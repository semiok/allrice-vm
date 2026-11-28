import { z } from 'zod';
import type { TransactionSql } from 'postgres';
import type { DEntryNativeDeliveryClaim } from './d-entry-native-delivery.ts';
import {
  RunStatusSchema,
  UuidSchema,
  hasDEntryPersonRelease,
  type RequestContext,
} from '@allrice/contracts';
import { readContentPrincipal } from './content-maintenance.ts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { EmployeeInstanceError } from './employees/employee-instances.ts';
import { IdentityError } from './identity.ts';
import { getDEntryNativeRootPin } from './d-entry-native-root.ts';
import { readDEntryReleasePolicy } from './d-entry-release-policy.ts';
import { mapEvent, type EventRow, type RunRow } from './queue/row-mappers.ts';

const ids = z.object({ runId: UuidSchema, executionId: UuidSchema }).strict();
const prompt = z
  .object({
    generation: z.literal('4.0'),
    source: z.enum(['dsh-native-prompt', 'dsh-native-delegation']),
    threadId: UuidSchema,
    employeeInstanceId: UuidSchema,
    employeeRelease: UuidSchema,
    personId: UuidSchema,
    vmId: z.string().min(1),
    rootSessionId: z.string().min(1),
    adapterId: z.string().min(1),
    loginSessionId: UuidSchema,
    nativeRequestId: z.string().min(1),
    forkedFromNativeSessionId: z.string().min(1).optional(),
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
    directRequestIds: z.array(z.string().min(1)).optional(),
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
        and r.execution_spec->>'generation'='4.0'
        and r.execution_spec->>'source' in ('dsh-native-prompt','dsh-native-delegation')`;
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
    root.forkedFromNativeSessionId !==
      before.prompt.forkedFromNativeSessionId ||
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

/** Public 4.0 projection. Callers resolve current workspace membership first.
 * The immutable execution and login proof stays on the model-audit path. */
export async function readDEntryNativeRunSnapshot(
  context: RequestContext,
  workspaceId: string,
  runId: string,
) {
  if (context.actor.type !== 'user') return undefined;
  const [row] = await getDatabase()<RunRow[]>`
    select r.* from allrice_runs r
    where r.id=${runId} and r.organization_id=${context.organizationId}
      and r.workspace_id=${workspaceId} and r.owner_id=${context.actor.id}
      and r.visibility='private'
      and r.execution_spec->>'generation'='4.0'
      and r.execution_spec->>'source' in ('dsh-native-prompt','dsh-native-delegation')
  `;
  if (!row) return undefined;
  const source = prompt.parse(row.execution_spec);
  const { threadId, employeeInstanceId, employeeRelease } = source;
  const root = await getDEntryNativeRootPin(context, {
    workspaceId,
    threadId,
    employeeInstanceId,
  }).catch((error: unknown) => {
    if (
      (error instanceof DataAccessError &&
        ['not_found', 'authorization_denied'].includes(error.code)) ||
      (error instanceof IdentityError &&
        [
          'authentication_failed',
          'authorization_denied',
          'tenant_context_invalid',
        ].includes(error.code)) ||
      (error instanceof EmployeeInstanceError &&
        error.code === 'instance_archived') ||
      (error instanceof Error &&
        error.message === 'NATIVE_QUERY_BINDING_UNAVAILABLE')
    )
      return null;
    throw error;
  });
  if (
    !root ||
    root.vmId !== source.vmId ||
    root.rootNativeSessionId !== source.rootSessionId ||
    root.identity.employeeVersionId !== employeeRelease
  )
    return undefined;
  return {
    generation: '4.0' as const,
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    status: RunStatusSchema.parse(row.state),
    threadId,
    employeeInstanceId,
    employeeRelease,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Publish the native audit events through the ordinary Run cursor and
 * envelope, with the original event ID and no internal adapter or login IDs. */
export function mapDEntryNativeRunEvent(row: EventRow, threadId: string) {
  const payload =
    row.payload &&
    typeof row.payload === 'object' &&
    !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  const evidence = Object.fromEntries(
    ['executionId', 'kind', 'sessionId', 'turn', 'nativeSequence', 'reason']
      .filter(
        (key) =>
          typeof payload[key] === 'string' || typeof payload[key] === 'number',
      )
      .map((key) => [key, payload[key]]),
  );
  return mapEvent({
    ...row,
    payload: {
      ...evidence,
      source: 'dsh',
      executionGeneration: '4.0',
      conversationId: threadId,
    },
  });
}

export type DEntryNativeRunCandidate = Readonly<{
  runId: string;
  executionId: string;
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  prompt: z.infer<typeof prompt>;
  attempt: z.infer<typeof attempt>;
}>;

export const DEntryNativeTurnEndSchema = z
  .object({
    sessionId: z.string().min(1),
    turn: z.number().int().positive(),
    sequence: z.number().int().positive(),
    reason: z.enum([
      'completed',
      'aborted',
      'interrupted',
      'blocked',
      'error',
      'max-tokens',
    ]),
    occurredAt: z.iso.datetime(),
  })
  .strict();
export type DEntryNativeTurnEnd = z.infer<typeof DEntryNativeTurnEndSchema>;

export type DEntryNativeRunJournalOwner = Readonly<{
  organizationId: string;
  workspaceId: string;
  personId: string;
  vmId: string;
  vmInstanceId: string;
  leaseEpoch: number;
  employeeInstanceId: string;
  employeeRelease: string;
}>;

function matchesRunScope(
  run: DEntryNativeRunCandidate['prompt'],
  execution: DEntryNativeRunCandidate['attempt'],
) {
  if (
    run.adapterId !== execution.profile ||
    !execution.contributingRequestIds.includes(run.nativeRequestId)
  )
    return false;
  const root = execution.sessionId === run.rootSessionId;
  if (run.source === 'dsh-native-prompt')
    return root && execution.parentSessionId === null;
  return (
    execution.kind !== 'session-title' &&
    execution.turn !== null &&
    (root
      ? execution.parentSessionId === null
      : !!execution.parentSessionId &&
        execution.parentSessionId !== execution.sessionId)
  );
}

function belongsToRetainedDisk(
  execution: DEntryNativeRunCandidate['attempt'],
  owner: DEntryNativeRunJournalOwner,
) {
  return (
    execution.leaseEpoch < owner.leaseEpoch ||
    (execution.leaseEpoch === owner.leaseEpoch &&
      execution.vmInstanceId === owner.vmInstanceId)
  );
}

type JournalSql = ReturnType<typeof getDatabase> | TransactionSql;

function currentJournalScope(
  sql: JournalSql,
  owner: DEntryNativeRunJournalOwner,
  leaseOwner?: string,
) {
  return sql`
    v.vm_id=${owner.vmId} and v.organization_id=${owner.organizationId}
    and v.person_id=${owner.personId} and v.instance_id=${owner.vmInstanceId}
    and v.lease_epoch=${owner.leaseEpoch} and v.phase='running'
    and v.disk_retained and v.native_created
    and v.lease_owner is not distinct from ${leaseOwner ?? null}::uuid
    and t.workspace_id=${owner.workspaceId} and t.execution_generation='4.0'
    and t.archived_at is null
    and coalesce(t.employee_instance_id,t.employee_assignment_id)=${owner.employeeInstanceId}
    and t.d_entry_native_root is not null
    and t.d_entry_native_root#>>'{host,binding,vmId}'=${owner.vmId}
    and t.d_entry_native_root#>>'{host,binding,organizationId}'=${owner.organizationId}
    and t.d_entry_native_root#>>'{host,binding,personId}'=${owner.personId}
    and t.d_entry_native_root#>>'{identity,organizationId}'=${owner.organizationId}
    and t.d_entry_native_root#>>'{identity,workspaceId}'=${owner.workspaceId}
    and t.d_entry_native_root#>>'{identity,personId}'=${owner.personId}
    and t.d_entry_native_root#>>'{identity,employeeInstanceId}'=${owner.employeeInstanceId}
    and t.d_entry_native_root#>>'{identity,threadId}'=t.id::text
  `;
}

// The fixed on-disk employee namespace must still match a current assignment.
// This projection intentionally has no account session or browser token.
function retainedJournalProfile(sql: JournalSql, lock = false) {
  return sql`
    select i.id,i.organization_id,i.workspace_id,i.owner_id,a.employee_version_id
    from allrice_employee_instances i
    join allrice_employee_assignments a on a.id=i.assignment_id and a.active
      and a.organization_id=i.organization_id and a.workspace_id=i.workspace_id
      and a.user_id=i.owner_id
    join allrice_employees e on e.id=a.employee_id and e.status='active'
      and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
    join allrice_workspaces w on w.id=i.workspace_id and w.archived_at is null
      and w.organization_id=i.organization_id
    join allrice_organizations o on o.id=i.organization_id and o.archived_at is null
    join allrice_users u on u.id=i.owner_id and u.status='active'
    where i.archived_at is null
      and exists (
        select 1 from allrice_memberships m
        where m.organization_id=i.organization_id and m.user_id=i.owner_id
          and m.active and m.role in ('admin','member')
          and (m.workspace_id is null or m.workspace_id=i.workspace_id)
        ${lock ? sql`for share of m` : sql``}
      )
      and not exists (
        select 1 from allrice_platform_employee_tenant_assignments d
        where d.organization_id=i.organization_id and d.workspace_id=i.workspace_id
          and d.tenant_employee_id=e.id and not d.active
      )
      ${lock ? sql`for share of i,a,e,w,o,u` : sql``}
  `;
}

/** Retry selectors from existing Run and VM rows. The actual guest read still
 * requires the exclusive current lease and an attached running disk. */
export async function nextRetainedDEntryNativeRunJournalOwner(
  after?: DEntryNativeRunJournalOwner,
): Promise<DEntryNativeRunJournalOwner | undefined> {
  const sql = getDatabase();
  const [row] = await sql<
    {
      organization_id: string;
      workspace_id: string;
      person_id: string;
      vm_id: string;
      instance_id: string;
      lease_epoch: number | string;
      employee_instance_id: string;
      employee_version_id: string;
    }[]
  >`
    select distinct v.organization_id, t.workspace_id, v.person_id,
      v.vm_id, v.instance_id, v.lease_epoch, i.id as employee_instance_id,
      i.employee_version_id
    from person_virtual_machines v
    join allrice_chat_sessions t on t.organization_id=v.organization_id
      and t.owner_id=v.person_id and t.execution_generation='4.0'
      and t.d_entry_native_root#>>'{host,binding,vmId}'=v.vm_id::text
    join (${retainedJournalProfile(sql)}) i on i.id=coalesce(t.employee_instance_id,t.employee_assignment_id)
      and i.organization_id=t.organization_id and i.workspace_id=t.workspace_id and i.owner_id=t.owner_id
    join allrice_runs r on r.organization_id=t.organization_id and r.workspace_id=t.workspace_id
      and r.owner_id=t.owner_id and r.state='running' and r.visibility='private'
      and r.execution_spec->>'generation'='4.0'
      and r.execution_spec->>'source' in ('dsh-native-prompt','dsh-native-delegation')
      and r.execution_spec->>'employeeInstanceId'=i.id::text
      and r.execution_spec->>'employeeRelease'=i.employee_version_id::text
      and r.execution_spec->>'vmId'=v.vm_id::text
      and r.execution_spec->>'threadId'=t.id::text
      and r.execution_spec->>'rootSessionId'=t.d_entry_native_root->>'nativeSessionId'
    where v.phase='running' and v.disk_retained and v.lease_owner is null and v.holds='[]'
      and not exists (
        select 1 from person_vm_admission_permits p
        where p.person_id=v.person_id and p.disposition<>'deferred'
      )
      ${after ? sql`and (v.vm_id,t.workspace_id,i.id) > (${after.vmId}::uuid,${after.workspaceId}::uuid,${after.employeeInstanceId}::uuid)` : sql``}
    order by v.vm_id,t.workspace_id,i.id
    limit 1
  `;
  if (!row) return undefined;
  return {
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    personId: row.person_id,
    vmId: row.vm_id,
    vmInstanceId: row.instance_id,
    leaseEpoch: Number(row.lease_epoch),
    employeeInstanceId: row.employee_instance_id,
    employeeRelease: row.employee_version_id,
  };
}

type ScanCursor = { runId: string; sequence: number };

/** Host-only enumeration for the authenticated owner of the retained disk.
 * Step instance, adapter and native job are the original execution's facts. */
export async function listDEntryNativeRunCandidates(
  owner: DEntryNativeRunJournalOwner,
  after?: ScanCursor,
  limit = 64,
  delivery?: Pick<
    DEntryNativeDeliveryClaim,
    'sessionId' | 'turn' | 'attemptId' | 'cursor'
  >,
  sql = getDatabase(),
) {
  const rows = await sql<
    {
      run_id: string;
      execution_id: string;
      sequence: number;
      organization_id: string;
      workspace_id: string;
      owner_id: string;
      prompt: unknown;
      attempt: unknown;
    }[]
  >`
    select r.id as run_id, r.organization_id, r.workspace_id, r.owner_id,
      e.id as execution_id, e.sequence, r.execution_spec as prompt, e.payload as attempt
    from allrice_runs r
    join allrice_run_events e on e.run_id=r.id and e.event_type='step.started'
    join person_virtual_machines v on v.person_id=r.owner_id
      and v.organization_id=r.organization_id
    join allrice_chat_sessions t on t.organization_id=r.organization_id
      and t.workspace_id=r.workspace_id and t.owner_id=r.owner_id
      and t.id::text=r.execution_spec->>'threadId'
      and t.d_entry_native_root->>'nativeSessionId'=r.execution_spec->>'rootSessionId'
    where ${currentJournalScope(sql, owner)}
      and r.organization_id=${owner.organizationId}
      and r.workspace_id=${owner.workspaceId} and r.owner_id=${owner.personId}
      and r.state='running' and r.visibility='private'
      and r.execution_spec @> ${sql.json({
        generation: '4.0',
        personId: owner.personId,
        vmId: owner.vmId,
        employeeInstanceId: owner.employeeInstanceId,
        employeeRelease: owner.employeeRelease,
      })}
      and r.execution_spec->>'source' in ('dsh-native-prompt','dsh-native-delegation')
      and e.payload->>'source'='dsh-native-attempt'
      ${
        delivery
          ? sql`and e.payload @> ${sql.json({
              kind: 'assistant',
              sessionId: delivery.sessionId,
              turn: delivery.turn,
              attemptId: delivery.attemptId,
              cursor: delivery.cursor,
              vmInstanceId: owner.vmInstanceId,
              leaseEpoch: owner.leaseEpoch,
            })}`
          : sql``
      }
      ${after ? sql`and (r.id,e.sequence) > (${after.runId}::uuid,${after.sequence}::integer)` : sql``}
    order by r.id, e.sequence
    limit ${limit}
  `;
  const candidates = rows.flatMap((row): DEntryNativeRunCandidate[] => {
    const source = prompt.safeParse(row.prompt);
    const step = attempt.safeParse(row.attempt);
    if (
      !source.success ||
      !step.success ||
      source.data.personId !== row.owner_id ||
      !matchesRunScope(source.data, step.data) ||
      !belongsToRetainedDisk(step.data, owner)
    )
      return [];
    return [
      {
        runId: row.run_id,
        executionId: row.execution_id,
        organizationId: row.organization_id,
        workspaceId: row.workspace_id,
        ownerId: row.owner_id,
        prompt: source.data,
        attempt: step.data,
      },
    ];
  });
  const last = rows.at(-1);
  const next =
    last && rows.length === limit
      ? { runId: last.run_id, sequence: last.sequence }
      : undefined;
  return { candidates, next };
}

/** A persisted root and the same current local owner fence the read. This
 * ledger work uses the original scope, even after its login has expired. */
async function checkCurrentRunJournal(
  sql: JournalSql,
  candidate: DEntryNativeRunCandidate,
  owner: DEntryNativeRunJournalOwner,
  signal: AbortSignal,
  leaseOwner?: string,
  lock = false,
) {
  signal.throwIfAborted();
  const { prompt } = candidate;
  if (
    candidate.organizationId !== owner.organizationId ||
    candidate.workspaceId !== owner.workspaceId ||
    candidate.ownerId !== owner.personId ||
    prompt.personId !== owner.personId ||
    prompt.vmId !== owner.vmId ||
    prompt.employeeInstanceId !== owner.employeeInstanceId ||
    prompt.employeeRelease !== owner.employeeRelease ||
    !belongsToRetainedDisk(candidate.attempt, owner)
  )
    return false;
  if (lock || leaseOwner) {
    const [profile] = await sql`
      select i.id from (${retainedJournalProfile(sql, lock)}) i
      where i.id=${owner.employeeInstanceId}
        and i.organization_id=${owner.organizationId} and i.workspace_id=${owner.workspaceId}
        and i.owner_id=${owner.personId} and i.employee_version_id=${owner.employeeRelease}
    `;
    if (!profile) return false;
  }
  const [row] = await sql`
    select 1 from person_virtual_machines v
    join allrice_chat_sessions t on t.id=${prompt.threadId}
      and t.organization_id=v.organization_id and t.owner_id=v.person_id
    where ${currentJournalScope(sql, owner, leaseOwner)}
      and t.d_entry_native_root->>'nativeSessionId'=${prompt.rootSessionId}
      and (t.d_entry_native_root->>'forkedFromNativeSessionId') is not distinct from ${prompt.forkedFromNativeSessionId ?? null}::text
      ${lock ? sql`for share of v,t` : sql``}
  `;
  signal.throwIfAborted();
  return !!row;
}

export function isDEntryNativeRunJournalCurrent(
  candidate: DEntryNativeRunCandidate,
  owner: DEntryNativeRunJournalOwner,
  signal: AbortSignal,
  leaseOwner?: string,
) {
  return checkCurrentRunJournal(
    getDatabase(),
    candidate,
    owner,
    signal,
    leaseOwner,
  );
}

/** Live present reads and publishes under the original login, current release
 * policy and exact running VM. The retained-disk ledger may account a terminal
 * event after that login expires. */
export async function assertDEntryNativeDeliveryRun(
  tx: TransactionSql,
  candidate: DEntryNativeRunCandidate,
  owner: DEntryNativeRunJournalOwner,
  signal: AbortSignal,
) {
  const {
    runId,
    executionId,
    organizationId,
    workspaceId,
    ownerId,
    prompt,
    attempt,
  } = candidate;
  if (
    attempt.kind !== 'assistant' ||
    attempt.leaseEpoch !== owner.leaseEpoch ||
    attempt.vmInstanceId !== owner.vmInstanceId ||
    !matchesRunScope(prompt, attempt)
  )
    throw new DataAccessError('not_found');

  signal.throwIfAborted();
  const principal = await readContentPrincipal(
    {
      actor: { type: 'user', id: ownerId },
      organizationId,
      workspaceId,
      sessionId: prompt.loginSessionId,
    },
    tx,
    true,
  );
  if (
    !principal?.writable ||
    !hasDEntryPersonRelease(await readDEntryReleasePolicy(tx, true), {
      organizationId,
      personId: ownerId,
    }) ||
    !(await checkCurrentRunJournal(
      tx,
      candidate,
      owner,
      signal,
      undefined,
      true,
    ))
  )
    throw new DataAccessError('not_found');
  const [row] = await tx`
    select r.id from allrice_runs r
    join allrice_run_events e on e.run_id=r.id and e.id=${executionId}
    where r.id=${runId} and r.organization_id=${organizationId} and r.workspace_id=${workspaceId}
      and r.owner_id=${ownerId} and r.state='running' and r.visibility='private'
      and r.execution_spec=${tx.json(prompt)} and e.event_type='step.started'
      and e.payload=${tx.json(attempt)}
    for share of r,e`;
  if (!row) throw new DataAccessError('not_found');
  signal.throwIfAborted();
}

const outcomes = {
  completed: { state: 'succeeded', event: 'run.succeeded' },
  aborted: { state: 'canceled', event: 'run.canceled' },
  interrupted: { state: 'canceled', event: 'run.canceled' },
  blocked: { state: 'failed', event: 'run.failed' },
  error: { state: 'failed', event: 'run.failed' },
  'max-tokens': { state: 'failed', event: 'run.failed' },
} as const;

/** Trusted Worker only, after a read of the physical native journal.
 * Lock the original running row and its exact execution provenance. Concurrent
 * replay and an uncertain COMMIT can only account one terminal transition. */
export async function publishDEntryNativeRunTerminal(
  candidate: DEntryNativeRunCandidate,
  terminal: DEntryNativeTurnEnd,
  signal: AbortSignal,
  authority: { owner: DEntryNativeRunJournalOwner; leaseOwner?: string },
) {
  const end = DEntryNativeTurnEndSchema.parse(terminal);
  const { runId, executionId, organizationId, workspaceId, ownerId } =
    candidate;
  if (
    candidate.prompt.personId !== ownerId ||
    !matchesRunScope(candidate.prompt, candidate.attempt) ||
    candidate.attempt.sessionId !== end.sessionId ||
    (candidate.attempt.turn !== null && candidate.attempt.turn !== end.turn) ||
    (candidate.attempt.kind !== 'session-title' &&
      (candidate.attempt.turn === null ||
        end.sequence <= candidate.attempt.cursor))
  )
    return false;
  signal.throwIfAborted();
  const { state, event } = outcomes[end.reason];
  return getDatabase().begin(async (tx) => {
    if (
      !(await checkCurrentRunJournal(
        tx,
        candidate,
        authority.owner,
        signal,
        authority.leaseOwner,
        true,
      ))
    )
      return false;
    const [row] = await tx`
      update allrice_runs r set state=${state},
        completed_at=${end.occurredAt},updated_at=clock_timestamp()
      where r.id=${runId} and r.organization_id=${organizationId}
        and r.workspace_id=${workspaceId} and r.owner_id=${ownerId}
        and r.visibility='private' and r.state='running'
        and r.execution_spec=${tx.json(candidate.prompt)}
        and exists (
          select 1 from allrice_run_events e
          where e.id=${executionId} and e.run_id=r.id and e.event_type='step.started'
            and e.payload=${tx.json(candidate.attempt)}
        )
      returning r.id
    `;
    if (!row) return false;
    await tx`
      insert into allrice_run_events
        (organization_id,workspace_id,run_id,sequence,event_type,occurred_at,payload)
      select ${organizationId},${workspaceId},${runId},coalesce(max(sequence)+1,0),
        ${event},${end.occurredAt},${tx.json({
          source: 'dsh-native-turn-end',
          executionId,
          sessionId: end.sessionId,
          turn: end.turn,
          nativeSequence: end.sequence,
          reason: end.reason,
        })}
      from allrice_run_events where run_id=${runId}
    `;
    signal.throwIfAborted();
    return true;
  });
}
