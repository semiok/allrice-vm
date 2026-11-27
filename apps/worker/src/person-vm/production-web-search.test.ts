import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import type { RequestContext } from '@allrice/contracts';
import { EgressError } from '@allrice/egress-gateway';
import type {
  PersonVmAdmissionBoundary,
  PersonVmBinding,
} from '@allrice/person-vm';
import { expect, it, vi } from 'vitest';
import {
  createHostSearch,
  readGuestSearch,
  type JoinedSearchProvider,
} from './production-web-search.js';

const wire = {
  adapterId: 'a'.repeat(64),
  sessionId: 'native-session',
  ticket: randomUUID(),
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
  expect(
    await readGuestSearch(body({ ...wire, query: '  weather  ' }), signal),
  ).toMatchObject({ query: '  weather  ' });
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
  const search = vi.fn<JoinedSearchProvider['search']>(async () => ({
    ok: true,
    value: {
      sources: [{ url: 'https://one.example' }, { url: 'https://two.example' }],
      truncated: false,
    },
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
    authority: {
      binding,
      context,
      signal: stop.signal,
      assertCurrent,
      closeProof: vi.fn(async () => {}),
    },
    stop,
    admission,
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
    void handle(response).catch((error: unknown) => {
      const failure =
        error instanceof EgressError
          ? error.code
          : error instanceof Error
            ? error.name
            : 'UNKNOWN';
      response.writeHead(403).end(failure);
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
    return {
      ok: true,
      value: { sources: [{ url: 'https://one.example' }], truncated: false },
    };
  });
  const signal = new AbortController().signal;
  await local(
    (response) => f.dispatch(f.authority, wire, response, signal),
    async (origin) => {
      const response = await fetch(origin);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('AbortError');
    },
  );
  expect(upstreamAborted).toBe(true);
  expect(f.release).toHaveBeenCalledTimes(1);
});

it('joins a revoked pre-activation error without retaining an unsafe permit', async () => {
  const f = fixture();
  const persisted = new Set(['queued-permit']);
  let unsafe = false;
  f.admission.queued = async (_permit, run, signal) => {
    try {
      return await run(signal);
    } catch (err) {
      unsafe = true;
      throw err;
    }
  };
  f.admission.activate = async () => {
    throw new Error('lease revoked during admission');
  };
  f.admission.finish = async () => {
    if (!unsafe) persisted.delete('queued-permit');
  };
  await expect(
    f.dispatch(
      f.authority,
      wire,
      {} as ServerResponse,
      new AbortController().signal,
    ),
  ).rejects.toThrow('lease revoked during admission');
  expect(f.search).not.toHaveBeenCalled();
  expect(persisted.size).toBe(0);
});

it('leaves transport closure failures unknown instead of certifying the activation joined', async () => {
  const f = fixture();
  const failure = new Error('dispatcher closure unknown');
  f.search.mockRejectedValueOnce(failure);
  let activationEscaped = false;
  f.admission.activate = async (_permit, invoke, active) => {
    try {
      return await invoke(active);
    } catch (error) {
      activationEscaped = true;
      throw error;
    }
  };
  await expect(
    f.dispatch(
      f.authority,
      wire,
      {} as ServerResponse,
      new AbortController().signal,
    ),
  ).rejects.toBe(failure);
  expect(activationEscaped).toBe(true);
  expect(f.release).toHaveBeenCalledOnce();
});

it('closes the native proof before the admitted permit is finished', async () => {
  const f = fixture();
  f.search.mockResolvedValueOnce({ ok: false, error: new Error('upstream') });
  await expect(
    f.dispatch(
      f.authority,
      wire,
      {} as ServerResponse,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(f.authority.closeProof).toHaveBeenCalledBefore(f.release);
});
