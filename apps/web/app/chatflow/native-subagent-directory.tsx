'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import type { NativeSubagentSummary } from '@allrice/contracts';
import {
  nativeSubagentElapsedMs,
  nativeSubagentEntryState,
  nativeSubagentReference,
  nativeSubagentScopeKey,
  type NativeSubagentReference,
  type NativeSubagentViewScope,
} from '../../lib/chatflow/native-subagent-view';
import type { useNativeSubagents } from './use-native-subagents';
import { WorkbenchIcon } from './workbench-modules';
import actions from './workbench-modules.module.css';
import css from './native-subagent-directory.module.css';

type Entry = NativeSubagentSummary['descendants'][number];

export function EmptyNativeSubagentDirectory() {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      portal
      align="end"
      autoFocus={false}
      open={open}
      onClose={() => setOpen(false)}
      listClassName={css.catalog}
      anchor={
        <Button
          size="sm"
          className={`${actions.iconButton} ${css.trigger}`}
          aria-expanded={open}
          aria-haspopup="tree"
          aria-label="子智能体"
          onClick={() => setOpen(!open)}
          onKeyDown={(event) => {
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <WorkbenchIcon kind="subagent" />
        </Button>
      }
    >
      <h2 className={css.title}>子智能体</h2>
      <p className={`${css.message} ${css.empty}`}>暂无子智能体</p>
    </Menu>
  );
}

type NativeSubagentDirectoryProps = {
  workspaceId: string;
  sessionId: string;
  observation: ReturnType<typeof useNativeSubagents>;
  scope?: NativeSubagentViewScope;
  onOpen?: (reference: NativeSubagentReference) => void;
  openRequest?: { id: number; scopeKey: string };
  employeeName?: string;
};
export function NativeSubagentDirectory({
  workspaceId,
  sessionId,
  observation,
  scope,
  onOpen,
  openRequest,
  employeeName,
}: NativeSubagentDirectoryProps) {
  const scopeKey = scope
    ? nativeSubagentScopeKey(scope)
    : JSON.stringify([workspaceId, sessionId]);
  const [openedScope, setOpenedScope] = useState<string | null>(null);
  const open = openedScope === scopeKey;
  const openRef = useRef(false);
  const { reads, refresh } = observation;
  const showCatalog = (nextOpen: boolean) => {
    if (nextOpen && !openRef.current) refresh();
    openRef.current = nextOpen;
    setOpenedScope(nextOpen ? scopeKey : null);
  };
  const read = reads[sessionId];
  const summary = read && read !== 'error' ? read : null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const catalog = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef(false);
  const close = useCallback(() => {
    openRef.current = false;
    setOpenedScope(null);
  }, []);
  useEffect(() => {
    setOpenedScope(null);
    openRef.current = false;
    setExpanded(new Set());
  }, [scopeKey]);
  const requestId =
    openRequest?.scopeKey === scopeKey ? openRequest.id : undefined;
  useEffect(() => {
    if (requestId !== undefined) {
      pendingFocus.current = true;
      showCatalog(true);
    }
  }, [requestId, scopeKey]);
  useEffect(() => {
    if (!open) pendingFocus.current = false;
    else if (summary && pendingFocus.current) {
      const first = catalog.current?.querySelector<HTMLElement>('[data-child]');
      if (first) {
        pendingFocus.current = false;
        first.focus();
      }
    }
  }, [open, summary]);
  const direct =
    summary?.descendants.filter((child) => child.parentId === summary.rootId) ??
    [];
  const [now, setNow] = useState(Date.now);
  const ticking =
    open &&
    summary?.root.source === 'live' &&
    summary.descendants.some(
      (entry) =>
        entry.kind === 'child' &&
        entry.observation.source === 'live' &&
        entry.running === true &&
        entry.timing.active,
    );
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const toggle = (id: string) =>
    setExpanded((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openEntry = (entry: Entry) => {
    if (
      !scope ||
      scope.workspaceId !== workspaceId ||
      scope.sessionId !== sessionId ||
      !summary ||
      !onOpen
    )
      return;
    onOpen(nativeSubagentReference(scope, summary, entry));
    close();
  };
  const rows = (parentId: string): ReactNode =>
    summary?.descendants
      .filter((entry) => entry.parentId === parentId)
      .map((entry) => {
        const branch = summary.descendants.some(
          (other) => other.parentId === entry.id,
        );
        const label =
          entry.kind === 'child' ? (entry.label ?? entry.id) : entry.id;
        const status = nativeSubagentEntryState(summary, entry);
        const duration =
          entry.kind === 'child'
            ? nativeSubagentElapsedMs(summary, entry, now)
            : undefined;
        const usage = entry.kind === 'child' ? Object.values(entry.usage) : [];
        const tokens =
          usage.length === 4 &&
          usage.every((value) => Number.isFinite(value) && value >= 0)
            ? `${usage.reduce((a, b) => a + b, 0).toLocaleString()} tokens`
            : '—';
        return (
          <li
            role="treeitem"
            key={entry.id}
            aria-expanded={branch ? expanded.has(entry.id) : undefined}
            tabIndex={0}
            data-child={entry.id}
            data-parent={parentId}
            aria-label={`${label}摘要`}
            onKeyDown={(event) => {
              if (
                event.target === event.currentTarget &&
                ['Enter', ' '].includes(event.key)
              ) {
                event.preventDefault();
                openEntry(entry);
              }
            }}
          >
            <div className={css.row}>
              {branch ? (
                <Button
                  size="sm"
                  className={css.branch}
                  aria-label={`${expanded.has(entry.id) ? '收起' : '展开'}${label}`}
                  aria-expanded={expanded.has(entry.id)}
                  onClick={() => toggle(entry.id)}
                >
                  {expanded.has(entry.id) ? '▾' : '▸'}
                </Button>
              ) : (
                <span className={css.branchSpacer} aria-hidden />
              )}
              <button
                type="button"
                className={css.entry}
                data-state={status.state}
                onClick={() => openEntry(entry)}
                aria-label={`${label}，${status.text}，${entry.kind === 'diagnostic' ? '查看读取说明' : '在工作台打开'}`}
              >
                <span className={css.stateDot} aria-hidden />
                <span className={css.copy}>
                  <span className={css.label}>{label}</span>
                  {entry.kind === 'child' && entry.task && (
                    <span className={css.task}>{entry.task}</span>
                  )}
                  <span className={css.status}>{status.text}</span>
                </span>
                <Tooltip
                  label="累计用量可能包含继承历史；用时来自已读取记录"
                  side="top"
                  portal
                >
                  <span className={css.metadata}>
                    {tokens}
                    <span className={css.duration}>
                      {duration === undefined
                        ? '—'
                        : `${Math.floor(duration / 1000)}秒`}
                    </span>
                  </span>
                </Tooltip>
                <span className={css.entryArrow} aria-hidden>
                  ›
                </span>
              </button>
            </div>
            {branch && expanded.has(entry.id) && (
              <ul role="group">{rows(entry.id)}</ul>
            )}
          </li>
        );
      });
  const running = direct.filter(
    (entry) =>
      entry.kind === 'child' &&
      summary?.root.source === 'live' &&
      entry.observation.source === 'live' &&
      entry.running === true,
  ).length;
  return (
    <div
      onBlurCapture={() => {
        pendingFocus.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          close();
          trigger.current?.focus();
          return;
        }
        const buttons = [
          ...(catalog.current?.querySelectorAll<HTMLElement>('[data-child]') ??
            []),
        ];
        const current = (event.target as HTMLElement).closest<HTMLElement>(
          '[data-child]',
        );
        const at = current ? buttons.indexOf(current) : -1;
        const target =
          at < 0
            ? 0
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : at + (event.key === 'ArrowUp' ? -1 : 1);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          pendingFocus.current = at < 0 && !buttons.length;
          showCatalog(true);
          requestAnimationFrame(() =>
            catalog.current
              ?.querySelectorAll<HTMLElement>('[data-child]')
              .item(target)
              ?.focus(),
          );
        }
        if (at >= 0 && ['ArrowRight', 'ArrowLeft'].includes(event.key)) {
          event.preventDefault();
          const id = buttons[at]!.dataset.child!;
          if (event.key === 'ArrowRight' && expanded.has(id))
            buttons[at + 1]?.focus();
          else if (
            summary?.descendants.some((entry) => entry.parentId === id) &&
            (event.key === 'ArrowRight') !== expanded.has(id)
          )
            toggle(id);
          else if (event.key === 'ArrowLeft')
            buttons
              .find(
                (button) =>
                  button.dataset.child === buttons[at]!.dataset.parent,
              )
              ?.focus();
        }
      }}
    >
      <Menu
        portal
        align="end"
        autoFocus={false}
        open={open}
        onClose={close}
        listClassName={css.catalog}
        anchor={
          <Button
            ref={trigger}
            size="sm"
            className={`${actions.iconButton} ${css.trigger}`}
            aria-expanded={open}
            aria-haspopup="tree"
            aria-label={
              read === 'error'
                ? '子智能体读取失败'
                : summary
                  ? `${direct.length} 个子智能体${running ? ` · ${running} 个运行中` : ''}`
                  : '子智能体'
            }
            onClick={() => showCatalog(!open)}
          >
            <WorkbenchIcon kind="subagent" />
            {(read === 'error' || running > 0) && (
              <span
                className={`${actions.badge} ${read === 'error' ? css.errorBadge : css.runningBadge}`}
                aria-hidden
              >
                {read === 'error' ? '!' : running}
              </span>
            )}
          </Button>
        }
      >
        <div ref={catalog}>
          <div className={css.catalogHead}>
            <h2 className={css.title}>
              {employeeName ? `${employeeName} · 子智能体` : '子智能体'}
            </h2>
            {summary && (
              <span className={css.message}>
                {direct.length} 个{running ? ` · ${running} 个运行中` : ''}
              </span>
            )}
          </div>
          {read === undefined ? (
            <div className={css.loading}>
              <p className={css.message} role="status">
                正在读取子智能体摘要…
              </p>
              <div className={css.skeleton} aria-hidden>
                <span />
                <span />
              </div>
            </div>
          ) : read === null ? (
            <p className={css.message} role="status">
              当前活动状态未知，请重新读取摘要。
            </p>
          ) : read === 'error' ? (
            <p className={css.message} role="alert">
              {observation.disconnected?.[sessionId]
                ? '实时观察已断开，重试。'
                : '暂时读不到子智能体目录。'}
            </p>
          ) : summary && !direct.length ? (
            <p className={`${css.message} ${css.empty}`}>暂无子智能体</p>
          ) : (
            <ul role="tree" aria-label="子智能体目录">
              {summary && rows(summary.rootId)}
            </ul>
          )}
        </div>
      </Menu>
    </div>
  );
}
