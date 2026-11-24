import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { on, once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
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
import { createDEntryProfile } from './profile.js';
import { holdReleasedProfile } from './released-profile.js';
import {
  DEntryProfileBootstrapSchema,
  DEntryProfileGraphSchema,
} from '@allrice/contracts';

const closes: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const sessionToken = 'original_session_token_for_page';
const otherToken = 'different_session_of_same_person';

async function fixture(release?: { directory: string; graph: unknown }) {
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
  const profileSource = new AbortController();
  if (release)
    f.deps.owners.resolve.mockResolvedValue({
      ...f.owner,
      fixedProfile: {
        revoked: profileSource.signal,
        async readImmutableGraph(signal) {
          signal.throwIfAborted();
          return release.graph;
        },
      },
    });
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
  const profile = createDEntryProfile(
    pages,
    service.signal,
    release?.directory,
  );
  const worker = createServer(async (request, response) => {
    if (await profile.handle(request, response)) return;
    if (!(await rpc.handle(request, response))) response.writeHead(404).end();
  });
  worker.on('upgrade', (request, socket, head) => {
    if (mux.matches(request)) void mux.upgrade(request, socket, head);
    else socket.destroy();
  });
  const workerOrigin = await listen(worker);
  vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', workerOrigin);
  closes.push(async () => {
    await Promise.all([mux.close(), rpc.close(), profile.close()]);
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
            request: {
              address: { kind: 'session', sessionId: 'root' },
              throughSeq: 0,
            },
          },
        },
        ...extra,
      }),
    });
  function publish(
    kind: 'bootstrap' | 'assets' | 'events',
    scopeId: string,
    selectors: Record<string, string> = {},
    mode?: 'document' | 'static',
    signal?: AbortSignal,
  ) {
    const url = new URL('/internal/d-entry/profile/' + kind, workerOrigin);
    url.search = new URLSearchParams({
      ...f.selection,
      organizationId: f.identity.organizationId,
      scopeId,
      ...selectors,
    }).toString();
    return fetch(url, {
      signal,
      headers: {
        authorization: 'Bearer ' + sessionToken,
        ...(mode && { 'x-allrice-profile-request': mode }),
      },
    });
  }
  return {
    ...f,
    host,
    connect,
    invoke,
    probe,
    publish,
    profileSource,
    web,
    origin,
  };
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
  return async (streamId?: string) => {
    while (true) {
      const next = await events.next();
      if (next.done)
        throw Error('Socket closed before the expected native frame');
      const frame = JSON.parse(String(next.value[0]));
      if (!streamId || frame.streamId === streamId) return frame;
    }
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
  expect(await next('events')).toMatchObject({
    type: 'item',
    streamId: 'events',
    value: { type: 'ready', host: { home: '/home/native-fixture' } },
  });

  const finishNative = deferred(),
    finishingNative = deferred();
  closes.push(async () => finishNative.resolve());
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
        request: { address: { kind: 'session', sessionId: 'root' } },
      },
    },
  });
  expect(await next('root')).toMatchObject({
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
  const cleanTransport = once(life.peer, 'close');
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
  expect((await cleanTransport)[0]).toBe(1000);
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

it(
  'publishes the real released graph and exact bytes through the same live page and closes an active event reader on revocation',
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-profile-release-'));
    closes.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, 'release');
    await promisify(execFile)(
      process.execPath,
      ['packages/dsh-web-composition/build-web-entry.mjs', directory],
      { timeout: 20_000 },
    );
    const raw = JSON.parse(
      await readFile(join(directory, 'artifact.json'), 'utf8'),
    );
    const graph = DEntryProfileGraphSchema.parse(raw.profile.graph);
    const source = new AbortController().signal;
    // Report the first immutable release diagnostic before entering the HTTP
    // boundary, which deliberately exposes only a generic dependency status.
    await holdReleasedProfile(
      directory,
      {
        revoked: source,
        async readImmutableGraph() {
          return graph;
        },
      },
      source,
    );
    // This runs the released app profile builder and actual non-owner Cordis
    // Peer. Only the VM receipt/current PostgreSQL lease is fixture-owned.
    const f = await fixture({ directory, graph });
    const { peer, receive, scopeId } = await open(f);
    const address = await f.publish('bootstrap', scopeId, {}, 'document');
    expect(address.status).toBe(200);
    const target = await address.json();
    expect(target).toMatchObject({
      bindingRef: f.owner.bindingRef,
      graphRev: graph.rev,
      nativeSessionId: 'root',
    });
    const initial = await f.publish('bootstrap', scopeId);
    expect(initial.status).toBe(200);
    const boot = DEntryProfileBootstrapSchema.parse(await initial.json());
    expect(boot.graph).toEqual(graph);
    expect(boot.injections.at(-1)).toMatchObject({
      kind: 'global',
      name: '__DSH_REMOTE_ACCESS__',
      value: { owner: false, grants: expect.any(Array) },
    });
    const duplicate = await f.publish('bootstrap', scopeId);
    expect(duplicate.status).toBe(409);
    await duplicate.body?.cancel();
    const { url, rev } = graph.batches[0]!;
    const asset = await f.publish('assets', scopeId, {
      bindingRef: f.owner.bindingRef,
      reference: url,
      revision: rev,
    });
    expect(asset.status).toBe(200);
    const proof = raw.profile.files.find(
      (row: { reference: string }) => row.reference === url,
    );
    const data = Buffer.from(await asset.arrayBuffer());
    expect(data).toEqual(await readFile(join(directory, proof.path)));
    expect(asset.headers.get('content-length')).toBe(String(data.byteLength));
    const bad = await f.publish('assets', scopeId, {
      bindingRef: f.owner.bindingRef,
      reference: url,
      revision: 'wrong',
    });
    expect(bad.status).toBe(404);
    await bad.body?.cancel();

    const keep = new AbortController();
    closes.push(async () => keep.abort());
    const events = await f.publish(
      'events',
      scopeId,
      { bindingRef: f.owner.bindingRef },
      undefined,
      keep.signal,
    );
    const reader = events.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(
      `data: ${JSON.stringify({ type: 'graph', graph })}\n\n`,
    );
    const clash = await f.publish('events', scopeId, {
      bindingRef: f.owner.bindingRef,
    });
    expect(clash.status).toBe(409);
    await clash.body?.cancel();
    const pending = expect(reader.read()).rejects.toThrow();
    f.profileSource.abort(Error('The native profile source was retired'));
    expect(await receive()).toMatchObject({
      type: 'error',
      streamId: 'life',
    });
    await pending;
    expect((await f.invoke(scopeId)).status).toBe(404);
    peer.terminate();
  },
);

it.skipIf(!process.env.ALLRICE_BROWSER_EXECUTABLE)(
  'joins the native page carrier in Chromium with the original browser Cookie',
  { timeout: 25_000 },
  async () => {
    const f = await fixture();
    f.web.on('request', (_, outgoing) => {
      outgoing.writeHead(200, { 'content-type': 'text/html' });
      outgoing.end('<!doctype html><title>Owned native carrier test</title>');
    });
    const require = createRequire(
      new URL(
        '../../../../packages/dsh-web-composition/package.json',
        import.meta.url,
      ),
    );
    const result: { outputFiles: { text: string }[] } =
      await require('esbuild').build({
        entryPoints: ['apps/web/lib/d-entry/page-carrier.ts'],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'DEntryCarrier',
        write: false,
      });
    const browser = await chromium.launch({
      executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE,
    });
    closes.push(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
      { name: 'allrice_session', value: sessionToken, url: f.origin },
    ]);
    const page = await context.newPage();
    await page.goto(f.origin);
    await page.addScriptTag({ content: result.outputFiles[0]!.text });
    const receipt = await page.evaluate(
      async ({ identity, selection }) => {
        const { openNativePageCarrier } = (
          window as unknown as {
            DEntryCarrier: typeof import('../../../web/lib/d-entry/page-carrier');
          }
        ).DEntryCarrier;
        let revoked = false;
        const carrier = openNativePageCarrier(identity, selection, () => {
          revoked = true;
        });
        const opened = await carrier.ready;
        await carrier.close();
        return { opened, revoked };
      },
      { identity: f.identity, selection: f.selection },
    );
    expect(receipt).toMatchObject({
      opened: {
        type: 'opened',
        scopeReference: { scopeId: expect.any(String) },
        bindingRef: f.owner.bindingRef,
      },
      revoked: false,
    });
    expect(
      await f
        .invoke(receipt.opened.scopeReference.scopeId)
        .then((value) => value.status),
    ).toBe(404);
    expect(f.owner.acquirePrincipal).toHaveBeenCalledTimes(1);
    await context.close();
  },
);
