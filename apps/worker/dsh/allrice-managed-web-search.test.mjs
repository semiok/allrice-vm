import { fileURLToPath, URL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Web from '@deepseek-ai/dsh-web';
import * as NativeWeb from '@deepseek-ai/dsh-tool-web';
import { afterEach, expect, it, vi } from 'vitest';
import { apply } from './allrice-managed-web-search.mjs';

afterEach(() => vi.unstubAllGlobals());

async function stage(sessionId, enabled = true) {
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
      enabled,
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
  const fetch = vi.fn(async () => globalThis.Response.json(result));
  vi.stubGlobal('fetch', fetch);
  const signal = new globalThis.AbortController().signal;
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

it('does not announce Search as available without a configured Host route', async () => {
  const provider = await stage('active-session', false);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(provider.available()).toBe(false);
  await expect(provider.search({ query: 'test' })).rejects.toMatchObject({
    code: 'WEB_PROVIDER_ERROR',
  });
  expect(fetch).not.toHaveBeenCalled();
});

it('runs native web_search with the unchanged DeepSeek provider selection and output', async () => {
  const ctx = new Context();
  const reply = {
    sources: [{ url: 'https://one.example', title: 'Weather reference' }],
    truncated: false,
  };
  const fetch = vi.fn(async () => globalThis.Response.json(reply));
  vi.stubGlobal('fetch', fetch);
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Tools);
    await ctx.plugin(Web, { searchProvider: 'deepseek-official' });
    await apply(
      {
        web: ctx.web,
        agents: { currentInitiator: () => ({ session: { id: 'child' } }) },
      },
      {
        cliPath: fileURLToPath(new URL('../package.json', import.meta.url)),
        origin: 'http://172.16.0.5:52400',
        capability: 'synthetic-epoch-capability',
        adapterId: 'guest-profile',
        enabled: true,
      },
    );
    await ctx.plugin(NativeWeb, { fetch: false });
    const result = await ctx.tools.execute({
      name: 'web_search',
      arguments: { queries: ['test'] },
      callId: 'call',
      agent: { id: 'child' },
      signal: new globalThis.AbortController().signal,
    });
    expect(result.isError).toBe(false);
    expect(result.value).toEqual(reply);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      expect.any(URL),
      expect.objectContaining({
        body: JSON.stringify({
          adapterId: 'guest-profile',
          sessionId: 'child',
          query: 'test',
          maxResults: 8,
        }),
      }),
    );
  } finally {
    await ctx.fiber.dispose();
  }
});
