import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { apply } from './allrice-managed-web-search.mjs';

afterEach(() => vi.unstubAllGlobals());

async function stage(sessionId) {
  const registerSearchProvider = vi.fn();
  await apply(
    {
      web: { registerSearchProvider },
      agents: {
        currentInitiator: () =>
          sessionId ? { session: { id: sessionId } } : undefined,
      },
    },
    {
      cliPath: fileURLToPath(new URL('../package.json', import.meta.url)),
      origin: 'http://172.16.0.5:52400',
      capability: 'synthetic-epoch-capability',
      adapterId: 'guest-profile',
    },
  );
  expect(registerSearchProvider).toHaveBeenCalledOnce();
  return registerSearchProvider.mock.calls[0][0];
}

it('registers the native provider ID and sends only the local capability', async () => {
  const provider = await stage('active-session');
  const result = {
    sources: [{ url: 'https://one.example' }],
    truncated: false,
  };
  const fetch = vi.fn(async () => Response.json(result));
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  expect(provider.id).toBe('deepseek-official');
  expect(
    await provider.search({ query: 'test', maxResults: 3 }, signal),
  ).toEqual(result);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    new URL('http://172.16.0.5:52400/v1/web/search'),
    {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: {
        authorization: 'Bearer synthetic-epoch-capability',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        adapterId: 'guest-profile',
        sessionId: 'active-session',
        query: 'test',
        maxResults: 3,
      }),
    },
  );
});

it('requires the active native Session before dispatch', async () => {
  const provider = await stage(undefined);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(provider.search({ query: 'test' })).rejects.toMatchObject({
    code: 'WEB_PROVIDER_ERROR',
  });
  expect(fetch).not.toHaveBeenCalled();
});
