import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  DEntryRolloutPolicySchema,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import type { PersonVmDiskPreparationTarget } from '@allrice/person-vm';
import { readContentPrincipal } from './content-maintenance.ts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  EmployeeInstanceError,
  getEmployeeInstance,
} from './employees/employee-instances.ts';
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
  await requireCurrentPlatformAdmin(context, getDatabase(), false);
  return readDEntryReleasePolicy();
}

/** Published by the same platform-admin authority as native_question_mode.
 * Each selection opts one person into 4.0 within their organization. */
export async function updateDEntryReleasePolicy(
  context: RequestContext,
  input: unknown,
) {
  const parsed = DEntryRolloutPolicySchema.parse(input);
  if (parsed.defaultGeneration !== '3.x')
    throw new DataAccessError('authorization_denied');
  const policy = { ...parsed, revision: randomUUID() };
  await getDatabase().begin(async (tx) => {
    const actor = await requireCurrentPlatformAdmin(context, tx);
    await tx`select pg_advisory_xact_lock(hashtextextended(${dEntryReleasePolicyKey},0))`;
    const [setting] =
      await tx`insert into allrice_settings(scope_type,key,value,updated_by)
      values('system',${dEntryReleasePolicyKey},${tx.json(policy)},${actor})
      on conflict(scope_type,scope_id,key) do update
      set value=excluded.value,updated_by=excluded.updated_by,updated_at=clock_timestamp()
      returning id`;
    await tx`insert into allrice_audit_events
      (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${context.organizationId},${context.workspaceId},${actor},'d_entry_release.update',
        'setting',${setting!.id},'recorded','platform_admin',${context.requestId},
        ${tx.json({ revision: policy.revision })})`;
  });
  return policy;
}

/** Host polling only. Page by person so one person's selections cannot be
 * split across pages, including when checking for a conflicting enterprise. */
export async function listPersonVmDiskPreparationPeople(
  after: string | null,
  limit: number,
  signal: AbortSignal,
) {
  if (after !== null) UuidSchema.parse(after);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Invalid disk preparation page size');
  signal.throwIfAborted();
  const policy = await getDatabase().begin('read only', async (sql) => {
    await sql`set local statement_timeout = '5s'`;
    signal.throwIfAborted();
    return readDEntryReleasePolicy(sql);
  });
  signal.throwIfAborted();
  const people = [
    ...new Set(
      policy.selections
        .filter(
          (entry) =>
            entry.generation === '4.0' &&
            (after === null || entry.personId > after),
        )
        .map((entry) => entry.personId),
    ),
  ]
    .sort()
    .slice(0, limit + 1);
  const personIds = people.slice(0, limit);
  return {
    personIds,
    nextAfter: people.length > limit ? personIds[limit - 1]! : null,
  };
}

/** Rebuild current storage eligibility from committed data in one short read.
 * The returned facts authorize neither a logged-in principal nor VM startup. */
export async function readPersonVmDiskPreparationTarget(
  personId: string,
  signal: AbortSignal,
): Promise<PersonVmDiskPreparationTarget | null> {
  UuidSchema.parse(personId);
  signal.throwIfAborted();
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (sql) => {
      await sql`set local statement_timeout = '5s'`;
      signal.throwIfAborted();
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
        from person_virtual_machines where person_id=${personId}`;
      if (
        vm &&
        (!vm.disk_retained ||
          vm.native_created ||
          vm.instance_id !== null ||
          vm.phase === 'deleted' ||
          vm.phase === 'running')
      )
        return null;

      const eligible: PersonVmDiskPreparationTarget[] = [];
      for (const entry of policy.selections) {
        signal.throwIfAborted();
        if (
          entry.generation !== '4.0' ||
          entry.personId !== personId ||
          (vm && entry.organizationId !== vm.organization_id) ||
          eligible[0]?.organizationId === entry.organizationId
        )
          continue;
        const [owner] = await sql<{ owner_id: string; workspace_id: string }[]>`
          select owner_id,workspace_id from allrice_employee_instances
          where id=${entry.employeeInstanceId} and organization_id=${entry.organizationId}
            and owner_id=${personId} and archived_at is null`;
        if (!owner) continue;
        // A read-only subject projection, deliberately without a session.
        const subject = {
          actor: { type: 'user' as const, id: owner.owner_id },
          organizationId: entry.organizationId,
          workspaceId: owner.workspace_id,
        };
        if (!(await readContentPrincipal(subject, sql))?.writable) continue;
        try {
          const employee = await getEmployeeInstance(
            subject,
            entry.employeeInstanceId,
            sql,
          );
          signal.throwIfAborted();
          if (eligible.length) return null; // Two eligible enterprises, no existing owner.
          eligible.push(
            Object.freeze({
              personId,
              organizationId: entry.organizationId,
              workspaceId: employee.workspaceId,
              employeeInstanceId: employee.id,
              employeeRevision: employee.revision,
              employeeVersionId: employee.source.employeeVersionId,
              policyRevision: policy.revision,
            }),
          );
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
      signal.throwIfAborted();
      return eligible[0] ?? null;
    },
  );
}
