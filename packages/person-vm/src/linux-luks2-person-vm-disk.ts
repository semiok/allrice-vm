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
  linuxDeviceNumber,
  linuxDiskKernel,
  linuxTools,
  observeLinuxDisk,
  requireDisk,
  type LinuxDiskKernel,
  type LinuxDiskObservation,
} from './linux-luks2-state.ts';
import { hostEnvironment, runCommand, type CommandRunner } from './process.ts';
import type { VmLease } from './store.ts';
import type { OwnedWorkDiskReceipt } from './template-snapshot-contract.ts';

const uuid = z.uuid();
const vmIdSchema = z.uuidv4().refine((id) => id.toLowerCase() === id);
const tiers = ['warm', 'cold'] as const;
const creationFields = {
  version: z.literal(1),
  vmId: vmIdSchema,
  tier: z.enum(tiers),
  capacityBytes: z.int().positive(),
  storageUuid: uuid,
  luksUuid: uuid,
  xfsUuid: uuid,
};
const recordSchema = z.discriminatedUnion('phase', [
  z.strictObject({ ...creationFields, phase: z.literal('allocating') }),
  z.strictObject({
    ...creationFields,
    phase: z.enum(['formatting', 'ready', 'erasing']),
    image: z.strictObject({
      inode: z.string().regex(/^\d+$/),
    }),
  }),
]);
type DiskRecord = z.infer<typeof recordSchema>;
type RegisteredDisk = Exclude<DiskRecord, { phase: 'allocating' }>;

const ownedDirectory = 0o700n;
const regularFile = 0o600n;

type DirectoryLayout = {
  mount: string;
  journal: string;
  images: Readonly<Record<PersonDisk['tier'], string>>;
  name: string;
  storageDevice: string;
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
  rootIdentity: Readonly<{ uuid: string; inode: string }>;
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

function deletionIdentity(record: RegisteredDisk) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        record.vmId,
        record.storageUuid,
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
  readonly #issued = new WeakMap<OwnedWorkDiskReceipt, object>();
  readonly #generations = new Map<string, object>();
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
    this.options = Object.freeze({
      ...options,
      rootIdentity: Object.freeze({ ...options.rootIdentity }),
    });
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

  private async roots(signal: AbortSignal, initialize = false) {
    const root = this.options.root;
    let storageDevice = '';
    for (let path = root; ; path = dirname(path)) {
      const info = await lstat(path, { bigint: true });
      requireDisk(
        info.isDirectory() &&
          !info.isSymbolicLink() &&
          (info.uid === 0n || info.uid === this.uid) &&
          (info.mode & 0o022n) === 0n,
      );
      if (path === root) {
        requireDisk(
          info.uid === this.uid &&
            (info.mode & 0o777n) === ownedDirectory &&
            String(info.ino) === this.options.rootIdentity.inode,
        );
        storageDevice = String(info.dev);
      }
      if (path === '/') break;
    }
    const outer = z
      .object({
        filesystems: z.tuple([
          z.object({
            'maj:min': z.string(),
          }),
        ]),
      })
      .parse(
        JSON.parse(
          await this.execute(
            'findmnt',
            ['--json', '--list', '--target', root, '--output', 'MAJ:MIN'],
            signal,
          ),
        ),
      ).filesystems[0];
    const liveDevice = linuxDeviceNumber(BigInt(storageDevice));
    requireDisk(outer['maj:min'] === liveDevice);
    const block = '/dev/block/' + liveDevice;
    requireDisk((await this.kernel.blockDevice(block)) === liveDevice);
    const fsUuid = (
      await this.execute(
        'blkid',
        ['-p', '-s', 'UUID', '-o', 'value', '--', block],
        signal,
      )
    ).trim();
    requireDisk(
      fsUuid === this.options.rootIdentity.uuid &&
        (await this.kernel.blockDevice(block)) === liveDevice,
    );
    const again = await lstat(root, { bigint: true });
    requireDisk(
      String(again.dev) === storageDevice &&
        String(again.ino) === this.options.rootIdentity.inode,
    );
    for (const name of [...tiers, 'journal', 'mounts']) {
      const path = join(root, name);
      if (initialize) {
        await mkdir(path, { mode: Number(ownedDirectory) }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          },
        );
      }
      if (await optional(() => lstat(path)))
        await this.privateDirectory(path, storageDevice);
    }
    return { root, storageDevice };
  }

  private async privateDirectory(path: string, storageDevice?: string) {
    const info = await lstat(path, { bigint: true });
    requireDisk(
      info.isDirectory() &&
        !info.isSymbolicLink() &&
        info.uid === this.uid &&
        (info.mode & 0o777n) === ownedDirectory &&
        (storageDevice === undefined || String(info.dev) === storageDevice),
    );
  }

  private async layout(
    id: string,
    signal: AbortSignal,
  ): Promise<DirectoryLayout> {
    const vmId = checkedId(id);
    const { root, storageDevice } = await this.roots(signal);
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
      storageDevice,
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
    storageDevice: string,
    capacity = this.bytes,
    allocating = false,
  ): Promise<PersonVmDiskIdentity | null> {
    const info = await optional(() => lstat(path, { bigint: true }));
    if (!info) return null;
    requireDisk(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.uid === this.uid &&
        info.nlink === 1n &&
        String(info.dev) === storageDevice &&
        (info.mode & 0o777n) === regularFile &&
        (allocating
          ? info.size <= BigInt(capacity)
          : info.size === BigInt(capacity)),
    );
    return { device: String(info.dev), inode: String(info.ino) };
  }

  private async state(id: string, signal: AbortSignal): Promise<DiskState> {
    signal.throwIfAborted();
    const layout = await this.layout(id, signal);
    const record = await this.readRecord(layout.journal);
    if (record)
      requireDisk(
        record.vmId === id &&
          record.storageUuid === this.options.rootIdentity.uuid,
      );
    const registered =
      record && record.phase !== 'allocating' ? record : undefined;
    let file: DiskState['file'];
    for (const tier of tiers) {
      const path = layout.images[tier];
      const identity = await this.imageAt(
        path,
        layout.storageDevice,
        record?.capacityBytes,
      );
      if (!identity) continue;
      requireDisk(
        !file && registered && identity.inode === registered.image.inode,
      );
      file = { path, identity, tier };
    }
    const staging = record && this.staging(layout, record);
    const staged =
      staging &&
      (await this.imageAt(
        staging,
        layout.storageDevice,
        record.capacityBytes,
        record.phase === 'allocating',
      ));
    if (staged) {
      requireDisk(
        !file &&
          record &&
          (record.phase === 'allocating' ||
            (record.phase === 'formatting' &&
              staged.inode === record.image.inode)),
      );
      if (registered)
        file = { path: staging!, identity: staged, tier: record.tier };
    }
    const observed = await observeLinuxDisk(
      {
        image: file,
        allImagePaths: [
          ...Object.values(layout.images),
          ...(staging ? [staging] : []),
        ],
        expectedIdentity: registered
          ? { device: layout.storageDevice, inode: registered.image.inode }
          : staged || undefined,
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
      if (target)
        await this.privateDirectory(layout.mount, layout.storageDevice);
    }
    if (!file) requireDisk(detached(observed));
    return { layout, record, file, observed };
  }

  // cryptsetup's LUKS2 metadata read normally auto-recovers a bad replica.
  // The metadata lock is already supplied by our exclusive disk owner.
  // Disable the CLI's locking for read probes to suppress that write-back.
  private async verifyHeader(state: DiskState, signal: AbortSignal) {
    requireDisk(state.file && state.record);
    await this.execute(
      'crypt',
      ['isLuks', '--type', 'luks2', '--disable-locks', state.file.path],
      signal,
    );
    requireDisk(
      (
        await this.execute(
          'crypt',
          ['luksUUID', '--disable-locks', state.file.path],
          signal,
        )
      ).trim() === state.record.luksUuid,
    );
  }

  private async verifyKey(state: DiskState, id: string, signal: AbortSignal) {
    requireDisk(state.file);
    const path = state.file.path;
    await this.withKey(id, false, (key) =>
      this.execute(
        'crypt',
        [
          'open',
          '--type',
          'luks2',
          '--test-passphrase',
          '--disable-locks',
          '--key-file',
          '-',
          path,
        ],
        signal,
        key,
      ),
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
        await this.verifyKey(state, id, signal);
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
      const { root } = await this.roots(signal);
      const ids = new Set(
        (await this.options.keys.listDiskIds(signal)).map(checkedId),
      );
      for (const directory of [...tiers, 'journal', 'mounts']) {
        for (const name of (await optional(() =>
          readdir(join(root, directory)),
        )) ?? []) {
          const id = directory === 'mounts' ? name : (name.split('.')[0] ?? '');
          if (
            directory === 'journal' &&
            name.startsWith(id + '.json.') &&
            uuid.safeParse(name.slice((id + '.json.').length)).success
          )
            continue;
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
    this.#generations.delete(disk.vmId);
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

  private staging(layout: DirectoryLayout, record: DiskRecord) {
    return layout.journal + '.' + record.luksUuid + '.alloc';
  }

  /** Call inside Linux provisioning's existing lease, before its read-only
   * inspect. Reclaim only an unpublished allocation of this exact row. */
  recoverIncompleteCreation(
    lease: Pick<VmLease, 'row' | 'signal' | 'guard'>,
    signal: AbortSignal,
  ) {
    const owned = AbortSignal.any([signal, lease.signal]);
    return this.serial(owned, async () => {
      const row = lease.row;
      if (!row) return false;
      const {
        vmId,
        personId,
        organizationId,
        leaseEpoch,
        diskTier: tier,
      } = row;
      const owner = { vmId, personId, organizationId };
      const assertUnpublished = () => {
        const current = lease.row;
        requireDisk(
          current &&
            current.vmId === vmId &&
            current.personId === personId &&
            current.organizationId === organizationId &&
            current.leaseEpoch === leaseEpoch &&
            current.diskTier === tier &&
            current.diskRetained &&
            (current.phase === 'starting' || current.phase === 'failed') &&
            current.instanceId === null &&
            !current.nativeCreated &&
            !current.egressReceipt &&
            !current.gatewayPorts.length &&
            !current.holds.length,
          'LEASE_LOST',
        );
      };
      assertUnpublished();
      await lease.guard(owner);
      owned.throwIfAborted();
      assertUnpublished();
      const recovered = await this.recoverAllocation({ vmId, tier }, owned);
      await lease.guard(owner);
      assertUnpublished();
      owned.throwIfAborted();
      return recovered;
    });
  }

  private async recoverAllocation(
    disk: PersonDisk,
    signal: AbortSignal,
    expectedLuksUuid?: string,
  ) {
    const state = await this.ensureLayout(disk, signal);
    if (expectedLuksUuid !== undefined)
      requireDisk(state.record?.luksUuid === expectedLuksUuid, 'LEASE_LOST');
    if (state.record?.phase === 'allocating') {
      requireDisk(
        state.record.tier === disk.tier &&
          !state.file &&
          detached(state.observed),
      );
      const path = this.staging(state.layout, state.record);
      const staged = await this.imageAt(
        path,
        state.layout.storageDevice,
        state.record.capacityBytes,
        true,
      );
      requireDisk(await this.options.keys.confirmAbsence(disk.vmId));
      signal.throwIfAborted();
      if (staged) await unlink(path);
      await unlink(state.layout.journal);
      await syncDiskPoolDirectory(dirname(state.layout.journal));
      return true;
    }
    if (state.record?.phase !== 'formatting') return false;
    const closed = await this.closeOwned(disk, signal);
    requireDisk(closed.record?.phase === 'formatting');
    await this.removeFileAndKey(closed, signal);
    return true;
  }

  create(disk: PersonDisk, signal: AbortSignal) {
    return this.serial(signal, async () => {
      checkedId(disk.vmId);
      await this.roots(signal, true);
      const prior = await this.ensureLayout(disk, signal);
      if (prior.record?.phase === 'ready') {
        await this.verifyHeader(prior, signal);
        await this.verifyKey(prior, disk.vmId, signal);
        return;
      }
      requireDisk(
        !prior.record &&
          !prior.file &&
          detached(prior.observed) &&
          (await this.options.keys.confirmAbsence(disk.vmId)),
      );
      const reservation = {
        version: 1,
        phase: 'allocating',
        vmId: disk.vmId,
        tier: disk.tier,
        capacityBytes: this.bytes,
        storageUuid: this.options.rootIdentity.uuid,
        luksUuid: randomUUID(),
        xfsUuid: randomUUID(),
      } as const;
      // Persist the exact staging locator before any image bytes or key exist.
      signal.throwIfAborted();
      await this.writeRecord(prior.layout.journal, reservation);
      try {
        const staging = this.staging(prior.layout, reservation);
        const file = await open(
          staging,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          Number(regularFile),
        );
        let image: PersonVmDiskIdentity;
        try {
          await file.truncate(this.bytes);
          await file.sync();
          const info = await file.stat({ bigint: true });
          image = { device: String(info.dev), inode: String(info.ino) };
        } finally {
          await file.close();
        }
        await syncDiskPoolDirectory(dirname(staging));
        const record = {
          ...reservation,
          phase: 'formatting',
          image: { inode: image.inode },
        } as const;
        await this.writeRecord(prior.layout.journal, record);
        signal.throwIfAborted();
        const path = prior.layout.images[disk.tier];
        await rename(staging, path);
        await syncDiskPoolDirectory(dirname(staging));
        await syncDiskPoolDirectory(dirname(path));

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
        return image;
      } catch {
        await this.recoverAllocation(
          disk,
          AbortSignal.timeout(30_000),
          reservation.luksUuid,
        );
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

  private async ensureWorkDirectory(state: DiskState) {
    requireDisk(state.observed.mount);
    await mkdir(join(state.layout.mount, 'work'), {
      mode: Number(ownedDirectory),
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    return this.workDirectory(state);
  }

  attach(disk: PersonDisk, signal: AbortSignal, beforeDispatch?: () => void) {
    return this.serial(signal, async () => {
      let state = await this.ensureLayout(disk, signal);
      requireDisk(state.record?.phase === 'ready' && state.file);
      await this.verifyHeader(state, signal);
      if (state.observed.mount) {
        await this.verifyXfs(state, signal);
        await this.ensureWorkDirectory(state);
        signal.throwIfAborted();
        return state.layout.mount;
      }
      if (!detached(state.observed)) {
        // A prior attach may have been interrupted before mount dispatch.
        // The caller owns this disk under the physical lease. Only a fully
        // identified, unmounted and unheld mapping can be reconciled here.
        const identity = state.file.identity;
        state = await this.closeOwned(disk, signal);
        requireDisk(
          state.record?.phase === 'ready' &&
            state.file &&
            exactImage(state.file.identity, identity),
        );
      }
      await mkdir(state.layout.mount, { mode: Number(ownedDirectory) }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
      await this.privateDirectory(
        state.layout.mount,
        state.layout.storageDevice,
      );
      requireDisk((await readdir(state.layout.mount)).length === 0);
      signal.throwIfAborted();
      beforeDispatch?.();
      this.#generations.delete(disk.vmId);
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
        await this.ensureWorkDirectory(mounted);
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
    requireDisk(
      state.record &&
        state.record.phase !== 'allocating' &&
        detached(state.observed),
    );
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
        gone.record.phase !== 'allocating' &&
        deletionIdentity(gone.record) === deletionIdentity(state.record),
    );
    for (const path of Object.values(state.layout.images))
      await syncDiskPoolDirectory(dirname(path));
    await syncDiskPoolDirectory(dirname(state.layout.journal));
    signal.throwIfAborted();
    await this.options.keys.delete(disk.vmId);
    requireDisk(await this.options.keys.confirmAbsence(disk.vmId));
    await unlink(state.layout.journal);
    await syncDiskPoolDirectory(dirname(state.layout.journal));
  }

  delete(...[disk, signal, erase]: Parameters<PersonVmDiskPort['delete']>) {
    return this.serial(signal, async () => {
      this.#generations.delete(disk.vmId);
      let state = await this.assertDetached(disk, signal);
      if (!state.record) {
        requireDisk(
          !state.file && (await this.options.keys.confirmAbsence(disk.vmId)),
        );
        if (erase) {
          await erase.beforeErase(state.layout.mount);
          const empty = await this.assertDetached(disk, signal);
          requireDisk(
            !empty.record &&
              !empty.file &&
              (await this.options.keys.confirmAbsence(disk.vmId)),
          );
          await optional(() => rmdir(empty.layout.mount));
          await optional(() =>
            syncDiskPoolDirectory(dirname(empty.layout.mount)),
          );
        }
        return;
      }
      requireDisk(
        state.record.phase === 'ready' || state.record.phase === 'erasing',
        'LEASE_LOST',
      );
      const identity = deletionIdentity(state.record);
      // The platform delete flow installs a durable erasing checkpoint in
      // #59's lease and supplies this exact reviewed digest on every retry.
      requireDisk(erase && erase.identitySha256 === identity, 'LEASE_LOST');
      await erase.beforeErase(state.layout.mount);
      const after = await this.assertDetached(disk, signal);
      requireDisk(
        after.record &&
          after.record.phase !== 'allocating' &&
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
                [
                  'luksDump',
                  '--dump-json-metadata',
                  '--disable-locks',
                  state.file.path,
                ],
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
      let generation = this.#generations.get(current.vmId);
      if (!generation) this.#generations.set(current.vmId, (generation = {}));
      this.#issued.set(receipt, generation);
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
      const generation = this.#generations.get(current.vmId);
      requireDisk(
        generation &&
          this.#issued.get(receipt) === generation &&
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
