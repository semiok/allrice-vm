import { describe, expect, it } from 'vitest';
import {
  LinuxSnapshotConfigurationSchema,
  PersonVmTemplateManifestSchema,
} from './template-snapshot-contract.ts';

const sha256 = 'a'.repeat(64);
const probe = {
  enabled: true,
  mode: 'probe',
  platform: 'linux/arm64',
  engine: 'microsandbox',
  templateDirectory: '/artifacts/templates/' + sha256,
  manifestSha256: sha256,
};

describe('Linux snapshot probe configuration', () => {
  it('defaults off and accepts only the pinned probe shape when enabled', () => {
    expect(LinuxSnapshotConfigurationSchema.parse(undefined)).toEqual({
      enabled: false,
    });
    expect(LinuxSnapshotConfigurationSchema.parse(probe)).toEqual(probe);
  });

  it.each([
    { externalMountPolicy: 'relaxed' },
    { dangerouslyInheritResources: true },
    { allowMissingResources: true },
    { driveOverrides: { rootfs: '/other.img' } },
    { mounts: [{ source: '/keys', destination: '/work' }] },
    { mode: 'production' },
    { engine: 'cloud-hypervisor' },
    { platform: 'darwin/arm64' },
    { templateDirectory: '/artifacts/../templates/' + sha256 },
    { templateDirectory: '/artifacts/templates/' + sha256 + '/' },
    { templateDirectory: '/artifacts/templates/wrong-hash' },
    { manifestSha256: sha256.toUpperCase() },
    { enabled: false },
  ])('rejects changed or unsupported configuration (%j)', (overrides) => {
    expect(
      LinuxSnapshotConfigurationSchema.safeParse({ ...probe, ...overrides })
        .success,
    ).toBe(false);
  });
});

const manifest = {
  version: 1,
  engine: 'microsandbox',
  engineVersion: '0.7.16',
  restoreProtocol: 1,
  platform: 'linux/arm64',
  host: {
    kernel: '6.12.0',
    cpuModel: 'Graviton3',
    cpuFeaturesSha256: sha256,
    kvmApiVersion: 12,
    gic: 'v3',
    pageSize: 4096,
  },
  guest: {
    vcpus: 2,
    memoryMiB: 2048,
    pageSize: 4096,
    kernelSha256: sha256,
    workMount: 'strict-external-directory',
    workPath: '/work',
  },
  inputs: {
    vmmSha256: sha256,
    firmwareSha256: sha256,
    agentdSha256: sha256,
    imageSha256: sha256,
    dshRuntimeDiskSha256: sha256,
    dshProfileSha256: sha256,
    commandMemorySha256: sha256,
    isolationPolicySha256: sha256,
  },
  files: [
    { role: 'state', path: 'state.bin', sha256, sizeBytes: 16 },
    { role: 'memory', path: 'memory.bin', sha256, sizeBytes: 2048 * 1024 ** 2 },
    { role: 'root-disk', path: 'disk/rootfs.raw', sha256, sizeBytes: 42 },
    { role: 'metadata', path: 'snapshot.json', sha256, sizeBytes: 128 },
  ],
};

describe('Linux snapshot template manifest', () => {
  it('accepts the pinned machine shape and complete file inventory', () => {
    expect(PersonVmTemplateManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it.each([
    { version: 2 },
    { restoreProtocol: 2 },
    { engineVersion: '0.7.15' },
    { host: { ...manifest.host, kvmApiVersion: 13 } },
    { guest: { ...manifest.guest, memoryMiB: 4096 } },
    { guest: { ...manifest.guest, workMount: 'replace-block-disk' } },
    { guest: { ...manifest.guest, workPath: '/home' } },
    { inputs: { ...manifest.inputs, isolationPolicySha256: '' } },
    { inputs: { ...manifest.inputs, commandMemorySha256: undefined } },
    { files: manifest.files.filter(({ role }) => role !== 'memory') },
  ])('rejects missing or incompatible metadata (%j)', (overrides) => {
    expect(
      PersonVmTemplateManifestSchema.safeParse({ ...manifest, ...overrides })
        .success,
    ).toBe(false);
  });

  it.each([
    { path: 'state.bin' },
    { path: 'disk' },
    { path: 'manifest.json' },
    { path: '../memory.bin' },
    { path: 'disk//data' },
    { path: 'disk/../data' },
    { path: '/private/memory.bin' },
    { sha256: 'not-a-hash' },
    { sizeBytes: 0 },
    { role: 'memory' },
  ])('rejects ambiguous or invalid file records (%j)', (overrides) => {
    const extra = {
      role: 'metadata',
      path: 'another.json',
      sha256,
      sizeBytes: 128,
      ...overrides,
    };
    expect(
      PersonVmTemplateManifestSchema.safeParse({
        ...manifest,
        files: [...manifest.files, extra],
      }).success,
    ).toBe(false);
  });
});
