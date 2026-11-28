import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createPostgresNativeScheduleObservationLedger,
  createPostgresPersonVmScheduledWakeStore,
  createDedicatedDatabase,
  createEmployeeInstance,
  readContentPrincipal,
  readPersonVmWakeRoster,
} from '@allrice/database';
import {
  createDailyScheduleRecord,
  ScheduleId,
  type ScheduleCatalogEntry,
} from '@deepseek-ai/dsh-schedule';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  PersonVmError,
  PersonVmService,
  PostgresPersonVmStore,
  PERSON_VM_WAKE_RESUME_AUDIT,
  type PersonVmBootstrapScope,
} from '@allrice/person-vm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import * as databaseClient from '../../../../packages/database/src/core/client.ts';
import { deferred } from '../../../../packages/d-entry-principal/test/host-fixture.ts';
import {
  context,
  harness,
} from '../../../../packages/person-vm/src/test-support.ts';
import { bootstrapMicrosandbox } from '../../../../packages/person-vm/src/microsandbox-bootstrap.ts';
import { runCommand } from '../../../../packages/person-vm/src/process.ts';
import { openNativeWebOwner } from '../native-web/owner.js';
import { createPersonVmScheduledWake } from './scheduled-wake.js';
import {
  createProductionScheduledWake,
  createProductionScheduledWakeSource,
  createProductionRetainedWake,
} from './production-scheduled-wake.js';
import {
  assertCompleteNativeActivityCensus,
  createProductionNativeActivity,
} from './production-native-activity.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('scheduled wake host intent on real PostgreSQL', () => {
  const signal = new AbortController().signal;
  const wakeAt = '2024-11-03T05:58:00.000Z';
  const target = '2024-11-03T06:00:00.000Z';
  type CaptureChecks = Pick<
    Awaited<
      ReturnType<Parameters<typeof createPersonVmScheduledWake>[0]['capture']>
    >,
    'assertDeliverable' | 'confirmObservations'
  >;
  let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let db: typeof database.db;

  beforeAll(async () => {
    database = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
    db = database.db;
  }, 120_000);

  beforeEach(async () => {
    // This suite owns its schema, but several cases intentionally leave
    // claims in flight. A host-wide query must not see another case's claim.
    await db`delete from person_vm_scheduled_wakes`;
  });

  afterAll(async () => {
    await database?.close();
  }, 30_000);

  async function fixture() {
    const binding = {
      personId: randomUUID(),
      organizationId: randomUUID(),
      vmId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
    };
    await db`insert into person_virtual_machines
      (person_id,organization_id,vm_id,instance_id,lease_epoch,phase,disk_tier,native_created,egress_receipt)
      values (${binding.personId},${binding.organizationId},${binding.vmId},
        ${binding.instanceId},${binding.leaseEpoch},'running','warm',true,'{}'::jsonb)`;
    const origin = {
      ...binding,
      workspaceId: randomUUID(),
      employeeInstanceId: randomUUID(),
      employeeVersionId: randomUUID(),
      employeeRevision: 1,
      bindingRef: 'isolated-fixture',
    };
    const assertCurrent = vi.fn(async () => {});
    let rows: ScheduleCatalogEntry[] = [
      {
        id: ScheduleId('at'),
        kind: 'at',
        status: 'active',
        scheduledAt: target,
        sessionId: SessionId('session'),
        prompt: 'synthetic',
        title: 'synthetic',
      },
    ];
    const receiptIds = new Map<string, string>();
    const catalog = vi.fn(async () => rows);
    const additional: {
      origin: typeof origin;
      receiptId: string;
      schedule: { catalog(): Promise<ScheduleCatalogEntry[]> };
    }[] = [];
    const start = vi.fn<
      Parameters<typeof createPersonVmScheduledWake>[0]['start']
    >(async () => 'ready');
    const store = () => createPostgresPersonVmScheduledWakeStore(db);
    const module = (wakeStore = store(), checks: CaptureChecks = {}) =>
      createPersonVmScheduledWake({
        store: wakeStore,
        ledger: createPostgresNativeScheduleObservationLedger(db),
        now: () => new Date('2024-11-03T05:00:00.000Z'),
        capture: async (_binding, planId) => {
          if (!receiptIds.has(planId))
            receiptIds.set(planId, 'a' + randomUUID().slice(1));
          return {
            profiles: [
              {
                origin,
                receiptId: receiptIds.get(planId)!,
                schedule: { catalog },
              },
              ...additional,
            ],
            assertCurrent,
            ...checks,
          };
        },
        start,
      });

    return {
      assertCurrent,
      binding,
      origin,
      catalog,
      start,
      store,
      module,
      addProfile(entries: ScheduleCatalogEntry[]) {
        const sibling = {
          ...origin,
          employeeInstanceId: randomUUID(),
          employeeVersionId: randomUUID(),
          bindingRef: randomUUID(),
        };
        additional.push({
          origin: sibling,
          receiptId: randomUUID(),
          schedule: { catalog: async () => entries },
        });
        return sibling;
      },
      async invalidate(planId: string) {
        await createPostgresNativeScheduleObservationLedger(
          db,
        ).invalidateReceipts({
          kind: 'invalidation',
          origin,
          receiptId: randomUUID(),
          invalidateReceiptIds: [receiptIds.get(planId)!.toUpperCase()],
          reasonRef: 'fixture-native-rule-deleted',
        });
      },
      setRows(next: ScheduleCatalogEntry[]) {
        rows = next;
      },
      reviseTime(scheduledAt: string) {
        rows = rows.map((row) => ({ ...row, scheduledAt }));
      },
      async stop(requestId: string) {
        await db.begin(async (tx) => {
          await tx`update person_virtual_machines set phase='stopped',egress_receipt=null
            where person_id=${binding.personId}`;
          await tx`insert into person_vm_audit
            (person_id,organization_id,vm_id,request_id,action,result,lease_epoch)
            values (${binding.personId},${binding.organizationId},${binding.vmId},
            ${requestId},'stop','succeeded',${binding.leaseEpoch})`;
        });
      },
    };
  }

  async function publishFixtureAuthority(
    f: Awaited<ReturnType<typeof fixture>>,
    siblings: (typeof f.origin)[] = [],
  ) {
    const { personId, organizationId, workspaceId } = f.origin;
    return db.begin(async (tx) => {
      await tx`insert into allrice_users(id,email,display_name,password_hash)
        values(${personId},${personId + '@example.test'},'Fixture','not-a-real-password')`;
      await tx`insert into allrice_organizations(id,slug,name)
        values(${organizationId},${organizationId},'Fixture')`;
      await tx`insert into allrice_workspaces(id,organization_id,slug,name)
        values(${workspaceId},${organizationId},'fixture','Fixture')`;
      await tx`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
        values(${organizationId},${workspaceId},${personId},'member')`;
      const employees: string[] = [];
      for (const { employeeInstanceId, employeeVersionId } of [
        f.origin,
        ...siblings,
      ]) {
        const [employee] = await tx<
          { id: string }[]
        >`insert into allrice_employees
        (organization_id,workspace_id,employee_key,name)
        values(${organizationId},${workspaceId},${employeeInstanceId},'Fixture') returning id`;
        await tx`insert into allrice_employee_versions
        (id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum)
        values(${employeeVersionId},${organizationId},${workspaceId},${employee!.id},
          1,'Fixture','fixture-model','', '{}'::jsonb,${'sha256:' + 'a'.repeat(64)})`;
        await tx`insert into allrice_employee_assignments
        (id,organization_id,workspace_id,employee_id,employee_version_id,user_id,is_default)
        values(${employeeInstanceId},${organizationId},${workspaceId},${employee!.id},${employeeVersionId},${personId},
          ${employeeInstanceId === f.origin.employeeInstanceId})`;
        await tx`insert into allrice_employee_instances
        (id,organization_id,workspace_id,owner_id,assignment_id,kind,creation_version_id)
        values(${employeeInstanceId},${organizationId},${workspaceId},${personId},
          ${employeeInstanceId},'general',${employeeVersionId})`;
        employees.push(employee!.id);
      }
      await tx`insert into allrice_settings(scope_type,key,value)
        values('system','d_entry_rollout_policy',${tx.json({
          revision: randomUUID(),
          defaultGeneration: '3.x',
          selections: [{ personId, organizationId }],
        })})
        on conflict(scope_type,scope_id,key) do update set value=excluded.value`;
      return employees[0]!;
    });
  }

  async function retainedFixture(maxResidentVms?: number) {
    const f = await fixture();
    const selected = f.addProfile([]);
    const unrelated = f.addProfile([]);
    await publishFixtureAuthority(f, [selected, unrelated]);
    const planId = randomUUID();
    f.reviseTime('2035-11-03T07:00:00.000Z');
    expect(
      await f.module().prepareStopWithWake(f.binding, planId, signal),
    ).toMatchObject({ ok: true });
    await f.stop(planId);
    const store = f.store();
    const vmStore = new PostgresPersonVmStore(
      () => createDedicatedDatabase(db),
      undefined,
      maxResidentVms,
    );
    const h = harness(vmStore);
    await h.disk.create({ vmId: f.binding.vmId, tier: 'warm' }, signal);
    h.states.set(f.binding.vmId, 'stopped');
    const gatewayPorts = [38990];
    h.setPorts(gatewayPorts);
    await db`update person_virtual_machines set gateway_ports=${db.json(gatewayPorts)},stopped_at=now()
      where vm_id=${f.binding.vmId}`;
    const roster = (await db.begin((tx) =>
      readPersonVmWakeRoster(tx, f.binding, [f.origin, selected, unrelated]),
    ))!;
    const slots = roster.entries.map((_, index) => ({
      hostPort: 32000 + index,
      guestPort: 32000 + index,
    }));
    h.native.prepareWebEndpoints = async (binding, expected) => ({
      binding,
      rosterDigest: expected.digest,
      slots,
      endpoints: expected.entries.map((entry, index) => ({
        ...entry,
        ...slots[index]!,
      })),
    });
    h.native.assertWebEndpoints = async () => {};
    h.runtime.retireAfterNativeStop = async () => {};
    h.runtime.assertScheduledReady = async () => {};
    const vm = () =>
      new PersonVmService({
        ...h.options,
        now: () => new Date(),
        nativeWeb: { prepare: async () => roster },
        retainedWake: createProductionRetainedWake(store),
      });
    const user = () =>
      vm().prewarm(
        context(f.binding.organizationId, f.binding.personId),
        { trigger: 'page', selectedEmployee: selected },
        signal,
      );
    const makeDue = async () => {
      await db`update person_vm_scheduled_wakes
        set wake_at=clock_timestamp()-interval '1 second',retry_at=null where plan_id=${planId}`;
    };
    const runDue = () =>
      createPersonVmScheduledWake({
        store,
        ledger: createPostgresNativeScheduleObservationLedger(db),
        capture: vi.fn(),
        start: createProductionScheduledWakeSource(vm(), 4, db).start,
      }).runDueOnce(signal);
    const planStatus = async () =>
      (
        await db`select state,reason from person_vm_scheduled_wakes
      where plan_id=${planId}`
      )[0];
    return { f, h, vmStore, planId, store, user, makeDue, runDue, planStatus };
  }

  it.each(['egress preflight', 'native preflight', 'native started'] as const)(
    'keeps foreground startup failure grounded in its stopped native evidence: %s',
    async (scenario) => {
      const x = await retainedFixture();
      const failure = new PersonVmError('EGRESS_UNAVAILABLE');
      const notDispatched = scenario !== 'native started';
      if (scenario === 'egress preflight')
        vi.spyOn(x.h.egress, 'prepare').mockRejectedValueOnce(failure);
      else if (scenario === 'native preflight') {
        Object.defineProperty(x.h.native, 'observesStartDispatch', {
          value: true,
        });
        vi.spyOn(x.h.native, 'start').mockRejectedValueOnce(failure);
      } else vi.spyOn(x.h.native, 'bootstrap').mockRejectedValueOnce(failure);
      const runtime = vi.spyOn(x.h.runtime, 'start');
      const nativeStop = vi.spyOn(x.h.native, 'stop');
      await expect(x.store.claim(300_000)).resolves.toBeNull();
      await expect(x.user()).rejects.toMatchObject({ code: failure.code });
      const row = await x.vmStore.read(x.f.binding.personId);
      expect(row).toMatchObject({
        phase: 'stopped',
        leaseEpoch: x.f.binding.leaseEpoch + 1,
        egressReceipt: null,
        instanceId: expect.any(String),
      });
      expect(row!.instanceId).not.toBe(x.f.binding.instanceId);
      const receipts = await db`select result,error_code from person_vm_audit
        where request_id=${x.planId} and lease_epoch=${row!.leaseEpoch}
          and action=${PERSON_VM_WAKE_RESUME_AUDIT} order by id`;
      expect(receipts).toEqual(
        (notDispatched ? ['started', 'succeeded'] : ['started']).map(
          (result) => ({ result, error_code: row!.instanceId }),
        ),
      );
      await x.makeDue();
      if (notDispatched) {
        expect(x.h.log).not.toContain('native:start');
        expect(nativeStop).toHaveBeenCalledExactlyOnceWith(
          {
            ...x.f.binding,
            instanceId: row!.instanceId,
            leaseEpoch: row!.leaseEpoch,
          },
          expect.any(AbortSignal),
          { requireStopped: true },
        );
        expect(x.h.log).toContain('native:assert-stopped');
        expect(x.h.log.indexOf('native:assert-stopped')).toBeLessThan(
          x.h.log.indexOf('disk:detach'),
        );
        expect(await x.planStatus()).toMatchObject({ state: 'waiting' });
        await expect(
          x.store.nextCommittedWakeAt(signal),
        ).resolves.toBeInstanceOf(Date);
        expect(await x.runDue()).toBe(true);
        expect(await x.runDue()).toBe(false);
        expect(await x.planStatus()).toEqual({ state: 'ready', reason: null });
        expect(runtime).toHaveBeenCalledOnce();
        expect(runtime.mock.lastCall?.[3]).toMatchObject({
          purpose: 'scheduled-wake',
          scheduledEmployeeIds: [x.f.origin.employeeInstanceId],
        });
        expect(await x.vmStore.read(x.f.binding.personId)).toMatchObject({
          phase: 'running',
          leaseEpoch: x.f.binding.leaseEpoch + 2,
        });
      } else {
        expect(await x.planStatus()).toEqual({
          state: 'unknown',
          reason: 'START_UNCONFIRMED',
        });
        expect(await x.runDue()).toBe(false);
        await expect(x.user()).rejects.toMatchObject({
          code: 'RUNTIME_NOT_READY',
        });
      }
      expect(x.h.log.filter((entry) => entry === 'native:start')).toHaveLength(
        1,
      );
    },
  );

  it('does not carry a known undispatched plan without exact native stop readback', async () => {
    const x = await retainedFixture();
    const startup = new PersonVmError('EGRESS_UNAVAILABLE');
    const stopReadback = new PersonVmError('ACTIVITY_UNKNOWN');
    vi.spyOn(x.h.egress, 'prepare').mockRejectedValueOnce(startup);
    vi.spyOn(x.h.native, 'assertStopped').mockRejectedValueOnce(stopReadback);
    await expect(x.user()).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
      cause: {
        errors: [
          startup,
          expect.objectContaining({
            code: 'CLEANUP_INCOMPLETE',
            cause: stopReadback,
          }),
        ],
      },
    });
    expect(x.h.log).toContain('native:stop');
    expect(x.h.log).not.toContain('disk:detach');
    expect(await x.vmStore.read(x.f.binding.personId)).toMatchObject({
      phase: 'failed',
    });
    expect(await x.planStatus()).toEqual({
      state: 'unknown',
      reason: 'START_UNCONFIRMED',
    });
    await x.makeDue();
    expect(await x.runDue()).toBe(false);
  });

  it('joins a foreground abort before native start without reviving the revoked schedule', async () => {
    const x = await retainedFixture();
    const prepareEgress = x.h.egress.prepare;
    vi.spyOn(x.h.egress, 'prepare').mockImplementationOnce(async (...args) => {
      const receipt = await prepareEgress(...args);
      await x.f.invalidate(x.planId);
      return receipt;
    });
    const runtime = vi.spyOn(x.h.runtime, 'start');
    await expect(x.user()).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    expect(x.h.log).not.toContain('native:start');
    expect(x.h.log).toContain('native:assert-stopped');
    expect(await x.planStatus()).toEqual({
      state: 'blocked',
      reason: 'STALE_PLAN',
    });
    await expect(x.user()).resolves.toMatchObject({
      phase: 'running',
      ready: true,
    });
    expect(runtime).toHaveBeenCalledOnce();
    expect(runtime.mock.lastCall?.[3]?.scheduledEmployeeIds).toBeUndefined();
    expect(await x.runDue()).toBe(false);
  });

  it('restores the background retry deadline when a foreground capacity check refuses the new epoch', async () => {
    const x = await retainedFixture(1);
    await fixture(); // A separate VM still owns the one physical slot.
    await x.makeDue();
    const claim = await x.store.claim(300_000);
    expect(claim?.planId).toBe(x.planId);
    await expect(
      x.store.settle(claim!, {
        state: 'waiting',
        reason: 'START_UNAVAILABLE',
        retryDelayMs: 60_000,
      }),
    ).resolves.toBe(true);
    const [prior] =
      await db`select retry_at,attempts from person_vm_scheduled_wakes
      where plan_id=${x.planId}`;
    expect(prior!.retry_at).toBeInstanceOf(Date);
    expect(prior!.attempts).toBe(1);
    await expect(x.user()).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
    expect(await x.vmStore.read(x.f.binding.personId)).toMatchObject({
      phase: 'stopped',
      leaseEpoch: x.f.binding.leaseEpoch,
      instanceId: x.f.binding.instanceId,
    });
    expect(await x.planStatus()).toMatchObject({ state: 'waiting' });
    await expect(x.store.nextCommittedWakeAt(signal)).resolves.toEqual(
      prior!.retry_at,
    );
    expect(
      (
        await db`select retry_at,attempts from person_vm_scheduled_wakes
        where plan_id=${x.planId}`
      )[0],
    ).toEqual(prior);
    expect(await x.runDue()).toBe(false);
  });

  it.each(['unused claim release', 'unknown settlement'] as const)(
    'preserves the original startup error alongside a failed %s',
    async (stage) => {
      const beforeReserve = stage === 'unused claim release';
      const x = await retainedFixture(beforeReserve ? 1 : undefined);
      const settlement = new Error('fixture cannot write the wake outcome');
      const startup = new PersonVmError('EGRESS_UNAVAILABLE');
      if (beforeReserve) {
        await fixture();
        vi.spyOn(x.store, 'releaseUnusedClaim').mockRejectedValueOnce(
          settlement,
        );
      } else {
        vi.spyOn(x.h.egress, 'prepare').mockRejectedValueOnce(startup);
        vi.spyOn(x.h.native, 'assertStopped').mockRejectedValueOnce(
          new PersonVmError('ACTIVITY_UNKNOWN'),
        );
        vi.spyOn(x.store, 'settle').mockRejectedValueOnce(settlement);
      }
      await expect(x.user()).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
        cause: {
          errors: beforeReserve
            ? [
                expect.objectContaining({ code: 'RUNTIME_NOT_READY' }),
                settlement,
              ]
            : [
                startup,
                expect.objectContaining({ code: 'CLEANUP_INCOMPLETE' }),
                settlement,
              ],
        },
      });
    },
  );

  it('allows an exact current foreground employee after a no-start retry limit without reviving the old plan', async () => {
    const x = await retainedFixture();
    for (let attempt = 1; attempt <= 4; attempt++) {
      await x.makeDue();
      const claim = (await x.store.claim(300_000))!;
      expect(claim).toMatchObject({
        attempts: attempt,
        leaseEpoch: x.f.binding.leaseEpoch,
      });
      expect(
        await x.store.settle(
          claim,
          attempt === 4
            ? { state: 'blocked', reason: 'RETRY_LIMIT' }
            : {
                state: 'waiting',
                reason: 'START_UNAVAILABLE',
                retryDelayMs: 1,
              },
        ),
      ).toBe(true);
    }
    await db`update allrice_memberships set active=false where user_id=${x.f.binding.personId}`;
    await db`update allrice_memberships set active=true where user_id=${x.f.binding.personId}`;
    const runtime = vi.spyOn(x.h.runtime, 'start');
    await expect(x.user()).resolves.toMatchObject({
      phase: 'running',
      ready: true,
    });
    expect(runtime).toHaveBeenCalledOnce();
    expect(
      runtime.mock.lastCall?.[3]?.selectedEmployee?.employeeInstanceId,
    ).not.toBe(x.f.origin.employeeInstanceId);
    expect(runtime.mock.lastCall?.[3]?.scheduledEmployeeIds).toBeUndefined();
    expect(await x.planStatus()).toEqual({
      state: 'blocked',
      reason: 'RETRY_LIMIT',
    });
    expect(await x.runDue()).toBe(false);
  });

  const scheduledCommand = {
    executable: 'node',
    args: ['scheduled-sentinel'],
  };
  async function useManagedExecFixture(
    x: Awaited<ReturnType<typeof retainedFixture>>,
    exec: (active: AbortSignal, stagingRoot: string) => Promise<string>,
    options: {
      wait?: (active: AbortSignal) => Promise<void>;
      afterLaunch?: () => Promise<unknown>;
    } = {},
  ) {
    const stagingRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'wake-exec-proof-')),
    );
    const cleanupCalls: string[] = [];
    x.h.native.bootstrap = async (scope) => {
      const launcher = await bootstrapMicrosandbox({
        scope,
        stagingRoot,
        name: 'retained-test',
        cleanupTimeoutMs: 1000,
        plan: {
          files: [
            { path: '/work/init.cjs', contents: '//fixture', mode: 0o600 },
            { path: '/work/launcher', contents: '#!/bin/sh', mode: 0o700 },
          ],
          initialize: { executable: 'node', args: ['/work/init.cjs'] },
          launcher: '/work/launcher',
          env: {},
        },
        async command(args, active) {
          if (args[0] === 'exec')
            return args.includes('scheduled-sentinel')
              ? exec(active, stagingRoot)
              : 'setup-job';
          if (
            args[1] === 'retained-test' &&
            args[2] === '--job' &&
            args[3] !== 'setup-job'
          ) {
            cleanupCalls.push(`${args[0]}:${args[3]}`);
            active.throwIfAborted();
            if (args[0] === 'wait') await options.wait?.(active);
          }
          if (args[0] === 'wait')
            return JSON.stringify({ code: 0, success: true, timed_out: false });
          return '';
        },
      });
      if (!options.afterLaunch) return launcher;
      return {
        ...launcher,
        async launch(...args: Parameters<typeof launcher.launch>) {
          const job = await launcher.launch(...args);
          await options.afterLaunch!();
          return job;
        },
      };
    };
    return {
      stagingRoot,
      cleanupCalls,
      close: () => rm(stagingRoot, { recursive: true, force: true }),
    };
  }

  const openFixtureOwner = (
    scope: PersonVmBootstrapScope,
    dispatch: NonNullable<Parameters<PersonVmBootstrapScope['launch']>[1]>,
    timeoutMs: number,
  ) =>
    openNativeWebOwner({
      scope,
      dispatchLaunch: dispatch,
      launch: {
        binding: scope.binding,
        auth: {
          dshHome: '/work/a',
          origin: 'http://127.0.0.1:32179/',
          nonce: randomUUID(),
          timeoutMs,
        },
        files: [],
        command: scheduledCommand,
      },
      lifetime: signal,
      vm: { assertCurrentBinding: vi.fn() },
      cleanupTimeoutMs: 1000,
    });

  async function disconnectWakeAuthority() {
    const killed = await db`with owner as (
      select distinct l.pid from pg_locks l join pg_stat_activity a using(pid)
      where l.relation='person_vm_scheduled_wakes'::regclass
        and l.mode='RowShareLock' and l.granted and a.datname=current_database()
        and a.application_name=current_setting('application_name')
        and l.pid<>pg_backend_pid())
      select pg_terminate_backend(pid, 1000) as stopped from owner
      where (select count(*) from owner)=1`;
    expect(killed).toEqual([{ stopped: true }]);
  }

  it.each([
    ['foreground', 'revocation first'],
    ['foreground', 'dispatch first'],
    ['scheduled', 'revocation first'],
    ['scheduled', 'dispatch first'],
  ] as const)(
    'serializes actual native scheduler exec on PG authority: %s / %s',
    async (route, order) => {
      const x = await retainedFixture();
      const issued = deferred<void>(),
        allowReceipt = deferred<void>();
      const dispatched = vi.fn(async () => {
        issued.resolve();
        await allowReceipt.promise;
        return 'scheduled-job';
      });
      const native = await useManagedExecFixture(x, dispatched);
      const archive = (locking: boolean) =>
        db.begin(async (tx) => {
          if (locking) await tx`set local lock_timeout='100ms'`;
          await tx`update allrice_employee_instances set archived_at=now()
        where id=${x.f.origin.employeeInstanceId}`;
        });
      x.h.runtime.start = async (_binding, _active, scope, web) => {
        expect(web?.scheduledEmployeeIds).toEqual([
          x.f.origin.employeeInstanceId,
        ]);
        const job = await scope.launch(
          scheduledCommand,
          async (active, work) => {
            if (order === 'revocation first') await x.f.invalidate(x.planId);
            return web!.dispatchScheduledLaunch!(active, work);
          },
        );
        expect(job.jobId).toBe('scheduled-job');
      };
      if (route === 'scheduled') await x.makeDue();
      const opening = route === 'foreground' ? x.user() : x.runDue();
      void opening.catch(() => {});
      try {
        if (order === 'revocation first') {
          if (route === 'foreground')
            await expect(opening).rejects.toBeDefined();
          else await expect(opening).resolves.toBe(true);
          expect(dispatched).not.toHaveBeenCalled();
          expect(await x.planStatus()).toEqual({
            state: 'blocked',
            reason: 'STALE_PLAN',
          });
          return;
        }
        await Promise.race([
          issued.promise,
          opening.then(() => {
            throw Error('Native dispatch never issued');
          }),
        ]);
        await expect(archive(true)).rejects.toMatchObject({ code: '55P03' });
        allowReceipt.resolve();
        await opening;
        await archive(false);
        expect(dispatched).toHaveBeenCalledOnce();
        expect(await x.planStatus()).toEqual({ state: 'ready', reason: null });
      } finally {
        allowReceipt.resolve();
        await opening.catch(() => {});
        await native.close();
      }
    },
  );

  it('joins a timed-out owned native CLI before releasing the plan lock and does not use partial stdout', async () => {
    const x = await retainedFixture();
    const issued = deferred<void>();
    const rescue = new AbortController();
    let launchSignal: AbortSignal | undefined;
    let joined = false;
    const exec = vi.fn(async (active: AbortSignal, root: string) => {
      launchSignal = active;
      issued.resolve();
      try {
        return await runCommand({
          executable: process.execPath,
          args: [
            '-e',
            "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.stdout.write('partial-job-id'); setInterval(() => {}, 1000)",
            join(root, 'child-pid'),
          ],
          env: {},
          signal: AbortSignal.any([
            active,
            rescue.signal,
            AbortSignal.timeout(4500),
          ]),
        });
      } finally {
        joined = true;
      }
    });
    const native = await useManagedExecFixture(x, exec);
    x.h.runtime.start = async (_binding, _active, scope, web) => {
      await openFixtureOwner(scope, web!.dispatchScheduledLaunch!, 1000);
    };
    await x.makeDue();
    const opening = x.runDue();
    void opening.catch(() => {});
    try {
      await Promise.race([
        issued.promise,
        opening.then(() => {
          throw Error('Native dispatch never issued');
        }),
      ]);
      await expect(
        db.begin(async (tx) => {
          await tx`set local lock_timeout='100ms'`;
          await tx`update allrice_employee_instances set archived_at=now()
            where id=${x.f.origin.employeeInstanceId}`;
        }),
      ).rejects.toMatchObject({ code: '55P03' });
      await expect(opening).resolves.toBe(true);
      expect(launchSignal?.aborted).toBe(true);
      expect(launchSignal?.reason).toMatchObject({ code: 'PROVIDER_FAILED' });
      expect(joined).toBe(true);
      const pid = Number(
        await readFile(join(native.stagingRoot, 'child-pid'), 'utf8'),
      );
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
      expect(native.cleanupCalls).toEqual([]);
      expect(exec).toHaveBeenCalledOnce();
      expect(await x.planStatus()).toEqual({
        state: 'unknown',
        reason: 'START_UNCONFIRMED',
      });
      await expect(
        db`update allrice_employee_instances set archived_at=now()
          where id=${x.f.origin.employeeInstanceId} returning id`,
      ).resolves.toEqual([{ id: x.f.origin.employeeInstanceId }]);
      expect(await x.runDue()).toBe(false);
    } finally {
      rescue.abort();
      await opening.catch(() => {});
      await native.close();
    }
  });

  it.each(['PG connection loss', 'closing authority check'] as const)(
    'joins only the detached job already acknowledged before %s',
    async (failure) => {
      const x = await retainedFixture();
      const waiting = deferred<void>(),
        allowWait = deferred<void>();
      const exec = vi.fn((active: AbortSignal) =>
        runCommand({
          executable: process.execPath,
          args: ['-e', "process.stdout.write('acknowledged-scheduled-job')"],
          env: {},
          signal: active,
        }),
      );
      const native = await useManagedExecFixture(x, exec, {
        async wait() {
          waiting.resolve();
          await allowWait.promise;
        },
        ...(failure === 'closing authority check' && {
          afterLaunch: () => x.f.invalidate(x.planId),
        }),
      });
      x.h.runtime.start = async (_binding, _active, scope, web) => {
        await openFixtureOwner(
          scope,
          (active, issue) =>
            web!.dispatchScheduledLaunch!(active, async (locked) => {
              const id = await issue(locked);
              if (failure === 'PG connection loss')
                await disconnectWakeAuthority();
              return id;
            }),
          5000,
        );
      };
      await x.makeDue();
      const opening = x.runDue();
      void opening.catch(() => {});
      try {
        await Promise.race([
          waiting.promise,
          opening.then(() => {
            throw Error('Acknowledged native job was lost');
          }),
        ]);
        expect(native.cleanupCalls).toEqual([
          'kill:acknowledged-scheduled-job',
          'wait:acknowledged-scheduled-job',
        ]);
        expect(await x.planStatus()).toMatchObject({ state: 'claimed' });
        allowWait.resolve();
        await expect(opening).resolves.toBe(true);
        expect(exec).toHaveBeenCalledOnce();
        expect(await x.planStatus()).toEqual(
          failure === 'PG connection loss'
            ? { state: 'unknown', reason: 'START_UNCONFIRMED' }
            : { state: 'blocked', reason: 'STALE_PLAN' },
        );
        expect(await x.runDue()).toBe(false);
      } finally {
        allowWait.resolve();
        await opening.catch(() => {});
        await native.close();
      }
    },
  );

  it('invalidates an existing idle sample after another employee is created via the current write path', async () => {
    const f = await fixture();
    await publishFixtureAuthority(f);
    await db`update person_virtual_machines set verified_web_slot_capacity=20 where vm_id=${f.binding.vmId}`;
    const user = {
      ...context(f.binding.organizationId, f.binding.personId),
      workspaceId: f.origin.workspaceId,
    };
    await db`insert into allrice_sessions(id,user_id,token_hash,expires_at)
      values(${user.sessionId},${f.binding.personId},${randomUUID().replaceAll('-', '').repeat(2)},now()+interval '1 hour')`;
    const catalog = {
      endpoint: f.origin,
      revoked: signal,
      owner: {
        nativeActivityRevision: () => 1,
        readScheduleCatalog: async () => [],
        readNativeActivity: async () => ({ complete: true, work: [] }),
      },
    };
    const startup = {
      assertAuthenticatedGroup: vi.fn(() => signal),
      activityCatalogs: vi.fn().mockReturnValue([catalog]),
    };
    const activity = createProductionNativeActivity(startup, signal, {
      sampleIntervalMs: 60_000,
      scheduleGuardMs: 120_000,
      assertCompleteCensus: (binding, current) =>
        assertCompleteNativeActivityCensus(startup, binding, current, db),
    });
    const old = await activity.observe(f.binding, signal);
    expect(old.coverage.state).toBe('sampled');
    const client = vi.spyOn(databaseClient, 'getDatabase').mockReturnValue(db);
    try {
      await expect(
        createEmployeeInstance(user, {
          workspaceId: user.workspaceId,
          expectedOwnerId: f.binding.personId,
          requestId: randomUUID(),
          profile: { name: 'B' },
        }),
      ).resolves.toMatchObject({ ownerId: f.binding.personId });
    } finally {
      client.mockRestore();
    }
    expect((await activity.observe(f.binding, signal)).coverage.state).toBe(
      'unknown',
    );
    expect(() =>
      activity.assertSampleCurrent(f.binding, old.coverage.cursor!, signal),
    ).toThrow('ACTIVITY_UNKNOWN');
  });

  it('wakes active scoped native occurrences once and retains the full census for authority', async () => {
    const f = await fixture();
    const [first] = await f.catalog();
    const later = f.addProfile([
      { ...first!, scheduledAt: '2035-11-03T07:00:00.000Z' },
    ]);
    const inactive = f.addProfile([{ ...first!, status: 'inactive' }]);
    const empty = f.addProfile([]);
    const owners = [f.origin, later, inactive, empty];
    await publishFixtureAuthority(f, [later, inactive, empty]);
    const planId = randomUUID();
    expect(
      await f.module().prepareStopWithWake(f.binding, planId, signal),
    ).toEqual({
      ok: true,
      nextWakeAt: wakeAt,
    });
    await f.stop(planId);
    const beforeDue = await f.store().readRetainedWake(f.binding, signal);
    expect(
      beforeDue?.roster.entries.map(
        ({ employeeInstanceId }) => employeeInstanceId,
      ),
    ).toEqual(
      owners.map(({ employeeInstanceId }) => employeeInstanceId).sort(),
    );
    expect(beforeDue?.employeeInstanceIds).toEqual(
      [f.origin.employeeInstanceId, later.employeeInstanceId].sort(),
    );
    await db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${'person-vm:' + f.binding.personId},0))`;
      await expect(f.store().claim(300_000)).resolves.toBeNull();
    });
    const claim = await f.store().claim(300_000);
    expect(claim?.planId).toBe(planId);
    await expect(
      f.store().readRetainedWake(f.binding, signal),
    ).rejects.toMatchObject({
      code: 'LEASE_CONFLICT',
    });
    expect(await f.store().readClaimStartup(claim!)).toEqual(beforeDue);
    expect(
      await f.store().readClaimStartup({ ...claim!, targetAt: new Date(0) }),
    ).toBeNull();
    expect(
      await f.store().readRetainedWake({ ...f.binding, leaseEpoch: 2 }, signal),
    ).toBeNull();

    const dispatch = vi.fn(async () => {});
    const startup = vi.fn<
      Parameters<
        typeof createProductionScheduledWakeSource
      >[0]['startRetainedForSchedule']
    >(async (binding, requestId, authority) => {
      expect(binding).toEqual(claim);
      expect(requestId).toBe(claim?.claimId);
      const current = await authority.readStartup(signal);
      expect(current).toEqual(beforeDue);
      await authority.withCurrentAuthority(current.digest, signal, dispatch);
      return {
        ...f.binding,
        phase: 'running',
        ready: false,
        diskRetained: true,
        lastActivityAt: target,
      };
    });
    const source = createProductionScheduledWakeSource(
      { startRetainedForSchedule: startup },
      4,
      db,
    );
    await expect(
      source.start(claim!, () => f.store().isCurrent(claim!), signal),
    ).resolves.toBe('ready');
    expect(dispatch).toHaveBeenCalledOnce();

    await db`update allrice_employee_instances set revision=2
      where id=${later.employeeInstanceId}`;
    await expect(
      f.store().readRetainedWake(f.binding, signal),
    ).resolves.toBeNull();
    await expect(
      f
        .store()
        .claimRetainedWake(f.binding, beforeDue!.digest, randomUUID(), signal),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    await expect(
      source.start(claim!, () => f.store().isCurrent(claim!), signal),
    ).resolves.toBe('denied');
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each(['missing owner', 'running limit', 'physical width'] as const)(
    'does not prepare a stop without complete and deliverable native coverage: %s',
    async (reason) => {
      const f = await fixture();
      const [task] = await f.catalog();
      const count = reason === 'running limit' ? 5 : 2;
      const siblings = Array.from({ length: count - 1 }, () =>
        f.addProfile([task!]),
      );
      const entries = [f.origin, ...siblings];
      await publishFixtureAuthority(f, siblings);
      await db`update person_virtual_machines
        set verified_web_slot_capacity=${reason === 'physical width' ? 1 : count}
        where vm_id=${f.binding.vmId}`;
      const roster = await db.begin((tx) =>
        readPersonVmWakeRoster(tx, f.binding, entries),
      );
      expect(roster).not.toBeNull();
      const wake = createProductionScheduledWake({
        startup: {
          activityCatalogs: vi.fn().mockReturnValue(
            (reason === 'missing owner' ? entries.slice(0, 1) : entries).map(
              (entry) => ({
                endpoint: entry,
                receipt: { binding: f.binding },
                revoked: signal,
                bindingRef: entry.bindingRef,
                owner: {
                  readScheduleCatalog: async () => [
                    {
                      ...task!,
                      scheduledAt: '2035-11-03T07:00:00.000Z',
                    },
                  ],
                },
              }),
            ),
          ),
        },
        database: db,
        source: createProductionScheduledWakeSource(
          { startRetainedForSchedule: vi.fn() },
          4,
          db,
        ),
        lifetime: signal,
      });
      try {
        const planId = randomUUID();
        expect(
          await wake.prepareStopWithWake(
            {
              binding: f.binding,
              requestId: planId,
              scheduledRoster: roster!,
              assertStopCurrent: async () => {},
            },
            signal,
          ),
        ).toEqual({
          blocked: true,
          reason:
            reason === 'missing owner'
              ? 'SCHEDULE_OBSERVATION_UNAVAILABLE'
              : 'SCHEDULE_WAKE_UNAVAILABLE',
        });
        expect(
          await db`select state from person_vm_scheduled_wakes where plan_id=${planId}`,
        ).toEqual([]);
        expect(
          await db`select phase from person_virtual_machines where vm_id=${f.binding.vmId}`,
        ).toEqual([{ phase: 'running' }]);
      } finally {
        await wake.close();
      }
    },
  );

  it('checks the scheduled-idle enrolled roster from current PG authority without a login', async () => {
    const f = await fixture();
    await publishFixtureAuthority(f);
    const planId = randomUUID();
    await f.module().prepareStopWithWake(f.binding, planId, signal);
    await f.stop(planId);
    const claim = await f.store().claim(300_000);
    expect(claim?.planId).toBe(planId);
    const roster = await f.store().readClaimRoster(claim!);
    expect(roster).not.toBeNull();
    expect(
      await db`select 1 from allrice_sessions where user_id=${f.binding.personId}`,
    ).toEqual([]);
    const activityCatalogs = vi.fn();
    const host = createProductionScheduledWake({
      startup: { activityCatalogs },
      database: db,
      lifetime: signal,
      source: { start: f.start, assertDeliverable: vi.fn() },
    });
    try {
      const current = {
        ...f.binding,
        instanceId: randomUUID(),
        leaseEpoch: f.binding.leaseEpoch + 1,
      };
      await expect(
        host.assertScheduledIdleCurrent(current, roster!, signal),
      ).resolves.toBeUndefined();
      await expect(
        host.assertScheduledIdleCurrent(
          { ...current, personId: randomUUID() },
          roster!,
          signal,
        ),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      await db`update allrice_settings
        set value=jsonb_set(value,'{selections}','[]')
        where key='d_entry_rollout_policy'`;
      await expect(
        host.assertScheduledIdleCurrent(current, roster!, signal),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      expect(activityCatalogs).not.toHaveBeenCalled();
    } finally {
      await host.close();
      await f.store().settle(claim!, { state: 'ready' });
    }
  });

  it('uses a durable wake handoff for the exact upgrade stop while ordinary wake work is paused', async () => {
    const f = await fixture();
    await publishFixtureAuthority(f);
    const scheduledAt = new Date(Date.now() + 600_000).toISOString();
    f.reviseTime(scheduledAt);
    const roster = await db.begin((tx) =>
      readPersonVmWakeRoster(tx, f.binding, [f.origin]),
    );
    expect(roster).not.toBeNull();
    const catalog = {
      endpoint: f.origin,
      receipt: {
        binding: f.binding,
        rosterDigest: 'original-receipt-of-a-slotted-owner',
        endpoints: [
          f.origin,
          { ...f.origin, employeeInstanceId: randomUUID() },
        ],
      },
      revoked: signal,
      bindingRef: f.origin.bindingRef,
      owner: { readScheduleCatalog: f.catalog },
    };
    const activityCatalogs = vi.fn().mockReturnValue([]);
    const host = createProductionScheduledWake({
      startup: { activityCatalogs },
      database: db,
      lifetime: signal,
      source: { start: f.start, assertDeliverable: vi.fn() },
    });
    const requestId = randomUUID();
    const request = {
      binding: f.binding,
      requestId,
      scheduledRoster: roster!,
      assertStopCurrent: f.assertCurrent,
    };
    try {
      await expect(host.prepareUpgradeStop(request, signal)).resolves.toEqual({
        blocked: true,
        reason: 'SCHEDULE_WAKE_UNAVAILABLE',
      });
      await host.pause(signal);
      await expect(host.prepareStopWithWake(request, signal)).resolves.toEqual({
        blocked: true,
        reason: 'SCHEDULE_WAKE_UNAVAILABLE',
      });
      await expect(
        host.prepareUpgradeStop(request, signal),
      ).resolves.toMatchObject({
        blocked: true,
      });
      activityCatalogs.mockReturnValue([catalog]);
      await expect(host.prepareUpgradeStop(request, signal)).resolves.toEqual({
        ok: true,
        nextWakeAt: new Date(Date.parse(scheduledAt) - 120_000).toISOString(),
        scheduleFingerprints: [expect.stringMatching(/^sha256:/)],
      });
      await expect(host.nextCommittedWakeAt(signal)).resolves.toBeNull();
      await db`update person_virtual_machines
        set lease_owner=${randomUUID()},lease_expires_at=now()+interval '1 minute'
        where person_id=${f.binding.personId}`;
      const stop = vi.fn(async () => {});
      await expect(
        host.dispatchUpgradeStop(
          f.binding,
          roster!,
          randomUUID(),
          signal,
          stop,
        ),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      const revoked = new Error('platform operator no longer current');
      await expect(
        host.dispatchUpgradeStop(
          f.binding,
          roster!,
          requestId,
          signal,
          stop,
          async () => {
            throw revoked;
          },
        ),
      ).rejects.toBe(revoked);
      expect(stop).not.toHaveBeenCalled();
      await host.dispatchUpgradeStop(
        f.binding,
        roster!,
        requestId,
        signal,
        stop,
      );
      expect(stop).toHaveBeenCalledTimes(1);
      // Before the physical stop is joined, a prepared plan alone is not a
      // commitment. Once joined, even failed lifecycle publication must not
      // let a release suspend its recovery and miss the wake.
      const stopMarker = (result: 'started' | 'succeeded') =>
        db`insert into person_vm_audit
          (person_id,organization_id,vm_id,request_id,action,result,lease_epoch)
          values (${f.binding.personId},${f.binding.organizationId},${f.binding.vmId},
            ${requestId},'stop.idle-dispatch',${result},${f.binding.leaseEpoch})`;
      await stopMarker('started');
      await expect(host.nextCommittedWakeAt(signal)).resolves.toBeNull();
      await stopMarker('succeeded');
      await db`update person_virtual_machines set phase='failed'
        where person_id=${f.binding.personId}`;
      await expect(host.nextCommittedWakeAt(signal)).resolves.toEqual(
        new Date(Date.parse(scheduledAt) - 120_000),
      );
      await f.stop(requestId);
      await expect(host.nextCommittedWakeAt(signal)).resolves.toEqual(
        new Date(Date.parse(scheduledAt) - 120_000),
      );
      await db`update person_virtual_machines set lease_owner=null,lease_expires_at=null
        where person_id=${f.binding.personId}`;
      await db`update person_vm_scheduled_wakes set wake_at=now()-interval '1 second'
        where plan_id=${requestId}`;
      const claim = await f.store().claim(300_000);
      expect(claim?.planId).toBe(requestId);
      await expect(f.store().readClaimRoster(claim!)).resolves.toEqual(roster);
    } finally {
      await host.close();
    }
  });

  it('cancels the dedicated wake scan while another connection still holds its table lock', async () => {
    let locked!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.begin(async (tx) => {
      await tx`lock table person_vm_scheduled_wakes in access exclusive mode`;
      locked();
      await held;
    });
    const caller = new AbortController();
    let read: Promise<unknown> | undefined;
    async function blocked() {
      const [row] = await db<{ count: number }[]>`select count(*)::int as count
        from pg_locks where relation='person_vm_scheduled_wakes'::regclass
          and mode='AccessShareLock' and not granted`;
      return row?.count;
    }
    try {
      await Promise.race([acquired, holder]);
      read = createPostgresPersonVmScheduledWakeStore(db).nextCommittedWakeAt(
        caller.signal,
      );
      void read.catch(() => {});
      await vi.waitFor(async () => expect(await blocked()).toBe(1), {
        interval: 20,
        timeout: 1_500,
      });
      const reason = new Error(
        'synthetic drain disconnected while read was active',
      );
      caller.abort(reason);
      const deadline = new AbortController();
      try {
        expect(
          await Promise.race([
            read.catch((error: unknown) => error),
            sleep(750, 'client did not close', { signal: deadline.signal }),
          ]),
        ).toBe(reason);
      } finally {
        deadline.abort();
      }
      await vi.waitFor(async () => expect(await blocked()).toBe(0), {
        interval: 20,
        timeout: 2_500,
      });
    } finally {
      caller.abort();
      release();
      await Promise.allSettled([holder, read]);
    }
  });

  it.each(['qualification', 'ownership'] as const)(
    'orders the scheduled-idle dispatch against a concurrent change in %s',
    async (fact) => {
      const f = await fixture();
      await publishFixtureAuthority(f);
      const stalePlan = randomUUID();
      await f.module().prepareStopWithWake(f.binding, stalePlan, signal);
      const roster = await db.begin((tx) =>
        readPersonVmWakeRoster(tx, f.binding, [f.origin]),
      );
      expect(roster).not.toBeNull();
      const { personId, employeeInstanceId } = f.origin;
      const refuse = async (
        tx: Parameters<typeof readPersonVmWakeRoster>[0],
      ) => {
        if (fact === 'qualification')
          await tx`update allrice_settings set value=jsonb_set(value,'{selections}','[]')
            where scope_type='system' and key='d_entry_rollout_policy'`;
        else
          await tx`update allrice_employee_instances set archived_at=now()
            where id=${employeeInstanceId}`;
      };
      await db`update person_virtual_machines
        set lease_owner=${randomUUID()},lease_expires_at=now()+interval '1 minute'
        where person_id=${personId}`;
      // A preparation from the past has a wake time earlier than the DB clock.
      // Give this synthetic candidate a future dispatch window.
      await db`update person_vm_scheduled_wakes
        set wake_at=now()+interval '10 minutes',target_at=now()+interval '12 minutes'
        where plan_id=${stalePlan}`;
      const stop = vi.fn(async () => {
        await expect(
          db.begin(async (tx) => {
            await tx`set local lock_timeout='100ms'`;
            await refuse(tx);
          }),
        ).rejects.toMatchObject({ code: '55P03' });
      });
      const store = f.store();
      await expect(
        store.withPreparedStopAuthority(
          { ...f.binding, leaseEpoch: f.binding.leaseEpoch + 1 },
          roster!,
          stalePlan,
          signal,
          stop,
        ),
      ).resolves.toBe(false);
      expect(stop).not.toHaveBeenCalled();
      await expect(
        store.withPreparedStopAuthority(
          f.binding,
          roster!,
          stalePlan,
          signal,
          stop,
        ),
      ).resolves.toBe(true);
      await db.begin(refuse);
      const newPlan = randomUUID();
      // The earlier authority commit cannot revoke a plan that did not exist
      // yet. The dispatch must fail even for a later, non-revoked plan.
      await f.module().prepareStopWithWake(f.binding, newPlan, signal);
      const [staged] = await db`update person_vm_scheduled_wakes
        set wake_at=now()+interval '10 minutes',target_at=now()+interval '12 minutes'
        where plan_id=${newPlan} returning revoked_at`;
      expect(staged?.revoked_at).toBeNull();
      await expect(
        store.withPreparedStopAuthority(
          f.binding,
          roster!,
          newPlan,
          signal,
          stop,
        ),
      ).resolves.toBe(false);
      expect(stop).toHaveBeenCalledTimes(1);
    },
  );

  it('declines a scheduled idle stop while a deployment writer holds the earlier lock', async () => {
    const f = await fixture();
    const tenantEmployeeId = await publishFixtureAuthority(f);
    const { organizationId, workspaceId, personId, employeeInstanceId } =
      f.origin;
    const [platform] = await db`insert into allrice_platform_employees
      (employee_key,name,description)
      values(${'wake-' + randomUUID()},'Fixture','Fixture') returning id`;
    const [revision] = await db`insert into allrice_platform_employee_revisions
      (employee_id,revision,definition,checksum)
      values(${platform!.id},1,'{}',${'sha256:' + 'a'.repeat(64)}) returning id`;
    const [deployment] =
      await db`insert into allrice_platform_employee_tenant_assignments
      (employee_id,revision_id,organization_id,workspace_id,tenant_employee_id)
      values(${platform!.id},${revision!.id},${organizationId},${workspaceId},${tenantEmployeeId})
      returning id`;
    const roster = await db.begin((tx) =>
      readPersonVmWakeRoster(tx, f.binding, [f.origin]),
    );
    expect(roster).not.toBeNull();
    const planId = randomUUID();
    expect(
      await f.module().prepareStopWithWake(f.binding, planId, signal),
    ).toMatchObject({
      ok: true,
    });
    await db`update person_virtual_machines
      set lease_owner=${randomUUID()},lease_expires_at=now()+interval '1 minute'
      where person_id=${personId}`;
    await db`update person_vm_scheduled_wakes
      set wake_at=now()+interval '10 minutes',target_at=now()+interval '12 minutes'
      where plan_id=${planId}`;
    const stop = vi.fn(async () => {});
    const dispatch = () =>
      f
        .store()
        .withPreparedStopAuthority(f.binding, roster!, planId, signal, stop);
    await db.begin(async (tx) => {
      await tx`select id from allrice_platform_employee_tenant_assignments
        where id=${deployment!.id} for update`;
      // The lock order here is the existing tenant withdrawal order.
      await expect(dispatch()).rejects.toMatchObject({ code: '55P03' });
      await tx`update allrice_platform_employee_tenant_assignments set active=false
        where id=${deployment!.id}`;
      await tx`update allrice_employee_assignments set active=false
        where id=${employeeInstanceId}`;
    });
    await expect(dispatch()).resolves.toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('durably invalidates a person’s old plan only when their 4.0 qualification is removed', async () => {
    const f = await fixture();
    await publishFixtureAuthority(f);
    const planId = randomUUID();
    await f.module().prepareStopWithWake(f.binding, planId, signal);
    await f.stop(planId);
    const claim = await f.store().claim(300_000);
    expect(claim?.planId).toBe(planId);

    const other = {
      personId: randomUUID(),
      organizationId: f.binding.organizationId,
    };
    await db`update allrice_settings
      set value=jsonb_set(value,'{revision}',to_jsonb(${randomUUID()}::text))
      where key='d_entry_rollout_policy'`;
    await db`update allrice_settings
      set value=jsonb_set(value,'{selections}',
        (value->'selections') || ${db.json(other)}::jsonb)
      where key='d_entry_rollout_policy'`;
    await db`update allrice_settings
      set value=jsonb_set(value,'{selections}',(value->'selections')-1)
      where key='d_entry_rollout_policy'`;
    await db`insert into allrice_memberships(organization_id,user_id,role)
      values(${f.binding.organizationId},${f.binding.personId},'member')`;
    for (const role of ['viewer', 'member'])
      await db`update allrice_memberships set role=${role}
        where organization_id=${f.binding.organizationId} and user_id=${f.binding.personId}
          and workspace_id=${f.origin.workspaceId}`;
    await expect(f.store().readClaimRoster(claim!)).resolves.not.toBeNull();
    const [original] = await db<{ value: Parameters<typeof db.json>[0] }[]>`
      select value from allrice_settings where key='d_entry_rollout_policy'`;
    await db`update allrice_settings
      set value=jsonb_set(value,'{selections}','[]'::jsonb)
      where key='d_entry_rollout_policy'`;
    const [revoked] =
      await db`select revoked_at,reason from person_vm_scheduled_wakes
      where plan_id=${planId}`;
    expect(revoked).toMatchObject({
      revoked_at: expect.any(Date),
      reason: 'STALE_PLAN',
    });
    await db`update allrice_settings set value=${db.json(original!.value)}
      where key='d_entry_rollout_policy'`;
    await expect(f.store().readClaimRoster(claim!)).resolves.toBeNull();
    await db`update person_vm_scheduled_wakes set claim_until=now()-interval '1 second'
      where plan_id=${planId}`;
    expect(await f.store().claim(300_000)).toBeNull();
    expect(await f.module().runDueOnce(signal)).toBe(true);
    expect(await f.module().runDueOnce(signal)).toBe(false);
    expect(f.start).not.toHaveBeenCalled();
    const [settled] =
      await db`select w.state,w.claim_id,w.claim_until,a.result,a.error_code
      from person_vm_scheduled_wakes w join person_vm_audit a using (person_id,vm_id)
      where w.plan_id=${planId} and a.request_id=${claim!.claimId}
        and a.action='scheduled-wake.settle'`;
    expect(settled).toEqual({
      state: 'blocked',
      claim_id: null,
      claim_until: null,
      result: 'denied',
      error_code: 'STALE_PLAN',
    });
  });

  it('orders a real employee archive against the admitted native dispatch', async () => {
    const f = await fixture();
    await publishFixtureAuthority(f);
    const planId = randomUUID();
    await f.module().prepareStopWithWake(f.binding, planId, signal);
    await f.stop(planId);
    const claim = await f.store().claim(300_000);
    expect(claim?.planId).toBe(planId);

    async function invalidate(lockTimeout: boolean) {
      await db.begin(async (tx) => {
        if (lockTimeout) await tx`set local lock_timeout='100ms'`;
        await tx`update allrice_employee_instances set archived_at=now()
            where id=${f.origin.employeeInstanceId}`;
      });
    }

    const dispatch = vi.fn(async (_roster: unknown, active: AbortSignal) => {
      await expect(invalidate(true)).rejects.toMatchObject({ code: '55P03' });
      return active;
    });
    await expect(
      f.store().withClaimAuthority(claim!, signal, dispatch),
    ).resolves.toMatchObject({ aborted: false });
    await invalidate(false);
    await expect(
      f.store().withClaimAuthority(claim!, signal, dispatch),
    ).resolves.toBeNull();
    expect(dispatch).toHaveBeenCalledOnce();
    await expect(f.store().settle(claim!, { state: 'ready' })).resolves.toBe(
      true,
    );
    const [settled] =
      await db`select state,reason from person_vm_scheduled_wakes
      where plan_id=${planId}`;
    expect(settled).toEqual({ state: 'blocked', reason: 'STALE_PLAN' });
  });

  it('aborts and joins native work when its dedicated PG authority connection closes', async () => {
    const f = await fixture();
    await publishFixtureAuthority(f);
    const planId = randomUUID();
    await f.module().prepareStopWithWake(f.binding, planId, signal);
    await f.stop(planId);
    const claim = await f.store().claim(300_000);
    expect(claim?.planId).toBe(planId);

    let finished = false;
    let joined = false;
    const work = f
      .store()
      .withClaimAuthority(claim!, signal, async (_, active) => {
        await disconnectWakeAuthority();
        await expect.poll(() => active.aborted).toBe(true);
        expect(finished).toBe(false);
        joined = true;
        active.throwIfAborted();
      });
    await expect(
      work.finally(() => {
        finished = true;
      }),
    ).rejects.toBeDefined();
    expect(joined).toBe(true);
  });

  it('rechecks current retained roster without a login and never revives a revoked plan', async () => {
    const f = await fixture();
    await publishFixtureAuthority(f);
    const planId = randomUUID();
    await expect(
      f.module().prepareStopWithWake(f.binding, planId, signal),
    ).resolves.toEqual({ ok: true, nextWakeAt: wakeAt });
    await f.stop(planId);
    const claim = await f.store().claim(300_000);
    expect(claim?.planId).toBe(planId);
    const logins =
      await db`select id from allrice_sessions where user_id=${f.binding.personId}`;
    expect(logins).toEqual([]);
    await expect(f.store().readClaimRoster(claim!)).resolves.toMatchObject({
      personId: f.binding.personId,
      organizationId: f.binding.organizationId,
      entries: [
        {
          workspaceId: f.origin.workspaceId,
          employeeInstanceId: f.origin.employeeInstanceId,
          employeeRevision: 1,
          employeeVersionId: f.origin.employeeVersionId,
        },
      ],
    });
    await expect(
      f.store().readClaimRoster({ ...claim!, planId: randomUUID() }),
    ).resolves.toBeNull();
    await db`update allrice_employee_instances set archived_at=now()
      where id=${f.origin.employeeInstanceId}`;
    await db`update allrice_employee_instances set archived_at=null
      where id=${f.origin.employeeInstanceId}`;
    await expect(f.store().readClaimRoster(claim!)).resolves.toBeNull();
    expect(await f.store().isCurrent(claim!)).toBe(false);
    await db`update person_vm_scheduled_wakes set claim_until=now()-interval '1 second'
      where plan_id=${planId}`;
    expect(await f.store().claim(300_000)).toBeNull();
    expect(await f.module().runDueOnce(signal)).toBe(true);
    const rows = await db`select action,error_code from person_vm_audit
      where request_id=${planId} and action='scheduled-wake.invalidate'`;
    expect(rows).toEqual([
      {
        action: 'scheduled-wake.invalidate',
        error_code: 'CURRENT_AUTHORITY_CHANGED',
      },
    ]);
  });

  it('uses the same audited stop, then claims once across host restarts or concurrent ticks', async () => {
    const f = await fixture();
    const planId = randomUUID();
    for (const host of [f.module(), f.module()]) {
      await expect(
        host.prepareStopWithWake(f.binding, planId, signal),
      ).resolves.toEqual({ ok: true, nextWakeAt: wakeAt });
    }
    expect(await f.module().runDueOnce(signal)).toBe(false);
    await f.stop(randomUUID());
    expect(await f.module().runDueOnce(signal)).toBe(false);
    await f.stop(planId);
    const results = await Promise.all([
      f.module().runDueOnce(signal),
      f.module().runDueOnce(signal),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({
      planId,
      targetAt: new Date(target),
    });
    expect(await f.module().runDueOnce(signal)).toBe(false);
    const audit = await db`select action,result from person_vm_audit
      where person_id=${f.binding.personId} and action like 'scheduled-wake.%' order by id`;
    expect(audit.map(({ action, result }) => [action, result])).toEqual([
      ['scheduled-wake.prepare', 'succeeded'],
      ['scheduled-wake.claim', 'started'],
      ['scheduled-wake.settle', 'succeeded'],
    ]);
  });

  it('replays an exact stop preparation using a noncanonical UUID spelling', async () => {
    const f = await fixture();
    const planId = ('a' + randomUUID().slice(1)).toUpperCase();
    for (const host of [f.module(), f.module()]) {
      await expect(
        host.prepareStopWithWake(f.binding, planId, signal),
      ).resolves.toEqual({ ok: true, nextWakeAt: wakeAt });
    }
    const prepares = await db`select request_id from person_vm_audit
      where person_id=${f.binding.personId} and action='scheduled-wake.prepare'`;
    expect(prepares).toEqual([{ request_id: planId.toLowerCase() }]);
  });

  it('uses the snapshot for the actual stop after rules change or are deleted', async () => {
    const f = await fixture();
    const host = f.module();
    await expect(
      host.prepareStopWithWake(f.binding, randomUUID(), signal),
    ).resolves.toEqual({ ok: true, nextWakeAt: wakeAt });
    f.reviseTime('2024-11-03T07:00:00.000Z');
    await expect(
      host.prepareStopWithWake(f.binding, randomUUID(), signal),
    ).resolves.toEqual({ ok: true, nextWakeAt: '2024-11-03T06:58:00.000Z' });
    f.setRows([]);
    const planId = randomUUID();
    await expect(
      host.prepareStopWithWake(f.binding, planId, signal),
    ).resolves.toEqual({ ok: true, nextWakeAt: null });
    await f.stop(planId);
    expect(await host.runDueOnce(signal)).toBe(false);
    expect(f.start).not.toHaveBeenCalled();
    const receipts =
      await db`select receipt_id from allrice_native_schedule_observation_receipts
      where person_id=${f.binding.personId}`;
    expect(receipts).toHaveLength(3);
  });

  it('keeps an earlier exact stop intent after other preparations stage or fail', async () => {
    const f = await fixture();
    const host = f.module();
    const stopId = randomUUID();
    await expect(
      host.prepareStopWithWake(f.binding, stopId, signal),
    ).resolves.toEqual({ ok: true, nextWakeAt: wakeAt });
    f.reviseTime('2024-11-03T07:00:00.000Z');
    await expect(
      host.prepareStopWithWake(f.binding, randomUUID(), signal),
    ).resolves.toEqual({ ok: true, nextWakeAt: '2024-11-03T06:58:00.000Z' });
    f.assertCurrent
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('lost roster after staging'));
    await expect(
      host.prepareStopWithWake(f.binding, randomUUID(), signal),
    ).resolves.toEqual({ blocked: true, reason: 'WAKE_PLAN_UNCONFIRMED' });
    await f.stop(stopId);
    expect(await host.runDueOnce(signal)).toBe(true);
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({
      planId: stopId,
      targetAt: new Date(target),
    });
    expect(await host.runDueOnce(signal)).toBe(false);
  });

  it('blocks stop if delivery permission is revoked while the plan commits', async () => {
    const f = await fixture();
    const assertDeliverable = vi
      .fn<NonNullable<CaptureChecks['assertDeliverable']>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('wake permission revoked'));
    const planId = randomUUID();
    const host = f.module(f.store(), { assertDeliverable });
    await expect(
      host.prepareStopWithWake(f.binding, planId, signal),
    ).resolves.toEqual({ blocked: true, reason: 'SCHEDULE_WAKE_UNAVAILABLE' });
    expect(assertDeliverable).toHaveBeenCalledTimes(2);
    await f.stop(randomUUID());
    expect(await host.runDueOnce(signal)).toBe(false);
    expect(f.start).not.toHaveBeenCalled();
  });

  it('uses the native committed UTC target across repeated New York wall time', async () => {
    const f = await fixture();
    const native = createDailyScheduleRecord(
      ScheduleId('daily'),
      'synthetic',
      { time: '01:30:00', time_zone: 'America/New_York' },
      Date.parse('2026-11-01T04:00:00.000Z'),
      'synthetic',
    );
    expect(native.scheduledAt).toBe('2026-11-01T05:30:00.000Z');
    f.setRows([
      { ...native, status: 'active', sessionId: SessionId('session') },
    ]);
    await expect(
      f.module().prepareStopWithWake(f.binding, randomUUID(), signal),
    ).resolves.toEqual({ ok: true, nextWakeAt: '2026-11-01T05:28:00.000Z' });
  });

  it.each(['native snapshot', 'original login'] as const)(
    'rejects a prepared ordinary idle stop after revoking the %s',
    async (revoked) => {
      const f = await fixture();
      await publishFixtureAuthority(f);
      f.reviseTime(new Date(Date.now() + 600_000).toISOString());
      const planId = randomUUID();
      await expect(
        f.module().prepareStopWithWake(f.binding, planId, signal),
      ).resolves.toMatchObject({ ok: true });
      const roster = await db.begin((tx) =>
        readPersonVmWakeRoster(tx, f.binding, [f.origin]),
      );
      expect(roster).not.toBeNull();
      await db`update person_virtual_machines
      set lease_owner=${randomUUID()},lease_expires_at=now()+interval '1 minute'
      where person_id=${f.binding.personId}`;
      const context = {
        actor: { type: 'user' as const, id: f.binding.personId },
        sessionId: randomUUID(),
        organizationId: f.binding.organizationId,
        workspaceId: f.origin.workspaceId,
      };
      await db`insert into allrice_sessions (id, user_id, token_hash, expires_at)
      values (${context.sessionId},${context.actor.id},${randomUUID().replaceAll('-', '').repeat(2)},now()+interval '1 hour')`;
      const host = createProductionScheduledWake({
        startup: { activityCatalogs: vi.fn() },
        database: db,
        lifetime: signal,
        source: { start: f.start, assertDeliverable: vi.fn() },
      });
      try {
        const stop = vi.fn(async () => {});
        const dispatch = () =>
          host.dispatchScheduledIdleStop(
            f.binding,
            roster!,
            planId,
            signal,
            stop,
            async (tx) => {
              if (!(await readContentPrincipal(context, tx, true)))
                throw new PersonVmError('AUTHORIZATION_DENIED');
            },
          );
        await dispatch();
        expect(stop).toHaveBeenCalledTimes(1);
        if (revoked === 'native snapshot') await f.invalidate(planId);
        else
          await db`update allrice_sessions set revoked_at=clock_timestamp()
        where id=${context.sessionId}`;
        await expect(dispatch()).rejects.toMatchObject({
          code: 'AUTHORIZATION_DENIED',
        });
        expect(stop).toHaveBeenCalledTimes(1);
        const [vm] = await db`select phase from person_virtual_machines
        where person_id=${f.binding.personId}`;
        expect(vm?.phase).toBe('running');
      } finally {
        await host.close();
      }
    },
  );

  it('refuses to dispatch an explicitly invalidated snapshot', async () => {
    const f = await fixture();
    const host = f.module();
    const planId = randomUUID();
    await expect(
      host.prepareStopWithWake(f.binding, planId, signal),
    ).resolves.toEqual({ ok: true, nextWakeAt: wakeAt });
    await f.invalidate(planId);
    await expect(
      host.prepareStopWithWake(f.binding, planId, signal),
    ).resolves.toEqual({ blocked: true, reason: 'WAKE_PLAN_UNCONFIRMED' });
    await f.stop(planId);
    expect(await host.runDueOnce(signal)).toBe(false);
    expect(f.start).not.toHaveBeenCalled();
    const [row] = await db`select state,reason from person_vm_scheduled_wakes
      where plan_id=${planId}`;
    expect(row).toMatchObject({ state: 'blocked', reason: 'STALE_PLAN' });
    const [event] = await db`select error_code from person_vm_audit
      where request_id=${planId} and action='scheduled-wake.invalidate'`;
    expect(event).toEqual({ error_code: 'NATIVE_SCHEDULE_INVALIDATED' });
  });

  it('does not accept another person’s receipt even with a valid new stop ID', async () => {
    const other = await fixture();
    await other
      .module()
      .prepareStopWithWake(other.binding, randomUUID(), signal);
    const [row] = await db<{ receipt_id: string }[]>`select receipt_id
      from allrice_native_schedule_observation_receipts
      where person_id=${other.binding.personId}`;
    const f = await fixture();
    expect(
      await f.store().stage({
        ...f.binding,
        planId: randomUUID(),
        receiptIds: [row!.receipt_id],
        targetAt: new Date(target),
        wakeAt: new Date(wakeAt),
      }),
    ).toBe(false);
  });

  it('blocks unknown catalog and targets inside the lead window', async () => {
    const f = await fixture();
    const host = f.module();
    f.catalog.mockRejectedValueOnce(new Error('catalog unavailable'));
    await expect(
      host.prepareStopWithWake(f.binding, randomUUID(), signal),
    ).resolves.toEqual({
      blocked: true,
      reason: 'SCHEDULE_OBSERVATION_UNAVAILABLE',
    });
    f.reviseTime('2024-11-03T05:01:59.999Z');
    await expect(
      host.prepareStopWithWake(f.binding, randomUUID(), signal),
    ).resolves.toEqual({ blocked: true, reason: 'SCHEDULE_TOO_CLOSE' });
    const staged = await db`select plan_id from person_vm_scheduled_wakes
      where person_id=${f.binding.personId}`;
    expect(staged).toEqual([]);
  });

  it.each([
    ['starting', false, 'retained'],
    ['starting', true, 'retained'],
    ['running', false, 'retained'],
    ['running', true, 'retained'],
    ['stopped', false, 'retained'],
    ['stopped', true, 'retained'],
    ['stopped', false, 'released'],
  ] as const)(
    'audits an unconfirmed start after the VM advanced to %s (revoked: %s, owner: %s)',
    async (phase, revoked, lease) => {
      const f = await fixture(),
        planId = randomUUID();
      await expect(
        f.module().prepareStopWithWake(f.binding, planId, signal),
      ).resolves.toEqual({ ok: true, nextWakeAt: wakeAt });
      await f.stop(planId);
      const claim = await f.store().claim(300_000);
      expect(claim).not.toBeNull();
      const owner = lease === 'released' ? null : randomUUID();
      await db`update person_virtual_machines
      set lease_epoch=lease_epoch+1,instance_id=${randomUUID()},phase=${phase},
        egress_receipt=${phase === 'running' ? db.json({}) : null},
        lease_owner=${owner},
        lease_expires_at=case when ${owner}::uuid is null then null else now()-interval '1 second' end
      where person_id=${f.binding.personId}`;
      if (revoked) await f.invalidate(planId);
      expect(await f.store().nextCommittedWakeAt(signal)).toBeInstanceOf(Date);
      await db`update person_vm_scheduled_wakes set claim_until=now()-interval '1 second'
      where plan_id=${planId}`;
      await db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${'person-vm:' + f.binding.personId},0))`;
        expect(await f.store().recordExpiredUnrecoverableClaim()).toBe(false);
      });
      expect(await f.module().runDueOnce(signal)).toBe(true);
      expect(await f.module().runDueOnce(signal)).toBe(false);
      expect(await f.store().nextCommittedWakeAt(signal)).toBeNull();
      expect(
        await db`select lease_owner from person_virtual_machines
        where person_id=${f.binding.personId}`,
      ).toEqual([{ lease_owner: owner }]);
      expect(f.start).not.toHaveBeenCalled();
      expect(await f.store().settle(claim!, { state: 'ready' })).toBe(false);
      const [row] = await db`select w.state,a.error_code
      from person_vm_scheduled_wakes w join person_vm_audit a using (person_id,vm_id)
      where w.plan_id=${planId} and a.request_id=${claim!.claimId}
        and a.action='scheduled-wake.settle'`;
      expect(row).toMatchObject({
        state: 'unknown',
        error_code: 'START_UNCONFIRMED',
      });
    },
  );

  it('recovers an expired claim, retries a confirmed non-start, and fences late settlements', async () => {
    const f = await fixture(),
      planId = randomUUID();
    expect(
      await f.module().prepareStopWithWake(f.binding, planId, signal),
    ).toEqual({ ok: true, nextWakeAt: wakeAt });
    await f.stop(planId);
    // Leases are driven by database time, not elapsed wall time in a test.
    const old = await f.store().claim(300_000);
    expect(old).not.toBeNull();
    await db`update person_vm_scheduled_wakes set claim_until=now()-interval '1 second'
      where plan_id=${planId}`;
    f.start.mockResolvedValueOnce('not-started');
    expect(await f.module().runDueOnce(signal)).toBe(true);
    expect(await f.store().isCurrent(old!)).toBe(false);
    expect(await f.store().settle(old!, { state: 'ready' })).toBe(false);
    const [retry] = await db`select state,reason,retry_at>now() as future
      from person_vm_scheduled_wakes where plan_id=${planId}`;
    expect(retry).toMatchObject({
      state: 'waiting',
      reason: 'START_UNAVAILABLE',
      future: true,
    });
    expect(await f.module().runDueOnce(signal)).toBe(false);
    await db`update person_vm_scheduled_wakes set retry_at=now()-interval '1 second'
      where plan_id=${planId}`;
    expect(await f.module().runDueOnce(signal)).toBe(true);
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it('makes a claim cancelled before dispatch immediately available after restart', async () => {
    const f = await fixture();
    const planId = randomUUID();
    await expect(
      f.module().prepareStopWithWake(f.binding, planId, signal),
    ).resolves.toEqual({ ok: true, nextWakeAt: wakeAt });
    await f.stop(planId);
    const abort = new AbortController();
    const store = f.store();
    expect(
      await f
        .module({
          ...store,
          async claim(timeout) {
            const claimed = await store.claim(timeout);
            expect(claimed?.planId).toBe(planId);
            abort.abort();
            return claimed;
          },
        })
        .runDueOnce(abort.signal),
    ).toBe(true);
    expect(f.start).not.toHaveBeenCalled();
    expect(await f.module().runDueOnce(signal)).toBe(true);
    expect(f.start.mock.calls[0]?.[0].attempts).toBe(1);
  });

  it('preserves pre-dispatch read failure and makes the unused claim available', async () => {
    const f = await fixture();
    const planId = randomUUID();
    await expect(
      f.module().prepareStopWithWake(f.binding, planId, signal),
    ).resolves.toEqual({ ok: true, nextWakeAt: wakeAt });
    await f.stop(planId);
    const failed = new Error('eligibility read failed');
    await expect(
      f
        .module({
          ...f.store(),
          async isCurrent() {
            throw failed;
          },
        })
        .runDueOnce(signal),
    ).rejects.toBe(failed);
    expect(f.start).not.toHaveBeenCalled();
    expect(await f.module().runDueOnce(signal)).toBe(true);
    expect(f.start.mock.calls[0]?.[0].attempts).toBe(1);
  });

  it('retains an unconfirmed start for operators without retrying it', async () => {
    const f = await fixture(),
      planId = randomUUID();
    expect(
      await f.module().prepareStopWithWake(f.binding, planId, signal),
    ).toEqual({ ok: true, nextWakeAt: wakeAt });
    await f.stop(planId);
    f.start.mockRejectedValueOnce(new Error('ack disconnected'));
    expect(await f.module().runDueOnce(signal)).toBe(true);
    expect(await f.module().runDueOnce(signal)).toBe(false);
    const [row] = await db`select state,reason from person_vm_scheduled_wakes
      where plan_id=${planId}`;
    expect(row).toMatchObject({
      state: 'unknown',
      reason: 'START_UNCONFIRMED',
    });
  });
});
