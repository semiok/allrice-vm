import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types';
import type { JobView } from '@deepseek-ai/dsh-api-job-controller/types';
import type { GoalView } from '@deepseek-ai/dsh-goal/types';
import {
  isNativeActivityProjection,
  readNativeProfileActivity,
} from './activity.js';

type Reader = Parameters<typeof readNativeProfileActivity>[0];
const root: SessionSummary = {
  sessionId: 'root' as SessionSummary['sessionId'],
  agentAvailable: true,
  updatedAt: 1,
  running: false,
  blank: false,
};
const signal = new AbortController().signal;
const emptyView = {
  kind: 'sequenced' as const,
  asOfSeq: 1,
  values: { inbox: { 'next-turn': [], 'next-step': [] } },
};
const reads = (override: Partial<Reader> = {}): Reader => ({
  sessions: async () => [root],
  jobs: async () => ({ type: 'rows', jobs: [] }),
  projections: async () => emptyView,
  goal: async () => undefined,
  ...override,
});

describe('public DSH activity sightings', () => {
  it('sees running root and delegated sessions without opening a turn', async () => {
    const jobs = vi.fn();
    const seen = await readNativeProfileActivity(
      reads({
        sessions: async () => [
          { ...root, running: true },
          {
            ...root,
            sessionId: 'child' as SessionSummary['sessionId'],
            parentSessionId: root.sessionId,
            origin: 'subagent',
            running: true,
          },
        ],
        jobs,
      }),
      signal,
    );
    expect(seen).toEqual({
      work: new Set(['turn', 'subagent']),
      complete: false,
    });
    expect(jobs).not.toHaveBeenCalled();
  });

  it.each(['running', 'stopping', 'completed'] as const)(
    'only counts an active background job: %s',
    async (status) => {
      const job: JobView = {
        id: 'bash-test' as JobView['id'],
        kind: 'bash',
        label: 'fixture',
        startedAt: 1,
        status,
        output: { earliest: 0, total: 0 },
      };
      expect(
        await readNativeProfileActivity(
          reads({
            jobs: async () => ({ type: 'rows', jobs: [job] }),
          }),
          signal,
        ),
      ).toEqual({
        work: new Set(status === 'completed' ? [] : ['job']),
        complete: status === 'completed',
      });
    },
  );

  it('finds an older owned Job and joins the cancelled sibling read', async () => {
    const sessions = Array.from({ length: 40 }, (_, index) => ({
      ...root,
      sessionId: String(index) as SessionSummary['sessionId'],
      agentAvailable: false,
    }));
    const last = sessions.at(-1)!.sessionId;
    const job: JobView = {
      id: 'bash-older' as JobView['id'],
      kind: 'bash',
      label: 'fixture',
      startedAt: 1,
      status: 'running',
      output: { earliest: 0, total: 0 },
    };
    const cancelled = vi.fn();
    const seen = await readNativeProfileActivity(
      reads({
        sessions: async () => sessions,
        jobs: async (id) => ({ type: 'rows', jobs: id === last ? [job] : [] }),
        projections: async (id, active) => {
          if (id !== last) return emptyView;
          return new Promise((_, reject) => {
            const stop = () => {
              cancelled();
              reject(active.reason);
            };
            if (active.aborted) stop();
            else active.addEventListener('abort', stop, { once: true });
          });
        },
      }),
      signal,
    );
    expect(seen).toEqual({ work: new Set(['job']), complete: false });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each(['schedule', 'goal'] as const)(
    'reads already queued %s work from a native projection',
    async (kind) => {
      expect(
        await readNativeProfileActivity(
          reads({
            projections: async () => ({
              kind: 'sequenced',
              asOfSeq: 1,
              values: {
                inbox: {
                  'next-turn': [
                    { id: 'native-input', role: 'user', source: { kind } },
                  ],
                  'next-step': [],
                },
              },
            }),
          }),
          signal,
        ),
      ).toEqual({ work: new Set([kind]), complete: false });
    },
  );

  it.each(['armed', 'disarmed'] as const)(
    'only recognizes an armed live goal between turns: %s',
    async (activation) => {
      const goal: GoalView = {
        id: 'goal' as GoalView['id'],
        activation,
        phase: 'active',
        revision: 1,
        objective: 'fixture',
        maxGoalRounds: 4,
        roundsStarted: 1,
        createdAt: 1,
        updatedAt: 1,
      };
      expect(
        await readNativeProfileActivity(
          reads({
            goal: async () => goal,
          }),
          signal,
        ),
      ).toEqual({
        work: new Set(activation === 'armed' ? ['goal'] : []),
        complete: activation === 'disarmed',
      });
    },
  );

  it('does not mistake unavailable or unsequenced reads for work evidence', async () => {
    expect(
      await readNativeProfileActivity(
        reads({
          jobs: async () => {
            throw Error('job roster unavailable');
          },
          projections: async () => ({
            kind: 'migration-required',
            values: {
              inbox: {
                'next-turn': [{ id: 'historical', role: 'user' }],
                'next-step': [],
              },
            },
          }),
        }),
        signal,
      ),
    ).toEqual({ work: new Set(), complete: false });
  });
  it('checks unowned Jobs even when a profile has no sessions', async () => {
    const jobs = vi.fn(async (): ReturnType<Reader['jobs']> => ({
      type: 'rows',
      jobs: [],
    }));
    const options = reads({ sessions: async () => [], jobs });
    await expect(readNativeProfileActivity(options, signal)).resolves.toEqual({
      work: new Set(),
      complete: true,
    });
    expect(jobs).toHaveBeenCalledWith(undefined, signal);
    jobs.mockResolvedValueOnce({
      type: 'rows',
      jobs: [
        {
          id: 'unowned' as JobView['id'],
          kind: 'bash',
          label: 'fixture',
          startedAt: 1,
          status: 'running',
          output: { earliest: 0, total: 0 },
        },
      ],
    });
    await expect(readNativeProfileActivity(options, signal)).resolves.toEqual({
      work: new Set(['job']),
      complete: false,
    });
  });

  it('rejects roster changes during a negative sample', async () => {
    const sessions = vi
      .fn()
      .mockResolvedValueOnce([root])
      .mockResolvedValueOnce([]);
    await expect(
      readNativeProfileActivity(reads({ sessions }), signal),
    ).resolves.toEqual({
      work: new Set(),
      complete: false,
    });
  });

  it('records visible transient work from the existing native control stream', () => {
    expect(isNativeActivityProjection('inbox', emptyView.values.inbox)).toBe(
      false,
    );
    expect(
      isNativeActivityProjection('inbox', {
        'next-turn': [],
        'next-step': [
          { id: 'scheduled', role: 'user', source: { kind: 'schedule' } },
        ],
      }),
    ).toBe(true);
    expect(isNativeActivityProjection('turnOutline', [])).toBe(true);
    expect(isNativeActivityProjection('subagentTiming', {})).toBe(true);
    expect(isNativeActivityProjection('sessionTitle', {})).toBe(false);
  });
});
