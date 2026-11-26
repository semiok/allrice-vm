import type { JobListFrame } from '@deepseek-ai/dsh-api-job-controller/types';
import type { GoalView } from '@deepseek-ai/dsh-goal/types';
import type {
  SessionProjectionsValue,
  SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/types';

type SessionId = SessionSummary['sessionId'];
export type NativeWork = 'turn' | 'subagent' | 'job' | 'goal' | 'schedule';

type NativeActivityReads = {
  sessions(signal: AbortSignal): Promise<readonly SessionSummary[]>;
  jobs(id: SessionId, signal: AbortSignal): Promise<JobListFrame>;
  projections(
    id: SessionId,
    signal: AbortSignal,
  ): Promise<SessionProjectionsValue>;
  goal(id: SessionId, signal: AbortSignal): Promise<GoalView | undefined>;
};

function pendingWork(
  projections: SessionProjectionsValue,
): NativeWork | undefined {
  if (projections?.kind !== 'sequenced') return;
  const inbox = projections.values.inbox;
  if (!inbox || typeof inbox !== 'object' || Array.isArray(inbox)) return;
  for (const target of ['next-turn', 'next-step'] as const) {
    const messages = inbox[target];
    if (!Array.isArray(messages) || !messages.length) continue;
    for (const item of messages) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      if (item.role !== 'user' || typeof item.id !== 'string') continue;
      const source = item.source;
      if (source && typeof source === 'object' && !Array.isArray(source)) {
        if (source.kind === 'schedule') return 'schedule';
        if (source.kind === 'goal') return 'goal';
      }
      return 'turn';
    }
  }
}

/** Query known activity without resuming Sessions or draining an Agent. Zero
 * sightings do not cover the process-local goal or schedule delivery drivers. */
export async function readNativeProfileActivity(
  read: NativeActivityReads,
  signal: AbortSignal,
): Promise<ReadonlySet<NativeWork>> {
  signal.throwIfAborted();
  const sessions = await read.sessions(signal);
  signal.throwIfAborted();
  const work = new Set<NativeWork>();
  for (const session of sessions) {
    if (session.running)
      work.add(session.origin === 'subagent' ? 'subagent' : 'turn');
  }
  if (work.size) return work;
  // Prefer loaded Agents, while still checking older Sessions for owned Jobs
  // within the existing deadline. The first positive fact settles the state.
  const ordered = [
    ...sessions.filter(({ agentAvailable }) => agentAvailable),
    ...sessions.filter(({ agentAvailable }) => !agentAvailable),
  ];
  for (const session of ordered) {
    signal.throwIfAborted();
    const settled = new AbortController();
    const current = AbortSignal.any([signal, settled.signal]);
    function found(kind: NativeWork | undefined) {
      if (!kind) return;
      work.add(kind);
      settled.abort();
    }
    await Promise.allSettled([
      read.jobs(session.sessionId, current).then(({ jobs }) => {
        if (
          jobs.some(
            ({ status }) => status === 'running' || status === 'stopping',
          )
        )
          found('job');
      }),
      read
        .projections(session.sessionId, current)
        .then((view) => found(pendingWork(view))),
      session.agentAvailable
        ? read.goal(session.sessionId, current).then((goal) => {
            if (goal?.phase === 'active' && goal.activation === 'armed')
              found('goal');
          })
        : undefined,
    ]);
    signal.throwIfAborted();
    if (work.size) break;
  }
  return work;
}
