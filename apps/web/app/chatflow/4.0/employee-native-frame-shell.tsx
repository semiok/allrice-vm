'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { DEntrySelectionInput } from '@allrice/contracts';
import { employeeEntryQuery } from '../../../lib/d-entry/entry-client';
import {
  emptyEmployeeFramePool,
  updateEmployeeFramePool,
  type EmployeeFrame,
  employeeFrameLimit,
} from '../../../lib/d-entry/employee-frame-pool';
import { createEmployeeMemoryPageWrites } from '../../../lib/memory/employee-memory-page-writes';
import styles from './employee-native-page.module.css';

type Controller = {
  retire(): Promise<boolean>;
  element(): HTMLIFrameElement | null;
  select(selection: DEntrySelectionInput, reopen: boolean): void;
  restore(query: string): void;
};

export type EmployeeFrameOwner = {
  visible(): boolean;
  ready(): boolean;
  activate(query: string, loginSessionId: string | undefined): void;
  register(controller: Controller): () => void;
  navigate(
    selection: DEntrySelectionInput,
    reopen: boolean,
    resumeEmployee: boolean,
  ): void;
  route(query: string, push: boolean): void;
  revoked(): void;
  bindMemoryWrites: ReturnType<typeof createEmployeeMemoryPageWrites>;
};

type Intent = {
  selection: DEntrySelectionInput;
  query: string;
  reopen?: boolean;
  resumeEmployee?: boolean;
  fromHistory?: boolean;
};

const entryPath = '/chatflow/4.0';
const chatBody = '[data-conversation-region="chat"]';

export function readFrameIntent(query: string): Intent | undefined {
  try {
    return { selection: employeeEntryQuery(query, true).selection, query };
  } catch {
    return undefined;
  }
}

export function EmployeeNativeFrameShell({
  initial,
  renderFrame,
  fallback,
}: {
  initial: Intent;
  renderFrame(
    frame: EmployeeFrame,
    owner: EmployeeFrameOwner,
    pendingArea: HTMLElement | null,
  ): ReactNode;
  fallback(state: 'failed' | 'unknown'): ReactNode;
}) {
  const [pool, setPool] = useState(() =>
    updateEmployeeFramePool(emptyEmployeeFramePool(), {
      type: 'select',
      request: initial,
    }),
  );
  const current = useRef(pool);
  const lastIntent = useRef(initial);
  const propQuery = useRef(initial.query);
  const directory = useRef(
    new Map<number, { controller: Controller; query: string }>(),
  );
  const [bindMemoryWrites] = useState(createEmployeeMemoryPageWrites);
  const [pendingArea, setPendingArea] = useState<HTMLElement | null>(null);
  const [unavailable, setUnavailable] = useState<'failed' | 'unknown'>(
    'failed',
  );
  const lifetime = useRef<AbortController | null>(null);
  const verifyLogin = useRef<Promise<void> | undefined>(undefined);
  const loginSessionId = useRef<string | undefined>(undefined);
  const replacingLogin = useRef(false);
  const shownBefore = useRef(new Set<number>());

  const update = useCallback(
    (action: Parameters<typeof updateEmployeeFramePool>[1]) => {
      const next = updateEmployeeFramePool(current.current, action);
      if (next !== current.current) {
        current.current = next;
        setPool(next);
      }
      return next;
    },
    [],
  );

  function reportURL(query: string, push: boolean) {
    if (location.pathname !== entryPath || location.search === '?' + query)
      return;
    if (push) history.pushState(history.state, '', entryPath + '?' + query);
    else history.replaceState(history.state, '', entryPath + '?' + query);
  }

  const publish = useCallback((id: number, intent: Intent, push: boolean) => {
    const record = directory.current.get(id);
    if (!record) return;
    if (intent.fromHistory) {
      if (record.query !== intent.query)
        record.controller.restore(intent.query);
      return;
    }
    reportURL(record.query, push);
    const selected = readFrameIntent(record.query);
    if (
      selected &&
      !intent.resumeEmployee &&
      (intent.selection.threadId !== selected.selection.threadId ||
        !intent.selection.threadId)
    )
      record.controller.select(intent.selection, !!intent.reopen);
  }, []);

  const request = useCallback(
    (intent: Intent) => {
      if (replacingLogin.current) return;
      lastIntent.current = intent;
      const previous = current.current.visible;
      const next = update({ type: 'select', request: intent });
      if (next.visible !== undefined && !next.wanted)
        publish(next.visible, intent, previous !== next.visible);
    },
    [publish, update],
  );

  useEffect(() => {
    const signal = new AbortController();
    lifetime.current = signal;
    const onPop = () => {
      if (location.pathname !== entryPath) return;
      const intent = readFrameIntent(location.search.slice(1));
      if (intent) request({ ...intent, fromHistory: true });
    };
    window.addEventListener('popstate', onPop, { signal: signal.signal });
    return () => {
      signal.abort();
      lifetime.current = null;
    };
  }, [request]);

  useEffect(() => {
    if (propQuery.current !== initial.query) {
      propQuery.current = initial.query;
      request({ ...initial, fromHistory: true });
    }
  }, [initial, request]);

  const resetLogin = useCallback(() => {
    replacingLogin.current = true;
    update({ type: 'reset' });
  }, [update]);

  useEffect(() => {
    if (
      replacingLogin.current &&
      !pool.frames.some((frame) => frame.phase === 'closing')
    )
      location.replace(entryPath);
  }, [pool]);

  const driver = useMemo(
    () => ({
      visible(id: number) {
        return current.current.visible === id;
      },
      ready(id: number) {
        return current.current.frames.some(
          (frame) => frame.id === id && frame.phase === 'ready',
        );
      },
      activate(id: number, query: string, sessionId: string | undefined) {
        const record = directory.current.get(id);
        if (!record) return;
        if (
          sessionId &&
          loginSessionId.current &&
          loginSessionId.current !== sessionId
        ) {
          resetLogin();
          return;
        }
        loginSessionId.current ??= sessionId;
        record.query = query;
        const previous = current.current.visible;
        const next = update({ type: 'ready', id });
        if (next.visible === id) {
          reportURL(
            query,
            previous !== undefined &&
              previous !== id &&
              !lastIntent.current.fromHistory,
          );
        }
      },
      register(id: number, query: string, controller: Controller) {
        const record = { controller, query };
        directory.current.set(id, record);
        return () => {
          if (directory.current.get(id) === record)
            directory.current.delete(id);
        };
      },
      route(id: number, query: string, push: boolean) {
        const record = directory.current.get(id);
        if (record) record.query = query;
        if (current.current.visible === id) reportURL(query, push);
      },
      revoked(id: number) {
        const currentFrame = current.current.frames.find(
          (frame) => frame.id === id,
        );
        if (!currentFrame || currentFrame.phase !== 'ready') return;
        update({ type: 'invalidate', id });
        if (verifyLogin.current || !lifetime.current) return;
        const signal = lifetime.current.signal;
        verifyLogin.current = fetch('/api/v1/auth/session', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal,
        })
          .then(async (response) => {
            const value = response.ok ? await response.json() : undefined;
            if (signal.aborted) return;
            if (
              response.status === 401 ||
              (loginSessionId.current &&
                typeof value?.context?.sessionId === 'string' &&
                value.context.sessionId !== loginSessionId.current)
            ) {
              resetLogin();
            }
          })
          .catch(() => {})
          .finally(() => {
            verifyLogin.current = undefined;
          });
      },
      navigate(
        selection: DEntrySelectionInput,
        reopen: boolean,
        resumeEmployee: boolean,
      ) {
        const params = new URLSearchParams({
          workspaceId: selection.workspaceId,
          employeeInstanceId: selection.employeeInstanceId,
        });
        if (selection.threadId) params.set('threadId', selection.threadId);
        if (!selection.threadId && !reopen)
          params.set('new', crypto.randomUUID());
        request({
          selection,
          query: params.toString(),
          reopen,
          resumeEmployee,
        });
      },
      joined(id: number, confirmed: boolean) {
        shownBefore.current.delete(id);
        if (!confirmed) setUnavailable('unknown');
        update({ type: 'joined', id, confirmed });
      },
      bindMemoryWrites,
    }),
    [bindMemoryWrites, request, resetLogin, update],
  );

  const opening = pool.frames.find((frame) => frame.phase === 'opening');
  const foreground = pool.visible ?? opening?.id;
  const wanted = pool.wanted;
  const pending = pool.visible !== undefined && !!wanted;
  const blocked =
    !!wanted &&
    (pool.frames.some(
      (frame) =>
        frame.phase === 'unconfirmed' &&
        frame.selection.employeeInstanceId ===
          wanted.selection.employeeInstanceId,
    ) ||
      (pool.frames.length === employeeFrameLimit &&
        pool.frames.every(
          (frame) => frame.phase === 'unconfirmed' || frame.id === pool.visible,
        )));
  useLayoutEffect(() => {
    if (!pending || pool.visible === undefined) return;
    const frame = directory.current.get(pool.visible)?.controller.element();
    const doc = frame?.contentDocument;
    const area = doc?.querySelector<HTMLElement>(chatBody);
    if (!doc?.body || !area) return;
    const mount = doc.createElement('div');
    mount.dataset.employeeTransition = '';
    Object.assign(mount.style, {
      position: 'fixed',
      display: 'grid',
      placeItems: 'center',
      background: 'var(--ar-surface, var(--dsw-alias-bg-base))',
      color: 'var(--ar-text-secondary, var(--dsw-alias-label-secondary))',
      zIndex: '1',
    });
    const measure = () => {
      const rect = area.getBoundingClientRect();
      Object.assign(mount.style, {
        left: rect.x + 'px',
        top: rect.y + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
      });
    };
    const inert = area.inert;
    area.inert = true;
    doc.body.append(mount);
    measure();
    const layout = new ResizeObserver(measure);
    layout.observe(area);
    frame?.contentWindow?.addEventListener('resize', measure);
    setPendingArea(mount);
    return () => {
      layout.disconnect();
      frame?.contentWindow?.removeEventListener('resize', measure);
      area.inert = inert;
      mount.remove();
      setPendingArea(null);
    };
  }, [pending, pool.visible]);

  useLayoutEffect(() => {
    for (const [id, record] of directory.current) {
      const root =
        record.controller.element()?.contentDocument?.documentElement;
      if (root) root.inert = id !== pool.visible;
    }
    if (pool.visible === undefined) return;
    const frame = directory.current.get(pool.visible)?.controller.element();
    if (!frame) return;
    if (shownBefore.current.has(pool.visible)) {
      frame.contentDocument
        ?.querySelector<HTMLElement>(
          '[data-composer-input][contenteditable="true"]',
        )
        ?.focus({ preventScroll: true });
    }
    if (document.activeElement !== frame) frame.focus({ preventScroll: true });
    shownBefore.current.add(pool.visible);
  }, [pool.visible]);

  return (
    <div className={styles.framePool}>
      {pool.frames
        .filter((frame) => frame.phase !== 'unconfirmed')
        .map((frame) => (
          <FrameSlot
            key={frame.id}
            frame={frame}
            driver={driver}
            shown={frame.id === foreground}
            pendingArea={
              frame.id === opening?.id && pending ? pendingArea : null
            }
            renderFrame={renderFrame}
          />
        ))}
      {foreground === undefined && fallback(unavailable)}
      {pendingArea &&
        (!opening || blocked) &&
        pending &&
        renderVacancy(pendingArea, blocked)}
    </div>
  );
}

function renderVacancy(target: HTMLElement, unconfirmed: boolean) {
  return createPortal(
    unconfirmed ? (
      <div role="alert">
        无法确认旧连接已关闭。{' '}
        <button type="button" onClick={() => location.reload()}>
          刷新页面
        </button>
      </div>
    ) : (
      <div role="status">正在打开工作台</div>
    ),
    target,
  );
}

type Driver = {
  visible(id: number): boolean;
  ready(id: number): boolean;
  activate(id: number, query: string, loginSessionId: string | undefined): void;
  register(id: number, query: string, controller: Controller): () => void;
  route(id: number, query: string, push: boolean): void;
  revoked(id: number): void;
  navigate(
    selection: DEntrySelectionInput,
    reopen: boolean,
    resumeEmployee: boolean,
  ): void;
  joined(id: number, confirmed: boolean): void;
  bindMemoryWrites: ReturnType<typeof createEmployeeMemoryPageWrites>;
};

function FrameSlot({
  frame,
  driver,
  shown,
  pendingArea,
  renderFrame,
}: {
  frame: EmployeeFrame;
  driver: Driver;
  shown: boolean;
  pendingArea: HTMLElement | null;
  renderFrame(
    frame: EmployeeFrame,
    owner: EmployeeFrameOwner,
    pendingArea: HTMLElement | null,
  ): ReactNode;
}) {
  const controller = useRef<Controller | undefined>(undefined);
  const owner = useMemo<EmployeeFrameOwner>(
    () => ({
      visible: () => driver.visible(frame.id),
      ready: () => driver.ready(frame.id),
      activate: (query, loginSessionId) =>
        driver.activate(frame.id, query, loginSessionId),
      register(control) {
        controller.current = control;
        const unregister = driver.register(frame.id, frame.query, control);
        return () => {
          if (controller.current === control) controller.current = undefined;
          unregister();
        };
      },
      navigate: driver.navigate,
      route: (query, push) => driver.route(frame.id, query, push),
      revoked: () => driver.revoked(frame.id),
      bindMemoryWrites: driver.bindMemoryWrites,
    }),
    [driver, frame.id, frame.query],
  );
  const retiring = useRef(false);
  useEffect(() => {
    if (frame.phase !== 'closing' || retiring.current) return;
    retiring.current = true;
    void (controller.current?.retire() ?? Promise.resolve(true)).then(
      (confirmed) => driver.joined(frame.id, confirmed),
      () => driver.joined(frame.id, false),
    );
  }, [driver, frame.id, frame.phase]);
  return (
    <div
      className={shown ? styles.foregroundFrame : styles.backgroundFrame}
      inert={!shown}
      aria-hidden={!shown || undefined}
    >
      {renderFrame(frame, owner, pendingArea)}
    </div>
  );
}
