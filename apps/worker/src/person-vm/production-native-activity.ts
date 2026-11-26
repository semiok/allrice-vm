import {
  PersonVmError,
  type PersonVmNativeActivityPort,
  type PersonVmBinding,
} from '@allrice/person-vm';
import type { NativeWork } from '../native-web/activity.js';
import type { createAssignedNativeWebStartup } from '../native-web/composition.js';

type NativeStartup = ReturnType<typeof createAssignedNativeWebStartup>;
type Catalog = ReturnType<NativeStartup['catalog']>;
type Startup = Pick<NativeStartup, 'assertAuthenticatedGroup'> & {
  activityCatalogs(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): readonly (Pick<Catalog, 'revoked'> & {
    owner: Pick<Catalog['owner'], 'readNativeActivity'>;
  })[];
};

export function createProductionNativeActivity(
  startup: Startup,
  lifetime: AbortSignal,
) {
  return {
    async observe(binding: PersonVmBinding, signal: AbortSignal) {
      const active = AbortSignal.any([lifetime, signal]);
      let work = new Set<NativeWork>();
      try {
        const owners = startup.activityCatalogs(binding, active);
        const guard = async (current: AbortSignal) => {
          startup.assertAuthenticatedGroup(binding, current);
        };
        const results = await Promise.allSettled(
          owners.map(({ owner, revoked }) =>
            owner.readNativeActivity(guard, AbortSignal.any([active, revoked])),
          ),
        );
        const current = startup.activityCatalogs(binding, active);
        if (
          current.length === owners.length &&
          owners.every(
            ({ owner, revoked }, index) =>
              !revoked.aborted && current[index]?.owner === owner,
          )
        ) {
          for (const result of results)
            if (result.status === 'fulfilled')
              for (const kind of result.value) work.add(kind);
        }
      } catch {
        // An unavailable or superseded roster is never a negative observation.
        work = new Set();
      }
      active.throwIfAborted();
      return {
        status: work.size ? ('busy' as const) : ('unknown' as const),
        activity: {
          binding,
          observedAt: new Date().toISOString(),
          // Counts are positive sightings only. The existing lifecycle
          // contract requires complete known activity before consuming zeros.
          state: 'unknown' as const,
          activeTurns: Number(work.has('turn') || work.has('goal')),
          activeJobs: Number(work.has('job')),
          activeSubtasks: Number(work.has('subagent')),
          pendingApprovals: 0,
        },
        activeScheduleDeliveries: null,
        coverage: {
          state: 'unknown' as const,
          cursor: null,
          reason: 'NATIVE_ACTIVITY_CONTINUITY_UNAVAILABLE',
        },
      };
    },
    async subscribe(_binding: PersonVmBinding, signal: AbortSignal) {
      signal.throwIfAborted();
      lifetime.throwIfAborted();
      // A job or session stream alone cannot latch changes to all families.
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    },
  } satisfies PersonVmNativeActivityPort;
}
