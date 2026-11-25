import { constants, type BigIntStats } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { PersonVmError, type PersonVmBinding } from './contract.ts';

/** Expected hashes come from the trusted publisher receipt, never this file's contents. */
export type ReadonlyDshDirectory = Readonly<{
  descriptorPath: string;
  hostDirectory: string;
  guestDirectory: string;
  artifactSha256: string;
  manifestSha256: string;
  sealedManifestSha256: string;
  treeSha256: string;
}>;
export type ReadonlyDshRuntimeDisk = Readonly<{
  diskPath: string;
  diskSha256: string;
  candidatePath: string;
  candidateSha256: string;
  provision: 'disk' | 'directory';
}>;
export type ReadonlyCommandMemoryDirectory = Readonly<{
  hostDirectory: string;
  guestDirectory: string;
  sha256: string;
}>;
export const COMMAND_MEMORY_CONTROL_FILES = Object.freeze([
  'bash-env.sh',
  'command-observer.cjs',
  'dsh-command-memory.mjs',
  'initialize.cjs',
  'launch-dsh.sh',
  'sample.cjs',
] as const);
export const COMMAND_MEMORY_STATE_ROOT = '/run/allrice-command-memory';
const BASE =
  'docker.io/library/node@sha256:af0bb4bf5b7318e3269417a7684a9e116c3c22eaf05382578b0d0d33de597ad2';
const MANIFEST_BYTES = 16832328;
const SANDBOX_BIN_DIRECTORY = 'sandbox-bin';
const SANDBOX_BWRAP_PATH = SANDBOX_BIN_DIRECTORY + '/bwrap';
const BUBBLEWRAP_PACKAGE_SHA256 =
  'd044ba1d7961d835669035fcd1e11121f1dc960a1a2e1c6489a93ea44e083557';
const hash = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
const digest = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function invalid(): never {
  throw new PersonVmError('PROVIDER_FAILED');
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid();
  return v as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0'))
    invalid();
}
function owned(s: BigIntStats) {
  if (!process.getuid || s.uid !== BigInt(process.getuid())) invalid();
}
function mode(s: BigIntStats) {
  return Number(s.mode & 0o7777n);
}
export function checkedReadonlyDshDirectory(
  value: ReadonlyDshDirectory,
): ReadonlyDshDirectory {
  if (
    !value ||
    ![
      value.artifactSha256,
      value.manifestSha256,
      value.sealedManifestSha256,
      value.treeSha256,
    ].every(digest) ||
    ![value.hostDirectory, value.descriptorPath, value.guestDirectory].every(
      (p) =>
        typeof p === 'string' &&
        isAbsolute(p) &&
        resolve(p) === p &&
        !p.includes(':') &&
        !p.includes('\0'),
    ) ||
    basename(value.hostDirectory) !== 'public' ||
    basename(dirname(value.hostDirectory)) !== value.artifactSha256 ||
    value.descriptorPath !==
      join(dirname(value.hostDirectory), 'descriptor.json') ||
    value.guestDirectory !== `/opt/allrice/dsh/${value.artifactSha256}`
  )
    invalid();
  return Object.freeze({
    descriptorPath: value.descriptorPath,
    hostDirectory: value.hostDirectory,
    guestDirectory: value.guestDirectory,
    artifactSha256: value.artifactSha256,
    manifestSha256: value.manifestSha256,
    sealedManifestSha256: value.sealedManifestSha256,
    treeSha256: value.treeSha256,
  });
}
export function checkedReadonlyCommandMemoryDirectory(
  value: ReadonlyCommandMemoryDirectory,
): ReadonlyCommandMemoryDirectory {
  if (
    !value ||
    !digest(value.sha256) ||
    typeof value.hostDirectory !== 'string' ||
    !isAbsolute(value.hostDirectory) ||
    resolve(value.hostDirectory) !== value.hostDirectory ||
    /[:\0]/.test(value.hostDirectory) ||
    basename(value.hostDirectory) !== value.sha256 ||
    value.guestDirectory !== `/opt/allrice/command-memory/${value.sha256}`
  )
    invalid();
  return Object.freeze({
    hostDirectory: value.hostDirectory,
    guestDirectory: value.guestDirectory,
    sha256: value.sha256,
  });
}
export function hashCommandMemoryControlFiles(
  files: ReadonlyMap<(typeof COMMAND_MEMORY_CONTROL_FILES)[number], Uint8Array>,
) {
  return hash(
    Buffer.from(
      JSON.stringify(
        COMMAND_MEMORY_CONTROL_FILES.map((file) => [
          file,
          hash(files.get(file) ?? invalid()),
        ]),
      ),
    ),
  );
}
export function checkedReadonlyDshRuntimeDisk(
  value: ReadonlyDshRuntimeDisk,
): ReadonlyDshRuntimeDisk {
  const { diskPath, diskSha256, candidatePath, candidateSha256, provision } =
    value;
  if (
    !digest(diskSha256) ||
    !digest(candidateSha256) ||
    typeof diskPath !== 'string' ||
    !isAbsolute(diskPath) ||
    resolve(diskPath) !== diskPath ||
    /[:\0]/.test(diskPath) ||
    basename(diskPath) !== 'runtime.ext4' ||
    basename(dirname(diskPath)) !== diskSha256 ||
    candidatePath !== join(dirname(diskPath), 'candidate.json') ||
    !['directory', 'disk'].includes(provision)
  )
    invalid();
  return Object.freeze({
    diskPath,
    diskSha256,
    candidatePath,
    candidateSha256,
    provision,
  });
}

function diskIdentity(stat: BigIntStats) {
  owned(stat);
  if (!stat.isFile() || mode(stat) !== 0o444 || stat.nlink !== 1n) invalid();
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs,
  ].join(':');
}

/** Recheck the sealed file's identity at each use. Hash its bytes once per
 * immutable file identity, so retained starts avoid reading the whole disk. */
export function createReadonlyDshDiskVerifier() {
  let verified: string | undefined;
  return async function verify(
    disk: ReadonlyDshRuntimeDisk,
    directory: ReadonlyDshDirectory,
    image: string,
    signal: AbortSignal,
  ) {
    try {
      await publishedDirectory(dirname(disk.diskPath));
      const bytes = await metadataFile(
        disk.candidatePath,
        MANIFEST_BYTES,
        signal,
        0o444,
      );
      const receipt = object(JSON.parse(bytes.toString('utf8')));
      const source = object(receipt.source);
      const imageDisk = object(receipt.disk);
      const abi = object(receipt.abi);
      if (
        hash(bytes) !== disk.candidateSha256 ||
        receipt.schemaVersion !== 1 ||
        receipt.platform !== 'linux/arm64' ||
        image !== BASE ||
        source.baseImage !== image ||
        source.dshVersion !== '0.2.1-rc.2' ||
        source.nodeVersion !== '22.23.2' ||
        source.artifactSha256 !== directory.artifactSha256 ||
        source.manifestSha256 !== directory.manifestSha256 ||
        source.descriptorSha256 !== directory.sealedManifestSha256 ||
        source.treeSha256 !== directory.treeSha256 ||
        source.bubblewrapVersion !== '0.8.0-2+deb12u1' ||
        source.bubblewrapDebSha256 !== BUBBLEWRAP_PACKAGE_SHA256 ||
        !digest(source.bubblewrapElfSha256) ||
        source.cli !== 'node_modules/@deepseek-ai/dsh/lib/bin.js' ||
        !digest(receipt.cliSha256) ||
        !digest(receipt.lockSha256) ||
        receipt.guestDirectory !== directory.guestDirectory ||
        source.lock !== 'package-lock.json' ||
        imageDisk.format !== 'raw/ext4' ||
        imageDisk.e2fsprogs !== '1.47.4' ||
        imageDisk.sha256 !== disk.diskSha256 ||
        typeof imageDisk.bytes !== 'number' ||
        !Number.isSafeInteger(imageDisk.bytes) ||
        imageDisk.bytes <= 0 ||
        ![SANDBOX_BWRAP_PATH, 'usr/local/bin/node'].every((name) => {
          const entry = object(abi[name]);
          return (
            entry.interpreter === '/lib/ld-linux-aarch64.so.1' &&
            Array.isArray(entry.needed) &&
            entry.needed.every((lib) => typeof lib === 'string')
          );
        })
      )
        invalid();
      const fd = await open(
        disk.diskPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await fd.stat({ bigint: true });
        const identity = diskIdentity(stat);
        if (stat.size !== BigInt(imageDisk.bytes)) invalid();
        const dependency =
          disk.diskPath + ':' + disk.diskSha256 + ':' + identity;
        if (verified !== dependency) {
          const checksum = createHash('sha256');
          for await (const chunk of fd.createReadStream({
            autoClose: false,
            signal,
          }))
            checksum.update(chunk);
          if (checksum.digest('hex') !== disk.diskSha256) invalid();
        }
        if (
          identity !== diskIdentity(await fd.stat({ bigint: true })) ||
          identity !==
            diskIdentity(await lstat(disk.diskPath, { bigint: true }))
        )
          invalid();
        signal.throwIfAborted();
        verified = dependency;
      } finally {
        await fd.close();
      }
      return {
        descriptorSha256: directory.sealedManifestSha256,
        sandboxSha256: source.bubblewrapElfSha256,
        cliSha256: receipt.cliSha256,
      };
    } catch {
      signal.throwIfAborted();
      invalid();
    }
  };
}

async function publishedDirectory(path: string) {
  const s = await lstat(path, { bigint: true });
  owned(s);
  if (!s.isDirectory() || mode(s) & 0o022 || (await realpath(path)) !== path)
    invalid();
}
async function metadataFile(
  path: string,
  limit: number,
  signal: AbortSignal,
  expectedMode = 0o600,
) {
  signal.throwIfAborted();
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await fd.stat({ bigint: true });
    owned(s);
    if (
      !s.isFile() ||
      s.nlink !== 1n ||
      mode(s) !== expectedMode ||
      s.size <= 0 ||
      s.size > BigInt(limit)
    )
      invalid();
    const bytes = await fd.readFile({ signal });
    if (bytes.length > limit) invalid();
    return bytes;
  } finally {
    await fd.close();
  }
}

export async function verifyReadonlyCommandMemoryDirectory(
  value: ReadonlyCommandMemoryDirectory,
  signal: AbortSignal,
) {
  const c = checkedReadonlyCommandMemoryDirectory(value);
  try {
    await publishedDirectory(dirname(c.hostDirectory));
    await publishedDirectory(c.hostDirectory);
    const names = (await readdir(c.hostDirectory)).sort();
    if (names.join('\0') !== COMMAND_MEMORY_CONTROL_FILES.join('\0')) invalid();
    const files = new Map<
      (typeof COMMAND_MEMORY_CONTROL_FILES)[number],
      Uint8Array
    >();
    for (const name of COMMAND_MEMORY_CONTROL_FILES)
      files.set(
        name,
        await metadataFile(
          join(c.hostDirectory, name),
          MANIFEST_BYTES,
          signal,
          name === 'launch-dsh.sh' ? 0o555 : 0o444,
        ),
      );
    if (hashCommandMemoryControlFiles(files) !== c.sha256) invalid();
    signal.throwIfAborted();
  } catch {
    invalid();
  }
}

/** The sandbox executable is the only payload leaf read during verification.
 * The artifact publisher owns the full tree and the Debian provenance checks. */
async function verifiedSandboxSha256(
  directory: ReadonlyDshDirectory,
  value: unknown,
  signal: AbortSignal,
) {
  const backend = object(value);
  keys(backend, [
    'kind',
    'path',
    'mode',
    'architecture',
    'packageVersion',
    'packageSha256',
    'sha256',
  ]);
  if (
    backend.kind !== 'bubblewrap' ||
    backend.path !== SANDBOX_BWRAP_PATH ||
    backend.mode !== 0o555 ||
    backend.architecture !== 'arm64' ||
    backend.packageVersion !== '0.8.0-2+deb12u1' ||
    backend.packageSha256 !== BUBBLEWRAP_PACKAGE_SHA256 ||
    !digest(backend.sha256)
  )
    invalid();

  const hostBin = join(directory.hostDirectory, SANDBOX_BIN_DIRECTORY);
  await publishedDirectory(hostBin);
  if (
    mode(await lstat(hostBin, { bigint: true })) !== 0o555 ||
    (await readdir(hostBin)).join('\0') !== 'bwrap'
  )
    invalid();
  const executable = await metadataFile(
    join(directory.hostDirectory, SANDBOX_BWRAP_PATH),
    128 * 1024,
    signal,
    0o555,
  );
  if (hash(executable) !== backend.sha256) invalid();
  return backend.sha256;
}

/** M1 and its sole publisher are trusted. Compare sealed bytes and the tree
 * version to host config. Older descriptors have no bundled sandbox backend. */
export async function verifyReadonlyDshDirectory(
  input: ReadonlyDshDirectory,
  image: string,
  signal: AbortSignal,
) {
  try {
    const c = checkedReadonlyDshDirectory(input);
    await publishedDirectory(c.hostDirectory);
    await publishedDirectory(dirname(c.hostDirectory));
    const bytes = await metadataFile(
      c.descriptorPath,
      MANIFEST_BYTES,
      signal,
      0o444,
    );
    const sealedHash = hash(bytes);
    if (sealedHash !== c.sealedManifestSha256) invalid();
    const descriptor = object(JSON.parse(bytes.toString('utf8')));
    if (
      image !== BASE ||
      descriptor.kind !== 'allrice-dsh-readonly-directory-v2' ||
      descriptor.baseImage !== image ||
      descriptor.hostDirectory !== c.hostDirectory ||
      descriptor.guestDirectory !== c.guestDirectory ||
      descriptor.artifactSha256 !== c.artifactSha256 ||
      descriptor.manifestSha256 !== c.manifestSha256 ||
      descriptor.treeSha256 !== c.treeSha256 ||
      descriptor.dshVersion !== '0.2.1-rc.2' ||
      descriptor.nodeVersion !== '22.23.2' ||
      !digest(descriptor.publisherSha256) ||
      !digest(descriptor.gateSha256)
    )
      invalid();
    const sandboxSha256 = Object.hasOwn(descriptor, 'sandboxBackend')
      ? await verifiedSandboxSha256(c, descriptor.sandboxBackend, signal)
      : undefined;
    signal.throwIfAborted();
    return { descriptorSha256: sealedHash, sandboxSha256 };
  } catch {
    invalid();
  }
}

// The provisioning choice applies only if this VM has no persisted artifact
// reference. An existing VM keeps its original layout through policy changes.
export async function selectedReadonlyRuntimeDisk(
  home: string,
  disk: ReadonlyDshRuntimeDisk | undefined,
  create: boolean,
  signal: AbortSignal,
) {
  if (!disk) return;
  try {
    const data = await metadataFile(
      join(home, 'allrice-readonly-dsh.json'),
      MANIFEST_BYTES,
      signal,
    );
    const saved = object(JSON.parse(data.toString('utf8')));
    return Object.hasOwn(saved, 'runtimeDiskSha256') ? disk : undefined;
  } catch (error) {
    if (create && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return disk.provision === 'disk' ? disk : undefined;
    signal.throwIfAborted();
    invalid();
  }
}

/** Derived persistent VM reference, not an epoch/permission authority. */
export async function readonlyArtifactReference(
  home: string,
  binding: PersonVmBinding,
  c: ReadonlyDshDirectory,
  create: boolean,
  signal: AbortSignal,
  descriptorSha256: string,
  controls?: ReadonlyCommandMemoryDirectory,
  disk?: ReadonlyDshRuntimeDisk,
  replaceAbsentDisk?: ReadonlyDshRuntimeDisk,
) {
  signal.throwIfAborted();
  if (!digest(descriptorSha256)) invalid();
  const path = join(home, 'allrice-readonly-dsh.json');
  function reference(runtimeDisk?: ReadonlyDshRuntimeDisk) {
    return {
      version: 2,
      vmId: binding.vmId,
      personId: binding.personId,
      ...c,
      descriptorSha256,
      ...(controls ? { commandMemorySha256: controls.sha256 } : {}),
      ...(runtimeDisk
        ? {
            runtimeDiskPath: runtimeDisk.diskPath,
            runtimeDiskSha256: runtimeDisk.diskSha256,
            runtimeCandidatePath: runtimeDisk.candidatePath,
            runtimeCandidateSha256: runtimeDisk.candidateSha256,
          }
        : {}),
    };
  }
  type Reference = ReturnType<typeof reference>;
  async function check(expected: Reference) {
    const raw = await metadataFile(path, MANIFEST_BYTES, signal);
    const saved = object(JSON.parse(raw.toString('utf8')));
    keys(saved, Object.keys(expected));
    for (const [key, value] of Object.entries(expected))
      if (saved[key] !== value) invalid();
  }
  async function write(
    target: string,
    value: Reference,
    allowExisting = false,
  ) {
    let fd;
    try {
      fd = await open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (allowExisting && (error as NodeJS.ErrnoException).code === 'EEXIST')
        return false;
      throw error;
    }
    try {
      await fd.writeFile(JSON.stringify(value));
      await fd.sync();
    } finally {
      await fd.close();
    }
    return true;
  }
  async function syncHome() {
    const directory = await open(
      home,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  try {
    if (replaceAbsentDisk) {
      if (!create || disk || replaceAbsentDisk.provision !== 'directory')
        invalid();
      // Create proved native absence under the VM owner. Only an exact,
      // earlier provisioning reference may be replaced before dispatch.
      await check(reference(replaceAbsentDisk));
      const stage = await mkdtemp(join(home, '.dsh-ref-'));
      try {
        const staged = join(stage, 'reference');
        await write(staged, reference());
        signal.throwIfAborted();
        await rename(staged, path);
        await syncHome();
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    } else if (create && (await write(path, reference(disk), true))) {
      await syncHome();
    }
    await check(reference(disk));
  } catch {
    invalid();
  }
}

/** Exact v0.7.16 public VolumeMount serialization for both sealed transports. */
export function assertReadonlyArtifactInspection(
  value: unknown,
  name: string,
  c: ReadonlyDshDirectory,
  running: boolean,
  controls?: ReadonlyCommandMemoryDirectory,
  disk?: ReadonlyDshRuntimeDisk,
) {
  const inspection = object(value);
  if (
    inspection.name !== name ||
    (running
      ? inspection.status !== 'Running'
      : !['Stopped', 'Created', 'Crashed'].includes(
          String(inspection.status),
        )) ||
    !Array.isArray(inspection.pending_changes) ||
    inspection.pending_changes.length !== 0
  )
    invalid();
  function config(value: unknown) {
    const v = object(value);
    if (!Array.isArray(v.mounts) || v.mounts.length !== (controls ? 2 : 1))
      invalid();
    const mounts = v.mounts.map(object);
    for (const expected of controls ? [c, controls] : [c]) {
      const m = object(
          mounts.find((mount) => mount.guest === expected.guestDirectory),
        ),
        options = object(m.options);
      keys(options, ['readonly', 'noexec', 'nosuid', 'nodev']);
      if (
        options.readonly !== true ||
        options.noexec !== false ||
        options.nosuid !== false ||
        options.nodev !== false
      )
        invalid();
      if (disk && expected === c) {
        keys(m, ['type', 'host', 'guest', 'options', 'format', 'fstype']);
        if (
          m.type !== 'DiskImage' ||
          m.host !== disk.diskPath ||
          m.format !== 'Raw' ||
          m.fstype !== 'ext4'
        )
          invalid();
        continue;
      }
      keys(m, [
        'type',
        'host',
        'guest',
        'options',
        'stat_virtualization',
        'host_permissions',
        'follow_root_symlinks',
        'quota_mib',
      ]);
      if (
        m.type !== 'Bind' ||
        m.host !== expected.hostDirectory ||
        m.stat_virtualization !== 'strict' ||
        m.host_permissions !== 'private' ||
        m.follow_root_symlinks !== false ||
        m.quota_mib !== null
      )
        invalid();
    }
  }
  config(inspection.config);
  if (running || inspection.active_config !== null)
    config(inspection.active_config);
}
