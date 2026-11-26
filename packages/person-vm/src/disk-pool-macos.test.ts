import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ApfsPersonVmDisk, FilePersonVmKeyStore } from './encrypted-disk.ts';
import { MacosPersonVmDiskPool } from './disk-pool-macos.ts';
import type { DiskPoolClaim } from './disk-pool-platform.ts';
import type { CommandRunner } from './process.ts';
import { signal } from './test-support.ts';

const actions = vi.hoisted(() => ({
  afterLink: undefined as ((from: string, to: string) => void) | undefined,
  afterUnlink: undefined as ((path: string) => void) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    link: async (from: string, to: string) => {
      await actual.link(from, to);
      actions.afterLink?.(from, to);
    },
    unlink: async (path: string) => {
      await actual.unlink(path);
      actions.afterUnlink?.(path);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  actions.afterLink = undefined;
  actions.afterUnlink = undefined;
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'ar-disk-bind-')),
  );
  roots.push(root);
  const diskRoot = join(root, 'disks');
  const keyRoot = join(root, 'keys');
  const manifestSha256 = '1'.repeat(64);
  const attachments = new Map<string, string>();
  const keyByInode = new Map<bigint, string>();
  const runner: CommandRunner = async ({ executable, args, input }) => {
    if (executable.endsWith('/plutil'))
      return Buffer.from(input!).toString('utf8');
    if (args[0] === 'info')
      return JSON.stringify({
        images: [...attachments].map(([image, mount]) => ({
          'image-path': image,
          'system-entities': [{ 'mount-point': mount }],
        })),
      });
    const verify = async (path: string) => {
      const { ino } = await fs.stat(path, { bigint: true });
      if (
        keyByInode.get(ino) !==
        createHash('sha256').update(input!).digest('hex')
      )
        throw Error('synthetic key rejected');
    };
    if (args[0] === 'create') {
      const path = args.at(-1)!;
      await fs.writeFile(path, 'synthetic physical image');
      keyByInode.set(
        (await fs.stat(path, { bigint: true })).ino,
        createHash('sha256').update(input!).digest('hex'),
      );
    }
    if (args[0] === 'imageinfo' || args[0] === 'attach') await verify(args[1]!);
    if (args[0] === 'attach')
      attachments.set(args[1]!, args[args.indexOf('-mountpoint') + 1]!);
    if (args[0] === 'detach') {
      for (const [image, mount] of attachments)
        if (mount === args[1]) attachments.delete(image);
    }
    return '';
  };
  const keys = new FilePersonVmKeyStore(keyRoot);
  const disk = new ApfsPersonVmDisk({
    root: diskRoot,
    keys,
    capacityGiB: 8,
    runner,
  });
  const adapter = (currentSeal = manifestSha256) =>
    new MacosPersonVmDiskPool({
      root: diskRoot,
      keyRoot,
      disk,
      keys,
      capacityGiB: 8,
      runner,
      image: `docker.io/library/node@sha256:${'2'.repeat(64)}`,
      imageCache: {
        directory: join(root, currentSeal),
        manifestSha256: currentSeal,
      },
    });
  return { root, diskRoot, keyRoot, attachments, disk, keys, adapter };
}

it('validates the original formal receipt after rotation and keeps the warm-cache decision tied to the current seal', async () => {
  const f = await fixture();
  const s = await stock(f);
  const cut = Error('synthetic after formal receipt');
  actions.afterLink = (_from, to) => {
    if (to === s.newManifest) throw cut;
  };
  await expect(s.platform.bindDisk(s.claim, signal())).rejects.toBe(cut);
  actions.afterLink = undefined;
  const rotated = f.adapter('3'.repeat(64));
  await expect(rotated.inspectBinding(s.claim, signal())).resolves.toBe(
    'bound',
  );
  await expect(rotated.hasSeededPublicCache(s.vmId, signal())).resolves.toBe(
    false,
  );
  await expect(s.platform.hasSeededPublicCache(s.vmId, signal())).resolves.toBe(
    true,
  );
});

it('retires only exact verified unassigned storage, including both its key and image', async () => {
  const f = await fixture();
  const s = await stock(f);
  const rotated = f.adapter('3'.repeat(64));
  await expect(
    rotated.destroyStock({ ...s.claim, proof: 'unrelated-identity' }, signal()),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  expect((await fs.lstat(s.oldImage, { bigint: true })).ino).toBe(
    s.oldProof.image,
  );
  expect((await fs.lstat(s.oldKey, { bigint: true })).ino).toBe(s.oldProof.key);
  await expect(
    rotated.destroyStock(s.claim, signal()),
  ).resolves.toBeUndefined();
  await expect(fs.lstat(s.oldImage)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.lstat(s.oldKey)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.attachments.size).toBe(0);
});

async function stock(f: Awaited<ReturnType<typeof fixture>>) {
  const platform = f.adapter();
  const ref = randomUUID();
  const vmId = randomUUID();
  await platform.createEncryptedDisk(ref, signal());
  const mount = await platform.mountDisk(ref, signal());
  expect(f.attachments.size).toBe(1);
  expect(mount).toContain(ref);
  await platform.unmountDisk(ref, signal());
  expect(f.attachments.size).toBe(0);
  const proof = await platform.inspectStock(
    { ref, source: platform.source },
    signal(),
  );
  const claim: DiskPoolClaim = {
    ref,
    proof,
    source: platform.source,
    intent: {
      id: randomUUID(),
      requestId: randomUUID(),
      owner: {
        personId: randomUUID(),
        organizationId: randomUUID(),
        vmId,
      },
    },
  };
  const oldImage = join(
    f.diskRoot,
    '.preprovision-images',
    'warm',
    `${ref}.sparseimage`,
  );
  const oldKey = join(f.keyRoot, '.preprovision-keys', `${ref}.key`);
  const files = f.disk.poolFiles({ vmId, tier: 'warm' });
  const oldProof = {
    image: (await fs.lstat(oldImage, { bigint: true })).ino,
    key: (await fs.lstat(oldKey, { bigint: true })).ino,
  };
  return {
    platform,
    claim,
    vmId,
    ref,
    oldImage,
    oldKey,
    newImage: files.image,
    newManifest: files.manifest,
    newKey: f.keys.filePath(vmId),
    oldProof,
  };
}

it.each([
  'image-link',
  'key-link',
  'image-unlink',
  'key-unlink',
  'receipt-link',
] as const)(
  'resumes the no-overwrite file binding when interrupted after %s',
  async (stage) => {
    const f = await fixture();
    const s = await stock(f);
    const original = Error(`synthetic interruption at ${stage}`);
    actions.afterLink = (_from, to) => {
      if (
        (stage === 'image-link' && to === s.newImage) ||
        (stage === 'key-link' && to === s.newKey) ||
        (stage === 'receipt-link' && to === s.newManifest)
      )
        throw original;
    };
    actions.afterUnlink = (file) => {
      if (
        (stage === 'image-unlink' && file === s.oldImage) ||
        (stage === 'key-unlink' && file === s.oldKey)
      )
        throw original;
    };
    await expect(s.platform.bindDisk(s.claim, signal())).rejects.toBe(original);
    actions.afterLink = undefined;
    actions.afterUnlink = undefined;
    const after = f.adapter();
    expect(await after.inspectBinding(s.claim, signal())).toBe(
      stage === 'receipt-link' ? 'bound' : 'pending',
    );
    await after.bindDisk(s.claim, signal());
    expect(await after.inspectBinding(s.claim, signal())).toBe('bound');
    expect(await after.hasSeededPublicCache(s.vmId, signal())).toBe(true);
    expect(await fs.lstat(s.newImage, { bigint: true })).toMatchObject({
      ino: s.oldProof.image,
      nlink: 1n,
    });
    expect(await fs.lstat(s.newKey, { bigint: true })).toMatchObject({
      ino: s.oldProof.key,
      nlink: 1n,
      mode: expect.any(BigInt),
    });
    for (const path of [s.oldImage, s.oldKey])
      await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.disk.inspect(s.vmId, signal())).toEqual({
      state: 'ready',
      disk: { vmId: s.vmId, tier: 'warm' },
    });
  },
);

it.each(['destination', 'key-material', 'mounted-alias'] as const)(
  'retains the original stock when the %s evidence conflicts',
  async (conflict) => {
    const f = await fixture();
    const s = await stock(f);
    if (conflict === 'destination')
      await fs.writeFile(s.newImage, 'unrelated file', { mode: 0o600 });
    if (conflict === 'key-material')
      await fs.writeFile(s.oldKey, 'x'.repeat(96));
    if (conflict === 'mounted-alias') {
      const alias = join(f.root, 'synthetic-image-alias');
      await fs.symlink(s.oldImage, alias);
      f.attachments.set(alias, join(f.root, 'other-mount'));
    }
    await expect(s.platform.inspectBinding(s.claim, signal())).resolves.toBe(
      'unknown',
    );
    // A rejected binding leaves both original references present.
    expect((await fs.lstat(s.oldImage, { bigint: true })).ino).toBe(
      s.oldProof.image,
    );
    expect((await fs.lstat(s.oldKey, { bigint: true })).ino).toBe(
      s.oldProof.key,
    );
    if (conflict === 'destination')
      expect(await fs.readFile(s.newImage, 'utf8')).toBe('unrelated file');
  },
);
