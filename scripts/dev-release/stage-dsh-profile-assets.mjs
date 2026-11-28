import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha = /^[a-f0-9]{64}$/;
const file = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[\w-][\w./-]*$/;
const browserAsset =
  /^(?:managed\/.*\.(?:js|css|svg|woff2?|ttf)|native\/assets\/(?:(?:index|vendor)-[\w-]+\.(?:js|css)|fonts\/[\w-]+\.(?:woff2?|ttf)))$/;

async function readRegular(path) {
  if ((await realpath(path)) !== path || !(await lstat(path)).isFile())
    throw new Error('Untrusted Employee Web release asset');
  return readFile(path);
}

async function listFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, path + '/')));
    else if (entry.isFile()) files.push(path);
    else throw new Error('Untrusted Employee Web public output');
  }
  return files;
}

const managedEntry = 'managed/employee-web-entry.js';
const nativeStartup = /^native\/assets\/(?:index|vendor)-[\w-]+\.(?:js|css)$/;

function managedStartupImports(outputs) {
  const entry = Object.keys(outputs).find((path) =>
    path.endsWith('/' + managedEntry),
  );
  if (!entry) throw new Error('Missing Employee Web startup entry');
  const seen = new Set();
  function visit(path) {
    if (seen.has(path)) return;
    if (!outputs[path] || !/\/managed\/[\w-]+\.js$/.test(path))
      throw new Error('Invalid Employee Web startup import');
    seen.add(path);
    for (const item of outputs[path].imports)
      if (item.kind === 'import-statement') {
        if (item.external)
          throw new Error('Unsealed Employee Web startup import');
        visit(item.path);
      }
  }
  visit(entry);
  return [...seen].map((path) => path.slice(path.lastIndexOf('/managed/') + 1));
}

/** Only sealed code is copied. The profile graph and all authenticated responses
 * remain on their existing private paths. Next serves the staged bytes itself. */
export async function stageDshProfileAssets(root, sourceSha) {
  const source = join(root, 'apps/worker/dist/d-entry-web');
  const artifact = await readRegular(join(source, 'artifact.json'));
  const manifest = JSON.parse(artifact);
  if (
    manifest.status !== 'code-artifacts-only' ||
    manifest.source?.head !== sourceSha ||
    manifest.source.dirty !== false ||
    manifest.nativeRelease?.name !== '@deepseek-ai/dsh-web-frontend'
  )
    throw new Error(
      'Employee Web public assets require the sealed code release',
    );
  const stamp = digest(artifact);
  const proofs = new Map(manifest.files.map((row) => [row.path, row]));
  if (proofs.size !== manifest.files.length)
    throw new Error('Duplicate Employee Web release file');

  const next = join(root, 'apps/web/.next');
  for (const path of [join(next, 'static'), join(next, 'server')])
    if ((await realpath(path)) !== path)
      throw new Error('Aliased Web build output');
  const publicRoot = join(next, 'static/dsh-profile');
  await mkdir(publicRoot, { recursive: true });
  if ((await realpath(publicRoot)) !== publicRoot)
    throw new Error('Aliased Employee Web public output');
  if ((await readdir(publicRoot)).some((name) => name !== stamp))
    throw new Error('Employee Web public output belongs to another release');
  const target = join(publicRoot, stamp);
  const staging = await mkdtemp(join(next, '.dsh-profile-'));

  async function copy(path, output) {
    const proof = proofs.get(path);
    if (!proof || !file.test(path) || !sha.test(proof.sha256))
      throw new Error('Missing Employee Web public asset proof');
    const bytes = await readRegular(join(source, path));
    if (bytes.length !== proof.bytes || digest(bytes) !== proof.sha256)
      throw new Error('Employee Web public asset differs from the seal');
    const destination = join(staging, output);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
  }

  try {
    const paths = [...proofs.keys()].filter(
      (path) => typeof path === 'string' && browserAsset.test(path),
    );
    const required = [managedEntry, 'managed/employee-web-entry.css'];
    if (required.some((path) => !paths.includes(path)))
      throw new Error('Employee Web public entry is missing');
    for (const path of paths) await copy(path, path);

    const bundles = [];
    for (const batch of manifest.profile.graph.batches) {
      if (!['bootstrap', 'application'].includes(batch.phase)) continue;
      const rows = manifest.profile.files.filter(
        (row) => row.reference === batch.url,
      );
      const row = rows[0];
      const proof = proofs.get(row?.path);
      if (
        rows.length !== 1 ||
        !/^plugins\/[a-f0-9]{64}\.js$/.test(row.path) ||
        row.bytes !== proof?.bytes ||
        row.sha256 !== proof.sha256 ||
        !sha.test(row.sha256) ||
        typeof batch.url !== 'string' ||
        typeof batch.rev !== 'string'
      )
        throw new Error('Invalid Employee Web public bundle proof');
      const path = 'bundles/' + row.sha256 + '.js';
      if (!bundles.some((entry) => entry.sha256 === row.sha256)) {
        await copy(row.path, path);
        paths.push(path);
      }
      bundles.push({
        reference: batch.url,
        revision: batch.rev,
        sha256: row.sha256,
      });
    }
    const kernel = JSON.parse(
      await readRegular(join(source, 'kernel-inputs.json')),
    );
    const startup = [
      ...new Set([
        ...bundles.map(({ sha256 }) => 'bundles/' + sha256 + '.js'),
        ...managedStartupImports(kernel.outputs),
        required[1],
        ...paths.filter((path) => nativeStartup.test(path)),
      ]),
    ];
    if (startup.some((path) => !paths.includes(path)))
      throw new Error('Employee Web startup asset is not public');
    const index = JSON.stringify({ stamp, paths, bundles, startup }) + '\n';
    await rename(staging, target).catch(async (error) => {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      // Re-preparing the same build verifies its existing staged copy.
      if (
        (await realpath(target)) !== target ||
        JSON.stringify((await listFiles(target)).sort()) !==
          JSON.stringify([...paths].sort())
      )
        throw new Error('Untrusted Employee Web public output inventory');
      for (const path of paths) {
        const prepared = await readRegular(join(staging, path));
        if (!(await readRegular(join(target, path))).equals(prepared))
          throw new Error(
            'Employee Web public content address already holds different bytes',
          );
      }
    });
    const indexPath = join(next, 'server/dsh-profile.json');
    await writeFile(indexPath, index, { flag: 'wx' }).catch(async (error) => {
      if (
        error.code !== 'EEXIST' ||
        (await readRegular(indexPath)).toString() !== index
      )
        throw error;
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
