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
} from '@allrice/contracts';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import {
  D_ENTRY_PAGE_UPLINK_BYTES,
  type DEntryPageInput,
} from '@allrice/d-entry-principal/types';
import { DataAccessError } from '@allrice/database';
import { dEntryBearer, dEntryHttpProblem } from './http.js';
import {
  DEntryNativeRootRejected,
  DEntryNativeUnavailable,
} from './native-owner.js';
import {
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

async function runOwner(
  pages: ReturnType<typeof createDEntryPageRequests>,
  token: string,
  input: {
    organizationId: string;
    selection: {
      workspaceId: string;
      employeeInstanceId: string;
      threadId?: string;
    };
  },
  peer: WebSocket,
  connected: AbortSignal,
) {
  const setup = new AbortController(),
    stop = new AbortController();
  const signal = AbortSignal.any([connected, setup.signal]);
  const send = sendTo(peer);
  let streamId: string | undefined;
  let scopeId: string | undefined;
  let operation: Promise<void> | undefined;
  let terminal: Promise<void> | undefined;
  let requestedClose = false,
    uplinkEnded = false;
  const notify = (error: unknown) => {
    if (!streamId || terminal || connected.aborted) return;
    terminal = send({
      type: 'error',
      streamId,
      error: pageRemoteFailure(error),
    });
    return terminal;
  };
  function endPage(reason: unknown) {
    stop.abort(reason);
    if (!scopeId) setup.abort(reason);
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
        operation = pages.own(
          token,
          input,
          signal,
          stop.signal,
          async (page) => {
            stop.signal.throwIfAborted();
            scopeId = page.scope.opened.scopeId;
            await send({
              type: 'item',
              streamId: id,
              value: {
                type: 'opened',
                scopeReference: { scopeId },
                bindingRef: page.bindingRef,
              },
            });
          },
          (error) => {
            void notify(error)
              ?.finally(() => peer.close())
              .catch(() => peer.terminate());
          },
        );
        void operation.catch((error) => {
          if (!requestedClose) {
            void notify(error)
              ?.finally(() => peer.close())
              .catch(() => peer.terminate());
          }
        });
      } else if (frame.streamId !== streamId) {
        throw denied();
      } else if (
        frame.type === 'item' &&
        frame.value === 'close' &&
        !requestedClose &&
        !uplinkEnded
      ) {
        requestedClose = true;
        endPage(new DOMException('Page closed', 'AbortError'));
      } else if (frame.type === 'end' && !uplinkEnded) {
        uplinkEnded = true;
        if (!requestedClose) {
          endPage(new DOMException('Page abandoned', 'AbortError'));
          break;
        }
        try {
          await operation;
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
          if (
            signal.aborted &&
            requestedClose &&
            !scopeId &&
            error === signal.reason &&
            !connected.aborted
          )
            await send({
              type: 'error',
              streamId: frame.streamId,
              error: {
                code: 'gateway/cancelled',
                message: 'Page closed during setup',
                details: {},
              },
            });
          else await notify(error);
        }
        break;
      } else if (frame.type === 'cancel') {
        endPage(new DOMException('Page abandoned', 'AbortError'));
        break;
      } else {
        throw denied();
      }
    }
  } catch (error) {
    endPage(error);
    await notify(error);
  } finally {
    endPage(connected.reason);
    await Promise.allSettled([operation, terminal]);
  }
}

async function runStreams(
  page: DEntryPageHandle,
  peer: WebSocket,
  signal: AbortSignal,
) {
  const send = sendTo(peer);
  const streams = new Map<
    string,
    {
      cancel(): void;
      sendInput(input: DEntryPageInput): void;
      work: Promise<void>;
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
    const source = (async () => {
      await page.assertCurrent(child);
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
        },
        child,
      );
    })();
    const work = source
      .then(async (stream) => {
        for await (const item of stream) {
          if (item.scopeId !== scopeId || !isRemoteJsonValue(item.value))
            throw denied();
          await page.assertCurrent(child);
          child.throwIfAborted();
          await send({ type: 'item', streamId: id, value: item.value });
        }
        await page.assertCurrent(child);
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
        await Promise.allSettled([input, inputError]);
        streams.delete(id);
      });
    streams.set(id, {
      work,
      cancel: () => controller.abort(),
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
  try {
    for await (const [message, binary] of on(peer, 'message', {
      signal: active,
      close: ['close'],
      highWaterMark: 1,
      lowWaterMark: 1,
    })) {
      if (binary) throw denied();
      const frame = parseRemoteStreamClientMessage(String(message));
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
    }
  } finally {
    stop.abort();
    await Promise.allSettled([...streams.values()].map(({ work }) => work));
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
