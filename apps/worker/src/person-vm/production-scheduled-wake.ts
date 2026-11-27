import { createHash } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { UuidSchema } from '@allrice/contracts';
import {
  createPostgresNativeScheduleObservationLedger,
  createPostgresPersonVmScheduledWakeStore,
  readPersonNativeWebRoster,
  readPersonVmWakeRoster,
  getDatabase,
} from '@allrice/database';
import {
  PersonVmError,
  type PersonVmIdleStopRequest,
  type PersonVmBinding,
  type PersonVmScheduledIdleAuthority,
  type PersonVmService,
  type PersonVmWebRoster,
} from '@allrice/person-vm';
import type {
  AssignedNativeWebCatalog,
  createAssignedNativeWebStartup,
} from '../native-web/composition.js';
import {
  readNativeScheduleObservations,
  type NativeScheduleObservationBatch,
} from '../native-schedule-observation.js';
import {
  createPersonVmScheduledWake,
  DEFAULT_SCHEDULE_WAKE_LEAD_MS,
  type PrepareStopWithWakeResult,
} from './scheduled-wake.js';

type WakeOptions = Parameters<typeof createPersonVmScheduledWake>[0];
type CapturedProfile = Awaited<
  ReturnType<WakeOptions['capture']>
>['profiles'][number];

export type PersonVmWakePreparation = PersonVmIdleStopRequest;

/** Internal authorization and retained startup, independent of login. */
export type ProductionScheduledWakeSource = Readonly<{
  leadMs?: number;
  assertDeliverable(
    preparation: PersonVmWakePreparation,
    profiles: readonly Readonly<{
      origin: CapturedProfile['origin'];
      batch: NativeScheduleObservationBatch;
    }>[],
    signal: AbortSignal,
  ): Promise<void>;
  start: WakeOptions['start'];
}>;

export function createProductionScheduledWakeSource(
  vm: Pick<PersonVmService, 'startRetainedForSchedule'>,
): ProductionScheduledWakeSource {
  const db = getDatabase();
  const store = createPostgresPersonVmScheduledWakeStore(db);
  return {
    async assertDeliverable({ binding }, profiles, signal) {
      signal.throwIfAborted();
      const roster = await db.begin(
        'isolation level repeatable read read only',
        (tx) =>
          readPersonVmWakeRoster(
            tx,
            binding,
            profiles.map(({ origin }) => origin),
          ),
      );
      signal.throwIfAborted();
      if (!roster) throw new PersonVmError('AUTHORIZATION_DENIED');
    },
    async start(claim, assertClaim, signal) {
      try {
        await vm.startRetainedForSchedule(
          claim,
          claim.claimId,
          {
            async readRoster(active) {
              active.throwIfAborted();
              const read = async () =>
                (await assertClaim()) ? store.readClaimRoster(claim) : null;
              const roster = await read().catch((cause) => {
                throw new PersonVmError('RUNTIME_NOT_READY', { cause });
              });
              active.throwIfAborted();
              if (!roster) throw new PersonVmError('AUTHORIZATION_DENIED');
              return roster;
            },
            async withCurrentAuthority(digest, active, work) {
              active.throwIfAborted();
              const completed = await store.withClaimAuthority(
                claim,
                active,
                async (roster, dispatchSignal) => {
                  if (roster.digest !== digest)
                    throw new PersonVmError('AUTHORIZATION_DENIED');
                  return { result: await work(dispatchSignal) };
                },
              );
              if (!completed) throw new PersonVmError('AUTHORIZATION_DENIED');
              return completed.result;
            },
          },
          signal,
        );
        return 'ready';
      } catch (error) {
        if (error instanceof PersonVmError) {
          if (error.code === 'AUTHORIZATION_DENIED') return 'denied';
          if (error.code === 'LEASE_LOST') return 'stale';
          if (
            error.code === 'LEASE_CONFLICT' ||
            error.code === 'RUNTIME_NOT_READY'
          )
            return 'not-started';
        }
        return 'unknown';
      }
    },
  };
}

function receiptId(planId: string, employeeInstanceId: string) {
  const bytes = createHash('sha256')
    .update('person-vm-scheduled-wake\0')
    .update(planId.toLowerCase() + employeeInstanceId.toLowerCase())
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function createProductionScheduledWake(input: {
  startup: Pick<ReturnType<typeof createAssignedNativeWebStartup>, 'catalog'>;
  database: ReturnType<typeof getDatabase>;
  source: ProductionScheduledWakeSource;
  lifetime: AbortSignal;
  minimumLeadMs?: number;
}) {
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([input.lifetime, stopped.signal]);
  const pending = new Set<Promise<unknown>>();
  const store = createPostgresPersonVmScheduledWakeStore(input.database);
  const ledger = createPostgresNativeScheduleObservationLedger(input.database);
  let runner: Promise<void> | undefined;
  let tick: Promise<boolean> | undefined;
  let lastCompletedTick: number | undefined;
  let paused = false;
  let closing: Promise<void> | undefined;

  const sourceLeadMs = input.source.leadMs ?? DEFAULT_SCHEDULE_WAKE_LEAD_MS;
  if (!Number.isSafeInteger(sourceLeadMs) || sourceLeadMs < 0)
    throw new RangeError('SCHEDULE_WAKE_LEAD_INVALID');

  function options(capture: WakeOptions['capture']) {
    return {
      store,
      ledger,
      capture,
      start: input.source.start,
      leadMs: Math.max(input.minimumLeadMs ?? 0, sourceLeadMs),
    };
  }
  const wake = createPersonVmScheduledWake(
    options(async () => {
      throw new PersonVmError('AUTHORIZATION_DENIED');
    }),
  );

  async function prepare(
    request: PersonVmWakePreparation,
    signal: AbortSignal,
    captureFingerprints?: (ordered: readonly string[]) => void,
  ): Promise<PrepareStopWithWakeResult> {
    const { binding } = request;
    const context = 'context' in request ? request.context : undefined;
    const requestId =
      'context' in request ? request.context.requestId : request.requestId;
    if (
      (context &&
        (context.actor.type !== 'user' ||
          context.actor.id !== binding.personId ||
          context.organizationId !== binding.organizationId)) ||
      !UuidSchema.safeParse(requestId).success
    )
      return { blocked: true, reason: 'SCHEDULE_OBSERVATION_UNAVAILABLE' };

    const engine = createPersonVmScheduledWake(
      options(async (_, planId, active) => {
        async function readCatalogs(signal: AbortSignal) {
          signal.throwIfAborted();
          await request.assertStopCurrent(signal);
          const roster =
            'context' in request
              ? await readPersonNativeWebRoster(request.context, input.database)
              : request.scheduledRoster;
          signal.throwIfAborted();
          if (
            roster.personId !== binding.personId ||
            roster.organizationId !== binding.organizationId ||
            roster.entries.length === 0
          )
            throw new PersonVmError('AUTHORIZATION_DENIED');
          const catalogs = roster.entries.map((entry) => {
            const catalog = input.startup.catalog(
              binding,
              entry.employeeInstanceId,
            );
            const exposed = catalog.endpoint;
            catalog.revoked.throwIfAborted();
            if (
              catalog.receipt.rosterDigest !== roster.digest ||
              catalog.receipt.endpoints.length !== roster.entries.length ||
              exposed.workspaceId !== entry.workspaceId ||
              exposed.employeeInstanceId !== entry.employeeInstanceId ||
              exposed.employeeVersionId !== entry.employeeVersionId ||
              exposed.employeeRevision !== entry.employeeRevision
            )
              throw new PersonVmError('AUTHORIZATION_DENIED');
            return catalog;
          });
          await request.assertStopCurrent(signal);
          signal.throwIfAborted();
          return catalogs;
        }

        const catalogs = await readCatalogs(active);
        function sameOwner(
          expected: AssignedNativeWebCatalog,
          current: AssignedNativeWebCatalog | undefined,
        ) {
          expected.revoked.throwIfAborted();
          return (
            current?.owner === expected.owner &&
            current?.bindingRef === expected.bindingRef &&
            current?.receipt === expected.receipt
          );
        }
        const profiles = catalogs.map(
          ({ endpoint, bindingRef, owner, revoked }) => ({
            origin: {
              ...binding,
              workspaceId: endpoint.workspaceId,
              employeeInstanceId: endpoint.employeeInstanceId,
              employeeRevision: endpoint.employeeRevision,
              employeeVersionId: endpoint.employeeVersionId,
              bindingRef,
            },
            receiptId: receiptId(planId, endpoint.employeeInstanceId),
            schedule: {
              catalog: () =>
                owner.readScheduleCatalog(
                  (signal) => request.assertStopCurrent(signal),
                  AbortSignal.any([active, revoked]),
                ),
            },
          }),
        );
        async function assertCurrent(signal: AbortSignal) {
          const current = await readCatalogs(signal);
          if (
            current.length !== catalogs.length ||
            catalogs.some(
              (catalog, index) => !sameOwner(catalog, current[index]),
            )
          )
            throw new PersonVmError('AUTHORIZATION_DENIED');
        }
        return {
          profiles,
          assertCurrent,
          async confirmObservations(batches, signal) {
            const results = await Promise.allSettled(
              profiles.map(({ schedule }) =>
                readNativeScheduleObservations(schedule, signal),
              ),
            );
            for (const [index, result] of results.entries()) {
              if (result.status === 'rejected') throw result.reason;
              if (result.value.fingerprint !== batches[index]?.fingerprint)
                throw new PersonVmError('ACTIVITY_UNKNOWN');
            }
            await assertCurrent(signal);
            captureFingerprints?.(
              batches.map(({ fingerprint }) => fingerprint),
            );
          },
          async assertDeliverable(batches, signal) {
            await input.source.assertDeliverable(
              request,
              profiles.map(({ origin }, index) => ({
                origin,
                batch: batches[index]!,
              })),
              signal,
            );
          },
        };
      }),
    );
    return engine.prepareStopWithWake(binding, requestId, signal);
  }

  const assertScheduledIdleCurrent: PersonVmScheduledIdleAuthority['assertCurrent'] =
    async (binding, expected, caller) => {
      const signal = AbortSignal.any([caller, lifetime]);
      signal.throwIfAborted();
      if (paused) throw new PersonVmError('RUNTIME_NOT_READY');
      const roster = await input.database.begin(
        'isolation level repeatable read read only',
        (tx) => readPersonVmWakeRoster(tx, binding, expected.entries),
      );
      signal.throwIfAborted();
      if (paused || roster?.digest !== expected.digest)
        throw new PersonVmError('AUTHORIZATION_DENIED');
    };

  function dispatchPreparedStop(isAvailable: () => boolean) {
    return async (
      binding: PersonVmBinding,
      roster: PersonVmWebRoster,
      requestId: string,
      caller: AbortSignal,
      stop: (active: AbortSignal) => Promise<void>,
      authorizeDispatch?: Parameters<typeof store.withPreparedStopAuthority>[5],
    ) => {
      const signal = AbortSignal.any([caller, lifetime]);
      signal.throwIfAborted();
      if (!isAvailable()) throw new PersonVmError('RUNTIME_NOT_READY');
      const dispatched = await store.withPreparedStopAuthority(
        binding,
        roster,
        requestId,
        signal,
        async (active) => {
          if (!isAvailable()) throw new PersonVmError('RUNTIME_NOT_READY');
          await stop(active);
        },
        authorizeDispatch,
      );
      if (!dispatched) throw new PersonVmError('AUTHORIZATION_DENIED');
    };
  }

  const dispatchScheduledIdleStop = dispatchPreparedStop(() => !paused);
  const dispatchUpgradeStop = dispatchPreparedStop(() => paused);

  function prepareOwnedStop(
    request: PersonVmWakePreparation,
    caller: AbortSignal,
    whilePaused: boolean,
    captureFingerprints?: (ordered: readonly string[]) => void,
  ): Promise<PrepareStopWithWakeResult> {
    const signal = AbortSignal.any([caller, lifetime]);
    signal.throwIfAborted();
    if (paused !== whilePaused)
      return Promise.resolve({
        blocked: true,
        reason: 'SCHEDULE_WAKE_UNAVAILABLE',
      });
    const operation = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return prepare(request, signal, captureFingerprints);
    });
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  }

  return {
    assertScheduledIdleCurrent,
    nextCommittedWakeAt: store.nextCommittedWakeAt,
    dispatchScheduledIdleStop,
    dispatchUpgradeStop,
    prepareStopWithWake(request: PersonVmWakePreparation, caller: AbortSignal) {
      return prepareOwnedStop(request, caller, false);
    },
    async prepareUpgradeStop(
      request: Extract<PersonVmWakePreparation, { scheduledRoster: unknown }>,
      caller: AbortSignal,
    ) {
      let scheduleFingerprints: readonly string[] | undefined;
      const plan = await prepareOwnedStop(request, caller, true, (ordered) => {
        scheduleFingerprints = ordered;
      });
      if ('blocked' in plan) return plan;
      if (!scheduleFingerprints?.length)
        throw new PersonVmError('ACTIVITY_UNKNOWN');
      return { ...plan, scheduleFingerprints };
    },
    start() {
      lifetime.throwIfAborted();
      runner ??= (async () => {
        while (!lifetime.aborted) {
          if (!paused) {
            try {
              tick = wake.runDueOnce(lifetime);
              await tick;
              lastCompletedTick = performance.now();
            } catch {
              lastCompletedTick = undefined;
              if (!lifetime.aborted)
                console.error('[person-vm] scheduled wake tick failed');
            } finally {
              tick = undefined;
            }
          }
          await sleep(5_000, undefined, { signal: lifetime, ref: false });
        }
      })().catch((error: unknown) => {
        if (!lifetime.aborted) throw error;
      });
      void runner.catch(() => {});
    },
    readyForRecovery() {
      return (
        !lifetime.aborted &&
        !paused &&
        lastCompletedTick !== undefined &&
        performance.now() - lastCompletedTick < 15_000
      );
    },
    async pause(signal: AbortSignal) {
      signal.throwIfAborted();
      paused = true;
      const joined = Promise.allSettled([tick, ...pending]);
      await new Promise<void>((resolve, reject) => {
        const abort = addAbortListener(signal, () => reject(signal.reason));
        void joined.then(() => {
          abort[Symbol.dispose]();
          resolve();
        });
      });
      signal.throwIfAborted();
    },
    resume() {
      paused = false;
    },
    close() {
      if (closing) return closing;
      stopped.abort(new PersonVmError('RUNTIME_NOT_READY'));
      return (closing = Promise.allSettled([runner, ...pending]).then(
        () => {},
      ));
    },
  };
}
