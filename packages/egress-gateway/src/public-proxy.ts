import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { addAbortListener } from 'node:events';
import { BlockList, connect, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  resolvePublicAddress,
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
  return { url, hostname, port };
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

async function open(hostname: string, port: number, signal: AbortSignal) {
  const setup = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  setup.throwIfAborted();
  const { address, family } = await waitFor(
    resolvePublicAddress(hostname, publicProxyAddress),
    setup,
  ).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'PUBLIC_ADDRESS_DENIED')
      throw denied();
    throw error;
  });
  setup.throwIfAborted();
  if (!publicProxyAddress(address)) throw denied();
  const socket = connect({ host: address, port, family });
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
    return { socket, joined, release };
  } catch (error) {
    await release();
    throw error;
  }
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
    Object.entries(headers).filter(
      ([key, value]) => value !== undefined && !dropped.has(key),
    ),
  );
}

function responseCode(error: unknown) {
  return error instanceof EgressError && error.code === 'DENIED' ? 403 : 502;
}

/** An HTTP listener capability for one active VM epoch. It cannot authenticate
 * the other routes on the same gateway port. */
export function createVmPublicProxy(
  owner: AbortSignal,
  assertActive: () => void,
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
      let upstream: Awaited<ReturnType<typeof open>> | undefined;
      try {
        assertActive();
        const { url, hostname, port } = publicProxyTarget(req.url ?? '', false);
        upstream = await open(hostname, port, signal);
        assertActive();
        signal.throwIfAborted();
        const upstreamSocket = upstream.socket;
        const out = requestHttp({
          method: req.method,
          hostname,
          port,
          path: url.pathname + url.search,
          headers: {
            ...forwarded(req.headers),
            host: url.host,
            connection: 'close',
          },
          createConnection: () => upstreamSocket,
          signal,
        });
        const answer = new Promise<IncomingMessage>((resolve, reject) => {
          out.once('response', resolve);
          out.once('error', reject);
          out.once('close', () => reject(new EgressError('UNAVAILABLE')));
        });
        const relay = answer.then((reply) => {
          res.writeHead(reply.statusCode ?? 502, forwarded(reply.headers));
          return pipeline(reply, res, { signal });
        });
        await Promise.all([pipeline(req, out, { signal }), relay]);
        counts.http++;
      } catch (error) {
        const status = responseCode(error);
        counts[status === 403 ? 'denied' : 'unavailable']++;
        if (!res.destroyed) {
          if (res.headersSent || signal.aborted) res.destroy();
          else res.writeHead(status, { connection: 'close' }).end();
        }
      } finally {
        res.off('close', cancel);
        await upstream?.release();
      }
    },
    async connect(req: IncomingMessage, client: Duplex, head: Buffer) {
      const clientClosed = closed(client);
      const disconnected = new AbortController();
      client.once('close', () => disconnected.abort());
      client.on('error', () => {});
      client.pause();
      const signal = AbortSignal.any([owner, disconnected.signal]);
      const cancel = addAbortListener(owner, () => client.destroy());
      let upstream: Awaited<ReturnType<typeof open>> | undefined;
      let established = false;
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
      try {
        if (!authenticated(req)) {
          counts.denied++;
          fail(407);
          return;
        }
        assertActive();
        const target = publicProxyTarget(req.url ?? '', true);
        upstream = await open(target.hostname, target.port, signal);
        assertActive();
        signal.throwIfAborted();
        established = true;
        counts.connect++;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.socket.write(head);
        client.pipe(upstream.socket);
        upstream.socket.pipe(client);
        await Promise.race([clientClosed, upstream.joined]);
      } catch (error) {
        const status = responseCode(error);
        counts[status === 403 ? 'denied' : 'unavailable']++;
        if (!established && !signal.aborted) fail(status);
      } finally {
        if (established || signal.aborted) client.destroy();
        // After an HTTP error, flush the status before closing the paused client.
        client.once('finish', () => client.destroy());
        if (client.writableFinished) client.destroy();
        await Promise.all([clientClosed, upstream?.release()]);
        cancel[Symbol.dispose]();
      }
    },
  };
}
