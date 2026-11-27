import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { Agent, buildConnector } from 'undici';
import { ModelGatewayError, type GatewayProvider } from './contract.ts';

/** Dedicated pool for the exact host. Track the underlying TCP socket
 * from creation, including before Undici has established a TLS context. */
export function createOwnedModelTransport(ownerId: string) {
  const sockets = new Map<Socket, Promise<void>>();
  const establishTls = buildConnector({ allowH2: false });
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      function settle(...result: Parameters<typeof callback>) {
        if (timer) clearTimeout(timer);
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
      if (secure) {
        // Keep Undici's TLS settings, certificate validation and session cache.
        try {
          establishTls({ ...options, httpSocket: socket }, settle);
        } catch (error) {
          socket.destroy();
          settle(
            error instanceof Error ? error : new Error('TLS setup failed'),
            null,
          );
        }
      } else {
        socket.setNoDelay(true).setKeepAlive(true, 60_000);
        socket.once('connect', () => settle(null, socket));
        timer = setTimeout(
          () => socket.destroy(new Error('Connect timeout')),
          10_000,
        ).unref();
      }
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
