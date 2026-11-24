import {
  DEntryPageBorrowSchema,
  DEntryPageUnarySchema,
  DEntryProfileBootstrapSchema,
  UuidSchema,
} from '@allrice/contracts';
import { z } from 'zod';
import {
  nativeMuxUrl,
  pageClosing,
  pageCompletion,
  pageRevoked,
} from './page-carrier';

const sender = z.strictObject({
  type: z.literal('client-request'),
  method: DEntryPageUnarySchema,
  rpcId: z.string(),
  payload: z.strictObject({ args: z.record(z.string(), z.unknown()) }),
});
export function nativeProfileDocument(
  container: HTMLElement,
  onRevoked: () => void,
) {
  const { scopeId, ...selection } = DEntryPageBorrowSchema.parse({
    scopeId: container.dataset.scopeId,
    workspaceId: container.dataset.workspaceId,
    employeeInstanceId: container.dataset.employeeInstanceId,
    threadId: container.dataset.threadId || undefined,
  });
  const organizationId = UuidSchema.parse(container.dataset.organizationId);
  const bindingRef = container.dataset.bindingRef!;
  const graphRev = container.dataset.graphRev!;
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const channels = new Map<WebSocket, Promise<void>>();
  const done = Promise.withResolvers<void>();
  const owned = <T>(task: Promise<T>) => {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  void done.promise.catch(() => {});
  const query = new URLSearchParams({
    scopeId,
    workspaceId: selection.workspaceId,
    employeeInstanceId: selection.employeeInstanceId,
    ...(selection.threadId && { threadId: selection.threadId }),
  });
  const profileUrl = (type: 'assets' | 'bootstrap') =>
    new URL('/api/v1/d-entry/profile/' + type + '?' + query, location.origin);
  let published:
    ReturnType<typeof DEntryProfileBootstrapSchema.parse> | undefined;
  let closing: Promise<void> | undefined;
  let peer: WebSocket | undefined;
  const receive = (event: MessageEvent) => {
    if (
      event.origin !== location.origin ||
      event.source !== parent ||
      event.data?.scopeId !== scopeId
    )
      return;
    if (event.data.type === pageRevoked && !lifetime.signal.aborted) {
      lifetime.abort();
      onRevoked();
    }
    if (event.data.type === pageCompletion) {
      if (event.data.state === 'closed') done.resolve();
      else done.reject(Error('Native page close is unconfirmed'));
    }
  };
  window.addEventListener('message', receive);
  function stop() {
    if (closing) return closing;
    lifetime.abort();
    parent.postMessage({ type: pageClosing, scopeId }, location.origin);
    closing = (async () => {
      const [remote] = await Promise.allSettled([done.promise]);
      // The owner fences the page before this borrowed carrier is discarded.
      const joined = [...channels.values()];
      for (const socket of channels.keys()) socket.close();
      await Promise.allSettled([...joined, ...pending]);
      window.removeEventListener('message', receive);
      if (remote.status === 'rejected') throw remote.reason;
    })();
    return closing;
  }
  return {
    close: stop,
    async bootstrap(signal: AbortSignal) {
      const active = AbortSignal.any([lifetime.signal, signal]);
      const response = await fetch(profileUrl('bootstrap'), {
        signal: active,
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw Error('Employee profile unavailable');
      const result = DEntryProfileBootstrapSchema.parse(await response.json());
      active.throwIfAborted();
      if (
        result.scopeReference.scopeId !== scopeId ||
        result.bindingRef !== bindingRef ||
        result.graph.rev !== graphRev
      )
        throw Error('Employee profile changed during startup');
      published = result;
      return result.injections;
    },
    transport: {
      fetch(input: string | URL, init: RequestInit) {
        return owned(
          Promise.resolve().then(() => {
            lifetime.signal.throwIfAborted();
            const endpoint =
              typeof input === 'string' && input.startsWith('api/')
                ? DEntryPageUnarySchema.safeParse(input.slice(4))
                : undefined;
            if (
              !endpoint?.success ||
              init.method !== 'POST' ||
              typeof init.body !== 'string'
            )
              return new Response(null, { status: 403 });
            const request = sender.parse(JSON.parse(init.body));
            if (endpoint.data !== request.method)
              return new Response(null, { status: 403 });
            return fetch('/api/v1/d-entry/native-rpc?carrier=page', {
              method: 'POST',
              credentials: 'same-origin',
              cache: 'no-store',
              signal: init.signal
                ? AbortSignal.any([lifetime.signal, init.signal])
                : lifetime.signal,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                selection,
                scopeId,
                rpcId: request.rpcId,
                endpoint: request.method,
                payload: request.payload,
              }),
            }).then(
              async (reply) =>
                new Response(await reply.arrayBuffer(), {
                  status: reply.status,
                  headers: reply.headers,
                }),
            );
          }),
        );
      },
      createWebSocket(input: string) {
        lifetime.signal.throwIfAborted();
        const expected = new URL('api/remote.mux', document.baseURI);
        expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
        if (new URL(input).href !== expected.href || peer)
          throw Error('Native connection is unavailable');
        const socket = new WebSocket(
          nativeMuxUrl(location.origin, organizationId, selection, scopeId),
        );
        peer = socket;
        channels.set(
          socket,
          new Promise((resolve) => {
            socket.addEventListener(
              'close',
              () => {
                channels.delete(socket);
                resolve();
                if (!lifetime.signal.aborted) {
                  lifetime.abort();
                  onRevoked();
                }
              },
              { once: true },
            );
          }),
        );
        return socket;
      },
      loadBundle(reference: string) {
        return owned(
          new Promise<void>((resolve, reject) => {
            lifetime.signal.throwIfAborted();
            const graph = published?.graph;
            const resource =
              graph &&
              [...graph.entries, ...graph.batches].find(
                ({ url }) => url === reference,
              );
            if (!resource) throw Error('Native bundle was not published');
            const target = profileUrl('assets');
            target.searchParams.set('bindingRef', bindingRef);
            target.searchParams.set('reference', resource.url);
            target.searchParams.set('revision', resource.rev);
            const script = document.createElement('script');
            script.src = target.href;
            const finish = (error?: unknown) => {
              lifetime.signal.removeEventListener('abort', cancel);
              script.remove();
              if (error) reject(error);
              else resolve();
            };
            const cancel = () => finish(lifetime.signal.reason);
            script.onload = () => finish();
            script.onerror = () =>
              finish(Error('Employee profile bundle unavailable'));
            lifetime.signal.addEventListener('abort', cancel, { once: true });
            document.head.append(script);
          }),
        );
      },
    },
  };
}
