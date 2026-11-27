import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
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
