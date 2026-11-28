'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  employeeMemoryClient,
  MemoryAccessLost,
  MemoryClientError,
  memoryReadFailed,
  type MemoryList,
  type MemoryWriteStore,
  type EmployeeMemorySourceReader,
  type MemorySourceRead,
} from '../../lib/memory/employee-memory-client';
import type { EmployeeMemoryPageWrites } from '../../lib/memory/employee-memory-page-writes';
import { EmployeeMemorySidebar } from './employee-memory-sidebar';

type Props = {
  scopeId: string;
  workspaceId: string;
  instanceId: string;
  headers: Record<string, string>;
  employeeName?: string;
  refreshKey?: string;
  lifetimeSignal?: AbortSignal;
  ownerSignal?: AbortSignal;
  assertCurrent?: () => void;
  active?: boolean;
  writes?: MemoryWriteStore;
  pageWrites?: EmployeeMemoryPageWrites;
  readSource?: EmployeeMemorySourceReader;
};

/** The production owner host consumes only the complete schemaVersion2 API. */
export function EmployeeMemoryManager(props: Props) {
  const localWrites = useRef<MemoryWriteStore>(new Map());
  const credentials = JSON.stringify(Object.entries(props.headers).sort());
  const headers = useMemo(
    () => Object.fromEntries(JSON.parse(credentials)),
    [credentials],
  );
  return (
    <Manager
      key={`${props.scopeId}/${props.workspaceId}/${props.instanceId}/${credentials}`}
      {...props}
      headers={headers}
      writes={props.writes ?? localWrites.current}
    />
  );
}
function Manager(props: Props & { writes: MemoryWriteStore }) {
  const [page, setPage] = useState<MemoryList | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [accessRevision, setAccessRevision] = useState(0);
  const alive = useRef(true),
    generation = useRef(0);
  const source = useRef({});
  const client = useMemo(
    () =>
      employeeMemoryClient(props, props.writes, {
        readSource: props.readSource,
        lifetimeSignal: props.lifetimeSignal,
        assertCurrent: props.assertCurrent,
      }),
    [
      props.scopeId,
      props.workspaceId,
      props.instanceId,
      props.headers,
      props.writes,
      props.readSource,
      props.lifetimeSignal,
      props.assertCurrent,
    ],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
    };
  }, []);
  const available = useCallback(() => {
    if (!alive.current || props.lifetimeSignal?.aborted) return false;
    try {
      props.assertCurrent?.();
      return true;
    } catch {
      return false;
    }
  }, [props.assertCurrent, props.lifetimeSignal]);
  const clearPrivate = useCallback(() => {
    generation.current += 1;
    setPage(null);
    setLoading(false);
    setError(memoryReadFailed);
    setAccessRevision((value) => value + 1);
  }, []);
  const readSource = useCallback<MemorySourceRead>(
    async (row, signal) => {
      try {
        return await client.source(row, signal);
      } catch (cause) {
        if (available() && !signal.aborted && cause instanceof MemoryAccessLost)
          clearPrivate();
        throw cause;
      }
    },
    [client, clearPrivate, available],
  );
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!available() || signal?.aborted) return;
      const started = ++generation.current;
      const current = () =>
        available() && !signal?.aborted && generation.current === started;
      setLoading(true);
      setError('');
      try {
        const value = await client.list(signal);
        if (current()) setPage(value);
      } catch (cause) {
        if (current()) {
          if (cause instanceof MemoryAccessLost) clearPrivate();
          else setError(memoryReadFailed);
        }
      } finally {
        if (current()) setLoading(false);
      }
    },
    [client, clearPrivate, available],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, props.refreshKey]);
  useEffect(() => {
    if (props.pageWrites)
      return props.pageWrites.subscribe((origin) => {
        if (source.current !== origin) void load();
      });
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.scopeId === props.scopeId && detail.source !== source.current)
        void load();
    };
    window.addEventListener('allrice:memory-changed', listener);
    return () => window.removeEventListener('allrice:memory-changed', listener);
  }, [load, props.pageWrites, props.scopeId]);
  function assertTab() {
    if (!available())
      throw new DOMException('Memory panel is closed', 'AbortError');
  }
  async function changed(
    intent: Parameters<EmployeeMemoryPageWrites['mutate']>[0],
  ) {
    try {
      if (props.pageWrites)
        await props.pageWrites.mutate(intent, assertTab, source.current);
      else if (intent.action === 'save')
        await client.save(intent.pair, intent.row);
      else await client[intent.action](intent.row);
    } catch (cause) {
      // Only a verified 201/200/204 receipt resolves.
      if (available() && cause instanceof MemoryAccessLost) clearPrivate();
      else if (
        available() &&
        cause instanceof MemoryClientError &&
        ['memory_limit_reached', 'cas_conflict', 'contract_changed'].includes(
          cause.reason ?? '',
        )
      )
        await load();
      throw cause;
    }
    // The document owns write receipts across tab visits. A newer tab in the
    // same document must refresh even after the tab that sent the write closed.
    if (
      !props.pageWrites &&
      (available() || Boolean(props.ownerSignal && !props.ownerSignal.aborted))
    )
      window.dispatchEvent(
        new CustomEvent('allrice:memory-changed', {
          detail: {
            scopeId: props.scopeId,
            workspaceId: props.workspaceId,
            instanceId: props.instanceId,
            source: source.current,
          },
        }),
      );
    // A failed read after acknowledged success is a read error, never a new write.
    if (available()) await load();
  }
  return (
    <div
      role="region"
      aria-label="个人记忆"
      style={{ height: '100%', minHeight: 0 }}
    >
      <EmployeeMemorySidebar
        targetKey={`${props.scopeId}/${props.workspaceId}/${props.instanceId}/${accessRevision}`}
        active={props.active}
        employeeName={props.employeeName ?? 'AI 员工'}
        rows={page ? [...page.pending, ...page.active] : []}
        loading={loading}
        error={error}
        onReload={() => void load()}
        onReadSource={readSource}
        onReadDetail={async (row, signal) => {
          try {
            return await client.detail(row, signal);
          } catch (cause) {
            if (
              available() &&
              !signal.aborted &&
              cause instanceof MemoryAccessLost
            )
              clearPrivate();
            throw cause;
          }
        }}
        onSave={(pair, row) => changed({ action: 'save', pair, row })}
        onConfirm={(row) => changed({ action: 'confirm', row })}
        onDelete={(row) => changed({ action: 'remove', row })}
      />
    </div>
  );
}
