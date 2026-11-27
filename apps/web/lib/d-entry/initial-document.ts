import {
  pageClosing,
  pageCompletion,
  pageDocumentReady,
  pageRevoked,
  pageStartupFailed,
} from './page-messages.ts';

export const profileBundleTimeoutMs = 30_000;

const publicBootstrapPath =
  /^\/_next\/static\/dsh-profile\/[a-f0-9]{64}\/bundles\/[a-f0-9]{64}\.js$/;

export function publicBootstrapUrl(
  batches: readonly { phase: string; url: string; rev: string }[],
  release: {
    root: string;
    bundles: readonly { reference: string; revision: string; sha256: string }[];
  },
) {
  const bootstrap = batches.find(({ phase }) => phase === 'bootstrap');
  if (!bootstrap) return;
  const sealed = release.bundles.find(
    ({ reference, revision }) =>
      reference === bootstrap.url && revision === bootstrap.rev,
  );
  if (!sealed) return;
  const url = release.root + 'bundles/' + sealed.sha256 + '.js';
  return publicBootstrapPath.test(url) ? url : undefined;
}

export type EarlyProfileBootstrap = {
  url: string;
  bytes: Promise<ArrayBuffer>;
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
  const { scopeId, publicBootstrapUrl } = document.currentScript.dataset;
  const controller = new AbortController();
  const earlyRequest = new AbortController();
  // The HTML publisher already matched the graph and the sealed code index.
  // Do not run these bytes here or include the login on the public request.
  const earlyBootstrap = new RegExp(${JSON.stringify(publicBootstrapPath.source)}).test(publicBootstrapUrl)
    ? Object.freeze({
        url: publicBootstrapUrl,
        cancel: () => earlyRequest.abort(),
        bytes: (async () => {
          const signal = AbortSignal.any([
            controller.signal, earlyRequest.signal, AbortSignal.timeout(${profileBundleTimeoutMs}),
          ]);
          const response = await fetch(publicBootstrapUrl, {
            credentials: 'omit', redirect: 'error', signal,
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw Error('Employee profile bundle unavailable');
          }
          const bytes = await response.arrayBuffer();
          signal.throwIfAborted();
          return bytes;
        })(),
      })
    : undefined;
  void earlyBootstrap?.bytes.catch(() => {});
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
    if (earlyBootstrap) {
      earlyBootstrap.cancel();
      const joined = () => send(protocol.complete, state);
      void earlyBootstrap.bytes.then(joined, joined);
    } else send(protocol.complete, state);
  };
  window.addEventListener('error', error, true);
  window.addEventListener('message', received);
  window.addEventListener('pagehide', stop, { once: true });
  window.addEventListener('load', loaded, { once: true });
  globalThis.__ALLRICE_EMPLOYEE_DOCUMENT__ = Object.freeze({
    scopeId,
    signal: controller.signal,
    earlyBootstrap,
    claim() {
      if (controller.signal.aborted) return false;
      claimed = true;
      return true;
    },
    finish,
  });
  send(protocol.ready);
})();`;
