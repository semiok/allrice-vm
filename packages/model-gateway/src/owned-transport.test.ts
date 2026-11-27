import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import type * as Net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { closeServer, deferred, listen } from './gateway.fixture.ts';
import { createOwnedModelTransport } from './owned-transport.ts';
import { runWithOwnedNativeFetch } from './transport.ts';

const fixture = vi.hoisted(() => ({
  lookup: undefined as Net.LookupFunction | undefined,
  onConnect: undefined as ((socket: Net.Socket) => void) | undefined,
}));
vi.mock('node:net', async (importOriginal) => {
  const real = await importOriginal<typeof Net>();
  return {
    ...real,
    connect(options: Net.TcpNetConnectOpts) {
      const socket = real.connect(
        fixture.lookup
          ? { ...options, autoSelectFamily: true, lookup: fixture.lookup }
          : options,
      );
      fixture.onConnect?.(socket);
      return socket;
    },
  };
});

it('cancels and joins the actual socket while TLS has not negotiated', async () => {
  const clientHello = deferred();
  const peerClosed = deferred();
  let destroyPeer: (() => void) | undefined;
  const server = createTcpServer((socket) => {
    destroyPeer = () => socket.destroy();
    socket.on('error', () => {});
    socket.once('data', () => clientHello.resolve());
    socket.once('close', () => peerClosed.resolve());
  });
  const stop = new AbortController();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('fixture_listener_missing');
  const endpoint = new URL(`https://127.0.0.1:${address.port}`);
  let clientClosed = false;
  fixture.onConnect = (socket) => {
    socket.once('close', () => {
      clientClosed = true;
    });
  };
  try {
    const operation = runWithOwnedNativeFetch(endpoint, 32, stop.signal, () =>
      fetch(endpoint, { method: 'POST', body: '{}' }),
    );
    await clientHello.promise;
    stop.abort();
    expect(await operation).toMatchObject({ ok: false });
    expect(clientClosed).toBe(true);
    // A ClientHello-only peer will never finish its handshake. An early
    // dispatcher receipt alone leaves this socket open until connect timeout.
    const promptlyClosed = await Promise.race([
      peerClosed.promise.then(() => true),
      setTimeout(1000, false, { ref: false }),
    ]);
    expect(promptlyClosed).toBe(true);
  } finally {
    fixture.onConnect = undefined;
    stop.abort();
    destroyPeer?.();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('completes validated TLS after the first of two candidate addresses fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'allrice-owned-transport-'));
  const keyPath = join(dir, 'fixture-key.pem');
  const certPath = join(dir, 'fixture-cert.pem');
  const trusted = getCACertificates();
  const owner = createOwnedModelTransport('multi-address-fixture');
  const failures: string[] = [];
  let server: ReturnType<typeof createHttpsServer> | undefined;
  try {
    await promisify(execFile)('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-days',
      '1',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ]);
    const [key, cert] = await Promise.all([
      readFile(keyPath, 'utf8'),
      readFile(certPath, 'utf8'),
    ]);
    setDefaultCACertificates([...trusted, cert]);
    server = createHttpsServer({ key, cert }, (_request, response) =>
      response.end('TLS ready'),
    );
    const endpoint = new URL(await listen(server));
    endpoint.protocol = 'https:';
    endpoint.hostname = 'localhost';
    // Only DNS is synthetic. Both attempts are real, and the test server
    // intentionally listens only on the second address.
    fixture.lookup = (_host, _options, callback) => {
      queueMicrotask(() =>
        callback(null, [
          { address: '::1', family: 6 },
          { address: '127.0.0.1', family: 4 },
        ]),
      );
    };
    fixture.onConnect = (socket) => {
      socket.on('connectionAttemptFailed', (ip) => failures.push(ip));
    };
    const response = await owner.fetchOwned(fetch, new Request(endpoint), {});
    expect(await response.text()).toBe('TLS ready');
    expect(failures).toEqual(['::1']);
    endpoint.hostname = 'other.localhost';
    await expect(
      owner.fetchOwned(fetch, new Request(endpoint), {}),
    ).rejects.toMatchObject({
      cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    });
  } finally {
    fixture.lookup = undefined;
    fixture.onConnect = undefined;
    setDefaultCACertificates(trusted);
    await owner.close();
    if (server?.listening) await closeServer(server);
    await rm(dir, { force: true, recursive: true });
  }
});

it('does not replay a Search POST when the upstream responds with 421', async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    request.once('end', () => response.writeHead(421).end('misdirected'));
  });
  const endpoint = new URL(await listen(server));
  try {
    const outcome = await runWithOwnedNativeFetch(
      endpoint,
      32,
      new AbortController().signal,
      async () =>
        (await fetch(endpoint, { method: 'POST', body: '{}' })).status,
    );
    expect(outcome).toEqual({ ok: true, value: 421 });
    expect(requests).toBe(1);
  } finally {
    await closeServer(server);
  }
});

it('fences the exact dispatcher and closes an outstanding real HTTP socket before releasing evidence', async () => {
  const accepted = deferred();
  const peerClosed = deferred();
  const server = createServer((request, response) => {
    request.socket.once('close', () => peerClosed.resolve());
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: still-open\n\n');
    accepted.resolve();
  });
  const origin = await listen(server);
  const owner = createOwnedModelTransport('exact-host');
  const signal = new AbortController().signal;
  try {
    await expect(
      owner.stoppedEvidence('exact-host', signal),
    ).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    const request = new Request(origin);
    const response = await owner.fetchOwned(fetch, request, {});
    await accepted.promise;
    await owner.close();
    await peerClosed.promise;
    await expect(
      owner.stoppedEvidence('other-host', signal),
    ).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    await expect(owner.stoppedEvidence('exact-host', signal)).resolves.toMatch(
      /^undici-owner-stopped:exact-host:/,
    );
    expect(() => owner.fetchOwned(fetch, request, {})).toThrow();
    await response.body?.cancel().catch(() => {});
  } finally {
    await owner.close();
    await closeServer(server);
  }
});

it.each(['abort', 'oversize'])(
  'joins an isolated native POST before reporting %s',
  async (mode) => {
    const reached = deferred();
    const peerClosed = deferred();
    const server = createServer((request, response) => {
      request.socket.once('close', () => peerClosed.resolve());
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(mode === 'oversize' ? 'x'.repeat(128) : '{');
      reached.resolve();
    });
    const endpoint = new URL(await listen(server));
    const stop = new AbortController();
    try {
      const operation = runWithOwnedNativeFetch(
        endpoint,
        32,
        stop.signal,
        async () => {
          const response = await fetch(endpoint, {
            method: 'POST',
            body: '{}',
          });
          return response.json();
        },
      );
      await reached.promise;
      if (mode === 'abort') stop.abort();
      expect(await operation).toMatchObject({ ok: false });
      await peerClosed.promise;
    } finally {
      await closeServer(server);
    }
  },
);
