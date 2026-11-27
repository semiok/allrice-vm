import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { RequestContext } from '@allrice/contracts';
import { PersonVmError } from './contract.ts';
import type { PersonVmView } from './contract.ts';

export type PlatformVmDeletionRequest = { personId: string } & (
  | { action: 'review' }
  | { action: 'retain-disk'; vmId: string; leaseEpoch: number }
  | { action: 'purge-disk'; vmId: string; confirmationId: string }
);

export type PlatformVmDeletionTarget = Pick<
  PersonVmView,
  'personId' | 'vmId' | 'organizationId' | 'phase' | 'diskRetained'
> & {
  instanceId: string | null;
  leaseEpoch: number;
  diskTier: 'warm' | 'cold';
  diskIdentitySha256: string | null;
};

export type PlatformVmDeletionResult =
  | { target: PlatformVmDeletionTarget; confirmationId: string | null }
  | { vm: PersonVmView };

export type PlatformVmErasingDisk = {
  diskIdentitySha256: string | null;
  diskTier: 'warm' | 'cold';
};

export type PlatformVmDeletionAudit = {
  context: RequestContext;
  target: PlatformVmDeletionTarget;
  confirmationId: string | null;
  action: 'review' | 'retain-disk' | 'purge-disk';
  result:
    'reviewed' | 'started' | 'erasing' | 'succeeded' | 'failed' | 'denied';
  errorCode?: string;
  requestedTarget?: { vmId: string; leaseEpoch?: number };
  diskUnverified?: true;
};

export type PlatformVmDeletionAuthorization = (
  sql: postgres.Sql,
) => Promise<void>;

/** The existing audit stream also supplies the short-lived, one-use approval.
 * It records the actual operator without borrowing the target's login. */
export async function recordPlatformVmDeletion(
  sql: postgres.Sql | postgres.TransactionSql,
  event: PlatformVmDeletionAudit,
) {
  const { context, target, action, result, confirmationId } = event;
  const metadata = {
    ...target,
    confirmationId,
    loginDigest: createHash('sha256').update(context.sessionId).digest('hex'),
    ...(event.requestedTarget && { requestedTarget: event.requestedTarget }),
    ...(event.diskUnverified && { diskUnverified: true }),
  };
  const verb = `person_vm.platform.${action}.${result}`;
  const decision = result === 'denied' ? 'denied' : 'recorded';
  if (action === 'purge-disk' && result === 'started') {
    const [accepted] = await sql`insert into allrice_audit_events
      (id,organization_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      select ${confirmationId},organization_id,actor_id,${verb},resource_type,resource_id,${decision},
        'explicit_platform_vm_deletion',${context.requestId},metadata
      from allrice_audit_events
      where organization_id=${target.organizationId} and actor_id=${context.actor.id}
        and action='person_vm.platform.review.reviewed' and resource_type='person_vm'
        and resource_id=${target.vmId} and metadata=${sql.json(metadata)}
        and occurred_at>clock_timestamp()-interval '5 minutes'
      on conflict (id) do nothing returning id`;
    if (!accepted) throw new PersonVmError('DISK_DELETE_NOT_AUTHORIZED');
    return;
  }
  await sql`insert into allrice_audit_events
    (organization_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
    values (${target.organizationId},${context.actor.id},${verb},'person_vm',${target.vmId},
      ${decision},${event.errorCode ?? 'explicit_platform_vm_deletion'},${context.requestId},
      ${sql.json(metadata)} || coalesce((
        select jsonb_build_object('reviewedDiskIdentitySha256', metadata->'diskIdentitySha256')
        from allrice_audit_events where ${event.diskUnverified === true} and ${confirmationId}::uuid is not null
          and action='person_vm.platform.review.reviewed' and resource_type='person_vm'
          and organization_id=${target.organizationId} and actor_id=${context.actor.id}
          and resource_id=${target.vmId}
          and metadata @> ${sql.json({ confirmationId, loginDigest: metadata.loginDigest, personId: target.personId })}
        order by occurred_at desc limit 1
      ), '{}'::jsonb))`;
}
