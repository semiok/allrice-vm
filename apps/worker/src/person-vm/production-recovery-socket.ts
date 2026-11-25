import { chmod, mkdtemp, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestContext } from '@allrice/contracts';
import type { authenticateSession } from '@allrice/database';

export async function openProductionRecoverySocket(input: {
  authenticate: typeof authenticateSession;
  recover(context: RequestContext, signal: AbortSignal): Promise<number>;
  pending(): boolean;
}) {
  // Binding under a 0700 directory prevents access by another local UID,
  // including while the socket itself is being created.
  // Keep the path short enough for Unix sockets on Darwin.
  const directory = await mkdtemp(join(tmpdir(), 'ar-recovery-'));
  const path = join(directory, 'owner');
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/recover' ||
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
    void (async () => {
      const context = token ? await input.authenticate(token) : null;
      if (!context) {
        response.writeHead(401, { connection: 'close' }).end();
        return;
      }
      disconnected.signal.throwIfAborted();
      const released = await input.recover(context, disconnected.signal);
      if (!response.destroyed)
        response
          .writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            connection: 'close',
          })
          .end(JSON.stringify({ released }));
    })()
      .catch(() => {
        if (!response.destroyed)
          response.writeHead(409, { connection: 'close' }).end();
      })
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
