import {
  ModelGatewayError,
  type GatewayFetchClassification,
} from './contract.ts';
import {
  readModelJsonRequest,
  replaceModelJsonRequest,
} from './openai-responses.ts';

export const DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_CHAT_URL = DEEPSEEK_API_BASE_URL + '/chat/completions';
export const DEEPSEEK_RESPONSES_URL = DEEPSEEK_API_BASE_URL + '/responses';

export function classifyDeepSeek(
  protocol: 'chat' | 'responses',
  input: RequestInfo | URL,
  init?: RequestInit,
): GatewayFetchClassification | null {
  const request = input instanceof Request ? input : undefined;
  if ((init?.method ?? request?.method)?.toUpperCase() !== 'POST') return null;
  const url = request?.url ?? String(input);
  if (protocol === 'chat' && url === DEEPSEEK_CHAT_URL)
    return { kind: 'model', protocol: 'openai-chat-completions' };
  if (protocol === 'responses' && url === DEEPSEEK_RESPONSES_URL)
    return { kind: 'model', protocol: 'openai-responses' };
  return null;
}

/** Public DeepSeek Chat mode for stateless, provider-neutral tool history.
 * Thinking mode needs every provider reasoning trace; that state cannot be
 * reconstructed safely from earlier calls on a different routed model. */
export async function prepareDeepSeekChatRequest(
  request: Request,
  model: string,
) {
  const payload = await readModelJsonRequest(request);
  if (
    payload.model !== model ||
    payload.stream !== true ||
    !Array.isArray(payload.messages) ||
    (payload.tools !== undefined &&
      (!Array.isArray(payload.tools) ||
        payload.tools.some(
          (tool: unknown) =>
            !tool ||
            typeof tool !== 'object' ||
            !('type' in tool) ||
            tool.type !== 'function',
        )))
  )
    throw new ModelGatewayError('UNSUPPORTED_UPSTREAM');

  // The SDK owns function-call serialization. Pin the official non-thinking
  // control explicitly; the API defaults to thinking when it is absent.
  delete payload.reasoning_effort;
  payload.thinking = { type: 'disabled' };
  return replaceModelJsonRequest(request, payload);
}
