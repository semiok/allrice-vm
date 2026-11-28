import {
  pageClosing,
  pageCompletion,
  pageDocumentReady,
  pageRevoked,
  pageStartupFailed,
} from './page-messages.ts';

import {
  downloadProfileResource,
  profileDownloadLimits,
  sealedProfileBundleFetch,
} from './profile-download.ts';
import { findPublicProfileBundle } from './public-profile-bundles.ts';

const publicBundlePath =
  /^\/_next\/static\/dsh-profile\/[a-f0-9]{64}\/bundles\/[a-f0-9]{64}\.js$/;

export function publicStartupBundleUrls(
  {
    graph,
    injections,
  }: {
    graph: {
      batches: readonly {
        phase: string;
        url: string;
        rev: string;
        entries?: readonly string[];
      }[];
    };
    injections: readonly { kind: string; src?: string }[];
  },
  release: Parameters<typeof findPublicProfileBundle>[0],
) {
  const batches = [
    graph.batches.find(({ phase }) => phase === 'bootstrap'),
    graph.batches.find(
      ({ phase, url }) =>
        phase === 'application' &&
        injections.some(
          ({ kind, src }) => kind === 'script-preload' && src === url,
        ),
    ),
  ];
  return [
    ...new Set(
      batches.flatMap((batch) => {
        const packet = batch && findPublicProfileBundle(release, batch);
        return packet ? [packet.url] : [];
      }),
    ),
  ];
}

export type EarlyProfileBundles = {
  take(): ReadonlyMap<string, Promise<ArrayBuffer>>;
  cancel(): void;
};

/** Inline in the authenticated document, before the browser sees any asset. */
export const initialDocumentLifecycle = `(() => {
  const protocol = ${JSON.stringify({
    close: pageClosing,
    complete: pageCompletion,
    ready: pageDocumentReady,
    revoke: pageRevoked,
    fail: pageStartupFailed,
  })};
  const { scopeId, publicStartupBundles } = document.currentScript.dataset;
  const controller = new AbortController();
  const earlyRequest = new AbortController();
  const reads = new Map();
  const pending = new Set();
  // The publisher matched the graph and the sealed index. The early fetch
  // carries no credentials and leaves execution to the native loader.
  const pattern = new RegExp(${JSON.stringify(publicBundlePath.source)});
  let urls;
  try { urls = JSON.parse(publicStartupBundles || '[]'); }
  catch { urls = []; }
  if (Array.isArray(urls) && urls.length <= 2) for (const url of urls) {
    if (typeof url !== 'string' || !pattern.test(url) || reads.has(url)) continue;
    const bytes = (${downloadProfileResource.toString()})(
      url,
      AbortSignal.any([controller.signal, earlyRequest.signal]),
      ${JSON.stringify(sealedProfileBundleFetch)},
      ${JSON.stringify(profileDownloadLimits)},
      (body) => new Response(body).arrayBuffer()
    );
    reads.set(url, bytes);
    pending.add(bytes);
    const settled = () => pending.delete(bytes);
    void bytes.then(settled, settled);
  }
  const earlyBundles = reads.size ? Object.freeze({
    take() {
      const taken = new Map(reads);
      reads.clear();
      return taken;
    },
    cancel() {
      reads.clear();
      earlyRequest.abort();
    },
  }) : undefined;
  let claimed = false;
  let complete = false;
  const send = (type, state) =>
    parent.postMessage({ type, scopeId, state }, location.origin);
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (!claimed) {
      send(protocol.close);
      window.stop();
      if (document.readyState === 'complete') finish('closed');
    }
  };
  const received = (event) => {
    if (event.source === parent && event.origin === location.origin &&
        event.data?.scopeId === scopeId && event.data.type === protocol.revoke) stop();
  };
  const error = (event) => {
    const asset = event.target?.dataset?.allriceDocumentAsset;
    if (!asset) return;
    send(protocol.fail);
    stop();
  };
  const loaded = () => {
    if (controller.signal.aborted && !claimed) finish('closed');
  };
  const finish = (state) => {
    if (complete) return;
    complete = true;
    window.removeEventListener('message', received);
    window.removeEventListener('error', error, true);
    window.removeEventListener('pagehide', stop);
    window.removeEventListener('load', loaded);
    if (earlyBundles) {
      earlyBundles.cancel();
      void Promise.allSettled(pending).then(() => send(protocol.complete, state));
    } else send(protocol.complete, state);
  };
  window.addEventListener('error', error, true);
  window.addEventListener('message', received);
  window.addEventListener('pagehide', stop, { once: true });
  window.addEventListener('load', loaded, { once: true });
  globalThis.__ALLRICE_EMPLOYEE_DOCUMENT__ = Object.freeze({
    scopeId,
    signal: controller.signal,
    earlyBundles,
    claim() {
      if (controller.signal.aborted) return false;
      claimed = true;
      return true;
    },
    finish,
  });
  send(protocol.ready);
})();`;
