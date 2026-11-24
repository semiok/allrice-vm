import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  ChecksumSchema,
  HostHistoryBindingSchema,
  UuidSchema,
  type HostHistoryBinding,
  type HostHistorySnapshot,
  type HostHistoryStorePort,
} from '@allrice/contracts';
import {
  hostHistoryDigest,
  HostHistoryIntegrityError,
} from './host-history.ts';

const ref = z.string().min(1);
const number = z.number().int().nonnegative().safe();
const header = z
  .object({
    id: ref,
    version: z.literal(4),
    createdAt: number,
  })
  .catchall(z.json());
const catalog = z
  .object({
    seq: number,
    time: number,
    type: z.literal('subagent/catalog'),
    data: z
      .object({
        version: z.union([z.literal(0), z.literal(1)]),
        childId: ref,
        childCreatedAt: number,
        mode: z.enum(['one-shot', 'continuable']),
        label: z.string().optional(),
      })
      .strict(),
  })
  .catchall(z.json());

export const HostHistorySourceKeySchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    personId: UuidSchema,
    employeeInstanceId: UuidSchema,
    threadId: UuidSchema,
    rootNativeSessionId: ref,
    rootOriginDigest: ChecksumSchema,
    rootBindingRef: ref,
    vmId: UuidSchema,
  })
  .strict();
export type HostHistorySourceKey = z.infer<typeof HostHistorySourceKeySchema>;

/** Original facts supplied by the host writer, never reconstructed from the
 * current employee configuration. Each session is a separate observed cut. */
export const HostHistorySourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    key: HostHistorySourceKeySchema,
    sessions: z
      .array(
        z
          .object({
            binding: HostHistoryBindingSchema,
            snapshotDigest: ChecksumSchema,
            header,
          })
          .strict(),
      )
      .min(1),
    edges: z.array(
      z
        .object({
          parentNativeSessionId: ref,
          childNativeSessionId: ref,
          parentEvent: catalog,
        })
        .strict(),
    ),
  })
  .strict();
export type HostHistorySource = z.infer<typeof HostHistorySourceSchema>;
export type CommittedHostHistorySource = Readonly<{
  digest: string;
  manifest: HostHistorySource;
}>;
const CommittedSourceSchema = z
  .object({
    index: number,
    previous: ChecksumSchema.nullable(),
    digest: ChecksumSchema,
    manifest: HostHistorySourceSchema,
  })
  .strict();
const legacyManifestName = /^[a-f0-9]{64}\.json$/;
const commitName = (index: number) => `commit-${index}.json`;

function fail(): never {
  throw new HostHistoryIntegrityError();
}
function same(a: unknown, b: unknown) {
  return hostHistoryDigest(a) === hostHistoryDigest(b);
}

async function readManifest(
  directory: string,
  name: string,
  signal: AbortSignal,
  slot?: { index: number; previous: string | null },
): Promise<CommittedHostHistorySource & { commitDigest?: string }> {
  signal.throwIfAborted();
  const file = await open(
    join(directory, name),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const value: unknown = JSON.parse(
      await file.readFile({ encoding: 'utf8', signal }),
    );
    const source = slot
      ? CommittedSourceSchema.parse(value)
      : {
          digest: `sha256:${name.slice(0, -5)}`,
          manifest: HostHistorySourceSchema.parse(value),
        };
    if (hostHistoryDigest(source.manifest) !== source.digest) fail();
    if (
      slot &&
      (!('index' in source) ||
        source.index !== slot.index ||
        source.previous !== slot.previous)
    )
      fail();
    return {
      digest: source.digest,
      manifest: source.manifest,
      ...(slot ? { commitDigest: hostHistoryDigest(source) } : {}),
    };
  } catch {
    signal.throwIfAborted();
    return fail();
  } finally {
    await file.close();
  }
}

function contentDigest(manifest: HostHistorySource) {
  return hostHistoryDigest({
    ...manifest,
    sessions: Object.fromEntries(
      manifest.sessions.map((row) => [row.binding.nativeSessionId, row]),
    ),
    edges: Object.fromEntries(
      manifest.edges.map((row) => [row.childNativeSessionId, row]),
    ),
  });
}

/** Validate the complete ancestry against the exact referenced snapshots.
 * Header.parentSession is fork lineage and is deliberately not an edge. */
async function validate(
  manifest: HostHistorySource,
  raw: HostHistoryStorePort,
  signal: AbortSignal,
): Promise<Map<string, HostHistorySnapshot>> {
  const snapshots = new Map<string, HostHistorySnapshot>();
  for (const row of manifest.sessions) {
    const b = row.binding,
      key = manifest.key;
    if (
      snapshots.has(b.nativeSessionId) ||
      b.nativeSessionId !== row.header.id ||
      b.rootNativeSessionId !== key.rootNativeSessionId ||
      (
        [
          'organizationId',
          'workspaceId',
          'personId',
          'employeeInstanceId',
          'threadId',
        ] as const
      ).some((field) => b[field] !== key[field])
    )
      fail();
    const stored = await raw.read(b, signal, row.snapshotDigest);
    signal.throwIfAborted();
    if (
      !stored ||
      stored.digest !== row.snapshotDigest ||
      hostHistoryDigest(stored.snapshot) !== row.snapshotDigest ||
      !same(stored.snapshot.binding, b) ||
      hostHistoryDigest(row.header) !== stored.snapshot.source.headerHash
    )
      fail();
    snapshots.set(b.nativeSessionId, stored.snapshot);
  }
  const root = manifest.sessions.find(
    (row) => row.binding.nativeSessionId === manifest.key.rootNativeSessionId,
  );
  if (
    !root ||
    root.binding.parentNativeSessionId !== null ||
    manifest.edges.length !== manifest.sessions.length - 1
  )
    fail();
  const parents = new Map<string, string>();
  for (const edge of manifest.edges) {
    const parent = snapshots.get(edge.parentNativeSessionId);
    const child = manifest.sessions.find(
      (row) => row.binding.nativeSessionId === edge.childNativeSessionId,
    );
    const event = edge.parentEvent;
    if (
      !parent ||
      !child ||
      parents.has(edge.childNativeSessionId) ||
      child.binding.parentNativeSessionId !== edge.parentNativeSessionId ||
      event.data.childId !== edge.childNativeSessionId ||
      event.data.childCreatedAt !== child.header.createdAt ||
      (event.data.mode === 'continuable' && event.data.label === undefined) ||
      event.seq < parent.source.inheritedEventCount ||
      parent.source.eventHashes[event.seq] !== hostHistoryDigest(event)
    )
      fail();
    parents.set(edge.childNativeSessionId, edge.parentNativeSessionId);
  }
  for (const row of manifest.sessions) {
    let id = row.binding.nativeSessionId;
    const seen = new Set<string>();
    while (id !== manifest.key.rootNativeSessionId) {
      if (seen.has(id)) fail();
      seen.add(id);
      const parent = parents.get(id);
      if (parent === undefined) fail();
      id = parent;
    }
  }
  signal.throwIfAborted();
  return snapshots;
}

/** Comparable prefix vectors only. Neither wall time nor filename order elects
 * a winner. A crossed vector or changed original binding is an integrity error. */
function compare(
  a: HostHistorySource,
  b: HostHistorySource,
  aSnapshots: Map<string, HostHistorySnapshot>,
  bSnapshots: Map<string, HostHistorySnapshot>,
): number {
  if (!same(a.key, b.key)) fail();
  let direction = 0;
  const ids = new Set(
    [...a.sessions, ...b.sessions].map((row) => row.binding.nativeSessionId),
  );
  for (const id of ids) {
    const x = a.sessions.find((row) => row.binding.nativeSessionId === id);
    const y = b.sessions.find((row) => row.binding.nativeSessionId === id);
    let change: number;
    if (!x || !y) change = x ? 1 : -1;
    else {
      if (!same(x.binding, y.binding) || !same(x.header, y.header)) fail();
      const left = aSnapshots.get(id)!.source,
        right = bSnapshots.get(id)!.source;
      if (
        left.headerHash !== right.headerHash ||
        left.inheritedEventCount !== right.inheritedEventCount ||
        left.eventHashes
          .slice(0, right.eventHashes.length)
          .some(
            (hash, index) =>
              right.eventHashes[index] !== undefined &&
              hash !== right.eventHashes[index],
          )
      )
        fail();
      change = Math.sign(left.throughSeq - right.throughSeq);
    }
    if (direction && change && direction !== change) fail();
    direction ||= change;
  }
  return direction;
}

/** Immutable manifests are committed last, outside the VM. There is no latest
 * pointer, authority cache, GC, scheduling or execution/resume dependency. */
export class HostHistorySourceStore {
  private readonly verified = new WeakMap<
    CommittedHostHistorySource,
    CommittedHostHistorySource
  >();
  constructor(
    private readonly root: string,
    private readonly raw: HostHistoryStorePort,
  ) {
    if (!isAbsolute(root)) fail();
  }
  private directory(key: HostHistorySourceKey) {
    return join(
      this.root,
      'sources',
      hostHistoryDigest(HostHistorySourceKeySchema.parse(key)).slice(7),
    );
  }
  async read(
    keyInput: HostHistorySourceKey,
    signal: AbortSignal,
    requestedSnapshot?: Readonly<{
      nativeSessionId: string;
      snapshotDigest: string;
    }>,
  ): Promise<CommittedHostHistorySource | null> {
    const key = HostHistorySourceKeySchema.parse(keyInput);
    const requested = requestedSnapshot && {
      nativeSessionId: ref.parse(requestedSnapshot.nativeSessionId),
      snapshotDigest: ChecksumSchema.parse(requestedSnapshot.snapshotDigest),
    };
    const { selected } = await this.readCommitted(key, signal, requested);
    if (selected) this.verified.set(selected, structuredClone(selected));
    return selected;
  }
  private async readCommitted(
    key: HostHistorySourceKey,
    signal: AbortSignal,
    requested?: Readonly<{ nativeSessionId: string; snapshotDigest: string }>,
  ) {
    signal.throwIfAborted();
    const directory = this.directory(key);
    const digests = new Map<string, string>();
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      signal.throwIfAborted();
      return {
        selected: null,
        selectedSnapshots: undefined,
        digests,
        slot: { index: 0, previous: null },
      };
    }
    const commits = new Set(
      names.filter((name) => /^commit-.*\.json$/.test(name)),
    );
    const legacy = names.filter((name) => legacyManifestName.test(name)).sort();
    let previous = legacy.length ? hostHistoryDigest(legacy) : null;
    const ordered = [...legacy];
    for (let index = 0; index < commits.size; index++) {
      const name = commitName(index);
      if (!commits.has(name)) fail();
      ordered.push(name);
    }
    let selected: CommittedHostHistorySource | null = null;
    let selectedSnapshots: Map<string, HostHistorySnapshot> | undefined;
    const candidates: {
      manifest: HostHistorySource;
      snapshots: Map<string, HostHistorySnapshot>;
    }[] = [];
    for (const [index, name] of ordered.entries()) {
      const { digest, manifest, commitDigest } = await readManifest(
        directory,
        name,
        signal,
        index < legacy.length
          ? undefined
          : { index: index - legacy.length, previous },
      );
      if (commitDigest) previous = commitDigest;
      if (!same(manifest.key, key)) fail();
      const snapshots = await validate(manifest, this.raw, signal);
      for (const previous of candidates)
        compare(manifest, previous.manifest, snapshots, previous.snapshots);
      candidates.push({ manifest, snapshots });
      const content = contentDigest(manifest);
      if (!digests.has(content)) digests.set(content, digest);
      // Still validate/compare every committed vector. A browser digest may
      // only select a manifest that actually committed this exact member.
      if (
        requested &&
        !manifest.sessions.some(
          (row) =>
            row.binding.nativeSessionId === requested.nativeSessionId &&
            row.snapshotDigest === requested.snapshotDigest,
        )
      )
        continue;
      if (selected) {
        const direction = compare(
          manifest,
          selected.manifest,
          snapshots,
          selectedSnapshots!,
        );
        if (direction < 0 || (direction === 0 && digest < selected.digest))
          continue;
      }
      selected = { digest, manifest };
      selectedSnapshots = snapshots;
    }
    signal.throwIfAborted();
    if (requested && !selected) fail();
    return {
      selected,
      selectedSnapshots,
      digests,
      slot: { index: commits.size, previous },
    };
  }
  async publish(
    input: HostHistorySource,
    signal: AbortSignal,
  ): Promise<string> {
    const manifest = HostHistorySourceSchema.parse(input);
    const snapshots = await validate(manifest, this.raw, signal);
    const digest = hostHistoryDigest(manifest),
      directory = this.directory(manifest.key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const content = contentDigest(manifest);
    for (;;) {
      const { selected, selectedSnapshots, digests, slot } =
        await this.readCommitted(manifest.key, signal);
      const committed = digests.get(content);
      if (committed) return committed;
      if (
        selected &&
        compare(manifest, selected.manifest, snapshots, selectedSnapshots!) < 0
      )
        fail();
      // A lost atomic claim leaves only private staging bytes. Verify the
      // winner and retry only if this immutable cut still extends that history.
      if (await this.commit(directory, { ...slot, digest, manifest }, signal))
        return digest;
    }
  }
  private async commit(
    directory: string,
    record: z.infer<typeof CommittedSourceSchema>,
    signal: AbortSignal,
  ) {
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(record), {
        encoding: 'utf8',
        signal,
      });
      await file.sync();
      await file.close();
      signal.throwIfAborted();
      try {
        await link(temporary, join(directory, commitName(record.index)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return false;
      }
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
    signal.throwIfAborted();
    return true;
  }
  /** One request's immutable selection. Never reselect on subsequent page,
   * download or reauthorization calls. Explicit uncommitted digests refuse. */
  committedStore(selected: CommittedHostHistorySource): HostHistoryStorePort {
    const verified = this.verified.get(selected);
    if (
      !verified ||
      verified.digest !== selected.digest ||
      verified.digest !== hostHistoryDigest(selected.manifest)
    )
      fail();
    const { manifest } = verified;
    return {
      async publish() {
        return fail();
      },
      read: async (
        binding: HostHistoryBinding,
        signal: AbortSignal,
        digest?: string,
      ) => {
        signal.throwIfAborted();
        const row = manifest.sessions.find((row) => same(row.binding, binding));
        if (!row || (digest !== undefined && digest !== row.snapshotDigest))
          fail();
        const stored = await this.raw.read(
          row.binding,
          signal,
          row.snapshotDigest,
        );
        signal.throwIfAborted();
        if (
          !stored ||
          stored.digest !== row.snapshotDigest ||
          !same(stored.snapshot.binding, row.binding) ||
          hostHistoryDigest(stored.snapshot) !== row.snapshotDigest
        )
          fail();
        return stored;
      },
    };
  }
}
