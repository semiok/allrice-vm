/** Memory-owned managed metadata. These persisted locators/proofs are never
 * authority: a pending transition and every issued pin re-read current source
 * permission through the original owner's bound reader. Not a public barrel. */
import {
  AdoptedHumanSourceProjectionSchema,
  EmployeeBusinessScopeProjectionSchema,
  StoredHumanSourceSelectorProjectionSchema,
  UuidSchema,
  type AdoptedHumanSourceProjection,
  type RequestContext,
} from '@allrice/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';
import { DataAccessError } from './data.ts';
import {
  readOrdinaryReadyStorageObject,
  workbenchOriginFileAccess,
} from './workbench-file-access.ts';
import {
  requireMemoryRuntimeAssembly,
  type MemoryRuntimeOwnerReads,
} from './memory-runtime-binding.ts';
import { readLockedNativeMemoryScopeAuthority } from './memory-runtime-current.ts';
import { readWorkflowStoredMemorySource } from './memory-runtime-workflow.ts';
import { ordinaryMemoryPredicate } from './workspace/employee-memory-primitives.ts';
import type { EmployeeMemoryScope } from './workspace/employee-memory.ts';

export const nativeMemoryMetadataKey = 'allriceEmployeeMemoryV4';
export const NativeMemorySourceSchema =
  StoredHumanSourceSelectorProjectionSchema.extend({
    version: z.literal(1),
    canonicalTool: z.literal('workspace.memory.remember'),
    nativeOwnerRef: z.string().min(1),
    nativeProfileRef: z.string().min(1),
    kind: z.enum(['ordinary-human-message', 'adopted-steering']),
    proof: z
      .object({ version: z.string().min(1), digest: z.string().min(1) })
      .strict(),
  }).strict();
export type NativeMemorySource = z.infer<typeof NativeMemorySourceSchema>;

export function nativeMemorySource(
  metadata: unknown,
): NativeMemorySource | null {
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !(nativeMemoryMetadataKey in metadata)
  )
    return null;
  return NativeMemorySourceSchema.parse(
    Reflect.get(metadata, nativeMemoryMetadataKey),
  );
}

export function memoryBusinessScope(scope: EmployeeMemoryScope) {
  return EmployeeBusinessScopeProjectionSchema.parse({
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    ownerId: scope.ownerId,
    employeeInstanceId: scope.instanceId,
    employeeId: scope.employeeId,
  });
}
export function sameMemoryBusinessScope(left: unknown, right: unknown) {
  const a = EmployeeBusinessScopeProjectionSchema.parse(left),
    b = EmployeeBusinessScopeProjectionSchema.parse(right);
  return Object.keys(a).every(
    (key) => Reflect.get(a, key) === Reflect.get(b, key),
  );
}

export async function requireStoredNativeMemorySource(
  reads: Pick<MemoryRuntimeOwnerReads, 'storedSource'>,
  scope: EmployeeMemoryScope,
  origin: { source_type: string; source_id: string | null; metadata: unknown },
  signal: AbortSignal,
) {
  const stored = nativeMemorySource(origin.metadata);
  if (!stored) return false;
  if (
    origin.source_type !== 'message' ||
    origin.source_id !== null ||
    !sameMemoryBusinessScope(stored.scope, memoryBusinessScope(scope))
  )
    throw new DataAccessError('authorization_denied');
  const selector = StoredHumanSourceSelectorProjectionSchema.parse({
    scope: stored.scope,
    threadId: stored.threadId,
    b: stored.b,
    executionBoundaryRef: stored.executionBoundaryRef,
    rootOriginRef: stored.rootOriginRef,
    nativeCall: stored.nativeCall,
    sourceRef: stored.sourceRef,
  });
  const current = AdoptedHumanSourceProjectionSchema.parse(
    await reads.storedSource(selector),
  );
  signal.throwIfAborted();
  const currentSelector = StoredHumanSourceSelectorProjectionSchema.parse({
    scope: current.scope,
    threadId: current.threadId,
    b: current.b,
    executionBoundaryRef: current.executionBoundaryRef,
    rootOriginRef: current.rootOriginRef,
    nativeCall: current.nativeCall,
    sourceRef: current.sourceRef,
  });
  if (
    JSON.stringify(currentSelector) !== JSON.stringify(selector) ||
    current.kind !== stored.kind ||
    current.proof.version !== stored.proof.version ||
    current.proof.digest !== stored.proof.digest
  )
    throw new DataAccessError('authorization_denied');
  return true;
}

type StoredSourceReader = Pick<MemoryRuntimeOwnerReads, 'storedSource'>;

/** Take the current rollout and Session locks before memory-order. The
 * selected metadata is only a locator; promotion verifies the locked row. */
export async function preparePendingNativeMemorySource(
  tx: TransactionSql,
  context: RequestContext,
  scope: EmployeeMemoryScope,
  memoryId: string,
): Promise<StoredSourceReader | undefined> {
  const [origin] = await tx<{ metadata: unknown }[]>`
    select metadata from allrice_memories m where m.id=${memoryId}
      and ${ordinaryMemoryPredicate(tx, scope)} and m.archived_at is null
      and (m.lifecycle_state<>'durable' or m.trust_level<>'user_confirmed')
      and m.metadata ? ${nativeMemoryMetadataKey}`;
  const stored = nativeMemorySource(origin?.metadata);
  if (
    !stored ||
    !UuidSchema.safeParse(stored.b).success ||
    !UuidSchema.safeParse(stored.nativeCall.callRef).success
  )
    return;
  const signal = new AbortController().signal;
  const authority = await readLockedNativeMemoryScopeAuthority(
    tx,
    context,
    {
      workspaceId: scope.workspaceId,
      employeeInstanceId: scope.instanceId,
      threadId: stored.threadId,
    },
    signal,
  );
  return {
    async storedSource(selector) {
      if (selector.threadId !== stored.threadId)
        throw new DataAccessError('authorization_denied');
      return readWorkflowStoredMemorySource(
        tx,
        context,
        authority,
        selector,
        signal,
      );
    },
  };
}

/** Called only after the original management transaction's identity -> memory
 * order -> source/row admission. Original execution liveness is irrelevant;
 * storedSource must independently prove CURRENT permission to that real source. */
export async function requirePendingNativeMemorySource(
  tx: Sql | TransactionSql,
  context: RequestContext,
  scope: EmployeeMemoryScope,
  origin: { source_type: string; source_id: string | null; metadata?: unknown },
  reads?: StoredSourceReader,
) {
  const stored = nativeMemorySource(origin.metadata);
  if (!stored) return false;
  const signal = new AbortController().signal;
  reads ??= await requireMemoryRuntimeAssembly().bind(
    tx,
    context,
    {
      workspaceId: UuidSchema.parse(scope.workspaceId).toLowerCase(),
      employeeInstanceId: UuidSchema.parse(scope.instanceId).toLowerCase(),
      threadId: stored.threadId,
      access: 'management',
      module: { kind: 'not-applicable' },
    },
    signal,
  );
  await requireStoredNativeMemorySource(
    reads,
    scope,
    { ...origin, metadata: origin.metadata },
    signal,
  );
  return true;
}

type LegacyMemoryOrigin = { source_type: string; source_id: string | null };

/** Reuse the pending-memory source owner gate for a pinned legacy Session.
 * Session archive holds a conflicting row lock, including on a stopped VM. */
export async function requireLegacyMemorySessionSource(
  tx: Sql | TransactionSql,
  scope: EmployeeMemoryScope,
  origin: LegacyMemoryOrigin,
) {
  const [source] = await tx`select s.id from allrice_chat_sessions s
    where s.organization_id=${scope.organizationId} and s.workspace_id=${scope.workspaceId}
      and s.owner_id=${scope.ownerId} and coalesce(s.employee_instance_id,s.employee_assignment_id)=${scope.instanceId}
      and s.archived_at is null
      and ((${origin.source_type}='message' and exists(select 1 from allrice_messages m
        where m.id=${origin.source_id} and m.organization_id=s.organization_id and m.workspace_id=s.workspace_id and m.owner_id=s.owner_id and m.session_id=s.id))
        or (${origin.source_type}='checkpoint' and exists(select 1 from allrice_context_checkpoints cp
          where cp.id=${origin.source_id} and cp.organization_id=s.organization_id and cp.workspace_id=s.workspace_id and cp.owner_id=s.owner_id and cp.session_id=s.id)))
    for share of s`;
  if (!source) throw new DataAccessError('authorization_denied');
}

/** Check only resource kinds with a real persisted owner relation. Ordinary
 * self-recorded and opaque tool/connector origins retain owner confirmation. */
export async function requireLegacyMemorySourceForDispatch(
  tx: Sql,
  context: RequestContext,
  scope: EmployeeMemoryScope,
  origin: LegacyMemoryOrigin,
) {
  if (['message', 'checkpoint'].includes(origin.source_type))
    return requireLegacyMemorySessionSource(tx, scope, origin);
  if (origin.source_type === 'file') {
    const who = { ...context, workspaceId: scope.workspaceId };
    const { source_id: id } = origin;
    if (!id || !(await readOrdinaryReadyStorageObject(who, id, tx)))
      throw new DataAccessError('authorization_denied');
    const access = await workbenchOriginFileAccess(who, id, tx, true);
    if (!access.canRead || !(await readOrdinaryReadyStorageObject(who, id, tx)))
      throw new DataAccessError('authorization_denied');
  }
}

export function sourceMetadata(
  source: AdoptedHumanSourceProjection,
  original: { nativeOwnerRef: string; nativeProfileRef: string },
) {
  return NativeMemorySourceSchema.parse({
    version: 1,
    canonicalTool: 'workspace.memory.remember',
    nativeOwnerRef: original.nativeOwnerRef,
    nativeProfileRef: original.nativeProfileRef,
    scope: source.scope,
    threadId: source.threadId,
    b: source.b,
    executionBoundaryRef: source.executionBoundaryRef,
    rootOriginRef: source.rootOriginRef,
    nativeCall: source.nativeCall,
    sourceRef: source.sourceRef,
    kind: source.kind,
    proof: source.proof,
  });
}
