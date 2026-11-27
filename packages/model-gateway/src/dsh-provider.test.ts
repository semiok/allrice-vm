import { afterEach, describe, expect, it, vi } from 'vitest';
import Llm, {
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { Context } from '@deepseek-ai/cordis';
import {
  GatewayLlmAdapter,
  registerManagedGatewayAdapter,
} from './dsh-provider.ts';
import { createNativeModelCallReferences } from './native-call-reference.ts';
import { MODEL_CALL_REFERENCE_HEADER } from './contract.ts';
import { modelBinding } from './gateway.fixture.ts';

afterEach(() => vi.unstubAllGlobals());

const endpoint = 'http://vm-egress.invalid:39001/v1/stream';
const chunks: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Synthetic rice price.' },
  {
    type: 'block-end',
    index: 0,
    block: { type: 'text', text: 'Synthetic rice price.' },
  },
  { type: 'finish', reason: { kind: 'stop' } },
];
function input(): GenerateOptions {
  return {
    provider: 'host-gateway',
    model: 'fixture-model',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '请查一下今天的大米价格。' }],
      },
    ],
    system: 'Synthetic managed model test.',
    temperature: 0.5,
    maxTokens: 512,
    signal: new AbortController().signal,
  };
}
async function collect(adapter: GatewayLlmAdapter, options: GenerateOptions) {
  const result: StreamChunk[] = [];
  for await (const chunk of adapter.stream(options)) result.push(chunk);
  return result;
}

describe('guest adapter VM-local egress capability (synthetic fetch only)', () => {
  it.each([
    { label: 'without a capability', capability: undefined },
    { label: 'with a capability', capability: 'synthetic-vm-epoch-capability' },
  ])('forwards the native call $label', async ({ capability }) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          chunks.map((chunk) => JSON.stringify(chunk)).join('\n') + '\n',
        ),
      );
    vi.stubGlobal('fetch', transport);
    const options = input();
    const adapter =
      capability === undefined
        ? new GatewayLlmAdapter(endpoint)
        : new GatewayLlmAdapter(endpoint, capability);

    expect(await collect(adapter, options)).toEqual(chunks);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init!.signal).toBe(options.signal);
    expect(Object.fromEntries(new Headers(init!.headers))).toEqual({
      'content-type': 'application/json',
      'x-allrice-model-contract': '1',
      ...(capability === undefined
        ? {}
        : { authorization: 'Bearer ' + capability }),
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      messages: options.messages,
      system: options.system,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });
    if (capability !== undefined) {
      expect(String(url)).not.toContain(capability);
      expect(init!.body).not.toContain(capability);
    }
  });

  it.each(['', 'wrong-synthetic-capability'])(
    'does not repair or retry a denied local capability %j',
    async (capability) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 'DENIED' }), { status: 403 }),
        );
      vi.stubGlobal('fetch', transport);

      await expect(
        collect(new GatewayLlmAdapter(endpoint, capability), input()),
      ).rejects.toMatchObject({ code: 'TRANSPORT' });
      expect(transport).toHaveBeenCalledTimes(1);
      const [url, init] = transport.mock.calls[0]!;
      expect(url).toBe(endpoint);
      expect(init!.headers).toMatchObject({
        authorization: 'Bearer ' + capability,
      });
    },
  );
});

it('registers a managed native DSH route and redeems the exact host call once', async () => {
  const ctx = new Context();
  const fiber = ctx.plugin(Llm);
  await fiber;
  const controller = new AbortController();
  const binding = modelBinding();
  const expected = structuredClone(binding);
  const call = new AbortController();
  const authority = { assertCall: vi.fn(async () => {}) };
  const refs = createNativeModelCallReferences(authority, controller.signal);
  const ref = await refs.issue(binding, call.signal);
  binding.context.sessionId = 'changed-after-issue';

  const resolve = vi.fn(async () => ref);
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const header = new Headers(init?.headers).get(MODEL_CALL_REFERENCE_HEADER);
    expect(header).toBe(ref);
    expect(String(init?.body)).not.toContain(ref);
    expect(String(init?.body)).not.toContain(expected.execution.runId);
    await expect(
      refs.resolveCall(
        { [MODEL_CALL_REFERENCE_HEADER]: ref },
        { ...expected.vm, leaseEpoch: expected.vm.leaseEpoch + 1 },
        call.signal,
      ),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    await expect(
      refs.resolveCall(
        { [MODEL_CALL_REFERENCE_HEADER]: ref },
        expected.vm,
        call.signal,
      ),
    ).resolves.toEqual(expected);
    return new Response(
      chunks.map((chunk) => JSON.stringify(chunk)).join('\n') + '\n',
    );
  });
  vi.stubGlobal('fetch', request);
  try {
    const route = { provider: 'host-gateway', model: 'fixture-model' };
    registerManagedGatewayAdapter(ctx.llm, {
      origin: 'http://127.0.0.1:12345',
      capability: 'a'.repeat(43),
      route: { ...route, resolveCallReference: resolve },
    });
    const options = input();
    const selected = await ctx.llm.prepareCall(
      {
        ...route,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      },
      call.signal,
    );
    const sessionId = expected.native.sessionId as GenerateOptions['sessionId'];
    const received = [];
    for await (const chunk of selected.stream({
      ...options,
      ...selected.config,
      sessionId,
    }))
      received.push(chunk);
    expect(received).toEqual(chunks);
    expect(resolve).toHaveBeenCalledWith(
      { ...route, sessionId },
      expect.any(AbortSignal),
    );
    expect(authority.assertCall).toHaveBeenCalledExactlyOnceWith(
      expected,
      expect.any(AbortSignal),
    );
    expect(request).toHaveBeenCalledTimes(1);
    await expect(
      refs.resolveCall(
        { [MODEL_CALL_REFERENCE_HEADER]: ref },
        expected.vm,
        call.signal,
      ),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
  } finally {
    controller.abort();
    await fiber.dispose();
  }
});

it('refuses guessed and revoked references and does not fetch without an exact selection', async () => {
  const lifetime = new AbortController();
  const call = new AbortController();
  const binding = modelBinding();
  const refs = createNativeModelCallReferences(
    { assertCall: async () => {} },
    lifetime.signal,
  );
  const issued = await refs.issue(binding, call.signal);
  call.abort();
  for (const ref of [issued, 'a'.repeat(43), [issued, issued], undefined])
    await expect(
      refs.resolveCall(
        { [MODEL_CALL_REFERENCE_HEADER]: ref },
        binding.vm,
        lifetime.signal,
      ),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });

  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const resolveCallReference = vi.fn(async () => '');
  const adapter = new GatewayLlmAdapter(endpoint, 'synthetic', {
    provider: 'host-gateway',
    model: 'fixture-model',
    resolveCallReference,
  });
  await expect(collect(adapter, input())).rejects.toMatchObject({
    code: 'BINDING_INVALID',
  });
  expect(resolveCallReference).not.toHaveBeenCalled();
  await expect(
    collect(adapter, {
      ...input(),
      sessionId: binding.native.sessionId as GenerateOptions['sessionId'],
    }),
  ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
  expect(resolveCallReference).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  lifetime.abort();
});

it('reads retained model context with current image capability without exposing an old route', async () => {
  const modelInfo = {
    provider: 'host-gateway',
    id: 'fixture-model',
    name: 'Current',
    inputModalities: ['text'] as const,
  };
  const resolveCallReference = vi.fn(async () => '');
  const adapter = new GatewayLlmAdapter(endpoint, 'synthetic', {
    provider: modelInfo.provider,
    model: modelInfo.id,
    modelInfo,
    historicalModels: [
      {
        ...modelInfo,
        id: 'previous-model',
        inputModalities: ['text', 'image'],
        context: { contextWindow: 200000 },
      },
    ],
    resolveCallReference,
  });
  await expect(adapter.listModels(modelInfo.provider)).resolves.toEqual([
    modelInfo,
  ]);
  await expect(
    adapter.resolveModel(modelInfo.provider, 'previous-model'),
  ).resolves.toMatchObject({
    id: 'previous-model',
    inputModalities: ['text'],
    context: { contextWindow: 200000 },
  });
  await expect(
    collect(adapter, {
      ...input(),
      model: 'previous-model',
      sessionId: modelBinding().native
        .sessionId as GenerateOptions['sessionId'],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
  expect(resolveCallReference).not.toHaveBeenCalled();
});

it('binds the one-use reference to its exact adapter response recipient', async () => {
  const controller = new AbortController();
  const binding = modelBinding();
  const refs = createNativeModelCallReferences(
    { assertCall: async () => {} },
    controller.signal,
  );
  const recipient = 'a'.repeat(43);
  const reference = await refs.issue(binding, controller.signal, recipient);
  const headers = {
    [MODEL_CALL_REFERENCE_HEADER]: reference,
    'x-allrice-model-call-recipient': recipient,
  };
  await expect(
    refs.resolveCall(
      { ...headers, 'x-allrice-model-call-recipient': 'b'.repeat(43) },
      binding.vm,
      controller.signal,
    ),
  ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
  await expect(
    refs.resolveCall(headers, binding.vm, controller.signal),
  ).resolves.toEqual(binding);
  await expect(
    refs.resolveCall(headers, binding.vm, controller.signal),
  ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
});
