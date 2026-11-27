import { afterEach, expect, it, vi } from 'vitest';
import {
  EmployeeProfileBundleTimeout,
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
  expect(resolve({ url: row.reference, rev: row.revision })).toBe(
    root + 'bundles/' + sha256 + '.js',
  );
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
