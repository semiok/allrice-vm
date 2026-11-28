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
  deferred,
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
  statementTimeout: vi.fn(async () => []),
  subscription:
    vi.fn<
      (
        _query: TemplateStringsArray,
        connectionId: string,
      ) => Promise<{ slot: 1 | 2; revision: string }[]>
    >(),
  home: '',
}));
vi.mock('@allrice/database', () => ({
  getDatabase: () => ({
    begin: (_mode: string, query: (tx: typeof state.subscription) => unknown) =>
      query(((parts: TemplateStringsArray, connectionId: string) =>
        parts[0].startsWith('set local statement_timeout')
          ? state.statementTimeout()
          : state.subscription(
              parts,
              connectionId,
            )) as typeof state.subscription),
  }),
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
      host.readModelMetadata(controller().signal),
    ).resolves.toMatchObject({
      modelInfo: { name: 'GPT-6.2 Sol', reasoning: { defaultEffort: 'high' } },
      historicalModels: expect.arrayContaining([
        expect.objectContaining({
          id: 'gpt-6.1-sol',
          inputModalities: ['text', 'image'],
        }),
        expect.objectContaining({
          id: 'gpt-5.6-sol',
          inputModalities: ['text', 'image'],
        }),
      ]),
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
        next.readModelMetadata(controller().signal),
      ).resolves.toMatchObject({
        modelInfo: { reasoning: { defaultEffort: 'medium' } },
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
    expect(state.subscription.mock.lastCall?.[1]).toBe(
      '52000000-0000-4000-8000-000000000001',
    );
    // A revoked connection leaves no joined ready subscription even if a
    // credential grant still exists on disk.
    state.subscription.mockResolvedValueOnce([]);
    await expect(host.assertCurrent()).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    expect(recovered.aborted).toBe(true);
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

it('proves both transports stopped while a timed database read is still settling', async () => {
  await saveSyntheticGrant();
  const host = await createProductionCodexRuntime(
    controller().signal,
    'slot-query-fixture',
  );
  const entered = deferred();
  const held = deferred<{ slot: 1; revision: string }[]>();
  state.statementTimeout.mockClear();
  state.subscription.mockImplementationOnce(() => {
    entered.resolve();
    return held.promise;
  });
  const reading = host.assertCurrent();
  try {
    await entered.promise;
    const closing = host.close();
    const proof = await host.confirmTransportStopped(
      'slot-query-fixture',
      AbortSignal.timeout(1500),
    );
    expect(proof).toContain('undici-owner-stopped:slot-query-fixture:auth:');
    expect(state.statementTimeout).toHaveBeenCalledOnce();
    held.resolve([{ slot: 1, revision: '1' }]);
    await expect(reading).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
    await closing;
  } finally {
    held.resolve([{ slot: 1, revision: '1' }]);
    await Promise.allSettled([reading, host.close()]);
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

it('joins OAuth rotation before closing its pool when a Codex route is withdrawn, retaining the grant for its peer', async () => {
  await saveSyntheticGrant(0);
  const refreshing = deferred();
  const completeRefresh = deferred();
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
  let refreshCount = 0;
  const refresh = createServer(async (request, response) => {
    for await (const part of request) void part;
    refreshCount++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    refreshing.resolve();
    await completeRefresh.promise;
    response.end(
      JSON.stringify({
        access_token: access,
        refresh_token: 'fixture-rotated-refresh',
        expires_in: 3600,
      }),
    );
  });
  const oauth = await listen(refresh);
  const upstream = await responsesFixture({ codex: true });
  const signal = controller().signal;
  const first = await createProductionCodexRuntime(signal, 'codex-first');
  const peer = await createProductionCodexRuntime(
    signal,
    'codex-peer',
    undefined,
    'gpt-6.1-sol',
  );
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (!(input instanceof Request)) return nativeFetch(input, init);
    const target = {
      'https://auth.openai.com/oauth/token': oauth,
      'https://chatgpt.com/backend-api/codex/responses': upstream.url,
    }[input.url];
    if (!target) {
      if (new URL(input.url).hostname !== '127.0.0.1')
        throw Error('non-local fixture');
      return nativeFetch(input, init);
    }
    return nativeFetch(target, {
      ...init,
      method: input.method,
      headers: input.headers,
      signal: input.signal,
    });
  });
  const start = (host: typeof first) =>
    gatewayFixture({
      binding: {
        ...modelBinding(),
        provider: host.route.provider,
        model: host.route.model,
      },
      provider: createDshGatewayProvider(
        host.llm,
        host.route,
        host.transport.fetchOwned,
        host.transport.beforeDispatch,
        host.scopeStream,
        host.transport.confirmClosed,
      ),
    });
  const a = await start(first);
  const b = await start(peer);
  const request = a.collect().catch(() => null);
  try {
    await refreshing.promise;
    let joined = false;
    const retirement = first.close().then(() => (joined = true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(first.revoked.aborted).toBe(true);
    expect(peer.revoked.aborted).toBe(false);
    expect(joined).toBe(false);
    completeRefresh.resolve();
    await retirement;
    await request;
    expect(
      [...a.store.rows.values()].map(({ kind, outcome }) => [kind, outcome]),
    ).toEqual([['auth-refresh', 'closed']]);
    expect(
      await readFile(join(state.home, '.credentials.yaml'), 'utf8'),
    ).toContain('fixture-rotated-refresh');
    expect((await b.collect()).at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
    });
    expect(refreshCount).toBe(1);
  } finally {
    completeRefresh.resolve();
    await Promise.all([a.close(), b.close(), first.close(), peer.close()]);
    await Promise.all([closeServer(refresh), upstream.close()]);
  }
}, 15_000);

it('refuses to register retired Codex IDs as new scoped routes', async () => {
  await expect(
    createProductionCodexRuntime(
      controller().signal,
      'old-route',
      undefined,
      'gpt-5.4',
    ),
  ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
});
