import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sensitivePageUpgradeCapability } from '../packages/d-entry-principal/src/page-capability-policy.ts';

const upstreamRegistryPrefix = '@deepseek-ai+';
const upstreamPackagePrefix = '@deepseek-ai/';

function packageName(entry) {
  if (!entry.startsWith(upstreamRegistryPrefix)) return;
  const name = entry.slice(upstreamRegistryPrefix.length).split('@', 1)[0];
  if (name === 'dsh' || name.startsWith('dsh-')) return name;
}

function record(packageId, invocation) {
  const { namespace, method, service, mode } = invocation;
  for (const label of [namespace, method, service]) {
    if (typeof label !== 'string' || !label || /[\s/]/u.test(label)) {
      throw new Error(`Invalid Typert endpoint metadata in ${packageId}`);
    }
  }
  if (mode !== undefined && mode !== 'stream') {
    throw new Error(`Unsupported Typert endpoint mode in ${packageId}`);
  }
  return [packageId, `${namespace}/${method}`, service, mode ?? 'unary'].join(
    '\t',
  );
}

/** Collect public Host descriptors from the installed, version-pinned releases. */
export async function collectPageEndpoints(virtualStore, version) {
  const packages = new Set();
  const records = new Set();
  for (const entry of (await readdir(virtualStore)).sort()) {
    const name = packageName(entry);
    if (!name) continue;
    // An in-place installation may leave previous package folders in the
    // virtual store. The installed distribution pin selects the inventory.
    const pinned = `${upstreamRegistryPrefix}${name}@${version}`;
    if (entry !== pinned && !entry.startsWith(`${pinned}_`)) continue;
    const packageId = upstreamPackagePrefix + name;
    const manifestPath = join(
      virtualStore,
      entry,
      'node_modules',
      packageId,
      'package.json',
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.name !== packageId || manifest.version !== version) {
      throw new Error(`Unexpected DSH release in ${entry}`);
    }
    if (!manifest.exports?.['./typert'] || packages.has(packageId)) continue;
    packages.add(packageId);
    const artifact = createRequire(manifestPath).resolve(`${packageId}/typert`);
    const { TYPERT } = await import(pathToFileURL(artifact));
    if (
      TYPERT?.package !== packageId ||
      TYPERT.face !== 'host' ||
      !Array.isArray(TYPERT.invocations)
    ) {
      throw new Error(`Invalid public Typert Host artifact for ${packageId}`);
    }
    for (const invocation of TYPERT.invocations) {
      const entry = record(packageId, invocation);
      if (records.has(entry)) {
        throw new Error(`Duplicate Typert endpoint declaration: ${entry}`);
      }
      records.add(entry);
    }
  }
  if (!records.size) throw new Error('No DSH Typert endpoints were found');
  return [...records].sort();
}

/** Compare inventory entries without making the baseline a runtime allowlist. */
export function addedPageEndpoints(previous, current) {
  const baseline = new Set(previous);
  return current
    .filter((entry) => !baseline.has(entry))
    .map((entry) => {
      const [packageId, endpoint, service, mode] = entry.split('\t');
      const [namespace, method] = endpoint.split('/');
      return { packageId, endpoint, namespace, method, service, mode };
    });
}

export function addedSensitivePageEndpoints(previous, current) {
  return addedPageEndpoints(previous, current).flatMap((entry) => {
    const category = sensitivePageUpgradeCapability(entry);
    return category ? [{ ...entry, category }] : [];
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(
    await readFile(join(root, 'apps/worker/dsh/upstream.json'), 'utf8'),
  );
  const [mode, ...args] = process.argv.slice(2);
  if (!['snapshot', 'check'].includes(mode) || args.length > 1)
    throw new Error(
      'Usage: dsh-page-endpoint-inventory.mjs snapshot|check [virtual-store]',
    );
  const virtualStore = resolve(args[0] ?? join(root, 'node_modules/.pnpm'));
  const rows = await collectPageEndpoints(virtualStore, manifest.version);
  if (mode === 'snapshot') {
    console.log(`# ${manifest.version} ${manifest.commit}\n${rows.join('\n')}`);
  } else {
    const baseline = await readFile(
      join(import.meta.dirname, 'dsh-page-endpoints-baseline.tsv'),
      'utf8',
    );
    const previous = baseline.trimEnd().split('\n').slice(1);
    for (const item of addedSensitivePageEndpoints(previous, rows)) {
      console.log(
        `::warning::New DSH endpoint ${item.endpoint} (${item.packageId}) matches ${item.category}`,
      );
    }
  }
}
