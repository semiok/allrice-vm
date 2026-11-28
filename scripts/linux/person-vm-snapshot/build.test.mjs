import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { sealTemplate } from './build.mjs';
import { captureCreateArgs, cpuAbi, readNativeCheckpoint } from './capture.mjs';
import { sha256 } from './capture-contract.mjs';
import { assertEmptyGuest } from './guest-audit.mjs';
import { verifyTemplate } from './verify.mjs';
import { source as oci } from '../../person-vm-image/verify.mjs';

import {
  cleanGuest,
  controls,
  createCaptureFixture,
  digest,
  dsh,
  guest,
  host,
  inputs,
  profile,
  signal,
} from './capture.fixture.mjs';

const fixtures = (t) => createCaptureFixture(t.onTestFinished);

test('seals identical input deterministically and archives it as an offline fixture', async (t) => {
  const f = await fixtures(t);
  const first = await sealTemplate(f.options);
  const other = join(f.root, 'other-seal');
  await mkdir(other, { mode: 0o700 });
  t.onTestFinished(async () => {
    try {
      await chmod(join(other, first.seal.manifestSha256), 0o700);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  });
  const second = await sealTemplate({ ...f.options, output: other });
  assert.equal(second.seal.manifestSha256, first.seal.manifestSha256);
  for (const name of ['manifest.json', 'manifest.sig']) {
    assert.deepEqual(
      await readFile(join(second.seal.templateDirectory, name)),
      await readFile(join(first.seal.templateDirectory, name)),
    );
  }
  await chmod(second.seal.templateDirectory, 0o700);
  const verify = {
    seal: first.seal,
    expected: f.options.expected,
    publicKey: f.publicKey,
    publisherUid: process.getuid(),
    signal: signal(),
  };
  await assert.rejects(
    verifyTemplate(verify),
    /missing build, integrity or cleanup proof/,
  );
  assert.deepEqual(
    await verifyTemplate({ ...verify, captureMode: 'fixture' }),
    first,
  );
  const index = JSON.parse(
    await readFile(join(first.seal.templateDirectory, 'first-day-index.json')),
  );
  assert.equal(index.run.mode, 'fixture');
  assert.deepEqual(
    index.records.map(({ step, result }) => [step, result]),
    [
      ['preflight', 'pass'],
      ['host', 'skip'],
      ['single-vm', 'skip'],
      ['workbench', 'skip'],
      ['timing', 'skip'],
      ['concurrency', 'skip'],
      ['recovery', 'skip'],
    ],
  );
  const receipt = await readFile(
    join(first.seal.templateDirectory, index.records[0].artifact.file),
  );
  assert.equal(sha256(receipt), index.records[0].artifact.sha256);
  await assert.rejects(sealTemplate(f.options), /already published/);
  assert.deepEqual(await readdir(f.output), [first.seal.manifestSha256]);
});

test('competing publishers leave exactly one verified generation', async (t) => {
  const f = await fixtures(t);
  const results = await Promise.allSettled([
    sealTemplate(f.options),
    sealTemplate(f.options),
  ]);
  assert.equal(
    results.filter(({ status }) => status === 'fulfilled').length,
    1,
  );
  assert.equal((await readdir(f.output)).length, 1);
});

test('rejects receipt bytes different from the reviewer pin', async (t) => {
  const f = await fixtures(t);
  f.options.captureSha256 = digest;
  await assert.rejects(sealTemplate(f.options), /receipt digest mismatch/);
});

test('refuses unconfirmed cleanup or a missing empty guest audit', async (t) => {
  const f = await fixtures(t);
  f.receipt.cleanup = 'unknown';
  await f.save();
  await assert.rejects(sealTemplate(f.options), /cleanup proof/);
  f.receipt.cleanup = 'stopped-and-removed';
  f.receipt.audit.noSeedFiles = false;
  await f.save();
  await assert.rejects(sealTemplate(f.options), /empty-guest audit/);
  assert.deepEqual(await readdir(f.output), []);
});

test('refuses mismatched MSB, KVM, kernel, pages and data/scratch overlap', async (t) => {
  const f = await fixtures(t);
  const valid = { ...f.receipt.preflight };
  for (const change of [
    { msbVersion: '0.7.17' },
    { kvmApi: 11 },
    { kernel: '5.15.0' },
    { pageBytes: 65536 },
    { scratchDevice: valid.dataDevice },
  ]) {
    f.receipt.preflight = { ...valid, ...change };
    await f.save();
    await assert.rejects(
      sealTemplate(f.options),
      /ABI or scratch identity mismatch/,
    );
  }
});

test('refuses changed bytes, permissions, symlink, and trailing files before publication', async (t) => {
  const f = await fixtures(t);
  const file = join(f.source, 'execution.bin');
  await chmod(file, 0o644);
  await assert.rejects(sealTemplate(f.options), /link count or permissions/);
  await writeFile(file, 'x'.repeat('execution.bin'.length));
  await chmod(file, 0o444);
  await assert.rejects(sealTemplate(f.options), /payload changed/);
  await rm(file);
  const outside = join(f.root, 'outside.bin');
  await writeFile(outside, 'execution.bin', { mode: 0o444 });
  await symlink(outside, file);
  await assert.rejects(sealTemplate(f.options), { code: 'ELOOP' });
  await writeFile(join(f.source, 'tail.json'), '{}');
  await assert.rejects(
    sealTemplate(f.options),
    /trailing or missing capture file/,
  );
  assert.deepEqual(await readdir(f.output), []);
});

test('permits only empty writable work and public read-only mounts', () => {
  assert.equal(assertEmptyGuest(cleanGuest, profile).workEmpty, true);
  for (const [change, error] of [
    [{ work: ['tenant'] }, /tenant directory/],
    [{ privateEntries: ['/home/node/employee'] }, /tenant directory/],
    [{ seeds: ['/var/lib/systemd/random-seed'] }, /seed or host key/],
    [{ inet: ['0.0.0.0:8080'] }, /network listener/],
    [{ unix: ['@private-app'] }, /network listener/],
    [{ swap: ['/swap'] }, /active swap/],
    [{ pageSize: 65536 }, /ABI page size/],
    [
      {
        mounts: [
          ...cleanGuest.mounts,
          { path: '/home', type: 'virtiofs', flags: ['ro'] },
        ],
      },
      /unexpected template mount/,
    ],
    [
      {
        processes: [
          { ...cleanGuest.processes[0], fds: ['/dev/vport0p1', '/work/file'] },
          cleanGuest.processes[1],
        ],
      },
      /open descriptor/,
    ],
    [
      {
        processes: [
          { ...cleanGuest.processes[0], env: ['TENANT_SECRET'] },
          cleanGuest.processes[1],
        ],
      },
      /environment/,
    ],
  ]) {
    assert.throws(
      () => assertEmptyGuest({ ...cleanGuest, ...change }, profile),
      error,
    );
  }
});

test('pins the local offline command arguments and all CPU cores', () => {
  const args = captureCreateArgs({
    runtimeSizeMiB: 1536,
    dsh,
    controlsHost: '/input/controls',
    controls,
    work: '/scratch/empty',
  });
  assert.equal(args[args.indexOf('--pull') + 1], 'never');
  assert.equal(args[args.indexOf('--net-default') + 1], 'deny');
  assert.equal(args[args.indexOf('--mount-dir') + 1], '/scratch/empty:/work');
  assert.equal(
    args[args.indexOf('--mount-named') + 1],
    'allrice-public-dsh:' + dsh + ':kind=disk,size=1536M,ro',
  );
  assert.deepEqual(
    args.filter((arg) => arg === '--port' || arg === '--net-rule'),
    [],
  );
  const info = (id, features = 'fp asimd') =>
    'processor: ' +
    id +
    '\nFeatures: ' +
    features +
    '\nCPU implementer: 0x41\nCPU architecture: 8\nCPU variant: 0x0\nCPU part: 0xd0c\nCPU revision: 1';
  assert.deepEqual(cpuAbi(info(0) + '\n\n' + info(1, 'asimd fp')), {
    cpuModel: '0x41/8/0x0/0xd0c/1',
    cpuFeaturesSha256: sha256('asimd fp'),
  });
  assert.throws(
    () => cpuAbi(info(0) + '\n\n' + info(1, 'asimd')),
    /heterogeneous CPU ABI/,
  );
});

test('reads the pinned checkpoint generations and rejects native capture ABI and object drift', async (t) => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'native-snapshot-fixture-'),
  );
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const checkpointRoot = join(root, 'checkpoint');
  async function object(bytes) {
    const hash = sha256(bytes);
    const dir = join(checkpointRoot, 'objects/sha256', hash.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const path = join(dir, hash);
    await writeFile(path, bytes);
    return { id: 'sha256:' + hash, path };
  }
  const state = await object('VMM execution bytes');
  const ram = await object(
    JSON.stringify({
      schema: 'microsandbox.memory/1',
      architecture: 'aarch64',
      guest_page_size: 4096,
      pause_generation: 7,
    }),
  );
  const disk = await object(
    JSON.stringify({ layers: [{}], pause_generation: 7 }),
  );
  const runtimeRaw = join(checkpointRoot, 'layers', 'public-dsh.raw');
  await mkdir(join(checkpointRoot, 'layers'));
  await writeFile(runtimeRaw, 'runtime.ext4');
  const runtime = await object(
    JSON.stringify({
      device_id: 'dsh-device',
      layers: [
        {
          layer_id: 'public-dsh',
          format: 'raw',
          file_size: Buffer.byteLength('runtime.ext4'),
        },
      ],
      pause_generation: 7,
    }),
  );
  const geometry = {
    vcpus: 2,
    max_vcpus: 2,
    memory_mib: 2048,
    max_memory_mib: 2048,
  };
  const devices = [{ device_id: 'root', device_type: 2 }];
  const resources = [
    {
      binding: {
        device_id: 'dsh-device',
        fstype: 'ext4',
        guest_path: '/opt/allrice/dsh/' + oci.artifactSha256,
        managed_disk: 'true',
        mount_options: '{"readonly":true}',
      },
      id: 'virtio:2:dsh-device',
      kind: 'block',
      treatment: 'serialize',
    },
    {
      binding: {
        device_id: 'work',
        role: 'external_bind',
      },
      id: 'virtio:26:work',
      kind: 'virtiofs',
      treatment: 'reconnect',
    },
    {
      binding: {
        agent_version: '0.7.16',
        bulk_port: 'agent-bulk',
        bulk_profile: 'dual-port-v1',
        protocol_generation: '8',
        workload_transport_barrier_version: 1,
      },
      id: 'guest:agentd',
      kind: 'agent',
      treatment: 'serialize',
    },
  ];
  const topology = {
    devices,
    geometry: {
      max_memory_mib: 2048,
      max_vcpus: 2,
      memory_mib: 2048,
      vcpus: 2,
    },
    resources,
  };
  const expected = {
    host,
    guest,
    inputs,
    deviceTopologySha256: sha256(JSON.stringify(topology)),
  };
  const rawResources = (attempt) => [
    resources[0],
    {
      ...resources[1],
      binding: {
        ...resources[1].binding,
        source_binding_token: 'fresh-grant-' + attempt,
        source_sandbox: 'allrice-public-template',
      },
    },
    {
      ...resources[2],
      binding: {
        agent_version: '0.7.16',
        attempt_id: 'capture-' + attempt,
        protocol_generation: '8',
        ready_time_ns: String(attempt * 10),
        transport_guest_bulk_bytes: String(attempt * 15),
        ready: JSON.stringify({
          boot_time_ns: attempt,
          init_time_ns: attempt * 2,
          ready_time_ns: attempt * 10,
          workload_transport_barrier_version: 1,
          bulk_transport: {
            profile: 'dual-port-v1',
            port: 'agent-bulk',
            connection_id: Array(16).fill(attempt),
          },
        }),
      },
    },
  ];
  const checkpoint = {
    schema: 'microsandbox.checkpoint/1',
    architecture: 'aarch64',
    checkpoint_id: 'fixture',
    pause_generation: 7,
    execution_state: state.id,
    memory: ram.id,
    disks: [disk.id, runtime.id],
    geometry,
    resources: rawResources(1),
    devices,
  };
  const descriptor = {
    schema: 'microsandbox.snapshot/1',
    scope: 'checkpoint',
    root_disk: { layout: 'flat' },
    parent: null,
    capture: {
      source_lineage: 'allrice-public-template',
      consistency: 'application-consistent',
      source_checkpoint: 'fixture',
    },
    image: { reference: oci.baseImage, manifest_digest: 'sha256:' + digest },
    state: { kind: 'checkpoint', checkpoint_id: 'fixture' },
  };
  async function save(options = {}) {
    const bytes = Buffer.from(JSON.stringify({ ...checkpoint, ...options }));
    descriptor.state.checkpoint_root = 'sha256:' + sha256(bytes);
    await writeFile(join(checkpointRoot, 'checkpoint.json'), bytes);
    await writeFile(join(root, 'snapshot.json'), JSON.stringify(descriptor));
  }
  await save();
  const verified = await readNativeCheckpoint(root, expected, signal());
  assert.equal(verified.execution, state.path);
  assert.equal(verified.memoryPath, ram.path);
  assert.equal(verified.rootDisk, disk.path);
  await save({ resources: rawResources(2) });
  const next = await readNativeCheckpoint(root, expected, signal());
  assert.deepEqual(next.topology, verified.topology);
  assert.notEqual(next.checkpointRoot, verified.checkpointRoot);
  for (const change of [
    { architecture: 'x86_64' },
    { owned_volumes: [{}] },
    { disks: [disk.id] },
  ]) {
    await save(change);
    await assert.rejects(
      readNativeCheckpoint(root, expected, signal()),
      /ABI or resource closure/,
    );
  }
  await save();
  await writeFile(runtimeRaw, 'altered.ext4');
  await assert.rejects(
    readNativeCheckpoint(root, expected, signal()),
    /runtime disk bytes mismatch/,
  );
  await writeFile(runtimeRaw, 'runtime.ext4');
  await writeFile(state.path, 'changed VMM bytes');
  await assert.rejects(
    readNativeCheckpoint(root, expected, signal()),
    /object digest mismatch/,
  );
});
