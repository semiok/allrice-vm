import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyTemplate } from './verify.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const temporary = await mkdtemp(
    join(await realpath(tmpdir()), 'snapshot-verify-'),
  );
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const data = [
    ['state', 'state.bin', 'public execution state'],
    ['memory', 'ram.bin', 'public execution memory'],
    ['root-disk', 'disk/root.raw', 'public root volume'],
    ['dsh-runtime-disk', 'disk/runtime.ext4', 'public DSH volume'],
    ['device-topology', 'devices.json', '{"work":"external"}'],
  ];
  const files = data.map(([role, path, contents]) => ({
    role,
    path,
    sha256: digest(contents),
    sizeBytes: Buffer.byteLength(contents),
  }));
  const sha256 = digest('synthetic pinned input');
  const manifest = {
    version: 1,
    engine: 'microsandbox',
    engineVersion: '0.7.16',
    restoreProtocol: 1,
    platform: 'linux/arm64',
    host: {
      kernel: '6.12.0',
      cpuModel: 'synthetic ARM64',
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
      dshRuntimeDiskSha256: files[3].sha256,
      dshProfileSha256: sha256,
      commandMemorySha256: sha256,
      isolationPolicySha256: sha256,
    },
    files,
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const manifestSha256 = digest(bytes);
  const root = join(temporary, manifestSha256);
  t.after(async () => {
    await chmod(root, 0o700);
    await chmod(join(root, 'disk'), 0o700);
    await rm(temporary, { recursive: true, force: true });
  });
  await mkdir(join(root, 'disk'), { recursive: true });
  for (const [, path, contents] of data) {
    await writeFile(join(root, path), contents, { mode: 0o444 });
  }
  await writeFile(join(root, 'manifest.json'), bytes, { mode: 0o444 });
  await writeFile(join(root, 'manifest.sig'), sign(null, bytes, privateKey), {
    mode: 0o444,
  });
  await chmod(join(root, 'disk'), 0o555);
  await chmod(root, 0o555);
  return {
    root,
    manifest,
    options: {
      seal: {
        enabled: true,
        mode: 'probe',
        engine: 'microsandbox',
        platform: 'linux/arm64',
        templateDirectory: root,
        manifestSha256,
      },
      expected: {
        host: manifest.host,
        guest: manifest.guest,
        inputs: manifest.inputs,
        deviceTopologySha256: files[4].sha256,
      },
      publicKey,
      publisherUid: process.getuid(),
      signal: globalThis.AbortSignal.timeout(5000),
    },
  };
}

test('reads back a pinned signed inventory with the approved topology and inputs', async (t) => {
  const { manifest, options } = await fixture(t);
  assert.deepEqual(await verifyTemplate(options), {
    seal: options.seal,
    manifest,
  });
});

test('refuses an independently pinned but incompatible device topology', async (t) => {
  const { options } = await fixture(t);
  options.expected.deviceTopologySha256 = digest('other layout');
  await assert.rejects(verifyTemplate(options), /device topology mismatch/);
});

test('refuses a signature from a different publisher key', async (t) => {
  const { options } = await fixture(t);
  options.publicKey = generateKeyPairSync('ed25519').publicKey;
  await assert.rejects(verifyTemplate(options), /invalid signature/);
});

test('refuses changed bytes in a same-length sealed volume', async (t) => {
  const { root, options } = await fixture(t);
  const path = join(root, 'disk/runtime.ext4');
  await chmod(path, 0o644);
  await writeFile(path, 'public XYZ volume');
  await chmod(path, 0o444);
  await assert.rejects(verifyTemplate(options), /file digest mismatch/);
});

test('refuses changed manifest bytes before parsing the inventory', async (t) => {
  const { root, options } = await fixture(t);
  const path = join(root, 'manifest.json');
  await chmod(path, 0o644);
  await writeFile(path, '{}');
  await chmod(path, 0o444);
  await assert.rejects(verifyTemplate(options), /manifest digest mismatch/);
});

test('refuses a writable file or a different publisher UID', async (t) => {
  const { root, options } = await fixture(t);
  await assert.rejects(
    verifyTemplate({ ...options, publisherUid: options.publisherUid + 1 }),
    /owner or permissions/,
  );
  await chmod(join(root, 'ram.bin'), 0o644);
  await assert.rejects(verifyTemplate(options), /owner or permissions/);
});

test('refuses undeclared files and directories', async (t) => {
  const { root, options } = await fixture(t);
  await chmod(root, 0o755);
  const extra = join(root, 'unexpected');
  await mkdir(extra);
  await chmod(root, 0o555);
  await assert.rejects(verifyTemplate(options), /unlisted file or directory/);
  await chmod(root, 0o755);
  await rm(extra, { recursive: true });
  await writeFile(extra, 'extra payload', { mode: 0o444 });
  await chmod(root, 0o555);
  await assert.rejects(verifyTemplate(options), /unlisted file or directory/);
});

test('refuses a missing inventoried volume', async (t) => {
  const { root, options } = await fixture(t);
  const disk = join(root, 'disk');
  await chmod(disk, 0o755);
  await rm(join(disk, 'root.raw'));
  await chmod(disk, 0o555);
  await assert.rejects(verifyTemplate(options), /missing inventoried file/);
});

test('refuses symlink or hardlink substitutions for inventoried files', async (t) => {
  const { root, options } = await fixture(t);
  const ram = join(root, 'ram.bin');
  const state = join(root, 'state.bin');
  await chmod(root, 0o755);
  await rm(ram);
  await symlink(state, ram);
  await chmod(root, 0o555);
  await assert.rejects(verifyTemplate(options), { code: 'ELOOP' });
  await chmod(root, 0o755);
  await rm(ram);
  await link(state, ram);
  await chmod(root, 0o555);
  await assert.rejects(verifyTemplate(options), /expected one regular file/);
});

test('refuses a cancelled verification', async (t) => {
  const { options } = await fixture(t);
  options.signal = globalThis.AbortSignal.abort();
  await assert.rejects(verifyTemplate(options), { name: 'AbortError' });
});
