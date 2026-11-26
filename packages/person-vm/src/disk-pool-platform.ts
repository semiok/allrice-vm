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
export type DiskPoolClaim = DiskPoolStock &
  Readonly<{
    proof: string;
    intent: DiskPoolIntent;
  }>;
export type DiskPoolCapacity = Readonly<{
  availableBytes: bigint;
  allocatedBytes: bigint;
  allocatedBytesByRef: ReadonlyMap<string, bigint>;
}>;

export class DiskPoolBudgetExceeded extends Error {
  constructor() {
    super('PERSON_VM_DISK_POOL_BUDGET_EXCEEDED');
  }
}

export interface DiskPoolPlatform {
  readCapacity(
    inventory: readonly Readonly<{ ref: string; vmId?: string }>[],
    signal: AbortSignal,
  ): Promise<DiskPoolCapacity>;
  createEncryptedDisk(ref: string, signal: AbortSignal): Promise<void>;
  mountDisk(ref: string, signal: AbortSignal): Promise<string>;
  seedPublicCache(
    ref: string,
    mount: string,
    source: string,
    budgetBytes: bigint,
    signal: AbortSignal,
  ): Promise<void>;
  /** Join the native operation and prove that the image and mount are offline. */
  unmountDisk(ref: string, signal: AbortSignal): Promise<void>;
  /** Identify the exact new disk and key after its public cache and detach settle. */
  inspectStock(stock: DiskPoolStock, signal: AbortSignal): Promise<string>;
  inspectBinding(
    claim: DiskPoolClaim,
    signal: AbortSignal,
  ): Promise<'pending' | 'bound' | 'unknown'>;
  /** No overwrite. Continue only a known physical prefix of the same claim. */
  bindDisk(claim: DiskPoolClaim, signal: AbortSignal): Promise<void>;
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
