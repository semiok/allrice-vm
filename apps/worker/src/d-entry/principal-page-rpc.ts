import { on } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEntryNativeOwnerRequestSchema,
  DEntryPageRpcRequestSchema,
  dEntryRegisteredThreadHeader,
} from '@allrice/contracts';
import type {
  DEntryPrincipalControlScope,
  DEntryPageNativeResult,
  DEntryScopedUnaryCall,
} from '@allrice/d-entry-principal/types';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import {
  DataAccessError,
  isDEntryNativeTitleRetryable,
  type DEntryPageForkSource,
} from '@allrice/database';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import { rpcIdSchema } from '@deepseek-ai/dsh-client-connection';
import {
  isRemoteJsonValue,
  RemoteError,
} from '@deepseek-ai/dsh-typert-protocol';
import {
  dEntryBearer,
  sendDEntryHttpProblem,
  type DEntryHttpDependencies,
} from './http.js';
import { createDEntryHttpReplies } from './http-replies.js';
import { authorizeDEntryNativeInvocation } from './native-invocation.js';
import { pageRemoteFailure } from './principal-profile-mux.js';
import type { createDEntryPageRequests } from './principal-requests.js';

const reply = (rpcId: string, result: object) => ({
  type: 'server-response',
  rpcId,
  result,
});

function encodeResult(
  rpcId: string,
  value: JsonValue | undefined,
  bytes: DEntryPageNativeResult['attachments'],
) {
  const body = reply(rpcId, { ok: true, value });
  if (!bytes.length) return Response.json(body);
  const parts = new FormData();
  const attachments = bytes.map(({ path, bytes }, index) => {
    const part = `bytes-${index}`;
    parts.set(part, new Blob([new Uint8Array(bytes)]));
    return { path, codec: 'bytes', part };
  });
  parts.set('metadata', JSON.stringify({ ...body, attachments }));
  return new Response(parts);
}

function encodeScopedResult(
  rpcId: string,
  result: Awaited<ReturnType<DEntryPrincipalControlScope['invoke']>>,
) {
  const attachments: DEntryPageNativeResult['attachments'][number][] = [];
  const codec = TYPERT_REMOTE.methods[result.endpoint].result;
  const value = codec.create().parse(result.value);
  const encoded = codec.encode
    ? codec.encode(value, (bytes, path) => {
        attachments.push({ path, bytes });
        return null;
      })
    : value;
  if (!isRemoteJsonValue(encoded))
    throw Error('PRINCIPAL_REMOTE_RESULT_INVALID');
  return encodeResult(rpcId, encoded as JsonValue, attachments);
}

const requestSchema = DEntryPageRpcRequestSchema.extend({
  organizationId: DEntryNativeOwnerRequestSchema.shape.organizationId,
});

async function readRequest(request: IncomingMessage, signal: AbortSignal) {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const [chunk] of on(request, 'data', {
      signal,
      close: ['end'],
      highWaterMark: 1,
      lowWaterMark: 1,
    })) {
      signal.throwIfAborted();
      length += chunk.length;
      // Same full HTTP body limit as the original rc.2 Connection bridge.
      if (length > 300 * 1024 * 1024)
        throw new SyntaxError('Invalid entry request');
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    // Discard any remaining body when input is rejected. An incomplete
    // pipelined request does not own the socket carrying its neighbor.
    if (!request.complete && !request.destroyed) request.resume();
  }
  signal.throwIfAborted();
  return requestSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString('utf8')),
  );
}

export function createDEntryPageRpc(
  pages: ReturnType<typeof createDEntryPageRequests>,
  authenticate: DEntryHttpDependencies['authenticate'],
  serviceSignal: AbortSignal,
) {
  const replies = createDEntryHttpReplies(serviceSignal);
  const path = '/internal/d-entry/native-rpc';
  return {
    handle(request: IncomingMessage, response: ServerResponse) {
      if (request.url?.split('?')[0] !== path || replies.signal.aborted)
        return Promise.resolve(false);
      const { searchParams } = new URL(request.url, 'http://worker.invalid');
      if (!searchParams.has('carrier')) return Promise.resolve(false);
      return replies.handle(request, response, async (signal, writeOwned) => {
        try {
          signal.throwIfAborted();
          if (request.method !== 'POST' || request.headers.origin)
            throw new DataAccessError('not_found');
          if (searchParams.size !== 1 || searchParams.get('carrier') !== 'page')
            throw new SyntaxError('Invalid page carrier');
          const token = dEntryBearer(request);
          if (!(await authenticate(token)))
            throw new DataAccessError('authentication_required');
          signal.throwIfAborted();
          const input = await readRequest(request, signal);
          const rpcId = rpcIdSchema.parse(input.rpcId);
          await pages.borrow(
            token,
            input,
            input.scopeId,
            signal,
            async (page, active) => {
              const { endpoint } = input;
              const invoke = async () => {
                const authorizeAttachment = () =>
                  authorizeDEntryNativeInvocation(
                    page.authorize,
                    endpoint,
                    input.payload,
                    'http',
                    active,
                  );
                const attachment =
                  endpoint === 'session/attachment'
                    ? await authorizeAttachment()
                    : undefined;
                let args = input.payload.args;
                let forkSource: DEntryPageForkSource | undefined;
                if (endpoint === 'session/create') {
                  const { request } = TYPERT_REMOTE.methods[endpoint]
                    .input({ strict: true })
                    .create()
                    .parse(args);
                  const { sessionId, ...create } = request;
                  // rc.2 will mint a missing client-supplied id. A locator may
                  // only be reused after confirming an existing owned Session.
                  args = {
                    request:
                      sessionId &&
                      (await page.canReuseNativeSession(sessionId, active))
                        ? request
                        : create,
                  };
                } else if (endpoint === 'session/fork') {
                  const { request } = TYPERT_REMOTE.methods[endpoint]
                    .input({ strict: true })
                    .create()
                    .parse(args);
                  forkSource = await page.authorizeForkSource(
                    request.sessionId,
                    active,
                  );
                }
                if (!isRemoteJsonValue(args))
                  throw new SyntaxError('Invalid entry request');
                await page.assertCurrent(active);
                let native: Response;
                let created: string | undefined;
                try {
                  if (attachment) {
                    const result = await page.scope.invoke(
                      {
                        scopeId: input.scopeId,
                        endpoint: attachment.endpoint,
                        args: attachment.payload.args,
                      } as DEntryScopedUnaryCall,
                      active,
                    );
                    native = encodeScopedResult(rpcId, result);
                  } else {
                    const call = {
                      kind: 'page' as const,
                      scopeId: input.scopeId,
                      endpoint,
                      args: args as Record<string, JsonValue>,
                    };
                    const result =
                      endpoint === 'terminal/create' ||
                      endpoint === 'terminal/close'
                        ? await page.invokeTerminal(call, active)
                        : await page.scope.invokePage(call, active);
                    if (
                      endpoint === 'session/create' ||
                      endpoint === 'session/fork'
                    ) {
                      created = TYPERT_REMOTE.methods[endpoint].result
                        .create()
                        .parse(result.value).sessionId;
                    }
                    if (endpoint === 'session/rename') {
                      // The native journal already owns the rename. Join the
                      // directory projection even if no control stream is open.
                      const {
                        request: { sessionId },
                      } = TYPERT_REMOTE.methods[endpoint]
                        .input({ strict: true })
                        .create()
                        .parse(args);
                      await page
                        .syncNativeTitle(sessionId, active)
                        .catch((error: unknown) => {
                          if (!active.aborted) {
                            if (isDEntryNativeTitleRetryable(error))
                              page.requestNativeTitle(sessionId);
                            else
                              console.error(
                                '[d-entry] native session title projection failed',
                              );
                          }
                        });
                    }
                    native = encodeResult(
                      rpcId,
                      result.value,
                      result.attachments,
                    );
                  }
                } catch (error) {
                  const failure = pageRemoteFailure(error);
                  if (
                    !(error instanceof RemoteError) &&
                    failure.message === 'PRINCIPAL_JOIN_UNKNOWN'
                  )
                    throw error;
                  native = Response.json(
                    reply(rpcId, { ok: false, error: failure }),
                  );
                }
                const registeredThread = created
                  ? await page.registerNativeSession(
                      created,
                      forkSource,
                      active,
                    )
                  : undefined;
                const bytes = Buffer.from(await native.arrayBuffer());
                await writeOwned(
                  active,
                  () =>
                    response
                      .writeHead(native.status, {
                        'content-type': native.headers.get('content-type')!,
                        'content-length': String(bytes.length),
                        'cache-control': 'private, no-store',
                        ...(registeredThread && {
                          [dEntryRegisteredThreadHeader]: encodeURIComponent(
                            JSON.stringify(registeredThread),
                          ),
                        }),
                      })
                      .end(bytes),
                  async () => {
                    await page.assertCurrent(active);
                    if (!attachment) return;
                    const next = await authorizeAttachment();
                    if (
                      next?.resource.bindingRef !==
                        attachment.resource.bindingRef ||
                      next.resource.parentNativeSessionId !==
                        attachment.resource.parentNativeSessionId
                    )
                      throw new DataAccessError('authorization_denied');
                  },
                );
              };
              if (
                endpoint === 'session/create' ||
                endpoint === 'session/fork' ||
                endpoint === 'session/rename'
              )
                await page.runThreadWrite(invoke);
              else await invoke();
            },
            async (error, active) => {
              await writeOwned(active, () =>
                sendDEntryHttpProblem(response, error),
              );
            },
          );
        } catch (error) {
          await writeOwned(signal, () =>
            sendDEntryHttpProblem(response, error),
          );
        }
        return true;
      });
    },
    close: replies.close,
  };
}
