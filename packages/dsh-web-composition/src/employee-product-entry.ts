import { applyIndexInjections } from '@deepseek-ai/dsh-client-web';
import { nativeProfileDocument } from '../../../apps/web/lib/d-entry/profile-browser';
import { startEmployeeWebEntry } from './employee-web-entry';

const container = document.getElementById('app');
if (!(container instanceof HTMLElement))
  throw Error('Missing employee document');
const profile = nativeProfileDocument(container, () => {
  void entry.close();
});
const scope = globalThis as typeof globalThis & {
  __DSH_TRANSPORT__?: typeof profile.transport;
};
scope.__DSH_TRANSPORT__ = profile.transport;
const entry = startEmployeeWebEntry(container, {
  async applyRequiredInjections(signal) {
    const injections = await profile.bootstrap(signal);
    await applyIndexInjections(injections, profile.transport.loadBundle);
  },
  cleanup: profile.close,
});
window.addEventListener('pagehide', () => void entry.close(), { once: true });
void entry.started.then((result) => {
  if (result.state === 'failed') void entry.close();
});
