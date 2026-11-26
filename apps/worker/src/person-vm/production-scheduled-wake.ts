import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { UuidSchema, type RequestContext } from '@allrice/contracts';
import {
  createPostgresNativeScheduleObservationLedger,
  createPostgresPersonVmScheduledWakeStore,
  readPersonNativeWebRoster,
  type getDatabase,
} from '@allrice/database';
import { PersonVmError, type PersonVmBinding } from '@allrice/person-vm';
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
  type PrepareStopWithWakeResult,
} from './scheduled-wake.js';

type WakeOptions = Parameters<typeof createPersonVmScheduledWake>[0];
type CapturedProfile = Awaited<
  ReturnType<WakeOptions['capture']>
>['profiles'][number];

export type PersonVmWakePreparation = Readonly<{
  binding: PersonVmBinding;
  context: RequestContext;
  /** The stop owner checks its exact lease and still-current native stop facts. */
  assertStopCurrent(signal: AbortSignal): Promise<void>;
}>;

/** Private installation from the owner of durable execution and VM startup.
 * The observation ledger itself cannot issue a grant or reconstruct a login. */
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
}) {
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([input.lifetime, stopped.signal]);
  const pending = new Set<Promise<unknown>>();
  const store = createPostgresPersonVmScheduledWakeStore(input.database);
  const ledger = createPostgresNativeScheduleObservationLedger(input.database);
  let runner: Promise<void> | undefined;
  let tick: Promise<boolean> | undefined;
  let paused = false;
  let closing: Promise<void> | undefined;

  function options(capture: WakeOptions['capture']) {
    return {
      store,
      ledger,
      capture,
      start: input.source.start,
      leadMs: input.source.leadMs,
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
  ): Promise<PrepareStopWithWakeResult> {
    const { context, binding } = request;
    if (
      context.actor.type !== 'user' ||
      context.actor.id !== binding.personId ||
      context.organizationId !== binding.organizationId ||
      !UuidSchema.safeParse(context.requestId).success
    )
      return { blocked: true, reason: 'SCHEDULE_OBSERVATION_UNAVAILABLE' };

    const engine = createPersonVmScheduledWake(
      options(async (_, planId, active) => {
        async function readCatalogs(signal: AbortSignal) {
          signal.throwIfAborted();
          await request.assertStopCurrent(signal);
          const roster = await readPersonNativeWebRoster(
            context,
            input.database,
          );
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
                owner.readScheduleCatalogForStop(
                  (signal) => request.assertStopCurrent(signal),
                  AbortSignal.any([active, revoked]),
                ),
            },
          }),
        );
        return {
          profiles,
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
            await request.assertStopCurrent(signal);
          },
          async assertCurrent(signal) {
            const current = await readCatalogs(signal);
            if (
              current.length !== catalogs.length ||
              catalogs.some(
                (catalog, index) => !sameOwner(catalog, current[index]),
              )
            )
              throw new PersonVmError('AUTHORIZATION_DENIED');
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
    return engine.prepareStopWithWake(binding, context.requestId, signal);
  }

  return {
    prepareStopWithWake(request: PersonVmWakePreparation, caller: AbortSignal) {
      const signal = AbortSignal.any([caller, lifetime]);
      signal.throwIfAborted();
      if (paused)
        return Promise.resolve({
          blocked: true,
          reason: 'SCHEDULE_WAKE_UNAVAILABLE',
        } as const);
      const operation = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return prepare(request, signal);
      });
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    },
    start() {
      lifetime.throwIfAborted();
      runner ??= (async () => {
        while (!lifetime.aborted) {
          if (!paused) {
            try {
              tick = wake.runDueOnce(lifetime);
              await tick;
            } catch {
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
    async pause() {
      paused = true;
      await Promise.allSettled([tick, ...pending]);
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
