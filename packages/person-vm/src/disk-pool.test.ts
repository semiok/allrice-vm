import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import { PersonVmError } from './contract.ts';
import { DiskPoolLedger } from './disk-pool-ledger.ts';
import {
  type DiskPoolClaim,
  type DiskPoolLock,
  type DiskPoolLocks,
  type DiskPoolPlatform,
  type DiskPoolStock,
} from './disk-pool-platform.ts';
import { PersonVmDiskPool } from './disk-pool.ts';
import { PersonVmService } from './person-vm.ts';
import { context, harness, MemoryStore, signal } from './test-support.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type Lane = 'fill' | 'inventory';
class Locks implements DiskPoolLocks {
  foreground = false;
  private held = new Map<
    Lane,
    { done: ReturnType<typeof gate>; owner: AbortController }
  >();
  async withLock<T>(
    kind: Lane,
    signal: AbortSignal,
    work: (lock: DiskPoolLock) => Promise<T>,
  ) {
    for (let other = this.held.get(kind); other; other = this.held.get(kind)) {
      if (kind === 'fill') return undefined;
      await other.done.promise;
    }
    signal.throwIfAborted();
    const done = gate();
    const owner = new AbortController();
    const item = { done, owner };
    this.held.set(kind, item);
    const active = AbortSignal.any([owner.signal, signal]);
    try {
      return await work({
        signal: active,
        ownerSignal: owner.signal,
        assertOwned: async () => owner.signal.throwIfAborted(),
        foregroundStarting: async () => this.foreground,
      });
    } finally {
      if (this.held.get(kind) === item) this.held.delete(kind);
      done.release();
    }
  }
  dropFillSession() {
    const item = this.held.get('fill');
    if (!item) throw Error('missing fill lock');
    this.held.delete('fill');
    item.owner.abort(Error('filled owner SQL disconnected'));
    item.done.release();
  }
}

type CrashAt = 'intent' | 'image' | 'key' | 'revocation' | 'receipt';
type FakeDisk = {
  image: string;
  key: string;
  mounted: boolean;
  seeded: string | null;
  temporaryKey: boolean;
  target?: string;
  stage: number;
};
class Platform implements DiskPoolPlatform {
  readonly disks = new Map<string, FakeDisk>();
  readonly binds: DiskPoolClaim[] = [];
  readonly minimumOwnerProof: DiskPoolClaim[] = [];
  available = 1000n;
  crash?: CrashAt;
  conflict = false;
  unsafeMount = false;
  onCapacity?: () => void;
  onSeed?: () => Promise<void>;
  onBinding?: () => Promise<void>;
  onUnmount?: () => Promise<void>;
  constructor(private readonly installed: (id: string) => void) {}
  private current(ref: string) {
    return this.disks.get(ref)!;
  }
  async readCapacity() {
    this.onCapacity?.();
    const allocatedBytesByRef = new Map(
      [...this.disks].map(([ref, disk]) => [ref, disk.seeded ? 100n : 10n]),
    );
    return {
      availableBytes: this.available,
      allocatedBytes: [...allocatedBytesByRef.values()].reduce(
        (n, size) => n + size,
        0n,
      ),
      allocatedBytesByRef,
    };
  }
  async createEncryptedDisk(ref: string) {
    expect(this.disks.has(ref)).toBe(false);
    this.disks.set(ref, {
      image: randomUUID(),
      key: randomUUID(),
      mounted: false,
      seeded: null,
      temporaryKey: true,
      stage: 0,
    });
  }
  async mountDisk(ref: string) {
    this.current(ref).mounted = true;
    return `opaque-${ref}`;
  }
  async seedPublicCache(
    ref: string,
    mount: string,
    source: string,
    budget: bigint,
  ) {
    expect(mount).toBe(`opaque-${ref}`);
    expect(this.current(ref).mounted).toBe(true);
    expect(budget).toBeGreaterThan(0n);
    await this.onSeed?.();
    this.current(ref).seeded = source;
  }
  async unmountDisk(ref: string) {
    await this.onUnmount?.();
    if (this.unsafeMount) throw Error('fake physical detach unconfirmed');
    this.current(ref).mounted = false;
  }
  async inspectStock(stock: DiskPoolStock) {
    const disk = this.current(stock.ref);
    expect(disk.mounted).toBe(false);
    expect(disk.seeded).toBe(stock.source);
    return `${disk.image}/${disk.key}`;
  }
  private at(stage: CrashAt) {
    if (this.crash !== stage) return;
    this.crash = undefined;
    throw Error(`fake cut at ${stage}`);
  }
  async inspectBinding(claim: DiskPoolClaim) {
    this.minimumOwnerProof.push(structuredClone(claim));
    this.at('intent');
    const disk = this.current(claim.ref);
    if (
      this.conflict ||
      disk.mounted ||
      (disk.target && disk.target !== claim.intent.owner.vmId)
    )
      return 'unknown' as const;
    expect(claim.proof).toBe(await this.inspectStock(claim));
    return disk.stage === 4 ? ('bound' as const) : ('pending' as const);
  }
  async bindDisk(claim: DiskPoolClaim) {
    this.binds.push(structuredClone(claim));
    await this.onBinding?.();
    const disk = this.current(claim.ref);
    if (!disk.stage) {
      disk.target = claim.intent.owner.vmId;
      disk.stage = 1;
      this.at('image');
    }
    if (disk.stage === 1) {
      disk.stage = 2;
      this.at('key');
    }
    if (disk.stage === 2) {
      disk.temporaryKey = false;
      disk.stage = 3;
      this.at('revocation');
    }
    if (disk.stage === 3) {
      this.installed(disk.target!);
      disk.stage = 4;
      this.at('receipt');
    }
  }
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ar-pool-')));
  roots.push(root);
  const store = new MemoryStore();
  const h = harness(store);
  const locks = new Locks();
  const platform = new Platform((vmId) => {
    h.disks.add(vmId);
    h.diskTiers.set(vmId, 'warm');
  });
  const events = vi.fn();
  const newPool = (enabled = true, source = 'public@digest/manifest') =>
    new PersonVmDiskPool(
      root,
      locks,
      events,
      enabled
        ? {
            platform,
            source,
            minimumFreeBytes: 200n,
            reserveBytes: 300n,
            cleanupTimeoutMs: 5000,
          }
        : undefined,
    );
  const pool = newPool();
  const serviceFor = (diskPool: PersonVmDiskPool) =>
    new PersonVmService({ ...h.options, diskPool });
  const service = serviceFor(pool);
  return {
    h,
    root,
    store,
    locks,
    platform,
    pool,
    service,
    serviceFor,
    newPool,
    events,
    ledger: new DiskPoolLedger(root),
  };
}

function adminTarget(rc: RequestContext) {
  return {
    personId: rc.actor.id,
    organizationId: rc.organizationId,
    workspaceId: randomUUID(),
    employeeInstanceId: randomUUID(),
    employeeRevision: 1,
    employeeVersionId: randomUUID(),
    platformRevisionId: null,
    policyRevision: 'committed-test-revision',
  };
}
const adminGuard = () => ({
  signal: signal(),
  assertCurrent: vi.fn(async () => {}),
  assertCapacity: vi.fn(async () => {}),
});

it('has three independent offline slots, claims three of five parallel first workbench opens, then replenishes', async () => {
  const f = await fixture();
  for (let i = 0; i < 4; i++) await f.pool.refill(signal());
  expect(f.platform.disks.size).toBe(3);
  expect(
    new Set([...f.platform.disks.values()].map((disk) => disk.image)).size,
  ).toBe(3);
  expect(
    new Set([...f.platform.disks.values()].map((disk) => disk.key)).size,
  ).toBe(3);
  expect([...f.platform.disks.values()].map((disk) => disk.mounted)).toEqual([
    false,
    false,
    false,
  ]);
  expect(f.h.log).toEqual([]);
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.service.prewarm(context(), { trigger: 'page' }, signal()),
    ),
  );
  expect(results.every((result) => result.ready)).toBe(true);
  expect(new Set(f.platform.binds.map((bind) => bind.ref)).size).toBe(3);
  expect(f.h.log.filter((entry) => entry === 'disk:create')).toHaveLength(2);
  expect(
    f.events.mock.calls.filter(([value]) => value.event === 'pool-empty'),
  ).toHaveLength(2);
  expect(
    [...f.platform.disks.values()].every((disk) => !disk.temporaryKey),
  ).toBe(true);
  expect((await f.ledger.read(signal())).bound.size).toBe(3);
  await f.pool.refill(signal());
  expect(f.platform.disks.size).toBe(4);
  expect(
    (await f.ledger.read(signal())).slots.filter(
      ({ entry }) => entry?.state === 'ready',
    ),
  ).toHaveLength(1);
});

it('leaves the admin row absent for a proven empty pool and immediately follows the original foreground path', async () => {
  const f = await fixture();
  const rc = context();
  const result = await f.service
    .diskPreparationPort()
    .prepare(adminTarget(rc), adminGuard());
  expect(result).toBe('deferred');
  expect(await f.store.read(rc.actor.id)).toBeNull();
  expect(
    await f.service.prewarm(rc, { trigger: 'page' }, signal()),
  ).toMatchObject({ phase: 'running', ready: true });
  expect(f.h.log.filter((entry) => entry === 'disk:create')).toHaveLength(1);
  expect(f.events.mock.calls.map(([value]) => value)).toEqual([
    { event: 'pool-empty', lane: 'admin' },
    { event: 'pool-empty', lane: 'foreground' },
  ]);
});

it('serializes admin and first workbench for one person and preserves the same disk for another employee in that enterprise', async () => {
  const f = await fixture();
  const rc = context();
  const firstEmployee = adminTarget(rc);
  const started = gate(),
    finish = gate();
  f.platform.onBinding = async () => {
    started.release();
    await finish.promise;
  };
  await f.pool.refill(signal());
  const admin = f.service.diskPreparationPort();
  const guard = adminGuard();
  const preparing = admin.prepare(firstEmployee, guard);
  try {
    await started.promise;
    const saved = await f.store.read(rc.actor.id);
    const event = f.platform.binds[0]!;
    expect(saved).toMatchObject(event.intent.owner);
    expect(Object.keys(event.intent.owner).sort()).toEqual([
      'organizationId',
      'personId',
      'vmId',
    ]);
    expect(await f.ledger.read(signal())).toMatchObject({
      slots: expect.arrayContaining([
        expect.objectContaining({
          entry: expect.objectContaining({ state: 'claiming' }),
        }),
      ]),
    });
    await expect(
      f.service.prewarm(rc, { trigger: 'input' }, signal()),
    ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
    expect(f.h.log).toEqual([]);
  } finally {
    finish.release();
  }
  expect(await preparing).toBe('prepared');
  const stopped = await f.store.read(rc.actor.id);
  expect(stopped?.phase).toBe('stopped');
  const secondEmployee = adminTarget(rc);
  expect(secondEmployee.employeeInstanceId).not.toBe(
    firstEmployee.employeeInstanceId,
  );
  expect(await admin.prepare(secondEmployee, adminGuard())).toBe(
    'already-prepared',
  );
  expect(
    await f.service.prewarm(rc, { trigger: 'page' }, signal()),
  ).toMatchObject({ vmId: stopped?.vmId, ready: true });
  await expect(
    f.service.create(context(randomUUID(), rc.actor.id), signal()),
  ).rejects.toMatchObject({ code: 'ORGANIZATION_CONFLICT' });
  expect(f.platform.binds).toHaveLength(1);
  expect(guard.assertCurrent.mock.calls.length).toBeGreaterThan(1);
  expect(
    f.store.audits
      .filter((event) => event.action === 'disk-preprovision')
      .map((event) => event.result),
  ).toEqual(['started', 'succeeded']);
});

it('lets an entered foreground win over admin allocation under the existing physical lease', async () => {
  const f = await fixture();
  const rc = context();
  const started = gate(),
    finish = gate();
  f.platform.onBinding = async () => {
    started.release();
    await finish.promise;
  };
  await f.pool.refill(signal());
  const opening = f.service.prewarm(rc, { trigger: 'page' }, signal());
  try {
    await started.promise;
    expect(
      await f.service
        .diskPreparationPort()
        .prepare(adminTarget(rc), adminGuard()),
    ).toBe('deferred');
    expect(f.platform.binds).toHaveLength(1);
  } finally {
    finish.release();
  }
  expect(await opening).toMatchObject({ ready: true });
  expect(
    f.store.audits.filter((event) => event.action === 'disk-preprovision'),
  ).toHaveLength(0);
});

it('checks capacity again before creating a disk and yields to foreground before allocating', async () => {
  const f = await fixture();
  f.platform.available = 499n;
  await f.pool.refill(signal());
  expect(f.events).toHaveBeenCalledWith({
    event: 'capacity-deferred',
    availableBytes: '499',
    allocatedBytes: '0',
  });
  expect(f.platform.disks.size).toBe(0);
  f.platform.available = 1000n;
  let checks = 0;
  f.platform.onCapacity = () => {
    if (++checks === 2) f.platform.available = 499n;
  };
  await f.pool.refill(signal());
  expect(f.platform.disks.size).toBe(0);
  expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe(
    'released-before-write',
  );
  f.platform.onCapacity = undefined;
  f.platform.available = 1000n;
  await f.pool.inForeground(() => f.pool.refill(signal()));
  expect(f.events).toHaveBeenCalledWith({ event: 'foreground-deferred' });
  expect(f.platform.disks.size).toBe(0);
  f.locks.foreground = true;
  await f.newPool().refill(signal());
  expect(f.platform.disks.size).toBe(0);
  f.locks.foreground = false;
  await f.pool.refill(signal());
  expect(f.platform.disks.size).toBe(1);
});

it('enforces one filler without holding inventory while copying or blocking a foreground fallback', async () => {
  const f = await fixture();
  const entered = gate(),
    finish = gate();
  f.platform.onSeed = async () => {
    entered.release();
    await finish.promise;
  };
  const filling = f.pool.refill(signal());
  try {
    await entered.promise;
    await Promise.all([f.newPool().refill(signal()), f.pool.refill(signal())]);
    const opening = await f.service.prewarm(
      context(),
      { trigger: 'page' },
      signal(),
    );
    expect(opening.ready).toBe(true);
    expect(f.platform.disks.size).toBe(1);
    expect(f.h.log.filter((entry) => entry === 'disk:create')).toHaveLength(1);
  } finally {
    finish.release();
  }
  await filling;
  expect([...f.platform.disks.values()][0]?.mounted).toBe(false);
});

it('preserves a reservation through a lost fill SQL connection and does not start a second filler', async () => {
  const f = await fixture();
  const entered = gate(),
    finish = gate();
  f.platform.onSeed = async () => {
    entered.release();
    await finish.promise;
  };
  const filling = f.pool.refill(signal());
  const original = expect(filling).rejects.toThrow(
    'filled owner SQL disconnected',
  );
  try {
    await entered.promise;
    f.locks.dropFillSession();
    await f.newPool().refill(signal());
    expect(f.platform.disks.size).toBe(1);
    expect(f.events).toHaveBeenCalledWith({ event: 'interrupted-fill' });
  } finally {
    finish.release();
  }
  await original;
  expect([...f.platform.disks.values()][0]?.mounted).toBe(false);
  expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe(
    'filling',
  );
});

it('joins an aborted fill to real detach and reports an unconfirmed detach as a durable maintenance problem', async () => {
  const f = await fixture();
  const entered = gate(),
    finish = gate();
  f.platform.onUnmount = async () => {
    entered.release();
    await finish.promise;
  };
  f.platform.unsafeMount = true;
  const cancel = new AbortController();
  const filling = f.pool.refill(cancel.signal);
  const result = expect(filling).rejects.toMatchObject({
    code: 'CLEANUP_INCOMPLETE',
  });
  try {
    await entered.promise;
    cancel.abort();
    expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe(
      'filling',
    );
    await f.newPool().refill(signal());
    expect(f.platform.disks.size).toBe(1);
  } finally {
    finish.release();
  }
  await result;
  expect((await f.ledger.read(signal())).slots[0]?.entry).toMatchObject({
    state: 'quarantined',
    reason: 'cleanup-unconfirmed',
  });
  await f.newPool().refill(signal());
  expect(f.platform.disks.size).toBe(1);
  expect(f.events).toHaveBeenCalledWith({ event: 'interrupted-fill' });
});

it.each<CrashAt>(['intent', 'image', 'key', 'revocation', 'receipt'])(
  'recovers the same durable claim after the %s stage is interrupted',
  async (stage) => {
    const f = await fixture();
    await f.pool.refill(signal());
    const rc = context();
    f.platform.crash = stage;
    await expect(
      f.service.prewarm(rc, { trigger: 'page' }, signal()),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    const original = f.platform.minimumOwnerProof[0]!;
    expect((await f.ledger.read(signal())).slots[0]?.entry).toMatchObject({
      intent: original.intent,
      state: 'claiming',
    });
    expect(f.h.log).toEqual([]);
    const restarted = f.serviceFor(f.newPool());
    await expect(restarted.start(rc, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    await expect(
      restarted.prewarm(
        { ...rc, requestId: randomUUID() },
        { trigger: 'page' },
        signal(),
      ),
    ).resolves.toMatchObject({ vmId: original.intent.owner.vmId, ready: true });
    const all = f.platform.minimumOwnerProof;
    expect(
      all.every(
        (entry) =>
          entry.intent.id === original.intent.id &&
          entry.intent.requestId === rc.requestId &&
          entry.proof === original.proof,
      ),
    ).toBe(true);
    expect(f.platform.disks.size).toBe(1);
    expect(f.h.log).not.toContain('disk:create');
    expect(
      (await f.ledger.read(signal())).bound.get(original.intent.owner.vmId),
    ).toMatchObject({ intent: original.intent });
  },
);

it('isolates a conflicting physical binding and prevents later fallback or reissue even when the pool is disabled', async () => {
  const f = await fixture();
  const first = context();
  await f.pool.refill(signal());
  f.platform.conflict = true;
  await expect(
    f.service.prewarm(first, { trigger: 'input' }, signal()),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  const retained = (await f.ledger.read(signal())).slots[0]?.entry;
  expect(retained).toMatchObject({ state: 'claim-quarantined' });
  const off = f.serviceFor(f.newPool(false));
  await expect(
    off.prewarm(first, { trigger: 'page' }, signal()),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  expect(f.platform.binds).toHaveLength(0);
  const second = await off.create(context(), signal());
  expect(second.phase).toBe('stopped');
  expect(f.h.log.filter((entry) => entry === 'disk:create')).toHaveLength(1);
  expect((await f.ledger.read(signal())).slots[0]?.entry).toEqual(retained);
});

it('does not reopen inventory from an obsolete public image generation', async () => {
  const f = await fixture();
  await f.pool.refill(signal());
  const newVersion = f.newPool(true, 'new@digest/manifest');
  await newVersion.refill(signal());
  const slots = (await f.ledger.read(signal())).slots;
  expect(slots[0]?.entry).toMatchObject({
    state: 'quarantined',
    reason: 'source-changed',
  });
  expect(slots[1]?.entry?.state).toBe('ready');
  await f.serviceFor(f.newPool()).create(context(), signal());
  expect(f.platform.binds).toHaveLength(0);
  expect(f.platform.disks.size).toBe(2);
});

it('preserves the initial target and disk when roster authority is withdrawn during binding', async () => {
  const f = await fixture();
  await f.pool.refill(signal());
  const rc = context();
  const guard = adminGuard();
  f.platform.onBinding = async () => {
    guard.assertCurrent.mockRejectedValue(
      new PersonVmError('AUTHORIZATION_DENIED'),
    );
  };
  await expect(
    f.service.diskPreparationPort().prepare(adminTarget(rc), guard),
  ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
  const first = f.platform.binds[0]!;
  expect((await f.ledger.read(signal())).slots[0]?.entry).toMatchObject({
    state: 'claiming',
    intent: first.intent,
  });
  expect((await f.store.read(rc.actor.id))?.phase).toBe('failed');
  await expect(
    f.service.prewarm(rc, { trigger: 'page' }, signal()),
  ).resolves.toMatchObject({ vmId: first.intent.owner.vmId, ready: true });
  expect(f.platform.binds).toHaveLength(1);
});
