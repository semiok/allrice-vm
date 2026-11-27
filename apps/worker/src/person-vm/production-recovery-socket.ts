import { chmod, mkdtemp, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestContext } from '@allrice/contracts';
import type { authenticateSession } from '@allrice/database';
import { PersonVmError } from '@allrice/person-vm';

export type ProductionShutdownStatus = Readonly<{
  bootId: string;
  pid: number;
  attemptId: string;
}> &
  (
    | Readonly<{ state: 'checking' | 'draining' }>
    | Readonly<{ state: 'deferred' | 'drain-failed'; reason: string }>
  );

export async function openProductionRecoverySocket(input: {
  authenticate: typeof authenticateSession;
  recover(context: RequestContext, signal: AbortSignal): Promise<number>;
  pending(): boolean;
  upgrade?: {
    bootId: string;
    authenticate(token: string): Promise<RequestContext | null>;
    drain(
      context: RequestContext,
      signal: AbortSignal,
    ): Promise<Readonly<{ stopped: number; expiresAt: string }>>;
    claimShutdown?(
      context: RequestContext,
      expiresAt: string,
      signal: AbortSignal,
    ): Promise<() => void>;
  };
  shutdown?: {
    authenticate(token: string): Promise<RequestContext | null>;
    authorize(context: RequestContext): Promise<unknown>;
    status(): ProductionShutdownStatus | undefined;
  };
}) {
  // Binding under a 0700 directory prevents access by another local UID,
  // including while the socket itself is being created.
  // Keep the path short enough for Unix sockets on Darwin.
  const directory = await mkdtemp(join(tmpdir(), 'ar-recovery-'));
  const path = join(directory, 'owner');
  const requests = new Set<Promise<void>>();
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const recovery = request.method === 'POST' && request.url === '/recover';
    const claim = request.url === '/shutdown-after-drain';
    const upgrade =
      request.method === 'POST' &&
      (request.url === '/drain-for-upgrade' ||
        (claim && input.upgrade?.claimShutdown))
        ? input.upgrade
        : undefined;
    const shutdown =
      request.method === 'GET' && request.url === '/shutdown-status'
        ? input.shutdown
        : undefined;
    if (
      (!recovery && !shutdown && !upgrade) ||
      request.headers.origin ||
      request.headers['transfer-encoding'] ||
      (request.headers['content-length'] ?? '0') !== '0'
    ) {
      response.writeHead(404, { connection: 'close' }).end();
      return;
    }
    const token =
      request.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
    const disconnected = new AbortController();
    response.once('close', () => disconnected.abort());
    function writeStatus(status: number, value?: object) {
      if (response.destroyed) return;
      response
        .writeHead(status, {
          'cache-control': 'no-store',
          connection: 'close',
          ...(value && { 'content-type': 'application/json' }),
        })
        .end(value && JSON.stringify(value));
    }
    const work = (async () => {
      const context = token
        ? await ((shutdown ?? upgrade)?.authenticate(token) ??
            input.authenticate(token))
        : null;
      if (!context) {
        writeStatus(401);
        return;
      }
      disconnected.signal.throwIfAborted();
      if (upgrade) {
        if (request.headers['x-allrice-worker-boot'] !== upgrade.bootId) {
          writeStatus(409, { code: 'WORKER_BOOT_MISMATCH' });
          return;
        }
        try {
          if (claim) {
            const expected = request.headers['x-allrice-drain-expires'];
            if (typeof expected !== 'string' || !upgrade.claimShutdown) {
              writeStatus(400);
              return;
            }
            const shutdown = await upgrade.claimShutdown(
              context,
              expected,
              disconnected.signal,
            );
            // Once the Host consumes the handoff, this connection no longer
            // owns completion. A disconnect still retires the same Worker.
            const depart = () => {
              response.off('finish', depart);
              response.off('close', depart);
              setImmediate(shutdown);
            };
            if (response.destroyed) depart();
            else {
              response.once('finish', depart);
              response.once('close', depart);
            }
            writeStatus(202);
            return;
          }
          const drained = await upgrade.drain(context, disconnected.signal);
          writeStatus(200, { ...drained, bootId: upgrade.bootId });
        } catch (error) {
          const code =
            error instanceof PersonVmError ? error.code : 'DRAIN_UNCONFIRMED';
          console.warn('[MET-273] upgrade drain declined', {
            requestId: context.requestId,
            code,
          });
          writeStatus(409, { requestId: context.requestId, code });
        }
      } else if (shutdown) {
        await shutdown.authorize(context);
        disconnected.signal.throwIfAborted();
        const current = shutdown.status();
        writeStatus(current ? 200 : 404, current);
      } else {
        const released = await input.recover(context, disconnected.signal);
        writeStatus(200, { released });
      }
    })().catch(() => writeStatus(shutdown ? 403 : 409));
    requests.add(work);
    function settled() {
      requests.delete(work);
      if (!input.pending()) void close().catch(() => {});
    }
    void work.then(settled, settled);
  });
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  let closing: Promise<void> | undefined;
  function close() {
    return (closing ??= new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error && server.listening) reject(error);
        else resolve();
      });
    }).then(async () => {
      // A disconnected client can release its socket while authentication or
      // recovery still owns database work. The pool must outlive both.
      await Promise.allSettled([...requests]);
      await rmdir(directory);
    }));
  }
  try {
    await chmod(directory, 0o700);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await close();
    throw error;
  }
  return { path, close };
}
