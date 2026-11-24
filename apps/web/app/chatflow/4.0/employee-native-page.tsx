'use client';

import { useEffect, useRef, useState } from 'react';
import {
  DEntryIdentityResultSchema,
  DEntrySelectionInputSchema,
} from '@allrice/contracts';
import {
  openNativePageCarrier,
  pageClosing,
  pageCompletion,
  pageRevoked,
} from '../../../lib/d-entry/page-carrier';

export function EmployeeNativePage({ query }: { query: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const lifetime = new AbortController();
    let carrier: ReturnType<typeof openNativePageCarrier> | undefined;
    let scopeId: string | undefined;
    setSource(undefined);
    setFailed(false);
    const send = (type: string, state?: 'closed' | 'unknown') => {
      if (scopeId)
        frame.current?.contentWindow?.postMessage(
          { type, scopeId, state },
          location.origin,
        );
    };
    const close = () => {
      void carrier?.close().then(
        () => send(pageCompletion, 'closed'),
        () => send(pageCompletion, 'unknown'),
      );
    };
    const receive = (event: MessageEvent) => {
      if (
        event.origin === location.origin &&
        event.source === frame.current?.contentWindow &&
        event.data?.type === pageClosing &&
        event.data?.scopeId === scopeId
      )
        close();
    };
    window.addEventListener('message', receive);
    window.addEventListener('pagehide', close);
    const setup = async () => {
      const params = new URLSearchParams(query);
      if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
        throw Error('Invalid employee selection');
      const selection = DEntrySelectionInputSchema.parse(
        Object.fromEntries(params),
      );
      const response = await fetch('/api/v1/d-entry/identity?' + params, {
        signal: lifetime.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) throw Error('Employee selection unavailable');
      const { identity } = DEntryIdentityResultSchema.parse(
        await response.json(),
      );
      lifetime.signal.throwIfAborted();
      if (
        identity.workspaceId !== selection.workspaceId ||
        identity.employeeInstanceId !== selection.employeeInstanceId ||
        identity.threadId !== (selection.threadId ?? null)
      )
        throw Error('Employee selection changed');
      carrier = openNativePageCarrier(identity, selection, () => {
        send(pageRevoked);
        if (!lifetime.signal.aborted) setFailed(true);
      });
      scopeId = (await carrier.ready).scopeReference.scopeId;
      lifetime.signal.throwIfAborted();
      params.set('scopeId', scopeId);
      setSource('/chatflow/4.0/document?' + params);
    };
    void setup().catch(() => {
      if (!lifetime.signal.aborted) setFailed(true);
    });
    return () => {
      lifetime.abort();
      close();
      window.removeEventListener('message', receive);
      window.removeEventListener('pagehide', close);
    };
  }, [query]);

  return (
    <main data-employee-selection={query}>
      {source && (
        <iframe
          ref={frame}
          title="员工工作区"
          src={source}
          referrerPolicy="no-referrer"
          style={{
            display: 'block',
            width: '100%',
            height: '100dvh',
            border: 0,
          }}
        />
      )}
      {failed && <p role="alert">当前入口暂不可用</p>}
    </main>
  );
}
