import {
  DEntryIdentitySchema,
  DEntrySelectionInputSchema,
  UuidSchema,
  selectDEntryGeneration,
  type RequestContext,
} from '@allrice/contracts';
import {
  DataAccessError,
  EmployeeInstanceError,
  IdentityError,
  createAssignedChatSession,
  getDatabase,
  getEmployeeInstance,
  readContentPrincipal,
  readDEntryReleasePolicy,
  requireDEntryNativeIdentity,
  resolveEmployeeSessionInstance,
} from '@allrice/database';
import { z } from 'zod';

const employeeSelection = DEntrySelectionInputSchema.omit({ threadId: true });
export const dEntryThreadRequest = z
  .object({ selection: employeeSelection, operationId: UuidSchema.optional() })
  .strict();

/** Bare entry discovers only the current login's explicitly enabled employees. */
export async function findDEntryEmployee(context: RequestContext) {
  if (context.actor.type !== 'user') return null;
  const policy = await readDEntryReleasePolicy();
  const enabled = policy.selections.filter(
    (item) =>
      item.organizationId === context.organizationId &&
      item.personId === context.actor.id &&
      item.generation === '4.0',
  );
  if (!enabled.length) return null;
  const sql = getDatabase();
  const candidates = await sql<{ id: string; workspace_id: string }[]>`
    select id,workspace_id from allrice_employee_instances
    where organization_id=${context.organizationId} and owner_id=${context.actor.id}
      and (${context.workspaceId}::uuid is null or workspace_id=${context.workspaceId})
      and archived_at is null
      and id=any(${sql.array(enabled.map(({ employeeInstanceId }) => employeeInstanceId))}::uuid[])
    order by (kind='general') desc,created_at,id`;
  for (const candidate of candidates) {
    const selection = {
      workspaceId: candidate.workspace_id,
      employeeInstanceId: candidate.id,
    };
    try {
      await requireDEntryNativeIdentity(context, selection);
      return selection;
    } catch (error) {
      if (
        (error instanceof DataAccessError &&
          ['authorization_denied', 'not_found'].includes(error.code)) ||
        (error instanceof IdentityError &&
          error.code === 'authorization_denied') ||
        (error instanceof EmployeeInstanceError &&
          error.code === 'instance_archived')
      )
        continue;
      throw error;
    }
  }
  return null;
}

/** A first entry reopens existing business work, including a thread whose native
 * root has not been pinned yet. Explicit New uses the existing fixed-ID writer. */
export async function openDEntryThread(
  context: RequestContext,
  { selection, operationId }: z.infer<typeof dEntryThreadRequest>,
  signal: AbortSignal,
) {
  if (
    context.actor.type !== 'user' ||
    (context.workspaceId && context.workspaceId !== selection.workspaceId)
  )
    throw new DataAccessError('authorization_denied');
  const scope = { ...context, workspaceId: selection.workspaceId };
  const personId = context.actor.id;
  signal.throwIfAborted();
  return getDatabase().begin(async (tx) => {
    // Use the existing per-user admission lock for simultaneous first entry
    // and explicit fixed-ID retries. Readbacks do not log duplicate creates.
    const principal = await readContentPrincipal(scope, tx, 'update_user');
    if (!principal?.writable) throw new DataAccessError('authorization_denied');
    const candidate = await getEmployeeInstance(
      scope,
      selection.employeeInstanceId,
      tx,
    );
    const instance = await resolveEmployeeSessionInstance(
      scope,
      candidate.assignmentId,
      candidate.id,
      tx,
    );
    const identity = DEntryIdentitySchema.parse({
      organizationId: scope.organizationId,
      workspaceId: selection.workspaceId,
      personId,
      employeeInstanceId: instance.id,
      employeeRevision: instance.revision,
      employeeVersionId: instance.source.employeeVersionId,
      threadId: null,
    });
    const policy = await readDEntryReleasePolicy(tx, true);
    if (selectDEntryGeneration(policy, identity) !== '4.0')
      throw new DataAccessError('authorization_denied');
    signal.throwIfAborted();
    const [existing] = await tx<{ id: string }[]>`
        select id from allrice_chat_sessions
        where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
          and owner_id=${personId}
          and coalesce(employee_instance_id,employee_assignment_id)=${instance.id}
          and execution_generation='4.0' and archived_at is null and visibility='private'
          and (${operationId ?? null}::uuid is null or id=${operationId ?? null}::uuid)
        order by pinned_at desc nulls last,updated_at desc,id desc limit 1`;
    const session =
      existing ??
      (await createAssignedChatSession(
        scope,
        {
          ...selection,
          employeeAssignmentId: instance.assignmentId,
          title: '新建对话',
        },
        { executionGeneration: '4.0', sessionId: operationId },
        tx,
      ));
    if (!(await readContentPrincipal(scope, tx))?.writable)
      throw new DataAccessError('authorization_denied');
    signal.throwIfAborted();
    return { ...selection, threadId: session.id };
  });
}
