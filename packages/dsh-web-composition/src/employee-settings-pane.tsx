import type { Context } from '@deepseek-ai/cordis';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { flushSync } from 'react-dom';
import {
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { AccountPasswordSettings } from '../../../apps/web/app/chatflow/account-password-settings';
import { SidebarSettingsButton } from '../../../apps/web/app/chatflow/sidebar-settings-trigger';
import { type EmployeeWorkbenchSettingsPort } from './employee-settings-port';
import styles from './employee-settings.module.css';

const settingsTab = 'allrice-employee-settings';

async function goToLogin(signal: AbortSignal) {
  const response = await fetch('/api/v1/auth/session', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!signal.aborted && response.status === 401)
    window.top?.location.replace('/chatflow/4.0');
  else if (!signal.aborted && !response.ok) throw Error('Login check failed');
}

function AccountActions({
  loginSessionId,
  signal,
}: {
  loginSessionId: string;
  signal: AbortSignal;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function logout() {
    if (pending || signal.aborted) return;
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch('/api/v1/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-allrice-expected-session-id': loginSessionId },
        signal,
      });
      if (signal.aborted) return;
      if (!response.ok) throw Error('Logout failed');
      await goToLogin(signal);
    } catch {
      if (signal.aborted) return;
      setFailed(true);
      setPending(false);
    }
  }
  return (
    <section aria-label="AllRice 账号">
      <AccountPasswordSettings
        scope={{
          sessionId: loginSessionId,
          signal,
          onChanged: () => goToLogin(signal),
        }}
      />
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => void logout()}
      >
        {pending ? '正在退出…' : '退出登录'}
      </Button>
      {failed && <p role="alert">退出登录失败，请重试。</p>}
    </section>
  );
}

function SettingsPane({
  port,
  signal,
  openNative,
}: {
  port: EmployeeWorkbenchSettingsPort;
  signal: AbortSignal;
  openNative: () => void;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <section className={styles.pane} aria-label="设置">
      <h2 className={styles.paneHeading}>设置</h2>
      <Button
        className={styles.paneEntry}
        variant="outline"
        aria-expanded={accountOpen}
        onClick={() => {
          if (!signal.aborted) setAccountOpen((open) => !open);
        }}
      >
        AllRice 账号
      </Button>
      {accountOpen && (
        <AccountActions loginSessionId={port.loginSessionId} signal={signal} />
      )}
      <Button
        className={styles.paneEntry}
        variant="outline"
        onClick={openNative}
      >
        通用设置 ↗
      </Button>
    </section>
  );
}

/** SettingsRoot supplies the live launcher; the native Dock owns the right tab. */
export function applyEmployeeSettingsPane(ctx: Context) {
  ctx.inject(
    [
      'allriceEmployeeWorkbenchSettings',
      'sidebarRightTabs',
      'sidebarRight',
      'layout',
    ],
    (scope) => {
      const port = scope.allriceEmployeeWorkbenchSettings;
      const lifetime = new AbortController();
      const signal = AbortSignal.any([port.signal, lifetime.signal]);
      const right = scope.sidebarRight;
      const current = () => {
        const mounted = right.mounted.getSnapshot();
        return !signal.aborted && mounted && port.isCurrentRoot(mounted)
          ? mounted
          : undefined;
      };
      const globalPanel = () =>
        scope.layout.panelInfo.getSnapshot().activePanelId !== null;
      const canOpenPane = () =>
        !signal.aborted && (current() !== undefined || globalPanel());
      const subscribe = (listener: () => void) => {
        const dispose = right.mounted.subscribe(listener);
        const disposeLayout = scope.layout.panelInfo.subscribe(listener);
        const disposeOwner = port.subscribe(listener);
        signal.addEventListener('abort', listener, { once: true });
        return () => {
          dispose();
          disposeLayout();
          disposeOwner();
          signal.removeEventListener('abort', listener);
        };
      };
      let launcher: { open: () => void } | undefined;
      scope.effect(() => () => lifetime.abort());
      function Launcher({ wide, openSettings }: SettingsLauncherOwnerProps) {
        const live = useSyncExternalStore(subscribe, canOpenPane);
        useLayoutEffect(() => {
          const binding = { open: openSettings };
          launcher = binding;
          return () => {
            if (launcher === binding) launcher = undefined;
          };
        }, [openSettings]);
        if (!live) return null;
        return (
          <SidebarSettingsButton
            collapsed={!wide}
            dialog={false}
            onOpen={() => {
              if (!canOpenPane()) return;
              // The Dock belongs to the current conversation, even when
              // the sidebar is showing a global page such as schedules.
              if (globalPanel())
                flushSync(() => scope.layout.selectPanel(null));
              if (current()) right.openTab(settingsTab);
            }}
          />
        );
      }
      function Pane({
        sessionId,
        useTabInfo,
      }: PropsRuntime<'sidebar.right.pane.tab'>) {
        const selected = useSyncExternalStore(subscribe, current);
        const { tab } = useTabInfo();
        const paneSignal = useMemo(
          () => AbortSignal.any([signal, tab.signal]),
          [tab.signal],
        );
        if (selected !== sessionId || !tab.visible || tab.signal.aborted)
          return null;
        return (
          <SettingsPane
            port={port}
            signal={paneSignal}
            openNative={() => {
              if (current() === sessionId && !tab.signal.aborted)
                launcher?.open();
            }}
          />
        );
      }
      scope.effect(() =>
        scope.sidebarRightTabs.register({
          id: settingsTab,
          kind: settingsTab,
          title: () => '设置',
        }),
      );
      scope.slots.inject('settings.launcher', () =>
        scope.slots.register(
          { name: 'settings.launcher', priority: -100 },
          Launcher,
        ),
      );
      scope.slots.inject('sidebar.right.pane.tab', () =>
        scope.slots.register(
          { name: 'sidebar.right.pane.tab', key: settingsTab },
          Pane,
        ),
      );
    },
  );
}
