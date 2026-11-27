import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { addAbortListener } from 'node:events';
import { BlockList, connect, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import {
  createSandboxPublicTlsClientHelloReader,
  resolvePublicAddresses,
  sandboxPublicAddress,
} from '@allrice/project-runtime';
import { EgressError } from './contract.js';

const denied = () => new EgressError('DENIED');
const proxyUser = 'vm-proxy';
const statuses = {
  403: 'Forbidden',
  407: 'Proxy Authentication Required',
  502: 'Bad Gateway',
};

export function publicProxyTarget(target: string, tunnel: boolean) {
  const parts =
    tunnel && /^(?:\[[\da-f:.]+\]|[^:\s#/?@%\\]+):(\d{1,5})$/i.exec(target);
  if (tunnel && !parts) throw denied();
  if (!tunnel && !/^http:\/\//i.test(target)) throw denied();
  if (/[\s\\]/u.test(target) || target.includes('#')) throw denied();
  const url = new URL(tunnel ? `http://${target}` : target);
  const port = Number(parts ? parts[1] : url.port || 80);
  if (
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    port < 1 ||
    port > 65535
  )
    throw denied();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || /(?:^|\.)(?:localhost|local|home\.arpa)\.?$/i.test(hostname))
    throw denied();
  const path = tunnel ? '/' : target.replace(/^http:\/\/[^/?]*/i, '');
  return {
    url,
    hostname,
    port,
    path: path.startsWith('/') ? path : '/' + path,
  };
}

export function publicProxyAddress(
  address: string,
  interfaces = networkInterfaces(),
) {
  if (!sandboxPublicAddress(address)) return false;
  const host = new BlockList();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const literal = entry.address.split('%', 1)[0]!;
      const family = isIP(literal) === 6 ? 'ipv6' : 'ipv4';
      const prefix = entry.cidr?.split('/')[1];
      if (prefix !== undefined) host.addSubnet(literal, Number(prefix), family);
      else host.addAddress(literal, family);
    }
  }
  return !host.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

function closed(stream: Duplex) {
  return stream.closed
    ? Promise.resolve()
    : new Promise<void>((resolve) => stream.once('close', resolve));
}

async function waitFor<T>(operation: Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  let listener: Disposable | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        listener = addAbortListener(signal, () => reject(signal.reason));
      }),
    ]);
  } finally {
    listener?.[Symbol.dispose]();
  }
}

function resolveTarget(hostname: string, signal: AbortSignal) {
  return resolvePublicAddresses(hostname, publicProxyAddress, signal).catch(
    (error: unknown) => {
      if (error instanceof Error && error.message === 'PUBLIC_ADDRESS_DENIED')
        throw denied();
      throw error;
    },
  );
}

async function openPinned(
  { address, family }: { address: string; family: number },
  port: number,
  signal: AbortSignal,
  setup: AbortSignal,
  allowHalfOpen: boolean,
) {
  setup.throwIfAborted();
  if (!publicProxyAddress(address)) throw denied();
  const socket = connect({ host: address, port, family, allowHalfOpen });
  const joined = closed(socket);
  const abort = addAbortListener(signal, () => socket.destroy());
  const release = async () => {
    socket.destroy();
    await joined;
    abort[Symbol.dispose]();
  };
  try {
    await waitFor(
      new Promise<void>((resolve, reject) => {
        socket.on('error', reject);
        socket.once('connect', resolve);
        socket.once('close', () => reject(new EgressError('UNAVAILABLE')));
      }),
      setup,
    );
    setup.throwIfAborted();
    const peer = socket.remoteAddress;
    const expected = new BlockList();
    const kind = family === 6 ? 'ipv6' : 'ipv4';
    expected.addAddress(address, kind);
    if (!peer || !expected.check(peer, kind) || !publicProxyAddress(peer))
      throw denied();
    return { socket, release };
  } catch (error) {
    await release();
    throw error;
  }
}

async function open(
  addresses: Awaited<ReturnType<typeof resolveTarget>>,
  port: number,
  signal: AbortSignal,
  allowHalfOpen = false,
) {
  const overall = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  for (const address of addresses) {
    const attempt = AbortSignal.any([overall, AbortSignal.timeout(2_500)]);
    try {
      return await openPinned(address, port, signal, attempt, allowHalfOpen);
    } catch (error) {
      overall.throwIfAborted();
      if (error instanceof EgressError && error.code === 'DENIED') throw error;
    }
  }
  throw new EgressError('UNAVAILABLE');
}

const hopByHop = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function forwarded(headers: IncomingHttpHeaders) {
  const connection =
    headers.connection?.split(',').map((name) => name.trim().toLowerCase()) ??
    [];
  const dropped = new Set([...hopByHop, ...connection]);
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) =>
      value !== undefined && !dropped.has(key) ? [[key, value] as const] : [],
    ),
  );
}

function responseCode(error: unknown) {
  return error instanceof EgressError && error.code === 'DENIED' ? 403 : 502;
}

type Target = ReturnType<typeof publicProxyTarget>;
type Addresses = Awaited<ReturnType<typeof resolveTarget>>;

async function relayHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: Target,
  addresses: Addresses,
  signal: AbortSignal,
) {
  const transfer = req.headers['transfer-encoding'];
  if (transfer && transfer.toLowerCase() !== 'chunked') throw denied();
  const upstream = await open(addresses, target.port, signal);
  let streams: readonly Promise<unknown>[] = [];
  try {
    signal.throwIfAborted();
    const headers = forwarded(req.headers);
    delete headers.expect;
    if (transfer) headers['transfer-encoding'] = 'chunked';
    if (req.headers['content-length'])
      headers['content-length'] = req.headers['content-length'];
    if (req.headers.expect?.toLowerCase() === '100-continue')
      res.writeContinue();
    const out = requestHttp({
      method: req.method,
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      headers: { ...headers, host: target.url.host, connection: 'close' },
      createConnection: () => upstream.socket,
      signal,
    });
    out.on('information', (message) => {
      try {
        if (message.statusCode === 102) res.writeProcessing();
        if (message.statusCode === 103)
          res.writeEarlyHints(forwarded(message.headers));
      } catch {
        // Optional hints must not interrupt the final response or escape this handler.
      }
    });
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      out.once('response', resolve);
      out.once('error', reject);
      out.once('close', () => reject(new EgressError('UNAVAILABLE')));
    }).then((reply) => {
      res.writeHead(reply.statusCode ?? 502, {
        ...forwarded(reply.headers),
        connection: 'close',
      });
      return pipeline(reply, res, { signal });
    });
    streams = [pipeline(req, out, { signal }), response];
    await Promise.all(streams);
  } finally {
    await upstream.release();
    await Promise.allSettled(streams);
  }
}

async function firstBytes(
  socket: Duplex,
  head: Buffer,
  hostname: string,
  signal: AbortSignal,
) {
  const readHello = createSandboxPublicTlsClientHelloReader(hostname);
  type Initial = {
    bytes: Buffer;
    hello: ReturnType<typeof readHello>;
  };
  const chunks: Buffer[] = [];
  let tls: boolean | undefined;
  let complete = false;
  let ready!: (initial: Initial) => void;
  let invalid!: (error: unknown) => void;
  const request = new Promise<Initial>((resolve, reject) => {
    ready = resolve;
    invalid = reject;
  });
  function data(chunk: Buffer) {
    if (!chunk.length || complete) return;
    try {
      tls ??= chunk[0] === 22;
      chunks.push(chunk);
      const hello = tls ? readHello(chunk) : null;
      if (tls && !hello) return;
      complete = true;
      socket.pause();
      ready({
        bytes: chunks.length === 1 ? chunk : Buffer.concat(chunks),
        hello,
      });
    } catch {
      complete = true;
      socket.pause();
      invalid(denied());
    }
  }
  try {
    socket.on('data', data);
    data(head);
    if (!complete) socket.resume();
    return await waitFor(request, signal);
  } finally {
    socket.pause();
    socket.off('data', data);
  }
}

/** CONNECT never forwards bytes outside a complete TLS record. This checks
 * wire framing only; the client still validates certificates and ciphertext. */
async function* tlsRecords(
  source: AsyncIterable<Buffer>,
  inspect: (record: Buffer, first: boolean) => Promise<void> | void,
) {
  let pending = Buffer.alloc(0);
  let first = true;
  for await (const chunk of source) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const type = pending[0]!;
      const length = pending.readUInt16BE(3);
      if (
        type < 20 ||
        type > 23 ||
        pending[1] !== 3 ||
        pending[2]! > 3 ||
        length === 0 ||
        length > 18_432
      )
        throw denied();
      if (pending.length < length + 5) break;
      const record = pending.subarray(0, length + 5);
      pending = pending.subarray(length + 5);
      const decision = inspect(record, first);
      if (decision) await decision;
      first = false;
      yield record;
    }
  }
  if (pending.length) throw denied();
}

async function* tlsInput(socket: Duplex, buffered?: Buffer) {
  // The first read can include records after the ClientHello, even if the
  // socket has reached EOF while the upstream connection was opening.
  if (buffered?.length) yield buffered;
  // The default iterator destroys a socket at EOF if its write side is open.
  yield* socket.iterator({ destroyOnReturn: false });
}

function finishTlsWrite(destination: Duplex, signal: AbortSignal) {
  const flushed = finished(destination, {
    readable: false,
    cleanup: true,
    signal,
  });
  destination.end();
  return flushed;
}

async function writeTlsRecords(
  records: AsyncIterable<Buffer>,
  destination: Duplex,
  signal: AbortSignal,
) {
  for await (const record of records) {
    signal.throwIfAborted();
    await waitFor(
      new Promise<void>((resolve, reject) => {
        destination.write(record, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
      signal,
    );
  }
  signal.throwIfAborted();
  await finishTlsWrite(destination, signal);
}

async function relayTls(
  client: Duplex,
  peer: Duplex,
  buffered: Buffer,
  earlyData: boolean,
  signal: AbortSignal,
) {
  const close = new AbortController();
  const active = AbortSignal.any([signal, close.signal]);
  const stop = addAbortListener(active, () => {
    client.destroy();
    peer.destroy();
  });
  const firstFlight = AbortSignal.timeout(10_000);
  const handshakeDeadline = addAbortListener(firstFlight, () =>
    close.abort(firstFlight.reason),
  );
  let serverHello: boolean | undefined;
  let serverFlight!: (serverHello: boolean) => void;
  const serverReady = new Promise<boolean>((resolve) => {
    serverFlight = resolve;
  });
  const ingress = writeTlsRecords(
    tlsRecords(tlsInput(peer), (record, first) => {
      if (!first) return;
      const hello = record[0] === 22 && record[5] === 2;
      if (!hello && record[0] !== 21) throw denied();
      if (hello) handshakeDeadline[Symbol.dispose]();
      serverHello = hello;
      serverFlight(hello);
    }),
    client,
    active,
  );
  const egress = writeTlsRecords(
    tlsRecords(tlsInput(client, buffered), (record) => {
      if (serverHello === true) return;
      // A TLS 1.3 client can send framed early data before ServerHello.
      if (
        serverHello === undefined &&
        earlyData &&
        (record[0] === 20 || record[0] === 23)
      )
        return;
      return waitFor(serverReady, active).then((hello) => {
        if (!hello) throw denied();
      });
    }),
    peer,
    active,
  );
  try {
    await Promise.all([ingress, egress]);
  } catch (error) {
    close.abort(error);
    throw error;
  } finally {
    await Promise.allSettled([ingress, egress]);
    handshakeDeadline[Symbol.dispose]();
    stop[Symbol.dispose]();
  }
}

/** Reuse the Node HTTP parser on the already accepted socket. No listener is
 * opened, and only this CONNECT's exact, already resolved target is reachable. */
async function httpInsideTunnel(
  socket: Duplex,
  initial: Buffer,
  target: Target,
  addresses: Addresses,
  signal: AbortSignal,
) {
  let request: Promise<void> | undefined;
  let incoming: IncomingMessage | undefined;
  const parser = createServer({ connectionsCheckingInterval: 0 });
  // In the pinned Node HTTP parser, request EOF then marks the pending
  // response as last instead of ending the socket before it can be written.
  Object.assign(parser, { httpAllowHalfOpen: true });
  const timeout = setTimeout(() => socket.destroy(), 10_000).unref();
  parser.maxRequestsPerSocket = 1;
  parser.on('connect', (_req, peer) => peer.destroy());
  parser.on('upgrade', (_req, peer) => peer.destroy());
  parser.on('clientError', (_error, peer) => peer.destroy());
  const relay = (req: IncomingMessage, res: ServerResponse) => {
    if (request) {
      res.writeHead(403, { connection: 'close' }).end();
      return;
    }
    clearTimeout(timeout);
    incoming = req;
    request = (async () => {
      try {
        const path = req.url ?? '';
        if (!path.startsWith('/') || !req.headers.host) throw denied();
        const requestTarget = publicProxyTarget(
          'http://' + req.headers.host + path,
          false,
        );
        if (
          requestTarget.hostname !== target.hostname ||
          requestTarget.port !== target.port
        )
          throw denied();
        await relayHttp(req, res, requestTarget, addresses, signal);
      } catch (error) {
        if (res.headersSent || signal.aborted) res.destroy();
        else res.writeHead(responseCode(error), { connection: 'close' }).end();
      }
    })();
  };
  parser.on('request', relay);
  parser.on('checkContinue', relay);
  const joined = closed(socket);
  parser.emit('connection', socket);
  if (socket.readableEnded) {
    // The CONNECT head can contain the full request before this parser owns EOF.
    socket.emit('data', initial);
    if (!incoming?.complete) socket.destroy();
  } else {
    socket.unshift(initial);
    socket.resume();
  }
  try {
    await joined;
    await request;
  } finally {
    clearTimeout(timeout);
  }
}

/** An HTTP listener capability for one active VM epoch. It cannot authenticate
 * the other routes on the same gateway port. */
export function createVmPublicProxy(
  owner: AbortSignal,
  assertActive: () => void,
  admit: (
    signal: AbortSignal,
    transfer: (signal: AbortSignal) => Promise<void>,
  ) => Promise<void>,
) {
  const capability = randomBytes(32).toString('base64url');
  const expected = Buffer.from(
    Buffer.from(`${proxyUser}:${capability}`).toString('base64'),
  );
  const counts = { http: 0, connect: 0, denied: 0, unavailable: 0 };
  function authenticated(req: IncomingMessage) {
    const raw = req.headers['proxy-authorization'];
    if (!raw || !/^basic /i.test(raw)) return false;
    const supplied = Buffer.from(raw.slice(6));
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  }
  const challenge = { 'proxy-authenticate': 'Basic realm="VM egress"' };
  const setup = (signal: AbortSignal) =>
    AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  return {
    counts,
    authorizationUrl(origin: string) {
      const url = new URL(origin);
      url.username = proxyUser;
      url.password = capability;
      return url.href;
    },
    async http(req: IncomingMessage, res: ServerResponse) {
      if (!authenticated(req)) {
        counts.denied++;
        res.writeHead(407, { ...challenge, connection: 'close' }).end();
        return;
      }
      const disconnected = new AbortController();
      const cancel = () => disconnected.abort();
      res.once('close', cancel);
      const signal = AbortSignal.any([owner, disconnected.signal]);
      const joinResponse = () =>
        finished(res, { cleanup: true }).catch(() => {});
      async function fail(error: unknown, active: AbortSignal) {
        const status = responseCode(error);
        counts[status === 403 ? 'denied' : 'unavailable']++;
        if (!res.destroyed) {
          if (res.headersSent || active.aborted) res.destroy();
          else res.writeHead(status, { connection: 'close' }).end();
        }
        await joinResponse();
      }
      try {
        assertActive();
        await admit(signal, async (active) => {
          try {
            assertActive();
            const target = publicProxyTarget(req.url ?? '', false);
            const addresses = await resolveTarget(
              target.hostname,
              setup(active),
            );
            assertActive();
            await relayHttp(req, res, target, addresses, active);
            counts.http++;
          } catch (error) {
            await fail(error, active);
          }
        });
      } catch (error) {
        await fail(error, signal);
      } finally {
        res.off('close', cancel);
      }
    },
    async connect(req: IncomingMessage, client: Duplex, head: Buffer) {
      const clientClosed = closed(client);
      const disconnected = new AbortController();
      let tls = false;
      client.once('close', (hadError: boolean) => {
        // A clean TLS close may precede flushing the other direction.
        if (
          !tls ||
          hadError ||
          !client.readableEnded ||
          !client.writableFinished
        )
          disconnected.abort();
      });
      client.on('error', () => {});
      client.pause();
      const signal = AbortSignal.any([owner, disconnected.signal]);
      const cancel = addAbortListener(owner, () => client.destroy());
      let upstream: Awaited<ReturnType<typeof open>> | undefined;
      let established = false;
      let joining: Promise<unknown> | undefined;
      function join(active: AbortSignal) {
        if (joining) return joining;
        if (established || active.aborted) client.destroy();
        // After an HTTP error, flush the status before closing the paused client.
        client.once('finish', () => client.destroy());
        if (client.writableFinished) client.destroy();
        return (joining = Promise.all([clientClosed, upstream?.release()]));
      }
      function fail(status: keyof typeof statuses) {
        if (client.destroyed) return;
        const auth =
          status === 407
            ? `Proxy-Authenticate: ${challenge['proxy-authenticate']}\r\n`
            : '';
        client.end(
          `HTTP/1.1 ${status} ${statuses[status]}\r\n${auth}Connection: close\r\nContent-Length: 0\r\n\r\n`,
        );
      }
      function rejectTransfer(error: unknown, active: AbortSignal) {
        const status = responseCode(error);
        counts[status === 403 ? 'denied' : 'unavailable']++;
        if (!established && !active.aborted) fail(status);
      }
      try {
        if (!authenticated(req)) {
          counts.denied++;
          fail(407);
          return;
        }
        assertActive();
        await admit(signal, async (active) => {
          const cancelTransfer = addAbortListener(active, () =>
            client.destroy(),
          );
          try {
            assertActive();
            const target = publicProxyTarget(req.url ?? '', true);
            const budget = setup(active);
            const addresses = await resolveTarget(target.hostname, budget);
            assertActive();
            budget.throwIfAborted();
            established = true;
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            const initial = await firstBytes(
              client,
              head,
              target.hostname,
              budget,
            );
            assertActive();
            counts.connect++;
            if (!initial.hello) {
              await httpInsideTunnel(
                client,
                initial.bytes,
                target,
                addresses,
                active,
              );
              return;
            }
            tls = true;
            upstream = await open(addresses, target.port, active, true);
            assertActive();
            active.throwIfAborted();
            const { end, earlyData } = initial.hello;
            upstream.socket.write(initial.bytes.subarray(0, end));
            await relayTls(
              client,
              upstream.socket,
              initial.bytes.subarray(end),
              earlyData,
              active,
            );
          } catch (error) {
            rejectTransfer(error, active);
          } finally {
            try {
              await join(active);
            } finally {
              cancelTransfer[Symbol.dispose]();
            }
          }
        });
      } catch (error) {
        rejectTransfer(error, signal);
      } finally {
        try {
          await join(signal);
        } finally {
          cancel[Symbol.dispose]();
        }
      }
    },
  };
}
