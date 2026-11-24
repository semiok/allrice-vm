import {
  pageClosing,
  pageCompletion,
  pageDocumentReady,
  pageRevoked,
  pageStartupFailed,
} from './page-messages.ts';

/** Inline in the authenticated document, before the browser sees any asset. */
export const initialDocumentLifecycle = `(() => {
  const protocol = ${JSON.stringify({
    close: pageClosing,
    complete: pageCompletion,
    ready: pageDocumentReady,
    revoke: pageRevoked,
    fail: pageStartupFailed,
  })};
  const scopeId = document.currentScript.dataset.scopeId;
  const controller = new AbortController();
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
    send(protocol.complete, state);
  };
  window.addEventListener('error', error, true);
  window.addEventListener('message', received);
  window.addEventListener('pagehide', stop, { once: true });
  window.addEventListener('load', loaded, { once: true });
  globalThis.__ALLRICE_EMPLOYEE_DOCUMENT__ = Object.freeze({
    scopeId,
    signal: controller.signal,
    claim() {
      if (controller.signal.aborted) return false;
      claimed = true;
      return true;
    },
    finish,
  });
  send(protocol.ready);
})();`;
