import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { closeServer, deferred, listen } from './gateway.fixture.ts';
import { createOwnedModelTransport } from './owned-transport.ts';
import { runWithOwnedNativeFetch } from './transport.ts';

it('cancels and joins the actual socket while TLS has not negotiated', async () => {
  const clientHello = deferred();
  const peerClosed = deferred();
  let destroyPeer: (() => void) | undefined;
  const server = createTcpServer((socket) => {
    destroyPeer = () => socket.destroy();
    socket.on('error', () => {});
    socket.once('data', () => clientHello.resolve());
    socket.once('close', () => peerClosed.resolve());
  });
  const stop = new AbortController();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('fixture_listener_missing');
  const endpoint = new URL(`https://127.0.0.1:${address.port}`);
  try {
    const operation = runWithOwnedNativeFetch(endpoint, 32, stop.signal, () =>
      fetch(endpoint, { method: 'POST', body: '{}' }),
    );
    await clientHello.promise;
    stop.abort();
    expect(await operation).toMatchObject({ ok: false });
    // A ClientHello-only peer will never finish its handshake. An early
    // dispatcher receipt alone leaves this socket open until connect timeout.
    const promptlyClosed = await Promise.race([
      peerClosed.promise.then(() => true),
      setTimeout(1000, false, { ref: false }),
    ]);
    expect(promptlyClosed).toBe(true);
  } finally {
    stop.abort();
    destroyPeer?.();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('does not replay a Search POST when the upstream responds with 421', async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    request.once('end', () => response.writeHead(421).end('misdirected'));
  });
  const endpoint = new URL(await listen(server));
  try {
    const outcome = await runWithOwnedNativeFetch(
      endpoint,
      32,
      new AbortController().signal,
      async () =>
        (await fetch(endpoint, { method: 'POST', body: '{}' })).status,
    );
    expect(outcome).toEqual({ ok: true, value: 421 });
    expect(requests).toBe(1);
  } finally {
    await closeServer(server);
  }
});

it('fences the exact dispatcher and closes an outstanding real HTTP socket before releasing evidence', async () => {
  const accepted = deferred();
  const peerClosed = deferred();
  const server = createServer((request, response) => {
    request.socket.once('close', () => peerClosed.resolve());
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: still-open\n\n');
    accepted.resolve();
  });
  const origin = await listen(server);
  const owner = createOwnedModelTransport('exact-host');
  const signal = new AbortController().signal;
  try {
    await expect(
      owner.stoppedEvidence('exact-host', signal),
    ).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    const request = new Request(origin);
    const response = await owner.fetchOwned(fetch, request, {});
    await accepted.promise;
    await owner.close();
    await peerClosed.promise;
    await expect(
      owner.stoppedEvidence('other-host', signal),
    ).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    await expect(owner.stoppedEvidence('exact-host', signal)).resolves.toMatch(
      /^undici-owner-stopped:exact-host:/,
    );
    expect(() => owner.fetchOwned(fetch, request, {})).toThrow();
    await response.body?.cancel().catch(() => {});
  } finally {
    await owner.close();
    await closeServer(server);
  }
});

it.each(['abort', 'oversize'])(
  'joins an isolated native POST before reporting %s',
  async (mode) => {
    const reached = deferred();
    const peerClosed = deferred();
    const server = createServer((request, response) => {
      request.socket.once('close', () => peerClosed.resolve());
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(mode === 'oversize' ? 'x'.repeat(128) : '{');
      reached.resolve();
    });
    const endpoint = new URL(await listen(server));
    const stop = new AbortController();
    try {
      const operation = runWithOwnedNativeFetch(
        endpoint,
        32,
        stop.signal,
        async () => {
          const response = await fetch(endpoint, {
            method: 'POST',
            body: '{}',
          });
          return response.json();
        },
      );
      await reached.promise;
      if (mode === 'abort') stop.abort();
      expect(await operation).toMatchObject({ ok: false });
      await peerClosed.promise;
    } finally {
      await closeServer(server);
    }
  },
);
