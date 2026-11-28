import type { Sql, TransactionSql } from 'postgres';
import {
  DEntryIdentitySchema,
  DEntrySelectionInputSchema,
  RequestContextSchema,
  selectDEntryGeneration,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError } from './data.ts';
import {
  getEmployeeInstance,
  resolveEmployeeSessionInstance,
} from './employees/employee-instances.ts';
import { readDEntryReleasePolicy } from './d-entry-release-policy.ts';
import {
  authorizeSessionHistoryOwner,
  getSessionExecutionGeneration,
} from './workspace/service.ts';

/** Browser management authority, independent of a VM, B, MCP call or native
 * receipt. Owner ACLs remain responsible for each resource and writable action.
 * Selectors never establish actor, organization, employee ownership or release. */
export async function requireEmployeePanelsAccess(
  contextInput: RequestContext,
  input: unknown,
  transaction?: TransactionSql | Sql,
) {
  const context = RequestContextSchema.parse(contextInput);
  const selection = DEntrySelectionInputSchema.parse(input);
  if (
    context.actor.type !== 'user' ||
    context.workspaceId !== selection.workspaceId
  )
    throw new DataAccessError('authorization_denied');
  let employee = await getEmployeeInstance(
    context,
    selection.employeeInstanceId,
    transaction,
  );
  if (transaction)
    employee = await resolveEmployeeSessionInstance(
      context,
      employee.assignmentId,
      employee.id,
      transaction,
      'read',
    );
  if (
    employee.ownerId !== context.actor.id ||
    employee.organizationId !== context.organizationId ||
    employee.workspaceId !== selection.workspaceId
  )
    throw new DataAccessError('authorization_denied');
  if (selection.threadId) {
    if (transaction) {
      const [thread] = await transaction`select id from allrice_chat_sessions
        where id=${selection.threadId} and organization_id=${context.organizationId}
          and workspace_id=${selection.workspaceId} and owner_id=${context.actor.id}
          and coalesce(employee_instance_id,employee_assignment_id)=${employee.id}
          and execution_generation='4.0' for share`;
      if (!thread) throw new DataAccessError('authorization_denied');
    } else {
      const thread = await authorizeSessionHistoryOwner(
        context,
        selection.workspaceId,
        selection.threadId,
      );
      if (
        (thread.employeeInstanceId ?? thread.employeeAssignmentId) !==
          employee.id ||
        (await getSessionExecutionGeneration(
          context,
          selection.workspaceId,
          selection.threadId,
        )) !== '4.0'
      )
        throw new DataAccessError('authorization_denied');
    }
  }
  const identity = DEntryIdentitySchema.parse({
    organizationId: context.organizationId,
    workspaceId: selection.workspaceId,
    personId: context.actor.id,
    employeeInstanceId: employee.id,
    employeeRevision: employee.revision,
    employeeVersionId: employee.source.employeeVersionId,
    threadId: selection.threadId ?? null,
  });
  if (
    selectDEntryGeneration(
      await readDEntryReleasePolicy(transaction, transaction !== undefined),
      identity,
    ) !== '4.0'
  )
    throw new DataAccessError('authorization_denied');
  return identity;
}
