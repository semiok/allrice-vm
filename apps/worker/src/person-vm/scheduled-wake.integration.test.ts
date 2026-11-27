import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createPostgresNativeScheduleObservationLedger,
  createPostgresPersonVmScheduledWakeStore,
  readPersonVmWakeRoster,
} from '@allrice/database';
import {
  createDailyScheduleRecord,
  ScheduleId,
  type ScheduleCatalogEntry,
} from '@deepseek-ai/dsh-schedule';
import { SessionId } from '@deepseek-ai/dsh-session';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createPersonVmScheduledWake } from './scheduled-wake.js';
import { createProductionScheduledWake } from './production-scheduled-wake.js';

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
  ) {
    const {
      personId,
      organizationId,
      workspaceId,
      employeeInstanceId,
      employeeVersionId,
    } = f.origin;
    return db.begin(async (tx) => {
      await tx`insert into allrice_users(id,email,display_name,password_hash)
        values(${personId},${personId + '@example.test'},'Fixture','not-a-real-password')`;
      await tx`insert into allrice_organizations(id,slug,name)
        values(${organizationId},${organizationId},'Fixture')`;
      await tx`insert into allrice_workspaces(id,organization_id,slug,name)
        values(${workspaceId},${organizationId},'fixture','Fixture')`;
      await tx`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
        values(${organizationId},${workspaceId},${personId},'member')`;
      const [employee] = await tx<
        { id: string }[]
      >`insert into allrice_employees
        (organization_id,workspace_id,employee_key,name)
        values(${organizationId},${workspaceId},'fixture','Fixture') returning id`;
      await tx`insert into allrice_employee_versions
        (id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum)
        values(${employeeVersionId},${organizationId},${workspaceId},${employee!.id},
          1,'Fixture','fixture-model','', '{}'::jsonb,${'sha256:' + 'a'.repeat(64)})`;
      await tx`insert into allrice_employee_assignments
        (id,organization_id,workspace_id,employee_id,employee_version_id,user_id)
        values(${employeeInstanceId},${organizationId},${workspaceId},${employee!.id},${employeeVersionId},${personId})`;
      await tx`insert into allrice_employee_instances
        (id,organization_id,workspace_id,owner_id,assignment_id,kind,creation_version_id)
        values(${employeeInstanceId},${organizationId},${workspaceId},${personId},
          ${employeeInstanceId},'general',${employeeVersionId})`;
      await tx`insert into allrice_settings(scope_type,key,value)
        values('system','d_entry_rollout_policy',${tx.json({
          revision: randomUUID(),
          defaultGeneration: '3.x',
          selections: [{ personId, organizationId }],
        })})
        on conflict(scope_type,scope_id,key) do update set value=excluded.value`;
      return employee!.id;
    });
  }

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
    const catalog = vi.fn();
    const host = createProductionScheduledWake({
      startup: { catalog },
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
      expect(catalog).not.toHaveBeenCalled();
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
    const catalog = vi.fn().mockReturnValue({
      endpoint: f.origin,
      receipt: { rosterDigest: roster!.digest, endpoints: [f.origin] },
      revoked: signal,
      bindingRef: f.origin.bindingRef,
      owner: { readScheduleCatalog: f.catalog },
    });
    const host = createProductionScheduledWake({
      startup: { catalog },
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
        const killed = await db`with owner as (
        select distinct l.pid from pg_locks l join pg_stat_activity a using(pid)
        where l.relation='person_vm_scheduled_wakes'::regclass
          and l.mode='RowShareLock' and l.granted and a.datname=current_database()
          and a.application_name=current_setting('application_name')
          and l.pid<>pg_backend_pid())
        select pg_terminate_backend(pid, 1000) as stopped from owner
        where (select count(*) from owner)=1`;
        expect(killed).toEqual([{ stopped: true }]);
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

  it.each([false, true])(
    'audits an unconfirmed start after the VM advanced (revoked: %s)',
    async (revoked) => {
      const f = await fixture(),
        planId = randomUUID();
      await expect(
        f.module().prepareStopWithWake(f.binding, planId, signal),
      ).resolves.toEqual({ ok: true, nextWakeAt: wakeAt });
      await f.stop(planId);
      const claim = await f.store().claim(300_000);
      expect(claim).not.toBeNull();
      await db`update person_virtual_machines
      set lease_epoch=lease_epoch+1,instance_id=${randomUUID()},phase='starting'
      where person_id=${f.binding.personId}`;
      if (revoked) await f.invalidate(planId);
      await db`update person_vm_scheduled_wakes set claim_until=now()-interval '1 second'
      where plan_id=${planId}`;
      expect(await f.module().runDueOnce(signal)).toBe(true);
      expect(await f.module().runDueOnce(signal)).toBe(false);
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
