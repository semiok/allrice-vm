import { randomUUID } from 'node:crypto';
import { on, once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  hostFixture,
  issue,
  deferred,
} from '../../../../packages/d-entry-principal/test/host-fixture.js';
import { createDEntryNativeGateway } from '../../../web/server/d-entry-native.mjs';
import { nativeEntryFixture } from './native-entry.fixture.js';
import { createDEntryPrincipalControl } from './principal-control.js';
import { createDEntryPageRpc } from './principal-page-rpc.js';
import { createDEntryPageMux } from './principal-profile-mux.js';
import { createDEntryPageRequests } from './principal-requests.js';

const closes: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const sessionToken = 'original_session_token_for_page';
const otherToken = 'different_session_of_same_person';

async function fixture() {
  const selected = issue('execute');
  const f = nativeEntryFixture();
  const host = await hostFixture({
    ...selected,
    identity: f.identity,
  });
  closes.push(() => host.close());
  const service = new AbortController();
  const control = createDEntryPrincipalControl(host.node, {
    carrier: service.signal,
    cleanupTimeoutMs: 3000,
  });
  closes.push(() => control.close());
  vi.mocked(f.owner.acquirePrincipal).mockImplementation((_, input, active) =>
    control.acquire(input, active),
  );
  vi.mocked(f.owner.readSessions).mockResolvedValue({
    ok: true,
    value: { items: host.catalog.items },
  });
  f.root.mockImplementation(async () => ({
    identity: f.identity,
    rootNativeSessionId: selected.root.nativeSessionId,
    rootOriginDigest: selected.root.rootOriginDigest,
    rootBindingRef: selected.root.rootBindingRef,
    vmId: f.binding.vmId,
  }));
  const otherSession = { ...f.context, sessionId: randomUUID() };
  const authenticate = vi.fn(async (token: string) =>
    token === sessionToken
      ? f.context
      : token === otherToken
        ? otherSession
        : null,
  );
  const pages = createDEntryPageRequests({
    ...f.deps,
    authenticate,
    historyIdentity: vi.fn(async (_context, selection) => ({
      ...f.identity,
      threadId: (selection as { threadId?: string }).threadId ?? null,
    })),
    historyRoot: f.root,
  });
  const mux = createDEntryPageMux(pages, service.signal);
  const rpc = createDEntryPageRpc(pages, authenticate, service.signal);
  const worker = createServer(async (request, response) => {
    if (!(await rpc.handle(request, response))) response.writeHead(404).end();
  });
  worker.on('upgrade', (request, socket, head) => {
    if (mux.matches(request)) void mux.upgrade(request, socket, head);
    else socket.destroy();
  });
  const workerOrigin = await listen(worker);
  vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', workerOrigin);
  closes.push(async () => {
    await Promise.all([mux.close(), rpc.close()]);
    worker.closeAllConnections();
    await new Promise<void>((resolve) => worker.close(() => resolve()));
  });
  const web = createServer();
  const origin = await listen(web);
  const probe = vi.fn(async (target: string | URL, _init: RequestInit) => {
    const requested = new URL(target);
    expect(requested.pathname).toBe('/api/v1/d-entry/identity');
    return Response.json({
      identity: {
        ...f.identity,
        threadId: requested.searchParams.get('threadId'),
      },
    });
  });
  const gateway = createDEntryNativeGateway({
    port: (web.address() as AddressInfo).port,
    probe,
  });
  web.on(
    'upgrade',
    (request, socket, head) => void gateway.upgrade(request, socket, head),
  );
  const clients: WebSocket[] = [];
  closes.push(async () => {
    clients.forEach((client) => client.terminate());
    await gateway.close();
    await new Promise<void>((resolve) => web.close(() => resolve()));
  });
  const connect = (scopeId?: string, token = sessionToken, suffix = '') => {
    const query = new URLSearchParams({
      carrier: 'page',
      organizationId: f.identity.organizationId,
      ...f.selection,
      ...(scopeId && { scopeId }),
    });
    const client = new WebSocket(
      origin.replace('http:', 'ws:') +
        '/api/v1/d-entry/native-mux?' +
        query +
        suffix,
      { headers: { origin, cookie: 'allrice_session=' + token } },
    );
    client.on('error', () => {});
    clients.push(client);
    return client;
  };
  const invoke = (scopeId: string, token = sessionToken, extra: object = {}) =>
    fetch(workerOrigin + '/internal/d-entry/native-rpc?carrier=page', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...f.body,
        scopeId,
        rpcId: '',
        endpoint: 'session/page',
        payload: {
          args: {
            request: { address: { kind: 'session', sessionId: 'root' } },
          },
        },
        ...extra,
      }),
    });
  return { ...f, host, connect, invoke, probe };
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
}

function send(peer: WebSocket, value: object) {
  peer.send(JSON.stringify(value));
}
function messages(peer: WebSocket) {
  const events = on(peer, 'message', { close: ['close'] });
  return async () => {
    const next = await events.next();
    if (next.done)
      throw Error('Socket closed before the expected native frame');
    return JSON.parse(String(next.value[0]));
  };
}
async function open(f: Awaited<ReturnType<typeof fixture>>) {
  const peer = f.connect();
  await once(peer, 'open');
  const receive = messages(peer);
  send(peer, {
    type: 'open',
    streamId: 'life',
    endpoint: '$d-entry/page',
    payload: { args: {} },
  });
  const frame = await receive();
  expect(frame).toMatchObject({
    type: 'item',
    streamId: 'life',
    value: { type: 'opened', bindingRef: f.owner.bindingRef },
  });
  expect(Object.keys(frame.value).sort()).toEqual([
    'bindingRef',
    'scopeReference',
    'type',
  ]);
  return {
    peer,
    receive,
    scopeId: frame.value.scopeReference.scopeId as string,
  };
}
async function status(peer: WebSocket) {
  const [request, response] = await once(peer, 'unexpected-response');
  response.resume();
  request.destroy();
  return response.statusCode;
}
function closePage(peer: WebSocket) {
  send(peer, { type: 'item', streamId: 'life', value: 'close' });
  send(peer, { type: 'end', streamId: 'life' });
}

it('issues only once, borrows the same actual native Peer for unary and stream and joins before closed/end', async () => {
  const f = await fixture();
  const life = await open(f);
  const business = f.connect(life.scopeId);
  await once(business, 'open');
  const next = messages(business);
  send(business, {
    type: 'open',
    streamId: 'self',
    endpoint: 'remoteAccess/follow',
    payload: { args: {} },
  });
  expect(await next()).toMatchObject({
    type: 'item',
    value: { type: 'baseline', owner: false },
  });
  send(business, {
    type: 'open',
    streamId: 'events',
    endpoint: '$events',
    payload: { args: {} },
  });
  expect(await next()).toMatchObject({
    type: 'item',
    streamId: 'events',
    value: { type: 'ready', host: { home: '/home/native-fixture' } },
  });

  const finishNative = deferred(),
    finishingNative = deferred();
  f.host.catalog.afterFollow = async () => {
    finishingNative.resolve();
    await finishNative.promise;
  };
  send(business, {
    type: 'open',
    streamId: 'root',
    endpoint: 'session/follow',
    payload: {
      args: {
        request: {
          address: { kind: 'session', sessionId: 'root' },
          throughSeq: 0,
        },
      },
    },
  });
  expect(await next()).toMatchObject({
    type: 'item',
    streamId: 'root',
    value: { type: 'snapshot' },
  });
  const response = await f.invoke(life.scopeId);
  expect(await response.json()).toEqual({
    type: 'server-response',
    rpcId: '',
    result: { ok: true, value: { records: [], hasMore: false } },
  });
  expect(f.host.catalog.pages[0]).toBe(f.host.catalog.follows[0]);
  expect(f.owner.acquirePrincipal).toHaveBeenCalledTimes(1);
  expect(f.probe.mock.calls[0]?.[1].method).toBe('GET');

  let ack: unknown;
  const closed = life.receive().then((frame) => (ack = frame));
  closePage(life.peer);
  try {
    await finishingNative.promise;
    expect(ack).toBeUndefined();
    expect((await f.invoke(life.scopeId)).status).toBe(404);
  } finally {
    finishNative.resolve();
  }
  expect(await closed).toEqual({
    type: 'item',
    streamId: 'life',
    value: { type: 'closed', scopeId: life.scopeId },
  });
  expect(await life.receive()).toEqual({ type: 'end', streamId: 'life' });
});

it('refuses duplicate selectors, unauthorized login and cross-session borrow without disturbing the page', async () => {
  const f = await fixture();
  expect(
    await status(f.connect(undefined, sessionToken, '&carrier=page')),
  ).toBe(400);
  expect(await status(f.connect(undefined, 'unknown_original_session'))).toBe(
    401,
  );
  const life = await open(f);
  expect(await status(f.connect(life.scopeId, otherToken))).toBe(404);
  expect((await f.invoke(life.scopeId, otherToken)).status).toBe(404);
  expect(
    (await f.invoke(life.scopeId, sessionToken, { endpoint: 'session/list' }))
      .status,
  ).toBe(400);
  expect((await f.invoke(life.scopeId)).status).toBe(200);
  expect(f.owner.acquirePrincipal).toHaveBeenCalledTimes(1);
  closePage(life.peer);
  expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
  expect(await life.receive()).toEqual({ type: 'end', streamId: 'life' });
});
