import type { GatewayFetchClassification } from './contract.ts';

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
