/** Workflow-owned reads for the memory owner's existing caller transaction.
 * Current principal, employee and rollout locks must already be held there. */
import { isDeepStrictEqual } from 'node:util';
import type { Sql, TransactionSql } from 'postgres';
import {
  ApplicationBuiltinModulesProjectionSchema,
  DEntryIdentitySchema,
  UuidSchema,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import { z } from 'zod';
import { DataAccessError } from './data.ts';
import { readLockedDEntryNativeRootPin } from './d-entry-native-root.ts';

const source = 'dsh-native-execution-evidence-v1';
const proofVersion = 'dsh-adopted-text-v1';
const text = z.string().min(1).max(512);
const number = z.number().int().nonnegative();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const adopted = z
  .object({
    kind: z.enum(['ordinary-human-message', 'adopted-steering']),
    occurrence: z
      .object({
        sessionId: text,
        parentSessionId: text.optional(),
        requestId: text,
        scopeId: UuidSchema,
        messageId: text,
        turn: number,
      })
      .strict(),
    sequence: number,
    digest,
  })
  .strict();
const model = z.object({ provider: text, model: text, digest }).strict();
const vm = z
  .object({
    vmId: UuidSchema,
    personId: UuidSchema,
    organizationId: UuidSchema,
    instanceId: UuidSchema,
    leaseEpoch: z.number().int().positive(),
  })
  .strict();
const originSchema = z
  .object({
    source: z.literal(source),
    kind: z.literal('origin'),
    b: UuidSchema,
    originalExecutionId: UuidSchema,
    originalRequestId: text,
    human: adopted,
    rootOriginRef: digest,
    rootSessionRef: text,
    nativeOwnerRef: text,
    nativeProfileRef: text,
    applicationBuild:
      ApplicationBuiltinModulesProjectionSchema.shape.applicationBuild.unwrap(),
    moduleConfigRevisionRef: digest,
    adoptedModelConfiguration: model,
    employeeInstanceId: UuidSchema,
    employeeRelease: UuidSchema,
    employeeRevision: z.number().int().positive(),
    threadId: UuidSchema,
    vm,
  })
  .strict();
const requestSchema = z
  .object({
    source: z.literal(source),
    kind: z.literal('request'),
    b: UuidSchema,
    executionId: UuidSchema,
    gatewayCallId: UuidSchema,
    nativeAttemptId: text,
    nativeCursor: number,
    turn: number,
    adoptedModelConfiguration: model,
    contributingRequestIds: z.array(text),
    human: adopted,
  })
  .strict();
const toolSchema = z
  .object({
    source: z.literal(source),
    kind: z.literal('memory-tool'),
    b: UuidSchema,
    executionId: UuidSchema,
    executionRef: text,
    proofVersion: z.literal(proofVersion),
    tool: z
      .object({
        attemptId: text,
        assistantSequence: number,
        sequence: number,
        callId: text,
        name: z.enum([
          'mcp__allrice__memory_read',
          'mcp__allrice__memory_remember',
        ]),
        executionSessionRef: text,
        executionParentRef: text.nullable(),
        dispatch: z
          .object({ kind: z.literal('sealed-handler'), version: text })
          .strict(),
        human: adopted,
      })
      .strict(),
  })
  .strict();
export type NativeMemoryEvidenceSelection =
  | { mode: 'issue'; runId: string; nativeRequestRef: string }
  | { mode: 'restore'; runId: string }
  | { mode: 'call'; nativeRequestRef: string };

const deny = (): never => {
  throw new DataAccessError('authorization_denied');
};
function requireOne<T>(rows: T[]): T {
  if (rows.length !== 1) return deny();
  return rows[0]!;
}

export async function readLockedNativeMemoryExecutionEvidence(
  tx: Sql | TransactionSql,
  context: RequestContext,
  identity: DEntryIdentity,
  selection: NativeMemoryEvidenceSelection,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  identity = DEntryIdentitySchema.parse(identity);
  const {
    organizationId,
    workspaceId,
    personId,
    threadId,
    employeeInstanceId,
  } = identity;
  if (
    !threadId ||
    context.actor.type !== 'user' ||
    context.actor.id.toLowerCase() !== personId ||
    context.organizationId.toLowerCase() !== organizationId ||
    (context.workspaceId !== null &&
      context.workspaceId.toLowerCase() !== workspaceId)
  )
    return deny();
  const pin = await readLockedDEntryNativeRootPin(tx, identity);
  if (!pin) return deny();
  const live = selection.mode !== 'restore';
  const currentVm = live
    ? requireOne(
        await tx<{ instance_id: string; lease_epoch: string }[]>`
        select instance_id, lease_epoch::text from person_virtual_machines
        where vm_id=${pin.vmId} and organization_id=${organizationId}
          and person_id=${personId} and phase='running'
        for share
      `,
      )
    : null;
  signal.throwIfAborted();

  const nativeRef =
    selection.mode === 'restore'
      ? null
      : UuidSchema.parse(selection.nativeRequestRef);
  const callRow =
    selection.mode === 'call'
      ? requireOne(
          await tx<{ run_id: string; payload: unknown }[]>`
        select run_id,payload from allrice_run_events where id=${nativeRef}
          and organization_id=${organizationId} and workspace_id=${workspaceId}
          and event_type='harness.native'
          and payload @> ${tx.json({ source, kind: 'memory-tool' })}
      `,
        )
      : null;
  const runId =
    selection.mode === 'call'
      ? callRow!.run_id
      : UuidSchema.parse(selection.runId);
  const run = requireOne(
    await tx<{ id: string }[]>`
    select id from allrice_runs
    where id=${runId} and organization_id=${organizationId} and workspace_id=${workspaceId}
      and owner_id=${personId} and visibility='private'
      and execution_spec @> ${tx.json({
        source: 'dsh-native-prompt',
        generation: '4.0',
        threadId,
        employeeInstanceId,
        personId,
        vmId: pin.vmId,
        rootSessionId: pin.rootNativeSessionId,
        ...(selection.mode !== 'restore' && {
          loginSessionId: context.sessionId,
        }),
      })}
      and (execution_spec->>'forkedFromNativeSessionId') is not distinct from ${pin.forkedFromNativeSessionId ?? null}::text
      and (${selection.mode === 'restore'} or state='running')
    for share
  `,
  );
  const original = originSchema.parse(
    requireOne(
      await tx<{ payload: unknown }[]>`
    select payload from allrice_run_events where run_id=${run.id}
      and organization_id=${organizationId} and workspace_id=${workspaceId}
      and event_type='harness.native' and payload @> ${tx.json({ source, kind: 'origin' })}
    limit 2
  `,
    ).payload,
  );
  const human = original.human;
  const originOccurrence = human.occurrence;
  if (
    original.b !== run.id ||
    original.threadId !== threadId ||
    original.employeeInstanceId !== employeeInstanceId ||
    original.vm.vmId !== pin.vmId ||
    original.vm.personId !== personId ||
    original.vm.organizationId !== organizationId ||
    original.rootOriginRef !== pin.rootOriginDigest ||
    original.rootSessionRef !== pin.rootNativeSessionId ||
    human.kind !== 'ordinary-human-message' ||
    originOccurrence.sessionId !== original.rootSessionRef ||
    originOccurrence.parentSessionId !== undefined ||
    originOccurrence.requestId !== original.originalRequestId ||
    (selection.mode === 'issue' && nativeRef !== original.originalExecutionId)
  )
    return deny();
  const [originScope] = await tx`
    select id from allrice_runs where id=${run.id}
      and execution_spec @> ${tx.json({
        employeeRelease: original.employeeRelease,
        adapterId: original.nativeProfileRef,
        nativeRequestId: original.originalRequestId,
      })}
  `;
  if (!originScope) return deny();

  // Root and caller authority are locked through outer commit. Live issuance
  // additionally requires the same VM generation. Stored index recovery is
  // inert and may read the original B after its VM has stopped.
  if (
    currentVm &&
    (identity.employeeVersionId !== original.employeeRelease ||
      identity.employeeRevision !== original.employeeRevision ||
      currentVm.instance_id !== original.vm.instanceId ||
      currentVm.lease_epoch !== String(original.vm.leaseEpoch))
  )
    return deny();

  async function readAttempt(
    executionId: string,
    sessionRef: string,
    parentRef: string | null,
  ) {
    const request = requestSchema.parse(
      requireOne(
        await tx<{ payload: unknown }[]>`
      select payload from allrice_run_events where run_id=${run.id}
        and organization_id=${organizationId} and workspace_id=${workspaceId}
        and event_type='harness.native' and payload @> ${tx.json({ source, kind: 'request', executionId })}
      limit 2
    `,
      ).payload,
    );
    const [step] = await tx`
      select id from allrice_run_events where id=${executionId} and run_id=${run.id}
        and organization_id=${organizationId} and workspace_id=${workspaceId}
        and event_type='step.started' and payload @> ${tx.json({
          source: 'dsh-native-attempt',
          kind: 'assistant',
          sessionId: sessionRef,
          parentSessionId: parentRef,
          profile: original.nativeProfileRef,
          nativeInstanceId: original.nativeOwnerRef,
          vmInstanceId: original.vm.instanceId,
          leaseEpoch: original.vm.leaseEpoch,
          cursor: request.nativeCursor,
          turn: request.turn,
          attemptId: request.nativeAttemptId,
          contributingRequestIds: request.contributingRequestIds,
        })}
    `;
    if (
      !step ||
      request.b !== run.id ||
      request.human.occurrence.turn !== request.turn ||
      request.human.sequence > request.nativeCursor ||
      !request.contributingRequestIds.includes(
        request.human.occurrence.requestId,
      )
    )
      return deny();
    return request;
  }
  const first = await readAttempt(
    original.originalExecutionId,
    original.rootSessionRef,
    null,
  );
  if (
    !isDeepStrictEqual(first.human, human) ||
    !isDeepStrictEqual(
      first.adoptedModelConfiguration,
      original.adoptedModelConfiguration,
    )
  )
    return deny();
  const persistedTool = callRow ? toolSchema.parse(callRow.payload) : null;
  if (persistedTool) {
    const tool = persistedTool.tool;
    const request =
      persistedTool.executionId === first.executionId &&
      tool.executionSessionRef === original.rootSessionRef &&
      tool.executionParentRef === null
        ? first
        : await readAttempt(
            persistedTool.executionId,
            tool.executionSessionRef,
            tool.executionParentRef,
          );
    const roots = await tx<{ ref: string }[]>`
      select payload->>'executionRef' as ref from allrice_run_events
      where run_id=${run.id} and organization_id=${organizationId} and workspace_id=${workspaceId}
        and event_type='harness.native'
        and payload @> ${tx.json({ source, kind: 'memory-root', b: run.id })}
      limit 2
    `;
    if (
      persistedTool.b !== run.id ||
      requireOne(roots).ref !== persistedTool.executionRef ||
      tool.attemptId !== request.nativeAttemptId ||
      tool.assistantSequence <= request.nativeCursor ||
      tool.sequence <= tool.assistantSequence ||
      !isDeepStrictEqual(tool.human, request.human) ||
      tool.human.occurrence.sessionId !== original.rootSessionRef ||
      tool.human.occurrence.parentSessionId !== undefined
    )
      return deny();
  }
  signal.throwIfAborted();
  return { original, first, nativeRequestRef: nativeRef, call: persistedTool };
}
