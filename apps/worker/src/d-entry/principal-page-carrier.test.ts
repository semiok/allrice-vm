import { decodeDEntryRegisteredThread } from '@allrice/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { getEventListeners, on, once } from 'node:events';
import { get, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  createConnection,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from 'node:net';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DataAccessError } from '@allrice/database';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import Llm from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import {
  deferred,
  summary,
} from '../../../../packages/d-entry-principal/test/host-fixture.js';
import { PendingPublication } from './profile.js';
import { holdReleasedProfile } from './released-profile.js';
import {
  DEntryProfileBootstrapSchema,
  DEntryProfileGraphSchema,
  DEntrySelectionInputSchema,
} from '@allrice/contracts';
import {
  fixture,
  buildProfileFixture,
  closes,
  sessionToken,
  otherToken,
  send,
  messages,
  open,
  status,
  closePage,
  type ProfileProof,
} from './principal-page-carrier.fixture.js';

it('reads the sealed language default and persists a native language preference without opening platform settings', async () => {
  const f = await fixture();
  const { host } = f.host;
  const gateway = host.typertGateway;
  const dispatch = gateway.invoke.bind(gateway);
  let preference = 'zh';
  const writes = vi.fn();
  const languageView = () => ({
    ns: 'locale',
    value: { preference },
    revision: 2,
  });
  const settings = '@deepseek-ai/dsh-api-settings-controller';
  host.provide('llm', {
    listConfigurableProviders: () => [{ settingsNs: 'llm-pi-ai' }],
  } as never);
  const dispose = host.typert.register({
    package: settings,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: ['describe', 'mutate', 'openSettingsDocument'].map(
      (method) => ({
        id: `${settings}#settings/${method}`,
        namespace: 'settings',
        method,
        service: 'settingsController',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'test#NativeLocaleJson',
          create: () => z.json(),
          jsonSchema: {},
        },
      }),
    ),
  });
  const dispatchSpy = vi
    .spyOn(gateway, 'invoke')
    .mockImplementation(async (request) => {
      if (request.namespace !== 'settings') return dispatch(request);
      if (request.method === 'describe')
        return {
          writable: true,
          hasDocument: true,
          namespaces: [languageView(), { ns: 'llm-pi-ai' }],
        };
      writes(request.args);
      preference = 'en';
      return languageView();
    });
  try {
    const life = await open(f);
    const call = (endpoint: string, args: object, token = sessionToken) =>
      f.invoke(life.scopeId, token, { endpoint, payload: { args } });
    const describe = async () => {
      const response = await call('settings/describe', {});
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.result.ok, JSON.stringify(body.result)).toBe(true);
      return body;
    };
    expect(await describe()).toMatchObject({
      result: {
        ok: true,
        value: {
          hasDocument: false,
          namespaces: expect.arrayContaining([
            { ns: 'locale', value: { preference: 'zh' }, revision: 2 },
          ]),
        },
      },
    });
    expect((await call('settings/describe', {}, otherToken)).status).toBe(404);
    const ops = [{ op: 'set', path: ['preference'], value: 'en' }];
    const denied = await call('settings/mutate', {
      ns: 'llm-pi-ai',
      ops,
      expectedRevision: 2,
    });
    expect(await denied.json()).toMatchObject({ result: { ok: false } });
    const fullDocument = await call('settings/openSettingsDocument', {});
    expect(await fullDocument.json()).toMatchObject({ result: { ok: false } });
    expect(writes).not.toHaveBeenCalled();
    const second = await open(f);
    const eventPeer = f.connect(second.scopeId);
    const events = messages(eventPeer);
    await once(eventPeer, 'open');
    send(eventPeer, {
      type: 'open',
      streamId: 'locale-events',
      endpoint: '$events',
      payload: { args: {} },
    });
    expect(await events('locale-events')).toMatchObject({
      value: { type: 'ready' },
    });
    const changed = await call('settings/mutate', {
      ns: 'locale',
      ops,
      expectedRevision: 2,
    });
    expect(await changed.json()).toMatchObject({
      result: { ok: true, value: { ns: 'locale' } },
    });
    expect(writes).toHaveBeenCalledExactlyOnceWith({
      ns: 'locale',
      ops,
      expectedRevision: 2,
    });
    expect(await describe()).toMatchObject({
      result: {
        ok: true,
        value: {
          namespaces: expect.arrayContaining([
            { ns: 'locale', value: { preference: 'en' }, revision: 2 },
          ]),
        },
      },
    });
    f.host.emit({ event: 'settings/document-updated', args: ['locale', 3] });
    expect(await events('locale-events')).toMatchObject({
      value: {
        type: 'emit',
        event: 'settings/document-updated',
        args: ['locale', 3],
      },
    });
    closePage(life.peer);
    expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
    closePage(second.peer);
  } finally {
    dispatchSpy.mockRestore();
    dispose();
  }
});

it('qualifies a new 4.0 editor without writing on upgrade, then prepares its root once on explicit open', async () => {
  const f = await fixture(undefined, true);
  const peer = f.connect();
  await once(peer, 'open');
  expect(f.prepareEditorRoot).not.toHaveBeenCalled();
  const receive = messages(peer);
  send(peer, {
    type: 'open',
    streamId: 'life',
    endpoint: '$d-entry/page',
    payload: { args: {} },
  });
  expect(await receive()).toMatchObject({
    type: 'item',
    value: { type: 'opened' },
  });
  expect(f.prepareEditorRoot).toHaveBeenCalledOnce();
  closePage(peer);
  expect(await receive()).toMatchObject({
    type: 'item',
    value: { type: 'closed' },
  });
  expect(await receive()).toMatchObject({ type: 'end' });
  const next = await open(f);
  expect(f.prepareEditorRoot).toHaveBeenCalledOnce();
  closePage(next.peer);
  await next.receive();
  await next.receive();
});

it('replaces the bound root on the same page socket and only the target watch remains live', async () => {
  const f = await fixture();
  const target = randomUUID();
  const revoked = f.registerThread(target);
  const { peer, scopeId, receive } = await open(f);
  const requestId = randomUUID();
  expect((await f.proveSwitch(scopeId, target, requestId)).status).toBe(204);
  send(peer, {
    type: 'item',
    streamId: 'life',
    value: {
      type: 'switch',
      requestId,
      threadId: target,
    },
  });
  const switched = await receive('life');
  expect(switched).toMatchObject({
    type: 'item',
    value: {
      type: 'switched',
      requestId,
      threadId: target,
      nativeSessionId: 'root-' + target,
    },
  });
  const nextScope = switched.value.scopeId as string;
  expect(nextScope).not.toBe(scopeId);
  expect((await f.invokeThread(scopeId, f.selection.threadId)).status).toBe(
    404,
  );
  expect((await f.invokeThread(nextScope, target)).status).toBe(200);
  expect((await f.invokeThread(nextScope, f.selection.threadId)).status).toBe(
    404,
  );
  const targetClosed = once(peer, 'close');
  revoked.abort();
  expect(await receive('life')).toMatchObject({ type: 'error' });
  await targetClosed;
  expect((await f.invokeThread(nextScope, target)).status).toBe(404);
});

it('requires proof from the current browser login even while the original login remains active', async () => {
  const f = await fixture();
  const target = randomUUID();
  f.registerThread(target);
  const { peer, scopeId, receive } = await open(f);
  const requestId = randomUUID();
  expect(
    (await f.proveSwitch(scopeId, target, requestId, otherToken)).status,
  ).toBe(404);
  send(peer, {
    type: 'item',
    streamId: 'life',
    value: { type: 'switch', requestId, threadId: target },
  });
  expect(await receive('life')).toMatchObject({
    value: { type: 'switch-unavailable', requestId },
  });
  expect(f.owner.acquirePrincipal).toHaveBeenCalledOnce();
  expect((await f.invokeThread(scopeId, f.selection.threadId)).status).toBe(
    200,
  );
  closePage(peer);
  expect(await receive('life')).toMatchObject({
    value: { type: 'closed', scopeId },
  });
  expect(await receive('life')).toMatchObject({ type: 'end' });
});

it('drains an already dispatched native create through registration and response before rotating', async () => {
  const f = await fixture();
  const target = randomUUID();
  f.registerThread(target);
  const { peer, scopeId, receive, revoked } = await open(f);
  const registering = deferred();
  const release = deferred();
  const register = f.registerRoot.getMockImplementation()!;
  f.registerRoot.mockImplementation(
    async (context, identity, receipt, active) => {
      registering.resolve();
      await release.promise;
      active.throwIfAborted();
      return register(context, identity, receipt, active);
    },
  );
  const write = f.invoke(scopeId, sessionToken, {
    endpoint: 'session/create',
    payload: { args: { request: {} } },
  });
  await registering.promise;
  const requestId = randomUUID();
  try {
    expect((await f.proveSwitch(scopeId, target, requestId)).status).toBe(204);
    send(peer, {
      type: 'item',
      streamId: 'life',
      value: { type: 'switch', requestId, threadId: target },
    });
    await vi.waitFor(() => expect(f.pageSignals.size).toBe(2));
    expect(revoked.aborted).toBe(false);
  } finally {
    release.resolve();
  }
  const response = await write;
  expect(response.status).toBe(200);
  expect(
    decodeDEntryRegisteredThread(
      response.headers.get('x-allrice-d-entry-thread'),
    )?.id,
  ).toBeDefined();
  expect(await receive('life')).toMatchObject({
    value: { type: 'switched', requestId },
  });
  expect(revoked.aborted).toBe(true);
  closePage(peer);
  expect(await receive('life')).toMatchObject({ value: { type: 'closed' } });
  expect(await receive('life')).toMatchObject({ type: 'end' });
});

it('joins a cancelled target lookup and the old page on close during a handoff', async () => {
  const f = await fixture();
  const target = randomUUID();
  f.registerThread(target);
  const { peer, scopeId, receive, revoked } = await open(f);
  const requestId = randomUUID();
  expect((await f.proveSwitch(scopeId, target, requestId)).status).toBe(204);
  const entered = deferred();
  const allow = deferred();
  f.authenticate.mockImplementationOnce(async () => {
    entered.resolve();
    await allow.promise;
    return f.context;
  });
  send(peer, {
    type: 'item',
    streamId: 'life',
    value: { type: 'switch', requestId, threadId: target },
  });
  await entered.promise;
  const fenced = once(revoked, 'abort');
  closePage(peer);
  await fenced;
  allow.resolve();
  expect(await receive('life')).toMatchObject({
    value: { type: 'closed', scopeId },
  });
  expect(await receive('life')).toMatchObject({ type: 'end' });
  expect(f.owner.acquirePrincipal).toHaveBeenCalledTimes(1);
});

it('joins a staged native scope and acknowledges the old page on close before publication', async () => {
  const f = await fixture();
  const target = randomUUID();
  f.registerThread(target);
  const { peer, scopeId, receive, revoked } = await open(f);
  const requestId = randomUUID();
  expect((await f.proveSwitch(scopeId, target, requestId)).status).toBe(204);
  const entered = deferred();
  const allow = deferred();
  f.authenticate.mockImplementation(async () => {
    if (f.pageSignals.size === 2) {
      entered.resolve();
      await allow.promise;
    }
    return f.context;
  });
  send(peer, {
    type: 'item',
    streamId: 'life',
    value: { type: 'switch', requestId, threadId: target },
  });
  await entered.promise;
  const fenced = once(revoked, 'abort');
  closePage(peer);
  await fenced;
  allow.resolve();
  expect(await receive('life')).toMatchObject({
    value: { type: 'closed', scopeId },
  });
  expect(await receive('life')).toMatchObject({ type: 'end' });
  expect(f.owner.acquirePrincipal).toHaveBeenCalledTimes(2);
  expect([...f.pageSignals.values()].every((signal) => signal.aborted)).toBe(
    true,
  );
});

it.each(['employee', 'login', 'tenant', 'epoch'] as const)(
  'refuses native reuse when the %s changes and leaves the exact old scope joinable',
  async (change) => {
    const f = await fixture();
    const target = randomUUID();
    f.registerThread(target);
    const { peer, scopeId, receive } = await open(f);
    const requestId = randomUUID();
    expect((await f.proveSwitch(scopeId, target, requestId)).status).toBe(204);
    if (change === 'employee')
      f.historyIdentity.mockResolvedValueOnce({
        ...f.identity,
        threadId: target,
        employeeInstanceId: randomUUID(),
      });
    if (change === 'login')
      f.authenticate.mockResolvedValueOnce({
        ...f.context,
        sessionId: randomUUID(),
      });
    if (change === 'tenant')
      f.historyIdentity.mockResolvedValueOnce({
        ...f.identity,
        threadId: target,
        organizationId: randomUUID(),
      });
    if (change === 'epoch')
      f.deps.owners.resolve.mockResolvedValueOnce({
        ...f.owner,
        receipt: {
          ...f.owner.receipt,
          binding: { ...f.binding, leaseEpoch: 2 },
        },
      });
    send(peer, {
      type: 'item',
      streamId: 'life',
      value: {
        type: 'switch',
        requestId,
        threadId: target,
      },
    });
    expect(await receive('life')).toMatchObject({
      type: 'item',
      value: {
        type: 'switch-unavailable',
        requestId,
      },
    });
    expect(f.owner.acquirePrincipal).toHaveBeenCalledTimes(1);
    expect((await f.invokeThread(scopeId, f.selection.threadId)).status).toBe(
      200,
    );
    closePage(peer);
    expect(await receive('life')).toMatchObject({
      value: { type: 'closed', scopeId },
    });
    expect(await receive('life')).toMatchObject({ type: 'end' });
  },
);

it('joins shared resource guards before releasing the page admission', async () => {
  const f = await fixture();
  const life = await open(f);
  const entered = deferred();
  const release = deferred();
  f.authenticate.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return f.context;
  });
  send(life.peer, {
    type: 'open',
    streamId: 'resource',
    endpoint: '$events',
    payload: { args: {} },
  });
  try {
    await entered.promise;
    closePage(life.peer);
    await expect
      .poll(() => f.pageSignals.get(life.scopeId)?.aborted)
      .toBe(true);
    expect(f.data.admission.boundary.finish).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  expect(await life.receive('life')).toMatchObject({
    type: 'item',
    value: { type: 'closed' },
  });
  expect(await life.receive('life')).toMatchObject({ type: 'end' });
  expect(f.data.admission.boundary.finish).toHaveBeenCalledOnce();
});

function observeProfileRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  url: URL,
) {
  const ready = deferred<ServerResponse>();
  const observe = (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'GET' || request.url !== url.pathname + url.search)
      return;
    f.worker.off('request', observe);
    ready.resolve(response);
  };
  f.worker.prependListener('request', observe);
  closes.push(async () => f.worker.off('request', observe));
  return ready.promise;
}

function startDocumentProfileRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  scopeId: string,
  active?: AbortSignal,
) {
  const arrival = observeProfileRequest(f, f.profileUrl('bootstrap', scopeId));
  const response = f.publish('bootstrap', scopeId, {}, 'document', active);
  return {
    response,
    completion: arrival.then(f.profileCompletion),
    settlement: response.then(
      (received) => ({ received }),
      (error: unknown) => ({ error }),
    ),
  };
}

function waitForProfilePhase<T>(
  phase: string,
  reached: Promise<T>,
  ...requests: ReturnType<typeof startDocumentProfileRequest>[]
) {
  return Promise.race([
    reached,
    ...requests.map(({ settlement }) =>
      settlement.then((result) => {
        if ('error' in result) throw result.error;
        throw Error(
          `Profile returned HTTP ${result.received.status} before ${phase}`,
        );
      }),
    ),
  ]);
}

// These loopback responses use either a fixed body length or Node's chunked
// encoding. The TCP packets can split any of those framing boundaries.
function observeProfileWire(source: Readable) {
  const chunks = on(source, 'data', { close: ['end', 'close'] });
  let pending = Buffer.alloc(0);

  async function receive(boundary: string) {
    const next = await chunks.next();
    if (next.done) throw Error(`Profile socket closed before ${boundary}`);
    pending = Buffer.concat([pending, next.value[0] as Buffer]);
  }
  function take(length: number) {
    const value = pending.subarray(0, length);
    pending = pending.subarray(length);
    return value;
  }
  async function bytes(length: number, boundary: string) {
    while (pending.length < length) await receive(boundary);
    return take(length);
  }
  async function through(delimiter: string, boundary: string) {
    let end = pending.indexOf(delimiter);
    while (end === -1) {
      await receive(boundary);
      end = pending.indexOf(delimiter);
    }
    return take(end + delimiter.length).subarray(0, end);
  }
  async function head(status: 200 | 404) {
    const [line, ...fields] = (
      await through('\r\n\r\n', 'complete response headers')
    )
      .toString('latin1')
      .split('\r\n');
    expect(line).toBe(
      status === 200 ? 'HTTP/1.1 200 OK' : 'HTTP/1.1 404 Not Found',
    );
    const headers = new Headers();
    for (const field of fields) {
      const colon = field.indexOf(':');
      expect(colon).toBeGreaterThan(0);
      headers.append(field.slice(0, colon), field.slice(colon + 1));
    }
    return headers;
  }
  async function chunk() {
    const size = (await through('\r\n', 'HTTP chunk size')).toString('ascii');
    expect(size).toMatch(/^[0-9a-f]+$/i);
    const length = Number.parseInt(size, 16);
    expect(Number.isSafeInteger(length)).toBe(true);
    const data = await bytes(length, 'HTTP chunk bytes');
    expect((await bytes(2, 'HTTP chunk boundary')).toString()).toBe('\r\n');
    return length ? data : null;
  }
  async function body(headers: Headers) {
    if (headers.get('transfer-encoding') === 'chunked') {
      expect(headers.has('content-length')).toBe(false);
      const parts: Buffer[] = [];
      for (let part = await chunk(); part; part = await chunk())
        parts.push(part);
      return Buffer.concat(parts);
    }
    const length = headers.get('content-length');
    expect(length).toMatch(/^\d+$/);
    expect(Number.isSafeInteger(Number(length))).toBe(true);
    return bytes(Number(length), 'fixed-length response body');
  }
  async function expectEnd() {
    let trailing = pending.length;
    for await (const [data] of chunks) trailing += (data as Buffer).length;
    expect(source.readableEnded).toBe(true);
    if (trailing)
      throw Error(`Profile socket delivered ${trailing} trailing bytes`);
  }
  return { head, chunk, body, expectEnd, dispose: () => chunks.return?.() };
}

it('parses split and coalesced profile responses through a clean end', async () => {
  const packets = [
    'HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r',
    '\n5\r\nhe',
    'llo\r\n0\r\n\r\nHTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nwo',
    'rldHTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n',
  ].map((part) => Buffer.from(part));
  const input = Readable.from(packets);
  const wire = observeProfileWire(input);
  const received: Buffer[] = [];
  input.on('data', (data: Buffer) => received.push(data));
  const chunked = await wire.head(200);
  expect((await wire.body(chunked)).toString()).toBe('hello');
  const fixed = await wire.head(200);
  expect((await wire.body(fixed)).toString()).toBe('world');
  const last = await wire.head(404);
  expect(last.get('connection')).toBe('close');
  expect(await wire.body(last)).toHaveLength(0);
  await wire.expectEnd();
  expect(received).toEqual(packets);
});

it('sees buffered and later bytes after a zero-length final response', async () => {
  const wire = observeProfileWire(
    Readable.from([
      Buffer.from('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\na'),
      Buffer.from('b'),
    ]),
  );
  expect(await wire.body(await wire.head(404))).toHaveLength(0);
  await expect(wire.expectEnd()).rejects.toThrow(
    'Profile socket delivered 2 trailing bytes',
  );
});

it.each(['EOF', 'socket error'] as const)(
  'settles the actual profile wire on %s before a full header',
  async (terminal) => {
    const accepted = deferred<Socket>();
    const server = createTcpServer(accepted.resolve).listen(0, '127.0.0.1');
    await once(server, 'listening');
    closes.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const client = createConnection({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
    });
    const wire = observeProfileWire(client);
    const closed = new Promise<void>((resolve) => {
      client.once('close', () => resolve());
    });
    closes.push(async () => {
      client.destroy();
      await closed;
      await wire.dispose();
    });
    await once(client, 'connect');
    const peer = await accepted.promise;
    closes.push(async () => peer.destroy());
    let delivered = false;
    const ready = wire.head(200).then(() => {
      delivered = true;
    });
    const expectedError = Error('Independent socket failure');
    const rejected =
      terminal === 'EOF'
        ? expect(ready).rejects.toThrow(
            'Profile socket closed before complete response headers',
          )
        : expect(ready).rejects.toBe(expectedError);
    const observed = once(client, 'data');
    peer.write('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n');
    await observed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delivered).toBe(false);
    if (terminal === 'EOF') peer.end();
    else client.destroy(expectedError);
    await rejected;
    await closed;
    expect(getEventListeners(client, 'data')).toHaveLength(0);
  },
);

function holdSocket(response: ServerResponse) {
  const socket = response.socket!;
  const close = socket.destroy.bind(socket);
  const fenced = deferred();
  const release = deferred();
  const hold = vi.spyOn(socket, 'destroy').mockImplementation((error) => {
    fenced.resolve();
    void release.promise.then(() => close(error));
    return socket;
  });
  closes.push(async () => {
    hold.mockRestore();
    release.resolve();
  });
  return { fenced: fenced.promise, release, closed: once(socket, 'close') };
}

const rpcPath = '/internal/d-entry/native-rpc?carrier=page';

function writePageRpc(client: Socket, body: string, connection = 'keep-alive') {
  client.write(
    `POST ${rpcPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nauthorization: Bearer ${sessionToken}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: ${connection}\r\n\r\n${body}`,
  );
}

it(
  'writes only an empty denial for a revoked queued RPC and keeps its HTTP neighbors',
  { timeout: 30_000 },
  async () => {
    const f = await fixture();
    const page = await open(f);
    const neighbor = await open(f);
    const waiting = deferred<ServerResponse>();
    const headArrived = deferred<ServerResponse>();
    let watched = false;
    const observe = (request: IncomingMessage, response: ServerResponse) => {
      if (request.url === '/fixture-before-profile')
        headArrived.resolve(response);
      if (request.url !== rpcPath || watched) return;
      watched = true;
      const writeHead = response.writeHead;
      const early = vi
        .spyOn(response, 'writeHead')
        .mockImplementation((...args: Parameters<typeof writeHead>) => {
          waiting.reject(
            Error('Queued RPC wrote before it owned the response'),
          );
          return Reflect.apply(writeHead, response, args) as ServerResponse;
        });
      function listen(event: string | symbol) {
        if (event !== 'socket') return;
        response.off('newListener', listen);
        early.mockRestore();
        waiting.resolve(response);
      }
      response.on('newListener', listen);
    };
    f.worker.prependListener('request', observe);
    closes.push(async () => f.worker.off('request', observe));
    const { address, port } = f.worker.address() as AddressInfo;
    const client = createConnection({ host: address, port });
    const closed = once(client, 'close');
    void closed.catch(() => {});
    const wire = observeProfileWire(client);
    closes.push(async () => {
      client.destroy();
      await closed.catch(() => {});
      await wire.dispose();
    });
    await once(client, 'connect');
    client.write(
      'GET /fixture-before-profile HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n',
    );
    const firstHeaders = await wire.head(200);
    const head = await headArrived.promise;

    writePageRpc(client, f.rpcBody(page.scopeId, { rpcId: 'revoked-rpc' }));
    const queued = await waiting.promise;
    expect(queued.socket).toBeNull();
    expect(queued.headersSent).toBe(false);
    expect(f.host.catalog.pages).toHaveLength(1);
    const terminal = page.receive();
    closePage(page.peer);
    expect(await terminal).toMatchObject({ value: { type: 'closed' } });
    expect(await page.receive()).toEqual({ type: 'end', streamId: 'life' });
    expect(queued.writableFinished).toBe(false);
    expect(head.writableEnded).toBe(false);
    expect(client.destroyed).toBe(false);

    writePageRpc(
      client,
      f.rpcBody(neighbor.scopeId, { rpcId: 'neighbor-rpc' }),
      'close',
    );
    head.end(' finished');
    expect((await wire.body(firstHeaders)).toString()).toBe(
      'unrelated handler still running finished',
    );
    const refused = await wire.head(404);
    expect(refused.get('content-length')).toBe('0');
    expect(await wire.body(refused)).toHaveLength(0);
    expect(
      JSON.parse((await wire.body(await wire.head(200))).toString()),
    ).toEqual({
      type: 'server-response',
      rpcId: 'neighbor-rpc',
      result: { ok: true, value: { records: [], hasMore: false } },
    });
    await wire.expectEnd();
    await closed;
    expect((await f.invoke(neighbor.scopeId)).status).toBe(200);
  },
);

it.each(['full reply', 'peer disconnect'] as const)(
  'joins the committed RPC on %s after fencing the page on a shared HTTP socket',
  { timeout: 30_000 },
  async (outcome) => {
    const f = await fixture();
    const page = await open(f);
    const neighbor = await open(f);
    const data = 'synthetic private response'.repeat(400_000);
    const records = [
      {
        type: 'event',
        event: {
          type: 'fixture-response-bytes',
          seq: 1,
          time: 1,
          data,
          ignorable: true,
        },
      },
    ] as const;
    f.host.catalog.pageRecords = records;

    const submitted = deferred<ServerResponse>();
    const successorWaiting = deferred<ServerResponse>();
    const successorChecking = deferred();
    const allowSuccessor = deferred();
    let serverSocket: Socket | undefined;
    let firstFinished = false;
    const observe = (request: IncomingMessage, response: ServerResponse) => {
      if (request.url !== rpcPath) return;
      if (serverSocket) {
        if (request.socket !== serverSocket) return;
        f.worker.off('request', observe);
        if (outcome === 'full reply') {
          response.once('socket', () => {
            vi.mocked(f.owner.assertCurrent).mockImplementationOnce(
              async () => {
                successorChecking.resolve();
                await allowSuccessor.promise;
              },
            );
          });
        }
        function queued(event: string | symbol) {
          if (event !== 'socket') return;
          response.off('newListener', queued);
          successorWaiting.resolve(response);
        }
        response.on('newListener', queued);
        return;
      }
      serverSocket = request.socket;
      response.once('finish', () => {
        firstFinished = true;
      });
      const end = response.end;
      const wrapped = vi
        .spyOn(response, 'end')
        .mockImplementation((...args: Parameters<typeof end>) => {
          wrapped.mockRestore();
          const result = Reflect.apply(end, response, args) as ServerResponse;
          submitted.resolve(response);
          return result;
        });
    };
    f.worker.prependListener('request', observe);
    closes.push(async () => f.worker.off('request', observe));
    const { address, port } = f.worker.address() as AddressInfo;
    const client = createConnection({ host: address, port });
    const closed = once(client, 'close');
    void closed.catch(() => {});
    const wire = observeProfileWire(client);
    // The peer can pipeline its second request, but it cannot consume the first.
    client.pause();
    closes.push(async () => {
      client.destroy();
      await closed.catch(() => {});
      await wire.dispose();
    });
    closes.push(async () => allowSuccessor.resolve());
    function beforeDisconnect<T>(work: Promise<T>) {
      return Promise.race([
        work,
        closed.then(() => {
          throw Error('RPC socket ended before the expected response phase');
        }),
      ]);
    }
    await once(client, 'connect');
    writePageRpc(
      client,
      f.rpcBody(page.scopeId, { rpcId: 'backpressured-rpc' }),
    );
    const response = await beforeDisconnect(submitted.promise);
    const socket = serverSocket!;
    expect(response.statusCode).toBe(200);
    expect(response.socket).toBe(socket);
    expect(response.writableEnded).toBe(true);
    expect(firstFinished).toBe(false);
    expect(socket.writableLength).toBeGreaterThan(0);
    const destroy = vi.spyOn(socket, 'destroy');
    let physicallyClosed = false;
    const serverClosed = new Promise<void>((resolve) =>
      socket.once('close', () => {
        physicallyClosed = true;
        resolve();
      }),
    );

    f.host.catalog.pageRecords = [];
    writePageRpc(
      client,
      f.rpcBody(neighbor.scopeId, { rpcId: 'neighbor-after-commit' }),
      'close',
    );
    const successor = await beforeDisconnect(successorWaiting.promise);
    expect(successor.socket).toBeNull();
    expect(successor.headersSent).toBe(false);

    let delivered = false;
    const terminal = page.receive().then((frame) => {
      delivered = true;
      if (outcome === 'peer disconnect') expect(physicallyClosed).toBe(true);
      else expect(firstFinished).toBe(true);
      return frame;
    });
    void terminal.catch(() => {});
    const fenced = once(page.revoked, 'abort');
    closePage(page.peer);
    await Promise.race([fenced, terminal]);
    expect(page.revoked.aborted).toBe(true);
    expect((await f.invoke(page.scopeId)).status).toBe(404);
    expect(delivered).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    expect(firstFinished).toBe(false);
    expect(physicallyClosed).toBe(false);
    expect(successor.headersSent).toBe(false);

    if (outcome === 'peer disconnect') {
      client.resetAndDestroy();
      await serverClosed;
      expect(await terminal).toMatchObject({
        value: { type: 'closed', scopeId: page.scopeId },
      });
      expect(await page.receive()).toEqual({ type: 'end', streamId: 'life' });
      expect((await f.invoke(neighbor.scopeId)).status).toBe(200);
      return;
    }

    try {
      client.resume();
      const first = await wire.head(200);
      expect(JSON.parse((await wire.body(first)).toString())).toEqual({
        type: 'server-response',
        rpcId: 'backpressured-rpc',
        result: { ok: true, value: { records, hasMore: false } },
      });
      await beforeDisconnect(successorChecking.promise);
      expect(await terminal).toMatchObject({
        value: { type: 'closed', scopeId: page.scopeId },
      });
      expect(await page.receive()).toEqual({ type: 'end', streamId: 'life' });
      expect(firstFinished).toBe(true);
      expect(physicallyClosed).toBe(false);
      expect(successor.socket).toBe(socket);
      expect(successor.headersSent).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      allowSuccessor.resolve();
    }
    const last = await wire.head(200);
    expect(last.get('connection')).toBe('close');
    expect(JSON.parse((await wire.body(last)).toString())).toEqual({
      type: 'server-response',
      rpcId: 'neighbor-after-commit',
      result: { ok: true, value: { records: [], hasMore: false } },
    });
    await wire.expectEnd();
    await closed;
    await serverClosed;
    expect((await f.invoke(neighbor.scopeId)).status).toBe(200);
  },
);

it.each(['baseline', 'upsert', 'remove'] as const)(
  'rechecks page authority before sending the native %s and keeps its sibling page',
  { timeout: 30_000 },
  async (type) => {
    const f = await fixture();
    const child = summary('child', 'root');
    const namesChild = (frame: unknown) =>
      JSON.stringify(frame)?.includes('"id":"child"');
    if (type === 'upsert')
      f.host.catalog.items = f.host.catalog.items.filter(
        (row) => row.sessionId !== child.sessionId,
      );
    const life = await open(f);
    const sibling = await open(f);
    const peer = f.connect(life.scopeId);
    await once(peer, 'open');
    const receive = messages(peer);
    const checkEntered = deferred();
    const releaseCheck = deferred();
    closes.push(async () => releaseCheck.resolve());
    let held = false;
    let observed: unknown;
    const wire = f.host.host.typertGateway.wireStream;
    const openNative = wire.open.bind(wire);
    vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
      const source = await openNative(...args);
      if (args[0] !== 'remoteAccess/follow') return source;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const item of source) {
            if (
              !held &&
              item &&
              typeof item === 'object' &&
              'type' in item &&
              item.type === type &&
              namesChild(item)
            ) {
              held = true;
              observed = item;
              vi.mocked(f.owner.assertCurrent).mockImplementationOnce(
                async () => {
                  checkEntered.resolve();
                  await releaseCheck.promise;
                },
              );
            }
            yield item;
          }
        },
      };
    });
    send(peer, {
      type: 'open',
      streamId: 'access',
      endpoint: 'remoteAccess/follow',
      payload: { args: {} },
    });
    if (type !== 'baseline') {
      const baseline = await receive('access');
      expect(baseline).toMatchObject({
        type: 'item',
        value: { type: 'baseline', owner: false },
      });
      if (type === 'upsert') {
        expect(JSON.stringify(baseline)).not.toContain('"id":"child"');
        f.host.catalog.items.push(child);
        f.host.host.emit('api-session/added', child);
      } else {
        expect(JSON.stringify(baseline)).toContain('"id":"child"');
        f.host.catalog.items = f.host.catalog.items.filter(
          (row) => row.sessionId !== child.sessionId,
        );
        f.host.host.emit('api-session/removed', child.sessionId);
      }
    }

    let delivered = false;
    const next = (async () => {
      while (true) {
        const frame = await receive('access');
        if (frame.type !== 'item' || namesChild(frame.value)) {
          delivered = true;
          return frame;
        }
      }
    })();
    try {
      await Promise.race([
        checkEntered.promise,
        next.then(() => {
          throw Error('Mux sent its frame before checking page authority');
        }),
      ]);
      expect(observed).toMatchObject({ type });
      expect(namesChild(observed)).toBe(true);
      expect(delivered).toBe(false);
    } finally {
      releaseCheck.resolve();
    }
    expect(await next).toMatchObject({ type: 'item', value: observed });
    expect((await f.invoke(life.scopeId)).status).toBe(200);
    expect((await f.invoke(sibling.scopeId)).status).toBe(200);
  },
);

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

it('opens the native control baseline and lists every Session in the current VM', async () => {
  const f = await fixture();
  const life = await open(f);
  const peer = f.connect(life.scopeId);
  const next = messages(peer);
  await once(peer, 'open');
  send(peer, {
    type: 'open',
    streamId: 'control',
    endpoint: 'session/control',
    payload: { args: {} },
  });
  expect(await next('control')).toEqual({
    type: 'item',
    streamId: 'control',
    value: {
      type: 'baseline',
      value: {
        projections: {
          root: { asOfSeq: 0, values: {} },
          child: { asOfSeq: 0, values: {} },
          other: { asOfSeq: 0, values: {} },
        },
      },
    },
  });
  const request = {
    endpoint: 'session/list',
    payload: { args: { _request: {} } },
  };
  const response = await f.invoke(life.scopeId, sessionToken, request);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    type: 'server-response',
    rpcId: '',
    result: {
      ok: true,
      value: {
        items: [summary('root'), summary('child', 'root'), summary('other')],
      },
    },
  });
  expect((await f.invoke(life.scopeId, otherToken, request)).status).toBe(404);
  expect(
    (
      await f.invoke(life.scopeId, sessionToken, {
        ...request,
        payload: { args: { _request: {}, scopeId: 'foreign-page' } },
      })
    ).status,
  ).toBe(200);
  closePage(life.peer);
  expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
});

it('delivers native page notifications on their declared resources and suppresses a revoked result', async () => {
  const f = await fixture();
  await f.host.useNativeEvents();
  const life = await open(f);
  const peer = f.connect(life.scopeId);
  const next = messages(peer);
  const delivered: unknown[] = [];
  peer.on('message', (data) => {
    const frame = JSON.parse(String(data));
    if (frame.streamId === 'events' && frame.value?.type === 'emit')
      delivered.push(frame.value);
  });
  await once(peer, 'open');
  send(peer, {
    type: 'open',
    streamId: 'events',
    endpoint: '$events',
    payload: { args: {} },
  });
  expect(await next('events')).toMatchObject({ value: { type: 'ready' } });

  const { host, catalog } = f.host;
  const other = summary('other').sessionId;
  host.emit('credentials/reference-updated', 'SYNTHETIC_REFERENCE' as never);
  host.emit('api-session/status', summary('absent').sessionId, true);
  host.emit('commands/change');
  host.emit('api-session/status', other, true);
  const notifications: { type: string; event: string; args: unknown[] }[] = [
    { type: 'emit', event: 'commands/change', args: [] },
    { type: 'emit', event: 'api-session/status', args: [other, true] },
  ];
  for (const value of notifications)
    expect(await next('events')).toMatchObject({ type: 'item', value });

  const releaseCatalog = deferred();
  closes.push(async () => releaseCatalog.resolve());
  catalog.beforeList = () => releaseCatalog.promise;
  const added = summary('new-live-session');
  try {
    host.emit('api-session/added', added);
    const addedFrame = {
      type: 'emit',
      event: 'api-session/added',
      args: [added],
    };
    expect(await next('events')).toMatchObject({
      type: 'item',
      value: addedFrame,
    });
    notifications.push(addedFrame);
    host.emit('api-session/removed', added.sessionId);
    const removedFrame = {
      type: 'emit',
      event: 'api-session/removed',
      args: [added.sessionId],
    };
    expect(await next('events')).toMatchObject({
      type: 'item',
      value: removedFrame,
    });
    notifications.push(removedFrame);
  } finally {
    releaseCatalog.resolve();
  }

  const checked = deferred();
  vi.mocked(f.owner.assertCurrent).mockImplementation(async () => {
    checked.resolve();
    throw new DataAccessError('authorization_denied');
  });
  const closed = once(peer, 'close');
  host.emit('commands/change');
  await checked.promise;
  await closed;
  expect(delivered).toEqual(notifications);
});

it('relays a native Cordis inspect query and its ordinary scoped RPC reply', async () => {
  const f = await fixture();
  const { host } = f.host;
  await f.host.useNativeEvents();
  const composition = createRequire(
    new URL(
      '../../../../packages/dsh-web-composition/package.json',
      import.meta.url,
    ),
  );
  const runtime = createRequire(
    composition.resolve('@deepseek-ai/dsh/package.json'),
  );
  const moduleName = '@deepseek-ai/dsh-cordis-host-runner';
  const { default: CordisRunner, CordisInspectRegistryService } = await import(
    pathToFileURL(runtime.resolve(moduleName)).href
  );
  const { TYPERT } = await import(
    pathToFileURL(runtime.resolve(`${moduleName}/typert`)).href
  );
  await host.plugin(SystemPrompt);
  await host.plugin(ToolRuntime);
  await host.plugin(CordisRunner);
  host.typert.register(TYPERT);
  const agentId = summary('other').sessionId;
  const agent = { id: agentId, ctx: host };
  host.typert.lookups.register('agent', {
    parameter: 'agent',
    wire: 'agentId',
    resource: 'session',
    hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
    wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    resolve: (id) => (id === agentId ? (agent as never) : undefined),
  });
  host.typert.contexts.registerHost('agent', {
    wire: 'agentId',
    resource: 'session',
    wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    resolve: (id) => (id === agentId ? agent.ctx : undefined),
  });
  const life = await open(f);
  const peer = f.connect(life.scopeId);
  await once(peer, 'open');
  const next = messages(peer);
  send(peer, {
    type: 'open',
    streamId: 'events',
    endpoint: '$events',
    payload: { args: {} },
  });
  expect(await next('events')).toMatchObject({ value: { type: 'ready' } });
  expect(host.typertGateway.hasLiveClient()).toBe(false);

  // rc.2 sources inspect queries only when an independent owner client is
  // present. The page enters through its existing non-owner carrier below.
  const companion = host.connection.createPeer({
    principal: { kind: 'owner' },
    interactions: 'answer',
  });
  const abort = new AbortController();
  const ownerEvents = await host.typertGateway.wireStream.open(
    '$events',
    { args: {} },
    { async *[Symbol.asyncIterator]() {} },
    companion,
    abort.signal,
  );
  const owner = ownerEvents[Symbol.asyncIterator]();
  closes.push(async () => {
    abort.abort();
    await owner.return?.();
    await companion.dispose();
  });
  expect(await owner.next()).toMatchObject({ value: { type: 'ready' } });
  const invoke = async (method: string, args: Record<string, unknown>) =>
    (
      await f.invoke(life.scopeId, sessionToken, {
        endpoint: 'dynamicCordisRunner/' + method,
        payload: { args },
      })
    ).json();
  const provider = 'fixture-inspector';
  const method = 'read';
  expect(
    await invoke('syncInspectManifest', {
      providers: [
        {
          id: provider,
          description: 'Read a synthetic fixture value.',
          methods: [
            {
              name: method,
              description: 'Read a label.',
              inputSchema: { type: 'object', additionalProperties: false },
              outputSchema: { type: 'string' },
            },
          ],
        },
      ],
    }),
  ).toMatchObject({ result: { ok: true, value: null } });
  const inspector = host.get('cordisInspect') as
    InstanceType<typeof CordisInspectRegistryService> | undefined;
  if (!(inspector instanceof CordisInspectRegistryService))
    throw Error('Native Cordis inspect service unavailable');
  const query = inspector.query(
    'client',
    provider,
    method,
    undefined,
    agent,
    abort.signal,
  );
  void query.catch(() => {});
  const notification = await next('events');
  expect(notification.value).toMatchObject({
    type: 'emit',
    event: 'cordis/inspect-query',
    args: [{ requestId: expect.any(String), agentId, provider, method }],
  });
  const { requestId } = notification.value.args[0];
  expect(
    await invoke('resolveInspectQuery', {
      agentId,
      requestId,
      resolution: { ok: true, data: 'fixture-label' },
    }),
  ).toMatchObject({ result: { ok: true, value: { accepted: true } } });
  await expect(query).resolves.toBe('fixture-label');
  expect(await next('events')).toMatchObject({
    value: {
      type: 'emit',
      event: 'cordis/inspect-query-resolved',
      args: [{ requestId }],
    },
  });
  expect(
    await invoke('resolveRequestRun', {
      requestId: 'synthetic-activation',
      resolution: {
        ok: false,
        reason: 'rejected',
        message: 'Synthetic decision',
      },
    }),
  ).toMatchObject({
    result: { ok: false, error: { details: { reason: 'plugin-management' } } },
  });
  closePage(life.peer);
  expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
});

it('searches another Session using the native descriptor and preserves native argument failures', async () => {
  const f = await fixture();
  const life = await open(f);
  const request = {
    endpoint: 'session/search',
    payload: { args: { request: { query: 'other' } } },
  };
  expect(
    await (await f.invoke(life.scopeId, sessionToken, request)).json(),
  ).toMatchObject({
    result: {
      ok: true,
      value: { items: [{ sessionId: 'other', snippet: 'matching session' }] },
    },
  });
  expect(
    await (
      await f.invoke(life.scopeId, sessionToken, {
        ...request,
        payload: { args: { request: { query: 0 } } },
      })
    ).json(),
  ).toMatchObject({
    result: { ok: false, error: { code: 'gateway/input-invalid' } },
  });
  closePage(life.peer);
  expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
});

it('updates ordinary settings and selects an authorized session model through the page carrier', async () => {
  const f = await fixture();
  const { host } = f.host;
  const composition = createRequire(
    new URL(
      '../../../../packages/dsh-web-composition/package.json',
      import.meta.url,
    ),
  );
  const runtime = createRequire(
    composition.resolve('@deepseek-ai/dsh/package.json'),
  );
  const moduleName = '@deepseek-ai/dsh-api-settings-controller';
  const { SettingsController } = await import(
    pathToFileURL(runtime.resolve(moduleName)).href
  );
  const { TYPERT } = await import(
    pathToFileURL(runtime.resolve(`${moduleName}/typert`)).href
  );
  let setting = { theme: 'light' };
  const update = vi.fn(async (_namespace: string, patch: typeof setting) => {
    setting = patch;
  });
  host.provide('settings', {
    update,
    describe: () => [
      {
        ns: 'appearance',
        schema: {},
        value: setting,
        autoGenerate: false,
        applies: 'live',
        secrets: [],
        revision: 1,
      },
    ],
  } as never);
  await host.plugin(Llm);
  await host.plugin(SettingsController);
  host.typert.register(TYPERT);
  const life = await open(f);
  const request = async (endpoint: string, args: Record<string, unknown>) =>
    (
      await f.invoke(life.scopeId, sessionToken, {
        endpoint,
        payload: { args },
      })
    ).json();
  const patch = { theme: 'dark' };
  expect(
    await request('settings/update', { ns: 'appearance', patch }),
  ).toMatchObject({
    result: { ok: true, value: { ns: 'appearance', value: patch } },
  });
  expect(update).toHaveBeenCalledWith('appearance', patch, undefined);
  const selected = { provider: 'openai-codex', model: 'fixture-codex' };
  expect(
    await request('session/selectModel', {
      request: { sessionId: 'other', ...selected },
    }),
  ).toMatchObject({
    result: { ok: true, value: { selected } },
  });
  closePage(life.peer);
  expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
});

it('uses actual DSH replies for create and fork registration on a page without a pinned root', async () => {
  const f = await fixture(undefined, false, true);
  const life = await open(f);
  const create = await f.invoke(life.scopeId, sessionToken, {
    endpoint: 'session/create',
    payload: { args: { request: { sessionId: 'browser-forged-id' } } },
  });
  expect(await create.json()).toMatchObject({
    result: { ok: true, value: { sessionId: 'native-created' } },
  });
  expect(
    decodeDEntryRegisteredThread(create.headers.get('x-allrice-d-entry-thread'))
      ?.id,
  ).toBe((await f.registerRoot.mock.results[0]?.value)?.identity.threadId);
  expect(f.host.catalog.creationRequests).toEqual([
    { agentPreset: 'standard' },
  ]);
  expect(f.prepareEditorRoot).not.toHaveBeenCalled();
  expect(f.registerRoot).toHaveBeenNthCalledWith(
    1,
    f.context,
    { ...f.identity, threadId: null },
    {
      nativeSessionId: 'native-created',
      forkSource: undefined,
      host: {
        binding: f.binding,
        bindingRef: f.owner.bindingRef,
        rosterDigest: f.owner.receipt.rosterDigest,
      },
    },
    expect.any(AbortSignal),
  );
  const forkOther = () =>
    f.invoke(life.scopeId, sessionToken, {
      endpoint: 'session/fork',
      payload: { args: { request: { sessionId: 'other' } } },
    });
  expect((await forkOther()).status).toBe(404);
  expect(f.host.catalog.items.map(({ sessionId }) => sessionId)).not.toContain(
    'native-forked',
  );
  const root = {
    identity: { ...f.identity, threadId: f.selection.threadId },
    rootNativeSessionId: 'other',
    rootOriginDigest: 'other-owned-root-proof',
    rootBindingRef: 'other-owned-root-ref',
    vmId: f.binding.vmId,
  };
  f.findRoot.mockResolvedValue(root);
  const fork = await forkOther();
  expect(await fork.json()).toMatchObject({
    result: { ok: true, value: { sessionId: 'native-forked' } },
  });
  expect(f.registerRoot.mock.calls[1]?.[2]).toMatchObject({
    nativeSessionId: 'native-forked',
    forkSource: { nativeSessionId: 'other', root },
  });
  expect(f.findRoot).toHaveBeenCalledWith(
    f.context,
    { ...f.identity, threadId: null },
    f.binding.vmId,
    'other',
  );
  expect(
    f.findRoot.mock.calls.filter((call) => call[3] === 'other'),
  ).toHaveLength(3);
  closePage(life.peer);
  expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
});

it('joins a fork from a registered ancestor but withholds registration after authority changes', async () => {
  const f = await fixture(undefined, false, true);
  const life = await open(f);
  const root = {
    identity: { ...f.identity, threadId: f.selection.threadId },
    rootNativeSessionId: 'other',
    rootOriginDigest: 'other-owned-root-proof',
    rootBindingRef: 'other-owned-root-ref',
    vmId: f.binding.vmId,
  };
  f.host.catalog.items.push(summary('other-child', 'other'));
  f.findRoot.mockResolvedValueOnce(root).mockResolvedValueOnce(undefined);
  const lost = await f.invoke(life.scopeId, sessionToken, {
    endpoint: 'session/fork',
    payload: { args: { request: { sessionId: 'other-child' } } },
  });
  expect(lost.status).toBe(404);
  expect(f.findRoot).toHaveBeenLastCalledWith(
    f.context,
    { ...f.identity, threadId: null },
    f.binding.vmId,
    'other',
  );
  expect(f.findRoot).toHaveBeenCalledTimes(2);
  expect(f.registerRoot).not.toHaveBeenCalled();
  expect(f.host.catalog.items.map(({ sessionId }) => sessionId)).toContain(
    'native-forked',
  );
  closePage(life.peer);
  expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
});

it.each(['login', 'vm binding'] as const)(
  'retains the native terminal through a page reconnect and joins owner cleanup after loss of %s',
  async (loss) => {
    const f = await fixture(undefined, false, false, 250);
    const revokedBinding = new AbortController();
    const watch = f.watchTerminal.getMockImplementation()!;
    f.watchTerminal.mockImplementationOnce(async (...args) => {
      const subscription = await watch(...args);
      return {
        ...subscription,
        revoked: AbortSignal.any([subscription.revoked, revokedBinding.signal]),
      };
    });
    const { host } = f.host;
    const web = createRequire(
      new URL('../../../web/package.json', import.meta.url),
    );
    const { TYPERT } = await import(
      pathToFileURL(
        web.resolve('@deepseek-ai/dsh-api-terminal-controller/typert'),
      ).href
    );
    host.typert.register(TYPERT);
    const terminal = {
      id: 'retained-pty',
      title: 'Shell',
      cwd: '/work',
      shell: { path: '/bin/sh', name: 'sh', args: [] },
      cols: 80,
      rows: 24,
      state: 'running',
      exitCode: null,
    };
    const closing = deferred();
    const closed = deferred();
    let closeAttempts = 0;
    closes.push(async () => closed.resolve());
    const invoke = host.typertGateway.invoke.bind(host.typertGateway);
    const native = vi
      .spyOn(host.typertGateway, 'invoke')
      .mockImplementation(async (call) => {
        if (call.namespace !== 'terminal') return invoke(call);
        if (call.method === 'create') {
          const request = z.object({ id: z.string() }).parse(call.args.request);
          if (request.id !== terminal.id)
            throw new RemoteError(
              'gateway/arguments-invalid',
              'Native validation rejected an unallocated terminal',
              { endpoint: 'terminal/create' },
            );
          return terminal;
        }
        if (call.method === 'list') return [terminal];
        if (call.method !== 'close') throw Error('Unexpected terminal RPC');
        expect(call.peer.principal.kind).toBe('owner');
        expect(call.peer.signal.aborted).toBe(false);
        expect(call.args).toEqual({ agentId: 'root', id: terminal.id });
        if (++closeAttempts <= 3)
          throw Error('Transient native termination failure');
        closing.resolve();
        await closed.promise;
      });
    const create = (page: Awaited<ReturnType<typeof open>>, id = terminal.id) =>
      f.invoke(page.scopeId, sessionToken, {
        endpoint: 'terminal/create',
        payload: {
          args: {
            agentId: 'root',
            request: { id, cols: 80, rows: 24 },
          },
        },
      });
    const first = await open(f);
    expect(await (await create(first)).json()).toMatchObject({
      result: { ok: true },
    });
    closePage(first.peer);
    expect(await first.receive()).toMatchObject({ value: { type: 'closed' } });
    const next = await open(f);
    expect(await (await create(next)).json()).toMatchObject({
      result: { ok: true },
    });
    expect(await (await create(next, 'unallocated-pty')).json()).toMatchObject({
      result: { ok: false, error: { code: 'gateway/arguments-invalid' } },
    });
    expect(f.watchTerminal).toHaveBeenCalledTimes(1);
    expect(f.deps.watch).toHaveBeenCalledTimes(3); // Two pages and one login owner.
    closePage(next.peer);
    expect(await next.receive()).toMatchObject({ value: { type: 'closed' } });
    expect(native.mock.calls.some(([call]) => call.method === 'close')).toBe(
      false,
    );

    if (loss === 'login') {
      f.identityRevoked.abort(new DataAccessError('authentication_required'));
    } else {
      const checks = f.watchTerminal.mock.calls[0]![4];
      const stale = new DataAccessError('authorization_denied');
      vi.mocked(f.owner.assertCurrent).mockRejectedValueOnce(stale);
      await expect(checks.verifyBinding(revokedBinding.signal)).rejects.toBe(
        stale,
      );
      revokedBinding.abort(stale);
    }
    await closing.promise;
    const observed = f.closeControl();
    let joined = false;
    void observed.then(
      () => {
        joined = true;
      },
      () => {
        joined = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(joined).toBe(false);
    closed.resolve();
    await observed;
    expect(
      native.mock.calls.filter(([call]) => call.method === 'close'),
    ).toHaveLength(4);
  },
);

it('withholds a successful native create reply after the page loses its VM authority', async () => {
  const f = await fixture(undefined, false, true);
  const life = await open(f);
  const entered = deferred();
  const finish = deferred();
  closes.push(async () => finish.resolve());
  f.host.catalog.beforeCreate = async () => {
    entered.resolve();
    await finish.promise;
  };
  const result = f.invoke(life.scopeId, sessionToken, {
    endpoint: 'session/create',
    payload: { args: { request: {} } },
  });
  await entered.promise;
  vi.mocked(f.owner.assertCurrent).mockRejectedValue(
    new DataAccessError('authorization_denied'),
  );
  finish.resolve();
  expect((await result).status).toBe(404);
  expect(f.registerRoot).not.toHaveBeenCalled();
});

it('keeps workspace file preview and private relay calls out of native dispatch', async () => {
  const f = await fixture();
  const life = await open(f);
  const invoke = vi.spyOn(f.host.host.typertGateway, 'invoke');
  for (const endpoint of [
    'workspaceFiles/readBytes',
    'allricePrincipal/openScope',
  ]) {
    const response = await f.invoke(life.scopeId, sessionToken, {
      endpoint,
      payload: { args: {} },
    });
    expect(await response.json()).toMatchObject({
      result: { ok: false, error: { code: 'remote-access/denied' } },
    });
  }
  expect(
    invoke.mock.calls.every(
      ([request]) =>
        request.namespace !== 'workspaceFiles' &&
        request.method !== 'openScope',
    ),
  ).toBe(true);
  closePage(life.peer);
  expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
});

it('carries native terminal input, resize and output across the owned VM stream', async () => {
  const f = await fixture();
  const { host } = f.host;
  const web = createRequire(
    new URL('../../../web/package.json', import.meta.url),
  );
  const { TYPERT } = await import(
    pathToFileURL(
      web.resolve('@deepseek-ai/dsh-api-terminal-controller/typert'),
    ).href
  );
  host.typert.register(TYPERT);
  const life = await open(f);
  expect(await status(f.connect(life.scopeId, otherToken))).toBe(404);
  const descriptor = host.typert.local.get('terminal/attach');
  const codec = descriptor?.uplink?.codec;
  if (codec?.mode !== 'strict')
    throw Error('Native terminal input schema missing');
  const inputCodec = codec.create();
  const wire = host.typertGateway.wireStream;
  const dispatch = wire.open.bind(wire);
  const inputs: unknown[] = [];
  const fault = deferred();
  const brokenId = 'native-error';
  closes.push(async () => fault.resolve());
  const attach = vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
    if (args[0] !== 'terminal/attach') return dispatch(...args);
    return (async function* () {
      yield {
        type: 'snapshot',
        sequence: 0,
        screen: '',
        writable: true,
        info: {
          id: 'terminal-fixture',
          title: 'Terminal',
          shell: { path: '/bin/sh', args: [], name: 'sh' },
          cwd: '/work',
          cols: 80,
          rows: 24,
          state: 'running',
          exitCode: null,
        },
      };
      if ((args[1] as typeof payload).args.id === brokenId) {
        await fault.promise;
        throw new RemoteError('gateway/service-unavailable', 'Fixture error', {
          endpoint: 'terminal/attach',
        });
      }
      for await (const raw of args[2]) {
        inputs.push(inputCodec.parse(raw));
      }
      yield { type: 'ack', sequence: 2 };
      yield { type: 'output', sequence: 3, data: 'guest-file\r\n' };
    })();
  });
  const peer = f.connect(life.scopeId);
  await once(peer, 'open');
  const receive = messages(peer);
  const streamId = 'terminal';
  const payload = { args: { agentId: 'root', id: 'terminal-fixture' } };
  send(peer, { type: 'open', streamId, endpoint: 'terminal/attach', payload });
  const frameOverheadBytes =
    Buffer.byteLength(
      JSON.stringify({
        type: 'item',
        streamId: '199c8160-f4ab-4f45-8b01-51b581fdffee',
        value: { type: 'input', value: null },
      }),
    ) - 4;
  expect(await receive(streamId)).toMatchObject({
    type: 'item',
    value: {
      type: 'snapshot',
      inputWindow: { maxBytes: 262_144, frameOverheadBytes },
    },
  });
  const write = { type: 'write', sequence: 1, data: 'ls\r' };
  const resize = { type: 'resize', sequence: 2, cols: 100, rows: 32 };
  send(peer, { type: 'item', streamId, value: write });
  send(peer, { type: 'item', streamId, value: resize });
  send(peer, { type: 'end', streamId });
  expect(await receive(streamId)).toMatchObject({
    type: 'item',
    value: { type: 'ack', sequence: 2 },
  });
  expect(await receive(streamId)).toMatchObject({
    type: 'item',
    value: { type: 'output', sequence: 3, data: 'guest-file\r\n' },
  });
  expect(await receive(streamId)).toMatchObject({ type: 'end' });
  expect(inputs).toEqual([write, resize]);
  expect(attach).toHaveBeenCalledWith(
    'terminal/attach',
    payload,
    expect.any(Object),
    expect.any(Object),
    expect.any(AbortSignal),
  );
  // A late frame for an ended attachment cannot take down the page mux.
  send(peer, { type: 'item', streamId, value: write });
  const cancelled = 'cancelled-terminal';
  send(peer, {
    type: 'open',
    streamId: cancelled,
    endpoint: 'terminal/attach',
    payload,
  });
  expect(await receive(cancelled)).toMatchObject({
    type: 'item',
    value: { type: 'snapshot' },
  });
  function holdCurrentCheck() {
    const checking = deferred();
    const interrupted = deferred();
    vi.mocked(f.owner.assertCurrent).mockImplementationOnce(
      async (_context, signal) => {
        checking.resolve();
        if (!signal.aborted) await once(signal, 'abort');
        interrupted.resolve();
        signal.throwIfAborted();
      },
    );
    return { checking, interrupted };
  }
  const inputCheck = holdCurrentCheck();
  send(peer, { type: 'item', streamId: cancelled, value: write });
  await inputCheck.checking.promise;
  send(peer, { type: 'cancel', streamId: cancelled });
  await inputCheck.interrupted.promise;
  send(peer, {
    type: 'open',
    streamId: brokenId,
    endpoint: 'terminal/attach',
    payload: { args: { ...payload.args, id: brokenId } },
  });
  expect(await receive(brokenId)).toMatchObject({
    type: 'item',
    value: { type: 'snapshot' },
  });
  const outputCheck = holdCurrentCheck();
  fault.resolve();
  await outputCheck.checking.promise;
  send(peer, { type: 'cancel', streamId: brokenId });
  await outputCheck.interrupted.promise;
  send(peer, {
    type: 'open',
    streamId: 'still-open',
    endpoint: 'session/control',
    payload: { args: {} },
  });
  expect(await receive('still-open')).toMatchObject({
    type: 'item',
    value: { type: 'baseline' },
  });
  expect(inputs).toEqual([write, resize]);
  closePage(life.peer);
  expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
});

it('reattaches native binary reply bytes using the generated field path', async () => {
  const f = await fixture();
  const life = await open(f);
  const codec = z.object({ result: z.array(z.instanceof(Uint8Array)) });
  f.host.host.typert.register({
    package: '@deepseek-ai/dsh-test-fixture',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      {
        id: '@deepseek-ai/dsh-test-fixture#session/fixtureBytes',
        service: 'sessionController',
        namespace: 'session',
        method: 'fixtureBytes',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'FixtureBytes',
          create: () => codec,
          encode(input, writeBytes) {
            return {
              result: codec
                .parse(input)
                .result.map((bytes, index) =>
                  writeBytes(bytes, ['result', index]),
                ),
            };
          },
        },
      },
    ],
  });
  const response = await f.invoke(life.scopeId, sessionToken, {
    endpoint: 'session/fixtureBytes',
    payload: { args: {} },
  });
  expect(
    response.headers.get('content-type'),
    await response.clone().text(),
  ).toContain('multipart/form-data');
  const multipart = await response.formData();
  expect(JSON.parse(String(multipart.get('metadata')))).toMatchObject({
    result: { ok: true, value: { result: [null] } },
    attachments: [{ path: ['result', 0], codec: 'bytes', part: 'bytes-0' }],
  });
  const part = multipart.get('bytes-0');
  expect(part).toBeInstanceOf(Blob);
  expect(
    Array.from(new Uint8Array(await (part as Blob).arrayBuffer())),
  ).toEqual([0, 128, 255]);
  closePage(life.peer);
  expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
});

it('relays same-VM projection updates for other Sessions without filtering', async () => {
  const f = await fixture();
  const life = await open(f);
  const wire = f.host.host.typertGateway.wireStream;
  const openNative = wire.open.bind(wire);
  vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
    const source = await openNative(...args);
    if (args[0] !== 'session/control') return source;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const item of source) {
          yield item;
          yield {
            type: 'projection',
            sessionId: 'other',
            key: 'fixture',
            seq: 1,
            value: 'unrelated',
          };
          yield {
            type: 'projection',
            sessionId: 'root',
            key: 'fixture',
            seq: 2,
            value: 'current',
          };
        }
      },
    };
  });
  const peer = f.connect(life.scopeId);
  const next = messages(peer);
  await once(peer, 'open');
  send(peer, {
    type: 'open',
    streamId: 'control',
    endpoint: 'session/control',
    payload: { args: {} },
  });
  expect(await next()).toMatchObject({
    type: 'item',
    value: { type: 'baseline' },
  });
  expect(await next()).toMatchObject({
    type: 'item',
    value: {
      type: 'projection',
      sessionId: 'other',
      seq: 1,
      value: 'unrelated',
    },
  });
  expect(await next()).toMatchObject({
    type: 'item',
    value: { type: 'projection', sessionId: 'root', seq: 2, value: 'current' },
  });
  expect((await f.invoke(life.scopeId)).status).toBe(200);
  closePage(life.peer);
  expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
});

it('opens another live registry stream and withholds its next frame after authority is lost', async () => {
  const f = await fixture();
  const life = await open(f);
  f.host.host.typert.register({
    package: '@deepseek-ai/dsh-api-job-controller',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      {
        id: '@deepseek-ai/dsh-api-job-controller#job/list',
        service: 'jobController',
        namespace: 'job',
        method: 'list',
        mode: 'stream',
        invocation: { kind: 'direct' },
        parameters: [],
        result: {
          mode: 'strict',
          typeSymbol: 'FixtureJob',
          create: () => z.object({ sessionId: z.string() }),
        },
      },
    ],
  });
  const wire = f.host.host.typertGateway.wireStream;
  const dispatch = wire.open.bind(wire);
  const finish = deferred();
  closes.push(async () => finish.resolve());
  const returned = deferred();
  vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
    if (args[0] !== 'job/list') return dispatch(...args);
    return (async function* () {
      try {
        yield { sessionId: 'other' };
        await finish.promise;
        yield { sessionId: 'unpublished-tail' };
      } finally {
        returned.resolve();
      }
    })();
  });
  const peer = f.connect(life.scopeId);
  await once(peer, 'open');
  const receive = messages(peer);
  send(peer, {
    type: 'open',
    streamId: 'job',
    endpoint: 'job/list',
    payload: { args: {} },
  });
  expect(await receive('job')).toEqual({
    type: 'item',
    streamId: 'job',
    value: { sessionId: 'other' },
  });
  const tail = vi.fn();
  peer.on('message', tail);
  const closed = once(peer, 'close');
  vi.mocked(f.owner.assertCurrent).mockRejectedValue(
    new DataAccessError('authorization_denied'),
  );
  finish.resolve();
  await closed;
  await returned.promise;
  expect(tail).not.toHaveBeenCalled();
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
    await (
      await f.invoke(life.scopeId, sessionToken, { endpoint: 'workspace/list' })
    ).json(),
  ).toMatchObject({
    result: { ok: false, error: { code: 'remote-access/denied' } },
  });
  expect((await f.invoke(life.scopeId)).status).toBe(200);
  expect(f.owner.acquirePrincipal).toHaveBeenCalledTimes(1);
  closePage(life.peer);
  expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
  expect(await life.receive()).toEqual({ type: 'end', streamId: 'life' });
});

it.each(['child grant', 'D qualification'] as const)(
  'checks %s after a real bootstrap baseline and a blocked native close',
  { timeout: 30_000 },
  async (change) => {
    const f = await fixture(await buildProfileFixture());
    const page = await open(f);
    const observed = deferred<unknown>();
    const joining = deferred();
    const allowJoin = deferred();
    closes.push(async () => allowJoin.resolve());
    const gateway = f.host.host.typertGateway.wireStream;
    const nativeOpen = gateway.open.bind(gateway);
    const peerIds: string[] = [];
    vi.spyOn(gateway, 'open').mockImplementation(async (...args) => {
      const source = await nativeOpen(...args);
      if (args[0] !== 'remoteAccess/follow') return source;
      const principal = args[3]?.principal;
      if (principal?.kind !== 'allrice-d-entry') return source;
      peerIds.push(principal.scopeId);
      if (peerIds.length !== 1) return source;
      return {
        [Symbol.asyncIterator]() {
          const underlying = source[Symbol.asyncIterator]();
          return {
            async next() {
              const item = await underlying.next();
              if (!item.done) observed.resolve(item.value);
              return item;
            },
            async return() {
              joining.resolve();
              await allowJoin.promise;
              return (
                (await underlying.return?.()) ?? {
                  done: true,
                  value: undefined,
                }
              );
            },
          };
        },
      };
    });
    const pendingResponse = deferred<ServerResponse>();
    f.worker.once('request', (_request, response) =>
      pendingResponse.resolve(response),
    );
    const result = f.publish('bootstrap', page.scopeId);
    void result.catch(() => {});
    try {
      const first = await observed.promise;
      expect(first).toMatchObject({ type: 'baseline', owner: false });
      expect(JSON.stringify(first)).toContain('"id":"child"');
      await joining.promise;
      expect((await pendingResponse.promise).headersSent).toBe(false);
      // No change hint has reached the guest and no SQL watcher has fired.
      if (change === 'child grant') {
        f.host.catalog.items = f.host.catalog.items.filter(
          (row) => String(row.sessionId) !== 'child',
        );
      } else {
        vi.mocked(f.owner.assertCurrent).mockRejectedValueOnce(
          new DataAccessError('authorization_denied'),
        );
      }
    } finally {
      allowJoin.resolve();
    }
    const response = await result;
    if (change === 'child grant') {
      expect(response.status).toBe(200);
      const bootstrap = DEntryProfileBootstrapSchema.parse(
        await response.json(),
      );
      const baseline = bootstrap.injections.at(-1);
      expect(JSON.stringify(baseline)).toContain('"id":"root"');
      expect(JSON.stringify(baseline)).not.toContain('"id":"child"');
      expect(peerIds).toEqual([page.scopeId, page.scopeId]);
    } else {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    }
  },
);

it.each(['HTTP disconnect', 'profile shutdown'] as const)(
  'cancels and joins the actual guest list on %s without revoking the page or its neighbor',
  { timeout: 30_000 },
  async (change) => {
    const f = await fixture(await buildProfileFixture());
    const page = await open(f);
    const neighbor = await open(f);
    const entered = deferred<AbortSignal>();
    const sawAbort = deferred();
    const joined = deferred();
    const allowJoin = deferred();
    closes.push(async () => allowJoin.resolve());
    let reads = 0;
    f.host.catalog.beforeList = async (signal) => {
      if (++reads !== 1) return;
      entered.resolve(signal);
      if (!signal.aborted) await once(signal, 'abort');
      sawAbort.resolve();
      await allowJoin.promise;
      joined.resolve();
      signal.throwIfAborted();
    };
    const url = f.profileUrl('bootstrap', page.scopeId);
    const pendingResponse = observeProfileRequest(f, url);
    const client = get(url, {
      headers: { authorization: 'Bearer ' + sessionToken },
    });
    client.on('error', () => {});
    client.on('response', (response) => response.resume());
    closes.push(async () => client.destroy());
    let shutdown: Promise<void> | undefined;
    let stopped = false;
    const completion = f.profileCompletion(await pendingResponse);
    try {
      const actualCatalogSignal = await entered.promise;
      expect(actualCatalogSignal.aborted).toBe(false);
      if (change === 'HTTP disconnect') client.destroy();
      else
        shutdown = f.closeProfile().then(() => {
          stopped = true;
        });
      await sawAbort.promise;
      expect(actualCatalogSignal.aborted).toBe(true);
      expect(completion.done).toBe(false);
      expect(stopped).toBe(false);
      expect((await f.invoke(neighbor.scopeId)).status).toBe(200);
      expect(completion.done).toBe(false);
    } finally {
      allowJoin.resolve();
    }
    await joined.promise;
    await shutdown;
    await completion.promise;
    expect((await f.invoke(page.scopeId)).status).toBe(200);
    if (change === 'HTTP disconnect') {
      const retry = await f.publish('bootstrap', page.scopeId);
      expect(retry.status).toBe(200);
      await retry.arrayBuffer();
    }
  },
);

it.each(['native update', 'true terminal', 'native terminal error'] as const)(
  'rejects the second baseline when final verification sees %s',
  { timeout: 30_000 },
  async (mode) => {
    const release = await buildProfileFixture();
    const f = await fixture(release);
    const page = await open(f);
    const neighbor = await open(f);
    const checking = deferred();
    const allowCheck = deferred();
    const finishReader = deferred();
    const nextFrame = deferred<'item' | 'terminal'>();
    f.profileObserved.mockImplementation((part) => {
      if (part === 'terminal' || f.profileObserved.mock.calls.length > 1)
        nextFrame.resolve(part);
    });
    closes.push(async () => allowCheck.resolve());
    closes.push(async () => finishReader.resolve());
    const wire = f.host.host.typertGateway.wireStream;
    const openNative = wire.open.bind(wire);
    let access = 0;
    vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
      const source = await openNative(...args);
      if (args[0] !== 'remoteAccess/follow' || ++access !== 2) return source;
      return {
        async *[Symbol.asyncIterator]() {
          let first = true;
          for await (const item of source) {
            if (first) {
              expect(item).toMatchObject({ type: 'baseline', owner: false });
              expect(JSON.stringify(item)).toContain('"id":"child"');
              release.beforeGraphRead = async () => {
                release.beforeGraphRead = undefined;
                checking.resolve();
                await allowCheck.promise;
              };
              first = false;
            }
            yield item;
            if (mode === 'true terminal' || mode === 'native terminal error') {
              await finishReader.promise;
              if (mode === 'native terminal error')
                throw new RemoteError(
                  'gateway/service-unavailable',
                  'native access feed failed',
                  { endpoint: 'remoteAccess/follow' },
                );
              return;
            }
          }
        },
      };
    });
    const terminal = observeProfileRequest(
      f,
      f.profileUrl('bootstrap', page.scopeId),
    );
    const result = f.publish('bootstrap', page.scopeId);
    void result.catch(() => {});
    const response = await terminal;
    const completion = f.profileCompletion(response);
    try {
      await checking.promise;
      if (mode === 'true terminal' || mode === 'native terminal error') {
        finishReader.resolve();
        expect(await nextFrame.promise).toBe('terminal');
      } else {
        const nativeChild = summary('child', 'root');
        f.host.catalog.items = f.host.catalog.items.filter(
          (row) => row.sessionId !== nativeChild.sessionId,
        );
        f.host.host.emit('api-session/removed', nativeChild.sessionId);
        expect(await nextFrame.promise).toBe('item');
      }
      expect(response.headersSent).toBe(false);
      expect(access).toBe(2);
    } finally {
      allowCheck.resolve();
      finishReader.resolve();
    }
    const refused = await result;
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain('"id":"child"');
    if (mode === 'native terminal error') {
      await completion.promise;
      expect((await f.invoke(page.scopeId)).status).toBe(404);
      expect((await f.invoke(neighbor.scopeId)).status).toBe(200);
      await f.checkUnknownControlClose();
      return;
    }
    const retry = await f.publish('bootstrap', page.scopeId);
    expect(retry.status).toBe(200);
    const refreshed = await retry.text();
    if (mode === 'true terminal') expect(refreshed).toContain('"id":"child"');
    else expect(refreshed).not.toContain('"id":"child"');
  },
);

it.each(['waiting to read', 'waiting for a newer projection'] as const)(
  'joins the finite request while it is %s and unrelated catalog I/O remains held',
  { timeout: 30_000 },
  async (mode) => {
    const f = await fixture(await buildProfileFixture());
    const page = await open(f);
    const scope = f.host.host.allricePrincipal.scopes.get(page.scopeId);
    if (!scope) throw Error('Guest scope missing');
    const waitingToRead = mode === 'waiting to read';
    const unrelatedRead = deferred<AbortSignal>();
    const firstChildRead = deferred<AbortSignal>();
    const finish = deferred();
    const finishFirstChild = deferred();
    closes.push(async () => finish.resolve());
    closes.push(async () => finishFirstChild.resolve());
    const reads: AbortSignal[] = [];
    let unrelatedReadDone = false;
    f.host.catalog.beforeList = async (signal) => {
      reads.push(signal);
      if (waitingToRead ? reads.length === 1 : signal === scope.abort.signal) {
        unrelatedRead.resolve(signal);
        await finish.promise;
        unrelatedReadDone = true;
      } else if (!waitingToRead && reads.length === 1) {
        firstChildRead.resolve(signal);
        await finishFirstChild.promise;
      }
    };
    const predecessor = waitingToRead ? scope.refresh() : undefined;
    void predecessor?.catch(() => {});
    if (predecessor) await unrelatedRead.promise;

    // A list call held by another owner does not establish this HTTP child's
    // arrival. Observe the exact guest scope after it registers its refresh.
    const childRefresh = deferred<{
      signal: AbortSignal;
      work: Promise<void>;
    }>();
    const refresh = scope.refresh.bind(scope);
    vi.spyOn(scope, 'refresh').mockImplementation((signal) => {
      const work = refresh(signal);
      if (signal && signal !== scope.abort.signal)
        childRefresh.resolve({ signal, work });
      return work;
    });
    const url = f.profileUrl('bootstrap', page.scopeId);
    const responseReady = observeProfileRequest(f, url);
    const client = get(url, {
      headers: { authorization: 'Bearer ' + sessionToken },
    });
    client.on('error', () => {});
    closes.push(async () => client.destroy());
    let projection: Promise<void> | undefined;
    try {
      const response = await responseReady;
      const completion = f.profileCompletion(response);
      const endedEarly = completion.promise.then(() => {
        throw Error('Profile finished before reaching its owned read phase');
      });
      const finite = await Promise.race([childRefresh.promise, endedEarly]);
      expect(scope.children.size).toBe(1);
      const guestChild = [...scope.children][0]!;
      let blocked: Promise<unknown> = finite.work;
      if (waitingToRead) {
        expect(scope['catalogQueue'].size).toBe(1);
        expect(reads).toEqual([await unrelatedRead.promise]);
      } else {
        expect(await Promise.race([firstChildRead.promise, endedEarly])).toBe(
          finite.signal,
        );
        f.host.host.emit('api-session/added', summary('child', 'root'));
        expect(scope['catalogQueue'].size).toBe(1);
        const newer = (projection = scope['refreshQueue']);
        expect(newer).not.toBe(finite.work);

        // Observe registration on the exact pending projection from current(),
        // after refresh itself and the native hint have installed their joins.
        const waiting = deferred();
        const entered = deferred<{ work: Promise<unknown> }>();
        const current = scope.current.bind(scope);
        vi.spyOn(scope, 'current').mockImplementationOnce(
          (dispatch, signal) => {
            expect(signal).toBe(finite.signal);
            const subscribe = newer.then.bind(newer);
            const observer = vi
              .spyOn(newer, 'then')
              .mockImplementationOnce((...callbacks) => {
                const continuation = subscribe(...callbacks);
                waiting.resolve();
                return continuation;
              });
            closes.push(async () => observer.mockRestore());
            const work = current(dispatch, signal);
            entered.resolve({ work });
            return work;
          },
        );
        finishFirstChild.resolve();
        const [enteredCurrent, nativeSignal] = await Promise.race([
          Promise.all([
            entered.promise,
            unrelatedRead.promise,
            waiting.promise,
          ]),
          endedEarly,
        ]);
        blocked = enteredCurrent.work;
        expect(nativeSignal).toBe(scope.abort.signal);
        expect(reads).toEqual([finite.signal, nativeSignal]);
      }
      expect(scope.children.has(guestChild)).toBe(true);
      const heldSignal = await unrelatedRead.promise;
      expect(heldSignal).not.toBe(finite.signal);
      expect(finite.signal.aborted).toBe(false);
      expect(completion.done).toBe(false);
      expect(response.headersSent).toBe(false);
      const callsBeforeCancel = reads.length;
      const cancelled = once(finite.signal, 'abort');
      client.destroy();
      await cancelled;
      await expect(blocked).rejects.toBe(finite.signal.reason);
      await completion.promise;
      expect(response.headersSent).toBe(false);
      expect(heldSignal.aborted).toBe(false);
      expect(unrelatedReadDone).toBe(false);
      expect(reads).toHaveLength(callsBeforeCancel);
      expect(scope.children.size).toBe(0);
      expect(scope['catalogQueue'].size).toBe(0);
    } finally {
      finishFirstChild.resolve();
      finish.resolve();
    }
    await predecessor;
    await projection;
    expect(unrelatedReadDone).toBe(true);
    const retry = await f.publish('bootstrap', page.scopeId);
    expect(retry.status).toBe(200);
    await retry.arrayBuffer();
  },
);

it.each(['with baseline', 'with independent baseline failure'] as const)(
  'fences bootstrap and later borrows when the initial native follow cannot confirm its close %s',
  { timeout: 30_000 },
  async (mode) => {
    const f = await fixture(await buildProfileFixture());
    const page = await open(f);
    const neighbor = await open(f);
    const initial = deferred();
    const failed = deferred<unknown>();
    const failure = Error('initial native follow return failed');
    const businessError = new RemoteError(
      'gateway/service-unavailable',
      'original native access business error',
      { endpoint: 'remoteAccess/follow' },
    );
    const wire = f.host.host.typertGateway.wireStream;
    const openNative = wire.open.bind(wire);
    let access = 0;
    vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
      const source = await openNative(...args);
      if (args[0] !== 'remoteAccess/follow' || ++access !== 1) return source;
      return {
        [Symbol.asyncIterator]() {
          const underlying = source[Symbol.asyncIterator]();
          return {
            async next() {
              const item = await underlying.next();
              if (!item.done) initial.resolve();
              if (mode === 'with independent baseline failure')
                throw businessError;
              return item;
            },
            async return() {
              await underlying.return?.();
              failed.resolve(failure);
              throw failure;
            },
          };
        },
      };
    });
    const result = f.publish('bootstrap', page.scopeId);
    await initial.promise;
    expect(await failed.promise).toBe(failure);
    const denied = await result;
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe('');
    expect((await f.publish('bootstrap', page.scopeId)).status).toBe(404);
    expect((await f.invoke(page.scopeId)).status).toBe(404);
    expect((await f.invoke(neighbor.scopeId)).status).toBe(200);
    expect(access).toBe(1);
    await f.checkUnknownControlClose();
    if (mode === 'with independent baseline failure')
      expect(f.profileFailures.mock.calls[0]?.[0]).toMatchObject({
        message: businessError.message,
      });
  },
);

it(
  'unregisters one of two actual waiters while keeping their shared page proof alive',
  { timeout: 30_000 },
  async () => {
    const release = await buildProfileFixture();
    const shared = deferred<AbortSignal>();
    const finish = deferred();
    let reads = 0;
    release.beforeGraphRead = async (signal) => {
      if (++reads !== 1) return;
      shared.resolve(signal);
      await finish.promise;
    };
    const f = await fixture(release);
    // Unblock the real proof before the fixture's reverse-order close joins it.
    closes.push(async () => finish.resolve());
    const page = await open(f);
    const bothSubscribed = deferred();
    const wait = PendingPublication.prototype.wait;
    let subscriptions = 0;
    const pendingPublications = vi
      .spyOn(PendingPublication.prototype, 'wait')
      .mockImplementation(function (this: PendingPublication, signal) {
        const result = wait.call(this, signal);
        if (++subscriptions === 2) bothSubscribed.resolve();
        return result;
      });
    closes.push(async () => pendingPublications.mockRestore());
    const cancel = new AbortController();
    try {
      const first = startDocumentProfileRequest(f, page.scopeId, cancel.signal);
      const firstDone = await waitForProfilePhase(
        'the first request arrived',
        first.completion,
        first,
      );
      const sharedSignal = await waitForProfilePhase(
        'the shared graph read',
        shared.promise,
        first,
      );
      const other = startDocumentProfileRequest(f, page.scopeId);
      await waitForProfilePhase(
        'both shared waiters registered',
        bothSubscribed.promise,
        first,
        other,
      );
      expect(f.profileBorrows.mock.calls).toHaveLength(2);
      const [one, two] = f.profileBorrows.mock.calls.map(([signal]) => signal);
      expect(getEventListeners(one!, 'abort')).toHaveLength(1);
      expect(getEventListeners(two!, 'abort')).toHaveLength(1);
      const proof = pendingPublications.mock.contexts[0] as PendingPublication;
      expect(pendingPublications.mock.contexts).toEqual([proof, proof]);
      const [firstWaiter, secondWaiter] = [...proof['waiters']];
      expect(firstWaiter).toBeTypeOf('function');
      expect(secondWaiter).toBeTypeOf('function');
      const firstAbortedInWorker = once(one!, 'abort');
      cancel.abort(Error('the first wire left'));
      await expect(first.response).rejects.toThrow('the first wire left');
      await waitForProfilePhase(
        'the first Worker abort',
        firstAbortedInWorker,
        other,
      );
      expect(getEventListeners(one!, 'abort')).toHaveLength(0);
      expect(getEventListeners(two!, 'abort')).toHaveLength(1);
      expect([...proof['waiters']]).toEqual([secondWaiter]);
      await waitForProfilePhase(
        'the first handler joined',
        firstDone.promise,
        other,
      );
      expect(sharedSignal.aborted).toBe(false);
      expect(reads).toBe(1);
      finish.resolve();
      const result = await other.response;
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ nativeSessionId: 'root' });
      expect(
        getEventListeners(f.profileBorrows.mock.calls[1]![0], 'abort'),
      ).toHaveLength(0);
    } finally {
      finish.resolve();
    }
  },
);

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
        readImmutableBundle: (reference, _bytes, signal) =>
          read(reference, signal),
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
    const terminalModule = graph.entries.find(
      ({ id }) => id === '@deepseek-ai/dsh-client-ui-sidebar-terminal',
    );
    if (!terminalModule)
      throw Error('Native terminal missing from sealed graph');
    const chunk = `plugins/${terminalModule.id}/client.terminal.js?rev=${terminalModule.rev}`;
    const loadChunk = (reference: string, revision = terminalModule.rev) =>
      f.publish('assets', scopeId, {
        bindingRef: f.owner.bindingRef,
        reference,
        revision,
      });
    const terminalScript = await loadChunk(chunk);
    expect(terminalScript.status).toBe(200);
    expect(terminalScript.headers.get('content-type')).toContain('javascript');
    expect(Buffer.from(await terminalScript.arrayBuffer())).toEqual(
      await read(chunk, source),
    );
    for (const response of [
      await loadChunk(chunk, 'wrong'),
      await loadChunk(
        chunk.replace('client.terminal.js', 'client.unsealed.js'),
      ),
      await loadChunk(chunk.replace('client.terminal.js', 'client.node.js')),
    ]) {
      expect(response.status).toBe(404);
      await response.body?.cancel();
    }

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
    const checkingGraph = deferred();
    const finishGraph = deferred();
    closes.push(async () => finishGraph.resolve());
    ownerProof.beforeGraphRead = async () => {
      ownerProof.beforeGraphRead = undefined;
      checkingGraph.resolve();
      await finishGraph.promise;
    };
    let sentQueued = false;
    const starting = pipelineAfterEvents(foreground.scopeId, {
      awaitingId: waiting.scopeId,
      beforeQueued: () => (sentQueued = true),
    });
    try {
      await Promise.race([
        checkingGraph.promise,
        starting.then(() => {
          throw Error('Pipeline completed before reading the published graph');
        }),
      ]);
      expect(sentQueued).toBe(false);
    } finally {
      finishGraph.resolve();
    }
    const pipeline = await starting;
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
    const [, , document] = await pipeline.remaining(404, 404, 200);
    expect(JSON.parse(document!.toString())).toEqual(target);
    await pipeline.disconnect();

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
    await afterRoleChange.remaining(404, 200);
    expect(roleNext!.writableFinished).toBe(true);
    expect((await f.invoke(noNotification.scopeId)).status).toBe(404);
    expect((await f.invoke(foreground.scopeId)).status).toBe(200);
    await afterRoleChange.disconnect();

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
    expect(beforeHeaders.revoked.aborted).toBe(false);
    const revokedBeforeHeaders = once(beforeHeaders.revoked, 'abort');
    closePage(beforeHeaders.peer);
    await revokedBeforeHeaders;
    expect((await f.invoke(beforeHeaders.scopeId)).status).toBe(404);
    expect(assignedAsset!.headersSent).toBe(false);
    expect(assignedNext!.headersSent).toBe(false);
    finishCheck.resolve();
    expect(await rejected).toMatchObject({ value: { type: 'closed' } });
    await assigned.remaining(404, 200);
    expect(assignedNext!.writableFinished).toBe(true);
    await assigned.disconnect();

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
    expect(reading.revoked.aborted).toBe(false);
    const revokedDuringRead = once(reading.revoked, 'abort');
    closePage(reading.peer);
    await revokedDuringRead;
    expect((await f.invoke(reading.scopeId)).status).toBe(404);
    finishRead.resolve();
    expect(await reading.receive()).toMatchObject({
      value: { type: 'closed' },
    });
    expect(preReadAsset!.statusCode).toBe(404);
    expect(preReadAsset!.writableEnded).toBe(true);
    expect(readHead!.writableEnded).toBe(false);
    expect(preReadNext!.headersSent).toBe(false);
    readHead!.end();
    await preRead.remaining(404, 200);
    await preRead.disconnect();

    const borrowing = await open(f);
    const authorizing = deferred();
    const finishHistory = deferred();
    closes.push(async () => finishHistory.resolve());
    const early = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: borrowing.scopeId,
      onlyAsset: true,
      beforeQueued: () => {
        f.historyIdentity.mockImplementationOnce(
          async (_context, selection) => {
            authorizing.resolve();
            await finishHistory.promise;
            return {
              ...f.identity,
              threadId:
                DEntrySelectionInputSchema.parse(selection).threadId ?? null,
            };
          },
        );
      },
      beforeNext: () => authorizing.promise,
    });
    const [earlyHead, earlyAsset] = early.responses;
    expect(earlyAsset!.listenerCount('socket')).toBe(0);
    expect(borrowing.revoked.aborted).toBe(false);
    const revokedDuringBorrow = once(borrowing.revoked, 'abort');
    closePage(borrowing.peer);
    await revokedDuringBorrow;
    expect((await f.invoke(borrowing.scopeId)).status).toBe(404);
    finishHistory.resolve();
    expect(await borrowing.receive()).toMatchObject({
      value: { type: 'closed' },
    });
    expect(earlyHead!.writableEnded).toBe(false);
    earlyHead!.end();
    await early.remaining(404, 200);
    await early.disconnect();

    const warm = await open(f);
    const warming = await f.publish('bootstrap', warm.scopeId, {}, 'document');
    expect(warming.status).toBe(200);
    await warming.json();
    const readingAsset = deferred();
    const cancelledAsset = deferred();
    const fallbackAsset = deferred();
    closes.push(async () => fallbackAsset.resolve());
    const disconnected = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: warm.scopeId,
      onlyAsset: true,
      beforeQueued: () => {
        ownerProof.beforeGraphRead = async (signal) => {
          ownerProof.beforeGraphRead = undefined;
          readingAsset.resolve();
          const stop = () => cancelledAsset.resolve();
          signal.addEventListener('abort', stop, { once: true });
          try {
            if (signal.aborted) stop();
            await Promise.race([cancelledAsset.promise, fallbackAsset.promise]);
          } finally {
            signal.removeEventListener('abort', stop);
          }
        };
      },
      beforeNext: () => readingAsset.promise,
    });
    const disconnectedAsset = disconnected.responses[1]!;
    expect(disconnectedAsset.socket).toBeNull();
    const disconnectedDone = f.profileCompletion(disconnectedAsset);
    await disconnected.disconnect();
    await disconnectedDone.promise;
    await cancelledAsset.promise;
    expect((await f.invoke(warm.scopeId)).status).toBe(200);
    expect((await f.invoke(foreground.scopeId)).status).toBe(200);

    expect(JSON.stringify(boot.injections.at(-1))).toContain('"id":"child"');
    const waitingGrants = await open(f);
    const grantPipeline = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: waitingGrants.scopeId,
      bootstrap: true,
    });
    const [grantHead, grantResponse] = grantPipeline.responses;
    expect(grantResponse!.socket).toBeNull();
    const oldCatalog = f.host.catalog.items;
    try {
      f.host.catalog.items = oldCatalog.filter(
        (row) => row.sessionId !== 'child',
      );
      grantHead!.end();
      const [grants] = await grantPipeline.remaining(200, 200);
      const published = DEntryProfileBootstrapSchema.parse(
        JSON.parse(grants!.toString()),
      );
      const access = published.injections.at(-1);
      expect(access).toMatchObject({ name: '__DSH_REMOTE_ACCESS__' });
      expect(JSON.stringify(access)).toContain('"id":"root"');
      expect(JSON.stringify(access)).not.toContain('"id":"child"');
      expect((await f.invoke(waitingGrants.scopeId)).status).toBe(200);
    } finally {
      f.host.catalog.items = oldCatalog;
      await grantPipeline.disconnect();
    }

    const draining = await pipelineAfterEvents(foreground.scopeId);
    const held = holdSocket(draining.responses[0]!);
    let terminal: Awaited<ReturnType<typeof receive>> | undefined;
    const terminalPromise = foreground
      .receive()
      .then((frame) => (terminal = frame));
    closePage(foreground.peer);
    await held.fenced;
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
    const heldErrors = holdSocket(errors.responses[0]!);
    let joined = false;
    const stopping = f.closeProfile().then(() => {
      joined = true;
    });
    await heldErrors.fenced;
    expect(joined).toBe(false);
    heldErrors.release.resolve();
    await heldErrors.closed;
    await stopping;
    expect(await pending).toBe(true);

    const wireOnly = await fixture({ directory, graph, read });
    const unrelated = await pipelineAfterEvents(
      scopeId,
      { unrelated: true },
      wireOnly,
    );
    const [unrelatedHead, unrelatedDenial] = unrelated.responses;
    const unrelatedFinish = once(unrelatedDenial!, 'finish');
    const unrelatedDone = wireOnly.profileCompletion(unrelatedDenial!);
    expect(unrelatedDenial!.socket).toBeNull();
    expect(unrelatedDenial!.headersSent).toBe(false);
    let wireJoined = false;
    const stoppingWire = wireOnly.closeProfile().then(() => {
      wireJoined = true;
    });
    await unrelatedDone.promise;
    expect(unrelatedDenial!.statusCode).toBe(404);
    expect(unrelatedDenial!.writableFinished).toBe(false);
    expect(unrelatedHead!.writableEnded).toBe(false);
    expect(wireJoined).toBe(false);
    unrelatedHead!.end();
    await unrelatedFinish;
    await stoppingWire;
    await unrelated.remaining(404);
    await unrelated.endFromWorker();
    closePage(peer);
    expect(await receive()).toMatchObject({ value: { type: 'closed' } });
    closePage(second.peer);
    expect(await second.receive()).toMatchObject({ value: { type: 'closed' } });

    const firstProof = deferred<AbortSignal>();
    const finishFirstProof = deferred();
    const sharedProof: ProfileProof = {
      directory,
      graph,
      read,
      async beforeGraphRead(signal) {
        sharedProof.beforeGraphRead = undefined;
        firstProof.resolve(signal);
        await finishFirstProof.promise;
      },
    };
    const shared = await fixture(sharedProof);
    closes.push(async () => finishFirstProof.resolve());
    const sharedPage = await open(shared);
    const caller = new AbortController();
    try {
      const firstRequest = startDocumentProfileRequest(
        shared,
        sharedPage.scopeId,
        caller.signal,
      );
      const firstHandler = await waitForProfilePhase(
        'the first request arrived',
        firstRequest.completion,
        firstRequest,
      );
      const sharedSignal = await waitForProfilePhase(
        'the shared graph read',
        firstProof.promise,
        firstRequest,
      );
      const secondBorrow = deferred();
      vi.mocked(shared.owner.assertCurrent).mockImplementationOnce(async () => {
        secondBorrow.resolve();
      });
      const secondRequest = startDocumentProfileRequest(
        shared,
        sharedPage.scopeId,
      );
      await waitForProfilePhase(
        'the second borrow',
        secondBorrow.promise,
        firstRequest,
        secondRequest,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      caller.abort();
      await expect(firstRequest.response).rejects.toMatchObject({
        name: 'AbortError',
      });
      await waitForProfilePhase(
        'the first handler joined',
        firstHandler.promise,
        secondRequest,
      );
      expect(sharedSignal.aborted).toBe(false);
      finishFirstProof.resolve();
      const responseWithSharedProof = await secondRequest.response;
      expect(responseWithSharedProof.status).toBe(200);
      await responseWithSharedProof.json();
    } finally {
      finishFirstProof.resolve();
    }

    const shutdownPage = await open(shared);
    const readBeforeShutdown = deferred<AbortSignal>();
    const finishShutdown = deferred();
    closes.push(async () => finishShutdown.resolve());
    sharedProof.beforeGraphRead = async (signal) => {
      sharedProof.beforeGraphRead = undefined;
      readBeforeShutdown.resolve(signal);
      await finishShutdown.promise;
    };
    try {
      const shutdownRequest = startDocumentProfileRequest(
        shared,
        shutdownPage.scopeId,
      );
      const shutdownSignal = await waitForProfilePhase(
        'the shutdown graph read',
        readBeforeShutdown.promise,
        shutdownRequest,
      );
      let joinedProof = false;
      const shutdown = shared.closeProfile().then(() => {
        joinedProof = true;
      });
      const refused = await shutdownRequest.response;
      expect(refused.status).toBe(404);
      expect(await refused.text()).toBe('');
      expect(shutdownSignal.aborted).toBe(true);
      expect(joinedProof).toBe(false);
      expect((await shared.invoke(sharedPage.scopeId)).status).toBe(200);
      finishShutdown.resolve();
      await shutdown;
      expect(joinedProof).toBe(true);
      expect((await shared.invoke(shutdownPage.scopeId)).status).toBe(200);
    } finally {
      finishShutdown.resolve();
    }

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

    async function pipelineAfterEvents(
      id: string,
      {
        awaitingId,
        errors = false,
        unrelated = false,
        onlyAsset = false,
        bootstrap = false,
        beforeQueued,
        beforeNext,
      }: {
        awaitingId?: string;
        errors?: boolean;
        unrelated?: boolean;
        onlyAsset?: boolean;
        bootstrap?: boolean;
        beforeQueued?: () => void;
        beforeNext?: () => Promise<void>;
      } = {},
      subject = f,
    ) {
      const worker = subject.worker.address() as AddressInfo;
      const client = createConnection({ host: '127.0.0.1', port: worker.port });
      const wire = observeProfileWire(client);
      const terminal = deferred<Error>();
      client.once('error', terminal.resolve);
      client.once('end', () => terminal.resolve(Error('Profile socket ended')));
      const closed = new Promise<void>((resolve) => {
        client.once('close', () => {
          terminal.resolve(Error('Profile socket closed'));
          resolve();
        });
      });
      function whileConnected<T>(work: Promise<T>) {
        return Promise.race([
          work,
          terminal.promise.then((error) => {
            throw error;
          }),
        ]);
      }
      async function disconnect() {
        client.destroy();
        await closed;
        await wire.dispose();
      }
      closes.push(disconnect);
      await once(client, 'connect', { signal: AbortSignal.timeout(5000) });

      const expected = unrelated
        ? 2
        : errors
          ? 3
          : awaitingId
            ? onlyAsset || bootstrap
              ? 3
              : 4
            : 1;
      const arrived = deferred();
      const responses: ServerResponse[] = [];
      const waiters: Array<{ waiting: Promise<void>; dispose: () => void }> =
        [];
      const observed = (request: IncomingMessage, response: ServerResponse) => {
        if (request.socket.remotePort !== client.localPort) return;
        const ready = deferred();
        const added = (name: string | symbol) => {
          if (name === 'socket') ready.resolve();
        };
        response.on('newListener', added);
        waiters.push({
          waiting: ready.promise,
          dispose: () => response.off('newListener', added),
        });
        responses.push(response);
        if (responses.length === expected) arrived.resolve();
      };
      subject.worker.prependListener('request', observed);
      const bindingRef = subject.owner.bindingRef;
      const events = subject.profileUrl('events', id, { bindingRef });
      const serialize = (url: URL, headers = '') =>
        `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${sessionToken}\r\n${headers}\r\n`;
      let firstHeaders: Headers;
      try {
        const head = unrelated
          ? new URL('/fixture-before-profile', events)
          : events;
        client.write(serialize(head));
        firstHeaders = await wire.head(200);
        expect(firstHeaders.get('transfer-encoding')).toBe('chunked');
        expect(firstHeaders.get('content-type')).toBe(
          unrelated ? 'text/plain' : 'text/event-stream; charset=utf-8',
        );
        const firstBody = await wire.chunk();
        expect(firstBody?.toString()).toBe(
          unrelated
            ? 'unrelated handler still running'
            : `data: ${JSON.stringify({ type: 'graph', graph })}\n\n`,
        );
        if (unrelated || errors) {
          const invalid = new URL(events);
          invalid.searchParams.append('scopeId', id);
          client.write(
            (unrelated ? '' : serialize(events)) +
              serialize(invalid, unrelated ? 'Connection: close\r\n' : ''),
          );
        } else if (awaitingId) {
          const asset = subject.profileUrl('assets', awaitingId, {
            bindingRef,
            graphRev: target.graphRev,
            manifestSha256: target.manifestSha256,
            path: largeAsset,
          });
          const invalid = new URL(asset);
          invalid.searchParams.set('path', 'managed/absent.js');
          const document = subject.profileUrl('bootstrap', id);
          beforeQueued?.();
          client.write(
            (bootstrap
              ? serialize(subject.profileUrl('bootstrap', awaitingId))
              : serialize(asset, 'x-allrice-profile-request: static\r\n')) +
              (onlyAsset || bootstrap
                ? ''
                : serialize(invalid, 'x-allrice-profile-request: static\r\n')),
          );
          if (beforeNext) await whileConnected(beforeNext());
          client.write(
            serialize(document, 'x-allrice-profile-request: document\r\n'),
          );
        }
        await whileConnected(arrived.promise);
        expect(responses).toHaveLength(expected);
        for (const [index, queued] of responses.entries()) {
          if (index < (beforeNext ? 2 : 1)) continue;
          await whileConnected(waiters[index]!.waiting);
          expect(queued.listenerCount('socket')).toBe(1);
        }
      } finally {
        subject.worker.off('request', observed);
        for (const waiter of waiters) waiter.dispose();
      }
      async function remaining(...statuses: (200 | 404)[]) {
        expect(await wire.body(firstHeaders)).toHaveLength(0);
        const bodies = [];
        for (const status of statuses) {
          const headers = await wire.head(status);
          if (unrelated) expect(headers.get('connection')).toBe('close');
          expect(headers.get('content-length')).not.toBe(
            String(largeBytes.length),
          );
          if (status === 404) expect(headers.get('content-length')).toBe('0');
          const data = await wire.body(headers);
          if (status === 404) expect(data).toHaveLength(0);
          bodies.push(data);
        }
        return bodies;
      }
      async function endFromWorker() {
        await wire.expectEnd();
        await closed;
      }
      return { responses, remaining, disconnect, endFromWorker };
    }
  },
);
