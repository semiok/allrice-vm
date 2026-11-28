import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as contracts from '@allrice/contracts';
import type { EmployeeRuntimePackage, StoragePort } from '@allrice/contracts';
import {
  NativeWebGuestLaunchUnacknowledged,
  PersonVmError,
  type PersonVmBinding,
  PersonVmService,
  PostgresPersonVmStore,
  sameVmBinding,
} from '@allrice/person-vm';
import {
  harness,
  signal,
} from '../../../../packages/person-vm/src/test-support.ts';
import * as client from '../../../../packages/database/src/core/client.ts';
import * as serviceBuild from '../../../../packages/database/src/service-build-identity.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { nativeBindingDescriptor } from '../../../../packages/database/src/native-session-binding.fixture.ts';
import { createEmployeeAdministrationFixture } from '../../../../packages/database/src/employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from '../../../../packages/database/src/platform-employees/runtime-package.ts';
import {
  createSession,
  authenticateSession,
  revokeSession,
} from '../../../../packages/database/src/identity.ts';
import { ensureGeneralEmployeeInstance } from '../../../../packages/database/src/employees/employee-instances.ts';
import {
  createChatSession,
  getSessionExecutionGeneration,
  ensureDefaultEmployee,
  sendChatMessage,
  updateChatSession,
  linkFileToSession,
  linkWorkspaceFileToSession,
} from '../../../../packages/database/src/workspace/service.ts';
import { initializeNativeOncePartition } from '../../../../packages/database/src/native-schedule-once-product.ts';
import { initializeNativeRecurringPartition } from '../../../../packages/database/src/native-schedule-recurring-product.ts';
import { prepareAutomationConversation } from '../../../../packages/database/src/automation-conversation.ts';
import { readScheduleTarget } from '../../../../packages/database/src/native-schedule-authority.ts';
import {
  claimNextJob,
  startClaimedJob,
  prepareJobNativeSession,
  bindJobNativeSession,
} from '../../../../packages/database/src/execution/queue.ts';
import { acquireConversationRuntime } from '../../../../packages/database/src/conversation/conversation-runtime.ts';
import { enqueueNativeSubagentControl } from '../../../../packages/database/src/conversation/native-subagent-control.ts';
import { updateQueuedMessage } from '../../../../packages/database/src/conversation/queued-messages.ts';
import { GET } from '../../app/api/v1/d-entry/identity/route';
import { POST } from '../../app/api/v1/d-entry/admission/route';
import { POST as createNativeRoot } from '../../app/api/v1/d-entry/native-root/route';
import { PATCH } from '../../app/api/v1/sessions/[id]/route';
import { POST as createBusinessThread } from '../../app/api/v1/sessions/route';
import {
  findDEntryCreationWorkspace,
  findDEntryEmployee,
  isDEntryPersonReleased,
} from '../d-entry/entry-threads';
import { POST as createEmployee } from '../../app/api/v1/employee-instances/route';
import { PATCH as updateEmployee } from '../../app/api/v1/employee-instances/[id]/route';
import { POST as changeEmployeeLifecycle } from '../../app/api/v1/employee-instances/[id]/lifecycle/route';
import { PUT as assignEmployees } from '../../app/api/v1/employees/[id]/assignments/route';
import { POST as employeeQuality } from '../../app/api/v1/admin/employee-quality/route';
import { POST as changeOrganizationAccount } from '../../app/api/v1/admin/organizations/[organizationId]/people/[userId]/status/route';
import { PATCH as changeTenantMembership } from '../../app/api/v1/admin/tenants/[organizationId]/members/[membershipId]/route';
import {
  POST as uploadAttachment,
  PUT as attachWorkspaceFile,
} from '../../app/api/v1/sessions/[id]/attachments/route';
import { POST as createOnceTask } from '../../app/api/v1/sessions/[id]/once-tasks/route';
import { POST as cancelOnceTask } from '../../app/api/v1/sessions/[id]/once-tasks/[taskId]/cancel/route';
import { POST as createRecurringTask } from '../../app/api/v1/sessions/[id]/schedule-tasks/route';
import {
  GET as getReleasePolicy,
  PUT as publishReleasePolicy,
} from '../../app/api/v1/admin/d-entry-release-policy/route';
import { PUT as publishPersonReleasePolicy } from '../../app/api/v1/admin/d-entry-release-policy/person/route';
import { resolveDEntryAdmission } from '../d-entry/admission';
import { resolveDEntryIdentity } from '../d-entry/identity';
import {
  dEntryReleasePolicyKey,
  readDEntryReleasePolicy,
  readPersonVmDiskPreparationTarget,
  getDEntryReleasePolicy,
  updateDEntryReleasePolicy,
  requireCurrentPlatformAdmin,
  getDEntryNativeRootPin,
  getDEntryHistoryRootPin,
  getDEntryPageNativeRoot,
  registerDEntryPageNativeRoot,
  ensureDEntryNativeRoot,
  syncDEntryNativeRootTitle,
  requireDEntryNativeIdentity,
  readDEntryEmployeeDirectory,
  preparePersonNativeWebRoster,
  readPersonNativeWebRoster,
  runDEntryAdmittedActivity,
  createEmployeeInstance,
  getEmployeeDetails,
  getOrganizationAiSharedDetails,
  listOrganizationPersonAiInstances,
  changeEmployeeInstanceLifecycle,
  listAdminTenantMembers,
  listOrganizationPeople,
  confirmDEntryEmployeeArchive,
  createDEntryAuthorityFeed,
  watchDEntryNativeAuthority,
  watchDEntryHistoryAuthority,
} from '@allrice/database';
import { authorizeFixturePlatformAdministrator } from '../../../../packages/database/src/platform-authority.fixture.ts';
import {
  WebSocket,
  deferred,
  nativeEntryFixture,
  nativeEntryServer,
} from '../../../worker/src/d-entry/native-entry.fixture';
import { dEntryHttpDefaults } from '../../../worker/src/d-entry/http';
import { installProductionDEntrySource } from '../../../worker/src/person-vm/production-dentry-source.js';
import { currentDEntryNativeDataPort } from '../../../worker/src/d-entry/native-data.js';
import { installAssignedDEntryNativeRuntime } from '../../../worker/src/business-runtime/native-prewarm.js';
import type { AssignedNativeWebCatalog } from '../../../worker/src/native-web/composition.js';
import { createProductionPersonVmAuthority } from '../../../worker/src/person-vm/production-authority.js';
import {
  createProductionCurrentPrewarm,
  createProductionStoppedEntryReconciliation,
} from '../../../worker/src/person-vm/production-prewarm.js';
import { dEntryNativePrewarmPort } from '../../../worker/src/d-entry/native-prewarm.js';

const cookie = vi.hoisted(() => ({
  token: '',
  storage: null as StoragePort | null,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'allrice_session' && cookie.token
        ? { value: cookie.token }
        : undefined,
  }),
}));
vi.mock('../storage/runtime', () => ({
  getStorageAdapter: () => cookie.storage!,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET-271 real cookie/DB owner admission and immutable product writer',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let runtimePackage: EmployeeRuntimePackage;
    const probes = new Set<() => Promise<void>>();
    afterEach(async () => {
      await Promise.all([...probes].map((close) => close()));
    });
    beforeAll(async () => {
      vi.stubEnv('DATABASE_URL', process.env.ALLRICE_TEST_DATABASE_URL!);
      vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '0');
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'a'.repeat(64));
      vi.stubEnv(
        'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
        'sha256:' + 'a'.repeat(64),
      );
      fixture = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      cookie.storage = runtimeFixtureStorage(fixture.db);
      for (const kind of ['once', 'recurring'] as const) {
        const reference = {
          artifactId: 'sha256:' + 'a'.repeat(64),
          profileId: `allrice-${kind}-control-v1`,
          storageId: 'synthetic-sql-only',
          stateRoot: fixture.storageRoot,
        };
        vi.stubEnv(`ALLRICE_NATIVE_${kind.toUpperCase()}_ENABLED`, '1');
        vi.stubEnv(
          `ALLRICE_NATIVE_${kind.toUpperCase()}_REFERENCE`,
          JSON.stringify(reference),
        );
        await (
          kind === 'once'
            ? initializeNativeOncePartition
            : initializeNativeRecurringPartition
        )(reference);
      }
      const source = await createEmployeeAdministrationFixture(fixture.db);
      runtimePackage = buildEmployeeRuntimePackage({
        revision: 1,
        definition: {
          ...source.definition,
          capabilities: {
            ...source.definition.capabilities,
            nativeSkillIds: [],
          },
        },
        skills: [],
      });
    }, 120000);
    beforeEach(() => {
      cookie.token = '';
    });
    async function expectEmployeeQuota(response: Response, message: string) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'QUOTA_EXCEEDED',
          message,
          retryable: false,
        },
      });
    }
    afterAll(async () => {
      cookie.token = '';
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    });
    async function setup(executionGeneration?: '4.0') {
      const f = await createRunAuthorityFixture(fixture.db, {
        configure: false,
        memberRole: 'member',
        executionGeneration,
        runtimePackage,
        toolNames: runtimePackage.runtimeManifest.toolNames,
        allowedTools: runtimePackage.runtimeManifest.toolNames,
        runtimePolicy: {
          harness: 'dsh',
          provider: runtimePackage.runtimeManifest.provider,
          model: runtimePackage.runtimeManifest.model,
          reasoningEffort: 'xhigh',
          timeoutMs: 300000,
          fallbackModels: [],
          credentialReference: 'deployment:synthetic-never-resolved',
          baseUrl: null,
        },
      });
      await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
      const login = await createSession(f.user);
      const context = await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!context) throw Error('synthetic_cookie_login_failed');
      cookie.token = login.token;
      return {
        ...f,
        login,
        context,
        selection: {
          workspaceId: f.workspace,
          employeeInstanceId: f.assignment,
          threadId: f.session,
        },
      };
    }
    type Fixture = Awaited<ReturnType<typeof setup>>;
    function request(
      f: Fixture,
      post = false,
      selection: Record<string, string> = f.selection,
    ) {
      return new Request(
        `https://allrice.test/api/v1/d-entry/${post ? 'admission' : 'identity'}${post ? '' : '?' + new URLSearchParams(selection)}`,
        {
          method: post ? 'POST' : 'GET',
          headers: {
            host: 'allrice.test',
            origin: 'https://allrice.test',
            'x-allrice-organization-id': f.org,
            'x-allrice-workspace-id': f.workspace,
          },
          ...(post ? { body: JSON.stringify(selection) } : {}),
        },
      );
    }
    function legacyRequest(
      f: Fixture,
      sessionId: string,
      path: string,
      method: string,
      body: unknown,
    ) {
      return new Request(
        `https://allrice.test/api/v1/sessions/${sessionId}${path}?workspaceId=${f.workspace}`,
        {
          method,
          headers: {
            host: 'allrice.test',
            origin: 'https://allrice.test',
            'content-type': 'application/json',
            'x-allrice-organization-id': f.org,
            'x-allrice-workspace-id': f.workspace,
          },
          body: JSON.stringify(body),
        },
      );
    }
    function rootRequest(
      f: Pick<Fixture, 'org' | 'workspace'>,
      selection: Awaited<ReturnType<typeof enabledFour>>['selection'],
    ) {
      return new Request('https://allrice.test/api/v1/d-entry/native-root', {
        method: 'POST',
        headers: {
          host: 'allrice.test',
          origin: 'https://allrice.test',
          'x-allrice-organization-id': f.org,
          'x-allrice-workspace-id': f.workspace,
        },
        body: JSON.stringify({ selection }),
      });
    }
    const route = (id: string) => ({ params: Promise.resolve({ id }) });
    async function four(
      f: Pick<Fixture, 'context' | 'workspace' | 'assignment'>,
    ) {
      return createChatSession(
        f.context,
        {
          workspaceId: f.workspace,
          employeeInstanceId: f.assignment,
          title: 'Only the 4.0 writer may continue this thread',
        },
        { executionGeneration: '4.0' },
      );
    }
    async function enabledFour() {
      const f = await setup(),
        thread = await four(f);
      const selection = { ...f.selection, threadId: thread.id };
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      const policy = await updateDEntryReleasePolicy(f.context, {
        revision: 'not-a-published-revision',
        defaultGeneration: '3.x',
        selections: [{ organizationId: f.org, personId: f.user }],
      });
      const identity = await requireDEntryNativeIdentity(f.context, selection);
      return { ...f, thread, selection, identity, policy };
    }
    const clearPublished =
      () => fixture.db`delete from allrice_settings where scope_type='system'
      and scope_id is null and key=${dEntryReleasePolicyKey}`;
    function creation(
      f: Pick<Fixture, 'org' | 'user'>,
      nativeSessionId = 'dsh-host-created-root',
    ) {
      return {
        nativeSessionId,
        host: {
          binding: {
            organizationId: f.org,
            personId: f.user,
            vmId: randomUUID(),
            instanceId: randomUUID(),
            leaseEpoch: 1,
          },
          bindingRef: randomUUID(),
          rosterDigest: 'sql-host-receipt-double',
        },
      };
    }

    async function probeRootFromOtherProcess(
      f: Awaited<ReturnType<typeof enabledFour>>,
      host: ReturnType<typeof creation>['host'],
    ) {
      const [scope] = await fixture.db`select current_schema() schema`;
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      url.searchParams.set('options', `-csearch_path=${scope!.schema}`);
      const stop = new AbortController();
      const probe = promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `
        const { ensureDEntryNativeRoot } = await import(process.env.MET271_ROOT_MODULE);
        const { closeDatabase } = await import(process.env.MET271_CLIENT_MODULE);
        const { context, selection, identity, host, operationId } = JSON.parse(process.env.MET271_ROOT_INPUT);
        let calls = 0;
        try {
          const pin = await ensureDEntryNativeRoot(context, selection, identity, {
            operationId, host, signal: new AbortController().signal,
            async create() { calls++; throw Error('unexpected native replay'); },
          });
          console.log(JSON.stringify({ calls, root: pin.rootNativeSessionId }));
        } catch (error) { console.log(JSON.stringify({ calls, error: error.message })); }
        finally { await closeDatabase(); }
      `,
        ],
        {
          signal: stop.signal,
          env: {
            ...process.env,
            DATABASE_URL: url.toString(),
            MET271_ROOT_MODULE: new URL(
              '../../../../packages/database/src/d-entry-native-root.ts',
              import.meta.url,
            ).href,
            MET271_CLIENT_MODULE: new URL(
              '../../../../packages/database/src/core/client.ts',
              import.meta.url,
            ).href,
            MET271_ROOT_INPUT: JSON.stringify({
              context: f.context,
              selection: f.selection,
              identity: f.identity,
              host,
              operationId: randomUUID(),
            }),
          },
        },
      );
      // AbortError alone is not process completion: join the actual close event.
      const exited = new Promise<void>((resolve) =>
        probe.child.once('close', () => resolve()),
      );
      let closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= (async () => {
          stop.abort();
          await exited;
        })());
      probes.add(close);
      void probe.catch(() => {}); // Teardown may cancel an interrupted test.
      try {
        const { stdout } = await probe;
        return JSON.parse(stdout.trim()) as {
          calls: number;
          error?: string;
          root?: string;
        };
      } finally {
        await close();
        probes.delete(close);
      }
    }

    it('persists only host creation provenance, scopes duplicate ids, and keeps the root stable across ordinary lease restarts', async () => {
      const f = await enabledFour(),
        fact = creation(f),
        create = vi.fn(async () => fact),
        signal = new AbortController().signal;
      try {
        const pin = await ensureDEntryNativeRoot(
          f.context,
          f.selection,
          f.identity,
          { operationId: randomUUID(), host: fact.host, signal, create },
        );
        const read = await getDEntryNativeRootPin(f.context, f.selection);
        expect(read).toEqual(pin);
        const restartedHost = {
          ...fact.host,
          binding: {
            ...fact.host.binding,
            instanceId: randomUUID(),
            leaseEpoch: 2,
          },
          bindingRef: randomUUID(),
        };
        const afterRestart = vi.fn(async () => ({
          ...fact,
          host: restartedHost,
        }));
        expect(
          await ensureDEntryNativeRoot(f.context, f.selection, f.identity, {
            operationId: randomUUID(),
            host: restartedHost,
            signal,
            create: afterRestart,
          }),
        ).toEqual(pin);
        expect(afterRestart).not.toHaveBeenCalled();
        const [row] =
          await fixture.db`select native_root_origin,d_entry_native_root from allrice_chat_sessions where id=${f.thread.id}`;
        expect(row!.native_root_origin).toBeNull();
        expect(row!.d_entry_native_root).toMatchObject({
          identity: f.identity,
          host: fact.host,
          releaseRevision: f.policy.revision,
        });
        await expect(
          fixture.db`update allrice_chat_sessions set d_entry_native_root=null where id=${f.thread.id}`,
        ).rejects.toThrow('D entry native root is immutable');
        const second = await four(f),
          secondSelection = { ...f.selection, threadId: second.id };
        const secondIdentity = await requireDEntryNativeIdentity(
          f.context,
          secondSelection,
        );
        await expect(
          ensureDEntryNativeRoot(f.context, secondSelection, secondIdentity, {
            operationId: randomUUID(),
            host: fact.host,
            signal,
            create: async () => fact,
          }),
        ).rejects.toMatchObject({ code: '23505' });
        const neverReplay = vi.fn(async () => fact);
        await expect(
          ensureDEntryNativeRoot(f.context, secondSelection, secondIdentity, {
            operationId: randomUUID(),
            host: fact.host,
            signal,
            create: neverReplay,
          }),
        ).rejects.toThrow('D_ENTRY_ROOT_CREATION_UNCONFIRMED');
        expect(neverReplay).not.toHaveBeenCalled();
        // Same native id in a different persistent VM namespace is legal; it
        // never changes the original thread's root or temporary owner lease.
        const third = await four(f),
          thirdSelection = { ...f.selection, threadId: third.id },
          thirdIdentity = await requireDEntryNativeIdentity(
            f.context,
            thirdSelection,
          );
        const otherVm = {
          ...fact,
          host: {
            ...fact.host,
            binding: { ...fact.host.binding, vmId: randomUUID() },
          },
        };
        await ensureDEntryNativeRoot(f.context, thirdSelection, thirdIdentity, {
          operationId: randomUUID(),
          host: otherVm.host,
          signal,
          create: async () => otherVm,
        });
        const [legacy] =
          await fixture.db`select count(*)::int n from allrice_native_session_bindings where context_id in (${f.thread.id},${second.id})`;
        const [runs] =
          await fixture.db`select count(*)::int n from allrice_employee_runs where session_id in (${f.thread.id},${second.id})`;
        expect(legacy!.n).toBe(0);
        expect(runs!.n).toBe(0);
        expect(create).toHaveBeenCalledTimes(1);
      } finally {
        await clearPublished();
      }
    });

    it('stores only the current native title for the registered 4.0 root and fences a delayed title', async () => {
      const f = await enabledFour();
      const fact = creation(f);
      const binding = fact.host.binding;
      const signal = new AbortController().signal;
      const observed = deferred<void>();
      const release = deferred<void>();
      let pending: Promise<void> | undefined;
      try {
        const pin = await ensureDEntryNativeRoot(
          f.context,
          f.selection,
          f.identity,
          {
            operationId: randomUUID(),
            host: fact.host,
            signal,
            create: async () => fact,
          },
        );
        await fixture.db`insert into person_virtual_machines
          (person_id, vm_id, organization_id, phase, disk_tier, instance_id, lease_epoch, native_created, egress_receipt)
          values (${f.user}, ${binding.vmId}, ${f.org}, 'running', 'warm', ${binding.instanceId},
            ${binding.leaseEpoch}, true, ${fixture.db.json({ source: 'synthetic-title' })})`;
        const readStored = async () =>
          (
            await fixture.db`select title from allrice_chat_sessions where id=${f.thread.id}`
          )[0]!.title;
        const sync = (read: (signal: AbortSignal) => Promise<string>) =>
          syncDEntryNativeRootTitle(f.context, pin, binding, read, signal);
        await sync(async () => '自动生成标题');
        expect(await readStored()).toBe('自动生成标题');

        const delayed = vi
          .fn<() => Promise<string>>()
          .mockImplementationOnce(async () => {
            observed.resolve();
            await release.promise;
            return '过时的自动标题';
          })
          // After the other page commits, re-read the authoritative title.
          .mockResolvedValue('自动生成标题');
        pending = sync(delayed);
        void pending.catch(() => {});
        await Promise.race([observed.promise, pending]);
        await sync(async () => '自动生成标题'); // The user can rename back to the stored title.
        release.resolve();
        await pending;
        expect(delayed).toHaveBeenCalledTimes(2);
        expect(await readStored()).toBe('自动生成标题');

        await sync(async () => '本人手动命名');
        const misleadingTitle = vi.fn(async () => '串写标题');
        for (const other of [
          { ...pin, rootNativeSessionId: 'child' },
          {
            ...pin,
            identity: { ...pin.identity, employeeInstanceId: randomUUID() },
          },
          {
            ...pin,
            identity: { ...pin.identity, organizationId: randomUUID() },
          },
        ])
          await expect(
            syncDEntryNativeRootTitle(
              f.context,
              other,
              binding,
              misleadingTitle,
              signal,
            ),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(misleadingTitle).not.toHaveBeenCalled();
        await expect(
          syncDEntryNativeRootTitle(
            f.context,
            pin,
            { ...binding, leaseEpoch: binding.leaseEpoch + 1 },
            misleadingTitle,
            signal,
          ),
        ).rejects.toMatchObject({ code: 'authorization_denied' });

        const locked = deferred<void>();
        const unlock = deferred<void>();
        const holder = fixture.db.begin(async (tx) => {
          await tx`select id from allrice_chat_sessions where id=${f.thread.id} for no key update`;
          locked.resolve();
          await unlock.promise;
        });
        let writeFailure: unknown;
        let blocked: Promise<void> | undefined;
        try {
          await Promise.race([locked.promise, holder]);
          blocked = sync(async () => '遇到行锁的标题').catch(
            (error: unknown) => {
              writeFailure = error;
            },
          );
          await vi.waitFor(
            () =>
              expect(writeFailure).toMatchObject({
                message: 'employee_access_busy',
              }),
            { timeout: 7000 },
          );
          expect(await readStored()).toBe('本人手动命名');
        } finally {
          unlock.resolve();
          await Promise.allSettled([holder, blocked]);
        }

        await expect(
          sync(async () => {
            await revokeSession(f.login.token);
            return '失权后标题';
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(await readStored()).toBe('本人手动命名');
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
        await clearPublished();
      }
    });

    it('registers native page create and fork replies exactly once under the current person VM lease', async () => {
      const f = await enabledFour();
      const created = creation(f, 'native-page-created');
      const binding = created.host.binding;
      const identity = { ...f.identity, threadId: null };
      const signal = new AbortController().signal;
      try {
        await fixture.db`insert into person_virtual_machines
          (person_id, vm_id, organization_id, phase, disk_tier, instance_id, lease_epoch, native_created, egress_receipt)
          values (${f.user}, ${binding.vmId}, ${f.org}, 'running', 'warm', ${binding.instanceId},
            ${binding.leaseEpoch}, true, ${fixture.db.json({ source: 'synthetic-registration' })})`;

        const first = await registerDEntryPageNativeRoot(
          f.context,
          identity,
          created,
          signal,
        );
        const { thread: directoryRow, ...firstRoot } = first;
        expect(first.identity.threadId).toEqual(expect.any(String));
        expect(first.identity.threadId).not.toBe(f.thread.id);
        expect(directoryRow).toMatchObject({
          id: first.identity.threadId,
          ownerId: f.user,
          organizationId: f.org,
          workspaceId: first.identity.workspaceId,
          employeeInstanceId: first.identity.employeeInstanceId,
          visibility: 'private',
          archivedAt: null,
        });
        expect(first).toMatchObject({
          rootNativeSessionId: created.nativeSessionId,
          vmId: binding.vmId,
        });
        expect(
          await registerDEntryPageNativeRoot(
            f.context,
            identity,
            created,
            signal,
          ),
        ).toEqual(first);
        expect(
          await getDEntryPageNativeRoot(
            f.context,
            identity,
            binding.vmId,
            created.nativeSessionId,
          ),
        ).toEqual(firstRoot);

        const forked = {
          ...created,
          nativeSessionId: 'native-page-forked',
          forkSource: { nativeSessionId: created.nativeSessionId, root: first },
        };
        await expect(
          registerDEntryPageNativeRoot(
            f.context,
            identity,
            {
              ...forked,
              forkSource: {
                ...forked.forkSource,
                root: { ...first, rootOriginDigest: 'replaced-source' },
              },
            },
            signal,
          ),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        const fork = await registerDEntryPageNativeRoot(
          f.context,
          first.identity,
          forked,
          signal,
        );
        const { thread: forkDirectoryRow, ...forkRoot } = fork;
        expect(fork.identity.threadId).not.toBe(first.identity.threadId);
        expect(forkDirectoryRow).toMatchObject({
          id: fork.identity.threadId,
          ownerId: f.user,
          organizationId: f.org,
          visibility: 'private',
          archivedAt: null,
        });
        expect(fork).toMatchObject({
          rootNativeSessionId: forked.nativeSessionId,
          forkedFromNativeSessionId: created.nativeSessionId,
        });
        expect(
          await registerDEntryPageNativeRoot(
            f.context,
            first.identity,
            forked,
            signal,
          ),
        ).toEqual(fork);
        await fixture.db`update allrice_chat_sessions set archived_at=now() where id=${first.identity.threadId}`;
        await expect(
          registerDEntryPageNativeRoot(
            f.context,
            identity,
            { ...forked, nativeSessionId: 'native-rejected-archived-source' },
            signal,
          ),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(
          await getDEntryNativeRootPin(f.context, {
            ...f.selection,
            threadId: fork.identity.threadId,
          }),
        ).toEqual(forkRoot);

        const other = await setup();
        await fixture.db`insert into allrice_memberships (organization_id, workspace_id, user_id, role)
          values (${f.org}, ${f.workspace}, ${other.user}, 'member')`;
        const stranger = await authenticateSession(other.login.token, {
          organizationId: f.org,
          workspaceId: f.workspace,
        });
        if (!stranger) throw Error('Synthetic member login unavailable');
        await expect(
          registerDEntryPageNativeRoot(
            stranger,
            identity,
            {
              ...created,
              nativeSessionId: 'native-rejected-actor',
            },
            signal,
          ),
        ).rejects.toMatchObject({ code: 'authorization_denied' });

        await fixture.db`update person_virtual_machines set lease_epoch=lease_epoch + 1 where vm_id=${binding.vmId}`;
        await expect(
          registerDEntryPageNativeRoot(
            f.context,
            identity,
            {
              ...created,
              nativeSessionId: 'native-rejected-old-epoch',
            },
            signal,
          ),
        ).rejects.toMatchObject({ code: 'authorization_denied' });

        const threads =
          await fixture.db`select id, d_entry_native_root->>'nativeSessionId' as native_session_id
          from allrice_chat_sessions where organization_id=${f.org} and workspace_id=${f.workspace}
            and execution_generation='4.0'`;
        expect(threads).toHaveLength(3);
        expect(threads).toEqual(
          expect.arrayContaining([
            { id: f.thread.id, native_session_id: null },
            {
              id: first.identity.threadId,
              native_session_id: created.nativeSessionId,
            },
            {
              id: fork.identity.threadId,
              native_session_id: forked.nativeSessionId,
            },
          ]),
        );
      } finally {
        await clearPublished();
      }
    });

    it('reads only the persistent root for archived/withdrawn viewer history and rechecks the current employee revision', async () => {
      const f = await enabledFour(),
        fact = creation(f),
        signal = new AbortController().signal,
        feed = createDEntryAuthorityFeed(
          process.env.ALLRICE_TEST_DATABASE_URL!,
        );
      let watcher:
        Awaited<ReturnType<typeof watchDEntryHistoryAuthority>> | undefined;
      try {
        const pin = await ensureDEntryNativeRoot(
          f.context,
          f.selection,
          f.identity,
          {
            operationId: randomUUID(),
            host: fact.host,
            signal,
            create: async () => fact,
          },
        );
        await clearPublished();
        await fixture.db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
        await fixture.db`update allrice_employee_instances set archived_at=clock_timestamp() where id=${f.assignment}`;
        await fixture.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.thread.id}`;
        await fixture.db`update allrice_memberships set role='viewer' where id=${f.membership}`;
        expect(await getDEntryHistoryRootPin(f.context, f.selection)).toEqual(
          pin,
        );
        await expect(
          getDEntryNativeRootPin(f.context, f.selection),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        watcher = await watchDEntryHistoryAuthority(
          f.context,
          f.selection,
          f.identity,
          signal,
          feed,
        );
        const revoked = once(watcher.revoked, 'abort');
        await fixture.db`update allrice_employee_instances set revision=revision+1 where id=${f.assignment}`;
        await revoked;
        expect(watcher.revoked.reason).toMatchObject({
          code: 'authorization_denied',
        });
        expect(await getDEntryHistoryRootPin(f.context, f.selection)).toEqual({
          ...pin,
          identity: {
            ...f.identity,
            employeeRevision: f.identity.employeeRevision + 1,
          },
        });
      } finally {
        await watcher?.close();
        await feed.close();
        await clearPublished();
      }
    });

    it('returns null for absent or claim-only history without creating, rewriting or falling back to a legacy root', async () => {
      const f = await enabledFour(),
        fact = creation(f),
        create = vi.fn(async () => {
          throw Error('unknown-native-reply');
        });
      try {
        expect(
          await getDEntryHistoryRootPin(f.context, f.selection),
        ).toBeNull();
        await expect(
          getDEntryHistoryRootPin(f.context, {
            ...f.selection,
            threadId: f.session,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        await expect(
          ensureDEntryNativeRoot(f.context, f.selection, f.identity, {
            operationId: randomUUID(),
            host: fact.host,
            signal: new AbortController().signal,
            create,
          }),
        ).rejects.toThrow('unknown-native-reply');
        const snapshot = () =>
          fixture.db`select d_entry_native_root_claim,d_entry_native_root,native_root_origin from allrice_chat_sessions where id=${f.thread.id}`;
        const before = await snapshot();
        expect(before[0]!.d_entry_native_root_claim).not.toBeNull();
        expect(
          await getDEntryHistoryRootPin(f.context, f.selection),
        ).toBeNull();
        expect(await snapshot()).toEqual(before);
        expect(before[0]!.d_entry_native_root).toBeNull();
        expect(before[0]!.native_root_origin).toBeNull();
        expect(create).toHaveBeenCalledTimes(1);
        const [runs] =
          await fixture.db`select count(*)::int n from allrice_employee_runs where session_id=${f.thread.id}`;
        expect(runs!.n).toBe(0);
      } finally {
        await clearPublished();
      }
    });

    for (const loss of [
      'user',
      'session',
      'membership',
      'organization',
      'workspace',
    ] as const)
      it(`revokes cold history from the actual current ${loss} authority, despite an old authenticated context`, async () => {
        const f = await enabledFour(),
          feed = createDEntryAuthorityFeed(
            process.env.ALLRICE_TEST_DATABASE_URL!,
          );
        let watcher:
          Awaited<ReturnType<typeof watchDEntryHistoryAuthority>> | undefined;
        try {
          watcher = await watchDEntryHistoryAuthority(
            f.context,
            f.selection,
            f.identity,
            new AbortController().signal,
            feed,
          );
          const revoked = once(watcher.revoked, 'abort');
          await {
            user: () =>
              fixture.db`update allrice_users set status='disabled' where id=${f.user}`,
            session: () => revokeSession(f.login.token),
            membership: () =>
              fixture.db`update allrice_memberships set active=false where id=${f.membership}`,
            organization: () =>
              fixture.db`update allrice_organizations set archived_at=clock_timestamp() where id=${f.org}`,
            workspace: () =>
              fixture.db`update allrice_workspaces set archived_at=clock_timestamp() where id=${f.workspace}`,
          }[loss]();
          await revoked;
          await expect(
            getDEntryHistoryRootPin(f.context, f.selection),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
        } finally {
          await watcher?.close();
          await feed.close();
          await clearPublished();
        }
      });

    // Fault injection is ONLY at the caller's transaction-ACK boundary. The
    // transactions/claims/pins below are real PG facts, not an in-memory store.
    for (const lostAt of ['claim-ack', 'native-reply', 'pin-ack'] as const)
      it(`retains durable at-most-once facts after ${lostAt}, without creating again on a second connection/request`, async () => {
        const f = await enabledFour(),
          fact = creation(f),
          operationId = randomUUID(),
          signal = new AbortController().signal,
          unknown = Error(`injected ${lostAt} lost`);
        let commits = 0;
        const lostCommit =
          lostAt === 'claim-ack' ? 1 : lostAt === 'pin-ack' ? 2 : 0;
        const actual = fixture.db;
        const withLostAck = new Proxy(actual, {
          get(target, key, receiver) {
            if (key !== 'begin') return Reflect.get(target, key, receiver);
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(target.begin, target, args);
              if (++commits === lostCommit) throw unknown;
              return result;
            };
          },
        });
        const create = vi.fn(async () => {
          if (lostAt === 'native-reply') throw unknown;
          return fact;
        });
        try {
          vi.mocked(client.getDatabase).mockReturnValue(withLostAck);
          await expect(
            ensureDEntryNativeRoot(f.context, f.selection, f.identity, {
              operationId,
              host: fact.host,
              signal,
              create,
            }),
          ).rejects.toBe(unknown);
          vi.mocked(client.getDatabase).mockReturnValue(actual);
          const [row] =
            await actual`select d_entry_native_root_claim,d_entry_native_root
            from allrice_chat_sessions where id=${f.thread.id}`;
          expect(row!.d_entry_native_root_claim).toMatchObject({
            operationId,
            identity: f.identity,
            host: fact.host,
          });
          expect(create).toHaveBeenCalledTimes(lostAt === 'claim-ack' ? 0 : 1);
          const again = vi.fn(async () => fact);
          for (const nextOperation of [operationId, randomUUID()]) {
            const next = ensureDEntryNativeRoot(
              f.context,
              f.selection,
              f.identity,
              {
                operationId: nextOperation,
                host: fact.host,
                signal,
                create: again,
              },
            );
            if (lostAt === 'pin-ack') {
              expect(row!.d_entry_native_root).not.toBeNull();
              expect(await next).toEqual(
                await getDEntryNativeRootPin(f.context, f.selection),
              );
            } else {
              expect(row!.d_entry_native_root).toBeNull();
              await expect(next).rejects.toThrow(
                'D_ENTRY_ROOT_CREATION_UNCONFIRMED',
              );
              await expect(
                getDEntryNativeRootPin(f.context, f.selection),
              ).rejects.toThrow('NATIVE_QUERY_BINDING_UNAVAILABLE');
            }
          }
          expect(again).not.toHaveBeenCalled();
          const otherProcess = await probeRootFromOtherProcess(f, fact.host);
          expect(otherProcess.calls).toBe(0);
          expect(otherProcess).toMatchObject(
            lostAt === 'pin-ack'
              ? { root: fact.nativeSessionId }
              : { error: 'D_ENTRY_ROOT_CREATION_UNCONFIRMED' },
          );
          await expect(actual`update allrice_chat_sessions set d_entry_native_root_claim=
            jsonb_set(d_entry_native_root_claim,'{operationId}',${actual.json(randomUUID())}) where id=${f.thread.id}`).rejects.toThrow(
            'D entry native creation claim is immutable',
          );
        } finally {
          vi.mocked(client.getDatabase).mockReturnValue(actual);
          await clearPublished();
        }
      });

    it('serializes real root creators without duplicate dispatch and rechecks a committed member downgrade before the final pin', async () => {
      const f = await enabledFour(),
        fact = creation(f),
        signal = new AbortController().signal;
      const entered = deferred<void>(),
        release = deferred<void>();
      let pending: Promise<unknown> | undefined;
      try {
        pending = ensureDEntryNativeRoot(f.context, f.selection, f.identity, {
          operationId: randomUUID(),
          host: fact.host,
          signal,
          create: async () => {
            entered.resolve();
            await release.promise;
            return fact;
          },
        });
        void pending.catch(() => {});
        await entered.promise;
        const competing = vi.fn(async () => fact);
        await expect(
          ensureDEntryNativeRoot(f.context, f.selection, f.identity, {
            operationId: randomUUID(),
            host: fact.host,
            signal,
            create: competing,
          }),
        ).rejects.toThrow('D_ENTRY_ROOT_CREATION_UNCONFIRMED');
        expect(competing).not.toHaveBeenCalled();
        await fixture.db`update allrice_memberships set role='viewer' where user_id=${f.user} and organization_id=${f.org}`;
        release.resolve();
        await expect(pending).rejects.toMatchObject({
          code: 'authorization_denied',
        });
        const [row] =
          await fixture.db`select d_entry_native_root,native_root_origin from allrice_chat_sessions where id=${f.thread.id}`;
        expect(row).toMatchObject({
          d_entry_native_root: null,
          native_root_origin: null,
        });
        // The create really ran, but current authority denied the final write.
        // Its immutable dispatch fact, not a connection lock, prevents replay.
        await fixture.db`update allrice_memberships set role='member' where user_id=${f.user} and organization_id=${f.org}`;
        const replay = vi.fn(async () => fact);
        await expect(
          ensureDEntryNativeRoot(f.context, f.selection, f.identity, {
            operationId: randomUUID(),
            host: fact.host,
            signal,
            create: replay,
          }),
        ).rejects.toThrow('D_ENTRY_ROOT_CREATION_UNCONFIRMED');
        expect(replay).not.toHaveBeenCalled();
        await fixture.db`update allrice_memberships set role='viewer' where user_id=${f.user} and organization_id=${f.org}`;
        expect(
          await resolveDEntryIdentity(f.context, f.selection, 'history'),
        ).toMatchObject({ threadId: f.thread.id });
      } finally {
        release.resolve();
        await pending?.catch(() => {});
        await clearPublished();
      }
    });

    for (const otherOnly of [true, false])
      it(`rechecks the current person's rollout after create, ignoring only unrelated policy changes (otherOnly=${otherOnly})`, async () => {
        const f = await enabledFour(),
          other = otherOnly ? await setup() : null,
          fact = creation(f),
          operationId = randomUUID(),
          signal = new AbortController().signal;
        const create = vi.fn(async () => {
          const policy = await updateDEntryReleasePolicy(f.context, {
            ...f.policy,
            selections: other
              ? [
                  ...f.policy.selections,
                  { organizationId: other.org, personId: other.user },
                ]
              : [],
          });
          expect(policy.revision).not.toBe(f.policy.revision);
          return fact;
        });
        try {
          const result = ensureDEntryNativeRoot(
            f.context,
            f.selection,
            f.identity,
            {
              operationId,
              host: fact.host,
              signal,
              create,
            },
          );
          if (otherOnly) {
            expect(await result).toMatchObject({
              rootNativeSessionId: fact.nativeSessionId,
            });
            expect(
              await getDEntryNativeRootPin(f.context, f.selection),
            ).toEqual(await result);
          } else
            await expect(result).rejects.toMatchObject({
              code: 'authorization_denied',
            });
          const [row] =
            await fixture.db`select d_entry_native_root_claim,d_entry_native_root,native_root_origin
            from allrice_chat_sessions where id=${f.thread.id}`;
          const birth = {
            operationId,
            identity: f.identity,
            host: fact.host,
            releaseRevision: f.policy.revision,
          };
          expect(row!.d_entry_native_root_claim).toMatchObject(birth);
          expect(row!.native_root_origin).toBeNull();
          if (otherOnly)
            expect(row!.d_entry_native_root).toMatchObject({
              ...birth,
              nativeSessionId: fact.nativeSessionId,
            });
          else {
            expect(row!.d_entry_native_root).toBeNull();
            await updateDEntryReleasePolicy(f.context, f.policy);
            const replay = vi.fn(async () => fact);
            await expect(
              ensureDEntryNativeRoot(f.context, f.selection, f.identity, {
                operationId: randomUUID(),
                host: fact.host,
                signal,
                create: replay,
              }),
            ).rejects.toThrow('D_ENTRY_ROOT_CREATION_UNCONFIRMED');
            expect(replay).not.toHaveBeenCalled();
          }
          expect(create).toHaveBeenCalledTimes(1);
        } finally {
          await clearPublished();
        }
      });

    it.each(['native', 'history'] as const)(
      'uses the real PG commit notification, discards rolled-back revocation, and closes the subscribe-before-recheck gap (%s)',
      async (access) => {
        const watchAuthority =
          access === 'history'
            ? watchDEntryHistoryAuthority
            : watchDEntryNativeAuthority;
        const f = await enabledFour(),
          feed = createDEntryAuthorityFeed(
            process.env.ALLRICE_TEST_DATABASE_URL!,
          );
        let watcher:
          Awaited<ReturnType<typeof watchDEntryNativeAuthority>> | undefined;
        try {
          watcher = await watchAuthority(
            f.context,
            f.selection,
            f.identity,
            new AbortController().signal,
            feed,
          );
          await expect(
            fixture.db.begin(async (tx) => {
              await tx`update allrice_memberships set role='viewer',active=${access !== 'history'} where user_id=${f.user} and organization_id=${f.org}`;
              expect(watcher!.revoked.aborted).toBe(false);
              throw Error('rollback-revocation');
            }),
          ).rejects.toThrow('rollback-revocation');
          expect(watcher.revoked.aborted).toBe(false);
          const revoked = new Promise<void>((resolve) =>
            watcher!.revoked.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
          await fixture.db.begin(async (tx) => {
            await tx`update allrice_memberships set role='viewer',active=${access !== 'history'} where user_id=${f.user} and organization_id=${f.org}`;
            expect(watcher!.revoked.aborted).toBe(false); // No pre-commit invalidation.
          });
          await revoked;
          expect(watcher.revoked.reason).toMatchObject({
            code: 'authorization_denied',
          });
          await watcher.close();
          watcher = undefined;
          await fixture.db`update allrice_memberships set role='member',active=true where user_id=${f.user} and organization_id=${f.org}`;
          const duringSubscribe = {
            ...feed,
            async subscribe(...args: Parameters<typeof feed.subscribe>) {
              const detach = await feed.subscribe(...args);
              await fixture.db`update allrice_memberships set role='viewer',active=${access !== 'history'} where user_id=${f.user} and organization_id=${f.org}`;
              return detach;
            },
          };
          await expect(
            watchAuthority(
              f.context,
              f.selection,
              f.identity,
              new AbortController().signal,
              duringSubscribe,
            ),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
        } finally {
          await watcher?.close();
          await feed.close();
          await clearPublished();
        }
      },
    );

    it('rechecks release/employee changes and expires at the real login deadline; notification disconnect aborts idle consumers', async () => {
      const f = await enabledFour(),
        feed = createDEntryAuthorityFeed(
          process.env.ALLRICE_TEST_DATABASE_URL!,
        );
      let history:
        Awaited<ReturnType<typeof watchDEntryHistoryAuthority>> | undefined;
      let watcher:
        Awaited<ReturnType<typeof watchDEntryNativeAuthority>> | undefined;
      const open = () =>
        watchDEntryNativeAuthority(
          f.context,
          f.selection,
          f.identity,
          new AbortController().signal,
          feed,
        );
      const abortOf = (watch: NonNullable<typeof watcher>) =>
        new Promise<void>((resolve) => {
          if (watch.revoked.aborted) resolve();
          else
            watch.revoked.addEventListener('abort', () => resolve(), {
              once: true,
            });
        });
      try {
        history = await watchDEntryHistoryAuthority(
          f.context,
          f.selection,
          f.identity,
          new AbortController().signal,
          feed,
        );
        watcher = await open();
        const releaseRevoked = abortOf(watcher);
        await updateDEntryReleasePolicy(f.context, {
          ...f.policy,
          selections: [],
        });
        await releaseRevoked;
        await watcher.close();
        await updateDEntryReleasePolicy(f.context, f.policy);
        watcher = await open();
        const employeeRevoked = abortOf(watcher);
        await fixture.db`update allrice_employee_instances set archived_at=clock_timestamp() where id=${f.assignment}`;
        await employeeRevoked;
        await watcher.close();
        await fixture.db`update allrice_employee_instances set archived_at=null where id=${f.assignment}`;
        // A real expires_at update (not a fabricated authenticatedAt/TTL) must
        // move the deadline of an already open subscription.
        watcher = await open();
        const expired = abortOf(watcher),
          historyExpired = abortOf(history);
        await fixture.db`update allrice_sessions set expires_at=clock_timestamp()+interval '1 second' where id=${f.login.id}`;
        await Promise.all([expired, historyExpired]);
        expect(history.revoked.reason).toMatchObject({
          code: 'authentication_required',
        });
        expect(watcher.revoked.reason).toMatchObject({
          code: 'authentication_required',
        });
        await watcher.close();
        const login = await createSession(f.user),
          context = (await authenticateSession(login.token, {
            organizationId: f.org,
            workspaceId: f.workspace,
          }))!;
        watcher = await watchDEntryNativeAuthority(
          context,
          f.selection,
          f.identity,
          new AbortController().signal,
          feed,
        );
        await feed.close();
        expect(watcher.revoked.aborted).toBe(true);
        expect(
          await resolveDEntryIdentity(context, f.selection, 'history'),
        ).toMatchObject({ threadId: f.thread.id });
      } finally {
        await history?.close();
        await watcher?.close();
        await feed.close();
        await clearPublished();
      }
    });

    it('drives the real original-Bearer HTTP root producer and current PG revocation with only native/admission ports doubled', async () => {
      const f = await enabledFour(),
        feed = createDEntryAuthorityFeed(
          process.env.ALLRICE_TEST_DATABASE_URL!,
        );
      const native = nativeEntryFixture({
        context: f.context,
        identity: f.identity,
      });
      native.rootCreate.mockResolvedValue({
        ok: true,
        value: { sessionId: native.catalog.items[0]!.sessionId },
      });
      const pinCommitted = deferred<void>(),
        letReply = deferred<void>();
      let rootReplies = 0;
      const server = await nativeEntryServer(native, {
        ...dEntryHttpDefaults,
        owners: native.deps.owners,
        data: native.deps.data,
        async ensureRoot(...args) {
          const pin = await ensureDEntryNativeRoot(...args);
          if (++rootReplies === 1) {
            pinCommitted.resolve();
            await letReply.promise;
          }
          return pin;
        },
        watch: (context, selection, identity, signal) =>
          watchDEntryNativeAuthority(
            context,
            selection,
            identity,
            signal,
            feed,
          ),
      });
      const headers = { authorization: `Bearer ${f.login.token}` };
      const previousWorkerUrl = process.env.ALLRICE_WORKER_INTERNAL_URL;
      vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', server.origin);
      try {
        const loseReply = new AbortController();
        const lostResponse = fetch(
          `${server.origin}/internal/d-entry/native-root`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(server.body),
            signal: loseReply.signal,
          },
        );
        void lostResponse.catch(() => {});
        await pinCommitted.promise;
        // Durable SQL success and a browser receiving its ACK are distinct.
        loseReply.abort();
        letReply.resolve();
        await expect(lostResponse).rejects.toThrow();
        // Real Web cookie/BFF -> original Bearer -> real Worker auth/SQL.
        const created = await createNativeRoot(rootRequest(f, f.selection));
        expect(created.status).toBe(200);
        expect(await created.json()).toMatchObject({
          rootNativeSessionId: 'dsh-root',
        });
        expect(
          (await getDEntryNativeRootPin(f.context, f.selection)).vmId,
        ).toBe(native.binding.vmId);
        expect(native.rootCreate).toHaveBeenCalledTimes(1);
        expect(
          (await server.request('native-root', server.body, headers)).status,
        ).toBe(200);
        expect(native.rootCreate).toHaveBeenCalledTimes(1); // Existing pin never redispatches create.
        const response = await server.request(
          'native-resource',
          { ...server.body, nativeSessionId: 'dsh-grandchild' },
          headers,
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          rootNativeSessionId: 'dsh-root',
          parentNativeSessionId: 'dsh-child',
        });
        const peer = new WebSocket(
          server.origin.replace('http:', 'ws:') +
            '/internal/d-entry/native-mux?' +
            new URLSearchParams({ organizationId: f.org, ...f.selection }),
          { headers },
        );
        peer.on('error', () => {});
        try {
          await once(peer, 'open');
          const closed = once(peer, 'close');
          await revokeSession(f.login.token); // Real cross-connection PG commit, no fake AbortController.
          await closed;
          await native.muxClosed.promise;
          expect(peer.readyState).toBe(WebSocket.CLOSED);
        } finally {
          peer.terminate();
        }
        expect(
          (await server.request('native-owner', server.body, headers)).status,
        ).toBe(401);
      } finally {
        letReply.resolve();
        await server.close();
        await feed.close();
        await clearPublished();
        if (previousWorkerUrl === undefined)
          delete process.env.ALLRICE_WORKER_INTERNAL_URL;
        else process.env.ALLRICE_WORKER_INTERNAL_URL = previousWorkerUrl;
      }
    });

    it('keeps published 4.0 policy from bypassing missing production owners on direct HTTP/internal/WS entry', async () => {
      const f = await enabledFour(),
        feed = createDEntryAuthorityFeed(
          process.env.ALLRICE_TEST_DATABASE_URL!,
        );
      const native = nativeEntryFixture({
        context: f.context,
        identity: f.identity,
      });
      const server = await nativeEntryServer(native, {
        ...dEntryHttpDefaults,
        watch: (context, selection, identity, signal) =>
          watchDEntryNativeAuthority(
            context,
            selection,
            identity,
            signal,
            feed,
          ),
      });
      const headers = { authorization: `Bearer ${f.login.token}` };
      const previousWorkerUrl = process.env.ALLRICE_WORKER_INTERNAL_URL;
      vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', server.origin);
      let peer: WebSocket | undefined;
      try {
        expect(
          (await createNativeRoot(rootRequest(f, f.selection))).status,
        ).toBe(503);
        expect((await readDEntryReleasePolicy()).selections).toContainEqual({
          organizationId: f.org,
          personId: f.user,
        });
        for (const [path, body] of [
          ['native-owner', server.body],
          ['native-root', server.body],
          [
            'native-resource',
            { ...server.body, nativeSessionId: 'guest-root' },
          ],
          [
            'native-rpc',
            {
              ...server.body,
              endpoint: 'session/cancel',
              payload: { args: { request: { sessionId: 'guest-root' } } },
            },
          ],
        ] as const)
          expect((await server.request(path, body, headers)).status).toBe(503);
        peer = new WebSocket(
          server.origin.replace('http:', 'ws:') +
            '/internal/d-entry/native-mux?' +
            new URLSearchParams({ organizationId: f.org, ...f.selection }),
          { headers },
        );
        peer.on('error', () => {});
        const [upgrade, rejected] = await once(peer, 'unexpected-response');
        expect(rejected.statusCode).toBe(503);
        rejected.resume();
        upgrade.destroy();
        const [row] =
          await fixture.db`select d_entry_native_root_claim,d_entry_native_root from allrice_chat_sessions where id=${f.thread.id}`;
        expect(row).toMatchObject({
          d_entry_native_root_claim: null,
          d_entry_native_root: null,
        });
        expect(native.rootCreate).not.toHaveBeenCalled();
        expect(native.data.acquireRpc).not.toHaveBeenCalled();
        expect(native.data.acquireMux).not.toHaveBeenCalled();
      } finally {
        peer?.terminate();
        await server.close();
        await feed.close();
        await clearPublished();
        if (previousWorkerUrl === undefined)
          delete process.env.ALLRICE_WORKER_INTERNAL_URL;
        else process.env.ALLRICE_WORKER_INTERNAL_URL = previousWorkerUrl;
      }
    });

    it('reads the current administrator in a read-only transaction and serves the policy without publishing', async () => {
      const f = await setup();
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      try {
        await fixture.db.begin('read only', async (tx) => {
          expect(await requireCurrentPlatformAdmin(f.context, tx, false)).toBe(
            f.user,
          );
        });
        const policy = await readDEntryReleasePolicy();
        const response = await getReleasePolicy(
          new Request(
            'https://allrice.test/api/v1/admin/d-entry-release-policy',
          ),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(await response.json()).toEqual(policy);
        const [settings] =
          await fixture.db`select count(*)::int n from allrice_settings where key=${dEntryReleasePolicyKey}`;
        const [audit] =
          await fixture.db`select count(*)::int n from allrice_audit_events
            where actor_id=${f.user} and action='d_entry_release.update'`;
        expect(settings!.n).toBe(0);
        expect(audit!.n).toBe(0);
      } finally {
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });
    it.each(['revoked', 'expired', 'disabled', 'email'] as const)(
      'rejects a retained administrator read context after %s authority changes',
      async (change) => {
        const f = await setup();
        await authorizeFixturePlatformAdministrator(fixture.db, f.user);
        try {
          await expect(getDEntryReleasePolicy(f.context)).resolves.toEqual(
            await readDEntryReleasePolicy(),
          );
          if (change === 'revoked') await revokeSession(f.login.token);
          else if (change === 'expired')
            await fixture.db`update allrice_sessions set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' where id=${f.context.sessionId}`;
          else if (change === 'disabled')
            await fixture.db`update allrice_users set status='disabled' where id=${f.user}`;
          else
            await fixture.db`update allrice_users set email=${`revoked-${randomUUID()}@example.invalid`} where id=${f.user}`;
          await expect(getDEntryReleasePolicy(f.context)).rejects.toMatchObject(
            { code: 'authorization_denied' },
          );
          const response = await getReleasePolicy(
            new Request(
              'https://allrice.test/api/v1/admin/d-entry-release-policy',
            ),
          );
          expect([401, 403]).toContain(response.status);
        } finally {
          vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
        }
      },
    );
    it('rejects an otherwise current administrator paired with another user session', async () => {
      const f = await setup(),
        other = await setup();
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      try {
        await expect(
          getDEntryReleasePolicy({
            ...f.context,
            sessionId: other.context.sessionId,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
      } finally {
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });
    it('uses the administrator email acquired under the publication locks, with zero setting/audit after a concurrent email revocation', async () => {
      const f = await setup();
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      const held = deferred<number>(),
        release = deferred<void>();
      let publish: Promise<unknown> | undefined;
      const revoke = fixture.db.begin(async (tx) => {
        await tx`select id from allrice_users where id=${f.user} for update`;
        const [backend] = await tx`select pg_backend_pid() pid`;
        held.resolve(backend!.pid);
        await release.promise;
        await tx`update allrice_users set email=${`revoked-${randomUUID()}@example.invalid`} where id=${f.user}`;
      });
      try {
        const blocker = await held.promise;
        publish = updateDEntryReleasePolicy(f.context, {
          revision: 'not-authority',
          defaultGeneration: '3.x',
          selections: [],
        });
        void publish.catch(() => {});
        await expect
          .poll(async () => {
            const [wait] =
              await fixture.db`select exists(select 1 from pg_stat_activity a
            where ${blocker}::integer=any(pg_blocking_pids(a.pid))
              and a.query like '%for share of s,u%') blocked`;
            return wait!.blocked;
          })
          .toBe(true);
        release.resolve();
        await revoke;
        await expect(publish).rejects.toMatchObject({
          code: 'authorization_denied',
        });
        const [settings] =
          await fixture.db`select count(*)::int n from allrice_settings where key=${dEntryReleasePolicyKey}`;
        const [audit] =
          await fixture.db`select count(*)::int n from allrice_audit_events
          where actor_id=${f.user} and action='d_entry_release.update'`;
        expect(settings!.n).toBe(0);
        expect(audit!.n).toBe(0);
      } finally {
        release.resolve();
        await Promise.allSettled([revoke, publish]);
      }
    });
    it('orders the first person rollout publication after an in-flight default policy reader', async () => {
      const f = await setup();
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      const held = deferred<number>();
      const release = deferred<void>();
      let publish: ReturnType<typeof updateDEntryReleasePolicy> | undefined;
      const read = fixture.db.begin(async (tx) => {
        const policy = await readDEntryReleasePolicy(tx, true);
        const [backend] = await tx`select pg_backend_pid() pid`;
        held.resolve(backend!.pid);
        await release.promise;
        return policy;
      });
      try {
        const blocker = await held.promise;
        publish = updateDEntryReleasePolicy(f.context, {
          revision: 'caller-revision',
          defaultGeneration: '3.x',
          selections: [{ organizationId: f.org, personId: f.user }],
        });
        void publish.catch(() => {});
        await expect
          .poll(async () => {
            const [wait] =
              await fixture.db`select exists(select 1 from pg_stat_activity a
                where ${blocker}::integer=any(pg_blocking_pids(a.pid))
                  and a.wait_event='advisory') blocked`;
            return wait!.blocked;
          })
          .toBe(true);
        expect((await readDEntryReleasePolicy()).revision).toBe('unpublished');
        release.resolve();
        expect((await read).revision).toBe('unpublished');
        const published = await publish;
        expect(published.selections).toEqual([
          { organizationId: f.org, personId: f.user },
        ]);
        expect(await readDEntryReleasePolicy()).toEqual(published);
      } finally {
        release.resolve();
        await Promise.allSettled([read, publish]);
        await clearPublished();
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });
    it('maps the real login cookie to current person/employee/root without starting a VM', async () => {
      const f = await setup();
      const req = request(f);
      req.headers.set('x-allrice-person-id', randomUUID());
      const response = await GET(req);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        identity: {
          organizationId: f.org,
          personId: f.user,
          employeeInstanceId: f.assignment,
          threadId: f.session,
        },
      });
      expect(response.headers.get('cache-control')).toContain('no-store');
      const admission = await POST(request(f, true));
      expect(admission.status).toBe(200);
      expect(await admission.json()).toMatchObject({
        executionGeneration: '3.x',
        policyRevision: 'unpublished',
      });
    });
    it('uses shared platform publication, defaults off, and never manufactures a 4.0 root pin or fallback', async () => {
      const f = await setup();
      const thread = await four(f);
      const selection = { ...f.selection, threadId: thread.id };
      const policy = {
        revision: 'caller-revision-is-not-authority',
        defaultGeneration: '3.x' as const,
        selections: [{ organizationId: f.org, personId: f.user }],
      };
      expect(await readDEntryReleasePolicy()).toEqual({
        revision: 'unpublished',
        defaultGeneration: '3.x',
        selections: [],
      });
      expect((await POST(request(f, true, selection))).status).toBe(403);
      await expect(
        updateDEntryReleasePolicy(f.context, policy),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      try {
        await expect(
          updateDEntryReleasePolicy(f.context, {
            ...policy,
            defaultGeneration: '4.0',
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        const published = await updateDEntryReleasePolicy(f.context, policy);
        expect(published.revision).not.toBe(policy.revision);
        expect(await readDEntryReleasePolicy()).toEqual(published);
        const [setting] =
          await fixture.db`select value from allrice_settings where scope_type='system'
          and scope_id is null and key=${dEntryReleasePolicyKey}`;
        expect(setting?.value).toEqual(published);
        // An existing 3.x writer stays 3.x. An opted-in 4.0 writer has no fake
        // native transport; exact routing is still a real owner dependency.
        expect(await (await POST(request(f, true))).json()).toMatchObject({
          executionGeneration: '3.x',
        });
        const unavailable = await POST(request(f, true, selection));
        expect(unavailable.status).toBe(503);
        expect((await unavailable.json()).error.code).toBe(
          'DEPENDENCY_UNAVAILABLE',
        );
        await expect(
          getDEntryNativeRootPin(f.context, selection),
        ).rejects.toThrow('NATIVE_QUERY_BINDING_UNAVAILABLE');
        const [unchanged] =
          await fixture.db`select native_root_origin from allrice_chat_sessions where id=${thread.id}`;
        expect(unchanged?.native_root_origin).toBeNull();
        const [count] =
          await fixture.db`select count(*)::int n from allrice_native_session_bindings where context_kind='chat' and context_id=${thread.id}`;
        expect(count?.n).toBe(0);
        await updateDEntryReleasePolicy(f.context, {
          ...policy,
          selections: [],
        });
        expect((await POST(request(f, true, selection))).status).toBe(403);
        expect((await GET(request(f, false, selection))).status).toBe(200);
        await revokeSession(f.login.token);
        await expect(
          updateDEntryReleasePolicy(f.context, policy),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
      } finally {
        await fixture.db`delete from allrice_settings where scope_type='system' and scope_id is null and key=${dEntryReleasePolicyKey}`;
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });
    it('rejects a foreign tenant/person and rechecks cookie and membership revocation', async () => {
      const f = await setup(),
        other = await setup();
      cookie.token = f.login.token;
      const foreignTenant = request(f);
      foreignTenant.headers.set('x-allrice-organization-id', other.org);
      expect((await GET(foreignTenant)).status).toBe(403);
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.org},${f.workspace},${other.user},'member')`;
      cookie.token = other.login.token;
      expect([403, 404]).toContain((await GET(request(f))).status);
      cookie.token = f.login.token;
      await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
      expect((await GET(request(f))).status).toBe(403);
      await fixture.db`update allrice_memberships set active=true where id=${f.membership}`;
      await revokeSession(f.login.token);
      expect((await GET(request(f))).status).toBe(401);
    });
    it('keeps owner history after assignment withdrawal/archival and refuses continuation', async () => {
      const f = await setup();
      await fixture.db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
      await fixture.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.session}`;
      expect((await GET(request(f))).status).toBe(200);
      expect((await POST(request(f, true))).status).toBe(403);
    });
    it('rechecks current writable authority for an already logged-in member downgraded to viewer, including new threads', async () => {
      const f = await setup(),
        thread = await four(f);
      const existing = { ...f.selection, threadId: thread.id };
      const newThread = {
        workspaceId: f.workspace,
        employeeInstanceId: f.assignment,
      };
      const policy = {
        revision: 'synthetic-approved-policy',
        defaultGeneration: '3.x' as const,
        selections: [{ organizationId: f.org, personId: f.user }],
      };
      for (const selection of [existing, newThread])
        expect(
          (await resolveDEntryAdmission(f.context, selection, policy))
            .executionGeneration,
        ).toBe('4.0');
      await fixture.db`update allrice_memberships set role='viewer' where id=${f.membership}`;
      expect(
        f.context.memberships.find((m) => m.id === f.membership)?.role,
      ).toBe('member');
      const fresh = await authenticateSession(f.login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      expect(fresh?.memberships.find((m) => m.id === f.membership)?.role).toBe(
        'viewer',
      );
      const [assignment] =
        await fixture.db`select active from allrice_employee_assignments where id=${f.assignment}`;
      expect(assignment!.active).toBe(true);
      for (const selection of [existing, newThread]) {
        await expect(
          resolveDEntryAdmission(f.context, selection, policy),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect((await POST(request(f, true, selection))).status).toBe(403);
      }
      expect((await GET(request(f, false, existing))).status).toBe(200);
      await expect(
        resolveDEntryIdentity(f.context, existing, 'history'),
      ).resolves.toMatchObject({ threadId: thread.id });
    });
    it('rejects 4.0 legacy PATCH before metadata and message visibility writes, preserving 3.x updates and history', async () => {
      const f = await setup(),
        thread = await four(f),
        messageId = randomUUID();
      await fixture.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
        values(${messageId},${f.org},${f.workspace},${thread.id},${f.user},'user','{"text":"synthetic history","citations":[]}')`;
      const snapshot =
        () => fixture.db`select s.title,s.visibility,s.archived_at,s.pinned_at,s.updated_at,m.visibility message_visibility
        from allrice_chat_sessions s join allrice_messages m on m.session_id=s.id where s.id=${thread.id}`;
      const before = await snapshot();
      for (const patch of [
        { title: 'No legacy rename' },
        { visibility: 'workspace' },
        { archived: true, stopActivity: true },
        { pinned: true },
      ]) {
        expect(
          (
            await PATCH(
              legacyRequest(f, thread.id, '', 'PATCH', patch),
              route(thread.id),
            )
          ).status,
        ).toBe(403);
        await expect(
          updateChatSession(f.context, f.workspace, thread.id, patch),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
      }
      expect(await snapshot()).toEqual(before);
      expect(
        (await GET(request(f, false, { ...f.selection, threadId: thread.id })))
          .status,
      ).toBe(200);
      const legacy = await createChatSession(f.context, {
        workspaceId: f.workspace,
        employeeInstanceId: f.assignment,
      });
      await fixture.db`insert into allrice_messages(organization_id,workspace_id,session_id,owner_id,role,content)
        values(${f.org},${f.workspace},${legacy.id},${f.user},'user','{"text":"legacy history","citations":[]}')`;
      const changed = await PATCH(
        legacyRequest(f, legacy.id, '', 'PATCH', {
          title: 'Legacy rename',
          visibility: 'workspace',
          pinned: true,
        }),
        route(legacy.id),
      );
      expect(changed.status).toBe(200);
      expect((await changed.json()).session).toMatchObject({
        title: 'Legacy rename',
        visibility: 'workspace',
      });
      const [message] =
        await fixture.db`select visibility from allrice_messages where session_id=${legacy.id}`;
      expect(message!.visibility).toBe('workspace');
      expect(
        (
          await PATCH(
            legacyRequest(f, legacy.id, '', 'PATCH', { archived: true }),
            route(legacy.id),
          )
        ).status,
      ).toBe(200);
    });
    it('rejects 4.0 legacy uploads before bytes or metadata, and guards both final file link services while preserving 3.x', async () => {
      const f = await setup(),
        thread = await four(f);
      const content = {
        fileName: 'synthetic.txt',
        mediaType: 'text/plain',
        contentBase64: Buffer.from('isolated fixture bytes').toString('base64'),
      };
      const put = vi.spyOn(cookie.storage!, 'put');
      try {
        const uploaded = await uploadAttachment(
          legacyRequest(f, f.session, '/attachments', 'POST', content),
          route(f.session),
        );
        expect(uploaded.status).toBe(201);
        const objectId = (await uploaded.json()).attachment.id as string;
        expect(put).toHaveBeenCalledTimes(1);
        const legacy = await createChatSession(f.context, {
          workspaceId: f.workspace,
          employeeInstanceId: f.assignment,
        });
        expect(
          (
            await attachWorkspaceFile(
              legacyRequest(f, legacy.id, '/attachments', 'PUT', { objectId }),
              route(legacy.id),
            )
          ).status,
        ).toBe(200);
        put.mockClear();
        const counts = () => fixture.db`select
          (select count(*)::int from allrice_storage_objects where organization_id=${f.org}) objects,
          (select count(*)::int from allrice_file_references where organization_id=${f.org}) links`;
        const before = await counts();
        expect(
          (
            await uploadAttachment(
              legacyRequest(f, thread.id, '/attachments', 'POST', content),
              route(thread.id),
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await attachWorkspaceFile(
              legacyRequest(f, thread.id, '/attachments', 'PUT', { objectId }),
              route(thread.id),
            )
          ).status,
        ).toBe(403);
        await expect(
          linkFileToSession({
            context: f.context,
            workspaceId: f.workspace,
            sessionId: thread.id,
            objectId,
            fileName: content.fileName,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        await expect(
          linkWorkspaceFileToSession({
            context: f.context,
            workspaceId: f.workspace,
            sessionId: thread.id,
            objectId,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(put).not.toHaveBeenCalled();
        expect(await counts()).toEqual(before);
        const [linked] =
          await fixture.db`select count(*)::int count from allrice_file_references where session_id=${thread.id}`;
        expect(linked!.count).toBe(0);
      } finally {
        put.mockRestore();
      }
    });
    it('rejects 4.0 once/recurring new_each_run at real routes and before creating a fresh 3.x target', async () => {
      const f = await setup(),
        thread = await four(f);
      const task = {
        name: 'Synthetic only',
        prompt: 'No native execution',
        conversationMode: 'new_each_run' as const,
      };
      const once = {
        ...task,
        clientRequestId: randomUUID(),
        runAt: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'UTC',
      };
      const recurring = {
        ...task,
        clientRequestId: randomUUID(),
        rule: { kind: 'every', seconds: 3600 },
      };
      const counts = () => fixture.db`select
        (select count(*)::int from allrice_automations where organization_id=${f.org}) clocks,
        (select count(*)::int from allrice_native_once_controls where immutable_control->>'organizationId'=${f.org}) once_controls,
        (select count(*)::int from allrice_native_recurring_controls where immutable_identity->>'organizationId'=${f.org}) recurring_controls,
        (select count(*)::int from allrice_chat_sessions where organization_id=${f.org} and execution_generation='3.x') legacy_threads,
        (select count(*)::int from allrice_automation_runs where organization_id=${f.org}) automation_runs,
        (select count(*)::int from allrice_jobs where organization_id=${f.org}) jobs`;
      const before = await counts();
      expect(
        (
          await createOnceTask(
            legacyRequest(f, thread.id, '/once-tasks', 'POST', once),
            route(thread.id),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await createRecurringTask(
            legacyRequest(f, thread.id, '/schedule-tasks', 'POST', recurring),
            route(thread.id),
          )
        ).status,
      ).toBe(403);
      const scope = {
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
      };
      await expect(
        fixture.db.begin(async (tx) =>
          prepareAutomationConversation(
            tx,
            f.context,
            scope,
            {
              id: randomUUID(),
              name: task.name,
              revision: 1,
              session_id: thread.id,
              employee_assignment_id: f.assignment,
              conversation_mode: 'new_each_run',
            },
            await readScheduleTarget(tx, scope, thread.id),
            { kind: 'manual', requestId: randomUUID() },
          ),
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(await counts()).toEqual(before);
      const legacyOnce = await createOnceTask(
        legacyRequest(f, f.session, '/once-tasks', 'POST', once),
        route(f.session),
      );
      expect(legacyOnce.status).toBe(201);
      const taskId = (await legacyOnce.json()).task.id as string;
      expect(
        (
          await createRecurringTask(
            legacyRequest(f, f.session, '/schedule-tasks', 'POST', recurring),
            route(f.session),
          )
        ).status,
      ).toBe(201);
      const [after] = await counts();
      expect(after).toMatchObject({
        clocks: 2,
        once_controls: 1,
        recurring_controls: 1,
        legacy_threads: 1,
        automation_runs: 0,
        jobs: before[0]!.jobs,
      });
      const [controlBefore] =
        await fixture.db`select snapshot,snapshot_version from allrice_native_once_controls where automation_id=${taskId}`;
      expect(
        (
          await cancelOnceTask(
            legacyRequest(
              f,
              thread.id,
              `/once-tasks/${taskId}/cancel`,
              'POST',
              {},
            ),
            { params: Promise.resolve({ id: thread.id, taskId }) },
          )
        ).status,
      ).toBe(403);
      const [controlAfter] =
        await fixture.db`select snapshot,snapshot_version from allrice_native_once_controls where automation_id=${taskId}`;
      expect(controlAfter).toEqual(controlBefore);
    });
    it('discovers an active assignment after materializing its first employee instance', async () => {
      const f = await setup(),
        user = randomUUID(),
        assignmentId = randomUUID();
      await fixture.db`insert into allrice_users(id,email,display_name,password_hash)
        values(${user},${user + '@example.test'},'Assigned employee owner','synthetic')`;
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
        values(${f.org},${f.workspace},${user},'member')`;
      await fixture.db`insert into allrice_employee_assignments
        (id,organization_id,workspace_id,employee_id,employee_version_id,user_id,is_default,active,assigned_by)
        select ${assignmentId},organization_id,workspace_id,employee_id,employee_version_id,${user},false,true,${f.user}
        from allrice_employee_assignments where id=${f.assignment}`;
      const { token } = await createSession(user);
      const context = await authenticateSession(token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!context) throw Error('Synthetic assignment login unavailable');
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      try {
        await updateDEntryReleasePolicy(f.context, {
          revision: 'initial',
          defaultGeneration: '3.x',
          selections: [{ organizationId: f.org, personId: user }],
        });
        expect(await findDEntryEmployee(context)).toBeNull();
        cookie.token = token;
        const requestId = randomUUID();
        const legacyCreate = await createEmployee(
          new Request('https://allrice.test/api/v1/employee-instances', {
            method: 'POST',
            headers: {
              origin: 'https://allrice.test',
              'x-allrice-organization-id': f.org,
              'x-allrice-workspace-id': f.workspace,
            },
            body: JSON.stringify({
              assignmentId,
              workspaceId: f.workspace,
              requestId,
              profile: { name: '额外员工' },
            }),
          }),
        );
        expect(legacyCreate.status).toBe(403);
        expect(
          await fixture.db`select id from allrice_employee_instances where owner_id=${user}`,
        ).toEqual([]);
        expect(
          (await preparePersonNativeWebRoster(context)).entries,
        ).toMatchObject([
          { workspaceId: f.workspace, employeeInstanceId: assignmentId },
        ]);
        expect(await findDEntryEmployee(context)).toEqual({
          workspaceId: f.workspace,
          employeeInstanceId: assignmentId,
        });
      } finally {
        await clearPublished();
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });

    it('creates from an empty personal roster and opens a 4.0 thread without changing existing writers', async () => {
      const f = await setup();
      const ownerId = randomUUID();
      const signal = new AbortController().signal;
      await fixture.db`insert into allrice_users(id,email,display_name,password_hash)
        values(${ownerId},${ownerId + '@example.test'},'New employee owner','synthetic')`;
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
        values(${f.org},${f.workspace},${ownerId},'member')`;
      const login = await createSession(ownerId);
      const owner = await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!owner) throw Error('Synthetic owner session unavailable');
      const input = {
        workspaceId: f.workspace,
        requestId: randomUUID(),
        expectedOwnerId: ownerId,
        profile: {
          name: '🚀私人助理',
          description: 'PRIVATE_FIRST_EMPLOYEE_DESCRIPTION',
        },
      };
      const headers = {
        origin: 'https://allrice.test',
        'x-allrice-organization-id': f.org,
        'x-allrice-workspace-id': f.workspace,
      };
      const create = (body: unknown = input) =>
        createEmployee(
          new Request('https://allrice.test/api/v1/employee-instances', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          }),
        );
      await clearPublished();
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      cookie.token = login.token;
      try {
        expect(await isDEntryPersonReleased(owner)).toBe(false);
        expect((await create()).status).toBe(403);
        const initial = {
          revision: 'initial',
          defaultGeneration: '3.x' as const,
          selections: [
            {
              organizationId: f.org.toUpperCase(),
              personId: ownerId.toUpperCase(),
            },
          ],
        };
        await updateDEntryReleasePolicy(f.context, {
          ...initial,
          selections: [
            ...initial.selections,
            { organizationId: f.org, personId: f.user },
          ],
        });
        cookie.token = f.login.token;
        expect((await create()).status).toBe(403);
        expect(
          await fixture.db`select id from allrice_employee_instances where creation_request_id=${input.requestId}`,
        ).toEqual([]);
        cookie.token = login.token;
        await updateDEntryReleasePolicy(f.context, initial);
        expect(await findDEntryCreationWorkspace(owner)).toBe(f.workspace);
        expect(await findDEntryEmployee(owner)).toBeNull();
        expect(await ensureDefaultEmployee(owner)).toBeNull();
        expect((await readPersonNativeWebRoster(owner)).entries).toEqual([]);
        expect(
          await readPersonVmDiskPreparationTarget(ownerId, signal),
        ).toBeNull();

        const vmId = randomUUID();
        await fixture.db`insert into person_virtual_machines
          (person_id,vm_id,organization_id,phase,disk_tier)
          values(${ownerId},${vmId},${f.org},'starting','warm')`;
        await expectEmployeeQuota(
          await create(),
          '当前工作台还没确认停机，停机后可以创建更多员工。',
        );
        expect(
          await fixture.db`select id from allrice_employee_instances where owner_id=${ownerId}`,
        ).toEqual([]);
        await fixture.db`update person_virtual_machines
          set phase='deleted',disk_retained=false where vm_id=${vmId}`;

        const other = await setup();
        const legacy = await createBusinessThread(
          new Request('https://allrice.test/api/v1/sessions', {
            method: 'POST',
            headers: { 'x-allrice-organization-id': other.org },
            body: JSON.stringify({
              workspaceId: other.workspace,
              employeeInstanceId: other.assignment,
            }),
          }),
        );
        expect(legacy.status).toBe(201);
        const { session: legacyThread } = await legacy.json();
        expect(
          await getSessionExecutionGeneration(
            other.context,
            other.workspace,
            legacyThread.id,
          ),
        ).toBe('3.x');
        await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
          values(${other.org},${other.workspace},${ownerId},'member')`;
        const otherTenant = await authenticateSession(login.token, {
          organizationId: other.org,
          workspaceId: other.workspace,
        });
        if (!otherTenant) throw Error('Synthetic second tenant unavailable');
        expect(await isDEntryPersonReleased(otherTenant)).toBe(false);
        await expect(
          createEmployeeInstance(otherTenant, {
            ...input,
            workspaceId: other.workspace,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        cookie.token = login.token;
        expect(
          (await create({ ...input, workspaceId: other.workspace })).status,
        ).toBe(403);
        expect(await isDEntryPersonReleased(f.context)).toBe(false);
        cookie.token = f.login.token;
        expect(
          (
            await create({
              workspaceId: f.workspace,
              assignmentId: f.assignment,
              requestId: randomUUID(),
              profile: { name: '既有 3.x 创建流程' },
            })
          ).status,
        ).toBe(201);
        cookie.token = login.token;
        await fixture.db`update allrice_memberships set role='viewer' where user_id=${ownerId}`;
        expect((await create()).status).toBe(403);
        await fixture.db`update allrice_memberships set role='member' where user_id=${ownerId}`;

        const responses = await Promise.all([create(), create()]);
        expect(responses.map(({ status }) => status)).toEqual([201, 201]);
        const [{ instance }, replay] = await Promise.all(
          responses.map((response) => response.json()),
        );
        expect(replay.instance).toEqual(instance);
        expect(
          (
            await create({
              workspaceId: f.workspace,
              assignmentId: instance.assignmentId,
              requestId: randomUUID(),
              profile: input.profile,
            })
          ).status,
        ).toBe(403);
        expect(
          await fixture.db`select id from allrice_employee_instances where owner_id=${ownerId}`,
        ).toEqual([{ id: instance.id }]);
        await fixture.db`delete from person_virtual_machines where vm_id=${vmId}`;
        expect(
          await readPersonVmDiskPreparationTarget(ownerId, signal),
        ).toMatchObject({
          personId: ownerId,
          organizationId: f.org,
          workspaceId: f.workspace,
          employeeInstanceId: instance.id,
          employeeVersionId: instance.source.employeeVersionId,
          platformRevisionId: null,
        });
        expect(instance).toMatchObject({
          kind: 'custom',
          workspaceId: f.workspace,
          ownerId,
          profile: input.profile,
          source: { kind: 'tenant_version' },
        });
        expect(instance.profile.appearance).toMatchObject({
          avatarValue: '🚀',
        });
        const details = await getEmployeeDetails(owner, instance.id);
        expect(details.profile).toMatchObject(input.profile);
        const directoryView = await listOrganizationPersonAiInstances(
          f.context,
          f.org,
          ownerId,
        );
        const sharedDetails = await getOrganizationAiSharedDetails(
          f.context,
          f.org,
          ownerId,
          instance.id,
        );
        expect(directoryView.instances).toContainEqual(
          expect.objectContaining({
            id: instance.id,
            sourceName: '自定义员工',
          }),
        );
        expect(sharedDetails.details.profile.name).toBe('自定义员工');
        expect(JSON.stringify({ directoryView, sharedDetails })).not.toContain(
          input.profile.name,
        );
        expect(JSON.stringify({ directoryView, sharedDetails })).not.toContain(
          input.profile.description,
        );
        const selection = {
          workspaceId: f.workspace,
          employeeInstanceId: instance.id,
        };
        expect(await findDEntryEmployee(owner)).toEqual(selection);
        expect(
          await requireDEntryNativeIdentity(owner, selection),
        ).toMatchObject({
          personId: ownerId,
          employeeInstanceId: instance.id,
          threadId: null,
        });
        const roster = await preparePersonNativeWebRoster(owner);
        expect(roster.entries).toEqual([
          {
            ...selection,
            employeeRevision: 1,
            employeeVersionId: instance.source.employeeVersionId,
          },
        ]);
        expect(await readPersonNativeWebRoster(owner)).toEqual(roster);
        expect(
          (
            await createBusinessThread(
              new Request('https://allrice.test/api/v1/sessions', {
                method: 'POST',
                headers,
                body: JSON.stringify(selection),
              }),
            )
          ).status,
        ).toBe(403);
        const thread = await createBusinessThread(
          new Request('https://allrice.test/api/v1/sessions?entry=4.0', {
            method: 'POST',
            headers,
            body: JSON.stringify({ selection }),
          }),
        );
        expect(thread.status).toBe(200);
        const native = await thread.json();
        expect(
          await getSessionExecutionGeneration(
            owner,
            f.workspace,
            native.threadId,
          ),
        ).toBe('4.0');
        // A business thread is durable before its native root exists. The
        // document directory opens only after the trusted host pins that root.
        await expect(
          readDEntryEmployeeDirectory(owner, native, signal),
        ).rejects.toMatchObject({ code: 'not_found' });
        const identity = await requireDEntryNativeIdentity(owner, native);
        const receipt = creation({ org: f.org, user: ownerId });
        const createRoot = vi.fn(async () => receipt);
        const pin = await ensureDEntryNativeRoot(owner, native, identity, {
          operationId: randomUUID(),
          host: receipt.host,
          signal,
          create: createRoot,
        });
        expect(createRoot).toHaveBeenCalledOnce();
        expect(pin.rootNativeSessionId).toBe(receipt.nativeSessionId);
        const directory = await readDEntryEmployeeDirectory(
          owner,
          native,
          signal,
        );
        expect(directory.employees.map(({ instanceId }) => instanceId)).toEqual(
          [instance.id],
        );
        expect(directory.sessions.map(({ id }) => id)).toEqual([
          native.threadId,
        ]);
        expect(
          await getSessionExecutionGeneration(
            f.context,
            f.workspace,
            f.session,
          ),
        ).toBe('3.x');
        const [row] =
          await fixture.db`select count(*)::int n from allrice_audit_events
          where actor_id=${ownerId} and action='employee.instance.create'`;
        expect(row?.n).toBe(1);
        await updateDEntryReleasePolicy(f.context, {
          ...initial,
          selections: [],
        });
        await expect(
          requireDEntryNativeIdentity(owner, native),
        ).rejects.toMatchObject({
          code: 'authorization_denied',
        });
        expect((await create()).status).toBe(403);
        expect(
          await getSessionExecutionGeneration(
            owner,
            f.workspace,
            native.threadId,
          ),
        ).toBe('4.0');
        const legacyInput = {
          workspaceId: input.workspaceId,
          profile: input.profile,
          requestId: randomUUID(),
        };
        await expect(
          createEmployeeInstance(owner, {
            ...legacyInput,
            assignmentId: instance.assignmentId,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        await expect(
          createEmployeeInstance(owner, {
            ...legacyInput,
            assignmentId: f.assignment,
          }),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
      } finally {
        await clearPublished();
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });

    it('preserves a running legacy roster until its physical lifecycle has settled', async () => {
      const f = await setup();
      const vmId = randomUUID(),
        instanceId = randomUUID();
      const receipt = fixture.db.json({
        binding: {
          personId: f.user,
          organizationId: f.org,
          vmId,
          instanceId,
          leaseEpoch: 1,
        },
        bindingId: randomUUID(),
        gatewayPorts: [38990],
      });
      const proposal = {
        workspaceId: f.workspace,
        expectedOwnerId: f.user,
        profile: { name: '第二名员工' },
        requestId: randomUUID(),
      };
      const create = () =>
        createEmployee(
          new Request('https://allrice.test/api/v1/employee-instances', {
            method: 'POST',
            headers: {
              origin: 'https://allrice.test',
              'x-allrice-organization-id': f.org,
              'x-allrice-workspace-id': f.workspace,
            },
            body: JSON.stringify(proposal),
          }),
        );
      await fixture.db`insert into person_virtual_machines
        (person_id,vm_id,organization_id,instance_id,phase,disk_tier,native_created,lease_epoch,egress_receipt)
        values(${f.user},${vmId},${f.org},${instanceId},'running','warm',true,1,${receipt})`;
      await clearPublished();
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      try {
        await updateDEntryReleasePolicy(f.context, {
          revision: 'initial',
          defaultGeneration: '3.x',
          selections: [{ organizationId: f.org, personId: f.user }],
        });
        const before = await preparePersonNativeWebRoster(f.context);
        expect(before.entries).toEqual([
          expect.objectContaining({ employeeInstanceId: f.assignment }),
        ]);
        for (const phase of ['running', 'starting', 'failed']) {
          await fixture.db`update person_virtual_machines set phase=${phase} where vm_id=${vmId}`;
          await expectEmployeeQuota(
            await create(),
            '当前工作台还没确认停机，停机后可以创建更多员工。',
          );
          expect(await readPersonNativeWebRoster(f.context)).toEqual(before);
        }
        await expect(
          requireDEntryNativeIdentity(f.context, {
            workspaceId: f.workspace,
            employeeInstanceId: f.assignment,
          }),
        ).resolves.toMatchObject({ employeeInstanceId: f.assignment });

        await fixture.db`update person_virtual_machines set phase='stopped',lease_owner=${randomUUID()},
          lease_expires_at=clock_timestamp()+interval '2 minutes',egress_receipt=null where vm_id=${vmId}`;
        await expectEmployeeQuota(
          await create(),
          '当前工作台还没确认停机，停机后可以创建更多员工。',
        );
        await fixture.db`update person_virtual_machines set lease_owner=null,lease_expires_at=null where vm_id=${vmId}`;
        const accepted = await create();
        expect(accepted.status).toBe(201);
        const { instance } = await accepted.json();
        expect(
          (await readPersonNativeWebRoster(f.context)).entries
            .map((entry) => entry.employeeInstanceId)
            .sort(),
        ).toEqual([f.assignment, instance.id].sort());
      } finally {
        await clearPublished();
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });

    it('preserves the verified physical width across workspace writes when the platform cap changes in either direction', async () => {
      const f = await setup();
      const other = randomUUID();
      const limit = 4;
      await fixture.db`insert into allrice_workspaces(id,organization_id,slug,name)
        values(${other},${f.org},'slots','Other writable workspace')`;
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
        values(${f.org},${other},${f.user},'member')`;
      await fixture.db`insert into person_virtual_machines
        (person_id,vm_id,organization_id,instance_id,phase,disk_tier,native_created,lease_epoch,egress_receipt,verified_web_slot_capacity)
        values(${f.user},${randomUUID()},${f.org},${randomUUID()},'running','warm',true,1,'{}'::jsonb,${limit})`;
      const body = (workspaceId: string) => ({
        workspaceId,
        expectedOwnerId: f.user,
        profile: { name: 'Employee' },
        requestId: randomUUID(),
      });
      const create = (input: ReturnType<typeof body>) =>
        createEmployee(
          new Request('https://allrice.test/api/v1/employee-instances', {
            method: 'POST',
            headers: {
              origin: 'https://allrice.test',
              'x-allrice-organization-id': f.org,
              'x-allrice-workspace-id': input.workspaceId,
            },
            body: JSON.stringify(input),
          }),
        );
      await clearPublished();
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      const configured = vi
        .spyOn(serviceBuild, 'readServicePersonVmEmployeePortSlots')
        .mockResolvedValue(20);
      try {
        await updateDEntryReleasePolicy(f.context, {
          revision: 'initial',
          defaultGeneration: '3.x',
          selections: [{ organizationId: f.org, personId: f.user }],
        });
        // The fixture already has one assigned employee taking a VM slot.
        for (let index = 1; index < limit - 1; index++)
          expect((await create(body(f.workspace))).status).toBe(201);
        const attempts = [body(f.workspace), body(other)];
        const responses = await Promise.all(attempts.map(create));
        expect(responses.map(({ status }) => status).sort()).toEqual([
          201, 409,
        ]);
        const winner = responses.findIndex(({ status }) => status === 201);
        const input = attempts[winner]!;
        const { instance } = await responses[winner]!.json();
        expect(await responses[1 - winner]!.json()).toMatchObject({
          error: {
            code: 'QUOTA_EXCEEDED',
            message: `每人最多 ${limit} 个员工`,
          },
        });
        expect(await (await create(input)).json()).toEqual({ instance });
        await fixture.db`update person_virtual_machines set phase='stopped',egress_receipt=null
          where person_id=${f.user}`;
        configured.mockResolvedValue(1);
        const stoppedFull = await create(attempts[1 - winner]!);
        expect(stoppedFull.status).toBe(409);
        expect(await stoppedFull.json()).toMatchObject({
          error: {
            code: 'QUOTA_EXCEEDED',
            message: `每人最多 ${limit} 个员工`,
          },
        });
        const lifecycle = { ...f.context, workspaceId: input.workspaceId };
        const watched = {
          personId: f.user,
          organizationId: f.org,
          workspaceId: input.workspaceId,
          employeeInstanceId: instance.id,
          employeeRevision: instance.revision,
        };
        expect(await confirmDEntryEmployeeArchive(watched)).toBe(false);
        const archived = await changeEmployeeInstanceLifecycle(
          lifecycle,
          instance.id,
          {
            workspaceId: input.workspaceId,
            expectedRevision: instance.revision,
            operation: 'archive',
            requestId: randomUUID(),
          },
        );
        expect((await create(attempts[1 - winner]!)).status).toBe(201);
        expect(await confirmDEntryEmployeeArchive(watched)).toBe(true);
        expect(
          await confirmDEntryEmployeeArchive({
            ...watched,
            organizationId: randomUUID(),
          }),
        ).toBe(false);
        await expect(
          changeEmployeeInstanceLifecycle(lifecycle, instance.id, {
            workspaceId: input.workspaceId,
            expectedRevision: archived.revision,
            sourceRevision: instance.revision,
            operation: 'restore',
            requestId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'employee_port_slots_full' });
        expect(
          (await readPersonNativeWebRoster(f.context)).entries,
        ).toHaveLength(limit);
        expect(configured).not.toHaveBeenCalled();
      } finally {
        configured.mockRestore();
        await clearPublished();
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });

    function rosterWrite(
      scope: { org: string; workspace: string },
      method: 'POST' | 'PUT' | 'PATCH',
      path: string,
      input: unknown,
    ) {
      return new Request(`https://allrice.test/api/v1/${path}`, {
        method,
        headers: {
          origin: 'https://allrice.test',
          'content-type': 'application/json',
          'x-allrice-organization-id': scope.org,
          'x-allrice-workspace-id': scope.workspace,
        },
        body: JSON.stringify(input),
      });
    }

    it.each(['bulk', 'person'] as const)(
      'keeps the first %s rollout off when the pending and materialized roster is over capacity',
      async (mode) => {
        const f = await setup(),
          admin = await setup();
        await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
        values(${f.org},${f.workspace},${admin.user},'member')`;
        // The second source is selected through the real admin writer and has yet
        // to be materialized into a general instance.
        const source = await secondAssignmentSource(f);
        await authorizeFixturePlatformAdministrator(fixture.db, admin.user);
        await clearPublished();
        const configured = vi
          .spyOn(serviceBuild, 'readServicePersonVmEmployeePortSlots')
          .mockResolvedValue(1);
        try {
          const scope = { workspaceId: f.workspace, userIds: [f.user] };
          expect(
            (
              await assignEmployees(
                rosterWrite(f, 'PUT', `employees/${source}/assignments`, scope),
                route(source),
              )
            ).status,
          ).toBe(200);
          const target = { organizationId: f.org, personId: f.user };
          const { revision } = await readDEntryReleasePolicy();
          const response =
            mode === 'bulk'
              ? await publishReleasePolicy(
                  rosterWrite(f, 'PUT', 'admin/d-entry-release-policy', {
                    revision,
                    defaultGeneration: '3.x',
                    selections: [target],
                  }),
                )
              : await publishPersonReleasePolicy(
                  rosterWrite(f, 'PUT', 'admin/d-entry-release-policy/person', {
                    ...target,
                    enabled: true,
                    expectedRevision: revision,
                  }),
                );
          expect(response.status).toBe(409);
          expect(await response.json()).toMatchObject({
            error: { code: 'QUOTA_EXCEEDED', message: '每人最多 1 个员工' },
          });
          expect((await readDEntryReleasePolicy()).revision).toBe(
            'unpublished',
          );
          expect(configured).toHaveBeenCalledOnce();
          expect(
            await fixture.db`select id from allrice_audit_events
          where actor_id=${admin.user} and action in ('d_entry_release.update','d_entry_release.person.update')`,
          ).toEqual([]);
          expect(
            await fixture.db`select i.id from allrice_employee_instances i
          join allrice_employee_assignments a on a.id=i.assignment_id
          where a.employee_id=${source}`,
          ).toEqual([]);
        } finally {
          configured.mockRestore();
          await clearPublished();
          vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
        }
      },
    );

    async function secondAssignmentSource(f: Fixture) {
      const id = randomUUID(),
        key = `seat-${id}`;
      await fixture.db.begin(async (tx) => {
        await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
          values(${id},${f.org},${f.workspace},${key},'Extra assignment')`;
        await tx`insert into allrice_employee_versions
          (organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
          select organization_id,workspace_id,${id},1,'Extra assignment',model,system_prompt,
            capabilities,config_checksum,jsonb_set(manifest,'{key}',to_jsonb(${key}::text)),provider_snapshot
          from allrice_employee_versions where id=${f.version}`;
      });
      return id;
    }

    it('shares the last real slot between self-creation and admin assignment and leaves the old roster usable', async () => {
      const f = await setup();
      const source = await secondAssignmentSource(f);
      await clearPublished();
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      const proposal = {
        workspaceId: f.workspace,
        expectedOwnerId: f.user,
        profile: { name: '我的第二名员工' },
        requestId: randomUUID(),
      };
      const direct = () =>
        createEmployee(rosterWrite(f, 'POST', 'employee-instances', proposal));
      const assign = (employee: string) =>
        assignEmployees(
          rosterWrite(f, 'PUT', `employees/${employee}/assignments`, {
            workspaceId: f.workspace,
            userIds: [f.user],
          }),
          route(employee),
        );
      const vmId = randomUUID();
      const limit =
        contracts.readPlatformPersonVmConfiguration().employeePortSlots;
      await fixture.db`insert into person_virtual_machines
        (person_id,vm_id,organization_id,instance_id,phase,disk_tier,native_created,lease_epoch,verified_web_slot_capacity)
        values(${f.user},${vmId},${f.org},${randomUUID()},'stopped','warm',true,1,${limit})`;
      try {
        await updateDEntryReleasePolicy(f.context, {
          revision: 'initial',
          defaultGeneration: '3.x',
          selections: [{ organizationId: f.org, personId: f.user }],
        });
        for (let count = 1; count < limit - 1; count++) {
          expect(
            (
              await createEmployee(
                rosterWrite(f, 'POST', 'employee-instances', {
                  ...proposal,
                  requestId: randomUUID(),
                }),
              )
            ).status,
          ).toBe(201);
        }
        const [mine, managed] = await Promise.all([direct(), assign(source)]);
        expect(
          (mine.status === 201 && managed.status === 409) ||
            (mine.status === 409 && managed.status === 200),
        ).toBe(true);
        const before = await preparePersonNativeWebRoster(f.context);
        expect(before.entries).toHaveLength(limit);
        const loser = await (mine.status === 201 ? assign(source) : direct());
        expect(loser.status).toBe(409);
        expect(await loser.json()).toMatchObject({
          error: {
            code: 'QUOTA_EXCEEDED',
            message: `每人最多 ${limit} 个员工`,
          },
        });
        expect(await readPersonNativeWebRoster(f.context)).toEqual(before);
        expect(
          await fixture.db`select id from allrice_employee_assignments
          where employee_id=${source} and user_id=${f.user}`,
        ).toHaveLength(managed.status === 200 ? 1 : 0);
        expect(
          await fixture.db`select id from allrice_employee_instances
          where creation_request_id=${proposal.requestId}`,
        ).toHaveLength(mine.status === 201 ? 1 : 0);
        await expect(
          requireDEntryNativeIdentity(f.context, {
            workspaceId: f.workspace,
            employeeInstanceId: f.assignment,
          }),
        ).resolves.toMatchObject({
          employeeInstanceId: f.assignment,
        });
        // A real SQL writer may hold the person row; an unchanged assignment
        // has no roster growth and need not contend for that lock.
        const extra = await secondAssignmentSource(f);
        await fixture.db.begin(async (tx) => {
          await tx`select id from allrice_users where id=${f.user} for no key update`;
          const busy = await assign(extra);
          expect(busy.status).toBe(409);
          expect(await busy.json()).toMatchObject({
            error: { code: 'CONFLICT', retryable: true },
          });
          expect((await assign(f.employee)).status).toBe(200);
        });
        expect(
          await fixture.db`select id from allrice_employee_assignments where employee_id=${extra}`,
        ).toEqual([]);
      } finally {
        await clearPublished();
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });

    function setOrganizationAccount(
      admin: Fixture,
      person: Fixture,
      active: boolean,
      expectedVersion: string,
    ) {
      return changeOrganizationAccount(
        rosterWrite(
          admin,
          'POST',
          `admin/organizations/${person.org}/people/${person.user}/status`,
          {
            active,
            expectedVersion,
          },
        ),
        {
          params: Promise.resolve({
            organizationId: person.org,
            userId: person.user,
          }),
        },
      );
    }

    async function organizationAccount(admin: Fixture, person: Fixture) {
      return (
        await listOrganizationPeople(admin.context, person.org)
      ).people.find(({ userId }) => userId === person.user)!;
    }

    async function reserveStoppedSlots(f: Fixture, slots: number) {
      await fixture.db`insert into person_virtual_machines
        (person_id,vm_id,organization_id,instance_id,phase,disk_tier,native_created,lease_epoch,verified_web_slot_capacity)
        values(${f.user},${randomUUID()},${f.org},${randomUUID()},'stopped','warm',true,1,${slots})`;
    }

    function createPersonalThroughRoute(f: Fixture, workspace = f.workspace) {
      return createEmployee(
        rosterWrite({ org: f.org, workspace }, 'POST', 'employee-instances', {
          workspaceId: workspace,
          expectedOwnerId: f.user,
          profile: { name: '个人员工' },
          requestId: randomUUID(),
        }),
      );
    }

    it('admits personal employees up to the default of 20 before the first VM is allocated', async () => {
      const f = await setup();
      await clearPublished();
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      try {
        await updateDEntryReleasePolicy(f.context, {
          revision: 'initial',
          defaultGeneration: '3.x',
          selections: [{ organizationId: f.org, personId: f.user }],
        });
        // The assignment already owns one slot, including before first boot.
        for (let count = 1; count < 20; count++)
          expect((await createPersonalThroughRoute(f)).status).toBe(201);
        await expectEmployeeQuota(
          await createPersonalThroughRoute(f),
          '每人最多 20 个员工',
        );
        expect(
          (await readPersonNativeWebRoster(f.context)).entries,
        ).toHaveLength(20);
        expect(
          await fixture.db`select vm_id from person_virtual_machines where person_id=${f.user}`,
        ).toEqual([]);
      } finally {
        await clearPublished();
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });

    it('rolls back the real quality release as one write when disable freed the last 4.0 slot', async () => {
      const f = await setup(),
        legacy = await setup(),
        admin = await setup();
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
        values(${f.org},${f.workspace},${legacy.user},'member'),(${f.org},${f.workspace},${admin.user},'member')`;
      const employeeId = await secondAssignmentSource(f);
      const slots =
        contracts.readPlatformPersonVmConfiguration().employeePortSlots;
      await clearPublished();
      await authorizeFixturePlatformAdministrator(fixture.db, admin.user);
      await reserveStoppedSlots(f, slots);
      const quality = (action: 'disable' | 'rollback') =>
        employeeQuality(
          rosterWrite(f, 'POST', 'admin/employee-quality', {
            action: 'update_release',
            payload: { action, employeeId, workspaceId: f.workspace },
          }),
        );
      const release = () =>
        fixture.db`select * from allrice_employee_releases where employee_id=${employeeId}`;
      const assignments = () =>
        fixture.db`select * from allrice_employee_assignments where employee_id=${employeeId} order by id`;
      const audit = () => fixture.db`select * from allrice_audit_events
        where action='employee.release.update' and resource_id=${employeeId} order by id`;
      try {
        await updateDEntryReleasePolicy(admin.context, {
          revision: 'initial',
          defaultGeneration: '3.x',
          selections: [{ organizationId: f.org, personId: f.user }],
        });
        cookie.token = admin.login.token;
        expect(
          (
            await assignEmployees(
              rosterWrite(f, 'PUT', `employees/${employeeId}/assignments`, {
                workspaceId: f.workspace,
                userIds: [f.user, legacy.user],
              }),
              route(employeeId),
            )
          ).status,
        ).toBe(200);
        const root = (await assignments()).find(
          ({ user_id }) => user_id === f.user,
        )!;
        await ensureGeneralEmployeeInstance(fixture.db, root.id);
        const thread = await createChatSession(
          f.context,
          {
            workspaceId: f.workspace,
            employeeInstanceId: root.id,
            title: 'Existing 4.0 chat',
          },
          { executionGeneration: '4.0' },
        );
        expect((await quality('disable')).status).toBe(200);
        expect(await release()).toMatchObject([{ stage: 'disabled' }]);
        expect(await assignments()).toMatchObject([
          { active: false },
          { active: false },
        ]);
        cookie.token = f.login.token;
        let last!: { id: string; revision: number };
        for (let count = 1; count < slots; count++) {
          const created = await createPersonalThroughRoute(f);
          expect(created.status).toBe(201);
          last = (await created.json()).instance;
        }
        const roster = await preparePersonNativeWebRoster(f.context);
        expect(roster.entries).toHaveLength(slots);
        const sessionVersion =
          () => fixture.db`select employee_assignment_id,employee_version_id,execution_generation
          from allrice_chat_sessions where id=${thread.id}`;
        const before = await Promise.all([
          release(),
          assignments(),
          sessionVersion(),
          audit(),
        ]);
        cookie.token = admin.login.token;
        const denied = await quality('rollback');
        expect(denied.status).toBe(409);
        expect(await denied.json()).toMatchObject({
          error: {
            code: 'QUOTA_EXCEEDED',
            message: `每人最多 ${slots} 个员工`,
          },
        });
        expect(
          await Promise.all([
            release(),
            assignments(),
            sessionVersion(),
            audit(),
          ]),
        ).toEqual(before);
        expect(await readPersonNativeWebRoster(f.context)).toEqual(roster);
        cookie.token = f.login.token;
        expect(
          (
            await changeEmployeeLifecycle(
              rosterWrite(
                f,
                'POST',
                `employee-instances/${last.id}/lifecycle`,
                {
                  workspaceId: f.workspace,
                  operation: 'archive',
                  expectedRevision: last.revision,
                  requestId: randomUUID(),
                },
              ),
              route(last.id),
            )
          ).status,
        ).toBe(200);
        cookie.token = admin.login.token;
        expect((await quality('rollback')).status).toBe(200);
        expect(await release()).toMatchObject([{ stage: 'production' }]);
        expect(await assignments()).toMatchObject([
          { active: true },
          { active: true },
        ]);
        expect(await audit()).toHaveLength(before[3]!.length + 1);
        expect(
          (await preparePersonNativeWebRoster(f.context)).entries.map(
            (entry) => entry.employeeInstanceId,
          ),
        ).toContain(root.id);
      } finally {
        await clearPublished();
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });

    it('fences writable membership while a real account activation owns the person row', async () => {
      const f = await setup(),
        admin = await setup(),
        second = randomUUID();
      const slots =
        contracts.readPlatformPersonVmConfiguration().employeePortSlots;
      const memberId = randomUUID();
      await fixture.db`insert into allrice_workspaces(id,organization_id,slug,name)
        values(${second},${f.org},'promotion-capacity','Second workspace')`;
      await fixture.db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role)
        values(${memberId},${f.org},${second},${f.user},'member')`;
      await clearPublished();
      await authorizeFixturePlatformAdministrator(fixture.db, admin.user);
      await reserveStoppedSlots(f, slots);
      const currentMembership = async () =>
        (
          await listAdminTenantMembers(admin.context, f.org, second)
        ).members.find(({ id }) => id === memberId)!;
      const changeMembership = (role: 'viewer' | 'member', version: string) =>
        changeTenantMembership(
          rosterWrite(
            admin,
            'PATCH',
            `admin/tenants/${f.org}/members/${memberId}`,
            {
              workspaceId: second,
              expectedVersion: version,
              active: true,
              role,
            },
          ),
          {
            params: Promise.resolve({
              organizationId: f.org,
              membershipId: memberId,
            }),
          },
        );
      try {
        await updateDEntryReleasePolicy(admin.context, {
          revision: 'initial',
          defaultGeneration: '3.x',
          selections: [{ organizationId: f.org, personId: f.user }],
        });
        cookie.token = f.login.token;
        expect((await createPersonalThroughRoute(f, second)).status).toBe(201);
        cookie.token = admin.login.token;
        expect(
          (
            await changeMembership(
              'viewer',
              (await currentMembership()).version,
            )
          ).status,
        ).toBe(200);
        cookie.token = f.login.token;
        for (let count = 1; count < slots; count++)
          expect((await createPersonalThroughRoute(f)).status).toBe(201);
        const roster = await preparePersonNativeWebRoster(f.context);
        expect(roster.entries).toHaveLength(slots);
        cookie.token = admin.login.token;
        const disabled = await setOrganizationAccount(
          admin,
          f,
          false,
          (await organizationAccount(admin, f)).version,
        );
        expect(disabled.status).toBe(200);
        const version = (await disabled.json()).person.version;
        const viewer = await currentMembership();

        await fixture.db`create function slot_test_pause_account_enable() returns trigger language plpgsql as $$
          begin
            perform pg_advisory_xact_lock(hashtextextended('slots-test-enable:'||new.id::text,0));
            return new;
          end; $$`;
        await fixture.db`create trigger slot_test_pause_account_enable
          after update of status on allrice_users for each row
          when (old.status='disabled' and new.status='active')
          execute function slot_test_pause_account_enable()`;
        const holding = deferred<number>(),
          letUpdateFinish = deferred<void>();
        let enable: Promise<Response> | undefined;
        const gate = fixture.db.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtextextended(${'slots-test-enable:' + f.user},0))`;
          const [backend] = await tx`select pg_backend_pid() pid`;
          holding.resolve(backend!.pid);
          await letUpdateFinish.promise;
        });
        try {
          const blocker = await holding.promise;
          enable = setOrganizationAccount(admin, f, true, version);
          void enable.catch(() => {});
          await expect
            .poll(async () => {
              const [state] =
                await fixture.db`select exists(select 1 from pg_stat_activity a
              where ${blocker}::integer=any(pg_blocking_pids(a.pid))
                and a.query like '%update allrice_users set status=%') blocked`;
              return state!.blocked;
            })
            .toBe(true);
          const racing = await changeMembership('member', viewer.version);
          expect(racing.status).toBe(409);
          expect(await racing.json()).toMatchObject({
            code: 'employee_access_busy',
          });
          expect(await currentMembership()).toMatchObject({
            role: 'viewer',
            version: viewer.version,
          });
          expect(await organizationAccount(admin, f)).toMatchObject({
            status: 'disabled',
          });
          letUpdateFinish.resolve();
          expect((await enable).status).toBe(200);
          const retry = await changeMembership('member', viewer.version);
          expect(retry.status).toBe(409);
          expect(await retry.json()).toMatchObject({
            code: 'employee_port_slots_full',
          });
          expect(await currentMembership()).toMatchObject({
            role: 'viewer',
            version: viewer.version,
          });
        } finally {
          letUpdateFinish.resolve();
          await Promise.allSettled([gate, enable]);
          await fixture.db`drop trigger slot_test_pause_account_enable on allrice_users`;
          await fixture.db`drop function slot_test_pause_account_enable()`;
        }
        const login = await createSession(f.user);
        const current = await authenticateSession(login.token, {
          organizationId: f.org,
          workspaceId: f.workspace,
        });
        expect(current).not.toBeNull();
        expect(await preparePersonNativeWebRoster(current!)).toEqual(roster);
      } finally {
        await clearPublished();
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });

    it.each(['running legacy', 'foreign owner', 'full pool'] as const)(
      'validates dormant member restore before account activation: %s',
      async (mode) => {
        const f = await setup(),
          admin = await setup();
        const foreign = mode === 'foreign owner' ? await setup() : undefined;
        const workspace = foreign?.workspace ?? randomUUID();
        const target = { ...f, org: foreign?.org ?? f.org, workspace };
        const memberId = randomUUID();
        if (!foreign)
          await fixture.db`insert into allrice_workspaces(id,organization_id,slug,name)
          values(${workspace},${f.org},'dormant-capacity','Second workspace')`;
        await fixture.db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role)
          values(${memberId},${target.org},${workspace},${f.user},'member')`;
        await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
          values(${f.org},${f.workspace},${admin.user},'member')`;
        await clearPublished();
        await authorizeFixturePlatformAdministrator(fixture.db, admin.user);
        const store = new PostgresPersonVmStore(() =>
          client.createDedicatedDatabase(fixture.db),
        );
        const h = harness(store);
        const limit =
          contracts.readPlatformPersonVmConfiguration().employeePortSlots;
        const currentMembership = async () =>
          (
            await listAdminTenantMembers(admin.context, target.org, workspace)
          ).members.find(({ id }) => id === memberId)!;
        const membership = (role: 'viewer' | 'member', version: string) =>
          changeTenantMembership(
            rosterWrite(
              admin,
              'PATCH',
              `admin/tenants/${target.org}/members/${memberId}`,
              {
                workspaceId: workspace,
                expectedVersion: version,
                active: true,
                role,
              },
            ),
            {
              params: Promise.resolve({
                organizationId: target.org,
                membershipId: memberId,
              }),
            },
          );
        try {
          await updateDEntryReleasePolicy(admin.context, {
            revision: 'initial',
            defaultGeneration: '3.x',
            selections: [...new Set([f.org, target.org])].map(
              (organizationId) => ({ organizationId, personId: f.user }),
            ),
          });
          cookie.token = f.login.token;
          expect((await createPersonalThroughRoute(target)).status).toBe(201);
          cookie.token = admin.login.token;
          expect(
            (await membership('viewer', (await currentMembership()).version))
              .status,
          ).toBe(200);
          if (mode === 'full pool') {
            await reserveStoppedSlots(f, limit);
            cookie.token = f.login.token;
            for (let count = 1; count < limit; count++)
              expect((await createPersonalThroughRoute(f)).status).toBe(201);
          } else {
            expect(
              (
                await h.service.prewarm(
                  f.context,
                  { trigger: 'page' },
                  signal(),
                )
              ).ready,
            ).toBe(true);
          }
          const before = await preparePersonNativeWebRoster(f.context);
          const vm = await store.read(f.user);
          const viewer = await currentMembership();
          cookie.token = admin.login.token;
          const disabled = await setOrganizationAccount(
            admin,
            f,
            false,
            (await organizationAccount(admin, f)).version,
          );
          expect(disabled.status).toBe(200);
          const { person } = await disabled.json();
          await expect(
            preparePersonNativeWebRoster(f.context),
          ).rejects.toMatchObject({
            code: 'authorization_denied',
          });
          const audits = () => fixture.db`select id from allrice_audit_events
            where action='tenant.member.updated' and resource_id=${memberId} order by id`;
          const oldAudits = await audits();
          const refused = await membership('member', viewer.version);
          expect(refused.status).toBe(foreign ? 403 : 409);
          const body = await refused.text();
          expect(JSON.parse(body)).toMatchObject({
            code: foreign ? 'AUTHORIZATION_DENIED' : 'employee_port_slots_full',
          });
          expect(body).not.toContain(vm!.vmId);
          expect(body).not.toContain(f.org);
          expect(await audits()).toEqual(oldAudits);
          expect(await currentMembership()).toMatchObject({
            role: 'viewer',
            version: viewer.version,
          });

          if (mode === 'full pool') {
            const employee = await secondAssignmentSource(f);
            const attempt = await assignEmployees(
              rosterWrite(f, 'PUT', `employees/${employee}/assignments`, {
                workspaceId: f.workspace,
                userIds: [f.user],
              }),
              route(employee),
            );
            expect(attempt.status).toBe(409);
            expect(await attempt.json()).toMatchObject({
              error: {
                code: 'QUOTA_EXCEEDED',
                message: `每人最多 ${limit} 个员工`,
              },
            });
            expect(
              await fixture.db`select id from allrice_employee_assignments
              where employee_id=${employee} and user_id=${f.user}`,
            ).toEqual([]);
          }

          expect(
            (await setOrganizationAccount(admin, f, true, person.version))
              .status,
          ).toBe(200);
          const login = await createSession(f.user);
          const current = await authenticateSession(login.token, {
            organizationId: f.org,
            workspaceId: f.workspace,
          });
          expect(current).not.toBeNull();
          expect(await preparePersonNativeWebRoster(current!)).toEqual(before);
          expect(await store.read(f.user)).toEqual(vm);
        } finally {
          const vm = await store.read(f.user);
          if (mode !== 'full pool' && vm?.phase === 'running') {
            h.states.set(vm.vmId, 'stopped');
            await h.service.stop(f.context, signal());
          }
          await clearPublished();
          vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
        }
      },
    );

    it('refuses foreign create, restore and dormant assignment after A allocates the VM', async () => {
      const a = await setup(),
        b = await setup(),
        admin = await setup();
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
        values(${b.org},${b.workspace},${a.user},'member'),
          (${a.org},${a.workspace},${admin.user},'member'),
          (${b.org},${b.workspace},${admin.user},'member')`;
      const localSource = await secondAssignmentSource(a);
      cookie.token = a.login.token;
      await clearPublished();
      await authorizeFixturePlatformAdministrator(fixture.db, admin.user);
      const c = (tenant: typeof a, requestId = randomUUID()) =>
        createEmployee(
          rosterWrite(tenant, 'POST', 'employee-instances', {
            workspaceId: tenant.workspace,
            expectedOwnerId: a.user,
            profile: { name: 'Personal employee' },
            requestId,
          }),
        );
      const lifecycle = (id: string, body: unknown) =>
        changeEmployeeLifecycle(
          rosterWrite(b, 'POST', `employee-instances/${id}/lifecycle`, body),
          route(id),
        );
      const store = new PostgresPersonVmStore(() =>
        client.createDedicatedDatabase(fixture.db),
      );
      const h = harness(store);
      try {
        await updateDEntryReleasePolicy(admin.context, {
          revision: 'initial',
          defaultGeneration: '3.x',
          selections: [a.org, b.org].map((organizationId) => ({
            organizationId,
            personId: a.user,
          })),
        });
        expect((await c(a)).status).toBe(201);
        const fromB = await c(b);
        expect(fromB.status).toBe(201);
        expect((await c(b)).status).toBe(201);
        const { instance: firstB } = await fromB.json();
        const archivedB = await lifecycle(firstB.id, {
          workspaceId: b.workspace,
          expectedRevision: firstB.revision,
          operation: 'archive',
          requestId: randomUUID(),
        });
        expect(archivedB.status).toBe(200);
        const { instance: archived } = await archivedB.json();
        await expect(
          h.service.prewarm(a.context, { trigger: 'page' }, signal()),
        ).resolves.toMatchObject({ ready: true });
        const owner = await store.read(a.user);
        expect(owner).toMatchObject({
          organizationId: a.org,
          personId: a.user,
        });
        const data =
          () => fixture.db`select id,archived_at,revision from allrice_employee_instances
          where owner_id=${a.user} and organization_id=${b.org} order by id`;
        const evidence = await data();
        const createId = randomUUID(),
          restoreId = randomUUID();
        for (const response of [
          await c(b, createId),
          await lifecycle(archived.id, {
            workspaceId: b.workspace,
            expectedRevision: archived.revision,
            sourceRevision: firstB.revision,
            operation: 'restore',
            requestId: restoreId,
          }),
        ]) {
          expect(response.status).toBe(403);
          const body = await response.text();
          expect(JSON.parse(body)).toMatchObject({
            error: { code: 'AUTHORIZATION_DENIED' },
          });
          expect(body).not.toContain(a.org);
          expect(body).not.toContain(owner!.vmId);
        }
        expect(await data()).toEqual(evidence);
        expect(
          await fixture.db`select id from allrice_audit_events
          where request_id in (${createId},${restoreId})`,
        ).toEqual([]);
        expect(await store.read(a.user)).toEqual(owner);

        cookie.token = admin.login.token;
        const disabled = await setOrganizationAccount(
          admin,
          a,
          false,
          (await organizationAccount(admin, a)).version,
        );
        expect(disabled.status).toBe(200);
        const dormant = (await disabled.json()).person;
        const assign = (
          tenant: Fixture,
          employeeId: string,
          userIds: string[],
        ) =>
          assignEmployees(
            rosterWrite(tenant, 'PUT', `employees/${employeeId}/assignments`, {
              workspaceId: tenant.workspace,
              userIds,
            }),
            route(employeeId),
          );
        const foreignAudit =
          () => fixture.db`select id from allrice_audit_events
          where organization_id=${b.org} and resource_id=${b.employee}
            and action='employee.assignment.manage' order by id`;
        const oldAudit = await foreignAudit();
        const denied = await assign(b, b.employee, [a.user, b.user]);
        expect(denied.status).toBe(403);
        const body = await denied.text();
        expect(JSON.parse(body)).toMatchObject({
          error: { code: 'AUTHORIZATION_DENIED' },
        });
        expect(body).not.toContain(a.org);
        expect(body).not.toContain(owner!.vmId);
        expect(await foreignAudit()).toEqual(oldAudit);
        expect(
          await fixture.db`select id from allrice_employee_assignments
          where employee_id=${b.employee} and user_id=${a.user}`,
        ).toEqual([]);
        const legacyBlocked = await assign(a, localSource, [a.user]);
        expect(legacyBlocked.status).toBe(409);
        expect(await legacyBlocked.json()).toMatchObject({
          error: {
            code: 'QUOTA_EXCEEDED',
            message: '当前工作台还没确认停机，停机后可以创建更多员工。',
          },
        });
        expect(
          await fixture.db`select id from allrice_employee_assignments
          where employee_id=${localSource} and user_id=${a.user}`,
        ).toEqual([]);
        expect(
          (await setOrganizationAccount(admin, a, true, dormant.version))
            .status,
        ).toBe(200);
        expect(await data()).toEqual(evidence);
        const login = await createSession(a.user);
        cookie.token = login.token;
        const current = await authenticateSession(login.token, {
          organizationId: a.org,
          workspaceId: a.workspace,
        });
        expect(current).not.toBeNull();
        await expect(
          requireDEntryNativeIdentity(current!, {
            workspaceId: a.workspace,
            employeeInstanceId: a.assignment,
          }),
        ).resolves.toMatchObject({ employeeInstanceId: a.assignment });
        await expect(
          h.service.resolve(a.context, signal()),
        ).resolves.toMatchObject({ vmId: owner!.vmId, organizationId: a.org });
        h.states.set(owner!.vmId, 'stopped');
        await h.service.stop(a.context, signal());
        expect((await c(a)).status).toBe(201);
      } finally {
        const row = await store.read(a.user);
        if (row?.phase === 'running') {
          h.states.set(row.vmId, 'stopped');
          await h.service.stop(a.context, signal());
        }
        await clearPublished();
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      }
    });

    it.each([
      ['login', 'authorization_denied'],
      ['membership', 'tenant_context_invalid'],
    ] as const)(
      'releases the real active entry permit after pre-acquire %s revocation',
      async (withdrawn, denial) => {
        await clearPublished();
        const f = await setup();
        await authorizeFixturePlatformAdministrator(fixture.db, f.user);
        const openSql = () => client.createDedicatedDatabase(fixture.db);
        const h = harness(new PostgresPersonVmStore(openSql));
        const current = createProductionPersonVmAuthority(signal());
        const vm = new PersonVmService({
          ...h.options,
          authority: current.authority,
        });
        const admission = vm.createAdmissionHost({ openSql });
        const entry = admission.participant('entry');
        const gateway = admission.participant('gateway');
        const prewarmCurrent = createProductionCurrentPrewarm({ vm, current });
        const entered = deferred<void>();
        const finishCurrentCheck = deferred<void>();
        const active = signal();
        const tenant = { organizationId: f.org, workspaceId: f.workspace };
        const selection = {
          workspaceId: f.workspace,
          employeeInstanceId: f.assignment,
        };
        let binding: PersonVmBinding | undefined;
        let operation: Promise<unknown> | undefined;
        let membershipWithdrawn = false;
        const restoreMembership = async () => {
          if (!membershipWithdrawn) return;
          await fixture.db`update allrice_memberships set active=true where id=${f.membership}`;
          membershipWithdrawn = false;
        };
        try {
          await updateDEntryReleasePolicy(f.context, {
            revision: 'initial',
            defaultGeneration: '3.x',
            selections: [{ organizationId: f.org, personId: f.user }],
          });
          const selected = await requireDEntryNativeIdentity(
            f.context,
            selection,
          );
          await prewarmCurrent(
            f.context,
            selected,
            { trigger: 'page' },
            active,
          );
          binding = await vm.resolve(f.context, active);
          const operationId = randomUUID();
          const rows = () => fixture.db`
          select operation_id, disposition from person_vm_admission_permits
          where person_id=${f.user} and participant='entry'`;
          const run = vi.fn(async () => {});
          const close = vi.fn(async () => {});
          const acquire = vi.fn(() => ({ run, close }));
          let checks = 0;
          let authorityError: unknown;
          const check = async (caller: AbortSignal) => {
            if (++checks === 2) {
              entered.resolve(undefined);
              await finishCurrentCheck.promise;
            }
            try {
              const authority =
                withdrawn === 'membership'
                  ? await authenticateSession(f.login.token, tenant)
                  : f.context;
              if (!authority) throw Error('fixture_expected_current_login');
              await requireDEntryNativeIdentity(authority, selection);
            } catch (error) {
              authorityError = error;
              throw error;
            }
            caller.throwIfAborted();
          };
          operation = runDEntryAdmittedActivity(
            {
              ports: { boundary: admission, participant: entry },
              owner: {
                context: f.context,
                binding,
                operationId,
                revoked: active,
                assertCurrent: check,
                assertUndispatched: check,
              },
              signal: active,
            },
            acquire,
          );
          await Promise.race([entered.promise, operation]);
          expect(await rows()).toEqual([
            { operation_id: operationId, disposition: 'active' },
          ]);
          expect(acquire).not.toHaveBeenCalled();
          if (withdrawn === 'login') {
            await revokeSession(f.login.token);
          } else {
            membershipWithdrawn = true;
            expect(
              await fixture.db`update allrice_memberships set active=false
            where id=${f.membership} and active returning id`,
            ).toEqual([{ id: f.membership }]);
          }
          finishCurrentCheck.resolve(undefined);
          await expect(operation).rejects.toMatchObject({
            code: denial,
          });
          await expect(operation).rejects.toBe(authorityError);
          expect(acquire).not.toHaveBeenCalled();
          expect(run).not.toHaveBeenCalled();
          expect(close).not.toHaveBeenCalled();
          expect(await rows()).toEqual([]);

          await restoreMembership();
          const login = await createSession(f.user);
          const authorized = await authenticateSession(login.token, tenant);
          if (!authorized) throw Error('fixture_reauthentication_failed');
          // This fixture already supplies a separate physical lifecycle actor.
          // Production entry itself must not gain stop authority.
          const lifecycle = h.service.createAdmissionHost({ openSql });
          const lease = await lifecycle.issue(authorized, binding, active);
          try {
            await gateway.freeze(lease, active);
            expect(await entry.freeze(lease, active)).toMatchObject({
              state: 'known',
              active: 0,
              queued: 0,
            });
            await gateway.assertFrozen(lease, active);
            await entry.assertFrozen(lease, active);
          } finally {
            await gateway.thaw(lease, active);
            await entry.thaw(lease, active);
          }
        } finally {
          finishCurrentCheck.resolve(undefined);
          await Promise.allSettled([operation]);
          try {
            await restoreMembership();
            if (binding) await vm.shutdownOwned(binding);
          } finally {
            await current.close();
            await clearPublished();
          }
        }
      },
    );

    it.each([
      'guest receipt lost',
      'Host join unknown',
      'different epoch',
      'admission LISTEN close fails',
    ] as const)(
      'recovers only its own locally joined production entry permit after exact native stop: %s',
      async (failure) => {
        const f = await setup();
        let failUnlisten = false;
        let failedUnlistens = 0;
        const openSql = () => {
          const db = client.createDedicatedDatabase(fixture.db);
          if (failUnlisten) {
            const listen = db.listen.bind(db);
            db.listen = ((...args: Parameters<typeof db.listen>) =>
              listen(...args).then((subscription) => ({
                ...subscription,
                async unlisten() {
                  await subscription.unlisten();
                  failedUnlistens++;
                  throw Error('entry admission listener close failed');
                },
              }))) as typeof db.listen;
          }
          return db;
        };
        const h = harness(new PostgresPersonVmStore(openSql));
        const retire = vi.fn(async () => {});
        h.runtime.retireAfterNativeStop = retire;
        const lifetime = signal();
        const current = createProductionPersonVmAuthority(lifetime);
        probes.add(current.close);
        const vm = new PersonVmService({
          ...h.options,
          authority: current.authority,
        });
        const admission = vm.createAdmissionHost({ openSql });
        const prewarmCurrent = createProductionCurrentPrewarm({ vm, current });
        const reconcile = createProductionStoppedEntryReconciliation({
          vm,
          current,
        });
        const scope = {
          workspaceId: f.workspace,
          employeeInstanceId: f.assignment,
        };
        const owners = () => fixture.db<
          { permit_id: string; participant: string; disposition: string }[]
        >`
          select permit_id, participant, disposition from person_vm_admission_permits where person_id=${f.user} order by participant,disposition`;
        await clearPublished();
        await authorizeFixturePlatformAdministrator(fixture.db, f.user);
        try {
          await updateDEntryReleasePolicy(f.context, {
            revision: 'initial',
            defaultGeneration: '3.x',
            selections: [{ organizationId: f.org, personId: f.user }],
          });
          const old = await requireDEntryNativeIdentity(f.context, scope);
          await prewarmCurrent(f.context, old, { trigger: 'page' }, lifetime);
          const binding = await vm.resolve(f.context, lifetime);
          const patch = await updateEmployee(
            new Request(
              `https://allrice.test/api/v1/employee-instances/${f.assignment}`,
              {
                method: 'PATCH',
                headers: {
                  origin: 'https://allrice.test',
                  'x-allrice-organization-id': f.org,
                  'x-allrice-workspace-id': f.workspace,
                },
                body: JSON.stringify({
                  workspaceId: f.workspace,
                  expectedRevision: old.employeeRevision,
                  requestId: randomUUID(),
                  profile: { expressionStyle: 'structured' },
                }),
              },
            ),
            { params: Promise.resolve({ id: f.assignment }) },
          );
          expect(patch.status).toBe(200);
          const next = await requireDEntryNativeIdentity(f.context, scope);
          expect(next).toEqual({
            ...old,
            employeeRevision: old.employeeRevision + 1,
          });
          expect(await confirmDEntryEmployeeArchive(old)).toBe(false);

          const error = new PersonVmError('CLEANUP_INCOMPLETE');
          let newEmployeeJobExited = false;
          const dispatches: PersonVmBinding[] = [];
          const dispatchPermits: string[] = [];
          const endpoint = {
            ...scope,
            employeeRevision: next.employeeRevision,
            employeeVersionId: next.employeeVersionId,
            hostPort: 30080,
            guestPort: 30081,
          };
          let published: AssignedNativeWebCatalog | undefined;
          const catalog = (target: PersonVmBinding, id: string) => {
            if (
              !published ||
              !sameVmBinding(target, published.receipt.binding) ||
              id !== endpoint.employeeInstanceId
            )
              throw new PersonVmError('RUNTIME_NOT_READY');
            return published;
          };
          const assertVerifiedEditor = (
            target: PersonVmBinding,
            active: AbortSignal,
            id: string = endpoint.employeeInstanceId,
          ) => {
            active.throwIfAborted();
            const { owner, revoked } = catalog(target, id);
            if (!owner.controlReady())
              throw new PersonVmError('RUNTIME_NOT_READY');
            revoked.throwIfAborted();
            return revoked;
          };
          const confirmPhysical = vi.fn<
            NonNullable<
              Parameters<
                typeof installProductionDEntrySource
              >[0]['confirmPhysical']
            >
          >((context, identity, target, active) =>
            current.withCurrentSelection(context, identity, active, () =>
              vm.assertRunningReadiness(context, target, active),
            ),
          );
          const startup = installProductionDEntrySource({
            vm,
            admission,
            lifetime,
            confirmPhysical,
            resolveSendRoute: vi.fn(),
            startup: {
              needsEmployee: (_context, target) =>
                target.leaseEpoch === binding.leaseEpoch ||
                newEmployeeJobExited,
              async synchronizeEmployee(
                _context,
                current,
                identity,
                check,
                active,
              ) {
                await check(active);
                expect(identity).toEqual(next);
                dispatches.push(current);
                if (current.leaseEpoch === binding.leaseEpoch + 1) {
                  expect(newEmployeeJobExited).toBe(true);
                  const [entry] = await owners();
                  expect(entry).toMatchObject({
                    participant: 'entry',
                    disposition: 'active',
                  });
                  dispatchPermits.push(entry!.permit_id);
                  newEmployeeJobExited = false;
                  return;
                }
                expect(current).toEqual(binding);
                if (failure === 'Host join unknown') throw error;
                throw new NativeWebGuestLaunchUnacknowledged(
                  failure === 'different epoch'
                    ? { ...current, leaseEpoch: current.leaseEpoch + 1 }
                    : current,
                  error,
                );
              },
              installStartingEditorProof: () => () => {},
              ensureVerifiedEditor: async (_context, current, id, active) => {
                expect(current).toMatchObject({
                  vmId: binding.vmId,
                  leaseEpoch: binding.leaseEpoch + 1,
                });
                expect(id).toBe(next.employeeInstanceId);
                return assertVerifiedEditor(current, active, id);
              },
              assertVerifiedEditor,
              assertAuthenticatedGroup: assertVerifiedEditor,
              catalog,
            },
          });
          probes.add(startup.close);
          const unexpectedOwnerOperation = () => {
            throw Error(
              'This fixture does not dispatch native owner operations',
            );
          };
          const startNative = h.runtime.start;
          h.runtime.start = async (...args) => {
            await startNative(...args);
            const [target] = args;
            if (
              target.personId === binding.personId &&
              target.organizationId === binding.organizationId &&
              target.vmId === binding.vmId &&
              target.leaseEpoch === binding.leaseEpoch + 1
            )
              published = Object.freeze({
                receipt: {
                  binding: target,
                  rosterDigest: 'current-physical-fixture',
                  endpoints: [endpoint],
                },
                endpoint,
                bindingRef: target.instanceId,
                revoked: lifetime,
                owner: {
                  binding: target,
                  revoked: lifetime,
                  jobExited: signal(),
                  modelAdapterId: undefined,
                  profileVerificationOwner: {},
                  nativeInstanceId: target.instanceId,
                  controlReady: () => !newEmployeeJobExited,
                  verifyStartingEditor: unexpectedOwnerOperation,
                  verifyRunningEditor: unexpectedOwnerOperation,
                  createRootFor: unexpectedOwnerOperation,
                  acquirePrincipal: unexpectedOwnerOperation,
                  readSessions: unexpectedOwnerOperation,
                  readSessionsFor: unexpectedOwnerOperation,
                  readImmutableGraphFor: unexpectedOwnerOperation,
                  readImmutableBundleFor: unexpectedOwnerOperation,
                  readNativeRootWakeFor: unexpectedOwnerOperation,
                  readNativeAttemptFor: unexpectedOwnerOperation,
                  observeNativeSearchCallFor: unexpectedOwnerOperation,
                  waitNativeTurnEnd: unexpectedOwnerOperation,
                  readPersistedRunTerminalFor: unexpectedOwnerOperation,
                  readManagedModelImageFor: unexpectedOwnerOperation,
                  readModelCatalogFor: unexpectedOwnerOperation,
                  nativeActivityRevision: unexpectedOwnerOperation,
                  readNativeActivity: unexpectedOwnerOperation,
                  readScheduleCatalog: unexpectedOwnerOperation,
                  retireAfterJobExit: unexpectedOwnerOperation,
                  retireAfterNativeStop: unexpectedOwnerOperation,
                  close: unexpectedOwnerOperation,
                },
              });
          };
          const installed = installAssignedDEntryNativeRuntime({
            vm,
            lifetime,
            prewarmCurrent,
            reconcileStoppedEntry: reconcile,
            isLiveSlottedBinding: (target) =>
              Boolean(
                published && sameVmBinding(target, published.receipt.binding),
              ),
            startup: { catalog },
          });
          probes.add(installed.close);
          const other = await admission.admit(
            f.context,
            binding,
            { participant: 'entry', operationId: randomUUID() },
            signal(),
          );
          const gateway = await admission.admit(
            f.context,
            binding,
            { participant: 'gateway', operationId: randomUUID() },
            signal(),
          );
          const gatewayStarted = deferred<void>();
          const releaseGateway = deferred<void>();
          const gatewayWork = admission.activate(
            gateway,
            async () => {
              gatewayStarted.resolve(undefined);
              await releaseGateway.promise;
            },
            signal(),
          );
          void gatewayWork.catch(() => {});
          const expectedOther = [
            {
              permit_id: other.permitId,
              participant: 'entry',
              disposition: 'queued',
            },
            {
              permit_id: gateway.permitId,
              participant: 'gateway',
              disposition: 'active',
            },
          ];
          try {
            await Promise.race([gatewayStarted.promise, gatewayWork]);
            const apply = currentDEntryNativeDataPort()!.assertEditorReady!;
            await expect(
              apply(f.context, old, signal()),
            ).rejects.toHaveProperty('code', 'authorization_denied');
            expect(await owners()).toEqual(expectedOther);
            const reachesFreshTicket = failure === 'guest receipt lost';
            const server = reachesFreshTicket
              ? await nativeEntryServer(undefined, dEntryHttpDefaults)
              : undefined;
            if (server) probes.add(server.close);
            const headers = { authorization: `Bearer ${f.login.token}` };
            const open = () =>
              server!.request(
                'native-prewarm',
                { organizationId: f.org, selection: scope, trigger: 'page' },
                headers,
              );
            const status = (operationId: string) =>
              fetch(
                server!.origin +
                  '/internal/d-entry/native-prewarm/status?' +
                  new URLSearchParams({
                    organizationId: f.org,
                    ...scope,
                    operationId,
                  }),
                { headers },
              );
            let lastOperation: string | undefined;
            if (server) {
              const warming = await open();
              expect(warming.status).toBe(202);
              lastOperation = (await warming.json()).ticket.operationId;
              await vi.waitFor(async () => {
                expect(
                  await (await status(lastOperation!)).json(),
                ).toMatchObject({ state: 'failed' });
              });
            } else {
              failUnlisten = failure === 'admission LISTEN close fails';
              try {
                await expect(apply(f.context, next, signal())).rejects.toThrow(
                  'D entry cleanup unknown',
                );
              } finally {
                failUnlisten = false;
              }
              expect(failedUnlistens).toBe(
                failure === 'admission LISTEN close fails' ? 1 : 0,
              );
            }
            const retained = [
              {
                permit_id: expect.any(String),
                participant: 'entry',
                disposition: 'active',
              },
              ...expectedOther,
            ];
            expect(await owners()).toEqual(retained);
            const prepare = () =>
              dEntryNativePrewarmPort.prepare!(f.context, next, signal());
            const target = {
              vmId: binding.vmId,
              instanceId: binding.instanceId,
              leaseEpoch: binding.leaseEpoch,
            };
            for (const phase of ['running', 'unknown'] as const) {
              h.states.set(binding.vmId, phase);
              await expect(prepare()).resolves.toMatchObject({
                target,
              });
              expect(await owners()).toEqual(retained);
            }
            if (reachesFreshTicket) {
              h.states.set(binding.vmId, 'running');
              const raced = vi
                .spyOn(h.native, 'status')
                .mockResolvedValueOnce('stopped');
              try {
                await expect(prepare()).resolves.toMatchObject({
                  target,
                });
                expect(await owners()).toEqual(retained);
              } finally {
                raced.mockRestore();
              }
            }
            expect(retire).not.toHaveBeenCalled();
            h.states.set(binding.vmId, 'stopped');
            await expect(h.store.read(f.user)).resolves.toMatchObject({
              phase: 'running',
              leaseEpoch: binding.leaseEpoch,
            });
            await expect(
              reconcile(
                f.context,
                next,
                { ...binding, leaseEpoch: binding.leaseEpoch + 1 },
                signal(),
              ),
            ).resolves.toBe(false);
            const foreign = new PersonVmService({
              ...h.options,
              authority: current.authority,
            });
            foreign.createAdmissionHost({ openSql });
            await expect(
              createProductionStoppedEntryReconciliation({
                vm: foreign,
                current,
              })(f.context, next, binding, signal()),
            ).resolves.toBe(false);
            expect(await owners()).toEqual(retained);
            if (!server || !lastOperation) {
              await expect(prepare()).resolves.toMatchObject({
                target,
              });
              expect(await owners()).toEqual(retained);
              return;
            }

            await expect(prepare()).rejects.toHaveProperty('code', 'VM_ACTIVE');
            expect(await owners()).toEqual(expectedOther);
            await expect(h.store.read(f.user)).resolves.toMatchObject({
              phase: 'running',
              leaseEpoch: binding.leaseEpoch,
            });
            expect(h.log).not.toContain('native:stop');
            await admission.finish(other);
            releaseGateway.resolve(undefined);
            await gatewayWork;
            await admission.finish(gateway);
            // T1 gets its existing epoch from the real HTTP path, then stops
            // just before production proof re-resolves the physical owner.
            const data = currentDEntryNativeDataPort()!;
            const entered = deferred<void>();
            const releaseStale = deferred<void>();
            const prove = data.assertEditorReady!.bind(data);
            const paused = vi
              .spyOn(data, 'assertEditorReady')
              .mockImplementationOnce(async (...args) => {
                entered.resolve(undefined);
                await releaseStale.promise;
                return prove(...args);
              });
            const resume = deferred<void>();
            const originalStart = h.native.start;
            h.native.start = async (...args) => {
              await resume.promise;
              return originalStart(...args);
            };
            try {
              h.states.set(binding.vmId, 'running');
              const staleRequest = open();
              await Promise.race([
                entered.promise,
                staleRequest.then(() => {
                  throw Error('old proof did not reach its pause');
                }),
              ]);
              const stale = await staleRequest;
              expect(stale.status).toBe(202);
              const staleId: string = (await stale.json()).ticket.operationId;
              expect(staleId).not.toBe(lastOperation);

              // Physical absence settles the proven old permit/Host, but
              // retained compute is required for any new ticket.
              const oldThread = await four(f);
              h.states.set(binding.vmId, 'absent');
              expect((await open()).status).toBe(503);
              await expect(h.store.read(f.user)).resolves.toMatchObject({
                phase: 'stopped',
                vmId: binding.vmId,
                instanceId: binding.instanceId,
                leaseEpoch: binding.leaseEpoch,
                nativeCreated: true,
                diskRetained: true,
              });
              expect(await owners()).toEqual([]);
              expect((await open()).status).toBe(503); // Already stopped PG row.
              expect(h.disks.has(binding.vmId)).toBe(true);
              expect(
                await getSessionExecutionGeneration(
                  f.context,
                  f.workspace,
                  oldThread.id,
                ),
              ).toBe('4.0');

              // Only the original compute coming back as stopped permits T2.
              h.states.set(binding.vmId, 'stopped');
              const warming = await open();
              expect(warming.status).toBe(202);
              const operationId: string = (await warming.json()).ticket
                .operationId;
              expect(operationId).not.toBe(lastOperation);
              const expired = await status(lastOperation);
              expect(expired.status).toBe(410);
              expect(await expired.json()).toEqual({ state: 'expired' });
              await expect(
                vm.assertCurrentBinding(f.context, binding, signal()),
              ).rejects.toBeDefined();
              resume.resolve(undefined);
              await vi.waitFor(async () => {
                expect(await (await status(operationId)).json()).toEqual({
                  state: 'ready',
                });
              });
              const reopened = await vm.resolve(f.context, signal());
              expect(reopened).toMatchObject({
                vmId: binding.vmId,
                leaseEpoch: binding.leaseEpoch + 1,
              });
              expect(reopened.instanceId).not.toBe(binding.instanceId);
              expect(await owners()).toEqual([]);
              newEmployeeJobExited = true;
              const delayed = paused.mock.results[0]!.value;
              const staleProof = expect(delayed).rejects.toHaveProperty(
                'code',
                'LEASE_LOST',
              );
              releaseStale.resolve(undefined);
              await staleProof;
              expect(paused.mock.calls[0]?.[3]).toEqual(binding);
              expect((await status(staleId)).status).toBe(410);
              expect(dispatches).toEqual([binding]);
              expect(dispatchPermits).toEqual([]);
              expect(await owners()).toEqual([]);

              expect(confirmPhysical).not.toHaveBeenCalled();
              const ping = vi.spyOn(h.native, 'ping');
              const hot = await open();
              if (hot.status === 202) {
                const hotId: string = (await hot.json()).ticket.operationId;
                await vi.waitFor(async () => {
                  expect(await (await status(hotId)).json()).toEqual({
                    state: 'ready',
                  });
                });
              } else expect(hot.status).toBe(200);
              expect(confirmPhysical).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ sessionId: f.context.sessionId }),
                next,
                reopened,
                expect.any(AbortSignal),
              );
              expect(ping).toHaveBeenCalledExactlyOnceWith(
                reopened,
                expect.any(AbortSignal),
              );
              expect(dispatches).toEqual([binding, reopened]);
              expect(dispatchPermits).toHaveLength(1);
              expect(await owners()).toEqual([]);
              expect(retire).toHaveBeenCalledExactlyOnceWith(
                binding,
                expect.any(AbortSignal),
              );
              expect(h.log).not.toContain('native:stop');
            } finally {
              resume.resolve(undefined);
              releaseStale.resolve(undefined);
              paused.mockRestore();
              await server.close();
              probes.delete(server.close);
            }
          } finally {
            releaseGateway.resolve(undefined);
            await Promise.allSettled([gatewayWork]);
            await Promise.all([
              admission.finish(other),
              admission.finish(gateway),
            ]);
          }
        } finally {
          await clearPublished();
          vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
        }
      },
    );

    it('pins old and new threads permanently and never creates a 3.x native origin for 4.0', async () => {
      const f = await setup(),
        thread = await four(f);
      expect(
        await getSessionExecutionGeneration(f.context, f.workspace, f.session),
      ).toBe('3.x');
      expect(
        await getSessionExecutionGeneration(f.context, f.workspace, thread.id),
      ).toBe('4.0');
      const [row] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${thread.id}`;
      expect(row!.native_root_origin).toBeNull();
      await expect(
        fixture.db`update allrice_chat_sessions set execution_generation='3.x' where id=${thread.id}`,
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        createChatSession(
          f.context,
          { workspaceId: f.workspace, employeeInstanceId: f.assignment },
          { sessionId: thread.id },
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });
    it('opens the first 4.0 business thread once and retries explicit New at the same durable ID', async () => {
      const f = await setup();
      await clearPublished();
      const selection = {
        workspaceId: f.workspace,
        employeeInstanceId: f.assignment,
      };
      const request = (operationId?: string, origin = 'https://allrice.test') =>
        new Request('https://allrice.test/api/v1/sessions?entry=4.0', {
          method: 'POST',
          headers: { origin, 'x-allrice-organization-id': f.org },
          body: JSON.stringify({ selection, operationId }),
        });
      const rows =
        () => fixture.db`select id,execution_generation,native_root_origin,d_entry_native_root
        from allrice_chat_sessions where owner_id=${f.user} order by id`;
      expect(await findDEntryEmployee(f.context)).toBeNull();
      expect((await createBusinessThread(request())).status).toBe(403);
      expect(await rows()).toHaveLength(1);
      await authorizeFixturePlatformAdministrator(fixture.db, f.user);
      await updateDEntryReleasePolicy(f.context, {
        revision: 'initial',
        defaultGeneration: '3.x',
        selections: [{ organizationId: f.org, personId: f.user }],
      });
      try {
        expect(
          await findDEntryEmployee({ ...f.context, workspaceId: null }),
        ).toEqual(selection);
        expect(
          (await createBusinessThread(request(undefined, 'https://other.test')))
            .status,
        ).toBe(403);
        const first = await Promise.all([
          createBusinessThread(request()),
          createBusinessThread(request()),
        ]);
        expect(first.map(({ status }) => status)).toEqual([200, 200]);
        const [one, same] = await Promise.all(
          first.map((response) => response.json()),
        );
        expect(one).toEqual({ ...selection, threadId: expect.any(String) });
        expect(same).toEqual(one);
        expect(await rows()).toHaveLength(2);
        const id = randomUUID();
        const explicit = await createBusinessThread(request(id));
        expect(explicit.status).toBe(200);
        expect(await explicit.json()).toEqual({ ...selection, threadId: id });
        expect(await (await createBusinessThread(request(id))).json()).toEqual({
          ...selection,
          threadId: id,
        });
        const active = await rows();
        expect(active).toHaveLength(3);
        const [audit] = await fixture.db`select count(*)::int as count
          from allrice_audit_events where actor_id=${f.user} and resource_id=${id} and action='session.create'`;
        expect(audit?.count).toBe(1);
        expect(
          active.filter(
            ({ execution_generation }) => execution_generation === '4.0',
          ),
        ).toEqual(
          expect.arrayContaining(
            [one.threadId, id].map((threadId) => ({
              id: threadId,
              execution_generation: '4.0',
              native_root_origin: null,
              d_entry_native_root: null,
            })),
          ),
        );
        expect((await createBusinessThread(request(f.session))).status).toBe(
          403,
        );
        await revokeSession(f.login.token);
        expect((await createBusinessThread(request(randomUUID()))).status).toBe(
          401,
        );
        expect(await rows()).toEqual(active);
      } finally {
        await clearPublished();
      }
    });
    it('serializes competing 3.x/4.0 creations at the same actual thread identity', async () => {
      const f = await setup(),
        id = randomUUID();
      const input = {
        workspaceId: f.workspace,
        employeeInstanceId: f.assignment,
      };
      const results = await Promise.allSettled([
        createChatSession(f.context, input, {
          sessionId: id,
          executionGeneration: '3.x',
        }),
        createChatSession(f.context, input, {
          sessionId: id,
          executionGeneration: '4.0',
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
        code: 'authorization_denied',
      });
      const [row] =
        await fixture.db`select count(*)::int count from allrice_chat_sessions where id=${id}`;
      expect(row!.count).toBe(1);
    });
    it('rejects legacy send, queue edit, child prompt and native acquire on a 4.0 thread before writes', async () => {
      const f = await setup(),
        thread = await four(f);
      await expect(
        sendChatMessage(f.context, f.workspace, thread.id, {
          clientMessageId: randomUUID(),
          text: '请在这条4.0线程继续处理，不能交给3.x执行。',
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        updateQueuedMessage(f.context, f.workspace, thread.id, randomUUID(), {
          action: 'edit',
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        enqueueNativeSubagentControl(f.context, thread.id, {
          rootRunId: f.rootRunId,
          generation: 0,
          input: {
            requestId: randomUUID(),
            kind: 'prompt',
            mode: 'continuable',
            parentSessionId: 'native-root',
            childSessionId: 'native-child',
            delivery: 'queue',
            content: [{ type: 'text', text: '网页不直接向子会话发言' }],
          },
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        acquireConversationRuntime({
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
          sessionId: thread.id,
          runId: f.rootRunId,
          workerId: f.worker.workerId,
          configChecksum: 'sha256:' + 'a'.repeat(64),
          compactThresholdTokens: 10000,
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const [counts] = await fixture.db`select
      (select count(*)::int from allrice_messages where session_id=${thread.id}) messages,
      (select count(*)::int from allrice_conversation_runtimes where session_id=${thread.id}) runtimes,
      (select count(*)::int from allrice_conversation_commands where session_id=${thread.id}) commands`;
      expect(counts).toMatchObject({ messages: 0, runtimes: 0, commands: 0 });
    });
    it('filters 4.0 from the real legacy claim and rechecks forged claimed/bind attempts', async () => {
      // Freeze the inconsistent legacy queue at first INSERT; existing Run
      // snapshots and Session writer pins remain immutable in this test too.
      const f = await setup('4.0');
      expect(
        await getSessionExecutionGeneration(f.context, f.workspace, f.session),
      ).toBe('4.0');
      const evidence = () => fixture.db`select
        (select to_jsonb(er) from allrice_employee_runs er where run_id=${f.rootRunId}) employee_run,
        (select to_jsonb(r) from allrice_conversation_runtimes r where session_id=${f.session}) runtime,
        (select count(*)::int from allrice_messages where session_id=${f.session}) messages,
        (select count(*)::int from allrice_native_session_bindings where context_kind='chat' and context_id=${f.session}) bindings,
        (select count(*)::int from allrice_run_events where run_id=${f.rootRunId}) events`;
      const before = await evidence();
      const job = () =>
        fixture.db`select status,worker_id,lease_token,lease_expires_at,attempt from allrice_jobs where id=${f.worker.jobId}`;
      await fixture.db`update allrice_jobs set status='queued',available_at=clock_timestamp()-interval '1 second',attempt=1 where id=${f.worker.jobId}`;
      const queued = await job();
      expect(await claimNextJob(randomUUID(), 60000)).toBeNull();
      expect(await job()).toEqual(queued);
      await fixture.db`update allrice_jobs set status='claimed',lease_expires_at=clock_timestamp()+interval '5 minutes' where id=${f.worker.jobId}`;
      const claimed = await job();
      await expect(
        startClaimedJob(f.worker.workerId, f.worker.jobId, f.worker.leaseToken),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(await job()).toEqual(claimed);
      await fixture.db`update allrice_jobs set status='running' where id=${f.worker.jobId}`;
      const running = await job();
      const lease = {
        workerId: f.worker.workerId,
        jobId: f.worker.jobId,
        leaseToken: f.worker.leaseToken,
        attempt: 1,
        subject: {
          kind: 'chat' as const,
          id: f.session,
          configChecksum: 'sha256:' + 'a'.repeat(64),
          generation: 0,
          expectedThreadId: null,
        },
      };
      await expect(
        prepareJobNativeSession({
          ...lease,
          nativeSessionId: 'dsh-' + f.session,
          storageContextKey: f.session,
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        bindJobNativeSession({
          ...lease,
          descriptor: nativeBindingDescriptor({
            organizationId: f.org,
            workspaceId: f.workspace,
            ownerId: f.user,
            contextKey: f.session,
          }),
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(await job()).toEqual(running);
      expect(await evidence()).toEqual(before);
    });
  },
);
