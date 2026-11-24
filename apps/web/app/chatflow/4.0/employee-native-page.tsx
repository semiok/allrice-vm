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
  pageNavigate,
  pageRevoked,
  pendingPageResult,
} from '../../../lib/d-entry/page-carrier';

export function EmployeeNativePage({ query }: { query: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const lifetime = new AbortController();
    let carrier: ReturnType<typeof openNativePageCarrier> | undefined;
    let scopeId: string | undefined;
    let navigating = false;
    const local = pendingPageResult<'closed' | 'unknown'>();
    setSource(undefined);
    setFailed(false);
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
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.current?.contentWindow ||
        !scopeId ||
        event.data?.scopeId !== scopeId
      )
        return;
      if (event.data.type === pageClosing) void close();
      if (
        event.data.type === pageCompletion &&
        ['closed', 'unknown'].includes(event.data.state)
      )
        local.resolve(event.data.state);
      if (event.data.type === pageNavigate) {
        const next = DEntrySelectionInputSchema.safeParse(event.data.selection);
        if (!next.success || !carrier || navigating) return;
        navigating = true;
        const params = new URLSearchParams(
          Object.entries(next.data).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
        // Both messages refer only to this exact iframe and page scope. The
        // carrier completion proves the remote side; terminate local entry
        // work independently and keep the frame until both report back.
        send(pageRevoked);
        void Promise.all([close(), local.promise]).then(([remote, entry]) => {
          if (lifetime.signal.aborted) return;
          if (remote === 'closed' && entry === 'closed')
            location.assign('/chatflow/4.0?' + params);
          else setFailed(true);
        });
      }
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
      const issued = (await carrier.ready).scopeReference;
      scopeId = issued.scopeId;
      lifetime.signal.throwIfAborted();
      params.set('scopeId', issued.scopeId);
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
