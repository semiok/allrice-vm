import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { readPlatformModelSettings } from '@allrice/database';
import { createDshGatewayProvider } from '@allrice/model-gateway';
import {
  AttachmentId,
  ImageVariantId,
  type ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment';
import {
  closeServer,
  gatewayFixture,
  listen,
  modelBinding,
} from '../../../../packages/model-gateway/src/gateway.fixture.js';
import { responsesFixture } from '../../../../packages/model-gateway/src/revision.fixture.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProductionCodexRuntime } from './production-codex-runtime.js';

const state = vi.hoisted(() => ({
  settings: vi.fn<typeof readPlatformModelSettings>(),
  subscription: vi.fn<() => Promise<{ slot: 1 | 2; revision: string }[]>>(),
  home: '',
}));
vi.mock('@allrice/database', () => ({
  getDatabase: () => state.subscription,
  readPlatformModelSettings: state.settings,
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
  state.settings.mockReset().mockResolvedValue({
    revision: 1,
    configuration: {
      connectionId: '52000000-0000-4000-8000-000000000001',
      workModel: 'gpt-6.2-sol',
      reasoningEffort: 'high',
      timeoutMs: 300_000,
      imageModel: 'auto',
      imagesEnabled: false,
    },
    updatedAt: '2026-11-26T00:00:00.000Z',
  });
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

it('pins the platform selection to the current Host and reads newer settings for the next Host', async () => {
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
      model: 'gpt-6.2-sol',
      transport: 'sse',
    });
    await expect(
      host.llm.prepareCall(
        { provider: host.route.provider, model: host.route.model },
        controller().signal,
      ),
    ).resolves.toMatchObject({
      config: {
        provider: host.route.provider,
        model: host.route.model,
        reasoningEffort: 'high',
      },
    });
    await expect(
      host.llm.prepareCall(
        { provider: host.route.provider, model: 'a-different-model' },
        controller().signal,
      ),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    await expect(
      host.readModelInfo(controller().signal),
    ).resolves.toMatchObject({
      name: 'GPT-6.2 Sol',
      reasoning: { defaultEffort: 'high' },
    });
    const current = await state.settings.mock.results[0]!.value;
    state.settings.mockResolvedValue({
      ...current,
      revision: 2,
      configuration: {
        ...current.configuration,
        workModel: 'gpt-6.1-sol',
        reasoningEffort: 'medium',
      },
    });
    const next = await createProductionCodexRuntime(
      controller().signal,
      'next-owner',
    );
    try {
      expect(host.route.model).toBe('gpt-6.2-sol');
      expect(next.route.model).toBe('gpt-6.1-sol');
      await expect(
        next.readModelInfo(controller().signal),
      ).resolves.toMatchObject({
        reasoning: { defaultEffort: 'medium' },
      });
      expect(state.settings).toHaveBeenCalledTimes(2);
      expect(external).not.toHaveBeenCalled();
    } finally {
      await next.close();
    }
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
    const old = await host.assertCurrent();
    state.subscription.mockResolvedValue([{ slot: 2, revision: '3' }]);
    await expect(host.assertCurrent()).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    expect(old.aborted).toBe(true);
    expect(host.revoked.aborted).toBe(false);
    const current = await host.assertCurrent();
    expect(current).not.toBe(old);
    expect(current.aborted).toBe(false);
    state.subscription.mockRejectedValueOnce(Error('synthetic SQL failure'));
    await expect(host.assertCurrent()).rejects.toThrow('synthetic SQL failure');
    expect(current.aborted).toBe(true);
    const recovered = await host.assertCurrent();
    expect(recovered.aborted).toBe(false);
  } finally {
    await host.close();
  }
});

it('does not enable the route without a grant from the managed store', async () => {
  state.subscription.mockResolvedValue([]);
  const host = await createProductionCodexRuntime(
    controller().signal,
    'test-owner',
  );
  try {
    await expect(host.assertCurrent()).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    state.subscription.mockResolvedValue([{ slot: 1, revision: '1' }]);
    await expect(host.assertCurrent()).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    await saveSyntheticGrant();
    expect((await host.assertCurrent()).aborted).toBe(false);
  } finally {
    await host.close();
  }
});

it('refreshes an expired managed Codex grant and meters an image-capable SSE request through the production runtime', async () => {
  await saveSyntheticGrant(0);
  const nativeFetch = globalThis.fetch;
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const data = Buffer.from(png, 'base64');
  const image = {
    attachmentId: AttachmentId('fixture-image'),
    mediaType: 'image/png' as const,
    width: 1,
    height: 1,
    bytes: data.length,
  };
  let outboundImage = false;
  const sse = await responsesFixture({
    codex: true,
    onRequestBody(body, contentEncoding) {
      // The rc.2 Codex SSE provider compresses the actual model request on
      // Node versions supporting zstd. Inspect the received wire bytes.
      expect([undefined, 'zstd']).toContain(contentEncoding);
      const payload = JSON.parse(
        (contentEncoding === 'zstd' ? zstdDecompressSync(body) : body).toString(
          'utf8',
        ),
      );
      expect(payload).toMatchObject({
        model: 'gpt-6.2-sol',
        reasoning: { effort: 'high' },
      });
      outboundImage = payload.input.some(
        (item: { content?: { type?: string; image_url?: string }[] }) =>
          Array.isArray(item.content) &&
          item.content.some(
            (part) =>
              part.type === 'input_image' &&
              part.image_url === 'data:image/png;base64,' + png,
          ),
      );
    },
  });
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
  const selected = modelBinding();
  const readImage = vi.fn(
    async (
      binding: typeof selected,
      ref: ImageAttachmentRef,
      target: { width: number; height: number; maxBytes: number } | null,
      signal: AbortSignal,
    ) => {
      expect(binding.vm).toEqual(selected.vm);
      expect(binding.native.sessionId).toBe(selected.native.sessionId);
      expect(ref).toEqual(image);
      expect(target).toMatchObject({ width: 1, height: 1 });
      expect(signal.aborted).toBe(false);
      return {
        ...image,
        variantId: ImageVariantId('fixture-variant'),
        attachment: image,
        data,
        depth: 'uchar' as const,
        space: 'srgb' as const,
        hasAlpha: false,
      };
    },
  );
  const host = await createProductionCodexRuntime(
    controller().signal,
    'fixture-production-codex',
    readImage,
  );
  const gateway = await gatewayFixture({
    binding: {
      ...selected,
      provider: host.route.provider,
      model: host.route.model,
    },
    provider: createDshGatewayProvider(
      host.llm,
      host.route,
      host.transport.fetchOwned,
      host.transport.beforeDispatch,
      host.scopeStream,
    ),
  });
  try {
    const chunks = await gateway.collect({
      ...gateway.input(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Synthetic picture' },
            { type: 'image', attachment: image },
          ],
        },
      ],
    });
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
    });
    expect(readImage).toHaveBeenCalledOnce();
    expect(used).toContain('https://chatgpt.com/backend-api/codex/responses');
    expect(outboundImage).toBe(true);
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
