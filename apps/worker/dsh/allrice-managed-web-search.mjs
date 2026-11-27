import { createRequire } from 'node:module';
import { pathToFileURL, URL } from 'node:url';

export const name = 'allrice-managed-web-search';
export const inject = ['agents', 'web'];

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
      const sessionId = ctx.agents.currentInitiator()?.session.id;
      if (!sessionId)
        throw new WebError(
          'Search needs an active conversation',
          'WEB_PROVIDER_ERROR',
        );
      signal?.throwIfAborted();
      const response = await globalThis
        .fetch(endpoint, {
          method: 'POST',
          signal,
          redirect: 'error',
          headers: {
            authorization: 'Bearer ' + capability,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ adapterId, sessionId, query, maxResults }),
        })
        .catch(() => {
          signal?.throwIfAborted();
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
      return response.json();
    },
  });
}
