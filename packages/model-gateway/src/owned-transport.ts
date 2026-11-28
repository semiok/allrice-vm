import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { Agent, buildConnector, errors } from 'undici';
import { ModelGatewayError, type GatewayProvider } from './contract.ts';

/** Dedicated pool for the exact host. Track the underlying TCP socket
 * from creation, including before Undici has established a TLS context. */
export function createOwnedModelTransport(ownerId: string) {
  const sockets = new Map<Socket, Promise<void>>();
  const establishTls = buildConnector({ allowH2: false, timeout: 0 });
  let closing: Promise<void> | undefined;
  const dispatcher = new Agent({
    allowH2: false,
    connect(options, callback) {
      if (closing) {
        callback(new ModelGatewayError('ADMISSION_CLOSED'), null);
        return;
      }
      const secure = options.protocol === 'https:';
      const socket = connect({
        host: options.hostname,
        port: Number(options.port || (secure ? 443 : 80)),
        localAddress: options.localAddress ?? undefined,
      });
      let pending: typeof callback | undefined = callback;
      const timer = setTimeout(
        () => socket.destroy(new errors.ConnectTimeoutError()),
        10_000,
      ).unref();
      function settle(...result: Parameters<typeof callback>) {
        clearTimeout(timer);
        const complete = pending;
        pending = undefined;
        if (complete) complete(...result);
        else result[1]?.destroy();
      }
      socket.on('error', (error) => settle(error, null));
      sockets.set(
        socket,
        new Promise<void>((resolve) => {
          socket.once('close', () => {
            sockets.delete(socket);
            resolve();
            settle(new ModelGatewayError('ADMISSION_CLOSED'), null);
          });
        }),
      );
      socket.once('connect', () => {
        if (closing) {
          socket.destroy();
          return;
        }
        if (!secure) {
          socket.setNoDelay(true).setKeepAlive(true, 60_000);
          settle(null, socket);
          return;
        }
        // Node may replace the TCP handle during address fallback. Wrap only
        // the winning connection, with Undici's original TLS validation/cache.
        try {
          establishTls({ ...options, httpSocket: socket }, settle);
        } catch (error) {
          socket.destroy();
          settle(
            error instanceof Error ? error : new Error('TLS setup failed'),
            null,
          );
        }
      });
    },
  });
  let evidence: string | undefined;
  const fetchOwned: NonNullable<GatewayProvider['fetchOwned']> = (
    fetch,
    request,
    init,
  ) => {
    if (closing) throw new ModelGatewayError('ADMISSION_CLOSED');
    const owned = { ...init, dispatcher };
    return fetch(request, owned);
  };
  return {
    fetchOwned,
    close() {
      return (closing ??= Promise.resolve().then(async () => {
        const dispatched = dispatcher.destroy();
        const joined = [...sockets].map(([socket, closed]) => {
          socket.destroy();
          return closed;
        });
        await Promise.all([dispatched, ...joined]);
        evidence = `undici-owner-stopped:${ownerId}:${randomUUID()}`;
      }));
    },
    async stoppedEvidence(candidate: string, signal: AbortSignal) {
      signal.throwIfAborted();
      if (candidate !== ownerId || !closing)
        throw new ModelGatewayError('AUTHORIZATION_DENIED');
      await closing;
      signal.throwIfAborted();
      if (!evidence) throw new ModelGatewayError('AUTHORIZATION_DENIED');
      return evidence;
    },
  };
}
