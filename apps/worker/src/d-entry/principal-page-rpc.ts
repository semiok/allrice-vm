import { on } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEntryNativeOwnerRequestSchema,
  DEntryPageLocaleSchema,
  DEntryPageRpcRequestSchema,
} from '@allrice/contracts';
import type {
  DEntryPrincipalControlScope,
  DEntryScopedUnaryCall,
  NativeUnary,
} from '@allrice/d-entry-principal/types';
import { DataAccessError } from '@allrice/database';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import { rpcIdSchema } from '@deepseek-ai/dsh-client-connection';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
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
  result: Awaited<ReturnType<DEntryPrincipalControlScope['invoke']>>,
) {
  if (DEntryPageLocaleSchema.safeParse(result.endpoint).success) {
    if (!isRemoteJsonValue(result.value))
      throw Error('PRINCIPAL_REMOTE_RESULT_INVALID');
    return Response.json(reply(rpcId, { ok: true, value: result.value }));
  }
  const parts = new FormData();
  const attachments: {
    path: readonly (string | number)[];
    codec: 'bytes';
    part: string;
  }[] = [];
  const codec = TYPERT_REMOTE.methods[result.endpoint as NativeUnary].result;
  const value = codec.create().parse(result.value);
  const encoded = codec.encode
    ? codec.encode(value, (bytes, path) => {
        const part = `bytes-${attachments.length}`;
        parts.set(part, new Blob([new Uint8Array(bytes)]));
        attachments.push({ path, codec: 'bytes', part });
        return null;
      })
    : value;
  if (!isRemoteJsonValue(encoded))
    throw Error('PRINCIPAL_REMOTE_RESULT_INVALID');
  const body = reply(rpcId, { ok: true, value: encoded });
  if (!attachments.length) return Response.json(body);
  parts.set('metadata', JSON.stringify({ ...body, attachments }));
  return new Response(parts);
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
              const locale = DEntryPageLocaleSchema.safeParse(input.endpoint);
              if (locale.success && !isRemoteJsonValue(input.payload.args))
                throw new SyntaxError('Invalid native language request');
              const authorize = async () =>
                locale.success || input.endpoint === 'session/list'
                  ? undefined
                  : authorizeDEntryNativeInvocation(
                      page.authorize,
                      input.endpoint,
                      input.payload,
                      'http',
                      active,
                    );
              const invocation = await authorize();
              const call: DEntryScopedUnaryCall = locale.success
                ? {
                    scopeId: input.scopeId,
                    endpoint: locale.data,
                    args: input.payload.args as Record<string, JsonValue>,
                  }
                : invocation
                  ? ({
                      scopeId: input.scopeId,
                      endpoint: invocation.endpoint,
                      args: invocation.payload.args,
                    } as DEntryScopedUnaryCall) // Exact unary selector and its generated input codec above.
                  : {
                      scopeId: input.scopeId,
                      endpoint: 'session/list',
                      args: TYPERT_REMOTE.methods['session/list']
                        .input({ strict: true })
                        .create()
                        .parse(input.payload.args),
                    };
              let native: Response;
              let sessionIds: string[] | undefined;
              try {
                const result = await page.scope.invoke(call, active);
                if (result.endpoint === 'session/list')
                  sessionIds = result.value.items.map((row) =>
                    String(row.sessionId),
                  );
                native = encodeResult(rpcId, result);
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
              const bytes = Buffer.from(await native.arrayBuffer());
              await writeOwned(
                active,
                () =>
                  response
                    .writeHead(native.status, {
                      'content-type': native.headers.get('content-type')!,
                      'content-length': String(bytes.length),
                      'cache-control': 'private, no-store',
                    })
                    .end(bytes),
                async () => {
                  await page.assertCurrent(active, sessionIds);
                  if (!invocation) return;
                  const next = await authorize();
                  if (
                    next?.resource.bindingRef !==
                      invocation.resource.bindingRef ||
                    next.resource.parentNativeSessionId !==
                      invocation.resource.parentNativeSessionId
                  )
                    throw new DataAccessError('authorization_denied');
                },
              );
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
