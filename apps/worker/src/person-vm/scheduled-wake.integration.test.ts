import { randomUUID } from 'node:crypto';
import {
  createPostgresNativeScheduleObservationLedger,
  createPostgresPersonVmScheduledWakeStore,
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

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('scheduled wake host intent on real PostgreSQL', () => {
  const signal = new AbortController().signal;
  const wakeAt = '2024-11-03T05:58:00.000Z';
  const target = '2024-11-03T06:00:00.000Z';
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
    const module = (wakeStore = store()) =>
      createPersonVmScheduledWake({
        store: wakeStore,
        ledger: createPostgresNativeScheduleObservationLedger(db),
        now: () => new Date('2024-11-03T05:00:00.000Z'),
        capture: async (_binding, planId) => {
          if (!receiptIds.has(planId)) receiptIds.set(planId, randomUUID());
          return {
            profiles: [
              {
                origin,
                receiptId: receiptIds.get(planId)!,
                schedule: { catalog },
              },
            ],
            assertCurrent,
          };
        },
        start,
      });

    return {
      assertCurrent,
      binding,
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
          invalidateReceiptIds: [receiptIds.get(planId)!],
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
    expect(await host.runDueOnce(signal)).toBe(true);
    expect(await host.runDueOnce(signal)).toBe(false);
    expect(f.start).not.toHaveBeenCalled();
    const [row] = await db`select state,reason from person_vm_scheduled_wakes
      where plan_id=${planId}`;
    expect(row).toMatchObject({ state: 'blocked', reason: 'STALE_PLAN' });
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

  it('audits an expired claim whose VM advanced during boot without retrying on the new binding', async () => {
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
  });

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
