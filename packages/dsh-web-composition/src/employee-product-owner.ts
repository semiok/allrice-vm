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
  ctx.inject(['uiWorkspace', 'sessions'], (native) => {
    native.effect(() => {
      const list = native.sessions.list;
      const open = () => {
        if (signal.aborted) return;
        // rc.2 cannot retain a Session until its native summary has arrived.
        const root = list
          .getSnapshot()
          .ids.find((id) => id === nativeSessionId);
        if (root === undefined) return;
        unsubscribe();
        native.uiWorkspace.openSession(root);
      };
      const unsubscribe = list.subscribe(open);
      open();
      return unsubscribe;
    }, 'AllRice employee native root');
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
            navigate(id, session?.id);
          },
          onNewSession(id) {
            if (employeeChoice(workspace, id)) navigate(id);
          },
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
        createEmployee: {
          workspace: {
            organizationId,
            workspaceId: selection.workspaceId,
            viewerId,
          },
          headers: requestHeaders,
          onCreated: (instance) => navigate(instance.id),
        },
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
  void workspaceTask
    .then(async (workspace) => {
      signal.throwIfAborted();
      const employee = employeeChoice(workspace, selection.employeeInstanceId);
      if (!employee) return;
      const unread = position<number>();
      let keys: string[] | undefined;
      let firstRead = false;
      let unreadRequest: Promise<void> | undefined;
      function remember(seen: string[]) {
        try {
          localStorage.setItem(storageKey, JSON.stringify(seen.slice(-2000)));
        } catch {
          // The active page can still clear its unread count.
        }
      }
      function refreshUnread() {
        if (signal!.aborted || keys || unreadRequest) return;
        unreadRequest = filesClient
          .listDeliverables({ workspaceId: selection.workspaceId }, signal!)
          .then((catalog) => {
            if (signal!.aborted) return;
            keys = catalog.files.map((file) => file.objectId);
            let previous: Set<string> | null = null;
            try {
              previous = unreadKeys(localStorage.getItem(storageKey));
            } catch {
              // Browser storage can be unavailable. The file list still opens.
            }
            if (firstRead || !previous) remember(keys);
            unread.update(
              !firstRead && previous
                ? keys.filter((key) => !previous.has(key)).length
                : 0,
            );
          })
          .catch(() => {
            // The optional unread preflight does not own either panel.
            // The deliverables panel presents its own live result and retry.
          })
          .finally(() => {
            unreadRequest = undefined;
          });
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
        filesUnread: null,
        filesUnreadSource: unread,
        materials: { ...common, readOnly: true },
        files: {
          ...common,
          readOnly: true,
          refreshKey: ownerKey,
          currentEmployee: {
            id: selection.employeeInstanceId,
            name: employee.currentVersion.manifest.name,
          },
          onRead() {
            if (signal!.aborted) return;
            firstRead = true;
            if (keys) {
              remember(keys);
              if (unread.getSnapshot() !== 0) unread.update(0);
            } else if (unreadRequest) void unreadRequest.then(refreshUnread);
            else refreshUnread();
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
      refreshUnread();
    })
    .catch(() => {});
}
