import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
} from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import { PersonVmError } from './contract.ts';
import {
  missing,
  privatePersonVmDirectory,
  syncDiskPoolDirectory,
  systemPathNormalizer,
} from './disk-pool-ledger.ts';
import { hostEnvironment, runCommand, type CommandRunner } from './process.ts';

export type PersonDisk = Readonly<{ vmId: string; tier: 'warm' | 'cold' }>;
type EraseOptions = Readonly<{
  identitySha256: string | null;
  beforeErase(mount: string): Promise<void>;
}>;
export type PersonVmDiskInspection =
  | Readonly<{ state: 'absent' | 'unknown' }>
  | Readonly<{ state: 'ready'; disk: PersonDisk; identitySha256?: string }>;
type DiskImageInfo = {
  images?: {
    'image-path': string;
    'system-entities'?: { 'mount-point'?: string }[];
  }[];
};
export type PersonVmDiskIdentity = Readonly<{ device: string; inode: string }>;
type MountState =
  | Readonly<{ state: 'unknown' }>
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'attached'; mount: string }>;
type PersonVmMountInspection =
  | Readonly<{ state: 'unknown' }>
  | (Exclude<MountState, { state: 'unknown' }> &
      Readonly<{ image: PersonVmDiskIdentity }>);
export interface PersonVmDiskPort {
  /** Host-only non-destructive reconciliation of this vmId's two storage locations. */
  inspect(vmId: string, signal: AbortSignal): Promise<PersonVmDiskInspection>;
  /** Independently confirm a previously retired VM's disk, key and mount are absent. */
  confirmAbsence?(vmId: string, signal: AbortSignal): Promise<boolean>;
  /** Formal Host references that need an owner before allocating new storage. */
  listFormalDiskIds?(signal: AbortSignal): Promise<string[]>;
  inspectDeletionTarget?(
    vmId: string,
    signal: AbortSignal,
    erasingIdentity?: string,
  ): Promise<PersonVmDiskInspection>;
  verifyDeletionDetached?(
    disk: PersonDisk,
    signal: AbortSignal,
  ): Promise<string>;
  inspectMount?(
    disk: PersonDisk,
    signal: AbortSignal,
    expected?: Readonly<{ image: PersonVmDiskIdentity; acrossTier?: true }>,
  ): Promise<PersonVmMountInspection>;
  /** Returns the creation identity only when this call formatted a new image. */
  create(
    disk: PersonDisk,
    signal: AbortSignal,
  ): Promise<PersonVmDiskIdentity | void>;
  attach(
    disk: PersonDisk,
    signal: AbortSignal,
    beforeDispatch?: () => void,
  ): Promise<string>;
  verifyAttachedMount?(
    disk: PersonDisk,
    signal: AbortSignal,
  ): Promise<string | null>;
  detach(
    disk: PersonDisk,
    signal: AbortSignal,
    onDetached?: (mount: string) => Promise<void>,
  ): Promise<void>;
  move(
    disk: PersonDisk,
    tier: PersonDisk['tier'],
    signal: AbortSignal,
  ): Promise<PersonDisk>;
  delete(
    disk: PersonDisk,
    signal: AbortSignal,
    erase?: EraseOptions,
  ): Promise<void>;
}
export interface PersonVmKeyStore {
  readOrCreate(
    vmId: string,
    beforeWrite?: () => Promise<void>,
  ): Promise<Buffer>;
  read(vmId: string): Promise<Buffer>;
  delete(vmId: string): Promise<void>;
  confirmAbsence?(vmId: string): Promise<boolean>;
  listDiskIds?(signal: AbortSignal): Promise<string[]>;
}

function checkedId(vmId: string) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      vmId,
    )
  ) {
    throw new PersonVmError('PROVIDER_FAILED');
  }
  return vmId;
}
export async function privateDirectory(path: string) {
  if (!isAbsolute(path)) throw new PersonVmError('PROVIDER_FAILED');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new PersonVmError('PROVIDER_FAILED');
  await chmod(path, 0o700);
}

async function privateFileIds(
  path: string,
  suffix: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const directory = await privatePersonVmDirectory(path);
  if (!directory) return [];
  const ids: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith(suffix)) continue;
    if (!entry.isFile()) throw new PersonVmError('CLEANUP_INCOMPLETE');
    ids.push(checkedId(entry.name.slice(0, -suffix.length)));
  }
  signal.throwIfAborted();
  return ids;
}

/** Dedicated host directory only. Never use a DSH plugin storageDir or guest path. */
export class FilePersonVmKeyStore implements PersonVmKeyStore {
  constructor(private readonly root: string) {}
  filePath(id: string) {
    return join(this.root, `${checkedId(id)}.key`);
  }
  async readOrCreate(id: string, beforeWrite?: () => Promise<void>) {
    await privateDirectory(this.root);
    const value = randomBytes(48).toString('hex');
    if (beforeWrite) await beforeWrite();
    try {
      const file = await open(
        this.filePath(id),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(value);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return this.read(id);
  }
  async read(id: string) {
    const file = await open(
      this.filePath(id),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size !== 96)
        throw new PersonVmError('PROVIDER_FAILED');
      return Buffer.from(await file.readFile());
    } finally {
      await file.close();
    }
  }
  async delete(id: string) {
    await rm(this.filePath(id), { force: true });
  }
  async confirmAbsence(id: string) {
    const root = await privatePersonVmDirectory(this.root);
    if (!root) return false;
    try {
      await lstat(join(root, basename(this.filePath(id))));
      return false;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await syncDiskPoolDirectory(root);
    return true;
  }
  listDiskIds(signal: AbortSignal) {
    return privateFileIds(this.root, '.key', signal);
  }
}

/** AES-256 APFS sparse images. All MSB writable state lives inside this image. */
export class ApfsPersonVmDisk implements PersonVmDiskPort {
  private readonly run: CommandRunner;
  constructor(
    private readonly options: {
      root: string;
      keys: PersonVmKeyStore;
      capacityGiB: number;
      runner?: CommandRunner;
    },
  ) {
    this.run = options.runner ?? runCommand;
    if (!Number.isInteger(options.capacityGiB) || options.capacityGiB <= 0)
      throw new PersonVmError('PROVIDER_FAILED');
  }
  private image(disk: PersonDisk) {
    return join(
      this.options.root,
      disk.tier,
      `${checkedId(disk.vmId)}.sparseimage`,
    );
  }
  private mount(disk: PersonDisk) {
    return join(this.options.root, 'mounts', checkedId(disk.vmId));
  }
  private manifest(vmId: string) {
    return join(this.options.root, 'manifests', `${checkedId(vmId)}.json`);
  }
  /** Trusted adapter only. Transferring ownership requires these exact paths. */
  poolFiles(disk: PersonDisk) {
    return { image: this.image(disk), manifest: this.manifest(disk.vmId) };
  }
  private async command(
    args: string[],
    signal: AbortSignal,
    input?: Uint8Array,
  ) {
    return this.run({
      executable: '/usr/bin/hdiutil',
      args,
      env: hostEnvironment(this.options.root),
      signal,
      ...(input ? { input } : {}),
    });
  }
  private async info(
    signal: AbortSignal,
    canonical: ReturnType<typeof systemPathNormalizer>,
  ): Promise<DiskImageInfo> {
    const plist = await this.command(['info', '-plist'], signal);
    const json = await this.run({
      executable: '/usr/bin/plutil',
      args: ['-convert', 'json', '-o', '-', '-'],
      env: hostEnvironment(this.options.root),
      signal,
      input: Buffer.from(plist),
    });
    const state = JSON.parse(json) as DiskImageInfo;
    if (Array.isArray(state.images)) {
      for (const image of state.images) {
        signal.throwIfAborted();
        if (typeof image?.['image-path'] === 'string')
          image['image-path'] = await canonical(image['image-path']);
        if (Array.isArray(image?.['system-entities'])) {
          for (const entity of image['system-entities']) {
            const point = entity?.['mount-point'];
            if (typeof point === 'string')
              entity['mount-point'] = await canonical(point);
          }
        }
      }
    }
    return state;
  }
  private async mountState(
    disk: PersonDisk,
    signal: AbortSignal,
    previous?: PersonDisk,
  ): Promise<MountState> {
    const canonical = systemPathNormalizer();
    const image = await canonical(this.image(disk));
    const oldImage = previous && (await canonical(this.image(previous)));
    const mount = this.mount(disk);
    const canonicalMount = await canonical(mount);
    const { images } = await this.info(signal, canonical);
    signal.throwIfAborted();
    if (!Array.isArray(images)) return { state: 'unknown' };
    const matches = images.filter(
      (entry) =>
        entry['image-path'] === image ||
        (oldImage !== undefined && entry['image-path'] === oldImage) ||
        entry['system-entities']?.some(
          (entity) => entity['mount-point'] === canonicalMount,
        ),
    );
    if (!matches.length) return { state: 'absent' };
    if (
      matches.length !== 1 ||
      matches[0]?.['image-path'] !== image ||
      matches[0]['system-entities']?.filter(
        (entity) => entity['mount-point'] === canonicalMount,
      ).length !== 1
    )
      return { state: 'unknown' };
    return { state: 'attached', mount };
  }
  private async isAttached(disk: PersonDisk, signal: AbortSignal) {
    const match = await this.mountState(disk, signal);
    if (match.state === 'unknown')
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    return match.state === 'attached';
  }
  private async withKey<T>(
    disk: PersonDisk,
    create: boolean,
    fn: (key: Buffer) => Promise<T>,
    beforeKeyWrite?: () => Promise<void>,
  ) {
    const key = await (create
      ? this.options.keys.readOrCreate(disk.vmId, beforeKeyWrite)
      : this.options.keys.read(disk.vmId));
    const input = Buffer.concat([key, Buffer.from([0])]);
    try {
      return await fn(input);
    } finally {
      key.fill(0);
      input.fill(0);
    }
  }
  async verifyImageKey(disk: PersonDisk, signal: AbortSignal) {
    await this.withKey(disk, false, (key) =>
      this.command(
        ['imageinfo', this.image(disk), '-stdinpass', '-plist'],
        signal,
        key,
      ),
    );
  }

  /** Pool entries may not have a live device or an occupied mount point. */
  async verifyOffline(disk: PersonDisk, signal: AbortSignal) {
    const canonical = systemPathNormalizer();
    const image = await canonical(this.image(disk));
    const mount = await canonical(this.mount(disk));
    const actual = await stat(image, { bigint: true }).catch(
      (error: unknown) => {
        if (missing(error)) return null;
        throw error;
      },
    );
    const observe = async (disappeared?: string) => {
      const state = await this.info(signal, canonical);
      if (
        !Array.isArray(state.images) ||
        state.images.some(
          (entry) =>
            !entry ||
            typeof entry['image-path'] !== 'string' ||
            entry['image-path'] === image ||
            entry['image-path'] === disappeared ||
            !Array.isArray(entry['system-entities']) ||
            entry['system-entities'].some(
              (entity) => !entity || entity['mount-point'] === mount,
            ),
        )
      )
        throw new PersonVmError('CLEANUP_INCOMPLETE');
      if (!actual) return;
      for (const item of state.images) {
        signal.throwIfAborted();
        const path = item['image-path'];
        if (!isAbsolute(path)) throw new PersonVmError('CLEANUP_INCOMPLETE');
        let candidate;
        try {
          candidate = await stat(path, { bigint: true });
        } catch (error) {
          if (missing(error)) return path;
          throw error;
        }
        if (candidate.dev === actual.dev && candidate.ino === actual.ino)
          throw new PersonVmError('CLEANUP_INCOMPLETE');
      }
    };
    const disappeared = await observe();
    // A vanished path is harmless only when a fresh device inventory no
    // longer reports that attachment and still proves the target offline.
    if (disappeared && (await observe(disappeared)))
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    const root = await lstat(this.options.root);
    const mounted = await lstat(mount).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (mounted && (!mounted.isDirectory() || mounted.dev !== root.dev))
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    signal.throwIfAborted();
  }
  async inspect(
    vmId: string,
    signal: AbortSignal,
  ): Promise<PersonVmDiskInspection> {
    signal.throwIfAborted();
    for (const directory of ['', 'warm', 'cold', 'manifests'])
      await privateDirectory(join(this.options.root, directory));
    const observed = await this.inspectExisting(vmId, signal);
    return observed.state === 'ready'
      ? { state: 'ready', disk: observed.disk }
      : observed;
  }
  async listFormalDiskIds(signal: AbortSignal) {
    const root = await privatePersonVmDirectory(this.options.root);
    const ids = new Set(await this.options.keys.listDiskIds?.(signal));
    if (!root) return [...ids];
    for (const [dir, suffix] of [
      ['warm', '.sparseimage'],
      ['cold', '.sparseimage'],
      ['manifests', '.json'],
    ] as const) {
      for (const id of await privateFileIds(join(root, dir), suffix, signal))
        ids.add(id);
    }
    return [...ids];
  }
  async confirmAbsence(vmId: string, signal: AbortSignal) {
    // An absent image/manifest pair alone can still leave an attached device
    // or an old key. Validate the original root before accepting absence.
    const root = await privatePersonVmDirectory(this.options.root);
    if (!root) return false;
    if ((await this.inspectExisting(vmId, signal)).state !== 'absent')
      return false;
    for (const tier of ['warm', 'cold'] as const)
      await this.verifyOffline({ vmId, tier }, signal);
    if (!(await this.options.keys.confirmAbsence?.(vmId))) return false;
    for (const dir of ['warm', 'cold', 'manifests'])
      await syncDiskPoolDirectory(join(root, dir));
    signal.throwIfAborted();
    return true;
  }
  async inspectDeletionTarget(
    vmId: string,
    signal: AbortSignal,
    erasingIdentity?: string,
  ): Promise<PersonVmDiskInspection> {
    const observed = await this.inspectExisting(
      vmId,
      signal,
      true,
      erasingIdentity,
    );
    if (observed.state !== 'ready') return observed;
    return {
      state: 'ready',
      disk: observed.disk,
      ...(observed.identitySha256 && {
        identitySha256: observed.identitySha256,
      }),
    };
  }
  private async inspectExisting(
    vmId: string,
    signal: AbortSignal,
    includeIdentity = false,
    erasingIdentity?: string,
  ): Promise<
    | Readonly<{ state: 'absent' | 'unknown' }>
    | Readonly<{
        state: 'ready';
        disk: PersonDisk;
        image: PersonVmDiskIdentity;
        identitySha256?: string;
      }>
  > {
    signal.throwIfAborted();
    const found: { disk: PersonDisk; device: string; inode: string }[] = [];
    for (const tier of ['warm', 'cold'] as const) {
      const disk = { vmId, tier };
      try {
        const stat = await lstat(this.image(disk), { bigint: true });
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          (stat.mode & 0o777n) !== 0o600n
        )
          return { state: 'unknown' };
        found.push({ disk, device: String(stat.dev), inode: String(stat.ino) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    let manifest: unknown;
    try {
      const file = await open(
        this.manifest(vmId),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024)
          return { state: 'unknown' };
        manifest = JSON.parse(await file.readFile('utf8'));
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { state: found.length === 0 ? 'absent' : 'unknown' };
      if (signal.aborted) throw error;
      return { state: 'unknown' };
    }
    if (!manifest || typeof manifest !== 'object') return { state: 'unknown' };
    const receipt = manifest as Record<string, unknown>;
    if (
      receipt.version !== 1 ||
      receipt.vmId !== vmId ||
      typeof receipt.device !== 'string' ||
      typeof receipt.inode !== 'string'
    )
      return { state: 'unknown' };
    const identitySha256 = () =>
      createHash('sha256')
        .update(JSON.stringify([1, vmId, receipt.device, receipt.inode]))
        .digest('hex');
    if (
      found.length === 0 &&
      erasingIdentity &&
      identitySha256() === erasingIdentity
    )
      return { state: 'absent' };
    const actual = found[0];
    if (
      found.length !== 1 ||
      !actual ||
      receipt.device !== actual.device ||
      receipt.inode !== actual.inode
    )
      return { state: 'unknown' };
    try {
      // Recognize/decrypt the completed container through the public command.
      // This does not mount, repair, reformat, or claim filesystem health.
      await this.verifyImageKey(actual.disk, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return { state: 'unknown' };
    }
    return {
      state: 'ready',
      disk: actual.disk,
      image: Object.freeze({ device: actual.device, inode: actual.inode }),
      ...(includeIdentity && {
        // Fingerprint the verified creation receipt, not the user's bytes or key.
        identitySha256: identitySha256(),
      }),
    };
  }

  /** An observation only, under the disk's physical lease. */
  async inspectMount(
    disk: PersonDisk,
    signal: AbortSignal,
    expected?: Readonly<{ image: PersonVmDiskIdentity; acrossTier?: true }>,
  ): Promise<PersonVmMountInspection> {
    const observed = await this.inspectExisting(disk.vmId, signal);
    if (
      observed.state !== 'ready' ||
      (observed.disk.tier !== disk.tier && !expected?.acrossTier) ||
      (expected &&
        (observed.image.device !== expected.image.device ||
          observed.image.inode !== expected.image.inode))
    )
      return { state: 'unknown' };
    const mounted = await this.mountState(observed.disk, signal, disk);
    return mounted.state === 'unknown'
      ? mounted
      : { ...mounted, image: observed.image };
  }
  async verifyAttachedMount(disk: PersonDisk, signal: AbortSignal) {
    const match = await this.inspectMount(disk, signal);
    return match.state === 'attached' ? match.mount : null;
  }
  async create(
    disk: PersonDisk,
    signal: AbortSignal,
    beforeKeyWrite?: () => Promise<void>,
  ) {
    await privateDirectory(this.options.root);
    await privateDirectory(join(this.options.root, disk.tier));
    const existing = await this.inspect(disk.vmId, signal);
    if (existing.state === 'ready') return;
    if (existing.state !== 'absent') throw new PersonVmError('PROVIDER_FAILED');
    await this.withKey(
      disk,
      true,
      (key) =>
        this.command(
          [
            'create',
            '-size',
            `${this.options.capacityGiB}g`,
            '-fs',
            'APFS',
            '-volname',
            `AllRice-${disk.vmId}`,
            '-type',
            'SPARSE',
            '-encryption',
            'AES-256',
            '-stdinpass',
            this.image(disk),
          ],
          signal,
          key,
        ),
      beforeKeyWrite,
    );
    await chmod(this.image(disk), 0o600);
    const stat = await lstat(this.image(disk), { bigint: true });
    const receipt = await open(
      this.manifest(disk.vmId),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const identity = { device: String(stat.dev), inode: String(stat.ino) };
    try {
      await receipt.writeFile(
        JSON.stringify({ version: 1, vmId: disk.vmId, ...identity }),
      );
      await receipt.sync();
    } finally {
      await receipt.close();
    }
    return Object.freeze(identity);
  }
  async attach(
    disk: PersonDisk,
    signal: AbortSignal,
    beforeDispatch?: () => void,
  ) {
    const inspected = await this.inspect(disk.vmId, signal);
    if (inspected.state !== 'ready' || inspected.disk.tier !== disk.tier)
      throw new PersonVmError('PROVIDER_FAILED');
    const stat = await lstat(this.image(disk));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new PersonVmError('PROVIDER_FAILED');
    if (!(await this.isAttached(disk, signal))) {
      await privateDirectory(this.mount(disk));
      await this.withKey(disk, false, async (key) => {
        if (await this.isAttached(disk, signal)) return;
        signal.throwIfAborted();
        beforeDispatch?.();
        await this.command(
          [
            'attach',
            this.image(disk),
            '-stdinpass',
            '-nobrowse',
            '-mountpoint',
            this.mount(disk),
          ],
          signal,
          key,
        );
      });
    }
    if (!(await this.isAttached(disk, signal)))
      throw new PersonVmError('PROVIDER_FAILED');
    return this.mount(disk);
  }
  async verifyDeletionDetached(disk: PersonDisk, signal: AbortSignal) {
    for (const tier of ['warm', 'cold'] as const)
      await this.verifyOffline({ vmId: disk.vmId, tier }, signal);
    return this.mount(disk);
  }
  async detach(
    disk: PersonDisk,
    signal: AbortSignal,
    onDetached?: (mount: string) => Promise<void>,
  ) {
    if (await this.isAttached(disk, signal))
      await this.command(['detach', this.mount(disk)], signal);
    if (await this.isAttached(disk, signal))
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    if (onDetached)
      await onDetached(await this.verifyDeletionDetached(disk, signal));
  }
  async move(disk: PersonDisk, tier: PersonDisk['tier'], signal: AbortSignal) {
    signal.throwIfAborted();
    const inspected = await this.inspect(disk.vmId, signal);
    if (inspected.state !== 'ready') throw new PersonVmError('PROVIDER_FAILED');
    const actual = inspected.disk;
    if (await this.isAttached(actual, signal))
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    const next = { vmId: disk.vmId, tier };
    if (tier !== actual.tier) {
      await privateDirectory(join(this.options.root, tier));
      try {
        await lstat(this.image(next));
        throw new PersonVmError('PROVIDER_FAILED');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(this.image(actual), this.image(next));
    }
    return next;
  }
  async delete(disk: PersonDisk, signal: AbortSignal, erase?: EraseOptions) {
    const inspected = erase
      ? await this.inspectDeletionTarget(
          disk.vmId,
          signal,
          erase.identitySha256 ?? undefined,
        )
      : await this.inspect(disk.vmId, signal);
    if (inspected.state === 'unknown')
      throw new PersonVmError('PROVIDER_FAILED');
    if (
      erase &&
      inspected.state === 'ready' &&
      (inspected.identitySha256 !== erase.identitySha256 ||
        inspected.disk.tier !== disk.tier)
    )
      throw new PersonVmError('LEASE_LOST');
    const actual = inspected.state === 'ready' ? inspected.disk : disk;
    if (erase) {
      const mount = await this.verifyDeletionDetached(disk, signal);
      await erase.beforeErase(mount);
      try {
        await rmdir(mount);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } else if (await this.isAttached(actual, signal)) {
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    }
    signal.throwIfAborted();
    await rm(this.image(actual), { force: true });
    // Never erase the completion receipt/key while either owned image remains,
    // including when the caller's persisted tier lagged a committed rename.
    for (const tier of ['warm', 'cold'] as const) {
      try {
        await lstat(this.image({ vmId: disk.vmId, tier }));
        throw new PersonVmError('CLEANUP_INCOMPLETE');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rm(this.manifest(disk.vmId), { force: true });
    await this.options.keys.delete(disk.vmId);
  }
}
