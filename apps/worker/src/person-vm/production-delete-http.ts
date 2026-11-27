import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { UuidSchema, type RequestContext } from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import {
  PersonVmError,
  type PlatformVmDeletionRequest,
  type PlatformVmDeletionResult,
} from '@allrice/person-vm';

const route = '/internal/platform/person-vm-delete';
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const maxBodyBytes = 2048;
const body = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('review'), personId: UuidSchema }),
  z.strictObject({
    action: z.literal('retain-disk'),
    personId: UuidSchema,
    vmId: UuidSchema,
    leaseEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    action: z.literal('purge-disk'),
    personId: UuidSchema,
    vmId: UuidSchema,
    confirmationId: UuidSchema,
  }),
]);

export function createProductionPersonVmDeleteHttp(input: {
  authenticate(token: string): Promise<RequestContext | null>;
  execute(
    context: RequestContext,
    request: PlatformVmDeletionRequest,
    signal: AbortSignal,
  ): Promise<PlatformVmDeletionResult>;
  lifetime: AbortSignal;
}) {
  const pending = new Set<Promise<void>>();
  return {
    close: () => Promise.allSettled([...pending]),
    async handle(
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<boolean> {
      if (request.url !== route) return false;
      const send = (status: number, result: unknown) => {
        if (response.destroyed) return;
        response
          .writeHead(status, {
            'cache-control': 'no-store',
            'content-type': 'application/json',
            connection: 'close',
          })
          .end(JSON.stringify(result));
      };
      if (
        request.method !== 'POST' ||
        !loopback.has(request.socket.remoteAddress ?? '') ||
        request.headers.origin !== undefined
      ) {
        send(404, { error: 'not_found' });
        return true;
      }
      if (input.lifetime.aborted) {
        send(503, { error: 'RUNTIME_NOT_READY' });
        return true;
      }
      const token =
        request.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
      if (!token) {
        send(401, { error: 'authentication_required' });
        return true;
      }
      const disconnected = new AbortController();
      response.once('close', () => disconnected.abort());
      const signal = AbortSignal.any([disconnected.signal, input.lifetime]);
      const stopReading = () => {
        if (!request.complete) request.destroy();
      };
      signal.addEventListener('abort', stopReading, { once: true });
      const work = (async () => {
        const context = await input.authenticate(token);
        signal.throwIfAborted();
        if (!context) {
          send(403, { error: 'authorization_denied' });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request.iterator({
          destroyOnReturn: false,
        })) {
          signal.throwIfAborted();
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > maxBodyBytes) {
            send(413, { error: 'request_too_large' });
            return;
          }
          chunks.push(bytes);
        }
        let value: PlatformVmDeletionRequest;
        try {
          value = body.parse(
            JSON.parse(Buffer.concat(chunks).toString('utf8')),
          );
        } catch {
          send(400, { error: 'invalid_request' });
          return;
        }
        send(200, await input.execute(context, value, signal));
      })().catch((error: unknown) => {
        if (error instanceof DataAccessError) {
          send(403, { error: 'authorization_denied' });
          return;
        }
        const code =
          error instanceof PersonVmError ? error.code : 'PROVIDER_FAILED';
        const status =
          code === 'AUTHORIZATION_DENIED' ||
          code === 'DISK_DELETE_NOT_AUTHORIZED'
            ? 403
            : code === 'NOT_FOUND'
              ? 404
              : code === 'RUNTIME_NOT_READY' || code === 'PROVIDER_FAILED'
                ? 503
                : 409;
        send(status, { error: code });
      });
      pending.add(work);
      try {
        await work;
      } finally {
        signal.removeEventListener('abort', stopReading);
        pending.delete(work);
      }
      return true;
    },
  };
}
