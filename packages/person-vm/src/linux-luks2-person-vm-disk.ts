import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { z } from 'zod';
import type { PersonVmBinding } from './contract.ts';
import { PersonVmError } from './contract.ts';
import { missing, syncDiskPoolDirectory } from './disk-pool-ledger.ts';
import type {
  PersonDisk,
  PersonVmDiskIdentity,
  PersonVmDiskInspection,
  PersonVmDiskPort,
  PersonVmKeyStore,
} from './encrypted-disk.ts';
import {
  linuxDiskKernel,
  linuxTools,
  observeLinuxDisk,
  requireDisk,
  type LinuxDiskKernel,
  type LinuxDiskObservation,
} from './linux-luks2-state.ts';
import { hostEnvironment, runCommand, type CommandRunner } from './process.ts';
import type { OwnedWorkDiskReceipt } from './template-snapshot-contract.ts';

const uuid = z.uuid();
const vmIdSchema = z.uuidv4().refine((id) => id.toLowerCase() === id);
const recordSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(['formatting', 'ready', 'erasing']),
  vmId: vmIdSchema,
  image: z.strictObject({
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
  }),
  capacityBytes: z.int().positive(),
  luksUuid: uuid,
  xfsUuid: uuid,
});
type DiskRecord = z.infer<typeof recordSchema>;

const tiers = ['warm', 'cold'] as const;
const ownedDirectory = 0o700n;
const regularFile = 0o600n;

type DirectoryLayout = {
  mount: string;
  journal: string;
  images: Readonly<Record<PersonDisk['tier'], string>>;
  name: string;
};
type DiskState = Readonly<{
  layout: DirectoryLayout;
  record: DiskRecord | null;
  file?: {
    path: string;
    identity: PersonVmDiskIdentity;
    tier: PersonDisk['tier'];
  };
  observed: LinuxDiskObservation;
}>;

type DiskAuthority = <T>(
  binding: PersonVmBinding,
  disk: PersonDisk,
  signal: AbortSignal,
  use: () => Promise<T>,
) => Promise<T>;

type LinuxDiskOptions = Readonly<{
  root: string;
  capacityGiB: number;
  keys: PersonVmKeyStore &
    Required<Pick<PersonVmKeyStore, 'confirmAbsence' | 'listDiskIds'>>;
  /** The future host holds the exact #59 lease and verifies all binding fields
   * for the full callback. Presence of a same-name VM is insufficient. */
  withCurrentDisk: DiskAuthority;
  /** Overrides are for isolated fixtures, supplied together. */
  runner?: CommandRunner;
  kernel?: LinuxDiskKernel;
}>;

function exactImage(a: PersonVmDiskIdentity, b: PersonVmDiskIdentity) {
  return a.device === b.device && a.inode === b.inode;
}

function sameBinding(a: PersonVmBinding, b: PersonVmBinding) {
  return (
    a.vmId === b.vmId &&
    a.personId === b.personId &&
    a.organizationId === b.organizationId &&
    a.instanceId === b.instanceId &&
    a.leaseEpoch === b.leaseEpoch
  );
}

function unavailable(): never {
  throw new PersonVmError('PROVIDER_FAILED');
}

function checkedId(id: string) {
  if (!vmIdSchema.safeParse(id).success) unavailable();
  return id;
}

async function optional<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function detached(observed: LinuxDiskObservation) {
  return !observed.mount && !observed.mapper && !observed.loop;
}

function deletionIdentity(record: DiskRecord) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        record.vmId,
        record.image.device,
        record.image.inode,
        record.capacityBytes,
        record.luksUuid,
        record.xfsUuid,
      ]),
    )
    .digest('hex');
}

/** Dedicated local privileged owner. The data root and its ancestors must be
 * protected from the Worker, guest and other untrusted users. All native and
 * disk owners must see the same mount namespace. A single helper and the
 * caller's #59 lease exclude independent operations on its registered VM. */
export class LinuxLuks2PersonVmDisk implements PersonVmDiskPort {
  private readonly runner: CommandRunner;
  private readonly kernel: LinuxDiskKernel;
  private readonly env: Record<string, string>;
  private readonly bytes: number;
  private readonly uid: bigint;
  private readonly issued = new WeakMap<OwnedWorkDiskReceipt, object>();
  private readonly generations = new Map<string, object>();
  private pending = Promise.resolve();

  constructor(private readonly options: LinuxDiskOptions) {
    const { root, capacityGiB, runner, kernel } = options;
    const uid = process.geteuid?.();
    requireDisk(
      root.startsWith('/') &&
        root !== '/' &&
        root.length < 2048 &&
        /^[a-zA-Z0-9_./-]+$/.test(root) &&
        posix.normalize(root) === root &&
        !root.endsWith('/') &&
        Number.isSafeInteger(capacityGiB) &&
        capacityGiB >= 1 &&
        Number.isSafeInteger(capacityGiB * 1024 ** 3) &&
        uid !== undefined &&
        ((runner && kernel) ||
          (!runner && !kernel && process.platform === 'linux' && uid === 0)),
      'PROVIDER_FAILED',
    );
    this.options = Object.freeze({ ...options });
    this.bytes = capacityGiB * 1024 ** 3;
    this.uid = BigInt(uid);
    this.env = hostEnvironment(root);
    this.runner = runner ?? runCommand;
    this.kernel = kernel ?? linuxDiskKernel;
  }

  private serial<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const done = this.pending.then(async () => {
      signal.throwIfAborted();
      try {
        return await operation();
      } catch (error) {
        if (error instanceof PersonVmError) throw error;
        return unavailable();
      }
    });
    this.pending = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  }

  private async roots() {
    const root = this.options.root;
    for (let path = root; ; path = dirname(path)) {
      const info = await lstat(path, { bigint: true });
      requireDisk(
        info.isDirectory() &&
          !info.isSymbolicLink() &&
          (info.uid === 0n || info.uid === this.uid) &&
          (info.mode & 0o022n) === 0n,
      );
      if (path === root)
        requireDisk(
          info.uid === this.uid && (info.mode & 0o777n) === ownedDirectory,
        );
      if (path === '/') break;
    }
    for (const name of [...tiers, 'journal', 'mounts']) {
      const path = join(root, name);
      await mkdir(path, { mode: Number(ownedDirectory) }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
      await this.privateDirectory(path);
    }
    return root;
  }

  private async privateDirectory(path: string) {
    const info = await lstat(path, { bigint: true });
    requireDisk(
      info.isDirectory() &&
        !info.isSymbolicLink() &&
        info.uid === this.uid &&
        (info.mode & 0o777n) === ownedDirectory,
    );
  }

  private async layout(id: string): Promise<DirectoryLayout> {
    const vmId = checkedId(id);
    const root = await this.roots();
    const hash = createHash('sha256')
      .update(root)
      .update('\0')
      .update(vmId)
      .digest('hex');
    return {
      mount: join(root, 'mounts', vmId),
      journal: join(root, 'journal', vmId + '.json'),
      images: {
        warm: join(root, 'warm', vmId + '.luks'),
        cold: join(root, 'cold', vmId + '.luks'),
      },
      name: 'allrice-' + hash,
    };
  }

  private async execute(
    tool: keyof typeof linuxTools,
    args: string[],
    signal: AbortSignal,
    input?: Buffer,
  ) {
    signal.throwIfAborted();
    try {
      const result = await this.runner({
        executable: linuxTools[tool],
        args,
        env: this.env,
        signal,
        ...(input ? { input } : {}),
      });
      signal.throwIfAborted();
      return result;
    } catch {
      return unavailable();
    }
  }

  private async withKey(
    id: string,
    create: boolean,
    run: (key: Buffer) => Promise<unknown>,
  ) {
    const key = await (create
      ? this.options.keys.readOrCreate(id)
      : this.options.keys.read(id));
    try {
      requireDisk(
        Buffer.isBuffer(key) && key.length >= 32 && key.length <= 4096,
      );
      await run(key);
    } finally {
      if (Buffer.isBuffer(key)) key.fill(0);
    }
  }

  private async readRecord(path: string) {
    const file = await optional(() =>
      open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ),
    );
    if (!file) return null;
    try {
      const info = await file.stat({ bigint: true });
      requireDisk(
        info.isFile() &&
          info.uid === this.uid &&
          info.nlink === 1n &&
          (info.mode & 0o777n) === regularFile &&
          info.size > 0n &&
          info.size <= 4096n,
      );
      return recordSchema.parse(JSON.parse(await file.readFile('utf8')));
    } finally {
      await file.close();
    }
  }

  private async writeRecord(path: string, record: DiskRecord) {
    const tmp = path + '.' + randomUUID();
    const file = await open(
      tmp,
      constants.O_WRONLY |
        constants.O_NOFOLLOW |
        constants.O_EXCL |
        constants.O_CREAT,
      Number(regularFile),
    );
    try {
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, path);
      await syncDiskPoolDirectory(dirname(path));
    } finally {
      await rm(tmp, { force: true });
    }
  }

  private async imageAt(
    path: string,
    capacity = this.bytes,
  ): Promise<PersonVmDiskIdentity | null> {
    const info = await optional(() => lstat(path, { bigint: true }));
    if (!info) return null;
    requireDisk(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.uid === this.uid &&
        info.nlink === 1n &&
        (info.mode & 0o777n) === regularFile &&
        info.size === BigInt(capacity),
    );
    return { device: String(info.dev), inode: String(info.ino) };
  }

  private async state(id: string, signal: AbortSignal): Promise<DiskState> {
    signal.throwIfAborted();
    const layout = await this.layout(id);
    const record = await this.readRecord(layout.journal);
    if (record) requireDisk(record.vmId === id);
    let file: DiskState['file'];
    for (const tier of tiers) {
      const path = layout.images[tier];
      const identity = await this.imageAt(path, record?.capacityBytes);
      if (!identity) continue;
      requireDisk(!file && record && exactImage(identity, record.image));
      file = { path, identity, tier };
    }
    const observed = await observeLinuxDisk(
      {
        image: file,
        allImagePaths: Object.values(layout.images),
        expectedIdentity: record?.image,
        mount: layout.mount,
        name: layout.name,
        luksUuid: record?.luksUuid,
      },
      this.kernel,
      this.runner,
      this.env,
      signal,
    );
    if (!observed.mount) {
      const target = await optional(() => lstat(layout.mount));
      if (target) await this.privateDirectory(layout.mount);
    }
    if (!file) requireDisk(detached(observed));
    return { layout, record, file, observed };
  }

  private async verifyHeader(state: DiskState, signal: AbortSignal) {
    requireDisk(state.file && state.record);
    await this.execute(
      'crypt',
      ['isLuks', '--type', 'luks2', state.file.path],
      signal,
    );
    requireDisk(
      (
        await this.execute('crypt', ['luksUUID', state.file.path], signal)
      ).trim() === state.record.luksUuid,
    );
  }

  private async verifyXfs(state: DiskState, signal: AbortSignal) {
    requireDisk(state.record && state.observed.mapper);
    const facts = (
      await this.execute(
        'blkid',
        [
          '-p',
          '-s',
          'UUID',
          '-s',
          'TYPE',
          '-o',
          'export',
          state.observed.mapper.path,
        ],
        signal,
      )
    )
      .trim()
      .split('\n');
    requireDisk(
      facts.filter((f) => f.startsWith('UUID=')).join() ===
        'UUID=' + state.record.xfsUuid &&
        facts.filter((f) => f.startsWith('TYPE=')).join() === 'TYPE=xfs',
    );
  }

  private async inspectState(
    id: string,
    signal: AbortSignal,
    erasingIdentity?: string,
  ): Promise<PersonVmDiskInspection> {
    try {
      const state = await this.state(id, signal);
      if (!state.record)
        return {
          state: (await this.options.keys.confirmAbsence(id))
            ? 'absent'
            : 'unknown',
        };
      if (
        state.record.phase === 'erasing' &&
        erasingIdentity === deletionIdentity(state.record) &&
        !state.file
      )
        return { state: 'absent' };
      requireDisk(
        state.file &&
          (state.record.phase === 'ready' ||
            (state.record.phase === 'erasing' &&
              erasingIdentity === deletionIdentity(state.record))),
      );
      await this.verifyHeader(state, signal);
      if (state.record.phase === 'ready')
        await this.withKey(id, false, async () => undefined);
      if (state.observed.mapper) await this.verifyXfs(state, signal);
      return {
        state: 'ready',
        disk: { vmId: id, tier: state.file.tier },
        identitySha256: deletionIdentity(state.record),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return { state: 'unknown' };
    }
  }

  inspect(id: string, signal: AbortSignal) {
    return this.serial(signal, () => this.inspectState(checkedId(id), signal));
  }

  inspectDeletionTarget(
    id: string,
    signal: AbortSignal,
    erasingIdentity?: string,
  ) {
    return this.serial(signal, () =>
      this.inspectState(checkedId(id), signal, erasingIdentity),
    );
  }

  confirmAbsence(id: string, signal: AbortSignal) {
    return this.serial(
      signal,
      async () =>
        (await this.inspectState(checkedId(id), signal)).state === 'absent',
    );
  }

  listFormalDiskIds(signal: AbortSignal) {
    return this.serial(signal, async () => {
      const root = await this.roots();
      const ids = new Set(
        (await this.options.keys.listDiskIds(signal)).map(checkedId),
      );
      for (const directory of [...tiers, 'journal', 'mounts']) {
        for (const name of await readdir(join(root, directory))) {
          const id = directory === 'mounts' ? name : (name.split('.')[0] ?? '');
          ids.add(checkedId(id));
        }
      }
      return [...ids].sort();
    });
  }

  inspectMount(
    disk: PersonDisk,
    signal: AbortSignal,
    expected?: { image: PersonVmDiskIdentity; acrossTier?: true },
  ): ReturnType<NonNullable<PersonVmDiskPort['inspectMount']>> {
    return this.serial(signal, async () => {
      try {
        const state = await this.state(disk.vmId, signal);
        if (
          !state.file ||
          state.record?.phase !== 'ready' ||
          (state.file.tier !== disk.tier && !expected?.acrossTier) ||
          (expected && !exactImage(expected.image, state.file.identity))
        )
          return { state: 'unknown' };
        if (state.observed.mount) {
          await this.verifyXfs(state, signal);
          return {
            state: 'attached',
            mount: state.layout.mount,
            image: state.file.identity,
          };
        }
        return detached(state.observed)
          ? { state: 'absent', image: state.file.identity }
          : { state: 'unknown' };
      } catch (error) {
        if (signal.aborted) throw error;
        return { state: 'unknown' };
      }
    });
  }

  private async ensureLayout(disk: PersonDisk, signal: AbortSignal) {
    requireDisk(tiers.includes(disk.tier), 'PROVIDER_FAILED');
    const state = await this.state(disk.vmId, signal);
    requireDisk(!state.file || state.file.tier === disk.tier, 'LEASE_LOST');
    return state;
  }

  private async openMapper(
    disk: PersonDisk,
    state: DiskState,
    signal: AbortSignal,
    create: boolean,
  ) {
    requireDisk(state.file && state.record && detached(state.observed));
    const attached = (
      await this.execute(
        'loop',
        ['--find', '--show', '--nooverlap', '--', state.file.path],
        signal,
      )
    ).trim();
    const observed = (await this.ensureLayout(disk, signal)).observed;
    const loop = observed.loop;
    requireDisk(
      loop && loop.path === attached && !observed.mapper && !observed.mount,
    );
    await this.withKey(disk.vmId, create, async (key) => {
      if (create)
        await this.execute(
          'crypt',
          [
            'luksFormat',
            '--type',
            'luks2',
            '--batch-mode',
            '--uuid',
            state.record!.luksUuid,
            '--key-file',
            '-',
            loop.path,
          ],
          signal,
          key,
        );
      await this.execute(
        'crypt',
        [
          'open',
          '--type',
          'luks2',
          '--key-file',
          '-',
          loop.path,
          state.layout.name,
        ],
        signal,
        key,
      );
    });
    const opened = await this.ensureLayout(disk, signal);
    requireDisk(
      opened.observed.mapper && opened.observed.loop?.path === loop.path,
    );
    return opened;
  }

  private async closeOwned(disk: PersonDisk, signal: AbortSignal) {
    this.generations.delete(disk.vmId);
    let state = await this.ensureLayout(disk, signal);
    if (state.observed.mount) {
      await this.execute('umount', ['--', state.layout.mount], signal);
      state = await this.ensureLayout(disk, signal);
      requireDisk(!state.observed.mount);
    }
    if (state.observed.mapper) {
      requireDisk(state.observed.mapper.openCount === 0);
      await this.execute('crypt', ['close', state.layout.name], signal);
      state = await this.ensureLayout(disk, signal);
      requireDisk(!state.observed.mount && !state.observed.mapper);
    }
    if (state.observed.loop) {
      await this.execute(
        'loop',
        ['--detach', state.observed.loop.path],
        signal,
      );
      state = await this.ensureLayout(disk, signal);
    }
    requireDisk(detached(state.observed));
    return state;
  }

  create(disk: PersonDisk, signal: AbortSignal) {
    return this.serial(signal, async () => {
      const prior = await this.ensureLayout(disk, signal);
      if (prior.record?.phase === 'ready') {
        await this.verifyHeader(prior, signal);
        return;
      }
      requireDisk(
        !prior.record &&
          !prior.file &&
          detached(prior.observed) &&
          (await this.options.keys.confirmAbsence(disk.vmId)),
      );
      const path = prior.layout.images[disk.tier];
      const file = await open(
        path,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        Number(regularFile),
      );
      let record: DiskRecord;
      try {
        await file.truncate(this.bytes);
        await file.sync();
        const info = await file.stat({ bigint: true });
        record = {
          version: 1,
          phase: 'formatting',
          vmId: disk.vmId,
          capacityBytes: this.bytes,
          image: { device: String(info.dev), inode: String(info.ino) },
          luksUuid: randomUUID(),
          xfsUuid: randomUUID(),
        };
      } finally {
        await file.close();
      }
      await syncDiskPoolDirectory(dirname(path));
      await this.writeRecord(prior.layout.journal, record);
      try {
        const opened = await this.openMapper(
          disk,
          await this.ensureLayout(disk, signal),
          signal,
          true,
        );
        requireDisk(opened.observed.mapper);
        await this.execute(
          'xfs',
          [
            '-m',
            'reflink=1,uuid=' + record.xfsUuid,
            opened.observed.mapper.path,
          ],
          signal,
        );
        await this.verifyXfs(opened, signal);
        await this.verifyHeader(opened, signal);
        await this.closeOwned(disk, signal);
        signal.throwIfAborted();
        await this.writeRecord(prior.layout.journal, {
          ...record,
          phase: 'ready',
        });
        return record.image;
      } catch {
        const cleanup = AbortSignal.timeout(30_000);
        const current = await this.closeOwned(disk, cleanup);
        requireDisk(
          current.record?.phase === 'formatting' &&
            current.file &&
            exactImage(record.image, current.file.identity),
        );
        await this.removeFileAndKey(current, cleanup);
        return unavailable();
      }
    });
  }

  private async workDirectory(state: DiskState) {
    requireDisk(state.observed.mount);
    const root = await lstat(state.layout.mount, { bigint: true });
    const child = join(state.layout.mount, 'work');
    const info = await lstat(child, { bigint: true });
    requireDisk(
      info.isDirectory() &&
        !info.isSymbolicLink() &&
        info.dev === root.dev &&
        root.isDirectory() &&
        root.uid === this.uid &&
        info.uid === this.uid &&
        (info.mode & 0o777n) === ownedDirectory,
    );
    return child;
  }

  attach(disk: PersonDisk, signal: AbortSignal, beforeDispatch?: () => void) {
    return this.serial(signal, async () => {
      const state = await this.ensureLayout(disk, signal);
      requireDisk(state.record?.phase === 'ready');
      await this.verifyHeader(state, signal);
      if (state.observed.mount) {
        await this.verifyXfs(state, signal);
        await this.workDirectory(state);
        return state.layout.mount;
      }
      requireDisk(detached(state.observed));
      await mkdir(state.layout.mount, { mode: Number(ownedDirectory) }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
      await this.privateDirectory(state.layout.mount);
      requireDisk((await readdir(state.layout.mount)).length === 0);
      signal.throwIfAborted();
      beforeDispatch?.();
      this.generations.delete(disk.vmId);
      try {
        const opened = await this.openMapper(disk, state, signal, false);
        requireDisk(opened.observed.mapper);
        await this.verifyXfs(opened, signal);
        await this.execute(
          'mount',
          [
            '-t',
            'xfs',
            '-o',
            'nodev,nosuid',
            '--',
            opened.observed.mapper.path,
            state.layout.mount,
          ],
          signal,
        );
        const mounted = await this.ensureLayout(disk, signal);
        requireDisk(
          mounted.observed.mount &&
            mounted.observed.mapper?.device === opened.observed.mapper.device,
        );
        const work = join(state.layout.mount, 'work');
        await mkdir(work, { mode: Number(ownedDirectory) }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          },
        );
        await this.workDirectory(mounted);
        signal.throwIfAborted();
        return state.layout.mount;
      } catch {
        await this.closeOwned(disk, AbortSignal.timeout(30_000));
        return unavailable();
      }
    });
  }

  verifyAttachedMount(disk: PersonDisk, signal: AbortSignal) {
    return this.serial(signal, async () => {
      const state = await this.ensureLayout(disk, signal);
      if (detached(state.observed)) return null;
      requireDisk(state.record?.phase === 'ready' && state.observed.mount);
      await this.verifyXfs(state, signal);
      await this.workDirectory(state);
      return state.layout.mount;
    });
  }

  detach(
    disk: PersonDisk,
    signal: AbortSignal,
    onDetached?: (mount: string) => Promise<void>,
  ) {
    return this.serial(signal, async () => {
      const state = await this.closeOwned(disk, signal);
      signal.throwIfAborted();
      await onDetached?.(state.layout.mount);
    });
  }

  verifyDeletionDetached(disk: PersonDisk, signal: AbortSignal) {
    return this.serial(
      signal,
      async () => (await this.assertDetached(disk, signal)).layout.mount,
    );
  }

  private async assertDetached(disk: PersonDisk, signal: AbortSignal) {
    const state = await this.ensureLayout(disk, signal);
    requireDisk(detached(state.observed));
    return state;
  }

  move(disk: PersonDisk, tier: PersonDisk['tier'], signal: AbortSignal) {
    return this.serial(signal, async () => {
      requireDisk(tiers.includes(tier), 'PROVIDER_FAILED');
      const state = await this.state(disk.vmId, signal);
      requireDisk(
        state.file &&
          state.record?.phase === 'ready' &&
          detached(state.observed),
      );
      await this.verifyHeader(state, signal);
      if (state.file.tier !== tier) {
        signal.throwIfAborted();
        await rename(state.file.path, state.layout.images[tier]);
        for (const path of Object.values(state.layout.images))
          await syncDiskPoolDirectory(dirname(path));
      }
      return { vmId: disk.vmId, tier };
    });
  }

  private async removeFileAndKey(state: DiskState, signal: AbortSignal) {
    requireDisk(state.record && detached(state.observed));
    const disk = {
      vmId: state.record.vmId,
      tier: state.file?.tier ?? 'cold',
    } as const;
    if (state.file) {
      const current = await this.assertDetached(disk, signal);
      requireDisk(
        current.file &&
          exactImage(current.file.identity, state.file.identity) &&
          current.record?.phase === state.record.phase &&
          deletionIdentity(current.record) === deletionIdentity(state.record),
      );
      signal.throwIfAborted();
      await unlink(current.file.path);
      await syncDiskPoolDirectory(dirname(current.file.path));
    }
    const gone = await this.assertDetached(disk, signal);
    requireDisk(
      !gone.file &&
        gone.record &&
        deletionIdentity(gone.record) === deletionIdentity(state.record),
    );
    signal.throwIfAborted();
    await this.options.keys.delete(disk.vmId);
    requireDisk(await this.options.keys.confirmAbsence(disk.vmId));
    await unlink(state.layout.journal);
    await syncDiskPoolDirectory(dirname(state.layout.journal));
  }

  delete(...[disk, signal, erase]: Parameters<PersonVmDiskPort['delete']>) {
    return this.serial(signal, async () => {
      this.generations.delete(disk.vmId);
      let state = await this.assertDetached(disk, signal);
      if (!state.record) {
        requireDisk(
          !state.file && (await this.options.keys.confirmAbsence(disk.vmId)),
        );
        return;
      }
      const identity = deletionIdentity(state.record);
      requireDisk(
        state.record.phase === 'ready' || state.record.phase === 'erasing',
        'LEASE_LOST',
      );
      if (erase) {
        requireDisk(erase.identitySha256 === identity, 'LEASE_LOST');
        await erase.beforeErase(state.layout.mount);
      }
      const after = await this.assertDetached(disk, signal);
      requireDisk(
        after.record &&
          deletionIdentity(after.record) === identity &&
          after.record.phase === state.record.phase,
        'LEASE_LOST',
      );
      state = after;
      await optional(() => rmdir(state.layout.mount));
      if (state.file) {
        await this.verifyHeader(state, signal);
        if (after.record.phase !== 'erasing') {
          await this.writeRecord(state.layout.journal, {
            ...after.record,
            phase: 'erasing',
          });
          state = await this.assertDetached(disk, signal);
          requireDisk(
            state.file &&
              state.record?.phase === 'erasing' &&
              deletionIdentity(state.record) === identity,
            'LEASE_LOST',
          );
        }
        await this.execute(
          'crypt',
          ['luksErase', '--batch-mode', state.file.path],
          signal,
        );
        const metadata = z
          .object({ keyslots: z.record(z.string(), z.unknown()) })
          .parse(
            JSON.parse(
              await this.execute(
                'crypt',
                ['luksDump', '--dump-json-metadata', state.file.path],
                signal,
              ),
            ),
          );
        requireDisk(Object.keys(metadata.keyslots).length === 0);
      } else requireDisk(after.record.phase === 'erasing');
      await this.removeFileAndKey(state, signal);
    });
  }

  issueOwnedWorkDisk(
    disk: PersonDisk,
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<OwnedWorkDiskReceipt> {
    return this.scopedReceipt(disk, binding, signal, async (state, current) => {
      const workDirectory = await this.workDirectory(state);
      signal.throwIfAborted();
      const observation = state.observed.mount!;
      const receipt = Object.freeze({
        binding: current,
        image: Object.freeze({ ...state.file!.identity }),
        mountId: [
          observation.namespace,
          observation.id,
          state.record!.luksUuid,
          state.record!.xfsUuid,
        ].join(':'),
        workDirectory,
      });
      let generation = this.generations.get(current.vmId);
      if (!generation) this.generations.set(current.vmId, (generation = {}));
      this.issued.set(receipt, generation);
      return receipt;
    });
  }

  verifyOwnedWorkDisk(
    receipt: OwnedWorkDiskReceipt,
    disk: PersonDisk,
    binding: PersonVmBinding,
    signal: AbortSignal,
  ) {
    return this.scopedReceipt(disk, binding, signal, async (state, current) => {
      const generation = this.generations.get(current.vmId);
      requireDisk(
        generation &&
          this.issued.get(receipt) === generation &&
          sameBinding(receipt.binding, current),
        'LEASE_LOST',
      );
      const observation = state.observed.mount!;
      requireDisk(
        receipt.mountId ===
          [
            observation.namespace,
            observation.id,
            state.record!.luksUuid,
            state.record!.xfsUuid,
          ].join(':') &&
          exactImage(receipt.image, state.file!.identity) &&
          receipt.workDirectory === (await this.workDirectory(state)),
        'LEASE_LOST',
      );
      signal.throwIfAborted();
    });
  }

  private scopedReceipt<T>(
    disk: PersonDisk,
    binding: PersonVmBinding,
    signal: AbortSignal,
    use: (state: DiskState, binding: PersonVmBinding) => Promise<T>,
  ) {
    const current = Object.freeze({ ...binding });
    const requested = Object.freeze({ ...disk });
    return this.serial(signal, async () => {
      requireDisk(
        checkedId(current.vmId) === requested.vmId &&
          current.organizationId &&
          current.personId &&
          current.instanceId &&
          Number.isSafeInteger(current.leaseEpoch) &&
          current.leaseEpoch > 0,
        'LEASE_LOST',
      );
      return this.options.withCurrentDisk(
        current,
        requested,
        signal,
        async () => {
          const state = await this.ensureLayout(requested, signal);
          requireDisk(
            state.record?.phase === 'ready' &&
              state.file &&
              state.observed.mount,
          );
          await this.verifyHeader(state, signal);
          await this.verifyXfs(state, signal);
          signal.throwIfAborted();
          return use(state, current);
        },
      );
    });
  }
}
