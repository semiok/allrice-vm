import { createServer, type AddressInfo, type Server } from 'node:net';
import { expect, it, vi } from 'vitest';
import { withPreviousGatewayFenced } from './production-upgrade-fence.js';

async function listen(server: Server, host: string, port = 0) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, exclusive: true }, resolve);
  });
  return (server.address() as AddressInfo).port;
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

it.each(['127.0.0.1', '::1'])(
  'leaves an older %s gateway untouched and reserves its port through the joined stop',
  async (host) => {
    const previous = createServer();
    const port = await listen(previous, host);
    const signal = new AbortController().signal;
    const stop = vi.fn(async () => 'stopped');
    try {
      await expect(
        withPreviousGatewayFenced(host, [port], signal, stop),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      expect(previous.listening).toBe(true);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      await close(previous);
    }
    const race = createServer();
    await expect(
      withPreviousGatewayFenced(host, [port], signal, async () => {
        try {
          await expect(listen(race, host, port)).rejects.toMatchObject({
            code: 'EADDRINUSE',
          });
        } finally {
          if (race.listening) await close(race);
        }
        return stop();
      }),
    ).resolves.toBe('stopped');
    expect(stop).toHaveBeenCalledOnce();
    const reopened = createServer();
    try {
      expect(await listen(reopened, host, port)).toBe(port);
    } finally {
      if (reopened.listening) await close(reopened);
    }
  },
);

it('detects an older gateway on another listen address', async () => {
  const previous = createServer();
  const port = await listen(previous, '127.0.0.1');
  const stop = vi.fn(async () => 'stopped');
  try {
    await expect(
      withPreviousGatewayFenced(
        '::1',
        [port],
        new AbortController().signal,
        stop,
      ),
    ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
    expect(stop).not.toHaveBeenCalled();
  } finally {
    await close(previous);
  }
});
