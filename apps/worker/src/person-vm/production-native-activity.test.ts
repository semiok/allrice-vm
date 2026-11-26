import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { NativeWork } from '../native-web/activity.js';
import { createProductionNativeActivity } from './production-native-activity.js';

const binding = {
  personId: randomUUID(),
  organizationId: randomUUID(),
  vmId: randomUUID(),
  instanceId: randomUUID(),
  leaseEpoch: 1,
};
const signal = new AbortController().signal;
const profile = (...work: NativeWork[]) => ({
  owner: { readNativeActivity: vi.fn(async () => new Set(work)) },
  revoked: signal,
});

it('sees work in a second employee and never grants continuous idle', async () => {
  const first = profile();
  const second = profile('job', 'subagent', 'schedule');
  const activity = createProductionNativeActivity(
    {
      activityCatalogs: () => [first, second],
      assertAuthenticatedGroup: () => {},
    },
    signal,
  );
  const snapshot = await activity.observe(binding, signal);
  expect(first.owner.readNativeActivity).toHaveBeenCalledOnce();
  expect(second.owner.readNativeActivity).toHaveBeenCalledOnce();
  expect(snapshot).toMatchObject({
    status: 'busy',
    activity: { binding, state: 'unknown', activeJobs: 1, activeSubtasks: 1 },
    activeScheduleDeliveries: null,
    coverage: { state: 'unknown', cursor: null },
  });
});

it('does not accept a stale roster or assume live reads cover a quiet interval', async () => {
  const first = profile();
  const busy = profile('turn');
  const catalogs = vi.fn().mockReturnValue([first]);
  const activity = createProductionNativeActivity(
    {
      activityCatalogs: catalogs,
      assertAuthenticatedGroup: () => {},
    },
    signal,
  );
  expect(await activity.observe(binding, signal)).toMatchObject({
    status: 'unknown',
    coverage: { state: 'unknown' },
  });
  catalogs.mockReturnValueOnce([busy]);
  expect(await activity.observe(binding, signal)).toMatchObject({
    status: 'unknown',
    coverage: { state: 'unknown' },
  });
  await expect(activity.subscribe(binding, signal)).rejects.toMatchObject({
    code: 'ACTIVITY_UNKNOWN',
  });
});
