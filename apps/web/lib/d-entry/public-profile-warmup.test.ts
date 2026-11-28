import { afterEach, expect, it, vi } from 'vitest';
import { warmPublicProfileAssets } from './public-profile-warmup';

afterEach(() => vi.unstubAllGlobals());

it('warms only exact immutable URLs, once and without credentials or redirects', async () => {
  const body = vi.fn();
  const request = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(Uint8Array.of(1));
            stream.close();
            body();
          },
        }),
      ),
  );
  vi.stubGlobal('fetch', request);
  const root = '/_next/static/dsh-profile/' + 'a'.repeat(64) + '/';
  const entry = root + 'managed/employee-web-entry.js';
  const bundle = root + 'bundles/' + 'b'.repeat(64) + '.js';
  await warmPublicProfileAssets(
    [
      entry,
      bundle,
      entry,
      entry + '?scopeId=x',
      entry + '\n',
      root + 'managed/../employee-web-entry.js',
      root + 'managed/debug.js.map',
      root + 'native/index.html',
      root + 'native/assets/file.js',
      'https://other.test' + entry,
      '/api/v1/d-entry/profile/bootstrap',
    ],
    new AbortController().signal,
  );
  expect(request.mock.calls).toEqual(
    [entry, bundle].map((url) => [
      url,
      {
        cache: 'force-cache',
        credentials: 'omit',
        redirect: 'error',
        priority: 'low',
        signal: expect.any(AbortSignal),
      },
    ]),
  );
  expect(body).toHaveBeenCalledTimes(2);
});
