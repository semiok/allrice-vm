import { Agent, ClientRequest, createServer, IncomingMessage } from 'node:http';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { nativeIndexByteLimit, nativeWebTransport } from './transport.js';
import { nativeSetupError } from './startup-diagnostic.js';

const cleanup: (() => Promise<void>)[] = [];
function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function watchClient(
  inspect: (
    request: ClientRequest,
    event: string | symbol,
    args: unknown[],
  ) => void,
) {
  const emit = ClientRequest.prototype.emit;
  vi.spyOn(ClientRequest.prototype, 'emit').mockImplementation(function (
    this: ClientRequest,
    event: string | symbol,
    ...args: unknown[]
  ) {
    inspect(this, event, args);
    return Reflect.apply(emit, this, [event, ...args]) as boolean;
  });
}
function parsedPrefix(size: number) {
  const parsed = latch<number>();
  return {
    observe(response: IncomingMessage) {
      let bytes = 0;
      const account = (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes >= size) {
          response.off('data', account);
          parsed.resolve(bytes);
        }
      };
      response.on('data', account);
    },
    promise: parsed.promise,
  };
}
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  vi.restoreAllMocks();
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
});

it('keeps the native index exchange private and separate from API and resource requests', async () => {
  const seen: [string, string | undefined][] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url!, 'http://fixture').pathname;
    seen.push([pathname, request.headers.cookie]);
    if (pathname === '/connect') {
      response.writeHead(302, {
        location: './api/remote.mux',
        'set-cookie': 'fixture-api=owner; HttpOnly',
      });
    } else if (request.url?.startsWith('/?token=')) {
      response.writeHead(303, {
        location: './',
        'set-cookie': 'fixture-index=browser; HttpOnly',
      });
    } else {
      if (pathname === '/') response.setHeader('content-type', 'text/html');
      response.write('abc');
    }
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const active = new AbortController().signal;
  const transport = nativeWebTransport(origin, active, () => {});
  cleanup.push(async () => {
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const nativeLaunch = origin + '/?token=fixture-only';
  await transport.authenticate(nativeLaunch);
  await transport.authenticateIndex(nativeLaunch);
  expect(await transport.readIndex(active)).toBe('abc');
  expect(
    await (await transport.fetch(origin + '/api', { method: 'GET' })).text(),
  ).toBe('abc');
  expect(
    Buffer.from(
      await transport.readExact(new URL('/plugins/', origin), 3, active),
    ).toString(),
  ).toBe('abc');
  expect(seen).toEqual([
    ['/connect', undefined],
    ['/', undefined],
    ['/', 'fixture-index=browser'],
    ['/api', 'fixture-api=owner'],
    ['/plugins/', undefined],
  ]);
});

it.each([
  'status',
  'media',
  'announced bytes',
  'received bytes',
  'cancel',
] as const)(
  'closes and joins only the authenticated index with invalid %s',
  async (cause) => {
    const first = latch<ServerResponse>();
    const second = latch<ServerResponse>();
    const browserCookies: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      browserCookies.push(request.headers.cookie);
      if (request.url === '/?token=index') {
        response
          .writeHead(303, {
            location: './',
            'set-cookie': 'fixture-index=browser; HttpOnly',
          })
          .end();
      } else if (browserCookies.length === 2) first.resolve(response);
      else second.resolve(response);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const transport = nativeWebTransport(
      origin,
      new AbortController().signal,
      () => {},
    );
    cleanup.push(async () => {
      await transport.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    await transport.authenticateIndex(origin + '/?token=index');
    const sockets: Duplex[] = [];
    const create = Agent.prototype.createConnection;
    vi.spyOn(Agent.prototype, 'createConnection').mockImplementation(function (
      this: Agent,
      ...args: Parameters<Agent['createConnection']>
    ) {
      const socket = create.apply(this, args);
      if (socket) sockets.push(socket);
      return socket;
    });
    const parsingFirst = parsedPrefix(
      cause === 'received bytes' ? nativeIndexByteLimit : 3,
    );
    const parsingSecond = parsedPrefix(3);
    watchClient((_request, event, [response]) => {
      if (event !== 'response' || !(response instanceof IncomingMessage))
        return;
      if (response.headers['x-fixture-index'] === 'A')
        parsingFirst.observe(response);
      else parsingSecond.observe(response);
    });
    const cancellation = new AbortController();
    const canceled = Error('Only the first verified native index was canceled');
    const bad = transport.readIndex(cancellation.signal);
    void bad.catch(() => {});
    const a = await first.promise;
    const good = transport.readIndex(new AbortController().signal);
    const b = await second.promise;
    b.writeHead(200, { 'content-type': 'text/html', 'x-fixture-index': 'B' });
    b.write('abc');
    expect(await parsingSecond.promise).toBe(3);
    const [firstSocket, secondSocket] = sockets;
    expect(firstSocket?.closed).toBe(false);
    expect(secondSocket?.closed).toBe(false);
    a.writeHead(cause === 'status' ? 503 : 200, {
      'content-type': cause === 'media' ? 'application/json' : 'text/html',
      'x-fixture-index': 'A',
      ...(cause === 'announced bytes' && {
        'content-length': nativeIndexByteLimit + 1,
      }),
    });
    a.flushHeaders();
    if (cause === 'received bytes') {
      a.write(Buffer.alloc(nativeIndexByteLimit, 'x'));
      expect(await parsingFirst.promise).toBe(nativeIndexByteLimit);
      expect(firstSocket?.destroyed).toBe(false);
      a.write('!');
    } else if (cause === 'cancel') {
      a.write('one');
      expect(await parsingFirst.promise).toBe(3);
      cancellation.abort(canceled);
    }
    if (cause === 'cancel') await expect(bad).rejects.toBe(canceled);
    else await expect(bad).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(firstSocket?.closed).toBe(true);
    expect(secondSocket?.closed).toBe(false);
    b.end('def');
    expect(await good).toBe('abcdef');
    expect(secondSocket?.closed).toBe(true);
    expect(browserCookies).toEqual([
      undefined,
      'fixture-index=browser',
      'fixture-index=browser',
    ]);
  },
);

it('bounds actual streamed profile bytes and joins the socket of an oversized response before rejecting', async () => {
  const reply = latch<ServerResponse>();
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.flushHeaders();
    reply.resolve(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const assigned = latch<Duplex>();
  const prefix = parsedPrefix(3);
  watchClient((_call, event, [response]) => {
    if (event === 'response' && response instanceof IncomingMessage)
      prefix.observe(response);
  });
  const create = Agent.prototype.createConnection;
  vi.spyOn(Agent.prototype, 'createConnection').mockImplementation(function (
    this: Agent,
    ...args: Parameters<Agent['createConnection']>
  ) {
    const socket = create.apply(this, args);
    if (socket) assigned.resolve(socket);
    return socket;
  });
  const transport = nativeWebTransport(
    origin,
    new AbortController().signal,
    () => {},
  );
  const release = latch();
  cleanup.push(async () => {
    release.resolve();
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const reading = transport.readExact(
    new URL('/plugins/?test=oversized', origin),
    3,
    new AbortController().signal,
  );
  let settled = false;
  void reading.then(
    () => (settled = true),
    () => (settled = true),
  );
  const socket = await assigned.promise;
  const cancelling = latch();
  let destroyStarted = false;
  const close = socket.destroy.bind(socket);
  vi.spyOn(socket, 'destroy').mockImplementation((error) => {
    destroyStarted = true;
    cancelling.resolve();
    void release.promise.then(() => close(error));
    return socket;
  });
  const closed = once(socket, 'close');
  const response = await reply.promise;
  response.write('abc');
  expect(await prefix.promise).toBe(3);
  expect(destroyStarted).toBe(false);
  expect(settled).toBe(false);
  expect(socket.closed).toBe(false);
  response.write('d');
  await cancelling.promise;
  expect(destroyStarted).toBe(true);
  expect(response.writableEnded).toBe(false);
  expect(settled).toBe(false);
  expect(socket.closed).toBe(false);
  release.resolve();
  await closed;
  await expect(reading).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
});

it('rejects contradictory profile length headers without waiting for body bytes', async () => {
  const reply = latch<ServerResponse>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': '4' });
    response.flushHeaders();
    reply.resolve(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const active = new AbortController();
  const transport = nativeWebTransport(origin, active.signal, () => {});
  cleanup.push(async () => {
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const reading = transport.readExact(new URL(origin), 3, active.signal);
  const response = await reply.promise;
  const closed = once(response, 'close');
  await expect(reading).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  await closed;
  expect(response.writableEnded).toBe(false);
});

for (const otherStarted of [false, true])
  it(`joins its own created socket before assignment, with the other reader ${otherStarted ? 'already pending' : 'starting later'}`, async () => {
    const otherResponse = latch<ServerResponse>();
    const server = createServer((request, response) => {
      if (otherStarted && request.url === '/other') {
        response.write('a');
        otherResponse.resolve(response);
      } else response.end('abc');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const caller = new AbortController();
    const transport = nativeWebTransport(
      origin,
      new AbortController().signal,
      () => {},
    );
    const cancelling = latch();
    const release = latch();
    const physicallyClosed = latch();
    cleanup.push(async () => {
      release.resolve();
      await transport.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    let assigned = false;
    const prefix = parsedPrefix(1);
    watchClient((call, event, [response]) => {
      if (call.path === '/before-assignment' && event === 'socket')
        assigned = true;
      if (
        call.path === '/other' &&
        event === 'response' &&
        response instanceof IncomingMessage
      )
        prefix.observe(response);
    });
    let arm = false;
    const reason = Error('stopped after physical creation, before assignment');
    const create = Agent.prototype.createConnection;
    vi.spyOn(Agent.prototype, 'createConnection').mockImplementation(function (
      this: Agent,
      ...args: Parameters<Agent['createConnection']>
    ) {
      const socket = create.apply(this, args);
      if (socket && arm) {
        arm = false;
        const destroy = socket.destroy.bind(socket);
        socket.once('close', () => physicallyClosed.resolve());
        vi.spyOn(socket, 'destroy').mockImplementation((error) => {
          cancelling.resolve();
          void release.promise.then(() => destroy(error));
          return socket;
        });
        caller.abort(reason);
      }
      return socket;
    });
    const readOther = () =>
      transport.readExact(
        new URL('/other', origin),
        3,
        new AbortController().signal,
      );
    const earlier = otherStarted ? readOther() : undefined;
    let earlierSettled = false;
    void earlier?.then(
      () => (earlierSettled = true),
      () => (earlierSettled = true),
    );
    if (earlier) expect(await prefix.promise).toBe(1);
    arm = true;
    const cancelled = transport.readExact(
      new URL('/before-assignment', origin),
      3,
      caller.signal,
    );
    let settled = false;
    void cancelled.then(
      () => (settled = true),
      () => (settled = true),
    );
    await cancelling.promise;
    expect(assigned).toBe(false);
    if (!earlier) expect(Buffer.from(await readOther()).toString()).toBe('abc');
    expect(settled).toBe(false);
    release.resolve();
    await physicallyClosed.promise;
    await expect(cancelled).rejects.toBe(reason);
    if (earlier) {
      const response = await otherResponse.promise;
      expect(earlierSettled).toBe(false);
      expect(response.writableEnded).toBe(false);
      expect(response.destroyed).toBe(false);
      response.end('bc');
      expect(Buffer.from(await earlier).toString()).toBe('abc');
    }
  });

it('rejects an actual short body and joins a caller-canceled bounded reader with its original reason', async () => {
  const waiting = latch();
  const server = createServer((request, response) => {
    if (request.url === '/cancel') {
      response.write('a');
      waiting.resolve();
    } else if (request.url === '/declared') {
      response.writeHead(200, { 'content-length': '3' });
      response.end('abc');
    } else {
      response.write(request.url === '/exact' ? 'abc' : 'ab');
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const caller = new AbortController();
  const transport = nativeWebTransport(
    origin,
    new AbortController().signal,
    () => {},
  );
  cleanup.push(async () => {
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const read = (path: string) =>
    transport.readExact(new URL(path, origin), 3, caller.signal);
  expect(Buffer.from(await read('/exact')).toString()).toBe('abc');
  expect(Buffer.from(await read('/declared')).toString()).toBe('abc');
  await expect(read('/short')).rejects.toMatchObject({
    code: 'PROVIDER_FAILED',
  });
  const cancellation = read('/cancel');
  await waiting.promise;
  const reason = Error('proof reader revoked by its caller');
  caller.abort(reason);
  await expect(cancellation).rejects.toBe(reason);
});

for (const accepted of [false, true])
  it(`close joins exact HTTP request ${accepted ? 'after accept' : 'before socket assignment'}`, async () => {
    // Transport-only close fixture; never a dummy DSH RPC/readiness server.
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const server = createServer(() => enter());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const transport = nativeWebTransport(
      origin,
      new AbortController().signal,
      () => {},
    );
    cleanup.push(async () => {
      await transport.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    let settled = false;
    const call = transport.fetch(new URL('/', origin), { method: 'GET' }).then(
      () => {
        settled = true;
        throw Error('fixture must not respond');
      },
      () => {
        settled = true;
      },
    );
    if (accepted) await entered;
    await transport.close();
    expect(settled).toBe(true);
    await call;
    await expect(
      transport.fetch(new URL('/', origin), { method: 'GET' }),
    ).rejects.toBeDefined();
  });

it.each(['http', 'invalid-upgrade', 'reset'] as const)(
  'captures the original WebSocket %s failure before reporting loss',
  async (kind) => {
    const server = createServer((_request, response) => {
      response.writeHead(302, {
        location: './api/remote.mux',
        'set-cookie': 'private=synthetic-api-cookie',
      });
      response.end();
    });
    server.on('upgrade', (_request, socket) => {
      if (kind === 'reset') socket.destroy();
      else if (kind === 'invalid-upgrade')
        socket.end(
          'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: invalid\r\n\r\n',
        );
      else
        socket.end(
          'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const lost = latch(),
      observations: ReturnType<typeof nativeSetupError>[] = [];
    const sources: string[] = [];
    const headers: number[] = [];
    const transport = nativeWebTransport(
      origin,
      new AbortController().signal,
      () => lost.resolve(),
      (error, status, failed, source) => {
        if (!failed && source === 'websocket' && status !== undefined)
          headers.push(status);
        // The owner keeps the first observation; the subsequent close is loss.
        if (failed && !observations.length) {
          observations.push(nativeSetupError(error, status));
          sources.push(source);
        }
      },
    );
    cleanup.push(async () => {
      await transport.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    await transport.authenticate(origin + '/?token=synthetic-startup-token');
    transport.createWebSocket(
      origin.replace('http:', 'ws:') + '/api/remote.mux',
    );
    await lost.promise;
    expect(sources).toEqual(['websocket']);
    expect(headers).toEqual(
      kind === 'reset' ? [] : [kind === 'invalid-upgrade' ? 101 : 404],
    );
    expect(observations).toEqual([
      kind === 'reset'
        ? { errorType: 'SystemError', errorCode: 'ECONNRESET' }
        : {
            errorType: 'HttpError',
            errorCode: 'UNEXPECTED_HTTP_RESPONSE',
            httpStatus: kind === 'invalid-upgrade' ? 101 : 404,
          },
    ]);
  },
);

for (const accepted of [false, true])
  it(`WS handshake close joins physical request/socket ${accepted ? 'after TCP/Upgrade request' : 'before socket assignment'}`, async () => {
    const created: {
      socket: Duplex;
      closed: Promise<void>;
      didClose: boolean;
    }[] = [];
    const create = Agent.prototype.createConnection;
    vi.spyOn(Agent.prototype, 'createConnection').mockImplementation(function (
      this: Agent,
      ...args: Parameters<Agent['createConnection']>
    ) {
      const socket = create.apply(this, args);
      if (socket) {
        const record = {
          socket,
          didClose: false,
          closed: new Promise<void>((done) =>
            socket.once('close', () => {
              record.didClose = true;
              done();
            }),
          ),
        };
        created.push(record);
      }
      return socket;
    });
    const upgraded = latch(),
      serverSockets = new Set<Socket>();
    const server = createServer((_request, response) => {
      response.writeHead(302, {
        location: './api/remote.mux',
        'set-cookie': 'synthetic-native-cookie=transport-only; HttpOnly',
      });
      response.end();
    });
    server.on('connection', (socket) => {
      serverSockets.add(socket);
      socket.once('close', () => serverSockets.delete(socket));
    });
    // Accept the TCP/Upgrade request, deliberately never complete the handshake.
    server.on('upgrade', () => upgraded.resolve());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const transport = nativeWebTransport(
      origin,
      new AbortController().signal,
      () => {},
    );
    cleanup.push(async () => {
      await transport.close();
      for (const socket of serverSockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    });
    await transport.authenticate(`${origin}/?token=synthetic-transport-only`);
    await Promise.all(created.map((record) => record.closed));
    const before = created.length;
    const ws = transport.createWebSocket(
      `${origin.replace('http:', 'ws:')}/api/remote.mux`,
    ) as unknown as WebSocket;
    expect(created).toHaveLength(before + 1);
    const physical = created[before]!;
    const logicalClose = new Promise<void>((done) =>
      ws.once('close', () => done()),
    );
    if (accepted) await upgraded.promise;
    let settled = false;
    const closed = transport.close().then(() => {
      settled = true;
    });
    await logicalClose;
    if (!physical.didClose) expect(settled).toBe(false);
    await closed;
    expect(physical.didClose).toBe(true);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(() =>
      transport.createWebSocket(
        `${origin.replace('http:', 'ws:')}/api/remote.mux`,
      ),
    ).toThrow();
  });
