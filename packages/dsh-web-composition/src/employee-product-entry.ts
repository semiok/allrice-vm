import { applyIndexInjections } from '@deepseek-ai/dsh-client-web';
import { nativeProfileDocument } from '../../../apps/web/lib/d-entry/profile-browser';
import { startEmployeeWebEntry } from './employee-web-entry';
import { pageCompletion } from '../../../apps/web/lib/d-entry/page-messages';

const container = document.getElementById('app');
if (!(container instanceof HTMLElement))
  throw Error('Missing employee document');
const scopeId = container.dataset.scopeId;
const profile = nativeProfileDocument(container, () => close());
const scope = globalThis as typeof globalThis & {
  __DSH_TRANSPORT__?: typeof profile.transport;
  __ALLRICE_D_ENTRY_LIFETIME__?: AbortSignal;
};
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
    parent.postMessage(
      { type: pageCompletion, scopeId, state },
      location.origin,
    );
  });
}
window.addEventListener('pagehide', close, { once: true });
void entry.started.then((result) => {
  if (result.state === 'failed') close();
});
