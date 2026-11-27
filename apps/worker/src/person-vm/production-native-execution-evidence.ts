import type { ApplicationBuiltinModulesProjection } from '@allrice/contracts';
import { getDatabase } from '@allrice/database';
import type { ModelCallBinding } from '@allrice/model-gateway';
import type {
  NativeRequestObservation,
  NativeToolObservation,
} from '../native-web/prompt-observation.js';

type TransactionSql = Parameters<
  Parameters<ReturnType<typeof getDatabase>['begin']>[1]
>[0];

export const nativeExecutionEvidenceSource = 'dsh-native-execution-evidence-v1';
export const nativeAdoptedTextProofVersion = 'dsh-adopted-text-v1';

export type NativeExecutionBuild =
  ApplicationBuiltinModulesProjection['applicationBuild'];

type Run = Readonly<{
  runId: string;
  organizationId: string;
  workspaceId: string;
  ownerId: string;
}>;

export type NativeExecutionOriginEvidence = Readonly<{
  source: typeof nativeExecutionEvidenceSource;
  kind: 'origin';
  b: string;
  originalExecutionId: string;
  originalRequestId: string;
  human: NativeRequestObservation['human'];
  rootOriginRef: string;
  rootSessionRef: string;
  nativeOwnerRef: string;
  nativeProfileRef: string;
  applicationBuild: NativeExecutionBuild;
  moduleConfigRevisionRef: null;
  adoptedModelConfiguration: NativeRequestObservation['request'];
  employeeInstanceId: string;
  employeeRelease: string;
  employeeRevision: number;
  threadId: string;
  vm: ModelCallBinding['vm'];
}>;

export type NativeExecutionRequestEvidence = Readonly<{
  source: typeof nativeExecutionEvidenceSource;
  kind: 'request';
  b: string;
  executionId: string;
  gatewayCallId: string;
  nativeAttemptId: string;
  nativeCursor: number;
  turn: number;
  adoptedModelConfiguration: NativeRequestObservation['request'];
  contributingRequestIds: readonly string[];
  human: NativeRequestObservation['human'];
}>;

export type NativeExecutionToolEvidence = Readonly<{
  source: typeof nativeExecutionEvidenceSource;
  kind: 'tool';
  b: string;
  executionId: string;
  sessionRef: string;
  proofVersion: typeof nativeAdoptedTextProofVersion;
  tool: NativeToolObservation;
}>;

export type NativeExecutionEvidence =
  | NativeExecutionOriginEvidence
  | NativeExecutionRequestEvidence
  | NativeExecutionToolEvidence;
type Receipt = Readonly<{
  run: Run;
  request: NativeExecutionRequestEvidence;
}>;

async function append(
  tx: TransactionSql,
  run: Run,
  fact: NativeExecutionEvidence,
) {
  await tx`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
    select ${run.organizationId},${run.workspaceId},${run.runId},coalesce(max(sequence)+1,0),
      'harness.native',${tx.json(fact)}
    from allrice_run_events where run_id=${run.runId}`;
}

/** Called under the original allrice_runs lock in persistExecution. The
 * locked Run serializes origin, request and tool receipts against Run close.
 * The optional evidence write must never roll back the established audit. */
export async function recordNativeExecutionRequest(
  transaction: TransactionSql,
  run: Run,
  call: ModelCallBinding,
  origin: Omit<
    NativeExecutionOriginEvidence,
    'source' | 'kind' | 'b' | 'originalExecutionId' | 'moduleConfigRevisionRef'
  >,
  contributingRequestIds: readonly string[],
  alreadyPersisted: boolean,
): Promise<Receipt | null> {
  return transaction
    .savepoint(async (tx) => {
      const [saved] = await tx<{ payload: NativeExecutionOriginEvidence }[]>`
      select payload from allrice_run_events
      where run_id=${run.runId} and event_type='harness.native'
        and payload->>'source'=${nativeExecutionEvidenceSource} and payload->>'kind'='origin'`;
      if (
        saved &&
        (saved.payload.b !== run.runId ||
          saved.payload.rootOriginRef !== origin.rootOriginRef ||
          saved.payload.nativeOwnerRef !== origin.nativeOwnerRef ||
          saved.payload.nativeProfileRef !== origin.nativeProfileRef ||
          saved.payload.employeeRelease !== origin.employeeRelease)
      )
        return null;
      if (!saved) {
        if (alreadyPersisted) return null;
        const [oldAttempt] = await tx`
        select id from allrice_run_events
        where run_id=${run.runId} and id<>${call.execution.executionId} and event_type='step.started'
          and payload->>'source'='dsh-native-attempt' and payload->>'kind'='assistant'
        limit 1`;
        // A Run opened by a build without this evidence cannot acquire an
        // original B provenance snapshot on a later model attempt.
        if (oldAttempt) return null;
        await append(tx, run, {
          ...origin,
          source: nativeExecutionEvidenceSource,
          kind: 'origin',
          b: run.runId,
          originalExecutionId: call.execution.executionId,
          moduleConfigRevisionRef: null,
        });
      }
      const sameHuman =
        !saved ||
        (saved.payload.human &&
          origin.human &&
          saved.payload.human.kind === origin.human.kind &&
          saved.payload.human.digest === origin.human.digest &&
          saved.payload.human.sequence === origin.human.sequence &&
          saved.payload.human.occurrence.messageId ===
            origin.human.occurrence.messageId &&
          saved.payload.human.occurrence.scopeId ===
            origin.human.occurrence.scopeId &&
          saved.payload.human.occurrence.requestId ===
            origin.human.occurrence.requestId &&
          saved.payload.human.occurrence.turn ===
            origin.human.occurrence.turn &&
          saved.payload.human.occurrence.sessionId ===
            origin.human.occurrence.sessionId);
      const request: NativeExecutionRequestEvidence = {
        source: nativeExecutionEvidenceSource,
        kind: 'request',
        b: run.runId,
        executionId: call.execution.executionId,
        gatewayCallId: call.native.callId,
        nativeAttemptId: call.native.attemptId!,
        nativeCursor: call.native.attemptCursor!,
        turn: call.native.attemptTurn!,
        contributingRequestIds,
        adoptedModelConfiguration: origin.adoptedModelConfiguration,
        human: sameHuman ? origin.human : null,
      };
      const [existing] = await tx<{ exact: boolean }[]>`
      select payload=${tx.json(request)} as exact from allrice_run_events
      where run_id=${run.runId} and event_type='harness.native'
        and payload->>'source'=${nativeExecutionEvidenceSource} and payload->>'kind'='request'
        and payload->>'executionId'=${request.executionId}`;
      if (existing) return existing.exact ? { run, request } : null;
      await append(tx, run, request);
      return { run, request };
    })
    .catch(() => null);
}

export function matchNativeToolObservation(
  request: NativeExecutionRequestEvidence,
  tool: NativeToolObservation,
) {
  const human = request.human;
  if (
    !human ||
    tool.attemptId !== request.nativeAttemptId ||
    tool.human.kind !== human.kind ||
    tool.human.sequence !== human.sequence ||
    tool.human.digest !== human.digest ||
    tool.assistantSequence <= request.nativeCursor ||
    tool.sequence <= tool.assistantSequence
  )
    return false;
  const actual = tool.human.occurrence;
  const expected = human.occurrence;
  return (
    actual.sessionId === expected.sessionId &&
    actual.parentSessionId === expected.parentSessionId &&
    actual.scopeId === expected.scopeId &&
    actual.requestId === expected.requestId &&
    actual.messageId === expected.messageId &&
    actual.turn === expected.turn &&
    actual.turn === request.turn
  );
}

export async function recordNativeExecutionTool(
  { run, request }: Receipt,
  tool: NativeToolObservation,
  signal: AbortSignal,
) {
  if (!matchNativeToolObservation(request, tool)) return;
  const fact: NativeExecutionToolEvidence = {
    source: nativeExecutionEvidenceSource,
    kind: 'tool',
    b: request.b,
    executionId: request.executionId,
    sessionRef: tool.human.occurrence.sessionId,
    proofVersion: nativeAdoptedTextProofVersion,
    tool,
  };
  signal.throwIfAborted();
  await getDatabase().begin(async (tx) => {
    const [current] = await tx`
      select id from allrice_runs
      where id=${run.runId} and organization_id=${run.organizationId}
        and workspace_id=${run.workspaceId} and owner_id=${run.ownerId}
        and visibility='private' and execution_spec->>'generation'='4.0'
      for update`;
    signal.throwIfAborted();
    if (!current) return;
    const [requestExists] = await tx`
      select id from allrice_run_events
      where run_id=${run.runId} and event_type='harness.native'
        and payload=${tx.json(request)}`;
    if (!requestExists) return;
    const [existing] = await tx`
      select id from allrice_run_events
      where run_id=${run.runId} and event_type='harness.native'
        and payload->>'source'=${nativeExecutionEvidenceSource} and payload->>'kind'='tool'
        and payload->>'executionId'=${request.executionId}
        and payload#>>'{tool,callId}'=${tool.callId}`;
    if (!existing) await append(tx, run, fact);
    signal.throwIfAborted();
  });
}
