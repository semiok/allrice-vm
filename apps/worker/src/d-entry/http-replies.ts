import type { IncomingMessage, ServerResponse } from 'node:http';

type WriteReply = (
  active: AbortSignal,
  write: () => void,
  verify?: () => Promise<void>,
) => Promise<boolean>;

export function createDEntryHttpReplies(serviceSignal: AbortSignal) {
  const connections = new WeakMap<IncomingMessage['socket'], AbortSignal>();
  const pending = new Set<Promise<unknown>>();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, serviceSignal]);
  let closing: Promise<void> | undefined;

  function track<T>(work: Promise<T>) {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }

  function socketLifetime(socket: IncomingMessage['socket']) {
    const existing = connections.get(socket);
    if (existing) return existing;
    const controller = new AbortController();
    connections.set(socket, controller.signal);
    if (socket.closed) controller.abort();
    else socket.once('close', () => controller.abort());
    return controller.signal;
  }

  function handle<T>(
    request: IncomingMessage,
    response: ServerResponse,
    run: (requestSignal: AbortSignal, writeOwned: WriteReply) => Promise<T>,
  ) {
    const disconnected = new AbortController();
    const stop = () => disconnected.abort();
    response.once('close', stop);
    const physical = socketLifetime(request.socket);
    const requestSignal = AbortSignal.any([
      signal,
      physical,
      disconnected.signal,
    ]);
    return track(
      Promise.resolve().then(async () => {
        try {
          return await run(requestSignal, writeOwned);
        } finally {
          response.off('close', stop);
        }
      }),
    );

    async function writeOwned(
      active: AbortSignal,
      write: () => void,
      verify?: () => Promise<void>,
    ) {
      const { socket } = request;
      if (response.writableFinished || response.closed || socket.closed)
        return false;
      let settle!: (sent: boolean) => void;
      const wire = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      const finished = () => settle(true);
      const closed = () => settle(false);
      response.once('finish', finished);
      response.once('close', closed);
      physical.addEventListener('abort', closed, { once: true });
      void wire.then(() => {
        response.off('finish', finished);
        response.off('close', closed);
        physical.removeEventListener('abort', closed);
      });

      if (!response.socket && !active.aborted) {
        // A pipelined response cannot write or cancel another response's
        // socket. Wait for Node to assign this exact response before handing
        // it any headers or business bytes.
        let wake!: () => void;
        const turn = new Promise<void>((resolve) => {
          wake = resolve;
        });
        response.once('socket', wake);
        active.addEventListener('abort', wake, { once: true });
        try {
          if (!response.socket && !active.aborted && !socket.closed) await turn;
        } finally {
          response.off('socket', wake);
          active.removeEventListener('abort', wake);
        }
      }
      if (socket.closed) {
        closed();
        return false;
      }
      const refuse = () => {
        // No page output reached this response. Hand only an empty,
        // order-preserving denial to the service and retain the actual wire.
        track(wire);
        response.writeHead(404, {
          'cache-control': 'private, no-store',
          'content-length': '0',
        });
        response.end();
        return false;
      };
      if (active.aborted && !response.headersSent) return refuse();
      try {
        if (verify) await verify();
      } catch (error) {
        // Keep the original verification failure with the caller even if
        // verification fenced its page. The borrowed error path will either
        // deliver an empty denial or find that the caller has disconnected.
        closed();
        throw error;
      }
      if (socket.closed || response.closed) {
        closed();
        return false;
      }
      if (active.aborted && !response.headersSent) return refuse();
      // Once a fixed-length response has started, only transport closure
      // can both stop its bytes and avoid corrupting HTTP/1.1 framing.
      const abort = () => {
        if (!response.writableFinished && response.socket) response.destroy();
      };
      active.addEventListener('abort', abort, { once: true });
      try {
        if (active.aborted) abort();
        else write();
        return await wire;
      } catch (error) {
        if (response.headersSent) {
          abort();
          await wire;
        } else closed();
        throw error;
      } finally {
        active.removeEventListener('abort', abort);
      }
    }
  }

  return {
    signal,
    track,
    handle,
    close() {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        // A handler can move an empty queued reply to this owner when
        // cancelled. Drain the handlers and any replies they hand over.
        while (pending.size) await Promise.allSettled([...pending]);
      });
      lifetime.abort();
      return closing;
    },
  };
}
