import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEntryNativePrewarmAcceptedSchema,
  DEntryNativePrewarmResultSchema,
} from '@allrice/contracts';
import {
  authenticatePlatformSession,
  authenticateSession,
  closeDEntryAuthorityFeeds,
  createDEntryAuthorityFeed,
  createDedicatedDatabase,
  createEmployeeInstance,
  createSession,
  ensureBootstrapPortalPrincipal,
  hasExistingDEntryEmployeeOrVm,
  requireDEntryNativeIdentity,
  revokeSession,
  updateDEntryReleasePolicy,
} from '@allrice/database';
import {
  ApfsPersonVmDisk,
  FilePersonVmKeyStore,
  PersonVmDiskPool,
  PersonVmService,
  PostgresPersonVmStore,
  type PersonVmAuthority,
  type PersonVmBinding,
} from '@allrice/person-vm';
import * as client from '../../../../packages/database/src/core/client.ts';
import { DiskPoolLedger } from '../../../../packages/person-vm/src/disk-pool-ledger.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { authorizeFixturePlatformAdministrator } from '../../../../packages/database/src/platform-authority.fixture.ts';
import {
  harness,
  signal,
} from '../../../../packages/person-vm/src/test-support.ts';
import { createProductionPersonVmDeleteHttp } from './production-delete-http.js';
import {
  authorizeProductionPersonVmDeletion,
  createProductionPersonVmAuthority,
} from './production-authority.js';
import { createProductionCurrentPrewarm } from './production-prewarm.js';
import { installAssignedDEntryNativeRuntime } from '../business-runtime/native-prewarm.js';
import { dEntryHttpDefaults } from '../d-entry/http.js';
import {
  installDEntryNativeDataPort,
  type DEntryNativeDataPort,
} from '../d-entry/native-data.js';
import {
  deferred,
  nativeEntryFixture,
  nativeEntryServer,
} from '../d-entry/native-entry.fixture.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
suite(
  'platform administrator personal VM deletion through real HTTP and PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let token: string, otherLogin: string;
    let operator: string, nonAdmin: string;
    let worker: ReturnType<typeof createServer>;
    let origin: string;
    let service: PersonVmService;
    let newService: (
      usePool?: boolean,
      prewarmAuthority?: PersonVmAuthority,
    ) => PersonVmService;
    let ledger: DiskPoolLedger;
    let store: PostgresPersonVmStore;
    let failKeyRemoval = false;
    let disconnectLeaseOnErase = false;
    let failImageCreation = false;
    let failRuntimeStart = false;
    let diskCreateAttempts = 0;
    let failDetach = false;
    let loseDetachReceipt = false;
    let revokeBeforeErase: string | undefined;
    let revokeAfterCheckpoint: string | undefined;
    let revokeDuringDiskRead: string | undefined;
    let checkLockedSessionId: string | undefined;
    let failDiskRead = false;
    let disconnectLeaseInPreflight = false;
    let leaseClient: ReturnType<typeof createDedicatedDatabase>;
    const nativeStates = new Map<string, 'running' | 'stopped' | 'absent'>();
    const attachments = new Map<string, string>();
    const releasedHomes = new Set<string>();
    const stopped = new AbortController();

    async function post(
      login: string,
      body: Record<string, unknown>,
      extra?: HeadersInit,
    ) {
      const response = await fetch(
        origin + '/internal/platform/person-vm-delete',
        {
          method: 'POST',
          headers: {
            ...extra,
            ...(login && { authorization: `Bearer ${login}` }),
          },
          body: JSON.stringify(body),
        },
      );
      return { status: response.status, json: await response.json() };
    }
    beforeAll(async () => {
      fixture = await createRuntimeFixtureDatabase();
      // The authority feed owns a separate pg listener from the fixture pool.
      vi.stubEnv('DATABASE_URL', process.env.ALLRICE_TEST_DATABASE_URL);
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      await fixture.db.unsafe(`
        create function assert_retained_owner_released() returns trigger language plpgsql as $$
        begin
          if new.action='person_vm.platform.retain-disk.succeeded' and exists (
            select 1 from person_virtual_machines where vm_id=new.resource_id and lease_owner is not null
          ) then raise exception 'retained deletion committed before physical lease release'; end if;
          return new;
        end $$;
        create constraint trigger retained_owner_at_commit after insert on allrice_audit_events
          deferrable initially deferred for each row execute function assert_retained_owner_released();
      `);
      const admin = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'control-plane',
        workspaceName: 'Control',
        email: 'vm-delete-platform@example.test',
        displayName: 'Platform operator',
        role: 'member',
      });
      operator = admin.user.id;
      await authorizeFixturePlatformAdministrator(fixture.db, operator);
      token = (await createSession(operator)).token;
      otherLogin = (await createSession(operator)).token;
      const orgAdmin = await createTarget('admin');
      nonAdmin = (await createSession(orgAdmin.actor.id)).token;
      const root = join(fixture.storageRoot, 'vm-delete');
      await mkdir(root, { mode: 0o700 });
      const keys = new FilePersonVmKeyStore(join(root, 'keys'));
      const eraseKey = keys.delete.bind(keys);
      keys.delete = async (vmId) => {
        if (revokeAfterCheckpoint) await revokeSession(revokeAfterCheckpoint);
        if (disconnectLeaseOnErase) {
          await leaseClient.end({ timeout: 0 });
          throw Error('synthetic death of the erasing lease owner');
        }
        if (failKeyRemoval) throw Error('synthetic interruption after unlink');
        await eraseKey(vmId);
      };
      const diskRoot = join(root, 'volume');
      ledger = new DiskPoolLedger(diskRoot);
      const disk = new ApfsPersonVmDisk({
        root: diskRoot,
        keys,
        capacityGiB: 1,
        runner: async ({ args, input, executable }) => {
          if (executable === '/usr/bin/plutil')
            return Buffer.from(input!).toString();
          if (args[0] === 'info')
            return JSON.stringify({
              images: [...attachments].map(([path, mount]) => ({
                'image-path': path,
                'system-entities': [{ 'mount-point': mount }],
              })),
            });
          if (args[0] === 'create') {
            diskCreateAttempts += 1;
            if (failImageCreation)
              throw Error('synthetic failure before APFS image creation');
            await writeFile(args.at(-1)!, 'isolated QA fixture');
          } else if (args[0] === 'imageinfo') {
            if (disconnectLeaseInPreflight) {
              await leaseClient.end({ timeout: 0 });
              throw Error('synthetic checkpoint preflight disconnection');
            }
            if (failDiskRead) throw Error('synthetic unreadable disk');
            await lstat(args[1]!);
            if (revokeDuringDiskRead) await revokeSession(revokeDuringDiskRead);
          } else if (args[0] === 'attach')
            attachments.set(args[1]!, args.at(-1)!);
          else if (args[0] === 'detach') {
            if (failDetach) throw Error('synthetic detach failure');
            for (const [path, mount] of attachments)
              if (mount === args[1]) attachments.delete(path);
            if (loseDetachReceipt) throw Error('synthetic detach reply lost');
          } else throw Error('Unexpected hdiutil operation');
          return '';
        },
      });
      newService = (usePool = true, prewarmAuthority) => {
        store = new PostgresPersonVmStore(() => {
          leaseClient = createDedicatedDatabase(fixture.db);
          return leaseClient;
        });
        const h = harness(store);
        return new PersonVmService({
          store,
          disk,
          ...(usePool && {
            diskPool: new PersonVmDiskPool(
              diskRoot,
              store.diskPoolLocks(diskRoot),
              () => {},
            ),
          }),
          authority: prewarmAuthority ?? h.options.authority,
          ...(prewarmAuthority && {
            egress: h.egress,
            ownsEgressReceipt: (receipt) => h.active.has(receipt.bindingId),
          }),
          native: {
            ...h.native,
            status: async (binding, active) =>
              nativeStates.get(binding.vmId) ??
              h.native.status(binding, active),
            assertRetainedStartup: async (binding, mount, active) => {
              active.throwIfAborted();
              expect(nativeStates.get(binding.vmId)).toBe('stopped');
              expect([...attachments.values()]).toContain(mount);
            },
            releaseDiskHome: async (vmId) => {
              releasedHomes.add(vmId);
            },
          },
          runtime: {
            ...h.runtime,
            async start(...args) {
              if (failRuntimeStart) throw Error('synthetic startup failure');
              await h.runtime.start(...args);
            },
            async retireAfterNativeStop() {
              if (revokeBeforeErase) await revokeSession(revokeBeforeErase);
            },
          },
          async authorizePlatformDeletion(context, signal, sql) {
            await authorizeProductionPersonVmDeletion(context, signal, sql);
            if (sql && checkLockedSessionId)
              await expect(fixture.db`select id from allrice_sessions
                where id=${checkLockedSessionId} for update nowait`).rejects.toMatchObject(
                { code: '55P03' },
              );
          },
          leaseTtlMs: 5000,
          activityMaxAgeMs: 100,
          cleanupTimeoutMs: 1000,
        });
      };
      service = newService();
      const http = createProductionPersonVmDeleteHttp({
        authenticate: authenticatePlatformSession,
        lifetime: stopped.signal,
        execute: (context, input, active) =>
          service.deleteForPlatform(context, input, active),
      });
      worker = createServer((req, res) => void http.handle(req, res));
      worker.listen(0, '127.0.0.1');
      await once(worker, 'listening');
      const address = worker.address();
      if (!address || typeof address === 'string')
        throw Error('No test endpoint');
      origin = `http://127.0.0.1:${address.port}`;
    });
    afterAll(async () => {
      stopped.abort();
      if (worker?.listening) {
        worker.close();
        await once(worker, 'close');
      }
      try {
        await closeDEntryAuthorityFeeds();
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await fixture?.close();
      }
      expect(attachments.size).toBe(0);
    });
    it('audits and clears an initial failed reservation that never produced an image', async () => {
      const owner = await createTarget();
      failImageCreation = true;
      try {
        await expect(service.create(owner, signal())).rejects.toMatchObject({
          code: 'PROVIDER_FAILED',
        });
      } finally {
        failImageCreation = false;
      }
      const personId = owner.actor.id;
      const review = await post(token, { action: 'review', personId });
      expect(review.json.target).toMatchObject({
        phase: 'failed',
        diskIdentitySha256: null,
      });
      const removed = await post(token, {
        action: 'purge-disk',
        personId,
        vmId: review.json.target.vmId,
        confirmationId: review.json.confirmationId,
      });
      expect(removed.json.vm).toMatchObject({
        phase: 'deleted',
        diskRetained: false,
      });
      expect(await hasExistingDEntryEmployeeOrVm(owner, fixture.db)).toBe(
        false,
      );
    });
    const expiredTicket = { status: 410, json: { state: 'expired' } };
    const failedTicket = {
      status: 200,
      json: { state: 'failed', code: 'START_UNAVAILABLE' },
    };

    async function prewarmDeletionTarget() {
      const owner = await createTarget();
      const personId = owner.actor.id;
      const admin = await authenticatePlatformSession(token);
      if (!admin) throw Error('Expected fixture administrator');
      await updateDEntryReleasePolicy(admin, {
        revision: 'initial',
        defaultGeneration: '3.x',
        selections: [{ organizationId: owner.organizationId, personId }],
      });
      const employee = await createEmployeeInstance(owner, {
        requestId: randomUUID(),
        workspaceId: owner.workspaceId,
        expectedOwnerId: personId,
        profile: { name: 'Disposable employee', description: 'Prewarm QA' },
      });
      const login = await createSession(personId);
      const selection = {
        workspaceId: owner.workspaceId,
        employeeInstanceId: employee.id,
      };
      const identity = await requireDEntryNativeIdentity(owner, selection);
      const originalService = service;
      const originalStore = store;
      const current = createProductionPersonVmAuthority(stopped.signal);
      const vm = (service = newService(true, current.authority));
      const prewarm = createProductionCurrentPrewarm({ vm, current });
      const dispatch = vi.fn(prewarm);
      const watch = vi.fn(dEntryHttpDefaults.watch);
      const isCurrent = vi.fn(dEntryHttpDefaults.prewarm.isCurrent!);
      const releaseGates: (() => void)[] = [];
      function gate() {
        const entered = deferred<void>();
        const resume = deferred<void>();
        releaseGates.push(resume.resolve);
        return { entered, resume };
      }
      function pauseDispatch() {
        const { entered, resume } = gate();
        const finished = deferred<boolean>();
        dispatch.mockImplementationOnce(async (...args) => {
          entered.resolve();
          await resume.promise;
          try {
            const result = await prewarm(...args);
            finished.resolve(true);
            return result;
          } catch (error) {
            finished.resolve(false);
            throw error;
          }
        });
        return { entered, resume, finished };
      }
      function pauseCreate(when: 'before' | 'after') {
        const { entered, resume } = gate();
        const create = vm.create.bind(vm);
        vi.spyOn(vm, 'create').mockImplementationOnce(async (...args) => {
          const result = when === 'after' ? await create(...args) : undefined;
          entered.resolve();
          await resume.promise;
          return result ?? create(...args);
        });
        return { entered, resume };
      }
      function pauseBeforeIssue() {
        const { entered, resume } = gate();
        const watchCurrent = watch.getMockImplementation()!;
        watch.mockImplementationOnce(async (...args) => {
          const subscription = await watchCurrent(...args);
          entered.resolve();
          await resume.promise;
          return subscription;
        });
        return { entered, resume };
      }
      function pauseAfterLeaseClaim() {
        const { entered, resume } = gate();
        const withLease = store.withLease.bind(store);
        vi.spyOn(store, 'withLease').mockImplementationOnce(
          (person, options, work) =>
            withLease(person, options, async (lease) => {
              entered.resolve();
              await resume.promise;
              return work(lease);
            }),
        );
        return { entered, resume };
      }
      const proof = vi.fn<
        NonNullable<DEntryNativeDataPort['assertEditorReady']>
      >(async (context, _identity, active, binding) => {
        if (!binding) throw Error('Expected the exact published binding');
        await vm.assertCurrentBinding(context, binding, active);
        return stopped.signal;
      });
      const uninstallData = installDEntryNativeDataPort({
        ...nativeEntryFixture().data,
        assertEditorReady: proof,
      });
      const runtime = installAssignedDEntryNativeRuntime({
        vm,
        startup: { catalog: vi.fn() },
        prewarmCurrent: dispatch,
        lifetime: stopped.signal,
      });
      const entry = await nativeEntryServer(undefined, {
        ...dEntryHttpDefaults,
        watch,
        prewarm: { ...dEntryHttpDefaults.prewarm, isCurrent },
      });
      const headers = (loginToken: string) => ({
        authorization: `Bearer ${loginToken}`,
      });
      function open(loginToken = login.token) {
        return entry.request(
          'native-prewarm',
          {
            organizationId: owner.organizationId,
            selection,
            trigger: 'page',
          },
          headers(loginToken),
        );
      }
      async function openTicket(loginToken = login.token) {
        const response = await open(loginToken);
        expect(response.status).toBe(202);
        return DEntryNativePrewarmAcceptedSchema.parse(await response.json())
          .ticket.operationId;
      }
      async function status(operationId: string, loginToken = login.token) {
        const query = new URLSearchParams({
          organizationId: owner.organizationId,
          ...selection,
          operationId,
        });
        const response = await fetch(
          `${entry.origin}/internal/d-entry/native-prewarm/status?${query}`,
          { headers: headers(loginToken) },
        );
        return { status: response.status, json: await response.json() };
      }
      async function ready(operationId: string, loginToken = login.token) {
        await vi.waitFor(async () => {
          expect(await status(operationId, loginToken)).toEqual({
            status: 200,
            json: { state: 'ready' },
          });
        });
        return vm.resolve(owner, signal());
      }
      async function row() {
        const value = await store.read(personId);
        if (!value) throw Error('Expected a persisted VM');
        return value;
      }
      async function deletionFence() {
        const [stored] = await fixture.db<
          { prewarm_deletion_fence: string | null }[]
        >`select prewarm_deletion_fence from person_virtual_machines where person_id=${personId}`;
        return stored?.prewarm_deletion_fence;
      }
      async function leaseRowVersion() {
        const [stored] = await fixture.db<
          { version: string; lease_owner: string | null }[]
        >`select xmin::text as version, lease_owner from person_virtual_machines
          where person_id=${personId}`;
        if (!stored) throw Error('Expected a VM row for lease observation');
        return stored;
      }
      async function purge(vmId: string, status = 200) {
        const review = await post(token, { action: 'review', personId });
        expect(review.status).toBe(200);
        expect(review.json.target.vmId).toBe(vmId);
        const erased = await post(token, {
          action: 'purge-disk',
          personId,
          vmId,
          confirmationId: review.json.confirmationId,
        });
        expect(erased.status, JSON.stringify(erased.json)).toBe(status);
        if (status === 200)
          expect(erased.json.vm).toMatchObject({
            vmId,
            phase: 'deleted',
            diskRetained: false,
          });
      }
      async function close(predecessor?: PersonVmBinding) {
        failImageCreation = false;
        failRuntimeStart = false;
        for (const release of releaseGates) release();
        try {
          await entry.close();
          await runtime.close();
          const persisted = await store.read(personId);
          if (persisted?.diskRetained) {
            if (predecessor && persisted.phase === 'starting') {
              // The fixture seeded this stopped predecessor. Its cancelled
              // takeover has joined and released the original lease.
              expect(persisted).toMatchObject({
                ...predecessor,
                leaseOwner: null,
              });
              expect(nativeStates.get(predecessor.vmId)).toBe('stopped');
              await vm.shutdownOwned(predecessor, false);
              expect(await row()).toMatchObject({
                ...predecessor,
                phase: 'stopped',
                leaseOwner: null,
                egressReceipt: null,
              });
              expect(
                [...attachments.values()].map((mount) => basename(mount)),
              ).not.toContain(predecessor.vmId);
            }
            if (persisted.nativeCreated)
              nativeStates.set(persisted.vmId, 'stopped');
            await purge(persisted.vmId);
            nativeStates.delete(persisted.vmId);
          }
        } finally {
          uninstallData();
          await current.close();
          service = originalService;
          store = originalStore;
        }
      }
      return {
        owner,
        identity,
        personId,
        proof,
        dispatch,
        watch,
        isCurrent,
        pauseDispatch,
        pauseCreate,
        pauseBeforeIssue,
        pauseAfterLeaseClaim,
        open,
        openTicket,
        status,
        ready,
        row,
        deletionFence,
        leaseRowVersion,
        purge,
        close,
        create: () =>
          current.withCurrentSelection(owner, identity, signal(), () =>
            vm.create(owner, signal()),
          ),
      };
    }

    it.each(['pending reopen', 'first image failure'] as const)(
      'keeps a purged prewarm ticket expired through replacement (%s)',
      async (scenario) => {
        const f = await prewarmDeletionTarget();
        try {
          const diskAttemptsBefore = diskCreateAttempts;
          const pending =
            scenario === 'pending reopen' ? f.pauseDispatch() : undefined;
          if (pending) expect((await f.create()).phase).toBe('stopped');
          else failImageCreation = true;
          const originalTicket = await f.openTicket();
          if (pending) {
            await pending.entered.promise;
            expect(await f.status(originalTicket)).toEqual({
              status: 200,
              json: { state: 'starting' },
            });
          } else {
            await vi.waitFor(async () =>
              expect(await f.status(originalTicket)).toEqual(failedTicket),
            );
            failImageCreation = false;
          }
          const predecessor = await f.row();
          expect(predecessor).toMatchObject({
            leaseEpoch: 0,
            instanceId: null,
          });
          await f.purge(predecessor.vmId);
          expect(await f.status(originalTicket)).toEqual(expiredTicket);
          const replacement = f.pauseDispatch();
          const replacementTicket = await f.openTicket();
          expect(replacementTicket).not.toBe(originalTicket);
          await replacement.entered.promise;
          expect(await f.openTicket()).toBe(replacementTicket);
          expect(await f.status(originalTicket)).toEqual(expiredTicket);
          replacement.resume.resolve();
          const binding = await f.ready(replacementTicket);
          expect(binding.vmId).not.toBe(predecessor.vmId);
          expect(binding.leaseEpoch).toBe(1);
          if (pending) {
            pending.resume.resolve();
            expect(await pending.finished.promise).toBe(false);
          }
          expect(await f.status(originalTicket)).toEqual(expiredTicket);
          expect(f.dispatch).toHaveBeenCalledTimes(2);
          expect(f.proof).toHaveBeenCalledOnce();
          expect(diskCreateAttempts - diskAttemptsBefore).toBe(2);
        } finally {
          await f.close();
        }
      },
    );

    it('keeps a parked initial ticket expired while its saved VM is purged and replaced', async () => {
      const f = await prewarmDeletionTarget();
      try {
        const paused = f.pauseCreate('after');
        const original = await f.openTicket();
        await paused.entered.promise;
        const predecessor = await f.row();
        expect(predecessor).toMatchObject({
          phase: 'stopped',
          leaseEpoch: 0,
          leaseOwner: null,
        });
        expect(await f.deletionFence()).toBeNull();
        expect(await f.status(original)).toEqual({
          status: 200,
          json: { state: 'starting' },
        });
        failKeyRemoval = true;
        try {
          await f.purge(predecessor.vmId, 503);
        } finally {
          failKeyRemoval = false;
        }
        expect(await f.row()).toMatchObject({
          vmId: predecessor.vmId,
          phase: 'deleted',
          diskRetained: true,
        });
        const fence = await f.deletionFence();
        expect(fence).toBeTruthy();
        expect(await f.status(original)).toEqual(expiredTicket);
        await f.purge(predecessor.vmId);
        expect(await f.deletionFence()).toBe(fence);
        const replacement = await f.openTicket();
        expect(replacement).not.toBe(original);
        expect(await f.ready(replacement)).toMatchObject({
          vmId: expect.not.stringContaining(predecessor.vmId),
          leaseEpoch: 1,
        });
        expect(await f.deletionFence()).toBe(fence);
        expect(await f.status(original)).toEqual(expiredTicket);
        paused.resume.resolve();
        expect(await f.status(original)).toEqual(expiredTicket);
        expect(f.proof).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    });

    it('never dispatches an unpolled first ticket in another login’s replacement VM', async () => {
      const f = await prewarmDeletionTarget();
      try {
        const paused = f.pauseDispatch();
        const original = await f.openTicket();
        await paused.entered.promise;
        const independent = (await createSession(f.personId)).token;
        failImageCreation = true;
        const failed = await f.openTicket(independent);
        await vi.waitFor(async () =>
          expect(await f.status(failed, independent)).toEqual(failedTicket),
        );
        failImageCreation = false;
        const predecessor = await f.row();
        await f.purge(predecessor.vmId);
        // No GET ever looked at the original ticket or saw the tombstone.
        const replacement = await f.openTicket(independent);
        const binding = await f.ready(replacement, independent);
        expect(binding.leaseEpoch).toBe(1);
        expect(binding.vmId).not.toBe(predecessor.vmId);
        paused.resume.resolve();
        expect(await paused.finished.promise).toBe(false);
        expect(await f.status(original)).toEqual(expiredTicket);
        expect(f.proof).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    });

    it('fences an older cold ticket across retaining and reopening the same VM', async () => {
      const f = await prewarmDeletionTarget();
      try {
        const prior = await f.create();
        const paused = f.pauseDispatch();
        const original = await f.openTicket();
        await paused.entered.promise;
        const retain = {
          action: 'retain-disk',
          personId: f.personId,
          vmId: prior.vmId,
          leaseEpoch: 0,
        };
        const retained = await post(token, retain);
        expect(retained.status).toBe(200);
        expect(retained.json.vm).toMatchObject({
          vmId: prior.vmId,
          phase: 'deleted',
          diskRetained: true,
        });
        const fence = await f.deletionFence();
        expect(fence).toBeTruthy();
        expect((await post(token, retain)).status).toBe(200);
        expect(await f.deletionFence()).toBe(fence);
        const restored = await f.openTicket();
        expect(restored).not.toBe(original);
        expect(await f.ready(restored)).toMatchObject({
          vmId: prior.vmId,
          leaseEpoch: 1,
        });
        expect(await f.deletionFence()).toBe(fence);
        paused.resume.resolve();
        expect(await paused.finished.promise).toBe(false);
        expect(await f.status(original)).toEqual(expiredTicket);
        expect(f.proof).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    });

    it('reports the real failure after an initial ticket claims an existing same-generation disk', async () => {
      const f = await prewarmDeletionTarget();
      try {
        const diskAttemptsBefore = diskCreateAttempts;
        const paused = f.pauseDispatch();
        const original = await f.openTicket();
        await paused.entered.promise;
        const prior = await f.create();
        expect(prior.phase).toBe('stopped');
        failRuntimeStart = true;
        paused.resume.resolve();
        expect(await paused.finished.promise).toBe(false);
        expect(await f.row()).toMatchObject({
          vmId: prior.vmId,
          leaseEpoch: 1,
          instanceId: expect.any(String),
          phase: 'stopped',
          leaseOwner: null,
        });
        expect(await f.deletionFence()).toBeNull();
        await vi.waitFor(async () =>
          expect(await f.status(original)).toEqual(failedTicket),
        );
        expect(f.proof).not.toHaveBeenCalled();
        expect(diskCreateAttempts - diskAttemptsBefore).toBe(1);
      } finally {
        await f.close();
      }
    });

    it.each(['before', 'after'] as const)(
      'starts an exact running request independently of a cold ticket parked %s create',
      async (stage) => {
        const f = await prewarmDeletionTarget();
        try {
          const paused = f.pauseCreate(stage);
          const older = await f.openTicket();
          await paused.entered.promise;
          const independent = (await createSession(f.personId)).token;
          const current = await f.openTicket(independent);
          const binding = await f.ready(current, independent);
          const fresh = await f.open();
          if (fresh.status === 202) {
            const { ticket } = DEntryNativePrewarmAcceptedSchema.parse(
              await fresh.json(),
            );
            expect(ticket.operationId).not.toBe(older);
            expect(await f.ready(ticket.operationId)).toEqual(binding);
          } else {
            expect(fresh.status).toBe(200);
            expect(
              DEntryNativePrewarmResultSchema.parse(await fresh.json()),
            ).toEqual({
              identity: f.identity,
              trigger: 'page',
            });
          }
          const healthy = await f.leaseRowVersion();
          expect(healthy.lease_owner).toBeNull();
          paused.resume.resolve();
          await vi.waitFor(async () => {
            expect(await f.status(older)).toEqual(
              stage === 'after' ? failedTicket : expiredTicket,
            );
          });
          // A claim and subsequent release would still advance this PG version.
          expect(await f.leaseRowVersion()).toEqual(healthy);
          expect(await f.ready(current, independent)).toEqual(binding);
          expect(f.proof.mock.calls.map(([, , , binding]) => binding)).toEqual([
            binding,
            binding,
          ]);
          expect(f.dispatch).toHaveBeenCalledTimes(3);
        } finally {
          await f.close();
        }
      },
    );

    it.each(['same login', 'different login'] as const)(
      'checks a cold POST prepared before the exact instance was saved by the %s',
      async (login) => {
        const f = await prewarmDeletionTarget();
        const entered = deferred<void>();
        const resume = deferred<void>();
        const prove = f.proof.getMockImplementation()!;
        f.proof.mockImplementationOnce(async (...args) => {
          entered.resolve();
          await resume.promise;
          return prove(...args);
        });
        try {
          const owner =
            login === 'different login'
              ? (await createSession(f.personId)).token
              : undefined;
          const paused = f.pauseBeforeIssue();
          const opening = f.open();
          await Promise.race([
            paused.entered.promise,
            opening.then((response) => {
              throw Error(
                'POST ended before its watch barrier: ' + response.status,
              );
            }),
          ]);
          const original = await f.openTicket(owner);
          await entered.promise;
          expect(await f.row()).toMatchObject({
            phase: 'running',
            instanceId: expect.any(String),
            leaseOwner: null,
          });
          paused.resume.resolve();
          const delayed = await opening;
          const body = await delayed.json();
          if (login === 'same login')
            expect({ status: delayed.status, json: body }).toMatchObject({
              status: 202,
              json: {
                ticket: { operationId: original },
                identity: f.identity,
              },
            });
          else
            expect({ status: delayed.status, json: body }).toEqual(
              expiredTicket,
            );
          // A new prepare after publication still joins its own exact ticket.
          expect(await f.openTicket(owner)).toBe(original);
          expect(f.dispatch).toHaveBeenCalledOnce();
          resume.resolve();
          expect(await f.ready(original, owner)).toMatchObject({
            leaseEpoch: 1,
          });
        } finally {
          resume.resolve();
          await f.close();
        }
      },
    );

    it('rejects a delayed cold POST when its login only has a hot ticket for the instance started by another login', async () => {
      const f = await prewarmDeletionTarget();
      const proving = deferred<void>();
      const resume = deferred<void>();
      try {
        const independent = (await createSession(f.personId)).token;
        const paused = f.pauseBeforeIssue();
        const opening = f.open();
        await Promise.race([
          paused.entered.promise,
          opening.then((response) => {
            throw Error(
              'POST ended before its watch barrier: ' + response.status,
            );
          }),
        ]);
        const starter = await f.openTicket(independent);
        const binding = await f.ready(starter, independent);
        const healthy = await f.leaseRowVersion();
        expect(healthy.lease_owner).toBeNull();

        const prove = f.proof.getMockImplementation()!;
        f.proof.mockImplementationOnce(async (...args) => {
          proving.resolve();
          await resume.promise;
          return prove(...args);
        });
        const hot = await f.openTicket();
        await proving.promise;
        expect(hot).not.toBe(starter);
        expect(await f.status(hot)).toEqual({
          status: 200,
          json: { state: 'starting' },
        });

        paused.resume.resolve();
        const delayed = await opening;
        expect({ status: delayed.status, json: await delayed.json() }).toEqual(
          expiredTicket,
        );
        // Hot proof precedes a call to the existing VM lifecycle in this fixture.
        expect(f.dispatch).toHaveBeenCalledOnce();
        expect(f.proof.mock.calls.map(([, , , current]) => current)).toEqual([
          binding,
          binding,
        ]);
        expect(await f.leaseRowVersion()).toEqual(healthy);
        resume.resolve();
        expect(await f.ready(hot)).toEqual(binding);
        expect(await f.ready(starter, independent)).toEqual(binding);
        expect(f.dispatch).toHaveBeenCalledTimes(2);
        const [, employee, input] = f.dispatch.mock.calls[1]!;
        expect(employee).toEqual(f.identity);
        expect(input.target).toMatchObject({
          vmId: binding.vmId,
          instanceId: binding.instanceId,
          leaseEpoch: binding.leaseEpoch,
        });
        expect(await f.leaseRowVersion()).toEqual(healthy);
      } finally {
        resume.resolve();
        await f.close();
      }
    });

    it.each(['issue', 'reuse', 'operation'] as const)(
      'uses the correct HTTP result when %s SQL sees revocation before its notification is handled',
      async (mode) => {
        const f = await prewarmDeletionTarget();
        const feed = createDEntryAuthorityFeed(process.env.DATABASE_URL!);
        const subscribe = feed.subscribe.bind(feed);
        const blocked: (() => void)[] = [];
        vi.spyOn(feed, 'subscribe').mockImplementation((listener, active) =>
          subscribe(
            {
              ...listener,
              changed(change) {
                if (
                  change.table === 'allrice_memberships' &&
                  change.personId === f.personId
                )
                  blocked.push(() => listener.changed(change));
                else listener.changed(change);
              },
            },
            active,
          ),
        );
        f.watch.mockImplementation(
          (context, selection, identity, signal, _feed, verify) =>
            dEntryHttpDefaults.watch(
              context,
              selection,
              identity,
              signal,
              feed,
              verify,
            ),
        );
        const productionCheck = dEntryHttpDefaults.prewarm.isCurrent!;
        let withdraw = false;
        let predecessor: PersonVmBinding | undefined;
        f.isCurrent.mockImplementation(async (...args) => {
          const active = args[3];
          if (withdraw && args[4] === mode) {
            withdraw = false;
            const withdrawn =
              await fixture.db`update allrice_memberships set active=false
                where user_id=${f.personId} and organization_id=${f.owner.organizationId} and active
                returning id`;
            expect(withdrawn.length).toBeGreaterThan(0);
            await feed.observeThroughCommit(active);
            expect(blocked).toHaveLength(
              withdrawn.length * (mode === 'reuse' ? 2 : 1),
            );
            expect(active.aborted).toBe(false);
          }
          return productionCheck(...args);
        });
        async function expectDenied(response: Response) {
          expect(response.status).toBe(404);
          expect(await response.json()).toMatchObject({
            error: { code: 'RESOURCE_NOT_FOUND' },
          });
        }
        try {
          if (mode === 'issue') {
            withdraw = true;
            await expectDenied(await f.open());
            expect(withdraw).toBe(false);
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(await store.read(f.personId)).toBeNull();
            return;
          }

          const prior = await f.ready(await f.openTicket());
          nativeStates.set(prior.vmId, 'stopped');
          // Emulate a prior worker loss before it published running. Its exact
          // stopped instance, retained disk and port receipt are from real startup.
          const orphaned =
            await fixture.db`update person_virtual_machines set phase='starting'
            where vm_id=${prior.vmId} and instance_id=${prior.instanceId} and phase='running'
              and lease_epoch=${prior.leaseEpoch} and lease_owner is null
            returning instance_id`;
          expect(orphaned).toHaveLength(1);
          predecessor = prior;
          const delayed = mode === 'reuse' ? f.pauseBeforeIssue() : undefined;
          const opening = delayed && f.open();
          if (delayed && opening)
            await Promise.race([
              delayed.entered.promise,
              opening.then((response) => {
                throw Error(
                  'POST ended before its watch barrier: ' + response.status,
                );
              }),
            ]);

          const physical = f.pauseAfterLeaseClaim();
          const original = await f.openTicket();
          await physical.entered.promise;
          expect(await f.row()).toMatchObject({
            ...prior,
            phase: 'starting',
            leaseOwner: expect.any(String),
          });
          const claimed = await f.leaseRowVersion();
          withdraw = true;
          if (delayed && opening) {
            delayed.resume.resolve();
            await expectDenied(await opening);
          } else {
            expect(await f.status(original)).toEqual(expiredTicket);
          }
          expect(withdraw).toBe(false);
          expect(await f.leaseRowVersion()).toEqual(claimed);
          expect(f.dispatch).toHaveBeenCalledTimes(2);
        } finally {
          for (const notify of blocked) notify();
          try {
            await f.close(predecessor);
          } finally {
            await feed.close();
          }
        }
      },
    );

    it('does not issue a retained-disk ticket when an actual purge finishes during the prepared POST', async () => {
      const f = await prewarmDeletionTarget();
      try {
        const prior = await f.create();
        failKeyRemoval = true;
        try {
          await f.purge(prior.vmId, 503);
        } finally {
          failKeyRemoval = false;
        }
        const fence = await f.deletionFence();
        expect(fence).toBeTruthy();
        expect(await f.row()).toMatchObject({
          phase: 'deleted',
          diskRetained: true,
        });
        const paused = f.pauseBeforeIssue();
        const opening = f.open();
        await Promise.race([
          paused.entered.promise,
          opening.then((response) => {
            throw Error(
              'POST finished before the issuance barrier: ' + response.status,
            );
          }),
        ]);
        await f.purge(prior.vmId);
        expect(await f.deletionFence()).toBe(fence);
        expect(await f.row()).toMatchObject({
          phase: 'deleted',
          diskRetained: false,
        });
        paused.resume.resolve();
        const expired = await opening;
        expect({ status: expired.status, json: await expired.json() }).toEqual(
          expiredTicket,
        );
        expect(f.dispatch).not.toHaveBeenCalled();
        const next = await f.openTicket();
        expect(await f.ready(next)).toMatchObject({
          vmId: expect.not.stringContaining(prior.vmId),
          leaseEpoch: 1,
        });
      } finally {
        await f.close();
      }
    });
    it('retains the complete image when an administrator is revoked or detach cannot be confirmed', async () => {
      const owner = await createTarget();
      const personId = owner.actor.id;
      const { vmId } = await service.create(owner, signal());
      const instanceId = randomUUID();
      await fixture.db`update person_virtual_machines
        set instance_id=${instanceId},native_created=true,lease_epoch=1 where vm_id=${vmId}`;
      nativeStates.set(vmId, 'stopped');
      const review = { action: 'review', personId };
      const revoke = (await createSession(operator)).token;
      const first = await post(revoke, review);
      function purge(confirmationId: string) {
        return { action: 'purge-disk', personId, vmId, confirmationId };
      }
      const receipt = {
        bindingId: randomUUID(),
        gatewayPorts: [49152],
        binding: {
          vmId,
          instanceId,
          personId,
          organizationId: owner.organizationId,
          leaseEpoch: 1,
        },
      };
      await fixture.db`update person_virtual_machines
        set egress_receipt=${fixture.db.json(receipt)} where vm_id=${vmId}`;
      const unowned = await post(token, review);
      expect(
        (await post(token, purge(unowned.json.confirmationId))).status,
      ).toBe(409);
      const [rejected] =
        await fixture.db`select egress_receipt from person_virtual_machines where vm_id=${vmId}`;
      expect(rejected?.egress_receipt).toEqual(receipt);
      await fixture.db`update person_virtual_machines set egress_receipt=null where vm_id=${vmId}`;
      revokeBeforeErase = revoke;
      try {
        expect(
          (await post(revoke, purge(first.json.confirmationId))).status,
        ).toBe(403);
        expect(nativeStates.get(vmId)).toBe('stopped');
        expect(releasedHomes.delete(vmId)).toBe(true);
      } finally {
        revokeBeforeErase = undefined;
      }
      const second = await post(token, review);
      failDetach = true;
      try {
        expect(
          (await post(token, purge(second.json.confirmationId))).status,
        ).toBe(409);
        expect(nativeStates.get(vmId)).toBe('stopped');
        expect(releasedHomes.has(vmId)).toBe(false);
      } finally {
        failDetach = false;
      }
      expect(
        (
          await post(token, {
            action: 'retain-disk',
            personId,
            vmId,
            leaseEpoch: 1,
          })
        ).json.vm,
      ).toMatchObject({
        phase: 'deleted',
        diskRetained: true,
      });
      expect(releasedHomes.has(vmId)).toBe(true);
      const third = await post(token, review);
      expect(
        (await post(token, purge(third.json.confirmationId))).json.vm
          .diskRetained,
      ).toBe(false);
    });
    async function createTarget(role: 'admin' | 'member' = 'member') {
      const person = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'vm-delete-company',
        organizationName: 'Company',
        workspaceSlug: 'test-workspace',
        workspaceName: 'Workspace',
        email: `${randomUUID()}@example.test`,
        displayName: 'Disposable target',
        role,
      });
      if (role === 'admin')
        await fixture.db`update allrice_memberships set role='admin' where user_id=${person.user.id}`;
      const login = await createSession(person.user.id);
      const context = await authenticateSession(login.token, {
        organizationId: person.organizationId,
        workspaceId: person.workspaceId,
      });
      if (!context?.workspaceId) throw Error('Expected scoped fixture owner');
      return { ...context, workspaceId: context.workspaceId };
    }
    it('uses the ordinary canonical lock for mixed-case IDs and never reports retention after purge', async () => {
      const owner = await createTarget();
      const personId = owner.actor.id.toUpperCase();
      const { vmId } = await service.create(owner, signal());
      const review = { action: 'review', personId };
      await store.withLease(
        owner.actor.id,
        { now: () => new Date(), ttlMs: 5000 },
        async () => {
          expect((await post(token, review)).status).toBe(409);
        },
      );
      const candidate = await post(token, review);
      expect(candidate.status).toBe(200);
      expect(candidate.json.target.personId).toBe(owner.actor.id);
      const erased = await post(token, {
        action: 'purge-disk',
        personId,
        vmId: vmId.toUpperCase(),
        confirmationId: candidate.json.confirmationId.toUpperCase(),
      });
      expect(erased.json.vm).toMatchObject({
        phase: 'deleted',
        diskRetained: false,
      });
      expect(
        (
          await post(token, {
            action: 'retain-disk',
            personId,
            vmId: vmId.toUpperCase(),
            leaseEpoch: candidate.json.target.leaseEpoch,
          })
        ).status,
      ).toBe(409);
      const [denied] =
        await fixture.db`select actor_id from allrice_audit_events
        where resource_id=${vmId} and action='person_vm.platform.retain-disk.denied'`;
      expect(denied?.actor_id).toBe(operator);
    });
    it('audits a broken disk read and permits a new Worker to resume before a retained disk has an erase checkpoint', async () => {
      const owner = await createTarget();
      const personId = owner.actor.id;
      const { vmId } = await service.create(owner, signal());
      const review = { action: 'review', personId };
      const first = await post(token, review);
      const epoch = first.json.target.leaseEpoch;
      expect(
        (
          await post(token, {
            action: 'retain-disk',
            personId,
            vmId,
            leaseEpoch: epoch,
          })
        ).status,
      ).toBe(200);
      const reviewed = await post(token, review);
      function purge(confirmationId: string) {
        return { action: 'purge-disk', personId, vmId, confirmationId };
      }
      failDiskRead = true;
      try {
        expect(
          (await post(token, purge(reviewed.json.confirmationId))).status,
        ).toBe(503);
      } finally {
        failDiskRead = false;
      }
      const [failed] =
        await fixture.db`select actor_id,request_id,metadata from allrice_audit_events
        where resource_id=${vmId} and action='person_vm.platform.purge-disk.failed'`;
      expect(failed).toMatchObject({
        actor_id: operator,
        request_id: expect.any(String),
        metadata: {
          personId,
          vmId,
          diskUnverified: true,
          diskIdentitySha256: null,
          reviewedDiskIdentitySha256: reviewed.json.target.diskIdentitySha256,
        },
      });
      disconnectLeaseInPreflight = true;
      try {
        expect(
          (await post(token, purge(reviewed.json.confirmationId))).status,
        ).toBe(503);
      } finally {
        disconnectLeaseInPreflight = false;
      }
      const [unstranded] =
        await fixture.db`select phase,disk_retained,lease_owner from person_virtual_machines where vm_id=${vmId}`;
      expect(unstranded).toEqual({
        phase: 'deleted',
        disk_retained: true,
        lease_owner: null,
      });
      service = newService();
      const renewed = await post(token, review);
      expect(
        (await post(token, purge(renewed.json.confirmationId))).json.vm
          .diskRetained,
      ).toBe(false);
    });
    it('completes an already-authorized erasure after the platform login is revoked', async () => {
      const owner = await createTarget();
      const personId = owner.actor.id;
      const { vmId } = await service.create(owner, signal());
      const session = await createSession(operator);
      const reviewed = await post(session.token, {
        action: 'review',
        personId,
      });
      revokeAfterCheckpoint = session.token;
      checkLockedSessionId = session.id;
      try {
        const erased = await post(session.token, {
          action: 'purge-disk',
          personId,
          vmId,
          confirmationId: reviewed.json.confirmationId,
        });
        expect(erased.json.vm).toMatchObject({
          phase: 'deleted',
          diskRetained: false,
        });
      } finally {
        revokeAfterCheckpoint = undefined;
        checkLockedSessionId = undefined;
      }
      expect(
        (await post(session.token, { action: 'review', personId })).status,
      ).toBe(403);
    });
    it('audits a purge denied when the administrator is revoked during inspection', async () => {
      const owner = await createTarget();
      const personId = owner.actor.id;
      const { vmId } = await service.create(owner, signal());
      const session = await createSession(operator);
      const reviewed = await post(session.token, {
        action: 'review',
        personId,
      });
      revokeDuringDiskRead = session.token;
      try {
        expect(
          (
            await post(session.token, {
              action: 'purge-disk',
              personId,
              vmId,
              confirmationId: reviewed.json.confirmationId,
            })
          ).status,
        ).toBe(403);
      } finally {
        revokeDuringDiskRead = undefined;
      }
      const [denied] =
        await fixture.db`select actor_id, reason, metadata from allrice_audit_events
        where resource_id=${vmId} and action='person_vm.platform.purge-disk.denied'`;
      expect(denied).toMatchObject({
        actor_id: operator,
        reason: 'AUTHORIZATION_DENIED',
        metadata: {
          personId,
          diskIdentitySha256: reviewed.json.target.diskIdentitySha256,
        },
      });
      expect((await store.read(personId))?.diskRetained).toBe(true);
    });
    it('requires real platform authorization, binds confirmation to the exact login and tombstone, and clears the first-employee VM gate only after purge', async () => {
      const owner = await createTarget();
      const personId = owner.actor.id;
      const admin = await authenticatePlatformSession(token);
      if (!admin) throw Error('Expected fixture administrator');
      await updateDEntryReleasePolicy(admin, {
        revision: 'initial',
        defaultGeneration: '3.x',
        selections: [{ organizationId: owner.organizationId, personId }],
      });
      const employee = {
        requestId: randomUUID(),
        workspaceId: owner.workspaceId,
        expectedOwnerId: personId,
        profile: {
          name: 'Disposable employee',
          description: 'QA creation after VM purge',
        },
      };
      const created = await service.create(owner, signal());
      const request = { action: 'review', personId };
      expect((await post('', request)).status).toBe(401);
      expect((await post(nonAdmin, request)).status).toBe(403);
      expect(
        (await post(token, request, { origin: 'https://other.example.test' }))
          .status,
      ).toBe(404);
      expect(
        (await post(token, { ...request, extra: 'a'.repeat(2048) })).status,
      ).toBe(413);
      const review = await post(token, request);
      expect(review.status).toBe(200);
      const target = review.json.target;
      expect(target).toMatchObject({
        personId,
        vmId: created.vmId,
        phase: 'stopped',
        diskRetained: true,
        diskIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const purge = {
        action: 'purge-disk',
        personId,
        vmId: created.vmId,
        confirmationId: review.json.confirmationId,
      };
      expect((await post(otherLogin, purge)).status).toBe(403);
      expect((await post(token, { ...purge, vmId: randomUUID() })).status).toBe(
        409,
      );
      expect(
        (
          await post(token, {
            action: 'retain-disk',
            personId,
            vmId: created.vmId,
            leaseEpoch: target.leaseEpoch + 1,
          })
        ).status,
      ).toBe(409);
      const retained = await post(token, {
        action: 'retain-disk',
        personId,
        vmId: created.vmId,
        leaseEpoch: target.leaseEpoch,
      });
      expect(retained.json.vm).toMatchObject({
        phase: 'deleted',
        diskRetained: true,
      });
      expect(await hasExistingDEntryEmployeeOrVm(owner, fixture.db)).toBe(true);
      await expect(
        createEmployeeInstance(owner, employee),
      ).rejects.toMatchObject({
        code: 'd_entry_first_employee_limit',
      });
      expect((await post(token, purge)).status).toBe(403);
      const next = await post(token, request);
      const confirmed = { ...purge, confirmationId: next.json.confirmationId };
      const deleted = await post(token, confirmed);
      expect(deleted.json.vm).toMatchObject({
        phase: 'deleted',
        diskRetained: false,
      });
      expect((await post(token, confirmed)).status).toBe(403);
      expect(await hasExistingDEntryEmployeeOrVm(owner, fixture.db)).toBe(
        false,
      );
      expect(await createEmployeeInstance(owner, employee)).toMatchObject({
        profile: { name: employee.profile.name },
      });
      const audit =
        await fixture.db`select actor_id,resource_id,action,metadata,occurred_at
      from allrice_audit_events where resource_id=${created.vmId} order by occurred_at,action`;
      expect(audit.map((row) => row.action)).toEqual(
        expect.arrayContaining([
          'person_vm.platform.review.reviewed',
          'person_vm.platform.retain-disk.succeeded',
          'person_vm.platform.purge-disk.started',
          'person_vm.platform.purge-disk.erasing',
          'person_vm.platform.purge-disk.succeeded',
        ]),
      );
      for (const row of audit.filter(
        (row) => !row.action.endsWith('.denied'),
      )) {
        expect(row).toMatchObject({
          actor_id: operator,
          resource_id: created.vmId,
          occurred_at: expect.any(Date),
          metadata: { personId, diskIdentitySha256: target.diskIdentitySha256 },
        });
      }
      expect(JSON.stringify(audit)).not.toContain(token);
    });
    it('refuses an unfinished pool claim and allows a fresh VM after the committed claim is purged', async () => {
      const owner = await createTarget();
      const personId = owner.actor.id;
      // Stage the formal disk separately to model a crash after the disk name
      // was published but before the pool committed the ownership transition.
      const legacyService = newService(false);
      const { vmId } = await legacyService.create(owner, signal());
      await fixture.db`update person_virtual_machines set lease_epoch=2
        where vm_id=${vmId}`;
      service = newService();
      const claim = {
        ref: randomUUID(),
        source: 'isolated-test-source',
        proof: 'isolated-test-image',
        intent: {
          id: randomUUID(),
          requestId: randomUUID(),
          owner: { personId, organizationId: owner.organizationId, vmId },
        },
      };
      const slot = (await ledger.read(signal())).slots[0]!;
      const filling = {
        ref: claim.ref,
        source: claim.source,
        state: 'filling',
      } as const;
      const ready = { ...filling, proof: claim.proof, state: 'ready' } as const;
      const claiming = { ...claim, state: 'claiming' } as const;
      await ledger.append(slot, filling, signal());
      await ledger.append(
        { ...slot, entry: filling, revision: slot.revision + 1 },
        ready,
        signal(),
      );
      await ledger.append(
        { ...slot, entry: ready, revision: slot.revision + 2 },
        claiming,
        signal(),
      );
      const review = { action: 'review', personId };
      expect(await post(token, review)).toEqual({
        status: 409,
        json: { error: 'CLEANUP_INCOMPLETE' },
      });
      const retain = { action: 'retain-disk', personId, vmId, leaseEpoch: 2 };
      expect(await post(token, retain)).toEqual({
        status: 409,
        json: { error: 'CLEANUP_INCOMPLETE' },
      });
      expect(await store.read(personId)).toMatchObject({
        vmId,
        phase: 'stopped',
        diskRetained: true,
        leaseOwner: null,
      });

      await ledger.append(
        { ...slot, entry: claiming, revision: slot.revision + 3 },
        { ...claim, state: 'bound' },
        signal(),
      );
      expect((await post(token, retain)).status).toBe(200);
      const reviewed = await post(token, review);
      expect(reviewed.status).toBe(200);
      expect(
        (
          await post(token, {
            action: 'purge-disk',
            personId,
            vmId,
            confirmationId: reviewed.json.confirmationId,
          })
        ).json.vm,
      ).toMatchObject({ phase: 'deleted', diskRetained: false });
      expect((await ledger.read(signal())).bound.has(vmId)).toBe(true);

      const fresh = await service.create(owner, signal());
      expect(fresh.vmId).not.toBe(vmId);
      expect(await store.read(personId)).toMatchObject({
        vmId: fresh.vmId,
        leaseEpoch: 2,
        diskRetained: true,
      });
    });
    it.each(['retain-disk', 'purge-disk'] as const)(
      'settles the retained startup mount before platform %s and preserves the verified width until erase',
      async (action) => {
        const owner = await createTarget();
        const personId = owner.actor.id;
        const { vmId } = await service.create(owner, signal());
        const binding = {
          personId,
          organizationId: owner.organizationId,
          vmId,
          instanceId: randomUUID(),
          leaseEpoch: 1,
        };
        const width = 8;
        await fixture.db`update person_virtual_machines
          set instance_id=${binding.instanceId},native_created=true,lease_epoch=${binding.leaseEpoch},verified_web_slot_capacity=${width}
          where vm_id=${vmId}`;
        nativeStates.set(vmId, 'stopped');
        loseDetachReceipt = true;
        try {
          await expect(
            service.reconcileStoppedEntryForPrewarm(
              owner,
              binding,
              signal(),
              true,
            ),
          ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
        } finally {
          loseDetachReceipt = false;
        }
        expect(attachments.size).toBe(0);
        const review = { action: 'review', personId };
        const reviewed = await post(token, review);
        expect(reviewed.status).toBe(200);
        if (action === 'retain-disk') {
          const retained = await post(token, {
            action,
            personId,
            vmId,
            leaseEpoch: binding.leaseEpoch,
          });
          expect(retained.status).toBe(200);
          expect(await store.read(personId)).toMatchObject({
            ...binding,
            phase: 'deleted',
            diskRetained: true,
            verifiedWebSlotCapacity: width,
          });
          expect((await service.create(owner, signal())).vmId).toBe(vmId);
        } else {
          const purge = { action, personId, vmId };
          failKeyRemoval = true;
          try {
            expect(
              (
                await post(token, {
                  ...purge,
                  confirmationId: reviewed.json.confirmationId,
                })
              ).status,
            ).toBe(503);
          } finally {
            failKeyRemoval = false;
          }
          expect(await store.read(personId)).toMatchObject({
            vmId,
            phase: 'deleted',
            diskRetained: true,
            verifiedWebSlotCapacity: width,
          });
          const retry = await post(token, review);
          expect(retry.status).toBe(200);
          expect(
            (
              await post(token, {
                ...purge,
                confirmationId: retry.json.confirmationId,
              })
            ).status,
          ).toBe(200);
          expect(await store.read(personId)).toMatchObject({
            vmId,
            phase: 'deleted',
            diskRetained: false,
            verifiedWebSlotCapacity: null,
          });
          expect((await service.create(owner, signal())).vmId).not.toBe(vmId);
        }
        await service.settleRetainedStartupMounts(signal());
        expect(attachments.size).toBe(0);
      },
    );
    it.each(['key removal failure', 'lease connection loss'] as const)(
      'recovers an interrupted physical purge after %s with normal creation fenced in between',
      async (failure) => {
        const owner = await createTarget();
        const personId = owner.actor.id;
        const { vmId } = await service.create(owner, signal());
        const review = { action: 'review', personId };
        const initial = await post(token, review);
        const purge = {
          action: 'purge-disk',
          personId,
          vmId,
          confirmationId: initial.json.confirmationId,
        };
        failKeyRemoval = failure === 'key removal failure';
        disconnectLeaseOnErase = failure === 'lease connection loss';
        try {
          expect((await post(token, purge)).status).toBe(503);
        } finally {
          failKeyRemoval = false;
          disconnectLeaseOnErase = false;
        }
        const [checkpoint] =
          await fixture.db`select phase,disk_retained,lease_owner
        from person_virtual_machines where vm_id=${vmId}`;
        expect(checkpoint).toEqual({
          phase: 'deleted',
          disk_retained: true,
          lease_owner: null,
        });
        if (failure === 'lease connection loss') {
          const crash = store.withLease(
            personId,
            {
              now: () => new Date(),
              ttlMs: 5000,
              deletionAction: 'purge-disk',
            },
            async (lease) => {
              expect(await lease.readPlatformErasingDisk?.()).toBeDefined();
              const [resumed] = await fixture.db`select lease_owner
            from person_virtual_machines where vm_id=${vmId}`;
              expect(resumed?.lease_owner).toBeNull();
              await leaseClient.end({ timeout: 0 });
              throw Error('resume preflight interrupted');
            },
          );
          await expect(crash).rejects.toThrow('resume preflight interrupted');
        }
        expect(await hasExistingDEntryEmployeeOrVm(owner, fixture.db)).toBe(
          true,
        );
        await expect(service.create(owner, signal())).rejects.toMatchObject({
          code: 'CLEANUP_INCOMPLETE',
        });
        expect((await post(token, purge)).status).toBe(403);
        const newReview = await post(token, review);
        expect(newReview.json.target.diskIdentitySha256).toBe(
          initial.json.target.diskIdentitySha256,
        );
        const revoked = await createSession(operator);
        const stale = await post(revoked.token, review);
        await revokeSession(revoked.token);
        expect(
          (
            await post(revoked.token, {
              ...purge,
              confirmationId: stale.json.confirmationId,
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await post(token, {
              ...purge,
              confirmationId: newReview.json.confirmationId,
            })
          ).json.vm.diskRetained,
        ).toBe(false);
        expect(await hasExistingDEntryEmployeeOrVm(owner, fixture.db)).toBe(
          false,
        );
      },
    );
  },
);
