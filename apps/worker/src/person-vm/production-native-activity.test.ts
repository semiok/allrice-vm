import { randomUUID } from 'node:crypto';
import {
  ScheduleId,
  type ScheduleCatalogEntry,
} from '@deepseek-ai/dsh-schedule';
import { SessionId } from '@deepseek-ai/dsh-session';
import { expect, it, vi } from 'vitest';
import { advanceIdleCandidate } from '../../../../packages/person-vm/src/admission-host.js';
import type { NativeWork } from '../native-web/activity.js';
import {
  createProductionNativeActivity,
  getIdleScheduleGuardMs,
} from './production-native-activity.js';

const binding = {
  personId: randomUUID(),
  organizationId: randomUUID(),
  vmId: randomUUID(),
  instanceId: randomUUID(),
  leaseEpoch: 1,
};
const signal = new AbortController().signal;
const period = 60_000;
const idleMs = 20 * period;

function profile() {
  let revision = 0;
  const owner = {
    nativeActivityRevision: () => revision,
    readNativeActivity: vi.fn(async () => ({
      work: new Set<NativeWork>(),
      complete: true,
    })),
    readScheduleCatalog: vi.fn(async (): Promise<ScheduleCatalogEntry[]> => []),
  };
  return {
    owner,
    revoked: signal,
    event: () => revision++,
  };
}

function harness() {
  let mono = 0;
  const now = () => Date.parse('2026-11-26T12:00:00Z') + mono;
  const first = profile();
  const second = profile();
  const catalogs = vi.fn(() => [first, second]);
  const guardMs = getIdleScheduleGuardMs({
    cleanupTimeoutMs: 15_000,
    idleScheduleSafetyMarginMs: 20_000,
  });
  const startup = {
    activityCatalogs: catalogs,
    assertAuthenticatedGroup: () => signal,
  };
  const create = (lifetime = signal) =>
    createProductionNativeActivity(startup, lifetime, {
      sampleIntervalMs: period,
      scheduleGuardMs: guardMs,
      now,
      monotonic: () => mono,
    });
  let instance = new AbortController();
  let activity = create(instance.signal);
  let candidate: ReturnType<typeof advanceIdleCandidate>;
  return {
    first,
    second,
    catalogs,
    guardMs,
    nearWake(offsetMs: number, persistent = false) {
      const rows: ScheduleCatalogEntry[] = [
        {
          id: ScheduleId('scheduled-fixture'),
          sessionId: SessionId('session'),
          kind: 'at',
          status: 'active',
          scheduledAt: new Date(now() + offsetMs).toISOString(),
          title: 'synthetic',
          prompt: 'synthetic',
        },
      ];
      if (persistent) second.owner.readScheduleCatalog.mockResolvedValue(rows);
      else second.owner.readScheduleCatalog.mockResolvedValueOnce(rows);
    },
    restart() {
      instance.abort();
      instance = new AbortController();
      activity = create(instance.signal);
      // Even a caller holding its old candidate cannot carry it into a new owner.
    },
    assertDispatch(
      cursor: NonNullable<
        Awaited<ReturnType<typeof activity.observe>>['coverage']['cursor']
      >,
    ) {
      activity.assertSampleCurrent(binding, cursor, signal);
    },
    async sample(slot: number, purpose?: 'stop-guard') {
      mono = slot * period;
      const snapshot = await activity.observe(binding, signal, purpose);
      const latest = advanceIdleCandidate(
        candidate,
        binding,
        [snapshot.coverage],
        [snapshot.coverage.cursor?.revision],
        null,
        mono,
      );
      const eligible = latest !== undefined && mono - latest.mono >= idleMs;
      if (!purpose) candidate = latest;
      return { snapshot, eligible };
    },
  };
}

it('gives the real admission candidate a complete 20-minute window, after the last slot', async () => {
  const h = harness();
  for (let slot = 0; slot < 20; slot++) {
    const result = await h.sample(slot);
    expect(result.snapshot.coverage.state).toBe('sampled');
    expect(result.eligible).toBe(false);
  }
  const last = await h.sample(20);
  expect(last.eligible).toBe(true);
  expect(last.snapshot).toMatchObject({
    status: 'idle',
    activity: { state: 'known', binding },
    activeScheduleDeliveries: 0,
    coverage: { state: 'sampled', idleSince: '2026-11-26T12:00:00.000Z' },
  });
  expect((await h.sample(20.02, 'stop-guard')).eligible).toBe(true);
});

it.each(['sample', 'control event'] as const)(
  'restarts the clock when busy evidence comes from a %s',
  async (kind) => {
    const h = harness();
    for (let slot = 0; slot < 20; slot++) await h.sample(slot);
    if (kind === 'sample')
      h.second.owner.readNativeActivity.mockResolvedValueOnce({
        work: new Set(['job', 'subagent', 'schedule']),
        complete: false,
      });
    else h.second.event();
    expect(await h.sample(20)).toMatchObject({
      eligible: false,
      snapshot: { status: 'busy', coverage: { state: 'unknown' } },
    });
    for (let slot = 21; slot <= 40; slot++)
      expect((await h.sample(slot)).eligible).toBe(false);
    expect((await h.sample(41)).eligible).toBe(true);
  },
);

it.each([false, true])(
  'restarts after a missed slot with an intervening guard: %s',
  async (guard) => {
    const h = harness();
    for (let slot = 0; slot < 20; slot++) await h.sample(slot);
    if (guard)
      expect((await h.sample(20, 'stop-guard')).snapshot.status).toBe(
        'unknown',
      );
    expect(await h.sample(21)).toMatchObject({
      eligible: false,
      snapshot: {
        coverage: { state: 'sampled', idleSince: '2026-11-26T12:21:00.000Z' },
      },
    });
    for (let slot = 22; slot <= 40; slot++)
      expect((await h.sample(slot)).eligible).toBe(false);
    expect((await h.sample(41)).eligible).toBe(true);
  },
);

it('reserves all three cleanup budgets before the scheduled wake can claim the VM', () => {
  expect(
    getIdleScheduleGuardMs({
      cleanupTimeoutMs: 90_000,
      idleScheduleSafetyMarginMs: 0,
    }),
  ).toBe(285_000);
});

it('blocks an active schedule at the configured inclusive safety boundary', async () => {
  const h = harness();
  h.nearWake(idleMs + h.guardMs + 1, true);
  for (let slot = 0; slot < 20; slot++) await h.sample(slot);
  expect((await h.sample(20)).eligible).toBe(true);
  h.nearWake(h.guardMs);
  expect(await h.sample(20, 'stop-guard')).toMatchObject({
    eligible: false,
    snapshot: { status: 'busy', coverage: { state: 'unknown' } },
  });
});

it('rejects a changed catalog at the final guard, even outside the stop window', async () => {
  const h = harness();
  h.nearWake(idleMs + 10 * period, true);
  for (let slot = 0; slot < 20; slot++) await h.sample(slot);
  expect((await h.sample(20)).eligible).toBe(true);
  h.nearWake(9 * period);
  expect(await h.sample(20, 'stop-guard')).toMatchObject({
    eligible: false,
    snapshot: { status: 'unknown', coverage: { state: 'unknown' } },
  });
});

it('rejects dispatch if a control event arrives after the final live recheck', async () => {
  const h = harness();
  for (let slot = 0; slot <= 20; slot++) await h.sample(slot);
  const checked = await h.sample(20.02, 'stop-guard');
  const cursor = checked.snapshot.coverage.cursor!;
  expect(checked.eligible).toBe(true);
  expect(() => h.assertDispatch(cursor)).not.toThrow();
  h.second.event();
  expect(() => h.assertDispatch(cursor)).toThrow('ACTIVITY_UNKNOWN');
});

it('starts a new window and source identity after Worker restart', async () => {
  const h = harness();
  for (let slot = 0; slot < 20; slot++) await h.sample(slot);
  const previous = (await h.sample(19)).snapshot.coverage.cursor;
  h.restart();
  const next = await h.sample(20);
  expect(next.eligible).toBe(false);
  expect(next.snapshot.coverage.cursor?.sourceId).not.toBe(previous?.sourceId);
  for (let slot = 21; slot < 40; slot++)
    expect((await h.sample(slot)).eligible).toBe(false);
  expect((await h.sample(40)).eligible).toBe(true);
});

it('treats missing evidence as unknown and keeps positive work from another profile', async () => {
  const h = harness();
  h.first.owner.readScheduleCatalog.mockRejectedValueOnce(
    Error('catalog unavailable'),
  );
  expect((await h.sample(0)).snapshot.status).toBe('unknown');

  h.first.owner.readNativeActivity.mockRejectedValueOnce(
    Error('session query unavailable'),
  );
  h.second.owner.readNativeActivity.mockResolvedValueOnce({
    work: new Set(['job', 'schedule']),
    complete: false,
  });
  expect((await h.sample(1)).snapshot).toMatchObject({
    status: 'busy',
    activeScheduleDeliveries: 1,
    activity: { activeJobs: 1 },
  });
  expect((await h.sample(2)).snapshot.status).toBe('idle');
  h.catalogs
    .mockReturnValueOnce([h.first, h.second])
    .mockReturnValueOnce([h.second]);
  expect((await h.sample(3)).snapshot.status).toBe('unknown');
});
