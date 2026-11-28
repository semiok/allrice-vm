import { randomUUID } from 'node:crypto';
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
  DEntryPageRpcRequestSchema,
  DEntryPageUnarySchema,
  DEntryPageSwitchSchema,
  sameDEntryIdentity,
  type DEntrySelectionInput,
} from '@allrice/contracts';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import {
  D_ENTRY_PAGE_UPLINK_BYTES,
  type DEntryPageInput,
} from '@allrice/d-entry-principal/types';
import { DataAccessError } from '@allrice/database';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import { dEntryBearer, dEntryHttpProblem } from './http.js';
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
const pageOpenPayload = z.strictObject({
  args: z.strictObject({ reuseEmployee: z.literal(true).optional() }),
});
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

// These are employee-wide read streams in the existing rc.2 page profile.
// Session follow and every other stream stay with the currently issued page.
const employeeStreams = new Set([
  '$events',
  'remoteAccess/follow',
  'session/control',
  'workspace/follow',
]);

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
  let publishedScopeId: string | undefined;
  let current: OwnedPage | undefined;
  let staged: OwnedPage | undefined;
  let transport: OwnedPage | undefined;
  let shared: ReturnType<typeof pageStreams> | undefined;
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
    borrowable = true,
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
        (requestId, threadId) => {
          if (current !== generation || !streamId || requestedClose) return;
          void Promise.resolve()
            .then(() =>
              switchThread(
                { type: 'switch', requestId, threadId },
                streamId!,
                true,
              ),
            )
            .catch(fail);
        },
        borrowable,
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
    if (scope.status === 'rejected') {
      const intentional =
        (generation.setup.signal.aborted &&
          scope.reason === generation.setup.signal.reason) ||
        (generation.stop.signal.aborted &&
          scope.reason === generation.stop.signal.reason);
      if (!intentional) throw scope.reason;
    }
  }

  function mount(generation: OwnedPage, page: DEntryPageHandle) {
    generation.resources = pageStreams(
      page,
      send,
      AbortSignal.any([connected, generation.stop.signal, page.signal]),
      Boolean(shared),
    );
    current = generation;
  }

  function switchThread(
    command: ReturnType<typeof DEntryPageSwitchSchema.parse>,
    id: string,
    direct = false,
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
    const reserved = previousPage.reserveThreadSwitch(
      command.requestId,
      command.threadId,
      direct,
    );
    if (!reserved) return decline();
    staged = begin(
      { ...input.selection, threadId: command.threadId },
      async (generation, page) => {
        const root = page.root;
        if (!root) throw denied();
        // A normal handoff must not abort a native create/fork after dispatch.
        await reserved.drained;
        // New authority is watching before the old registration is fenced.
        // No stream or unary from the old document can use this new scope ID.
        await previousPage.assertCurrent(
          AbortSignal.any([connected, generation.stop.signal]),
        );
        generation.stop.signal.throwIfAborted();
        page.signal.throwIfAborted();
        const retiring = shared ? (previous.resources?.openIds() ?? []) : [];
        endPage(previous);
        await join(previous);
        generation.stop.signal.throwIfAborted();
        await page.assertCurrent(page.signal);
        page.signal.throwIfAborted();
        generation.stop.signal.throwIfAborted();
        connected.throwIfAborted();
        mount(generation, page);
        staged = undefined;
        for (const streamId of retiring) await send({ type: 'end', streamId });
        await send({
          type: 'item',
          streamId: id,
          value: {
            type: 'switched',
            requestId: command.requestId,
            threadId: command.threadId,
            scopeId: page.scope.opened.scopeId,
            nativeSessionId: root.rootNativeSessionId,
          },
        });
        publishedScopeId = page.scope.opened.scopeId;
      },
      previousPage,
    );
    // Wait only for publication. The stage operation itself stays owned until
    // its authorization is revoked or the next generation joins it.
    const generation = staged;
    handoff = generation.operation
      .catch(async (error: unknown) => {
        if (requestedClose || connected.aborted) return;
        if (
          error instanceof DEntryPageSwitchUnavailable &&
          staged === generation
        ) {
          staged = undefined;
          handoff = undefined;
          await decline();
        } else if (!generation.stop.signal.aborted) fail(error);
      })
      .finally(reserved.release);
    void handoff.catch(fail);
    // Publication marks completion below at the mount; handoff owns a
    // rejection listener until the generation itself terminates.
  }

  async function joinPages() {
    const generations = new Set([transport, current, staged]);
    const results = await Promise.allSettled([
      shared?.close(),
      ...[...generations].map(join),
    ]);
    for (const result of results)
      if (result.status === 'rejected') throw result.reason;
  }

  try {
    for await (const [message, binary] of on(peer, 'message', {
      signal: connected,
      close: ['close'],
      highWaterMark: 1,
      lowWaterMark: 1,
    })) {
      if (binary) throw denied();
      const decoded: unknown = JSON.parse(String(message));
      const pageScopeId =
        decoded && typeof decoded === 'object' && 'pageScopeId' in decoded
          ? decoded.pageScopeId
          : undefined;
      if (decoded && typeof decoded === 'object' && 'pageScopeId' in decoded)
        delete decoded.pageScopeId;
      const frame = parseRemoteStreamClientMessage(JSON.stringify(decoded));
      if (
        !streamId &&
        frame.type === 'open' &&
        frame.endpoint === '$d-entry/page'
      ) {
        const { args } = pageOpenPayload.parse(frame.payload);
        const id = (streamId = frame.streamId);
        const sharedPage = args.reuseEmployee
          ? new Promise<DEntryPageHandle>((resolve, reject) => {
              transport = begin(
                {
                  workspaceId: input.selection.workspaceId,
                  employeeInstanceId: input.selection.employeeInstanceId,
                },
                async (_generation, page) => {
                  resolve(page);
                },
                undefined,
                false,
              );
              void transport.operation.then(() => reject(denied()), reject);
            })
          : undefined;
        void sharedPage?.catch((error: unknown) => {
          if (!requestedClose) fail(error);
        });
        current = begin(input.selection, async (generation, page) => {
          if (sharedPage) {
            const employee = await sharedPage;
            if (
              !sameDEntryIdentity(employee.identity, {
                ...page.identity,
                threadId: null,
              }) ||
              employee.sessionId !== page.sessionId ||
              employee.bindingRef !== page.bindingRef
            )
              throw denied();
            employee.signal.throwIfAborted();
            shared = pageStreams(
              employee,
              send,
              AbortSignal.any([connected, employee.signal]),
            );
          }
          generation.stop.signal.throwIfAborted();
          page.signal.throwIfAborted();
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
          publishedScopeId = page.scope.opened.scopeId;
        });
        void current.operation.catch((error) => {
          if (!requestedClose) fail(error);
        });
      } else if (frame.streamId !== streamId) {
        if (!current?.resources || requestedClose) throw denied();
        const local = current.resources;
        const id = frame.streamId;
        const stable =
          shared &&
          (frame.type === 'open'
            ? employeeStreams.has(frame.endpoint)
            : shared.has(id));
        if (frame.type === 'open' && (local.has(id) || shared?.has(id)))
          throw denied();
        const resources = stable ? shared : local;
        const replaced =
          frame.type === 'open' &&
          !stable &&
          (pageScopeId !== undefined || Boolean(shared)) &&
          pageScopeId !== current.page?.scope.opened.scopeId;
        if (resources && !resources.signal.aborted && !replaced)
          resources.accept(frame);
        else if (frame.type === 'open')
          await send({
            type: 'error',
            streamId: id,
            error: {
              code: 'gateway/cancelled',
              message: 'Native session selection changed',
              details: {},
            },
          });
      } else if (
        frame.type === 'item' &&
        frame.value === 'close' &&
        !requestedClose
      ) {
        requestedClose = true;
        const reason = new DOMException('Page closed', 'AbortError');
        endPage(current, reason);
        endPage(staged, reason);
        endPage(transport, reason);
      } else if (frame.type === 'item' && !requestedClose) {
        await switchThread(
          DEntryPageSwitchSchema.parse(frame.value),
          frame.streamId,
        );
      } else if (frame.type === 'end') {
        if (!requestedClose) break;
        try {
          await joinPages();
          connected.throwIfAborted();
          const scopeId = publishedScopeId;
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
    endPage(transport, error);
    await notify(error);
  } finally {
    endPage(current, connected.reason);
    endPage(staged, connected.reason);
    endPage(transport, connected.reason);
    await Promise.allSettled([joinPages(), handoff, terminal]);
  }
}

function pageStreams(
  page: DEntryPageHandle,
  send: Send,
  signal: AbortSignal,
  exactRoot = false,
) {
  const streams = new Map<
    string,
    {
      cancel(): void;
      sendInput(input: DEntryPageInput): void;
      work: Promise<void>;
      isOpen(): boolean;
    }
  >();
  const scopeId = page.scope.opened.scopeId;
  const stop = new AbortController();
  const active = AbortSignal.any([signal, stop.signal]);
  function open(frame: Extract<Frame, { type: 'open' }>) {
    const controller = new AbortController();
    const child = AbortSignal.any([active, controller.signal]);
    const id = frame.streamId;
    let settled = false;
    let follow: Awaited<ReturnType<DEntryPageHandle['watchFollow']>>;
    let buffered = 0;
    let input = Promise.resolve();
    let inputError = Promise.resolve();

    function failInput(error: unknown) {
      if (settled || child.aborted) return;
      settled = true;
      controller.abort();
      inputError = page.assertCurrent(active).then(async () => {
        active.throwIfAborted();
        await send({
          type: 'error',
          streamId: id,
          error: pageRemoteFailure(error),
        });
      });
      void inputError.catch((error: unknown) => stop.abort(error));
    }
    const source = page.use(child, async (child) => {
      if (frame.endpoint === 'session/follow') {
        if (exactRoot) {
          const { request } = TYPERT_REMOTE.methods['session/follow']
            .input({ strict: true })
            .create()
            .parse(
              DEntryPageRpcRequestSchema.shape.payload.parse(frame.payload)
                .args,
            );
          const { address } = request;
          const id =
            address.kind === 'session'
              ? address.sessionId
              : address.childSessionId;
          await page.authorizeFollow(id, child);
        }
        follow = await page.watchFollow(child);
      }
      if (follow) {
        if (!page.scope.opened.followWithdrawals)
          throw new RemoteError(
            'remote-access/denied',
            'Native follow continuity unavailable',
            { action: 'session/follow', reason: 'continuity-unavailable' },
          );
        let pending;
        while ((pending = follow.pending())) await pending;
        follow.signal.throwIfAborted();
      } else await page.assertCurrent(child);
      child.throwIfAborted();
      if (frame.endpoint === '$events') {
        emptyPayload.parse(frame.payload);
        return page.scope.stream(
          { kind: 'events', scopeId, payload: REMOTE_EVENT_STREAM_PAYLOAD },
          child,
        );
      }
      const endpoint = DEntryPageUnarySchema.parse(frame.endpoint);
      const { args } = DEntryPageRpcRequestSchema.shape.payload.parse(
        frame.payload,
      );
      if (!isRemoteJsonValue(args)) throw denied();
      return page.scope.streamPage(
        {
          kind: 'page',
          scopeId,
          endpoint,
          args: args as Record<string, JsonValue>,
          ...(follow && { followId: randomUUID() }),
        },
        follow?.signal ?? child,
      );
    });
    const work = page
      .use(child, async (child) => {
        const stream = await source;
        for await (const item of stream) {
          if (item.scopeId !== scopeId || !isRemoteJsonValue(item.value))
            throw denied();
          if (follow) {
            let pending;
            while ((pending = follow.pending())) await pending;
            follow.signal.throwIfAborted();
          } else await page.assertCurrent(child);
          if ('revoked' in stream) stream.revoked?.throwIfAborted();
          child.throwIfAborted();
          await send({ type: 'item', streamId: id, value: item.value });
        }
        follow?.signal.throwIfAborted();
        if ('revoked' in stream) stream.revoked?.throwIfAborted();
        await page.assertCurrent(child);
        if (follow) {
          let pending;
          while ((pending = follow.pending())) await pending;
        }
        follow?.signal.throwIfAborted();
        if ('revoked' in stream) stream.revoked?.throwIfAborted();
        child.throwIfAborted();
        settled = true;
        await send({ type: 'end', streamId: id });
      })
      .catch(async (error) => {
        if (child.aborted) return;
        if (settled) throw error;
        try {
          await page.assertCurrent(child);
          child.throwIfAborted();
          settled = true;
          await send({
            type: 'error',
            streamId: id,
            error: pageRemoteFailure(error),
          });
        } catch (failure) {
          if (!child.aborted) throw failure;
        }
      })
      .finally(async () => {
        settled = true;
        controller.abort();
        await Promise.allSettled([input, inputError, follow?.close()]);
        streams.delete(id);
      });
    streams.set(id, {
      work,
      cancel: () => controller.abort(),
      isOpen: () => !settled && !child.aborted,
      sendInput(command) {
        if (settled || child.aborted) return;
        const bytes = Buffer.byteLength(JSON.stringify(command));
        if (buffered + bytes > D_ENTRY_PAGE_UPLINK_BYTES) {
          failInput(
            new RemoteError('gateway/uplink-overflow', 'Native input is full', {
              endpoint: frame.endpoint,
            }),
          );
          return;
        }
        buffered += bytes;
        input = input
          .then(async () => {
            if (settled || child.aborted) return;
            const stream = await source.catch(() => undefined);
            if (!stream || settled || child.aborted) return;
            if (!('send' in stream)) {
              if (command.type === 'input') throw denied();
              controller.abort();
              return;
            }
            await page.assertCurrent(child);
            if (!settled && !child.aborted) stream.send(command);
          })
          .catch(failInput)
          .finally(() => {
            buffered -= bytes;
          });
      },
    });
    void work.catch((error) => stop.abort(error));
  }
  async function close() {
    stop.abort();
    await Promise.allSettled([...streams.values()].map(({ work }) => work));
  }
  return {
    signal: active,
    has: (id: string) => streams.has(id),
    openIds: () =>
      [...streams].filter(([, entry]) => entry.isOpen()).map(([id]) => id),
    accept(frame: Frame) {
      active.throwIfAborted();
      const prior = streams.get(frame.streamId);
      if (frame.type === 'open') {
        if (prior) throw denied();
        open(frame);
      } else if (frame.type === 'cancel') {
        prior?.cancel();
      } else if (frame.type === 'end') {
        prior?.sendInput({ type: 'input-end' });
      } else {
        if (frame.value !== undefined && !isRemoteJsonValue(frame.value))
          throw denied();
        prior?.sendInput({
          type: 'input',
          value: frame.value as JsonValue | undefined,
        });
      }
    },
    close,
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
            warm,
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
          if (warm && (scopeId || !threadId)) throw denied();
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
            await pages.authorizeUpgrade(token, input, connected, warm === '1');
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
