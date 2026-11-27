import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import {
  MAX_PERSON_VM_EMPLOYEE_PORT_SLOTS,
  readPlatformPersonVmConfiguration,
} from '@allrice/contracts';
import { z } from 'zod';
import { platformRepository } from './platform-repository-credential-contracts.ts';

const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const role = z.enum(['web', 'worker']);
export type ServiceBuildRole = z.infer<typeof role>;
const serviceEntrypoints = {
  web: '/apps/web/server.mjs',
  worker: '/apps/worker/dist/index.js',
} as const;
const personVmConfig = '.local/person-vm-host.json';
const buildManifestPath = '.local/dev-build-identity.json';
const relativePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      p.split('/').every((s) => s !== '' && s !== '.' && s !== '..'),
  );
const fileSchema = z
  .object({
    path: relativePath,
    scope: z.enum(['web', 'worker', 'graph']),
    checksum,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 ** 2),
  })
  .strict();
const workspaceEdgeSchema = z
  .object({
    importer: relativePath,
    dependency: z.string().regex(/^@allrice\/[a-z0-9-]+$/),
    packagePath: relativePath,
    specifier: z.string().min(1).max(200),
    entrypoint: relativePath,
    checksum,
  })
  .strict();
const manifestBodySchema = z
  .object({
    version: z.literal(1),
    environment: z.literal('dev'),
    repository: z.literal(platformRepository.fullName),
    repositoryId: z.literal(platformRepository.id),
    sourceSha: sha,
    sourceTree: sha,
    webBuildId: z.string().min(1).max(200),
    protocols: z
      .object({
        identity: z.literal(1),
        ordinaryConsumer: z.literal(1),
        releaseAdmission: z.literal('disabled'),
      })
      .strict(),
    files: z.array(fileSchema).min(4).max(10000),
    workspaceEdges: z.array(workspaceEdgeSchema).max(1000),
    nextExternalAliases: z
      .array(
        z
          .object({
            path: relativePath,
            target: relativePath,
            packageChecksum: checksum,
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export const ServiceBuildManifestSchema = manifestBodySchema
  .extend({ manifestDigest: checksum })
  .strict();
export type ServiceBuildManifest = z.infer<typeof ServiceBuildManifestSchema>;
export interface ServiceBuildIdentity {
  version: 1;
  environment: 'dev';
  repository: ServiceBuildManifest['repository'];
  repositoryId: ServiceBuildManifest['repositoryId'];
  service: ServiceBuildRole;
  mode: 'production';
  sourceSha: string;
  sourceTree: string;
  manifestDigest: string;
  artifactDigest: string;
  runtimeGraphDigest: string;
  webBuildId: string;
  bootId: string;
  pid: number;
  startedAt: string;
  nodeVersion: string;
  protocols: ServiceBuildManifest['protocols'];
}
const digest = (value: string | Buffer) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
const fileDigest = (files: ServiceBuildManifest['files']) =>
  digest(JSON.stringify(files));

type WorkspacePackage = {
  path: string;
  data: {
    dependencies?: Record<string, string>;
    main?: string;
    exports?: unknown;
  };
};
export type ServiceBuildVerificationObserver = (
  metric:
    | { kind: 'read'; bytes: number }
    | { kind: 'package' }
    | { kind: 'cache'; hit: boolean },
) => void;
function observeBuild(
  observer: ServiceBuildVerificationObserver | undefined,
  metric: Parameters<ServiceBuildVerificationObserver>[0],
) {
  try {
    observer?.(metric);
  } catch {
    /* observation does not affect the seal */
  }
}
async function workspacePackages(
  root: string,
  observer?: ServiceBuildVerificationObserver,
) {
  const packages = new Map<string, WorkspacePackage>();
  for (const folder of ['apps', 'packages']) {
    for (const entry of await readdir(join(root, folder))) {
      const path = folder + '/' + entry;
      try {
        const data = JSON.parse(
          (await bytesAt(root, path + '/package.json', observer)).toString(),
        );
        if (typeof data.name === 'string') {
          if (packages.has(data.name))
            throw Error('DEV_BUILD_RUNTIME_GRAPH_INVALID');
          packages.set(data.name, { path, data });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return packages;
}

// Current workspace exports use unconditional/default runtime targets. Reject
// conditional import/require maps rather than attest a CJS target for ESM.
function runtimeExports(pkg: WorkspacePackage): [string, string][] {
  const target = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => key === 'types' || key === 'default') &&
      typeof (value as { default?: unknown }).default === 'string'
    )
      return (value as { default: string }).default;
    throw Error('DEV_BUILD_RUNTIME_EXPORT_UNSUPPORTED');
  };
  const exports = pkg.data.exports;
  const entries: [string, string][] =
    exports &&
    typeof exports === 'object' &&
    !Array.isArray(exports) &&
    Object.keys(exports).every((key) => key === '.' || key.startsWith('./'))
      ? Object.entries(exports).map(([key, value]) => [key, target(value)])
      : [['.', target(exports ?? pkg.data.main)]];
  for (const [key, path] of entries) {
    if (key.includes('*') || !path.startsWith('./'))
      throw Error('DEV_BUILD_RUNTIME_EXPORT_UNSUPPORTED');
    relativePath.parse(path.slice(2));
  }
  return entries;
}

async function resolveWorkspaceGraph(
  root: string,
  packages: Map<string, WorkspacePackage>,
  observer?: ServiceBuildVerificationObserver,
) {
  const pending = ['@allrice/web', '@allrice/worker'],
    seen = new Set<string>();
  const edges: ServiceBuildManifest['workspaceEdges'] = [];
  while (pending.length) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const importer = packages.get(name);
    if (!importer) throw Error('DEV_BUILD_RUNTIME_GRAPH_MISSING');
    const resolver = createRequire(join(root, importer.path, 'package.json'));
    const dependencies = Object.entries(importer.data.dependencies ?? {})
      .filter(
        ([name, version]) =>
          name.startsWith('@allrice/') || version.startsWith('workspace:'),
      )
      .map(([name]) => name);
    for (const dependency of dependencies) {
      if (!packages.has(dependency))
        throw Error('DEV_BUILD_RUNTIME_GRAPH_MISSING');
      const pkg = packages.get(dependency)!;
      if (
        (await realpath(
          join(root, importer.path, 'node_modules', dependency),
        )) !== join(root, pkg.path)
      )
        throw Error('DEV_BUILD_RUNTIME_GRAPH_INVALID');
      for (const [subpath, exportedPath] of runtimeExports(pkg)) {
        const specifier =
          dependency + (subpath === '.' ? '' : subpath.slice(1));
        const entrypoint = await realpath(resolver.resolve(specifier));
        const expected = join(root, pkg.path, exportedPath.slice(2));
        if (entrypoint !== expected)
          throw Error('DEV_BUILD_RUNTIME_GRAPH_INVALID');
        edges.push({
          importer: importer.path,
          dependency,
          packagePath: pkg.path,
          specifier,
          entrypoint: relative(root, entrypoint),
          checksum: digest(
            await bytesAt(root, relative(root, entrypoint), observer),
          ),
        });
      }
      pending.push(dependency);
    }
  }
  edges.sort(
    (a, b) =>
      a.importer.localeCompare(b.importer) ||
      a.specifier.localeCompare(b.specifier),
  );
  return { edges, names: seen };
}

async function bytesAt(
  root: string,
  path: string,
  observer?: ServiceBuildVerificationObserver,
) {
  const target = join(root, path);
  const stat = await lstat(target);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 64 * 1024 ** 2 ||
    !(await realpath(target)).startsWith(root + sep)
  )
    throw Error('DEV_BUILD_IDENTITY_INVALID');
  const bytes = await readFile(target);
  observeBuild(observer, { kind: 'read', bytes: bytes.length });
  return bytes;
}
async function nextExternalAliases(
  root: string,
  observer?: ServiceBuildVerificationObserver,
): Promise<ServiceBuildManifest['nextExternalAliases']> {
  const aliases: ServiceBuildManifest['nextExternalAliases'] = [];
  const visit = async (path: string) => {
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) {
      const target = await realpath(join(root, path));
      // Turbopack emits hashed external-vendor aliases here. They must resolve
      // inside this release's frozen pnpm installation, never workspace roots
      // or another release. Their complete link set is part of the seal.
      if (!target.startsWith(join(root, 'node_modules/.pnpm') + sep))
        throw Error('DEV_BUILD_RUNTIME_GRAPH_INVALID');
      const packageBytes = await bytesAt(
        root,
        relative(root, target) + '/package.json',
        observer,
      );
      const packageName = JSON.parse(packageBytes.toString()).name;
      if (
        typeof packageName !== 'string' ||
        packageName.startsWith('@allrice/')
      )
        throw Error('DEV_BUILD_RUNTIME_GRAPH_INVALID');
      aliases.push({
        path,
        target: relative(root, target),
        packageChecksum: digest(packageBytes),
      });
    } else if (stat.isDirectory()) {
      for (const entry of (await readdir(join(root, path))).sort())
        await visit(path + '/' + entry);
    } else throw Error('DEV_BUILD_RUNTIME_GRAPH_INVALID');
  };
  const path = 'apps/web/.next/node_modules';
  try {
    await lstat(join(root, path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // A symlink replacing the whole overlay could change lookup precedence.
  if (!(await lstat(join(root, path))).isDirectory())
    throw Error('DEV_BUILD_RUNTIME_GRAPH_INVALID');
  await visit(path);
  return aliases;
}
async function walk(
  root: string,
  path: string,
  scope: 'web' | 'worker' | 'graph',
  files: ServiceBuildManifest['files'],
  observer?: ServiceBuildVerificationObserver,
) {
  // Node resolves dependencies from the nearest importer directory. A nested
  // node_modules layer could bypass the package-root links measured below.
  if (path.split('/').includes('node_modules'))
    throw Error('DEV_BUILD_RUNTIME_GRAPH_INVALID');
  const target = join(root, path),
    stat = await lstat(target);
  if (stat.isSymbolicLink()) throw Error('DEV_BUILD_IDENTITY_INVALID');
  if (stat.isDirectory()) {
    for (const entry of (await readdir(target)).sort())
      await walk(root, path + '/' + entry, scope, files, observer);
  } else {
    const bytes = await bytesAt(root, path, observer);
    files.push({ path, scope, checksum: digest(bytes), bytes: bytes.length });
    if (files.length > 10000) throw Error('DEV_BUILD_IDENTITY_INVALID');
  }
}

/** Operator-only preparation; caller must prove the exact clean Git SHA/tree.
 * No model/browser path, command, credential or deployment permission is accepted. */
export async function prepareServiceBuildManifest(input: {
  root: string;
  sourceSha: string;
  sourceTree: string;
  observe?: ServiceBuildVerificationObserver;
}): Promise<ServiceBuildManifest> {
  sha.parse(input.sourceSha);
  sha.parse(input.sourceTree);
  const root = await realpath(input.root),
    files: ServiceBuildManifest['files'] = [];
  const aliases = await nextExternalAliases(root, input.observe);
  await walk(root, 'apps/web/.next/server', 'web', files, input.observe);
  await walk(root, 'apps/web/.next/static', 'web', files, input.observe);
  await walk(root, 'apps/web/server.mjs', 'web', files, input.observe);
  await walk(root, 'apps/web/server', 'web', files, input.observe);
  for (const entry of await readdir(join(root, 'apps/web/.next'))) {
    if ((await lstat(join(root, 'apps/web/.next', entry))).isFile())
      await walk(root, 'apps/web/.next/' + entry, 'web', files, input.observe);
  }
  await walk(root, 'apps/worker/dist', 'worker', files, input.observe);
  // The optional private Host file belongs to this same release seal. Do not
  // walk a directory here: this exact path must identify one regular file.
  let hasPersonVmConfig = false;
  try {
    const stat = await lstat(join(root, personVmConfig));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error('DEV_BUILD_IDENTITY_INVALID');
    hasPersonVmConfig = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (hasPersonVmConfig) {
    const bytes = await bytesAt(root, personVmConfig, input.observe);
    files.push({
      path: personVmConfig,
      scope: 'worker',
      checksum: digest(bytes),
      bytes: bytes.length,
    });
  }
  const packages = await workspacePackages(root, input.observe);
  const graph = await resolveWorkspaceGraph(root, packages, input.observe);
  for (const name of graph.names) {
    observeBuild(input.observe, { kind: 'package' });
    const pkg = packages.get(name);
    if (!pkg) throw Error('DEV_BUILD_RUNTIME_GRAPH_MISSING');
    await walk(root, pkg.path + '/package.json', 'graph', files, input.observe);
    const entries = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : value && typeof value === 'object'
          ? Object.values(value).flatMap(entries)
          : [];
    if (
      [pkg.data.main, ...entries(pkg.data.exports)].some(
        (p) => typeof p === 'string' && p.includes('dist/'),
      )
    ) {
      await walk(root, pkg.path + '/dist', 'graph', files, input.observe);
    }
    if (name === '@allrice/vm-memory')
      await walk(root, pkg.path + '/guest', 'graph', files, input.observe);
  }
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
    await walk(root, path, 'graph', files, input.observe);
  // Governance/install provenance is sealed by the full service release,
  // independent of the narrower portable native execution identity.
  for (const name of [
    'distribution.json',
    'compatibility.json',
    'patch-ledger.json',
    'upstream.json',
  ])
    await walk(root, 'apps/worker/dsh/' + name, 'graph', files, input.observe);
  await walk(root, 'patches', 'graph', files, input.observe);
  files.sort(
    (a, b) => a.path.localeCompare(b.path) || a.scope.localeCompare(b.scope),
  );
  const body = manifestBodySchema.parse({
    version: 1,
    environment: 'dev',
    repository: platformRepository.fullName,
    repositoryId: platformRepository.id,
    sourceSha: input.sourceSha,
    sourceTree: input.sourceTree,
    webBuildId: (await bytesAt(root, 'apps/web/.next/BUILD_ID', input.observe))
      .toString()
      .trim(),
    protocols: {
      identity: 1,
      ordinaryConsumer: 1,
      releaseAdmission: 'disabled',
    },
    files,
    workspaceEdges: graph.edges,
    nextExternalAliases: aliases,
  });
  return ServiceBuildManifestSchema.parse({
    ...body,
    manifestDigest: digest(JSON.stringify(body)),
  });
}

/** Actual entrypoint and artifact bytes, not a guessed revision from an env var.
 * Absent manifest is legacy/unverified. A present but invalid manifest is fatal. */
export async function verifyServiceBuildIdentity(input: {
  entrypoint: string;
  service: ServiceBuildRole;
  claimedSha?: string;
  mode: 'production' | 'development';
  bootId?: string;
  observe?: ServiceBuildVerificationObserver;
}): Promise<ServiceBuildIdentity | null> {
  role.parse(input.service);
  if (input.bootId !== undefined) z.uuid().parse(input.bootId);
  // Next development serves .next/dev and source reloads; a retained production
  // build in the same worktree cannot attest that running development process.
  if (input.mode !== 'production') return null;
  const entrypoint = await realpath(input.entrypoint);
  const ending = serviceEntrypoints[input.service];
  if (!entrypoint.endsWith(ending)) return null;
  const root = entrypoint.slice(0, -ending.length);
  let bytes: Buffer;
  try {
    bytes = await bytesAt(root, buildManifestPath, input.observe);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw Error('DEV_BUILD_IDENTITY_INVALID');
  }
  try {
    if (bytes.length > 4 * 1024 ** 2) throw Error('invalid');
    const manifest = ServiceBuildManifestSchema.parse(
      JSON.parse(bytes.toString()),
    );
    const { manifestDigest, ...body } = manifest;
    if (
      digest(JSON.stringify(body)) !== manifestDigest ||
      (input.claimedSha !== undefined &&
        input.claimedSha !== manifest.sourceSha)
    )
      throw Error('invalid');
    const paths = manifest.files.map((file) => file.scope + ':' + file.path);
    if (new Set(paths).size !== paths.length) throw Error('invalid');
    const selected = manifest.files.filter(
      (file) => file.scope === input.service || file.scope === 'graph',
    );
    if (
      !selected.some((file) => file.path === relative(root, entrypoint)) ||
      !selected.some((file) => file.scope === 'graph')
    )
      throw Error('invalid');
    // Re-enumerate actual runtime directories, including additions after
    // sealing. Reading only the old file list misses new resolver overrides.
    const measured = await prepareServiceBuildManifest({
      root,
      sourceSha: manifest.sourceSha,
      sourceTree: manifest.sourceTree,
      observe: input.observe,
    });
    if (measured.manifestDigest !== manifestDigest) throw Error('invalid');
    return {
      version: 1,
      environment: 'dev',
      repository: manifest.repository,
      repositoryId: manifest.repositoryId,
      service: input.service,
      mode: 'production',
      sourceSha: manifest.sourceSha,
      sourceTree: manifest.sourceTree,
      manifestDigest,
      artifactDigest: fileDigest(
        manifest.files.filter((file) => file.scope === input.service),
      ),
      runtimeGraphDigest: digest(
        JSON.stringify({
          files: manifest.files.filter((file) => file.scope === 'graph'),
          workspaceEdges: manifest.workspaceEdges,
          nextExternalAliases: manifest.nextExternalAliases,
        }),
      ),
      webBuildId: manifest.webBuildId,
      protocols: manifest.protocols,
      bootId: input.bootId ?? randomUUID(),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      nodeVersion: process.version,
    };
  } catch {
    throw Error('DEV_BUILD_IDENTITY_INVALID');
  }
}
const cacheKey = Symbol.for('allrice.dev.service-build-identity.v1');
type Global = typeof globalThis & {
  [cacheKey]?: Map<ServiceBuildRole, Promise<ServiceBuildIdentity | null>>;
};
export function readServiceBuildIdentity(
  service: ServiceBuildRole,
  options: { bootId?: string; observe?: ServiceBuildVerificationObserver } = {},
) {
  const cache = ((globalThis as Global)[cacheKey] ??= new Map());
  observeBuild(options.observe, { kind: 'cache', hit: cache.has(service) });
  if (!cache.has(service)) {
    cache.set(
      service,
      process.argv[1]
        ? verifyServiceBuildIdentity({
            entrypoint: resolve(process.argv[1]),
            service,
            bootId: options.bootId,
            observe: options.observe,
            claimedSha: process.env.ALLRICE_RELEASE_SHA,
            mode:
              service === 'web' && process.argv.includes('--dev')
                ? 'development'
                : 'production',
          })
        : Promise.resolve(null),
    );
  }
  return cache.get(service)!;
}

async function readSealedPersonVmHostFile(
  build: ServiceBuildIdentity,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  try {
    if (!process.argv[1] || build.mode !== 'production')
      throw Error('DEV_BUILD_IDENTITY_INVALID');
    const entrypoint = await realpath(process.argv[1]);
    signal?.throwIfAborted();
    const ending = serviceEntrypoints[build.service];
    if (!entrypoint.endsWith(ending)) throw Error('DEV_BUILD_IDENTITY_INVALID');
    const root = entrypoint.slice(0, -ending.length);
    const manifestBytes = await bytesAt(root, buildManifestPath);
    signal?.throwIfAborted();
    if (manifestBytes.length > 4 * 1024 ** 2)
      throw Error('DEV_BUILD_IDENTITY_INVALID');
    const { manifestDigest, ...manifest } = ServiceBuildManifestSchema.parse(
      JSON.parse(manifestBytes.toString('utf8')),
    );
    if (
      digest(JSON.stringify(manifest)) !== manifestDigest ||
      manifestDigest !== build.manifestDigest ||
      manifest.sourceSha !== build.sourceSha ||
      manifest.sourceTree !== build.sourceTree
    )
      throw Error('DEV_BUILD_IDENTITY_INVALID');
    const selected = manifest.files.filter(
      (file) => file.path === personVmConfig,
    );
    if (!selected.length) return null;
    const expected = selected[0]!;
    if (selected.length !== 1 || expected.scope !== 'worker')
      throw Error('DEV_BUILD_IDENTITY_INVALID');
    const file = await open(
      join(root, personVmConfig),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      signal?.throwIfAborted();
      const stat = await file.stat();
      signal?.throwIfAborted();
      if (
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== process.getuid?.() ||
        stat.size !== expected.bytes
      )
        throw Error('DEV_BUILD_IDENTITY_INVALID');
      bytes = await file.readFile();
      signal?.throwIfAborted();
      if (
        bytes.length !== expected.bytes ||
        digest(bytes) !== expected.checksum
      )
        throw Error('DEV_BUILD_IDENTITY_INVALID');
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    const { employeePortSlots: configured, ...configuration } = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(bytes.toString('utf8')));
    const employeePortSlots =
      readPlatformPersonVmConfiguration().employeePortSlots;
    if (
      typeof configured === 'number' &&
      Number.isInteger(configured) &&
      configured >= 1 &&
      configured <= MAX_PERSON_VM_EMPLOYEE_PORT_SLOTS
    )
      return { configuration, employeePortSlots: configured, manifestDigest };
    if (configured !== undefined)
      console.warn('[person-vm.host-configuration]', {
        field: 'employeePortSlots',
        reason: 'invalid_slot_count',
        fallback: employeePortSlots,
      });
    return { configuration, employeePortSlots, manifestDigest };
  } catch {
    signal?.throwIfAborted();
    throw Error('DEV_BUILD_IDENTITY_INVALID');
  }
}

/** The verified Worker entrypoint is the only consumer of private Host fields. */
export async function readSealedPersonVmHostConfiguration(
  build: ServiceBuildIdentity,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (build.service !== 'worker') throw Error('DEV_BUILD_IDENTITY_INVALID');
  return readSealedPersonVmHostFile(build, signal);
}

/** Web and Worker enrollment use the same sealed scalar as the VM provider. */
export async function readServicePersonVmEmployeePortSlots() {
  const fallback = readPlatformPersonVmConfiguration().employeePortSlots;
  if (!process.argv[1]) return fallback;
  const entrypoint = await realpath(process.argv[1]);
  const service = entrypoint.endsWith(serviceEntrypoints.worker)
    ? 'worker'
    : entrypoint.endsWith(serviceEntrypoints.web)
      ? 'web'
      : undefined;
  if (!service) return fallback;
  const build = await readServiceBuildIdentity(service);
  if (!build) return fallback;
  const sealed = await readSealedPersonVmHostFile(build);
  return sealed?.employeePortSlots ?? fallback;
}
