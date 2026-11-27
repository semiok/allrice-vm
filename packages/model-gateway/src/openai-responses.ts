import {
  ModelGatewayError,
  type GatewayFetchClassification,
} from './contract.ts';

export const OPENAI_RESPONSES_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_RESPONSES_URL = OPENAI_RESPONSES_BASE_URL + '/responses';

export function classifyOpenAiResponses(
  input: RequestInfo | URL,
  init?: RequestInit,
): GatewayFetchClassification | null {
  const request = input instanceof Request ? input : undefined;
  return (init?.method ?? request?.method)?.toUpperCase() === 'POST' &&
    URL.parse(request?.url ?? String(input))?.href === OPENAI_RESPONSES_URL
    ? { kind: 'model', protocol: 'openai-responses' }
    : null;
}

const maxPayloadBytes = 32 * 1024 * 1024;
const maxEventBytes = 1024 * 1024;
const maxCitations = 128;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const allowedInputTypes = new Set([
  'message',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
]);
const messageRoles = new Set(['user', 'assistant', 'system', 'developer']);

function isNeutralContent(value: unknown, assistant = false): boolean {
  if (typeof value === 'string') return true;
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => {
      const part = record(entry);
      if (assistant)
        return part.type === 'output_text' && typeof part.text === 'string';
      if (part.type === 'input_text') return typeof part.text === 'string';
      return (
        part.type === 'input_image' &&
        !('file_id' in part) &&
        typeof part.image_url === 'string' &&
        part.image_url.startsWith('data:image/')
      );
    })
  );
}

/** Every host API attempt uses stateless, provider-neutral history. The SDK
 * can supply local function calls/results, but cannot supply hosted state. */
export async function prepareOpenAiResponsesRequest(
  request: Request,
  model: string,
  hostedSearch: boolean,
) {
  if (
    !request.body ||
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') ?? '',
    ) ||
    request.headers.has('content-encoding')
  )
    throw new ModelGatewayError('UNSUPPORTED_UPSTREAM');
  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();
  let size = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxPayloadBytes)
        throw new ModelGatewayError('INPUT_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  request.signal.throwIfAborted();
  let payload: Record<string, unknown>;
  try {
    payload = record(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
  } catch {
    throw new ModelGatewayError('UNSUPPORTED_UPSTREAM');
  }
  if (
    payload.model !== model ||
    payload.stream !== true ||
    payload.store !== false ||
    'previous_response_id' in payload ||
    'conversation' in payload ||
    !Array.isArray(payload.input) ||
    (payload.tools !== undefined && !Array.isArray(payload.tools))
  )
    throw new ModelGatewayError('UNSUPPORTED_UPSTREAM');
  const tools: unknown[] = Array.isArray(payload.tools) ? payload.tools : [];
  if (
    tools.some(
      (tool) => !['function', 'custom'].includes(String(record(tool).type)),
    )
  )
    throw new ModelGatewayError('UNSUPPORTED_UPSTREAM');
  if (type === 'message' && item.role === 'assistant') {
    // output_text belongs to a provider-owned output item with a required
    // id. EasyInputMessage accepts plain assistant text without that id.
    return {
      role: 'assistant',
      content: Array.isArray(item.content)
        ? item.content.map((part: { text: string }) => part.text).join('')
        : item.content,
    };
  }
  const calls = new Map<string, string>();
  payload.input = payload.input.map((value: unknown) => {
    const item = record(value);
    const type = item.type ?? 'message';
    if (
      typeof type !== 'string' ||
      !allowedInputTypes.has(type) ||
      (type === 'message' &&
        (!messageRoles.has(String(item.role)) ||
          !isNeutralContent(item.content, item.role === 'assistant')))
    )
      throw new ModelGatewayError('UNSUPPORTED_UPSTREAM');
    if (type !== 'message') {
      if (typeof item.call_id !== 'string' || !item.call_id)
        throw new ModelGatewayError('UNSUPPORTED_UPSTREAM');
      const result = type.endsWith('_output');
      if (result) {
        if (
          calls.get(item.call_id) + '_output' !== type ||
          !isNeutralContent(item.output)
        )
          throw new ModelGatewayError('UNSUPPORTED_UPSTREAM');
      } else {
        calls.set(item.call_id, type);
      }
    }
    // Native function results correlate through call_id in this input. No
    // provider item identifiers are needed when replaying neutral history.
    delete item.id;
    return item;
  });
  if (hostedSearch) payload.tools = [...tools, { type: 'web_search' }];
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, {
    method: request.method,
    headers,
    signal: request.signal,
    redirect: request.redirect,
    body: JSON.stringify(payload),
  });
}

type Citation = Readonly<{ start: number; end: number; url: string }>;
const index = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function readCitation(value: unknown): Citation | undefined {
  const { type, start_index: start, end_index: end, url } = record(value);
  if (
    type !== 'url_citation' ||
    !index(start) ||
    !index(end) ||
    end < start ||
    end >= maxEventBytes ||
    typeof url !== 'string' ||
    url.length > 2048 ||
    Array.from(url).some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
    )
  )
    return;
  const parsed = URL.parse(url);
  if (
    !parsed ||
    !['https:', 'http:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    return;
  return {
    start,
    end,
    url: parsed.href.replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29')),
  };
}

function linkText(
  text: string,
  candidates: readonly Citation[],
  limit: number,
) {
  // Responses documents end_index as the last included character.
  const chars = Array.from(text);
  const unique = new Map<string, Citation>();
  for (const citation of candidates) {
    if (citation.end < chars.length)
      unique.set(
        JSON.stringify([citation.start, citation.end, citation.url]),
        citation,
      );
  }
  let tail = chars.length;
  let output = '';
  const citations = [...unique.values()].slice(0, limit);
  for (const { end, url } of citations.sort((a, b) => b.end - a.end)) {
    output = ` [来源](${url})` + chars.slice(end + 1, tail).join('') + output;
    tail = end + 1;
  }
  return {
    text: chars.slice(0, tail).join('') + output,
    count: citations.length,
  };
}

/** One projection per physical HTTP attempt. The native SDK keeps its own SSE
 * parsing and the gateway meter still sees the original bytes. Only message
 * text on output_item.done is projected into already supported DSH blocks. */
export class OpenAiCitationProjection {
  private buffer: Buffer = Buffer.alloc(0);
  private skippingOversize = false;
  private count = 0;
  private rendered = 0;
  private citations = new Map<string, Map<number, Citation[]>>();

  push(bytes: Uint8Array): Uint8Array {
    const buffer = Buffer.concat([this.buffer, bytes]);
    const frames: Buffer[] = [];
    let offset = 0;
    // A CRLF token may not backtrack into two independent line endings.
    const blankLine = /(?:\r\n|\r(?!\n)|(?<!\r)\n){2}/g;
    for (const match of buffer.toString('latin1').matchAll(blankLine)) {
      const end = match.index + match[0].length;
      const frame = buffer.subarray(offset, end);
      frames.push(
        this.skippingOversize || frame.length > maxEventBytes
          ? frame
          : this.project(frame),
      );
      this.skippingOversize = false;
      offset = end;
    }
    this.buffer = buffer.subarray(offset);
    if (this.skippingOversize || this.buffer.length > maxEventBytes) {
      this.skippingOversize = true;
      // Pass an oversized frame through, keeping only enough bytes to
      // recognize a delimiter split across transport reads.
      const flush = Math.max(0, this.buffer.length - 3);
      frames.push(this.buffer.subarray(0, flush));
      this.buffer = Buffer.from(this.buffer.subarray(flush));
    }
    return Buffer.concat(frames);
  }

  finish(): Uint8Array {
    const remaining = this.buffer;
    this.buffer = Buffer.alloc(0);
    this.citations.clear();
    return remaining;
  }

  private add(itemId: unknown, part: unknown, values: readonly unknown[]) {
    if (
      typeof itemId !== 'string' ||
      !itemId ||
      itemId.length > 256 ||
      !index(part) ||
      part >= maxCitations
    )
      return;
    for (const value of values.slice(0, maxCitations)) {
      if (this.count >= maxCitations) break;
      const citation = readCitation(value);
      if (!citation) continue;
      let parts = this.citations.get(itemId);
      if (!parts) this.citations.set(itemId, (parts = new Map()));
      let citations = parts.get(part);
      if (!citations) parts.set(part, (citations = []));
      if (
        citations.some(
          ({ start, end, url }) =>
            start === citation.start &&
            end === citation.end &&
            url === citation.url,
        )
      )
        continue;
      citations.push(citation);
      this.count++;
    }
  }

  private project(frame: Buffer): Buffer {
    let lines: string[];
    let event: Record<string, unknown>;
    try {
      lines = new TextDecoder('utf-8', { fatal: true })
        .decode(frame)
        .split(/\r\n|[\r\n]/);
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      event = record(JSON.parse(data));
    } catch {
      return frame;
    }
    if (event.type === 'response.output_text.annotation.added') {
      this.add(event.item_id, event.content_index, [event.annotation]);
      return frame;
    }
    if (event.type === 'response.content_part.done') {
      const part = record(event.part);
      if (part.type === 'output_text' && Array.isArray(part.annotations))
        this.add(event.item_id, event.content_index, part.annotations);
      return frame;
    }
    if (event.type !== 'response.output_item.done') return frame;
    const item = record(event.item);
    if (
      item.type !== 'message' ||
      item.role !== 'assistant' ||
      typeof item.id !== 'string' ||
      !Array.isArray(item.content)
    )
      return frame;
    const pending = this.citations.get(item.id);
    let changed = false;
    const content = item.content.map((value: unknown, partIndex: number) => {
      const part = record(value);
      if (part.type !== 'output_text' || typeof part.text !== 'string')
        return value;
      const final = Array.isArray(part.annotations)
        ? part.annotations.slice(0, maxCitations).flatMap((value: unknown) => {
            const citation = readCitation(value);
            return citation ? [citation] : [];
          })
        : [];
      const candidates = [...final, ...(pending?.get(partIndex) ?? [])];
      if (!candidates.length || this.rendered === maxCitations) return value;
      const linked = linkText(
        part.text,
        candidates,
        maxCitations - this.rendered,
      );
      if (!linked.count) return value;
      this.rendered += linked.count;
      changed = true;
      return { ...part, text: linked.text };
    });
    this.citations.delete(item.id);
    for (const citations of pending?.values() ?? [])
      this.count -= citations.length;
    if (!changed) return frame;
    event.item = { ...item, content };
    const fields = lines.filter((line) => line && !line.startsWith('data:'));
    return Buffer.from(
      [...fields, 'data: ' + JSON.stringify(event), '', ''].join('\n'),
    );
  }
}
