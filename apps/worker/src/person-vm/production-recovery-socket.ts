import { chmod, mkdtemp, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestContext } from '@allrice/contracts';
import type { authenticateSession } from '@allrice/database';

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
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const recovery = request.method === 'POST' && request.url === '/recover';
    const shutdown =
      request.method === 'GET' && request.url === '/shutdown-status'
        ? input.shutdown
        : undefined;
    if (
      (!recovery && !shutdown) ||
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
    void (async () => {
      const context = token
        ? await (shutdown
            ? shutdown.authenticate(token)
            : input.authenticate(token))
        : null;
      if (!context) {
        writeStatus(401);
        return;
      }
      disconnected.signal.throwIfAborted();
      if (shutdown) {
        await shutdown.authorize(context);
        disconnected.signal.throwIfAborted();
        const current = shutdown.status();
        writeStatus(current ? 200 : 404, current);
      } else {
        const released = await input.recover(context, disconnected.signal);
        writeStatus(200, { released });
      }
    })()
      .catch(() => writeStatus(shutdown ? 403 : 409))
      .finally(() => {
        if (!input.pending()) void close().catch(() => {});
      });
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
    }).then(() => rmdir(directory)));
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
