import { once } from 'node:events';
import { createServer, request } from 'node:http';
import type * as Dns from 'node:dns/promises';
import type * as Net from 'node:net';
import { createServer as createTcpServer } from 'node:net';
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
}));
vi.mock('node:dns/promises', async (original) => ({
  ...(await original<typeof Dns>()),
  lookup: network.dns,
}));
vi.mock('node:net', async (original) => {
  const net = await original<typeof Net>();
  return {
    ...net,
    connect(options: Net.TcpNetConnectOpts) {
      network.attempted(options);
      if (options.host !== '1.1.1.1') throw Error('unexpected test dial');
      const socket = net.connect({ ...options, host: '127.0.0.1' });
      Object.defineProperty(socket, 'remoteAddress', { value: options.host });
      return socket;
    },
  };
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  network.attempted.mockClear();
  network.dns.mockReset();
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
const setup = async () => {
  const stop = new AbortController();
  const proxy = createVmPublicProxy(stop.signal, () =>
    stop.signal.throwIfAborted(),
  );
  const requests = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    requests.add(work);
    void work.finally(() => requests.delete(work)).catch(() => {});
  };
  const server = createServer((req, res) => track(proxy.http(req, res)));
  server.on('connect', (req, client, head) =>
    track(proxy.connect(req, client, head)),
  );
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
    drain: () => Promise.allSettled([...requests]),
  };
};

async function get(port: number, path: string, authorization?: string) {
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

it('carries opaque CONNECT bytes only after authorization and joins the tunnel on epoch loss', async () => {
  const upstream = createTcpServer((socket) => socket.pipe(socket));
  const upstreamPort = await listen(upstream);
  const vm = await setup();
  network.dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  function connect(authorization?: string) {
    const req = request({
      method: 'CONNECT',
      host: '127.0.0.1',
      port: vm.port,
      path: `public.example:${upstreamPort}`,
      headers: authorization ? { 'proxy-authorization': authorization } : {},
    });
    const result = once(req, 'connect') as Promise<
      [
        {
          statusCode: number;
        },
        Net.Socket,
        Buffer,
      ]
    >;
    req.end();
    return result;
  }
  const [challenge, rejected] = await connect();
  rejected.destroy();
  expect(challenge.statusCode).toBe(407);
  expect(network.dns).not.toHaveBeenCalled();
  const [response, tunnel] = await connect(vm.authorization);
  expect(response.statusCode).toBe(200);
  try {
    const reply = once(tunnel, 'data');
    tunnel.write('round trip');
    expect((await reply)[0].toString()).toBe('round trip');
    const end = once(tunnel, 'close');
    vm.stop.abort();
    await vm.drain();
    await end;
  } finally {
    tunnel.destroy();
  }
});
