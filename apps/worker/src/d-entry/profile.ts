import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
import {
  holdReleasedProfile,
  readWorkerEmployeeWebSeal,
} from './released-profile.js';
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
type PublicationResult = { value: Publication } | { error: unknown };
export class PendingPublication {
  private result?: PublicationResult;
  private readonly waiters = new Set<(result: PublicationResult) => void>();

  finish(result: PublicationResult) {
    this.result = result;
    for (const receive of this.waiters) receive(result);
    this.waiters.clear();
  }

  async wait(caller: AbortSignal) {
    caller.throwIfAborted();
    return (
      this.result ??
      new Promise<PublicationResult>((resolve, reject) => {
        const receive = (value: PublicationResult) => {
          caller.removeEventListener('abort', stop);
          resolve(value);
        };
        const stop = () => {
          caller.removeEventListener('abort', stop);
          this.waiters.delete(receive);
          reject(caller.reason);
        };
        this.waiters.add(receive);
        caller.addEventListener('abort', stop, { once: true });
        if (caller.aborted) stop();
      })
    );
  }
}

export function createDEntryProfile(
  pages: ReturnType<typeof createDEntryPageRequests>,
  serviceSignal: AbortSignal,
  trustedReleaseDirectory?: string,
) {
  const publications = new WeakMap<DEntryPageHandle, PendingPublication>();
  const connections = new WeakMap<IncomingMessage['socket'], AbortSignal>();
  const pending = new Set<Promise<unknown>>();
  function track(work: Promise<unknown>) {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
  }
  const lifetime = new AbortController();
  const serviceLifetime = AbortSignal.any([lifetime.signal, serviceSignal]);
  let closing: Promise<void> | undefined;

  function socketLifetime(socket: IncomingMessage['socket']) {
    const existing = connections.get(socket);
    if (existing) return existing;
    const controller = new AbortController();
    connections.set(socket, controller.signal);
    if (socket.closed) controller.abort();
    else socket.once('close', () => controller.abort());
    return controller.signal;
  }

  async function publication(page: DEntryPageHandle, caller: AbortSignal) {
    caller.throwIfAborted();
    if (!page.fixedProfile) throw new DEntryNativeUnavailable();
    let held = publications.get(page);
    if (!held) {
      const opening = new PendingPublication();
      const source = page.fixedProfile;
      const revoked = () => page.invalidate(source.revoked.reason);
      const shared = AbortSignal.any([page.signal, serviceLifetime]);
      shared.throwIfAborted();
      if (source.revoked.aborted) {
        revoked();
        source.revoked.throwIfAborted();
      }
      source.revoked.addEventListener('abort', revoked, { once: true });
      shared.addEventListener(
        'abort',
        () => source.revoked.removeEventListener('abort', revoked),
        { once: true },
      );
      // The first finite preflight can finish before bootstrap/assets requests.
      // This verified release stays bound to the current page/source lifetime.
      const proof = page.use(serviceLifetime, async (active) => {
        if (trustedReleaseDirectory)
          return holdReleasedProfile(trustedReleaseDirectory, source, active);
        const seal = await readWorkerEmployeeWebSeal(active);
        return holdReleasedProfile(
          seal.directory,
          source,
          active,
          seal.manifestSha256,
        );
      });
      publications.set(page, opening);
      track(proof);
      void proof.then(
        (release) =>
          opening.finish({
            value: { release, bootstrap: 'available', events: false },
          }),
        (error) => {
          publications.delete(page);
          if (!shared.aborted) page.invalidate(error);
          opening.finish({ error });
        },
      );
      held = opening;
    }
    const result = await held.wait(caller);
    caller.throwIfAborted();
    if ('error' in result) throw result.error;
    return result.value;
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
    if (!operation || serviceLifetime.aborted) return Promise.resolve(false);
    const running = handle();
    track(running);
    return running;

    async function handle() {
      const disconnected = new AbortController();
      const stop = () => disconnected.abort();
      response.once('close', stop);
      const physical = socketLifetime(request.socket);
      const signal = AbortSignal.any([
        serviceLifetime,
        physical,
        disconnected.signal,
      ]);
      async function writeOwned(
        active: AbortSignal,
        write: () => void,
        verify?: () => Promise<void>,
      ) {
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
        physical.addEventListener('abort', closed, { once: true });
        void wire.then(() => {
          response.off('finish', finished);
          response.off('close', closed);
          physical.removeEventListener('abort', closed);
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
          active.addEventListener('abort', wake, { once: true });
          try {
            if (!response.socket && !active.aborted && !socket.closed)
              await turn;
          } finally {
            response.off('socket', wake);
            active.removeEventListener('abort', wake);
          }
        }
        if (socket.closed) {
          closed();
          return false;
        }
        const refuse = () => {
          // No page output reached this response. Hand only an empty,
          // order-preserving denial to the service and retain the actual wire.
          track(wire);
          response.writeHead(404, {
            'cache-control': 'private, no-store',
            'content-length': '0',
          });
          response.end();
          return false;
        };
        if (active.aborted && !response.headersSent) return refuse();
        try {
          if (verify) await verify();
        } catch (error) {
          if (socket.closed || response.closed) {
            closed();
            return false;
          }
          if (active.aborted && !response.headersSent) return refuse();
          // The writer still owns no response. Its page callback will deliver
          // the classified error under this same borrowed lifetime.
          closed();
          throw error;
        }
        if (socket.closed || response.closed) {
          closed();
          return false;
        }
        if (active.aborted && !response.headersSent) return refuse();
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
          if (response.headersSent) {
            abort();
            await wire;
          } else closed();
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
        verify?: () => Promise<void>,
        beforeHead?: () => void,
      ) {
        return writeOwned(
          active,
          () => {
            beforeHead?.();
            response.writeHead(status, {
              'cache-control': 'private, no-store',
              ...headers,
            });
            write();
          },
          verify,
        );
      }
      function json(
        active: AbortSignal,
        value: unknown,
        status = 200,
        verify?: () => Promise<void>,
      ) {
        return send(
          active,
          { 'content-type': 'application/json' },
          () => response.end(JSON.stringify(value)),
          status,
          verify,
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
            if (bindingRequest && bindingRequest.bindingRef !== page.bindingRef)
              throw new DataAccessError('not_found');
            const held = await publication(page, active);
            const { release } = held;
            async function verifyRelease() {
              await release.assertCurrent(active).catch((error) => {
                if (!active.aborted) page.invalidate(error);
                throw error;
              });
            }
            async function verify() {
              await verifyRelease();
              await page.assertCurrent(active);
            }
            await verifyRelease();
            if (operation === 'bootstrap') {
              if (mode === 'document') {
                await json(
                  active,
                  {
                    ...DEntryProfileAddressSchema.parse({
                      bindingRef: page.bindingRef,
                      graphRev: release.graph.rev,
                      manifestSha256: release.manifestSha256,
                    }),
                    nativeSessionId: page.root.rootNativeSessionId,
                  },
                  200,
                  verify,
                );
                return;
              }
              if (held.bootstrap !== 'available') {
                await busy(active);
                return;
              }
              const followAccess = (
                observed?: Parameters<DEntryPageHandle['scope']['stream']>[2],
              ) =>
                page.scope
                  .stream(
                    {
                      scopeId,
                      endpoint: 'remoteAccess/follow',
                      args: {},
                    },
                    active,
                    observed,
                  )
                  [Symbol.asyncIterator]();
              async function readBaseline(
                iterator: ReturnType<typeof followAccess>,
              ) {
                const first = await iterator.next();
                if (
                  first.done ||
                  first.value.scopeId !== scopeId ||
                  first.value.value.type !== 'baseline' ||
                  !('owner' in first.value.value) ||
                  first.value.value.owner !== false
                )
                  throw new DEntryNativeUnavailable();
                return first.value.value;
              }
              held.bootstrap = 'sending';
              let latestAccess: ReturnType<typeof followAccess> | undefined;
              try {
                let body: string;
                let firstItem = true;
                let superseded = false;
                const sent = await send(
                  active,
                  { 'content-type': 'application/json' },
                  () => response.end(body),
                  200,
                  async () => {
                    await verify();
                    const initialAccess = followAccess();
                    await readBaseline(initialAccess).catch(async (error) => {
                      await initialAccess.return?.().catch(() => {});
                      throw error;
                    });
                    await initialAccess.return?.().catch((error) => {
                      page.invalidate(error);
                      throw error;
                    });
                    // Closing the initial native reader can block while its
                    // grants change. Read from the same Peer after that join.
                    // Keep this reader owned through the actual response.
                    latestAccess = followAccess(() => {
                      if (firstItem) firstItem = false;
                      else superseded = true;
                    });
                    const baseline = await readBaseline(latestAccess);
                    await verify();
                    body = JSON.stringify(
                      DEntryProfileBootstrapSchema.parse({
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
                      }),
                    );
                  },
                  () => {
                    if (superseded) throw new DataAccessError('not_found');
                  },
                );
                if (sent) held.bootstrap = 'sent';
              } finally {
                try {
                  await latestAccess?.return?.();
                } catch (error) {
                  page.invalidate(error);
                }
                if (held.bootstrap === 'sending') held.bootstrap = 'available';
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
                await send(
                  active,
                  { 'content-type': 'text/event-stream; charset=utf-8' },
                  () =>
                    response.write(
                      `data: ${JSON.stringify({ type: 'graph', graph: release.graph })}\n\n`,
                    ),
                  200,
                  verify,
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
            await send(
              active,
              {
                'content-type': asset.media,
                'content-length': String(asset.data.byteLength),
                'x-content-type-options': 'nosniff',
              },
              () => response.end(asset.data),
              200,
              verify,
            );
          },
          async (error, active) => {
            await writeOwned(active, () =>
              sendDEntryHttpProblem(response, error),
            );
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
      closing = Promise.resolve().then(async () => {
        // An admitted handler can move a queued denial to the wire set after
        // observing the abort. Keep taking ownership until both are empty.
        while (pending.size) await Promise.allSettled([...pending]);
      });
      lifetime.abort();
      return closing;
    },
  };
}
