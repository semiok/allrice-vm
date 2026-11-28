import { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, escapeIdentifier } from 'pg';

/** One owner for the socket and its retry timer. Do not let the driver create
 * another LISTEN connection after the caller has joined close. */
export function openPostgresNotifications(
  databaseUrl: string,
  channels: readonly string[],
  receive: (channel: string, payload: string) => void,
  options: {
    applicationName?: string;
    keepAliveMs?: number;
    onListen?(): void;
  } = {},
) {
  const stopped = new AbortController();
  let endCurrent: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  let ready!: () => void, failed!: (error: unknown) => void;
  const listening = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const run = (async () => {
    while (!stopped.signal.aborted) {
      const socket = new Socket();
      const closed = new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
      });
      const client = new Client({
        connectionString: databaseUrl,
        stream: () => socket,
        application_name: options.applicationName,
        keepAlive: Boolean(options.keepAliveMs),
        keepAliveInitialDelayMillis: options.keepAliveMs,
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
      });
      let ending: Promise<void> | undefined;
      const end = () =>
        (ending ??= (async () => {
          // Give PostgreSQL its normal Terminate, but a half-open peer must
          // not hold shutdown. This read-only connection owns no transaction.
          const deadline = setTimeout(() => socket.destroy(), 1000).unref();
          try {
            await Promise.all([client.end(), closed]);
          } finally {
            clearTimeout(deadline);
          }
        })());
      const disconnected = new Promise<void>((resolve) => {
        const lost = () => resolve();
        client.once('end', lost);
        client.on('error', lost);
      });
      client.on('notification', ({ channel, payload }) => {
        if (!stopped.signal.aborted && payload !== undefined)
          receive(channel, payload);
      });
      try {
        await client.connect();
        // Ending before readiness can abandon pg's pending connect callback.
        // Join the bounded connection attempt before ending it.
        endCurrent = end;
        for (const channel of channels) {
          stopped.signal.throwIfAborted();
          await client.query(`LISTEN ${escapeIdentifier(channel)}`);
        }
        stopped.signal.throwIfAborted();
        options.onListen?.();
        ready();
        await disconnected;
      } catch (error) {
        if (!stopped.signal.aborted) failed(error);
      } finally {
        await end();
        endCurrent = undefined;
      }
      if (!stopped.signal.aborted)
        await delay(250, undefined, {
          signal: stopped.signal,
          ref: false,
        }).catch((error: unknown) => {
          if (!stopped.signal.aborted) throw error;
        });
    }
  })();
  void run.catch(failed);
  void listening.catch(() => {});
  return {
    ready: listening,
    close() {
      if (closing) return closing;
      stopped.abort();
      failed(stopped.signal.reason);
      return (closing = (async () => {
        // End a held LISTEN query as well as an already-listening session.
        await endCurrent?.();
        await run;
      })());
    },
  };
}
