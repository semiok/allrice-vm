import type { JobListFrame } from '@deepseek-ai/dsh-api-job-controller/types';
import type { GoalView } from '@deepseek-ai/dsh-goal/types';
import type {
  SessionProjectionsValue,
  SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/types';

type SessionId = SessionSummary['sessionId'];
export type NativeWork = 'turn' | 'subagent' | 'job' | 'goal' | 'schedule';

export type NativeProfileActivity = Readonly<{
  work: ReadonlySet<NativeWork>;
  complete: boolean;
}>;

type NativeActivityReads = {
  sessions(signal: AbortSignal): Promise<readonly SessionSummary[]>;
  jobs(id: SessionId | undefined, signal: AbortSignal): Promise<JobListFrame>;
  projections(
    id: SessionId,
    signal: AbortSignal,
  ): Promise<SessionProjectionsValue>;
  goal(id: SessionId, signal: AbortSignal): Promise<GoalView | undefined>;
};

function pendingWork(inbox: unknown): NativeWork | undefined {
  if (!inbox || typeof inbox !== 'object' || Array.isArray(inbox))
    throw new TypeError('Invalid native inbox');
  for (const target of ['next-turn', 'next-step'] as const) {
    const messages = (inbox as Record<string, unknown>)[target];
    if (!Array.isArray(messages)) throw new TypeError('Invalid native inbox');
    for (const item of messages) {
      if (
        !item ||
        typeof item !== 'object' ||
        item.role !== 'user' ||
        typeof item.id !== 'string'
      )
        throw new TypeError('Invalid native inbox message');
      const source = item.source;
      if (source && typeof source === 'object' && !Array.isArray(source)) {
        if (source.kind === 'schedule') return 'schedule';
        if (source.kind === 'goal') return 'goal';
      }
      return 'turn';
    }
  }
}

/** Positive observations on the existing Host-wide control stream. */
export function isNativeActivityProjection(key: string, value: unknown) {
  if (key === 'turnOutline' || key === 'subagentTiming') return true;
  if (key !== 'inbox') return false;
  try {
    return pendingWork(value) !== undefined;
  } catch {
    // Invalid activity evidence also interrupts the sampling window.
    return true;
  }
}

/** Sample current work without resuming Sessions or draining an Agent. */
export async function readNativeProfileActivity(
  read: NativeActivityReads,
  signal: AbortSignal,
): Promise<NativeProfileActivity> {
  signal.throwIfAborted();
  const sessions = await read.sessions(signal);
  signal.throwIfAborted();
  const work = new Set<NativeWork>();
  for (const session of sessions) {
    if (session.running)
      work.add(session.origin === 'subagent' ? 'subagent' : 'turn');
  }
  if (work.size) return { work, complete: false };
  function hasActiveJob({ jobs }: JobListFrame) {
    return jobs.some(
      ({ status }) => status === 'running' || status === 'stopping',
    );
  }

  // A profile with no sessions still has an unowned Job bucket.
  let complete = true;
  if (sessions.length === 0 && hasActiveJob(await read.jobs(undefined, signal)))
    return { work: new Set(['job']), complete: false };
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
    const reads = await Promise.allSettled([
      read.jobs(session.sessionId, current).then((frame) => {
        if (hasActiveJob(frame)) found('job');
      }),
      read.projections(session.sessionId, current).then((view) => {
        if (view?.kind !== 'sequenced')
          throw new TypeError('Native projections unavailable');
        found(pendingWork(view.values.inbox));
        if (view.values.subagentTiming?.active) found('subagent');
      }),
      session.agentAvailable
        ? read.goal(session.sessionId, current).then((goal) => {
            if (goal?.phase === 'active' && goal.activation === 'armed')
              found('goal');
          })
        : undefined,
    ]);
    signal.throwIfAborted();
    if (work.size) return { work, complete: false };
    if (reads.some(({ status }) => status === 'rejected')) complete = false;
  }
  if (complete) {
    // A Session can attach, disappear or start while the per-session queries
    // run. Bound the observation to unchanged public roster facts.
    const current = await read.sessions(signal);
    signal.throwIfAborted();
    const previous = new Map(
      sessions.map((session) => [session.sessionId, session]),
    );
    for (const session of current) {
      if (session.running)
        work.add(session.origin === 'subagent' ? 'subagent' : 'turn');
      const before = previous.get(session.sessionId);
      if (
        !before ||
        before.agentAvailable !== session.agentAvailable ||
        before.updatedAt !== session.updatedAt
      )
        complete = false;
      previous.delete(session.sessionId);
    }
    complete = complete && previous.size === 0 && work.size === 0;
  }
  return { work, complete };
}
