import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { release } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { source as publicOci } from '../../person-vm-image/verify.mjs';
import { inventoryFile, readSmallFile } from './build.mjs';
import {
  checkCaptureReceipt,
  checkHostPreflight,
  hashPattern,
  matches,
  payloads,
  requireCapture,
  sha256,
} from './capture-contract.mjs';

const exec = promisify(execFile);
const vm = 'allrice-public-template';
const group = vm;
const snapshot = group + ':baseline';
const runtimeVolume = 'allrice-public-dsh';
const cleanEnv = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' };
const preflightSha256 =
  'a3a66dbf99e09dbee605b2fefa1cfbe81c1f96f02b4a854fafe4ce8316b67d50';

async function command(program, args, { env, cwd, signal, phase }) {
  try {
    const { stdout } = await exec(program, args, {
      env,
      cwd,
      signal,
      maxBuffer: 512 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const code = Number.isInteger(error.code)
      ? ' (exit ' + error.code + ')'
      : '';
    throw new Error('Snapshot capture refused: ' + phase + code);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function cpuAbi(cpuinfo) {
  const groups = cpuinfo
    .trim()
    .split(/\n\s*\n/)
    .filter((block) => /^processor\s*:/m.test(block));
  const modelFields = [
    'CPU implementer',
    'CPU architecture',
    'CPU variant',
    'CPU part',
    'CPU revision',
  ];
  const profiles = groups.map((block) => {
    const fields = new Map(
      block
        .split('\n')
        .map((line) => line.split(':').map((value) => value.trim())),
    );
    const model = modelFields.map((key) => fields.get(key));
    const flags = fields.get('Features')?.split(/\s+/).sort();
    requireCapture(
      model.every(Boolean) && flags?.length && flags.every(Boolean),
      'CPU ABI unavailable',
    );
    return {
      cpuModel: model.join('/'),
      cpuFeaturesSha256: sha256(flags.join(' ')),
    };
  });
  requireCapture(
    profiles.length > 0 &&
      profiles.every(
        (profile) => JSON.stringify(profile) === JSON.stringify(profiles[0]),
      ),
    'heterogeneous CPU ABI',
  );
  return profiles[0];
}

export function captureCreateArgs({
  runtimeSizeMiB,
  dsh,
  controlsHost,
  controls,
  work,
}) {
  return [
    'create',
    publicOci.baseImage,
    '--name',
    vm,
    '--pull',
    'never',
    '--cpus',
    '2',
    '--max-cpus',
    '2',
    '--memory',
    '2048M',
    '--max-memory',
    '2048M',
    '--root-disk',
    'flat:10G,clone=reflink',
    '--net-default',
    'deny',
    '--workdir',
    '/',
    '--user',
    'root',
    '--mount-dir',
    work + ':/work',
    '--mount-named',
    runtimeVolume + ':' + dsh + ':kind=disk,size=' + runtimeSizeMiB + 'M,ro',
    '--mount-dir',
    controlsHost + ':' + controls + ':ro',
  ];
}

async function exactPath(path) {
  requireCapture(
    typeof path === 'string' &&
      isAbsolute(path) &&
      !/[:\0\r\n]/.test(path) &&
      (await realpath(path)) === path,
    'unexpected input path',
  );
  return path;
}

async function sealedInput(path, digest, signal) {
  await exactPath(path);
  requireCapture(matches(hashPattern, digest), 'expected pinned input digest');
  const info = await lstat(path);
  const parent = await lstat(dirname(path));
  requireCapture(
    info.isFile() &&
      (info.mode & 0o7222) === 0 &&
      info.nlink === 1 &&
      [0, process.getuid()].includes(info.uid) &&
      (parent.mode & 0o7022) === 0 &&
      [0, process.getuid()].includes(parent.uid),
    'unprotected capture input',
  );
  requireCapture(
    (await inventoryFile(path, signal, undefined, info.uid)).sha256 === digest,
    'capture input digest mismatch',
  );
  return path;
}

export async function readNativeCheckpoint(artifact, expected, signal) {
  const checkpointDirectory = join(artifact, 'checkpoint');
  const descriptor = JSON.parse(
    await readSmallFile(join(artifact, 'snapshot.json')),
  );
  const checkpointBytes = await readSmallFile(
    join(checkpointDirectory, 'checkpoint.json'),
  );
  const checkpoint = JSON.parse(checkpointBytes);
  const geometry = checkpoint.geometry;
  requireCapture(
    descriptor.schema === 'microsandbox.snapshot/1' &&
      descriptor.scope === 'checkpoint' &&
      descriptor.root_disk?.layout === 'flat' &&
      descriptor.parent === null &&
      descriptor.image?.reference === publicOci.baseImage &&
      descriptor.image.manifest_digest ===
        'sha256:' + expected.inputs.imageSha256 &&
      descriptor.capture?.source_lineage === vm &&
      descriptor.capture.consistency === 'application-consistent' &&
      descriptor.state?.kind === 'checkpoint' &&
      descriptor.state.checkpoint_root ===
        'sha256:' + sha256(checkpointBytes) &&
      descriptor.state.checkpoint_id === checkpoint.checkpoint_id &&
      descriptor.capture.source_checkpoint === checkpoint.checkpoint_id &&
      checkpoint.schema === 'microsandbox.checkpoint/1' &&
      checkpoint.architecture === 'aarch64' &&
      geometry?.vcpus === 2 &&
      geometry.max_vcpus === 2 &&
      geometry.memory_mib === 2048 &&
      geometry.max_memory_mib === 2048 &&
      Array.isArray(checkpoint.disks) &&
      checkpoint.disks.length === 2 &&
      (checkpoint.owned_volumes === undefined ||
        (Array.isArray(checkpoint.owned_volumes) &&
          checkpoint.owned_volumes.length === 0)) &&
      Array.isArray(checkpoint.devices) &&
      checkpoint.devices.length > 0 &&
      Array.isArray(checkpoint.resources) &&
      checkpoint.resources.every((resource) => resource.treatment !== 'reject'),
    'native checkpoint ABI or resource closure mismatch',
  );
  const topology = Buffer.from(
    JSON.stringify(
      canonical({
        devices: checkpoint.devices.map(({ device_id, device_type }) => ({
          device_id,
          device_type,
        })),
        // Per-boot grants and network identities stay bound by the raw
        // checkpoint hash. Only stable device layout enters the profile pin.
        resources: checkpoint.resources.map(({ binding, ...resource }) => ({
          ...resource,
          binding: Object.fromEntries(
            Object.entries(binding).filter(
              ([key]) =>
                ![
                  'source_binding_token',
                  'guest_network',
                  'gateway_mac',
                ].includes(key),
            ),
          ),
        })),
        geometry,
      }),
    ),
  );
  requireCapture(
    sha256(topology) === expected.deviceTopologySha256,
    'native device topology mismatch',
  );

  async function object(id) {
    requireCapture(
      typeof id === 'string' &&
        id.startsWith('sha256:') &&
        hashPattern.test(id.slice(7)),
      'invalid checkpoint object identity',
    );
    const hash = id.slice(7);
    const path = join(
      checkpointDirectory,
      'objects',
      'sha256',
      hash.slice(0, 2),
      hash,
    );
    requireCapture(
      (await realpath(path)) === path &&
        (await inventoryFile(path, signal)).sha256 === hash,
      'native checkpoint object digest mismatch',
    );
    return path;
  }
  const execution = await object(checkpoint.execution_state);
  const memoryPath = await object(checkpoint.memory);
  const disks = await Promise.all(
    checkpoint.disks.map(async (id) => {
      const path = await object(id);
      return { path, manifest: JSON.parse(await readSmallFile(path)) };
    }),
  );
  const dshGuestPath = '/opt/allrice/dsh/' + publicOci.artifactSha256;
  const runtimeResource = checkpoint.resources.find(
    ({ binding }) =>
      binding.guest_path === dshGuestPath && binding.managed_disk === 'true',
  );
  const runtimeDevice = runtimeResource?.binding.device_id;
  const runtime = disks.find(
    ({ manifest }) => manifest.device_id === runtimeDevice,
  );
  const root = disks.find(({ manifest }) =>
    [undefined, 'vda', 'vdb'].includes(manifest.device_id),
  );
  requireCapture(
    runtimeDevice &&
      runtime &&
      root &&
      runtime !== root &&
      runtimeResource.binding.fstype === 'ext4' &&
      JSON.parse(runtimeResource.binding.mount_options).readonly === true,
    'native public runtime disk binding mismatch',
  );
  const [runtimeLayer] = runtime.manifest.layers;
  requireCapture(
    runtime.manifest.layers.length === 1 &&
      runtimeLayer?.format === 'raw' &&
      /^[a-zA-Z0-9_-]+$/.test(runtimeLayer.layer_id) &&
      runtime.manifest.pause_generation === checkpoint.pause_generation,
    'native public runtime disk generation mismatch',
  );
  const runtimeLayerPath = join(
    checkpointDirectory,
    'layers',
    runtimeLayer.layer_id + '.raw',
  );
  await exactPath(runtimeLayerPath);
  const runtimeBytes = await inventoryFile(runtimeLayerPath, signal);
  requireCapture(
    runtimeBytes.sha256 === expected.inputs.dshRuntimeDiskSha256 &&
      runtimeBytes.sizeBytes === runtimeLayer.file_size,
    'native public runtime disk bytes mismatch',
  );
  const rootDisk = root.path;
  const memory = JSON.parse(await readSmallFile(memoryPath, 16 * 1024 * 1024));
  const disk = root.manifest;
  requireCapture(
    memory.schema === 'microsandbox.memory/1' &&
      memory.architecture === 'aarch64' &&
      memory.guest_page_size === expected.guest.pageSize &&
      memory.pause_generation === checkpoint.pause_generation &&
      disk.pause_generation === checkpoint.pause_generation &&
      Array.isArray(disk.layers) &&
      disk.layers.length > 0,
    'native memory or disk generation mismatch',
  );
  return {
    execution,
    memoryPath,
    rootDisk,
    topology,
    checkpointRoot: descriptor.state.checkpoint_root,
  };
}

/** Capture under a dedicated non-root UID in an operator-created disconnected
 * network namespace. Never accepts an existing sandbox or a signing key. */
export async function captureTemplate({
  scratchMount,
  output,
  preflightScript,
  hostNode,
  hostNodeSha256,
  native,
  controls,
  publicImageCache,
  profilePath,
  guestKernelPath,
  isolationPolicyPath,
  outsideNetNamespace,
  dataUuid,
  scratchUuid,
  scratchLuksUuid,
  expected,
  signal,
}) {
  requireCapture(
    process.platform === 'linux' &&
      process.arch === 'arm64' &&
      process.getuid() !== 0,
    'capture requires a dedicated non-root arm64 Linux account',
  );
  requireCapture(
    /^net:\[\d+\]$/.test(outsideNetNamespace) &&
      outsideNetNamespace !== (await readlink('/proc/self/ns/net')),
    'capture requires an isolated host network namespace',
  );
  const interfaces = (await readFile('/proc/net/dev', 'utf8'))
    .trim()
    .split('\n')
    .slice(2)
    .map((line) => line.split(':')[0].trim());
  requireCapture(
    interfaces.length === 1 && interfaces[0] === 'lo',
    'host capture network is not disconnected',
  );
  await exactPath(scratchMount);
  await exactPath(output);
  const outputStat = await lstat(output);
  requireCapture(
    output.startsWith(scratchMount + '/') &&
      outputStat.isDirectory() &&
      outputStat.uid === process.getuid() &&
      (outputStat.mode & 0o7777) === 0o700,
    'capture output must be a private directory on scratch',
  );
  const { host, guest, inputs } = expected;
  const observed = cpuAbi(await readFile('/proc/cpuinfo', 'utf8'));
  requireCapture(
    host.kernel === release() &&
      host.cpuModel === observed.cpuModel &&
      host.cpuFeaturesSha256 === observed.cpuFeaturesSha256,
    'running host CPU or kernel ABI mismatch',
  );
  const binary = await sealedInput(native.msb, inputs.vmmSha256, signal);
  const preflight = JSON.parse(
    await command(
      '/usr/bin/python3',
      [
        await sealedInput(preflightScript, preflightSha256, signal),
        'check-runtime',
        '--scratch-mount',
        scratchMount,
        '--data-uuid',
        dataUuid,
        '--scratch-uuid',
        scratchUuid,
        '--scratch-luks-uuid',
        scratchLuksUuid,
        '--node',
        await sealedInput(hostNode, hostNodeSha256, signal),
        '--msb',
        binary,
      ],
      { env: cleanEnv, phase: 'host preflight', signal },
    ),
  );
  checkHostPreflight(host, preflight);
  requireCapture(
    preflight.dataUuid === dataUuid &&
      preflight.scratchUuid === scratchUuid &&
      preflight.scratchLuksUuid === scratchLuksUuid &&
      (await lstat(scratchMount)).dev === outputStat.dev,
    'scratch mount changed',
  );
  const firmware = await sealedInput(
    native.libkrunfw,
    inputs.firmwareSha256,
    signal,
  );
  const agentd = await sealedInput(native.agentd, inputs.agentdSha256, signal);
  // The guest kernel is provided by this pinned firmware. Keep the publisher's
  // separately inspected kernel bytes in the same approved release inputs.
  await sealedInput(guestKernelPath, guest.kernelSha256, signal);
  await sealedInput(profilePath, inputs.dshProfileSha256, signal);
  await sealedInput(isolationPolicyPath, inputs.isolationPolicySha256, signal);
  const runtimeDisk = await sealedInput(
    native.runtimeDisk,
    inputs.dshRuntimeDiskSha256,
    signal,
  );
  const runtimeSize = (await lstat(runtimeDisk)).size;
  const runtimeSizeMiB = runtimeSize / 1024 ** 2;
  requireCapture(
    Number.isSafeInteger(runtimeSizeMiB) && runtimeSizeMiB > 0,
    'runtime must have a whole-MiB volume size',
  );
  requireCapture(
    controls.sha256 === inputs.commandMemorySha256,
    'command memory digest mismatch',
  );
  const [{ seedPublicImageCache }, { verifyReadonlyCommandMemoryDirectory }] =
    await Promise.all([
      import('../../../packages/person-vm/src/image-cache.ts'),
      import('../../../packages/person-vm/src/readonly-artifact.ts'),
    ]);
  await verifyReadonlyCommandMemoryDirectory(controls, signal);
  const controlsHost = await exactPath(controls.hostDirectory);
  const dsh = '/opt/allrice/dsh/' + publicOci.artifactSha256;

  const capture = await mkdtemp(join(output, '.capture-'));
  let scratch;
  try {
    scratch = await mkdtemp(join(scratchMount, 's-'));
  } catch (error) {
    await rm(capture, { recursive: true, force: true });
    throw error;
  }
  const home = join(scratch, 'm');
  const work = join(scratch, 'w');
  const config = join(scratch, 'msb.json');
  const snapshots = join(home, 'snapshots');
  const volumes = join(home, 'volumes');
  async function configureMsb(home, config) {
    await mkdir(home, { mode: 0o700 });
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        home,
        allowed_backends: ['local'],
        paths: {
          msb: binary,
          libkrunfw: firmware,
          agentd,
          snapshots: join(home, 'snapshots'),
          volumes: join(home, 'volumes'),
        },
      }),
      { mode: 0o600, flag: 'wx' },
    );
    const env = {
      ...cleanEnv,
      HOME: home,
      MSB_HOME: home,
      MSB_CONFIG_PATH: config,
    };
    return (args, phase, active = signal) =>
      command(binary, args, { env, cwd: home, signal: active, phase });
  }
  let msb;
  let dispatch = false;
  let stoppedAndRemoved = false;
  async function listSandboxes(active) {
    const rows = JSON.parse(
      await msb(['ls', '--format', 'json'], 'sandbox inventory', active),
    );
    requireCapture(Array.isArray(rows), 'sandbox inventory unavailable');
    return rows;
  }
  async function stopAndRemove() {
    const active = globalThis.AbortSignal.timeout(60000);
    const rows = await listSandboxes(active);
    requireCapture(
      rows.length === 1 && rows[0].name === vm,
      'capture owner missing',
    );
    if (rows[0].status !== 'Stopped')
      await msb(['stop', '-t', '30', vm], 'stop', active);
    const stopped = await listSandboxes(active);
    requireCapture(
      stopped.length === 1 &&
        stopped[0].name === vm &&
        stopped[0].status === 'Stopped',
      'stop not confirmed',
    );
    await msb(['rm', vm], 'remove', active);
    requireCapture(
      (await listSandboxes(active)).length === 0,
      'sandbox removal not confirmed',
    );
    stoppedAndRemoved = true;
  }
  try {
    try {
      await mkdir(work, { mode: 0o700 });
      msb = await configureMsb(home, config);
      await seedPublicImageCache(
        publicImageCache,
        publicOci.baseImage,
        home,
        signal,
      );
      requireCapture(
        (await listSandboxes(signal)).length === 0,
        'sandbox home is not empty',
      );
      await msb(
        [
          'volume',
          'create',
          runtimeVolume,
          '--kind',
          'disk',
          '--size',
          runtimeSizeMiB + 'M',
        ],
        'private public-runtime volume',
      );
      const allocated = JSON.parse(
        await msb(
          ['volume', 'ls', '--format', 'json'],
          'native volume inventory',
        ),
      );
      requireCapture(
        allocated.length === 1 &&
          allocated[0].name === runtimeVolume &&
          allocated[0].kind === 'disk' &&
          allocated[0].disk_format === 'raw' &&
          allocated[0].disk_fstype === 'ext4' &&
          allocated[0].capacity_bytes === runtimeSize,
        'unexpected native volume allocation',
      );
      const blank = await exactPath(join(volumes, runtimeVolume, 'disk.raw'));
      const blankStat = await lstat(blank);
      requireCapture(
        blankStat.isFile() &&
          blankStat.uid === process.getuid() &&
          blankStat.nlink === 1 &&
          blankStat.size === runtimeSize,
        'unowned native volume file',
      );
      const seeded = blank + '.seeded';
      const seededDisk = await inventoryFile(runtimeDisk, signal, seeded);
      requireCapture(
        seededDisk.sha256 === inputs.dshRuntimeDiskSha256 &&
          seededDisk.sizeBytes === runtimeSize,
        'public runtime disk changed while seeding',
      );
      await rename(seeded, blank);
      dispatch = true;
      const archive = join(capture, 'template.msb');
      await msb(
        captureCreateArgs({
          runtimeSizeMiB,
          dsh,
          controlsHost,
          controls: controls.guestDirectory,
          work,
        }),
        'create',
      );
      await msb(['exec', vm, '--', '/usr/bin/sync'], 'guest sync');
      const auditSource = await readSmallFile(
        new URL('./guest-audit.mjs', import.meta.url),
      );
      const audit = JSON.parse(
        await msb(
          [
            'exec',
            vm,
            '--',
            '/usr/local/bin/node',
            '--input-type=module',
            '--eval',
            auditSource.toString('utf8'),
            '--',
            '--audit-guest',
            dsh,
            controls.guestDirectory,
            String(guest.pageSize),
          ],
          'guest audit',
        ),
      );
      await msb(
        [
          'snap',
          'create',
          'baseline',
          '--sandbox',
          vm,
          '--group',
          group,
          '--full',
          '--integrity',
        ],
        'full snapshot',
      );
      await msb(['snap', 'verify', snapshot], 'native integrity');
      const entries = JSON.parse(
        await msb(
          ['snap', 'ls', '--group', group, '--format', 'json'],
          'snapshot readback',
        ),
      );
      const entry = entries[0];
      requireCapture(
        entries.length === 1 &&
          entry.name === 'baseline' &&
          entry.group === group &&
          entry.scope === 'full' &&
          typeof entry.artifact_path === 'string' &&
          entry.artifact_path.startsWith(snapshots + '/' + group + '/'),
        'unexpected snapshot artifact identity',
      );
      const artifact = await exactPath(entry.artifact_path);
      const nativeCapture = await readNativeCheckpoint(
        artifact,
        expected,
        signal,
      );
      await msb(
        ['snap', 'export', snapshot, '--output', archive, '--with-image'],
        'portable export',
      );
      await stopAndRemove();
      // Import into a fresh registry and empty image cache. This checks the exported closure
      // without resuming any guest or pulling an image for that guest.
      const readbackGroup = 'template-archive-readback';
      const readbackHome = join(scratch, 'r');
      const readback = await configureMsb(
        readbackHome,
        join(scratch, 'readback.json'),
      );
      await readback(
        ['snap', 'import', archive, '--group', readbackGroup],
        'portable archive readback',
      );
      const imported = JSON.parse(
        await readback(
          ['snap', 'ls', '--group', readbackGroup, '--format', 'json'],
          'portable archive inventory',
        ),
      );
      const importedPath = imported[0]?.artifact_path;
      requireCapture(
        imported.length === 1 &&
          typeof importedPath === 'string' &&
          importedPath.startsWith(
            join(readbackHome, 'snapshots', readbackGroup) + '/',
          ),
        'portable archive identity mismatch',
      );
      const importedRoot = await exactPath(importedPath);
      const archiveCheckpoint = await readNativeCheckpoint(
        importedRoot,
        expected,
        signal,
      );
      requireCapture(
        archiveCheckpoint.checkpointRoot === nativeCapture.checkpointRoot,
        'portable archive checkpoint mismatch',
      );
      await readback(
        ['snap', 'verify', importedRoot],
        'portable archive integrity',
      );
      const files = [];
      for (const [path, source] of Object.entries({
        'execution.bin': nativeCapture.execution,
        'memory.json': nativeCapture.memoryPath,
        'root-disk.json': nativeCapture.rootDisk,
        'runtime.ext4': runtimeDisk,
      })) {
        files.push({
          path,
          role: payloads[path],
          ...(await inventoryFile(source, signal, join(capture, path))),
        });
      }
      await writeFile(
        join(capture, 'device-topology.json'),
        nativeCapture.topology,
        { mode: 0o444, flag: 'wx' },
      );
      for (const path of ['device-topology.json', 'template.msb']) {
        files.push({
          path,
          role: payloads[path],
          ...(await inventoryFile(join(capture, path), signal)),
        });
      }

      const receipt = {
        version: 1,
        mode: 'linux',
        boot: 'new-offline-public-oci',
        cleanup: 'stopped-and-removed',
        full: true,
        integrityVerified: true,
        engineVersion: '0.7.16',
        host,
        guest,
        inputs,
        deviceTopologySha256: expected.deviceTopologySha256,
        preflight,
        audit,
        files,
      };
      checkCaptureReceipt(receipt, { mode: 'linux', expected });
      const bytes = Buffer.from(JSON.stringify(receipt));
      const captureSha256 = sha256(bytes);
      await writeFile(join(capture, 'capture.json'), bytes, {
        mode: 0o444,
        flag: 'wx',
      });
      await chmod(join(capture, 'template.msb'), 0o444);
      const directory = join(output, 'capture-' + captureSha256);
      await rename(capture, directory);
      return { directory, captureSha256 };
    } catch (error) {
      if (dispatch && !stoppedAndRemoved) {
        try {
          await stopAndRemove();
        } catch {
          // Leave the exact private scratch with its native owner for inspection.
        }
        requireCapture(
          stoppedAndRemoved,
          'stop unconfirmed; retained isolated scratch ' +
            scratch +
            (error.message.startsWith('Snapshot capture refused:')
              ? '. First failure was ' +
                error.message.slice('Snapshot capture refused: '.length)
              : '. First failure was capture readback'),
        );
      }
      throw error;
    }
  } finally {
    if (!dispatch || stoppedAndRemoved)
      await rm(scratch, { recursive: true, force: true });
    await rm(capture, { recursive: true, force: true });
  }
}
