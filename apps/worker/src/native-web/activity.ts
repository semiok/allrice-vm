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
  // The VM poll has its own deadline. Bound work on a profile with a long
  // history even if every underlying RPC answers immediately.
  for (const session of sessions.slice(0, 32)) {
    signal.throwIfAborted();
    const [jobs, projections, goal] = await Promise.allSettled([
      read.jobs(session.sessionId, signal),
      read.projections(session.sessionId, signal),
      session.agentAvailable ? read.goal(session.sessionId, signal) : undefined,
    ]);
    signal.throwIfAborted();
    if (
      jobs.status === 'fulfilled' &&
      jobs.value.jobs.some(
        ({ status }) => status === 'running' || status === 'stopping',
      )
    )
      work.add('job');
    if (projections.status === 'fulfilled') {
      const pending = pendingWork(projections.value);
      if (pending) work.add(pending);
    }
    if (
      goal.status === 'fulfilled' &&
      goal.value?.phase === 'active' &&
      goal.value.activation === 'armed'
    )
      work.add('goal');
    if (work.size) break;
  }
  return work;
}
