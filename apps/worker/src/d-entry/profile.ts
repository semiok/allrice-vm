import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  DEntryPageBorrowSchema,
  DEntryProfileAddressSchema,
  DEntryProfileAssetSchema,
  DEntryProfileBindingSchema,
  DEntryProfileBootstrapSchema,
  DEntryProfileFilePathSchema,
  UuidSchema,
} from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import { dEntryBearer, sendDEntryHttpProblem } from './http.js';
import { DEntryNativeUnavailable } from './native-owner.js';
import type {
  createDEntryPageRequests,
  DEntryPageHandle,
} from './principal-requests.js';
import { holdReleasedProfile } from './released-profile.js';

const directory = fileURLToPath(
  new URL(
    '../../../../packages/dsh-web-composition/dist/web-entry',
    import.meta.url,
  ),
);
const bootstrapQuery = DEntryPageBorrowSchema.extend({
  organizationId: UuidSchema,
});
const eventsQuery = DEntryProfileBindingSchema.extend({
  organizationId: UuidSchema,
});
const assetQuery = DEntryProfileAssetSchema.extend({
  organizationId: UuidSchema,
});
const staticQuery = bootstrapQuery.extend({
  ...DEntryProfileAddressSchema.shape,
  path: DEntryProfileFilePathSchema,
});
type Release = Awaited<ReturnType<typeof holdReleasedProfile>>;
type Publication = {
  release: Release;
  bootstrap: 'available' | 'sending' | 'sent';
  events: boolean;
};

class ProfileBusy extends Error {}
export function createDEntryProfile(
  pages: ReturnType<typeof createDEntryPageRequests>,
  serviceSignal: AbortSignal,
  trustedReleaseDirectory = directory,
) {
  const publications = new WeakMap<DEntryPageHandle, Promise<Publication>>();
  const pending = new Set<Promise<boolean>>();
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;

  async function publication(page: DEntryPageHandle, caller: AbortSignal) {
    if (!page.fixedProfile) throw new DEntryNativeUnavailable();
    let held = publications.get(page);
    if (!held) {
      const source = page.fixedProfile;
      const revoked = () => page.invalidate(source.revoked.reason);
      source.revoked.addEventListener('abort', revoked, { once: true });
      // Detach the read-only source observation when the page fences.
      page.signal.addEventListener(
        'abort',
        () => source.revoked.removeEventListener('abort', revoked),
        { once: true },
      );
      if (source.revoked.aborted) revoked();
      held = holdReleasedProfile(trustedReleaseDirectory, source, caller).then(
        (release) => ({ release, bootstrap: 'available', events: false }),
      );
      publications.set(page, held);
      void held.catch((error) => {
        publications.delete(page);
        if (!caller.aborted && !page.signal.aborted) page.invalidate(error);
      });
    }
    return held;
  }

  async function json(
    response: ServerResponse,
    value: unknown,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    response.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    });
    response.end(JSON.stringify(value));
    await finished(response, { cleanup: true });
  }

  function service(request: IncomingMessage, response: ServerResponse) {
    const path = request.url?.split('?')[0];
    const operation =
      path === '/internal/d-entry/profile/bootstrap'
        ? 'bootstrap'
        : path === '/internal/d-entry/profile/assets'
          ? 'assets'
          : path === '/internal/d-entry/profile/events'
            ? 'events'
            : undefined;
    if (!operation) return Promise.resolve(false);
    const running = handle();
    pending.add(running);
    void running.then(
      () => pending.delete(running),
      () => pending.delete(running),
    );
    return running;

    async function handle() {
      const disconnected = new AbortController();
      const stop = () => disconnected.abort();
      response.once('close', stop);
      const signal = AbortSignal.any([
        lifetime.signal,
        serviceSignal,
        disconnected.signal,
      ]);
      try {
        signal.throwIfAborted();
        if (request.method !== 'GET' || request.headers.origin)
          throw new DataAccessError('not_found');
        const { searchParams } = new URL(request.url!, 'http://worker.invalid');
        if (
          [...searchParams.keys()].some(
            (key) => searchParams.getAll(key).length !== 1,
          )
        )
          throw new SyntaxError('Entry selectors must be unique');
        const mode = request.headers['x-allrice-profile-request'];
        // Two static-document variants borrow the same service across the
        // existing Web→Worker trust boundary. Only Web sets this header.
        if (
          mode !== undefined &&
          !(operation === 'bootstrap' && mode === 'document') &&
          !(operation === 'assets' && mode === 'static')
        )
          throw new SyntaxError('Invalid profile request');
        const query = Object.fromEntries(searchParams);
        const base = bootstrapQuery.parse(
          Object.fromEntries(
            Object.entries(query).filter(
              ([name]) => name in bootstrapQuery.shape,
            ),
          ),
        );
        const { organizationId, scopeId, ...selection } = base;
        const token = dEntryBearer(request);
        const exact =
          operation === 'bootstrap'
            ? bootstrapQuery.parse(query)
            : operation === 'events'
              ? eventsQuery.parse(query)
              : mode === 'static'
                ? staticQuery.parse(query)
                : assetQuery.parse(query);
        await pages.borrow(
          token,
          { organizationId, selection },
          scopeId,
          signal,
          async (page, active) => {
            if ('bindingRef' in exact && exact.bindingRef !== page.bindingRef)
              throw new DataAccessError('not_found');
            const held = await publication(page, active);
            const { release } = held;
            await release.assertCurrent(active).catch((error) => {
              if (!active.aborted) page.invalidate(error);
              throw error;
            });
            if (operation === 'bootstrap') {
              if (mode === 'document') {
                await page.assertCurrent(active);
                return json(
                  response,
                  DEntryProfileAddressSchema.parse({
                    bindingRef: page.bindingRef,
                    graphRev: release.graph.rev,
                    manifestSha256: release.manifestSha256,
                  }),
                  active,
                );
              }
              if (held.bootstrap !== 'available') throw new ProfileBusy();
              held.bootstrap = 'sending';
              try {
                const baseline = page.scope.opened.baseline;
                if (baseline.owner !== false)
                  throw new DEntryNativeUnavailable();
                const body = DEntryProfileBootstrapSchema.parse({
                  version: 1,
                  scopeReference: { scopeId },
                  bindingRef: page.bindingRef,
                  graph: release.graph,
                  injections: [
                    ...release.injections,
                    {
                      kind: 'global',
                      name: '__DSH_REMOTE_ACCESS__',
                      value: baseline,
                    },
                  ],
                });
                await page.assertCurrent(active);
                await json(response, body, active);
                held.bootstrap = 'sent';
              } finally {
                if (held.bootstrap === 'sending') held.bootstrap = 'available';
              }
              return;
            }
            if (operation === 'events') {
              if (held.events) throw new ProfileBusy();
              held.events = true;
              const abort = () => response.destroy();
              try {
                await page.assertCurrent(active);
                active.throwIfAborted();
                response.writeHead(200, {
                  'content-type': 'text/event-stream; charset=utf-8',
                  'cache-control': 'private, no-store',
                });
                active.addEventListener('abort', abort, { once: true });
                response.write(
                  `data: ${JSON.stringify({ type: 'graph', graph: release.graph })}\n\n`,
                );
                // The certified graph is fixed for this source lifetime.
                await finished(response, { cleanup: true });
              } finally {
                active.removeEventListener('abort', abort);
                held.events = false;
              }
              return;
            }

            let asset: Awaited<ReturnType<Release['readStatic']>>;
            try {
              if ('path' in exact) {
                if (
                  exact.manifestSha256 !== release.manifestSha256 ||
                  exact.graphRev !== release.graph.rev
                )
                  throw new DataAccessError('not_found');
                asset = await release.readStatic(exact.path, active);
              } else if ('reference' in exact) {
                asset = await release.readReference(
                  exact.reference,
                  exact.revision,
                  active,
                );
              } else throw new DataAccessError('not_found');
            } catch (error) {
              if (!active.aborted && !(error instanceof DataAccessError))
                page.invalidate(error);
              throw error;
            }
            await page.assertCurrent(active);
            active.throwIfAborted();
            response.writeHead(200, {
              'content-type': asset.media,
              'content-length': asset.data.byteLength,
              'cache-control': 'private, no-store',
              'x-content-type-options': 'nosniff',
            });
            response.end(asset.data);
            await finished(response, { cleanup: true });
          },
        );
      } catch (error) {
        if (
          error instanceof ProfileBusy &&
          !response.headersSent &&
          !response.destroyed
        ) {
          response.writeHead(409, {
            'content-type': 'application/json',
            'cache-control': 'private, no-store',
          });
          response.end(
            JSON.stringify({
              error: {
                code: 'CONFLICT',
                message: 'A profile request already owns this response',
                requestId: randomUUID(),
                retryable: false,
              },
            }),
          );
        } else {
          sendDEntryHttpProblem(response, error);
        }
      } finally {
        response.off('close', stop);
      }
      return true;
    }
  }

  return {
    handle: service,
    close() {
      if (closing) return closing;
      lifetime.abort();
      return (closing = Promise.allSettled([...pending]).then(() => {}));
    },
  };
}
