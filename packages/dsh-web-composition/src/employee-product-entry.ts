import { applyIndexInjections } from '@deepseek-ai/dsh-client-web';
import { nativeProfileDocument } from '../../../apps/web/lib/d-entry/profile-browser';
import { startEmployeeWebEntry } from './employee-web-entry';
import {
  pageCompletion,
  pageStartupFailed,
} from '../../../apps/web/lib/d-entry/page-messages';

const container = document.getElementById('app');
if (!(container instanceof HTMLElement))
  throw Error('Missing employee document');
const scopeId = container.dataset.scopeId;
const scope = globalThis as typeof globalThis & {
  __DSH_TRANSPORT__?: ReturnType<typeof nativeProfileDocument>['transport'];
  __ALLRICE_D_ENTRY_LIFETIME__?: AbortSignal;
  __ALLRICE_EMPLOYEE_DOCUMENT__?: {
    signal: AbortSignal;
    claim(): boolean;
    finish(state: 'closed' | 'unknown'): void;
  };
};
const initial = scope.__ALLRICE_EMPLOYEE_DOCUMENT__;
if (initial && !initial.claim()) initial.finish('closed');
else boot(container);

function boot(container: HTMLElement) {
  const profile = nativeProfileDocument(container, () => close());
  scope.__DSH_TRANSPORT__ = profile.transport;
  scope.__ALLRICE_D_ENTRY_LIFETIME__ = profile.signal;
  const entry = startEmployeeWebEntry(container, {
    async applyRequiredInjections(signal) {
      const injections = await profile.bootstrap(signal);
      await applyIndexInjections(injections, profile.transport.loadBundle);
    },
    cancel: profile.cancel,
    cleanup: profile.close,
  });
  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    void entry.close().then(({ state }) => {
      window.removeEventListener('pagehide', close);
      initial?.signal.removeEventListener('abort', close);
      if (initial) initial.finish(state);
      else
        parent.postMessage(
          { type: pageCompletion, scopeId, state },
          location.origin,
        );
    });
  }
  window.addEventListener('pagehide', close, { once: true });
  initial?.signal.addEventListener('abort', close, { once: true });
  void entry.started.then((result) => {
    if (result.state !== 'failed') return;
    parent.postMessage({ type: pageStartupFailed, scopeId }, location.origin);
    close();
  });
}
