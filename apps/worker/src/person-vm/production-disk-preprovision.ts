import { setTimeout as sleep } from 'node:timers/promises';
import { sameDEntryIdentity } from '@allrice/contracts';
import type {
  createDEntryAuthorityFeed,
  readPersonVmDiskPreparationRoster,
  readPersonVmDiskPreparationTarget,
} from '@allrice/database';
import {
  PersonVmError,
  type PersonVmDiskPreparationPort,
  type PersonVmDiskPreparationTarget,
} from '@allrice/person-vm';

const pageSize = 16;
const scanMs = 15_000;
const minimumSweepSpacingMs = 1_000;
const initialRetryMs = 1_000;
const maxRetryMs = 30_000;
const eligibilityTables = new Set([
  'allrice_settings',
  'allrice_users',
  'allrice_memberships',
  'allrice_organizations',
  'allrice_workspaces',
  'allrice_employee_instances',
  'allrice_employee_assignments',
  'allrice_employees',
  'allrice_platform_employee_tenant_assignments',
  'allrice_employee_version_sources',
  'allrice_platform_employee_revisions',
]);

type Feed = Pick<
  ReturnType<typeof createDEntryAuthorityFeed>,
  'subscribe' | 'close'
>;
type PreparationEvent =
  | 'capacity-deferred'
  | 'organization-conflict'
  | 'version-source-unverified'
  | 'cleanup-incomplete'
  | 'prepare-failed'
  | 'source-unavailable';
type Retry = { failures: number; notBefore: number };

function matchesTarget(
  previous: PersonVmDiskPreparationTarget,
  current: PersonVmDiskPreparationTarget | null,
) {
  return (
    current !== null &&
    current.policyRevision === previous.policyRevision &&
    current.platformRevisionId === previous.platformRevisionId &&
    sameDEntryIdentity(
      { ...current, threadId: null },
      { ...previous, threadId: null },
    )
  );
}

function vmError<Code extends PersonVmError['code']>(
  error: unknown,
  code: Code,
): error is PersonVmError & { code: Code } {
  return error instanceof PersonVmError && error.code === code;
}

/** The Host owns this scanner. Its only mutating dependency is the offline
 * disk port, which must acquire the existing per-person physical lease. */
export function startProductionDiskPreprovision(input: {
  lifetime: AbortSignal;
  openFeed(): Feed;
  readRoster: typeof readPersonVmDiskPreparationRoster;
  readTarget: typeof readPersonVmDiskPreparationTarget;
  foregroundBusy(personId: string, signal: AbortSignal): Promise<boolean>;
  refill?(signal: AbortSignal): Promise<void>;
  availableBytes(signal: AbortSignal): Promise<bigint>;
  minimumFreeBytes: number;
  reserveBytes: number;
  port: PersonVmDiskPreparationPort;
  observe(event: PreparationEvent): void;
}) {
  const closing = new AbortController();
  const lifetime = AbortSignal.any([input.lifetime, closing.signal]);
  const retry = new Map<string, Retry>();
  const minimumFree =
    BigInt(input.minimumFreeBytes) + BigInt(input.reserveBytes);
  const lowCapacity = Error('DISK_PREPARATION_CAPACITY_UNAVAILABLE');

  function defer(personId: string, failed: boolean) {
    const failures = failed
      ? Math.min((retry.get(personId)?.failures ?? 0) + 1, 6)
      : 0;
    const delay = failed
      ? Math.min(initialRetryMs * 2 ** (failures - 1), maxRetryMs)
      : scanMs;
    retry.set(personId, {
      failures,
      notBefore:
        performance.now() + delay + Math.floor(Math.random() * initialRetryMs),
    });
  }

  async function scan(feed: Feed) {
    const disconnected = new AbortController();
    const signal = AbortSignal.any([lifetime, disconnected.signal]);
    let waiting: AbortController | undefined;
    let attempt: { personId: string; recheck(): void } | undefined;
    let hinted = false;
    let nextSweep = 0;
    const startup = AbortSignal.any([signal, AbortSignal.timeout(6_000)]);
    startup.throwIfAborted();
    // pg can leave connect() pending after an early end(). On abort let
    // the owner join feed.close(), which closes the socket and seals admission.
    let stopSetup!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stopSetup = () => reject(startup.reason);
    });
    startup.addEventListener('abort', stopSetup, { once: true });
    const unsubscribe = await Promise.race([
      feed.subscribe(
        {
          changed(change) {
            // The admission feed also echoes our own physical lease updates.
            // Existing physical lease and admission guards belong to the port.
            if (!eligibilityTables.has(change.table)) return;
            const personId =
              change.personId ??
              (change.table === 'allrice_users' ? change.id : null);
            if (!personId || attempt?.personId === personId) attempt?.recheck();
            hinted = true;
            waiting?.abort();
          },
          lost: (error) => disconnected.abort(error),
        },
        startup,
      ),
      cancelled,
    ]).finally(() => startup.removeEventListener('abort', stopSetup));
    startup.throwIfAborted();

    async function readSource<T>(active: AbortSignal, read: () => Promise<T>) {
      try {
        return await read();
      } catch (error) {
        if (!active.aborted && !vmError(error, 'ORGANIZATION_CONFLICT'))
          disconnected.abort(error);
        throw error;
      }
    }

    async function prepare(personId: string) {
      if ((retry.get(personId)?.notBefore ?? 0) > performance.now()) return;
      const cancel = new AbortController();
      const active = AbortSignal.any([signal, cancel.signal]);
      let rechecking: Promise<void> | undefined;
      let recheckRequested = false;
      const guards = new Set<Promise<void>>();
      const trackGuard = (check: () => Promise<void>) => () => {
        const pending = check();
        guards.add(pending);
        const settled = () => guards.delete(pending);
        void pending.then(settled, settled);
        return pending;
      };
      try {
        const readTarget = async () => {
          const result = await readSource(active, () =>
            input.readTarget(personId, active),
          );
          active.throwIfAborted();
          if (result === 'version-source-unverified') {
            input.observe(result);
            defer(personId, true);
            cancel.abort(Error('DISK_PREPARATION_AUTHORITY_CHANGED'));
            throw active.reason;
          }
          return result;
        };
        const target = await readTarget();
        active.throwIfAborted();
        if (!target) {
          retry.delete(personId);
          return;
        }
        const busy = await readSource(active, () =>
          input.foregroundBusy(personId, active),
        );
        active.throwIfAborted();
        if (busy) {
          defer(personId, false);
          return;
        }
        const assertCurrent = async () => {
          active.throwIfAborted();
          const current = await readTarget();
          active.throwIfAborted();
          if (!matchesTarget(target, current)) {
            cancel.abort(Error('DISK_PREPARATION_AUTHORITY_CHANGED'));
            active.throwIfAborted();
          }
        };
        const assertCapacity = async () => {
          active.throwIfAborted();
          const available = await input.availableBytes(active);
          active.throwIfAborted();
          if (available < minimumFree) throw lowCapacity;
        };
        attempt = {
          personId,
          recheck() {
            recheckRequested = true;
            rechecking ??= Promise.resolve().then(async () => {
              try {
                while (recheckRequested && !active.aborted) {
                  recheckRequested = false;
                  await assertCurrent();
                }
              } catch (error) {
                if (!active.aborted) cancel.abort(error);
              } finally {
                rechecking = undefined;
              }
            });
          },
        };
        await assertCapacity();
        await assertCurrent();
        active.throwIfAborted();
        await input.port.prepare(target, {
          signal: active,
          assertCurrent: trackGuard(assertCurrent),
          assertCapacity: trackGuard(assertCapacity),
        });
        active.throwIfAborted();
        defer(personId, false);
      } catch (error) {
        if (vmError(error, 'CLEANUP_INCOMPLETE')) throw error;
        if (signal.aborted) throw signal.reason;
        if (!active.aborted) {
          input.observe(
            error === lowCapacity
              ? 'capacity-deferred'
              : vmError(error, 'ORGANIZATION_CONFLICT')
                ? 'organization-conflict'
                : 'prepare-failed',
          );
          defer(personId, true);
        }
      } finally {
        cancel.abort();
        attempt = undefined;
        await rechecking;
        await Promise.allSettled(guards);
      }
    }

    try {
      while (!signal.aborted) {
        const delay = nextSweep - performance.now();
        if (delay > 0) await sleep(delay, undefined, { signal, ref: false });
        signal.throwIfAborted();
        hinted = false;
        try {
          await input.refill?.(signal);
        } catch (error) {
          if (signal.aborted || vmError(error, 'CLEANUP_INCOMPLETE'))
            throw error;
          input.observe('prepare-failed');
        }
        const seen = new Set<string>();
        const roster = await input.readRoster(signal);
        signal.throwIfAborted();
        let offset: number | null = 0;
        do {
          const page = roster.page(offset, pageSize);
          for (const personId of page.personIds) {
            signal.throwIfAborted();
            seen.add(personId);
            await prepare(personId);
          }
          offset = page.nextOffset;
          if (offset !== null)
            await sleep(0, undefined, { signal, ref: false });
        } while (offset !== null);
        for (const personId of retry.keys()) {
          if (!seen.has(personId)) retry.delete(personId);
        }
        nextSweep = performance.now() + minimumSweepSpacingMs;
        if (hinted) continue;
        waiting = new AbortController();
        try {
          await sleep(scanMs, undefined, {
            signal: AbortSignal.any([signal, waiting.signal]),
            ref: false,
          });
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          if (!waiting.signal.aborted) throw error;
        } finally {
          waiting = undefined;
        }
      }
      signal.throwIfAborted();
    } finally {
      unsubscribe();
    }
  }

  const work = (async () => {
    while (!lifetime.aborted) {
      let feed: Feed | undefined;
      let cleanupFailure: PersonVmError | undefined;
      let sourceFailed = false;
      try {
        feed = input.openFeed();
        await scan(feed);
      } catch (error) {
        if (vmError(error, 'CLEANUP_INCOMPLETE')) cleanupFailure = error;
        else sourceFailed = true;
      }
      // A feed that cannot be closed must not be replaced by an extra owner.
      try {
        await feed?.close();
      } catch (error) {
        if (cleanupFailure)
          throw new AggregateError(
            [cleanupFailure, error],
            'DISK_PREPARATION_CLOSE_INCOMPLETE',
          );
        throw error;
      }
      if (cleanupFailure) throw cleanupFailure;
      if (!lifetime.aborted && sourceFailed)
        input.observe('source-unavailable');
      if (!lifetime.aborted)
        await sleep(initialRetryMs, undefined, {
          signal: lifetime,
          ref: false,
        }).catch((error: unknown) => {
          if (!lifetime.aborted) throw error;
        });
    }
  })();
  void work.catch(() => input.observe('cleanup-incomplete'));

  return {
    close() {
      closing.abort();
      return work;
    },
  };
}
