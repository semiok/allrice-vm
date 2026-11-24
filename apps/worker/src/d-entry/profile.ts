import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
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

export function createDEntryProfile(
  pages: ReturnType<typeof createDEntryPageRequests>,
  serviceSignal: AbortSignal,
  trustedReleaseDirectory = directory,
) {
  const publications = new WeakMap<DEntryPageHandle, Promise<Publication>>();
  const pending = new Set<Promise<unknown>>();
  function track(work: Promise<unknown>) {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
  }
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
      // The first finite preflight can finish before bootstrap/assets requests.
      // This verified release stays bound to the current page/source lifetime.
      held = holdReleasedProfile(
        trustedReleaseDirectory,
        source,
        page.signal,
      ).then((release) => ({ release, bootstrap: 'available', events: false }));
      publications.set(page, held);
      void held.catch((error) => {
        publications.delete(page);
        if (!page.signal.aborted) page.invalidate(error);
      });
    }
    const current = await held;
    caller.throwIfAborted();
    return current;
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
    track(running);
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
      async function writeOwned(active: AbortSignal, write: () => void) {
        const { socket } = request;
        if (response.writableFinished || response.closed || socket.closed)
          return false;
        let settle!: (sent: boolean) => void;
        const wire = new Promise<boolean>((resolve) => {
          settle = resolve;
        });
        const finished = () => settle(true);
        const closed = () => settle(false);
        response.once('finish', finished);
        response.once('close', closed);
        socket.once('close', closed);
        void wire.then(() => {
          response.off('finish', finished);
          response.off('close', closed);
          socket.off('close', closed);
        });

        if (!response.socket && !active.aborted) {
          // A pipelined response cannot write or cancel another response's
          // socket. Wait for Node to assign this exact response before handing
          // it any headers or business bytes.
          let wake!: () => void;
          const turn = new Promise<void>((resolve) => {
            wake = resolve;
          });
          response.once('socket', wake);
          socket.once('close', wake);
          active.addEventListener('abort', wake, { once: true });
          try {
            if (!response.socket && !active.aborted && !socket.closed)
              await turn;
          } finally {
            response.off('socket', wake);
            socket.off('close', wake);
            active.removeEventListener('abort', wake);
          }
        }
        if (socket.closed) {
          closed();
          return false;
        }
        if (active.aborted && !response.socket) {
          // No page output reached Node. Transfer only an empty, order-
          // preserving denial to the service; the earlier response can keep
          // writing. The service owns this framing until finish/socket close.
          track(wire);
          response.writeHead(404, {
            'cache-control': 'private, no-store',
            'content-length': '0',
          });
          response.end();
          return false;
        }
        // Once a fixed-length response has started, only transport closure
        // can both stop its bytes and avoid corrupting HTTP/1.1 framing.
        const abort = () => {
          if (!response.writableFinished && response.socket) response.destroy();
        };
        active.addEventListener('abort', abort, { once: true });
        try {
          if (active.aborted) abort();
          else write();
          return await wire;
        } catch (error) {
          abort();
          await wire;
          throw error;
        } finally {
          active.removeEventListener('abort', abort);
        }
      }
      function send(
        active: AbortSignal,
        headers: Record<string, string>,
        write: () => void,
        status = 200,
      ) {
        return writeOwned(active, () => {
          response.writeHead(status, {
            'cache-control': 'private, no-store',
            ...headers,
          });
          write();
        });
      }
      function json(active: AbortSignal, value: unknown, status = 200) {
        return send(
          active,
          { 'content-type': 'application/json' },
          () => response.end(JSON.stringify(value)),
          status,
        );
      }
      function busy(active: AbortSignal) {
        return json(
          active,
          {
            error: {
              code: 'CONFLICT',
              message: 'A profile request already owns this response',
              requestId: randomUUID(),
              retryable: false,
            },
          },
          409,
        );
      }
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
        if (operation === 'bootstrap') bootstrapQuery.parse(query);
        const events =
          operation === 'events' ? eventsQuery.parse(query) : undefined;
        const staticFile =
          operation === 'assets' && mode === 'static'
            ? staticQuery.parse(query)
            : undefined;
        const bundle =
          operation === 'assets' && mode !== 'static'
            ? assetQuery.parse(query)
            : undefined;
        const bindingRequest = events ?? staticFile ?? bundle;
        await pages.borrow(
          token,
          { organizationId, selection },
          scopeId,
          signal,
          async (page, active) => {
            try {
              if (
                bindingRequest &&
                bindingRequest.bindingRef !== page.bindingRef
              )
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
                  await json(active, {
                    ...DEntryProfileAddressSchema.parse({
                      bindingRef: page.bindingRef,
                      graphRev: release.graph.rev,
                      manifestSha256: release.manifestSha256,
                    }),
                    nativeSessionId: page.root.rootNativeSessionId,
                  });
                  return;
                }
                if (held.bootstrap !== 'available') {
                  await busy(active);
                  return;
                }
                held.bootstrap = 'sending';
                try {
                  const iterator = page.scope
                    .stream(
                      {
                        scopeId,
                        endpoint: 'remoteAccess/follow',
                        args: {},
                      },
                      active,
                    )
                    [Symbol.asyncIterator]();
                  const first = await iterator
                    .next()
                    .finally(() => iterator.return?.());
                  if (
                    first.done ||
                    first.value.scopeId !== scopeId ||
                    first.value.value.type !== 'baseline' ||
                    !('owner' in first.value.value) ||
                    first.value.value.owner !== false
                  )
                    throw new DEntryNativeUnavailable();
                  const baseline = first.value.value;
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
                  if (await json(active, body)) held.bootstrap = 'sent';
                } finally {
                  if (held.bootstrap === 'sending')
                    held.bootstrap = 'available';
                }
                return;
              }
              if (operation === 'events') {
                if (held.events) {
                  await busy(active);
                  return;
                }
                held.events = true;
                try {
                  await page.assertCurrent(active);
                  await send(
                    active,
                    { 'content-type': 'text/event-stream; charset=utf-8' },
                    () =>
                      response.write(
                        `data: ${JSON.stringify({ type: 'graph', graph: release.graph })}\n\n`,
                      ),
                  );
                } finally {
                  held.events = false;
                }
                return;
              }

              let asset: Awaited<ReturnType<Release['readStatic']>>;
              try {
                if (staticFile) {
                  if (
                    staticFile.manifestSha256 !== release.manifestSha256 ||
                    staticFile.graphRev !== release.graph.rev
                  )
                    throw new DataAccessError('not_found');
                  asset = await release.readStatic(staticFile.path, active);
                } else if (bundle) {
                  asset = await release.readReference(
                    bundle.reference,
                    bundle.revision,
                    active,
                  );
                } else throw new DataAccessError('not_found');
              } catch (error) {
                if (!active.aborted && !(error instanceof DataAccessError))
                  page.invalidate(error);
                throw error;
              }
              await page.assertCurrent(active);
              await send(
                active,
                {
                  'content-type': asset.media,
                  'content-length': String(asset.data.byteLength),
                  'x-content-type-options': 'nosniff',
                },
                () => response.end(asset.data),
              );
            } catch (error) {
              if (active.aborted) throw error;
              await writeOwned(active, () =>
                sendDEntryHttpProblem(response, error),
              );
            }
          },
        );
      } catch (error) {
        await writeOwned(signal, () => sendDEntryHttpProblem(response, error));
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
