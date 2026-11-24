import { Agent, ClientRequest, createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { nativeWebTransport } from './transport.js';

const cleanup: (() => Promise<void>)[] = [];
function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  const close = socket.destroy.bind(socket);
  vi.spyOn(socket, 'destroy').mockImplementation((error) => {
    cancelling.resolve();
    void release.promise.then(() => close(error));
    return socket;
  });
  const closed = once(socket, 'close');
  const response = await reply.promise;
  const firstChunk = latch();
  const sawFirst = (raw: Buffer) => {
    if (raw.toString().includes('abc')) firstChunk.resolve();
  };
  socket.on('data', sawFirst);
  response.write('abc');
  await firstChunk.promise;
  socket.off('data', sawFirst);
  expect(settled).toBe(false);
  expect(socket.closed).toBe(false);
  response.write('d');
  await cancelling.promise;
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

it('joins its own created socket when canceled before ClientRequest assigns it', async () => {
  const server = createServer((_request, response) => response.end('abc'));
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
  const emit = ClientRequest.prototype.emit;
  vi.spyOn(ClientRequest.prototype, 'emit').mockImplementation(function (
    this: ClientRequest,
    event: string,
    ...args: unknown[]
  ) {
    if (this.path === '/before-assignment' && event === 'socket')
      assigned = true;
    return Reflect.apply(emit, this, [event, ...args]) as boolean;
  });
  let first = true;
  const reason = Error('stopped after physical creation, before assignment');
  const create = Agent.prototype.createConnection;
  vi.spyOn(Agent.prototype, 'createConnection').mockImplementation(function (
    this: Agent,
    ...args: Parameters<Agent['createConnection']>
  ) {
    const socket = create.apply(this, args);
    if (socket && first) {
      first = false;
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
  const independent = await transport.readExact(
    new URL('/other', origin),
    3,
    new AbortController().signal,
  );
  expect(Buffer.from(independent).toString()).toBe('abc');
  expect(settled).toBe(false);
  release.resolve();
  await physicallyClosed.promise;
  await expect(cancelled).rejects.toBe(reason);
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
