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
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { source as publicOci } from '../../person-vm-image/verify.mjs';
import { inventoryFile, readSmallFile } from './build.mjs';
import {
  checkCaptureReceipt,
  checkHostPreflight,
  hashPattern,
  payloads,
  requireCapture,
  sha256,
} from './capture-contract.mjs';

const exec = promisify(execFile);
const vm = 'allrice-public-template';
const group = vm;
const snapshot = group + ':baseline';
const cleanEnv = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' };

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
  runtimeDisk,
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
    '--mount-disk',
    runtimeDisk + ':' + dsh + ':format=raw,fstype=ext4,ro',
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
  const info = await lstat(path);
  requireCapture(
    info.isFile() && (info.mode & 0o7222) === 0,
    'unprotected capture input',
  );
  requireCapture(
    (await inventoryFile(path, signal)).sha256 === digest,
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
      checkpoint.disks.length === 1 &&
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
        resources: checkpoint.resources,
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
  const rootDisk = await object(checkpoint.disks[0]);
  const memory = JSON.parse(await readSmallFile(memoryPath, 16 * 1024 * 1024));
  const disk = JSON.parse(await readSmallFile(rootDisk));
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
  return { execution, memoryPath, rootDisk, topology };
}

/** Capture under a dedicated non-root UID in an operator-created disconnected
 * network namespace. Never accepts an existing sandbox or a signing key. */
export async function captureTemplate({
  scratchMount,
  output,
  preflightScript,
  hostNode,
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
        await exactPath(preflightScript),
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
        await exactPath(hostNode),
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

  const scratch = await mkdtemp(join(scratchMount, 's-'));
  const capture = await mkdtemp(join(output, '.capture-'));
  const home = join(scratch, 'm');
  const work = join(scratch, 'w');
  const config = join(scratch, 'msb.json');
  const snapshots = join(home, 'snapshots');
  const env = {
    ...cleanEnv,
    HOME: scratch,
    MSB_HOME: home,
    MSB_CONFIG_PATH: config,
  };
  const msb = (args, phase, active = signal) =>
    command(binary, args, { env, cwd: scratch, signal: active, phase });
  let dispatch = false;
  let stoppedAndRemoved = false;
  try {
    try {
      await mkdir(work, { mode: 0o700 });
      await mkdir(home, { mode: 0o700 });
      await writeFile(
        config,
        JSON.stringify({
          version: 1,
          home,
          allowed_backends: ['local'],
          paths: { msb: binary, libkrunfw: firmware, agentd, snapshots },
        }),
        { mode: 0o600, flag: 'wx' },
      );
      await seedPublicImageCache(
        publicImageCache,
        publicOci.baseImage,
        home,
        signal,
      );
      requireCapture(
        JSON.parse(await msb(['ls', '--format', 'json'], 'empty home'))
          .length === 0,
        'sandbox home is not empty',
      );
      dispatch = true;
      await msb(
        captureCreateArgs({
          runtimeDisk,
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
        [
          'snap',
          'export',
          snapshot,
          '--output',
          join(capture, 'template.msb'),
          '--with-image',
        ],
        'portable export',
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

      const cleanupSignal = globalThis.AbortSignal.timeout(60000);
      await msb(['stop', '-t', '30', vm], 'stop', cleanupSignal);
      const stopped = JSON.parse(
        await msb(
          ['ls', '--format', 'json'],
          'stopped readback',
          cleanupSignal,
        ),
      );
      requireCapture(
        stopped.length === 1 &&
          stopped[0].name === vm &&
          stopped[0].status === 'Stopped',
        'stop not confirmed',
      );
      await msb(['rm', vm], 'remove', cleanupSignal);
      requireCapture(
        JSON.parse(
          await msb(
            ['ls', '--format', 'json'],
            'removed readback',
            cleanupSignal,
          ),
        ).length === 0,
        'sandbox removal not confirmed',
      );
      stoppedAndRemoved = true;

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
        const active = globalThis.AbortSignal.timeout(60000);
        try {
          const entries = JSON.parse(
            await msb(['ls', '--format', 'json'], 'cleanup inventory', active),
          );
          if (entries.length === 1 && entries[0].name === vm) {
            if (entries[0].status !== 'Stopped')
              await msb(['stop', '-t', '30', vm], 'cleanup stop', active);
            const stopped = JSON.parse(
              await msb(['ls', '--format', 'json'], 'cleanup readback', active),
            );
            requireCapture(
              stopped.length === 1 &&
                stopped[0].name === vm &&
                stopped[0].status === 'Stopped',
              'cleanup stop not confirmed',
            );
            await msb(['rm', vm], 'cleanup remove', active);
            stoppedAndRemoved =
              JSON.parse(
                await msb(
                  ['ls', '--format', 'json'],
                  'cleanup removed readback',
                  active,
                ),
              ).length === 0;
          }
        } catch {
          // Leave the exact private scratch with its native owner for inspection.
        }
        requireCapture(
          stoppedAndRemoved,
          'stop unconfirmed; retained isolated scratch ' + scratch,
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
