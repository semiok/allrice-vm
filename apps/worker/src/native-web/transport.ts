import {
  request,
  Agent,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket from 'ws';
import type {
  ConnectionWebSocket,
  RpcFetch,
} from '@deepseek-ai/dsh-client-connection/client';
import { PersonVmError } from '@allrice/person-vm';

/** Dedicated outbound resources; never the global fetch pool or a listener. */
export function nativeWebTransport(
  origin: string,
  signal: AbortSignal,
  lost: () => void,
) {
  const sockets = new Set<Duplex>(),
    websockets = new Set<WebSocket>();
  const calls = new Set<ClientRequest>();
  const joins = new Set<Promise<void>>();
  let cookie: string | undefined,
    closing = false;
  function joined(promise: Promise<void>) {
    joins.add(promise);
    void promise.then(() => joins.delete(promise));
  }
  function socketJoin(socket: Duplex) {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    joined(
      new Promise((done) =>
        socket.once('close', () => {
          sockets.delete(socket);
          done();
        }),
      ),
    );
  }
  const agent = new (class extends Agent {
    override createConnection(...args: Parameters<Agent['createConnection']>) {
      const socket = super.createConnection(...args);
      if (socket) socketJoin(socket); // Before ClientRequest's asynchronous assignment.
      return socket;
    }
  })({ keepAlive: false });
  function requestJoin(call: ClientRequest) {
    calls.add(call);
    joined(
      new Promise((done) =>
        call.once('close', () => {
          calls.delete(call);
          done();
        }),
      ),
    );
    call.on('socket', socketJoin);
  }
  function target(input: string | URL) {
    signal.throwIfAborted();
    const url = new URL(input, origin);
    if (
      closing ||
      url.origin !== new URL(origin).origin ||
      url.username ||
      url.password
    )
      throw new PersonVmError('PROVIDER_FAILED');
    return url;
  }
  function prepareRequest(
    input: string | URL,
    init: Parameters<RpcFetch>[1],
    receive: (response: IncomingMessage) => void,
  ) {
    const url = target(input);
    const headers = new Headers(init.headers);
    headers.set('host', url.host);
    headers.set('origin', new URL(origin).origin);
    if (cookie) headers.set('cookie', cookie);
    const callSignal = init.signal
      ? AbortSignal.any([signal, init.signal])
      : signal;
    // Native Connection unary calls provide their already encoded JSON string.
    const body = init.body;
    if (body !== undefined && body !== null && typeof body !== 'string')
      throw new PersonVmError('PROVIDER_FAILED');
    const call = request(
      url,
      {
        method: init.method,
        headers: Object.fromEntries(headers),
        agent,
        signal: callSignal,
      },
      receive,
    );
    requestJoin(call);
    return { call, send: () => call.end(body) };
  }
  const fetch: RpcFetch = (input, init) =>
    new Promise((resolve, reject) => {
      try {
        const { call, send } = prepareRequest(input, init, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('error', () =>
            reject(new PersonVmError('PROVIDER_FAILED')),
          );
          response.on('end', () => {
            try {
              const output = new Headers();
              for (const [key, value] of Object.entries(response.headers))
                for (const item of Array.isArray(value)
                  ? value
                  : value === undefined
                    ? []
                    : [value])
                  output.append(key, item);
              const body = Buffer.concat(chunks);
              resolve(
                new Response(
                  body.length ? Uint8Array.from(body).buffer : null,
                  {
                    status: response.statusCode!,
                    headers: output,
                  },
                ),
              );
            } catch {
              reject(new PersonVmError('PROVIDER_FAILED'));
            }
          });
        });
        // A closed, unanswered request is not a reply.
        call.once('close', () => reject(new PersonVmError('PROVIDER_FAILED')));
        call.on('error', () => reject(new PersonVmError('PROVIDER_FAILED')));
        send();
      } catch {
        reject(new PersonVmError('PROVIDER_FAILED'));
      }
    });
  /** Profile attestation already holds the sealed length. Limit the actual
   * response stream and keep ownership through physical cancellation. */
  async function readExact(
    input: URL,
    bytes: number,
    caller: AbortSignal,
  ): Promise<Uint8Array> {
    const active = AbortSignal.any([signal, caller]);
    active.throwIfAborted();
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new PersonVmError('PROVIDER_FAILED');
    const data = Buffer.allocUnsafe(bytes);
    return new Promise((resolve, reject) => {
      let received = 0;
      let complete = false;
      let failure: { reason: unknown } | undefined;
      let socket: Duplex | undefined;
      const fail = () => {
        failure ??= {
          reason: active.aborted
            ? active.reason
            : new PersonVmError('PROVIDER_FAILED'),
        };
      };
      const { call, send } = prepareRequest(
        input,
        { method: 'GET', headers: { connection: 'close' }, signal: active },
        (response) => {
          response.once('error', fail);
          if (response.statusCode !== 200) {
            fail();
            response.destroy();
            return;
          }
          response.on('data', (chunk: Buffer) => {
            if (failure) return;
            if (chunk.length > data.length - received) {
              fail();
              response.destroy();
              return;
            }
            received += chunk.copy(data, received);
          });
          response.once('end', () => {
            complete = received === data.length;
            if (!complete) fail();
          });
        },
      );
      call.once('socket', (assigned) => (socket = assigned));
      call.on('error', fail);
      call.once('close', () => {
        const finish = () => {
          if (!complete || active.aborted) fail();
          if (failure) reject(failure.reason);
          else resolve(data);
        };
        if (socket && !socket.closed) socket.once('close', finish);
        else finish();
      });
      send();
    });
  }
  return {
    fetch,
    readExact,
    async authenticate(authenticatedUrl: string) {
      const url = target(authenticatedUrl);
      url.pathname = '/connect';
      url.searchParams.set('interactions', 'none');
      const response = await fetch(url, { method: 'GET', redirect: 'manual' });
      const values = response.headers.getSetCookie();
      if (
        response.status !== 302 ||
        response.headers.get('location') !== './api/remote.mux' ||
        values.length !== 1
      )
        throw new PersonVmError('PROVIDER_FAILED');
      cookie = values[0]!.split(';', 1)[0]!;
    },
    createWebSocket(input: string): ConnectionWebSocket {
      const url = new URL(input);
      const http = new URL(url);
      http.protocol = 'http:';
      target(http);
      if (
        url.protocol !== 'ws:' ||
        url.pathname !== '/api/remote.mux' ||
        url.search ||
        !cookie
      )
        throw new PersonVmError('PROVIDER_FAILED');
      let socket: WebSocket;
      try {
        socket = new WebSocket(url, {
          agent,
          finishRequest(call) {
            requestJoin(call);
            call.end();
          },
          headers: {
            Cookie: cookie,
            Host: url.host,
            Origin: new URL(origin).origin,
          },
        });
      } catch {
        throw new PersonVmError('PROVIDER_FAILED');
      }
      websockets.add(socket);
      socket.on('error', () => {}); // Native carrier owns its typed failure; never log credential URLs.
      joined(
        new Promise((done) =>
          socket.once('close', () => {
            websockets.delete(socket);
            if (!closing) lost();
            done();
          }),
        ),
      );
      return socket as unknown as ConnectionWebSocket;
    },
    async close() {
      closing = true;
      cookie = undefined;
      agent.destroy();
      for (const call of calls) call.destroy();
      for (const socket of sockets) socket.destroy();
      for (const socket of websockets) socket.terminate();
      while (joins.size) await Promise.all([...joins]);
    },
  };
}
