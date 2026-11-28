import {
  DEntryIdentitySchema,
  DEntrySelectionInputSchema,
  hasDEntryPersonRelease,
  sameDEntryIdentity,
  selectDEntryGeneration,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError } from './data.ts';
import {
  authorizeSessionHistoryOwner,
  authorizeSessionOwner,
  getSessionExecutionGeneration,
  readDEntrySidebarSessionPage,
} from './workspace/service.ts';
import {
  getEmployeeInstance,
  getEmployeeInstanceForHistory,
  listEmployeeInstances,
} from './employees/employee-instances.ts';
import { requireCurrentWorkspaceWriteAuthority } from './identity.ts';
import { readDEntryReleasePolicy } from './d-entry-release-policy.ts';
import { getDatabase } from './core/client.ts';

const identityServices = {
  authorizeSessionHistoryOwner,
  authorizeSessionOwner,
  getEmployeeInstance,
  getEmployeeInstanceForHistory,
  requireCurrentWorkspaceWriteAuthority,
};

/** Host composition seam, not an authentication API. Both HTTP adapters obtain
 * context from the original session before calling the same current authority. */
export function createDEntryIdentityResolver(services = identityServices) {
  return async function resolveDEntryIdentity(
    context: RequestContext,
    input: unknown,
    access: 'history' | 'execute',
  ): Promise<DEntryIdentity> {
    const selection = DEntrySelectionInputSchema.parse(input);
    if (
      context.actor.type !== 'user' ||
      (context.workspaceId !== null &&
        context.workspaceId !== selection.workspaceId)
    )
      throw new DataAccessError('authorization_denied');
    const scope = { ...context, workspaceId: selection.workspaceId };
    const thread = selection.threadId
      ? await (
          access === 'history'
            ? services.authorizeSessionHistoryOwner
            : services.authorizeSessionOwner
        )(scope, selection.workspaceId, selection.threadId)
      : null;
    if (
      thread &&
      (thread.employeeInstanceId ?? thread.employeeAssignmentId) !==
        selection.employeeInstanceId
    )
      throw new DataAccessError('authorization_denied');
    const employee = await (
      thread && access === 'history'
        ? services.getEmployeeInstanceForHistory
        : services.getEmployeeInstance
    )(scope, selection.employeeInstanceId);
    if (
      employee.ownerId !== context.actor.id ||
      employee.organizationId !== context.organizationId ||
      employee.workspaceId !== selection.workspaceId
    )
      throw new DataAccessError('authorization_denied');
    if (access === 'execute')
      await services.requireCurrentWorkspaceWriteAuthority(
        scope,
        selection.workspaceId,
      );
    return DEntryIdentitySchema.parse({
      organizationId: context.organizationId,
      workspaceId: employee.workspaceId,
      personId: context.actor.id,
      employeeInstanceId: employee.id,
      employeeRevision: employee.revision,
      employeeVersionId: employee.source.employeeVersionId,
      threadId: thread?.id ?? null,
    });
  };
}

export const resolveDEntryIdentity = createDEntryIdentityResolver();

/** VM-live reads also require current write eligibility and explicit release.
 * Cold history uses resolveDEntryIdentity(..., 'history') and never enters here. */
export async function requireDEntryNativeIdentity(
  context: RequestContext,
  input: unknown,
) {
  const identity = await resolveDEntryIdentity(context, input, 'execute');
  const policy = await readDEntryReleasePolicy();
  if (
    selectDEntryGeneration(policy, identity) !== '4.0' ||
    (identity.threadId &&
      (await getSessionExecutionGeneration(
        context,
        identity.workspaceId,
        identity.threadId,
      )) !== '4.0')
  )
    throw new DataAccessError('authorization_denied');
  return identity;
}

/** The authenticated D document owns this directory. The cursor is internal,
 * and every page comes from the same read-only PostgreSQL cut. */
export async function readDEntryEmployeeDirectory(
  context: RequestContext,
  input: unknown,
  signal: AbortSignal,
) {
  const identity = await requireDEntryNativeIdentity(context, input);
  if (!identity.threadId) throw new DataAccessError('not_found');
  signal.throwIfAborted();
  const scope = { ...context, workspaceId: identity.workspaceId };
  const result = await getDatabase().begin(
    'isolation level repeatable read read only',
    async (sql) => {
      const policy = await readDEntryReleasePolicy(sql);
      if (!hasDEntryPersonRelease(policy, identity))
        throw new DataAccessError('authorization_denied');
      const instances = await listEmployeeInstances(
        scope,
        identity.workspaceId,
        sql,
      );
      if (!instances.some(({ id }) => id === identity.employeeInstanceId))
        throw new DataAccessError('authorization_denied');
      signal.throwIfAborted();
      // The inventory already checked the owned live instances in this cut.
      // Qualify the current assignments together using the same owner,
      // employee, release and version predicates as the individual reads.
      const versions = await sql<
        {
          assignment_id: string;
          employee_version_id: string;
          employee_id: string;
          name: string;
          is_default: boolean;
        }[]
      >`
        select a.id assignment_id,a.employee_version_id,v.employee_id,v.name,a.is_default
        from allrice_employee_assignments a
        join allrice_employees e on e.id=a.employee_id
          and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
        join allrice_employee_versions v on v.id=a.employee_version_id
          and v.organization_id=a.organization_id and v.workspace_id=a.workspace_id
        where a.id in ${sql([...new Set(instances.map((row) => row.assignmentId))])}
          and a.organization_id=${identity.organizationId}
          and a.workspace_id=${identity.workspaceId} and a.user_id=${identity.personId}
          and a.active and e.status='active'
          and not exists(select 1 from allrice_platform_employee_tenant_assignments d
            where d.organization_id=a.organization_id and d.workspace_id=a.workspace_id
              and d.tenant_employee_id=a.employee_id and not d.active)`;
      const assignments = new Map(
        versions.map((row) => [row.assignment_id, row]),
      );
      const employees = instances.flatMap((instance) => {
        const version = assignments.get(instance.assignmentId);
        if (
          !version ||
          version.employee_version_id !== instance.source.employeeVersionId
        )
          return [];
        const currentVersion = {
          id: instance.source.employeeVersionId,
          manifest: {
            name: instance.profile.name ?? version.name,
            description: instance.profile.description,
            appearance: instance.profile.appearance,
          },
        };
        return [
          {
            id: instance.assignmentId,
            instanceId: instance.id,
            employeeId: version.employee_id,
            isDefault: version.is_default && instance.kind === 'general',
            currentVersion,
            versions: [currentVersion],
          },
        ];
      });
      const employeeIds = employees.map(({ instanceId }) => instanceId);
      if (!employeeIds.includes(identity.employeeInstanceId))
        throw new DataAccessError('authorization_denied');
      const sessions = [];
      let cursor: string | undefined;
      do {
        signal.throwIfAborted();
        const page = await readDEntrySidebarSessionPage(
          scope,
          identity.workspaceId,
          employeeIds,
          cursor,
          sql,
        );
        sessions.push(...page.sessions);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      if (
        !sessions.some(
          (thread) =>
            thread.id === identity.threadId &&
            (thread.employeeInstanceId ?? thread.employeeAssignmentId) ===
              identity.employeeInstanceId,
        )
      )
        throw new DataAccessError('not_found');
      return { employees, sessions, revision: policy.revision };
    },
  );
  const checked = await requireDEntryNativeIdentity(context, input);
  const currentPolicy = await readDEntryReleasePolicy();
  signal.throwIfAborted();
  if (
    !sameDEntryIdentity(checked, identity) ||
    currentPolicy.revision !== result.revision
  )
    throw new DataAccessError('authorization_denied');
  return {
    organizationId: identity.organizationId,
    workspaceId: identity.workspaceId,
    viewerId: identity.personId,
    employees: result.employees,
    sessions: result.sessions,
  };
}
