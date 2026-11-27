import { on } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { WebSocket, WebSocketServer } from 'ws';
import {
  REMOTE_EVENT_STREAM_PAYLOAD,
  parseRemoteStreamClientMessage,
  type RemoteStreamServerMessage,
} from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import {
  RemoteError,
  isRemoteJsonValue,
} from '@deepseek-ai/dsh-typert-protocol';
import {
  DEntryPageMuxQuerySchema,
  DEntryPageSwitchSchema,
  type DEntrySelectionInput,
} from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import { TYPERT_REMOTE as Native } from '@deepseek-ai/dsh-api-session-controller/remote';
import { dEntryBearer, dEntryHttpProblem } from './http.js';
import { authorizeDEntryNativeInvocation } from './native-invocation.js';
import {
  DEntryNativeRootRejected,
  DEntryNativeUnavailable,
} from './native-owner.js';
import {
  DEntryPageSwitchUnavailable,
  type DEntryPageHandle,
  type createDEntryPageRequests,
} from './principal-requests.js';

const emptyPayload = z.object({ args: z.strictObject({}) }).strict();
const denied = () => new DataAccessError('authorization_denied');
type Frame = ReturnType<typeof parseRemoteStreamClientMessage>;
type Send = (value: RemoteStreamServerMessage) => Promise<void>;

export function pageRemoteFailure(error: unknown) {
  if (error instanceof DEntryNativeRootRejected)
    return {
      code: 'gateway/unavailable',
      message: 'ENTRY_ACTION_UNAVAILABLE',
      details: {},
    };
  if (error instanceof RemoteError)
    return { code: error.code, message: error.message, details: error.details };
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string' &&
    'details' in error &&
    isRemoteJsonValue(error.details)
  )
    return { code: error.code, message: error.message, details: error.details };
  const status = dEntryHttpProblem(error).status;
  if (status === 400 || status === 404)
    return {
      code: 'gateway/forbidden',
      message: 'ENTRY_ACTION_UNAVAILABLE',
      details: {},
    };
  return {
    code: 'gateway/internal',
    message: 'PRINCIPAL_JOIN_UNKNOWN',
    details: {},
  };
}
function sendTo(peer: WebSocket): Send {
  return (value) =>
    new Promise((resolve, reject) =>
      peer.send(JSON.stringify(value), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
}

function openPeer(
  wss: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) {
  return new Promise<WebSocket>((resolve, reject) => {
    const disconnected = () => reject(new DEntryNativeUnavailable());
    socket.once('close', disconnected);
    try {
      wss.handleUpgrade(request, socket, head, (peer) => {
        socket.off('close', disconnected);
        resolve(peer);
      });
    } catch (error) {
      socket.off('close', disconnected);
      reject(error);
    }
  });
}

type OwnedPage = {
  setup: AbortController;
  stop: AbortController;
  page?: DEntryPageHandle;
  resources?: ReturnType<typeof pageStreams>;
  operation: Promise<void>;
};

async function runOwner(
  pages: ReturnType<typeof createDEntryPageRequests>,
  token: string,
  input: {
    organizationId: string;
    selection: DEntrySelectionInput;
  },
  peer: WebSocket,
  connected: AbortSignal,
) {
  const send = sendTo(peer);
  let streamId: string | undefined;
  let current: OwnedPage | undefined;
  let staged: OwnedPage | undefined;
  let handoff: Promise<void> | undefined;
  let terminal: Promise<void> | undefined;
  let requestedClose = false;
  const notify = (error: unknown) => {
    if (!streamId || terminal || connected.aborted) return;
    terminal = send({
      type: 'error',
      streamId,
      error: pageRemoteFailure(error),
    });
    return terminal;
  };
  const fail = (error: unknown) => {
    void notify(error)
      ?.finally(() => peer.close())
      .catch(() => peer.terminate());
  };

  function begin(
    selection: DEntrySelectionInput,
    publish: (generation: OwnedPage, page: DEntryPageHandle) => Promise<void>,
    previous?: DEntryPageHandle,
  ) {
    const setup = new AbortController();
    const stop = new AbortController();
    const signal = AbortSignal.any([connected, setup.signal]);
    const generation: OwnedPage = {
      setup,
      stop,
      operation: pages.own(
        token,
        { organizationId: input.organizationId, selection },
        signal,
        stop.signal,
        async (page) => {
          stop.signal.throwIfAborted();
          page.signal.throwIfAborted();
          generation.page = page;
          await publish(generation, page);
        },
        (error) => {
          if (!requestedClose && !stop.signal.aborted) fail(error);
        },
        previous,
      ),
    };
    return generation;
  }

  function endPage(generation: OwnedPage | undefined, reason?: unknown) {
    generation?.stop.abort(reason);
    if (!generation?.page) generation?.setup.abort(reason);
  }

  async function join(generation: OwnedPage | undefined) {
    if (!generation) return;
    const [streams, scope] = await Promise.allSettled([
      generation.resources?.close(),
      generation.operation,
    ]);
    if (streams.status === 'rejected') throw streams.reason;
    if (
      scope.status === 'rejected' &&
      (generation.page ||
        !generation.setup.signal.aborted ||
        scope.reason !== generation.setup.signal.reason)
    )
      throw scope.reason;
  }

  function mount(generation: OwnedPage, page: DEntryPageHandle) {
    generation.resources = pageStreams(
      page,
      send,
      AbortSignal.any([connected, generation.stop.signal, page.signal]),
    );
    current = generation;
  }

  function switchThread(
    command: ReturnType<typeof DEntryPageSwitchSchema.parse>,
    id: string,
  ) {
    const previous = current;
    const previousPage = previous?.page;
    if (!previousPage || staged || requestedClose) throw denied();
    previousPage.signal.throwIfAborted();
    const decline = () =>
      send({
        type: 'item',
        streamId: id,
        value: { type: 'switch-unavailable', requestId: command.requestId },
      });
    if (command.threadId === previousPage.identity.threadId) return decline();
    staged = begin(
      { ...input.selection, threadId: command.threadId },
      async (generation, page) => {
        // New authority is watching before the old registration is fenced.
        // No stream or unary from the old document can use this new scope ID.
        await previousPage.assertCurrent(connected);
        generation.stop.signal.throwIfAborted();
        page.signal.throwIfAborted();
        endPage(previous);
        await join(previous);
        await page.assertCurrent(page.signal);
        page.signal.throwIfAborted();
        generation.stop.signal.throwIfAborted();
        connected.throwIfAborted();
        mount(generation, page);
        staged = undefined;
        await send({
          type: 'item',
          streamId: id,
          value: {
            type: 'switched',
            requestId: command.requestId,
            threadId: command.threadId,
            scopeId: page.scope.opened.scopeId,
            nativeSessionId: page.root.rootNativeSessionId,
          },
        });
      },
      previousPage,
    );
    // Wait only for publication. The stage operation itself stays owned until
    // its authorization is revoked or the next generation joins it.
    const generation = staged;
    handoff = generation.operation.catch(async (error: unknown) => {
      if (requestedClose || connected.aborted) return;
      if (
        error instanceof DEntryPageSwitchUnavailable &&
        staged === generation
      ) {
        staged = undefined;
        handoff = undefined;
        await decline();
      } else if (!generation.stop.signal.aborted) fail(error);
    });
    void handoff.catch(fail);
    // Publication marks completion below at the mount; handoff owns a
    // rejection listener until the generation itself terminates.
  }

  try {
    for await (const [message, binary] of on(peer, 'message', {
      signal: connected,
      close: ['close'],
      highWaterMark: 1,
      lowWaterMark: 1,
    })) {
      if (binary) throw denied();
      const frame = parseRemoteStreamClientMessage(String(message));
      if (
        !streamId &&
        frame.type === 'open' &&
        frame.endpoint === '$d-entry/page'
      ) {
        emptyPayload.parse(frame.payload);
        const id = (streamId = frame.streamId);
        current = begin(input.selection, async (generation, page) => {
          mount(generation, page);
          await send({
            type: 'item',
            streamId: id,
            value: {
              type: 'opened',
              scopeReference: { scopeId: page.scope.opened.scopeId },
              bindingRef: page.bindingRef,
            },
          });
        });
        void current.operation.catch((error) => {
          if (!requestedClose) fail(error);
        });
      } else if (frame.streamId !== streamId) {
        if (!current?.resources || requestedClose) throw denied();
        // The parent fences its old port before requesting the handoff.
        // Drop cancellation and other already queued frames during the cut.
        if (!staged) current.resources.accept(frame);
      } else if (
        frame.type === 'item' &&
        frame.value === 'close' &&
        !requestedClose
      ) {
        requestedClose = true;
        const reason = new DOMException('Page closed', 'AbortError');
        endPage(current, reason);
        endPage(staged, reason);
      } else if (frame.type === 'item' && !requestedClose) {
        await switchThread(
          DEntryPageSwitchSchema.parse(frame.value),
          frame.streamId,
        );
      } else if (frame.type === 'end') {
        if (!requestedClose) break;
        const scopeId = current?.page?.scope.opened.scopeId;
        try {
          const joins = await Promise.allSettled([join(staged), join(current)]);
          for (const result of joins)
            if (result.status === 'rejected') throw result.reason;
          connected.throwIfAborted();
          if (!scopeId) {
            await send({
              type: 'error',
              streamId: frame.streamId,
              error: {
                code: 'gateway/cancelled',
                message: 'Page closed during setup',
                details: {},
              },
            });
          } else if (!terminal) {
            await send({
              type: 'item',
              streamId: frame.streamId,
              value: { type: 'closed', scopeId },
            });
            await send({ type: 'end', streamId: frame.streamId });
          }
        } catch (error) {
          await notify(error);
        }
        break;
      } else if (frame.type === 'cancel') {
        break;
      } else {
        throw denied();
      }
    }
  } catch (error) {
    endPage(current, error);
    endPage(staged, error);
    await notify(error);
  } finally {
    endPage(current, connected.reason);
    endPage(staged, connected.reason);
    await Promise.allSettled([join(current), join(staged), handoff, terminal]);
  }
}

function pageStreams(page: DEntryPageHandle, send: Send, signal: AbortSignal) {
  const streams = new Map<string, { cancel(): void; work: Promise<void> }>();
  const scopeId = page.scope.opened.scopeId;
  const stop = new AbortController();
  const active = AbortSignal.any([signal, stop.signal]);
  function open(frame: Extract<Frame, { type: 'open' }>) {
    const controller = new AbortController();
    const child = AbortSignal.any([active, controller.signal]);
    const id = frame.streamId;
    const work = page.use(child, async () => {
      try {
        let call;
        let check = () => page.assertCurrent(child);
        if (frame.endpoint === '$events') {
          emptyPayload.parse(frame.payload);
          call = {
            kind: 'events' as const,
            scopeId,
            payload: REMOTE_EVENT_STREAM_PAYLOAD,
          };
        } else if (frame.endpoint === 'remoteAccess/follow') {
          const { args } = emptyPayload.parse(frame.payload);
          call = { scopeId, endpoint: 'remoteAccess/follow' as const, args };
        } else if (frame.endpoint === 'session/control') {
          const { args } = emptyPayload.parse(frame.payload);
          call = { scopeId, endpoint: 'session/control' as const, args };
        } else if (frame.endpoint === 'session/follow') {
          const authorize = () =>
            authorizeDEntryNativeInvocation(
              page.authorize,
              frame.endpoint,
              frame.payload,
              'mux',
              child,
            );
          const initial = await authorize();
          check = async () => {
            await page.assertCurrent(child);
            const next = await authorize();
            if (
              next.resource.bindingRef !== initial.resource.bindingRef ||
              next.resource.parentNativeSessionId !==
                initial.resource.parentNativeSessionId
            )
              throw denied();
          };
          // The literal branch and existing strict native invocation codec
          // establish this input's method/args pair before any guest dispatch.
          call = {
            scopeId,
            endpoint: 'session/follow' as const,
            args: initial.payload.args,
          } as Parameters<DEntryPageHandle['scope']['stream']>[0];
        } else {
          throw denied();
        }
        await check();
        for await (const item of page.scope.stream(call, child)) {
          if (item.scopeId !== scopeId || !isRemoteJsonValue(item.value))
            throw denied();
          if (frame.endpoint === 'remoteAccess/follow') {
            const { value } = item;
            const grants =
              value.type === 'baseline' && 'owner' in value && !value.owner
                ? value.grants
                : value.type === 'upsert' && 'grant' in value
                  ? [value.grant]
                  : undefined;
            if (!grants && value.type !== 'remove') throw denied();
            const sessionIds = grants?.map(({ resource }) => {
              if (resource.kind !== 'session') throw denied();
              return String(resource.id);
            });
            // A remove must still reach the client after the child has left
            // the catalogue. Only frames granting access require child proof.
            await page.assertCurrent(child, sessionIds);
          } else if (frame.endpoint === 'session/control') {
            const control = Native.methods['session/control'].result
              .create()
              .parse(item.value);
            if (control.type === 'baseline') {
              await page.assertCurrent(
                child,
                Object.keys(control.value.projections),
              );
            } else {
              try {
                await page.assertCurrent(child, [String(control.sessionId)]);
              } catch (error) {
                // A child can leave the catalog between guest filtering and
                // delivery. A failed page/root check also revokes the page.
                if (
                  error instanceof DataAccessError &&
                  error.code === 'not_found' &&
                  !page.signal.aborted &&
                  !child.aborted
                )
                  continue;
                throw error;
              }
            }
          } else await check();
          child.throwIfAborted();
          await send({ type: 'item', streamId: id, value: item.value });
        }
        child.throwIfAborted();
        await send({ type: 'end', streamId: id });
      } catch (error) {
        if (!child.aborted) {
          await send({
            type: 'error',
            streamId: id,
            error: pageRemoteFailure(error),
          });
        }
      } finally {
        streams.delete(id);
      }
    });
    streams.set(id, { cancel: () => controller.abort(), work });
    void work.catch((error) => stop.abort(error));
  }
  return {
    signal: active,
    accept(frame: Frame) {
      active.throwIfAborted();
      const prior = streams.get(frame.streamId);
      if (frame.type === 'open' && !prior) open(frame);
      else if (frame.type === 'cancel' || frame.type === 'end') prior?.cancel();
      else throw denied();
    },
    async close() {
      stop.abort();
      await Promise.allSettled([...streams.values()].map(({ work }) => work));
    },
  };
}

async function runStreams(
  page: DEntryPageHandle,
  peer: WebSocket,
  signal: AbortSignal,
) {
  const resources = pageStreams(page, sendTo(peer), signal);
  try {
    for await (const [message, binary] of on(peer, 'message', {
      signal: resources.signal,
      close: ['close'],
      highWaterMark: 1,
      lowWaterMark: 1,
    })) {
      if (binary) throw denied();
      resources.accept(parseRemoteStreamClientMessage(String(message)));
    }
  } finally {
    await resources.close();
  }
}

export function createDEntryPageMux(
  pages: ReturnType<typeof createDEntryPageRequests>,
  serviceSignal: AbortSignal,
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const lifetime = new AbortController();
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const matches = (request: IncomingMessage) =>
    request.url?.split('?')[0] === '/internal/d-entry/native-mux' &&
    new URL(request.url, 'http://worker.invalid').searchParams.has('carrier');
  return {
    matches,
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      const disconnected = new AbortController();
      const closed = new Promise<void>((resolve) =>
        socket.once('close', resolve),
      );
      const stop = (reason?: unknown) => disconnected.abort(reason);
      socket.once('close', stop);
      socket.on('error', stop);
      let peer: WebSocket | undefined;
      const connected = AbortSignal.any([
        lifetime.signal,
        serviceSignal,
        disconnected.signal,
      ]);
      const operation = Promise.resolve()
        .then(async () => {
          connected.throwIfAborted();
          if (
            request.method !== 'GET' ||
            request.headers.origin ||
            !matches(request)
          )
            throw denied();
          const { searchParams } = new URL(
            request.url!,
            'http://worker.invalid',
          );
          if (
            [...searchParams.keys()].some(
              (key) => searchParams.getAll(key).length !== 1,
            )
          )
            throw new SyntaxError('Entry selectors must be unique');
          const {
            organizationId,
            scopeId,
            workspaceId,
            employeeInstanceId,
            threadId,
          } = DEntryPageMuxQuerySchema.parse(Object.fromEntries(searchParams));
          const input = {
            organizationId,
            selection: {
              workspaceId,
              employeeInstanceId,
              ...(threadId && { threadId }),
            },
          };
          const token = dEntryBearer(request);
          const accept = async () => {
            connected.throwIfAborted();
            peer = await openPeer(wss, request, socket, head);
            peer.on('error', stop);
            return peer;
          };
          if (scopeId) {
            await pages.borrow(
              token,
              input,
              scopeId,
              connected,
              async (page, active) => {
                const childPeer = await accept();
                try {
                  await runStreams(page, childPeer, active);
                } finally {
                  if (!page.signal.aborted)
                    page.invalidate(new DEntryNativeUnavailable());
                }
              },
            );
          } else {
            await pages.authorizeUpgrade(token, input, connected);
            await runOwner(pages, token, input, await accept(), connected);
          }
        })
        .catch(async (error) => {
          if (!peer && !socket.destroyed) {
            await Promise.race([
              new Promise<void>((resolve) =>
                socket.end(
                  `HTTP/1.1 ${dEntryHttpProblem(error).status} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
                  resolve,
                ),
              ),
              closed,
            ]);
          }
        })
        .finally(async () => {
          if (peer?.readyState === WebSocket.OPEN && !connected.aborted)
            peer.close();
          else socket.destroy();
          await closed;
          socket.off('error', stop);
        });
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    },
    close() {
      if (closing) return closing;
      lifetime.abort();
      closing = (async () => {
        for (const client of wss.clients) client.terminate();
        await Promise.allSettled([...pending]);
        await new Promise<void>((resolve, reject) =>
          wss.close((error) => (error ? reject(error) : resolve())),
        );
      })();
      return closing;
    },
  };
}
