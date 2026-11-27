import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApfsPersonVmDisk, FilePersonVmKeyStore } from './encrypted-disk.ts';
import type { Command, CommandRunner } from './process.ts';
import { signal } from './test-support.ts';

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'ar-disk-')));
  temporary.push(path);
  return path;
}
const hash = (value: Buffer) =>
  createHash('sha256').update(value).digest('hex');

async function aliasedDisk(alias: 'configured' | 'reported') {
  const lexical = await mkdtemp('/tmp/ar-apfs-alias-');
  temporary.push(lexical);
  const physical = await realpath(lexical);
  if (process.platform === 'darwin') expect(physical).not.toBe(lexical);
  const configured = join(alias === 'configured' ? lexical : physical, 'disks');
  const observed = join(alias === 'reported' ? lexical : physical, 'disks');
  const ref = { vmId: randomUUID(), tier: 'warm' as const };
  const mount = join(configured, 'mounts', ref.vmId);
  const observedImage = join(observed, 'warm', ref.vmId + '.sparseimage');
  const observedMount = join(observed, 'mounts', ref.vmId);
  const keys = new FilePersonVmKeyStore(join(lexical, 'keys'));
  let attachments: unknown[] = [];
  const report = (mounted: boolean) => {
    attachments = [
      {
        'image-path': observedImage,
        'system-entities': [mounted ? { 'mount-point': observedMount } : {}],
      },
    ];
  };
  const detachments: string[] = [];
  const disk = new ApfsPersonVmDisk({
    root: configured,
    keys,
    capacityGiB: 8,
    runner: async ({ executable, args, input }) => {
      if (executable.endsWith('/plutil')) return Buffer.from(input!).toString();
      if (args[0] === 'info') return JSON.stringify({ images: attachments });
      if (args[0] === 'create') await writeFile(args.at(-1)!, 'test image');
      if (args[0] === 'attach') report(true);
      if (args[0] === 'detach') {
        detachments.push(args[1]!);
        attachments = [];
      }
      return '';
    },
  });
  return { disk, keys, ref, mount, report, detachments };
}

describe('APFS adapter protocol and private filesystem (not actual encryption acceptance)', () => {
  it.each(['configured', 'reported'] as const)(
    'confirms absence after a complete detach and deletion with a %s system alias',
    async (alias) => {
      const { disk, keys, ref, mount, detachments } = await aliasedDisk(alias);
      await disk.create(ref, signal());
      expect(await disk.listFormalDiskIds(signal())).toEqual([ref.vmId]);
      expect(await keys.listDiskIds(signal())).toEqual([ref.vmId]);
      await expect(disk.attach(ref, signal())).resolves.toBe(mount);
      await expect(disk.verifyAttachedMount(ref, signal())).resolves.toBe(
        mount,
      );
      await disk.detach(ref, signal());
      expect(detachments).toEqual([mount]);
      await disk.delete(ref, signal());
      await expect(disk.confirmAbsence(ref.vmId, signal())).resolves.toBe(true);
      expect(await disk.listFormalDiskIds(signal())).toEqual([]);
    },
  );
  it.each(['configured', 'reported'] as const)(
    'refuses absence when files are gone but a device still reports a %s system alias',
    async (alias) => {
      const { disk, ref, report } = await aliasedDisk(alias);
      await disk.create(ref, signal());
      await disk.delete(ref, signal());
      expect(await disk.listFormalDiskIds(signal())).toEqual([]);
      report(false);
      await expect(
        disk.confirmAbsence(ref.vmId, signal()),
      ).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
    },
  );
  it('key仅stdin、AES-256参数、停止后挂卸/冷盘移动/重开保留同字节', async () => {
    const root = await directory(),
      volume = join(root, 'volume'),
      keyRoot = join(root, 'keys');
    const keys = new FilePersonVmKeyStore(keyRoot),
      ref = { vmId: randomUUID(), tier: 'warm' as const };
    const calls: Command[] = [],
      attachments = new Map<string, string>();
    let inputCount = 0;
    const runner: CommandRunner = async (command) => {
      calls.push(command);
      const args = command.args;
      if (command.executable === '/usr/bin/plutil')
        return Buffer.from(command.input!).toString();
      if (args[0] === 'info')
        return JSON.stringify({
          images: [...attachments].map(([image, mount]) => ({
            'image-path': image,
            'system-entities': [{ 'mount-point': mount }],
          })),
        });
      if (args[0] === 'create' || args[0] === 'attach') {
        expect(command.input?.at(-1)).toBe(0);
        expect(command.input?.length).toBe(97);
        inputCount += 1;
        const secret = Buffer.from(command.input!.subarray(0, -1)).toString();
        expect(JSON.stringify(args)).not.toContain(secret);
        expect(JSON.stringify(command.env)).not.toContain(secret);
        if (args[0] === 'create')
          await writeFile(args.at(-1)!, 'synthetic-not-encrypted-image');
        else attachments.set(args[1]!, args[args.indexOf('-mountpoint') + 1]!);
      }
      if (args[0] === 'detach')
        for (const [image, mount] of attachments)
          if (mount === args[1]) attachments.delete(image);
      return '';
    };
    const disk = new ApfsPersonVmDisk({
      root: volume,
      keys,
      capacityGiB: 40,
      runner,
    });
    const freshImage = await disk.create(ref, signal());
    const image = join(volume, 'warm', ref.vmId + '.sparseimage');
    expect((await lstat(image)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(keyRoot, ref.vmId + '.key'))).mode & 0o777).toBe(
      0o600,
    );
    const original = hash(await readFile(image));
    const initialMount = await disk.inspectMount(ref, signal());
    expect(initialMount.state).toBe('absent');
    if (initialMount.state === 'unknown')
      throw new Error('Missing disk identity');
    const originalImage = initialMount.image;
    expect(freshImage).toEqual(originalImage);
    await expect(disk.create(ref, signal())).resolves.toBeUndefined();
    expect(await disk.verifyAttachedMount(ref, signal())).toBeNull();
    const dispatched = vi.fn();
    const mount = await disk.attach(ref, signal(), dispatched);
    expect(dispatched).toHaveBeenCalledOnce();
    const start = calls.length;
    expect(await disk.verifyAttachedMount(ref, signal())).toBe(mount);
    attachments.set(image, join(root, 'different-mount'));
    expect(await disk.verifyAttachedMount(ref, signal())).toBeNull();
    attachments.set(image, mount);
    const other = join(volume, 'warm', randomUUID() + '.sparseimage');
    attachments.set(other, mount);
    expect(await disk.verifyAttachedMount(ref, signal())).toBeNull();
    attachments.delete(other);
    expect(
      calls
        .slice(start)
        .filter((call) => call.executable.endsWith('hdiutil'))
        .map((call) => call.args[0]),
    ).toEqual(['imageinfo', 'info', 'imageinfo', 'info', 'imageinfo', 'info']);
    attachments.set(other, mount);
    const ambiguous = calls.length;
    await expect(disk.inspectMount(ref, signal())).resolves.toEqual({
      state: 'unknown',
    });
    await expect(disk.attach(ref, signal(), dispatched)).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    await expect(disk.detach(ref, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    expect(
      calls
        .slice(ambiguous)
        .some(({ args }) => ['attach', 'detach'].includes(args[0]!)),
    ).toBe(false);
    expect(dispatched).toHaveBeenCalledOnce();
    attachments.delete(other);
    await expect(disk.move(ref, 'cold', signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    await expect(disk.delete(ref, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    await disk.detach(ref, signal());
    const cold = await disk.move(ref, 'cold', signal());
    const acrossTier = { image: originalImage, acrossTier: true } as const;
    await expect(disk.inspectMount(ref, signal(), acrossTier)).resolves.toEqual(
      {
        state: 'absent',
        image: originalImage,
      },
    );
    await expect(
      disk.inspectMount(ref, signal(), {
        ...acrossTier,
        image: { ...originalImage, inode: 'other-image' },
      }),
    ).resolves.toEqual({ state: 'unknown' });
    attachments.set(image, join(root, 'unexpected-old-mount'));
    await expect(disk.inspectMount(ref, signal(), acrossTier)).resolves.toEqual(
      {
        state: 'unknown',
      },
    );
    attachments.delete(image);
    // A caller whose DB commit failed can repeat the stale source safely.
    expect(await disk.move(ref, 'cold', signal())).toEqual(cold);
    await disk.attach(cold, signal());
    await expect(disk.inspectMount(ref, signal(), acrossTier)).resolves.toEqual(
      {
        state: 'attached',
        mount,
        image: originalImage,
      },
    );
    await disk.detach(cold, signal());
    const warm = await disk.move(cold, 'warm', signal());
    expect(await disk.move(cold, 'warm', signal())).toEqual(warm);
    expect(hash(await readFile(image))).toBe(original);
    expect(inputCount).toBe(3);
    const create = calls.find((call) => call.args[0] === 'create')!;
    expect(create.args).toEqual(
      expect.arrayContaining([
        '-encryption',
        'AES-256',
        '-fs',
        'APFS',
        '-stdinpass',
      ]),
    );
    expect(create.input?.every((byte) => byte === 0)).toBe(true);
    await disk.move(warm, 'cold', signal());
    await disk.delete(warm, signal()); // Persisted caller tier may lag actual cold location.
    await expect(
      readFile(join(volume, 'cold', ref.vmId + '.sparseimage')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await disk.delete(warm, signal());
    await expect(keys.read(ref.vmId)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('创建前失败可重试原key；部分盘或双位置歧义保留原字节且拒绝', async () => {
    const root = await directory(),
      volume = join(root, 'volume');
    const keys = new FilePersonVmKeyStore(join(root, 'keys'));
    let creates = 0,
      partial = false;
    const runner: CommandRunner = async ({ args }) => {
      if (args[0] === 'create') {
        creates += 1;
        if (partial) {
          await writeFile(args.at(-1)!, 'partial-image');
          throw new Error('synthetic partial create');
        }
        if (creates === 1)
          throw new Error('synthetic pre-image create failure');
        await writeFile(args.at(-1)!, 'completed-image');
      }
      return '';
    };
    const disk = new ApfsPersonVmDisk({
      root: volume,
      keys,
      capacityGiB: 40,
      runner,
    });
    const ref = { vmId: randomUUID(), tier: 'warm' as const };
    await expect(disk.create(ref, signal())).rejects.toThrow(
      'synthetic pre-image',
    );
    const firstKey = await keys.read(ref.vmId),
      keyDigest = hash(firstKey);
    firstKey.fill(0);
    await disk.create(ref, signal());
    const secondKey = await keys.read(ref.vmId);
    expect(hash(secondKey)).toBe(keyDigest);
    secondKey.fill(0);
    expect((await disk.inspect(ref.vmId, signal())).state).toBe('ready');
    const image = join(volume, 'warm', ref.vmId + '.sparseimage');
    await copyFile(image, join(volume, 'cold', ref.vmId + '.sparseimage'));
    expect((await disk.inspect(ref.vmId, signal())).state).toBe('unknown');
    await expect(disk.move(ref, 'cold', signal())).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    await expect(disk.delete(ref, signal())).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    expect(await readFile(image, 'utf8')).toBe('completed-image');
    partial = true;
    const unfinished = { vmId: randomUUID(), tier: 'warm' as const };
    await expect(disk.create(unfinished, signal())).rejects.toThrow(
      'synthetic partial',
    );
    const attempted = creates;
    await expect(disk.create(unfinished, signal())).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    expect(creates).toBe(attempted);
    expect(
      await readFile(
        join(volume, 'warm', unfinished.vmId + '.sparseimage'),
        'utf8',
      ),
    ).toBe('partial-image');
  });
  it('keystore拒绝软链和路径穿越，不覆写已存在盘', async () => {
    const root = await directory(),
      keyRoot = join(root, 'keys');
    const keys = new FilePersonVmKeyStore(keyRoot),
      vmId = randomUUID();
    const first = await keys.readOrCreate(vmId);
    const second = await keys.readOrCreate(vmId);
    expect(hash(first)).toBe(hash(second));
    first.fill(0);
    second.fill(0);
    await expect(keys.read('../not-owned')).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    const other = randomUUID();
    await symlink(join(keyRoot, vmId + '.key'), join(keyRoot, other + '.key'));
    await expect(keys.read(other)).rejects.toBeDefined();
    const volume = join(root, 'volume');
    const disk = new ApfsPersonVmDisk({
      root: volume,
      keys,
      capacityGiB: 40,
      runner: async (command) => {
        if (command.args[0] === 'create')
          await writeFile(command.args.at(-1)!, 'fixture');
        return '';
      },
    });
    const ref = { vmId, tier: 'warm' as const };
    await disk.create(ref, signal());
    const original = hash(
      await readFile(join(volume, 'warm', vmId + '.sparseimage')),
    );
    await disk.create(ref, signal());
    expect(
      hash(await readFile(join(volume, 'warm', vmId + '.sparseimage'))),
    ).toBe(original);
  });
});
