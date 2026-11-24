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
    indexCookie: string | undefined,
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
  function newAgent(ownSocket?: (socket: Duplex) => void) {
    return new (class extends Agent {
      override createConnection(
        ...args: Parameters<Agent['createConnection']>
      ) {
        const socket = super.createConnection(...args);
        if (socket) {
          socketJoin(socket);
          ownSocket?.(socket);
        }
        return socket;
      }
    })({ keepAlive: false });
  }
  const agent = newAgent();
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
    connectionPool = agent,
    credential: 'api' | 'index' | 'none' = 'api',
  ) {
    const url = target(input);
    const headers = new Headers(init.headers);
    headers.set('host', url.host);
    headers.set('origin', new URL(origin).origin);
    headers.delete('cookie');
    const selected =
      credential === 'api'
        ? cookie
        : credential === 'index'
          ? indexCookie
          : undefined;
    if (selected) headers.set('cookie', selected);
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
        agent: connectionPool,
        signal: callSignal,
      },
      receive,
    );
    requestJoin(call);
    return { call, send: () => call.end(body) };
  }
  const requestResponse = (
    input: Parameters<RpcFetch>[0],
    init: Parameters<RpcFetch>[1],
    credential: 'api' | 'index' | 'none',
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      try {
        const { call, send } = prepareRequest(
          input,
          init,
          (response) => {
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
          },
          agent,
          credential,
        );
        // A closed, unanswered request is not a reply.
        call.once('close', () => reject(new PersonVmError('PROVIDER_FAILED')));
        call.on('error', () => reject(new PersonVmError('PROVIDER_FAILED')));
        send();
      } catch {
        reject(new PersonVmError('PROVIDER_FAILED'));
      }
    });
  const fetch: RpcFetch = (input, init) => requestResponse(input, init, 'api');
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
      let physicalClose: Promise<void> | undefined;
      // This agent owns exactly this request, even when the request dies
      // before Node assigns the already created socket to ClientRequest.
      const connection = newAgent((socket) => {
        physicalClose = new Promise<void>((done) => {
          if (socket.closed) done();
          else socket.once('close', done);
        });
      });
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
          const declared = response.headers['content-length'];
          if (
            response.statusCode !== 200 ||
            (declared !== undefined &&
              /^\d+$/.test(declared) &&
              BigInt(declared) !== BigInt(bytes))
          ) {
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
        connection,
        'none',
      );
      call.on('error', fail);
      call.once('close', () => {
        void (async () => {
          await physicalClose;
          connection.destroy();
          if (!complete || active.aborted) fail();
          if (failure) reject(failure.reason);
          else resolve(data);
        })();
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
    async authenticateIndex(authenticatedUrl: string) {
      const url = target(authenticatedUrl);
      if (url.pathname !== '/') throw new PersonVmError('PROVIDER_FAILED');
      const response = await requestResponse(
        url,
        { method: 'GET', redirect: 'manual' },
        'none',
      );
      const values = response.headers.getSetCookie();
      if (
        response.status !== 303 ||
        response.headers.get('location') !== './' ||
        values.length !== 1
      )
        throw new PersonVmError('PROVIDER_FAILED');
      indexCookie = values[0]!.split(';', 1)[0]!;
    },
    readIndex(signal: AbortSignal) {
      if (!indexCookie) throw new PersonVmError('PROVIDER_FAILED');
      return requestResponse(
        new URL('/', origin),
        { method: 'GET', redirect: 'error', signal },
        'index',
      );
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
      indexCookie = undefined;
      agent.destroy();
      for (const call of calls) call.destroy();
      for (const socket of sockets) socket.destroy();
      for (const socket of websockets) socket.terminate();
      while (joins.size) await Promise.all([...joins]);
    },
  };
}
