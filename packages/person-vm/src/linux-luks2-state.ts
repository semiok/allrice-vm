import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { z } from 'zod';
import { PersonVmError } from './contract.ts';
import { missing } from './disk-pool-ledger.ts';
import type { PersonVmDiskIdentity } from './encrypted-disk.ts';
import type { CommandRunner } from './process.ts';

export const linuxTools = Object.freeze({
  loop: '/usr/sbin/losetup',
  dm: '/usr/sbin/dmsetup',
  crypt: '/usr/sbin/cryptsetup',
  xfs: '/usr/sbin/mkfs.xfs',
  blkid: '/usr/sbin/blkid',
  mount: '/usr/bin/mount',
  umount: '/usr/bin/umount',
});

export type LinuxDiskKernel = Readonly<{
  mountInfo(signal: AbortSignal): Promise<string>;
  mountNamespace(): Promise<string>;
  blockDevice(path: string): Promise<string | null>;
  relations(device: string, kind: 'holders' | 'slaves'): Promise<string[]>;
}>;

export function linuxDeviceNumber(n: bigint) {
  const major = ((n >> 8n) & 0xfffn) | ((n >> 32n) & ~0xfffn);
  const minor = (n & 0xffn) | ((n & 0x00000ffffff00000n) >> 12n);
  return `${major}:${minor}`;
}

const deviceNumber = /^\d+:\d+$/;
const loopName = /^\/dev\/loop\d+$/;

export const linuxDiskKernel: LinuxDiskKernel = {
  mountInfo: (signal) =>
    readFile('/proc/self/mountinfo', { encoding: 'utf8', signal }),
  async mountNamespace() {
    const info = await stat('/proc/self/ns/mnt', { bigint: true });
    return `${info.dev}:${info.ino}`;
  },
  async blockDevice(path) {
    try {
      const info = await stat(path, { bigint: true });
      requireDisk(info.isBlockDevice());
      return linuxDeviceNumber(info.rdev);
    } catch (error) {
      // A dangling mapper symlink is an inconsistent observation.
      if (
        missing(error) &&
        !(await lstat(path).catch((cause: unknown) => {
          if (missing(cause)) return null;
          throw cause;
        }))
      )
        return null;
      throw error;
    }
  },
  relations(device, kind) {
    requireDisk(deviceNumber.test(device));
    return readdir(`/sys/dev/block/${device}/${kind}`);
  },
};

export function requireDisk(
  condition: unknown,
  code:
    | 'CLEANUP_INCOMPLETE'
    | 'LEASE_LOST'
    | 'PROVIDER_FAILED' = 'CLEANUP_INCOMPLETE',
): asserts condition {
  if (!condition) throw new PersonVmError(code);
}

const commandNumber = z.union([
  z.int().nonnegative(),
  z.string().regex(/^\d+$/),
]);
const bool = z.union([
  z.boolean(),
  z.literal(0),
  z.literal(1),
  z.literal('0'),
  z.literal('1'),
]);
const loopsSchema = z.object({
  loopdevices: z.array(
    z.object({
      name: z.string().regex(loopName),
      'back-file': z.string().min(1),
      'back-ino': commandNumber,
      'back-maj:min': z.string().regex(deviceNumber),
      offset: commandNumber,
      sizelimit: commandNumber,
      ro: bool,
      autoclear: bool,
    }),
  ),
});
const off = (value: boolean | number | string) =>
  value === false || value === 0 || value === '0';

function unescapeMount(path: string) {
  const decoded = path.replace(/\\(040|011|012|134)/g, (_, code: string) =>
    String.fromCharCode(Number.parseInt(code, 8)),
  );
  requireDisk(!decoded.includes('\0') && decoded.startsWith('/'));
  return decoded;
}

function parseMountInfo(content: string) {
  requireDisk(content.length > 0 && content.length <= 4 * 1024 * 1024);
  const records = content
    .trimEnd()
    .split('\n')
    .map((line) => {
      const fields = line.split(' ');
      const split = fields.indexOf('-');
      const [id, parent, device, root, path, options] = fields;
      const fs = fields[split + 1];
      requireDisk(
        id &&
          /^\d+$/.test(id) &&
          parent &&
          /^\d+$/.test(parent) &&
          device &&
          deviceNumber.test(device) &&
          root &&
          path &&
          options &&
          split >= 6 &&
          fs &&
          fields.length === split + 4,
      );
      return {
        id,
        device,
        root: unescapeMount(root),
        path: unescapeMount(path),
        fs,
        options: options.split(','),
      };
    });
  requireDisk(new Set(records.map(({ id }) => id)).size === records.length);
  return records;
}

type ObservationInput = {
  image?: { path: string; identity: PersonVmDiskIdentity };
  allImagePaths: readonly string[];
  expectedIdentity?: PersonVmDiskIdentity;
  mount: string;
  name: string;
  luksUuid?: string;
};

export type LinuxDiskObservation = Readonly<{
  loop?: { path: string; device: string };
  mapper?: { path: string; device: string; openCount: number };
  mount?: { id: string; namespace: string };
}>;

/** Kernel identities are authoritative. CLI success and a path being present are
 * insufficient to conclude that a mount, mapping or loop belongs to this disk. */
export async function observeLinuxDisk(
  input: ObservationInput,
  kernel: LinuxDiskKernel,
  run: CommandRunner,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<LinuxDiskObservation> {
  const args = [
    '--list',
    '--json',
    '--output',
    'NAME,BACK-FILE,BACK-INO,BACK-MAJ:MIN,OFFSET,SIZELIMIT,RO,AUTOCLEAR',
  ];
  const loops = loopsSchema.parse(
    JSON.parse(
      await run({
        executable: linuxTools.loop,
        args,
        env,
        signal,
      }),
    ),
  ).loopdevices;
  const loopIdentity = (
    item: z.infer<typeof loopsSchema>['loopdevices'][number],
  ) =>
    input.expectedIdentity &&
    item['back-maj:min'] ===
      linuxDeviceNumber(BigInt(input.expectedIdentity.device)) &&
    String(item['back-ino']) === input.expectedIdentity.inode;
  const matches = loops.filter(
    (item) =>
      loopIdentity(item) ||
      input.allImagePaths.some(
        (path) =>
          item['back-file'] === path ||
          item['back-file'] === path + ' (deleted)',
      ),
  );
  const item = matches[0];
  requireDisk(matches.length <= 1);
  if (item)
    requireDisk(
      input.image &&
        item['back-file'] === input.image.path &&
        loopIdentity(item) &&
        BigInt(item.offset) === 0n &&
        BigInt(item.sizelimit) === 0n &&
        off(item.ro) &&
        off(item.autoclear),
    );
  const loopDevice = item ? await kernel.blockDevice(item.name) : null;
  if (item) requireDisk(loopDevice && deviceNumber.test(loopDevice));
  const loop =
    item && loopDevice ? { path: item.name, device: loopDevice } : undefined;

  const dmOutput = (
    await run({
      executable: linuxTools.dm,
      args: [
        'info',
        '--columns',
        '--noheadings',
        '--separator',
        '|',
        '-o',
        'name,uuid,major,minor,open',
      ],
      env,
      signal,
    })
  ).trim();
  const dmRows =
    dmOutput === '' || dmOutput === 'No devices found'
      ? []
      : dmOutput.split('\n').map((line) => {
          const fields = line.split('|').map((field) => field.trim());
          const [name, uuid, major, minor, open] = fields;
          requireDisk(
            fields.length === 5 &&
              name &&
              uuid !== undefined &&
              /^\d+$/.test(major ?? '') &&
              /^\d+$/.test(minor ?? '') &&
              /^\d+$/.test(open ?? ''),
          );
          const openCount = Number(open);
          requireDisk(Number.isSafeInteger(openCount));
          return { name, uuid, device: `${major}:${minor}`, openCount };
        });
  const uuidPrefix =
    input.luksUuid && 'CRYPT-LUKS2-' + input.luksUuid.replaceAll('-', '') + '-';
  const dmUuid = uuidPrefix && uuidPrefix + input.name;
  const relevant = dmRows.filter(
    (row) =>
      row.name === input.name ||
      (uuidPrefix && row.uuid.startsWith(uuidPrefix)),
  );
  const dm = relevant[0];
  requireDisk(relevant.length <= 1);
  const mapperPath = '/dev/mapper/' + input.name;
  const actualDmDevice = await kernel.blockDevice(mapperPath);
  if (dm) {
    requireDisk(
      loop &&
        dmUuid &&
        dm.name === input.name &&
        dm.uuid === dmUuid &&
        dm.device === actualDmDevice,
    );
    const slaves = await kernel.relations(dm.device, 'slaves');
    requireDisk(slaves.length === 1 && '/dev/' + slaves[0] === loop.path);
  } else requireDisk(actualDmDevice === null);
  if (loop) {
    const holders = await kernel.relations(loop.device, 'holders');
    requireDisk(
      dm
        ? holders.length === 1 &&
            /^dm-\d+$/.test(holders[0] ?? '') &&
            (await kernel.blockDevice('/dev/' + holders[0])) === dm.device
        : holders.length === 0,
    );
  }

  const namespace = await kernel.mountNamespace();
  requireDisk(/^\d+:\d+$/.test(namespace));
  const mounts = parseMountInfo(await kernel.mountInfo(signal)).filter(
    (record) =>
      record.path === input.mount ||
      record.path.startsWith(input.mount + '/') ||
      record.device === dm?.device ||
      record.device === loop?.device,
  );
  const mount = mounts[0];
  requireDisk(mounts.length <= 1);
  if (mount)
    requireDisk(
      dm &&
        mount.device === dm.device &&
        mount.path === input.mount &&
        mount.root === '/' &&
        mount.fs === 'xfs' &&
        mount.options.includes('rw') &&
        mount.options.includes('nodev') &&
        mount.options.includes('nosuid'),
    );
  signal.throwIfAborted();
  return {
    loop,
    mapper: dm
      ? { path: mapperPath, device: dm.device, openCount: dm.openCount }
      : undefined,
    mount: mount ? { id: mount.id, namespace } : undefined,
  };
}
