import { randomUUID } from 'node:crypto';
import { PersonVmError } from './contract.ts';
import {
  DiskPoolLedger,
  type DiskPoolRecord,
  type DiskPoolSlot,
} from './disk-pool-ledger.ts';
import {
  DiskPoolBudgetExceeded,
  DiskPoolForegroundDeferred,
  DiskPoolInventoryMismatch,
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
  assertTicket?(signal: AbortSignal): Promise<void>;
  /** Only for a first admin allocation whose person lease has no SQL VM row. */
  commitOwner?(signal: AbortSignal): Promise<void>;
}>;
type PoolEvent = Readonly<{
  event:
    | 'pool-empty'
    | 'capacity-deferred'
    | 'foreground-deferred'
    | 'interrupted-fill'
    | 'fill-deferred'
    | 'stock-ready'
    | 'stock-retired'
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
  !entry ||
  entry.state === 'bound' ||
  entry.state === 'retired' ||
  entry.state === 'released-before-write';
const unsettledFill = (entry: DiskPoolRecord | null) =>
  entry?.state === 'filling' ||
  entry?.state === 'retiring' ||
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

  async status(
    owner: DiskPoolOwner,
    signal: AbortSignal,
    verifyPriorRetirement?: (previous: DiskPoolOwner) => Promise<boolean>,
    allocating = false,
  ) {
    const { slots, bound, boundByPerson, ordinaryOwners } =
      await this.ledger.read(signal, allocating);
    const ordinary = ordinaryOwners.get(owner.vmId);
    if (verifyPriorRetirement) {
      for (const previous of [
        ...(boundByPerson.get(owner.personId) ?? []).map(
          ({ intent }) => intent.owner,
        ),
        ...[...ordinaryOwners.values()].filter(
          (saved) => saved.personId === owner.personId,
        ),
      ]) {
        if (previous.organizationId !== owner.organizationId)
          throw new PersonVmError('ORGANIZATION_CONFLICT');
        if (
          previous.vmId !== owner.vmId &&
          !(await verifyPriorRetirement(previous))
        )
          incomplete();
      }
    }
    const slot = pendingFor(slots, owner.personId, owner.vmId);
    if (slot) {
      const entry = slot.entry!;
      if (
        ordinary ||
        entry.state !== 'claiming' ||
        !sameDiskPoolOwner(entry.intent.owner, owner)
      )
        incomplete();
      return 'pending' as const;
    }
    const saved = bound.get(owner.vmId);
    if (saved && !sameDiskPoolOwner(saved.intent.owner, owner)) incomplete();
    if (ordinary) {
      if (saved || !sameDiskPoolOwner(ordinary, owner)) incomplete();
      return 'ordinary' as const;
    }
    return saved ? ('bound' as const) : ('none' as const);
  }

  async unaccountedFormalDisks(vmIds: readonly string[], signal: AbortSignal) {
    if (vmIds.length === 0) return [];
    const { slots, bound, ordinaryOwners } = await this.ledger.read(
      signal,
      true,
    );
    const pending = new Set(
      slots.flatMap(({ entry }) =>
        entry?.state === 'claiming' || entry?.state === 'claim-quarantined'
          ? [entry.intent.owner.vmId]
          : [],
      ),
    );
    return vmIds.filter(
      (id) => !bound.has(id) && !ordinaryOwners.has(id) && !pending.has(id),
    );
  }

  async recordOrdinaryOwner(owner: DiskPoolOwner, guard: ClaimGuard) {
    await this.checkClaim(guard);
    await this.ledger.recordOrdinaryOwner(owner, guard.signal, () =>
      this.checkClaim(guard),
    );
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

  private async checkClaim(guard: ClaimGuard, lock?: DiskPoolLock) {
    guard.signal.throwIfAborted();
    await guard.assertCurrent();
    await guard.assertOwner();
    guard.signal.throwIfAborted();
    if (lock) {
      await lock.assertOwned();
      lock.signal.throwIfAborted();
    }
    if (guard.assertTicket) {
      guard.signal.throwIfAborted();
      // Observe the admitted grant after the ownership calls have settled.
      await guard.assertTicket(lock?.signal ?? guard.signal);
      guard.signal.throwIfAborted();
      lock?.signal.throwIfAborted();
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
    if (guard.commitOwner) {
      guard.signal.throwIfAborted();
      await guard.assertCurrent();
    } else {
      await this.checkClaim(guard);
    }
    const binding = await this.inventory<Bind | null>(
      guard.signal,
      async (lock) => {
        const { slots, bound } = await this.ledger.read(lock.signal);
        const pending = pendingFor(slots, owner.personId, owner.vmId);
        if (pending) {
          const entry = pending.entry!;
          if (
            guard.commitOwner ||
            entry.state !== 'claiming' ||
            !sameDiskPoolOwner(entry.intent.owner, owner)
          )
            incomplete();
          return { slot: pending, entry: { ...entry, state: 'claiming' } };
        }
        // A completed claim without its normal disk cannot become a fresh one.
        if (bound.has(owner.vmId)) incomplete();
        if (lane === 'admin' && this.foreground) return null;
        const slot = slots.find(
          ({ entry }) =>
            entry?.state === 'ready' && entry.source === options.source,
        );
        if (!slot || slot.entry?.state !== 'ready') return null;
        if (guard.commitOwner) {
          await guard.assertCurrent();
          await lock.assertOwned();
          lock.signal.throwIfAborted();
          if (this.foreground) return null;
          await guard.commitOwner(lock.signal);
        }
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
        await this.ledger.append(slot, entry, lock.signal, () =>
          this.checkClaim(guard, lock),
        );
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
        await this.ledger.append(
          slot,
          { ...entry, state },
          lock.signal,
          async () => {
            if (state === 'bound') {
              await this.checkClaim(guard, lock);
            } else {
              await guard.assertOwner();
              await lock.assertOwned();
            }
          },
        );
        return true;
      });
    await this.checkClaim(guard);
    // A new seal changes stock eligibility, never an existing physical claim.
    let state = await options.platform.inspectBinding(entry, guard.signal);
    if (state === 'pending') {
      await this.checkClaim(guard);
      await options.platform.bindDisk(entry, guard.signal, () =>
        this.checkClaim(guard),
      );
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
    options: PersonVmDiskPoolOptions,
  ) {
    let { slots } = await this.ledger.read(signal);
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
      let measured: DiskPoolCapacity | undefined;
      let mismatch: unknown;
      try {
        measured = await options.platform.readCapacity(inventory, signal);
      } catch (error) {
        if (!(error instanceof DiskPoolInventoryMismatch)) throw error;
        mismatch = error;
      }
      const latest = (await this.ledger.read(signal)).slots;
      if (
        latest.every((slot, index) => slot.revision === slots[index]?.revision)
      ) {
        if (
          !measured ||
          measured.availableBytes < 0n ||
          measured.allocatedBytes < 0n
        )
          incomplete(mismatch);
        return measured;
      }
      slots = latest;
    }
    // Repeated catalog changes are a capacity deferral. An untracked file
    // against the same catalog revision is a maintenance error above.
    throw new DiskPoolBudgetExceeded();
  }

  async availableBytes(signal: AbortSignal) {
    if (!this.options) incomplete();
    try {
      return (await this.capacity(signal, this.options)).availableBytes;
    } catch (error) {
      if (error instanceof DiskPoolBudgetExceeded) return 0n;
      throw error;
    }
  }

  private capacityDeferred(
    capacity?: Pick<DiskPoolCapacity, 'availableBytes' | 'allocatedBytes'>,
  ) {
    this.observe({
      event: 'capacity-deferred',
      ...(capacity && {
        availableBytes: String(capacity.availableBytes),
        allocatedBytes: String(capacity.allocatedBytes),
      }),
    });
  }

  private advanceStock(
    slot: DiskPoolSlot,
    entry: DiskPoolRecord,
    fill: DiskPoolLock,
    signal: AbortSignal,
  ) {
    return this.inventory(signal, async (lock) => {
      await fill.assertOwned();
      await lock.assertOwned();
      await this.ledger.append(slot, entry, lock.signal);
      return { ...slot, entry, revision: slot.revision + 1 };
    });
  }

  private async retireStock(
    slot: DiskPoolSlot,
    proof: string,
    reason: 'source-changed' | 'preparation-deferred',
    fill: DiskPoolLock,
    options: PersonVmDiskPoolOptions,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const { ref, source } = slot.entry!;
    const stock = { ref, source, proof };
    const retiring = await this.advanceStock(
      slot,
      { ...stock, state: 'retiring', reason },
      fill,
      fill.ownerSignal,
    );
    try {
      // A later owner cannot reissue a retiring slot whose actual deletion did
      // not settle. Even during shutdown, join this exact physical operation.
      await options.platform.destroyStock(
        stock,
        AbortSignal.any([
          fill.ownerSignal,
          AbortSignal.timeout(options.cleanupTimeoutMs),
        ]),
      );
      await this.advanceStock(
        retiring,
        { ...stock, state: 'retired', reason },
        fill,
        fill.ownerSignal,
      );
    } catch (error) {
      incomplete(error);
    }
    this.observe({ event: 'stock-retired' });
  }

  private async prepareStock(
    reservation: DiskPoolSlot,
    fill: DiskPoolLock,
    options: PersonVmDiskPoolOptions,
    foregroundStarting: () => Promise<boolean>,
  ) {
    const entry = reservation.entry!;
    const active = fill.signal;
    const { platform, minimumFreeBytes, reserveBytes } = options;
    let mayHaveStorage = false;
    let created = false;
    let detached = false;
    let unconfirmed = false;
    let proof: string | undefined;
    let inspecting = false;
    let nextForegroundProbe = 0;
    const checkpoint = async (force = false) => {
      active.throwIfAborted();
      if (this.foreground) throw new DiskPoolForegroundDeferred();
      if (force || performance.now() >= nextForegroundProbe) {
        const busy = await foregroundStarting();
        // The local marker is checked at every write boundary. Remote
        // starting hints share this connection and are sampled at most 1 Hz.
        nextForegroundProbe = performance.now() + 1000;
        if (busy || this.foreground) throw new DiskPoolForegroundDeferred();
      }
      active.throwIfAborted();
    };
    try {
      const check = await this.capacity(active, options);
      await checkpoint();
      if (check.availableBytes < minimumFreeBytes + reserveBytes)
        throw new DiskPoolBudgetExceeded(check);
      await fill.assertOwned();
      await checkpoint(true);
      let problem: { error: unknown } | undefined;
      let rejectedBeforeKey: { error: unknown } | undefined;
      try {
        await platform.createEncryptedDisk(entry.ref, active, async () => {
          try {
            await checkpoint(true);
          } catch (error) {
            rejectedBeforeKey = { error };
            throw error;
          }
          mayHaveStorage = true;
        });
        if (!mayHaveStorage) incomplete();
        created = true;
        await checkpoint();
        const mount = await platform.mountDisk(entry.ref, active);
        const beforeSeed = await this.capacity(active, options);
        const spent = beforeSeed.allocatedBytesByRef.get(entry.ref);
        if (spent === undefined) incomplete();
        if (
          spent >= reserveBytes ||
          beforeSeed.availableBytes < minimumFreeBytes + reserveBytes - spent
        )
          throw new DiskPoolBudgetExceeded(beforeSeed);
        await fill.assertOwned();
        await checkpoint();
        await platform.seedPublicCache(
          entry.ref,
          mount,
          entry.source,
          { reserveBytes, minimumFreeBytes },
          active,
          () => checkpoint(),
        );
      } catch (error) {
        // Before the key-write guard succeeds, a known cancellation or its
        // own rejection cannot have allocated storage. An independent
        // preflight error can still mean conflicting or unidentified storage.
        if (!mayHaveStorage)
          mayHaveStorage = !(
            (active.aborted && error === active.reason) ||
            (rejectedBeforeKey && error === rejectedBeforeKey.error)
          );
        problem = { error };
      } finally {
        if (mayHaveStorage) {
          // A rejected attach can still have reached the physical device.
          try {
            await platform.unmountDisk(
              entry.ref,
              AbortSignal.timeout(options.cleanupTimeoutMs),
            );
            detached = true;
          } catch (error) {
            unconfirmed = true;
            problem = {
              error: problem
                ? new AggregateError([problem.error, error])
                : error,
            };
          }
        }
      }
      if (problem) throw problem.error;
      inspecting = true;
      // After complete seeding and confirmed detach, join proof under the
      // physical fill owner even if the scanner is being stopped.
      const settlement = AbortSignal.any([
        fill.ownerSignal,
        AbortSignal.timeout(options.cleanupTimeoutMs),
      ]);
      proof = await platform.inspectStock(entry, settlement);
      const after = await this.capacity(settlement, options);
      const allocated = after.allocatedBytesByRef.get(entry.ref);
      if (allocated === undefined) incomplete();
      if (allocated > reserveBytes || after.availableBytes < minimumFreeBytes)
        throw new DiskPoolBudgetExceeded(after);
    } catch (error) {
      if (error instanceof DiskPoolBudgetExceeded)
        this.capacityDeferred(error.capacity);
      const yielding = error instanceof DiskPoolForegroundDeferred;
      let confirmedYield = yielding && !mayHaveStorage;
      let first = error;
      if (!fill.ownerSignal.aborted) {
        const canRetire =
          created &&
          detached &&
          (error instanceof DiskPoolBudgetExceeded ||
            yielding ||
            active.aborted);
        let known = canRetire ? proof : undefined;
        if (canRetire && !known && !inspecting) {
          try {
            known = await platform.inspectStock(
              entry,
              AbortSignal.any([
                fill.ownerSignal,
                AbortSignal.timeout(options.cleanupTimeoutMs),
              ]),
            );
          } catch (inspectionFailure) {
            first = new AggregateError([error, inspectionFailure]);
          }
        }
        try {
          if (known) {
            await this.retireStock(
              reservation,
              known,
              'preparation-deferred',
              fill,
              options,
              fill.ownerSignal,
            );
            confirmedYield = yielding;
          } else {
            await this.advanceStock(
              reservation,
              mayHaveStorage
                ? {
                    ...entry,
                    state: 'quarantined',
                    reason: unconfirmed
                      ? 'cleanup-unconfirmed'
                      : 'preparation-failed',
                  }
                : { ...entry, state: 'released-before-write' },
              fill,
              fill.ownerSignal,
            );
            if (mayHaveStorage) this.observe({ event: 'stock-quarantined' });
          }
        } catch (cleanupFailure) {
          incomplete(new AggregateError([first, cleanupFailure]));
        }
      }
      if (
        unconfirmed ||
        (yielding && !confirmedYield) ||
        (first instanceof PersonVmError && first.code === 'CLEANUP_INCOMPLETE')
      )
        incomplete(first);
      if (active.aborted) throw first;
      this.observe({
        event: yielding ? 'foreground-deferred' : 'fill-deferred',
      });
      return;
    }
    // Once publication is attempted, a lost acknowledgement can already
    // have admitted the disk. No failure path here may delete it.
    if (!proof) incomplete();
    await this.advanceStock(
      reservation,
      { ...entry, state: 'ready', proof },
      fill,
      fill.ownerSignal,
    );
    this.observe({ event: 'stock-ready' });
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
        this.foreground > 0 || (await fill.foregroundStarting());
      const snapshot = await this.ledger.read(active);
      if (snapshot.slots.some(({ entry }) => unsettledFill(entry))) {
        this.observe({ event: 'interrupted-fill' });
        return;
      }
      const obsolete = snapshot.slots.find(
        ({ entry }) =>
          entry?.state === 'ready' && entry.source !== options.source,
      );
      if (!obsolete && !snapshot.slots.some(({ entry }) => vacant(entry)))
        return;
      if (await foregroundStarting()) {
        this.observe({ event: 'foreground-deferred' });
        return;
      }
      try {
        await options.platform.assertSourceFitsReserve?.(
          options.reserveBytes,
          active,
        );
        if (await foregroundStarting()) {
          this.observe({ event: 'foreground-deferred' });
          return;
        }
        if (obsolete?.entry?.state === 'ready')
          await this.retireStock(
            obsolete,
            obsolete.entry.proof,
            'source-changed',
            fill,
            options,
            active,
          );
        const initial = await this.capacity(active, options);
        if (
          initial.availableBytes <
          options.minimumFreeBytes + options.reserveBytes
        )
          throw new DiskPoolBudgetExceeded(initial);
      } catch (error) {
        if (!(error instanceof DiskPoolBudgetExceeded)) throw error;
        this.capacityDeferred(error.capacity);
        return;
      }
      active.throwIfAborted();
      let acknowledged:
        { slot: DiskPoolSlot; inventoryOwner: AbortSignal } | undefined;
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
          const elected = { ...slot, entry, revision: slot.revision + 1 };
          // Only the durable append acknowledgement proves that this exact
          // empty slot can be released if the wrapper reports cancellation.
          acknowledged = { slot: elected, inventoryOwner: lock.ownerSignal };
          return elected;
        },
      ).catch(async (error: unknown) => {
        if (
          acknowledged &&
          signal.aborted &&
          error === signal.reason &&
          !fill.ownerSignal.aborted &&
          !acknowledged.inventoryOwner.aborted
        ) {
          const slot = acknowledged.slot;
          try {
            await this.advanceStock(
              slot,
              { ...slot.entry!, state: 'released-before-write' },
              fill,
              fill.ownerSignal,
            );
          } catch (cleanup) {
            incomplete(new AggregateError([error, cleanup]));
          }
        }
        throw error;
      });
      if (reservation)
        await this.prepareStock(reservation, fill, options, foregroundStarting);
      else if (this.foreground) this.observe({ event: 'foreground-deferred' });
    });
  }
}
