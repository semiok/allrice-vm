import { z } from 'zod';
import { UuidSchema, type RequestContext } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { getDEntryNativeRootPin } from './d-entry-native-root.ts';

const ids = z.object({ runId: UuidSchema, executionId: UuidSchema }).strict();
const prompt = z
  .object({
    generation: z.literal('4.0'),
    source: z.literal('dsh-native-prompt'),
    threadId: UuidSchema,
    employeeInstanceId: UuidSchema,
    employeeRelease: UuidSchema,
    personId: UuidSchema,
    vmId: z.string().min(1),
    rootSessionId: z.string().min(1),
    adapterId: z.string().min(1),
    loginSessionId: UuidSchema,
    nativeRequestId: z.string().min(1),
  })
  .strict();
const attempt = z
  .object({
    source: z.literal('dsh-native-attempt'),
    profile: z.string().min(1),
    sessionId: z.string().min(1),
    parentSessionId: z.string().nullable(),
    nativeInstanceId: z.string().min(1),
    vmInstanceId: z.string().min(1),
    leaseEpoch: z.number().int().positive(),
    attemptId: z.string().min(1),
    kind: z.enum(['assistant', 'compaction', 'session-title']),
    cursor: z.number().int().nonnegative(),
    turn: z.number().int().nullable(),
    contributingRequestIds: z.array(z.string().min(1)),
  })
  .strict();

/** The two IDs stored by the model ledger refer to an actual DSH prompt
 * projection and its observed execution event. The 3.x Run/Job reader is
 * intentionally independent of this 4.0 audit path. */
export async function readDEntryNativeExecution(
  context: RequestContext,
  input: z.infer<typeof ids>,
  signal: AbortSignal,
) {
  const { runId, executionId } = ids.parse(input);
  if (context.actor.type !== 'user' || !context.workspaceId)
    throw new DataAccessError('authorization_denied');
  const scope = { workspaceId: context.workspaceId, userId: context.actor.id };
  signal.throwIfAborted();
  const query = async () => {
    const [row] =
      await getDatabase()`select r.state, r.execution_spec as prompt, e.payload as attempt
      from allrice_runs r
      join allrice_run_events e on e.run_id=r.id and e.id=${executionId} and e.event_type='step.started'
      where r.id=${runId} and r.organization_id=${context.organizationId}
        and r.workspace_id=${scope.workspaceId} and r.owner_id=${scope.userId}
        and r.execution_spec->>'source'='dsh-native-prompt'`;
    if (!row) throw new DataAccessError('not_found');
    return {
      state: String(row.state),
      prompt: prompt.parse(row.prompt),
      attempt: attempt.parse(row.attempt),
    };
  };
  const before = await query();
  const root = await getDEntryNativeRootPin(context, {
    workspaceId: scope.workspaceId,
    employeeInstanceId: before.prompt.employeeInstanceId,
    threadId: before.prompt.threadId,
  });
  if (
    root.vmId !== before.prompt.vmId ||
    root.rootNativeSessionId !== before.prompt.rootSessionId ||
    root.identity.employeeVersionId !== before.prompt.employeeRelease
  )
    throw new DataAccessError('authorization_denied');
  signal.throwIfAborted();
  const current = await query();
  signal.throwIfAborted();
  if (
    JSON.stringify(current.prompt) !== JSON.stringify(before.prompt) ||
    JSON.stringify(current.attempt) !== JSON.stringify(before.attempt)
  )
    throw new DataAccessError('authorization_denied');
  return Object.freeze({ runId, executionId, ...current });
}
