import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PersonVmError } from './contract.ts';
import { DiskPoolForegroundDeferred } from './disk-pool-platform.ts';
import {
  missing,
  publishDiskPoolRecord,
  syncDiskPoolDirectory,
} from './disk-pool-ledger.ts';

export type PublicImageCache = Readonly<{
  directory: string;
  manifestSha256: string;
}>;
export class PublicImageCacheBudgetExceeded extends Error {
  constructor(
    readonly capacity?: Readonly<{
      availableBytes: bigint;
      allocatedBytes: bigint;
    }>,
    options?: ErrorOptions,
  ) {
    super('PERSON_VM_PUBLIC_CACHE_BUDGET_EXCEEDED', options);
  }
}
export function isCapacityWriteError(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOSPC' || code === 'EDQUOT';
}
type WriteBudget = Readonly<{
  bytes: bigint;
  blockBytes: bigint;
  beforeWrite?(bytes: bigint): Promise<void>;
}>;
async function writeToCache<T>(write: () => Promise<T>) {
  try {
    return await write();
  } catch (error) {
    if (isCapacityWriteError(error))
      throw new PublicImageCacheBudgetExceeded(undefined, { cause: error });
    throw error;
  }
}

type CacheFile = { bytes: number; sha256: string };

const msbVersion = '0.7.16';
const flatAbi = 2;
const metadataLimit = 4 * 1024 * 1024;
const sourceDirectories = [
  'manifests',
  'layers',
  'flat',
  'flat/refs',
  'flat/blobs',
];
const readOnly =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function invalid(cause?: unknown): never {
  throw new PersonVmError('PROVIDER_FAILED', { cause });
}
function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex');
}
function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid();
  return value as Record<string, unknown>;
}
function parse(bytes: string | Buffer) {
  return object(JSON.parse(bytes.toString()));
}
function inside(path: string, root: string) {
  return path === root || path.startsWith(root + sep);
}

export function checkedPublicImageCache(
  input: PublicImageCache,
  image: string,
) {
  const { directory, manifestSha256 } = input;
  if (
    typeof directory !== 'string' ||
    !isAbsolute(directory) ||
    normalize(directory) !== directory ||
    directory.includes('\0') ||
    !isHash(manifestSha256) ||
    basename(directory) !== manifestSha256 ||
    !/^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/.test(image)
  )
    invalid();
  return Object.freeze({ directory, manifestSha256 });
}

async function verifyDirectory(path: string, mode: number) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o7777) !== mode ||
    stat.uid !== process.getuid?.() ||
    (await realpath(path)) !== path
  )
    invalid();
}

async function checkedFile(path: string, sealed: boolean) {
  const file = await open(path, readOnly);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      (sealed ? (stat.mode & 0o7777) !== 0o444 : (stat.mode & 0o7022) !== 0) ||
      !Number.isSafeInteger(stat.size) ||
      stat.size <= 0
    )
      invalid();
    return { file, stat };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function readMetadata(
  path: string,
  expected: { sha256: string; bytes?: number },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { file, stat } = await checkedFile(path, true);
  try {
    if (
      stat.size > metadataLimit ||
      (expected.bytes !== undefined && stat.size !== expected.bytes)
    )
      invalid();
    const bytes = await file.readFile({ signal });
    if (bytes.length !== stat.size || sha256(bytes) !== expected.sha256)
      invalid();
    return parse(bytes);
  } finally {
    await file.close();
  }
}

// v0.7.16 saves a normalized image config along with the original config
// JSON. Bind both since the native cache hit consumes the normalized fields.
function validateNativeConfig(native: unknown, raw: Record<string, unknown>) {
  const config = object(raw.config);
  if (
    !isDeepStrictEqual(native, {
      env: config.Env ?? [],
      cmd: config.Cmd ?? null,
      entrypoint: config.Entrypoint ?? null,
      working_dir: config.WorkingDir ?? null,
      user: config.User ?? null,
      exposed_ports: Object.keys(config.ExposedPorts ?? {}).sort(),
      volumes: Object.keys(config.Volumes ?? {}).sort(),
      labels: config.Labels ?? {},
      stop_signal: config.StopSignal ?? null,
    })
  )
    invalid();
}

async function readSeed(
  input: PublicImageCache,
  image: string,
  signal: AbortSignal,
) {
  const { directory, manifestSha256 } = checkedPublicImageCache(input, image);
  await verifyDirectory(directory, 0o555);
  const seal = await readMetadata(
    join(directory, 'manifest.json'),
    { sha256: manifestSha256 },
    signal,
  );
  const digest = image.slice(image.indexOf('@') + 1);
  if (
    seal.version !== 1 ||
    seal.microsandbox !== msbVersion ||
    seal.image !== image ||
    seal.platform !== 'linux/arm64' ||
    seal.materialization !== 'flat' ||
    typeof seal.ociManifest !== 'string' ||
    'sha256:' + sha256(seal.ociManifest) !== digest ||
    !Array.isArray(seal.files)
  )
    invalid();
  const oci = parse(seal.ociManifest);
  const config = object(oci.config);
  if (
    oci.schemaVersion !== 2 ||
    oci.mediaType !== 'application/vnd.oci.image.manifest.v1+json' ||
    !isDigest(config.digest) ||
    !Array.isArray(oci.layers) ||
    oci.layers.length === 0 ||
    seal.files.length > oci.layers.length + 3
  )
    invalid();
  const files = new Map<string, CacheFile>();
  for (const row of seal.files) {
    const { path, bytes, sha256: hash } = object(row);
    if (
      typeof path !== 'string' ||
      files.has(path) ||
      typeof bytes !== 'number' ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      !isHash(hash)
    )
      invalid();
    files.set(path, { bytes, sha256: hash });
  }
  for (const subdirectory of sourceDirectories)
    await verifyDirectory(join(directory, subdirectory), 0o555);

  const metadataPath = 'manifests/' + sha256(image) + '.json';
  const flatReferencePath = 'flat/refs/' + digest.replace(':', '_') + '.json';
  const metadataEntry = files.get(metadataPath);
  const flatEntry = files.get(flatReferencePath);
  if (!metadataEntry || !flatEntry) invalid();
  const metadata = await readMetadata(
    join(directory, metadataPath),
    metadataEntry,
    signal,
  );
  const flat = await readMetadata(
    join(directory, flatReferencePath),
    flatEntry,
    signal,
  );
  if (
    metadata.manifest_digest !== digest ||
    metadata.config_digest !== config.digest ||
    typeof metadata.raw_manifest_json !== 'string' ||
    !isDeepStrictEqual(parse(metadata.raw_manifest_json), oci) ||
    typeof metadata.raw_config_json !== 'string' ||
    'sha256:' + sha256(metadata.raw_config_json) !== config.digest ||
    !Array.isArray(metadata.layers) ||
    metadata.layers.length !== oci.layers.length ||
    flat.schema !== 1 ||
    flat.manifest_digest !== digest ||
    flat.materializer_abi !== flatAbi ||
    !isDigest(flat.artifact_digest)
  )
    invalid();

  const rawConfig = parse(metadata.raw_config_json);
  const rootfs = object(rawConfig.rootfs);
  const diffIds = rootfs.diff_ids;
  if (
    rawConfig.os !== 'linux' ||
    rawConfig.architecture !== 'arm64' ||
    rootfs.type !== 'layers' ||
    !Array.isArray(diffIds) ||
    diffIds.length !== oci.layers.length ||
    !diffIds.every(isDigest)
  )
    invalid();
  // Match the pinned MSB flat cache key, including ABI and ordered diff IDs.
  const abi = Buffer.alloc(4);
  abi.writeUInt32LE(flatAbi);
  const derivation = createHash('sha256')
    .update('microsandbox.flat-rootfs\0')
    .update(abi)
    .update(['', 'linux/arm64', digest, ...diffIds].join('\0'))
    .digest('hex');
  if (flat.derivation_digest !== 'sha256:' + derivation) invalid();
  validateNativeConfig(metadata.config, rawConfig);
  for (const [index, layer] of oci.layers.entries()) {
    const descriptor = object(layer);
    if (
      !isDigest(descriptor.digest) ||
      !isDeepStrictEqual(metadata.layers[index], {
        digest: descriptor.digest,
        media_type: descriptor.mediaType,
        size_bytes: descriptor.size,
        diff_id: diffIds[index],
      })
    )
      invalid();
  }
  const flatBlob =
    'flat/blobs/' + flat.artifact_digest.replace(':', '_') + '.raw';
  const blob = files.get(flatBlob);
  if (
    !blob ||
    blob.sha256 !== flat.artifact_digest.slice(7) ||
    blob.bytes !== flat.virtual_size_bytes
  )
    invalid();
  const expected = new Set([
    metadataPath,
    flatReferencePath,
    flatBlob,
    ...diffIds.map((id) => 'layers/' + id.replace(':', '_') + '.erofs'),
  ]);
  if (
    files.size !== expected.size ||
    [...expected].some((path) => !files.has(path))
  )
    invalid();

  const children = new Map<string, string[]>([['.', ['manifest.json']]]);
  for (const path of [...sourceDirectories, ...expected]) {
    const parent = dirname(path);
    const names = children.get(parent) ?? [];
    names.push(basename(path));
    children.set(parent, names);
  }
  for (const [parent, names] of children) {
    if (
      !isDeepStrictEqual(
        (await readdir(join(directory, parent))).sort(),
        names.sort(),
      )
    )
      invalid();
  }
  signal.throwIfAborted();
  return files;
}

export async function publicImageCacheBytes(
  input: PublicImageCache,
  image: string,
  signal: AbortSignal,
) {
  const entries = await readSeed(input, image, signal);
  return [...entries.values()].reduce(
    (sum, entry) => sum + BigInt(entry.bytes),
    0n,
  );
}

async function verifyFile(
  path: string,
  expected: CacheFile,
  signal: AbortSignal,
  sealed: boolean,
  destination?: string,
  budget?: WriteBudget,
) {
  signal.throwIfAborted();
  const { file, stat } = await checkedFile(path, sealed);
  try {
    if (stat.size !== expected.bytes) invalid();
    const hash = createHash('sha256');
    let size = 0;
    async function* chunks() {
      // Copy from the same descriptor whose ownership and mode were checked.
      const buffer = Buffer.allocUnsafe(256 * 1024);
      for (;;) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > expected.bytes) invalid();
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        yield chunk;
      }
    }
    const contents = chunks();
    if (destination && budget) {
      await budget.beforeWrite?.(0n);
      const output = await writeToCache(() => open(destination, 'wx', 0o600));
      try {
        for await (const chunk of contents) {
          await budget.beforeWrite?.(BigInt(chunk.length));
          await writeToCache(async () => {
            await output.writeFile(chunk);
            await output.sync();
          });
        }
      } finally {
        await output.close();
      }
    } else if (destination) {
      await writeFile(destination, contents, {
        flag: 'wx',
        mode: 0o600,
        signal,
      });
    } else {
      while (!(await contents.next()).done) {
        // Drain the verified stream without writing a copy.
      }
    }
    if (size !== expected.bytes || hash.digest('hex') !== expected.sha256)
      invalid();
    signal.throwIfAborted();
  } finally {
    await file.close();
  }
}

async function privateCacheDirectory(path: string, create: boolean) {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (!create && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return false;
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7022) !== 0 ||
    (await realpath(path)) !== path
  )
    invalid();
  return true;
}

async function discardInterruptedStages(root: string, signal: AbortSignal) {
  // The caller holds the VM's physical owner until seeding has settled.
  // Another attempt cannot be writing within this VM's staging namespace.
  for (const name of await readdir(root)) {
    if (!/^\.public-oci-[A-Za-z0-9]{6}$/.test(name)) continue;
    signal.throwIfAborted();
    const stage = join(root, name);
    await verifyDirectory(stage, 0o700);
    const entries = await readdir(stage, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || !/^\d+$/.test(entry.name)))
      invalid();
    for (const entry of entries) await unlink(join(stage, entry.name));
    await rmdir(stage);
  }
}

async function checkedNativeCacheRoot(
  input: PublicImageCache,
  nativeRoot: string,
) {
  const root = await realpath(nativeRoot);
  const mount = await realpath(dirname(nativeRoot));
  if (root !== join(mount, basename(nativeRoot))) invalid();
  await verifyDirectory(root, 0o700);
  if (inside(mount, input.directory) || inside(input.directory, mount))
    invalid();
  return root;
}

/** A Host-verified pool binding already seeded these bytes. Rehash the exact
 * mounted files against the current seal without reopening public blobs. */
export async function verifySeededPublicImageCache(
  input: PublicImageCache,
  image: string,
  nativeRoot: string,
  signal: AbortSignal,
) {
  try {
    const root = await checkedNativeCacheRoot(input, nativeRoot);
    const files = await readSeed(input, image, signal);
    const cache = join(root, 'cache');
    for (const path of [
      cache,
      ...sourceDirectories.map((name) => join(cache, name)),
    ]) {
      if (!(await privateCacheDirectory(path, false))) invalid();
    }
    for (const [name, entry] of files)
      await verifyFile(join(cache, name), entry, signal, false);
    signal.throwIfAborted();
  } catch {
    signal.throwIfAborted();
    invalid();
  }
}

type CacheRefreshIntent = Readonly<{
  version: 1;
  previous: string | null;
  installed: string;
}>;

async function cacheDirectoryInode(path: string, device: bigint) {
  if (!(await privateCacheDirectory(path, false))) return null;
  const stat = await lstat(path, { bigint: true });
  if (stat.dev !== device) invalid();
  return String(stat.ino);
}
const validInode = (value: unknown) =>
  typeof value === 'string' && /^\d+$/.test(value);
const cacheRefreshDirectory = (
  root: string,
  claimId: string,
  image: string,
  seal: string,
) =>
  join(root, '.public-oci-refresh-' + sha256(`${claimId}\0${image}\0${seal}`));

export async function hasPendingPublicCacheRefresh(
  input: PublicImageCache,
  image: string,
  nativeRoot: string,
  claimId: string,
) {
  const root = await checkedNativeCacheRoot(input, nativeRoot);
  const transaction = cacheRefreshDirectory(
    root,
    claimId,
    image,
    input.manifestSha256,
  );
  return (
    (await privateCacheDirectory(transaction, false)) &&
    Boolean(await readCacheRefreshIntent(join(transaction, 'intent.json'))) &&
    (await privateCacheDirectory(join(transaction, 'cache'), false))
  );
}

async function readCacheRefreshRecord(path: string): Promise<unknown> {
  const file = await open(path, readOnly).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    // A process may exit after linking the final name, before unlinking
    // its staging alias. Both names then refer to the same synced file.
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > 4096 ||
      stat.nlink > 2
    )
      invalid();
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}

async function readCacheRefreshIntent(path: string) {
  const intent = (await readCacheRefreshRecord(path)) as
    CacheRefreshIntent | undefined;
  if (intent === undefined) return null;
  if (
    !intent ||
    intent.version !== 1 ||
    !validInode(intent.installed) ||
    (intent.previous !== null && !validInode(intent.previous))
  )
    invalid();
  return intent;
}

/** Same-owner first native create. The caller has proved the original pooled
 * claim and mounted image. Stage and flush the full current seal before moving
 * any existing cache, and retain the entire previous directory on that disk. */
export async function refreshSeededPublicImageCache(
  input: PublicImageCache,
  image: string,
  nativeRoot: string,
  claimId: string,
  signal: AbortSignal,
) {
  const root = await checkedNativeCacheRoot(input, nativeRoot);
  // The verified image is stable across mounts, but its guest device number
  // can change. Check the live mount device and persist only in-volume inodes.
  const { dev } = await lstat(root, { bigint: true });
  const transaction = cacheRefreshDirectory(
    root,
    claimId,
    image,
    input.manifestSha256,
  );
  const cache = join(root, 'cache');
  const previous = join(transaction, 'previous');
  const staged = join(transaction, 'cache');
  const intentPath = join(transaction, 'intent.json');
  const originPath = 'owner.json';
  const owner = { version: 1, claimId, image, seal: input.manifestSha256 };
  signal.throwIfAborted();
  if (!(await privateCacheDirectory(transaction, false))) {
    const original = await cacheDirectoryInode(cache, dev);
    if (!original) invalid();
    // Publish the same-owner staging directory before copying any payload.
    // Only this small metadata directory has a random initialization name.
    const scratch = await mkdtemp(join(root, '.public-oci-refresh-owner-'));
    let published = false;
    try {
      await publishDiskPoolRecord(
        join(scratch, originPath),
        { ...owner, original },
        { signal },
      );
      signal.throwIfAborted();
      await rename(scratch, transaction);
      published = true;
      await syncDiskPoolDirectory(root);
    } finally {
      if (!published) await rm(scratch, { force: true, recursive: true });
    }
  }

  let intent = await readCacheRefreshIntent(intentPath);
  if (!intent) {
    const origin = (await readCacheRefreshRecord(
      join(transaction, originPath),
    )) as (typeof owner & { original: string }) | undefined;
    if (
      !origin ||
      !validInode(origin.original) ||
      !isDeepStrictEqual(origin, { ...owner, original: origin.original }) ||
      (await cacheDirectoryInode(cache, dev)) !== origin.original ||
      (await cacheDirectoryInode(previous, dev))
    )
      invalid();
    await syncDiskPoolDirectory(root);
    const hasStage = await privateCacheDirectory(staged, false);
    const alreadyCurrent =
      !hasStage &&
      (await verifySeededPublicImageCache(input, image, root, signal).then(
        () => true,
        () => false,
      ));
    signal.throwIfAborted();
    if (alreadyCurrent) {
      intent = { version: 1, previous: null, installed: origin.original };
    } else {
      // Resume the exact stage. The seeder checks existing public bytes and
      // only writes missing files after clearing its own interrupted scratch.
      await seedPublicImageCache(input, image, transaction, signal);
      const installed = await cacheDirectoryInode(staged, dev);
      if (!installed) invalid();
      const files = await readSeed(input, image, signal);
      for (const name of files.keys()) {
        signal.throwIfAborted();
        const { file } = await checkedFile(join(staged, name), false);
        try {
          await file.sync();
        } finally {
          await file.close();
        }
      }
      for (const directory of [...sourceDirectories].reverse())
        await syncDiskPoolDirectory(join(staged, directory));
      await syncDiskPoolDirectory(staged);
      intent = { version: 1, previous: origin.original, installed };
    }
    await publishDiskPoolRecord(intentPath, intent, { signal });
  }
  await syncDiskPoolDirectory(transaction);
  const active = await cacheDirectoryInode(cache, dev);
  const old = await cacheDirectoryInode(previous, dev);
  const next = await cacheDirectoryInode(staged, dev);
  if (active !== intent.installed) {
    if (!intent.previous || next !== intent.installed) invalid();
    await verifySeededPublicImageCache(input, image, transaction, signal);
    // The lease serializes this pair of moves. Every already present
    // destination must be exactly the one captured by the durable intent.
    if (old) {
      if (old !== intent.previous || active) invalid();
    } else {
      if (active !== intent.previous) invalid();
      signal.throwIfAborted();
      await rename(cache, previous);
    }
    await syncDiskPoolDirectory(transaction);
    await syncDiskPoolDirectory(root);
    signal.throwIfAborted();
    await rename(staged, cache);
  } else if (next || old !== intent.previous) invalid();
  await syncDiskPoolDirectory(transaction);
  await syncDiskPoolDirectory(root);
  await verifySeededPublicImageCache(input, image, root, signal);
}

/** Under the VM owner, seed only public bytes into the existing encrypted
 * per-VM cache. MSB can create locks and staging files only in that private
 * cache. Host publication must stage these exact entries from a fresh,
 * digest-pinned native pull, then seal and retain the immutable generation. */
export async function seedPublicImageCache(
  input: PublicImageCache,
  image: string,
  nativeRoot: string,
  signal: AbortSignal,
  budget?: WriteBudget,
) {
  try {
    const root = await checkedNativeCacheRoot(input, nativeRoot);
    const files = await readSeed(input, image, signal);
    if (budget) {
      const needed = [...files.values()].reduce((total, file) => {
        const size = BigInt(file.bytes);
        return (
          total +
          ((size + budget.blockBytes - 1n) / budget.blockBytes) *
            budget.blockBytes
        );
      }, 0n);
      if (needed > budget.bytes) throw new PublicImageCacheBudgetExceeded();
      await budget.beforeWrite?.(0n);
    }
    await discardInterruptedStages(root, signal);
    const cache = join(root, 'cache');
    const directories = [
      cache,
      ...sourceDirectories.map((name) => join(cache, name)),
    ];
    const existingDirectories = new Set<string>();
    for (const path of directories) {
      if (await privateCacheDirectory(path, false))
        existingDirectories.add(path);
    }
    const stagePrefix = join(root, '.public-oci-');
    const stage = budget
      ? await writeToCache(() => mkdtemp(stagePrefix))
      : await mkdtemp(stagePrefix);
    let failure: { error: unknown } | undefined;
    try {
      if (budget) await writeToCache(() => syncDiskPoolDirectory(root));
      const staged = new Map<string, { path: string; entry: CacheFile }>();
      for (const [name, entry] of files) {
        const destination = join(cache, name);
        let exists = false;
        if (existingDirectories.has(dirname(destination))) {
          try {
            await verifyFile(destination, entry, signal, false);
            exists = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        const path = exists ? undefined : join(stage, String(staged.size));
        await verifyFile(
          join(input.directory, name),
          entry,
          signal,
          true,
          path,
          path ? budget : undefined,
        );
        if (path !== undefined) staged.set(destination, { path, entry });
      }
      for (const path of directories) {
        if (budget) {
          await budget.beforeWrite?.(0n);
          await writeToCache(async () => {
            await privateCacheDirectory(path, true);
            await syncDiskPoolDirectory(dirname(path));
          });
        } else await privateCacheDirectory(path, true);
      }
      // Link only from private staging. An already verified private entry
      // needs no second copy, including after an interrupted partial install.
      for (const [destination, { path, entry }] of staged) {
        signal.throwIfAborted();
        try {
          if (budget) {
            await budget.beforeWrite?.(0n);
            await writeToCache(async () => {
              await link(path, destination);
              await syncDiskPoolDirectory(dirname(destination));
            });
          } else await link(path, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await verifyFile(destination, entry, signal, false);
        }
      }
    } catch (error) {
      failure = { error };
    }
    try {
      await rm(stage, { recursive: true, force: true });
    } catch (cleanup) {
      const cause = new AggregateError(
        failure ? [failure.error, cleanup] : [cleanup],
      );
      if (failure?.error instanceof PublicImageCacheBudgetExceeded)
        throw new PublicImageCacheBudgetExceeded(failure.error.capacity, {
          cause,
        });
      if (failure?.error instanceof DiskPoolForegroundDeferred)
        throw new DiskPoolForegroundDeferred({ cause });
      throw cause;
    }
    if (failure) throw failure.error;
    signal.throwIfAborted();
  } catch (error) {
    if (!budget) signal.throwIfAborted();
    if (
      error instanceof PublicImageCacheBudgetExceeded ||
      error instanceof DiskPoolForegroundDeferred
    )
      throw error;
    // Joined cleanup failures retain the original operation and cleanup
    // errors even when the caller concurrently cancels.
    if (!(error instanceof AggregateError)) signal.throwIfAborted();
    invalid(error);
  }
}
