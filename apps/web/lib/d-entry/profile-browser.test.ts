import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  EmployeeProfileBundleTimeout,
  profileBundleReference,
  readProfileBundle,
  releasedBundleResolver,
} from './profile-browser';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('uses a public digest only for the exact graph resource and revision', () => {
  const root = '/_next/static/dsh-profile/' + 'a'.repeat(64) + '/';
  const sha256 = 'b'.repeat(64);
  const row = {
    reference: 'plugins/??exact/client.js&rev=r1',
    revision: 'r1',
    sha256,
  };
  const data = { publicAssetRoot: root, publicBundles: JSON.stringify([row]) };
  const resolve = releasedBundleResolver(data);
  expect(resolve({ url: row.reference, rev: row.revision })).toEqual({
    url: root + 'bundles/' + sha256 + '.js',
  });
  expect(resolve({ url: row.reference, rev: 'r2' })).toBeUndefined();
  expect(
    resolve({ url: 'plugins/??other/client.js&rev=r1', rev: 'r1' }),
  ).toBeUndefined();
  expect(
    releasedBundleResolver({
      ...data,
      publicAssetRoot: 'https://other.example/',
    })({ url: row.reference, rev: 'r1' }),
  ).toBeUndefined();
});

it('uses the same verified public packet after relocation and reconstructs the admitted native order', async () => {
  const root = '/_next/static/dsh-profile/' + 'a'.repeat(64) + '/';
  const rev = '1'.repeat(12);
  const url = `plugins/??@dsh/second/client.js,@dsh/first/client.js&rev=${rev}`;
  const first = 'first("中");\n';
  const second = 'second();\n';
  const bytes = new TextEncoder().encode(first + second + 'sealed trailer');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const data = {
    publicAssetRoot: root,
    publicBundles: JSON.stringify([
      {
        reference: 'sealed',
        revision: 'build',
        sha256,
        layout: {
          phase: 'application',
          byteLength: bytes.length,
          entries: [
            { id: '@dsh/first', offset: 0, length: Buffer.byteLength(first) },
            {
              id: '@dsh/second',
              offset: Buffer.byteLength(first),
              length: Buffer.byteLength(second),
            },
          ],
        },
      },
    ]),
  };
  const resolve = releasedBundleResolver(data);
  const batch = {
    url,
    rev,
    phase: 'application',
    entries: ['@dsh/second', '@dsh/first'],
  };
  const packet = resolve(batch)!;
  expect(packet.url).toBe(root + 'bundles/' + sha256 + '.js');
  const received = await packet.assemble!(bytes.buffer);
  expect(new TextDecoder().decode(received)).toBe(
    second +
      first +
      '//# sourceMappingURL=' +
      url.slice('plugins/'.length).replaceAll('/client.js', '/client.js.map') +
      '\n',
  );
  const changed = bytes.slice();
  changed[0] = 0;
  await expect(packet.assemble!(changed.buffer)).rejects.toThrow(
    'Invalid public profile packet digest',
  );
  await expect(packet.assemble!(bytes.slice(0, -1).buffer)).rejects.toThrow(
    'Invalid public profile packet length',
  );
  expect(resolve({ ...batch, phase: 'bootstrap' })).toBeUndefined();
  expect(
    resolve({ ...batch, entries: ['@dsh/first', '@dsh/second'] }),
  ).toBeUndefined();
  expect(
    resolve({
      ...batch,
      entries: ['@dsh/third'],
      url: `plugins/??@dsh/third/client.js&rev=${rev}`,
    }),
  ).toBeUndefined();
});

it('routes a native package-local browser chunk only at its owning graph revision', () => {
  const id = '@deepseek-ai/dsh-client-ui-sidebar-terminal';
  const rev = '0a123ba325cd';
  const graph = {
    rev,
    release: { version: '0.2.1-rc.2' },
    entries: [{ id, url: `plugins/??${id}/client.js&rev=${rev}`, rev }],
    batches: [],
  };
  const url = `plugins/${id}/client.terminal.js?rev=${rev}`;
  expect(profileBundleReference(graph, url)).toEqual({ url, rev });
  for (const bad of [
    url.replace(id, '@deepseek-ai/other-package'),
    url.replace(rev, 'other'),
    url.replace('client.terminal.js', 'client.node.js'),
    url.replace('client.terminal.js', '../client.terminal.js'),
    url + '&rev=other',
  ])
    expect(profileBundleReference(graph, bad)).toBeUndefined();
});

it('falls back through the authenticated no-store path when the public body is interrupted', async () => {
  const scoped = new URL('https://allrice.test/api/v1/d-entry/profile/assets');
  const interrupted = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('public stream ended'));
      },
    }),
  );
  const request = vi
    .fn()
    .mockResolvedValueOnce(interrupted)
    .mockResolvedValueOnce(new Response('verified'));
  vi.stubGlobal('fetch', request);
  const signal = new AbortController().signal;
  const direct = '/_next/static/dsh-profile/example.js';
  const bytes = await readProfileBundle(scoped, signal, direct);
  expect(new TextDecoder().decode(bytes)).toBe('verified');
  expect(request).toHaveBeenNthCalledWith(1, direct, {
    signal: expect.any(AbortSignal),
    credentials: 'omit',
    cache: 'force-cache',
    redirect: 'error',
  });
  expect(request).toHaveBeenNthCalledWith(2, scoped, {
    signal: expect.any(AbortSignal),
    credentials: 'same-origin',
    cache: 'no-store',
  });
});

it('does not fall back after the scoped page is revoked', async () => {
  const controller = new AbortController();
  const request = vi.fn(async () => {
    controller.abort();
    throw Error('aborted public request');
  });
  vi.stubGlobal('fetch', request);
  await expect(
    readProfileBundle(
      new URL('https://allrice.test/scoped'),
      controller.signal,
      '/public.js',
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).toHaveBeenCalledTimes(1);
});

it('consumes fetched public bytes once and keeps fallback scoped if preloading fails', async () => {
  const scoped = new URL('https://allrice.test/scoped');
  const direct = '/_next/static/dsh-profile/example.js';
  const signal = new AbortController().signal;
  const request = vi.fn().mockResolvedValue(new Response('scoped'));
  vi.stubGlobal('fetch', request);
  const bytes = new TextEncoder().encode('public').buffer;
  await expect(
    readProfileBundle(scoped, signal, direct, Promise.resolve(bytes)),
  ).resolves.toBe(bytes);
  expect(request).not.toHaveBeenCalled();
  const fallback = await readProfileBundle(
    scoped,
    signal,
    direct,
    Promise.reject(Error('preload unavailable')),
  );
  expect(new TextDecoder().decode(fallback)).toBe('scoped');
  expect(request).toHaveBeenCalledExactlyOnceWith(scoped, {
    signal: expect.any(AbortSignal),
    credentials: 'same-origin',
    cache: 'no-store',
  });
});

it('aborts an incomplete bundle body and retries the authorized request once', async () => {
  vi.useFakeTimers();
  const request = vi
    .fn()
    .mockImplementationOnce(
      (_url, { signal }: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener(
                'abort',
                () => controller.error(signal.reason),
                { once: true },
              );
            },
          }),
        ),
    )
    .mockResolvedValueOnce(new Response('verified'));
  vi.stubGlobal('fetch', request);
  const parent = new AbortController().signal;
  const body = readProfileBundle(
    new URL('https://allrice.test/scoped'),
    parent,
  );
  await vi.advanceTimersByTimeAsync(30_000);
  expect(new TextDecoder().decode(await body)).toBe('verified');
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0]![1].signal.aborted).toBe(true);
  expect(parent.aborted).toBe(false);
});

it('bounds a stalled public bundle plus its scoped fallback', async () => {
  vi.useFakeTimers();
  const request = vi.fn((_url, { signal }: RequestInit) =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener(
              'abort',
              () => controller.error(signal.reason),
              { once: true },
            );
          },
        }),
      ),
    ),
  );
  vi.stubGlobal('fetch', request);
  const result = readProfileBundle(
    new URL('https://allrice.test/scoped'),
    new AbortController().signal,
    '/public.js',
  );
  const rejected = expect(result).rejects.toBeInstanceOf(
    EmployeeProfileBundleTimeout,
  );
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  expect(request).toHaveBeenCalledTimes(2);
});

it('keeps receiving a progressing bundle past thirty seconds without restarting', async () => {
  vi.useFakeTimers();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const request = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            body = controller;
          },
        }),
      ),
  );
  vi.stubGlobal('fetch', request);
  const result = readProfileBundle(
    new URL('https://allrice.test/scoped'),
    new AbortController().signal,
  );
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(15_000);
    body.enqueue(Uint8Array.of(65 + i));
    await vi.advanceTimersByTimeAsync(0);
  }
  body.close();
  expect(new TextDecoder().decode(await result)).toBe('ABCD');
  expect(request).toHaveBeenCalledOnce();
});

it('bounds even a continuously progressing download', async () => {
  vi.useFakeTimers();
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const request = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            bodies.push(controller);
          },
        }),
      ),
  );
  vi.stubGlobal('fetch', request);
  const result = readProfileBundle(
    new URL('https://allrice.test/scoped'),
    new AbortController().signal,
    '/public.js',
  );
  for (let i = 0; i < 7; i++) {
    await vi.advanceTimersByTimeAsync(15_000);
    bodies[0]!.enqueue(Uint8Array.of(65));
    await vi.advanceTimersByTimeAsync(0);
  }
  await vi.advanceTimersByTimeAsync(15_000);
  expect(request).toHaveBeenCalledTimes(2);
  bodies[1]!.enqueue(Uint8Array.of(66));
  bodies[1]!.close();
  expect(new TextDecoder().decode(await result)).toBe('B');
});
