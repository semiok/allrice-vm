import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { collectProfileArtifacts } from './collect-profile-artifacts.mjs';

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL('./', import.meta.url));
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const guestInputs = [
  'profiles/allrice-web/package.json',
  'package.json',
  'cordis.patch.yml',
  'index.mjs',
  'host/settings-models.mjs',
  'host/settings-account.mjs',
  'host/plugin-manager.mjs',
];
const diagnostics = [
  'kernel-inputs.json',
  'profile-startup.log',
  'profile-code.json',
];

/** @type {import('esbuild').BuildOptions} */
export const employeeWebKernelOptions = {
  bundle: true,
  platform: 'browser',
  alias: {
    'node:module': join(
      packageRoot,
      'src/employee-web-entry-node-unavailable.ts',
    ),
  },
  // rc.2 apps/web/vite.config.ts browserizes this same public kernel. Its
  // clientBuildEnvironmentDefines uses an empty env fallback; this kernel's
  // inputs contain no DSH_CLIENT_* reads. Never embed the build Host's env.
  define: {
    'process.env': '{}',
    'process.env.NODE_ENV': '"production"',
    'process.env.CORDIS_SHARED': 'undefined',
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
  },
  loader: {
    '.woff': 'file',
    '.woff2': 'file',
    '.ttf': 'file',
    '.svg': 'file',
    '.wasm': 'file',
  },
};

/** Enumerate only the release's publicly exported dist tree. This inventories
 * all lazy chunks/fonts/CSS, rather than equating graph scripts with closure. */
async function publicNativeFiles() {
  const cli = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
  const web = createRequire(
    cli.resolve('@deepseek-ai/dsh-web-app/package.json'),
  );
  const name = '@deepseek-ai/dsh-web-frontend';
  const metadata = JSON.parse(
    await readFile(web.resolve(name + '/package.json'), 'utf8'),
  );
  if (metadata.version !== '0.2.1-rc.2')
    throw new Error('Native frontend release differs from the pinned profile');
  const root = dirname(web.resolve(name + '/dist/index.html'));
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const nameInDist = relative(root, path).split('\\').join('/');
        // Node enforces the package's public export for each copied resource.
        const exported = web.resolve(name + '/dist/' + nameInDist);
        files.push({
          path: await realpath(exported),
          output: 'native/' + nameInDist,
        });
      } else throw new Error('Unexpected non-file in the native release dist');
    }
  }
  await visit(root);
  return { name, version: metadata.version, files };
}

/** Build code artifacts only. A code inventory never supplies production
 * principal, access baseline, graph events or authority to execute a document. */
export async function buildEmployeeWebArtifact(
  outputDirectory,
  linuxCapture,
  terminalEnabled = true,
) {
  outputDirectory = resolve(outputDirectory);
  await mkdir(dirname(outputDirectory), { recursive: true });
  // A failed build must not leave an old success beside replaced new bytes.
  await mkdir(outputDirectory);
  // Always rebuild this checkout's contribution; never take donor/prebuilt UI.
  await execute(process.execPath, [join(packageRoot, 'build.mjs')], {
    cwd: packageRoot,
  });
  const compiled = await readFile(join(packageRoot, 'dist/client.js'));
  const inputs = JSON.parse(
    await readFile(join(packageRoot, 'dist/build-inputs.json'), 'utf8'),
  );
  const sourceFiles = [];
  for (const input of [
    ...Object.keys(inputs.inputs),
    'build.mjs',
    'src/client.cjs',
    'package.json',
  ]) {
    if (input === 'allrice-employee-contributions.ts') continue;
    const path = join(packageRoot, input);
    sourceFiles.push({
      path: relative(workspace, path),
      sha256: sha256(await readFile(path)),
    });
  }
  const native = await publicNativeFiles();
  const files = [];
  async function emit(output, bytes) {
    const path = join(outputDirectory, output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    files.push({ path: output, bytes: bytes.length, sha256: sha256(bytes) });
  }
  await emit('allrice/client.js', compiled);
  for (const pathname of guestInputs)
    await emit(
      'guest/' + pathname,
      await readFile(join(packageRoot, pathname)),
    );
  for (const file of native.files)
    await emit(file.output, await readFile(file.path));
  const managedDirectory = join(outputDirectory, 'managed');
  const kernel = await build({
    ...employeeWebKernelOptions,
    absWorkingDir: packageRoot,
    entryPoints: { 'employee-web-entry': 'src/employee-product-entry.ts' },
    outdir: managedDirectory,
    entryNames: 'employee-web-entry',
    assetNames: 'assets/[name]-[hash]',
    write: false,
    splitting: true,
    format: 'esm',
    // Keep CSS module identifiers descriptive across the separate native
    // kernel and AllRice contribution compilations; short independent names
    // can collide even when each compilation has a consistent local graph.
    minifySyntax: true,
    minifyWhitespace: true,
    minifyIdentifiers: false,
    metafile: true,
  });
  for (const output of Object.values(kernel.metafile.outputs)) {
    if (
      output.imports.some(
        (item) => item.external && !item.path.startsWith('data:'),
      )
    )
      throw new Error(
        'Managed kernel has an unclosed external code/asset import',
      );
  }
  for (const output of kernel.outputFiles)
    await emit(relative(outputDirectory, output.path), output.contents);
  await writeFile(
    join(outputDirectory, 'kernel-inputs.json'),
    JSON.stringify(kernel.metafile, null, 2) + '\n',
  );
  await mkdir(join(outputDirectory, 'plugins'), { recursive: true });
  if (linuxCapture) {
    await linuxCapture.collect(outputDirectory, guestInputs);
  } else {
    const state = await mkdtemp(join(outputDirectory, '.build-state-'));
    const dshHome = join(state, 'dsh');
    try {
      for (const name of ['home', 'dsh', 'agents', 'tmp', 'work'])
        await mkdir(join(state, name));
      const child = await execute(
        process.execPath,
        [
          '--max-old-space-size=512',
          fileURLToPath(import.meta.url),
          '--profile-artifacts',
          outputDirectory,
          dshHome,
          String(terminalEnabled),
        ],
        {
          cwd: join(state, 'work'),
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            PATH: dirname(process.execPath) + ':/usr/bin:/bin',
            HOME: join(state, 'home'),
            DSH_HOME: dshHome,
            DSH_AGENTS_HOME: join(state, 'agents'),
            XDG_CONFIG_HOME: join(state, 'home/.config'),
            XDG_DATA_HOME: join(state, 'home/.local/share'),
            TMPDIR: join(state, 'tmp'),
            DSH_TELEMETRY_DISABLED: '1',
            DO_NOT_TRACK: '1',
          },
        },
      );
      await writeFile(
        join(outputDirectory, 'profile-startup.log'),
        child.stdout + child.stderr,
      );
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  }
  const profile = JSON.parse(
    await readFile(join(outputDirectory, 'profile-code.json'), 'utf8'),
  );
  files.push(...profile.files);
  const { stdout: head } = await execute('git', ['rev-parse', 'HEAD'], {
    cwd: workspace,
  });
  const { stdout: dirty } = await execute('git', ['status', '--porcelain'], {
    cwd: workspace,
  });
  const manifest = {
    format: 1,
    status: 'code-artifacts-only',
    source: {
      head: head.trim(),
      dirty: dirty !== '',
      contributionInputs: sourceFiles,
    },
    nativeRelease: { name: native.name, version: native.version },
    files,
    diagnostics: await Promise.all(
      diagnostics.map(async (path) => {
        const bytes = await readFile(join(outputDirectory, path));
        return { path, bytes: bytes.length, sha256: sha256(bytes) };
      }),
    ),
    // Full-profile bundle graph and the managed entry are separate proof items.
    profile,
    terminalEnabled,
    ...(linuxCapture ? { profileRuntime: linuxCapture.identity } : {}),
    managedEntry: 'managed/employee-web-entry.js',
    closure: {
      publicNativeDist: true,
      sourceBuiltContribution: true,
      profileScripts: true,
      managedEntry: true,
    },
    runtime: {
      principal: null,
      snapshotFor: null,
      follow: null,
      graphEventsAuthority: null,
      executableDocument: false,
    },
  };
  await writeFile(
    join(outputDirectory, 'artifact.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  return manifest;
}

/** The Worker release seal inventories real files under dist. A sealed
 * release directory must never be overwritten after it is available. */
export async function prepareEmployeeWebServiceArtifact(
  directory,
  head,
  linuxCapture,
  terminalEnabled = true,
) {
  let current;
  try {
    current = await readFile(join(directory, 'artifact.json'), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (current !== undefined) {
    const existing = JSON.parse(current);
    if (existing.source?.head !== head || existing.source.dirty !== false)
      throw Error('Employee Web artifact belongs to another source');
    if (
      existing.terminalEnabled !== terminalEnabled ||
      !isDeepStrictEqual(existing.profileRuntime, linuxCapture?.identity)
    )
      throw Error('Employee Web artifact belongs to another runtime');
    await verifyEmployeeWebArtifact(directory, existing);
    return existing;
  }
  const stage = await mkdtemp(join(dirname(directory), '.employee-web-'));
  try {
    const built = join(stage, 'contents');
    const manifest = await buildEmployeeWebArtifact(
      built,
      linuxCapture,
      terminalEnabled,
    );
    if (manifest.source.head !== head || manifest.source.dirty)
      throw Error('Employee Web artifact requires the fixed service source');
    await verifyEmployeeWebArtifact(built, manifest);
    await rename(built, directory);
    return manifest;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function verifyEmployeeWebArtifact(directory, artifact) {
  const native = await publicNativeFiles();
  if (
    artifact.format !== 1 ||
    artifact.status !== 'code-artifacts-only' ||
    !isDeepStrictEqual(artifact.nativeRelease, {
      name: native.name,
      version: native.version,
    }) ||
    !Array.isArray(artifact.files) ||
    artifact.managedEntry !== 'managed/employee-web-entry.js' ||
    artifact.profile?.sourceBuiltClient !== true ||
    !isDeepStrictEqual(
      artifact.diagnostics?.map(({ path }) => path),
      diagnostics,
    )
  )
    throw Error('Employee Web artifact manifest is incomplete');
  const fingerprints = new Map();
  for (const row of [...artifact.files, ...artifact.diagnostics]) {
    if (
      typeof row.path !== 'string' ||
      !/^[A-Za-z0-9._+/-]+$/.test(row.path) ||
      row.path
        .split('/')
        .some((part) => !part || part === '.' || part === '..') ||
      !Number.isInteger(row.bytes) ||
      row.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(row.sha256) ||
      fingerprints.has(row.path)
    )
      throw Error('Invalid Employee Web artifact fingerprint');
    fingerprints.set(row.path, {
      path: row.path,
      bytes: row.bytes,
      sha256: row.sha256,
    });
  }
  const profile = artifact.profile;
  const references = new Map(
    profile.files.map((file) => [file.reference, file]),
  );
  if (references.size !== profile.files.length)
    throw Error('Duplicate Employee Web profile references');
  for (const { url } of [...profile.graph.entries, ...profile.graph.batches])
    if (!references.has(url))
      throw Error('Employee Web artifact profile is incomplete');
  for (const name of [
    ...guestInputs.map((path) => 'guest/' + path),
    ...native.files.map(({ output }) => output),
    'allrice/client.js',
    'managed/employee-web-entry.js',
    'managed/employee-web-entry.css',
    ...profile.files.map(({ path, bytes, sha256: digest }) => {
      if (
        !isDeepStrictEqual(fingerprints.get(path), {
          path,
          bytes,
          sha256: digest,
        })
      )
        throw Error('Employee Web asset fingerprint differs from its profile');
      return path;
    }),
  ])
    if (!fingerprints.has(name))
      throw Error('Missing Employee Web artifact file: ' + name);
  const observed = new Set();
  async function visit(path = '') {
    for (const entry of await readdir(join(directory, path), {
      withFileTypes: true,
    })) {
      const child = path ? path + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (
        !entry.isFile() ||
        (child !== 'artifact.json' && !fingerprints.has(child))
      )
        throw Error('Unexpected Employee Web artifact file: ' + child);
      else observed.add(child);
    }
  }
  await visit();
  for (const [path, proof] of fingerprints) {
    if (!observed.has(path))
      throw Error('Missing Employee Web artifact file: ' + path);
    const bytes = await readFile(join(directory, path));
    if (bytes.length !== proof.bytes || sha256(bytes) !== proof.sha256)
      throw Error('Employee Web artifact bytes changed: ' + path);
  }
}

/** The default destination is an atomic reference to a complete immutable
 * build. Explicitly named outputs still use the original one-write contract. */
export async function publishEmployeeWebArtifact(
  outputDirectory,
  buildArtifact = buildEmployeeWebArtifact,
) {
  const destination = resolve(outputDirectory);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, '.web-entry-'));
  const artifact = join(stage, 'artifact');
  const pointer = join(stage, 'next');
  const backup = join(stage, 'previous');
  let keep = false;
  try {
    const manifest = await buildArtifact(artifact);
    await symlink(relative(parent, artifact), pointer, 'dir');
    const previous = await lstat(destination).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (previous && !previous.isDirectory() && !previous.isSymbolicLink())
      throw new Error('Web entry destination is not a release directory');
    // Migrate an older default build that published a directory directly.
    if (previous?.isDirectory()) await rename(destination, backup);
    try {
      await rename(pointer, destination);
    } catch (error) {
      if (previous?.isDirectory()) {
        try {
          await rename(backup, destination);
        } catch (cleanup) {
          keep = true;
          throw new AggregateError(
            [error, cleanup],
            'Web entry publication rollback failed',
          );
        }
      }
      throw error;
    }
    keep = true;
    return manifest;
  } finally {
    if (!keep) await rm(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === '--profile-artifacts') {
    await collectProfileArtifacts({
      outputDirectory: process.argv[3],
      dshHome: process.argv[4],
      packageRoot,
      installAnchor: require.resolve('@deepseek-ai/dsh/package.json'),
      resolutionAnchor: import.meta.url,
      host: '127.0.0.1',
      terminalEnabled: process.argv[5] !== 'false',
    });
  } else {
    const directory = process.argv[2] ?? join(packageRoot, 'dist/web-entry');
    const manifest = await (process.argv[2]
      ? buildEmployeeWebArtifact(directory)
      : publishEmployeeWebArtifact(directory));
    process.stdout.write(
      JSON.stringify({
        status: manifest.status,
        files: manifest.files.length,
        output: directory,
      }) + '\n',
    );
  }
}
