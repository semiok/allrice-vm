import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  statfs,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PersonVmError, type PersonVmBinding } from './contract.ts';
import {
  DiskPoolLedger,
  missing,
  publishDiskPoolRecord,
  syncDiskPoolDirectory,
} from './disk-pool-ledger.ts';
import {
  DiskPoolBudgetExceeded,
  DiskPoolInventoryMismatch,
  sameDiskPoolOwner,
  type DiskPoolClaim,
  type DiskPoolPlatform,
  type DiskPoolStock,
  type PreparedDiskPoolStock,
} from './disk-pool-platform.ts';
import {
  ApfsPersonVmDisk,
  FilePersonVmKeyStore,
  privateDirectory,
  type PersonDisk,
} from './encrypted-disk.ts';
import {
  checkedPublicImageCache,
  hasPendingPublicCacheRefresh,
  isCapacityWriteError,
  publicImageCacheBytes,
  refreshSeededPublicImageCache,
  PublicImageCacheBudgetExceeded,
  seedPublicImageCache,
  type PublicImageCache,
} from './image-cache.ts';
import type { CommandRunner } from './process.ts';

type Inode = Readonly<{ device: string; inode: string }>;
type StockProof = Readonly<{ image: Inode; key: Inode }>;
type FileIdentity = Inode & Readonly<{ links: bigint; bytes: bigint }>;

// hdiutil(1) documents 1 MiB allocation increments for default single-file UDSP.
const sparseImageBandBytes = 1024n * 1024n;
const roundBytes = (bytes: bigint, block: bigint) =>
  ((bytes + block - 1n) / block) * block;

function invalid(): never {
  throw new PersonVmError('CLEANUP_INCOMPLETE');
}
const warm = (vmId: string): PersonDisk => ({ vmId, tier: 'warm' });
const sameInode = (file: Inode, expected: Inode) =>
  file.device === expected.device && file.inode === expected.inode;
function checkedInode(value: Inode) {
  return (
    value &&
    typeof value.device === 'string' &&
    typeof value.inode === 'string' &&
    /^\d+$/.test(value.device) &&
    /^\d+$/.test(value.inode)
  );
}
function checkedStockProof(value: string) {
  const proof = JSON.parse(value) as StockProof;
  if (!proof || !checkedInode(proof.image) || !checkedInode(proof.key))
    invalid();
  return proof;
}
async function identity(
  path: string,
  strict = true,
): Promise<FileIdentity | null> {
  const stat = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (!missing(error)) throw error;
    return null;
  });
  if (!stat) return null;
  if (
    !stat.isFile() ||
    stat.uid !== BigInt(process.getuid!()) ||
    (strict && (stat.mode & 0o7777n) !== 0o600n)
  )
    invalid();
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    links: stat.nlink,
    bytes: stat.blocks * 512n,
  };
}
async function directory(path: string) {
  let stat = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (!missing(error)) throw error;
    return null;
  });
  if (!stat) {
    let base = dirname(path);
    while (true) {
      const resolved = await realpath(base).catch((error: unknown) => {
        if (!missing(error)) throw error;
        return null;
      });
      if (resolved) {
        if (resolved !== base) invalid();
        break;
      }
      base = dirname(base);
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      await syncDiskPoolDirectory(parent);
      if (parent === base) break;
    }
    stat = await lstat(path, { bigint: true });
  }
  if (
    !stat.isDirectory() ||
    stat.uid !== BigInt(process.getuid!()) ||
    (stat.mode & 0o7777n) !== 0o700n ||
    (await realpath(path)) !== path
  )
    invalid();
  return stat.dev;
}
async function syncFile(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDiskPoolDirectory(dirname(path));
}
async function manifest(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (!missing(error)) throw error;
    return null;
  });
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > 1024
    )
      invalid();
    return JSON.parse(await file.readFile('utf8')) as Inode & {
      version: 1;
      vmId: string;
      poolClaimId?: string;
      poolSource?: string;
    };
  } finally {
    await file.close();
  }
}
function placement(
  before: FileIdentity | null,
  after: FileIdentity | null,
  expected: Inode,
) {
  const count = before && after ? 2n : 1n;
  if (
    (!before && !after) ||
    [before, after].some(
      (entry) =>
        entry && (!sameInode(entry, expected) || entry.links !== count),
    )
  )
    invalid();
  return before ? (after ? 'linked' : 'stock') : 'formal';
}

/** APFS images and keys move by preserving their inodes. The normal VM
 * manifest is published last, after the temporary key reference is gone. */
export class MacosPersonVmDiskPool implements DiskPoolPlatform {
  readonly source: string;
  private readonly stockRoot: string;
  private readonly stockKeyRoot: string;
  private readonly stockKeys: FilePersonVmKeyStore;
  private readonly stockDisk: ApfsPersonVmDisk;
  private readonly imageCache: PublicImageCache;
  private readonly ledger: DiskPoolLedger;

  constructor(
    private readonly options: Readonly<{
      root: string;
      keyRoot: string;
      capacityGiB: number;
      disk: ApfsPersonVmDisk;
      keys: FilePersonVmKeyStore;
      image: string;
      imageCache: PublicImageCache;
      runner?: CommandRunner;
    }>,
  ) {
    this.stockRoot = join(options.root, '.preprovision-images');
    this.ledger = new DiskPoolLedger(options.root);
    this.stockKeyRoot = join(options.keyRoot, '.preprovision-keys');
    this.stockKeys = new FilePersonVmKeyStore(this.stockKeyRoot);
    this.stockDisk = new ApfsPersonVmDisk({
      root: this.stockRoot,
      keys: this.stockKeys,
      capacityGiB: options.capacityGiB,
      ...(options.runner && { runner: options.runner }),
    });
    this.imageCache = checkedPublicImageCache(
      options.imageCache,
      options.image,
    );
    this.source = `${options.image} ${this.imageCache.manifestSha256}`;
  }

  private async layout(signal: AbortSignal) {
    const { root, keyRoot } = this.options;
    const diskDevice = await directory(root);
    const keyDevice = await directory(keyRoot);
    if (
      (await directory(this.stockRoot)) !== diskDevice ||
      (await directory(this.stockKeyRoot)) !== keyDevice
    )
      invalid();
    for (const base of [root, this.stockRoot]) {
      for (const name of ['warm', 'cold', 'manifests', 'mounts']) {
        signal.throwIfAborted();
        if ((await directory(join(base, name))) !== diskDevice) invalid();
      }
    }
    return diskDevice;
  }

  async readCapacity(
    inventory: readonly Readonly<{ ref: string; vmId?: string }>[],
    signal: AbortSignal,
  ) {
    const diskDevice = String(await this.layout(signal));
    const warmRoot = join(this.stockRoot, 'warm');
    const names = await readdir(warmRoot);
    const files = new Map<string, string>();
    for (const { ref, vmId } of inventory) {
      files.set(this.stockDisk.poolFiles(warm(ref)).image, ref);
      if (vmId) files.set(this.options.disk.poolFiles(warm(vmId)).image, ref);
    }
    if (names.some((name) => !files.has(join(warmRoot, name))))
      throw new DiskPoolInventoryMismatch();
    const observed = new Map<string, bigint>();
    const allocatedBytesByRef = new Map<string, bigint>();
    for (const [path, ref] of files) {
      signal.throwIfAborted();
      const file = await identity(path, false);
      if (!file) continue;
      if (file.device !== diskDevice) invalid();
      observed.set(file.inode, file.bytes);
      allocatedBytesByRef.set(ref, file.bytes);
    }
    const volume = await statfs(warmRoot, { bigint: true });
    const formal = await statfs(join(this.options.root, 'warm'), {
      bigint: true,
    });
    if (
      volume.bsize <= 0n ||
      volume.bsize !== formal.bsize ||
      volume.type !== formal.type
    )
      invalid();
    signal.throwIfAborted();
    return {
      availableBytes: volume.bavail * volume.bsize,
      allocatedBytes: [...observed.values()].reduce((a, b) => a + b, 0n),
      allocatedBytesByRef,
    };
  }

  async createEncryptedDisk(
    ref: string,
    signal: AbortSignal,
    beforeKeyWrite?: () => Promise<void>,
  ) {
    await this.layout(signal);
    const disk = warm(ref);
    const { image, manifest: receipt } = this.stockDisk.poolFiles(disk);
    if (
      (await identity(image)) ||
      (await identity(receipt)) ||
      (await identity(this.stockKeys.filePath(ref))) ||
      (await identity(
        this.stockDisk.poolFiles({ ...disk, tier: 'cold' }).image,
      ))
    )
      invalid();
    signal.throwIfAborted();
    await this.stockDisk.create(disk, signal, beforeKeyWrite);
  }

  async assertSourceFitsReserve(reserveBytes: bigint, signal: AbortSignal) {
    const seedBytes = await publicImageCacheBytes(
      this.imageCache,
      this.options.image,
      signal,
    );
    // Reject a budget too small for the public payload and initial image
    // growth headroom before reserving stock. Actual growth is checked
    // after formatting/mount and around every bounded copy write.
    const initialWindow =
      roundBytes(seedBytes, sparseImageBandBytes) + 2n * sparseImageBandBytes;
    signal.throwIfAborted();
    if (reserveBytes < initialWindow) throw new DiskPoolBudgetExceeded();
  }

  mountDisk(ref: string, signal: AbortSignal) {
    return this.stockDisk.attach(warm(ref), signal);
  }

  async seedPublicCache(
    ref: string,
    mount: string,
    source: string,
    {
      reserveBytes,
      minimumFreeBytes,
    }: { reserveBytes: bigint; minimumFreeBytes: bigint },
    signal: AbortSignal,
    checkpoint?: () => Promise<void>,
  ) {
    if (
      source !== this.source ||
      (await this.stockDisk.verifyAttachedMount(warm(ref), signal)) !== mount
    )
      invalid();
    const nativeRoot = join(mount, 'microsandbox');
    const { bsize } = await statfs(mount, { bigint: true });
    if (bsize <= 0n) invalid();
    const image = this.stockDisk.poolFiles(warm(ref)).image;
    const original = await identity(image);
    const outerRoot = dirname(image);
    const outerDevice = String(await directory(outerRoot));
    if (!original || original.device !== outerDevice) invalid();
    const backing = await open(
      image,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const sample = async (nextBytes: bigint) => {
      signal.throwIfAborted();
      if (checkpoint) await checkpoint();
      await backing.sync();
      const volume = await statfs(outerRoot, { bigint: true });
      const guest = await statfs(mount, { bigint: true });
      const current = await backing.stat({ bigint: true });
      if (
        current.dev.toString() !== original.device ||
        current.ino.toString() !== original.inode ||
        current.nlink !== 1n ||
        volume.bsize <= 0n ||
        guest.bsize !== bsize
      )
        invalid();
      const availableBytes = volume.bavail * volume.bsize;
      const allocatedBytes = current.blocks * 512n;
      const chunk = roundBytes(nextBytes, bsize);
      // Include a distinct band for image/filesystem metadata and count the
      // prior guest fsync in the backing allocation before the next write.
      const growth =
        roundBytes(chunk, sparseImageBandBytes) + sparseImageBandBytes;
      if (
        allocatedBytes + growth > reserveBytes ||
        availableBytes < minimumFreeBytes + growth ||
        guest.bavail * bsize < chunk + bsize
      )
        throw new PublicImageCacheBudgetExceeded({
          availableBytes,
          allocatedBytes,
        });
      if (checkpoint) await checkpoint();
      return reserveBytes - allocatedBytes;
    };
    try {
      const bytes = await sample(0n);
      await privateDirectory(nativeRoot);
      await seedPublicImageCache(
        this.imageCache,
        this.options.image,
        nativeRoot,
        signal,
        {
          bytes,
          blockBytes: bsize,
          beforeWrite: async (chunk) => {
            await sample(chunk);
          },
        },
      );
    } catch (error) {
      if (error instanceof PublicImageCacheBudgetExceeded)
        throw new DiskPoolBudgetExceeded(error.capacity, { cause: error });
      if (isCapacityWriteError(error))
        throw new DiskPoolBudgetExceeded(undefined, { cause: error });
      throw error;
    } finally {
      await backing.close();
    }
  }

  async unmountDisk(ref: string, signal: AbortSignal) {
    const disk = warm(ref);
    await this.stockDisk.detach(disk, signal);
    await this.stockDisk.verifyOffline(disk, signal);
  }

  async inspectStock(stock: DiskPoolStock, signal: AbortSignal) {
    if (stock.source !== this.source) invalid();
    return this.identifyStock(stock.ref, signal);
  }

  private async identifyStock(ref: string, signal: AbortSignal) {
    const disk = warm(ref);
    await this.stockDisk.verifyOffline(disk, signal);
    const { image, manifest: receipt } = this.stockDisk.poolFiles(disk);
    const key = this.stockKeys.filePath(ref);
    for (const file of [image, key, receipt]) await syncFile(file);
    const original = await this.stockDisk.inspect(ref, signal);
    if (original.state !== 'ready' || original.disk.tier !== 'warm') invalid();
    const diskIdentity = await identity(image);
    const keyIdentity = await identity(key);
    if (
      !diskIdentity ||
      !keyIdentity ||
      diskIdentity.links !== 1n ||
      keyIdentity.links !== 1n
    )
      invalid();
    return JSON.stringify({
      image: { device: diskIdentity.device, inode: diskIdentity.inode },
      key: { device: keyIdentity.device, inode: keyIdentity.inode },
    } satisfies StockProof);
  }

  async destroyStock(stock: PreparedDiskPoolStock, signal: AbortSignal) {
    await this.layout(signal);
    if ((await this.identifyStock(stock.ref, signal)) !== stock.proof)
      invalid();
    signal.throwIfAborted();
    await this.stockDisk.delete(warm(stock.ref), signal);
    if (!(await this.stockDisk.confirmAbsence(stock.ref, signal))) invalid();
  }

  /** Only the normal VM start provider consumes this readback, after the
   * Person VM owner has checked the journal and identified the disk. */
  async hasSeededPublicCache(vmId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const receipt = await manifest(
      this.options.disk.poolFiles(warm(vmId)).manifest,
    );
    signal.throwIfAborted();
    return (
      receipt?.version === 1 &&
      receipt.vmId === vmId &&
      typeof receipt.poolClaimId === 'string' &&
      receipt.poolSource === this.source
    );
  }

  /** The native create caller owns the boot lease and selected attached disk. */
  async refreshBoundPublicCache(
    binding: PersonVmBinding,
    mount: string,
    signal: AbortSignal,
    resumeOnly = false,
  ) {
    signal.throwIfAborted();
    const disk = warm(binding.vmId);
    const { image, manifest: receiptPath } = this.options.disk.poolFiles(disk);
    const receipt = await manifest(receiptPath);
    if (!receipt?.poolClaimId || receipt.poolSource === this.source)
      return false;
    const nativeRoot = join(mount, 'microsandbox');
    if (
      resumeOnly &&
      !(await hasPendingPublicCacheRefresh(
        this.imageCache,
        this.options.image,
        nativeRoot,
        receipt.poolClaimId,
      ))
    )
      return false;
    const claim = (await this.ledger.read(signal)).bound.get(binding.vmId);
    if (
      !claim ||
      !sameDiskPoolOwner(claim.intent.owner, binding) ||
      claim.intent.id !== receipt.poolClaimId ||
      claim.source !== receipt.poolSource ||
      receipt.version !== 1 ||
      receipt.vmId !== binding.vmId
    )
      invalid();
    const proof = checkedStockProof(claim.proof);
    const diskIdentity = await identity(image);
    const keyIdentity = await identity(
      this.options.keys.filePath(binding.vmId),
    );
    if (
      !diskIdentity ||
      !keyIdentity ||
      diskIdentity.links !== 1n ||
      keyIdentity.links !== 1n ||
      !sameInode(receipt, proof.image) ||
      !sameInode(diskIdentity, proof.image) ||
      !sameInode(keyIdentity, proof.key) ||
      (await this.options.disk.verifyAttachedMount(disk, signal)) !== mount
    )
      invalid();
    await refreshSeededPublicImageCache(
      this.imageCache,
      this.options.image,
      nativeRoot,
      claim.intent.id,
      signal,
    );
    return true;
  }

  private async binding(claim: DiskPoolClaim, signal: AbortSignal) {
    const proof = checkedStockProof(claim.proof);
    await this.layout(signal);
    const stock = warm(claim.ref);
    const formal = warm(claim.intent.owner.vmId);
    const from = {
      ...this.stockDisk.poolFiles(stock),
      key: this.stockKeys.filePath(stock.vmId),
    };
    const to = {
      ...this.options.disk.poolFiles(formal),
      key: this.options.keys.filePath(formal.vmId),
    };
    await this.stockDisk.verifyOffline(stock, signal);
    await this.options.disk.verifyOffline(formal, signal);
    if (
      (await identity(
        this.options.disk.poolFiles({ ...formal, tier: 'cold' }).image,
      )) ||
      (await identity(
        this.stockDisk.poolFiles({ ...stock, tier: 'cold' }).image,
      ))
    )
      invalid();
    const image = placement(
      await identity(from.image),
      await identity(to.image),
      proof.image,
    );
    const key = placement(
      await identity(from.key),
      await identity(to.key),
      proof.key,
    );
    const old = await manifest(from.manifest);
    const current = await manifest(to.manifest);
    const allFormal = image === 'formal' && key === 'formal';
    if (
      old &&
      (old.version !== 1 ||
        old.vmId !== stock.vmId ||
        old.poolClaimId !== undefined ||
        !sameInode(old, proof.image))
    )
      invalid();
    if (
      current &&
      (current.version !== 1 ||
        current.vmId !== formal.vmId ||
        current.poolClaimId !== claim.intent.id ||
        current.poolSource !== claim.source ||
        !sameInode(current, proof.image) ||
        !allFormal ||
        old)
    )
      invalid();
    if (
      (!old && !allFormal) ||
      (image === 'stock' && key !== 'stock') ||
      (image === 'linked' && key === 'formal') ||
      (image === 'formal' && key === 'stock')
    )
      invalid();
    signal.throwIfAborted();
    return { from, to, formal, proof, image, key, old, current };
  }

  async inspectBinding(claim: DiskPoolClaim, signal: AbortSignal) {
    try {
      const state = await this.binding(claim, signal);
      if (state.image === 'formal')
        await this.options.disk.verifyImageKey(state.formal, signal);
      else await this.stockDisk.verifyImageKey(warm(claim.ref), signal);
      if (state.current) {
        // A dead writer can leave the published link visible before fsync.
        await syncFile(state.to.manifest);
        return 'bound' as const;
      }
      return 'pending' as const;
    } catch {
      signal.throwIfAborted();
      return 'unknown' as const;
    }
  }

  async bindDisk(
    claim: DiskPoolClaim,
    signal: AbortSignal,
    beforeManifestLink?: () => Promise<void>,
  ) {
    const state = await this.binding(claim, signal);
    if (state.current) return;
    const { from, to } = state;
    if (state.image === 'stock') {
      signal.throwIfAborted();
      await link(from.image, to.image);
    }
    await syncDiskPoolDirectory(dirname(to.image));
    if (state.key === 'stock') {
      signal.throwIfAborted();
      await link(from.key, to.key);
    }
    await syncDiskPoolDirectory(dirname(to.key));
    await this.options.disk.verifyImageKey(state.formal, signal);
    for (const [path, exists] of [
      [from.image, state.image !== 'formal'],
      [from.key, state.key !== 'formal'],
      [from.manifest, Boolean(state.old)],
    ] as const) {
      signal.throwIfAborted();
      if (exists) await unlink(path);
      // Persist both a just-completed unlink and one observed on recovery.
      await syncDiskPoolDirectory(dirname(path));
    }
    await publishDiskPoolRecord(
      to.manifest,
      {
        version: 1,
        vmId: state.formal.vmId,
        ...state.proof.image,
        poolClaimId: claim.intent.id,
        poolSource: claim.source,
      },
      { signal, beforeLink: beforeManifestLink },
    );
  }
}
