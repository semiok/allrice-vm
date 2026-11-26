import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types';
import type { JobView } from '@deepseek-ai/dsh-api-job-controller/types';
import type { GoalView } from '@deepseek-ai/dsh-goal/types';
import { readNativeProfileActivity } from './activity.js';

type Reader = Parameters<typeof readNativeProfileActivity>[0];
const root: SessionSummary = {
  sessionId: 'root' as SessionSummary['sessionId'],
  agentAvailable: true,
  updatedAt: 1,
  running: false,
  blank: false,
};
const signal = new AbortController().signal;
const reads = (override: Partial<Reader> = {}): Reader => ({
  sessions: async () => [root],
  jobs: async () => ({ type: 'rows', jobs: [] }),
  projections: async () => null,
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
    expect(seen).toEqual(new Set(['turn', 'subagent']));
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
      ).toEqual(new Set(status === 'completed' ? [] : ['job']));
    },
  );

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
      ).toEqual(new Set([kind]));
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
      ).toEqual(new Set(activation === 'armed' ? ['goal'] : []));
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
    ).toEqual(new Set());
  });
});
