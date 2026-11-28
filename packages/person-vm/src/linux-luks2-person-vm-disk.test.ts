import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersonVmBinding } from './contract.ts';
import type { PersonDisk } from './encrypted-disk.ts';
import { LinuxLuks2PersonVmDisk } from './linux-luks2-person-vm-disk.ts';
import {
  linuxDeviceNumber,
  linuxTools,
  type LinuxDiskKernel,
} from './linux-luks2-state.ts';
import type { Command } from './process.ts';

const vm = '550e8400-e29b-41d4-a716-446655440000';
const storageUuid = '550e8400-e29b-41d4-a716-446655440012';
const otherVm = '550e8400-e29b-41d4-a716-446655440001';
const disk = { vmId: vm, tier: 'warm' } as const satisfies PersonDisk;
const binding: PersonVmBinding = {
  vmId: vm,
  personId: 'person-a',
  organizationId: 'org-a',
  instanceId: 'generation-a',
  leaseEpoch: 1,
};
const signal = new AbortController().signal;
const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

type Device = {
  backing?: string;
  loop?: number;
  mapping?: string;
  mounted?: string;
  savedWork?: string;
  luksUuid?: string;
  xfsUuid?: string;
  erased?: boolean;
};
type Fault = { action: string; mode: 'before' | 'after' | 'no-op' };

async function fixture() {
  const root = await mkdtemp(
    join(await realpath(process.cwd()), '.luks2-test-'),
  );
  roots.add(root);
  const devices = new Map<string, Device>();
  const passes = new Map<string, Buffer>();
  const verifiedKeys = new Map<Device, Buffer>();
  const inputRefs: Uint8Array[] = [];
  const history: string[] = [];
  const secret = Buffer.from('fixture-only-key-never-in-arguments-or-output');
  const assertions = {
    use: binding,
    fsUuid: storageUuid,
    unknown: false,
    invalidLoop: false,
    invalidDm: false,
    extraMount: false,
    keyDeleteFails: false,
    loopIdAfterMove: false,
    busy: false,
    fault: undefined as Fault | undefined,
  };
  function all() {
    return [...devices.values()];
  }
  async function deviceForFile(path: string | undefined) {
    if (!path) throw Error('fixture missing file');
    const info = await lstat(path, { bigint: true });
    const id = String(info.ino);
    const device = devices.get(id) ?? {};
    devices.set(id, device);
    return device;
  }
  function deviceForLoop(path: string | undefined) {
    const device = all().find(
      (row) => row.loop !== undefined && path === '/dev/loop' + row.loop,
    );
    if (!device) throw Error('fixture missing loop');
    return device;
  }
  function deviceForMap(path: string | undefined) {
    const device = all().find(
      (row) => row.mapping && row.mapping === basename(path ?? ''),
    );
    if (!device) throw Error('fixture missing mapping');
    return device;
  }

  let ids = 0;
  async function dispatch(command: Command) {
    const [op, second] = command.args;
    const last = command.args.at(-1);
    switch (command.executable) {
      case linuxTools.findmnt:
        return JSON.stringify({
          filesystems: [
            {
              uuid: assertions.fsUuid,
              'maj:min': linuxDeviceNumber(
                (await lstat(root, { bigint: true })).dev,
              ),
            },
          ],
        });
      case linuxTools.loop:
        if (op === '--list') {
          if (assertions.unknown) return '{broken output';
          return JSON.stringify({
            loopdevices: await Promise.all(
              all().flatMap((row) => {
                if (row.loop === undefined || !row.backing) return [];
                return [
                  lstat(row.backing, { bigint: true }).then((info) => ({
                    name: '/dev/loop' + row.loop,
                    'back-file': row.backing,
                    'back-ino': Number(info.ino),
                    'back-maj:min': linuxDeviceNumber(info.dev),
                    offset: assertions.invalidLoop ? 4096 : 0,
                    sizelimit: 0,
                    ro: false,
                    autoclear: false,
                  })),
                ];
              }),
            ),
          });
        }
        if (op === '--find') {
          const row = await deviceForFile(last);
          row.backing = last;
          row.loop = ++ids;
          return '/dev/loop' + row.loop + '\n';
        }
        if (op === '--detach') {
          const row = deviceForLoop(last);
          row.loop = undefined;
          row.backing = undefined;
          return '';
        }
        break;
      case linuxTools.dm:
        return all()
          .flatMap((row) =>
            row.mapping
              ? [
                  row.mapping +
                    '|CRYPT-LUKS2-' +
                    row.luksUuid?.replaceAll('-', '') +
                    '-' +
                    row.mapping +
                    '|253|' +
                    row.loop +
                    '|' +
                    (row.mounted || assertions.busy ? '1' : '0'),
                ]
              : [],
          )
          .join('\n');
      case linuxTools.crypt:
        if (op === 'luksFormat') {
          const row = deviceForLoop(last);
          row.luksUuid = command.args[command.args.indexOf('--uuid') + 1];
          verifiedKeys.set(row, Buffer.from(command.input!));
          return '';
        }
        if (op === 'open') {
          const probe = command.args.includes('--test-passphrase');
          const row = probe
            ? await deviceForFile(last)
            : deviceForLoop(command.args.at(-2));
          if (!command.input || !verifiedKeys.get(row)?.equals(command.input))
            throw Error('bad secret');
          if (!probe) row.mapping = last;
          return '';
        }
        if (op === 'close') {
          const row = deviceForMap(last);
          row.mapping = undefined;
          return '';
        }
        if (op === 'luksUUID' || op === 'isLuks') {
          const row = await deviceForFile(last);
          if (!row.luksUuid) throw Error('unformatted');
          return op === 'luksUUID' ? row.luksUuid + '\n' : '';
        }
        if (op === 'luksDump') {
          const row = await deviceForFile(last);
          return JSON.stringify({ keyslots: row.erased ? {} : { '0': {} } });
        }
        if (op === 'luksErase') {
          const row = await deviceForFile(last);
          row.erased = true;
          verifiedKeys.delete(row);
          return '';
        }
        break;
      case linuxTools.xfs:
        deviceForMap(last).xfsUuid = second?.split('uuid=')[1];
        return '';
      case linuxTools.blkid:
        return 'TYPE=xfs\nUUID=' + deviceForMap(last).xfsUuid + '\n';
      case linuxTools.mount: {
        const device = deviceForMap(command.args.at(-2));
        device.mounted = last;
        if (device.savedWork) {
          await rename(device.savedWork, join(last!, 'work'));
          device.savedWork = undefined;
        }
        return '';
      }
      case linuxTools.umount: {
        const row = all().find((row) => row.mounted === last);
        if (!row) throw Error('unmounted');
        const hiddenWork = join(root, '.volume-' + row.luksUuid);
        try {
          await rename(join(last!, 'work'), hiddenWork);
          row.savedWork = hiddenWork;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        row.mounted = undefined;
        return '';
      }
    }
    throw Error('unexpected command');
  }

  const command = vi.fn(async (command: Command) => {
    command.signal.throwIfAborted();
    expect(command.executable).toMatch(/^\/usr\/s?bin\//);
    expect(JSON.stringify([command.env, command.args])).not.toContain(
      secret.toString(),
    );
    const action = command.args.includes('--test-passphrase')
      ? 'cryptsetup test-passphrase'
      : basename(command.executable) + ' ' + command.args[0];
    const observed = [
      'cryptsetup isLuks',
      'cryptsetup luksUUID',
      'cryptsetup test-passphrase',
      'cryptsetup luksDump',
    ];
    if (observed.includes(action))
      expect(command.args).toContain('--disable-locks');
    if (
      [
        'cryptsetup open',
        'cryptsetup luksFormat',
        'cryptsetup luksErase',
      ].includes(action)
    )
      expect(command.args).not.toContain('--disable-locks');
    if (action === 'losetup --list')
      expect(command.args).toEqual([
        '--list',
        '--json',
        '--output',
        'NAME,BACK-FILE,BACK-INO,BACK-MAJ:MIN,OFFSET,SIZELIMIT,RO,AUTOCLEAR',
      ]);
    if (action === 'losetup --detach')
      expect(command.args).toEqual([
        '--detach',
        expect.stringMatching(/^\/dev\/loop\d+$/),
      ]);
    if (command.input) {
      expect(command.args).toContain('--key-file');
      expect(command.args).toContain('-');
      expect(command.executable).toBe(linuxTools.crypt);
      inputRefs.push(command.input);
    }
    if (action === 'cryptsetup luksFormat') {
      expect(
        command.args.filter(
          (arg) => arg.includes('pbkdf') || arg === '--iter-time',
        ),
      ).toEqual([]);
    }
    history.push(action);
    if (
      assertions.fault?.action === action &&
      assertions.fault.mode === 'before'
    )
      throw Error(secret.toString());
    if (
      assertions.fault?.action === action &&
      assertions.fault.mode === 'no-op'
    )
      return '';
    const value = await dispatch(command);
    if (
      assertions.fault?.action === action &&
      assertions.fault.mode === 'after'
    )
      throw Error(secret.toString());
    return value;
  });

  const kernel: LinuxDiskKernel = {
    async mountInfo() {
      const base = '1 0 0:1 / / rw - rootfs rootfs rw\n';
      return (
        base +
        all()
          .filter((row) => row.mounted)
          .map(
            (row) =>
              40 +
              row.loop! +
              ' 1 253:' +
              row.loop +
              ' / ' +
              row.mounted +
              ' rw,nosuid,nodev - xfs /dev/dm-5 rw\n' +
              (assertions.extraMount
                ? '43 1 253:' + row.loop + ' / /foreign rw - xfs /dev/dm-5 rw\n'
                : ''),
          )
          .join('')
      );
    },
    async mountNamespace() {
      return '4:4026531840';
    },
    async blockDevice(path) {
      const row = all().find(
        (row) => row.loop !== undefined && path === '/dev/loop' + row.loop,
      );
      if (row) return '7:' + row.loop;
      const mapped = all().find(
        (row) =>
          row.mapping &&
          (path === '/dev/mapper/' + row.mapping ||
            path === '/dev/dm-' + row.loop),
      );
      return mapped ? '253:' + mapped.loop : null;
    },
    async relations(device, kind) {
      const index = Number(device.split(':')[1]);
      if (kind === 'slaves')
        return [assertions.invalidDm ? 'loop96' : 'loop' + index];
      return all().some((row) => row.loop === index && row.mapping)
        ? ['dm-' + index]
        : [];
    },
  };

  const keys = {
    readOrCreate: vi.fn(async (id: string) => {
      if (!passes.has(id))
        passes.set(id, Buffer.concat([secret, Buffer.from(id)]));
      return Buffer.from(passes.get(id)!);
    }),
    async read(id: string) {
      if (!passes.has(id)) throw Error('missing key');
      return Buffer.from(passes.get(id)!);
    },
    delete: vi.fn(async (id: string) => {
      if (assertions.keyDeleteFails) throw Error('key store unavailable');
      passes.delete(id);
    }),
    async confirmAbsence(id: string) {
      return !passes.has(id);
    },
    async listDiskIds() {
      return [...passes.keys()];
    },
  };
  const info = await lstat(root, { bigint: true });
  const adapter = new LinuxLuks2PersonVmDisk({
    keys,
    root,
    rootIdentity: { uuid: storageUuid, inode: String(info.ino) },
    capacityGiB: 1,
    runner: command,
    kernel,
    async withCurrentDisk(candidate, disk, signal, use) {
      signal.throwIfAborted();
      expect(disk.vmId).toBe(candidate.vmId);
      if (JSON.stringify(candidate) !== JSON.stringify(assertions.use))
        throw Error('fixture lease expired');
      return use();
    },
  });
  return {
    root,
    adapter,
    keys,
    history,
    assertions,
    command,
    devices,
    inputRefs,
    secret,
    corruptKey: () => passes.set(vm, Buffer.alloc(48, 17)),
    image: (tier: PersonDisk['tier'] = 'warm', id = vm) =>
      join(root, tier, id + '.luks'),
  };
}

describe('Linux LUKS2 PersonVmDiskPort', () => {
  it('creates one LUKS2/XFS disk, reattaches, verifies capacity and issues the exact private work receipt', async () => {
    const f = await fixture();
    expect(await f.adapter.inspect(vm, signal)).toEqual({ state: 'absent' });
    const created = await f.adapter.create(disk, signal);
    expect(created).toEqual(
      expect.objectContaining({
        device: expect.any(String),
        inode: expect.any(String),
      }),
    );
    expect((await lstat(f.image())).size).toBe(1024 ** 3);
    expect(await f.adapter.create(disk, signal)).toBeUndefined();
    expect(f.history.filter((item) => item === 'mkfs.xfs -m')).toHaveLength(1);
    const before = vi.fn(() =>
      expect(f.history.at(-1)).not.toBe('losetup --find'),
    );
    const mount = await f.adapter.attach(disk, signal, before);
    expect(before).toHaveBeenCalledOnce();
    expect(await f.adapter.attach(disk, signal, before)).toBe(mount);
    expect(before).toHaveBeenCalledOnce();
    const receipt = await f.adapter.issueOwnedWorkDisk(disk, binding, signal);
    expect(receipt).toEqual({
      binding,
      image: created,
      mountId: expect.stringMatching(/^4:4026531840:42:/),
      workDirectory: mount + '/work',
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    await f.adapter.verifyOwnedWorkDisk(receipt, disk, binding, signal);
    const released = vi.fn(async (path: string) => {
      expect(path).toBe(mount);
      expect(f.history).toContain('cryptsetup close');
      expect(f.history.indexOf('cryptsetup close')).toBeLessThan(
        f.history.lastIndexOf('losetup --list'),
      );
    });
    await f.adapter.detach(disk, signal, released);
    expect(released).toHaveBeenCalledOnce();
    expect(
      await f.adapter.inspectMount(disk, signal, { image: receipt.image }),
    ).toEqual({ state: 'absent', image: created });
    expect(await f.adapter.verifyAttachedMount(disk, signal)).toBeNull();
    expect(f.inputRefs.length).toBeGreaterThan(0);
    expect(
      f.inputRefs.every((bytes) => bytes.every((byte) => byte === 0)),
    ).toBe(true);
    await f.adapter.attach(disk, signal);
    await expect(
      f.adapter.verifyOwnedWorkDisk(receipt, disk, binding, signal),
    ).rejects.toThrow();
  });

  it('keeps two users’ disks, keys and work contents independent across a remount', async () => {
    const f = await fixture();
    const otherDisk = { ...disk, vmId: otherVm };
    const otherBinding = {
      ...binding,
      vmId: otherVm,
      personId: 'person-b',
      instanceId: 'generation-b',
    };
    await f.adapter.create(disk, signal);
    await f.adapter.create(otherDisk, signal);
    const first = await f.adapter.attach(disk, signal);
    const second = await f.adapter.attach(otherDisk, signal);
    await writeFile(join(first, 'work', 'only-a'), 'for A');
    await writeFile(join(second, 'work', 'only-b'), 'for B');
    f.assertions.use = otherBinding;
    const receipt = await f.adapter.issueOwnedWorkDisk(
      otherDisk,
      otherBinding,
      signal,
    );
    await f.adapter.detach(disk, signal);
    await f.adapter.verifyOwnedWorkDisk(
      receipt,
      otherDisk,
      otherBinding,
      signal,
    );
    await f.adapter.attach(disk, signal);
    expect(await readFile(join(first, 'work', 'only-a'), 'utf8')).toBe('for A');
    await expect(lstat(join(first, 'work', 'only-b'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(second, 'work', 'only-b'), 'utf8')).toBe(
      'for B',
    );
  });

  it('moves only detached images across tiers with unchanged physical identity', async () => {
    const f = await fixture();
    const image = await f.adapter.create(disk, signal);
    await f.adapter.attach(disk, signal);
    await expect(f.adapter.move(disk, 'cold', signal)).rejects.toThrow();
    await f.adapter.detach(disk, signal);
    const cold = await f.adapter.move(disk, 'cold', signal);
    expect(await f.adapter.inspect(vm, signal)).toMatchObject({
      state: 'ready',
      disk: cold,
    });
    expect(
      await f.adapter.inspectMount(disk, signal, {
        image: image!,
        acrossTier: true,
      }),
    ).toEqual({ state: 'absent', image });
    await f.adapter.attach(cold, signal);
    await f.adapter.detach(cold, signal);
  });

  it.each([
    { action: 'cryptsetup luksFormat', mode: 'after' },
    { action: 'cryptsetup open', mode: 'after' },
    { action: 'mkfs.xfs -m', mode: 'before' },
  ] satisfies Fault[])(
    'rolls back a failed create after $action',
    async (fault) => {
      const f = await fixture();
      f.assertions.fault = fault;
      await expect(f.adapter.create(disk, signal)).rejects.toThrow(
        'PROVIDER_FAILED',
      );
      expect(await f.adapter.confirmAbsence(vm, signal)).toBe(true);
      expect(f.history).toContain('losetup --detach');
      expect(f.keys.delete).toHaveBeenCalledWith(vm);
      expect(
        f.inputRefs.every((bytes) => bytes.every((byte) => byte === 0)),
      ).toBe(true);
    },
  );

  it.each([
    { action: 'cryptsetup open', mode: 'after' },
    { action: 'mount -t', mode: 'before' },
    { action: 'mount -t', mode: 'after' },
  ] satisfies Fault[])(
    'rolls back exact mapping on $action $mode and preserves the ready disk',
    async (fault) => {
      const f = await fixture();
      await f.adapter.create(disk, signal);
      f.assertions.fault = fault;
      await expect(f.adapter.attach(disk, signal)).rejects.toThrow(
        'PROVIDER_FAILED',
      );
      expect(await f.adapter.verifyAttachedMount(disk, signal)).toBeNull();
      expect(await f.adapter.inspect(vm, signal)).toMatchObject({
        state: 'ready',
        disk,
      });
      expect(f.keys.delete).not.toHaveBeenCalled();
    },
  );

  it.each([
    { action: 'umount --', mode: 'no-op' },
    { action: 'cryptsetup close', mode: 'no-op' },
    { action: 'losetup --detach', mode: 'no-op' },
  ] satisfies Fault[])(
    'holds disk, key and callback when $action is not confirmed',
    async (fault) => {
      const f = await fixture();
      await f.adapter.create(disk, signal);
      await f.adapter.attach(disk, signal);
      f.assertions.fault = fault;
      const after = vi.fn(async () => {});
      await expect(f.adapter.detach(disk, signal, after)).rejects.toThrow(
        'CLEANUP_INCOMPLETE',
      );
      expect(after).not.toHaveBeenCalled();
      await expect(f.adapter.delete(disk, signal)).rejects.toThrow(
        'CLEANUP_INCOMPLETE',
      );
      expect(f.keys.delete).not.toHaveBeenCalled();
      expect(await lstat(f.image())).toBeTruthy();
      expect(f.history).not.toContain('cryptsetup luksErase');
      f.assertions.fault = undefined;
      await f.adapter.detach(disk, signal, after);
      expect(after).toHaveBeenCalledOnce();
    },
  );

  it.each(['invalidLoop', 'invalidDm', 'extraMount', 'unknown'] as const)(
    'treats %s as unknown and leaves devices alone',
    async (condition) => {
      const f = await fixture();
      await f.adapter.create(disk, signal);
      await f.adapter.attach(disk, signal);
      f.assertions[condition] = true;
      const before = f.history.length;
      expect(await f.adapter.inspect(vm, signal)).toEqual({ state: 'unknown' });
      expect(await f.adapter.confirmAbsence(vm, signal)).toBe(false);
      await expect(f.adapter.delete(disk, signal)).rejects.toThrow();
      await expect(f.adapter.detach(disk, signal)).rejects.toThrow();
      expect(f.history.slice(before)).not.toContain('umount --');
      expect(f.keys.delete).not.toHaveBeenCalled();
    },
  );

  it('does not close a mapper still held outside the visible mount namespace', async () => {
    const f = await fixture();
    await f.adapter.create(disk, signal);
    await f.adapter.attach(disk, signal);
    f.assertions.busy = true;
    const before = f.history.length;
    await expect(f.adapter.detach(disk, signal)).rejects.toThrow(
      'CLEANUP_INCOMPLETE',
    );
    expect(f.history.slice(before)).toContain('umount --');
    expect(f.history.slice(before)).not.toContain('cryptsetup close');
    await expect(f.adapter.delete(disk, signal)).rejects.toThrow(
      'CLEANUP_INCOMPLETE',
    );
    expect(f.keys.delete).not.toHaveBeenCalled();
  });

  it('serializes simultaneous create calls and refuses a ready image missing its key', async () => {
    const f = await fixture();
    await Promise.all([
      f.adapter.create(disk, signal),
      f.adapter.create(disk, signal),
    ]);
    expect(f.history.filter((action) => action === 'mkfs.xfs -m')).toHaveLength(
      1,
    );
    await f.keys.delete(vm);
    expect(await f.adapter.inspect(vm, signal)).toEqual({ state: 'unknown' });
    await expect(f.adapter.attach(disk, signal)).rejects.toThrow(
      'PROVIDER_FAILED',
    );
    expect(await lstat(f.image())).toBeTruthy();
  });

  it('rejects malformed device status even if no files exist', async () => {
    const f = await fixture();
    f.assertions.unknown = true;
    expect(await f.adapter.inspect(vm, signal)).toEqual({ state: 'unknown' });
    await expect(f.adapter.create(disk, signal)).rejects.toThrow();
    expect(f.keys.readOrCreate).not.toHaveBeenCalled();
  });

  it('rejects cross-user receipts, shape-only copies, and stale lease epochs', async () => {
    const f = await fixture();
    await f.adapter.create(disk, signal);
    await f.adapter.attach(disk, signal);
    const receipt = await f.adapter.issueOwnedWorkDisk(disk, binding, signal);
    await expect(
      f.adapter.verifyOwnedWorkDisk({ ...receipt }, disk, binding, signal),
    ).rejects.toThrow('LEASE_LOST');
    await expect(
      f.adapter.verifyOwnedWorkDisk(
        receipt,
        { ...disk, vmId: otherVm },
        binding,
        signal,
      ),
    ).rejects.toThrow('LEASE_LOST');
    await expect(
      f.adapter.issueOwnedWorkDisk(
        disk,
        { ...binding, personId: 'person-b' },
        signal,
      ),
    ).rejects.toThrow();
    f.assertions.use = { ...binding, leaseEpoch: 2 };
    await expect(
      f.adapter.verifyOwnedWorkDisk(receipt, disk, binding, signal),
    ).rejects.toThrow();
    await expect(
      f.adapter.verifyOwnedWorkDisk(receipt, disk, f.assertions.use, signal),
    ).rejects.toThrow('LEASE_LOST');
  });

  it('rejects path injection, backing symlinks, changed capacity and a symlinked work child', async () => {
    const f = await fixture();
    await expect(
      f.adapter.create({ ...disk, vmId: '../other;command' }, signal),
    ).rejects.toThrow('PROVIDER_FAILED');
    expect(f.history).toEqual([]);
    await f.adapter.create(disk, signal);
    const other = { ...disk, vmId: otherVm };
    await symlink(f.image(), f.image('warm', otherVm));
    expect(await f.adapter.inspect(otherVm, signal)).toEqual({
      state: 'unknown',
    });
    await expect(f.adapter.create(other, signal)).rejects.toThrow();
    const mount = await f.adapter.attach(disk, signal);
    const work = join(mount, 'work');
    await rm(work, { recursive: true });
    await symlink(f.root, work);
    await expect(
      f.adapter.issueOwnedWorkDisk(disk, binding, signal),
    ).rejects.toThrow();
    await f.adapter.detach(disk, signal);
    await truncate(f.image(), 1024 ** 3 + 1);
    expect(await f.adapter.inspect(vm, signal)).toEqual({ state: 'unknown' });
  });

  it('keeps unknown when the protected filesystem root is replaced at the same path', async () => {
    const f = await fixture();
    await f.adapter.create(disk, signal);
    const former = f.root + '-former';
    await rename(f.root, former);
    roots.add(former);
    await mkdir(f.root, { mode: 0o700 });
    expect(await f.adapter.inspect(vm, signal)).toEqual({ state: 'unknown' });
    await expect(f.adapter.create(disk, signal)).rejects.toThrow();
    expect(f.keys.delete).not.toHaveBeenCalled();
    expect(await lstat(join(former, 'warm', vm + '.luks'))).toBeTruthy();
  });

  it('recovers an interrupted staging allocation before re-creating', async () => {
    const f = await fixture();
    expect(await f.adapter.inspect(vm, signal)).toEqual({ state: 'absent' });
    const journal = join(f.root, 'journal', vm + '.json');
    const luksUuid = '550e8400-e29b-41d4-a716-446655440010';
    await writeFile(
      journal,
      JSON.stringify({
        version: 1,
        phase: 'allocating',
        vmId: vm,
        tier: 'warm',
        capacityBytes: 1024 ** 3,
        storageUuid,
        luksUuid,
        xfsUuid: '550e8400-e29b-41d4-a716-446655440011',
      }),
      { mode: 0o600 },
    );
    const staging = journal + '.' + luksUuid + '.alloc';
    await writeFile(staging, Buffer.alloc(15), { mode: 0o600 });
    expect(await f.adapter.inspect(vm, signal)).toEqual({ state: 'unknown' });
    expect(await f.adapter.recoverIncompleteCreation(disk, signal)).toBe(true);
    await expect(lstat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.adapter.confirmAbsence(vm, signal)).toBe(true);
    await f.adapter.create(disk, signal);
    expect(await f.adapter.recoverIncompleteCreation(disk, signal)).toBe(false);
    expect(await f.adapter.inspect(vm, signal)).toMatchObject({
      state: 'ready',
    });
  });

  it('recovers a registered partially formatted disk once its remaining mapping can be joined', async () => {
    const f = await fixture();
    f.assertions.fault = { action: 'mkfs.xfs -m', mode: 'no-op' };
    f.assertions.busy = true;
    await expect(f.adapter.create(disk, signal)).rejects.toThrow(
      'CLEANUP_INCOMPLETE',
    );
    expect(await f.adapter.inspect(vm, signal)).toEqual({ state: 'unknown' });
    await expect(
      f.adapter.recoverIncompleteCreation(disk, signal),
    ).rejects.toThrow('CLEANUP_INCOMPLETE');
    expect(f.keys.delete).not.toHaveBeenCalled();
    f.assertions.busy = false;
    expect(await f.adapter.recoverIncompleteCreation(disk, signal)).toBe(true);
    expect(await f.adapter.confirmAbsence(vm, signal)).toBe(true);
    f.assertions.fault = undefined;
    await f.adapter.create(disk, signal);
    expect(await f.adapter.inspect(vm, signal)).toMatchObject({
      state: 'ready',
    });
  });

  it('binds persistent identity to the outer filesystem UUID and inode, not a boot-local device number', async () => {
    const f = await fixture();
    const created = await f.adapter.create(disk, signal);
    expect(
      JSON.parse(await readFile(join(f.root, 'journal', vm + '.json'), 'utf8')),
    ).toMatchObject({ storageUuid, image: { inode: created?.inode } });
    expect(
      JSON.parse(await readFile(join(f.root, 'journal', vm + '.json'), 'utf8'))
        .image,
    ).not.toHaveProperty('device');
    f.assertions.fsUuid = '550e8400-e29b-41d4-a716-446655440013';
    expect(await f.adapter.inspect(vm, signal)).toEqual({ state: 'unknown' });
    await expect(f.adapter.attach(disk, signal)).rejects.toThrow();
    f.assertions.fsUuid = storageUuid;
    expect(await f.adapter.inspect(vm, signal)).toMatchObject({
      state: 'ready',
    });
  });

  it('does not report ready when a present key cannot unlock the exact LUKS2 header', async () => {
    const f = await fixture();
    await f.adapter.create(disk, signal);
    f.corruptKey();
    expect(await f.adapter.inspect(vm, signal)).toEqual({ state: 'unknown' });
    expect(f.history.at(-1)).toBe('cryptsetup test-passphrase');
    expect(
      f.inputRefs.every((bytes) => bytes.every((byte) => byte === 0)),
    ).toBe(true);
  });

  it('rejects a writable protected root before doing storage work', async () => {
    const f = await fixture();
    await chmod(f.root, 0o777);
    await expect(f.adapter.create(disk, signal)).rejects.toThrow();
    expect(f.history).toEqual([]);
  });

  it('preserves the backing image and key when keyslot erasure is unconfirmed', async () => {
    const f = await fixture();
    await f.adapter.create(disk, signal);
    const target = await f.adapter.inspectDeletionTarget(vm, signal);
    if (target.state !== 'ready') throw Error('fixture target unverified');
    const erase = {
      identitySha256: target.identitySha256!,
      beforeErase: async () => {},
    };
    f.assertions.fault = { action: 'cryptsetup luksErase', mode: 'no-op' };
    await expect(f.adapter.delete(disk, signal, erase)).rejects.toThrow(
      'CLEANUP_INCOMPLETE',
    );
    expect(f.keys.delete).not.toHaveBeenCalled();
    expect(await lstat(f.image())).toBeTruthy();
    expect(await f.adapter.inspect(vm, signal)).toEqual({ state: 'unknown' });
    f.assertions.fault = undefined;
    await f.adapter.delete(disk, signal, erase);
    expect(await f.adapter.confirmAbsence(vm, signal)).toBe(true);
  });

  it('runs the native cleanup callback for a proven never-created or already-erased disk', async () => {
    const f = await fixture();
    const beforeErase = vi.fn(async (mount: string) => {
      expect(mount).toBe(join(f.root, 'mounts', vm));
    });
    await f.adapter.delete(disk, signal, { identitySha256: null, beforeErase });
    expect(beforeErase).toHaveBeenCalledOnce();
    expect(await f.adapter.confirmAbsence(vm, signal)).toBe(true);
    expect(f.history).not.toContain('cryptsetup luksErase');
  });

  it('uses the verified deletion target, erases keyslots, and retries key-store failure without re-erasing', async () => {
    const f = await fixture();
    await f.adapter.create(disk, signal);
    await f.adapter.attach(disk, signal);
    await f.adapter.detach(disk, signal);
    const result = await f.adapter.inspectDeletionTarget(vm, signal);
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') throw Error('not ready');
    await expect(f.adapter.delete(disk, signal)).rejects.toThrow('LEASE_LOST');
    expect(f.history).not.toContain('cryptsetup luksErase');
    expect(await f.adapter.inspect(vm, signal)).toMatchObject({
      state: 'ready',
    });
    const beforeErase = vi.fn(async (mount: string) => {
      expect(mount).toBe(join(f.root, 'mounts', vm));
    });
    await expect(
      f.adapter.delete(disk, signal, { identitySha256: 'wrong', beforeErase }),
    ).rejects.toThrow('LEASE_LOST');
    expect(beforeErase).not.toHaveBeenCalled();
    const erase = { identitySha256: result.identitySha256!, beforeErase };
    f.assertions.keyDeleteFails = true;
    await expect(f.adapter.delete(disk, signal, erase)).rejects.toThrow(
      'PROVIDER_FAILED',
    );
    expect(beforeErase).toHaveBeenCalledOnce();
    expect(await f.adapter.inspect(vm, signal)).toEqual({ state: 'unknown' });
    expect(
      await f.adapter.inspectDeletionTarget(vm, signal, erase.identitySha256),
    ).toEqual({ state: 'absent' });
    expect(await f.adapter.confirmAbsence(vm, signal)).toBe(false);
    expect(
      f.history.filter((action) => action === 'cryptsetup luksErase'),
    ).toHaveLength(1);
    f.assertions.keyDeleteFails = false;
    await f.adapter.delete(disk, signal, erase);
    expect(
      f.history.filter((action) => action === 'cryptsetup luksErase'),
    ).toHaveLength(1);
    expect(await f.adapter.confirmAbsence(vm, signal)).toBe(true);
    expect(await f.adapter.listFormalDiskIds(signal)).toEqual([]);
  });
});
