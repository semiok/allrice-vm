import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type * as Filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PublicImageCacheBudgetExceeded,
  seedPublicImageCache,
  verifySeededPublicImageCache,
} from './image-cache.ts';
import { MicrosandboxPersonVm } from './microsandbox.ts';
import { DiskPoolLedger } from './disk-pool-ledger.ts';
import { DiskPoolForegroundDeferred } from './disk-pool-platform.ts';
import { MacosPersonVmDiskPool } from './disk-pool-macos.ts';
import { ApfsPersonVmDisk, FilePersonVmKeyStore } from './encrypted-disk.ts';
import type { CommandRunner } from './process.ts';

const faults = vi.hoisted(() => ({
  cacheWrite: undefined as Error | undefined,
  secondCopy: undefined as Error | undefined,
  beforeLink: undefined as ((from: string, to: string) => void) | undefined,
  removeCopyStage: undefined as (() => void) | undefined,
  afterRename: undefined as ((from: string, to: string) => void) | undefined,
}));

vi.mock('node:fs/promises', async (original) => {
  const filesystem = await original<typeof Filesystem>();
  return {
    ...filesystem,
    writeFile: vi.fn(
      async (...args: Parameters<typeof filesystem.writeFile>) => {
        if (
          faults.secondCopy &&
          /\/\.public-oci-[A-Za-z0-9]{6}\/\d+$/.test(String(args[0]))
        )
          throw faults.secondCopy;
        return filesystem.writeFile(...args);
      },
    ),
    async link(from: string, to: string) {
      faults.beforeLink?.(from, to);
      await filesystem.link(from, to);
    },
    async rm(...args: Parameters<typeof filesystem.rm>) {
      if (/\/\.public-oci-[A-Za-z0-9]{6}$/.test(String(args[0])))
        faults.removeCopyStage?.();
      await filesystem.rm(...args);
    },
    async open(...args: Parameters<typeof filesystem.open>) {
      const file = await filesystem.open(...args);
      if (
        faults.cacheWrite &&
        args[1] === 'wx' &&
        String(args[0]).includes('/.public-oci-')
      )
        vi.spyOn(file, 'writeFile').mockRejectedValueOnce(faults.cacheWrite);
      return file;
    },
    async rename(from: string, to: string) {
      await filesystem.rename(from, to);
      faults.afterRename?.(from, to);
    },
  };
});

const roots: string[] = [];
const hash = (contents: Buffer | string) =>
  createHash('sha256').update(contents).digest('hex');
const digest = (contents: Buffer | string) => 'sha256:' + hash(contents);
const blob = 'synthetic flat rootfs';
const blobPath = 'flat/blobs/' + digest(blob).replace(':', '_') + '.raw';
const layer = 'synthetic public EROFS layer';
const diffId = digest('original OCI tar layer');
const layerPath = 'layers/' + diffId.replace(':', '_') + '.erofs';

async function removeFixture(path: string) {
  if (!(await lstat(path)).isDirectory()) return;
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await removeFixture(join(path, name));
}

afterEach(async () => {
  faults.cacheWrite = undefined;
  faults.secondCopy = undefined;
  faults.beforeLink = undefined;
  faults.removeCopyStage = undefined;
  faults.afterRename = undefined;
  for (const path of roots.splice(0)) {
    await removeFixture(path);
    await rm(path, { recursive: true, force: true });
  }
});

async function fixture(
  opts: {
    extra?: string;
    nativeEnv?: string[];
    abi?: number;
    corruptDerivation?: boolean;
    metadataSpacing?: number;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pc-')));
  roots.push(root);
  const rawConfig = JSON.stringify({
    os: 'linux',
    architecture: 'arm64',
    rootfs: { type: 'layers', diff_ids: [diffId] },
    config: { Env: ['NODE_VERSION=22.23.2'], Cmd: ['node'] },
  });
  const config = {
    digest: digest(rawConfig),
    size: Buffer.byteLength(rawConfig),
    mediaType: 'application/vnd.oci.image.config.v1+json',
  };
  const descriptor = {
    digest: digest('OCI tar.gz'),
    size: 600,
    mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
  };
  const oci = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config,
    layers: [descriptor],
  };
  const ociManifest = JSON.stringify(oci, null, 2);
  const imageDigest = digest(ociManifest);
  const image = 'docker.io/library/node@' + imageDigest;
  const metadataPath = 'manifests/' + hash(image) + '.json';
  const entries = {
    [metadataPath]: JSON.stringify(
      {
        manifest_digest: imageDigest,
        config_digest: config.digest,
        raw_manifest_json: JSON.stringify(oci),
        raw_config_json: rawConfig,
        config: {
          env: opts.nativeEnv ?? ['NODE_VERSION=22.23.2'],
          cmd: ['node'],
          entrypoint: null,
          working_dir: null,
          user: null,
          exposed_ports: [],
          volumes: [],
          labels: {},
          stop_signal: null,
        },
        layers: [
          {
            digest: descriptor.digest,
            media_type: descriptor.mediaType,
            size_bytes: descriptor.size,
            diff_id: diffId,
          },
        ],
      },
      null,
      opts.metadataSpacing,
    ),
    ['flat/refs/' + imageDigest.replace(':', '_') + '.json']: JSON.stringify({
      schema: 1,
      manifest_digest: imageDigest,
      derivation_digest: digest(
        opts.corruptDerivation
          ? 'wrong derivation'
          : Buffer.concat([
              Buffer.from('microsandbox.flat-rootfs\0'),
              Buffer.from([2, 0, 0, 0]),
              Buffer.from(`\0linux/arm64\0${imageDigest}\0${diffId}`),
            ]),
      ),
      materializer_abi: opts.abi ?? 2,
      artifact_digest: digest(blob),
      virtual_size_bytes: Buffer.byteLength(blob),
    }),
    [layerPath]: layer,
    [blobPath]: blob,
    ...(opts.extra ? { [opts.extra]: 'not public OCI payload' } : {}),
  };
  const manifest = JSON.stringify({
    version: 1,
    microsandbox: '0.7.16',
    image,
    platform: 'linux/arm64',
    materialization: 'flat',
    ociManifest,
    files: Object.entries(entries).map(([path, contents]) => ({
      path,
      bytes: Buffer.byteLength(contents),
      sha256: hash(contents),
    })),
  });
  const manifestSha256 = hash(manifest);
  const directory = join(root, 'published', manifestSha256);
  const files: Record<string, string> = {
    ...entries,
    'manifest.json': manifest,
  };
  await mkdir(directory, { recursive: true });
  const directories = new Set([directory]);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    for (
      let parent = dirname(target);
      parent !== directory;
      parent = dirname(parent)
    )
      directories.add(parent);
    await writeFile(target, contents, { mode: 0o444 });
  }
  for (const path of directories) await chmod(path, 0o555);
  const source = { directory, manifestSha256 };
  const person = async (name: string) => {
    const mount = join(root, name);
    const native = join(mount, 'microsandbox');
    await mkdir(mount, { mode: 0o700 });
    await mkdir(native, { mode: 0o700 });
    return { mount, native, cache: join(native, 'cache') };
  };
  return { root, image, source, person, files, metadataPath };
}
const active = () => new AbortController().signal;

describe('sealed public OCI cache', () => {
  it('seeds two private VM caches concurrently without sharing writable inodes or private state', async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.person('a'), f.person('b')]);
    await mkdir(join(a.native, 'secrets'), { mode: 0o700 });
    await writeFile(join(a.native, 'secrets', 'private'), 'synthetic secret');
    await Promise.all(
      [a, b].map((person) =>
        seedPublicImageCache(f.source, f.image, person.native, active()),
      ),
    );
    const copies = [a.cache, b.cache, f.source.directory].map((path) =>
      join(path, blobPath),
    );
    expect(
      new Set(
        await Promise.all(copies.map(async (path) => (await lstat(path)).ino)),
      ).size,
    ).toBe(3);
    expect(await readFile(copies[0]!, 'utf8')).toBe(blob);
    await writeFile(copies[0]!, 'synthetic local replacement');
    expect(await readFile(copies[1]!, 'utf8')).toBe(blob);
    expect(await readFile(copies[2]!, 'utf8')).toBe(blob);
    expect(await readdir(a.native)).toEqual(['cache', 'secrets']);
    expect(await readdir(b.native)).toEqual(['cache']);
    expect((await readdir(f.source.directory)).sort()).toEqual([
      'flat',
      'layers',
      'manifest.json',
      'manifests',
    ]);
  });

  it('verifies a warm disk locally against the seal and detects changed private bytes', async () => {
    const f = await fixture();
    const a = await f.person('a');
    await seedPublicImageCache(f.source, f.image, a.native, active());
    const sealedBlob = join(f.source.directory, blobPath);
    await chmod(sealedBlob, 0o600);
    await writeFile(
      sealedBlob,
      'changed while source remains sealed by its manifest',
    );
    await chmod(sealedBlob, 0o444);
    await expect(
      verifySeededPublicImageCache(f.source, f.image, a.native, active()),
    ).resolves.toBeUndefined();
    const diskBlob = join(a.cache, blobPath);
    await writeFile(diskBlob, 'private cache corruption');
    await expect(
      verifySeededPublicImageCache(f.source, f.image, a.native, active()),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });

  it.each([
    { extra: 'secrets/local' },
    { extra: 'manifests/other.lock' },
    { nativeEnv: ['UNAPPROVED=runtime'] },
    { abi: 99 },
    { corruptDerivation: true },
  ])(
    'rejects a sealed generation with unsupported content %j',
    async (opts) => {
      const f = await fixture(opts);
      const a = await f.person('a');
      await expect(
        seedPublicImageCache(f.source, f.image, a.native, active()),
      ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
      expect(await readdir(a.native)).toEqual([]);
    },
  );

  it('rejects a foreign image and an unsealed path', async () => {
    const f = await fixture();
    const a = await f.person('a');
    for (const [source, image] of [
      [f.source, f.image.replace('docker.io/library', 'example.test/private')],
      [f.source, f.image.slice(0, -1) + (f.image.endsWith('0') ? '1' : '0')],
      [{ ...f.source, manifestSha256: hash('unapproved') }, f.image],
    ] as const) {
      await expect(
        seedPublicImageCache(source, image, a.native, active()),
      ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    }
    expect(await readdir(a.native)).toEqual([]);
  });

  it.each(['checksum', 'symlink', 'writable'] as const)(
    'rejects %s corruption without leaving staging or changing private files',
    async (fault) => {
      const f = await fixture();
      const a = await f.person('a');
      const path = join(f.source.directory, layerPath);
      if (fault === 'symlink') {
        await chmod(dirname(path), 0o700);
        await rm(path);
        const substitute = join(f.root, 'substitute');
        await writeFile(substitute, layer, { mode: 0o444 });
        await symlink(substitute, path);
        await chmod(dirname(path), 0o555);
      } else {
        await chmod(path, 0o600);
        if (fault === 'checksum') {
          await writeFile(path, layer.replace('public', 'forged'));
          await chmod(path, 0o444);
        }
      }
      await expect(
        seedPublicImageCache(f.source, f.image, a.native, active()),
      ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
      expect(await readdir(a.native)).toEqual([]);
    },
  );

  it('reuses exact private files and refuses a conflict without overwriting it', async () => {
    const f = await fixture();
    const a = await f.person('a');
    const seed = () =>
      seedPublicImageCache(f.source, f.image, a.native, active());
    await seed();
    const existing = join(a.cache, blobPath);
    const inode = (await lstat(existing)).ino;
    await seed();
    expect((await lstat(existing)).ino).toBe(inode);
    await writeFile(existing, 'unexpected cache contents');
    await expect(seed()).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(await readFile(existing, 'utf8')).toBe('unexpected cache contents');
    expect(await readdir(a.native)).toEqual(['cache']);
  });

  it('retries after interruption between linking a private cache file and cleaning its stage', async () => {
    const f = await fixture();
    const a = await f.person('a');
    const stage = await mkdtemp(join(a.native, '.public-oci-'));
    const staged = join(stage, '0');
    const linked = join(a.cache, layerPath);
    await mkdir(dirname(linked), { recursive: true, mode: 0o700 });
    await writeFile(staged, layer, { mode: 0o600 });
    await link(staged, linked);
    const { ino: inode, nlink } = await lstat(linked);
    expect(nlink).toBe(2);
    const stagedWrites = vi.mocked(writeFile);
    stagedWrites.mockClear();

    await seedPublicImageCache(f.source, f.image, a.native, active());

    // The cache has four entries. Reuse the installed layer without allocating
    // a second copy, so retry needs only the space for the other three.
    expect(stagedWrites).toHaveBeenCalledTimes(3);
    expect(await lstat(linked)).toMatchObject({ ino: inode, nlink: 1 });
    await expect(lstat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(a.cache, blobPath), 'utf8')).toBe(blob);
  });

  it('refuses unexpected data in the staging namespace without deleting it', async () => {
    const f = await fixture();
    const a = await f.person('a');
    const stage = await mkdtemp(join(a.native, '.public-oci-'));
    const unrelated = join(stage, 'unexpected');
    await writeFile(unrelated, 'retain me');
    await expect(
      seedPublicImageCache(f.source, f.image, a.native, active()),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(await readFile(unrelated, 'utf8')).toBe('retain me');
    expect(await readdir(a.native)).toEqual([stage.split('/').at(-1)]);
  });

  it('does not replace a private destination symlink or consume a source in the same mount', async () => {
    const f = await fixture();
    const a = await f.person('a');
    const path = join(a.cache, blobPath);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const original = join(f.source.directory, blobPath);
    await symlink(original, path);
    await expect(
      seedPublicImageCache(f.source, f.image, a.native, active()),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(original, 'utf8')).toBe(blob);

    const nested = join(a.mount, f.source.manifestSha256);
    await symlink(f.source.directory, nested);
    await expect(
      seedPublicImageCache(
        { ...f.source, directory: nested },
        f.image,
        a.native,
        active(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });

  it('preserves cancellation and does not leave private staging', async () => {
    const f = await fixture();
    const a = await f.person('a');
    const abort = new AbortController();
    const cancelled = new Error('owner stopped');
    abort.abort(cancelled);
    await expect(
      seedPublicImageCache(f.source, f.image, a.native, abort.signal),
    ).rejects.toBe(cancelled);
    expect(await readdir(a.native)).toEqual([]);
  });
});

it('stops a partially copied public cache at the next observable write and removes staging', async () => {
  const f = await fixture();
  const person = await f.person('a');
  const capacity = new PublicImageCacheBudgetExceeded({
    availableBytes: 90n,
    allocatedBytes: 200n,
  });
  let writes = 0;
  await expect(
    seedPublicImageCache(f.source, f.image, person.native, active(), {
      bytes: 4096n * 32n,
      blockBytes: 4096n,
      async beforeWrite(bytes) {
        if (bytes > 0n && ++writes === 2) throw capacity;
      },
    }),
  ).rejects.toBe(capacity);
  expect(writes).toBe(2);
  expect(await readdir(person.native)).toEqual([]);
});

describe('Microsandbox create with a sealed public OCI seed', () => {
  it.each(['seeded', 'warm', 'original', 'missing'] as const)(
    'keeps native paths private and preserves the %s create behavior',
    async (mode) => {
      const f = await fixture();
      const person = await f.person('a');
      const socketRoot = await mkdtemp('/tmp/a-');
      roots.push(socketRoot);
      const calls: string[][] = [];
      const seededPublicCache = vi.fn(async () => true);
      if (mode === 'warm')
        await seedPublicImageCache(f.source, f.image, person.native, active());
      const vm = new MicrosandboxPersonVm({
        binary: '/fixture/msb',
        agentd: '/fixture/agentd',
        libkrunfw: '/fixture/libkrunfw',
        image: f.image,
        rootDiskGiB: 8,
        socketRoot,
        ...(mode === 'original' ? {} : { publicImageCache: f.source }),
        ...(mode === 'warm' ? { seededPublicCache } : {}),
        runner: async ({ args }) => {
          calls.push([...args]);
          if (args[0] === '--version') return 'microsandbox 0.7.16';
          if (args[0] === 'list') return '[]';
          if (args[0] === 'create' && (mode === 'seeded' || mode === 'warm'))
            expect(await readFile(join(person.cache, blobPath), 'utf8')).toBe(
              blob,
            );
          return '';
        },
      });
      const binding = {
        vmId: randomUUID(),
        personId: randomUUID(),
        organizationId: randomUUID(),
        instanceId: randomUUID(),
        leaseEpoch: 1,
      };
      if (mode === 'missing') {
        await removeFixture(f.source.directory);
        await rm(f.source.directory, { recursive: true });
      }
      await vm.prepare(binding, person.mount, active());
      const config = JSON.parse(
        await readFile(join(person.mount, 'msb-config.json'), 'utf8'),
      );
      const alias = join(socketRoot, binding.vmId);
      expect(config.paths.cache).toBe(join(alias, 'cache'));
      expect(config.paths.secrets).toBe(join(alias, 'secrets'));
      expect(config.paths.sandboxes).toBe(join(person.native, 'sandboxes'));
      const receipt = { binding, bindingId: randomUUID(), gatewayPorts: [] };
      if (mode === 'missing') {
        await expect(
          vm.create(binding, receipt, active()),
        ).rejects.toMatchObject({
          code: 'PROVIDER_FAILED',
        });
        expect(calls.map(([command]) => command)).toEqual([
          '--version',
          'list',
        ]);
        // Retained disks keep their private configuration if the seed is removed.
        await vm.start(binding, active());
        expect(calls.map(([command]) => command)).toEqual([
          '--version',
          'list',
          'start',
        ]);
        return;
      }
      await vm.create(binding, receipt, active());
      expect(calls.map(([command]) => command)).toEqual(
        mode === 'seeded' || mode === 'warm'
          ? ['--version', 'list', 'create']
          : ['--version', 'list', 'pull', 'create'],
      );
      expect(calls.at(-1)).toEqual(
        expect.arrayContaining([
          '--pull',
          'never',
          '--net-default',
          'deny',
          '--root-disk',
          'flat:8G,clone=reflink',
        ]),
      );
      if (mode === 'warm')
        expect(seededPublicCache).toHaveBeenCalledWith(
          binding.vmId,
          expect.any(AbortSignal),
        );
    },
  );
});

it.each(['ENOSPC', 'EDQUOT'] as const)(
  'keeps actual owned %s write failure as a capacity error after staging settles',
  async (code) => {
    const f = await fixture();
    const person = await f.person('budget');
    const failure = Object.assign(new Error('synthetic owned disk write'), {
      code,
      syscall: 'write',
    });
    faults.cacheWrite = failure;
    await expect(
      seedPublicImageCache(f.source, f.image, person.native, active(), {
        bytes: 32n * 4096n,
        blockBytes: 4096n,
      }),
    ).rejects.toMatchObject({
      name: 'Error',
      message: 'PERSON_VM_PUBLIC_CACHE_BUDGET_EXCEEDED',
      cause: failure,
    });
    expect(await readdir(person.native)).toEqual([]);
  },
);

it('refreshes a verified older bound disk before first native create, resumes cutover, and retains all old state', async () => {
  const old = await fixture();
  const next = await fixture({ metadataSpacing: 2 });
  expect(old.image).toBe(next.image);
  expect(old.metadataPath).toBe(next.metadataPath);
  expect(old.files[old.metadataPath]).not.toBe(next.files[next.metadataPath]);
  const root = join(old.root, 'pool');
  const keyRoot = join(old.root, 'keys');
  const attachments = new Map<string, string>();
  const diskRunner: CommandRunner = async ({ args, executable, input }) => {
    if (executable.endsWith('/plutil')) return Buffer.from(input!).toString();
    if (args[0] === 'info')
      return JSON.stringify({
        images: [...attachments].map(([path, mount]) => ({
          'image-path': path,
          'system-entities': [{ 'mount-point': mount }],
        })),
      });
    if (args[0] === 'create')
      await writeFile(args.at(-1)!, 'synthetic encrypted disk payload');
    if (args[0] === 'attach')
      attachments.set(args[1]!, args[args.indexOf('-mountpoint') + 1]!);
    return '';
  };
  const keys = new FilePersonVmKeyStore(keyRoot);
  const disk = new ApfsPersonVmDisk({
    root,
    keys,
    capacityGiB: 8,
    runner: diskRunner,
  });
  const adapter = (seed: typeof old) =>
    new MacosPersonVmDiskPool({
      root,
      keyRoot,
      capacityGiB: 8,
      keys,
      disk,
      runner: diskRunner,
      image: seed.image,
      imageCache: seed.source,
    });
  const older = adapter(old),
    current = adapter(next);
  const binding = {
    vmId: randomUUID(),
    personId: randomUUID(),
    organizationId: randomUUID(),
    instanceId: randomUUID(),
    leaseEpoch: 1,
  };
  const { vmId, personId, organizationId } = binding;
  const ref = randomUUID();
  const oldStock = { ref, source: older.source };
  await older.readCapacity([], active());
  await expect(older.assertSourceFitsReserve(1n, active())).rejects.toThrow(
    'PERSON_VM_DISK_POOL_BUDGET_EXCEEDED',
  );
  expect(await readdir(join(root, '.preprovision-images', 'warm'))).toEqual([]);
  await older.createEncryptedDisk(ref, active());
  const proof = await older.inspectStock(oldStock, active());
  const claim = {
    ...oldStock,
    proof,
    intent: {
      id: randomUUID(),
      requestId: randomUUID(),
      owner: { vmId, personId, organizationId },
    },
  };
  const ledger = new DiskPoolLedger(root);
  const append = async (entry: Parameters<DiskPoolLedger['append']>[1]) => {
    await ledger.append(
      (await ledger.read(active())).slots[0]!,
      entry,
      active(),
    );
  };
  await append({ ...oldStock, state: 'filling' });
  await append({ ...oldStock, proof, state: 'ready' });
  await append({ ...claim, state: 'claiming' });
  await older.bindDisk(claim, active());
  await append({ ...claim, state: 'bound' });
  const mount = await disk.attach({ vmId, tier: 'warm' }, active());
  const nativeRoot = join(mount, 'microsandbox');
  await mkdir(nativeRoot, { mode: 0o700 });
  await seedPublicImageCache(old.source, old.image, nativeRoot, active());
  await mkdir(join(nativeRoot, 'secrets'), { mode: 0o700 });
  await writeFile(
    join(nativeRoot, 'secrets', 'private'),
    'retained native state',
  );
  await writeFile(
    join(nativeRoot, 'cache', 'unknown'),
    'retained unknown cache bytes',
  );
  const metadata = join(nativeRoot, 'cache', old.metadataPath);
  expect(await readFile(metadata, 'utf8')).toBe(old.files[old.metadataPath]);
  const socketRoot = await mkdtemp('/tmp/ar-');
  roots.push(socketRoot);
  const calls: string[][] = [];
  const native = new MicrosandboxPersonVm({
    binary: '/fixture/msb',
    libkrunfw: '/fixture/libkrunfw',
    agentd: '/fixture/agentd',
    image: next.image,
    publicImageCache: next.source,
    rootDiskGiB: 8,
    socketRoot,
    seededPublicCache: current.hasSeededPublicCache.bind(current),
    refreshBoundPublicCache: current.refreshBoundPublicCache.bind(current),
    runner: async ({ args }) => {
      calls.push([...args]);
      if (args[0] === '--version') return 'microsandbox 0.7.16';
      if (args[0] === 'list') return '[]';
      if (args[0] === 'create')
        expect(await readFile(metadata, 'utf8')).toBe(
          next.files[next.metadataPath],
        );
      return '';
    },
  });
  const receipt = { binding, bindingId: randomUUID(), gatewayPorts: [] };
  await native.prepare(binding, mount, active());
  await expect(
    current.refreshBoundPublicCache(
      { ...binding, organizationId: randomUUID() },
      mount,
      active(),
    ),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  vi.mocked(writeFile).mockRejectedValueOnce(
    Object.assign(new Error('synthetic staging disk full'), { code: 'ENOSPC' }),
  );
  await expect(native.create(binding, receipt, active())).rejects.toMatchObject(
    { code: 'PROVIDER_FAILED' },
  );
  expect(await readFile(metadata, 'utf8')).toBe(old.files[old.metadataPath]);
  expect(await readFile(join(nativeRoot, 'cache', 'unknown'), 'utf8')).toBe(
    'retained unknown cache bytes',
  );
  const beforePublication = Error(
    'synthetic cut after staged bytes and before journal link',
  );
  faults.beforeLink = (_from, to) => {
    if (to.endsWith('/intent.json')) throw beforePublication;
  };
  await expect(native.create(binding, receipt, active())).rejects.toBe(
    beforePublication,
  );
  faults.beforeLink = undefined;
  const transaction = (await readdir(nativeRoot)).find((name) =>
    /^\.public-oci-refresh-[a-f0-9]{64}$/.test(name),
  );
  expect(transaction).toBeDefined();
  const transactionRoot = join(nativeRoot, transaction!);
  expect(
    await readFile(join(transactionRoot, 'cache', next.metadataPath), 'utf8'),
  ).toBe(next.files[next.metadataPath]);
  expect(await readFile(metadata, 'utf8')).toBe(old.files[old.metadataPath]);
  // The disk can hold the previous cache plus exactly one new payload.
  faults.secondCopy = Object.assign(
    new Error('no room for another staged copy'),
    { code: 'ENOSPC' },
  );
  const interruption = Error('synthetic restart after cache archive');
  faults.afterRename = (_from, to) => {
    if (to.endsWith('/previous')) throw interruption;
  };
  await expect(native.create(binding, receipt, active())).rejects.toBe(
    interruption,
  );
  faults.afterRename = undefined;
  expect(calls.map(([command]) => command)).toEqual([
    '--version',
    'list',
    'list',
    'list',
  ]);
  await native.prepare(binding, mount, active());
  expect(await readFile(metadata, 'utf8')).toBe(next.files[next.metadataPath]);
  await expect(
    native.create(binding, receipt, active()),
  ).resolves.toBeUndefined();
  const preserved = join(transactionRoot, 'previous');
  expect(await readFile(join(preserved, 'unknown'), 'utf8')).toBe(
    'retained unknown cache bytes',
  );
  expect(await readFile(join(preserved, old.metadataPath), 'utf8')).toBe(
    old.files[old.metadataPath],
  );
  expect(await readFile(join(nativeRoot, 'secrets', 'private'), 'utf8')).toBe(
    'retained native state',
  );
  expect(calls.filter(([command]) => command === 'create')).toHaveLength(1);
  await writeFile(metadata, 'corruption of installed current seal');
  await expect(native.create(binding, receipt, active())).rejects.toMatchObject(
    { code: 'PROVIDER_FAILED' },
  );
  expect(calls.filter(([command]) => command === 'create')).toHaveLength(1);
});

it.each(['foreground', 'capacity'] as const)(
  'preserves the %s and cleanup errors across concurrent cancellation',
  async (kind) => {
    const f = await fixture();
    const person = await f.person('cleanup');
    const stop = new AbortController();
    const cleanup = Object.assign(new Error('synthetic stage cleanup failed'), {
      code: 'EIO',
    });
    const failure =
      kind === 'foreground'
        ? new DiskPoolForegroundDeferred()
        : new PublicImageCacheBudgetExceeded({
            availableBytes: 50n,
            allocatedBytes: 100n,
          });
    faults.removeCopyStage = () => {
      stop.abort(Error('synthetic caller cancellation during cleanup'));
      throw cleanup;
    };
    const copied = seedPublicImageCache(
      f.source,
      f.image,
      person.native,
      stop.signal,
      {
        bytes: 4096n * 32n,
        blockBytes: 4096n,
        async beforeWrite(bytes) {
          if (bytes > 0n) throw failure;
        },
      },
    );
    await expect(copied).rejects.toBeInstanceOf(failure.constructor);
    await expect(copied).rejects.toMatchObject({
      cause: { errors: [failure, cleanup] },
    });
  },
);

it('keeps the ordinary unbudgeted seed cancellation reason when copy cleanup also fails', async () => {
  const f = await fixture();
  const person = await f.person('ordinary-cold');
  const stop = new AbortController();
  const reason = Error('synthetic cold start cancelled');
  faults.removeCopyStage = () => {
    stop.abort(reason);
    throw Error('synthetic stage cleanup failed');
  };
  await expect(
    seedPublicImageCache(f.source, f.image, person.native, stop.signal),
  ).rejects.toBe(reason);
});
