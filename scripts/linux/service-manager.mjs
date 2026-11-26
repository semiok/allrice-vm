import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const sealPath = '.local/dev-build-identity.json';
const configPath = 'apps/worker/dist/linux-service-config.json';
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
    await readRegular(join(root, sealPath), 32 * 1024 * 1024),
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
      config = JSON.parse(bytes);
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
  return { root, sourceSha: body.sourceSha, config };
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
      command: `ALLRICE_WORKER_HOST=127.0.0.1 ALLRICE_WORKER_PORT=${config.workerPort} ${config.node} ${root}/apps/worker/dist/index.js`,
    },
    {
      role: 'web',
      dir: `${root}/apps/web`,
      extra: [],
      command: `${config.node} ${root}/apps/web/server.mjs --hostname 127.0.0.1 --port ${config.webPort}`,
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
        `ExecStartPre=/usr/bin/findmnt --noheadings --mountpoint ${config.dataMount} --source UUID=${config.dataUuid}`,
        `ExecStart=/usr/bin/env NODE_ENV=production ALLRICE_RELEASE_SHA=${sourceSha} ${command}`,
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

/** New/identical units only. Replacing release units needs the deploy drain
 * and rollback sequence, which is intentionally outside this installer. */
export async function installUnitFiles(directory, units, reload) {
  if ((await realpath(directory)) !== directory)
    throw new Error('Aliased systemd unit directory');
  const missing = [];
  for (const [name, contents] of units) {
    try {
      const found = await readRegular(join(directory, name), 4096);
      if (!found.equals(Buffer.from(contents)))
        throw new Error(
          'Existing unit differs; drain and replace through the release owner',
        );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push([name, contents]);
    }
  }
  const staging = await mkdtemp(join(directory, '.allrice40-'));
  const created = [];
  try {
    for (const [name, contents] of missing) {
      const file = join(staging, name);
      const target = join(directory, name);
      await writeFile(file, contents, { mode: 0o644, flag: 'wx' });
      await link(file, target);
      created.push(target);
    }
    await reload();
  } catch (error) {
    for (const target of created) {
      const name = posix.basename(target);
      const [expected, actual] = await Promise.all([
        lstat(join(staging, name)),
        lstat(target),
      ]);
      if (expected.ino === actual.ino && expected.dev === actual.dev)
        await rm(target);
    }
    throw error;
  } finally {
    await rm(staging, { recursive: true });
  }
}

async function main(args) {
  const [action, root, manifestDigest] = args;
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
    await installUnitFiles('/etc/systemd/system', units, () =>
      execFileSync('/usr/bin/systemctl', ['daemon-reload'], {
        stdio: 'ignore',
      }),
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
