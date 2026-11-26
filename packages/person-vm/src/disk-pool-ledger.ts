import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  sep,
} from 'node:path';
import { UuidSchema } from '@allrice/contracts';
import { PersonVmError } from './contract.ts';
import {
  sameDiskPoolOwner,
  type DiskPoolClaim,
  type DiskPoolOwner,
  type DiskPoolStock,
  type PreparedDiskPoolStock,
} from './disk-pool-platform.ts';

export const diskPoolSize = 3;
const maxRecordBytes = 8 * 1024;
const recordName = /^([0-2])\.([1-9][0-9]*)\.json$/;
const ordinaryOwnerName = /^owner\.([0-9a-f-]{36})\.json$/;
const stageName = /^\.stage-[0-9a-f-]{36}$/;

export type DiskPoolRecord =
  | (DiskPoolStock & { state: 'filling' })
  | (DiskPoolStock & { state: 'released-before-write' })
  | (DiskPoolStock & { state: 'ready'; proof: string })
  | (PreparedDiskPoolStock & {
      state: 'retiring' | 'retired';
      reason: 'source-changed' | 'preparation-deferred';
    })
  | (DiskPoolClaim & { state: 'claiming' | 'bound' | 'claim-quarantined' })
  | (DiskPoolStock & {
      state: 'quarantined';
      reason: 'source-changed' | 'preparation-failed' | 'cleanup-unconfirmed';
    });
export type DiskPoolSlot = Readonly<{
  index: number;
  revision: number;
  entry: DiskPoolRecord | null;
}>;

export function missing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
function incomplete(): never {
  throw new PersonVmError('CLEANUP_INCOMPLETE');
}

/** Resolve only a system-owned first component. The suffix may not exist. */
export function systemPathNormalizer() {
  const aliases = new Map<string, Promise<string>>();
  return async (path: string) => {
    if (!isAbsolute(path) || normalize(path) !== path) return path;
    const root = parse(path).root;
    const alias = join(root, path.slice(root.length).split(sep)[0]!);
    let physical = aliases.get(alias);
    if (!physical) {
      physical = lstat(alias)
        .then((info) =>
          info.isSymbolicLink() && info.uid === 0 ? realpath(alias) : alias,
        )
        .catch((error: unknown) => {
          if (missing(error)) return alias;
          throw error;
        });
      aliases.set(alias, physical);
    }
    const prefix = await physical;
    return prefix === alias ? path : join(prefix, relative(alias, path));
  };
}

async function storageAncestor(path: string) {
  const canonical = await realpath(path).catch((error: unknown) => {
    if (!missing(error)) throw error;
    return null;
  });
  if (!canonical || canonical === path) return canonical;
  // Allow a system-owned top-level alias such as Darwin's /tmp or /var.
  // No further symbolic link may change the remainder of the configured path.
  if ((await systemPathNormalizer()(path)) !== canonical) incomplete();
  return canonical;
}

/** Resolve a trusted ancestor, then validate the requested directory leaf. */
export async function privatePersonVmDirectory(path: string) {
  if (!isAbsolute(path) || path === dirname(path)) incomplete();
  const parent = await storageAncestor(dirname(path));
  if (!parent) return null;
  const canonical = join(parent, basename(path));
  const info = await lstat(canonical).catch((error: unknown) => {
    if (!missing(error)) throw error;
    return null;
  });
  if (!info) return null;
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o7777) !== 0o700
  )
    incomplete();
  return canonical;
}

async function ensurePrivatePersonVmDirectory(path: string): Promise<string> {
  const existing = await privatePersonVmDirectory(path);
  if (existing) return existing;
  const parent = dirname(path);
  const canonical =
    (await storageAncestor(parent)) ??
    (await ensurePrivatePersonVmDirectory(parent));
  const target = join(canonical, basename(path));
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
  }
  return (await privatePersonVmDirectory(target)) ?? incomplete();
}

export async function syncDiskPoolDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncCatalogParents(path: string) {
  // Even an observed directory could have been just created by another
  // process. Persist its name and each owned ancestor's name up to the
  // independently managed parent before creating an authoritative receipt.
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const info = await lstat(parent);
    if (!info.isDirectory()) incomplete();
    await syncDiskPoolDirectory(parent);
    if (info.uid !== process.getuid?.() || parent === dirname(parent)) return;
  }
}

/** Create and publish an immutable record. Link is the compare-and-set; a
 * disconnected advisory session cannot overwrite a successor's record. */
export async function publishDiskPoolRecord(
  path: string,
  value: unknown,
  options?: Readonly<{ signal: AbortSignal; beforeLink?(): Promise<void> }>,
) {
  options?.signal.throwIfAborted();
  const parent = dirname(path);
  const staging = join(parent, `.stage-${randomUUID()}`);
  const file = await open(staging, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    options?.signal.throwIfAborted();
    if (options?.beforeLink) await options.beforeLink();
    options?.signal.throwIfAborted();
    await link(staging, path);
    await syncDiskPoolDirectory(parent);
  } finally {
    await unlink(staging);
  }
}

function validText(v: unknown, limit: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= limit;
}
function uuid(v: unknown) {
  return UuidSchema.safeParse(v).success;
}
function readOrdinaryOwner(value: unknown, vmId: string): DiskPoolOwner {
  const record = value as (DiskPoolOwner & { version: number }) | null;
  if (
    !record ||
    record.version !== 1 ||
    record.vmId !== vmId ||
    !uuid(record.vmId) ||
    !uuid(record.personId) ||
    !uuid(record.organizationId)
  )
    incomplete();
  return record;
}

async function readEvidence(path: string): Promise<unknown> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > maxRecordBytes
    )
      incomplete();
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}

function readRecord(value: unknown): DiskPoolRecord {
  const entry = value as DiskPoolRecord | null;
  if (!entry || !uuid(entry.ref) || !validText(entry.source, 320)) incomplete();
  switch (entry.state) {
    case 'filling':
    case 'released-before-write':
      return entry;
    case 'ready':
      if (validText(entry.proof, 4096)) return entry;
      break;
    case 'retiring':
    case 'retired':
      if (
        validText(entry.proof, 4096) &&
        ['source-changed', 'preparation-deferred'].includes(entry.reason)
      )
        return entry;
      break;
    case 'quarantined':
      if (
        [
          'source-changed',
          'preparation-failed',
          'cleanup-unconfirmed',
        ].includes(entry.reason)
      )
        return entry;
      break;
    case 'claiming':
    case 'bound':
    case 'claim-quarantined': {
      const intent = entry.intent;
      if (
        validText(entry.proof, 4096) &&
        intent &&
        uuid(intent.id) &&
        uuid(intent.requestId) &&
        uuid(intent.owner?.vmId) &&
        uuid(intent.owner?.personId) &&
        uuid(intent.owner?.organizationId)
      )
        return entry;
      break;
    }
  }
  return incomplete();
}
function follows(previous: DiskPoolRecord | null, entry: DiskPoolRecord) {
  if (
    !previous ||
    previous.state === 'bound' ||
    previous.state === 'retired' ||
    previous.state === 'released-before-write'
  )
    return entry.state === 'filling';
  if (entry.ref !== previous.ref || entry.source !== previous.source)
    return false;
  if (previous.state === 'filling')
    return (
      entry.state === 'ready' ||
      entry.state === 'quarantined' ||
      (entry.state === 'retiring' && entry.reason === 'preparation-deferred') ||
      entry.state === 'released-before-write'
    );
  if (previous.state === 'ready') {
    return (
      entry.state === 'quarantined' ||
      (entry.state === 'retiring' &&
        entry.reason === 'source-changed' &&
        entry.proof === previous.proof) ||
      (entry.state === 'claiming' && entry.proof === previous.proof)
    );
  }
  if (previous.state === 'retiring')
    return (
      entry.state === 'retired' &&
      entry.reason === previous.reason &&
      entry.proof === previous.proof
    );
  return (
    previous.state === 'claiming' &&
    (entry.state === 'bound' || entry.state === 'claim-quarantined') &&
    previous.proof === entry.proof &&
    previous.intent.id === entry.intent.id &&
    previous.intent.requestId === entry.intent.requestId &&
    sameDiskPoolOwner(previous.intent.owner, entry.intent.owner)
  );
}

/** Host-local private catalog. Each fixed stock slot has an append-only
 * sequence. A bound generation frees its slot and keeps its original claim. */
export class DiskPoolLedger {
  private seen = false;
  constructor(private readonly diskRoot: string) {}
  private async location() {
    const disk = await privatePersonVmDirectory(this.diskRoot);
    const ledger =
      disk &&
      (await privatePersonVmDirectory(join(disk, '.preprovision-ledger')));
    if (ledger) this.seen = true;
    else if (this.seen) incomplete();
    return ledger;
  }
  async read(signal: AbortSignal, includeOrdinaryOwners = false) {
    const slots: DiskPoolSlot[] = Array.from(
      { length: diskPoolSize },
      (_, index) => ({
        index,
        revision: 0,
        entry: null,
      }),
    );
    const bound = new Map<string, DiskPoolClaim>();
    const boundByPerson = new Map<string, DiskPoolClaim[]>();
    const ordinaryOwners = new Map<string, DiskPoolOwner>();
    signal.throwIfAborted();
    const root = await this.location();
    if (root) {
      const names = await readdir(root);
      const files = names
        .flatMap((name) => {
          if (stageName.test(name) || ordinaryOwnerName.test(name)) return [];
          const match = recordName.exec(name);
          if (!match) return incomplete();
          return [
            { name, index: Number(match[1]), revision: Number(match[2]) },
          ];
        })
        .sort((a, b) => a.index - b.index || a.revision - b.revision);
      // A writer which lost its SQL session after linking might have been
      // interrupted before its fsync. Make this observed prefix durable.
      await syncDiskPoolDirectory(root);
      const refs = new Set<string>();
      const intents = new Set<string>();
      for (const { name, index, revision } of files) {
        signal.throwIfAborted();
        const slot = slots[index]!;
        if (!Number.isSafeInteger(revision) || revision !== slot.revision + 1)
          incomplete();
        const entry = readRecord(await readEvidence(join(root, name)));
        if (!follows(slot.entry, entry)) incomplete();
        if (entry.state === 'filling') {
          if (refs.has(entry.ref)) incomplete();
          refs.add(entry.ref);
        }
        if (entry.state === 'claiming') {
          if (intents.has(entry.intent.id)) incomplete();
          intents.add(entry.intent.id);
        }
        if (entry.state === 'bound') {
          if (bound.has(entry.intent.owner.vmId)) incomplete();
          bound.set(entry.intent.owner.vmId, entry);
          const owner = entry.intent.owner.personId;
          const previous = boundByPerson.get(owner);
          if (previous) previous.push(entry);
          else boundByPerson.set(owner, [entry]);
        }
        slots[index] = { index, revision, entry };
      }
      if (includeOrdinaryOwners) {
        for (const name of names) {
          const vmId = ordinaryOwnerName.exec(name)?.[1];
          if (!vmId) continue;
          signal.throwIfAborted();
          ordinaryOwners.set(
            vmId,
            readOrdinaryOwner(await readEvidence(join(root, name)), vmId),
          );
        }
      }
    }
    signal.throwIfAborted();
    return { slots, bound, boundByPerson, ordinaryOwners };
  }

  private async ensure(signal: AbortSignal) {
    signal.throwIfAborted();
    let root = await this.location();
    if (!root) {
      const disk = await ensurePrivatePersonVmDirectory(this.diskRoot);
      root = await ensurePrivatePersonVmDirectory(
        join(disk, '.preprovision-ledger'),
      );
      this.seen = true;
    }
    await syncCatalogParents(root);
    signal.throwIfAborted();
    return root;
  }

  async recordOrdinaryOwner(
    owner: DiskPoolOwner,
    signal: AbortSignal,
    beforeLink: () => Promise<void>,
  ) {
    const record = readOrdinaryOwner(
      {
        version: 1,
        vmId: owner.vmId,
        personId: owner.personId,
        organizationId: owner.organizationId,
      },
      owner.vmId,
    );
    const root = await this.ensure(signal);
    await publishDiskPoolRecord(
      join(root, `owner.${owner.vmId}.json`),
      record,
      { signal, beforeLink },
    );
  }

  async append(
    slot: DiskPoolSlot,
    entry: DiskPoolRecord,
    signal: AbortSignal,
    beforeLink?: () => Promise<void>,
  ) {
    if (!follows(slot.entry, entry)) incomplete();
    const root = await this.ensure(signal);
    try {
      await publishDiskPoolRecord(
        join(root, `${slot.index}.${slot.revision + 1}.json`),
        entry,
        { signal, beforeLink },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST')
        throw new PersonVmError('LEASE_CONFLICT', { cause: error });
      throw error;
    }
  }
}
