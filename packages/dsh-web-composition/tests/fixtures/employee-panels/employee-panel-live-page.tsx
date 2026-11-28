// Isolated document host for a browser test. Business authority and data are
// supplied by the original Cookie and production Web handlers.
import '../../../../../apps/web/app/dsh-upstream/design-platform.css';
import '../../../../../apps/web/app/dsh-upstream/base.css';
import '../../../../../apps/web/app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../../../../../apps/web/app/styles/base.css';
import '@allrice/ui/styles.css';
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots';
import { Context } from '@deepseek-ai/cordis';
import { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import {
  EmployeePanelContent,
  EmployeePanelsEntries,
  useEmployeePanelsUnread,
} from '../../../src/employee-panels';
import { employeePanelKinds } from '../../../src/employee-panels-model';
import { installEmployeeProductOwner } from '../../../src/employee-product-owner';

const container = document.getElementById('app')!;
const sessionId = container.dataset.nativeSessionId as SessionIdOf;
const lifetime = new AbortController();
Object.assign(globalThis, { __ALLRICE_D_ENTRY_LIFETIME__: lifetime.signal });
const ctx = new Context();
let openPanel: ((kind: 'files' | 'materials') => void) | undefined;
// The independent BFF is exercised without starting a VM. Give the real
// panel the same mounted-session value that its native Dock supplies.
ctx.provide('sidebarRight', {
  mounted: {
    getSnapshot: () => sessionId,
    // This isolated panel document retains one mounted session.
    subscribe: () => () => {},
  },
  isExpanded: () => true,
  openTab(id: string) {
    if (id === employeePanelKinds.files) openPanel?.('files');
    if (id === employeePanelKinds.materials) openPanel?.('materials');
  },
} as unknown as Context['sidebarRight']);
const root = createRoot(container);
ctx.inject(['allriceEmployeePanels'], (scope) => {
  const binding = scope.allriceEmployeePanels;
  function App() {
    const [kind, setKind] = useState<'materials' | 'files'>('files');
    openPanel = setKind;
    const snapshot = useSyncExternalStore(
      (listener) => binding.port.subscribe(sessionId, listener),
      () => binding.port.getSnapshot(sessionId),
    );
    const filesUnread = useEmployeePanelsUnread(snapshot);
    return (
      <main aria-label="资料成果">
        {snapshot && (
          <nav aria-label="面板" data-unread={filesUnread ?? 'unknown'}>
            <EmployeePanelsEntries
              ctx={scope}
              binding={binding}
              sessionId={sessionId}
              snapshot={snapshot}
              filesUnread={filesUnread}
            />
          </nav>
        )}
        {snapshot && (
          <EmployeePanelContent
            key={kind}
            ctx={scope}
            binding={binding}
            sessionId={sessionId}
            snapshot={snapshot}
            signal={lifetime.signal}
            kind={kind}
          />
        )}
      </main>
    );
  }
  root.render(<App />);
});
installEmployeeProductOwner(ctx);
window.addEventListener(
  'pagehide',
  () => {
    lifetime.abort();
    root.unmount();
    void ctx.fiber.dispose();
  },
  { once: true },
);
