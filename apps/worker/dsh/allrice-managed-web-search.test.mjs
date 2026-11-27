import { URL } from 'node:url';
import { TextDecoder } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Web, { WebError } from '@deepseek-ai/dsh-web';
import * as NativeWeb from '@deepseek-ai/dsh-tool-web';
import { afterEach, expect, it, vi } from 'vitest';
import {
  apply,
  observeManagedSearchCalls,
} from './allrice-managed-web-search.mjs';

afterEach(() => vi.unstubAllGlobals());

const settings = {
  origin: 'http://172.16.0.5:52400',
  capability: 'synthetic-epoch-capability',
  adapterId: 'guest-profile',
  enabled: true,
};
const result = {
  sources: [{ url: 'https://one.example' }],
  truncated: false,
};
const origin = (signal) => ({
  signal,
  proof: {
    rootSessionId: 'root',
    claims: [{ scopeId: 'exact-principal', requestId: 'original-prompt' }],
    turn: 1,
  },
});
const execution = (id) => ({
  callId: id,
  name: 'web_search',
  arguments: { queries: ['test'] },
  agent: { id: 'child', session: { id: 'child' } },
  signal: new globalThis.AbortController().signal,
});

async function stage(enabled = true) {
  const registerSearchProvider = vi.fn();
  let run;
  const turn = new globalThis.AbortController();
  const open = observeManagedSearchCalls(
    {
      on(_event, listener) {
        run = listener;
      },
    },
    settings.adapterId,
    turn.signal,
    () => origin(turn.signal),
  );
  await apply(
    { web: { registerSearchProvider } },
    { ...settings, enabled },
    WebError,
  );
  expect(registerSearchProvider).toHaveBeenCalledOnce();
  return { provider: registerSearchProvider.mock.calls[0][0], run, open, turn };
}

it('binds the exact native arguments and consumes the proof once before delivering Search', async () => {
  const { provider, run, open } = await stage();
  let observed;
  const host = vi.fn(async (url, options) => {
    expect(url.href).toBe('http://172.16.0.5:52400/v1/web/search');
    expect(options.headers.authorization).toBe(
      'Bearer synthetic-epoch-capability',
    );
    expect(options.redirect).toBe('error');
    const request = JSON.parse(options.body);
    expect(request).toEqual({
      adapterId: settings.adapterId,
      sessionId: 'child',
      ticket: expect.any(String),
      query: 'test',
      maxResults: 3,
    });
    const ownerRequest = { signal: new globalThis.AbortController().signal };
    expect(open({ ...request, query: 'altered' }, ownerRequest).status).toBe(
      404,
    );
    observed = open(request, ownerRequest).body.getReader();
    expect(open(request, ownerRequest).status).toBe(404);
    const proof = JSON.parse(
      new TextDecoder().decode((await observed.read()).value),
    );
    expect(proof).toEqual({
      ...origin().proof,
      callId: 'first-call',
      sessionId: 'child',
    });
    return globalThis.Response.json(result);
  });
  vi.stubGlobal('fetch', host);
  expect(provider.id).toBe('deepseek-official');
  expect(
    await run(execution('first-call'), () =>
      provider.search({ query: 'test', maxResults: 3 }),
    ),
  ).toEqual(result);
  expect(new TextDecoder().decode((await observed.read()).value)).toBe(
    'ended\n',
  );
  expect((await observed.read()).done).toBe(true);
  expect(host).toHaveBeenCalledOnce();
});

it('denies Search without a live exact tool scope, and without a configured Host route', async () => {
  const { provider, run } = await stage(false);
  const enabled = await stage();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(provider.available()).toBe(false);
  await expect(
    run(execution('closed'), () => provider.search({ query: 'test' })),
  ).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
  await expect(
    enabled.provider.search({ query: 'test' }),
  ).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
  await expect(
    enabled.run(execution('valid'), () =>
      enabled.provider.search({ query: 'different tool argument' }),
    ),
  ).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
  expect(fetch).not.toHaveBeenCalled();
});

it('expires the native owner proof and cancels the active request when its turn ends', async () => {
  const { provider, run, open, turn } = await stage();
  let expired;
  vi.stubGlobal('fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    const ownerRequest = { signal: new globalThis.AbortController().signal };
    const reader = open(request, ownerRequest).body.getReader();
    await reader.read();
    turn.abort();
    expect(options.signal.aborted).toBe(true);
    expired = await reader.read();
    expect(open(request, ownerRequest).status).toBe(404);
    options.signal.throwIfAborted();
  });
  await expect(
    run(execution('ended'), () => provider.search({ query: 'test' })),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(new TextDecoder().decode(expired.value)).toBe('ended\n');
});

it('runs native web_search with the unchanged DeepSeek provider selection and output', async () => {
  const ctx = new Context();
  const fetch = vi.fn(async () => globalThis.Response.json(result));
  vi.stubGlobal('fetch', fetch);
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Tools);
    await ctx.plugin(Web, { searchProvider: 'deepseek-official' });
    const turn = new globalThis.AbortController();
    observeManagedSearchCalls(ctx, settings.adapterId, turn.signal, () =>
      origin(turn.signal),
    );
    await apply({ web: ctx.web }, settings, WebError);
    await ctx.plugin(NativeWeb, { fetch: false });
    const outcome = await ctx.tools.execute(execution('real-call'));
    expect(outcome.isError).toBe(false);
    expect(outcome.value).toEqual(result);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      adapterId: settings.adapterId,
      sessionId: 'child',
      ticket: expect.any(String),
      query: 'test',
      maxResults: 8,
    });
  } finally {
    await ctx.fiber.dispose();
  }
});

it('reports the unavailable registered provider without a host Search key or an upstream call', async () => {
  const ctx = new Context();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    await ctx.plugin(Web, { searchProvider: 'deepseek-official' });
    await expect(ctx.web.search({ query: 'test' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_MISSING',
      message: 'configured web provider "deepseek-official" is not registered',
    });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await ctx.fiber.dispose();
  }
});
