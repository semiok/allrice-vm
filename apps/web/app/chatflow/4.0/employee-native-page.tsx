'use client';

import { useEffect, useRef, useState } from 'react';
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  DEntryIdentityResultSchema,
  DEntrySelectionInputSchema,
  type DEntryNativePrewarmTicket,
  type DEntrySelectionInput,
} from '@allrice/contracts';
import {
  openNativePageCarrier,
  pendingPageResult,
} from '../../../lib/d-entry/page-carrier';
import {
  pageClosing,
  pageCompletion,
  pageDocumentReady,
  pageEditorMounted,
  pageNavigate,
  pageRevoked,
  pageStartupFailed,
} from '../../../lib/d-entry/page-messages';
import {
  EmployeeEntryError,
  employeeEntryQuery,
  prepareEmployeeEntry,
  prewarmEmployeeEntry,
  type EmployeePrewarmProgress,
} from '../../../lib/d-entry/entry-client';
import styles from './employee-native-page.module.css';

type Status =
  | 'warming'
  | 'accepted'
  | 'starting'
  | 'waiting-for-capacity'
  | 'opening'
  | 'ready'
  | 'cancelled'
  | 'failed'
  | 'asset-timeout'
  | 'selection-unavailable'
  | 'sign-in'
  | 'forbidden'
  | 'denied'
  | 'closing'
  | 'unknown';

// Only the browser's wait is bounded. The Worker owns each admitted VM start.
const entryWaitMs = 5 * 60_000;
const closingNoticeMs = 10_000;
const closingConfirmationMs = 60_000;

type EntryWarmup = {
  lifetime: AbortController;
  result: Promise<void>;
  progress: {
    current?: EmployeePrewarmProgress;
    ticket?: DEntryNativePrewarmTicket;
    show?(state: EmployeePrewarmProgress): void;
  };
};

async function waitForVisibleEntry(signal: AbortSignal) {
  signal.throwIfAborted();
  if (!document.hidden) return;
  await new Promise<void>((resolve, reject) => {
    const visible = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', visible);
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => reject(signal.reason);
    document.addEventListener('visibilitychange', visible, { signal });
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function EmployeeNativePage({
  query,
  prepare = false,
  initialUnavailable = false,
}: {
  query: string;
  prepare?: boolean;
  initialUnavailable?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const frameSelection = useRef<DEntrySelectionInput | undefined>(undefined);
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<Status>(
    initialUnavailable ? 'failed' : prepare && !query ? 'denied' : 'warming',
  );
  const [settled, setSettled] = useState(false);
  const [activation, setActivation] = useState<{
    query: string;
    confirmedQuery?: string;
    warmup?: EntryWarmup;
    retainFrame?: boolean;
    ticket?: DEntryNativePrewarmTicket;
  }>({ query });
  const activeQuery = activation.query;
  const loaded = useRef<((node: HTMLIFrameElement) => void) | undefined>(
    undefined,
  );
  const replace = useRef<(() => void) | undefined>(undefined);
  const cancel = useRef<(() => void) | undefined>(undefined);
  const resume = useRef<(() => void) | undefined>(undefined);
  const nextQuery = useRef(query);
  const lastPropQuery = useRef(query);
  if (lastPropQuery.current !== query) {
    lastPropQuery.current = query;
    nextQuery.current = query;
  }

  useEffect(() => {
    if (initialUnavailable || (prepare && !activeQuery)) {
      setStatus(initialUnavailable ? 'failed' : 'denied');
      setSettled(true);
      const changeSelection = () => setActivation({ query: nextQuery.current });
      replace.current = changeSelection;
      return () => {
        if (replace.current === changeSelection) replace.current = undefined;
      };
    }
    const lifetime = activation.warmup?.lifetime ?? new AbortController();
    let carrier: ReturnType<typeof openNativePageCarrier> | undefined;
    let scopeId: string | undefined;
    let navigating = false;
    let retired = false;
    let mounted = false;
    let documentStarted = false;
    let discardingPendingDocument = false;
    let navigationClosed = false;
    let remoteRevoked = false;
    let selectedQuery = activation.confirmedQuery;
    let selectedEmployee: DEntrySelectionInput | undefined;
    let nextWarmup: EntryWarmup | undefined;
    let pendingNavigation: { target: string; query: string } | undefined;
    let ticket = activation.ticket;
    let resumable = false;
    let superseded = false;
    let timer: number | undefined;
    let closingNotice: number | undefined;
    let closingConfirmation: number | undefined;
    let replacing: Promise<boolean> | undefined;
    let detached = false;
    const local = pendingPageResult<'closed' | 'unknown'>();
    const retainedDocument = activation.retainFrame
      ? frame.current?.contentDocument
      : undefined;
    if (!activation.retainFrame) {
      frameSelection.current = undefined;
      setSource(undefined);
    }
    setFailed(false);
    setStatus('warming');
    setSettled(false);
    const send = (type: string, state?: 'closed' | 'unknown') => {
      if (scopeId)
        frame.current?.contentWindow?.postMessage(
          { type, scopeId, state },
          location.origin,
        );
    };
    function close() {
      return carrier?.close().then(
        () => {
          send(pageCompletion, 'closed');
          return 'closed' as const;
        },
        () => {
          send(pageCompletion, 'unknown');
          return 'unknown' as const;
        },
      );
    }
    function matchesDocument(url: string) {
      const address = new URL(url);
      const path = '/chatflow/4.0/document';
      return (
        address.origin === location.origin &&
        ((address.pathname === path &&
          address.searchParams.getAll('scopeId').length === 1 &&
          address.searchParams.get('scopeId') === scopeId) ||
          address.pathname.startsWith(path + '/' + scopeId + '/'))
      );
    }
    function retire() {
      if (replacing) return replacing;
      if (prepare) {
        closingNotice = window.setTimeout(
          () => setStatus('closing'),
          closingNoticeMs,
        );
        // Loss of either completion signal must not leave a perpetual spinner
        // or enable a new page without the old page's actual close proof.
        closingConfirmation = window.setTimeout(
          () => setStatus('unknown'),
          closingConfirmationMs,
        );
      }
      replacing = (async () => {
        // A render change keeps the old iframe and its authenticated sender
        // attached until both halves have settled.
        if (!mounted || !frame.current) {
          // A dispatched open can be creating the irreversible native root.
          // Stop taking its result into the UI, then close after it settles.
          if (prepare && carrier?.dispatched)
            await carrier.ready.catch(() => {});
          lifetime.abort();
          const [remote] = await Promise.all([close(), setting]);
          return remote !== 'unknown';
        }
        send(pageRevoked);
        // Before the inline lifecycle runs there is no child to acknowledge
        // revoke. Observe a blank navigation before accepting local closure.
        if (!documentStarted) {
          try {
            const win = frame.current.contentWindow;
            const previous = frame.current.contentDocument;
            if (
              win &&
              previous &&
              (previous.URL === 'about:blank' ||
                previous === retainedDocument ||
                (matchesDocument(previous.URL) &&
                  !Reflect.get(win, '__ALLRICE_EMPLOYEE_DOCUMENT__')))
            ) {
              discardingPendingDocument = true;
              win.stop();
              win.location.replace('about:blank');
            }
          } catch {
            // An uninspectable child must supply its own completion.
          }
        }
        const [remote, entry] = await Promise.all([close(), local.promise]);
        return remote === 'closed' && entry === 'closed';
      })()
        .catch(() => false)
        .finally(() => {
          window.clearTimeout(closingNotice);
          window.clearTimeout(closingConfirmation);
        });
      return replacing;
    }
    function finish(
      status:
        | 'cancelled'
        | 'failed'
        | 'asset-timeout'
        | 'forbidden'
        | 'selection-unavailable'
        | 'sign-in',
      retainTicket = status === 'cancelled',
    ) {
      if (navigating || replace.current !== applyQuery) return;
      navigating = true;
      resumable = retainTicket;
      window.clearTimeout(timer);
      setStatus(status);
      void retire().then((closed) => {
        if (replace.current !== applyQuery) return;
        if (closed) {
          retired = true;
          if (nextQuery.current !== activeQuery) {
            activateSelection(nextQuery.current);
            return;
          }
          frameSelection.current = undefined;
          setSource(undefined);
          setStatus(status);
          setSettled(true);
        } else setStatus('unknown');
      });
    }
    function failedDocument(state: 'closed' | 'unknown') {
      local.resolve(state);
      if (prepare) finish('failed');
      else {
        setFailed(true);
        void close();
      }
    }
    const documentLoaded = (node: HTMLIFrameElement) => {
      if (!scopeId || node !== frame.current || !mounted) return;
      try {
        const doc = node.contentDocument;
        if (doc?.URL === 'about:blank') {
          if (discardingPendingDocument && !documentStarted)
            local.resolve('closed');
          return;
        }
        if (!doc) return failedDocument('unknown');
        const exact = matchesDocument(doc.URL);
        const child = node.contentWindow as
          | (Window & { __ALLRICE_EMPLOYEE_DOCUMENT__?: { scopeId: string } })
          | null;
        if (
          exact &&
          child?.__ALLRICE_EMPLOYEE_DOCUMENT__?.scopeId === scopeId
        ) {
          documentStarted = true;
          return;
        }
        if (discardingPendingDocument && exact && !documentStarted) return;
        // The two authenticated document handlers return a JSON problem
        // before any owned document exists. An uninspectable or changed
        // document has no equivalent local completion proof.
        failedDocument(
          exact && !documentStarted && doc.contentType === 'application/json'
            ? 'closed'
            : 'unknown',
        );
      } catch {
        failedDocument('unknown');
      }
    };
    loaded.current = documentLoaded;
    function activateSelection(query: string, warmup?: EntryWarmup) {
      const params = new URLSearchParams(query);
      const same = (key: 'workspaceId' | 'employeeInstanceId') =>
        params.getAll(key).length === 1 &&
        params.get(key) === frameSelection.current?.[key];
      setActivation({
        query,
        warmup,
        // The previous thread already joined. A fresh authorized document
        // can use the same frame without creating an outer navigation.
        retainFrame:
          !!frame.current && same('workspaceId') && same('employeeInstanceId'),
      });
    }
    const applyQuery = () => {
      if (navigating) {
        if (nextQuery.current !== activeQuery) {
          nextWarmup?.lifetime.abort();
          nextWarmup = undefined;
          superseded = true;
        }
        if (retired && nextQuery.current !== activeQuery)
          activateSelection(nextQuery.current);
        return;
      }
      navigating = true;
      window.clearTimeout(timer);
      void retire().then((closed) => {
        if (replace.current !== applyQuery) return;
        if (closed) activateSelection(nextQuery.current);
        else if (prepare) setStatus('unknown');
        else setFailed(true);
      });
    };
    replace.current = applyQuery;
    cancel.current = () => finish('cancelled');
    resume.current = () => {
      const query = nextQuery.current;
      setActivation({
        query,
        confirmedQuery: query === activeQuery ? selectedQuery : undefined,
        ticket:
          resumable && query === activeQuery
            ? (ticket ?? activation.warmup?.progress.ticket)
            : undefined,
      });
    };
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.current?.contentWindow ||
        !scopeId ||
        event.data?.scopeId !== scopeId
      )
        return;
      if (event.data.type === pageClosing) {
        navigationClosed = true;
        if (prepare && !navigating && !detached) finish('failed');
        else void close();
      }
      if (event.data.type === pageStartupFailed) {
        if (prepare)
          finish(
            event.data.reason === 'asset-timeout' ? 'asset-timeout' : 'failed',
          );
        else {
          setFailed(true);
          void close();
        }
      }
      if (event.data.type === pageDocumentReady) {
        documentStarted = true;
        if (replacing || remoteRevoked) send(pageRevoked);
      }
      if (
        event.data.type === pageEditorMounted &&
        prepare &&
        !navigating &&
        !remoteRevoked
      ) {
        window.clearTimeout(timer);
        setStatus('ready');
        if (
          selectedQuery &&
          location.pathname === '/chatflow/4.0' &&
          nextQuery.current === activeQuery
        )
          history.replaceState(
            history.state,
            '',
            '/chatflow/4.0?' + selectedQuery,
          );
      }
      if (
        event.data.type === pageCompletion &&
        ['closed', 'unknown'].includes(event.data.state)
      ) {
        navigationClosed = true;
        local.resolve(event.data.state);
      }
      if (event.data.type === pageNavigate) {
        const next = DEntrySelectionInputSchema.safeParse(event.data.selection);
        if (
          !next.success ||
          !carrier ||
          detached ||
          navigationClosed ||
          remoteRevoked ||
          superseded ||
          (navigating && !pendingNavigation)
        )
          return;
        if (
          !pendingNavigation &&
          next.data.threadId &&
          selectedEmployee?.threadId === next.data.threadId &&
          selectedEmployee.workspaceId === next.data.workspaceId &&
          selectedEmployee.employeeInstanceId === next.data.employeeInstanceId
        )
          return;
        const params = new URLSearchParams(
          Object.entries(next.data).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
        // Untagged rootless messages are the existing explicit New action.
        // A card click or newly created employee reopens any concurrent first thread.
        const newThread =
          prepare && !next.data.threadId && event.data.reopen !== true;
        const target = params.toString() + (newThread ? '&new' : '');
        if (pendingNavigation?.target === target) return;
        if (newThread) params.set('new', crypto.randomUUID());
        const duringClose = !!pendingNavigation;
        pendingNavigation = { target, query: params.toString() };
        if (duringClose) {
          // The first target may have an overlapping prewarm. Only the latest
          // target can consume one, and the old carrier is still joining.
          nextWarmup?.lifetime.abort();
          nextWarmup = undefined;
          return;
        }
        navigating = true;
        window.clearTimeout(timer);
        const sameEmployee =
          prepare &&
          location.pathname === '/chatflow/4.0' &&
          selectedEmployee?.workspaceId === next.data.workspaceId &&
          selectedEmployee.employeeInstanceId === next.data.employeeInstanceId;
        if (sameEmployee && !document.hidden) {
          // A navigation from this verified employee can start qualification
          // for the selected thread while the old page joins its transport.
          // This request has no page-carrier or thread-creation side effect.
          const lifetime = new AbortController();
          const progress: EntryWarmup['progress'] = {};
          const result = prewarmEmployeeEntry(next.data, lifetime.signal, {
            accepted: (ticket) => {
              progress.ticket = ticket;
            },
            progress(state) {
              progress.current = state;
              progress.show?.(state);
            },
          });
          void result.catch(() => {}); // the next activation reports the result
          nextWarmup = { lifetime, result, progress };
        }
        // Both messages refer only to this exact iframe and page scope. The
        // carrier completion proves the remote side; terminate local entry
        // work independently and keep the frame until both report back.
        void retire().then((closed) => {
          if (replace.current !== applyQuery || detached) return;
          const query = pendingNavigation!.query;
          pendingNavigation = undefined;
          const warmup = nextWarmup;
          nextWarmup = undefined;
          if (closed) {
            if (superseded || nextQuery.current !== activeQuery) {
              warmup?.lifetime.abort();
              activateSelection(nextQuery.current);
            } else if (prepare && location.pathname === '/chatflow/4.0') {
              nextQuery.current = query;
              if (location.search !== '?' + query)
                history.pushState(null, '', '/chatflow/4.0?' + query);
              activateSelection(query, warmup);
            } else location.assign('/chatflow/4.0?' + query);
          } else {
            warmup?.lifetime.abort();
            if (prepare) setStatus('unknown');
            else setFailed(true);
          }
        });
      }
    };
    window.addEventListener('message', receive);
    const leaving = () => {
      if (detached) return;
      detached = true;
      nextWarmup?.lifetime.abort();
      lifetime.abort();
      send(pageRevoked);
      if (prepare && carrier?.dispatched && !scopeId)
        void carrier.ready.catch(() => {}).then(close);
      else void close();
    };
    window.addEventListener('pagehide', leaving);
    const restoreQuery = () => {
      if (location.pathname !== '/chatflow/4.0') return;
      nextQuery.current = location.search.slice(1);
      if (nextQuery.current !== activeQuery) applyQuery();
    };
    window.addEventListener('popstate', restoreQuery);
    const parsedEntry = Promise.resolve().then(() =>
      employeeEntryQuery(activation.confirmedQuery ?? activeQuery, prepare),
    );
    // The shell owns only its wait; the Worker owns an accepted cold start.
    const showPrewarm = (state: EmployeePrewarmProgress) => {
      if (!lifetime.signal.aborted && !navigating)
        setStatus(activation.retainFrame ? 'warming' : state);
    };
    const prewarming = prepare
      ? parsedEntry.then(async ({ selection }) => {
          await waitForVisibleEntry(lifetime.signal);
          lifetime.signal.throwIfAborted();
          if (activation.warmup) {
            const { progress, result } = activation.warmup;
            progress.show = showPrewarm;
            if (progress.current) showPrewarm(progress.current);
            await result;
          } else
            await prewarmEmployeeEntry(selection, lifetime.signal, {
              ticket,
              accepted: (accepted) => {
                ticket = accepted;
              },
              progress: showPrewarm,
            });
        })
      : undefined;
    void prewarming?.catch(() => {}); // setup reports the same rejection.
    const setup = async () => {
      const entry = await parsedEntry;
      const selection = prepare
        ? await prepareEmployeeEntry(
            entry,
            lifetime.signal,
            () => {
              ticket = undefined;
              if (activation.warmup)
                activation.warmup.progress.ticket = undefined;
              setStatus('opening');
              timer = window.setTimeout(() => finish('failed'), entryWaitMs);
            },
            prewarming,
          )
        : entry.selection;
      const { params } = entry;
      if (selection.threadId && !entry.selection.threadId)
        params.set('threadId', selection.threadId);
      if (prepare && selection.threadId) selectedQuery = params.toString();
      const response = await fetch('/api/v1/d-entry/identity?' + params, {
        signal: lifetime.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new EmployeeEntryError(response.status);
      const { identity } = DEntryIdentityResultSchema.parse(
        await response.json(),
      );
      lifetime.signal.throwIfAborted();
      if (
        identity.workspaceId !== selection.workspaceId ||
        identity.employeeInstanceId !== selection.employeeInstanceId ||
        identity.threadId !== (selection.threadId ?? null)
      )
        throw new EmployeeEntryError(403, 'response-mismatch');
      carrier = openNativePageCarrier(identity, selection, () => {
        remoteRevoked = true;
        send(pageRevoked);
        if (!prepare && !lifetime.signal.aborted) setFailed(true);
        // Before issuance, ready's rejection is handled by setting below.
        if (prepare && mounted) finish('failed');
      });
      const issued = (await carrier.ready).scopeReference;
      scopeId = issued.scopeId;
      lifetime.signal.throwIfAborted();
      if (navigating) return;
      selectedEmployee = selection;
      frameSelection.current = selection;
      params.set('scopeId', issued.scopeId);
      mounted = true;
      const documentUrl = '/chatflow/4.0/document?' + params;
      const retainedWindow = activation.retainFrame
        ? frame.current?.contentWindow
        : undefined;
      if (retainedWindow) retainedWindow.location.replace(documentUrl);
      else setSource(documentUrl);
    };
    const setting = setup().catch((error: unknown) => {
      if (lifetime.signal.aborted) return;
      if (!prepare) return setFailed(true);
      if (!(error instanceof EmployeeEntryError)) return finish('failed');
      const responseMismatch = error.reason === 'response-mismatch';
      if (error.status === 401) finish('sign-in');
      else if (error.status === 403 && !responseMismatch) finish('forbidden');
      else if (responseMismatch || [400, 404].includes(error.status))
        finish('selection-unavailable');
      else finish('failed', error.status === 408);
    });
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(closingNotice);
      window.clearTimeout(closingConfirmation);
      if (activation.warmup) activation.warmup.progress.show = undefined;
      leaving();
      if (loaded.current === documentLoaded) loaded.current = undefined;
      if (replace.current === applyQuery) replace.current = undefined;
      cancel.current = undefined;
      resume.current = undefined;
      window.removeEventListener('message', receive);
      window.removeEventListener('pagehide', leaving);
      window.removeEventListener('popstate', restoreQuery);
    };
  }, [activation, activeQuery, prepare, initialUnavailable]);

  useEffect(() => {
    if (nextQuery.current !== activeQuery) replace.current?.();
  }, [query, activeQuery]);

  return (
    <main data-employee-selection={activeQuery}>
      {source && (
        <iframe
          ref={frame}
          title="员工工作区"
          src={source}
          onLoad={(event) => loaded.current?.(event.currentTarget)}
          referrerPolicy="no-referrer"
          className={
            prepare && status !== 'ready' ? styles.startingFrame : undefined
          }
          style={{
            display: 'block',
            width: '100%',
            height: '100dvh',
            border: 0,
          }}
        />
      )}
      {prepare && status !== 'ready' && (
        <EntryStatus
          status={status}
          settled={initialUnavailable || settled}
          stop={() => cancel.current?.()}
          retry={() => {
            if (initialUnavailable) location.reload();
            else resume.current?.();
          }}
        />
      )}
      {!prepare && failed && <p role="alert">当前入口暂不可用</p>}
    </main>
  );
}

const messages = {
  warming: ['正在打开对话', '马上就好。'],
  accepted: ['正在准备你的工作台', '准备好会自动打开对话。'],
  starting: ['正在启动工作台', '第一次启动需要一两分钟，留在这页就行。'],
  'waiting-for-capacity': [
    '正在等待工作台名额',
    '已有 4 个员工在运行。有空位会自动继续，也可以取消等待。',
  ],
  opening: ['工作台已就绪', '正在打开对话。'],
  failed: ['暂时打不开工作台', '可以点重试，或者返回员工页。'],
  'asset-timeout': [
    '工作台资源下载超时',
    '自动重试后仍未下载完成，可以点重试。',
  ],
  cancelled: ['已取消等待', '可以继续打开工作台。'],
  'selection-unavailable': ['暂时打不开这条对话', '可以返回员工页重选。'],
  'sign-in': ['请重新登录', '登录后再打开工作台。'],
  forbidden: ['当前请求未获授权', '请确认登录账号和工作区权限。'],
  denied: ['当前账号无法打开这个工作台', '请确认登录账号和工作区权限。'],
  closing: ['正在结束上一次连接', '旧连接结束后可以继续。'],
  unknown: ['暂时无法打开工作台', '无法确认旧连接已关闭。'],
} as const;

function EntryStatus({
  status,
  settled,
  stop,
  retry,
}: {
  status: Exclude<Status, 'ready'>;
  settled: boolean;
  stop(): void;
  retry(): void;
}) {
  const [title, description] = messages[status];
  // The current prewarm protocol does not report this reason. Render it only
  // when a future caller has an authoritative capacity-wait status.
  const starting = [
    'warming',
    'accepted',
    'starting',
    'waiting-for-capacity',
    'opening',
  ].includes(status);
  const failedOpening = status === 'failed' || status === 'asset-timeout';
  const resumable = status === 'cancelled' || failedOpening;
  const canReturn = status === 'failed' || status === 'selection-unavailable';
  const attention =
    failedOpening ||
    [
      'selection-unavailable',
      'sign-in',
      'forbidden',
      'denied',
      'unknown',
    ].includes(status);
  return (
    <div className={styles.status}>
      <section>
        <div role={attention ? 'alert' : 'status'} aria-atomic="true">
          {starting && <StateDot state="ongoing" size={28} />}
          <h1>{title}</h1>
          <p>{description}</p>
          {failedOpening && (
            <p>如果一直打不开，请关闭浏览器扩展或者用无痕窗口再试</p>
          )}
        </div>
        {starting && (
          <button type="button" onClick={stop}>
            取消等待
          </button>
        )}
        {resumable && (
          <button type="button" disabled={!settled} onClick={retry}>
            {status === 'cancelled' ? '继续' : '重试'}
          </button>
        )}
        {canReturn && settled && <a href="/chatflow/4.0">返回员工页</a>}
        {status === 'sign-in' && settled && (
          <a href="/login?next=%2Fchatflow%2F4.0">重新登录</a>
        )}
      </section>
    </div>
  );
}
