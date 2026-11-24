import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
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
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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

/** M1 and its sole publisher are trusted. No host TOCTOU/ACL/ancestry audit or
 * per-start payload scan: compare the sealed bytes and tree version to host config. */
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
    signal.throwIfAborted();
    return sealedHash;
  } catch {
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
) {
  signal.throwIfAborted();
  if (!digest(descriptorSha256)) invalid();
  const path = join(home, 'allrice-readonly-dsh.json');
  const value = {
    version: 2,
    vmId: binding.vmId,
    personId: binding.personId,
    ...c,
    descriptorSha256,
    ...(controls ? { commandMemorySha256: controls.sha256 } : {}),
  };
  if (create) {
    let fd;
    try {
      fd = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') invalid();
    }
    if (fd) {
      try {
        await fd.writeFile(JSON.stringify(value));
        await fd.sync();
      } finally {
        await fd.close();
      }
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
  }
  try {
    const raw = await metadataFile(path, MANIFEST_BYTES, signal),
      saved = object(JSON.parse(raw.toString('utf8')));
    keys(saved, Object.keys(value));
    for (const [key, expected] of Object.entries(value))
      if (saved[key] !== expected) invalid();
  } catch {
    invalid();
  }
}

/** v0.7.16 public VolumeMount::Bind serialization; missing/extra is unknown. */
export function assertReadonlyArtifactInspection(
  value: unknown,
  name: string,
  c: ReadonlyDshDirectory,
  running: boolean,
  controls?: ReadonlyCommandMemoryDirectory,
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
      keys(options, ['readonly', 'noexec', 'nosuid', 'nodev']);
      if (
        m.type !== 'Bind' ||
        m.host !== expected.hostDirectory ||
        m.stat_virtualization !== 'strict' ||
        m.host_permissions !== 'private' ||
        m.follow_root_symlinks !== false ||
        m.quota_mib !== null ||
        options.readonly !== true ||
        options.noexec !== false ||
        options.nosuid !== false ||
        options.nodev !== false
      )
        invalid();
    }
  }
  config(inspection.config);
  if (running || inspection.active_config !== null)
    config(inspection.active_config);
}
