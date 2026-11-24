import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { Workspace } from '../../../apps/web/app/chatflow/chatflow-types';
import {
  employeeChoice,
  sessionEmployeeKey,
} from '../../../apps/web/app/chatflow/employee-instances';
import { unreadKeys } from '../../../apps/web/app/chatflow/workbench-modules';
import { createEmployeePanelsHttpClient } from '../../../apps/web/lib/chatflow/employee-panel-data-http';
import { pageNavigate } from '../../../apps/web/lib/d-entry/page-messages';
import { readEmployeeDocument } from '../../../apps/web/lib/d-entry/profile-browser';
import {
  bindEmployeeSidebar,
  type EmployeeSidebarSnapshot,
} from './employee-sidebar';
import {
  bindEmployeePanelsHttp,
  type EmployeePanelsSnapshot,
} from './employee-panels';

function position<T>() {
  let snapshot: T | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(value: T | null) {
      snapshot = value;
      listeners.forEach((notify) => notify());
    },
  };
}

export function installEmployeeProductOwner(ctx: Context) {
  const scope = globalThis as typeof globalThis & {
    __ALLRICE_D_ENTRY_LIFETIME__?: AbortSignal;
  };
  const signal = scope.__ALLRICE_D_ENTRY_LIFETIME__;
  if (!signal) return;
  const data = document.getElementById('app')?.dataset;
  if (!data) return;
  const { scopeId, selection, viewerId, organizationId, nativeSessionId } =
    readEmployeeDocument(data);
  if (!nativeSessionId || !selection.threadId)
    throw Error('Employee session unavailable');
  const threadId = selection.threadId;
  const sidebar = position<EmployeeSidebarSnapshot>();
  const panels = position<EmployeePanelsSnapshot>();
  const ownerKey = [
    organizationId,
    viewerId,
    selection.workspaceId,
    scopeId,
  ].join('/');
  const requestHeaders = {
    'x-allrice-workspace-id': selection.workspaceId,
    'x-allrice-organization-id': organizationId,
  };
  function navigate(employeeInstanceId: string, target?: string) {
    signal!.throwIfAborted();
    parent.postMessage(
      {
        type: pageNavigate,
        scopeId,
        selection: {
          workspaceId: selection.workspaceId,
          employeeInstanceId,
          threadId: target,
        },
      },
      location.origin,
    );
  }
  const clear = () => {
    sidebar.update(null);
    panels.update(null);
  };
  signal.addEventListener('abort', clear, { once: true });
  ctx.effect(() => () => {
    signal.removeEventListener('abort', clear);
    clear();
  });
  ctx.inject(['uiWorkspace'], (native) => {
    if (signal.aborted) return;
    native.uiWorkspace.openSession(
      nativeSessionId as Parameters<typeof native.uiWorkspace.openSession>[0],
    );
  });

  const workspaceTask = Promise.resolve().then(() => {
    const embedded = document.getElementById(
      'allrice-employee-directory',
    )?.textContent;
    if (!embedded) throw Error('Employee catalog unavailable');
    const directory = JSON.parse(embedded) as Pick<
      Workspace,
      'organizationId' | 'workspaceId' | 'viewerId' | 'employees' | 'sessions'
    >;
    const workspace: Workspace = {
      ...directory,
      employeeProfiles: [],
      sessionModels: [],
      canAdminister: false,
    };
    signal.throwIfAborted();
    if (
      workspace.viewerId !== viewerId ||
      workspace.organizationId !== organizationId ||
      workspace.workspaceId !== selection.workspaceId ||
      !employeeChoice(workspace, selection.employeeInstanceId) ||
      !workspace.sessions.some(
        (thread) =>
          thread.id === threadId &&
          sessionEmployeeKey(thread) === selection.employeeInstanceId,
      )
    )
      throw Error('Employee catalog changed');
    return workspace;
  });

  void workspaceTask
    .then((workspace) => {
      const sessions = workspace.sessions.filter(
        (session) => session.ownerId === viewerId && !session.archivedAt,
      );
      const initial: EmployeeSidebarSnapshot = {
        settingsOpen: false,
        tree: {
          workspace,
          sessions,
          activeId: threadId,
          onSelectSession(id) {
            if (id === threadId) return;
            const selected = sessions.find((session) => session.id === id);
            if (selected) navigate(sessionEmployeeKey(selected), selected.id);
          },
          onEmployeeNavigate(id) {
            if (
              !employeeChoice(workspace, id) ||
              id === selection.employeeInstanceId
            )
              return;
            const session = sessions.find(
              (row) => sessionEmployeeKey(row) === id,
            );
            if (session) navigate(id, session.id);
            else notice('此员工暂没有可打开的工作。');
          },
          onNewSession: () => notice('当前入口暂无法新建工作。'),
          onDetails: () => notice('当前入口暂无法打开员工详情。'),
        },
      };
      function notice(error: string) {
        if (!signal!.aborted) sidebar.update({ ...initial, error });
      }
      sidebar.update(initial);
      bindEmployeeSidebar(ctx, {
        getSnapshot: sidebar.getSnapshot,
        subscribe: sidebar.subscribe,
        createEmployee: () => notice('当前入口暂无法创建员工。'),
        openArchive: () => notice('当前入口暂无法打开归档。'),
        openEmployeeSettings: () => notice('当前入口暂无法打开员工设置。'),
      });
    })
    .catch(() => {});

  const filesClient = createEmployeePanelsHttpClient(selection, {
    expectedViewerId: viewerId,
    lifetimeSignal: signal,
  });
  const storageKey =
    'allrice:workbench-read:v1:' +
    [organizationId, selection.workspaceId, viewerId].join('/') +
    '/files';
  void Promise.all([
    workspaceTask,
    filesClient.listDeliverables(
      { workspaceId: selection.workspaceId },
      signal,
    ),
  ])
    .then(async ([workspace, catalog]) => {
      signal.throwIfAborted();
      const employee = employeeChoice(workspace, selection.employeeInstanceId);
      if (!employee) return;
      const keys = catalog.files.map((file) => file.objectId);
      let previous: Set<string> | null = null;
      try {
        previous = unreadKeys(localStorage.getItem(storageKey));
      } catch {
        // Browser storage can be unavailable. The file list still opens.
      }
      const common = {
        ownerKey,
        viewerId,
        workspaceId: selection.workspaceId,
        sessionId: threadId,
        headers: requestHeaders,
      };
      const initial: EmployeePanelsSnapshot = {
        scopeKey: ownerKey,
        publicationManagement: {
          organizationId,
          employeeInstanceId: selection.employeeInstanceId,
          threadId,
        },
        filesUnread: previous
          ? keys.filter((key) => !previous.has(key)).length
          : 0,
        materials: { ...common, readOnly: true },
        files: {
          ...common,
          readOnly: true,
          refreshKey: ownerKey,
          currentEmployee: {
            id: selection.employeeInstanceId,
            name: employee.currentVersion.manifest.name,
          },
          employees: catalog.employees,
          onRead() {
            try {
              localStorage.setItem(
                storageKey,
                JSON.stringify(keys.slice(-2000)),
              );
            } catch {
              // The active page can still clear its unread count.
            }
            const now = panels.getSnapshot();
            if (now?.filesUnread) panels.update({ ...now, filesUnread: 0 });
          },
          onOpen(file) {
            const current = panels.getSnapshot();
            if (signal!.aborted || !current) return;
            panels.update({
              ...current,
              filePreview: {
                objectId: file.objectId,
                close() {
                  const current = panels.getSnapshot();
                  if (current)
                    panels.update({ ...current, filePreview: undefined });
                },
              },
            });
          },
        },
      };
      if (!previous) initial.files.onRead?.();
      panels.update(initial);
      await bindEmployeePanelsHttp(
        ctx,
        {
          getSnapshot: (id) =>
            signal.aborted || id !== nativeSessionId
              ? null
              : panels.getSnapshot(),
          subscribe: (_id, listener) => panels.subscribe(listener),
        },
        (id) =>
          id === nativeSessionId && !signal.aborted
            ? { selection, viewerId }
            : null,
      );
    })
    .catch(() => {});
}
