import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import type { Socket } from 'node:net';

type RequestClose = {
  complete: boolean;
  socket?: Socket;
  settled: Promise<void>;
  onSettled(): void;
  onHeaders(): void;
  onBody(): void;
};
type Observation = {
  requests: Map<object, RequestClose>;
  onHeaders(): void;
  onBody(): void;
};
const dispatches = new AsyncLocalStorage<Observation>();
const requests = new WeakMap<object, RequestClose>();
const create = channel('undici:request:create');
const headers = channel('undici:client:sendHeaders');
const bodyChunk = channel('undici:request:bodyChunkSent');
const trailers = channel('undici:request:trailers');

/** Public Undici diagnostics, pinned by Node 22.23.2. Read only request object
 * identity and socket lifecycle; never inspect/log headers, credentials or body.
 * A request:error notification is NOT itself a connection-close confirmation. */
export function installNativeCloseObserver(): () => void {
  const onCreate = (message: unknown) => {
    const observation = dispatches.getStore();
    if (!observation) return;
    const { request } = message as { request: object };
    let onSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      onSettled = resolve;
    });
    // Wire admission attaches only to the first native request in this
    // exact fetch. Native close still follows every observed request.
    const entry = {
      complete: false,
      settled,
      onSettled,
      onHeaders: observation.requests.size ? () => {} : observation.onHeaders,
      onBody: observation.requests.size ? () => {} : observation.onBody,
    };
    observation.requests.set(request, entry);
    requests.set(request, entry);
  };
  const onHeaders = (message: unknown) => {
    const { request, socket } = message as { request: object; socket: Socket };
    const entry = requests.get(request);
    if (!entry) return;
    entry.socket = socket;
    entry.onHeaders();
    if (socket.closed) entry.onSettled();
    else socket.once('close', entry.onSettled);
  };
  const onBody = (message: unknown) => {
    requests.get((message as { request: object }).request)?.onBody();
  };
  const onTrailers = (message: unknown) => {
    const entry = requests.get((message as { request: object }).request);
    if (entry) {
      entry.complete = true;
      entry.onSettled();
    }
  };
  create.subscribe(onCreate);
  headers.subscribe(onHeaders);
  bodyChunk.subscribe(onBody);
  trailers.subscribe(onTrailers);
  return () => {
    create.unsubscribe(onCreate);
    headers.unsubscribe(onHeaders);
    bodyChunk.unsubscribe(onBody);
    trailers.unsubscribe(onTrailers);
  };
}

export function observeNativeClose() {
  const ready = Promise.withResolvers<void>();
  const written = Promise.withResolvers<void>();
  let wroteBody = false;
  const observation: Observation = {
    requests: new Map(),
    onHeaders: ready.resolve,
    onBody() {
      wroteBody = true;
      written.resolve();
    },
  };
  return {
    headersReady: ready.promise,
    bodyWritten: written.promise,
    get wroteBody() {
      return wroteBody;
    },
    run<T>(operation: () => T): T {
      return dispatches.run(observation, operation);
    },
    async confirmed(): Promise<boolean> {
      if (!observation.requests.size) return false;
      for (const entry of observation.requests.values()) {
        if (entry.complete) continue; // Entire response received, not just headers.
        // Native Fetch abort destroys its HTTP/1 socket before closing it. Await
        // the real close event; an abort signal or rejected cancel is not proof.
        if (!entry.socket?.destroyed) return false;
        await entry.settled;
      }
      return true;
    },
    /** A null Web body may be available at headers before the actual HTTP
     * response ends. Join its raw completion or confirmed cancellation. */
    async waitForSettlement(signal: AbortSignal): Promise<boolean> {
      if (!observation.requests.size) return false;
      for (const entry of observation.requests.values()) {
        if (entry.complete) continue;
        if (!entry.socket || signal.aborted) return false;
        const known = await new Promise<boolean>((resolve) => {
          const abort = () => resolve(false);
          signal.addEventListener('abort', abort, { once: true });
          void entry.settled.then(() => {
            signal.removeEventListener('abort', abort);
            resolve(true);
          });
        });
        if (!known) return false;
      }
      return true;
    },
    dispose() {
      for (const [request, entry] of observation.requests) {
        requests.delete(request);
        entry.socket?.off('close', entry.onSettled);
      }
      observation.requests.clear();
    },
  };
}
