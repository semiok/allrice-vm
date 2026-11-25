import { z } from 'zod';
import {
  RunStatusSchema,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { EmployeeInstanceError } from './employees/employee-instances.ts';
import { IdentityError } from './identity.ts';
import { getDEntryNativeRootPin } from './d-entry-native-root.ts';
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

function currentJournalScope(
  sql: ReturnType<typeof getDatabase>,
  owner: DEntryNativeRunJournalOwner,
) {
  return sql`
    v.vm_id=${owner.vmId} and v.organization_id=${owner.organizationId}
    and v.person_id=${owner.personId} and v.instance_id=${owner.vmInstanceId}
    and v.lease_epoch=${owner.leaseEpoch} and v.phase='running'
    and v.disk_retained and v.lease_owner is null
    and t.workspace_id=${owner.workspaceId} and t.execution_generation='4.0'
    and coalesce(t.employee_instance_id,t.employee_assignment_id)=${owner.employeeInstanceId}
    and t.d_entry_native_root is not null
    and t.d_entry_native_root#>>'{host,binding,vmId}'=${owner.vmId}
    and t.d_entry_native_root#>>'{host,binding,organizationId}'=${owner.organizationId}
    and t.d_entry_native_root#>>'{host,binding,personId}'=${owner.personId}
  `;
}

type ScanCursor = { runId: string; sequence: number };

/** Host-only enumeration for the authenticated owner of the retained disk.
 * Step instance, adapter and native job are the original execution's facts. */
export async function listDEntryNativeRunCandidates(
  owner: DEntryNativeRunJournalOwner,
  after?: ScanCursor,
) {
  const sql = getDatabase();
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
      ${after ? sql`and (r.id,e.sequence) > (${after.runId}::uuid,${after.sequence}::integer)` : sql``}
    order by r.id, e.sequence
    limit 64
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
    last && rows.length === 64
      ? { runId: last.run_id, sequence: last.sequence }
      : undefined;
  return { candidates, next };
}

/** A persisted root and the same current local owner fence the read. This
 * ledger work uses the original scope, even after its login has expired. */
export async function isDEntryNativeRunJournalCurrent(
  candidate: DEntryNativeRunCandidate,
  owner: DEntryNativeRunJournalOwner,
  signal: AbortSignal,
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
  const sql = getDatabase();
  const [row] = await sql`
    select 1 from person_virtual_machines v
    join allrice_chat_sessions t on t.id=${prompt.threadId}
      and t.organization_id=v.organization_id and t.owner_id=v.person_id
    where ${currentJournalScope(sql, owner)}
      and t.d_entry_native_root->>'nativeSessionId'=${prompt.rootSessionId}
  `;
  signal.throwIfAborted();
  return !!row;
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
    signal.throwIfAborted();
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
