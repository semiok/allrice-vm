import { createServer } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createDshGatewayProvider,
  type ModelCallBinding,
} from '@allrice/model-gateway';
import {
  closeServer,
  deferred,
  gatewayFixture,
  listen,
  modelBinding,
} from '../../../../packages/model-gateway/src/gateway.fixture.js';
import { createProductionOpenAiRuntime } from './production-openai-runtime.js';

const key = 'synthetic-api-fixture';
const model = 'gpt-4.1-mini';
const exactUrl = 'https://api.openai.com/v1/responses';
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubEnv('ALLRICE_OPENAI_API_KEY', key);
  vi.stubEnv('ALLRICE_DSH_OPENAI_MODEL', model);
  vi.stubEnv('ALLRICE_DSH_OPENAI_WEB_SEARCH_MODEL', model);
});
afterEach(async () => {
  try {
    for (const close of cleanups.splice(0).reverse()) await close();
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

async function fixture(
  attemptKind: ModelCallBinding['native']['attemptKind'] = 'assistant',
  hold = false,
) {
  const requests: Array<{
    authorization?: string;
    body: Record<string, unknown>;
  }> = [];
  const opened = deferred<void>(),
    closed = deferred<void>();
  const sse = createServer((request, response) => {
    void (async () => {
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(Buffer.from(chunk));
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(body).toString('utf8')),
      });
      response.once('close', () => closed.resolve());
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type: string, fields: object) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
        );
      const web = {
        type: 'web_search_call',
        id: 'ws-synthetic',
        status: 'completed',
        action: {
          type: 'search',
          sources: [{ url: 'https://uncited.example/' }],
        },
      };
      const answer = {
        id: 'msg-synthetic',
        type: 'message',
        role: 'assistant',
      };
      const annotation = {
        type: 'url_citation',
        url: 'https://weather.example/',
        start_index: 0,
        end_index: 3,
        title: 'Weather fixture',
      };
      event('response.created', {
        response: { id: 'res-synthetic', status: 'in_progress' },
      });
      event('response.output_item.added', {
        output_index: 0,
        item: { ...web, status: 'in_progress' },
      });
      event('response.output_item.done', { output_index: 0, item: web });
      event('response.output_item.added', {
        output_index: 1,
        item: { ...answer, content: [] },
      });
      event('response.output_text.delta', {
        output_index: 1,
        content_index: 0,
        delta: '🙂天气。',
      });
      event('response.output_text.annotation.added', {
        output_index: 1,
        item_id: answer.id,
        content_index: 0,
        annotation_index: 0,
        annotation,
      });
      opened.resolve();
      if (hold) return;
      const item = {
        ...answer,
        content: [
          { type: 'output_text', text: '🙂天气。', annotations: [annotation] },
        ],
      };
      event('response.output_item.done', { output_index: 1, item });
      event('response.completed', {
        response: {
          id: 'res-synthetic',
          status: 'completed',
          output: [web, item],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        },
      });
      response.end();
    })().catch((error) => response.destroy(error as Error));
  });
  const url = await listen(sse);
  cleanups.push(() => closeServer(sse));
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request && input.url === exactUrl)
      return fetch(url + '/v1/responses', {
        ...init,
        method: input.method,
        headers: input.headers,
        signal: input.signal,
      });
    const href = input instanceof Request ? input.url : String(input);
    if (new URL(href).hostname !== '127.0.0.1')
      throw new Error('Unexpected non-fixture destination');
    return fetch(input, init);
  });
  const host = await createProductionOpenAiRuntime(
    new AbortController().signal,
    'openai-fixture',
  );
  cleanups.push(() => host.close());
  const base = modelBinding();
  const f = await gatewayFixture({
    binding: {
      ...base,
      provider: host.route.provider,
      model: host.route.model,
      native: { ...base.native, attemptKind },
    },
    provider: createDshGatewayProvider(
      host.llm,
      host.route,
      host.transport.fetchOwned,
      host.transport.beforeDispatch,
      host.scopeStream,
    ),
  });
  cleanups.push(() => f.close());
  return { f, host, requests, opened, closed };
}

it('uses the native public API adapter, meters the exact host call, and delivers actual citations without a guest key or search tool call', async () => {
  const { f, requests } = await fixture();
  const chunks = await f.collect();
  expect(chunks).toEqual(
    expect.arrayContaining([
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'text',
          text: '🙂天气 [来源](https://weather.example/)。',
        },
      },
      expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
    ]),
  );
  expect(chunks.some((chunk) => chunk.type === 'tool-call-delta')).toBe(false);
  expect(JSON.stringify(chunks)).not.toMatch(
    /uncited\.example|synthetic-api-fixture/,
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]?.authorization).toBe('Bearer ' + key);
  expect(requests[0]?.body).toMatchObject({
    model,
    store: false,
    tools: [{ type: 'function', name: 'lookup' }, { type: 'web_search' }],
  });
  expect([...f.store.rows.values()]).toMatchObject([
    {
      kind: 'model',
      protocol: 'openai-responses',
      httpStatus: 200,
      outcome: 'closed',
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    },
  ]);
});

it.each(['compaction', 'session-title'] as const)(
  'does not add hosted tools or citations to a %s attempt',
  async (purpose) => {
    const { f, requests } = await fixture(purpose);
    const chunks = await f.collect({ ...f.input(), purpose });
    expect(JSON.stringify(chunks)).not.toContain('weather.example');
    expect(requests[0]?.body.tools).toMatchObject([
      { type: 'function', name: 'lookup' },
    ]);
    expect(requests[0]?.body.tools).toHaveLength(1);
  },
);

it('leaves native requests unmodified when the host has not approved search for this model', async () => {
  vi.stubEnv('ALLRICE_DSH_OPENAI_WEB_SEARCH_MODEL', undefined);
  const { f, requests } = await fixture();
  expect(JSON.stringify(await f.collect())).not.toContain('weather.example');
  expect(requests[0]?.body.tools).toHaveLength(1);
});

it('joins the actual upstream body on VM revocation without delivering a pending citation', async () => {
  const { f, opened, closed } = await fixture('assistant', true);
  const collecting = f.collect().catch((error: unknown) => error);
  await opened.promise;
  await f.gateway.revoke(f.binding.vm);
  await closed.promise;
  const result = await collecting;
  expect(JSON.stringify(result)).not.toContain('weather.example');
  expect([...f.store.rows.values()]).toMatchObject([{ outcome: 'canceled' }]);
  expect(f.admission.records.size).toBe(0);
});

it('refuses another approved model or a missing host credential and revokes a changed key', async () => {
  const signal = new AbortController().signal;
  vi.stubEnv('ALLRICE_DSH_OPENAI_WEB_SEARCH_MODEL', 'other-model');
  await expect(
    createProductionOpenAiRuntime(signal, 'fixture'),
  ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
  vi.stubEnv('ALLRICE_DSH_OPENAI_WEB_SEARCH_MODEL', model);
  vi.stubEnv('ALLRICE_OPENAI_API_KEY', undefined);
  await expect(
    createProductionOpenAiRuntime(signal, 'fixture'),
  ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
  vi.stubEnv('ALLRICE_OPENAI_API_KEY', key);
  const host = await createProductionOpenAiRuntime(signal, 'fixture');
  cleanups.push(() => host.close());
  vi.stubEnv('ALLRICE_OPENAI_API_KEY', 'different-synthetic-key');
  await expect(host.assertCurrent(signal)).rejects.toMatchObject({
    code: 'AUTHORIZATION_DENIED',
  });
  expect(host.revoked.aborted).toBe(true);
});
