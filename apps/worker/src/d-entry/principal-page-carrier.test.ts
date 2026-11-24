import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { on, once } from 'node:events';
import { createServer, get, type ServerResponse } from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { DataAccessError } from '@allrice/database';
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
  DEntryPageOpenedSchema,
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

type ProfileProof = {
  directory: string;
  graph: unknown;
  read(reference: string, signal: AbortSignal): Promise<Uint8Array>;
  beforeGraphRead?: (signal: AbortSignal) => Promise<void>;
};

async function fixture(release?: ProfileProof) {
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
          await release.beforeGraphRead?.(signal);
          signal.throwIfAborted();
          return release.graph;
        },
        readImmutableBundle: release.read,
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
    if (request.url === '/fixture-before-profile') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('unrelated handler still running');
      return;
    }
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
  function profileUrl(
    kind: 'bootstrap' | 'assets' | 'events',
    scopeId: string,
    selectors: Record<string, string> = {},
  ) {
    const url = new URL('/internal/d-entry/profile/' + kind, workerOrigin);
    url.search = new URLSearchParams({
      ...f.selection,
      organizationId: f.identity.organizationId,
      scopeId,
      ...selectors,
    }).toString();
    return url;
  }
  function publish(
    kind: 'bootstrap' | 'assets' | 'events',
    scopeId: string,
    selectors: Record<string, string> = {},
    mode?: 'document' | 'static',
    signal?: AbortSignal,
  ) {
    const url = profileUrl(kind, scopeId, selectors);
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
    profileUrl,
    closeProfile: profile.close,
    worker,
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
  'publishes the released graph and bytes, and waits for all queued HTTP writers to settle',
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
    const largeAsset = 'managed/transfer-ownership-test.js';
    const largeBytes = Buffer.alloc(12 * 1024 * 1024, 32);
    await writeFile(join(directory, largeAsset), largeBytes);
    raw.files.push({
      path: largeAsset,
      bytes: largeBytes.length,
      sha256: createHash('sha256').update(largeBytes).digest('hex'),
    });
    await writeFile(join(directory, 'artifact.json'), JSON.stringify(raw));
    const graph = DEntryProfileGraphSchema.parse(raw.profile.graph);
    const read = (reference: string, signal: AbortSignal) => {
      const file = raw.profile.files.find(
        (row: { reference: string }) => row.reference === reference,
      );
      if (!file) throw Error('Named release proof missing');
      return readFile(join(directory, file.path), { signal });
    };
    const source = new AbortController().signal;
    await holdReleasedProfile(
      directory,
      {
        revoked: source,
        async readImmutableGraph() {
          return graph;
        },
        readImmutableBundle: read,
      },
      source,
    );
    // This runs the released app profile builder and actual non-owner Cordis
    // Peer. Only the VM receipt/current PostgreSQL lease is fixture-owned.
    const ownerProof: ProfileProof = { directory, graph, read };
    const f = await fixture(ownerProof);
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

    async function blockedAsset() {
      const serverResponse = deferred<ServerResponse>();
      f.worker.once('request', (_request, response) =>
        serverResponse.resolve(response),
      );
      const url = f.profileUrl('assets', scopeId, {
        bindingRef: f.owner.bindingRef,
        graphRev: target.graphRev,
        manifestSha256: target.manifestSha256,
        path: largeAsset,
      });
      const request = get(url, {
        headers: {
          authorization: 'Bearer ' + sessionToken,
          'x-allrice-profile-request': 'static',
        },
      });
      request.on('error', () => {});
      closes.push(async () => request.destroy());
      const [paused] = await once(request, 'response');
      paused.on('error', () => {});
      paused.pause();
      expect(paused.statusCode).toBe(200);
      const response = await serverResponse.promise;
      expect(response.writableFinished).toBe(false);
      return { request, closed: once(response, 'close') };
    }
    const cancelled = await blockedAsset();
    cancelled.request.destroy();
    await cancelled.closed;
    expect((await f.invoke(scopeId)).status).toBe(200);

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
    const pending = reader.read().then(
      () => false,
      () => true,
    );
    const foreground = await open(f);
    const waiting = await open(f);
    const pipeline = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: waiting.scopeId,
    });
    const [active, queuedAsset, queuedDenial, next] = pipeline.responses;
    for (const item of [queuedAsset!, queuedDenial!, next!]) {
      expect(item.socket).toBeNull();
      expect(item.headersSent).toBe(false);
      expect(item.writableEnded).toBe(false);
    }
    closePage(waiting.peer);
    expect(await waiting.receive()).toMatchObject({
      value: { type: 'closed' },
    });
    expect(await waiting.receive()).toEqual({ type: 'end', streamId: 'life' });
    expect((await f.invoke(waiting.scopeId)).status).toBe(404);
    expect((await f.invoke(foreground.scopeId)).status).toBe(200);
    expect(active!.destroyed).toBe(false);
    expect(active!.writableEnded).toBe(false);
    expect(queuedAsset!.statusCode).toBe(404);
    expect(queuedDenial!.statusCode).toBe(404);
    expect(next!.headersSent).toBe(false);
    active!.end();
    await expect
      .poll(() => pipeline.raw().match(/HTTP\/1\.1 (200|404)/g))
      .toEqual([
        'HTTP/1.1 200',
        'HTTP/1.1 404',
        'HTTP/1.1 404',
        'HTTP/1.1 200',
      ]);
    await expect
      .poll(() => pipeline.raw().includes(target.manifestSha256))
      .toBe(true);
    expect(pipeline.raw()).not.toContain(
      'content-length: ' + largeBytes.length,
    );
    pipeline.client.destroy();

    const noNotification = await open(f);
    const afterRoleChange = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: noNotification.scopeId,
      onlyAsset: true,
    });
    const [roleHead, roleAsset, roleNext] = afterRoleChange.responses;
    expect(roleAsset!.socket).toBeNull();
    // The authoritative lookup now denies B. Its watcher has not sent any
    // cancellation signal. The HTTP writer must read again after its turn.
    vi.mocked(f.owner.assertCurrent).mockRejectedValueOnce(
      new DataAccessError('authorization_denied'),
    );
    roleHead!.end();
    await expect
      .poll(() => afterRoleChange.raw().match(/HTTP\/1\.1 (200|404)/g))
      .toEqual(['HTTP/1.1 200', 'HTTP/1.1 404', 'HTTP/1.1 200']);
    expectEmptyDenial(afterRoleChange.raw());
    expect(roleNext!.writableFinished).toBe(true);
    expect((await f.invoke(noNotification.scopeId)).status).toBe(404);
    expect((await f.invoke(foreground.scopeId)).status).toBe(200);
    afterRoleChange.client.destroy();

    const beforeHeaders = await open(f);
    const assigned = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: beforeHeaders.scopeId,
      onlyAsset: true,
    });
    const [assignHead, assignedAsset, assignedNext] = assigned.responses;
    const checking = deferred();
    const finishCheck = deferred();
    closes.push(async () => finishCheck.resolve());
    vi.mocked(f.owner.assertCurrent).mockImplementationOnce(async () => {
      checking.resolve();
      await finishCheck.promise;
    });
    assignHead!.end();
    await checking.promise;
    expect(assignedAsset!.socket).not.toBeNull();
    expect(assignedAsset!.headersSent).toBe(false);
    const rejected = beforeHeaders.receive();
    closePage(beforeHeaders.peer);
    await expect
      .poll(async () => (await f.invoke(beforeHeaders.scopeId)).status)
      .toBe(404);
    expect(assignedAsset!.headersSent).toBe(false);
    expect(assignedNext!.headersSent).toBe(false);
    finishCheck.resolve();
    expect(await rejected).toMatchObject({ value: { type: 'closed' } });
    await expect
      .poll(() => assigned.raw().match(/HTTP\/1\.1 (200|404)/g))
      .toEqual(['HTTP/1.1 200', 'HTTP/1.1 404', 'HTTP/1.1 200']);
    expectEmptyDenial(assigned.raw());
    expect(assignedNext!.writableFinished).toBe(true);
    assigned.client.destroy();

    const reading = await open(f);
    const readingGraph = deferred();
    const finishRead = deferred();
    closes.push(async () => finishRead.resolve());
    const preRead = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: reading.scopeId,
      onlyAsset: true,
      beforeQueued: () => {
        ownerProof.beforeGraphRead = async () => {
          ownerProof.beforeGraphRead = undefined;
          readingGraph.resolve();
          await finishRead.promise;
        };
      },
      beforeNext: () => readingGraph.promise,
    });
    const [readHead, preReadAsset, preReadNext] = preRead.responses;
    await readingGraph.promise;
    expect(preReadAsset!.listenerCount('socket')).toBe(0);
    closePage(reading.peer);
    await expect
      .poll(async () => (await f.invoke(reading.scopeId)).status)
      .toBe(404);
    finishRead.resolve();
    expect(await reading.receive()).toMatchObject({
      value: { type: 'closed' },
    });
    expect(preReadAsset!.statusCode).toBe(404);
    expect(preReadAsset!.writableEnded).toBe(true);
    expect(readHead!.writableEnded).toBe(false);
    expect(preReadNext!.headersSent).toBe(false);
    readHead!.end();
    await expect
      .poll(() => preRead.raw().match(/HTTP\/1\.1 (200|404)/g))
      .toEqual(['HTTP/1.1 200', 'HTTP/1.1 404', 'HTTP/1.1 200']);
    expectEmptyDenial(preRead.raw());
    preRead.client.destroy();

    const draining = await pipelineAfterEvents(foreground.scopeId);
    const held = holdSocket(draining.responses[0]!);
    let terminal: Awaited<ReturnType<typeof receive>> | undefined;
    const terminalPromise = foreground
      .receive()
      .then((frame) => (terminal = frame));
    closePage(foreground.peer);
    await expect.poll(() => held.fenced()).toBe(true);
    expect((await f.invoke(foreground.scopeId)).status).toBe(404);
    expect((await f.invoke(scopeId)).status).toBe(200);
    expect(terminal).toBeUndefined();
    held.release.resolve();
    await held.closed;
    expect(await terminalPromise).toMatchObject({ value: { type: 'closed' } });
    expect(await foreground.receive()).toEqual({
      type: 'end',
      streamId: 'life',
    });

    const second = await open(f);
    const firstResponse = await f.publish('bootstrap', second.scopeId);
    expect(firstResponse.status).toBe(200);
    await firstResponse.json();
    const errors = await pipelineAfterEvents(second.scopeId, { errors: true });
    expect(
      errors.responses
        .slice(1)
        .every((r) => r.socket === null && !r.headersSent),
    ).toBe(true);
    const unrelated = await pipelineAfterEvents(second.scopeId, {
      unrelated: true,
    });
    const [unrelatedHead, unrelatedDenial] = unrelated.responses;
    const unrelatedFinish = once(unrelatedDenial!, 'finish');
    expect(unrelatedDenial!.socket).toBeNull();
    expect(unrelatedDenial!.headersSent).toBe(false);
    const heldErrors = holdSocket(errors.responses[0]!);
    let joined = false;
    const stopping = f.closeProfile().then(() => {
      joined = true;
    });
    await expect.poll(() => heldErrors.fenced()).toBe(true);
    expect(joined).toBe(false);
    heldErrors.release.resolve();
    await heldErrors.closed;
    expect(unrelatedDenial!.writableFinished).toBe(false);
    expect(unrelatedHead!.writableEnded).toBe(false);
    expect(joined).toBe(false);
    unrelatedHead!.end();
    await unrelatedFinish;
    await stopping;
    expect(unrelated.raw()).toContain('unrelated handler still running');
    await expect
      .poll(() => unrelated.raw().match(/HTTP\/1\.1 (200|404)/g))
      .toEqual(['HTTP/1.1 200', 'HTTP/1.1 404']);
    unrelated.client.destroy();
    expect(await pending).toBe(true);
    closePage(peer);
    expect(await receive()).toMatchObject({ value: { type: 'closed' } });
    closePage(second.peer);
    expect(await second.receive()).toMatchObject({ value: { type: 'closed' } });

    const withdrawn = await fixture({ directory, graph, read });
    const live = await open(withdrawn);
    const watching = await withdrawn.publish('events', live.scopeId, {
      bindingRef: withdrawn.owner.bindingRef,
    });
    const updates = watching.body!.getReader();
    expect((await updates.read()).done).toBe(false);
    const withdrew = updates.read().then(
      () => false,
      () => true,
    );
    withdrawn.profileSource.abort(
      Error('The native profile source was retired'),
    );
    expect(await live.receive()).toMatchObject({
      type: 'error',
      streamId: 'life',
    });
    expect(await withdrew).toBe(true);
    expect((await withdrawn.invoke(live.scopeId)).status).toBe(404);

    function expectEmptyDenial(output: string) {
      const denial = output
        .split(/\r\n(?=HTTP\/1\.1 )/)
        .find((response) => response.startsWith('HTTP/1.1 404'));
      expect(denial).toMatch(/\r\ncontent-length: 0\r\n/i);
      expect(denial?.split('\r\n\r\n')[1] ?? '').toBe('');
    }
    async function pipelineAfterEvents(
      id: string,
      {
        awaitingId,
        errors = false,
        unrelated = false,
        onlyAsset = false,
        beforeQueued,
        beforeNext,
      }: {
        awaitingId?: string;
        errors?: boolean;
        unrelated?: boolean;
        onlyAsset?: boolean;
        beforeQueued?: () => void;
        beforeNext?: () => Promise<void>;
      } = {},
    ) {
      const worker = f.worker.address() as AddressInfo;
      const client = createConnection({ host: '127.0.0.1', port: worker.port });
      client.on('error', () => {});
      closes.push(async () => client.destroy());
      await once(client, 'connect', { signal: AbortSignal.timeout(5000) });
      const responses: ServerResponse[] = [];
      const observed = (_request: unknown, response: ServerResponse) =>
        responses.push(response);
      f.worker.on('request', observed);
      let body = '';
      client.on('data', (data) => {
        body += data.toString();
      });
      const bindingRef = f.owner.bindingRef;
      const events = f.profileUrl('events', id, { bindingRef });
      const serialize = (url: URL, headers = '') =>
        `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${sessionToken}\r\n${headers}\r\n`;
      try {
        const head = unrelated
          ? new URL('/fixture-before-profile', events)
          : events;
        client.write(serialize(head));
        await expect.poll(() => body.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
        await expect
          .poll(() =>
            body.includes(
              unrelated
                ? 'unrelated handler still running'
                : 'text/event-stream',
            ),
          )
          .toBe(true);
        if (unrelated || errors) {
          const invalid = new URL(events);
          invalid.searchParams.append('scopeId', id);
          client.write(
            (unrelated ? '' : serialize(events)) + serialize(invalid),
          );
          await expect.poll(() => responses.length).toBe(unrelated ? 2 : 3);
        } else if (awaitingId) {
          const asset = f.profileUrl('assets', awaitingId, {
            bindingRef,
            graphRev: target.graphRev,
            manifestSha256: target.manifestSha256,
            path: largeAsset,
          });
          const invalid = new URL(asset);
          invalid.searchParams.set('path', 'managed/absent.js');
          const document = f.profileUrl('bootstrap', id);
          beforeQueued?.();
          client.write(
            serialize(asset, 'x-allrice-profile-request: static\r\n') +
              (onlyAsset
                ? ''
                : serialize(invalid, 'x-allrice-profile-request: static\r\n')),
          );
          await beforeNext?.();
          client.write(
            serialize(document, 'x-allrice-profile-request: document\r\n'),
          );
          await expect.poll(() => responses.length).toBe(onlyAsset ? 3 : 4);
        }
        for (const queued of responses.slice(beforeNext ? 2 : 1))
          await expect.poll(() => queued.listenerCount('socket')).toBe(1);
      } finally {
        f.worker.off('request', observed);
      }
      return { responses, client, raw: () => body };
    }
    function holdSocket(response: ServerResponse) {
      const socket = response.socket!;
      const close = socket.destroy.bind(socket);
      let entered = false;
      const release = deferred();
      const hold = vi.spyOn(socket, 'destroy').mockImplementation((error) => {
        entered = true;
        void release.promise.then(() => close(error));
        return socket;
      });
      closes.push(async () => {
        hold.mockRestore();
        release.resolve();
      });
      return { fenced: () => entered, release, closed: once(socket, 'close') };
    }
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
            DEntryCarrier: {
              openNativePageCarrier(
                original: typeof identity,
                selectors: typeof selection,
                revoked: () => void,
              ): {
                ready: Promise<ReturnType<typeof DEntryPageOpenedSchema.parse>>;
                close(): Promise<void>;
              };
            };
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

it.skipIf(!process.env.ALLRICE_BROWSER_EXECUTABLE)(
  'waits for the real document dispose before navigation and cancels a partial bundle on child pagehide',
  { timeout: 30_000 },
  async () => {
    const f = await fixture();
    const root = process.cwd();
    const require = createRequire(
      new URL(
        '../../../../packages/dsh-web-composition/package.json',
        import.meta.url,
      ),
    );
    const { employeeWebKernelOptions } = (await import(
      new URL(
        '../../../../packages/dsh-web-composition/build-web-entry.mjs',
        import.meta.url,
      ).href
    )) as { employeeWebKernelOptions: { loader: Record<string, string> } };
    function bundle(resolveDir: string, source: string) {
      return require('esbuild')
        .build({
          ...employeeWebKernelOptions,
          stdin: { contents: source, resolveDir, loader: 'tsx' },
          format: 'esm',
          write: false,
          outdir: '/page-close-test',
          jsx: 'automatic',
          loader: Object.fromEntries(
            Object.keys(employeeWebKernelOptions.loader!).map((key) => [
              key,
              'dataurl',
            ]),
          ),
        })
        .then(
          (result: { outputFiles: { path: string; text: string }[] }) =>
            result.outputFiles.find((file) => file.path.endsWith('.js'))!.text,
        );
    }
    const [outer, child] = await Promise.all([
      bundle(
        join(root, 'apps/web'),
        `
        import { createRoot } from 'react-dom/client';
        import { EmployeeNativePage } from './app/chatflow/4.0/employee-native-page';
        createRoot(document.getElementById('root')).render(<EmployeeNativePage query={location.search.slice(1)} />);
      `,
      ),
      bundle(
        join(root, 'packages/dsh-web-composition'),
        `
        import { AppWebEntry } from '@deepseek-ai/dsh-client-web';
        const dispose = AppWebEntry.prototype.dispose;
        const gate = Promise.withResolvers();
        window.releaseDispose = gate.resolve;
        AppWebEntry.prototype.dispose = async function () {
          document.body.dataset.dispose = 'waiting';
          const shouldFail = await gate.promise;
          await dispose.call(this);
          if (shouldFail) throw Error('Dispose outcome unknown');
        };
        await import('./src/employee-product-entry');
      `,
      ),
    ]);
    let transfer = deferred<ServerResponse>();
    let cancelled = deferred<void>();
    const graph = DEntryProfileGraphSchema.parse({
      rev: 'test-graph',
      release: { version: '0.2.1-rc.2' },
      entries: [{ id: 'held', url: 'plugins/??held', rev: 'held-entry' }],
      batches: [
        {
          phase: 'bootstrap',
          url: 'plugins/??held-batch',
          rev: 'held-batch',
          entries: ['held'],
        },
      ],
    });
    f.web.on('request', (request, response) => {
      const url = new URL(request.url!, f.origin);
      const send = (type: string, body: string) =>
        response.writeHead(200, { 'Content-Type': type }).end(body);
      if (url.pathname === '/outer.js')
        return send('application/javascript', outer);
      if (url.pathname === '/child.js')
        return send('application/javascript', child);
      if (url.pathname === '/api/v1/d-entry/identity')
        return send(
          'application/json',
          JSON.stringify({ identity: f.identity }),
        );
      if (url.pathname === '/chatflow/4.0/document') {
        const fields = {
          'scope-id': url.searchParams.get('scopeId'),
          'workspace-id': f.identity.workspaceId,
          'employee-instance-id': f.identity.employeeInstanceId,
          'organization-id': f.identity.organizationId,
          'viewer-id': f.identity.personId,
          'binding-ref': f.owner.bindingRef,
          'graph-rev': graph.rev,
        };
        const attributes = Object.entries(fields)
          .map(([key, value]) => `data-${key}="${value}"`)
          .join(' ');
        return send(
          'text/html',
          `<!doctype html><div id="app" ${attributes}></div><script type="module" src="/child.js"></script>`,
        );
      }
      if (url.pathname === '/api/v1/d-entry/profile/bootstrap')
        return send(
          'application/json',
          JSON.stringify({
            version: 1,
            scopeReference: { scopeId: url.searchParams.get('scopeId') },
            bindingRef: f.owner.bindingRef,
            graph,
            injections: [
              {
                kind: 'script-src',
                placement: 'head',
                src: graph.batches[0]!.url,
              },
            ],
          }),
        );
      if (url.pathname === '/api/v1/d-entry/profile/assets') {
        const close = cancelled;
        response.once('close', () => close.resolve());
        response.writeHead(200, { 'Content-Type': 'application/javascript' });
        response.write('window.nativeLateRegistration = ');
        transfer.resolve(response);
        return;
      }
      // The next URL is enough to detect navigation. A second VM and launch
      // are outside this test's close boundary.
      if (url.pathname === '/chatflow/4.0')
        return send('text/html', '<!doctype html><p>Next selection</p>');
      return send(
        'text/html',
        '<!doctype html><div id="root"></div><script type="module" src="/outer.js"></script>',
      );
    });
    const browser = await chromium.launch({
      executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE,
    });
    closes.push(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
      { name: 'allrice_session', value: sessionToken, url: f.origin },
    ]);
    const start = f.origin + '/old?' + new URLSearchParams(f.selection);
    for (const scenario of ['navigate', 'unknown', 'child-hides'] as const) {
      transfer = deferred<ServerResponse>();
      cancelled = deferred<void>();
      const page = await context.newPage();
      try {
        await page.goto(start);
        const blocked = await transfer.promise;
        expect(blocked.writableFinished).toBe(false);
        const frame = page
          .frames()
          .find((candidate) =>
            candidate.url().includes('/chatflow/4.0/document'),
          )!;
        const scopeId = new URL(frame.url()).searchParams.get('scopeId')!;
        expect((await f.invoke(scopeId)).status).toBe(200);
        const next = { ...f.selection, threadId: randomUUID() };
        await frame.evaluate(
          ({ scenario, scopeId, next }) => {
            if (scenario === 'child-hides')
              window.dispatchEvent(new Event('pagehide'));
            else
              parent.postMessage(
                { type: 'allrice:d-entry:navigate', scopeId, selection: next },
                location.origin,
              );
          },
          { scenario, scopeId, next },
        );
        await cancelled.promise;
        expect(blocked.destroyed).toBe(true);
        expect(blocked.writableFinished).toBe(false);
        await frame.locator('body[data-dispose=waiting]').waitFor();
        expect((await f.invoke(scopeId)).status).toBe(404);
        expect(page.url()).toBe(start);
        expect(
          await frame.evaluate(() =>
            Object.hasOwn(window, 'nativeLateRegistration'),
          ),
        ).toBe(false);
        await frame.evaluate(
          (fail) =>
            (
              window as unknown as { releaseDispose(fail: boolean): void }
            ).releaseDispose(fail),
          scenario === 'unknown',
        );
        if (scenario === 'navigate')
          await page.waitForURL('**/chatflow/4.0?**');
        else if (scenario === 'unknown') {
          await page.getByRole('alert').waitFor();
          expect(page.url()).toBe(start);
        }
      } finally {
        await page.close();
      }
    }
    await context.close();
  },
);
