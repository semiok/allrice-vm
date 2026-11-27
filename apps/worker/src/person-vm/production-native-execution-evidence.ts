import type { ApplicationBuiltinModulesProjection } from '@allrice/contracts';
import { getDatabase } from '@allrice/database';
import type { ModelCallBinding } from '@allrice/model-gateway';
import type {
  NativeMemoryToolObservation,
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
  moduleConfigRevisionRef: string | null;
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
  | NativeExecutionToolEvidence
  | Readonly<{
      source: typeof nativeExecutionEvidenceSource;
      kind: 'memory-tool';
      b: string;
      executionId: string;
      executionRef: string;
      proofVersion: typeof nativeAdoptedTextProofVersion;
      tool: NativeMemoryToolObservation;
    }>
  | Readonly<{
      source: typeof nativeExecutionEvidenceSource;
      kind: 'memory-root';
      b: string;
      executionRef: string;
    }>;
type Receipt = Readonly<{
  run: Run;
  request: NativeExecutionRequestEvidence;
  origin: NativeExecutionOriginEvidence;
  firstIssue: boolean;
}>;

/** Resolve the original B from the private ledger using the exact old adopted
 * occurrence freshly observed in the live native owner. Never pick latest. */
export async function recoverNativeMemoryRun(
  input: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    loginSessionId: string;
    employeeInstanceId: string;
    employeeRelease: string;
    employeeRevision: number;
    threadId: string;
    rootOriginRef: string;
    nativeOwnerRef: string;
    nativeProfileRef: string;
    vm: ModelCallBinding['vm'];
    moduleConfigRevisionRef: string;
    original: NonNullable<NativeRequestObservation['originalHuman']>;
  },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const sql = getDatabase();
  const human = { ...input.original, kind: 'ordinary-human-message' };
  const matches = await sql<{ id: string }[]>`
    select r.id from allrice_runs r join allrice_run_events e on e.run_id=r.id
      and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id
    where r.organization_id=${input.organizationId} and r.workspace_id=${input.workspaceId}
      and r.owner_id=${input.ownerId} and r.visibility='private' and r.state='running'
      and r.execution_spec @> ${sql.json({
        source: 'dsh-native-prompt',
        generation: '4.0',
        loginSessionId: input.loginSessionId,
        threadId: input.threadId,
        employeeInstanceId: input.employeeInstanceId,
        employeeRelease: input.employeeRelease,
        nativeRequestId: human.occurrence.requestId,
        rootSessionId: human.occurrence.sessionId,
        adapterId: input.nativeProfileRef,
        vmId: input.vm.vmId,
        personId: input.ownerId,
      })}
      and e.event_type='harness.native' and e.payload->>'b'=r.id::text
      and e.payload @> ${sql.json({
        source: nativeExecutionEvidenceSource,
        kind: 'origin',
        human,
        rootOriginRef: input.rootOriginRef,
        rootSessionRef: human.occurrence.sessionId,
        nativeOwnerRef: input.nativeOwnerRef,
        nativeProfileRef: input.nativeProfileRef,
        employeeInstanceId: input.employeeInstanceId,
        employeeRelease: input.employeeRelease,
        employeeRevision: input.employeeRevision,
        threadId: input.threadId,
        moduleConfigRevisionRef: input.moduleConfigRevisionRef,
        vm: input.vm,
        originalRequestId: human.occurrence.requestId,
      })}
      and exists (select 1 from allrice_run_events s where s.run_id=r.id
        and s.event_type='step.started' and s.id::text=e.payload->>'originalExecutionId')
    limit 2`;
  signal.throwIfAborted();
  return matches.length === 1 ? matches[0]!.id : null;
}

async function append(
  tx: TransactionSql,
  run: Run,
  fact: NativeExecutionEvidence,
) {
  const [row] = await tx<
    { id: string }[]
  >`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
    select ${run.organizationId},${run.workspaceId},${run.runId},coalesce(max(sequence)+1,0),
      'harness.native',${tx.json(fact)}
    from allrice_run_events where run_id=${run.runId} returning id`;
  return row!.id;
}

async function lockNativeMemoryRun(tx: TransactionSql, run: Run) {
  const [locked] = await tx`
    select id from allrice_runs where id=${run.runId}
      and organization_id=${run.organizationId} and workspace_id=${run.workspaceId}
      and owner_id=${run.ownerId} and visibility='private' and state='running'
      and execution_spec->>'generation'='4.0' for update`;
  return !!locked;
}

/** Persist the DB's stable reference for B, without retaining the index text.
 * A proven DB restore can fill this receipt after an earlier lost response. */
export async function bindNativeMemoryExecutionRef(
  { run, origin }: Pick<Receipt, 'run' | 'origin'>,
  executionRef: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const accepted = await getDatabase().begin(async (tx) => {
    const locked = await lockNativeMemoryRun(tx, run);
    signal.throwIfAborted();
    if (!locked) return false;
    const [bound] =
      await tx`select id from allrice_run_events where run_id=${run.runId}
      and event_type='harness.native' and payload=${tx.json(origin)}`;
    if (!bound) return false;
    const found = await tx<{ ref: string }[]>`
      select payload->>'executionRef' as ref from allrice_run_events where run_id=${run.runId}
        and event_type='harness.native' and payload->>'source'=${nativeExecutionEvidenceSource}
        and payload->>'kind'='memory-root' and payload->>'b'=${run.runId} limit 2`;
    if (found.length)
      return found.length === 1 && found[0]!.ref === executionRef;
    await append(tx, run, {
      source: nativeExecutionEvidenceSource,
      kind: 'memory-root',
      b: run.runId,
      executionRef,
    });
    signal.throwIfAborted();
    return true;
  });
  signal.throwIfAborted();
  return accepted;
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
  > & { moduleConfigRevisionRef?: string },
  contributingRequestIds: readonly string[],
  alreadyPersisted: boolean,
  originalHuman?: NativeRequestObservation['originalHuman'],
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
          saved.payload.employeeInstanceId !== origin.employeeInstanceId ||
          saved.payload.employeeRelease !== origin.employeeRelease ||
          saved.payload.employeeRevision !== origin.employeeRevision ||
          saved.payload.threadId !== origin.threadId ||
          saved.payload.originalRequestId !== origin.originalRequestId ||
          saved.payload.vm.vmId !== origin.vm.vmId ||
          saved.payload.vm.instanceId !== origin.vm.instanceId ||
          saved.payload.vm.leaseEpoch !== origin.vm.leaseEpoch)
      )
        return null;
      const storedOrigin: NativeExecutionOriginEvidence = saved?.payload ?? {
        ...origin,
        source: nativeExecutionEvidenceSource,
        kind: 'origin',
        b: run.runId,
        originalExecutionId: call.execution.executionId,
        moduleConfigRevisionRef: origin.moduleConfigRevisionRef ?? null,
      };
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
        await append(tx, run, storedOrigin);
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
      const originalMatches =
        !!originalHuman &&
        !!saved?.payload.human &&
        saved.payload.human.kind === 'ordinary-human-message' &&
        saved.payload.human.digest === originalHuman.digest &&
        saved.payload.human.sequence === originalHuman.sequence &&
        saved.payload.human.occurrence.messageId ===
          originalHuman.occurrence.messageId &&
        saved.payload.human.occurrence.scopeId ===
          originalHuman.occurrence.scopeId &&
        saved.payload.human.occurrence.sessionId ===
          originalHuman.occurrence.sessionId &&
        saved.payload.human.occurrence.requestId ===
          originalHuman.occurrence.requestId &&
        saved.payload.human.occurrence.turn === originalHuman.occurrence.turn;
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
        human:
          sameHuman ||
          (originalMatches && origin.human?.kind === 'adopted-steering')
            ? origin.human
            : null,
      };
      const [existing] = await tx<{ exact: boolean }[]>`
      select payload=${tx.json(request)} as exact from allrice_run_events
      where run_id=${run.runId} and event_type='harness.native'
        and payload->>'source'=${nativeExecutionEvidenceSource} and payload->>'kind'='request'
        and payload->>'executionId'=${request.executionId}`;
      const receipt = {
        run,
        request,
        origin: storedOrigin,
        firstIssue: !saved,
      };
      if (existing) return existing.exact ? receipt : null;
      await append(tx, run, request);
      return receipt;
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

/** A sealed tool body waits on this commit before the memory callback can
 * authorize the invocation. The row ID identifies the actual occurrence. */
export async function recordNativeMemoryToolCall(
  { run, request, origin }: Receipt,
  executionRef: string,
  tool: NativeMemoryToolObservation,
  signal: AbortSignal,
) {
  if (
    !origin.moduleConfigRevisionRef ||
    !matchNativeToolObservation(request, tool) ||
    tool.dispatch.kind !== 'sealed-handler' ||
    !['mcp__allrice__memory_read', 'mcp__allrice__memory_remember'].includes(
      tool.name,
    )
  )
    return null;
  const fact = {
    source: nativeExecutionEvidenceSource,
    kind: 'memory-tool',
    b: run.runId,
    executionId: request.executionId,
    executionRef,
    proofVersion: nativeAdoptedTextProofVersion,
    tool,
  } as const;
  signal.throwIfAborted();
  const id = await getDatabase().begin(async (tx) => {
    if (!(await lockNativeMemoryRun(tx, run))) return null;
    signal.throwIfAborted();
    const exact = await tx<{ id: string }[]>`
      select step.id from allrice_run_events step
      where step.id=${request.executionId} and step.run_id=${run.runId}
        and step.organization_id=${run.organizationId} and step.workspace_id=${run.workspaceId}
        and step.event_type='step.started' and step.payload @> ${tx.json({
          source: 'dsh-native-attempt',
          kind: 'assistant',
          sessionId: tool.executionSessionRef,
          parentSessionId: tool.executionParentRef,
          nativeInstanceId: origin.nativeOwnerRef,
          profile: origin.nativeProfileRef,
          vmInstanceId: origin.vm.instanceId,
          leaseEpoch: origin.vm.leaseEpoch,
          attemptId: request.nativeAttemptId,
          cursor: request.nativeCursor,
          turn: request.turn,
        })}
        and (select count(*) from allrice_run_events e where e.run_id=step.run_id
          and e.organization_id=step.organization_id and e.workspace_id=step.workspace_id
          and e.event_type='harness.native' and e.payload=${tx.json(request)})=1
        and (select count(*) from allrice_run_events e where e.run_id=step.run_id
          and e.organization_id=step.organization_id and e.workspace_id=step.workspace_id
          and e.event_type='harness.native' and e.payload=${tx.json(origin)})=1`;
    if (exact.length !== 1) return null;
    const roots = await tx<{ ref: string }[]>`
      select payload->>'executionRef' as ref from allrice_run_events
      where run_id=${run.runId} and organization_id=${run.organizationId}
        and workspace_id=${run.workspaceId} and event_type='harness.native'
        and payload @> ${tx.json({ source: nativeExecutionEvidenceSource, kind: 'memory-root', b: run.runId })}
      limit 2`;
    if (roots.length !== 1 || roots[0]!.ref !== executionRef) return null;
    const existing = await tx<{ id: string; exact: boolean }[]>`
      select id, payload=${tx.json(fact)} as exact from allrice_run_events
      where run_id=${run.runId} and organization_id=${run.organizationId}
        and workspace_id=${run.workspaceId} and event_type='harness.native'
        and payload @> ${tx.json({ source: nativeExecutionEvidenceSource, kind: 'memory-tool', b: run.runId, executionId: request.executionId })}
        and (payload#>>'{tool,callId}'=${tool.callId} or payload#>>'{tool,sequence}'=${String(tool.sequence)})
      limit 2`;
    signal.throwIfAborted();
    if (existing.length)
      return existing.length === 1 && existing[0]!.exact
        ? existing[0]!.id
        : null;
    const id = await append(tx, run, fact);
    signal.throwIfAborted();
    return id;
  });
  signal.throwIfAborted();
  return id;
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
