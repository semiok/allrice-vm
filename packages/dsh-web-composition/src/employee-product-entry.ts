import { applyIndexInjections } from '@deepseek-ai/dsh-client-web';
import { nativeProfileDocument } from '../../../apps/web/lib/d-entry/profile-browser';
import {
  startEmployeeWebEntry,
  type EmployeeWebEntryClose,
} from './employee-web-entry';
import {
  pageCompletion,
  pageStartupFailed,
} from '../../../apps/web/lib/d-entry/page-messages';

const container = document.getElementById('app');
const scope = globalThis as typeof globalThis & {
  __DSH_TRANSPORT__?: ReturnType<typeof nativeProfileDocument>['transport'];
  __ALLRICE_D_ENTRY_LIFETIME__?: AbortSignal;
  __ALLRICE_EMPLOYEE_DOCUMENT__?: {
    scopeId: string;
    signal: AbortSignal;
    claim(): boolean;
    finish(state: 'closed' | 'unknown'): void;
  };
};
const initial = scope.__ALLRICE_EMPLOYEE_DOCUMENT__;
const scopeId = initial?.scopeId ?? container?.dataset.scopeId;
const fail = () =>
  parent.postMessage({ type: pageStartupFailed, scopeId }, location.origin);
if (initial && !initial.claim()) initial.finish('closed');
else if (container) boot(container);
else {
  fail();
  initial?.finish('closed');
}

function boot(container: HTMLElement) {
  let profile: ReturnType<typeof nativeProfileDocument> | undefined;
  let entry: ReturnType<typeof startEmployeeWebEntry> | undefined;
  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    const joined = entry
      ? entry.close()
      : Promise.resolve().then(async (): Promise<EmployeeWebEntryClose> => {
          profile?.cancel();
          await profile?.close();
          return { state: 'closed' };
        });
    const finish = (state: EmployeeWebEntryClose['state']) => {
      window.removeEventListener('pagehide', close);
      initial?.signal.removeEventListener('abort', close);
      if (scope.__DSH_TRANSPORT__ === profile?.transport)
        delete scope.__DSH_TRANSPORT__;
      if (scope.__ALLRICE_D_ENTRY_LIFETIME__ === profile?.signal)
        delete scope.__ALLRICE_D_ENTRY_LIFETIME__;
      if (initial) initial.finish(state);
      else
        parent.postMessage(
          { type: pageCompletion, scopeId, state },
          location.origin,
        );
    };
    void joined.then(
      ({ state }) => finish(state),
      () => finish('unknown'),
    );
  }
  try {
    const document = nativeProfileDocument(container, close);
    profile = document;
    scope.__DSH_TRANSPORT__ = document.transport;
    scope.__ALLRICE_D_ENTRY_LIFETIME__ = document.signal;
    entry = startEmployeeWebEntry(container, {
      async applyRequiredInjections(signal) {
        const injections = await document.bootstrap(signal);
        await applyIndexInjections(injections, document.transport.loadBundle);
      },
      cancel: document.cancel,
      cleanup: document.close,
    });
    window.addEventListener('pagehide', close, { once: true });
    initial?.signal.addEventListener('abort', close, { once: true });
    void entry.started.then((result) => {
      if (result.state !== 'failed') return;
      fail();
      close();
    });
  } catch {
    fail();
    close();
  }
}
