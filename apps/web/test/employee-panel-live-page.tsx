// Isolated document host for a browser test. Business authority and data are
// supplied by the original Cookie and production Web handlers.
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '@allrice/ui/styles.css';
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots';
import { Context } from '@deepseek-ai/cordis';
import { useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { EmployeePanelContent } from '../../../packages/dsh-web-composition/src/employee-panels';
import { installEmployeeProductOwner } from '../../../packages/dsh-web-composition/src/employee-product-owner';

const container = document.getElementById('app')!;
const sessionId = container.dataset.nativeSessionId as SessionIdOf;
const lifetime = new AbortController();
Object.assign(globalThis, { __ALLRICE_D_ENTRY_LIFETIME__: lifetime.signal });
const ctx = new Context();
// The independent BFF is exercised without starting a VM. Give the real
// panel the same mounted-session value that its native Dock supplies.
ctx.provide('sidebarRight', {
  mounted: { getSnapshot: () => sessionId },
} as unknown as Context['sidebarRight']);
const root = createRoot(container);
ctx.inject(['allriceEmployeePanels'], (scope) => {
  const binding = scope.allriceEmployeePanels;
  function App() {
    const [kind, setKind] = useState<'materials' | 'files'>('files');
    const snapshot = useSyncExternalStore(
      (listener) => binding.port.subscribe(sessionId, listener),
      () => binding.port.getSnapshot(sessionId),
    );
    return (
      <main aria-label="资料成果">
        <nav aria-label="面板">
          <button onClick={() => setKind('files')}>交付成果</button>
          <button onClick={() => setKind('materials')}>企业资料</button>
        </nav>
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
