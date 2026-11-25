import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { closeServer, deferred, listen } from './gateway.fixture.ts';
import { createOwnedModelTransport } from './owned-transport.ts';

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
