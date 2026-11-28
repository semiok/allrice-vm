import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import {
  DEntryRolloutPolicySchema,
  hasDEntryPersonRelease,
  UuidSchema,
  type DEntryRolloutPolicy,
  type RequestContext,
} from '@allrice/contracts';
import {
  PersonVmError,
  type PersonVmDiskPreparationTarget,
} from '@allrice/person-vm';
import { readContentPrincipal } from './content-maintenance.ts';
import { joinCallerSave } from './business-runtime/caller-transaction.ts';
import { createDedicatedDatabase, getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  EmployeeInstanceError,
  getEmployeeInstance,
  readEmployeeVersionPublication,
} from './employees/employee-instances.ts';
import { assertNativeWebRolloutCapacity } from './employees/native-web-capacity.ts';
import { requireCurrentPlatformAdmin } from './platform-authority.ts';

// The existing platform release store is shared by Web and Worker. No process
// env, browser input or cached allowlist may enable an employee's 4.0 entry.
export const dEntryReleasePolicyKey = 'd_entry_rollout_policy';
const disabledPolicy = {
  revision: 'unpublished',
  defaultGeneration: '3.x' as const,
  selections: [],
};

/** Internal host read; callers establish current session/employee authority.
 * Missing configuration is the explicitly approved default-off policy. Invalid
 * stored configuration fails closed rather than silently changing a thread. */
export async function readDEntryReleasePolicy(
  sql: ReturnType<typeof getDatabase> | postgres.TransactionSql = getDatabase(),
  lock = false,
) {
  // A missing settings row cannot serialize with the first publication.
  if (lock)
    await sql`select pg_advisory_xact_lock_shared(hashtextextended(${dEntryReleasePolicyKey},0))`;
  const [row] = await sql`select value from allrice_settings
    where scope_type='system' and scope_id is null and key=${dEntryReleasePolicyKey}
    ${lock ? sql`for share` : sql``}`;
  const parsed = DEntryRolloutPolicySchema.safeParse(
    row?.value ?? disabledPolicy,
  );
  if (!parsed.success || parsed.data.defaultGeneration !== '3.x')
    throw new Error('D entry published policy is unavailable');
  return parsed.data;
}

export async function getDEntryReleasePolicy(context: RequestContext) {
  const db = getDatabase();
  await requireCurrentPlatformAdmin(context, db, false);
  const policy = await readDEntryReleasePolicy(db);
  await requireCurrentPlatformAdmin(context, db, false);
  return policy;
}

/** Published by the same platform-admin authority as native_question_mode.
 * Each selection opts one person into 4.0 within their organization. */
export async function updateDEntryReleasePolicy(
  context: RequestContext,
  input: unknown,
  options: { compareRevision?: true } = {},
) {
  const parsed = DEntryRolloutPolicySchema.parse(input);
  if (parsed.defaultGeneration !== '3.x')
    throw new DataAccessError('authorization_denied');
  const policy = { ...parsed, revision: randomUUID() };
  await getDatabase().begin(async (tx) => {
    const actor = await requireCurrentPlatformAdmin(context, tx);
    await tx`select pg_advisory_xact_lock(hashtextextended(${dEntryReleasePolicyKey},0))`;
    await requireCurrentPlatformAdmin(context, tx, false);
    const [stored] = await tx`select value from allrice_settings
      where scope_type='system' and scope_id is null and key=${dEntryReleasePolicyKey}`;
    const previous = DEntryRolloutPolicySchema.safeParse(
      stored?.value ?? disabledPolicy,
    );
    const current =
      previous.success && previous.data.defaultGeneration === '3.x'
        ? previous.data
        : undefined;
    if (options.compareRevision) {
      if (!current) throw new Error('D entry published policy is unavailable');
      if (current.revision !== parsed.revision)
        throw new DEntryPersonRolloutConflict();
    }
    // A valid replacement submitted without CAS can repair an unreadable
    // policy. Check every candidate selection as a new release in that case.
    const settingId = await writeReleasePolicy(
      tx,
      actor,
      current ?? disabledPolicy,
      policy,
    );
    await tx`insert into allrice_audit_events
      (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${context.organizationId},${context.workspaceId},${actor},'d_entry_release.update',
        'setting',${settingId},'recorded','platform_admin',${context.requestId},
        ${tx.json({ revision: policy.revision })})`;
  });
  return policy;
}

async function writeReleasePolicy(
  tx: postgres.TransactionSql,
  actor: string,
  previous: DEntryRolloutPolicy,
  policy: DEntryRolloutPolicy,
) {
  await assertNativeWebRolloutCapacity(tx, previous, policy);
  const [setting] = await tx<{ id: string }[]>`
    insert into allrice_settings(scope_type,key,value,updated_by)
    values('system',${dEntryReleasePolicyKey},${tx.json(policy)},${actor})
    on conflict(scope_type,scope_id,key) do update
    set value=excluded.value,updated_by=excluded.updated_by,updated_at=clock_timestamp()
    returning id`;
  if (!setting) throw new Error('Rollout publication missing receipt');
  return setting.id;
}

const identifier = UuidSchema.transform((id) => id.toLowerCase());
const rolloutTarget = z.strictObject({
  organizationId: identifier,
  personId: identifier,
});
const rolloutChange = rolloutTarget.extend({
  enabled: z.boolean(),
  expectedRevision: DEntryRolloutPolicySchema.shape.revision,
});

export class DEntryPersonRolloutConflict extends Error {}

async function requireRolloutMember(
  sql: ReturnType<typeof getDatabase> | postgres.TransactionSql,
  target: z.infer<typeof rolloutTarget>,
  lock = false,
) {
  if (lock)
    await sql`select id from allrice_organizations where id=${target.organizationId} for share`;
  const [member] = await sql`
    select m.id from allrice_memberships m
    join allrice_organizations o on o.id=m.organization_id and o.archived_at is null and o.slug<>'allrice-platform'
    join allrice_users u on u.id=m.user_id and u.status='active'
    where m.organization_id=${target.organizationId} and m.user_id=${target.personId} and m.active
      and (m.workspace_id is null or exists (
        select 1 from allrice_workspaces w
        where w.id=m.workspace_id and w.organization_id=m.organization_id and w.archived_at is null
        ${lock ? sql`for share` : sql``}
      ))
    order by m.id limit 1
    ${lock ? sql`for share of o,u,m` : sql``}`;
  if (!member) throw new DataAccessError('not_found');
}

export async function getDEntryPersonRollout(
  context: RequestContext,
  input: { organizationId: string; personId: string },
) {
  const target = rolloutTarget.parse(input);
  const db = getDatabase();
  await requireCurrentPlatformAdmin(context, db, false);
  await requireRolloutMember(db, target);
  const policy = await readDEntryReleasePolicy(db);
  await requireRolloutMember(db, target);
  await requireCurrentPlatformAdmin(context, db, false);
  return {
    ...target,
    enabled: hasDEntryPersonRelease(policy, target),
    revision: policy.revision,
  };
}

/** Same setting and advisory lock as the existing platform publication. */
export async function updateDEntryPersonRollout(
  context: RequestContext,
  input: unknown,
) {
  const { organizationId, personId, enabled, expectedRevision } =
    rolloutChange.parse(input);
  const target = { organizationId, personId };
  return getDatabase().begin(async (tx) => {
    const actor = await requireCurrentPlatformAdmin(context, tx);
    // Native admission locks the subject before reading the rollout policy.
    // Take the subject lock here before the exclusive policy lock as well.
    if (enabled) await requireRolloutMember(tx, target, true);
    await tx`select pg_advisory_xact_lock(hashtextextended(${dEntryReleasePolicyKey},0))`;
    await requireCurrentPlatformAdmin(context, tx, false);
    const current = await readDEntryReleasePolicy(tx);
    if (current.revision !== expectedRevision)
      throw new DEntryPersonRolloutConflict();
    const wasEnabled = hasDEntryPersonRelease(current, target);
    // A platform administrator may withdraw a stale selection after offboarding.
    if (!enabled && !wasEnabled) await requireRolloutMember(tx, target);
    let revision = current.revision;
    if (enabled !== wasEnabled) {
      revision = randomUUID();
      await writeReleasePolicy(tx, actor, current, {
        ...current,
        revision,
        selections: enabled
          ? [...current.selections, target]
          : current.selections.filter(
              (s) =>
                s.organizationId !== organizationId || s.personId !== personId,
            ),
      });
    }
    const [receipt] = await tx<{ id: string; occurred_at: Date }[]>`
      insert into allrice_audit_events
        (organization_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${organizationId},${actor},'d_entry_release.person.update','user',${personId},
        'recorded','platform_admin',${context.requestId},
        ${tx.json({ previousRevision: current.revision, revision, previousEnabled: wasEnabled, enabled })})
      returning id, occurred_at`;
    if (!receipt) throw new Error('Rollout publication missing audit');
    return {
      ...target,
      enabled,
      revision,
      audit: { id: receipt.id, occurredAt: receipt.occurred_at.toISOString() },
    };
  });
}

/** Preparation reads stay off the request pool. Cancellation closes only
 * this owned connection and joins even a callback interrupted by disconnect. */
async function readDiskPreparation<T>(
  mode: string,
  signal: AbortSignal,
  read: (sql: postgres.TransactionSql, active: AbortSignal) => Promise<T>,
): Promise<T> {
  const active = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  active.throwIfAborted();
  const client = createDedicatedDatabase(getDatabase());
  let closing: Promise<void> | undefined;
  let callback: Promise<{ value: T }> | undefined;
  const close = () => (closing ??= client.end({ timeout: 0 }));
  const abort = () => void close().catch(() => {});
  active.addEventListener('abort', abort, { once: true });
  try {
    const result = await joinCallerSave(
      client.begin(mode, (sql) => {
        callback = (async () => {
          active.throwIfAborted();
          await sql`set local transaction_timeout = '5s'`;
          active.throwIfAborted();
          return { value: await read(sql, active) };
        })();
        return callback;
      }),
      () => callback,
    );
    active.throwIfAborted();
    return result.value;
  } finally {
    active.removeEventListener('abort', abort);
    await close();
  }
}

/** One committed roster per sweep. Pages are scheduling hints only. */
export async function readPersonVmDiskPreparationRoster(signal: AbortSignal) {
  const policy = await readDiskPreparation('read only', signal, (sql) =>
    readDEntryReleasePolicy(sql),
  );
  const people = [
    ...new Set(policy.selections.map(({ personId }) => personId)),
  ].sort();
  return Object.freeze({
    page(offset: number, limit: number) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new RangeError('Invalid disk preparation page');
      const personIds = people.slice(offset, offset + limit);
      const next = offset + personIds.length;
      return { personIds, nextOffset: next < people.length ? next : null };
    },
  });
}

/** Advisory preflight only. The provider owns physical lease arbitration. */
export async function readPersonVmDiskPreparationForegroundBusy(
  personId: string,
  signal: AbortSignal,
): Promise<boolean> {
  return readDiskPreparation('read only', signal, async (sql) => {
    const [row] = await sql<{ busy: boolean }[]>`
      select lease_owner is not null or instance_id is not null
        or holds <> '[]'::jsonb as busy
      from person_virtual_machines where person_id=${UuidSchema.parse(personId)}`;
    return row?.busy ?? false;
  });
}

/** Tenant and personal provenance must come from the exact version's creation
 * transaction. A missing platform mapping also describes old materializations. */
async function hasDiskPreparationVersionProvenance(
  sql: postgres.TransactionSql,
  identity: Pick<
    PersonVmDiskPreparationTarget,
    | 'organizationId'
    | 'workspaceId'
    | 'employeeVersionId'
    | 'employeeInstanceId'
    | 'personId'
  >,
  employeeId: string,
) {
  const [proof] = await sql<{ verified: boolean }[]>`
    select exists (
      select 1 from allrice_employee_versions v
      join allrice_audit_events audit
        on audit.organization_id=v.organization_id and audit.workspace_id=v.workspace_id
      where v.organization_id=${identity.organizationId} and v.workspace_id=${identity.workspaceId}
        and v.employee_id=${employeeId} and v.id=${identity.employeeVersionId}
        and audit.decision='allowed' and audit.occurred_at=v.published_at
        and (
          (v.version=1 and audit.action='employee.create' and audit.resource_type='employee'
            and audit.resource_id=v.employee_id and audit.reason='admin_created_employee_definition')
          or
          (audit.action='employee.version.publish' and audit.resource_type='employee_version'
            and audit.resource_id=v.id
            and audit.reason in ('admin_published_immutable_candidate', 'admin_published_immutable_manifest')
            and audit.metadata->>'checksum'=v.config_checksum)
          or
          (v.version=1 and audit.action='employee.instance.create' and audit.resource_type='employee_instance'
            and audit.resource_id=${identity.employeeInstanceId} and audit.actor_id=${identity.personId}
            and audit.reason='d_entry_personal_employee_create'
            and exists (select 1 from allrice_employee_instances i
              where i.id=audit.resource_id and i.assignment_id=i.id and i.kind='custom'
                and i.organization_id=v.organization_id and i.workspace_id=v.workspace_id
                and i.owner_id=audit.actor_id and i.creation_version_id=v.id))
        )
    ) as verified`;
  return proof?.verified === true;
}

/** Rebuild current storage eligibility from committed data in one short read.
 * The returned facts authorize neither a logged-in principal nor VM startup. */
export async function readPersonVmDiskPreparationTarget(
  personId: string,
  signal: AbortSignal,
): Promise<PersonVmDiskPreparationTarget | null | 'version-source-unverified'> {
  const ownerId = UuidSchema.parse(personId).toLowerCase();
  signal.throwIfAborted();
  return readDiskPreparation(
    'isolation level repeatable read read only',
    signal,
    async (sql, active) => {
      const policy = await readDEntryReleasePolicy(sql);
      const [vm] = await sql<
        {
          organization_id: string;
          phase: string;
          disk_retained: boolean;
          native_created: boolean;
          instance_id: string | null;
        }[]
      >`
        select organization_id,phase,disk_retained,native_created,instance_id
        from person_virtual_machines where person_id=${ownerId}`;
      if (
        vm &&
        (!vm.disk_retained ||
          vm.native_created ||
          vm.instance_id !== null ||
          vm.phase === 'deleted' ||
          vm.phase === 'running')
      )
        return null;

      const organizations = policy.selections
        .filter(
          (entry) =>
            entry.personId === ownerId &&
            (!vm || entry.organizationId === vm.organization_id),
        )
        .map(({ organizationId }) => organizationId);
      if (!organizations.length) return null;

      // The rollout grants a person in an organization. Resolve their current
      // employee instances inside this snapshot to retain publication checks.
      const employees = await sql<
        {
          id: string;
          organization_id: string;
          workspace_id: string;
          employee_id: string;
          platform_version: boolean;
        }[]
      >`
          select i.id,i.organization_id,i.workspace_id,a.employee_id,
            exists (select 1 from allrice_platform_employee_tenant_assignments d
              where d.organization_id=i.organization_id and d.workspace_id=i.workspace_id
                and d.tenant_employee_id=a.employee_id
                and d.tenant_employee_version_id=a.employee_version_id) as platform_version
          from allrice_employee_instances i
          join allrice_employee_assignments a on a.id=i.assignment_id
            and a.organization_id=i.organization_id and a.workspace_id=i.workspace_id
            and a.user_id=i.owner_id and a.active
          where i.organization_id=any(${organizations}::uuid[]) and i.owner_id=${ownerId}
            and i.archived_at is null
          order by i.organization_id,i.id`;
      let eligible: PersonVmDiskPreparationTarget | null = null;
      let organizationConflict = false;
      for (const instance of employees) {
        active.throwIfAborted();
        // A read-only subject projection, deliberately without a session.
        const subject = {
          actor: { type: 'user' as const, id: ownerId },
          organizationId: instance.organization_id,
          workspaceId: instance.workspace_id,
        };
        if (!(await readContentPrincipal(subject, sql))?.writable) continue;
        try {
          const employee = await getEmployeeInstance(subject, instance.id, sql);
          active.throwIfAborted();
          const identity = {
            personId: ownerId,
            organizationId: instance.organization_id,
            workspaceId: employee.workspaceId,
            employeeInstanceId: employee.id,
            employeeRevision: employee.revision,
            employeeVersionId: employee.source.employeeVersionId,
          };
          const source = employee.source;
          if (
            source.kind === 'tenant_version' &&
            (instance.platform_version ||
              !(await hasDiskPreparationVersionProvenance(
                sql,
                identity,
                instance.employee_id,
              )))
          )
            return 'version-source-unverified';
          const platformRevisionId =
            source.kind === 'platform' ? source.templateRevisionId : null;
          if (platformRevisionId) {
            const publication = await readEmployeeVersionPublication(
              {
                organizationId: identity.organizationId,
                workspaceId: identity.workspaceId,
                employeeId: instance.employee_id,
                versionId: identity.employeeVersionId,
              },
              sql,
            );
            if (publication?.revision_id !== platformRevisionId) continue;
          }
          active.throwIfAborted();
          if (eligible) {
            organizationConflict ||=
              eligible.organizationId !== identity.organizationId;
            continue;
          }
          eligible = Object.freeze({
            ...identity,
            platformRevisionId,
            policyRevision: policy.revision,
          });
        } catch (error) {
          if (
            (error instanceof DataAccessError &&
              ['not_found', 'authorization_denied'].includes(error.code)) ||
            (error instanceof EmployeeInstanceError &&
              error.code === 'instance_archived')
          )
            continue;
          throw error;
        }
      }
      active.throwIfAborted();
      if (organizationConflict)
        throw new PersonVmError('ORGANIZATION_CONFLICT');
      return eligible;
    },
  );
}
