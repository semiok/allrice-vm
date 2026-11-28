import { expect, it } from 'vitest';
import {
  classifyOpenAiResponses,
  prepareOpenAiResponsesRequest,
  OpenAiCitationProjection,
  OPENAI_RESPONSES_URL,
} from './openai-responses.ts';

function frame(event: Record<string, unknown>) {
  return Buffer.from(
    `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
  );
}
const citation = (url: string, start_index = 0, end_index = 1) => ({
  type: 'url_citation',
  url,
  start_index,
  end_index,
});
const annotation = (item_id: string, content_index: number, value: unknown) =>
  frame({
    type: 'response.output_text.annotation.added',
    item_id,
    content_index,
    annotation: value,
  });
const answer = (id: string, ...content: object[]) =>
  frame({
    type: 'response.output_item.done',
    item: { id, type: 'message', role: 'assistant', content },
  });
const text = (text: string, annotations: unknown[] = []) => ({
  type: 'output_text',
  text,
  annotations,
});
function parts(frame: Uint8Array) {
  const data = Buffer.from(frame)
    .toString('utf8')
    .split('\n')
    .find((line) => line.startsWith('data: '));
  return (
    JSON.parse(data!.slice(6)) as { item: { content: { text?: string }[] } }
  ).item.content.map((part) => part.text);
}

it('only classifies the exact OpenAI API Responses POST', () => {
  expect(
    classifyOpenAiResponses(
      new Request(OPENAI_RESPONSES_URL, { method: 'POST' }),
    ),
  ).toEqual({ kind: 'model', protocol: 'openai-responses' });
  for (const url of [
    OPENAI_RESPONSES_URL + '?',
    OPENAI_RESPONSES_URL + '?x=1',
    OPENAI_RESPONSES_URL + '#',
    OPENAI_RESPONSES_URL + '/',
    OPENAI_RESPONSES_URL.replace('https:', 'http:'),
    OPENAI_RESPONSES_URL.replace(
      'api.openai.com',
      'api.openai.com.example.test',
    ),
    OPENAI_RESPONSES_URL.replace('api.openai.com', 'other@api.openai.com'),
    'https://api.openai.com/v1/chat/completions',
    'https://auth.openai.com/oauth/token',
    'https://chatgpt.com/backend-api/codex/responses',
  ])
    expect(classifyOpenAiResponses(url, { method: 'POST' })).toBeNull();
  expect(
    classifyOpenAiResponses(OPENAI_RESPONSES_URL, { method: 'GET' }),
  ).toBeNull();
});

it('adds hosted search exactly once and preserves function tools, tool choice, and request controls', async () => {
  const tool = {
    type: 'function',
    name: 'lookup',
    parameters: { type: 'object' },
  };
  const payload = {
    model: 'fixture',
    stream: true,
    store: false,
    input: [],
    tools: [tool],
    tool_choice: { type: 'function', name: 'lookup' },
  };
  const request = new Request(OPENAI_RESPONSES_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '10' },
    body: JSON.stringify(payload),
  });
  const result = await prepareOpenAiResponsesRequest(request, 'fixture', true);
  expect(result.redirect).toBe('manual');
  expect(result.headers.has('content-length')).toBe(false);
  expect(await result.json()).toEqual({
    ...payload,
    tools: [tool, { type: 'web_search' }],
  });
});

it.each([false, true])(
  'rejects raw provider session state and hosted history (search=%s)',
  async (search) => {
    for (const extra of [
      { previous_response_id: 'synthetic-response' },
      { conversation: 'synthetic-conversation' },
      { store: true },
      { input: [{ type: 'item_reference', id: 'synthetic-item' }] },
      { input: [{ type: 'additional_tools', tools: [] }] },
      {
        input: [
          {
            role: 'user',
            content: [{ type: 'input_image', file_id: 'synthetic-file' }],
          },
        ],
      },
      {
        input: [
          { type: 'function_call_output', call_id: 'unpaired', output: 'x' },
        ],
      },
      { tools: [{ type: 'web_search' }] },
    ]) {
      const request = new Request(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'fixture',
          stream: true,
          store: false,
          input: [],
          ...extra,
        }),
      });
      await expect(
        prepareOpenAiResponsesRequest(request, 'fixture', search),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_UPSTREAM' });
    }
  },
);

it('keeps neutral function-result correlation without replaying upstream item IDs', async () => {
  const input = [
    {
      type: 'function_call',
      id: 'synthetic-item',
      call_id: 'paired',
      name: 'lookup',
      arguments: '{}',
    },
    { type: 'function_call_output', call_id: 'paired', output: 'fixture' },
  ];
  const request = new Request(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'fixture',
      stream: true,
      store: false,
      input,
    }),
  });
  const prepared = await prepareOpenAiResponsesRequest(
    request,
    'fixture',
    false,
  );
  const payload = await prepared.json();
  expect(payload).toMatchObject({
    input: [
      {
        type: 'function_call',
        call_id: 'paired',
        name: 'lookup',
        arguments: '{}',
      },
      input[1],
    ],
  });
  expect(payload.input[0]).not.toHaveProperty('id');
});

it('links only valid actual citations at character offsets, with interleaved item and content identities', () => {
  const projector = new OpenAiCitationProjection();
  const source = citation('https://weather.example/a(b)');
  const content2 = citation('https://news.example/');
  const unrelated = citation('https://unrelated.example/');
  const first = answer(
    'a',
    text('天气。', [source]),
    text('🙂好呀。', [
      citation('javascript:alert(1)'),
      citation('https://user:pw@invalid.example/'),
      citation('https://invalid.example/', 0, 99),
      { type: 'file_citation', url: 'https://invalid.example/' },
    ]),
  );
  const input = Buffer.concat([
    annotation('a', 0, source),
    annotation('b', 0, unrelated),
    annotation('a', 1, content2),
    first,
  ]);
  const bytes: Uint8Array[] = [];
  for (let i = 0; i < input.length; i += 7)
    bytes.push(projector.push(input.subarray(i, i + 7)));
  const output = Buffer.concat(bytes).toString('utf8');
  const done = output.slice(
    output.lastIndexOf('event: response.output_item.done'),
  );
  expect(parts(Buffer.from(done))).toEqual([
    '天气 [来源](https://weather.example/a%28b%29)。',
    '🙂好 [来源](https://news.example/)呀。',
  ]);
  expect(parts(projector.push(answer('b', text('消息。'))))).toEqual([
    '消息 [来源](https://unrelated.example/)。',
  ]);
});

it('isolates attempt state and passes non-citation or oversized frames through', () => {
  const a = new OpenAiCitationProjection(),
    b = new OpenAiCitationProjection();
  const token = 'https://only-in-a.example/';
  a.push(annotation('same-id', 0, citation(token)));
  const complete = answer('same-id', text('没有引用'));
  expect(b.push(complete)).toEqual(complete);
  const tool = frame({
    type: 'response.output_item.done',
    item: {
      id: 'same-id',
      type: 'web_search_call',
      action: { sources: [token] },
    },
  });
  expect(a.push(tool)).toEqual(tool);
  expect(parts(a.push(complete))).toEqual([`没有 [来源](${token})引用`]);
  const large = Buffer.concat([
    Buffer.alloc(1024 * 1024 + 1, 120),
    Buffer.from('\r\n\r\n'),
  ]);
  a.push(annotation('new-id', 0, citation(token, 0, 0)));
  const received = Buffer.concat([
    a.push(large.subarray(0, -1)),
    a.push(Buffer.concat([large.subarray(-1), answer('new-id', text('🙂好'))])),
  ]);
  expect(received.subarray(0, large.length)).toEqual(large);
  expect(parts(received.subarray(large.length))).toEqual([
    `🙂 [来源](${token})好`,
  ]);
  expect(a.finish().byteLength).toBe(0);
});

it('releases discarded offsets at item completion and accepts CR-only event framing', () => {
  const projector = new OpenAiCitationProjection();
  for (let i = 0; i < 128; i++) {
    projector.push(
      annotation('first', 0, citation('https://stale.example/' + i, 0, 99)),
    );
  }
  const uncited = answer('first', text('好'));
  expect(projector.push(uncited)).toEqual(uncited);
  const second = Buffer.concat([
    annotation('second', 0, citation('https://source.example/', 0, 0)),
    answer('second', text('界。')),
  ])
    .toString('utf8')
    .replaceAll('\r\n', '\r');
  const result = Buffer.concat([
    ...Array.from(Buffer.from(second), (byte) =>
      projector.push(Uint8Array.of(byte)),
    ),
    projector.finish(),
  ]);
  const done = result
    .toString('utf8')
    .split('event: response.output_item.done')
    .at(-1)!;
  expect(parts(Buffer.from(done))).toEqual([
    '界 [来源](https://source.example/)。',
  ]);
});
