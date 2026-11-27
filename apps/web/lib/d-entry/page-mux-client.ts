import { pageMuxAttach } from './page-messages';

export type NativePageSocket = Pick<
  WebSocket,
  'readyState' | 'send' | 'close'
> &
  Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** Expose the rc.2 text-stream socket interface to the owned iframe without
 * opening another connection or handing it the parent page protocol. */
export function borrowPageMux(
  scopeId: string,
  resourceScopeId = scopeId,
): NativePageSocket {
  const { port1, port2 } = new MessageChannel();
  const events = new EventTarget();
  let readyState: number = WebSocket.CONNECTING;
  function finish() {
    if (readyState === WebSocket.CLOSED) return;
    readyState = WebSocket.CLOSED;
    port1.close();
    events.dispatchEvent(new CloseEvent('close', { wasClean: true }));
  }
  port1.onmessage = ({ data }) => {
    if (data?.type === 'close') {
      finish();
    } else if (data?.type === 'open' && readyState === WebSocket.CONNECTING) {
      readyState = WebSocket.OPEN;
      events.dispatchEvent(new Event('open'));
    } else if (
      data?.type === 'frame' &&
      typeof data.data === 'string' &&
      readyState === WebSocket.OPEN
    ) {
      events.dispatchEvent(new MessageEvent('message', { data: data.data }));
    }
  };
  port1.onmessageerror = finish;
  parent.postMessage(
    { type: pageMuxAttach, scopeId, resourceScopeId },
    location.origin,
    [port2],
  );
  return {
    get readyState() {
      return readyState;
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    send(data) {
      if (typeof data !== 'string' || readyState !== WebSocket.OPEN)
        throw new DOMException(
          'Native resource mux is unavailable',
          'InvalidStateError',
        );
      port1.postMessage({ type: 'frame', data });
    },
    close() {
      if (readyState === WebSocket.CLOSED) return;
      port1.postMessage({ type: 'close' });
      finish();
    },
  };
}
