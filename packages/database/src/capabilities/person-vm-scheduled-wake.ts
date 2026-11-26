import { randomUUID } from 'node:crypto';
import type { PersonVmBinding } from '@allrice/person-vm';
import type { Sql, TransactionSql } from 'postgres';

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
  return (
    row.plan_id === plan.planId &&
    row.organization_id === plan.organizationId &&
    row.vm_id === plan.vmId &&
    row.instance_id === plan.instanceId &&
    Number(row.lease_epoch) === plan.leaseEpoch &&
    row.receipt_ids.length === plan.receiptIds.length &&
    row.receipt_ids.every((id, index) => id === plan.receiptIds[index]) &&
    row.target_at?.getTime() === plan.targetAt?.getTime() &&
    row.wake_at?.getTime() === plan.wakeAt?.getTime()
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

/** Stores host boot intent. The eventual boot caller must hold the ordinary VM
 * lifecycle lease and establish current authority independently of this store. */
export function createPostgresPersonVmScheduledWakeStore(sql: Sql) {
  return {
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
            and vm.phase='running'`;
        return (
          !!existing &&
          ['empty', 'waiting'].includes(existing.state) &&
          equalPlan(existing, plan)
        );
      });
    },

    /** Expiry permits reclaim of intent only. The boot port checks the claim
     * again under the VM lease before touching the exact stopped source. */
    claim(leaseMs: number): Promise<ScheduledWakeClaim | null> {
      return sql.begin(async (tx) => {
        const claimId = randomUUID();
        const [row] = await tx<PlanRow[]>`update person_vm_scheduled_wakes as w
          set state='claimed',claim_id=${claimId},
            claim_until=now()+${leaseMs}::double precision * interval '1 millisecond',
            retry_at=null,attempts=w.attempts+1,reason=null,updated_at=now()
          from (
            select p.person_id,p.plan_id from person_vm_scheduled_wakes p
            join person_virtual_machines vm
              using (person_id,organization_id,vm_id,instance_id,lease_epoch)
            where vm.phase in ('stopped','cold') and vm.disk_retained
              and vm.egress_receipt is null and vm.lease_owner is null
              and jsonb_array_length(vm.holds)=0
              and p.plan_id=(
                select a.request_id from person_vm_audit a
                where a.person_id=p.person_id and a.organization_id=p.organization_id
                  and a.vm_id=p.vm_id and a.lease_epoch=p.lease_epoch
                  and a.action='stop' and a.result='succeeded'
                order by a.id desc limit 1)
              and coalesce(p.retry_at,p.wake_at)<=now()
              and (p.state='waiting' or (p.state='claimed' and p.claim_until<=now()))
            order by coalesce(p.retry_at,p.wake_at),p.person_id
            limit 1 for update of p skip locked
          ) as due where w.person_id=due.person_id and w.plan_id=due.plan_id
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

    /** Once the exact stopped generation is gone, a prior boot may have
     * executed. Record the unresolved attempt without dispatching it again. */
    recordExpiredClaimWithoutStoppedSource(): Promise<boolean> {
      return sql.begin(async (tx) => {
        const [row] = await tx<(PlanRow & { expired_claim: string })[]>`
          update person_vm_scheduled_wakes as w
          set state='unknown',claim_id=null,claim_until=null,
            reason='START_UNCONFIRMED',updated_at=now()
          from (
            select p.plan_id,p.claim_id from person_vm_scheduled_wakes p
            where p.state='claimed' and p.claim_until<=now()
              and not exists (
                select 1 from person_virtual_machines vm where vm.person_id=p.person_id
                  and (vm.lease_owner is not null or (
                    vm.organization_id=p.organization_id and vm.vm_id=p.vm_id
                    and vm.instance_id=p.instance_id and vm.lease_epoch=p.lease_epoch
                    and vm.phase in ('stopped','cold') and vm.disk_retained
                    and vm.egress_receipt is null)))
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
          'failed',
          'START_UNCONFIRMED',
        );
        return true;
      });
    },

    async isCurrent(claim: ScheduledWakeClaim): Promise<boolean> {
      const [row] = await sql`select 1 from person_vm_scheduled_wakes
        where person_id=${claim.personId} and organization_id=${claim.organizationId}
          and vm_id=${claim.vmId} and instance_id=${claim.instanceId}
          and lease_epoch=${claim.leaseEpoch} and plan_id=${claim.planId}
          and claim_id=${claim.claimId} and state='claimed' and claim_until>now()`;
      return !!row;
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
        const [row] = await tx<PlanRow[]>`update person_vm_scheduled_wakes
          set state=${outcome.state},claim_id=null,claim_until=null,reason=${reason},
            retry_at=now()+${retryDelayMs}::double precision * interval '1 millisecond',
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
          outcome.state === 'ready'
            ? 'succeeded'
            : outcome.state === 'blocked'
              ? 'denied'
              : 'failed',
          reason,
        );
        return true;
      });
    },
  };
}
