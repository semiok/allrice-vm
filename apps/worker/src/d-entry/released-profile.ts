import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  DEntryProfileAddressSchema,
  DEntryProfileChunkFilenameSchema,
  DEntryProfileFilePathSchema,
  DEntryProfileGraphSchema,
  DEntryProfileInjectionSchema,
} from '@allrice/contracts';
import {
  DataAccessError,
  readServiceBuildIdentity,
  ServiceBuildManifestSchema,
} from '@allrice/database';
import { DEntryNativeUnavailable } from './native-owner.js';

/** Trusted same-Host reader. Its implementation must read the actual current
 * immutable clientModules graph from the existing leased native profile. */
export interface DEntryFixedProfileSource {
  readonly revoked: AbortSignal;
  /** Opaque identity of the actual native owner for this employee and epoch. */
  readonly verificationOwner?: object;
  readImmutableGraph(signal: AbortSignal): Promise<unknown>;
  readImmutableBundle(
    reference: string,
    expectedBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}
const hash = (value: Buffer) =>
  createHash('sha256').update(value).digest('hex');
const workerReleasePath = 'apps/worker/dist/d-entry-web';
export type EmployeeWebReleaseSeal = Readonly<{
  directory: string;
  manifestSha256: string;
}>;

/** Only the actual production Worker installation can select this artifact. */
export async function readWorkerEmployeeWebSeal(signal: AbortSignal) {
  signal.throwIfAborted();
  const identity = await readServiceBuildIdentity('worker');
  const entrypoint = process.argv[1];
  if (identity?.mode !== 'production' || !entrypoint)
    throw new DEntryNativeUnavailable();
  const installed = await realpath(entrypoint);
  const suffix = '/apps/worker/dist/index.js';
  if (!installed.endsWith(suffix)) throw new DEntryNativeUnavailable();
  const root = installed.slice(0, -suffix.length);
  const releaseManifest = ServiceBuildManifestSchema.parse(
    JSON.parse(
      await readFile(join(root, '.local/dev-build-identity.json'), {
        encoding: 'utf8',
        signal,
      }),
    ),
  );
  const { manifestDigest, ...body } = releaseManifest;
  if (
    manifestDigest !== identity.manifestDigest ||
    'sha256:' + hash(Buffer.from(JSON.stringify(body))) !== manifestDigest
  )
    throw new DEntryNativeUnavailable();
  const artifact = releaseManifest.files.find(
    (file) =>
      file.scope === 'worker' &&
      file.path === workerReleasePath + '/artifact.json',
  );
  if (!artifact) throw new DEntryNativeUnavailable();
  signal.throwIfAborted();
  return Object.freeze({
    directory: join(root, workerReleasePath),
    manifestSha256: artifact.checksum.slice('sha256:'.length),
  }) satisfies EmployeeWebReleaseSeal;
}
const bytesEntry = z.object({
  path: DEntryProfileFilePathSchema,
  bytes: z.number().int().min(1),
  sha256: DEntryProfileAddressSchema.shape.manifestSha256,
});
const manifestSchema = z.object({
  format: z.literal(1),
  status: z.literal('code-artifacts-only'),
  source: z.object({ dirty: z.literal(false) }),
  nativeRelease: z.object({
    name: z.literal('@deepseek-ai/dsh-web-frontend'),
    version: z.literal('0.2.1-rc.2'),
  }),
  closure: z.strictObject({
    publicNativeDist: z.literal(true),
    sourceBuiltContribution: z.literal(true),
    profileScripts: z.literal(true),
    managedEntry: z.literal(true),
  }),
  files: z.array(bytesEntry).min(1),
  profile: z.object({
    graph: DEntryProfileGraphSchema,
    bootInjections: z.array(DEntryProfileInjectionSchema).min(1),
    files: z.array(bytesEntry.extend({ reference: z.string().min(1) })).min(1),
    chunks: z
      .array(
        z.strictObject({
          module: z.string().min(1),
          file: DEntryProfileChunkFilenameSchema,
        }),
      )
      .default([]),
    sourceBuiltClient: z.literal(true),
  }),
  managedEntry: z.literal('managed/employee-web-entry.js'),
});
const nativeAliases = new Set([
  'assets/index-CN7NIWNw.js',
  'assets/vendor-DcuzkuQH.js',
  'assets/vendor-DV2921Zo.css',
  'assets/index-BxpfOGf3.css',
]);
const mime = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.map', 'application/json'],
  ['.json', 'application/json'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.webp', 'image/webp'],
  ['.wasm', 'application/wasm'],
]);
function verified<T>(values: readonly T[], key: (value: T) => string) {
  const map = new Map(values.map((value) => [key(value), value]));
  if (map.size !== values.length) throw new DEntryNativeUnavailable();
  return map;
}

type Graph = z.infer<typeof DEntryProfileGraphSchema>;
type Resource = { url: string; rev: string };
const guestAttestations = new WeakMap<
  object,
  { key: string; verified: Promise<void> }
>();
async function waitForGuestProof(proof: Promise<void>, caller: AbortSignal) {
  caller.throwIfAborted();
  let cancel!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(caller.reason);
    caller.addEventListener('abort', cancel, { once: true });
  });
  try {
    await Promise.race([proof, stopped]);
    caller.throwIfAborted();
  } finally {
    caller.removeEventListener('abort', cancel);
  }
}
const parallelGuestEntries = 4;
type SealedFiles = Map<string, Promise<Buffer>>;
let loadedRelease: { key: string; files: SealedFiles } | undefined;

function sealedFilesFor(frozenRoot: string, digest: string) {
  const key = JSON.stringify([frozenRoot, digest]);
  if (loadedRelease?.key !== key) loadedRelease = { key, files: new Map() };
  return loadedRelease.files;
}

async function verifyReleaseBytes(
  frozenRoot: string,
  row: z.infer<typeof bytesEntry>,
  signal: AbortSignal,
  files?: SealedFiles,
) {
  signal.throwIfAborted();
  async function readChecked() {
    const selected = resolve(frozenRoot, row.path);
    if (
      !selected.startsWith(frozenRoot + sep) ||
      (await realpath(selected)) !== selected
    )
      throw new DEntryNativeUnavailable();
    const data = await readFile(selected, { signal });
    signal.throwIfAborted();
    if (data.length !== row.bytes || hash(data) !== row.sha256)
      throw new DEntryNativeUnavailable();
    return data;
  }
  if (!files) return readChecked();
  let pending = files.get(row.path);
  if (!pending) {
    const read = readChecked();
    files.set(row.path, read);
    void read.catch(() => {
      if (files.get(row.path) === read) files.delete(row.path);
    });
    pending = read;
  }
  const data = await pending;
  signal.throwIfAborted();
  return data;
}

const parserModule = '@deepseek-ai/dsh-client-modules';

function topology({
  id,
  inject,
  immediately,
  external,
}: Graph['entries'][number]) {
  return { id, inject, immediately, external };
}

function rc2Resource(ids: readonly string[], rev: string, map: boolean) {
  if (
    ids.some(
      (id) => !/^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/i.test(id),
    )
  )
    throw new DEntryNativeUnavailable();
  return (
    'plugins/??' +
    ids.map((id) => id + (map ? '/client.js.map' : '/client.js')).join(',') +
    '&rev=' +
    rev
  );
}

function mapTrailer(reference: string) {
  return Buffer.from(
    '//# sourceMappingURL=' + reference.slice('plugins/'.length) + '\n',
  );
}
function withoutMapTrailer(data: Buffer, reference: string) {
  const original = mapTrailer(reference);
  if (!data.subarray(-original.byteLength).equals(original))
    throw new DEntryNativeUnavailable();
  return data.subarray(0, -original.byteLength);
}

/** In rc.2, native scan order breaks ties between independent modules. The
 * dependency edges, parser module, URL limits and combo identity remain exact. */
function assertNativeGraph(graph: Graph, sealed: Graph) {
  if (!isDeepStrictEqual(graph.release, sealed.release))
    throw new DEntryNativeUnavailable('release');
  const nodes = verified(graph.entries, ({ id }) => id);
  const sealedNodes = verified(sealed.entries, ({ id }) => id);
  if (nodes.size !== sealedNodes.size)
    throw new DEntryNativeUnavailable('entries.length');
  const started = new Set<string>();
  for (const [index, entry] of graph.entries.entries()) {
    const original = sealedNodes.get(entry.id);
    if (!original) throw new DEntryNativeUnavailable(`entries[${index}].id`);
    if (
      entry.url !== rc2Resource([entry.id], entry.rev, false) ||
      !/^[a-f0-9]{12}$/.test(entry.rev) ||
      !isDeepStrictEqual(topology(entry), topology(original))
    )
      throw new DEntryNativeUnavailable(`entries[${index}].url/rev/topology`);
    for (const external of entry.external ?? []) {
      const name = nodes.has(external)
        ? external
        : external.replace(/\/client$/, '');
      if (
        nodes.has(name) &&
        (!started.has(name) ||
          (entry.id === parserModule && name !== parserModule))
      )
        throw new DEntryNativeUnavailable(`entries[${index}].external.order`);
    }
    started.add(entry.id);
  }
  const batches: Graph['batches'] = [];
  function append(phase: Graph['batches'][number]['phase'], entries: string[]) {
    const digest = createHash('sha1').update('combo\0');
    for (const id of entries) {
      const revision = nodes.get(id)!.rev;
      for (const part of [id, revision])
        digest.update(String(Buffer.byteLength(part)) + ':').update(part);
    }
    const rev = digest.digest('hex').slice(0, 12);
    batches.push({
      phase,
      rev,
      entries,
      url: rc2Resource(entries, rev, false),
    });
  }
  if (!nodes.has(parserModule)) throw new DEntryNativeUnavailable('parser.id');
  append('bootstrap', [parserModule]);
  let group: string[] = [];
  for (const { id } of graph.entries) {
    if (id === parserModule) continue;
    const candidate = [...group, id];
    if (
      Buffer.byteLength(rc2Resource(candidate, '0'.repeat(12), true)) >
      3 * 1024
    ) {
      if (!group.length) throw new DEntryNativeUnavailable('batches.url.size');
      append('application', group);
      group = [id];
    } else group = candidate;
  }
  if (group.length) append('application', group);
  if (!isDeepStrictEqual(graph.batches, batches))
    throw new DEntryNativeUnavailable('batches.phase/url/rev/entries');
  const revision = createHash('sha1')
    .update(JSON.stringify({ entries: graph.entries, batches: graph.batches }))
    .digest('hex')
    .slice(0, 12);
  if (graph.rev !== revision) throw new DEntryNativeUnavailable('rev');
}

async function readManifest(
  directory: string,
  active: AbortSignal,
  manifestSha256?: string,
) {
  active.throwIfAborted();
  const frozenRoot = await realpath(directory);
  const raw = await readFile(join(frozenRoot, 'artifact.json'), {
    signal: active,
  });
  if (manifestSha256 && hash(raw) !== manifestSha256)
    throw new DEntryNativeUnavailable();
  return {
    frozenRoot,
    digest: manifestSha256 ?? hash(raw),
    manifest: manifestSchema.parse(JSON.parse(raw.toString('utf8'))),
  };
}

const isStatic = (path: string) =>
  path.startsWith('managed/') ||
  (path.startsWith('native/assets/') &&
    (nativeAliases.has(path.slice('native/'.length)) ||
      /\.(?:woff2?|ttf)$/.test(path)));

/** Snapshot bytes from the installed, sealed Worker release before it can
 * publish a page. All later consumers read the retained, checked bytes. */
export async function primeWorkerEmployeeWebRelease(signal: AbortSignal) {
  const seal = await readWorkerEmployeeWebSeal(signal);
  const { frozenRoot, manifest } = await readManifest(
    seal.directory,
    signal,
    seal.manifestSha256,
  );
  const files = sealedFilesFor(frozenRoot, seal.manifestSha256);
  for (const file of verified(manifest.files, (row) => row.path).values()) {
    if (isStatic(file.path) || file.path.startsWith('plugins/'))
      await verifyReleaseBytes(frozenRoot, file, signal, files);
  }
}

const guestFiles = [
  ['guest/profiles/allrice-web/package.json', 'package.json'],
  [
    'guest/package.json',
    'node_modules/@allrice/dsh-web-composition/package.json',
  ],
  [
    'guest/cordis.patch.yml',
    'node_modules/@allrice/dsh-web-composition/cordis.patch.yml',
  ],
  ['guest/index.mjs', 'node_modules/@allrice/dsh-web-composition/index.mjs'],
  [
    'guest/host/settings-models.mjs',
    'node_modules/@allrice/dsh-web-composition/host/settings-models.mjs',
  ],
  [
    'guest/host/settings-account.mjs',
    'node_modules/@allrice/dsh-web-composition/host/settings-account.mjs',
  ],
  [
    'guest/host/plugin-manager.mjs',
    'node_modules/@allrice/dsh-web-composition/host/plugin-manager.mjs',
  ],
  [
    'allrice/client.js',
    'node_modules/@allrice/dsh-web-composition/dist/client.js',
  ],
] as const;

/** Material for the exact employee profile under the existing guest bootstrap.
 * In-box bundles continue to resolve from the sealed rc.2 CLI installation. */
export async function readReleasedGuestProfile(
  seal: EmployeeWebReleaseSeal,
  signal: AbortSignal,
) {
  const { frozenRoot, manifest } = await readManifest(
    seal.directory,
    signal,
    seal.manifestSha256,
  );
  const inventory = verified(manifest.files, (entry) => entry.path);
  const staged = [];
  for (const [path, destination] of guestFiles) {
    const proof = inventory.get(path);
    if (!proof) throw new DEntryNativeUnavailable();
    const bytes = await verifyReleaseBytes(frozenRoot, proof, signal);
    const contents = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    staged.push(Object.freeze({ path: destination, contents }));
  }
  signal.throwIfAborted();
  return Object.freeze(staged);
}

export async function holdReleasedProfile(
  directory: string,
  source: DEntryFixedProfileSource,
  signal: AbortSignal,
  manifestSha256?: string,
) {
  const active = AbortSignal.any([signal, source.revoked]);
  const {
    frozenRoot,
    digest: manifestDigest,
    manifest,
  } = await readManifest(directory, active, manifestSha256);
  const sealedFiles = manifestSha256
    ? sealedFilesFor(frozenRoot, manifestSha256)
    : undefined;
  const { graph: sealedGraph, bootInjections } = manifest.profile;
  const graph = DEntryProfileGraphSchema.parse(
    await source.readImmutableGraph(active),
  );
  active.throwIfAborted();
  assertNativeGraph(sealedGraph, sealedGraph);
  assertNativeGraph(graph, sealedGraph);
  const files = verified(manifest.files, (entry) => entry.path);
  const refs = verified(
    [...sealedGraph.entries, ...sealedGraph.batches],
    (entry) => entry.url,
  );
  const modules = verified(sealedGraph.entries, (entry) => entry.id);
  const bundles = verified(manifest.profile.files, (entry) => entry.reference);
  const partition = sealedGraph.batches.flatMap((part) => part.entries);
  if (
    modules.has('@deepseek-ai/dsh-client-hmr') ||
    !modules.has('@allrice/dsh-web-composition') ||
    !modules.has(parserModule) ||
    partition.length !== modules.size ||
    new Set(partition).size !== modules.size ||
    partition.some((id) => !modules.has(id))
  )
    throw new DEntryNativeUnavailable();
  for (const [url] of refs) {
    const row = bundles.get(url);
    if (
      !row ||
      !row.path.startsWith('plugins/') ||
      !isDeepStrictEqual(files.get(row.path), {
        path: row.path,
        bytes: row.bytes,
        sha256: row.sha256,
      })
    )
      throw new DEntryNativeUnavailable();
  }
  if (
    bootInjections[0]?.kind !== 'script' ||
    bootInjections.filter((row) => row.kind === 'script').length !== 1 ||
    bootInjections.some((row) => {
      if (row.kind === 'global')
        return (
          row.name !== '__DSH_BOOT__' ||
          !isDeepStrictEqual(row.value, sealedGraph)
        );
      if (row.kind === 'script') return row.text.includes('__DSH_BOOT_READY__');
      return !sealedGraph.batches.some(
        (batch) =>
          batch.url === row.src &&
          batch.phase ===
            (row.kind === 'script-src' ? 'bootstrap' : 'application'),
      );
    }) ||
    bootInjections.filter((row) => row.kind === 'global').length !== 1 ||
    bootInjections.filter(
      (row) => row.kind === 'script-src' || row.kind === 'script-preload',
    ).length !== sealedGraph.batches.length
  )
    throw new DEntryNativeUnavailable();
  for (const pathname of [
    manifest.managedEntry,
    'managed/employee-web-entry.css',
    ...[...nativeAliases].map((alias) => 'native/' + alias),
  ])
    if (!files.has(pathname)) throw new DEntryNativeUnavailable();

  async function assertCurrent(caller: AbortSignal) {
    const current = AbortSignal.any([active, caller]);
    current.throwIfAborted();
    const actual = DEntryProfileGraphSchema.parse(
      await source.readImmutableGraph(current),
    );
    current.throwIfAborted();
    if (!isDeepStrictEqual(actual, graph)) throw new DEntryNativeUnavailable();
  }
  async function readBytes(
    row: z.infer<typeof bytesEntry>,
    current: AbortSignal,
  ) {
    const media = mime.get(extname(row.path));
    if (!media) throw new DEntryNativeUnavailable();
    return {
      data: await verifyReleaseBytes(frozenRoot, row, current, sealedFiles),
      media,
    };
  }
  async function read(path: string | undefined, caller: AbortSignal) {
    const row = path && files.get(path);
    if (!row) throw new DataAccessError('not_found');
    const current = AbortSignal.any([active, caller]);
    await assertCurrent(current);
    const result = await readBytes(row, current);
    await assertCurrent(current);
    // The wire consumer must not be able to mutate the release snapshot.
    return { ...result, data: Buffer.from(result.data) };
  }
  const checked = new Map(
    [
      ...graph.entries.map((entry) => ({ ...entry, entries: [entry.id] })),
      ...graph.batches,
    ].map((entry) => [entry.url, entry] as const),
  );
  if (checked.size !== graph.entries.length + graph.batches.length)
    throw new DEntryNativeUnavailable();
  function proof(reference: string) {
    const row = bundles.get(reference);
    if (
      !row ||
      !row.path.startsWith('plugins/') ||
      !isDeepStrictEqual(files.get(row.path), {
        path: row.path,
        bytes: row.bytes,
        sha256: row.sha256,
      })
    )
      throw new DEntryNativeUnavailable();
    return row;
  }
  const liveModules = verified(graph.entries, ({ id }) => id);
  const chunks = verified(
    manifest.profile.chunks.map(({ module, file }) => {
      const live = liveModules.get(module);
      const sealed = modules.get(module);
      if (!live || !sealed) throw new DEntryNativeUnavailable();
      const name = `plugins/${module}/${file}`;
      return {
        reference: `${name}?rev=${live.rev}`,
        rev: live.rev,
        row: proof(`${name}?rev=${sealed.rev}`),
      };
    }),
    ({ reference }) => reference,
  );
  async function readEntry(id: string, signal: AbortSignal) {
    const sealed = modules.get(id);
    if (!sealed) throw new DEntryNativeUnavailable();
    const map = rc2Resource([id], sealed.rev, true);
    const { data, media } = await readBytes(proof(sealed.url), signal);
    return { data: withoutMapTrailer(data, map), media, map };
  }
  async function readCombo(
    ids: readonly string[],
    map: string,
    current: AbortSignal,
  ) {
    const scripts: Buffer[] = [];
    const nativeMaps: { reference: string; line: number }[] = [];
    let line = 0;
    for (const id of ids) {
      const entry = await readEntry(id, current);
      scripts.push(entry.data);
      nativeMaps.push({ reference: entry.map, line });
      for (const byte of entry.data) if (byte === 10) line++;
    }
    return {
      data: Buffer.concat([...scripts, mapTrailer(map)]),
      media: 'text/javascript; charset=utf-8',
      async sourceMap(signal: AbortSignal) {
        const sections = [];
        for (const { reference, line } of nativeMaps) {
          const { data } = await readBytes(proof(reference), signal);
          const singleton = z
            .strictObject({
              version: z.literal(3),
              file: z.literal('client.js'),
              sections: z.tuple([
                z.strictObject({
                  offset: z.strictObject({
                    line: z.literal(0),
                    column: z.literal(0),
                  }),
                  map: z.json(),
                }),
              ]),
            })
            .parse(JSON.parse(data.toString('utf8')));
          sections.push({
            offset: { line, column: 0 },
            map: singleton.sections[0].map,
          });
        }
        return Buffer.from(
          JSON.stringify({ version: 3, file: 'client.js', sections }) + '\n',
        );
      },
    };
  }

  // Check the sealer's native combos as well as the guest's exact orders.
  async function attestGuest() {
    for (const batch of sealedGraph.batches) {
      const map = rc2Resource(batch.entries, batch.rev, true);
      const expected = await readCombo(batch.entries, map, active);
      const original = await readBytes(proof(batch.url), active);
      const originalMap = await readBytes(proof(map), active);
      if (
        !original.data.equals(expected.data) ||
        !originalMap.data.equals(await expected.sourceMap(active))
      )
        throw new DEntryNativeUnavailable();
    }
    await attestEntries();
  }
  async function attest(ids: readonly string[], current: Resource) {
    const map = rc2Resource(ids, current.rev, true);
    const expected = await readCombo(ids, map, active);
    const native = await source.readImmutableBundle(
      current.url,
      expected.data.byteLength,
      active,
    );
    active.throwIfAborted();
    if (!expected.data.equals(native)) throw new DEntryNativeUnavailable();
    const expectedMap = await expected.sourceMap(active);
    const nativeMap = await source.readImmutableBundle(
      map,
      expectedMap.byteLength,
      active,
    );
    active.throwIfAborted();
    if (!expectedMap.equals(nativeMap)) throw new DEntryNativeUnavailable();
  }
  async function attestEntries() {
    // Keep large combined bodies serial. Smaller independent entries can
    // overlap, but all dispatched reads join before failure or publication.
    for (let i = 0; i < graph.entries.length; i += parallelGuestEntries) {
      active.throwIfAborted();
      const results = await Promise.allSettled(
        graph.entries
          .slice(i, i + parallelGuestEntries)
          .map((entry) => attest([entry.id], entry)),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    for (const batch of graph.batches) await attest(batch.entries, batch);
  }
  const key = JSON.stringify([frozenRoot, manifestDigest, graph]);
  const owner = source.verificationOwner;
  for (;;) {
    active.throwIfAborted();
    const held = owner && guestAttestations.get(owner);
    if (owner && held?.key === key) {
      try {
        await waitForGuestProof(held.verified, active);
        break;
      } catch {
        active.throwIfAborted();
        // A rejected read may reflect the initiating page's authority rather
        // than these bytes. Only successful equality is shared across scopes.
        if (guestAttestations.get(owner) === held)
          guestAttestations.delete(owner);
        continue;
      }
    }
    const verified = attestGuest();
    if (owner) {
      const checking = { key, verified };
      guestAttestations.set(owner, checking);
      void verified.catch(() => {
        if (guestAttestations.get(owner) === checking)
          guestAttestations.delete(owner);
      });
    }
    await verified;
    break;
  }
  active.throwIfAborted();
  for (const file of files.values()) {
    if (isStatic(file.path)) await readBytes(file, active);
  }
  await assertCurrent(active);
  const injections = [
    bootInjections[0],
    ...graph.batches
      .filter((part) => part.phase === 'application')
      .map(({ url }) => ({
        kind: 'script-preload',
        src: url,
      })),
    ...graph.batches
      .filter((part) => part.phase === 'bootstrap')
      .map(({ url }) => ({
        kind: 'script-src',
        placement: 'head',
        src: url,
      })),
    { kind: 'global', name: '__DSH_BOOT__', value: graph },
  ].map((row) => DEntryProfileInjectionSchema.parse(row));
  return {
    manifestSha256: manifestDigest,
    graph,
    injections,
    revoked: source.revoked,
    assertCurrent,
    async readReference(
      reference: string,
      revision: string,
      caller: AbortSignal,
    ) {
      const entry = checked.get(reference) ?? chunks.get(reference);
      if (!entry || revision !== entry.rev)
        throw new DataAccessError('not_found');
      const current = AbortSignal.any([active, caller]);
      await assertCurrent(current);
      const result =
        'row' in entry
          ? await readBytes(entry.row, current)
          : await readCombo(
              entry.entries,
              rc2Resource(entry.entries, entry.rev, true),
              current,
            );
      await assertCurrent(current);
      return 'row' in entry
        ? { ...result, data: Buffer.from(result.data) }
        : { data: result.data, media: result.media };
    },
    readStatic(path: string, caller: AbortSignal) {
      if (isStatic(path)) return read(path, caller);
      throw new DataAccessError('not_found');
    },
  };
}
