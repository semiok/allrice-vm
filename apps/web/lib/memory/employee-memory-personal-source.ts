import {
  MemoryDetailQueryProjectionSchema,
  type MemoryDetailQueryProjection,
  type RequestContext,
} from '@allrice/contracts';
import {
  createApplicationBuiltinModuleAuthority,
  createEmployeeMemoryPort,
  DataAccessError,
  EmployeeInstanceError,
  resolveDEntryIdentity,
  readApplicationBuiltinModules,
} from '@allrice/database';

function denyArchivedEmployee(error: unknown): never {
  if (
    error instanceof EmployeeInstanceError &&
    error.code === 'instance_archived'
  )
    throw new DataAccessError('authorization_denied');
  throw error;
}

/** Mutation owners already check current identity, assignment and instance
 * inside the writer transaction, including the legacy general-instance alias. */
export async function requireEmployeeMemoryModule(signal: AbortSignal) {
  signal.throwIfAborted();
  const { builtinModules } = await readApplicationBuiltinModules('web');
  signal.throwIfAborted();
  if (builtinModules['employee-memory'] !== true)
    throw new DataAccessError('authorization_denied');
}

const builtinAuthority = createApplicationBuiltinModuleAuthority('web');
export const personalEmployeeMemory = createEmployeeMemoryPort({
  qualification: {
    async requireCurrentAccess(context, target, signal) {
      // Without a thread, the existing read identity still requires a current
      // employee instance and assignment. This management read needs no VM.
      const identity = await resolveDEntryIdentity(
        context,
        {
          workspaceId: target.workspaceId.toLowerCase(),
          employeeInstanceId: target.instanceId.toLowerCase(),
        },
        'history',
      ).catch(denyArchivedEmployee);
      await builtinAuthority.require(
        { context, identity, moduleId: 'employee-memory' },
        signal,
      );
    },
  },
});

export async function readPersonalEmployeeMemorySource(
  context: RequestContext,
  input: MemoryDetailQueryProjection,
  signal: AbortSignal,
) {
  const target = MemoryDetailQueryProjectionSchema.parse(input);
  return personalEmployeeMemory
    .source(context, target, signal)
    .catch(denyArchivedEmployee);
}
