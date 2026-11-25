import {
  DEntryPageClosedSchema,
  DEntryPageOpenedSchema,
  type DEntryIdentity,
  type DEntrySelectionInput,
} from '@allrice/contracts';
import { parseRemoteStreamServerMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol';

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
  let requested = false,
    complete = false,
    dispatched = false,
    gotClosed = false,
    gotEnd = false;
  function send(value: object) {
    socket.send(JSON.stringify({ ...value, streamId: id }));
  }
  function end() {
    send({ type: 'item', value: 'close' });
    send({ type: 'end' });
  }
  function fail(reason: unknown) {
    if (complete) return;
    complete = true;
    onRevoked();
    ready.reject(reason);
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
      if (frame.streamId !== id) throw Error('Unexpected native page stream');
      if (frame.type === 'error')
        throw Object.assign(Error(frame.error.message), frame.error);
      if (frame.type === 'end' && requested && gotClosed && !gotEnd) {
        gotEnd = true;
        return;
      }
      if (frame.type !== 'item' || gotClosed)
        throw Error('Unexpected native page terminal');
      if (scopeId) {
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
      if (!dispatched) {
        fail(failure ?? Error('Native page carrier did not open'));
        joined.resolve();
        return;
      }
      if (gotEnd && event.wasClean && !failure) {
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
  return {
    ready: ready.promise,
    close() {
      if (!requested && !complete) {
        requested = true;
        ready.reject(new DOMException('Page closed', 'AbortError'));
        if (socket.readyState === WebSocket.OPEN) end();
        if (socket.readyState === WebSocket.CONNECTING) socket.close();
      }
      return joined.promise;
    },
  };
}
