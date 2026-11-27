import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import type * as Filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import { PersonVmError } from './contract.ts';
import { DiskPoolLedger } from './disk-pool-ledger.ts';
import {
  DiskPoolBudgetExceeded,
  DiskPoolInventoryMismatch,
  type DiskPoolClaim,
  type DiskPoolLock,
  type DiskPoolLocks,
  type DiskPoolPlatform,
  type DiskPoolStock,
  type PreparedDiskPoolStock,
} from './disk-pool-platform.ts';
import { PersonVmDiskPool } from './disk-pool.ts';
import { PersonVmService } from './person-vm.ts';
import { context, harness, MemoryStore, signal } from './test-support.ts';

const faults = vi.hoisted(() => ({
  afterLedgerFileSync: undefined as (() => void) | undefined,
  afterDirectorySync: undefined as ((path: string) => void) | undefined,
  managedParent: undefined as
    { path: string; error: NodeJS.ErrnoException } | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof Filesystem>();
  return {
    ...fs,
    async lstat(...args: Parameters<typeof fs.lstat>) {
      const info = await fs.lstat(...args);
      if (
        faults.managedParent?.path === String(args[0]) &&
        info &&
        typeof info.uid === 'number'
      )
        info.uid += 1;
      return info;
    },
    async access(...args: Parameters<typeof fs.access>) {
      if (faults.managedParent?.path === String(args[0]))
        throw Error('unexpected access probe for managed directory');
      return fs.access(...args);
    },
    async open(...args: Parameters<typeof fs.open>) {
      if (faults.managedParent?.path === String(args[0]))
        throw faults.managedParent.error;
      const file = await fs.open(...args);
      if (
        faults.afterLedgerFileSync &&
        String(args[0]).includes('/.preprovision-ledger/.stage-')
      ) {
        const sync = file.sync.bind(file);
        vi.spyOn(file, 'sync').mockImplementation(async () => {
          await sync();
          faults.afterLedgerFileSync?.();
        });
      } else if (
        faults.afterDirectorySync &&
        (await file.stat()).isDirectory()
      ) {
        const sync = file.sync.bind(file);
        vi.spyOn(file, 'sync').mockImplementation(async () => {
          await sync();
          faults.afterDirectorySync?.(String(args[0]));
        });
      }
      return file;
    },
  };
});

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
  foregroundChecks = 0;
  beforeInventory?: (signal: AbortSignal) => void;
  afterInventory?: () => Promise<void>;
  onInventoryOwnerCheck?: (signal: AbortSignal) => Promise<void>;
  private held = new Map<
    Lane,
    { done: ReturnType<typeof gate>; owner: AbortController }
  >();
  async withLock<T>(
    kind: Lane,
    signal: AbortSignal,
    work: (lock: DiskPoolLock) => Promise<T>,
  ) {
    if (kind === 'inventory') this.beforeInventory?.(signal);
    for (let other = this.held.get(kind); other; other = this.held.get(kind)) {
      if (kind === 'fill') return undefined;
      signal.throwIfAborted();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
      });
      signal.addEventListener('abort', abort, { once: true });
      try {
        await Promise.race([other.done.promise, cancelled]);
      } finally {
        signal.removeEventListener('abort', abort);
      }
    }
    signal.throwIfAborted();
    const done = gate();
    const owner = new AbortController();
    const item = { done, owner };
    this.held.set(kind, item);
    const active = AbortSignal.any([owner.signal, signal]);
    try {
      const value = await work({
        signal: active,
        ownerSignal: owner.signal,
        assertOwned: async () => {
          if (kind === 'inventory' && this.onInventoryOwnerCheck)
            await this.onInventoryOwnerCheck(active);
          owner.signal.throwIfAborted();
        },
        foregroundStarting: async () => {
          this.foregroundChecks += 1;
          return this.foreground;
        },
      });
      if (kind === 'inventory') await this.afterInventory?.();
      active.throwIfAborted();
      return value;
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
  readonly destroyed: string[] = [];
  readonly binds: DiskPoolClaim[] = [];
  readonly minimumOwnerProof: DiskPoolClaim[] = [];
  available = 1000n;
  crash?: CrashAt;
  conflict = false;
  unsafeMount = false;
  onCapacity?: () => void | Promise<void>;
  onCreationBudget?: () => Promise<void>;
  onCreatePreflight?: () => Promise<void>;
  onSeed?: (checkpoint?: () => Promise<void>) => Promise<void>;
  onInspect?: (scoped: AbortSignal) => Promise<void>;
  onBinding?: () => Promise<void>;
  onUnmount?: () => Promise<void>;
  constructor(private readonly installed: (id: string) => void) {}
  private current(ref: string) {
    return this.disks.get(ref)!;
  }
  async readCapacity(inventory: readonly { ref: string; vmId?: string }[]) {
    await this.onCapacity?.();
    if (
      [...this.disks].some(
        ([ref, disk]) =>
          !disk.target && !inventory.some((stock) => stock.ref === ref),
      )
    )
      throw new DiskPoolInventoryMismatch();
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
  async createEncryptedDisk(
    ref: string,
    _current?: AbortSignal,
    beforeKeyWrite?: () => Promise<void>,
  ) {
    expect(this.disks.has(ref)).toBe(false);
    if (this.onCreatePreflight) await this.onCreatePreflight();
    if (beforeKeyWrite) await beforeKeyWrite();
    this.disks.set(ref, {
      image: randomUUID(),
      key: randomUUID(),
      mounted: false,
      seeded: null,
      temporaryKey: true,
      stage: 0,
    });
  }
  async assertSourceFitsReserve() {
    await this.onCreationBudget?.();
  }
  async mountDisk(ref: string) {
    this.current(ref).mounted = true;
    return `opaque-${ref}`;
  }
  async seedPublicCache(
    ref: string,
    mount: string,
    source: string,
    budget: { reserveBytes: bigint; minimumFreeBytes: bigint },
    _signal: AbortSignal,
    checkpoint?: () => Promise<void>,
  ) {
    expect(mount).toBe(`opaque-${ref}`);
    expect(this.current(ref).mounted).toBe(true);
    expect(budget.reserveBytes).toBeGreaterThan(0n);
    await this.onSeed?.(checkpoint);
    this.current(ref).seeded = source;
  }
  async unmountDisk(ref: string) {
    await this.onUnmount?.();
    if (this.unsafeMount) throw Error('fake physical detach unconfirmed');
    this.current(ref).mounted = false;
  }
  async inspectStock(stock: DiskPoolStock, scoped = signal()) {
    await this.onInspect?.(scoped);
    const disk = this.current(stock.ref);
    expect(disk.mounted).toBe(false);
    return `${disk.image}/${disk.key}`;
  }
  async destroyStock(stock: PreparedDiskPoolStock) {
    const disk = this.current(stock.ref);
    expect(disk.target).toBeUndefined();
    expect(disk.temporaryKey).toBe(true);
    expect(stock.proof).toBe(await this.inspectStock(stock));
    this.disks.delete(stock.ref);
    this.destroyed.push(stock.ref);
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
  async bindDisk(
    claim: DiskPoolClaim,
    _scoped?: AbortSignal,
    beforeManifestLink?: () => Promise<void>,
  ) {
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
      await beforeManifestLink?.();
      this.installed(disk.target!);
      disk.stage = 4;
      this.at('receipt');
    }
  }
}

const roots: string[] = [];
afterEach(async () => {
  faults.afterLedgerFileSync = undefined;
  faults.afterDirectorySync = undefined;
  faults.managedParent = undefined;
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

it.each([false, true])(
  'persists lazy catalog ancestry before publishing an owner receipt (already created=%s)',
  async (existing) => {
    const f = await fixture();
    const parent = join(f.root, 'volume', 'people');
    const disk = join(parent, 'disks');
    const catalog = join(disk, '.preprovision-ledger');
    if (existing) await mkdir(catalog, { mode: 0o700, recursive: true });
    const synced: string[] = [];
    faults.afterDirectorySync = (path) => synced.push(path);
    const ledger = new DiskPoolLedger(disk);
    const owner = {
      personId: randomUUID(),
      organizationId: randomUUID(),
      vmId: randomUUID(),
    };
    const beforeLink = vi.fn(async () => {
      expect(synced.slice(0, 4)).toEqual([
        disk,
        parent,
        join(f.root, 'volume'),
        f.root,
      ]);
    });
    await ledger.recordOrdinaryOwner(owner, signal(), beforeLink);
    expect(beforeLink).toHaveBeenCalledOnce();
    expect(synced).toContain(catalog);
    expect(
      (await ledger.read(signal(), true)).ordinaryOwners.get(owner.vmId),
    ).toMatchObject(owner);
  },
);

it.each([
  { edge: 'pre-existing unreadable', existing: true, code: 'EACCES' },
  {
    edge: 'newly created with unreadable parent',
    existing: false,
    code: 'EACCES',
  },
  { edge: 'pre-existing with I/O failure', existing: true, code: 'EIO' },
])(
  'fails closed before publishing a receipt through a managed parent ($edge)',
  async ({ existing, code }) => {
    const f = await fixture();
    const disk = join(f.root, 'disks');
    if (existing) await mkdir(disk, { mode: 0o700 });
    const failure = Object.assign(
      Error('synthetic managed parent open failure'),
      { code },
    );
    faults.managedParent = { path: f.root, error: failure };
    const ledger = new DiskPoolLedger(disk);
    const owner = {
      personId: randomUUID(),
      organizationId: randomUUID(),
      vmId: randomUUID(),
    };
    const beforeLink = vi.fn(async () => {});
    await expect(
      ledger.recordOrdinaryOwner(owner, signal(), beforeLink),
    ).rejects.toBe(failure);
    expect(beforeLink).not.toHaveBeenCalled();
    expect(await readdir(join(disk, '.preprovision-ledger'))).toEqual([]);
  },
);

it('stops a cold disk allocation when the managed catalog parent cannot be synced', async () => {
  const f = await fixture();
  const disk = join(f.root, 'disks');
  await mkdir(disk, { mode: 0o700 });
  const failure = Object.assign(Error('synthetic managed parent read denied'), {
    code: 'EACCES',
  });
  faults.managedParent = { path: f.root, error: failure };
  const create = vi.spyOn(f.h.disk, 'create');
  const service = f.serviceFor(new PersonVmDiskPool(disk, f.locks, f.events));
  await expect(service.create(context(), signal())).rejects.toMatchObject({
    code: 'PROVIDER_FAILED',
    cause: failure,
  });
  expect(create).not.toHaveBeenCalled();
  expect(f.h.disks.size).toBe(0);
  expect(await readdir(join(disk, '.preprovision-ledger'))).toEqual([]);
});

it.each(['ancestor', 'disk', 'ledger', 'mode'] as const)(
  'refuses an untrusted catalog directory (%s) before writing',
  async (which) => {
    const f = await fixture();
    const other = join(f.root, 'other');
    const ancestor = join(f.root, 'ancestor');
    const disk = join(which === 'ancestor' ? ancestor : f.root, 'disks');
    await mkdir(other, { mode: 0o700 });
    if (which === 'ancestor') {
      await symlink(other, ancestor, 'dir');
    } else if (which === 'disk') {
      await symlink(other, disk, 'dir');
    } else {
      await mkdir(disk, { mode: 0o700 });
      if (which === 'mode') await chmod(disk, 0o755);
      if (which === 'ledger')
        await symlink(other, join(disk, '.preprovision-ledger'), 'dir');
    }
    const ledger = new DiskPoolLedger(disk);
    const owner = {
      personId: randomUUID(),
      organizationId: randomUUID(),
      vmId: randomUUID(),
    };
    await expect(ledger.read(signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    await expect(
      ledger.recordOrdinaryOwner(owner, signal(), async () => {}),
    ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
    expect(await readdir(other)).toEqual([]);
  },
);

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

it.each(['last-stock', 'foreground-priority'] as const)(
  'leaves the first admin organization unbound when %s changes after probing',
  async (cause) => {
    const f = await fixture();
    await f.pool.refill(signal());
    const first = context();
    const second = context(randomUUID(), first.actor.id);
    const guard = adminGuard();
    const release = gate();
    let foreground: Promise<unknown> | undefined;
    guard.assertCapacity.mockImplementation(async () => {
      if (cause === 'last-stock') {
        await f.service.prewarm(context(), { trigger: 'page' }, signal());
      } else {
        foreground = f.pool.inForeground(() => release.promise);
      }
    });
    try {
      await expect(
        f.service.diskPreparationPort().prepare(adminTarget(first), guard),
      ).resolves.toBe('deferred');
      expect(guard.assertCapacity).toHaveBeenCalledOnce();
      expect(await f.store.read(first.actor.id)).toBeNull();
      expect(
        f.store.audits.filter((audit) => audit.personId === first.actor.id),
      ).toHaveLength(0);
    } finally {
      release.release();
      await foreground;
    }
    await expect(
      f.service.prewarm(second, { trigger: 'page' }, signal()),
    ).resolves.toMatchObject({
      organizationId: second.organizationId,
      ready: true,
    });
  },
);

it('joins active offline prep on the first workbench request and keeps exact storage for every assigned employee', async () => {
  const f = await fixture();
  const rc = context();
  const firstEmployee = adminTarget(rc);
  const started = gate(),
    finish = gate(),
    waiting = gate();
  f.store.onOfflineWait = waiting.release;
  f.platform.onBinding = async () => {
    started.release();
    await finish.promise;
  };
  await f.pool.refill(signal());
  const admin = f.service.diskPreparationPort();
  const guard = adminGuard();
  const preparing = admin.prepare(firstEmployee, guard);
  const foreground = f.serviceFor(f.newPool());
  const target = {
    vmId: null,
    instanceId: null,
    leaseEpoch: 1,
    assertAuthority: vi.fn(async () => {}),
  };
  let opening: ReturnType<PersonVmService['prewarm']> | undefined;
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
    opening = foreground.prewarm(rc, { trigger: 'input', target }, signal());
    await waiting.promise;
    expect(f.h.log).toEqual([]);
  } finally {
    finish.release();
  }
  expect(await preparing).toBe('prepared');
  const vmId = f.platform.binds[0]!.intent.owner.vmId;
  await expect(opening).resolves.toMatchObject({
    phase: 'running',
    vmId,
    ready: true,
  });
  expect(await f.store.read(rc.actor.id)).toMatchObject({
    vmId,
    leaseEpoch: 1,
  });
  expect(target.assertAuthority).toHaveBeenCalled();
  const secondEmployee = adminTarget(rc);
  expect(secondEmployee.employeeInstanceId).not.toBe(
    firstEmployee.employeeInstanceId,
  );
  expect(await admin.prepare(secondEmployee, adminGuard())).toBe(
    'already-prepared',
  );
  expect(f.h.log).not.toContain('disk:create');
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

it('refuses a revoked admitted ticket after waiting for the inventory lock without claiming stock or falling back', async () => {
  const f = await fixture();
  const rc = context();
  await f.pool.refill(signal());
  const entered = gate(),
    waiting = gate(),
    release = gate();
  const holder = f.locks.withLock('inventory', signal(), async () => {
    entered.release();
    await release.promise;
  });
  await entered.promise;
  f.locks.beforeInventory = waiting.release;
  let current = true;
  const revoked = Object.assign(Error('ticket grant changed'), {
    code: 'authorization_denied',
  });
  const opening = f.service.prewarm(
    rc,
    {
      trigger: 'page',
      target: {
        vmId: null,
        instanceId: null,
        leaseEpoch: 1,
        async assertAuthority() {
          if (!current) throw revoked;
        },
      },
    },
    signal(),
  );
  const outcome = opening.catch((error: unknown) => error);
  try {
    expect(
      await Promise.race([waiting.promise.then(() => 'waiting'), outcome]),
    ).toBe('waiting');
    current = false;
  } finally {
    release.release();
    await holder;
    await outcome;
  }
  expect(await outcome).toMatchObject({
    code: 'AUTHORIZATION_DENIED',
    cause: revoked,
  });
  const inventory = await f.ledger.read(signal(), true);
  expect(inventory.slots[0]?.entry?.state).toBe('ready');
  expect(inventory.ordinaryOwners.size).toBe(0);
  expect(f.platform.binds).toHaveLength(0);
  expect(f.h.log).toEqual([]);
});

it('leaves exact stock ready when the admitted ticket is revoked during the final inventory ownership check', async () => {
  const f = await fixture();
  const rc = context();
  await f.pool.refill(signal());
  const ready = (await f.ledger.read(signal())).slots[0]!;
  expect(ready.entry?.state).toBe('ready');
  const stock = structuredClone(f.platform.disks.get(ready.entry!.ref));
  const checking = gate();
  const finish = gate();
  let staged = 0;
  faults.afterLedgerFileSync = () => {
    staged += 1;
  };
  f.locks.onInventoryOwnerCheck = async (active) => {
    expect(staged).toBe(1);
    checking.release();
    await finish.promise;
    expect(active.aborted).toBe(false);
  };
  const revoked = Object.assign(Error('ticket grant changed'), {
    code: 'authorization_denied',
  });
  const assertAuthority = vi.fn(async (active: AbortSignal) => {
    active.throwIfAborted();
  });
  const outcome = f.service
    .prewarm(
      rc,
      {
        trigger: 'page',
        target: {
          vmId: null,
          instanceId: null,
          leaseEpoch: 1,
          assertAuthority,
        },
      },
      signal(),
    )
    .catch((error: unknown) => error);
  try {
    expect(
      await Promise.race([checking.promise.then(() => 'checking'), outcome]),
    ).toBe('checking');
    expect(assertAuthority).toHaveBeenCalled();
    assertAuthority.mockRejectedValue(revoked);
  } finally {
    finish.release();
    await outcome;
  }
  expect(await outcome).toMatchObject({
    code: 'AUTHORIZATION_DENIED',
    cause: revoked,
  });
  const inventory = await f.ledger.read(signal(), true);
  expect(inventory.slots[0]).toEqual(ready);
  expect(inventory.ordinaryOwners.size).toBe(0);
  expect(f.platform.disks.get(ready.entry!.ref)).toEqual(stock);
  expect(f.platform.binds).toHaveLength(0);
  expect(f.h.log).toEqual([]);
});

it('does not commit a new owner when an admitted ticket is revoked during default-off catalog reconciliation', async () => {
  const f = await fixture();
  const rc = context();
  const off = f.serviceFor(f.newPool(false));
  let current = true;
  vi.spyOn(f.h.disk, 'listFormalDiskIds').mockImplementationOnce(async () => {
    current = false;
    return [];
  });
  const revoked = Object.assign(Error('ticket grant changed'), {
    code: 'authorization_denied',
  });
  await expect(
    off.prewarm(
      rc,
      {
        trigger: 'input',
        target: {
          vmId: null,
          instanceId: null,
          leaseEpoch: 1,
          async assertAuthority() {
            if (!current) throw revoked;
          },
        },
      },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED', cause: revoked });
  expect(await f.store.read(rc.actor.id)).toBeNull();
  expect(f.h.log).toEqual([]);
  expect(await readdir(f.root)).toEqual([]);
});

it('checks the admitted running ticket after the pending-disk observation', async () => {
  const f = await fixture();
  const rc = context();
  await f.pool.refill(signal());
  await f.service.prewarm(rc, { trigger: 'page' }, signal());
  const running = (await f.store.read(rc.actor.id))!;
  const before = f.h.log.slice();
  let current = true;
  const status = f.pool.status.bind(f.pool);
  vi.spyOn(f.pool, 'status').mockImplementationOnce(async (...args) => {
    const result = await status(...args);
    current = false;
    return result;
  });
  const revoked = new PersonVmError('AUTHORIZATION_DENIED');
  await expect(
    f.service.prewarm(
      rc,
      {
        trigger: 'input',
        target: {
          vmId: running.vmId,
          instanceId: running.instanceId,
          leaseEpoch: running.leaseEpoch,
          async assertAuthority() {
            if (!current) throw revoked;
          },
        },
      },
      signal(),
    ),
  ).rejects.toBe(revoked);
  expect(f.h.log).toEqual(before);
  expect(await f.store.read(rc.actor.id)).toMatchObject({
    phase: 'running',
    instanceId: running.instanceId,
  });
});

it('cancels a waiting workbench without cancelling or duplicating the offline owner', async () => {
  const f = await fixture();
  const rc = context();
  const started = gate(),
    finish = gate(),
    waiting = gate();
  f.store.onOfflineWait = waiting.release;
  f.platform.onBinding = async () => {
    started.release();
    await finish.promise;
  };
  await f.pool.refill(signal());
  const admin = f.service
    .diskPreparationPort()
    .prepare(adminTarget(rc), adminGuard());
  try {
    await started.promise;
    const stop = new AbortController();
    const response = f
      .serviceFor(f.newPool())
      .prewarm(rc, { trigger: 'page' }, stop.signal);
    const rejection = expect(response).rejects.toBe(
      'synthetic workbench closed',
    );
    await waiting.promise;
    stop.abort('synthetic workbench closed');
    await rejection;
    expect(await f.store.read(rc.actor.id)).toMatchObject({
      phase: 'starting',
    });
    expect(f.platform.binds).toHaveLength(1);
    expect(f.h.log).toEqual([]);
  } finally {
    finish.release();
  }
  await expect(admin).resolves.toBe('prepared');
  expect((await f.store.read(rc.actor.id))?.phase).toBe('stopped');
});

it('joins only offline preparation when a roster scan enters between first create and start', async () => {
  const f = await fixture();
  const rc = context();
  const entered = gate(),
    finish = gate(),
    waiting = gate();
  f.store.onOfflineWait = waiting.release;
  const create = f.service.create.bind(f.service);
  let roster: Promise<unknown> | undefined;
  vi.spyOn(f.service, 'create').mockImplementationOnce(async (...args) => {
    const result = await create(...args);
    // Place the existing roster's marked physical lane in the create/start gap.
    roster = f.store.withLease(
      rc.actor.id,
      {
        now: f.h.now,
        ttlMs: 90000,
        offlinePreparation: {
          mode: 'prepare',
          organizationId: rc.organizationId,
          signal: signal(),
        },
      },
      async () => {
        entered.release();
        await finish.promise;
      },
    );
    await entered.promise;
    return result;
  });
  await f.pool.refill(signal());
  const opening = f.service.prewarm(rc, { trigger: 'page' }, signal());
  try {
    await waiting.promise;
    expect(f.h.log).toEqual([]);
  } finally {
    finish.release();
  }
  await roster;
  await expect(opening).resolves.toMatchObject({
    ready: true,
    vmId: f.platform.binds[0]!.intent.owner.vmId,
  });
});

it('keeps an unrelated physical lease as an immediate conflict', async () => {
  const f = await fixture();
  const rc = context();
  const entered = gate(),
    finish = gate();
  f.store.onOfflineWait = vi.fn();
  const other = f.store.withLease(
    rc.actor.id,
    { now: f.h.now, ttlMs: 90000 },
    async () => {
      entered.release();
      await finish.promise;
    },
  );
  try {
    await entered.promise;
    await expect(
      f.service.prewarm(rc, { trigger: 'page' }, signal()),
    ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
    expect(f.store.onOfflineWait).not.toHaveBeenCalled();
  } finally {
    finish.release();
    await other;
  }
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

it('records repeated static source reserve deferrals without reserving a slot', async () => {
  const f = await fixture();
  f.platform.onCreationBudget = async () => {
    throw new DiskPoolBudgetExceeded();
  };
  for (let i = 0; i < 3; i++) await f.pool.refill(signal());
  expect(f.platform.disks.size).toBe(0);
  expect(
    (await f.ledger.read(signal())).slots.map(({ revision }) => revision),
  ).toEqual([0, 0, 0]);
  expect(await readdir(f.root)).toEqual([]);
  expect(f.events.mock.calls).toEqual(
    Array.from({ length: 3 }, () => [{ event: 'capacity-deferred' }]),
  );
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

it('retires a full obsolete generation and refills all three slots with exact independent stock', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.pool.refill(signal());
  const old = [...f.platform.disks.keys()];
  const currentSource = 'new@digest/manifest';
  const current = f.newPool(true, currentSource);
  for (let i = 0; i < 3; i++) await current.refill(signal());
  expect(f.platform.destroyed).toEqual(old);
  expect(f.platform.disks.size).toBe(3);
  for (const { entry } of (await f.ledger.read(signal())).slots)
    expect(entry).toMatchObject({ state: 'ready', source: currentSource });
  await expect(
    f.serviceFor(current).create(context(), signal()),
  ).resolves.toMatchObject({ phase: 'stopped' });
  expect(f.platform.binds[0]).toMatchObject({ source: currentSource });
});

it('finishes an elected idle retirement when shutdown arrives after its durable append', async () => {
  const f = await fixture();
  await f.pool.refill(signal());
  const stop = new AbortController();
  const closed = Error('synthetic caller shutdown after durable retiring');
  f.locks.afterInventory = async () => {
    const { slots } = await f.ledger.read(signal());
    if (slots[0]?.entry?.state === 'retiring') stop.abort(closed);
  };
  const rotated = f.newPool(true, 'new@digest/manifest');
  await expect(rotated.refill(stop.signal)).rejects.toBe(closed);
  expect((await f.ledger.read(signal())).slots[0]?.entry).toMatchObject({
    state: 'retired',
    reason: 'source-changed',
  });
  expect(f.platform.disks.size).toBe(0);
  await rotated.refill(signal());
  expect((await f.ledger.read(signal())).slots[0]?.entry).toMatchObject({
    state: 'ready',
    source: 'new@digest/manifest',
  });
});

it.each(['ENOSPC', 'EDQUOT'] as const)(
  'releases a capacity-failed %s write only after actual offline retirement',
  async (code) => {
    const f = await fixture();
    const detached = gate();
    const release = gate();
    const failure = Object.assign(new Error('synthetic disk write'), { code });
    f.platform.onSeed = async () => {
      throw new DiskPoolBudgetExceeded(undefined, { cause: failure });
    };
    f.platform.onUnmount = async () => {
      detached.release();
      await release.promise;
    };
    const refill = f.pool.refill(signal());
    try {
      await detached.promise;
      expect(f.platform.destroyed).toHaveLength(0);
      expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe(
        'filling',
      );
    } finally {
      release.release();
    }
    await refill;
    expect(f.platform.destroyed).toHaveLength(1);
    expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe(
      'retired',
    );
    expect(f.events).toHaveBeenCalledWith({ event: 'capacity-deferred' });
  },
);

it.each(['key', 'receipt'] as const)(
  'finishes an existing same-owner %s claim across a seal rotation',
  async (stage) => {
    const f = await fixture();
    const rc = context();
    await f.pool.refill(signal());
    f.platform.crash = stage;
    await expect(f.service.create(rc, signal())).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    const original = f.platform.binds[0]!;
    const current = f.newPool(true, 'new@digest/manifest');
    await current.refill(signal());
    await expect(
      f.serviceFor(current).create(rc, signal()),
    ).resolves.toMatchObject({
      vmId: original.intent.owner.vmId,
      phase: 'stopped',
    });
    expect(f.platform.destroyed).not.toContain(original.ref);
    expect(
      f.platform.binds.every(
        (binding) => binding.intent.id === original.intent.id,
      ),
    ).toBe(true);
    expect(f.h.log).not.toContain('disk:create');
  },
);

it.each(['before-copy', 'after-copy'] as const)(
  'retires exact offline stock after a %s capacity deferral and can refill next time',
  async (point) => {
    const f = await fixture();
    let reads = 0;
    if (point === 'before-copy')
      f.platform.onCapacity = () => {
        if (++reads === 3) f.platform.available = 150n;
      };
    else
      f.platform.onSeed = async () => {
        f.platform.available = 150n;
      };
    await f.pool.refill(signal());
    expect((await f.ledger.read(signal())).slots[0]?.entry).toMatchObject({
      state: 'retired',
      reason: 'preparation-deferred',
    });
    expect(f.platform.disks.size).toBe(0);
    expect(f.platform.destroyed).toHaveLength(1);
    expect(f.events).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'capacity-deferred',
        availableBytes: '150',
      }),
    );
    f.platform.available = 1000n;
    f.platform.onCapacity = undefined;
    f.platform.onSeed = undefined;
    await f.pool.refill(signal());
    expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe(
      'ready',
    );
  },
);

it('reobserves new catalog records after concurrent stock appears and still fences genuinely untracked files', async () => {
  const f = await fixture();
  const sampling = gate(),
    resume = gate();
  let first = true;
  f.platform.onCapacity = async () => {
    if (!first) return;
    first = false;
    sampling.release();
    await resume.promise;
  };
  const reading = f.newPool().availableBytes(signal());
  try {
    await sampling.promise;
    await f.pool.refill(signal());
  } finally {
    resume.release();
  }
  await expect(reading).resolves.toBe(1000n);
  await f.platform.createEncryptedDisk(randomUUID());
  await expect(f.pool.availableBytes(signal())).rejects.toMatchObject({
    code: 'CLEANUP_INCOMPLETE',
  });
});

it.each(['missing', 'replaced', 'non-retained'] as const)(
  'fences a %s owner row against durable completed physical ownership, even after switching off the pool',
  async (state) => {
    const f = await fixture();
    const rc = context();
    await f.pool.refill(signal());
    const v1 = await f.service.create(rc, signal());
    const saved = (await f.store.read(rc.actor.id))!;
    if (state === 'missing') f.store.rows.delete(rc.actor.id);
    if (state === 'replaced')
      f.store.rows.set(rc.actor.id, {
        ...saved,
        vmId: randomUUID(),
        phase: 'failed',
      });
    if (state === 'non-retained')
      f.store.rows.set(rc.actor.id, {
        ...saved,
        diskRetained: false,
        phase: 'deleted',
      });
    const current = await f.store.read(rc.actor.id);
    const disabled = f.serviceFor(f.newPool(false));
    await expect(disabled.create(rc, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    await expect(f.service.create(rc, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    expect(await f.store.read(rc.actor.id)).toEqual(current);
    expect([...f.h.disks]).toEqual([v1.vmId]);
    expect(f.h.log).not.toContain('disk:create');
  },
);

it('fences a cold first allocation after its owner row is restored away', async () => {
  const f = await fixture();
  const rc = context();
  const createDisk = f.h.disk.create.bind(f.h.disk);
  vi.spyOn(f.h.disk, 'create').mockImplementation(async (ref, scoped) => {
    const coldReceipt = (await f.ledger.read(scoped, true)).ordinaryOwners.get(
      ref.vmId,
    );
    expect(coldReceipt).toMatchObject({
      personId: rc.actor.id,
      organizationId: rc.organizationId,
      vmId: ref.vmId,
    });
    await createDisk(ref, scoped);
  });
  const first = await f.service.create(rc, signal());
  expect(f.h.log).toEqual(['disk:create']);
  f.store.rows.delete(rc.actor.id);
  await f.pool.refill(signal());
  const reopened = f.serviceFor(f.newPool());
  await expect(
    reopened.diskPreparationPort().prepare(adminTarget(rc), adminGuard()),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  await expect(
    f.serviceFor(f.newPool(false)).create(rc, signal()),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  expect(await f.store.read(rc.actor.id)).toBeNull();
  expect([...f.h.disks]).toEqual([first.vmId]);
  expect(f.platform.binds).toHaveLength(0);
  expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe('ready');
});

it('replaces a recorded cold allocation only after authorized deletion and verified absence', async () => {
  const f = await fixture();
  const rc = context();
  const disabled = f.serviceFor(f.newPool(false));
  const first = await disabled.create(rc, signal());
  f.h.authorizeDiskDelete(true);
  await expect(
    disabled.delete(rc, { deleteDisk: true }, signal()),
  ).resolves.toMatchObject({ diskRetained: false });
  f.h.partialDisks.add(first.vmId);
  await expect(disabled.create(rc, signal())).rejects.toMatchObject({
    code: 'CLEANUP_INCOMPLETE',
  });
  f.h.partialDisks.delete(first.vmId);
  const next = await disabled.create(rc, signal());
  expect(next.vmId).not.toBe(first.vmId);
  expect([...f.h.disks]).toEqual([next.vmId]);
});

it('permits authorized deletion and replacement only after the exact prior disk is physically absent', async () => {
  const f = await fixture();
  const rc = context();
  await f.pool.refill(signal());
  const v1 = await f.service.create(rc, signal());
  f.h.authorizeDiskDelete(true);
  await expect(
    f.service.delete(rc, { deleteDisk: true }, signal()),
  ).resolves.toMatchObject({ diskRetained: false });
  const old = (await f.store.read(rc.actor.id))!;
  const off = f.serviceFor(f.newPool(false));
  f.h.disks.add(v1.vmId);
  f.h.diskTiers.set(v1.vmId, 'warm');
  await expect(off.create(rc, signal())).rejects.toMatchObject({
    code: 'CLEANUP_INCOMPLETE',
  });
  expect(await f.store.read(rc.actor.id)).toEqual(old);
  f.h.disks.delete(v1.vmId);
  f.h.diskTiers.delete(v1.vmId);
  const v2 = await off.create(rc, signal());
  expect(v2.vmId).not.toBe(v1.vmId);
  expect(v2.phase).toBe('stopped');
  expect([...f.h.disks]).toEqual([v2.vmId]);
  expect((await f.ledger.read(signal())).bound.get(v1.vmId)).toBeDefined();
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
  expect(f.platform.binds).toEqual([first, first]);
});

it('rechecks foreground after the creation budget preflight without opening a disk', async () => {
  const f = await fixture();
  f.platform.onCreationBudget = async () => {
    f.locks.foreground = true;
  };
  await f.pool.refill(signal());
  expect(f.platform.disks.size).toBe(0);
  expect((await f.ledger.read(signal())).slots[0]?.entry).toBeNull();
  expect(f.events).toHaveBeenCalledWith({ event: 'foreground-deferred' });
});

it('yields active copying at the next bounded checkpoint without querying PG for each write', async () => {
  const f = await fixture();
  const copying = gate(),
    next = gate(),
    booted = gate(),
    finish = gate();
  let writes = 0;
  f.platform.onSeed = async (checkpoint) => {
    expect(checkpoint).toBeDefined();
    for (let index = 0; index < 40; index++) {
      await checkpoint!();
      writes++;
    }
    copying.release();
    await next.promise;
    await checkpoint!();
    writes++;
  };
  const refill = f.pool.refill(signal());
  await copying.promise;
  const foreground = f.pool.inForeground(async () => {
    booted.release();
    await finish.promise;
  });
  try {
    await booted.promise;
    next.release();
    await refill;
    expect(writes).toBe(40);
    expect(f.locks.foregroundChecks).toBeLessThan(40);
    expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe(
      'retired',
    );
    expect(f.platform.disks.size).toBe(0);
    expect(f.events).toHaveBeenCalledWith({ event: 'foreground-deferred' });
    expect(f.events).not.toHaveBeenCalledWith({ event: 'fill-deferred' });
  } finally {
    finish.release();
    await foreground;
  }
});

it.each(['proof', 'publication'] as const)(
  'settles a confirmed detached disk when the scanner shuts down during %s',
  async (point) => {
    const f = await fixture();
    const stop = new AbortController();
    const reason = Error(`synthetic shutdown before ${point} completes`);
    let inspected = false;
    f.platform.onInspect = async (scoped) => {
      if (point === 'proof') stop.abort(reason);
      scoped.throwIfAborted();
      inspected = true;
    };
    f.locks.beforeInventory = () => {
      if (point === 'publication' && inspected) stop.abort(reason);
    };
    await expect(f.pool.refill(stop.signal)).rejects.toBe(reason);
    expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe(
      'ready',
    );
    expect([...f.platform.disks.values()][0]?.mounted).toBe(false);
    expect(f.platform.destroyed).toHaveLength(0);
  },
);

it('leaves the stock ready when authority is revoked after claim staging fsync and before link', async () => {
  const f = await fixture();
  await f.pool.refill(signal());
  const revoke = new AbortController();
  const revoked = new PersonVmError('AUTHORIZATION_DENIED');
  faults.afterLedgerFileSync = () => revoke.abort(revoked);
  const owner = {
    personId: randomUUID(),
    organizationId: randomUUID(),
    vmId: randomUUID(),
  };
  await expect(
    f.pool.claim(owner, randomUUID(), 'admin', {
      signal: revoke.signal,
      assertCurrent: async () => revoke.signal.throwIfAborted(),
      assertOwner: async () => {},
    }),
  ).rejects.toBe(revoked);
  faults.afterLedgerFileSync = undefined;
  expect(f.platform.binds).toHaveLength(0);
  expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe('ready');
  await expect(f.service.create(context(), signal())).resolves.toMatchObject({
    phase: 'stopped',
  });
  expect(f.platform.binds).toHaveLength(1);
});

it('keeps the exact physical claim pending when authority is revoked after staging the bound record', async () => {
  const f = await fixture();
  await f.pool.refill(signal());
  const rc = context();
  const guard = adminGuard();
  const revoked = new PersonVmError('AUTHORIZATION_DENIED');
  let staged = 0;
  faults.afterLedgerFileSync = () => {
    if (++staged === 2) guard.assertCurrent.mockRejectedValue(revoked);
  };
  await expect(
    f.service.diskPreparationPort().prepare(adminTarget(rc), guard),
  ).rejects.toBe(revoked);
  faults.afterLedgerFileSync = undefined;
  expect(staged).toBe(2);
  const first = f.platform.binds[0]!;
  expect([...f.h.disks]).toEqual([first.intent.owner.vmId]);
  expect((await f.ledger.read(signal())).slots[0]?.entry).toMatchObject({
    state: 'claiming',
    intent: first.intent,
  });
  await expect(f.service.create(rc, signal())).resolves.toMatchObject({
    vmId: first.intent.owner.vmId,
    phase: 'stopped',
  });
  expect(f.platform.binds).toEqual([first]);
  expect(
    (await f.ledger.read(signal())).bound.get(first.intent.owner.vmId),
  ).toMatchObject({ intent: first.intent });
});

it('does not publish ready when the actual fill connection is lost during offline proof', async () => {
  const f = await fixture();
  f.platform.onInspect = async (scoped) => {
    f.locks.dropFillSession();
    scoped.throwIfAborted();
  };
  await expect(f.pool.refill(signal())).rejects.toThrow(
    'filled owner SQL disconnected',
  );
  expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe(
    'filling',
  );
  expect([...f.platform.disks.values()][0]?.mounted).toBe(false);
  expect(f.platform.destroyed).toHaveLength(0);
  await f.newPool().refill(signal());
  expect(f.events).toHaveBeenCalledWith({ event: 'interrupted-fill' });
});

it.each(['shutdown', 'owner-loss'] as const)(
  'settles or fences the exact empty reservation when %s occurs after the durable CAS',
  async (point) => {
    const f = await fixture();
    const stop = new AbortController();
    const stopped = Error('caller shut down after durable slot election');
    let elected = false;
    f.locks.afterInventory = async () => {
      if (
        !elected &&
        (await f.ledger.read(signal())).slots[0]?.entry?.state === 'filling'
      ) {
        elected = true;
        if (point === 'shutdown') stop.abort(stopped);
        else f.locks.dropFillSession();
      }
    };
    const refill = f.pool.refill(stop.signal);
    if (point === 'shutdown') await expect(refill).rejects.toBe(stopped);
    else await expect(refill).rejects.toThrow('filled owner SQL disconnected');
    expect(elected).toBe(true);
    expect(f.platform.disks.size).toBe(0);
    expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe(
      point === 'shutdown' ? 'released-before-write' : 'filling',
    );
    await f.newPool().refill(signal());
    if (point === 'shutdown')
      expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe(
        'ready',
      );
    else expect(f.events).toHaveBeenCalledWith({ event: 'interrupted-fill' });
  },
);

it('releases a known empty election when the foreground starts during platform preflight', async () => {
  const f = await fixture();
  f.platform.onCreatePreflight = async () => {
    f.locks.foreground = true;
  };
  f.platform.onUnmount = vi.fn(async () => {});
  await f.pool.refill(signal());
  expect(f.platform.onUnmount).not.toHaveBeenCalled();
  expect(f.platform.disks.size).toBe(0);
  expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe(
    'released-before-write',
  );
  expect(f.events).toHaveBeenCalledWith({ event: 'foreground-deferred' });
});

it.each([false, true])(
  'releases caller-only cancellation before the first storage write and fences conflict (conflict=%s)',
  async (conflicting) => {
    const f = await fixture();
    const stop = new AbortController();
    const stopped = Error('caller canceled during platform preflight');
    const conflict = new PersonVmError('PROVIDER_FAILED');
    f.platform.onCreatePreflight = async () => {
      stop.abort(stopped);
      throw conflicting ? conflict : stopped;
    };
    const unmount = vi
      .spyOn(f.platform, 'unmountDisk')
      .mockResolvedValue(undefined);
    await expect(f.pool.refill(stop.signal)).rejects.toBe(
      conflicting ? conflict : stopped,
    );
    expect(unmount).toHaveBeenCalledTimes(conflicting ? 1 : 0);
    expect(f.platform.disks.size).toBe(0);
    expect((await f.ledger.read(signal())).slots[0]?.entry?.state).toBe(
      conflicting ? 'quarantined' : 'released-before-write',
    );
  },
);

it('cancels a refill waiting for the occupied inventory lock before creating any reservation', async () => {
  const f = await fixture();
  const held = gate(),
    release = gate(),
    waiting = gate();
  const holder = f.locks.withLock('inventory', signal(), async () => {
    held.release();
    await release.promise;
  });
  await held.promise;
  const stop = new AbortController();
  const reason = Error('caller cancellation before slot election');
  let acquisition: AbortSignal | undefined;
  f.locks.beforeInventory = (current) => {
    acquisition = current;
    waiting.release();
  };
  const refill = f.pool.refill(stop.signal);
  try {
    await waiting.promise;
    stop.abort(reason);
    // If acquisition was accidentally given an independent owner signal,
    // fail here and release the fixture's holder instead of hanging the test.
    expect(acquisition?.aborted).toBe(true);
    await expect(refill).rejects.toBe(reason);
    expect(
      (await f.ledger.read(signal())).slots.every(
        (slot) => slot.entry === null,
      ),
    ).toBe(true);
    expect(f.platform.disks.size).toBe(0);
  } finally {
    release.release();
    await holder;
    await refill.catch(() => {});
  }
});
