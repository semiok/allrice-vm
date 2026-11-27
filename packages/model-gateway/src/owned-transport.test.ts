import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { closeServer, deferred, listen } from './gateway.fixture.ts';
import { createOwnedModelTransport } from './owned-transport.ts';
import { runWithOwnedNativeFetch } from './transport.ts';

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
