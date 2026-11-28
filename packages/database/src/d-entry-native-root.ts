import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TransactionSql } from 'postgres';
import {
  ChatSessionSchema,
  DEntryIdentitySchema,
  DEntrySelectionInputSchema,
  UuidSchema,
  sameDEntryIdentity,
  selectDEntryGeneration,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  requireDEntryNativeIdentity,
  resolveDEntryIdentity,
} from './d-entry.ts';
import { readDEntryReleasePolicy } from './d-entry-release-policy.ts';
import {
  getEmployeeInstance,
  resolveEmployeeSessionInstance,
} from './employees/employee-instances.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { createAssignedChatSession } from './workspace/service.ts';

const hostSchema = z
  .object({
    binding: z
      .object({
        organizationId: UuidSchema,
        personId: UuidSchema,
        vmId: z.string().min(1),
        instanceId: z.string().min(1),
        leaseEpoch: z.number().int().positive(),
      })
      .strict(),
    bindingRef: z.string().min(1),
    rosterDigest: z.string().min(1),
  })
  .strict();
const claimSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: DEntryIdentitySchema.extend({ threadId: UuidSchema }),
    host: hostSchema,
    operationId: UuidSchema,
    releaseRevision: z.string().min(1),
    forkedFromNativeSessionId: z.string().min(1).optional(),
  })
  .strict();
const pinSchema = claimSchema.extend({ nativeSessionId: z.string().min(1) });
/** Trusted host invocation result, never HTTP JSON. The owner must issue it
 * only from the actual generated session/create reply on its exact profile.
 * Temporary binding is immutable birth provenance, not a current lease grant. */
export type DEntryNativeRootCreation = Readonly<{
  nativeSessionId: string;
  host: z.infer<typeof hostSchema>;
}>;
/** Current history authority with persistent birth provenance, not a live lease. */
export type DEntryHistoryRootPin = Readonly<{
  identity: DEntryIdentity;
  rootNativeSessionId: string;
  rootOriginDigest: string;
  rootBindingRef: string;
  vmId: string;
  forkedFromNativeSessionId?: string;
}>;
export type DEntryPageForkSource = Readonly<{
  nativeSessionId: string;
  root: DEntryHistoryRootPin;
}>;
const deny = (): never => {
  throw new DataAccessError('authorization_denied');
};
type Sql = ReturnType<typeof getDatabase>;

function projectPin(raw: unknown, identity: DEntryIdentity) {
  const pin = pinSchema.parse(raw);
  const birth = pin.identity;
  // Revision/version/release/instance/epoch at birth remain provenance. Current
  // employee authority is resolved separately; a restart never rewrites this
  // persistent employee-profile/native-root identity.
  if (
    !(
      [
        'organizationId',
        'workspaceId',
        'personId',
        'employeeInstanceId',
        'threadId',
      ] as const
    ).every((key) => birth[key] === identity[key]) ||
    pin.host.binding.organizationId !== identity.organizationId ||
    pin.host.binding.personId !== identity.personId
  )
    return deny();
  return {
    identity,
    rootNativeSessionId: pin.nativeSessionId,
    rootOriginDigest:
      'sha256:' +
      createHash('sha256').update(JSON.stringify(pin)).digest('hex'),
    rootBindingRef: pin.operationId,
    vmId: pin.host.binding.vmId,
    ...(pin.forkedFromNativeSessionId && {
      forkedFromNativeSessionId: pin.forkedFromNativeSessionId,
    }),
  };
}
async function readPin(
  sql: Sql | TransactionSql,
  identity: DEntryIdentity,
  history = false,
  lock = false,
) {
  const [row] = await sql`select d_entry_native_root from allrice_chat_sessions
    where id=${identity.threadId} and organization_id=${identity.organizationId}
      and workspace_id=${identity.workspaceId} and owner_id=${identity.personId}
      and coalesce(employee_instance_id,employee_assignment_id)=${identity.employeeInstanceId}
      and execution_generation='4.0' and (${history} or archived_at is null)
    ${lock ? sql`for share` : sql``}`;
  if (!row) return deny();
  return row.d_entry_native_root == null
    ? null
    : projectPin(row.d_entry_native_root, identity);
}

/** Private evidence reader. The caller supplies its already locked identity. */
export function readLockedDEntryNativeRootPin(
  tx: Sql | TransactionSql,
  identity: DEntryIdentity,
) {
  if (!identity.threadId) return deny();
  return readPin(tx, identity, false, true);
}

/** Cold, owner-only persistent read. Missing/claim-only never creates or wakes. */
export async function getDEntryHistoryRootPin(
  context: RequestContext,
  input: unknown,
): Promise<DEntryHistoryRootPin | null> {
  const selection = DEntrySelectionInputSchema.extend({
    threadId: UuidSchema,
  }).parse(input);
  const identity = await resolveDEntryIdentity(context, selection, 'history');
  return readPin(getDatabase(), identity, true);
}

/** Pure current-authority read; no catalog root selection, boot or repair. */
export async function getDEntryNativeRootPin(
  context: RequestContext,
  input: unknown,
) {
  const identity = await requireDEntryNativeIdentity(context, input);
  if (!identity.threadId) return deny();
  const pin = await readPin(getDatabase(), identity);
  if (!pin) throw Error('NATIVE_QUERY_BINDING_UNAVAILABLE');
  return pin;
}

async function findPageRoot(
  sql: Sql | TransactionSql,
  identity: DEntryIdentity,
  vmId: string,
  nativeSessionId: string,
) {
  const [row] =
    await sql`select id,d_entry_native_root from allrice_chat_sessions
    where organization_id=${identity.organizationId} and workspace_id=${identity.workspaceId}
      and owner_id=${identity.personId} and visibility='private'
      and coalesce(employee_instance_id,employee_assignment_id)=${identity.employeeInstanceId}
      and execution_generation='4.0' and archived_at is null and d_entry_native_root is not null
      and d_entry_native_root#>>'{host,binding,vmId}'=${vmId}
      and d_entry_native_root->>'nativeSessionId'=${nativeSessionId}`;
  return (
    row &&
    projectPin(row.d_entry_native_root, { ...identity, threadId: row.id })
  );
}

/** Resolve a registered native root for page reuse or prompt admission. */
export async function getDEntryPageNativeRoot(
  context: RequestContext,
  identity: DEntryIdentity,
  vmId: string,
  nativeSessionId: string,
) {
  const current = await requireDEntryNativeIdentity(context, {
    workspaceId: identity.workspaceId,
    employeeInstanceId: identity.employeeInstanceId,
    ...(identity.threadId && { threadId: identity.threadId }),
  });
  if (!sameDEntryIdentity(identity, current)) return deny();
  const registered = await findPageRoot(
    getDatabase(),
    identity,
    vmId,
    nativeSessionId,
  );
  if (!registered) return;
  return getDEntryNativeRootPin(context, {
    workspaceId: identity.workspaceId,
    employeeInstanceId: identity.employeeInstanceId,
    threadId: registered.identity.threadId,
  });
}

/** Store a confirmed native create/fork reply against the same existing owner
 * records. Both the claim and its result commit with the new private thread. */
export async function registerDEntryPageNativeRoot(
  context: RequestContext,
  identity: DEntryIdentity,
  receipt: DEntryNativeRootCreation & { forkSource?: DEntryPageForkSource },
  signal: AbortSignal,
) {
  const host = hostSchema.parse(receipt.host);
  const { binding } = host;
  const { forkSource } = receipt;
  const nativeSessionId = z
    .string()
    .min(1)
    .max(256)
    .parse(receipt.nativeSessionId);
  if (
    context.actor.type !== 'user' ||
    context.actor.id !== identity.personId ||
    context.organizationId !== identity.organizationId ||
    context.workspaceId !== identity.workspaceId ||
    binding.personId !== identity.personId ||
    binding.organizationId !== identity.organizationId ||
    forkSource?.nativeSessionId === nativeSessionId
  )
    return deny();
  signal.throwIfAborted();
  return getDatabase().begin(async (tx) => {
    if (!(await readContentPrincipal(context, tx, 'update_user'))?.writable)
      return deny();
    const employee = await getEmployeeInstance(
      context,
      identity.employeeInstanceId,
      tx,
    );
    const instance = await resolveEmployeeSessionInstance(
      context,
      employee.assignmentId,
      employee.id,
      tx,
    );
    if (
      instance.revision !== identity.employeeRevision ||
      instance.source.employeeVersionId !== identity.employeeVersionId
    )
      return deny();
    if (
      identity.threadId &&
      !(
        await tx`select id from allrice_chat_sessions
      where id=${identity.threadId} and owner_id=${identity.personId}
        and organization_id=${identity.organizationId} and workspace_id=${identity.workspaceId}
        and coalesce(employee_instance_id,employee_assignment_id)=${instance.id}
        and execution_generation='4.0' and archived_at is null for share`
      ).length
    )
      return deny();
    const policy = await readDEntryReleasePolicy(tx, true);
    if (selectDEntryGeneration(policy, identity) !== '4.0') return deny();
    const [vm] = await tx`select vm_id from person_virtual_machines
      where person_id=${binding.personId} and organization_id=${binding.organizationId}
        and vm_id=${binding.vmId} and instance_id=${binding.instanceId}
        and lease_epoch=${binding.leaseEpoch} and phase='running' for share`;
    if (!vm) return deny();
    signal.throwIfAborted();
    if (forkSource) {
      const expected = forkSource.root;
      const [row] =
        await tx`select d_entry_native_root from allrice_chat_sessions
        where id=${expected.identity.threadId} and organization_id=${identity.organizationId}
          and workspace_id=${identity.workspaceId} and owner_id=${identity.personId}
          and coalesce(employee_instance_id,employee_assignment_id)=${instance.id}
          and visibility='private' and execution_generation='4.0' and archived_at is null
          and d_entry_native_root is not null for share`;
      if (!row) return deny();
      const current = projectPin(row.d_entry_native_root, {
        ...identity,
        threadId: expected.identity.threadId,
      });
      if (
        current.vmId !== binding.vmId ||
        current.rootNativeSessionId !== expected.rootNativeSessionId ||
        current.rootOriginDigest !== expected.rootOriginDigest ||
        current.rootBindingRef !== expected.rootBindingRef
      )
        return deny();
    }
    const forkedFromNativeSessionId = forkSource?.nativeSessionId;
    const existing = await findPageRoot(
      tx,
      identity,
      binding.vmId,
      nativeSessionId,
    );
    if (existing) {
      if (
        forkSource &&
        forkedFromNativeSessionId !== existing.forkedFromNativeSessionId
      )
        return deny();
      const [row] =
        await tx`select id,employee_assignment_id,employee_version_id,title,
        created_at,updated_at,pinned_at from allrice_chat_sessions
        where id=${existing.identity.threadId} and organization_id=${identity.organizationId}
          and workspace_id=${identity.workspaceId} and owner_id=${identity.personId}
          and coalesce(employee_instance_id,employee_assignment_id)=${identity.employeeInstanceId}
          and execution_generation='4.0' and visibility='private' and archived_at is null for share`;
      if (!row) return deny();
      const thread = ChatSessionSchema.parse({
        id: row.id,
        ownerId: identity.personId,
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        employeeInstanceId: identity.employeeInstanceId,
        employeeAssignmentId: row.employee_assignment_id,
        employeeVersionId: row.employee_version_id,
        title: row.title,
        visibility: 'private',
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        archivedAt: null,
        pinnedAt: row.pinned_at?.toISOString() ?? null,
      });
      return { ...existing, thread };
    }
    const thread = await createAssignedChatSession(
      context,
      {
        workspaceId: identity.workspaceId,
        employeeInstanceId: instance.id,
        employeeAssignmentId: instance.assignmentId,
        title: '新建对话',
      },
      { executionGeneration: '4.0' },
      tx,
    );
    const claim = claimSchema.parse({
      schemaVersion: 1,
      identity: { ...identity, threadId: thread.id },
      host,
      operationId: randomUUID(),
      releaseRevision: policy.revision,
      ...(forkedFromNativeSessionId && { forkedFromNativeSessionId }),
    });
    const pin = pinSchema.parse({ ...claim, nativeSessionId });
    await tx`update allrice_chat_sessions set d_entry_native_root_claim=${tx.json(claim)} where id=${thread.id}`;
    await tx`update allrice_chat_sessions set d_entry_native_root=${tx.json(pin)} where id=${thread.id}`;
    await tx`insert into allrice_audit_events
      (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${identity.organizationId},${identity.workspaceId},${identity.personId},'d_entry_root.bind',
        'chat_session',${thread.id},'recorded',${forkSource ? 'host_native_fork' : 'host_native_create'},
        ${context.requestId},${tx.json({ operationId: claim.operationId, releaseRevision: policy.revision })})`;
    signal.throwIfAborted();
    return { ...projectPin(pin, claim.identity), thread };
  });
}

/** Host-only storage producer. Commit an immutable at-most-once claim BEFORE
 * dispatch. A missing result is unknown, never permission to create again,
 * including the same operationId after a lost commit/reply ACK. No Agent
 * lifecycle, retry, TTL, Run/Job or recovery policy is introduced. */
export async function ensureDEntryNativeRoot(
  context: RequestContext,
  input: unknown,
  expected: DEntryIdentity,
  creation: {
    operationId: string;
    host: DEntryNativeRootCreation['host'];
    signal: AbortSignal;
    create(signal: AbortSignal): Promise<DEntryNativeRootCreation>;
  },
) {
  const selection = DEntrySelectionInputSchema.extend({
    threadId: UuidSchema,
  }).parse(input);
  const operationId = UuidSchema.parse(creation.operationId);
  const host = hostSchema.parse(creation.host);
  const scope = { ...context, workspaceId: selection.workspaceId };
  const current = await requireDEntryNativeIdentity(scope, selection);
  if (
    !sameDEntryIdentity(current, expected) ||
    host.binding.organizationId !== current.organizationId ||
    host.binding.personId !== current.personId
  )
    return deny();
  const active = creation.signal;
  active.throwIfAborted();
  const identity = await requireDEntryNativeIdentity(scope, selection);
  if (!sameDEntryIdentity(identity, expected)) return deny();
  const existing = await readPin(getDatabase(), identity);
  if (existing) {
    if (existing.vmId !== host.binding.vmId) return deny();
    return existing;
  }
  // Current identity → assignment → instance → Session → release locks.
  // Both short transactions recheck authority; neither holds a business
  // pool slot/identity lock across the native call or its real close join.
  const lockCurrent = async (tx: TransactionSql) => {
    const [before] =
      await tx`select employee_assignment_id from allrice_chat_sessions
  where id=${identity.threadId} and organization_id=${identity.organizationId}
    and workspace_id=${identity.workspaceId} and owner_id=${identity.personId}`;
    if (!before) return deny();
    const instance = await resolveEmployeeSessionInstance(
      scope,
      before.employee_assignment_id,
      identity.employeeInstanceId,
      tx,
    );
    if (
      instance.revision !== identity.employeeRevision ||
      instance.source.employeeVersionId !== identity.employeeVersionId
    )
      return deny();
    const [thread] =
      await tx`select id,d_entry_native_root_claim,d_entry_native_root from allrice_chat_sessions
  where id=${identity.threadId} and organization_id=${identity.organizationId}
    and workspace_id=${identity.workspaceId} and owner_id=${identity.personId}
    and employee_assignment_id=${instance.assignmentId}
    and coalesce(employee_instance_id,employee_assignment_id)=${identity.employeeInstanceId}
    and execution_generation='4.0' and native_root_origin is null and archived_at is null
  for update`;
    if (!thread) return deny();
    const policy = await readDEntryReleasePolicy(tx, true);
    if (selectDEntryGeneration(policy, identity) !== '4.0') return deny();
    active.throwIfAborted();
    return { thread, policy };
  };
  // A begin/COMMIT rejection is not proof of rollback. Never dispatch
  // unless this very transaction's success ACK has reached the caller.
  const claim = await getDatabase().begin(async (tx) => {
    const { thread, policy } = await lockCurrent(tx);
    if (thread.d_entry_native_root_claim != null)
      throw Error('D_ENTRY_ROOT_CREATION_UNCONFIRMED');
    const value = claimSchema.parse({
      schemaVersion: 1,
      identity,
      host,
      operationId,
      releaseRevision: policy.revision,
    });
    const [written] =
      await tx`update allrice_chat_sessions set d_entry_native_root_claim=${tx.json(value)}
      where id=${identity.threadId} and d_entry_native_root_claim is null returning id`;
    if (!written) return deny();
    return value;
  });
  active.throwIfAborted();
  // Only this original callback can supply the actual host creation fact.
  // An equal JSON claim on a later request is NOT a creation receipt.
  const receipt = await creation.create(active);
  active.throwIfAborted();
  if (
    JSON.stringify(hostSchema.parse(receipt.host)) !==
    JSON.stringify(claim.host)
  )
    return deny();
  return getDatabase().begin(async (tx) => {
    const { thread, policy } = await lockCurrent(tx);
    if (thread.d_entry_native_root != null) return deny();
    const pin = pinSchema.parse({
      ...claim,
      nativeSessionId: receipt.nativeSessionId,
    });
    projectPin(pin, identity); // Also binds the receipt's person/organization.
    const [written] =
      await tx`update allrice_chat_sessions set d_entry_native_root=${tx.json(pin)}
  where id=${identity.threadId} and d_entry_native_root is null
    and d_entry_native_root_claim=${tx.json(claim)} returning id`;
    if (!written) return deny();
    await tx`insert into allrice_audit_events
  (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
  values(${identity.organizationId},${identity.workspaceId},${identity.personId},'d_entry_root.bind',
    'chat_session',${identity.threadId},'recorded','host_native_create',${context.requestId},
    ${tx.json({ operationId, releaseRevision: policy.revision })})`;
    return projectPin(pin, identity);
  });
}
