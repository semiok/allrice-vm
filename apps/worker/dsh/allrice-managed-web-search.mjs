import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { ReadableStream } from 'node:stream/web';
import { pathToFileURL, URL } from 'node:url';
import { TextEncoder } from 'node:util';

export const name = 'allrice-managed-web-search';
export const inject = ['web'];

const calls = new AsyncLocalStorage();

/** One proof per invocation of the native provider, owned by its tool body. */
export function observeManagedSearchCalls(
  scope,
  adapterId,
  lifetime,
  readOrigin,
) {
  const pending = new Map();
  scope.on(
    'tools/execute',
    async (exec, next) => {
      const sessionId = exec.agent?.session?.id;
      if (exec.name !== 'web_search' || !sessionId) return next();
      const origin = readOrigin(sessionId);
      if (!origin) return next();
      const stop = new globalThis.AbortController();
      const active = globalThis.AbortSignal.any([
        lifetime,
        stop.signal,
        exec.signal,
        origin.signal,
      ]);
      const queries = Array.isArray(exec.arguments?.queries)
        ? exec.arguments.queries.filter((query) => typeof query === 'string')
        : [];
      try {
        return await calls.run(
          {
            issue(query, maxResults, signal, requestedAdapter) {
              const index = queries.indexOf(query);
              if (
                index === -1 ||
                active.aborted ||
                requestedAdapter !== adapterId
              )
                return null;
              queries.splice(index, 1);
              const id = randomUUID();
              const current = signal
                ? globalThis.AbortSignal.any([active, signal])
                : active;
              if (current.aborted) return null;
              pending.set(id, {
                query,
                maxResults,
                sessionId,
                signal: current,
                expires: performance.now() + 10_000,
                proof: { ...origin.proof, callId: exec.callId, sessionId },
              });
              return {
                id,
                sessionId,
                signal: current,
                dispose: () => pending.delete(id),
              };
            },
          },
          next,
        );
      } finally {
        stop.abort();
      }
    },
    { global: true },
  );
  return (wanted, request) => {
    const entry = pending.get(wanted.ticket);
    const notFound = () => new globalThis.Response(null, { status: 404 });
    if (
      !entry ||
      entry.signal.aborted ||
      entry.expires < performance.now() ||
      entry.sessionId !== wanted.sessionId ||
      entry.query !== wanted.query ||
      entry.maxResults !== wanted.maxResults
    )
      return notFound();
    pending.delete(wanted.ticket);
    const active = globalThis.AbortSignal.any([entry.signal, request.signal]);
    if (active.aborted) return notFound();
    let detach;
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        const close = () => {
          controller.enqueue(encoder.encode('ended\n'));
          controller.close();
        };
        detach = () => active.removeEventListener('abort', close);
        active.addEventListener('abort', close, { once: true });
        controller.enqueue(encoder.encode(JSON.stringify(entry.proof) + '\n'));
      },
      cancel() {
        detach?.();
      },
    });
    return new globalThis.Response(body, {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  };
}

export async function apply(
  ctx,
  { cliPath, origin, capability, adapterId, enabled },
) {
  const require = createRequire(cliPath);
  const { WebError } = await import(
    pathToFileURL(require.resolve('@deepseek-ai/dsh-web')).href
  );
  const endpoint = new URL('/v1/web/search', origin);
  return ctx.web.registerSearchProvider({
    id: 'deepseek-official',
    available: () => enabled === true,
    async search({ query, maxResults }, signal) {
      if (enabled !== true)
        throw new WebError(
          'Managed search is unavailable',
          'WEB_PROVIDER_ERROR',
        );
      if (query.includes(capability))
        throw new WebError(
          'Search query contains a credential',
          'WEB_PROVIDER_ERROR',
        );
      const ticket = calls
        .getStore()
        ?.issue(query, maxResults, signal, adapterId);
      if (!ticket)
        throw new WebError(
          'Search needs an active conversation',
          'WEB_PROVIDER_ERROR',
        );
      try {
        ticket.signal.throwIfAborted();
        const response = await globalThis
          .fetch(endpoint, {
            method: 'POST',
            signal: ticket.signal,
            redirect: 'error',
            headers: {
              authorization: 'Bearer ' + capability,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              adapterId,
              sessionId: ticket.sessionId,
              ticket: ticket.id,
              query,
              maxResults,
            }),
          })
          .catch(() => {
            ticket.signal.throwIfAborted();
            throw new WebError(
              'Managed search is unavailable',
              'WEB_PROVIDER_ERROR',
            );
          });
        if (!response.ok) {
          const code = (await response.json().catch(() => null))?.code;
          throw new WebError(
            code === 'LIMIT_EXCEEDED'
              ? 'Search limit reached. Try again later.'
              : 'Managed search is unavailable',
            code === 'LIMIT_EXCEEDED'
              ? 'WEB_SEARCH_LIMIT_EXCEEDED'
              : 'WEB_PROVIDER_ERROR',
          );
        }
        return await response.json();
      } finally {
        ticket.dispose();
      }
    },
  });
}
