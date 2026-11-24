import { finished } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEntryNativeOwnerRequestSchema,
  DEntryPageRpcRequestSchema,
} from '@allrice/contracts';
import type { DEntryScopedUnaryCall } from '@allrice/d-entry-principal/types';
import { DataAccessError } from '@allrice/database';
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
  result: Awaited<
    ReturnType<
      import('@allrice/d-entry-principal/types').DEntryPrincipalControlScope['invoke']
    >
  >,
) {
  const parts = new FormData();
  const attachments: {
    path: readonly (string | number)[];
    codec: 'bytes';
    part: string;
  }[] = [];
  const codec = TYPERT_REMOTE.methods[result.endpoint].result;
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
  for await (const chunk of request) {
    signal.throwIfAborted();
    length += chunk.length;
    // Same full HTTP body limit as the original rc.2 Connection bridge.
    if (length > 300 * 1024 * 1024)
      throw new SyntaxError('Invalid entry request');
    chunks.push(Buffer.from(chunk));
  }
  return requestSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString('utf8')),
  );
}

export function createDEntryPageRpc(
  pages: ReturnType<typeof createDEntryPageRequests>,
  authenticate: DEntryHttpDependencies['authenticate'],
  serviceSignal: AbortSignal,
) {
  const running = new Set<Promise<boolean>>();
  const path = '/internal/d-entry/native-rpc';
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  return {
    handle(request: IncomingMessage, response: ServerResponse) {
      if (request.url?.split('?')[0] !== path) return Promise.resolve(false);
      const { searchParams } = new URL(request.url, 'http://worker.invalid');
      if (!searchParams.has('carrier')) return Promise.resolve(false);
      const operation = Promise.resolve().then(async () => {
        const abort = new AbortController();
        const disconnected = () => abort.abort();
        response.once('close', disconnected);
        const signal = AbortSignal.any([
          lifetime.signal,
          serviceSignal,
          abort.signal,
        ]);
        const stopRead = () => {
          if (!request.complete) request.destroy();
        };
        signal.addEventListener('abort', stopRead, { once: true });
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
              const authorize = () =>
                authorizeDEntryNativeInvocation(
                  page.authorize,
                  input.endpoint,
                  input.payload,
                  'http',
                  active,
                );
              const invocation = await authorize();
              const call = {
                scopeId: input.scopeId,
                endpoint: invocation.endpoint,
                args: invocation.payload.args,
              } as DEntryScopedUnaryCall; // Exact unary selector and its generated input codec above.
              let native: Response;
              try {
                native = encodeResult(
                  rpcId,
                  await page.scope.invoke(call, active),
                );
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
              await page.assertCurrent(active);
              const next = await authorize();
              if (
                next.resource.bindingRef !== invocation.resource.bindingRef ||
                next.resource.parentNativeSessionId !==
                  invocation.resource.parentNativeSessionId
              )
                throw new DataAccessError('authorization_denied');
              active.throwIfAborted();
              response.writeHead(native.status, {
                'content-type': native.headers.get('content-type')!,
                'cache-control': 'private, no-store',
              });
              response.end(bytes);
              await finished(response, { signal: active, cleanup: true });
            },
          );
        } catch (error) {
          sendDEntryHttpProblem(response, error);
        } finally {
          response.off('close', disconnected);
          signal.removeEventListener('abort', stopRead);
        }
        return true;
      });
      running.add(operation);
      void operation.then(
        () => running.delete(operation),
        () => running.delete(operation),
      );
      return operation;
    },
    close() {
      if (closing) return closing;
      lifetime.abort();
      return (closing = Promise.allSettled([...running]).then(() => {}));
    },
  };
}
