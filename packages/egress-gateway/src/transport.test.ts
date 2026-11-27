import { beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RequestOptions } from 'node:https';
import { EgressError } from './contract.js';
import { createPublicHttpsTransport, fetchPublicHttps } from './transport.js';

const io = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
  interfaces: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: io.lookup }));
vi.mock('node:https', () => ({ request: io.request }));
vi.mock('node:os', () => ({ networkInterfaces: io.interfaces }));

beforeEach(() => {
  vi.resetAllMocks();
  io.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  io.interfaces.mockReturnValue({});
});
function read(
  url = 'https://registry.example/pkg',
  maxBytes = 16,
  signal = new AbortController().signal,
) {
  return createPublicHttpsTransport().read(new URL(url), { maxBytes, signal });
}
function reply(
  status: number,
  body: string,
  headers: Record<string, string> = {},
  once = false,
) {
  const respond = (
    _options: RequestOptions,
    receive: (res: PassThrough) => void,
  ) => {
    const req = new EventEmitter();
    return Object.assign(req, {
      end() {
        const response = Object.assign(new PassThrough(), {
          statusCode: status,
          headers,
        });
        response.once('close', () => req.emit('close'));
        receive(response);
        response.end(Buffer.from(body));
      },
    });
  };
  if (once) io.request.mockImplementationOnce(respond);
  else io.request.mockImplementation(respond);
}
it.each([
  'http://registry.example/pkg',
  'https://127.0.0.1/pkg',
  'https://user:secret@registry.example/pkg',
  'https://registry.example:8443/pkg',
])('rejects unsafe target before DNS: %s', async (target) => {
  await expect(read(target)).rejects.toMatchObject({ code: 'DENIED' });
  expect(io.lookup).not.toHaveBeenCalled();
  expect(io.request).not.toHaveBeenCalled();
});
it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1'])(
  'rejects mixed DNS containing %s before connecting',
  async (address) => {
    io.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address, family: 4 },
    ]);
    await expect(read()).rejects.toMatchObject({ code: 'DENIED' });
    expect(io.request).not.toHaveBeenCalled();
  },
);
it('rejects the host public interface address too', async () => {
  io.interfaces.mockReturnValue({ eth0: [{ address: '8.8.8.8' }] });
  await expect(read()).rejects.toMatchObject({ code: 'DENIED' });
  expect(io.request).not.toHaveBeenCalled();
});
it('pins the validated address without another resolver or proxy and preserves TLS identity', async () => {
  reply(200, 'ok');
  expect(
    Buffer.from(
      (await read('https://registry.example/pkg?q=1')).body,
    ).toString(),
  ).toBe('ok');
  const options = io.request.mock.calls[0]![0] as RequestOptions;
  expect(options).toMatchObject({
    hostname: 'registry.example',
    servername: 'registry.example',
    family: 4,
    agent: false,
    method: 'GET',
    path: '/pkg?q=1',
  });
  const pinned = vi.fn();
  options.lookup!('registry.example', {}, pinned);
  expect(pinned).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  expect(io.lookup).toHaveBeenCalledTimes(1);
  expect(options.headers).not.toHaveProperty('authorization');
});
it.each([
  [302, {}],
  [200, { 'content-encoding': 'gzip' }],
])(
  'rejects redirects and compressed responses (%s)',
  async (status, headers) => {
    reply(status, 'body', headers);
    await expect(read()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(io.request).toHaveBeenCalledTimes(1);
  },
);
it('enforces the byte budget on the response stream', async () => {
  reply(200, 'too large');
  await expect(read(undefined, 2)).rejects.toMatchObject({
    code: 'LIMIT_EXCEEDED',
  });
});
it('does not start a socket after authority aborts during DNS', async () => {
  const controller = new AbortController();
  io.lookup.mockImplementation(async () => {
    controller.abort();
    return [{ address: '8.8.8.8', family: 4 }];
  });
  await expect(read(undefined, 16, controller.signal)).rejects.toThrow();
  expect(io.request).not.toHaveBeenCalled();
});

function webRead(
  authorize: (target: string, signal: AbortSignal) => Promise<void>,
  maxRedirects = 2,
) {
  return fetchPublicHttps('https://weather.example/shanghai', {
    authorize,
    maxBytes: 16,
    maxRedirects,
    signal: new AbortController().signal,
    timeoutMs: 1_000,
  });
}

it('reauthorizes and pins each redirect hop', async () => {
  reply(307, '', { location: 'https://data.example/weather' }, true);
  reply(200, 'weather', { 'content-type': 'text/plain' });
  const authorize = vi.fn<(target: string) => Promise<void>>(async () => {});
  expect(await webRead(authorize)).toMatchObject({
    url: 'https://data.example/weather',
    status: 200,
    body: Buffer.from('weather'),
  });
  expect(authorize.mock.calls.map(([target]) => target)).toEqual([
    'https://weather.example/shanghai',
    'https://data.example/weather',
  ]);
  expect(io.lookup.mock.calls.map(([host]) => host)).toEqual([
    'weather.example',
    'data.example',
  ]);
});

it('rejects an unauthorized redirect before resolving its host', async () => {
  reply(302, '', { location: 'https://data.example/weather' }, true);
  const authorize = async (target: string) => {
    if (new URL(target).hostname !== 'weather.example')
      throw new EgressError('DENIED');
  };
  await expect(webRead(authorize)).rejects.toMatchObject({ code: 'DENIED' });
  expect(io.lookup).toHaveBeenCalledTimes(1);
  expect(io.request).toHaveBeenCalledTimes(1);
});

it('rejects the host on a redirect even if DNS uses a different IPv6 spelling', async () => {
  io.interfaces.mockReturnValue({
    eth0: [{ address: '2001:4860:4860:0:0:0:0:8888' }],
  });
  io.lookup
    .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    .mockResolvedValueOnce([{ address: '2001:4860:4860::8888', family: 6 }]);
  reply(302, '', { location: 'https://data.example' }, true);
  await expect(webRead(async () => {})).rejects.toMatchObject({
    code: 'DENIED',
  });
  expect(io.request).toHaveBeenCalledTimes(1);
});

it('rejects a redirect outside the budget before doing another lookup', async () => {
  reply(302, '', { location: '/loop' });
  await expect(webRead(async () => {}, 0)).rejects.toMatchObject({
    code: 'LIMIT_EXCEEDED',
  });
  expect(io.lookup).toHaveBeenCalledTimes(1);
});
