import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { RequestContext } from '@allrice/contracts';
import { EgressError, sendEgressResponse } from '@allrice/egress-gateway';
import type {
  PersonVmAdmissionBindingPort,
  PersonVmAdmissionBoundary,
  PersonVmBinding,
} from '@allrice/person-vm';
import {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
} from '@deepseek-ai/dsh-web-search-deepseek';
import type { WebSearchProvider } from '@deepseek-ai/dsh-web';
import { z } from 'zod';

export const webSearchRoute = 'web-search';
export const webSearchPath = '/v1/web/search';

const maxRequestBytes = 8_192;
const maxResponseBytes = 256 * 1024;
const searchTimeoutMs = 55_000;
const quotaWindowMs = 60_000;
const wireSearch = z
  .object({
    adapterId: z.string().regex(/^[a-f0-9]{64}$/),
    sessionId: z.string().min(1).max(256),
    query: z.string().trim().min(1).max(2_000),
    maxResults: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export async function readGuestSearch(
  request: IncomingMessage,
  signal: AbortSignal,
) {
  const length = request.headers['content-length'];
  if (
    request.headers['content-type'] !== 'application/json' ||
    request.headers['transfer-encoding'] ||
    typeof length !== 'string' ||
    !/^[1-9][0-9]{0,3}$/.test(length) ||
    Number(length) > maxRequestBytes
  )
    throw new EgressError('DENIED');

  signal.throwIfAborted();
  const abort = () => request.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      signal.throwIfAborted();
      size += Buffer.byteLength(chunk);
      if (size > Number(length)) throw new EgressError('DENIED');
      chunks.push(Buffer.from(chunk));
    }
    signal.throwIfAborted();
    try {
      if (size !== Number(length)) throw new EgressError('DENIED');
      return wireSearch.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
    } catch {
      throw new EgressError('DENIED');
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export type GuestSearchRequest = z.infer<typeof wireSearch>;

export function createHostSearchProvider(
  key: string | undefined,
): WebSearchProvider | undefined {
  if (!key?.trim()) return undefined;
  return new DeepSeekSearchProvider(() => ({
    apiKey: key,
    baseURL: DEEPSEEK_DEFAULT_BASE_URL,
    apiVersion: DEEPSEEK_DEFAULT_API_VERSION,
    model: DEEPSEEK_DEFAULT_MODEL,
    maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxUses: DEEPSEEK_DEFAULT_MAX_USES,
  }));
}

type SearchAuthority = {
  context: RequestContext;
  binding: PersonVmBinding;
  signal: AbortSignal;
  assertCurrent(signal: AbortSignal): Promise<void>;
};

export function createHostSearch({
  provider,
  vm,
  admission,
  requestsPerPersonPerMinute,
}: {
  provider: Pick<WebSearchProvider, 'search'>;
  vm: PersonVmAdmissionBindingPort;
  admission: PersonVmAdmissionBoundary;
  requestsPerPersonPerMinute: number;
}) {
  if (
    !Number.isSafeInteger(requestsPerPersonPerMinute) ||
    requestsPerPersonPerMinute <= 0
  )
    throw new EgressError('POLICY_INVALID');
  const quota = new Map<string, number>();
  let window = -1;
  function spend(personId: string) {
    const now = Math.floor(performance.now() / quotaWindowMs);
    if (now !== window) {
      quota.clear();
      window = now;
    }
    const used = quota.get(personId) ?? 0;
    if (used >= requestsPerPersonPerMinute)
      throw new EgressError('LIMIT_EXCEEDED');
    quota.set(personId, used + 1);
  }
  return async function dispatch(
    { context, binding, signal, assertCurrent }: SearchAuthority,
    { query, maxResults }: GuestSearchRequest,
    response: ServerResponse,
    caller: AbortSignal,
  ) {
    const active = AbortSignal.any([
      caller,
      signal,
      AbortSignal.timeout(searchTimeoutMs),
    ]);
    active.throwIfAborted();
    const permit = await admission.admit(
      context,
      binding,
      {
        participant: 'gateway',
        operationId: randomUUID(),
      },
      active,
    );
    try {
      if (permit.disposition !== 'queued') throw new EgressError('UNAVAILABLE');
      const outcome = await admission.queued(
        permit,
        (queued) =>
          admission.activate(
            permit,
            async (owned) => {
              const current = AbortSignal.any([
                active,
                permit.signal,
                queued,
                owned,
              ]);
              try {
                await assertCurrent(current);
                await vm.assertAdmissionBinding(context, binding, current);
                current.throwIfAborted();
                spend(binding.personId);
                const result = await provider
                  .search({ query, maxResults }, current)
                  .catch(() => {
                    throw new EgressError('UNAVAILABLE');
                  });
                const sources = result.sources.slice(0, maxResults ?? 20);
                const body = Buffer.from(
                  JSON.stringify({
                    ...result,
                    sources,
                    truncated:
                      result.truncated ||
                      sources.length < result.sources.length,
                  }),
                );
                if (body.byteLength > maxResponseBytes)
                  throw new EgressError('LIMIT_EXCEEDED');
                await assertCurrent(current);
                await vm.assertAdmissionBinding(context, binding, current);
                current.throwIfAborted();
                await sendEgressResponse(
                  response,
                  { status: 200, contentType: 'application/json', body },
                  current,
                );
                return { ok: true as const };
              } catch (error) {
                // Provider search joins dispatch/content before returning, and the
                // shared HTTP writer joins response closure on failure.
                return { ok: false as const, error };
              }
            },
            queued,
          ),
        active,
      );
      if (!outcome.ok) throw outcome.error;
    } finally {
      await admission.finish(permit);
    }
  };
}
