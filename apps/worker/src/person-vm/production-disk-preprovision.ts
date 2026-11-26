import { setTimeout as sleep } from 'node:timers/promises';
import { sameDEntryIdentity } from '@allrice/contracts';
import type {
  createDEntryAuthorityFeed,
  listPersonVmDiskPreparationPeople,
  readPersonVmDiskPreparationTarget,
} from '@allrice/database';
import type {
  PersonVmDiskPreparationPort,
  PersonVmDiskPreparationTarget,
} from '@allrice/person-vm';

const pageSize = 16;
const scanMs = 15_000;
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
  'capacity-deferred' | 'prepare-failed' | 'source-unavailable';
type Retry = { failures: number; notBefore: number };

function matchesTarget(
  previous: PersonVmDiskPreparationTarget,
  current: PersonVmDiskPreparationTarget | null,
) {
  return (
    current !== null &&
    current.policyRevision === previous.policyRevision &&
    sameDEntryIdentity(
      { ...current, threadId: null },
      { ...previous, threadId: null },
    )
  );
}

/** The Host owns this scanner. Its only mutating dependency is the offline
 * disk port, which must acquire the existing per-person physical lease. */
export function startProductionDiskPreprovision(input: {
  lifetime: AbortSignal;
  openFeed(): Feed;
  listPeople: typeof listPersonVmDiskPreparationPeople;
  readTarget: typeof readPersonVmDiskPreparationTarget;
  foregroundBusy(personId: string, signal: AbortSignal): Promise<boolean>;
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
    let attempt: { personId: string; cancel: AbortController } | undefined;
    let hinted = false;
    const unsubscribe = await feed.subscribe(
      {
        changed(change) {
          // The admission feed also echoes our own physical lease updates.
          // Existing physical lease and admission guards belong to the port.
          if (!eligibilityTables.has(change.table)) return;
          const personId =
            change.personId ??
            (change.table === 'allrice_users' ? change.id : null);
          if (!personId || attempt?.personId === personId) {
            attempt?.cancel.abort(Error('DISK_PREPARATION_AUTHORITY_CHANGED'));
          }
          hinted = true;
          waiting?.abort();
        },
        lost: (error) => disconnected.abort(error),
      },
      signal,
    );

    async function prepare(personId: string) {
      if ((retry.get(personId)?.notBefore ?? 0) > performance.now()) return;
      const cancel = new AbortController();
      const active = AbortSignal.any([signal, cancel.signal]);
      attempt = { personId, cancel };
      try {
        const target = await input.readTarget(personId, active);
        active.throwIfAborted();
        if (!target) {
          retry.delete(personId);
          return;
        }
        const busy = await input.foregroundBusy(personId, active);
        active.throwIfAborted();
        if (busy) {
          defer(personId, false);
          return;
        }
        const assertCurrent = async () => {
          active.throwIfAborted();
          const current = await input.readTarget(personId, active);
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
        await assertCapacity();
        await assertCurrent();
        active.throwIfAborted();
        await input.port.prepare(target, {
          signal: active,
          assertCurrent,
          assertCapacity,
        });
        active.throwIfAborted();
        defer(personId, false);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (!active.aborted) {
          input.observe(
            error === lowCapacity ? 'capacity-deferred' : 'prepare-failed',
          );
          defer(personId, true);
        }
      } finally {
        cancel.abort();
        attempt = undefined;
      }
    }

    try {
      while (!signal.aborted) {
        hinted = false;
        const seen = new Set<string>();
        let after: string | null = null;
        do {
          const page = await input.listPeople(after, pageSize, signal);
          signal.throwIfAborted();
          for (const personId of page.personIds) {
            signal.throwIfAborted();
            seen.add(personId);
            await prepare(personId);
          }
          after = page.nextAfter;
        } while (after !== null);
        for (const personId of retry.keys()) {
          if (!seen.has(personId)) retry.delete(personId);
        }
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

  const lowCapacity = Error('DISK_PREPARATION_CAPACITY_UNAVAILABLE');
  const work = (async () => {
    while (!lifetime.aborted) {
      let feed: Feed | undefined;
      try {
        feed = input.openFeed();
        await scan(feed);
      } catch {
        if (!lifetime.aborted) input.observe('source-unavailable');
      } finally {
        // A feed that cannot be closed must not be replaced by an extra owner.
        await feed?.close();
      }
      if (!lifetime.aborted)
        await sleep(initialRetryMs, undefined, {
          signal: lifetime,
          ref: false,
        }).catch((error: unknown) => {
          if (!lifetime.aborted) throw error;
        });
    }
  })();
  void work.catch(() => input.observe('source-unavailable'));

  return {
    close() {
      closing.abort();
      return work;
    },
  };
}
