import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  authenticatePlatformSession,
  authenticateSession,
  createDedicatedDatabase,
  createEmployeeInstance,
  createSession,
  ensureBootstrapPortalPrincipal,
  hasExistingDEntryEmployeeOrVm,
  revokeSession,
  updateDEntryReleasePolicy,
} from '@allrice/database';
import {
  ApfsPersonVmDisk,
  FilePersonVmKeyStore,
  PersonVmDiskPool,
  PersonVmService,
  PostgresPersonVmStore,
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
import { authorizeProductionPersonVmDeletion } from './production-authority.js';

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
    let newService: (usePool?: boolean) => PersonVmService;
    let ledger: DiskPoolLedger;
    let store: PostgresPersonVmStore;
    let failKeyRemoval = false;
    let disconnectLeaseOnErase = false;
    let failImageCreation = false;
    let failDetach = false;
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
          } else throw Error('Unexpected hdiutil operation');
          return '';
        },
      });
      newService = (usePool = true) => {
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
          authority: h.options.authority,
          native: {
            ...h.native,
            status: async (binding) =>
              nativeStates.get(binding.vmId) ?? 'absent',
            releaseDiskHome: async (vmId) => {
              releasedHomes.add(vmId);
            },
          },
          runtime: {
            ...h.runtime,
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
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
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
