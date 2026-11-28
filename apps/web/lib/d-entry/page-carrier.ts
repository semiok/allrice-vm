import { EmployeeEntryError } from './entry-client';
import {
  DEntryPageClosedSchema,
  DEntryPageOpenedSchema,
  DEntryPageSkillRefreshSchema,
  DEntryPageSwitchResultSchema,
  type DEntryIdentity,
  type DEntrySelectionInput,
} from '@allrice/contracts';
import {
  parseRemoteStreamClientMessage,
  parseRemoteStreamServerMessage,
} from '@deepseek-ai/dsh-api-gateway/stream-protocol';

type SwitchedPage = Extract<
  ReturnType<typeof DEntryPageSwitchResultSchema.parse>,
  { type: 'switched' }
>;

export {
  pageClosing,
  pageCompletion,
  pageNavigate,
  pageRevoked,
} from './page-messages';

export function pendingPageResult<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((fulfilled, rejected) => {
    resolve = fulfilled;
    reject = rejected;
  });
  return { promise, resolve, reject };
}

export function nativeMuxUrl(
  origin: string,
  organizationId: string,
  selection: DEntrySelectionInput,
  scopeId?: string,
) {
  const url = new URL('/api/v1/d-entry/native-mux', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = new URLSearchParams({
    carrier: 'page',
    organizationId,
    workspaceId: selection.workspaceId,
    employeeInstanceId: selection.employeeInstanceId,
    ...(selection.threadId && { threadId: selection.threadId }),
    ...(scopeId && { scopeId }),
  }).toString();
  return url;
}

export function openNativePageCarrier(
  identity: DEntryIdentity,
  selection: DEntrySelectionInput,
  onRevoked: () => void,
  onSkillsRefreshed?: (scopeId: string) => void,
) {
  const ready =
    pendingPageResult<ReturnType<typeof DEntryPageOpenedSchema.parse>>();
  const joined = pendingPageResult<void>();
  // The owner can close before the first native acknowledgement.
  void ready.promise.catch(() => {});
  void joined.promise.catch(() => {});
  const id = crypto.randomUUID();
  const socket = new WebSocket(
    nativeMuxUrl(location.origin, identity.organizationId, selection),
  );
  let scopeId: string | undefined;
  let carrierSelection = selection;
  let nativeMux: MessagePort | undefined;
  let refreshingSkills: string | undefined;
  let switching:
    | {
        id: string;
        threadId: string;
        proof: AbortController;
        result: ReturnType<typeof pendingPageResult<SwitchedPage | undefined>>;
      }
    | undefined;
  let requested = false,
    complete = false,
    dispatched = false,
    setupCancelled = false,
    gotClosed = false,
    gotEnd = false;
  function send(value: object) {
    socket.send(JSON.stringify({ ...value, streamId: id }));
  }
  function end() {
    send({ type: 'item', value: 'close' });
    send({ type: 'end' });
  }
  function closeMux() {
    if (!nativeMux) return;
    nativeMux.postMessage({ type: 'close' });
    nativeMux.close();
    nativeMux = undefined;
  }
  function fail(reason: unknown) {
    if (complete) return;
    complete = true;
    closeMux();
    onRevoked();
    ready.reject(reason);
    switching?.proof.abort(reason);
    switching?.result.reject(reason);
    switching = undefined;
    // Local transport closure is still observed independently below.
    socket.close();
    return reason;
  }
  let failure: unknown;
  socket.addEventListener(
    'open',
    () => {
      if (requested) return;
      try {
        send({
          type: 'open',
          endpoint: '$d-entry/page',
          payload: { args: {} },
        });
        dispatched = true;
      } catch (error) {
        failure = fail(error);
      }
    },
    { once: true },
  );
  socket.addEventListener('message', (event) => {
    if (complete) return;
    try {
      if (typeof event.data !== 'string')
        throw Error('Invalid native page frame');
      const frame = parseRemoteStreamServerMessage(event.data);
      if (frame.streamId !== id) {
        if (requested) return;
        if (!nativeMux) throw Error('Unexpected native page stream');
        nativeMux.postMessage({ type: 'frame', data: event.data });
        return;
      }
      if (setupCancelled) throw Error('Unexpected native page terminal');
      if (
        frame.type === 'error' &&
        requested &&
        !scopeId &&
        frame.error.code === 'gateway/cancelled' &&
        frame.error.message === 'Page closed during setup'
      ) {
        // The Worker emits this terminal only after joining the unopened
        // page operation. Also wait for the actual clean socket close.
        setupCancelled = true;
        return;
      }
      if (frame.type === 'error')
        throw Object.assign(Error(frame.error.message), frame.error);
      if (frame.type === 'end' && requested && gotClosed && !gotEnd) {
        gotEnd = true;
        return;
      }
      if (frame.type !== 'item' || gotClosed)
        throw Error('Unexpected native page terminal');
      if (scopeId) {
        const skillNotice = DEntryPageSkillRefreshSchema.safeParse(frame.value);
        if (skillNotice.success) {
          const notice = skillNotice.data;
          if (notice.scopeId !== scopeId || requested) return;
          if (notice.type === 'skills-changed') {
            if (!onSkillsRefreshed || refreshingSkills) return;
            refreshingSkills = scopeId;
            nativeMux?.close();
            nativeMux = undefined;
            send({ type: 'item', value: { type: 'refresh-skills', scopeId } });
          } else if (
            notice.type === 'skills-refreshed' &&
            refreshingSkills === scopeId
          ) {
            refreshingSkills = undefined;
            onSkillsRefreshed?.(scopeId);
          }
          return;
        }
        if (switching) {
          const decoded = DEntryPageSwitchResultSchema.safeParse(frame.value);
          if (decoded.success) {
            const value = decoded.data;
            if (
              value.requestId !== switching.id ||
              (value.type === 'switched' &&
                value.threadId !== switching.threadId)
            )
              throw Error('Unexpected native page switch acknowledgement');
            const { result } = switching;
            switching = undefined;
            if (value.type === 'switched') {
              scopeId = value.scopeId;
              refreshingSkills = undefined;
              carrierSelection = { ...selection, threadId: value.threadId };
              nativeMux?.close();
              nativeMux = undefined;
            }
            result.resolve(value.type === 'switched' ? value : undefined);
            return;
          }
        }
        if (
          !requested ||
          DEntryPageClosedSchema.parse(frame.value).scopeId !== scopeId
        )
          throw Error('Unexpected native page acknowledgement');
        gotClosed = true;
      } else {
        const value = DEntryPageOpenedSchema.parse(frame.value);
        scopeId = value.scopeReference.scopeId;
        if (!requested) ready.resolve(value);
      }
    } catch (error) {
      failure = fail(error);
    }
  });
  socket.addEventListener(
    'error',
    () => {
      failure = fail(Error('Native page carrier failed')) ?? failure;
    },
    { once: true },
  );
  socket.addEventListener(
    'close',
    (event) => {
      closeMux();
      if (!dispatched) {
        fail(failure ?? Error('Native page carrier did not open'));
        joined.resolve();
        return;
      }
      if ((gotEnd || setupCancelled) && event.wasClean && !failure) {
        complete = true;
        joined.resolve();
        return;
      }
      const error = failure ?? Error('Native page close is unconfirmed');
      fail(error);
      joined.reject(error);
    },
    { once: true },
  );
  function close() {
    if (!requested && !complete) {
      requested = true;
      const reason = new DOMException('Page closed', 'AbortError');
      switching?.proof.abort(reason);
      switching?.result.reject(reason);
      closeMux();
      ready.reject(new DOMException('Page closed', 'AbortError'));
      if (socket.readyState === WebSocket.OPEN) end();
      if (socket.readyState === WebSocket.CONNECTING) socket.close();
    }
    return joined.promise;
  }
  return {
    ready: ready.promise,
    get dispatched() {
      return dispatched;
    },
    switchThread(threadId: string, requestId: string) {
      if (
        !scopeId ||
        !nativeMux ||
        switching ||
        requested ||
        complete ||
        socket.readyState !== WebSocket.OPEN
      )
        return Promise.resolve(undefined);
      const result = pendingPageResult<SwitchedPage | undefined>();
      const proof = new AbortController();
      switching = { id: requestId, threadId, proof, result };
      const query = new URLSearchParams({
        ...carrierSelection,
        scopeId,
        requestId,
        targetThreadId: threadId,
      });
      // A current same-origin cookie must prove that this is the login owning
      // the published scope, independently of the token captured by the socket.
      void fetch('/api/v1/d-entry/profile/switch?' + query, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: proof.signal,
      })
        .then((response) => {
          if (response.status !== 204)
            throw new EmployeeEntryError(response.status);
          if (switching?.id !== requestId || requested) return;
          try {
            send({
              type: 'item',
              value: { type: 'switch', requestId, threadId },
            });
          } catch (error) {
            failure = fail(error);
          }
        })
        .catch((error: unknown) => {
          if (switching?.id !== requestId || requested) return;
          switching = undefined;
          // A check over HTTP does not report the health of the old socket.
          // The caller uses its existing explicit close-and-join protocol.
          result.reject(error);
        });
      return result.promise;
    },
    attachMux(port: MessagePort, requestedScope = scopeId) {
      if (
        !scopeId ||
        scopeId !== requestedScope ||
        nativeMux ||
        refreshingSkills ||
        requested ||
        complete ||
        socket.readyState !== WebSocket.OPEN
      ) {
        port.postMessage({ type: 'close' });
        port.close();
        return;
      }
      nativeMux = port;
      port.onmessage = (event) => {
        if (nativeMux !== port || requested || complete) return;
        try {
          if (event.data?.type === 'close') {
            void close().catch(() => {});
            return;
          }
          if (
            event.data?.type !== 'frame' ||
            typeof event.data.data !== 'string'
          )
            throw Error('Invalid native resource frame');
          const frame = parseRemoteStreamClientMessage(event.data.data);
          if (
            frame.streamId === id ||
            (frame.type === 'open' && frame.endpoint === '$d-entry/page')
          )
            throw Error('A borrowed mux cannot control its page');
          socket.send(event.data.data);
        } catch (error) {
          failure = fail(error);
        }
      };
      port.onmessageerror = () => {
        failure = fail(Error('Invalid native resource frame'));
      };
      port.postMessage({ type: 'open' });
    },
    close,
  };
}
