import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PersonVmError } from '@allrice/person-vm';

const execute = promisify(execFile);

/** Read both address families. A wildcard bind alone is insufficient on
 * Darwin: the kernel may also accept a listener on a specific address. */
async function listenerCount(port: number, signal: AbortSignal) {
  if (process.platform === 'darwin') {
    const { stdout, stderr } = await execute(
      '/usr/sbin/netstat',
      ['-an', '-p', 'tcp'],
      { signal, timeout: 3000, env: { LC_ALL: 'C' } },
    );
    if (stderr || !stdout.includes('Local Address'))
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    return stdout.split('\n').filter((line) => {
      const [protocol, , , local, , state] = line.trim().split(/\s+/);
      return (
        /^tcp[46]*$/.test(protocol ?? '') &&
        state === 'LISTEN' &&
        local?.endsWith('.' + port)
      );
    }).length;
  }
  if (process.platform === 'linux') {
    const rows = await Promise.all(
      ['/proc/net/tcp', '/proc/net/tcp6'].map((path) =>
        readFile(path, { encoding: 'utf8', signal }),
      ),
    );
    if (rows.some((text) => !text.includes('local_address')))
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    return rows
      .flatMap((text) => text.split('\n').slice(1))
      .filter((line) => {
        const [, local, , state] = line.trim().split(/\s+/);
        return (
          state === '0A' && parseInt(local?.split(':')[1] ?? '', 16) === port
        );
      }).length;
  }
  throw new PersonVmError('CLEANUP_INCOMPLETE');
}

/** Supported M1 launches use an absolute Worker entrypoint. Another such
 * process may still own the old runtime even when its gateway is already gone. */
export async function assertNoPreviousWorker(
  diskRoot: string,
  signal: AbortSignal,
) {
  if (process.platform !== 'darwin')
    throw new PersonVmError('ACTIVITY_UNKNOWN');
  const { stdout, stderr } = await execute(
    '/bin/ps',
    ['-axww', '-o', 'uid=,pid=,ucomm=,command='],
    { signal, timeout: 3000, env: { LC_ALL: 'C' } },
  );
  const ourUid = process.getuid?.();
  const processes = stdout
    .trim()
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line));
  if (
    stderr ||
    ourUid === undefined ||
    processes.some((entry) => !entry) ||
    !processes.some((entry) => Number(entry?.[2]) === process.pid)
  )
    throw new PersonVmError('ACTIVITY_UNKNOWN');

  const current = await realpath(diskRoot);
  const legacy = join(homedir(), 'allrice-dev-releases') + '/';
  for (const entry of processes) {
    if (
      !entry ||
      Number(entry[1]) !== ourUid ||
      Number(entry[2]) === process.pid ||
      !/^node(?:js)?$/i.test(entry[3] ?? '')
    )
      continue;
    const release = /(?:^|\s)(\S+)\/apps\/worker\/dist\/index\.js(?:\s|$)/.exec(
      entry[4] ?? '',
    )?.[1];
    if (!release || release.startsWith(legacy)) continue;
    const other = await (async () => {
      try {
        const config: unknown = JSON.parse(
          await readFile(join(release, '.local/person-vm-host.json'), {
            signal,
            encoding: 'utf8',
          }),
        );
        if (
          !config ||
          typeof config !== 'object' ||
          !('disk' in config) ||
          !config.disk ||
          typeof config.disk !== 'object' ||
          !('root' in config.disk) ||
          typeof config.disk.root !== 'string'
        )
          throw new PersonVmError('ACTIVITY_UNKNOWN');
        return await realpath(config.disk.root);
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        )
          throw error;
        const manifest: unknown = JSON.parse(
          await readFile(join(release, '.local/dev-build-identity.json'), {
            signal,
            encoding: 'utf8',
          }),
        );
        if (
          !manifest ||
          typeof manifest !== 'object' ||
          !('files' in manifest) ||
          !Array.isArray(manifest.files) ||
          manifest.files.some(
            (file: unknown) =>
              !file ||
              typeof file !== 'object' ||
              ('path' in file && file.path === '.local/person-vm-host.json'),
          )
        )
          throw new PersonVmError('ACTIVITY_UNKNOWN');
        return undefined; // a sealed legacy Worker with no VM Host
      }
    })();
    if (other === current) throw new PersonVmError('LEASE_CONFLICT');
  }
  signal.throwIfAborted();
}

/** While the caller owns the physical VM lease, prove the previous host no
 * longer admits work at its exact gateway port. No request is served. */
export async function withPreviousGatewayFenced<T>(
  address: string,
  ports: readonly number[],
  signal: AbortSignal,
  stop: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const [port] = ports;
  if (
    ports.length !== 1 ||
    !port ||
    !Number.isInteger(port) ||
    port > 65535 ||
    port < 1
  )
    throw new PersonVmError('EGRESS_BINDING_INVALID');

  const guard = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      guard.once('error', reject);
      guard.listen({ host: address, port, exclusive: true }, resolve);
    }).catch((error: unknown) => {
      throw new PersonVmError('LEASE_CONFLICT', { cause: error });
    });
    if ((await listenerCount(port, signal)) !== 1)
      throw new PersonVmError('LEASE_CONFLICT');
    signal.throwIfAborted();
    return await stop();
  } finally {
    if (guard.listening)
      await new Promise<void>((resolve, reject) =>
        guard.close((error) => (error ? reject(error) : resolve())),
      );
  }
}
