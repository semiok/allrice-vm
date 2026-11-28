import { generateKeyPairSync } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { payloads, sha256 } from './capture-contract.mjs';
import { assertEmptyGuest } from './guest-audit.mjs';

export const digest = 'a'.repeat(64);
export const dsh = '/opt/allrice/dsh/' + digest;
export const controls = '/opt/allrice/command-memory/' + digest;
export const cleanGuest = {
  work: [],
  privateEntries: [],
  seeds: [],
  inet: [],
  unix: [],
  swap: [],
  pageSize: 4096,
  mounts: [
    { path: '/', type: 'ext4', flags: ['rw'] },
    { path: '/.msb', type: 'virtiofs', source: 'msb_runtime', flags: ['rw'] },
    { path: '/work', type: 'virtiofs', flags: ['rw'] },
    { path: dsh, type: 'ext4', flags: ['ro'] },
    { path: controls, type: 'virtiofs', flags: ['ro'] },
  ],
  agentPorts: ['/dev/vport0p1', '/dev/vport0p2'],
  processes: [
    { task: 'agent', cwd: '/', env: ['PATH'], fds: ['/dev/vport0p1'] },
    { task: 'audit', cwd: '/', env: ['PATH'], fds: ['pipe:[2]'] },
  ],
};
export const profile = { dsh, controls, pageSize: 4096 };
export const signal = () => globalThis.AbortSignal.timeout(5000);
export const host = {
  kernel: '6.12.0',
  cpuModel: 'arm64 pinned ABI',
  cpuFeaturesSha256: digest,
  kvmApiVersion: 12,
  gic: 'v3',
  pageSize: 4096,
};
export const guest = {
  vcpus: 2,
  memoryMiB: 2048,
  pageSize: 4096,
  kernelSha256: digest,
  workMount: 'strict-external-directory',
  workPath: '/work',
};
export const inputs = {
  vmmSha256: digest,
  firmwareSha256: digest,
  agentdSha256: digest,
  imageSha256: digest,
  dshRuntimeDiskSha256: sha256('runtime.ext4'),
  dshProfileSha256: digest,
  commandMemorySha256: digest,
  isolationPolicySha256: digest,
};

export async function createCaptureFixture(after) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'snapshot-build-'));
  after(async () => {
    for (const name of await readdir(join(root, 'sealed'))) {
      await chmod(join(root, 'sealed', name), 0o700);
    }
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, 'capture');
  const output = join(root, 'sealed');
  await mkdir(source, { mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  for (const path of Object.keys(payloads)) {
    await writeFile(join(source, path), path, { mode: 0o444 });
  }
  const expected = {
    host,
    guest,
    inputs,
    deviceTopologySha256: sha256('device-topology.json'),
  };
  const receipt = {
    version: 1,
    mode: 'fixture',
    boot: 'new-offline-public-oci',
    cleanup: 'stopped-and-removed',
    full: true,
    integrityVerified: true,
    engineVersion: '0.7.16',
    host,
    guest,
    inputs,
    deviceTopologySha256: expected.deviceTopologySha256,
    preflight: {
      kvmApi: 12,
      reflink: true,
      msbVersion: '0.7.16',
      kernel: '6.12.0',
      pageBytes: 4096,
      dataUuid: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      scratchUuid: 'b'.repeat(8) + '-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      scratchLuksUuid: 'c'.repeat(8) + '-cccc-cccc-cccc-cccccccccccc',
      dataDevice: '1:0',
      scratchDevice: '2:0',
    },
    audit: assertEmptyGuest(cleanGuest, profile),
    files: Object.entries(payloads).map(([path, role]) => ({
      path,
      role,
      sha256: sha256(path),
      sizeBytes: Buffer.byteLength(path),
    })),
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const options = {
    source,
    output,
    expected,
    privateKey,
    signal: signal(),
    mode: 'fixture',
    run: {
      mode: 'fixture',
      target: 'local-fixture',
      id: 'synthetic-1',
      commit: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      seal: 'sha256:' + digest,
    },
    captureSha256: null,
  };
  async function save() {
    const bytes = Buffer.from(JSON.stringify(receipt));
    const path = join(source, 'capture.json');
    await rm(path, { force: true });
    await writeFile(path, bytes, { mode: 0o444 });
    options.captureSha256 = sha256(bytes);
  }
  await save();
  return { root, source, output, options, publicKey, receipt, save };
}
