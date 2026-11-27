import {
  DEntryPageBorrowSchema,
  DEntryPageUnarySchema,
  DEntryProfileBootstrapSchema,
  DEntryProfileChunkFilenameSchema,
  type DEntryProfileGraphSchema,
  UuidSchema,
  dEntryRegisteredThreadHeader,
  decodeDEntryRegisteredThread,
} from '@allrice/contracts';
import { z } from 'zod';
import {
  pageNativeThreadRegistered,
  type PageNativeThreadRegistration,
} from './page-messages';
import {
  nativeMuxUrl,
  pageClosing,
  pageCompletion,
  pageRevoked,
  pendingPageResult,
} from './page-carrier';

const sender = z.strictObject({
  type: z.literal('client-request'),
  method: DEntryPageUnarySchema,
  rpcId: z.string(),
  payload: z.strictObject({ args: z.record(z.string(), z.unknown()) }),
});
const createdSessionReply = z.object({
  type: z.literal('server-response'),
  rpcId: z.string(),
  result: z.object({
    ok: z.literal(true),
    value: z.object({ sessionId: z.string().min(1).max(256) }),
  }),
});

function publishNativeThread(
  reply: Response,
  bytes: ArrayBuffer,
  scopeId: string,
  rpcId: string,
  onThreadRegistered?: (receipt: PageNativeThreadRegistration) => void,
) {
  const thread = decodeDEntryRegisteredThread(
    reply.headers.get(dEntryRegisteredThreadHeader),
  );
  if (!reply.ok || !thread) return;
  // Never replace or reinterpret the RPC result that DSH itself consumes.
  try {
    const parsed = createdSessionReply.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    if (!parsed.success || parsed.data.rpcId !== rpcId) return;
    const receipt = {
      scopeId,
      thread,
      nativeSessionId: parsed.data.result.value.sessionId,
    };
    onThreadRegistered?.(receipt);
    document.dispatchEvent(
      new CustomEvent<PageNativeThreadRegistration>(
        pageNativeThreadRegistered,
        { detail: receipt },
      ),
    );
  } catch {
    // A malformed optional sidebar receipt must not cause a native write retry.
  }
}

const publicRoot = /^\/_next\/static\/dsh-profile\/[a-f0-9]{64}\/$/;
const publicBundlesSchema = z.array(
  z.strictObject({
    reference: z.string(),
    revision: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
);
export function releasedBundleResolver(data: DOMStringMap) {
  const root = data.publicAssetRoot;
  if (!root || !publicRoot.test(root)) return () => undefined;
  try {
    const bundles = publicBundlesSchema.parse(
      JSON.parse(data.publicBundles ?? '[]'),
    );
    return ({ url, rev }: { url: string; rev: string }) => {
      const entry = bundles.find(
        ({ reference, revision }) => url === reference && rev === revision,
      );
      return entry ? root + 'bundles/' + entry.sha256 + '.js' : undefined;
    };
  } catch {
    return () => undefined;
  }
}

const profileBundleTimeoutMs = 30_000;

export function profileBundleReference(
  graph: z.infer<typeof DEntryProfileGraphSchema>,
  reference: string,
) {
  const bundle = [...graph.entries, ...graph.batches].find(
    ({ url }) => url === reference,
  );
  if (bundle) return bundle;
  // Native require.async requests a sibling of its current graph entry.
  const [path, query, trailing] = reference.split('?');
  if (!path || trailing !== undefined) return;
  const slash = path.lastIndexOf('/');
  if (
    !DEntryProfileChunkFilenameSchema.safeParse(path.slice(slash + 1)).success
  )
    return;
  const owner = graph.entries.find(
    ({ id, rev }) =>
      path.slice(0, slash) === `plugins/${id}` && query === `rev=${rev}`,
  );
  if (owner) return { url: reference, rev: owner.rev };
}

export class EmployeeProfileBundleTimeout extends Error {
  constructor() {
    super('Employee profile bundle download timed out');
  }
}

async function fetchProfileBundle(
  url: URL | string,
  parent: AbortSignal,
  options: Pick<RequestInit, 'credentials' | 'cache'>,
) {
  parent.throwIfAborted();
  const timeout = new AbortController();
  const until = AbortSignal.any([parent, timeout.signal]);
  const timer = setTimeout(
    () => timeout.abort(new EmployeeProfileBundleTimeout()),
    profileBundleTimeoutMs,
  );
  try {
    const response = await fetch(url, { ...options, signal: until });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('Employee profile bundle unavailable');
    }
    // A 200 with a stalled body is subject to the same deadline as headers.
    const bytes = await response.arrayBuffer();
    until.throwIfAborted();
    return bytes;
  } catch (error) {
    until.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function readProfileBundle(
  target: URL,
  signal: AbortSignal,
  publicUrl?: string,
) {
  const read = () =>
    fetchProfileBundle(target, signal, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  try {
    return await (publicUrl
      ? fetchProfileBundle(publicUrl, signal, { credentials: 'omit' })
      : read());
  } catch (error) {
    signal.throwIfAborted();
    if (!publicUrl && !(error instanceof EmployeeProfileBundleTimeout))
      throw error;
    try {
      return await read();
    } catch (retryError) {
      signal.throwIfAborted();
      if (error instanceof EmployeeProfileBundleTimeout) throw error;
      throw retryError;
    }
  }
}

export function readEmployeeDocument(data: DOMStringMap) {
  const { scopeId, ...selection } = DEntryPageBorrowSchema.parse({
    scopeId: data.scopeId,
    workspaceId: data.workspaceId,
    employeeInstanceId: data.employeeInstanceId,
    threadId: data.threadId || undefined,
  });
  const organizationId = UuidSchema.parse(data.organizationId);
  const viewerId = UuidSchema.parse(data.viewerId);
  return {
    scopeId,
    selection,
    organizationId,
    viewerId,
    nativeSessionId: data.nativeSessionId,
  };
}

export function nativeProfileDocument(
  container: HTMLElement,
  onRevoked: () => void,
  onBundleTimeout: (error: EmployeeProfileBundleTimeout) => void,
  onThreadRegistered?: (receipt: PageNativeThreadRegistration) => void,
) {
  const { scopeId, selection, organizationId } = readEmployeeDocument(
    container.dataset,
  );
  const bindingRef = container.dataset.bindingRef!;
  const graphRev = container.dataset.graphRev!;
  const releasedBundle = releasedBundleResolver(container.dataset);
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const channels = new Map<WebSocket, Promise<void>>();
  const done = pendingPageResult<void>();
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
    signal: lifetime.signal,
    close: stop,
    cancel: () => lifetime.abort(),
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
            }).then(async (reply) => {
              const bytes = await reply.arrayBuffer();
              if (
                !lifetime.signal.aborted &&
                (request.method === 'session/create' ||
                  request.method === 'session/fork')
              )
                publishNativeThread(
                  reply,
                  bytes,
                  scopeId,
                  request.rpcId,
                  onThreadRegistered,
                );
              return new Response(bytes, {
                status: reply.status,
                headers: reply.headers,
              });
            });
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
          (async () => {
            const signal = lifetime.signal;
            signal.throwIfAborted();
            const graph = published?.graph;
            const resource = graph && profileBundleReference(graph, reference);
            if (!resource) throw Error('Native bundle was not published');
            const target = profileUrl('assets');
            target.searchParams.set('bindingRef', bindingRef);
            target.searchParams.set('reference', resource.url);
            target.searchParams.set('revision', resource.rev);
            const bytes = await readProfileBundle(
              target,
              signal,
              releasedBundle(resource),
            ).catch((error: unknown) => {
              if (
                error instanceof EmployeeProfileBundleTimeout &&
                !signal.aborted
              ) {
                // The rc.2 loader also retries bundles, then falls back to
                // per-module URLs. Fence those reads after our terminal retry.
                lifetime.abort(error);
                onBundleTimeout(error);
              }
              throw error;
            });
            signal.throwIfAborted();
            // rc.2 payloads are classic registration scripts. Download belongs
            // to the abortable request; only the received, certified bytes can
            // enter the synchronous native registration callback.
            const script = document.createElement('script');
            script.textContent = new TextDecoder('utf-8', {
              fatal: true,
            }).decode(bytes);
            let registrationError: Error | undefined;
            const failed = (event: ErrorEvent) => {
              registrationError =
                event.error instanceof Error
                  ? event.error
                  : Error('Employee profile bundle failed');
            };
            window.addEventListener('error', failed);
            try {
              signal.throwIfAborted();
              document.head.append(script);
              if (registrationError) throw registrationError;
            } finally {
              window.removeEventListener('error', failed);
              script.remove();
            }
          })(),
        );
      },
    },
  };
}
