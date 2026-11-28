import { borrowPageMux, type NativePageSocket } from './page-mux-client';
import {
  DEntryPageBorrowSchema,
  DEntryPageSwitchResultSchema,
  DEntryPageUnarySchema,
  DEntryProfileBootstrapSchema,
  DEntryProfileChunkFilenameSchema,
  type DEntryProfileGraphSchema,
  UuidSchema,
  dEntryRegisteredThreadHeader,
  decodeDEntryRegisteredThread,
} from '@allrice/contracts';
import { z } from 'zod';
import type { EarlyProfileBundles } from './initial-document';
import {
  findPublicProfileBundle,
  publicProfileBundles,
} from './public-profile-bundles';
import {
  downloadProfileResource,
  profileDownloadLimits,
  sealedProfileBundleFetch,
} from './profile-download';
import {
  nativeMuxUrl,
  pageClosing,
  pageCompletion,
  pageRevoked,
  pendingPageResult,
} from './page-carrier';
import {
  pageNativeThreadRegistered,
  pageThreadScope,
  pageThreadSwitchCancel,
  pageThreadSwitchPrepare,
  pageThreadSwitchPrepared,
  type PageNativeThreadRegistration,
  type PageThreadScope,
} from './page-messages';

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
  resourceScopeId: string,
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
      resourceScopeId,
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

export function releasedBundleResolver(data: DOMStringMap) {
  const root = data.publicAssetRoot;
  if (!root) return () => undefined;
  try {
    const bundles = publicProfileBundles.parse(
      JSON.parse(data.publicBundles ?? '[]'),
    );
    return (resource: Parameters<typeof findPublicProfileBundle>[1]) =>
      findPublicProfileBundle({ root, bundles }, resource);
  } catch {
    return () => undefined;
  }
}

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

function fetchProfileBundle(
  url: URL | string,
  parent: AbortSignal,
  options: Pick<RequestInit, 'credentials' | 'cache' | 'redirect'>,
) {
  return downloadProfileResource(
    url,
    parent,
    options,
    profileDownloadLimits,
    (body) => new Response(body).arrayBuffer(),
    new EmployeeProfileBundleTimeout(),
  );
}

export async function readProfileBundle(
  target: URL,
  signal: AbortSignal,
  publicUrl?: string,
  preloaded?: Promise<ArrayBuffer>,
  assemble?: (bytes: ArrayBuffer) => Promise<ArrayBuffer>,
) {
  const read = () =>
    fetchProfileBundle(target, signal, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  try {
    signal.throwIfAborted();
    let bytes = await (publicUrl
      ? (preloaded ??
        fetchProfileBundle(publicUrl, signal, sealedProfileBundleFetch))
      : read());
    if (publicUrl && assemble) {
      signal.throwIfAborted();
      bytes = await assemble(bytes);
    }
    signal.throwIfAborted();
    return bytes;
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
  earlyBundles?: EarlyProfileBundles,
  onThreadScope?: (scope: PageThreadScope) => void,
  onThreadRegistered?: (receipt: PageNativeThreadRegistration) => void,
) {
  const { scopeId, selection, organizationId } = readEmployeeDocument(
    container.dataset,
  );
  const bindingRef = container.dataset.bindingRef!;
  const graphRev = container.dataset.graphRev!;
  const releasedBundle = releasedBundleResolver(container.dataset);
  const lifetime = new AbortController();
  let authority = {
    scopeId,
    selection,
    lifetime: new AbortController(),
  };
  const pending = new Set<Promise<unknown>>();
  const threadWrites = new Set<Promise<Response>>();
  let switching: { requestId: string; drainsComplete?: boolean } | undefined;
  const preloaded = new Map<string, Promise<ArrayBuffer>>();
  const channels = new Map<NativePageSocket, Promise<void>>();
  const done = pendingPageResult<void>();
  const owned = <T>(task: Promise<T>) => {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  const cancel = () => {
    lifetime.abort();
    authority.lifetime.abort();
    earlyBundles?.cancel();
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
  let peer: NativePageSocket | undefined;
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
    if (
      event.data.type === pageThreadSwitchPrepare &&
      !lifetime.signal.aborted &&
      !switching &&
      UuidSchema.safeParse(event.data.requestId).success
    ) {
      const { requestId } = event.data;
      const handoff = { requestId, drainsComplete: false };
      switching = handoff;
      // A native write stays owned through consumption of its registration
      // header and response body, not just until the guest first replies.
      void Promise.allSettled(threadWrites).then(() => {
        if (switching !== handoff || lifetime.signal.aborted) return;
        handoff.drainsComplete = true;
        parent.postMessage(
          { type: pageThreadSwitchPrepared, scopeId, requestId },
          location.origin,
        );
      });
    }
    if (
      event.data.type === pageThreadSwitchCancel &&
      switching?.requestId === event.data.requestId
    )
      switching = undefined;
    if (
      event.data.type === pageThreadScope &&
      onThreadScope &&
      !lifetime.signal.aborted &&
      container.dataset.sharedMux === '1'
    ) {
      const result = DEntryPageSwitchResultSchema.safeParse(event.data.issued);
      if (
        !result.success ||
        result.data.type !== 'switched' ||
        result.data.scopeId === authority.scopeId ||
        result.data.requestId !== switching?.requestId
      )
        return;
      const next = result.data;
      switching = undefined;
      authority.lifetime.abort();
      authority = {
        scopeId: next.scopeId,
        selection: { ...selection, threadId: next.threadId },
        lifetime: new AbortController(),
      };
      try {
        onThreadScope(next);
      } catch {
        cancel();
        onRevoked();
      }
    }
  };
  window.addEventListener('message', receive);
  function stop() {
    if (closing) return closing;
    cancel();
    preloaded.clear();
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
    cancel,
    async bootstrap(signal: AbortSignal) {
      const active = AbortSignal.any([lifetime.signal, signal]);
      const inline = container.ownerDocument.getElementById(
        'allrice-employee-bootstrap',
      );
      async function fetchBootstrap() {
        const response = await fetch(profileUrl('bootstrap'), {
          signal: active,
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) throw Error('Employee profile unavailable');
        return response.json();
      }
      const result = DEntryProfileBootstrapSchema.parse(
        inline ? JSON.parse(inline.textContent ?? '') : await fetchBootstrap(),
      );
      active.throwIfAborted();
      if (
        result.scopeReference.scopeId !== scopeId ||
        result.bindingRef !== bindingRef ||
        result.graph.rev !== graphRev
      )
        throw Error('Employee profile changed during startup');
      published = result;
      const earlyReads = inline ? earlyBundles?.take() : undefined;
      const readEarly = (url: string) =>
        earlyReads?.get(url)?.catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'TimeoutError')
            throw new EmployeeProfileBundleTimeout();
          throw error;
        });
      const bootstrapBatch = result.graph.batches.find(
        ({ phase }) => phase === 'bootstrap',
      );
      if (bootstrapBatch) {
        const url = releasedBundle(bootstrapBatch)?.url;
        const bytes = url && readEarly(url);
        if (bytes) preloaded.set(bootstrapBatch.url, owned(bytes));
      }
      // The rc.2 injection interpreter leaves preload rows as hints. Fetch
      // only the co-sealed public bytes and let the native loader execute them.
      for (const injection of result.injections) {
        if (injection.kind !== 'script-preload') continue;
        const batch = result.graph.batches.find(
          ({ phase, url }) => phase === 'application' && url === injection.src,
        );
        const publicUrl = batch && releasedBundle(batch)?.url;
        if (publicUrl && !preloaded.has(injection.src))
          preloaded.set(
            injection.src,
            owned(
              readEarly(publicUrl) ??
                fetchProfileBundle(publicUrl, active, sealedProfileBundleFetch),
            ),
          );
      }
      return result.injections;
    },
    transport: {
      fetch(input: string | URL, init: RequestInit) {
        const isThreadWrite =
          input === 'api/session/create' || input === 'api/session/fork';
        if (isThreadWrite && switching)
          return Promise.reject(
            new DOMException(
              'Native session switch in progress',
              'InvalidStateError',
            ),
          );
        const current = authority;
        const signal = AbortSignal.any(
          init.signal
            ? [lifetime.signal, current.lifetime.signal, init.signal]
            : [lifetime.signal, current.lifetime.signal],
        );
        const task = owned(
          Promise.resolve().then(() => {
            signal.throwIfAborted();
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
              signal,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                selection: current.selection,
                scopeId: current.scopeId,
                rpcId: request.rpcId,
                endpoint: request.method,
                payload: request.payload,
              }),
            }).then(async (reply) => {
              const bytes = await reply.arrayBuffer();
              signal.throwIfAborted();
              if (
                request.method === 'session/create' ||
                request.method === 'session/fork'
              )
                publishNativeThread(
                  reply,
                  bytes,
                  scopeId,
                  current.scopeId,
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
        if (isThreadWrite) {
          threadWrites.add(task);
          void task.then(
            () => threadWrites.delete(task),
            () => threadWrites.delete(task),
          );
        }
        return task;
      },
      createWebSocket(input: string) {
        lifetime.signal.throwIfAborted();
        const expected = new URL('api/remote.mux', document.baseURI);
        expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
        if (new URL(input).href !== expected.href || peer)
          throw Error('Native connection is unavailable');
        const socket =
          container.dataset.sharedMux === '1' &&
          window.frameElement?.getAttribute('data-page-mux') === 'v1'
            ? borrowPageMux(
                scopeId,
                authority.scopeId,
                () => !switching?.drainsComplete,
                () => authority.scopeId,
              )
            : new WebSocket(
                nativeMuxUrl(
                  location.origin,
                  organizationId,
                  selection,
                  scopeId,
                ),
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
                if (peer === socket && !lifetime.signal.aborted) {
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
            const current = authority;
            const signal = AbortSignal.any([
              lifetime.signal,
              current.lifetime.signal,
            ]);
            signal.throwIfAborted();
            const graph = published?.graph;
            const resource = graph && profileBundleReference(graph, reference);
            if (!resource) throw Error('Native bundle was not published');
            const target = profileUrl('assets');
            target.searchParams.set('scopeId', current.scopeId);
            if (current.selection.threadId)
              target.searchParams.set('threadId', current.selection.threadId);
            target.searchParams.set('bindingRef', bindingRef);
            target.searchParams.set('reference', resource.url);
            target.searchParams.set('revision', resource.rev);
            const prefetched = preloaded.get(resource.url);
            preloaded.delete(resource.url);
            const packet = releasedBundle(resource);
            const bytes = await readProfileBundle(
              target,
              signal,
              packet?.url,
              prefetched,
              packet?.assemble,
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
