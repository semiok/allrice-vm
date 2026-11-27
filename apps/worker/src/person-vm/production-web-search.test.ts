import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import type { RequestContext } from '@allrice/contracts';
import type {
  PersonVmAdmissionBoundary,
  PersonVmBinding,
} from '@allrice/person-vm';
import { expect, it, vi } from 'vitest';
import type { WebSearchProvider } from '@deepseek-ai/dsh-web';
import { createHostSearch, readGuestSearch } from './production-web-search.js';

const wire = {
  adapterId: 'a'.repeat(64),
  sessionId: 'native-session',
  query: 'Shanghai weather',
  maxResults: 1,
};

function body(value: unknown): IncomingMessage {
  const bytes = Buffer.from(JSON.stringify(value));
  return Object.assign(Readable.from([bytes]), {
    headers: {
      'content-type': 'application/json',
      'content-length': String(bytes.length),
    },
  }) as unknown as IncomingMessage;
}

it('gates query shape and never accepts a guest-selected credential or URL', async () => {
  const signal = new AbortController().signal;
  expect(await readGuestSearch(body(wire), signal)).toEqual(wire);
  await expect(
    readGuestSearch(
      body({ ...wire, baseURL: 'https://other.example' }),
      signal,
    ),
  ).rejects.toMatchObject({ code: 'DENIED' });
  await expect(
    readGuestSearch(body({ ...wire, query: 'x'.repeat(8192) }), signal),
  ).rejects.toMatchObject({ code: 'DENIED' });
});

function fixture(limit = 1) {
  const stop = new AbortController();
  const binding: PersonVmBinding = {
    vmId: randomUUID(),
    personId: randomUUID(),
    organizationId: randomUUID(),
    instanceId: randomUUID(),
    leaseEpoch: 4,
  };
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: binding.personId },
    organizationId: binding.organizationId,
    workspaceId: null,
    memberships: [],
    authenticatedAt: '2026-11-26T00:00:00.000Z',
  };
  const permit = {
    permitId: randomUUID(),
    binding,
    participant: 'gateway' as const,
    disposition: 'queued' as const,
    signal: stop.signal,
  };
  const release = vi.fn(async () => {});
  const admission: PersonVmAdmissionBoundary = {
    admit: vi.fn(async () => permit),
    queued: async (_permit, run, signal) => run(signal),
    activate: async (_permit, run, signal) => run(signal),
    waitUntilReady: async () => binding,
    finish: release,
  };
  const search = vi.fn<WebSearchProvider['search']>(async () => ({
    sources: [{ url: 'https://one.example' }, { url: 'https://two.example' }],
    truncated: false,
  }));
  const checkBinding = vi.fn(async () => {});
  const assertCurrent = vi.fn(async () => {});
  const dispatch = createHostSearch({
    provider: { search },
    vm: { assertAdmissionBinding: checkBinding },
    admission,
    requestsPerPersonPerMinute: limit,
  });
  return {
    dispatch,
    authority: { binding, context, signal: stop.signal, assertCurrent },
    stop,
    release,
    search,
    checkBinding,
  };
}

async function local<T>(
  handle: (response: ServerResponse) => Promise<void>,
  run: (origin: string) => Promise<T>,
) {
  const server = createServer((_request, response) => {
    void handle(response).catch((error: { code?: string }) => {
      response.writeHead(403).end(error.code ?? '');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('missing listener');
    return await run('http://127.0.0.1:' + address.port);
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

it('checks the exact binding before and after search and shares the rate limit across VM epochs', async () => {
  const f = fixture();
  let epoch = f.authority.binding.leaseEpoch;
  const signal = new AbortController().signal;
  await local(
    (response) =>
      f.dispatch(
        {
          ...f.authority,
          binding: { ...f.authority.binding, leaseEpoch: epoch },
        },
        wire,
        response,
        signal,
      ),
    async (origin) => {
      const first = await fetch(origin);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({
        sources: [{ url: 'https://one.example' }],
        truncated: true,
      });
      epoch++;
      expect(await (await fetch(origin)).text()).toBe('LIMIT_EXCEEDED');
    },
  );
  expect(f.search).toHaveBeenCalledTimes(1);
  expect(f.checkBinding).toHaveBeenNthCalledWith(
    2,
    f.authority.context,
    f.authority.binding,
    expect.any(AbortSignal),
  );
  expect(f.release).toHaveBeenCalledTimes(2);
});

it('cancels the upstream and does not emit a result after revocation', async () => {
  const f = fixture();
  let upstreamAborted = false;
  f.search.mockImplementationOnce(async (_query, signal) => {
    signal?.addEventListener(
      'abort',
      () => {
        upstreamAborted = true;
      },
      { once: true },
    );
    f.stop.abort();
    return { sources: [{ url: 'https://one.example' }], truncated: false };
  });
  const signal = new AbortController().signal;
  await local(
    (response) => f.dispatch(f.authority, wire, response, signal),
    async (origin) => {
      const response = await fetch(origin);
      expect(response.status).toBe(403);
      await response.text();
    },
  );
  expect(upstreamAborted).toBe(true);
  expect(f.release).toHaveBeenCalledTimes(1);
});
