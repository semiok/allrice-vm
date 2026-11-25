import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProductionCodexRuntime } from './production-codex-runtime.js';

const state = vi.hoisted(() => ({
  subscription: vi.fn<() => Promise<1 | 2>>(),
  home: '',
}));
vi.mock('@allrice/database', () => ({
  requireEnabledCodexSubscription: state.subscription,
}));
vi.mock('../codex-subscription-home.js', () => ({
  codexSubscriptionHome: () => state.home,
}));
const controller = () => new AbortController();

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'allrice-codex-host-fixture-'));
  state.subscription.mockReset().mockResolvedValue(1);
  vi.stubEnv('ALLRICE_DSH_CODEX_MODEL', 'gpt-6.1-sol');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(state.home, { recursive: true, force: true });
});

async function saveSyntheticGrant() {
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
      '      expires: 4102444800000',
    ].join('\n'),
    { mode: 0o600 },
  );
}

it('loads the pinned native model route from a stored subscription without making a model call', async () => {
  await saveSyntheticGrant();
  const external = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', external);
  const host = await createProductionCodexRuntime(controller().signal);
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

it('accepts only the exact metered POST destinations and revokes a stale subscription owner', async () => {
  await saveSyntheticGrant();
  const host = await createProductionCodexRuntime(controller().signal);
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
    state.subscription.mockResolvedValue(2);
    await expect(host.assertCurrent()).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    expect(host.revoked.aborted).toBe(true);
    state.subscription.mockResolvedValue(1);
    await expect(host.assertCurrent()).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
  } finally {
    await host.close();
  }
});

it('does not enable the route without a grant from the managed store', async () => {
  await expect(
    createProductionCodexRuntime(controller().signal),
  ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
});
