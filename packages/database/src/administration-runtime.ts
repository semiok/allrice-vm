import { UuidSchema, type RequestContext } from '@allrice/contracts';
import { requireCurrentPlatformAdmin } from './platform-authority.ts';
import { listDshRuntimeEventTimeline } from './conversation/conversation-runtime.ts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';

export async function readAdministrationRuntimeTimeline(
  context: RequestContext,
  sessionIdInput: string,
  organizationIdInput: string | null,
) {
  const sessionId = UuidSchema.parse(sessionIdInput).toLowerCase();
  const db = getDatabase();
  await requireCurrentPlatformAdmin(context, db, false);
  const organizationId =
    organizationIdInput === null ? null : UuidSchema.parse(organizationIdInput);
  const [session] = await db<
    {
      organizationId: string;
      workspaceId: string;
      ownerId: string;
      generation: '3.x' | '4.0';
    }[]
  >`
    select s.organization_id as "organizationId", s.workspace_id as "workspaceId",
      s.owner_id as "ownerId", s.execution_generation as generation
    from allrice_chat_sessions s
    join allrice_organizations o on o.id=s.organization_id and o.archived_at is null
    join allrice_workspaces w on w.id=s.workspace_id and w.organization_id=o.id and w.archived_at is null
    where s.id=${sessionId} and s.archived_at is null
      and (${organizationId}::uuid is null or s.organization_id=${organizationId})
  `;
  if (!session) throw new DataAccessError('not_found');
  const timeline =
    session.generation === '4.0'
      ? await nativeAdminTimeline(db, sessionId, session)
      : await listDshRuntimeEventTimeline(sessionId, {
          administrationScope: session,
          database: db,
        });
  await requireCurrentPlatformAdmin(context, db, false);
  return timeline;
}

/** Native execution evidence is projected from the committed Run and its
 * bound lifecycle rows. Guest-supplied payload values never become labels. */
async function nativeAdminTimeline(
  db: ReturnType<typeof getDatabase>,
  sessionId: string,
  scope: { organizationId: string; workspaceId: string; ownerId: string },
) {
  const rows = await db<
    {
      id: string;
      state: string;
      created_at: Date;
      completed_at: Date | null;
      events: { sequence: number; type: string; occurredAt: string }[];
    }[]
  >`
    select r.id,r.state,r.created_at,r.completed_at,ev.events
    from allrice_runs r
    cross join lateral (
      select coalesce(jsonb_agg(jsonb_build_object(
        'sequence',e.sequence, 'type',e.event_type, 'occurredAt',e.occurred_at
      ) order by e.sequence),'[]'::jsonb) events
      from (
        select e.sequence,e.event_type,e.occurred_at from allrice_run_events e
        where e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id
          and ((e.event_type='step.started' and e.payload->>'source'='dsh-native-attempt')
            or (e.event_type in ('run.succeeded','run.failed','run.canceled')
              and e.payload->>'source'='dsh-native-turn-end'))
        order by e.sequence desc limit 150
      ) e
    ) ev
    where r.organization_id=${scope.organizationId} and r.workspace_id=${scope.workspaceId}
      and r.owner_id=${scope.ownerId} and r.execution_spec->>'threadId'=${sessionId}
      and r.execution_spec->>'generation'='4.0'
      and r.execution_spec->>'source' in ('dsh-native-prompt','dsh-native-delegation')
    order by r.created_at desc, r.id desc limit 100
  `;
  const turns = [...rows].reverse().map((row) => ({
    run: {
      id: row.id,
      status: row.state,
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
    },
    userMessage: { text: null, occurredAt: null },
    assistantMessage: { text: null, status: row.state, occurredAt: null },
    usage: null,
    timing: null,
    events: row.events.map(({ sequence, type, occurredAt }) => ({
      id: `${row.id}:${sequence}`,
      key: `${row.id}:${sequence}`,
      runId: row.id,
      sequence,
      kind: 'lifecycle',
      status: type.slice(type.indexOf('.') + 1),
      title: type,
      detail: null,
      occurredAt,
    })),
  }));
  const latest = turns.at(-1)?.run;
  return {
    sessionId,
    turns,
    run: latest ? { id: latest.id, status: latest.status } : null,
  };
}
