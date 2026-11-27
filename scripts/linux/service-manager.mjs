import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const sealPath = '.local/dev-build-identity.json';
const configPath = 'apps/worker/dist/linux-service-config.json';
const mountCheckPath = 'apps/worker/dist/linux-service-manager.mjs';
const unitNames = ['allrice40-worker.service', 'allrice40-web.service'];
const sha = /^[0-9a-f]{40}$/;
const sha256 = /^sha256:[0-9a-f]{64}$/;
const fsUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const digest = (bytes) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const safePath = (value) =>
  typeof value === 'string' &&
  /^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(value) &&
  posix.normalize(value) === value;
const port = (value) =>
  Number.isInteger(value) && value >= 1024 && value <= 65535;

async function readRegular(path, maxBytes) {
  if ((await realpath(path)) !== path) throw new Error('Aliased release input');
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error('Invalid release input');
    return await file.readFile();
  } finally {
    await file.close();
  }
}

/** The operator supplies the trusted digest from release preparation, rather
 * than treating the copy of the digest beside the configuration as authority. */
export async function readLinuxRelease(root, expectedDigest) {
  if (
    !safePath(root) ||
    (await realpath(root)) !== root ||
    !sha256.test(expectedDigest)
  )
    throw new Error('Invalid release root or trusted digest');
  const { manifestDigest, ...body } = JSON.parse(
    (await readRegular(join(root, sealPath), 32 * 1024 * 1024)).toString(
      'utf8',
    ),
  );
  if (
    manifestDigest !== expectedDigest ||
    digest(JSON.stringify(body)) !== expectedDigest ||
    body.version !== 1 ||
    body.environment !== 'dev' ||
    body.repository !== 'semiok/allrice-vm' ||
    body.repositoryId !== 1469490636 ||
    !sha.test(body.sourceSha) ||
    !sha.test(body.sourceTree) ||
    !Array.isArray(body.files)
  )
    throw new Error('Release seal mismatch');
  let config;
  for (const [path, scope] of [
    [configPath, 'worker'],
    [mountCheckPath, 'worker'],
    ['apps/worker/dist/index.js', 'worker'],
    ['apps/web/server.mjs', 'web'],
  ]) {
    const entries = body.files.filter((entry) => entry.path === path);
    if (entries.length !== 1 || entries[0].scope !== scope)
      throw new Error('Missing or ambiguous sealed release input');
    const bytes = await readRegular(join(root, path), 16 * 1024 * 1024);
    if (
      bytes.length !== entries[0].bytes ||
      digest(bytes) !== entries[0].checksum
    )
      throw new Error('Sealed release input changed');
    if (path === configPath) {
      config = JSON.parse(bytes.toString('utf8'));
      if (
        Object.keys(config).sort().join(',') !==
          'dataMount,dataUuid,node,platform,socketRoot,webPort,workerPort' ||
        config.platform !== 'linux/arm64' ||
        config.socketRoot !== '/run/ar' ||
        config.dataMount !== '/var/lib/allrice40' ||
        !fsUuid.test(config.dataUuid) ||
        !safePath(config.node) ||
        !port(config.webPort) ||
        !port(config.workerPort) ||
        config.webPort === config.workerPort
      )
        throw new Error('Invalid sealed Linux service configuration');
    }
  }
  return {
    root,
    sourceSha: body.sourceSha,
    sourceTree: body.sourceTree,
    config,
  };
}

export function renderUnits({ root, sourceSha, config }) {
  const common = [
    'Wants=network-online.target',
    'After=network-online.target',
    `RequiresMountsFor=${config.dataMount}`,
    `AssertPathIsMountPoint=${config.dataMount}`,
  ];
  const services = [
    {
      role: 'worker',
      dir: root,
      extra: [
        'SupplementaryGroups=kvm',
        'RuntimeDirectory=ar',
        'RuntimeDirectoryMode=0700',
        'RuntimeDirectoryPreserve=yes',
      ],
      command: `ALLRICE_EXECUTION_ROOT=${config.dataMount}/executions ALLRICE_DSH_RUNTIME_ROOT=${config.dataMount}/dsh-runtime ALLRICE_WORKER_HOST=127.0.0.1 ALLRICE_WORKER_PORT=${config.workerPort} ${config.node} ${root}/apps/worker/dist/index.js`,
    },
    {
      role: 'web',
      dir: `${root}/apps/web`,
      extra: [],
      command: `ALLRICE_WORKER_INTERNAL_URL=http://127.0.0.1:${config.workerPort} ${config.node} ${root}/apps/web/server.mjs --hostname 127.0.0.1 --port ${config.webPort}`,
    },
  ];
  return new Map(
    services.map(({ role, dir, extra, command }, index) => [
      unitNames[index],
      [
        '[Unit]',
        `Description=AllRice 4.0 Linux ${role}`,
        ...common,
        ...(role === 'web'
          ? [
              'Requires=allrice40-worker.service',
              'After=allrice40-worker.service',
            ]
          : []),
        '',
        '[Service]',
        'Type=exec',
        'User=allrice',
        'Group=allrice',
        'UMask=0077',
        `WorkingDirectory=${dir}`,
        `EnvironmentFile=/etc/allrice40/${role}.env`,
        ...extra,
        `ExecStartPre=${config.node} ${root}/${mountCheckPath} check-mount ${config.dataMount} ${config.dataUuid}`,
        `ExecStart=/usr/bin/env NODE_ENV=production ALLRICE_RELEASE_SHA=${sourceSha} ALLRICE_STORAGE_ROOT=${config.dataMount}/storage ${command}`,
        'KillMode=mixed',
        'SendSIGKILL=no',
        'TimeoutStopSec=infinity',
        'StandardOutput=journal',
        'StandardError=journal',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        '',
      ].join('\n'),
    ]),
  );
}

/** An overmount must not let an older, hidden matching UUID pass. */
export function assertDataMount(output, target, uuid) {
  const { filesystems } = JSON.parse(output);
  if (
    !Array.isArray(filesystems) ||
    filesystems.length !== 1 ||
    filesystems[0].target !== target ||
    filesystems[0].uuid !== uuid ||
    !filesystems[0].options?.split(',').includes('rw')
  )
    throw new Error(
      'Expected a single writable data mount matching the release',
    );
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

export async function checkUnitPlacement(directory, loadPaths, show) {
  if (!loadPaths.includes(directory) || !loadPaths.every(safePath))
    throw new Error('Cannot identify systemd unit search path');
  for (const name of unitNames) {
    const info = new Map(
      show(name)
        .trim()
        .split('\n')
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    const own = join(directory, name);
    const state = info.get('LoadState');
    if (
      !['loaded', 'not-found'].includes(state) ||
      !info.has('FragmentPath') ||
      !info.has('DropInPaths') ||
      info.get('UpheldBy') !== '' ||
      info.get('ActiveState') !== 'inactive' ||
      info.get('MainPID') !== '0' ||
      info.get('ControlPID') !== '0' ||
      !['', '0'].includes(info.get('Job')) ||
      info.get('FragmentPath') !== (state === 'loaded' ? own : '') ||
      info.get('DropInPaths') ||
      (state === 'loaded' && !(await exists(own)))
    )
      throw new Error(
        'Existing systemd activity, fragment, mask or drop-in; use the release owner',
      );
    for (const root of loadPaths) {
      if (
        (root !== directory && (await exists(join(root, name)))) ||
        (await exists(join(root, name + '.d'))) ||
        (await exists(join(root, 'allrice40-.service.d'))) ||
        (await exists(join(root, 'service.d')))
      )
        throw new Error(
          'Existing systemd fragment or drop-in in the search path',
        );
      const children = await readdir(root).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of children) {
        if (
          /\.(?:wants|requires|upholds)$/.test(entry) &&
          (await exists(join(root, entry, name)))
        )
          throw new Error(
            'Existing systemd dependency link could activate these units',
          );
      }
    }
  }
}

/** New/identical units only. Replacing release units needs the deploy drain
 * and rollback sequence, which is intentionally outside this installer. */
export async function installUnitFiles(
  directory,
  units,
  checkPlacement,
  reload,
) {
  if (
    (await realpath(directory)) !== directory ||
    units.size !== unitNames.length ||
    unitNames.some((name) => !units.has(name))
  )
    throw new Error('Invalid unit directory or unit set');
  const lock = join(directory, '.allrice40-install.lock');
  await mkdir(lock, { mode: 0o700 });
  try {
    await checkPlacement();
    const missing = [];
    for (const [name, contents] of units) {
      const target = join(directory, name);
      if (!(await exists(target))) {
        missing.push([name, contents]);
        continue;
      }
      if (!(await readRegular(target, 4096)).equals(Buffer.from(contents)))
        throw new Error(
          'Existing unit differs; drain and replace through the release owner',
        );
    }
    if (!missing.length) return;
    const staging = await mkdtemp(join(lock, 'units-'));
    const created = [];
    try {
      for (const [name, contents] of missing) {
        const file = join(staging, name);
        const target = join(directory, name);
        await writeFile(file, contents, { mode: 0o644, flag: 'wx' });
        await link(file, target);
        created.push([file, target]);
      }
      await reload();
    } catch (error) {
      const cleaned = await Promise.allSettled(
        created.map(async ([file, target]) => {
          if (!(await exists(target))) return;
          const [expected, actual] = await Promise.all([
            lstat(file),
            lstat(target),
          ]);
          if (expected.ino === actual.ino && expected.dev === actual.dev)
            await rm(target);
        }),
      );
      const failures = cleaned.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          'unit install rollback incomplete',
        );
      throw error;
    } finally {
      await rm(staging, { recursive: true });
    }
  } finally {
    await rmdir(lock);
  }
}

const managerEnvironment = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' };
const managerCall = (file, args) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    env: managerEnvironment,
    timeout: 15000,
  });

function unitStatus(name) {
  try {
    return managerCall('/usr/bin/systemctl', [
      '--system',
      'show',
      '--all',
      '--property=LoadState,ActiveState,MainPID,ControlPID,Job,FragmentPath,DropInPaths,UpheldBy',
      name,
    ]);
  } catch (error) {
    if (error.status === 1 && /^LoadState=not-found$/m.test(error.stdout ?? ''))
      return error.stdout;
    throw error;
  }
}

async function main(args) {
  const [action, root, manifestDigest] = args;
  if (action === 'check-mount' && args.length === 3) {
    if (root !== '/var/lib/allrice40' || !fsUuid.test(manifestDigest))
      throw new Error('Invalid release data mount');
    assertDataMount(
      managerCall('/usr/bin/findmnt', [
        '--json',
        '--list',
        '--mountpoint',
        root,
        '--output',
        'TARGET,UUID,OPTIONS',
      ]),
      root,
      manifestDigest,
    );
    return;
  }
  if (args.length !== 3 || !['render', 'install'].includes(action))
    throw new Error(
      'Usage: service-manager.mjs render|install RELEASE EXPECTED_MANIFEST_DIGEST',
    );
  const release = await readLinuxRelease(root, manifestDigest);
  const units = renderUnits(release);
  if (action === 'render') {
    for (const [name, contents] of units)
      process.stdout.write(`# ${name}\n${contents}\n`);
  } else {
    if (
      process.platform !== 'linux' ||
      process.arch !== 'arm64' ||
      process.getuid() !== 0 ||
      !root.startsWith('/opt/allrice40/releases/')
    )
      throw new Error('Install requires the Linux arm64 release operator');
    const directory = '/etc/systemd/system';
    await installUnitFiles(
      directory,
      units,
      () =>
        checkUnitPlacement(
          directory,
          managerCall('/usr/bin/systemctl', [
            '--system',
            'show',
            '--property=UnitPath',
            '--value',
          ])
            .trim()
            .split(/\s+/),
          unitStatus,
        ),
      () => managerCall('/usr/bin/systemctl', ['--system', 'daemon-reload']),
    );
    console.log(
      'Units installed; service activation remains with the release operator',
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
