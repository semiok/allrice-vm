import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createDshGatewayProvider } from '@allrice/model-gateway';
import {
  closeServer,
  gatewayFixture,
  listen,
  modelBinding,
} from '../../../../packages/model-gateway/src/gateway.fixture.js';
import { responsesFixture } from '../../../../packages/model-gateway/src/revision.fixture.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProductionCodexRuntime } from './production-codex-runtime.js';

const state = vi.hoisted(() => ({
  subscription: vi.fn<() => Promise<{ slot: 1 | 2; revision: string }[]>>(),
  home: '',
}));
vi.mock('@allrice/database', () => ({
  getDatabase: () => state.subscription,
}));
vi.mock('../codex-subscription-home.js', () => ({
  codexSubscriptionHome: () => state.home,
}));
const controller = () => new AbortController();

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'allrice-codex-host-fixture-'));
  state.subscription
    .mockReset()
    .mockResolvedValue([{ slot: 1, revision: '1' }]);
  vi.stubEnv('ALLRICE_DSH_CODEX_MODEL', 'gpt-6.1-sol');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(state.home, { recursive: true, force: true });
});

async function saveSyntheticGrant(expires = 4102444800000) {
  await writeFile(
    join(state.home, '.credentials.yaml'),
    [
      'version: 1',
      'refs: {}',
      'records:',
      '  llm-pi-ai/openai-codex:',
      '    kind: grant',
      '    payload:',
      '      type: oauth',
      '      access: fixture-access',
      '      refresh: fixture-refresh',
      `      expires: ${expires}`,
    ].join('\n'),
    { mode: 0o600 },
  );
}

it('loads the pinned native model route from a stored subscription without making a model call', async () => {
  await saveSyntheticGrant();
  const external = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', external);
  const host = await createProductionCodexRuntime(
    controller().signal,
    'test-owner',
  );
  try {
    expect(host.route).toMatchObject({
      provider: 'openai-codex',
      model: 'gpt-6.1-sol',
      transport: 'sse',
    });
    await expect(
      host.llm.prepareCall(
        { provider: host.route.provider, model: host.route.model },
        controller().signal,
      ),
    ).resolves.toMatchObject({
      config: { provider: host.route.provider, model: host.route.model },
    });
    await expect(
      host.llm.prepareCall(
        { provider: host.route.provider, model: 'a-different-model' },
        controller().signal,
      ),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    expect(external).not.toHaveBeenCalled();
  } finally {
    try {
      await host.close();
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

it('accepts only metered POST destinations and revokes an old owner after switching away and back', async () => {
  await saveSyntheticGrant();
  const host = await createProductionCodexRuntime(
    controller().signal,
    'test-owner',
  );
  try {
    const model = 'https://chatgpt.com/backend-api/codex/responses';
    expect(host.route.classify(model, { method: 'POST' })).toEqual({
      kind: 'model',
      protocol: 'openai-responses',
    });
    expect(
      host.route.classify(
        new Request('https://auth.openai.com/oauth/token', {
          method: 'POST',
        }),
      ),
    ).toEqual({ kind: 'auth-refresh', protocol: 'opaque' });
    expect(host.route.classify(model, { method: 'GET' })).toBeNull();
    expect(
      host.route.classify(model + '?different=1', { method: 'POST' }),
    ).toBeNull();
    expect(
      host.route.classify(model.replace('https:', 'http:'), { method: 'POST' }),
    ).toBeNull();
    state.subscription.mockResolvedValue([{ slot: 1, revision: '3' }]);
    await expect(host.assertCurrent()).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    expect(host.revoked.aborted).toBe(true);
    state.subscription.mockResolvedValue([{ slot: 1, revision: '1' }]);
    await expect(host.assertCurrent()).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
  } finally {
    await host.close();
  }
});

it('does not enable the route without a grant from the managed store', async () => {
  await expect(
    createProductionCodexRuntime(controller().signal, 'test-owner'),
  ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
});

it('refreshes an expired managed Codex grant and meters the fixed SSE route through the production runtime', async () => {
  await saveSyntheticGrant(0);
  const nativeFetch = globalThis.fetch;
  const sse = await responsesFixture({ codex: true });
  const access = [
    'fixture',
    Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'fixture-account',
        },
      }),
    ).toString('base64url'),
    'fixture-signature',
  ].join('.');
  let refreshes = 0;
  const refresh = createServer(async (request, response) => {
    for await (const part of request) void part;
    refreshes++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        access_token: access,
        refresh_token: 'fixture-rotated-refresh',
        expires_in: 3600,
      }),
    );
  });
  const oauth = await listen(refresh);
  const used: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (!(input instanceof Request)) return nativeFetch(input, init);
    const target = {
      'https://auth.openai.com/oauth/token': oauth,
      'https://chatgpt.com/backend-api/codex/responses': sse.url,
    }[input.url];
    if (!target) return nativeFetch(input, init);
    used.push(input.url);
    const wire = {
      ...init,
      method: input.method,
      headers: input.headers,
      signal: input.signal,
    };
    return nativeFetch(target, wire);
  });
  const host = await createProductionCodexRuntime(
    controller().signal,
    'fixture-production-codex',
  );
  const gateway = await gatewayFixture({
    binding: {
      ...modelBinding(),
      provider: host.route.provider,
      model: host.route.model,
    },
    provider: createDshGatewayProvider(
      host.llm,
      host.route,
      host.transport.fetchOwned,
    ),
  });
  try {
    const chunks = await gateway.collect();
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
    });
    const attempts = [...gateway.store.rows.values()];
    expect(attempts).toMatchObject([
      { kind: 'auth-refresh', httpStatus: 200, outcome: 'closed' },
      {
        kind: 'model',
        httpStatus: 200,
        outcome: 'closed',
        usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 },
      },
    ]);
    expect(used).toEqual([
      'https://auth.openai.com/oauth/token',
      'https://chatgpt.com/backend-api/codex/responses',
    ]);
    expect(refreshes).toBe(1);
    expect(
      await readFile(join(state.home, '.credentials.yaml'), 'utf8'),
    ).toContain('fixture-rotated-refresh');
    expect(sse.active).toBe(0);
  } finally {
    await Promise.all([gateway.close(), closeServer(refresh), sse.close()]);
    await host.close();
    vi.unstubAllGlobals();
  }
});
