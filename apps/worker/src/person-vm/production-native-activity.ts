import { randomUUID } from 'node:crypto';
import {
  PersonVmError,
  sameVmBinding,
  type PersonVmNativeActivityPort,
  type PersonVmBinding,
} from '@allrice/person-vm';
import type { NativeWork } from '../native-web/activity.js';
import type { createAssignedNativeWebStartup } from '../native-web/composition.js';
import { readNativeScheduleObservations } from '../native-schedule-observation.js';
import { earliestNativeScheduleTarget } from './scheduled-wake.js';

type NativeStartup = ReturnType<typeof createAssignedNativeWebStartup>;
type Catalog = ReturnType<NativeStartup['catalog']>;
type ActivityCatalog = Pick<Catalog, 'revoked'> & {
  owner: Pick<
    Catalog['owner'],
    'nativeActivityRevision' | 'readNativeActivity' | 'readScheduleCatalog'
  >;
};
type Startup = Pick<NativeStartup, 'assertAuthenticatedGroup'> & {
  activityCatalogs(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): readonly ActivityCatalog[];
};
type ClockReading = { wall: number; mono: number };
type Window = {
  idleSince: string;
  revision: string;
  lastSlot: number;
  lastSample: ClockReading;
  lastStarted: number;
  revisions: readonly number[];
  scheduleFingerprints: readonly string[];
};
type History = {
  binding: PersonVmBinding;
  catalogs: readonly ActivityCatalog[];
  revoked: AbortSignal;
  forget(): void;
  reading: boolean;
  interrupted: boolean;
  window?: Window;
};

export const DEFAULT_IDLE_SAMPLE_INTERVAL_MS = 60_000;
export const IDLE_RECONCILE_TIMEOUT_MS = 15_000;

export function getIdleScheduleGuardMs(config: {
  cleanupTimeoutMs: number;
  idleScheduleSafetyMarginMs?: number;
}) {
  // Wake cannot claim the VM until stop commits and releases its lease.
  // After the bounded native stop, egress revoke, native retirement and disk
  // detach each have their own sequential cleanup budget in PersonVmService.
  return (
    IDLE_RECONCILE_TIMEOUT_MS +
    3 * config.cleanupTimeoutMs +
    (config.idleScheduleSafetyMarginMs ?? 30_000)
  );
}

export function createProductionNativeActivity(
  startup: Startup,
  lifetime: AbortSignal,
  options: {
    sampleIntervalMs: number;
    scheduleGuardMs: number;
    now?: () => number;
    monotonic?: () => number;
  },
) {
  const history = new Map<string, History>();
  const sourceId = randomUUID();
  const period = options.sampleIntervalMs;
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const clock = (): ClockReading => ({ wall: now(), mono: monotonic() });

  function clear(personId: string) {
    history.get(personId)?.forget();
    history.delete(personId);
  }

  function matches(
    scope: History,
    binding: PersonVmBinding,
    owners: readonly ActivityCatalog[],
  ) {
    return (
      sameVmBinding(scope.binding, binding) &&
      !scope.revoked.aborted &&
      scope.catalogs.length === owners.length &&
      scope.catalogs.every(({ owner }, index) => owners[index]?.owner === owner)
    );
  }

  return {
    async observe(binding, signal, purpose = 'inspection') {
      const active = AbortSignal.any([lifetime, signal]);
      const id = binding.personId;
      let scope: History | undefined;
      let reading = false;
      const work = new Set<NativeWork>();
      const observation = (
        status: 'idle' | 'busy' | 'unknown',
        wall: number,
        window?: Window,
      ) => {
        const observedAt = new Date(wall).toISOString();
        return {
          status,
          activity: {
            binding,
            observedAt,
            state:
              status === 'idle' ? ('known' as const) : ('unknown' as const),
            activeTurns: Number(work.has('turn') || work.has('goal')),
            activeJobs: Number(work.has('job')),
            activeSubtasks: Number(work.has('subagent')),
            pendingApprovals: 0,
          },
          activeScheduleDeliveries:
            status === 'idle' ? 0 : work.has('schedule') ? 1 : null,
          ...(window && {
            scheduleFingerprints: [...window.scheduleFingerprints],
          }),
          coverage: window
            ? {
                state: 'sampled' as const,
                cursor: { sourceId, revision: window.revision },
                from: window.idleSince,
                idleSince: window.idleSince,
                through: observedAt,
              }
            : {
                state: 'unknown' as const,
                cursor: null,
                reason: 'NATIVE_IDLE_SAMPLING_INCOMPLETE',
              },
        };
      };
      try {
        active.throwIfAborted();
        const catalogs = startup.activityCatalogs(binding, active);
        if (!catalogs.length) throw new PersonVmError('ACTIVITY_UNKNOWN');
        scope = history.get(id);
        if (!scope || !matches(scope, binding, catalogs)) {
          clear(id);
          const revoked = AbortSignal.any([
            lifetime,
            ...catalogs.map(({ revoked }) => revoked),
          ]);
          const owned: History = {
            binding,
            catalogs,
            revoked,
            reading: false,
            interrupted: false,
            forget: () => revoked.removeEventListener('abort', expired),
          };
          function expired() {
            if (history.get(id) === owned) clear(id);
          }
          scope = owned;
          history.set(id, owned);
          revoked.addEventListener('abort', expired, { once: true });
          revoked.throwIfAborted();
        }
        if (scope.reading) {
          scope.interrupted = true;
          scope.window = undefined;
          return observation('unknown', now());
        }
        scope.reading = reading = true;
        scope.interrupted = false;

        const start = clock();
        const revisions = catalogs.map(({ owner }) =>
          owner.nativeActivityRevision(),
        );
        const guard = async (current: AbortSignal) => {
          startup.assertAuthenticatedGroup(binding, current);
        };
        const schedules = await Promise.allSettled(
          catalogs.map(({ owner, revoked }) =>
            readNativeScheduleObservations(
              {
                catalog: () =>
                  owner.readScheduleCatalog(
                    guard,
                    AbortSignal.any([active, revoked]),
                  ),
              },
              active,
            ),
          ),
        );
        active.throwIfAborted();
        const profiles = await Promise.allSettled(
          catalogs.map(({ owner, revoked }) =>
            owner.readNativeActivity(guard, AbortSignal.any([active, revoked])),
          ),
        );
        active.throwIfAborted();
        if (
          scope.interrupted ||
          history.get(id) !== scope ||
          !matches(scope, binding, startup.activityCatalogs(binding, active))
        )
          throw new PersonVmError('ACTIVITY_UNKNOWN');

        const end = clock();
        for (const profile of profiles)
          if (profile.status === 'fulfilled')
            for (const kind of profile.value.work) work.add(kind);
        const batches = schedules.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        );
        const earliest = earliestNativeScheduleTarget(batches);
        const tooClose =
          earliest !== null && earliest - end.wall <= options.scheduleGuardMs;
        const previous = scope.window;
        const changed = catalogs.some(
          ({ owner }, index) =>
            owner.nativeActivityRevision() !== revisions[index] ||
            (scope!.window &&
              scope!.window.revisions[index] !== revisions[index]),
        );
        if (work.size || tooClose || changed) {
          scope.window = undefined;
          return observation('busy', end.wall);
        }
        if (
          batches.length !== catalogs.length ||
          profiles.some(
            (result) => result.status === 'rejected' || !result.value.complete,
          )
        ) {
          scope.window = undefined;
          return observation('unknown', end.wall);
        }

        const scheduleFingerprints = batches.map(
          ({ fingerprint }) => fingerprint,
        );
        const slot = Math.floor(start.mono / period);
        // Only periodic inspections fill slots. Wall time independently detects
        // suspension or clock changes on hosts whose monotonic clock pauses.
        const continuous =
          previous &&
          scheduleFingerprints.every(
            (fingerprint, index) =>
              fingerprint === previous.scheduleFingerprints[index],
          ) &&
          start.mono >= previous.lastStarted &&
          start.mono - previous.lastStarted <=
            period + Math.min(1_000, period / 10) &&
          slot >= previous.lastSlot &&
          slot <= previous.lastSlot + Number(purpose === 'inspection') &&
          Math.abs(
            end.wall -
              previous.lastSample.wall -
              (end.mono - previous.lastSample.mono),
          ) <= 1_000 &&
          end.wall >= previous.lastSample.wall;
        if (purpose === 'stop-guard' && !continuous) {
          scope.window = undefined;
          return observation('unknown', end.wall);
        }
        const window = continuous
          ? previous
          : {
              idleSince: new Date(end.wall).toISOString(),
              revision: randomUUID(),
              lastSlot: slot,
              lastSample: end,
              lastStarted: start.mono,
              revisions,
              scheduleFingerprints,
            };
        if (purpose === 'inspection' && slot !== window.lastSlot) {
          window.lastSlot = slot;
          window.lastSample = end;
          window.lastStarted = start.mono;
        }
        scope.window = window;
        return observation('idle', end.wall, window);
      } catch {
        if (!scope || history.get(id) === scope) clear(id);
        active.throwIfAborted();
        return observation('unknown', now());
      } finally {
        if (reading && scope) scope.reading = false;
      }
    },
    assertSampleCurrent(binding, cursor, signal) {
      signal.throwIfAborted();
      lifetime.throwIfAborted();
      const scope = history.get(binding.personId);
      const window = scope?.window;
      const current = clock();
      if (
        !scope ||
        !window ||
        scope.reading ||
        cursor.sourceId !== sourceId ||
        cursor.revision !== window.revision ||
        Math.floor(current.mono / period) !== window.lastSlot ||
        current.wall < window.lastSample.wall ||
        Math.abs(
          current.wall -
            window.lastSample.wall -
            (current.mono - window.lastSample.mono),
        ) > 1_000 ||
        !matches(scope, binding, startup.activityCatalogs(binding, signal)) ||
        scope.catalogs.some(
          ({ owner }, index) =>
            owner.nativeActivityRevision() !== window.revisions[index],
        )
      )
        throw new PersonVmError('ACTIVITY_UNKNOWN');
    },
    async subscribe(_binding, signal) {
      signal.throwIfAborted();
      lifetime.throwIfAborted();
      // Host idle samples are used by polling. They aren't a freeze stream.
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    },
  } satisfies PersonVmNativeActivityPort;
}
