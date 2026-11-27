import { createHash, randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { selectDEntryGeneration } from '@allrice/contracts';
import type { PersonVmBinding, PersonVmWebRoster } from '@allrice/person-vm';
import type { ISql, Sql, TransactionSql } from 'postgres';
import { joinCallerSave } from '../business-runtime/caller-transaction.ts';
import { createDedicatedDatabase } from '../core/client.ts';
import { readDEntryReleasePolicy } from '../d-entry-release-policy.ts';
import type { NativeScheduleLedgerOrigin } from './native-schedule-observation-ledger.ts';

type Identity = PersonVmBinding & { planId: string };
type WakePlan = Identity & {
  receiptIds: readonly string[];
  targetAt: Date | null;
  wakeAt: Date | null;
};
type WakeState =
  'empty' | 'waiting' | 'claimed' | 'ready' | 'blocked' | 'unknown';
type PlanRow = {
  person_id: string;
  organization_id: string;
  vm_id: string;
  instance_id: string;
  lease_epoch: string;
  plan_id: string;
  receipt_ids: string[];
  target_at: Date | null;
  wake_at: Date | null;
  state: WakeState;
  attempts: number;
};
export type ScheduledWakeClaim = Identity & {
  claimId: string;
  receiptIds: readonly string[];
  targetAt: Date;
  attempts: number;
};
export type ScheduledWakeOutcome =
  | { state: 'ready' }
  | { state: 'waiting'; reason: 'START_UNAVAILABLE'; retryDelayMs: number }
  | {
      state: 'blocked';
      reason: 'CURRENT_AUTHORITY_DENIED' | 'STALE_PLAN' | 'RETRY_LIMIT';
    }
  | { state: 'unknown'; reason: 'START_UNCONFIRMED' };

function equalPlan(row: PlanRow, plan: WakePlan) {
  const receipts = plan.receiptIds.map((id) => id.toLowerCase()).sort();
  return (
    row.plan_id === plan.planId.toLowerCase() &&
    row.organization_id === plan.organizationId.toLowerCase() &&
    row.vm_id === plan.vmId.toLowerCase() &&
    row.instance_id === plan.instanceId.toLowerCase() &&
    Number(row.lease_epoch) === plan.leaseEpoch &&
    row.receipt_ids.length === receipts.length &&
    [...row.receipt_ids].sort().every((id, index) => id === receipts[index]) &&
    row.target_at?.getTime() === plan.targetAt?.getTime() &&
    row.wake_at?.getTime() === plan.wakeAt?.getTime()
  );
}

function hasInvalidation(sql: ISql, receiptIds: readonly string[]) {
  return sql`exists (
    select 1 from allrice_native_schedule_observation_receipts original
    join allrice_native_schedule_observation_receipts revision
      using (organization_id,workspace_id,person_id,vm_id,employee_instance_id)
    where original.receipt_id=any(${[...receiptIds]}::uuid[])
      and exists (
        select 1
        from jsonb_array_elements_text(revision.input_payload->'invalidateReceiptIds') invalidated(id)
        where lower(invalidated.id)=original.receipt_id::text))`;
}

/** Read the current facts for every profile that will restart on this disk.
 * This is an internal boot check, not a replacement for user authorization. */
export async function readPersonVmWakeRoster(
  tx: TransactionSql,
  binding: PersonVmBinding,
  expected: readonly Pick<
    NativeScheduleLedgerOrigin,
    | 'workspaceId'
    | 'employeeInstanceId'
    | 'employeeVersionId'
    | 'employeeRevision'
  >[],
  lock = false,
): Promise<PersonVmWebRoster | null> {
  const { personId, organizationId } = binding;
  if (!expected.length) return null;
  const rows = await tx<
    {
      workspace_id: string;
      instance_id: string;
      revision: number;
      version_id: string;
    }[]
  >`select i.workspace_id,i.id as instance_id,i.revision,a.employee_version_id as version_id
    from allrice_employee_instances i
    join allrice_employee_assignments a on a.id=i.assignment_id
      and a.organization_id=i.organization_id and a.workspace_id=i.workspace_id
      and a.user_id=i.owner_id and a.active
    join allrice_employees e on e.id=a.employee_id
      and e.organization_id=i.organization_id and e.workspace_id=i.workspace_id and e.status='active'
    join allrice_users u on u.id=i.owner_id and u.status='active'
    join allrice_organizations o on o.id=i.organization_id and o.archived_at is null
    join allrice_workspaces ws on ws.id=i.workspace_id and ws.organization_id=o.id and ws.archived_at is null
    join lateral (
      select m.id from allrice_memberships m where m.organization_id=o.id and m.user_id=u.id
        and m.active and m.role in ('admin','member')
        and (m.workspace_id is null or m.workspace_id=ws.id)
      order by m.id limit 1 ${lock ? tx`for share of m nowait` : tx``}
    ) membership on true
    where i.id=any(${expected.map((entry) => entry.employeeInstanceId)}::uuid[])
      and i.organization_id=${organizationId} and i.owner_id=${personId} and i.archived_at is null
      and not exists(select 1 from allrice_platform_employee_tenant_assignments d
        where d.organization_id=o.id and d.workspace_id=ws.id and d.tenant_employee_id=e.id and not d.active)
    ${lock ? tx`for share of i,a,u,o,ws nowait for update of e nowait` : tx``}`;
  if (rows.length !== expected.length) return null;
  if (lock) {
    // The employee key lock also excludes new matching deployments through
    // the foreign key. Tenant withdrawal locks the deployment before the
    // employee and assignment; back off instead of waiting in reverse order.
    const deployments = await tx<{ active: boolean }[]>`
      select d.active from allrice_platform_employee_tenant_assignments d
      join allrice_employee_assignments a on a.employee_id=d.tenant_employee_id
        and a.organization_id=d.organization_id and a.workspace_id=d.workspace_id
      join allrice_employee_instances i on i.assignment_id=a.id
      where i.id=any(${expected.map((entry) => entry.employeeInstanceId)}::uuid[])
      order by d.id for share of d nowait`;
    if (deployments.some(({ active }) => !active)) return null;
  }
  const policy = await readDEntryReleasePolicy(tx, lock);
  const entries = rows
    .map((row) => ({
      workspaceId: row.workspace_id,
      employeeInstanceId: row.instance_id,
      employeeRevision: row.revision,
      employeeVersionId: row.version_id,
    }))
    .sort((a, b) => a.employeeInstanceId.localeCompare(b.employeeInstanceId));
  const wanted = new Map(
    expected.map((entry) => [entry.employeeInstanceId, entry]),
  );
  if (
    entries.some((entry) => {
      const previous = wanted.get(entry.employeeInstanceId);
      return (
        !previous ||
        previous.workspaceId !== entry.workspaceId ||
        previous.employeeRevision !== entry.employeeRevision ||
        previous.employeeVersionId !== entry.employeeVersionId ||
        selectDEntryGeneration(policy, {
          ...entry,
          personId,
          organizationId,
          threadId: null,
        }) !== '4.0'
      );
    })
  )
    return null;
  const facts = { personId, organizationId, entries };
  return {
    ...facts,
    digest: `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`,
  };
}

async function readClaimRoster(
  tx: TransactionSql,
  claim: ScheduledWakeClaim,
  lock = false,
): Promise<PersonVmWebRoster | null> {
  // The physical owner can already have advanced the current epoch.
  // Recheck the immutable stopped source and its original receipt here.
  const [plan] = await tx<{ receipt_ids: string[] }[]>`
  select p.receipt_ids from person_vm_scheduled_wakes p
  where p.plan_id=${claim.planId} and p.claim_id=${claim.claimId}
    and p.person_id=${claim.personId} and p.organization_id=${claim.organizationId}
    and p.vm_id=${claim.vmId} and p.instance_id=${claim.instanceId}
    and p.lease_epoch=${claim.leaseEpoch} and p.state='claimed'
    and p.claim_until>clock_timestamp() and p.revoked_at is null
    and not ${hasInvalidation(tx, claim.receiptIds)}
    and p.plan_id=(
      select a.request_id from person_vm_audit a
      where a.person_id=p.person_id and a.organization_id=p.organization_id
        and a.vm_id=p.vm_id and a.lease_epoch=p.lease_epoch
        and a.action='stop' and a.result='succeeded'
      order by a.id desc limit 1)
    ${lock ? tx`for share of p` : tx``}`;
  if (
    !plan ||
    plan.receipt_ids.length !== claim.receiptIds.length ||
    plan.receipt_ids.some((id, index) => id !== claim.receiptIds[index])
  )
    return null;
  const receipts = await tx<{ origin: NativeScheduleLedgerOrigin }[]>`
  select input_payload->'origin' as origin
  from allrice_native_schedule_observation_receipts
  where receipt_id=any(${plan.receipt_ids}::uuid[])`;
  if (receipts.length !== plan.receipt_ids.length) return null;
  return readPersonVmWakeRoster(
    tx,
    claim,
    receipts.map(({ origin }) => origin),
  );
}

async function audit(
  tx: TransactionSql,
  row: PlanRow,
  request: string,
  action: 'prepare' | 'claim' | 'settle',
  result: 'started' | 'succeeded' | 'failed' | 'denied',
  reason: string | null = null,
) {
  await tx`insert into person_vm_audit
    (person_id,organization_id,vm_id,request_id,action,result,error_code,lease_epoch)
    values (${row.person_id},${row.organization_id},${row.vm_id},${request},
      ${'scheduled-wake.' + action},${result},${reason},${row.lease_epoch})`;
}

export async function withOwnedPersonVmAuthorityTransaction<T>(
  sql: Sql,
  isolation:
    'isolation level read committed' | 'isolation level repeatable read',
  signal: AbortSignal,
  work: (tx: TransactionSql, active: AbortSignal) => Promise<T>,
) {
  signal.throwIfAborted();
  const dedicated = createDedicatedDatabase(sql);
  const disconnected = new AbortController();
  let closing = false;
  dedicated.options.onclose = () => {
    if (!closing)
      disconnected.abort(new Error('SCHEDULE_WAKE_AUTHORITY_CONNECTION_LOST'));
  };
  const active = AbortSignal.any([signal, disconnected.signal]);
  let pending: Promise<{ value: T }> | undefined;
  try {
    const transaction = dedicated.begin(isolation, (tx) => {
      pending = (async () => {
        active.throwIfAborted();
        const lockTimeout =
          isolation === 'isolation level read committed' ? '100ms' : '5s';
        await tx`select set_config('lock_timeout', ${lockTimeout}, true)`;
        const value = await work(tx, active);
        active.throwIfAborted();
        return { value };
      })();
      return pending;
    });
    const result = await joinCallerSave(transaction, () => pending);
    return result.value;
  } finally {
    // A successful native start can return a capacity handle that retains
    // the dispatch signal through bootstrap. Normal SQL close is not loss.
    closing = true;
    await dedicated.end({ timeout: 5 });
  }
}

/** Stores host boot intent. The eventual boot caller must hold the ordinary VM
 * lifecycle lease and establish current authority independently of this store. */
export function createPostgresPersonVmScheduledWakeStore(sql: Sql) {
  return {
    /** Includes joined native stops awaiting lifecycle publication. Release
     * must leave their recovery and wake with the current Worker. */
    async nextCommittedWakeAt(signal: AbortSignal): Promise<Date | null> {
      const active = AbortSignal.any([signal, AbortSignal.timeout(3_000)]);
      active.throwIfAborted();
      const dedicated = createDedicatedDatabase(sql);
      let closing: Promise<void> | undefined;
      const close = () => (closing ??= dedicated.end({ timeout: 0 }));
      // This transaction is strictly read-only. It can safely be terminated
      // without waiting for an unresponsive database or a network read.
      const abort = addAbortListener(
        active,
        () => void close().catch(() => {}),
      );
      try {
        return await dedicated.begin('read only', async (tx) => {
          await tx`set local statement_timeout = '2s'`;
          active.throwIfAborted();
          const [row] = await tx<{ earliest: Date | null }[]>`
        select min(at) as earliest from (
        select greatest(p.wake_at,p.retry_at) as at
        from person_virtual_machines vm
        join person_vm_scheduled_wakes p using (person_id,organization_id,vm_id,instance_id,lease_epoch)
        cross join lateral (
          select a.request_id, a.result from person_vm_audit a
          where a.person_id=vm.person_id and a.organization_id=vm.organization_id
            and a.vm_id=vm.vm_id and a.lease_epoch=vm.lease_epoch
            and (
              (vm.phase in ('stopped','cold') and vm.egress_receipt is null
                and a.action='stop' and a.result='succeeded')
              or (vm.phase in ('running','failed') and a.action='stop.idle-dispatch'))
          order by a.id desc limit 1
        ) stop
        where vm.disk_retained and p.revoked_at is null
          and p.wake_at is not null and p.state='waiting'
          and stop.request_id=p.plan_id and stop.result='succeeded'
        union all
        -- An in-flight claim can already be starting the next epoch.
        select greatest(wake_at,claim_until) as at
          from person_vm_scheduled_wakes where state='claimed'
        ) committed`;
          active.throwIfAborted();
          return row?.earliest ?? null;
        });
      } catch (error) {
        active.throwIfAborted();
        throw error;
      } finally {
        abort[Symbol.dispose]();
        await close();
      }
    },
    stage(plan: WakePlan): Promise<boolean> {
      return sql.begin(async (tx) => {
        const [row] = await tx<
          PlanRow[]
        >`insert into person_vm_scheduled_wakes as w
          (person_id,organization_id,vm_id,instance_id,lease_epoch,plan_id,receipt_ids,
           target_at,wake_at,state)
          select vm.person_id,vm.organization_id,vm.vm_id,vm.instance_id,vm.lease_epoch,
            ${plan.planId},${[...plan.receiptIds]}::uuid[],${plan.targetAt},${plan.wakeAt},
            case when ${plan.targetAt}::timestamptz is null then 'empty' else 'waiting' end
          from person_virtual_machines vm
          where vm.person_id=${plan.personId} and vm.organization_id=${plan.organizationId}
            and vm.vm_id=${plan.vmId} and vm.instance_id=${plan.instanceId}
            and vm.lease_epoch=${plan.leaseEpoch} and vm.phase='running'
            and not ${hasInvalidation(tx, plan.receiptIds)}
            and (select count(*) from allrice_native_schedule_observation_receipts r
              where r.receipt_id=any(${[...plan.receiptIds]}::uuid[])
                and r.person_id=vm.person_id and r.organization_id=vm.organization_id
                and r.vm_id=vm.vm_id and r.input_payload->>'kind'='snapshot'
                and lower(r.input_payload #>> '{origin,instanceId}')=vm.instance_id::text
                and r.input_payload #>> '{origin,leaseEpoch}'=vm.lease_epoch::text)
              =cardinality(${[...plan.receiptIds]}::uuid[])
          on conflict(plan_id) do nothing
          returning w.*`;
        if (row) {
          await audit(tx, row, row.plan_id, 'prepare', 'succeeded');
          return true;
        }
        const [existing] = await tx<
          PlanRow[]
        >`select w.* from person_vm_scheduled_wakes w
          join person_virtual_machines vm using (person_id,organization_id,vm_id,instance_id,lease_epoch)
          where w.plan_id=${plan.planId} and w.person_id=${plan.personId}
            and w.revoked_at is null and vm.phase='running'
            and not ${hasInvalidation(tx, plan.receiptIds)}`;
        return (
          !!existing &&
          ['empty', 'waiting'].includes(existing.state) &&
          equalPlan(existing, plan)
        );
      });
    },

    /** Expiry permits reclaim of intent only. The boot port checks the claim
     * again under the VM lease before touching the exact stopped source.
     * Start from the VM's committed stop so abandoned preparations stay in
     * the audit history without becoming candidates on every tick. */
    claim(leaseMs: number): Promise<ScheduledWakeClaim | null> {
      return sql.begin(async (tx) => {
        const claimId = randomUUID();
        const [row] = await tx<PlanRow[]>`update person_vm_scheduled_wakes as w
          set state='claimed',claim_id=${claimId},
            claim_until=now()+${leaseMs}::double precision * interval '1 millisecond',
            retry_at=null,attempts=w.attempts+1,reason=null,updated_at=now()
          from (
            select p.plan_id from person_virtual_machines vm
            join lateral (
              select a.request_id from person_vm_audit a
              where a.person_id=vm.person_id and a.organization_id=vm.organization_id
                and a.vm_id=vm.vm_id and a.lease_epoch=vm.lease_epoch
                and a.action='stop' and a.result='succeeded'
              order by a.id desc limit 1
            ) as last_stop on true
            join person_vm_scheduled_wakes p on p.plan_id=last_stop.request_id
              and p.person_id=vm.person_id and p.organization_id=vm.organization_id
              and p.vm_id=vm.vm_id and p.instance_id=vm.instance_id
              and p.lease_epoch=vm.lease_epoch
            where vm.phase in ('stopped','cold') and vm.disk_retained
              and p.revoked_at is null
              and vm.egress_receipt is null and vm.lease_owner is null
              and jsonb_array_length(vm.holds)=0
              and coalesce(p.retry_at,p.wake_at)<=now()
              and (p.state='waiting' or (p.state='claimed' and p.claim_until<=now()))
            order by coalesce(p.retry_at,p.wake_at),p.person_id
            limit 1 for update of p skip locked
          ) as due where w.plan_id=due.plan_id
          returning w.*`;
        if (!row?.target_at) return null;
        await audit(tx, row, claimId, 'claim', 'started');
        return {
          personId: row.person_id,
          organizationId: row.organization_id,
          vmId: row.vm_id,
          instanceId: row.instance_id,
          leaseEpoch: Number(row.lease_epoch),
          planId: row.plan_id,
          receiptIds: row.receipt_ids,
          targetAt: row.target_at,
          attempts: row.attempts,
          claimId,
        };
      });
    },

    /** Retire expired claims that cannot be retried. A missing stopped
     * generation leaves the prior start unconfirmed. */
    recordExpiredUnrecoverableClaim(): Promise<boolean> {
      return sql.begin(async (tx) => {
        const [row] = await tx<
          (PlanRow & { expired_claim: string; reason: string })[]
        >`
          update person_vm_scheduled_wakes as w
          set state=case when expired.denied then 'blocked' else 'unknown' end,
            claim_id=null,claim_until=null,
            reason=case when expired.denied then 'STALE_PLAN' else 'START_UNCONFIRMED' end,
            updated_at=now()
          from (
            select p.plan_id,p.claim_id,p.revoked_at is not null and source.stopped as denied
            from person_vm_scheduled_wakes p
            left join person_virtual_machines vm on vm.person_id=p.person_id
            cross join lateral (
              select coalesce(vm.organization_id=p.organization_id and vm.vm_id=p.vm_id
                and vm.instance_id=p.instance_id and vm.lease_epoch=p.lease_epoch
                and vm.phase in ('stopped','cold') and vm.disk_retained
                and vm.egress_receipt is null, false) as stopped
            ) as source
            where p.state='claimed' and p.claim_until<=now()
              and (p.revoked_at is not null or not source.stopped)
              and (vm.lease_owner is null or (
                vm.organization_id=p.organization_id and vm.vm_id=p.vm_id
                and vm.lease_epoch>p.lease_epoch and vm.phase in ('starting','running','failed')
                and vm.lease_expires_at<=clock_timestamp()
                and pg_try_advisory_xact_lock(hashtextextended('person-vm:' || p.person_id::text,0))
              ))
            order by p.claim_until,p.plan_id
            limit 1 for update of p skip locked
          ) as expired where w.plan_id=expired.plan_id
          returning w.*,expired.claim_id as expired_claim`;
        if (!row) return false;
        await audit(
          tx,
          row,
          row.expired_claim,
          'settle',
          row.state === 'blocked' ? 'denied' : 'failed',
          row.reason,
        );
        return true;
      });
    },

    async isCurrent(claim: ScheduledWakeClaim): Promise<boolean> {
      const [row] = await sql`select 1 from person_vm_scheduled_wakes
        where person_id=${claim.personId} and organization_id=${claim.organizationId}
          and vm_id=${claim.vmId} and instance_id=${claim.instanceId}
          and lease_epoch=${claim.leaseEpoch} and plan_id=${claim.planId}
          and claim_id=${claim.claimId} and state='claimed' and claim_until>now()
          and revoked_at is null
          and not ${hasInvalidation(sql, claim.receiptIds)}`;
      return !!row;
    },

    readClaimRoster(
      claim: ScheduledWakeClaim,
    ): Promise<PersonVmWebRoster | null> {
      return sql.begin('isolation level repeatable read read only', (tx) =>
        readClaimRoster(tx, claim),
      );
    },

    /** Order native dispatch and running publication against commits that
     * update this same row to invalidate authority or native receipts. */
    async withClaimAuthority<T>(
      claim: ScheduledWakeClaim,
      signal: AbortSignal,
      work: (roster: PersonVmWebRoster, active: AbortSignal) => Promise<T>,
    ): Promise<T | null> {
      return withOwnedPersonVmAuthorityTransaction(
        sql,
        'isolation level repeatable read',
        signal,
        async (tx, active) => {
          const roster = await readClaimRoster(tx, claim, true);
          active.throwIfAborted();
          return roster ? work(roster, active) : null;
        },
      );
    },

    /** Keep the current employee facts and prepared stop plan pinned through
     * the native command. The caller holds the physical lease. */
    withPreparedStopAuthority(
      binding: PersonVmBinding,
      expected: PersonVmWebRoster,
      requestId: string,
      signal: AbortSignal,
      stop: (active: AbortSignal) => Promise<void>,
      authorizeDispatch?: (
        tx: TransactionSql,
        active: AbortSignal,
      ) => Promise<void>,
    ): Promise<boolean> {
      // Read deployments after taking the employee key lock so the next
      // statement also sees any deployments inserted before that lock.
      return withOwnedPersonVmAuthorityTransaction(
        sql,
        'isolation level read committed',
        signal,
        async (tx, active) => {
          const roster = await readPersonVmWakeRoster(
            tx,
            binding,
            expected.entries,
            true,
          );
          if (roster?.digest !== expected.digest) return false;
          const [plan] = await tx<
            { receipt_ids: string[]; wake_at: Date | null }[]
          >`select p.receipt_ids, p.wake_at
          from person_vm_scheduled_wakes p
          join person_virtual_machines vm using (person_id,organization_id,vm_id,instance_id,lease_epoch)
          where p.plan_id=${requestId} and p.person_id=${binding.personId}
            and p.organization_id=${binding.organizationId} and p.vm_id=${binding.vmId}
            and p.instance_id=${binding.instanceId} and p.lease_epoch=${binding.leaseEpoch}
            and p.revoked_at is null and p.state in ('empty','waiting')
            and vm.phase='running' and vm.lease_owner is not null
          for share of p nowait`;
          if (!plan) return false;
          const [current] = await tx<{ authorized: boolean }[]>`
            select not ${hasInvalidation(tx, plan.receipt_ids)}
              and (${plan.wake_at}::timestamptz is null or
                ${plan.wake_at}::timestamptz>clock_timestamp()) as authorized
            from person_virtual_machines vm
            where vm.person_id=${binding.personId} and vm.organization_id=${binding.organizationId}
              and vm.vm_id=${binding.vmId} and vm.instance_id=${binding.instanceId}
              and vm.lease_epoch=${binding.leaseEpoch} and vm.phase='running'
              and vm.lease_owner is not null and vm.lease_expires_at>clock_timestamp()`;
          if (current?.authorized !== true) return false;
          await authorizeDispatch?.(tx, active);
          active.throwIfAborted();
          await stop(active);
          return true;
        },
      );
    },

    releaseUnusedClaim(claim: ScheduledWakeClaim): Promise<boolean> {
      return sql.begin(async (tx) => {
        const [row] = await tx<
          (PlanRow & { reason: string })[]
        >`update person_vm_scheduled_wakes
          set state=case when revoked_at is null then 'waiting' else 'blocked' end,
            claim_id=null,claim_until=null,attempts=attempts-1,
            reason=case when revoked_at is null then 'DISPATCH_CANCELLED' else 'STALE_PLAN' end,
            updated_at=now()
          where plan_id=${claim.planId} and claim_id=${claim.claimId} and state='claimed'
          returning *`;
        if (!row) return false;
        await audit(
          tx,
          row,
          claim.claimId,
          'settle',
          row.state === 'blocked' ? 'denied' : 'failed',
          row.reason,
        );
        return true;
      });
    },

    settle(
      claim: ScheduledWakeClaim,
      result: ScheduledWakeOutcome,
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        let outcome = result;
        if (outcome.state === 'waiting') {
          const [stopped] = await tx`select 1 from person_virtual_machines
            where person_id=${claim.personId} and organization_id=${claim.organizationId}
              and vm_id=${claim.vmId} and instance_id=${claim.instanceId}
              and lease_epoch=${claim.leaseEpoch} and phase in ('stopped','cold')
              and disk_retained and egress_receipt is null`;
          if (!stopped)
            outcome = { state: 'unknown', reason: 'START_UNCONFIRMED' };
        }
        const reason = 'reason' in outcome ? outcome.reason : null;
        const retryDelayMs =
          outcome.state === 'waiting' ? outcome.retryDelayMs : null;
        const [row] = await tx<
          (PlanRow & { reason: string | null })[]
        >`update person_vm_scheduled_wakes
          set state=case when revoked_at is not null then 'blocked' else ${outcome.state} end,
            claim_id=null,claim_until=null,
            reason=case when revoked_at is not null then 'STALE_PLAN' else ${reason} end,
            retry_at=case when revoked_at is null then
              now()+${retryDelayMs}::double precision * interval '1 millisecond' end,
            updated_at=now()
          where person_id=${claim.personId} and plan_id=${claim.planId}
            and claim_id=${claim.claimId} and state='claimed' and claim_until>now()
          returning *`;
        if (!row) return false;
        await audit(
          tx,
          row,
          claim.claimId,
          'settle',
          row.state === 'ready'
            ? 'succeeded'
            : row.state === 'blocked'
              ? 'denied'
              : 'failed',
          row.reason,
        );
        return true;
      });
    },
  };
}
