import {
  CurrentEmployeeBusinessProjectionSchema,
  DEntryIdentitySchema,
  EmployeeBusinessTargetProjectionSchema,
  hasDEntryPersonRelease,
  type ApplicationBuiltinModulesProjection,
  type EmployeeBusinessTargetProjection,
  type RequestContext,
} from '@allrice/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { DataAccessError } from './data.ts';
import { readDEntryReleasePolicy } from './d-entry-release-policy.ts';
import { resolveEmployeeSessionInstance } from './employees/employee-instances.ts';

/** Private to the database owner. The caller owns commit and cancellation.
 * Application build verification takes place before opening the transaction.
 * Historical source readers do not use this live execution gate. */
export async function readLockedNativeMemoryAuthority(
  tx: Sql | TransactionSql,
  context: RequestContext,
  input: EmployeeBusinessTargetProjection,
  applicationModules: ApplicationBuiltinModulesProjection,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const target = EmployeeBusinessTargetProjectionSchema.parse(input);
  if (
    context.actor.type !== 'user' ||
    (context.workspaceId !== null &&
      context.workspaceId.toLowerCase() !== target.workspaceId) ||
    target.access !== 'execute' ||
    target.threadId === null ||
    target.module.kind !== 'builtin' ||
    target.module.moduleId !== 'employee-memory' ||
    applicationModules.builtinModules['employee-memory'] !== true
  )
    throw new DataAccessError('authorization_denied');

  const [selection] = await tx<{ employee_assignment_id: string }[]>`
    select employee_assignment_id from allrice_chat_sessions
    where id=${target.threadId} and organization_id=${context.organizationId}
      and workspace_id=${target.workspaceId} and owner_id=${context.actor.id}
      and coalesce(employee_instance_id,employee_assignment_id)=${target.employeeInstanceId}
      and execution_generation='4.0' and archived_at is null
  `;
  signal.throwIfAborted();
  if (!selection?.employee_assignment_id)
    throw new DataAccessError('authorization_denied');

  // D-entry locks principal → assignment → instance → Session → release.
  // Passing an explicit existing instance excludes legacy materialization.
  const employee = await resolveEmployeeSessionInstance(
    { ...context, workspaceId: target.workspaceId },
    selection.employee_assignment_id,
    target.employeeInstanceId,
    tx,
  );
  signal.throwIfAborted();
  const [thread] = await tx<{ employee_id: string }[]>`
    select a.employee_id from allrice_chat_sessions t
    join allrice_employee_assignments a on a.id=t.employee_assignment_id
      and a.organization_id=t.organization_id and a.workspace_id=t.workspace_id
      and a.user_id=t.owner_id
    where t.id=${target.threadId} and t.organization_id=${employee.organizationId}
      and t.workspace_id=${employee.workspaceId} and t.owner_id=${employee.ownerId}
      and t.employee_assignment_id=${employee.assignmentId}
      and coalesce(t.employee_instance_id,t.employee_assignment_id)=${employee.id}
      and t.execution_generation='4.0' and t.archived_at is null
    for share of t
  `;
  signal.throwIfAborted();
  if (!thread) throw new DataAccessError('authorization_denied');
  const currentPolicy = await readDEntryReleasePolicy(tx, true);
  signal.throwIfAborted();
  if (
    !hasDEntryPersonRelease(currentPolicy, {
      organizationId: employee.organizationId,
      personId: employee.ownerId,
    })
  )
    throw new DataAccessError('authorization_denied');

  const identity = DEntryIdentitySchema.parse({
    organizationId: employee.organizationId,
    workspaceId: employee.workspaceId,
    personId: employee.ownerId,
    employeeInstanceId: employee.id,
    employeeRevision: employee.revision,
    employeeVersionId: employee.source.employeeVersionId,
    threadId: target.threadId,
  });
  const current = CurrentEmployeeBusinessProjectionSchema.parse({
    scope: {
      organizationId: employee.organizationId,
      workspaceId: employee.workspaceId,
      ownerId: employee.ownerId,
      employeeInstanceId: employee.id,
      employeeId: thread.employee_id,
    },
    threadId: target.threadId,
    access: 'execute',
    executionGeneration: '4.0',
    identityRevisionRef: JSON.stringify({
      instanceRevision: employee.revision,
      employeeVersionId: employee.source.employeeVersionId,
    }),
    module: { ...target.module, applicationModules },
  });
  return { identity, current, releaseRevision: currentPolicy.revision };
}

export async function readLockedNativeMemoryCurrent(
  ...args: Parameters<typeof readLockedNativeMemoryAuthority>
) {
  return (await readLockedNativeMemoryAuthority(...args)).current;
}
