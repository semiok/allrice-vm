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
import { dirname, join } from 'node:path';
import { UuidSchema } from '@allrice/contracts';
import { PersonVmError } from './contract.ts';
import {
  sameDiskPoolOwner,
  type DiskPoolClaim,
  type DiskPoolStock,
} from './disk-pool-platform.ts';

export const diskPoolSize = 3;
const maxRecordBytes = 8 * 1024;
const recordName = /^([0-2])\.([1-9][0-9]*)\.json$/;
const stageName = /^\.stage-[0-9a-f-]{36}$/;

export type DiskPoolRecord =
  | (DiskPoolStock & { state: 'filling' })
  | (DiskPoolStock & { state: 'released-before-write' })
  | (DiskPoolStock & { state: 'ready'; proof: string })
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
export async function syncDiskPoolDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Create and publish an immutable record. Link is the compare-and-set; a
 * disconnected advisory session cannot overwrite a successor's record. */
export async function publishDiskPoolRecord(path: string, value: unknown) {
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
    previous.state === 'released-before-write'
  )
    return entry.state === 'filling';
  if (entry.ref !== previous.ref || entry.source !== previous.source)
    return false;
  if (previous.state === 'filling')
    return (
      entry.state === 'ready' ||
      entry.state === 'quarantined' ||
      entry.state === 'released-before-write'
    );
  if (previous.state === 'ready') {
    return (
      entry.state === 'quarantined' ||
      (entry.state === 'claiming' && entry.proof === previous.proof)
    );
  }
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
  private readonly root: string;
  private seen = false;
  constructor(diskRoot: string) {
    this.root = join(diskRoot, '.preprovision-ledger');
  }
  private async exists() {
    const stat = await lstat(this.root).catch((error: unknown) => {
      if (!missing(error)) throw error;
      return null;
    });
    if (!stat) {
      if (this.seen) incomplete();
      return false;
    }
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o7777) !== 0o700 ||
      (await realpath(this.root)) !== this.root
    )
      incomplete();
    this.seen = true;
    return true;
  }
  async read(signal: AbortSignal) {
    const slots: DiskPoolSlot[] = Array.from(
      { length: diskPoolSize },
      (_, index) => ({
        index,
        revision: 0,
        entry: null,
      }),
    );
    const bound = new Map<string, DiskPoolClaim>();
    signal.throwIfAborted();
    if (await this.exists()) {
      const files = (await readdir(this.root))
        .flatMap((name) => {
          if (stageName.test(name)) return [];
          const match = recordName.exec(name);
          if (!match) return incomplete();
          return [
            { name, index: Number(match[1]), revision: Number(match[2]) },
          ];
        })
        .sort((a, b) => a.index - b.index || a.revision - b.revision);
      // A writer which lost its SQL session after linking might have been
      // interrupted before its fsync. Make this observed prefix durable.
      await syncDiskPoolDirectory(this.root);
      const refs = new Set<string>();
      const intents = new Set<string>();
      for (const { name, index, revision } of files) {
        signal.throwIfAborted();
        const slot = slots[index]!;
        if (!Number.isSafeInteger(revision) || revision !== slot.revision + 1)
          incomplete();
        const file = await open(
          join(this.root, name),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        let entry: DiskPoolRecord;
        try {
          const stat = await file.stat();
          if (
            !stat.isFile() ||
            stat.uid !== process.getuid?.() ||
            (stat.mode & 0o7777) !== 0o600 ||
            stat.size > maxRecordBytes
          )
            incomplete();
          entry = readRecord(JSON.parse(await file.readFile('utf8')));
        } finally {
          await file.close();
        }
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
        }
        slots[index] = { index, revision, entry };
      }
    }
    signal.throwIfAborted();
    return { slots, bound };
  }

  async append(slot: DiskPoolSlot, entry: DiskPoolRecord, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!follows(slot.entry, entry)) incomplete();
    if (!(await this.exists())) {
      try {
        await mkdir(this.root, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      }
      if (!(await this.exists())) incomplete();
      await syncDiskPoolDirectory(dirname(this.root));
    }
    signal.throwIfAborted();
    try {
      await publishDiskPoolRecord(
        join(this.root, `${slot.index}.${slot.revision + 1}.json`),
        entry,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST')
        throw new PersonVmError('LEASE_CONFLICT', { cause: error });
      throw error;
    }
  }
}
