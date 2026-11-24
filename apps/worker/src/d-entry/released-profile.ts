import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  DEntryProfileAddressSchema,
  DEntryProfileFilePathSchema,
  DEntryProfileGraphSchema,
  DEntryProfileInjectionSchema,
} from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import { DEntryNativeUnavailable } from './native-owner.js';

/** Trusted same-Host reader. Its implementation must read the actual current
 * immutable clientModules graph from the existing leased native profile. */
export interface DEntryFixedProfileSource {
  readonly revoked: AbortSignal;
  readImmutableGraph(signal: AbortSignal): Promise<unknown>;
  readImmutableBundle(
    reference: string,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}
const hash = (value: Buffer) =>
  createHash('sha256').update(value).digest('hex');
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

function topology(graph: Graph) {
  return {
    release: graph.release,
    entries: graph.entries.map(({ id, inject, immediately, external }) => ({
      id,
      inject,
      immediately,
      external,
    })),
    batches: graph.batches.map(({ phase, entries }) => ({ phase, entries })),
  };
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

function replaceMapTrailer(data: Buffer, before: string, after: string) {
  const trailer = (reference: string) =>
    Buffer.from(
      '//# sourceMappingURL=' + reference.slice('plugins/'.length) + '\n',
    );
  const original = trailer(before);
  if (!data.subarray(-original.byteLength).equals(original))
    throw new DEntryNativeUnavailable();
  return Buffer.concat([
    data.subarray(0, -original.byteLength),
    trailer(after),
  ]);
}

export async function holdReleasedProfile(
  directory: string,
  source: DEntryFixedProfileSource,
  signal: AbortSignal,
) {
  const active = AbortSignal.any([signal, source.revoked]);
  active.throwIfAborted();
  const frozenRoot = await realpath(directory);
  const raw = await readFile(join(frozenRoot, 'artifact.json'), {
    signal: active,
  });
  const manifest = manifestSchema.parse(JSON.parse(raw.toString('utf8')));
  const { graph: sealedGraph, bootInjections } = manifest.profile;
  const graph = DEntryProfileGraphSchema.parse(
    await source.readImmutableGraph(active),
  );
  active.throwIfAborted();
  if (!isDeepStrictEqual(topology(graph), topology(sealedGraph)))
    throw new DEntryNativeUnavailable();
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
    !modules.has('@deepseek-ai/dsh-client-modules') ||
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
    ).length !== graph.batches.length
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
    const selected = resolve(frozenRoot, row.path);
    const media = mime.get(extname(row.path));
    if (
      !media ||
      !selected.startsWith(frozenRoot + sep) ||
      (await realpath(selected)) !== selected
    )
      throw new DEntryNativeUnavailable();
    const data = await readFile(selected, { signal: current });
    current.throwIfAborted();
    if (data.byteLength !== row.bytes || hash(data) !== row.sha256)
      throw new DEntryNativeUnavailable();
    return { data, media };
  }
  async function read(path: string | undefined, caller: AbortSignal) {
    const row = path && files.get(path);
    if (!row) throw new DataAccessError('not_found');
    const current = AbortSignal.any([active, caller]);
    await assertCurrent(current);
    const result = await readBytes(row, current);
    await assertCurrent(current);
    return result;
  }
  const isStatic = (path: string) =>
    path.startsWith('managed/') ||
    (path.startsWith('native/assets/') &&
      (nativeAliases.has(path.slice('native/'.length)) ||
        /\.(?:woff2?|ttf)$/.test(path)));
  const checked = new Map<
    string,
    {
      revision: string;
      read(signal: AbortSignal): ReturnType<typeof readBytes>;
    }
  >();
  const relocated = new Map<string, string>();
  async function attest(
    ids: readonly string[],
    sealed: Resource,
    current: Resource,
  ) {
    if (
      sealed.url !== rc2Resource(ids, sealed.rev, false) ||
      current.url !== rc2Resource(ids, current.rev, false)
    )
      throw new DEntryNativeUnavailable();
    const oldMap = rc2Resource(ids, sealed.rev, true);
    const newMap = rc2Resource(ids, current.rev, true);
    const proof = (reference: string) => {
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
    };
    const script = proof(sealed.url);
    const sourceMap = proof(oldMap);
    const read = async (signal: AbortSignal) => {
      const { data, media } = await readBytes(script, signal);
      return { data: replaceMapTrailer(data, oldMap, newMap), media };
    };
    const expected = await read(active);
    const expectedMap = await readBytes(sourceMap, active);
    const native = await source.readImmutableBundle(current.url, active);
    const nativeMap = await source.readImmutableBundle(newMap, active);
    active.throwIfAborted();
    if (!expected.data.equals(native) || !expectedMap.data.equals(nativeMap))
      throw new DEntryNativeUnavailable();
    if (checked.has(current.url) || relocated.has(sealed.url))
      throw new DEntryNativeUnavailable();
    checked.set(current.url, { revision: current.rev, read });
    relocated.set(sealed.url, current.url);
  }

  for (const [index, entry] of sealedGraph.entries.entries())
    await attest([entry.id], entry, graph.entries[index]!);
  for (const [index, batch] of sealedGraph.batches.entries())
    await attest(batch.entries, batch, graph.batches[index]!);
  for (const file of files.values()) {
    if (isStatic(file.path)) await readBytes(file, active);
  }
  await assertCurrent(active);
  const injections = bootInjections.map((row) => {
    if (row.kind === 'global') return { ...row, value: graph };
    if (row.kind === 'script') return row;
    const src = relocated.get(row.src);
    if (!src) throw new DEntryNativeUnavailable();
    return { ...row, src };
  });
  return {
    manifestSha256: hash(raw),
    graph,
    injections,
    revoked: source.revoked,
    assertCurrent,
    async readReference(
      reference: string,
      revision: string,
      caller: AbortSignal,
    ) {
      const entry = checked.get(reference);
      if (!entry || revision !== entry.revision)
        throw new DataAccessError('not_found');
      const current = AbortSignal.any([active, caller]);
      await assertCurrent(current);
      const result = await entry.read(current);
      await assertCurrent(current);
      return result;
    },
    readStatic(path: string, caller: AbortSignal) {
      if (isStatic(path)) return read(path, caller);
      throw new DataAccessError('not_found');
    },
  };
}
