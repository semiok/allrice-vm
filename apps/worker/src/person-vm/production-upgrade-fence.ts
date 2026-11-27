import { createServer } from 'node:net';
import { PersonVmError } from '@allrice/person-vm';

/** The previous host must have relinquished its real TCP endpoint. The
 * dual-stack exclusive bind covers the old address even when the new release
 * uses a different listen address. This socket never serves a request. */
export async function withPreviousGatewayFenced<T>(
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
      guard.listen(
        { host: '::', port, exclusive: true, ipv6Only: false },
        resolve,
      );
    }).catch((error: unknown) => {
      throw new PersonVmError('LEASE_CONFLICT', { cause: error });
    });
    signal.throwIfAborted();
    return await stop();
  } finally {
    if (guard.listening)
      await new Promise<void>((resolve, reject) =>
        guard.close((error) => (error ? reject(error) : resolve())),
      );
  }
}
