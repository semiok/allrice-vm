// Installed beside the reviewed service manager and host preflight on one trial host.
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertDataMount,
  readLinuxRelease,
  renderUnits,
} from './service-manager.mjs';

const releaseRoot = '/opt/allrice40/releases';
const helper = '/opt/allrice40/trial/bin/host-preflight.py';
const dataMount = '/var/lib/allrice40';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const releaseKeys = ['manifestDigest', 'release', 'tree'];

function checkRelease(value) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== releaseKeys.join(',') ||
    !releaseKeys.every((key) => typeof value[key] === 'string') ||
    !/^[0-9a-f]{40}$/.test(value.release) ||
    !/^[0-9a-f]{40}$/.test(value.tree) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.manifestDigest)
  )
    throw new Error('Expected a complete release identity');
}

function validate(config) {
  if (
    !config ||
    Object.keys(config).sort().join(',') !==
      'current,dataUuid,dataVolume,msb,rollback,scratchLuksUuid,scratchMount,scratchUuid' ||
    !/^vol-[a-f0-9]{17}$/.test(config.dataVolume) ||
    ![config.dataUuid, config.scratchUuid, config.scratchLuksUuid].every(
      (value) => typeof value === 'string' && uuid.test(value),
    ) ||
    config.dataUuid === config.scratchUuid ||
    config.scratchMount !== '/mnt/allrice-trial-scratch' ||
    config.msb !== '/opt/allrice40/msb/bin/msb'
  )
    throw new Error('Invalid fixed Linux host probe configuration');
  checkRelease(config.current);
  if (config.rollback !== null) {
    checkRelease(config.rollback);
    if (config.rollback.release === config.current.release)
      throw new Error('Rollback release must be different');
  }
}

function command(executable, args, timeout = 30_000) {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      maxBuffer: 64 * 1024,
    });
  } catch {
    throw new Error('Host check failed: ' + executable.split('/').at(-1));
  }
}

async function readOperatorFile(path) {
  if ((await realpath(path)) !== path) throw new Error('Aliased operator file');
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== 0 ||
      info.mode & 0o022 ||
      info.size > 65536
    )
      throw new Error('Untrusted operator file');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

async function checkedRelease(identity, dataUuid, load) {
  const release = await load(
    releaseRoot + '/' + identity.release,
    identity.manifestDigest,
  );
  if (
    release.sourceSha !== identity.release ||
    release.sourceTree !== identity.tree ||
    release.config.dataUuid !== dataUuid
  )
    throw new Error('Sealed release or data volume identity mismatch');
  return release;
}

function deviceSerial(tree) {
  const disks = [];
  function visit(entries) {
    for (const entry of entries) {
      if (Array.isArray(entry.children) && entry.children.length) {
        visit(entry.children);
      } else if (entry.type === 'disk') {
        disks.push(entry.serial);
      } else {
        throw new Error('Backing disk graph has an unresolved device');
      }
    }
  }
  visit(tree.blockdevices);
  if (disks.length !== 1) throw new Error('Unexpected backing disk graph');
  return disks[0];
}

function mountedVolume(run, target, filesystemUuid) {
  const mounts = run('/usr/bin/findmnt', [
    '--json',
    '--list',
    '--mountpoint',
    target,
    '--output',
    'TARGET,UUID,OPTIONS,SOURCE',
  ]);
  if (filesystemUuid) assertDataMount(mounts, target, filesystemUuid);
  const { filesystems } = JSON.parse(mounts);
  const source = filesystems[0]?.source;
  if (
    filesystems.length !== 1 ||
    filesystems[0].target !== target ||
    typeof source !== 'string' ||
    !/^\/dev\/[a-zA-Z0-9_/-]+$/.test(source)
  )
    throw new Error('Expected an exact device-backed mount');
  const serial = deviceSerial(
    JSON.parse(
      run('/usr/bin/lsblk', [
        '--json',
        '--inverse',
        '--output',
        'NAME,TYPE,SERIAL',
        '--',
        source,
      ]),
    ),
  );
  if (typeof serial !== 'string' || !/^vol[0-9a-f]{17}$/.test(serial))
    throw new Error('Mounted filesystem has no exact EBS serial');
  return serial;
}

// Use the active, verified release's normal verifier to read the old release.
// The old release is data to the verifier, not a source of executable code.
const verifyPrevious = `
  import { pathToFileURL } from 'node:url';
  const [verifier, entrypoint, claimedSha, tree, digest] = process.argv.slice(1);
  const { verifyServiceBuildIdentity } = await import(pathToFileURL(verifier));
  const identity = await verifyServiceBuildIdentity({
    entrypoint, claimedSha, service: 'web', mode: 'production',
  });
  if (identity?.sourceTree !== tree || identity.manifestDigest !== digest) process.exit(1);
  process.stdout.write('verified');
`;

function verifyReady(role, pid, ready, current) {
  const identity = ready?.identity;
  if (
    ready?.status !== 'ready' ||
    identity?.service !== role ||
    identity.pid !== pid ||
    typeof identity.bootId !== 'string' ||
    !uuid.test(identity.bootId) ||
    identity.environment !== 'dev' ||
    identity.mode !== 'production' ||
    identity.repository !== 'semiok/allrice-vm' ||
    identity.repositoryId !== 1469490636 ||
    identity.sourceSha !== current.release ||
    identity.sourceTree !== current.tree ||
    identity.manifestDigest !== current.manifestDigest ||
    (ready.maintenance && ready.maintenance.state !== 'open')
  )
    throw new Error(role + ' is not ready under the approved systemd process');
  return identity.bootId;
}

export async function probeHost(
  settings,
  {
    run = command,
    load = readLinuxRelease,
    readUnit = readOperatorFile,
    readBoot = () => readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
  } = {},
) {
  validate(settings);
  const {
    current,
    rollback,
    dataUuid,
    dataVolume,
    scratchUuid,
    scratchLuksUuid,
  } = settings;
  const release = await checkedRelease(current, dataUuid, load);
  const serial = mountedVolume(run, dataMount, dataUuid);
  if (serial !== dataVolume.replace('-', ''))
    throw new Error(
      'Mounted filesystem does not belong to the approved EBS volume',
    );
  const systemSerial = mountedVolume(run, '/', undefined);
  if (systemSerial === serial)
    throw new Error('Retained data EBS must be physically separate from root');
  const scratchSerial = mountedVolume(run, settings.scratchMount, scratchUuid);
  if (scratchSerial === serial || scratchSerial === systemSerial)
    throw new Error(
      'Scratch must be physically separate from root and retained data EBS',
    );

  const units = renderUnits(release);
  const mainPids = new Map();
  for (const [unit, expected] of units) {
    const path = '/etc/systemd/system/' + unit;
    const output = run('/usr/bin/systemctl', [
      'show',
      unit,
      '--all',
      '--property=FragmentPath,ActiveState,SubState,NeedDaemonReload,DropInPaths,MainPID',
    ]);
    const pid = Number(/^MainPID=([1-9][0-9]*)$/m.exec(output)?.[1]);
    const properties = output.trimEnd().split('\n').sort().join('\n');
    const required = [
      'ActiveState=active',
      'SubState=running',
      'FragmentPath=' + path,
      'NeedDaemonReload=no',
      'DropInPaths=',
      'MainPID=' + pid,
    ]
      .sort()
      .join('\n');
    if (
      !Number.isSafeInteger(pid) ||
      properties !== required ||
      (await readUnit(path)) !== expected
    )
      throw new Error('Active systemd unit differs from the sealed release');
    mainPids.set(unit, pid);
  }

  const scratch = [
    '--scratch-mount',
    settings.scratchMount,
    '--scratch-uuid',
    scratchUuid,
    '--scratch-luks-uuid',
    scratchLuksUuid,
  ];
  const luks = JSON.parse(
    run('/usr/bin/python3', [helper, 'check-luks', ...scratch]),
  );
  const runtime = JSON.parse(
    run('/usr/sbin/runuser', [
      '-u',
      'allrice',
      '--',
      '/usr/bin/python3',
      helper,
      'check-runtime',
      ...scratch,
      '--data-uuid',
      dataUuid,
      '--node',
      release.config.node,
      '--msb',
      settings.msb,
    ]),
  );
  if (
    luks.luks2 !== true ||
    [luks, runtime].some(
      (value) =>
        value.scratchUuid !== scratchUuid ||
        value.scratchLuksUuid !== scratchLuksUuid,
    ) ||
    !/^\d+:\d+$/.test(luks.device) ||
    luks.device !== runtime.scratchDevice ||
    runtime.dataUuid !== dataUuid ||
    runtime.kvmApi !== 12 ||
    runtime.reflink !== true
  )
    throw new Error('Root and Worker host probe evidence differs');

  const checkReady = (role, port, path) =>
    verifyReady(
      role,
      mainPids.get('allrice40-' + role + '.service'),
      JSON.parse(
        run('/usr/bin/curl', [
          '--disable',
          '--fail',
          '--silent',
          '--max-time',
          '5',
          '--noproxy',
          '*',
          `http://127.0.0.1:${port}${path}`,
        ]),
      ),
      current,
    );
  checkReady('worker', release.config.workerPort, '/health/ready');
  const webBootId = checkReady(
    'web',
    release.config.webPort,
    '/api/health/ready',
  );
  if (rollback) {
    const previous = await checkedRelease(rollback, dataUuid, load);
    const verified = run(
      '/usr/sbin/runuser',
      [
        '-u',
        'allrice',
        '--',
        release.config.node,
        '--input-type=module',
        '-e',
        verifyPrevious,
        release.root + '/packages/database/dist/service-build-identity.js',
        previous.root + '/apps/web/server.mjs',
        rollback.release,
        rollback.tree,
        rollback.manifestDigest,
      ],
      90_000,
    );
    if (verified !== 'verified')
      throw new Error('Full rollback release verification failed');
  }
  const bootId = (await readBoot()).trim();
  if (!uuid.test(bootId)) throw new Error('Missing kernel boot identity');
  return {
    bootId,
    webBootId,
    ...current,
    dataVolume,
    dataUuid,
    scratchUuid,
    scratchLuksUuid,
    rollback,
    systemd: [...units.keys()],
    workerReady: true,
    kvmApi: 12,
    luks2: true,
    xfs: true,
    reflink: true,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--dry-run') {
    console.log(
      JSON.stringify({
        mode: 'dry-run',
        checks: [
          'release and rollback seal',
          'active systemd units',
          'exact EBS data mount',
          'LUKS2/XFS',
          'non-root KVM and strict reflink',
          'Web and Worker readiness bound to systemd',
          'boot identity',
        ],
      }),
    );
    return;
  }
  if (
    args.length ||
    process.platform !== 'linux' ||
    process.arch !== 'arm64' ||
    process.getuid?.() !== 0
  )
    throw new Error('Run as the designated Linux arm64 host operator');
  const path = '/etc/allrice40/linux-trial.json';
  if (((await lstat(path)).mode & 0o777) !== 0o600)
    throw new Error('Expected the private Linux trial configuration');
  console.log(
    JSON.stringify(await probeHost(JSON.parse(await readOperatorFile(path)))),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(() => {
    // GetCommandInvocation is region-wide. Do not return raw unit or system output.
    console.error('AllRice Linux acceptance probe failed');
    process.exitCode = 1;
  });
