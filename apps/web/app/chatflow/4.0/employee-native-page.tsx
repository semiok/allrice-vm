'use client';

import { useEffect, useRef, useState } from 'react';
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  DEntrySelectionInputSchema,
  type DEntryIdentity,
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
  pageMuxAttach,
  pageNavigate,
  pageSwitchReady,
  pageThreadScope,
  pageThreadSwitchCancel,
  pageThreadSwitchPrepare,
  pageThreadSwitchPrepared,
  pageThreadSelected,
  pageNativeThreadSelected,
  pageRevoked,
  pageStartupFailed,
} from '../../../lib/d-entry/page-messages';
import {
  cancelEmployeeCapacityWait,
  EmployeeEntryError,
  employeeEntryQuery,
  prepareEmployeeEntry,
  prewarmEmployeeEntry,
  readEmployeeEntryIdentity,
  type EmployeePrewarmProgress,
} from '../../../lib/d-entry/entry-client';
import { warmPublicProfileAssets } from '../../../lib/d-entry/public-profile-warmup';
import { createEmployeeMemoryPageWrites } from '../../../lib/memory/employee-memory-page-writes';
import styles from './employee-native-page.module.css';

const noStartupAssets: readonly string[] = [];

type Status =
  | 'warming'
  | 'accepted'
  | 'starting'
  | 'restarting'
  | 'waiting-for-capacity'
  | 'restart-confirmation'
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
const warmUpgradeWaitMs = 3_000;
const liveSwitchWaitMs = 10_000;
const closingNoticeMs = 10_000;
const closingConfirmationMs = 60_000;

type ThreadHandoff = {
  selection: DEntrySelectionInput & { threadId: string };
  requestId: string;
  submitted?: boolean;
  scopeId?: string;
  restored?: boolean;
};

type EntryWarmup = {
  selection: DEntrySelectionInput;
  lifetime: AbortController;
  result: Promise<void>;
  stopAssetDownloads(): void;
  readIdentity():
    Awaited<ReturnType<typeof readEmployeeEntryIdentity>> | undefined;
  progress: {
    current?: { state: EmployeePrewarmProgress; activeLimit?: number };
    ticket?: DEntryNativePrewarmTicket;
    show?(state: EmployeePrewarmProgress, activeLimit?: number): void;
  };
};

function startEntryWarmup(
  selection: DEntrySelectionInput,
  lifetime: AbortController,
  startupAssetUrls: readonly string[],
  ticket?: DEntryNativePrewarmTicket,
  foregroundOpen?: boolean,
): EntryWarmup {
  const progress: EntryWarmup['progress'] = {};
  const assets = new AbortController();
  let identity: ReturnType<EntryWarmup['readIdentity']>;
  const result = prewarmEmployeeEntry(selection, lifetime.signal, {
    ticket,
    trigger: foregroundOpen ? 'open' : 'page',
    ready(checked) {
      if (selection.threadId) identity = checked;
    },
    accepted(accepted) {
      progress.ticket = accepted;
      void warmPublicProfileAssets(
        startupAssetUrls,
        AbortSignal.any([lifetime.signal, assets.signal]),
      );
    },
    progress(state, activeLimit) {
      progress.current = { state, activeLimit };
      progress.show?.(state, activeLimit);
    },
  });
  void result.catch(() => {}); // setup reports the result for this selection.
  return {
    selection,
    lifetime,
    result,
    progress,
    stopAssetDownloads: () => assets.abort(),
    readIdentity: () => identity,
  };
}

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
  startupAssetUrls = noStartupAssets,
  warmIdentity,
}: {
  query: string;
  prepare?: boolean;
  initialUnavailable?: boolean;
  startupAssetUrls?: readonly string[];
  warmIdentity?: DEntryIdentity;
}) {
  const assetUrls = useRef(startupAssetUrls);
  const frame = useRef<HTMLIFrameElement>(null);
  const frameSelection = useRef<DEntrySelectionInput | undefined>(undefined);
  const [source, setSource] = useState<string>();
  const [bindMemoryWrites] = useState(createEmployeeMemoryPageWrites);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<Status>(
    initialUnavailable ? 'failed' : prepare && !query ? 'denied' : 'warming',
  );
  const [settled, setSettled] = useState(false);
  const [activeLimit, setActiveLimit] = useState<number>();
  const [activation, setActivation] = useState<{
    query: string;
    confirmedQuery?: string;
    foregroundOpen?: boolean;
    warmup?: EntryWarmup;
    retainFrame?: boolean;
    ticket?: DEntryNativePrewarmTicket;
    warmIdentity?: DEntryIdentity;
  }>({ query, warmIdentity });
  const activeQuery = activation.query;
  const loaded = useRef<((node: HTMLIFrameElement) => void) | undefined>(
    undefined,
  );
  const replace = useRef<(() => void) | undefined>(undefined);
  const cancel = useRef<(() => void) | undefined>(undefined);
  const resume = useRef<((foregroundOpen?: boolean) => void) | undefined>(
    undefined,
  );
  const pendingWarmup = useRef<EntryWarmup | undefined>(undefined);
  const nextQuery = useRef(query);
  const displayedQuery = useRef(query);
  const lastPropQuery = useRef(query);
  if (lastPropQuery.current !== query) {
    lastPropQuery.current = query;
    nextQuery.current = query;
  }

  useEffect(() => {
    assetUrls.current = startupAssetUrls;
  }, [startupAssetUrls]);

  useEffect(() => {
    const discardPending = () => pendingWarmup.current?.lifetime.abort();
    window.addEventListener('pagehide', discardPending);
    return () => {
      window.removeEventListener('pagehide', discardPending);
      discardPending();
    };
  }, []);

  useEffect(() => {
    displayedQuery.current = activeQuery;
    const pending = pendingWarmup.current;
    pendingWarmup.current = undefined;
    if (pending && pending !== activation.warmup) pending.lifetime.abort();
    if (initialUnavailable || (prepare && !activeQuery)) {
      activation.warmup?.lifetime.abort();
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
    let unbindMemoryWrites: (() => void) | undefined;
    let resourceScopeId: string | undefined;
    let navigating = false;
    let navigationClosed = false;
    let pendingNavigation: { target: string; query: string } | undefined;
    let retired = false;
    let mounted = false;
    let documentStarted = false;
    let discardingPendingDocument = false;
    let remoteRevoked = false;
    let selectedQuery = activation.confirmedQuery;
    let selectedEmployee: DEntrySelectionInput | undefined;
    let nextWarmup: EntryWarmup | undefined;
    let warmup = activation.warmup;
    const capacityCancellation = new AbortController();
    let ticket = activation.ticket;
    let resumable = false;
    let superseded = false;
    let timer: number | undefined;
    let closingNotice: number | undefined;
    let closingConfirmation: number | undefined;
    let replacing: Promise<boolean> | undefined;
    let detached = false;
    let switchReady = false;
    let switching: ThreadHandoff | undefined;
    let switchTimer: number | undefined;
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
      warmup?.stopAssetDownloads();
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
        // A request stalled before its first HTML never installed a local
        // lifecycle. Cancel that navigation, and observe the blank document
        // before confirming local closure. An issued document still joins.
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
            // An uninspectable document must supply its real completion.
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
        | 'sign-in'
        | 'restart-confirmation',
      retainTicket = status === 'cancelled',
      join?: Promise<void>,
    ) {
      if (navigating || replace.current !== applyQuery) return;
      navigating = true;
      resumable = retainTicket;
      window.clearTimeout(timer);
      setStatus(status);
      void Promise.all([retire(), join]).then(([closed]) => {
        if (replace.current !== applyQuery) return;
        if (closed) {
          retired = true;
          if (nextQuery.current !== displayedQuery.current) {
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
        // Old local/remote resources have already joined. Keep the DOM frame
        // while the new thread obtains its own page scope and document.
        retainFrame:
          !!frame.current && same('workspaceId') && same('employeeInstanceId'),
      });
    }
    const applyQuery = () => {
      if (navigating) {
        if (nextQuery.current !== displayedQuery.current) {
          nextWarmup?.lifetime.abort();
          nextWarmup = undefined;
          superseded = true;
        }
        if (retired && nextQuery.current !== displayedQuery.current)
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
    cancel.current = () => {
      if (navigating) return;
      const current = warmup;
      const pendingTicket = current?.progress.ticket;
      if (
        !current ||
        !pendingTicket ||
        current.progress.current?.activeLimit === undefined
      )
        return finish('cancelled');
      const joined = cancelEmployeeCapacityWait(
        current.selection,
        pendingTicket,
        capacityCancellation.signal,
      ).then(
        (expired) => {
          if (expired) {
            ticket = undefined;
            current.progress.ticket = undefined;
          }
        },
        () => {
          // The local wait is cancelled. Explicit continuation can check the
          // same ticket if the remote cancellation had no confirmed outcome.
        },
      );
      finish('cancelled', true, joined);
    };
    resume.current = (foregroundOpen) => {
      const query = nextQuery.current;
      setActivation({
        query,
        confirmedQuery:
          query === displayedQuery.current ? selectedQuery : undefined,
        foregroundOpen: query === displayedQuery.current && foregroundOpen,
        ticket:
          resumable && query === displayedQuery.current
            ? (ticket ?? warmup?.progress.ticket)
            : undefined,
      });
    };
    function navigate(selection: DEntrySelectionInput, reopen = false) {
      const params = new URLSearchParams(
        Object.entries(selection).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      const newThread = prepare && !selection.threadId && !reopen;
      const target = params.toString() + (newThread ? '&new' : '');
      if (pendingNavigation?.target === target) return;
      if (newThread) params.set('new', crypto.randomUUID());
      const joining = !!pendingNavigation;
      pendingNavigation = { target, query: params.toString() };
      if (joining) {
        nextWarmup?.lifetime.abort();
        nextWarmup = undefined;
        return;
      }
      navigating = true;
      window.clearTimeout(timer);
      const sameEmployee =
        prepare &&
        location.pathname === '/chatflow/4.0' &&
        selectedEmployee?.workspaceId === selection.workspaceId &&
        selectedEmployee.employeeInstanceId === selection.employeeInstanceId;
      if (sameEmployee && !document.hidden) {
        nextWarmup = startEntryWarmup(
          selection,
          new AbortController(),
          assetUrls.current,
        );
      }
      void retire().then((closed) => {
        if (replace.current !== applyQuery || detached) return;
        const query = pendingNavigation!.query;
        pendingNavigation = undefined;
        const warmup = nextWarmup;
        nextWarmup = undefined;
        if (closed) {
          if (superseded || nextQuery.current !== displayedQuery.current) {
            warmup?.lifetime.abort();
            activateSelection(nextQuery.current);
          } else if (prepare && location.pathname === '/chatflow/4.0') {
            nextQuery.current = query;
            pendingWarmup.current = warmup;
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
    function cancelSwitch(target: ThreadHandoff) {
      switching = undefined;
      window.clearTimeout(switchTimer);
      frame.current?.contentWindow?.postMessage(
        { type: pageThreadSwitchCancel, scopeId, requestId: target.requestId },
        location.origin,
      );
    }
    function submitSwitch(target: ThreadHandoff) {
      if (!carrier) return;
      target.submitted = true;
      window.clearTimeout(switchTimer);
      switchTimer = window.setTimeout(() => {
        if (switching === target) finish('failed');
      }, liveSwitchWaitMs);
      void carrier
        .switchThread(target.selection.threadId, target.requestId)
        .then((issued) => {
          if (switching !== target || navigating || detached || remoteRevoked)
            return;
          if (!issued) {
            cancelSwitch(target);
            navigate(target.selection);
            return;
          }
          target.scopeId = issued.scopeId;
          frame.current?.contentWindow?.postMessage(
            { type: pageThreadScope, scopeId, issued },
            location.origin,
          );
        })
        .catch((error: unknown) => {
          if (switching !== target) return;
          cancelSwitch(target);
          if (error instanceof EmployeeEntryError) {
            if (error.status === 401) return finish('sign-in');
            if ([403, 404].includes(error.status))
              return finish('selection-unavailable');
          }
          finish('failed');
        });
    }
    function beginLiveSwitch(
      selection: DEntrySelectionInput,
      restored = false,
    ) {
      if (
        !prepare ||
        !carrier ||
        !scopeId ||
        !switchReady ||
        switching ||
        navigating ||
        detached ||
        navigationClosed ||
        remoteRevoked ||
        superseded ||
        !selection.threadId ||
        document.hidden ||
        location.pathname !== '/chatflow/4.0' ||
        selectedEmployee?.workspaceId !== selection.workspaceId ||
        selectedEmployee.employeeInstanceId !== selection.employeeInstanceId ||
        selectedEmployee.threadId === selection.threadId
      )
        return false;
      const target: ThreadHandoff = {
        selection: { ...selection, threadId: selection.threadId },
        requestId: crypto.randomUUID(),
        restored,
      };
      switching = target;
      switchTimer = window.setTimeout(() => {
        if (switching !== target) return;
        cancelSwitch(target);
        if (restored) {
          nextQuery.current = location.search.slice(1);
          applyQuery();
        }
      }, liveSwitchWaitMs);
      frame.current?.contentWindow?.postMessage(
        { type: pageThreadSwitchPrepare, scopeId, requestId: target.requestId },
        location.origin,
      );
      return true;
    }
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.current?.contentWindow ||
        !scopeId ||
        event.data?.scopeId !== scopeId
      )
        return;
      if (event.data.type === pageMuxAttach && event.ports.length === 1)
        carrier?.attachMux(
          event.ports[0]!,
          event.data.resourceScopeId ?? scopeId,
        );
      if (event.data.type === pageSwitchReady) switchReady = true;
      if (
        event.data.type === pageThreadSwitchPrepared &&
        switching &&
        switching.requestId === event.data.requestId &&
        !switching.submitted &&
        !navigating &&
        !detached &&
        !remoteRevoked
      )
        submitSwitch(switching);
      if (
        event.data.type === pageThreadSelected &&
        switching?.scopeId &&
        event.data.resourceScopeId === switching.scopeId &&
        !navigating &&
        !detached &&
        !remoteRevoked
      ) {
        const { selection, restored } = switching;
        resourceScopeId = switching.scopeId;
        const query = new URLSearchParams({
          workspaceId: selection.workspaceId,
          employeeInstanceId: selection.employeeInstanceId,
          threadId: selection.threadId!,
        }).toString();
        if (nextQuery.current !== displayedQuery.current) return;
        switching = undefined;
        window.clearTimeout(switchTimer);
        selectedEmployee = selection;
        frameSelection.current = selection;
        selectedQuery = query;
        nextQuery.current = displayedQuery.current = query;
        if (!restored)
          history.pushState(history.state, '', '/chatflow/4.0?' + query);
      }
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
          nextQuery.current === displayedQuery.current
        ) {
          nextQuery.current = displayedQuery.current = selectedQuery;
          history.replaceState(
            history.state,
            '',
            '/chatflow/4.0?' + selectedQuery,
          );
        }
      }
      if (
        event.data.type === pageCompletion &&
        ['closed', 'unknown'].includes(event.data.state)
      ) {
        navigationClosed = true;
        local.resolve(event.data.state);
      }
      if (event.data.type === pageNativeThreadSelected) {
        const next = DEntrySelectionInputSchema.safeParse(event.data.selection);
        if (
          !prepare ||
          !carrier ||
          switching?.submitted ||
          event.data.resourceScopeId !== resourceScopeId ||
          !next.success ||
          !next.data.threadId ||
          next.data.workspaceId !== selectedEmployee?.workspaceId ||
          next.data.employeeInstanceId !==
            selectedEmployee.employeeInstanceId ||
          navigating ||
          remoteRevoked ||
          detached ||
          nextQuery.current !== displayedQuery.current ||
          location.pathname !== '/chatflow/4.0'
        )
          return;
        if (!beginLiveSwitch(next.data)) navigate(next.data);
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
          switching ||
          (navigating && !pendingNavigation)
        )
          return;
        const selection = next.data;
        if (
          !pendingNavigation &&
          selection.threadId &&
          selectedEmployee?.threadId === selection.threadId &&
          selectedEmployee.workspaceId === selection.workspaceId &&
          selectedEmployee.employeeInstanceId === selection.employeeInstanceId
        )
          return;
        if (!beginLiveSwitch(selection))
          navigate(selection, event.data.reopen === true);
      }
    };
    window.addEventListener('message', receive);
    const leaving = () => {
      if (detached) return;
      detached = true;
      capacityCancellation.abort();
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
      const query = location.search.slice(1);
      if (query === displayedQuery.current && !switching) return;
      const params = new URLSearchParams(query);
      const selection = DEntrySelectionInputSchema.safeParse(
        Object.fromEntries(params),
      );
      if (
        selection.success &&
        params.size === Object.keys(selection.data).length &&
        beginLiveSwitch(selection.data, true)
      )
        return;
      nextQuery.current = query;
      if (switching || query !== displayedQuery.current) applyQuery();
    };
    window.addEventListener('popstate', restoreQuery);
    const parsedEntry = Promise.resolve().then(() =>
      employeeEntryQuery(activation.confirmedQuery ?? activeQuery, prepare),
    );
    // The shell owns only its wait; the Worker owns an accepted cold start.
    const showPrewarm = (state: EmployeePrewarmProgress, limit?: number) => {
      if (lifetime.signal.aborted || navigating) return;
      setActiveLimit(limit);
      setStatus(
        limit !== undefined
          ? 'waiting-for-capacity'
          : activation.retainFrame
            ? 'warming'
            : state,
      );
    };
    const startPrewarming = () =>
      prepare
        ? parsedEntry.then(async ({ selection }) => {
            await waitForVisibleEntry(lifetime.signal);
            lifetime.signal.throwIfAborted();
            warmup ??= startEntryWarmup(
              selection,
              lifetime,
              assetUrls.current,
              ticket,
              activation.foregroundOpen,
            );
            warmup.progress.show = showPrewarm;
            const progress = warmup.progress.current;
            if (progress) showPrewarm(progress.state, progress.activeLimit);
            await warmup.result;
          })
        : undefined;
    let prewarming = activation.warmIdentity ? undefined : startPrewarming();
    void prewarming?.catch(() => {}); // setup reports the same rejection.
    const opening = () => {
      ticket = undefined;
      if (warmup) warmup.progress.ticket = undefined;
      setStatus('opening');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => finish('failed'), entryWaitMs);
    };
    const connect = (
      identity: DEntryIdentity,
      selection: DEntrySelectionInput,
      warm?: boolean,
    ) =>
      openNativePageCarrier(
        identity,
        selection,
        () => {
          remoteRevoked = true;
          unbindMemoryWrites?.();
          send(pageRevoked);
          if (!prepare && !lifetime.signal.aborted) setFailed(true);
          // Before issuance, ready's rejection is handled by setting below.
          if (prepare && mounted) finish('failed');
          // Password changes and logout can revoke this carrier before their
          // responses reach the iframe. Only the current cookie decides where
          // the outer page goes.
          if (mounted)
            void retire()
              .then(async () => {
                if (detached || replace.current !== applyQuery) return;
                const response = await fetch('/api/v1/auth/session', {
                  credentials: 'same-origin',
                  cache: 'no-store',
                  signal: lifetime.signal,
                });
                // The unqualified entry checks the cookie again on navigation.
                if (
                  response.status === 401 &&
                  !detached &&
                  replace.current === applyQuery
                )
                  location.replace('/chatflow/4.0');
              })
              .catch(() => {});
        },
        warm,
      );
    const setup = async () => {
      const entry = await parsedEntry;
      const { params } = entry;
      let selection = entry.selection;
      let identity: DEntryIdentity | undefined;
      let opened: Awaited<ReturnType<typeof connect>['ready']> | undefined;
      const warm = activation.warmIdentity;
      if (
        prepare &&
        !entry.operationId &&
        warm &&
        selection.threadId &&
        warm.threadId === selection.threadId &&
        warm.workspaceId === selection.workspaceId &&
        warm.employeeInstanceId === selection.employeeInstanceId
      ) {
        await waitForVisibleEntry(lifetime.signal);
        selectedQuery = params.toString();
        const attempt = (carrier = connect(warm, selection, true));
        const upgradeTimer = window.setTimeout(() => {
          if (!attempt.dispatched) void attempt.close().catch(() => {});
        }, warmUpgradeWaitMs);
        try {
          opened = await attempt.ready;
          identity = warm;
          opening();
        } catch (error) {
          lifetime.signal.throwIfAborted();
          // Before the page command it is safe to fall back to the cold path.
          // A dispatched attempt must retain its normal failure and close.
          if (attempt.dispatched) throw error;
          await attempt.close();
          carrier = undefined;
          remoteRevoked = false;
        } finally {
          window.clearTimeout(upgradeTimer);
        }
      }
      if (!opened || !identity) {
        prewarming ??= startPrewarming();
        selection = prepare
          ? await prepareEmployeeEntry(
              entry,
              lifetime.signal,
              opening,
              prewarming,
            )
          : entry.selection;
        if (selection.threadId && !entry.selection.threadId)
          params.set('threadId', selection.threadId);
        if (prepare && selection.threadId) selectedQuery = params.toString();
        identity =
          warmup?.readIdentity() ??
          (await readEmployeeEntryIdentity(selection, lifetime.signal));
        lifetime.signal.throwIfAborted();
        carrier = connect(identity, selection);
        opened = await carrier.ready;
      }
      const issued = opened.scopeReference;
      scopeId = resourceScopeId = issued.scopeId;
      lifetime.signal.throwIfAborted();
      if (navigating) return;
      selectedEmployee = selection;
      frameSelection.current = selection;
      params.set('scopeId', issued.scopeId);
      unbindMemoryWrites = bindMemoryWrites(window, issued.scopeId, identity);
      mounted = true;
      const documentUrl = '/chatflow/4.0/document?' + params;
      const retainedWindow = activation.retainFrame
        ? frame.current?.contentWindow
        : undefined;
      // A child URL replacement must not insert a second history item that
      // intercepts the outer page's Back/Forward after a thread switch.
      if (retainedWindow) retainedWindow.location.replace(documentUrl);
      else setSource(documentUrl);
    };
    const setting = setup().catch((error: unknown) => {
      if (lifetime.signal.aborted) return;
      if (!prepare) return setFailed(true);
      if (!(error instanceof EmployeeEntryError)) return finish('failed');
      if (error.reason === 'UPGRADE_OPEN_REQUIRED')
        return finish('restart-confirmation');
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
      window.clearTimeout(switchTimer);
      if (warmup) warmup.progress.show = undefined;
      leaving();
      unbindMemoryWrites?.();
      if (loaded.current === documentLoaded) loaded.current = undefined;
      if (replace.current === applyQuery) replace.current = undefined;
      cancel.current = undefined;
      resume.current = undefined;
      window.removeEventListener('message', receive);
      window.removeEventListener('pagehide', leaving);
      window.removeEventListener('popstate', restoreQuery);
    };
  }, [activation, activeQuery, bindMemoryWrites, prepare, initialUnavailable]);

  useEffect(() => {
    if (nextQuery.current !== displayedQuery.current) replace.current?.();
  }, [query, activeQuery]);

  return (
    <main data-employee-selection={activeQuery}>
      {source && (
        <iframe
          ref={frame}
          title="员工工作区"
          data-page-mux="v1"
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
          activeLimit={activeLimit}
          settled={initialUnavailable || settled}
          stop={() => cancel.current?.()}
          retry={() => {
            if (initialUnavailable) location.reload();
            else resume.current?.(status === 'restart-confirmation');
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
    '有空位会自动继续，也可以取消等待。',
  ],
  restarting: ['版本已更新，正在重新启动员工', '重启后会继续打开工作台。'],
  'restart-confirmation': ['版本已更新', '打开员工工作台需要先重启员工。'],
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
  activeLimit,
  settled,
  stop,
  retry,
}: {
  status: Exclude<Status, 'ready'>;
  activeLimit?: number;
  settled: boolean;
  stop(): void;
  retry(): void;
}) {
  const [title, description] = messages[status];
  const starting = [
    'warming',
    'accepted',
    'starting',
    'waiting-for-capacity',
    'restarting',
    'opening',
  ].includes(status);
  const failedOpening = status === 'failed' || status === 'asset-timeout';
  const resumable =
    status === 'cancelled' ||
    status === 'restart-confirmation' ||
    failedOpening;
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
          <p>
            {status === 'waiting-for-capacity' &&
              activeLimit !== undefined &&
              `当前工作台的 ${activeLimit} 个运行名额已占用。`}
            {description}
          </p>
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
            {status === 'restart-confirmation'
              ? '打开员工'
              : status === 'cancelled'
                ? '继续'
                : '重试'}
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
