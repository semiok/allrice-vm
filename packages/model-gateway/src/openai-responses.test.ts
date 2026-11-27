import { expect, it } from 'vitest';
import {
  classifyOpenAiResponses,
  enableOpenAiHostedSearch,
  OpenAiCitationProjection,
  OPENAI_RESPONSES_URL,
} from './openai-responses.ts';

function frame(event: Record<string, unknown>) {
  return Buffer.from(
    `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
  );
}
const citation = (url: string, start_index = 0, end_index = 2) => ({
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
  const result = await enableOpenAiHostedSearch(request, 'fixture');
  expect(result.redirect).toBe('manual');
  expect(result.headers.has('content-length')).toBe(false);
  const once = await enableOpenAiHostedSearch(result, 'fixture');
  expect(await once.json()).toEqual({
    ...payload,
    tools: [tool, { type: 'web_search' }],
  });
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
  const large = Buffer.alloc(1024 * 1024 + 1, 120);
  expect(a.push(large)).toEqual(large);
  expect(a.push(complete)).toEqual(complete);
  expect(a.finish().byteLength).toBe(0);
});
