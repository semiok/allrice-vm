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
} from '@allrice/database';

const builtinAuthority = createApplicationBuiltinModuleAuthority('web');
const personalMemory = createEmployeeMemoryPort({
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
      );
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
  try {
    return await personalMemory.source(context, target, signal);
  } catch (error) {
    // An archived employee has lost access to its current memory panel.
    if (
      error instanceof EmployeeInstanceError &&
      error.code === 'instance_archived'
    )
      throw new DataAccessError('authorization_denied');
    throw error;
  }
}
