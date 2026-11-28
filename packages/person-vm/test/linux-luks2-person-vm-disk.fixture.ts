import { lstat, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expect, onTestFinished, vi } from 'vitest';
import type { PersonVmBinding } from '../src/contract.ts';
import type { PersonDisk } from '../src/encrypted-disk.ts';
import { LinuxLuks2PersonVmDisk } from '../src/linux-luks2-person-vm-disk.ts';
import {
  linuxDeviceNumber,
  linuxTools,
  type LinuxDiskKernel,
} from '../src/linux-luks2-state.ts';
import type { Command } from '../src/process.ts';

export const vm = '550e8400-e29b-41d4-a716-446655440000';
export const storageUuid = '550e8400-e29b-41d4-a716-446655440012';
export const otherVm = '550e8400-e29b-41d4-a716-446655440001';
export const disk = { vmId: vm, tier: 'warm' } as const satisfies PersonDisk;
export const binding: PersonVmBinding = {
  vmId: vm,
  personId: 'person-a',
  organizationId: 'org-a',
  instanceId: 'generation-a',
  leaseEpoch: 1,
};

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
export type Fault = { action: string; mode: 'before' | 'after' | 'no-op' };

export async function createLinuxLuks2Fixture() {
  const root = await mkdtemp(
    join(await realpath(process.cwd()), '.luks2-test-'),
  );
  onTestFinished(() => rm(root, { force: true, recursive: true }));
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
        if (last?.startsWith('/dev/block/')) return assertions.fsUuid + '\n';
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
      if (path.startsWith('/dev/block/'))
        return linuxDeviceNumber((await lstat(root, { bigint: true })).dev);
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
  const restart = () =>
    new LinuxLuks2PersonVmDisk({
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
    adapter: restart(),
    restart,
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
