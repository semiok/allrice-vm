import {
  request,
  Agent,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket from 'ws';
import type {
  ConnectionWebSocket,
  RpcFetch,
} from '@deepseek-ai/dsh-client-connection/client';
import { PersonVmError } from '@allrice/person-vm';

export const nativeIndexByteLimit = 1024 * 1024;
// rc.2 includes retained projection previews in both session reads.
const nativeActivityHistoryByteLimit = 8 * 1024 * 1024;
const nativeUnaryByteLimits: Partial<Record<NativeOwnedUnary, number>> = {
  'session/create': 16 * 1024,
  'session/list': nativeActivityHistoryByteLimit,
  'session/projections': nativeActivityHistoryByteLimit,
};

export type NativeOwnedUnary =
  | 'session/create'
  | 'session/modelCatalog'
  | 'session/list'
  | 'session/projections'
  | 'workspace/create'
  | 'goals/get'
  | 'schedule/catalog';

/** Dedicated outbound resources; never the global fetch pool or a listener. */
export function nativeWebTransport(
  origin: string,
  signal: AbortSignal,
  lost: () => void,
  observeStartup?: (
    error: unknown,
    status: number | undefined,
    failed: boolean,
    source: 'http' | 'websocket',
  ) => void | Promise<void>,
) {
  const sockets = new Set<Duplex>(),
    websockets = new Set<WebSocket>();
  const calls = new Set<ClientRequest>();
  const joins = new Set<Promise<void>>();
  let cookie: string | undefined,
    indexCookie: string | undefined,
    closing = false;
  function observe(
    error: unknown,
    status?: number,
    failed = true,
    source: 'http' | 'websocket' = 'http',
  ) {
    try {
      return observeStartup?.(error, status, failed, source);
    } catch {
      // Observability cannot change the native transport outcome.
    }
  }
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
    rpc = false,
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      let status: number | undefined;
      let responded = false;
      const rejectResponse = (error?: unknown) => {
        if (!responded) observe(error, status);
        reject(new PersonVmError('PROVIDER_FAILED'));
      };
      try {
        const { call, send } = prepareRequest(
          input,
          init,
          (response) => {
            status = response.statusCode;
            observe(undefined, status, false);
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('error', rejectResponse);
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
                const result = new Response(
                  body.length ? Uint8Array.from(body).buffer : null,
                  { status: response.statusCode!, headers: output },
                );
                responded = true;
                if (rpc) observe(undefined, result.status, !result.ok);
                resolve(result);
              } catch (error) {
                rejectResponse(error);
              }
            });
          },
          agent,
          credential,
        );
        // A closed, unanswered request is not a reply.
        call.once('close', () => rejectResponse());
        call.on('error', rejectResponse);
        send();
      } catch (error) {
        rejectResponse(error);
      }
    });
  const fetch: RpcFetch = (input, init) =>
    requestResponse(input, init, 'api', true);
  /** Each finite proof reads only its own bounded response and keeps
   * ownership through physical shutdown. */
  async function readOwned(
    input: URL,
    caller: AbortSignal,
    bounds: {
      maxBytes: number;
      exact?: number;
      credential: 'none' | 'index' | 'api';
      accepts(response: IncomingMessage): boolean;
      body?: string;
      onChunk?(chunk: Buffer): void;
    },
  ): Promise<{ data: Buffer; headers: IncomingHttpHeaders }> {
    const active = AbortSignal.any([signal, caller]);
    active.throwIfAborted();
    const fixed =
      bounds.exact === undefined ? undefined : Buffer.allocUnsafe(bounds.exact);
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      let received = 0;
      let responseStatus: number | undefined;
      let complete: IncomingHttpHeaders | undefined;
      let failure: { reason: unknown; audit?: Promise<void> } | undefined;
      let physicalClose: Promise<void> | undefined;
      // This agent owns exactly this request, even when the request dies
      // before Node assigns the already created socket to ClientRequest.
      const connection = newAgent((socket) => {
        physicalClose = new Promise<void>((done) => {
          if (socket.closed) done();
          else socket.once('close', done);
        });
      });
      const fail = (error?: unknown) => {
        if (failure) return failure.audit;
        const reason = active.aborted
          ? active.reason
          : new PersonVmError('PROVIDER_FAILED');
        const audit = observe(active.aborted ? reason : error, responseStatus);
        failure = { reason, audit: audit || undefined };
        return audit;
      };
      function discard(response: IncomingMessage, audit: void | Promise<void>) {
        if (audit) {
          const destroy = () => {
            response.destroy();
          };
          void audit.then(destroy, destroy);
        } else response.destroy();
      }
      const { call, send } = prepareRequest(
        input,
        {
          method: bounds.body === undefined ? 'GET' : 'POST',
          headers: {
            connection: 'close',
            ...(bounds.body !== undefined && {
              'content-type': 'application/json',
            }),
          },
          body: bounds.body,
          signal: active,
        },
        (response) => {
          responseStatus = response.statusCode;
          observe(undefined, responseStatus, false);
          response.once('error', fail);
          const declared = response.headers['content-length'];
          if (
            !bounds.accepts(response) ||
            (declared !== undefined &&
              /^\d+$/.test(declared) &&
              (bounds.exact === undefined
                ? BigInt(declared) > BigInt(bounds.maxBytes)
                : BigInt(declared) !== BigInt(bounds.exact)))
          ) {
            discard(response, fail());
            return;
          }
          response.on('data', (chunk: Buffer) => {
            if (failure) return;
            if (chunk.length > bounds.maxBytes - received) {
              discard(response, fail());
              return;
            }
            if (fixed) chunk.copy(fixed, received);
            else chunks.push(chunk);
            received += chunk.length;
            try {
              bounds.onChunk?.(chunk);
            } catch (reason) {
              const audit = observe(reason, responseStatus);
              failure = { reason, audit: audit || undefined };
              discard(response, audit);
            }
          });
          response.once('end', () => {
            if (bounds.exact !== undefined && received !== bounds.exact) fail();
            else complete = response.headers;
          });
        },
        connection,
        bounds.credential,
      );
      call.on('error', fail);
      call.once('close', () => {
        void (async () => {
          await physicalClose;
          if (active.aborted || !complete) fail();
          // Preserve the actual socket join. An explicit local teardown can
          // follow the bounded startup audit when a diagnostic was needed.
          if (failure?.audit) await failure.audit.catch(() => {});
          connection.destroy();
          if (failure) reject(failure.reason);
          else if (complete)
            resolve({
              data: fixed ?? Buffer.concat(chunks, received),
              headers: complete,
            });
        })();
      });
      send();
    });
  }
  async function readExact(
    input: URL,
    bytes: number,
    caller: AbortSignal,
  ): Promise<Uint8Array> {
    AbortSignal.any([signal, caller]).throwIfAborted();
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new PersonVmError('PROVIDER_FAILED');
    return (
      await readOwned(input, caller, {
        maxBytes: bytes,
        exact: bytes,
        credential: 'none',
        accepts: ({ statusCode }) => statusCode === 200,
      })
    ).data;
  }
  return {
    fetch,
    readExact,
    async readManagedModelProof(
      body: string,
      caller: AbortSignal,
      image = false,
      onChunk?: (chunk: Buffer) => void,
    ) {
      if (!cookie) throw new PersonVmError('PROVIDER_FAILED');
      const { data } = await readOwned(
        new URL('api/allrice-managed-model/current', origin),
        caller,
        {
          maxBytes: image
            ? Math.ceil((20 * 1024 * 1024 * 4) / 3) + 16_384
            : 24 * 1024,
          credential: 'api',
          body,
          onChunk,
          accepts: ({ statusCode, headers }) =>
            onChunk
              ? statusCode === 200 &&
                headers['content-type'] === 'text/plain; charset=utf-8'
              : statusCode === 200 || statusCode === 404,
        },
      );
      return data.length ? data.toString('utf8') : null;
    },
    async readUnaryReply(
      method: NativeOwnedUnary,
      body: string,
      caller: AbortSignal,
    ) {
      if (!cookie) throw new PersonVmError('PROVIDER_FAILED');
      const { data } = await readOwned(
        new URL('api/' + method, origin),
        caller,
        {
          maxBytes: nativeUnaryByteLimits[method] ?? nativeIndexByteLimit,
          credential: 'api',
          body,
          accepts: ({ statusCode, headers }) =>
            statusCode === 200 &&
            headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ===
              'application/json',
        },
      );
      return data.toString('utf8');
    },
    async authenticate(authenticatedUrl: string) {
      const url = target(authenticatedUrl);
      url.pathname = '/connect';
      url.searchParams.set('interactions', 'none');
      const response = await requestResponse(
        url,
        { method: 'GET', redirect: 'manual' },
        'api',
      );
      const values = response.headers.getSetCookie();
      if (
        response.status !== 302 ||
        response.headers.get('location') !== './api/remote.mux' ||
        values.length !== 1
      ) {
        observe(undefined, response.status);
        throw new PersonVmError('PROVIDER_FAILED');
      }
      cookie = values[0]!.split(';', 1)[0]!;
    },
    async authenticateIndex(authenticatedUrl: string) {
      const url = target(authenticatedUrl);
      if (url.pathname !== '/') throw new PersonVmError('PROVIDER_FAILED');
      const response = await readOwned(url, signal, {
        maxBytes: 4096,
        credential: 'none',
        accepts: ({ statusCode, headers }) =>
          statusCode === 303 &&
          headers.location === './' &&
          headers['set-cookie']?.length === 1,
      });
      indexCookie = response.headers['set-cookie']![0]!.split(';', 1)[0]!;
    },
    async readIndex(signal: AbortSignal) {
      if (!indexCookie) throw new PersonVmError('PROVIDER_FAILED');
      const { data } = await readOwned(new URL('/', origin), signal, {
        maxBytes: nativeIndexByteLimit,
        credential: 'index',
        accepts: ({ statusCode, headers }) =>
          statusCode === 200 &&
          headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ===
            'text/html',
      });
      return data.toString('utf8');
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
      let responseStatus: number | undefined;
      try {
        socket = new WebSocket(url, {
          agent,
          finishRequest(call) {
            requestJoin(call);
            // A normal listener on ws's unexpected-response event would
            // take ownership of rejection. Observe the HTTP response only.
            const captureStatus = (response: IncomingMessage) => {
              responseStatus = response.statusCode;
              observe(undefined, responseStatus, false, 'websocket');
            };
            call.prependListener('response', captureStatus);
            call.prependListener('upgrade', captureStatus);
            call.end();
          },
          headers: {
            Cookie: cookie,
            Host: url.host,
            Origin: new URL(origin).origin,
          },
        });
      } catch (error) {
        observe(error, responseStatus, true, 'websocket');
        throw new PersonVmError('PROVIDER_FAILED');
      }
      websockets.add(socket);
      socket.on('error', (error) =>
        observe(error, responseStatus, true, 'websocket'),
      );
      joined(
        new Promise((done) =>
          socket.once('close', () => {
            websockets.delete(socket);
            if (!closing) {
              observe(
                new PersonVmError('PROVIDER_FAILED'),
                responseStatus,
                true,
                'websocket',
              );
              lost();
            }
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
