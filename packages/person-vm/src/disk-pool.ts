import { randomUUID } from 'node:crypto';
import { PersonVmError } from './contract.ts';
import {
  DiskPoolLedger,
  type DiskPoolRecord,
  type DiskPoolSlot,
} from './disk-pool-ledger.ts';
import {
  DiskPoolBudgetExceeded,
  sameDiskPoolOwner,
  type DiskPoolCapacity,
  type DiskPoolClaim,
  type DiskPoolLock,
  type DiskPoolLocks,
  type DiskPoolOwner,
  type DiskPoolPlatform,
} from './disk-pool-platform.ts';

export type PersonVmDiskPoolOptions = Readonly<{
  platform: DiskPoolPlatform;
  source: string;
  minimumFreeBytes: bigint;
  reserveBytes: bigint;
  cleanupTimeoutMs: number;
}>;
type Claiming = DiskPoolClaim & { state: 'claiming' };
type Bind = { slot: DiskPoolSlot; entry: Claiming };
type ClaimGuard = Readonly<{
  signal: AbortSignal;
  assertOwner(): Promise<void>;
  assertCurrent(): Promise<void>;
}>;
type PoolEvent = Readonly<{
  event:
    | 'pool-empty'
    | 'capacity-deferred'
    | 'foreground-deferred'
    | 'interrupted-fill'
    | 'fill-deferred'
    | 'stock-ready'
    | 'stock-quarantined'
    | 'claim-quarantined'
    | 'claim-bound';
  lane?: 'foreground' | 'admin';
  availableBytes?: string;
  allocatedBytes?: string;
}>;

function incomplete(cause?: unknown): never {
  throw new PersonVmError('CLEANUP_INCOMPLETE', { cause });
}
function pendingFor(slots: DiskPoolSlot[], personId: string, vmId?: string) {
  const matches = slots.filter(
    ({ entry }) =>
      (entry?.state === 'claiming' || entry?.state === 'claim-quarantined') &&
      (entry.intent.owner.personId === personId ||
        entry.intent.owner.vmId === vmId),
  );
  if (matches.length > 1) incomplete();
  return matches[0];
}
const vacant = (entry: DiskPoolRecord | null) =>
  !entry || entry.state === 'bound' || entry.state === 'released-before-write';
const unsettledFill = (entry: DiskPoolRecord | null) =>
  entry?.state === 'filling' ||
  (entry?.state === 'quarantined' && entry.reason === 'cleanup-unconfirmed');

/** Storage policy only. Call claim and person-specific reads under the existing
 * per-person lease. The inventory lane is always acquired after that lease.
 * It never encloses image, mount, cache or key operations. */
export class PersonVmDiskPool {
  private readonly ledger: DiskPoolLedger;
  private foreground = 0;
  constructor(
    root: string,
    private readonly locks: DiskPoolLocks,
    private readonly observe: (event: PoolEvent) => void,
    private readonly options?: PersonVmDiskPoolOptions,
  ) {
    this.ledger = new DiskPoolLedger(root);
  }

  get enabled() {
    return this.options !== undefined;
  }

  async inForeground<T>(work: () => Promise<T>) {
    if (!this.enabled) return work();
    this.foreground += 1;
    try {
      return await work();
    } finally {
      this.foreground -= 1;
    }
  }

  async status(owner: DiskPoolOwner, signal: AbortSignal) {
    const { slots, bound } = await this.ledger.read(signal);
    const slot = pendingFor(slots, owner.personId, owner.vmId);
    if (slot) {
      const entry = slot.entry!;
      if (
        entry.state !== 'claiming' ||
        !sameDiskPoolOwner(entry.intent.owner, owner)
      )
        incomplete();
      return 'pending' as const;
    }
    const saved = bound.get(owner.vmId);
    if (saved && !sameDiskPoolOwner(saved.intent.owner, owner)) incomplete();
    return saved ? ('bound' as const) : ('none' as const);
  }

  async canPrepare(personId: string, signal: AbortSignal) {
    if (!this.options || this.foreground) return false;
    const { slots } = await this.ledger.read(signal);
    const available =
      Boolean(pendingFor(slots, personId)) ||
      slots.some(
        ({ entry }) =>
          entry?.state === 'ready' && entry.source === this.options?.source,
      );
    if (!available) this.observe({ event: 'pool-empty', lane: 'admin' });
    return available;
  }

  private async inventory<T>(
    signal: AbortSignal,
    work: (lock: DiskPoolLock) => Promise<T>,
  ) {
    const result = await this.locks.withLock('inventory', signal, work);
    if (result === undefined) throw new PersonVmError('LEASE_CONFLICT');
    return result;
  }

  private async checkClaim(guard: ClaimGuard) {
    guard.signal.throwIfAborted();
    await guard.assertCurrent();
    await guard.assertOwner();
    guard.signal.throwIfAborted();
  }
  private async quarantineOldSource(
    slots: DiskPoolSlot[],
    source: string,
    lock: DiskPoolLock,
  ) {
    for (const slot of slots) {
      const entry = slot.entry;
      if (entry?.state !== 'ready' || entry.source === source) continue;
      await lock.assertOwned();
      await this.ledger.append(
        slot,
        {
          ref: entry.ref,
          source: entry.source,
          state: 'quarantined',
          reason: 'source-changed',
        },
        lock.signal,
      );
      this.observe({ event: 'stock-quarantined' });
    }
  }

  async claim(
    owner: DiskPoolOwner,
    requestId: string,
    lane: 'foreground' | 'admin',
    guard: ClaimGuard,
  ): Promise<boolean> {
    const options = this.options;
    if (!options) {
      if ((await this.status(owner, guard.signal)) === 'pending') incomplete();
      return false;
    }
    await this.checkClaim(guard);
    const binding = await this.inventory<Bind | null>(
      guard.signal,
      async (lock) => {
        const { slots, bound } = await this.ledger.read(lock.signal);
        const pending = pendingFor(slots, owner.personId, owner.vmId);
        if (pending) {
          const entry = pending.entry!;
          if (
            entry.state !== 'claiming' ||
            !sameDiskPoolOwner(entry.intent.owner, owner)
          )
            incomplete();
          return { slot: pending, entry: { ...entry, state: 'claiming' } };
        }
        // A completed claim without its normal disk cannot become a fresh one.
        if (bound.has(owner.vmId)) incomplete();
        if (lane === 'admin' && this.foreground) return null;
        await this.quarantineOldSource(slots, options.source, lock);
        const slot = slots.find(
          ({ entry }) =>
            entry?.state === 'ready' && entry.source === options.source,
        );
        if (!slot || slot.entry?.state !== 'ready') return null;
        const entry: Claiming = {
          ...slot.entry,
          state: 'claiming',
          intent: {
            id: randomUUID(),
            requestId,
            owner: {
              personId: owner.personId,
              organizationId: owner.organizationId,
              vmId: owner.vmId,
            },
          },
        };
        await guard.assertOwner();
        await lock.assertOwned();
        await this.ledger.append(slot, entry, lock.signal);
        return { slot: { ...slot, entry, revision: slot.revision + 1 }, entry };
      },
    );
    if (!binding) {
      this.observe({ event: 'pool-empty', lane });
      return false;
    }
    const { entry, slot } = binding;
    const finish = (state: 'bound' | 'claim-quarantined') =>
      this.inventory<boolean>(guard.signal, async (lock) => {
        await guard.assertOwner();
        await lock.assertOwned();
        await this.ledger.append(slot, { ...entry, state }, lock.signal);
        return true;
      });
    await this.checkClaim(guard);
    let state =
      entry.source === options.source
        ? await options.platform.inspectBinding(entry, guard.signal)
        : 'unknown';
    if (state === 'pending') {
      await this.checkClaim(guard);
      await options.platform.bindDisk(entry, guard.signal);
      state = await options.platform.inspectBinding(entry, guard.signal);
    }
    if (state === 'unknown') {
      await finish('claim-quarantined');
      this.observe({ event: 'claim-quarantined', lane });
    }
    if (state !== 'bound') incomplete();
    await this.checkClaim(guard);
    await finish('bound');
    this.observe({ event: 'claim-bound', lane });
    return true;
  }

  private async capacity(
    signal: AbortSignal,
    slots: DiskPoolSlot[],
    options: PersonVmDiskPoolOptions,
  ) {
    const inventory = slots.flatMap(({ entry }) =>
      !entry || vacant(entry)
        ? []
        : [
            {
              ref: entry.ref,
              ...((entry.state === 'claiming' ||
                entry.state === 'claim-quarantined') && {
                vmId: entry.intent.owner.vmId,
              }),
            },
          ],
    );
    const measured = await options.platform.readCapacity(inventory, signal);
    if (measured.availableBytes < 0n || measured.allocatedBytes < 0n)
      incomplete();
    return measured;
  }

  async availableBytes(signal: AbortSignal) {
    if (!this.options) incomplete();
    return (
      await this.capacity(
        signal,
        (await this.ledger.read(signal)).slots,
        this.options,
      )
    ).availableBytes;
  }

  private capacityDeferred(capacity: DiskPoolCapacity) {
    this.observe({
      event: 'capacity-deferred',
      availableBytes: String(capacity.availableBytes),
      allocatedBytes: String(capacity.allocatedBytes),
    });
  }

  async refill(signal: AbortSignal) {
    const options = this.options;
    if (!options) return;
    if (this.foreground) {
      this.observe({ event: 'foreground-deferred' });
      return;
    }
    await this.locks.withLock('fill', signal, async (fill) => {
      const active = fill.signal;
      const foregroundStarting = async () =>
        this.foreground || (await fill.foregroundStarting());
      const snapshot = await this.ledger.read(active);
      if (snapshot.slots.some(({ entry }) => unsettledFill(entry))) {
        // A released SQL socket does not prove a previous disk job finished.
        this.observe({ event: 'interrupted-fill' });
        return;
      }
      if (
        snapshot.slots.some(
          ({ entry }) =>
            entry?.state === 'ready' && entry.source !== options.source,
        )
      )
        await this.inventory<boolean>(active, async (lock) => {
          await this.quarantineOldSource(
            (await this.ledger.read(lock.signal)).slots,
            options.source,
            lock,
          );
          return true;
        });
      if (!snapshot.slots.some(({ entry }) => vacant(entry))) return;
      if (await foregroundStarting()) {
        this.observe({ event: 'foreground-deferred' });
        return;
      }
      const initial = await this.capacity(active, snapshot.slots, options);
      if (
        initial.availableBytes <
        options.minimumFreeBytes + options.reserveBytes
      ) {
        this.capacityDeferred(initial);
        return;
      }
      const reservation = await this.inventory<DiskPoolSlot | null>(
        active,
        async (lock) => {
          if (this.foreground) return null;
          const { slots } = await this.ledger.read(lock.signal);
          if (this.foreground) return null;
          if (slots.some(({ entry }) => unsettledFill(entry))) {
            this.observe({ event: 'interrupted-fill' });
            return null;
          }
          const slot = slots.find(({ entry }) => vacant(entry));
          if (!slot) return null;
          const entry = {
            ref: randomUUID(),
            source: options.source,
            state: 'filling',
          } as const;
          await fill.assertOwned();
          await lock.assertOwned();
          if (this.foreground) return null;
          await this.ledger.append(slot, entry, lock.signal);
          return { ...slot, entry, revision: slot.revision + 1 };
        },
      );
      if (!reservation) {
        if (this.foreground) this.observe({ event: 'foreground-deferred' });
        return;
      }
      const entry = reservation.entry!;
      const { platform, minimumFreeBytes, reserveBytes } = options;
      let unconfirmed = false;
      let wrote = false;
      const settle = (next: DiskPoolRecord, signal: AbortSignal) =>
        this.inventory<boolean>(signal, async (lock) => {
          await fill.assertOwned();
          await lock.assertOwned();
          await this.ledger.append(reservation, next, lock.signal);
          return true;
        });
      try {
        const check = await this.capacity(
          active,
          (await this.ledger.read(active)).slots,
          options,
        );
        if (await foregroundStarting()) {
          await settle({ ...entry, state: 'released-before-write' }, active);
          this.observe({ event: 'foreground-deferred' });
          return;
        }
        if (check.availableBytes < minimumFreeBytes + reserveBytes) {
          await settle({ ...entry, state: 'released-before-write' }, active);
          this.capacityDeferred(check);
          return;
        }
        await fill.assertOwned();
        active.throwIfAborted();
        let problem: unknown;
        try {
          wrote = true;
          await platform.createEncryptedDisk(entry.ref, active);
          const mount = await platform.mountDisk(entry.ref, active);
          const beforeSeed = await this.capacity(
            active,
            (await this.ledger.read(active)).slots,
            options,
          );
          const spent = beforeSeed.allocatedBytesByRef.get(entry.ref);
          if (spent === undefined) incomplete();
          if (
            spent >= reserveBytes ||
            beforeSeed.availableBytes <
              minimumFreeBytes + (reserveBytes - spent)
          ) {
            this.capacityDeferred(beforeSeed);
            throw new PersonVmError('PROVIDER_FAILED');
          }
          await fill.assertOwned();
          try {
            await platform.seedPublicCache(
              entry.ref,
              mount,
              entry.source,
              reserveBytes - spent,
              active,
            );
          } catch (error) {
            if (error instanceof DiskPoolBudgetExceeded)
              this.capacityDeferred(beforeSeed);
            throw error;
          }
        } catch (error) {
          problem = error;
        } finally {
          // Even a rejected attach can have reached the physical device.
          try {
            await platform.unmountDisk(
              entry.ref,
              AbortSignal.timeout(options.cleanupTimeoutMs),
            );
          } catch (error) {
            unconfirmed = true;
            problem = problem ? new AggregateError([problem, error]) : error;
          }
        }
        if (problem) throw problem;
        const proof = await platform.inspectStock(entry, active);
        const after = await this.capacity(
          active,
          (await this.ledger.read(active)).slots,
          options,
        );
        const allocated = after.allocatedBytesByRef.get(entry.ref);
        if (allocated === undefined) incomplete();
        if (allocated > reserveBytes) {
          this.capacityDeferred(after);
          throw new DiskPoolBudgetExceeded();
        }
        await settle({ ...entry, state: 'ready', proof }, active);
        this.observe({ event: 'stock-ready' });
      } catch (error) {
        if (!fill.ownerSignal.aborted) {
          try {
            await settle(
              wrote
                ? {
                    ...entry,
                    state: 'quarantined',
                    reason: unconfirmed
                      ? 'cleanup-unconfirmed'
                      : 'preparation-failed',
                  }
                : { ...entry, state: 'released-before-write' },
              fill.ownerSignal,
            );
          } catch (journalFailure) {
            incomplete(new AggregateError([error, journalFailure]));
          }
          if (wrote) this.observe({ event: 'stock-quarantined' });
        }
        if (unconfirmed) incomplete(error);
        if (active.aborted) throw error;
        this.observe({ event: 'fill-deferred' });
      }
    });
  }
}
