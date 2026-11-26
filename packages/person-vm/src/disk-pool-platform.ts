/** Host-only storage references and receipts; business policy never interprets them. */
export type DiskPoolOwner = Readonly<{
  personId: string;
  organizationId: string;
  vmId: string;
}>;
export type DiskPoolIntent = Readonly<{
  id: string;
  requestId: string;
  owner: DiskPoolOwner;
}>;
export type DiskPoolStock = Readonly<{ ref: string; source: string }>;
export type PreparedDiskPoolStock = DiskPoolStock & Readonly<{ proof: string }>;
export type DiskPoolClaim = PreparedDiskPoolStock &
  Readonly<{ intent: DiskPoolIntent }>;
export type DiskPoolCapacity = Readonly<{
  availableBytes: bigint;
  allocatedBytes: bigint;
  allocatedBytesByRef: ReadonlyMap<string, bigint>;
}>;

export class DiskPoolBudgetExceeded extends Error {
  constructor(
    readonly capacity?: Pick<
      DiskPoolCapacity,
      'availableBytes' | 'allocatedBytes'
    >,
    options?: ErrorOptions,
  ) {
    super('PERSON_VM_DISK_POOL_BUDGET_EXCEEDED', options);
  }
}
export class DiskPoolForegroundDeferred extends Error {
  constructor(options?: ErrorOptions) {
    super('PERSON_VM_DISK_POOL_FOREGROUND_DEFERRED', options);
  }
}
/** The caller makes a fresh catalog observation before deciding an image is untracked. */
export class DiskPoolInventoryMismatch extends Error {
  constructor() {
    super('PERSON_VM_DISK_POOL_INVENTORY_MISMATCH');
  }
}

export interface DiskPoolPlatform {
  readCapacity(
    inventory: readonly Readonly<{ ref: string; vmId?: string }>[],
    signal: AbortSignal,
  ): Promise<DiskPoolCapacity>;
  assertSourceFitsReserve?(
    reserveBytes: bigint,
    signal: AbortSignal,
  ): Promise<void>;
  /** Read-only for this ref until the supplied guard succeeds immediately before key creation. */
  createEncryptedDisk(
    ref: string,
    signal: AbortSignal,
    beforeKeyWrite?: () => Promise<void>,
  ): Promise<void>;
  mountDisk(ref: string, signal: AbortSignal): Promise<string>;
  seedPublicCache(
    ref: string,
    mount: string,
    source: string,
    budget: Readonly<{ reserveBytes: bigint; minimumFreeBytes: bigint }>,
    signal: AbortSignal,
    checkpoint?: () => Promise<void>,
  ): Promise<void>;
  /** Join the native operation and prove that the image and mount are offline. */
  unmountDisk(ref: string, signal: AbortSignal): Promise<void>;
  /** Identify the exact new disk and key once offline, including before seeding. */
  inspectStock(stock: DiskPoolStock, signal: AbortSignal): Promise<string>;
  /** The durable catalog already retired this unassigned reference from use. */
  destroyStock(
    stock: PreparedDiskPoolStock,
    signal: AbortSignal,
  ): Promise<void>;
  inspectBinding(
    claim: DiskPoolClaim,
    signal: AbortSignal,
  ): Promise<'pending' | 'bound' | 'unknown'>;
  /** No overwrite. Continue only a known physical prefix of the same claim. */
  bindDisk(
    claim: DiskPoolClaim,
    signal: AbortSignal,
    beforeManifestLink?: () => Promise<void>,
  ): Promise<void>;
}

export type DiskPoolLock = Readonly<{
  signal: AbortSignal;
  ownerSignal: AbortSignal;
  assertOwned(): Promise<void>;
  foregroundStarting(): Promise<boolean>;
}>;
export interface DiskPoolLocks {
  withLock<T>(
    kind: 'inventory' | 'fill',
    signal: AbortSignal,
    work: (lock: DiskPoolLock) => Promise<T>,
  ): Promise<T | undefined>;
}

export function sameDiskPoolOwner(a: DiskPoolOwner, b: DiskPoolOwner) {
  return (
    a.personId === b.personId &&
    a.organizationId === b.organizationId &&
    a.vmId === b.vmId
  );
}
