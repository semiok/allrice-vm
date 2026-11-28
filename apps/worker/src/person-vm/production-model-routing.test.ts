import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessage,
  createToolResultMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import {
  classifyDeepSeek,
  selectScopedModel,
  type ModelCallBinding,
} from '@allrice/model-gateway';
import {
  closeServer,
  deferred,
  gatewayFixture,
  freshCall,
  listen,
  modelBinding,
} from '../../../../packages/model-gateway/src/gateway.fixture.js';
import { createProductionModelRouting } from './production-model-routing.js';
import { createProductionOpenAiRuntime } from './production-openai-runtime.js';

vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  readPlatformModelSettings: async () => ({
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
  }),
}));

const deepSeekKey = 'synthetic-deepseek-api';
const openAiKey = 'synthetic-openai-api';
const origins = {
  openai: 'https://api.openai.com/v1/responses',
  chat: 'https://api.deepseek.com/chat/completions',
  responses: 'https://api.deepseek.com/responses',
};
const fallback = { provider: 'openai-codex', model: 'gpt-6.2-sol' };
const modelRoutes = {
  openai: { provider: 'openai', model: 'gpt-4.1-mini' },
  chat: { provider: 'deepseek', model: 'deepseek-flash' },
  responses: { provider: 'deepseek', model: 'deepseek-v4-pro' },
} as const;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const close of cleanups.splice(0).reverse()) await close();
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

function routeFixture() {
  const base = modelBinding();
  const call = (
    sessionId: string,
    route: keyof typeof modelRoutes,
    parentSessionId: string | null = null,
  ): ModelCallBinding => ({
    ...base,
    ...modelRoutes[route],
    execution: { runId: base.execution.runId, executionId: randomUUID() },
    native: {
      ...base.native,
      sessionId,
      rootSessionId: parentSessionId ? 'openai-root' : sessionId,
      parentSessionId,
      callId: randomUUID(),
      attemptKind: 'assistant',
    },
  });
  const root = call('openai-root', 'openai');
  const chat = call('child-chat', 'chat', root.native.sessionId);
  const responses = call('child-responses', 'responses', root.native.sessionId);
  const scope = {
    organizationId: base.vm.organizationId,
    personId: base.vm.personId,
  };
  vi.stubEnv('ALLRICE_DSH_MODEL_PROVIDER', undefined);
  vi.stubEnv('ALLRICE_DSH_MODEL_REVOCATIONS_FILE', undefined);
  vi.stubEnv('ALLRICE_OPENAI_API_KEY', openAiKey);
  vi.stubEnv('ALLRICE_DEEPSEEK_API_KEY', deepSeekKey);
  vi.stubEnv(
    'ALLRICE_DSH_MODEL_ROUTES',
    JSON.stringify({
      routes: [
        { id: 'openai', ...modelRoutes.openai, protocol: 'responses' },
        { id: 'chat', ...modelRoutes.chat, protocol: 'chat' },
        {
          id: 'responses',
          ...modelRoutes.responses,
          protocol: 'responses',
          search: true,
        },
      ],
      rules: [
        {
          ...scope,
          route: 'chat',
          sessionId: chat.native.sessionId,
          scope: 'subagent',
        },
        {
          ...scope,
          route: 'responses',
          parentSessionId: root.native.sessionId,
          scope: 'subagent',
        },
        {
          ...scope,
          route: 'openai',
          sessionId: root.native.sessionId,
          attempt: 'assistant',
        },
        { ...scope, route: 'chat', attempt: 'session-title' },
        { ...scope, route: 'responses', attempt: 'compaction' },
      ],
    }),
  );
  return { base, root, chat, responses };
}

it('selects only trusted tenant/person rules in order for exact sessions, child trees and task tiers', async () => {
  const { base, root, chat, responses } = routeFixture();
  const routing = await createProductionModelRouting(
    new AbortController().signal,
    'routing-fixture',
    async () => {
      throw new Error('fixture does not read images');
    },
  );
  cleanups.push(routing.close);
  expect(routing.select(root.vm, root.native)).toEqual(modelRoutes.openai);
  expect(routing.select(chat.vm, chat.native)).toEqual(modelRoutes.chat);
  expect(routing.select(responses.vm, responses.native)).toEqual(
    modelRoutes.responses,
  );
  expect(
    routing.select(base.vm, { ...base.native, attemptKind: 'session-title' }),
  ).toEqual(modelRoutes.chat);
  expect(
    routing.select(root.vm, { ...root.native, attemptKind: 'compaction' }),
  ).toEqual(modelRoutes.responses);
  expect(
    routing.select({ ...root.vm, organizationId: randomUUID() }, root.native),
  ).toMatchObject(fallback);
  expect(
    routing.select({ ...root.vm, personId: randomUUID() }, root.native),
  ).toMatchObject(fallback);
  const catalog = await routing.guestCatalog(
    base.vm,
    new AbortController().signal,
  );
  expect(catalog?.models).toHaveLength(3);
  expect(catalog?.defaultModelInfo).toMatchObject({
    ...{ provider: fallback.provider, id: fallback.model },
    reasoning: { defaultEffort: 'high' },
  });
  expect(catalog?.historicalModels).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: fallback.provider,
        id: 'gpt-6-sol',
      }),
    ]),
  );
  expect(catalog?.title).toEqual(modelRoutes.chat);
  expect(catalog?.compaction).toEqual(modelRoutes.responses);
  expect(JSON.stringify(catalog)).not.toContain(deepSeekKey);
  expect(JSON.stringify(catalog)).not.toContain(openAiKey);
  expect(selectScopedModel(catalog!.rules, chat.native, fallback)).toEqual(
    modelRoutes.chat,
  );
  expect(() => routing.provider({ ...chat, ...modelRoutes.openai })).toThrow(
    expect.objectContaining({ code: 'BINDING_INVALID' }),
  );
  expect(() => routing.provider({ ...chat, model: 'not-approved' })).toThrow(
    expect.objectContaining({ code: 'BINDING_INVALID' }),
  );
});

it('inherited maintenance follows the Host session route, with fallback only for an unmatched cold session', async () => {
  const { root, base } = routeFixture();
  const config = JSON.parse(process.env.ALLRICE_DSH_MODEL_ROUTES!);
  config.rules = config.rules.filter(
    ({ attempt }: { attempt?: string }) =>
      attempt !== 'session-title' && attempt !== 'compaction',
  );
  vi.stubEnv('ALLRICE_DSH_MODEL_ROUTES', JSON.stringify(config));
  const signal = new AbortController().signal;
  const routing = await createProductionModelRouting(
    signal,
    'routing-fixture',
    async () => {
      throw new Error('fixture does not read images');
    },
  );
  cleanups.push(routing.close);
  for (const attemptKind of ['compaction', 'session-title'] as const) {
    const native = { ...root.native, attemptKind };
    expect(routing.select(root.vm, native)).toEqual(modelRoutes.openai);
    await expect(
      routing.assertCurrent({ ...root, ...fallback, native }, signal),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    await expect(
      routing.assertCurrent({ ...root, native }, signal),
    ).resolves.toMatchObject({ aborted: false });
    expect(
      routing.select(base.vm, { ...base.native, attemptKind }),
    ).toMatchObject(fallback);
  }
});

it('refuses a configured Host key pasted into any Guest model or session selector', async () => {
  routeFixture();
  const config = JSON.parse(process.env.ALLRICE_DSH_MODEL_ROUTES!);
  vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic-r2-search-key');
  function mutate(field: 'model' | 'sessionId' | 'parentSessionId') {
    const copy = structuredClone(config);
    const row = field === 'model' ? copy.routes[0] : copy.rules[0];
    row[field] =
      field === 'parentSessionId' ? 'synthetic-r2-search-key' : deepSeekKey;
    vi.stubEnv('ALLRICE_DSH_MODEL_ROUTES', JSON.stringify(copy));
    return createProductionModelRouting(
      new AbortController().signal,
      'routing-fixture',
      async () => {
        throw new Error('fixture does not read images');
      },
    );
  }
  for (const field of ['model', 'sessionId', 'parentSessionId'] as const)
    await expect(mutate(field)).rejects.toMatchObject({
      code: 'BINDING_INVALID',
    });
});

it('proves a fresh root independently of a maintenance-only rule or an exact prior session', async () => {
  const { root, base } = routeFixture();
  vi.stubEnv('ALLRICE_DSH_MODEL_PROVIDER', 'openai');
  vi.stubEnv('ALLRICE_DSH_OPENAI_MODEL', 'gpt-6.2-astra');
  vi.stubEnv('ALLRICE_OPENAI_API_KEY', undefined);
  const config = JSON.parse(process.env.ALLRICE_DSH_MODEL_ROUTES!);
  const signal = new AbortController().signal;
  const images = async () => {
    throw Error('fixture does not read images');
  };
  const unready = await createProductionModelRouting(
    signal,
    'fixture-unready',
    images,
  );
  cleanups.push(unready.close);
  expect(unready.rootRoute(root.vm)).toMatchObject({
    provider: 'openai',
    model: 'gpt-6.2-astra',
  });
  await expect(
    unready.assertRootCurrent(base.vm, signal),
  ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
  expect(unready.rootRoute(root.vm, root.native.sessionId)).toEqual(
    modelRoutes.openai,
  );
  config.rules.push({
    organizationId: root.vm.organizationId,
    personId: root.vm.personId,
    scope: 'root',
    attempt: 'assistant',
    route: 'chat',
  });
  vi.stubEnv('ALLRICE_DSH_MODEL_ROUTES', JSON.stringify(config));
  const routed = await createProductionModelRouting(
    signal,
    'fixture-routed',
    images,
  );
  cleanups.push(routed.close);
  expect(routed.rootRoute(root.vm)).toEqual(modelRoutes.chat);
  await expect(
    routed.assertRootCurrent(root.vm, signal),
  ).resolves.toMatchObject({ aborted: false });
});

it('does not confuse a short credential placeholder with part of an approved model ID', async () => {
  const { responses } = routeFixture();
  vi.stubEnv('ALLRICE_DEEPSEEK_API_KEY', 'pro');
  const signal = new AbortController().signal;
  const routing = await createProductionModelRouting(
    signal,
    'routing-fixture',
    async () => {
      throw new Error('fixture does not read images');
    },
  );
  cleanups.push(routing.close);
  expect(routing.select(responses.vm, responses.native)).toEqual(
    modelRoutes.responses,
  );
  expect(routing.provider(responses).requireTransportProof).toBe(true);
});

it('isolates a missing opt-in OpenAI default key and publishes true Astra capabilities', async () => {
  const { base, chat } = routeFixture();
  vi.stubEnv('ALLRICE_DSH_MODEL_PROVIDER', 'openai');
  vi.stubEnv('ALLRICE_DSH_OPENAI_MODEL', 'gpt-6.2-astra');
  vi.stubEnv('ALLRICE_OPENAI_API_KEY', undefined);
  const signal = new AbortController().signal;
  const create = () =>
    createProductionModelRouting(signal, 'routing-fixture', async () => {
      throw new Error('fixture does not read images');
    });
  const routing = await create();
  cleanups.push(routing.close);
  expect(
    (await routing.guestCatalog(base.vm, signal))?.defaultModelInfo,
  ).toMatchObject({
    provider: 'openai',
    id: 'gpt-6.2-astra',
    context: { contextWindow: 1_050_000 },
    inputModalities: ['text', 'image'],
    defaultMaxTokens: 128_000,
    reasoning: {
      efforts: expect.arrayContaining([expect.objectContaining({ id: 'max' })]),
    },
  });
  await expect(
    routing.assertCurrent(
      { ...base, provider: 'openai', model: 'gpt-6.2-astra' },
      signal,
    ),
  ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
  await expect(routing.assertCurrent(chat, signal)).resolves.toMatchObject({
    aborted: false,
  });
  vi.stubEnv('ALLRICE_DSH_MODEL_ROUTES', undefined);
  await expect(create()).rejects.toMatchObject({
    code: 'AUTHORIZATION_DENIED',
  });
});

it('exposes only approved hosted search with a matching protocol and model, on exact official endpoints', async () => {
  const { chat, responses } = routeFixture();
  const signal = new AbortController().signal;
  await expect(
    createProductionOpenAiRuntime(signal, 'routing-fixture', undefined, {
      ...modelRoutes.chat,
      protocol: 'chat',
      search: true,
    }),
  ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
  await expect(
    createProductionOpenAiRuntime(signal, 'routing-fixture', undefined, {
      provider: 'openai',
      model: 'gpt-4.1-nano',
      protocol: 'responses',
      search: true,
    }),
  ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
  const routing = await createProductionModelRouting(
    signal,
    'routing-fixture',
    async () => {
      throw new Error('fixture does not read images');
    },
  );
  cleanups.push(routing.close);
  expect(routing.provider(chat).hostedWebSearch).toBeUndefined();
  expect(routing.provider(responses).hostedWebSearch).toEqual(
    modelRoutes.responses,
  );
  expect(
    classifyDeepSeek('chat', origins.chat, { method: 'POST' }),
  ).toMatchObject({ protocol: 'openai-chat-completions' });
  expect(
    classifyDeepSeek('responses', origins.responses, { method: 'POST' }),
  ).toMatchObject({ protocol: 'openai-responses' });
  for (const url of [
    origins.responses,
    origins.chat + '?retry=1',
    origins.chat + '/',
    origins.chat + '#fragment',
    'https://api.deepseek.com/v1/chat/completions',
    'https://api.deepseek.com:8443/chat/completions',
    'https://api.deepseek.com.invalid/chat/completions',
  ])
    expect(classifyDeepSeek('chat', url, { method: 'POST' })).toBeNull();
  expect(
    classifyDeepSeek('responses', origins.responses, { method: 'GET' }),
  ).toBeNull();
});

it('advertises public model metadata and keeps a healthy route usable when a peer credential is absent', async () => {
  const { root, chat } = routeFixture();
  vi.stubEnv('ALLRICE_DEEPSEEK_API_KEY', undefined);
  const signal = new AbortController().signal;
  const routing = await createProductionModelRouting(
    signal,
    'routing-fixture',
    async () => {
      throw new Error('fixture does not read images');
    },
  );
  cleanups.push(routing.close);
  // Another rule still needs the static Codex fallback catalog after this
  // runtime's execution route has stopped.
  await routing.fallback.close();
  const catalog = await routing.guestCatalog(root.vm, signal);
  expect(catalog?.defaultModelInfo).toMatchObject({
    provider: 'openai-codex',
    id: fallback.model,
  });
  expect(catalog?.models).toHaveLength(3);
  await expect(routing.assertCurrent(chat, signal)).rejects.toMatchObject({
    code: 'AUTHORIZATION_DENIED',
  });
  await expect(routing.assertCurrent(root, signal)).resolves.toMatchObject({
    aborted: false,
  });
  await routing.close();
  await expect(routing.guestCatalog(root.vm, signal)).rejects.toBeDefined();
});

it('uses native Chat and Responses adapters with one metering owner and joins only the revoked route', async () => {
  const calls = routeFixture();
  const directory = await mkdtemp(join(tmpdir(), 'allrice-routing-fixture-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const revocationPath = join(directory, 'revocations.json');
  async function publishRevocations(ids: string[]) {
    const staged = revocationPath + '.next';
    await writeFile(staged, JSON.stringify(ids), { mode: 0o600, flag: 'wx' });
    await rename(staged, revocationPath);
  }
  await publishRevocations([]);
  vi.stubEnv('ALLRICE_DSH_MODEL_REVOCATIONS_FILE', revocationPath);
  const routing = await createProductionModelRouting(
    new AbortController().signal,
    'shared-fixture',
    async () => {
      throw new Error('fixture does not read images');
    },
  );
  cleanups.push(routing.close);
  const opened = {
    chat: deferred(),
    responses: deferred(),
    openai: deferred(),
  };
  const finish = {
    chat: deferred(),
    responses: deferred(),
    openai: deferred(),
  };
  const chatClosed = deferred();
  const chatBodies: Record<string, unknown>[] = [];
  const requests = new Map<
    string,
    { authorization?: string; body: Record<string, unknown> }
  >();
  const upstream = createServer((request, response) => {
    void (async () => {
      const source = request.url?.slice(1);
      if (source !== 'chat' && source !== 'responses' && source !== 'openai')
        throw new Error('wrong fixture target');

      const buffers: Buffer[] = [];
      for await (const chunk of request) buffers.push(Buffer.from(chunk));
      requests.set(source, {
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(buffers).toString()),
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      if (source === 'chat') {
        chatBodies.push(requests.get('chat')!.body);
        if (chatBodies.length === 1) {
          response.end(
            'data: ' +
              JSON.stringify({
                id: 'chat-first',
                object: 'chat.completion.chunk',
                created: 1,
                model: modelRoutes.chat.model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_fixture',
                          type: 'function',
                          function: { name: 'lookup', arguments: '{}' },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: {
                  prompt_tokens: 3,
                  completion_tokens: 2,
                  total_tokens: 5,
                },
              }) +
              '\n\ndata: [DONE]\n\n',
          );
          return;
        }
        response.once('close', () => chatClosed.resolve());
      }
      opened[source].resolve();
      await finish[source].promise;
      if (response.destroyed) return;
      if (source === 'chat') {
        response.end(
          'data: ' +
            JSON.stringify({
              id: 'chat-completion-fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model: modelRoutes.chat.model,
              choices: [
                {
                  index: 0,
                  delta: { content: 'chat fixture' },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 3,
                completion_tokens: 2,
                total_tokens: 5,
              },
            }) +
            '\n\ndata: [DONE]\n\n',
        );
        return;
      }
      const sendEvent = (type: string, fields: object) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
        );
      const item = { id: 'msg-fixture', type: 'message', role: 'assistant' };
      sendEvent('response.created', {
        response: { id: 'resp-fixture', status: 'in_progress' },
      });
      sendEvent('response.output_item.added', {
        output_index: 0,
        item: { ...item, content: [] },
      });
      sendEvent('response.output_text.delta', {
        output_index: 0,
        content_index: 0,
        delta: 'fixture',
      });
      const answer = {
        ...item,
        content: [{ type: 'output_text', text: 'fixture', annotations: [] }],
      };
      sendEvent('response.output_item.done', { output_index: 0, item: answer });
      sendEvent('response.completed', {
        response: {
          id: 'resp-fixture',
          status: 'completed',
          output: [answer],
          usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
        },
      });
      response.end();
    })().catch((error) => response.destroy(error as Error));
  });
  const url = await listen(upstream);
  cleanups.push(() => closeServer(upstream));
  const beforeConnect = deferred();
  let holdBeforeConnect = false;
  const fixtureFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : String(input);
    if (
      href === origins.chat &&
      input instanceof Request &&
      holdBeforeConnect
    ) {
      beforeConnect.resolve();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(input.signal.reason);
        if (input.signal.aborted) abort();
        else input.signal.addEventListener('abort', abort, { once: true });
      });
    }
    const match = Object.entries(origins).find(
      ([, endpoint]) => endpoint === href,
    );
    if (match && input instanceof Request)
      return fixtureFetch(url + '/' + match[0], {
        ...init,
        method: input.method,
        headers: input.headers,
        signal: input.signal,
      });
    if (new URL(href).hostname !== '127.0.0.1')
      throw new Error('non-fixture destination');
    return fixtureFetch(input, init);
  });
  const queue = [
    calls.chat,
    freshCall(calls.chat),
    calls.responses,
    calls.root,
    freshCall(calls.chat),
    { ...calls.responses, model: 'unapproved' },
  ];
  const signals = new Map<string, AbortSignal>();
  for (const call of queue.slice(0, 5))
    signals.set(
      call.native.callId,
      await routing.assertCurrent(call, new AbortController().signal),
    );
  const gateway = await gatewayFixture({
    provider: routing.provider,
    nextBinding: (index) => queue[index]!,
    authority: {
      async assertCall(call, signal) {
        await routing.assertCurrent(call, signal);
      },
      deliverySignal: (call) => signals.get(call.native.callId)!,
      async authorizeUsage() {
        throw new Error('not used');
      },
      async confirmOwnerStopped() {
        throw new Error('not used');
      },
    },
  });
  cleanups.push(gateway.close);
  const firstChat = await gateway.collect();
  expect(firstChat.at(-1)).toMatchObject({
    type: 'finish',
    reason: { kind: 'tool-calls' },
  });
  const callId = ToolCallId('call_fixture');
  const input = gateway.input();
  const chat = gateway
    .collect({
      ...input,
      messages: [
        ...input.messages,
        createAssistantMessage({
          content: [
            { type: 'tool-call', id: callId, name: 'lookup', arguments: '{}' },
          ],
          source: { provider: 'deepseek', model: modelRoutes.chat.model },
        }),
        createToolResultMessage({
          callId,
          isError: false,
          content: [{ type: 'text', text: 'synthetic result' }],
        }),
      ],
    })
    .catch(() => null);
  await opened.chat.promise;
  const responses = gateway.collect();
  void responses.catch(() => {});
  await opened.responses.promise;
  const openai = gateway.collect();
  void openai.catch(() => {});
  await opened.openai.promise;
  holdBeforeConnect = true;
  const connecting = gateway.collect().catch(() => null);
  await beforeConnect.promise;
  expect(gateway.store.slots.get(calls.base.vm.personId)?.size).toBe(4);
  await publishRevocations(['chat']);
  await chatClosed.promise;
  await Promise.all([chat, connecting]);
  expect(gateway.store.slots.get(calls.base.vm.personId)?.size).toBe(2);
  const canceledChat = [...gateway.store.rows.values()].filter(
    (row) =>
      row.protocol === 'openai-chat-completions' && row.outcome === 'canceled',
  );
  expect(canceledChat).toHaveLength(2);
  expect(
    canceledChat.some((row) => row.httpStatus === null && row.dispatchObserved),
  ).toBe(true);
  await expect(
    routing.assertCurrent(calls.chat, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
  expect(signals.get(calls.responses.native.callId)?.aborted).toBe(false);
  expect(signals.get(calls.root.native.callId)?.aborted).toBe(false);
  finish.chat.resolve();
  finish.responses.resolve();
  finish.openai.resolve();
  for (const chunks of await Promise.all([responses, openai]))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
    });
  await expect(gateway.collect()).resolves.toEqual([
    expect.objectContaining({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: expect.objectContaining({ code: 'BINDING_INVALID' }),
      },
    }),
  ]);
  expect([...requests.keys()]).toEqual(['chat', 'responses', 'openai']);
  expect(requests.get('chat')).toMatchObject({
    authorization: 'Bearer ' + deepSeekKey,
    body: {
      model: modelRoutes.chat.model,
      stream: true,
      thinking: { type: 'disabled' },
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call_fixture',
          content: 'synthetic result',
        }),
      ]),
      tools: [{ type: 'function' }],
    },
  });
  expect(requests.get('responses')).toMatchObject({
    authorization: 'Bearer ' + deepSeekKey,
    body: {
      model: modelRoutes.responses.model,
      tools: [{ type: 'function' }, { type: 'web_search' }],
    },
  });
  expect(requests.get('openai')).toMatchObject({
    authorization: 'Bearer ' + openAiKey,
    body: { model: modelRoutes.openai.model, tools: [{ type: 'function' }] },
  });
  expect(gateway.store.rows.size).toBe(5);
  expect(
    [...gateway.store.rows.values()].map((row) => {
      const binding = gateway.store.calls.get(row.callId)!.binding;
      return [
        binding.provider,
        binding.model,
        row.protocol,
        row.outcome,
        row.usage.totalTokens,
      ];
    }),
  ).toEqual(
    expect.arrayContaining([
      [
        'deepseek',
        modelRoutes.chat.model,
        'openai-chat-completions',
        'closed',
        5,
      ],
      [
        'deepseek',
        modelRoutes.chat.model,
        'openai-chat-completions',
        'canceled',
        null,
      ],
      [
        'deepseek',
        modelRoutes.responses.model,
        'openai-responses',
        'closed',
        10,
      ],
      ['openai', modelRoutes.openai.model, 'openai-responses', 'closed', 10],
    ]),
  );
  expect(gateway.store.slots.get(calls.base.vm.personId)?.size ?? 0).toBe(0);
  await routing.close();
  await expect(
    routing.confirmTransportStopped(
      'shared-fixture',
      new AbortController().signal,
    ),
  ).resolves.toMatch(/^model-pools-stopped:[0-9a-f]{64}$/);
}, 15_000);
