import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type * as Dns from 'node:dns/promises';
import type * as Https from 'node:https';
import { connect as startTls } from 'node:tls';
import type * as Net from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createVmPublicProxy,
  publicProxyAddress,
  publicProxyTarget,
} from './public-proxy.js';

const network = vi.hoisted(() => ({
  dns: vi.fn<
    (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>
  >(),
  attempted: vi.fn<(options: Net.TcpNetConnectOpts) => void>(),
  beforeDial: vi.fn<() => Promise<void> | undefined>(),
  captureDial: vi.fn<(socket: Net.Socket) => void>(),
  doh: vi.fn(() => {
    throw Error('DoH must not be dialed in this fixture');
  }),
}));
vi.mock('node:dns/promises', async (original) => ({
  ...(await original<typeof Dns>()),
  lookup: network.dns,
}));
vi.mock('node:https', async (original) => ({
  ...(await original<typeof Https>()),
  get: network.doh,
}));
vi.mock('node:net', async (original) => {
  const net = await original<typeof Net>();
  return {
    ...net,
    connect(options: Net.TcpNetConnectOpts) {
      network.attempted(options);
      if (options.host === '8.8.8.8') {
        const socket = new net.Socket();
        queueMicrotask(() =>
          socket.destroy(Error('unreachable fixture address')),
        );
        return socket;
      }
      if (options.host !== '1.1.1.1') throw Error('unexpected test dial');
      const local = { ...options, host: '127.0.0.1' };
      const gate = network.beforeDial();
      const socket = gate ? new net.Socket(local) : net.connect(local);
      if (gate)
        void gate.then(() => {
          if (!socket.destroyed) socket.connect(local);
        });
      Object.defineProperty(socket, 'remoteAddress', { value: options.host });
      network.captureDial(socket);
      return socket;
    },
  };
});

const cleanup: (() => Promise<void>)[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  network.attempted.mockClear();
  network.beforeDial.mockReset();
  network.captureDial.mockReset();
  network.dns.mockReset();
  network.doh.mockClear();
});
async function listen(server: Net.Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('listener');
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return address.port;
}
const setup = async (
  rejectHint?: ServerResponse['writeEarlyHints'],
  admit: Parameters<typeof createVmPublicProxy>[2] = (signal, transfer) =>
    transfer(signal),
) => {
  const stop = new AbortController();
  const proxy = createVmPublicProxy(
    stop.signal,
    () => stop.signal.throwIfAborted(),
    admit,
  );
  const requests = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    requests.add(work);
    void work.finally(() => requests.delete(work)).catch(() => {});
  };
  const server = createServer((req, res) => {
    if (rejectHint) res.writeEarlyHints = rejectHint;
    track(proxy.http(req, res));
  });
  const inputEnded = deferred<void>();
  server.on('connect', (req, client, head) => {
    client.once('end', () => inputEnded.resolve());
    track(proxy.connect(req, client, head));
  });
  const port = await listen(server);
  cleanup.push(async () => {
    stop.abort();
    server.closeAllConnections();
    await Promise.allSettled([...requests]);
  });
  const auth = new URL(proxy.authorizationUrl(`http://127.0.0.1:${port}`));
  const authorization =
    'Basic ' +
    Buffer.from(auth.username + ':' + auth.password).toString('base64');
  return {
    stop,
    port,
    authorization,
    inputEnded: inputEnded.promise,
    drain: () => Promise.allSettled([...requests]),
  };
};

async function get(
  port: number,
  path: string,
  authorization?: string,
  information?: number[],
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: authorization ? { 'proxy-authorization': authorization } : {},
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8').on('data', (chunk: string) => {
          body += chunk;
        });
        response.once('end', () =>
          resolve({ status: response.statusCode!, body }),
        );
        response.once('error', reject);
      },
    );
    req.on('information', (message) => information?.push(message.statusCode));
    req.once('error', reject);
    req.end();
  });
}

it('validates the target form and rejects current host prefixes and non-public addresses', () => {
  for (const target of [
    'example.org',
    'example.org:0',
    'example.org:65536',
    'user@example.org:443',
    'example.org:443/path',
    'localhost:443',
    'host.local:443',
  ])
    expect(() => publicProxyTarget(target, true)).toThrow();
  expect(publicProxyTarget('[2606:4700::1111]:443', true)).toMatchObject({
    hostname: '2606:4700::1111',
    port: 443,
  });
  expect(publicProxyTarget('example.org:80', true)).toMatchObject({ port: 80 });
  expect(() => publicProxyTarget('http://guest@example.org/', false)).toThrow();
  const host = {
    lan: [
      {
        address: '8.8.8.8',
        cidr: '8.8.8.8/24',
        family: 'IPv4' as const,
        internal: false,
        mac: '00:00:00:00:00:00',
        netmask: '255.255.255.0',
      },
    ],
  };
  for (const address of [
    '8.8.8.8',
    '8.8.8.9',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:7f00:1',
  ])
    expect(publicProxyAddress(address, host)).toBe(false);
  expect(publicProxyAddress('1.1.1.1', host)).toBe(true);
  expect(publicProxyAddress('2606:4700::1111', host)).toBe(true);
});

it('challenges before DNS and forwards plain HTTP once to the pinned answer with no proxy headers', async () => {
  const upstream = createServer((req, res) => {
    expect(req.headers['proxy-authorization']).toBeUndefined();
    expect(req.headers.connection).toBe('close');
    expect(req.headers.host).toMatch(/^public\.example:/);
    expect(req.url).toBe('/path?q=open');
    res.end('public reply');
  });
  const upstreamPort = await listen(upstream);
  const vm = await setup();
  const target = `http://public.example:${upstreamPort}/path?q=open`;
  expect(await get(vm.port, target)).toEqual({ status: 407, body: '' });
  expect(network.dns).not.toHaveBeenCalled();
  network.dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  expect(await get(vm.port, target, vm.authorization)).toEqual({
    status: 200,
    body: 'public reply',
  });
  expect(network.attempted).toHaveBeenCalledExactlyOnceWith({
    host: '1.1.1.1',
    port: upstreamPort,
    family: 4,
    allowHalfOpen: false,
  });
});

it('keeps the final HTTP response when the early-hints writer rejects a hint', async () => {
  const rejectHint = vi.fn(() => {
    throw new TypeError('fixture hint rejected');
  });
  const vm = await setup(rejectHint);
  const port = await listen(
    createServer((_req, res) => {
      res.writeProcessing();
      res.writeEarlyHints({
        link: '</fixture.css>; rel=preload; as=style',
        'x-fixture-hint': 'kept',
      });
      res.end('final response');
    }),
  );
  network.dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  const information: number[] = [];
  await expect(
    get(
      vm.port,
      `http://public.example:${port}/`,
      vm.authorization,
      information,
    ),
  ).resolves.toEqual({ status: 200, body: 'final response' });
  expect(information).toEqual([102]);
  expect(rejectHint).toHaveBeenCalledExactlyOnceWith({
    link: '</fixture.css>; rel=preload; as=style',
    'x-fixture-hint': 'kept',
  });
});

it('denies a mixed DNS answer, private redirect target and a retired epoch before dialing', async () => {
  const vm = await setup();
  network.dns.mockResolvedValue([
    { address: '1.1.1.1', family: 4 },
    { address: '192.168.0.2', family: 4 },
  ]);
  expect(
    (await get(vm.port, 'http://mixed.example/', vm.authorization)).status,
  ).toBe(403);
  expect(
    (await get(vm.port, 'http://169.254.169.254/', vm.authorization)).status,
  ).toBe(403);
  expect(network.attempted).not.toHaveBeenCalled();
  vm.stop.abort();
  const rejected = await get(
    vm.port,
    'http://public.example/',
    vm.authorization,
  ).catch(() => null);
  expect(rejected?.status === 200).toBe(false);
  expect(network.attempted).not.toHaveBeenCalled();
});

function openTunnel(
  vm: { port: number },
  upstreamPort: number,
  authorization?: string,
) {
  const req = request({
    method: 'CONNECT',
    host: '127.0.0.1',
    port: vm.port,
    path: `public.example:${upstreamPort}`,
    headers: authorization ? { 'proxy-authorization': authorization } : {},
  });
  const result = once(req, 'connect') as Promise<
    [{ statusCode: number }, Net.Socket, Buffer]
  >;
  req.end();
  return result;
}

it('admits only authenticated public HTTP and CONNECT and does not dial when admission refuses', async () => {
  const admit = vi.fn(async () => {
    throw Error('test gateway frozen');
  });
  const vm = await setup(undefined, admit);
  expect((await get(vm.port, 'http://public.example/')).status).toBe(407);
  const [challenge, unauthenticated] = await openTunnel(vm, 443);
  unauthenticated.destroy();
  expect(challenge.statusCode).toBe(407);
  expect(admit).not.toHaveBeenCalled();

  const [refused, tunnel] = await openTunnel(vm, 443, vm.authorization);
  tunnel.destroy();
  expect(refused.statusCode).toBe(502);
  expect(
    (await get(vm.port, 'http://public.example/', vm.authorization)).status,
  ).toBe(502);
  expect(admit).toHaveBeenCalledTimes(2);
  expect(network.dns).not.toHaveBeenCalled();
  expect(network.attempted).not.toHaveBeenCalled();
});

it('joins an established CONNECT that is cancelled by its gateway permit before dialing', async () => {
  const permit = new AbortController();
  const joined = deferred<void>();
  const vm = await setup(undefined, async (signal, transfer) => {
    await transfer(AbortSignal.any([signal, permit.signal]));
    joined.resolve();
  });
  network.dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  const [handshake, tunnel] = await openTunnel(vm, 443, vm.authorization);
  try {
    expect(handshake.statusCode).toBe(200);
    const closed = once(tunnel, 'close');
    permit.abort();
    await Promise.all([joined.promise, closed]);
    expect(network.attempted).not.toHaveBeenCalled();
  } finally {
    tunnel.destroy();
  }
});

it('uses validated fallback addresses and accepts only parsed HTTP inside a plaintext CONNECT', async () => {
  const upstream = createServer((req, res) => {
    expect(req.url).toBe('//protected-target?');
    expect(req.headers['proxy-authorization']).toBeUndefined();
    res.end('plain HTTP over CONNECT');
  });
  const port = await listen(upstream);
  const vm = await setup();
  network.dns.mockResolvedValue([
    { address: '8.8.8.8', family: 4 },
    { address: '1.1.1.1', family: 4 },
  ]);
  const [challenge, rejected] = await openTunnel(vm, port);
  rejected.destroy();
  expect(challenge.statusCode).toBe(407);
  expect(network.dns).not.toHaveBeenCalled();

  const [start, badWire] = await openTunnel(vm, port, vm.authorization);
  expect(start.statusCode).toBe(200);
  const badClosed = once(badWire, 'close');
  badWire.write('not HTTP or TLS\r\n');
  await badClosed;
  expect(network.attempted).not.toHaveBeenCalled();

  const [response, tunnel] = await openTunnel(vm, port, vm.authorization);
  expect(response.statusCode).toBe(200);
  tunnel.write(
    `GET //protected-target? HTTP/1.1\r\nHost: public.example:${port}\r\nConnection: close\r\n\r\n`,
  );
  let body = '';
  for await (const chunk of tunnel) body += String(chunk);
  expect(body).toContain('plain HTTP over CONNECT');
  expect(network.attempted.mock.calls.map(([options]) => options.host)).toEqual(
    ['8.8.8.8', '1.1.1.1'],
  );
});

it('delivers a plaintext CONNECT response after the guest has sent the request and FIN', async () => {
  const received = deferred<string>();
  const respond = deferred<void>();
  const port = await listen(
    createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
      req.once('end', () => received.resolve(body));
      void respond.promise.then(() => res.end('reply after guest FIN'));
    }),
  );
  const vm = await setup();
  network.dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  const [response, tunnel] = await openTunnel(vm, port, vm.authorization);
  expect(response.statusCode).toBe(200);
  try {
    tunnel.end(
      `POST /fixture HTTP/1.1\r\nHost: public.example:${port}\r\nContent-Length: 5\r\n\r\nhello`,
    );
    await vm.inputEnded;
    expect(await received.promise).toBe('hello');
    respond.resolve();
    let body = '';
    for await (const chunk of tunnel) body += String(chunk);
    expect(body).toContain('reply after guest FIN');
    await vm.drain();
  } finally {
    respond.resolve();
    tunnel.destroy();
  }
});

it('passes a real TLS ClientHello and joins both endpoints on epoch loss', async () => {
  const received = deferred<Buffer>();
  const peerClosed = deferred<void>();
  const port = await listen(
    createTcpServer((socket) => {
      socket.once('close', () => peerClosed.resolve());
      socket.once('data', received.resolve);
    }),
  );
  const vm = await setup();
  network.dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  const [response, tunnel] = await openTunnel(vm, port, vm.authorization);
  expect(response.statusCode).toBe(200);
  const client = startTls({ socket: tunnel, servername: 'public.example' });
  client.on('error', () => {});
  try {
    expect((await received.promise)[0]).toBe(22);
    const ended = deferred<void>();
    client.once('close', () => ended.resolve());
    vm.stop.abort();
    await vm.drain();
    await Promise.all([peerClosed.promise, ended.promise]);
  } finally {
    client.destroy();
  }
});

it('closes and joins a silent TLS peer at the handshake deadline without guest input', async () => {
  const hello = deferred<void>();
  const peerClosed = deferred<void>();
  const port = await listen(
    createTcpServer((socket) => {
      socket.once('data', () => hello.resolve());
      socket.once('close', () => peerClosed.resolve());
    }),
  );
  const vm = await setup();
  network.dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  const deadline = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    if (ms === 10_000 && network.captureDial.mock.calls.length)
      return deadline.signal;
    return originalTimeout(ms);
  });
  const [response, tunnel] = await openTunnel(vm, port, vm.authorization);
  expect(response.statusCode).toBe(200);
  const client = startTls({ socket: tunnel, servername: 'public.example' });
  client.on('error', () => {});
  const closed = deferred<void>();
  client.once('close', () => closed.resolve());
  try {
    await hello.promise;
    deadline.abort();
    await Promise.all([closed.promise, peerClosed.promise, vm.drain()]);
    expect(vm.stop.signal.aborted).toBe(false);
  } finally {
    client.destroy();
    timeout.mockRestore();
  }
});

it('streams a validated HTTPS response through multiple TLS records and preserves the tail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'public-proxy-fixture-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-subj',
    '/CN=public.example',
    '-addext',
    'subjectAltName=DNS:public.example',
    '-days',
    '1',
    '-keyout',
    keyPath,
    '-out',
    certPath,
  ]);
  const [key, cert] = await Promise.all([
    readFile(keyPath),
    readFile(certPath),
  ]);
  const payload = 'record'.repeat(12_000) + 'complete tail';
  const port = await listen(
    createHttpsServer({ key, cert }, (req, res) => {
      expect(req.url).toBe('/tls-body');
      res
        .writeHead(200, {
          'content-length': payload.length,
          connection: 'close',
        })
        .end(payload);
    }),
  );
  const vm = await setup();
  network.dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  const [response, tunnel] = await openTunnel(vm, port, vm.authorization);
  expect(response.statusCode).toBe(200);
  const client = startTls({
    socket: tunnel,
    servername: 'public.example',
    ca: cert,
    ALPNProtocols: ['http/1.1'],
  });
  try {
    await once(client, 'secureConnect');
    expect(client.authorized).toBe(true);
    client.write(
      'GET /tls-body HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n\r\n',
    );
    let body = '';
    for await (const chunk of client) body += String(chunk);
    expect(body.split('\r\n\r\n')[1]).toBe(payload);
  } finally {
    client.destroy();
  }
});

async function nativeClientHello() {
  const hello = deferred<Buffer>();
  const capture = createTcpServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt16BE(3)) {
        hello.resolve(buffer);
        socket.destroy();
      }
    });
  });
  const capturePort = await listen(capture);
  const generator = startTls({
    host: '127.0.0.1',
    port: capturePort,
    servername: 'public.example',
  });
  generator.on('error', () => {});
  const initial = await hello.promise;
  generator.destroy();
  return initial;
}

it.each(['guest FIN', 'epoch revoke'] as const)(
  'keeps the guest-to-upstream TLS tail writable after upstream FIN and joins on %s',
  async (completion) => {
    const initial = await nativeClientHello();
    const hello = Buffer.from([22, 3, 3, 0, 1, 2]);
    const tail = Buffer.from([23, 3, 3, 0, 3, 14, 15, 16]);
    const upstream = deferred<Net.Socket>();
    const proxyPeer = deferred<Net.Socket>();
    const peerClosed = deferred<void>();
    let received = Buffer.alloc(0);
    const port = await listen(
      createTcpServer({ allowHalfOpen: true }, (socket) => {
        socket.once('close', () => peerClosed.resolve());
        socket.on('data', (chunk) => {
          const hadHello = received.length >= initial.length;
          received = Buffer.concat([received, chunk]);
          if (!hadHello && received.length >= initial.length) {
            socket.end(hello);
            upstream.resolve(socket);
          }
        });
      }),
    );
    const vm = await setup();
    network.dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    network.captureDial.mockImplementationOnce(proxyPeer.resolve);
    const [response, tunnel] = await openTunnel(vm, port, vm.authorization);
    expect(response.statusCode).toBe(200);
    tunnel.allowHalfOpen = true;
    const ended = once(tunnel, 'end');
    const clientClosed = once(tunnel, 'close');
    tunnel.resume();
    tunnel.write(initial);
    try {
      await ended;
      expect((await upstream.promise).readableEnded).toBe(false);
      if (completion === 'guest FIN') {
        const writable = await proxyPeer.promise;
        writable.cork();
        tunnel.end(tail);
        await clientClosed;
        await vi.waitFor(() =>
          expect(writable.writableLength).toBe(tail.length),
        );
        expect(writable.destroyed).toBe(false);
        writable.uncork();
      } else vm.stop.abort();
      await Promise.all([peerClosed.promise, vm.drain()]);
      expect(received).toEqual(
        completion === 'guest FIN' ? Buffer.concat([initial, tail]) : initial,
      );
      if (completion === 'epoch revoke') tunnel.destroy();
      await clientClosed;
    } finally {
      tunnel.destroy();
    }
  },
);

it('joins both sockets when an incomplete TLS record fails while the opposite writer is blocked', async () => {
  const initial = await nativeClientHello();
  const remote = deferred<Net.Socket>();
  const proxyPeer = deferred<Net.Socket>();
  const peerClosed = deferred<void>();
  const hello = Buffer.from([22, 3, 3, 0, 1, 2]);
  const tail = Buffer.from([23, 3, 3, 0, 3, 14, 15, 16]);
  const port = await listen(
    createTcpServer({ allowHalfOpen: true }, (socket) => {
      socket.once('close', () => peerClosed.resolve());
      socket.once('data', () => {
        socket.write(hello);
        remote.resolve(socket);
      });
    }),
  );
  const vm = await setup();
  network.dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  network.captureDial.mockImplementationOnce(proxyPeer.resolve);
  const [response, tunnel] = await openTunnel(vm, port, vm.authorization);
  expect(response.statusCode).toBe(200);
  const serverFlight = once(tunnel, 'data');
  const clientClosed = once(tunnel, 'close');
  tunnel.write(initial);
  try {
    await serverFlight;
    const writable = await proxyPeer.promise;
    writable.cork();
    tunnel.end(tail);
    await vm.inputEnded;
    await vi.waitFor(() => expect(writable.writableLength).toBe(tail.length));
    (await remote.promise).end(tail.subarray(0, -1));
    await Promise.all([clientClosed, peerClosed.promise, vm.drain()]);
    expect(writable.destroyed).toBe(true);
  } finally {
    tunnel.destroy();
  }
});

it.each(['coalesced', 'split', 'coalesced before EOF'] as const)(
  'relays %s early TLS records before the first server flight',
  async (transport) => {
    // Synthetic ClientHello and opaque records exercise framing only.
    const name = Buffer.from('public.example');
    const wireHello = Buffer.concat([
      Buffer.from([22, 3, 1, 0, 0, 1, 0, 0, 0, 3, 3]),
      Buffer.alloc(32),
      Buffer.from([0, 0, 2, 0x13, 1, 1, 0, 0, 0]),
      Buffer.from([
        0,
        0,
        0,
        name.length + 5,
        0,
        name.length + 3,
        0,
        0,
        name.length,
      ]),
      name,
      Buffer.from([0, 42, 0, 0, 0, 41, 0, 0]),
    ]);
    wireHello.writeUInt16BE(wireHello.length - 5, 3);
    wireHello.writeUIntBE(wireHello.length - 9, 6, 3);
    wireHello.writeUInt16BE(wireHello.length - 52, 50);
    const early = Buffer.from([23, 3, 3, 0, 3, 11, 12, 13]);
    const helloReceived = deferred<void>();
    const received = deferred<Buffer>();
    const port = await listen(
      createTcpServer((socket) => {
        let data = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          data = Buffer.concat([data, chunk]);
          if (data.length >= wireHello.length) helloReceived.resolve();
          if (data.length >= wireHello.length + early.length) {
            received.resolve(data);
            socket.end(Buffer.from([21, 3, 3, 0, 2, 2, 40]));
          }
        });
      }),
    );
    const vm = await setup();
    network.dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    const dial = deferred<void>();
    if (transport === 'coalesced before EOF')
      network.beforeDial.mockReturnValueOnce(dial.promise);
    const [response, tunnel] = await openTunnel(vm, port, vm.authorization);
    expect(response.statusCode).toBe(200);
    const clientClosed = once(tunnel, 'close');
    tunnel.resume();
    try {
      if (transport === 'coalesced before EOF') {
        tunnel.end(Buffer.concat([wireHello, early]));
        await vm.inputEnded;
        expect(network.beforeDial).toHaveBeenCalledOnce();
        dial.resolve();
      } else if (transport === 'coalesced') {
        tunnel.write(Buffer.concat([wireHello, early]));
      } else {
        tunnel.write(wireHello);
        await helloReceived.promise;
        tunnel.write(early);
      }
      expect(await received.promise).toEqual(Buffer.concat([wireHello, early]));
      await clientClosed;
      await vm.drain();
    } finally {
      tunnel.destroy();
    }
  },
);

it.each([false, true])(
  'discards non-TLS bytes after accepting a native ClientHello (split records: %s)',
  async (split) => {
    const initial = await nativeClientHello();
    const record = (payload: Buffer) => {
      const header = Buffer.from(initial.subarray(0, 5));
      header.writeUInt16BE(payload.length, 3);
      return Buffer.concat([header, payload]);
    };
    const prefix = split
      ? Buffer.concat([
          record(initial.subarray(5, 8)),
          record(initial.subarray(8)),
        ])
      : initial;
    const crossed: Buffer[] = [];
    const forwarded = deferred<void>();
    const remoteClosed = deferred<void>();
    const port = await listen(
      createTcpServer((socket) => {
        socket.on('data', (chunk) => {
          crossed.push(chunk);
          if (Buffer.concat(crossed).length >= prefix.length)
            forwarded.resolve();
        });
        socket.once('close', () => remoteClosed.resolve());
      }),
    );
    const vm = await setup();
    network.dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    const [response, tunnel] = await openTunnel(vm, port, vm.authorization);
    expect(response.statusCode).toBe(200);
    const closed = once(tunnel, 'close');
    tunnel.write(prefix);
    await forwarded.promise;
    tunnel.write('fixture bytes outside a record');
    await Promise.all([closed, remoteClosed.promise]);
    expect(Buffer.concat(crossed)).toEqual(prefix);
  },
);

it('joins a pending system lookup and never starts a synthetic DNS fallback after revoke', async () => {
  const vm = await setup();
  const began = deferred<void>();
  const result = deferred<{ address: string; family: 4 }[]>();
  network.dns.mockImplementation(() => {
    began.resolve();
    return result.promise;
  });
  const reply = get(vm.port, 'http://waiting.example/', vm.authorization).catch(
    () => null,
  );
  await began.promise;
  vm.stop.abort();
  let joined = false;
  const draining = vm.drain().then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  result.resolve([{ address: '198.18.2.16', family: 4 }]);
  await draining;
  await reply;
  expect(network.doh).not.toHaveBeenCalled();
  expect(network.attempted).not.toHaveBeenCalled();
});
