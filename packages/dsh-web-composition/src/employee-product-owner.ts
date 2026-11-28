import type { Context } from '@deepseek-ai/cordis';
import { ChatSessionSchema } from '@allrice/contracts';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { Workspace } from '../../../apps/web/app/chatflow/chatflow-types';
import { employeeSkillHostCopy } from '../../../apps/web/app/chatflow/employee-skill-host-copy';
import { readDEntryEmployeeSkills } from '../../../apps/web/app/chatflow/employee-skills-api';
import type { EmployeeSkillWriteStore } from '../../../apps/web/app/chatflow/employee-skills-host';
import {
  employeeChoice,
  sessionEmployeeKey,
} from '../../../apps/web/app/chatflow/employee-instances';
import { unreadKeys } from '../../../apps/web/app/chatflow/workbench-modules';
import { createEmployeePanelsHttpClient } from '../../../apps/web/lib/chatflow/employee-panel-data-http';
import {
  pageNavigate,
  pageNativeThreadRegistered,
  pageNativeThreadSelected,
  type PageNativeThreadRegistration,
  pageSwitchReady,
  pageThreadScope,
  pageThreadSelected,
  type PageThreadScope,
} from '../../../apps/web/lib/d-entry/page-messages';
import { readEmployeeDocument } from '../../../apps/web/lib/d-entry/profile-browser';
import { readEmployeeMemoryPageWrites } from '../../../apps/web/lib/memory/employee-memory-page-writes';
import { personalEmployeeMemorySourceReader } from '../../../apps/web/lib/memory/employee-memory-client';
import {
  bindEmployeeSidebar,
  type EmployeeSidebarSnapshot,
} from './employee-sidebar';
import {
  bindEmployeePanelsHttp,
  type EmployeePanelsSnapshot,
} from './employee-panels';
import { bindEmployeeSettings } from './employee-settings-port';

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
  if (!signal) return false;
  const data = document.getElementById('app')?.dataset;
  if (!data || signal.aborted) return true;
  const { scopeId, selection, viewerId, organizationId, nativeSessionId } =
    readEmployeeDocument(data);
  if (!nativeSessionId || !selection.threadId)
    throw Error('Employee session unavailable');
  const threadId = selection.threadId;
  const pageWrites = readEmployeeMemoryPageWrites(parent, scopeId, {
    organizationId,
    personId: viewerId,
    workspaceId: selection.workspaceId,
    employeeInstanceId: selection.employeeInstanceId,
  });
  let activeThreadId = threadId;

  const registered = new Map([[nativeSessionId, { threadId, scopeId }]]);
  let openRegisteredSession: ((thread: string) => boolean) | undefined;
  let startNativeSession: ((onError: () => void) => boolean) | undefined;
  let reflectNativeTitle: (() => void) | undefined;
  let beginNativeNavigation: (() => AbortSignal) | undefined;
  let activeNativeSession: string | undefined;
  let resourceScopeId = scopeId;
  let switchingScope = false;
  const sidebar = position<EmployeeSidebarSnapshot>();
  const panels = position<EmployeePanelsSnapshot>();
  const panelSelection = (nativeId: string) => {
    if (signal.aborted || switchingScope || nativeId !== activeNativeSession)
      return null;
    const root = registered.get(nativeId);
    return root?.scopeId === resourceScopeId && root.threadId === activeThreadId
      ? { selection: { ...selection, threadId: root.threadId }, viewerId }
      : null;
  };
  if (data.loginSessionId)
    bindEmployeeSettings(ctx, {
      signal,
      loginSessionId: data.loginSessionId,
      isCurrentRoot: (id) => panelSelection(id) !== null,
      subscribe: panels.subscribe,
    });
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
  function navigate(
    employeeInstanceId: string,
    target?: string,
    reopen = false,
  ) {
    signal!.throwIfAborted();
    beginNativeNavigation?.();
    parent.postMessage(
      {
        type: pageNavigate,
        scopeId,
        ...(reopen && { reopen }),
        selection: {
          workspaceId: selection.workspaceId,
          employeeInstanceId,
          threadId: target,
        },
      },
      location.origin,
    );
  }
  function selectThread(thread: string) {
    activeThreadId = thread;
    const previous = sidebar.getSnapshot();
    if (previous?.tree && previous.tree.activeId !== thread)
      sidebar.update({
        ...previous,
        tree: { ...previous.tree, activeId: thread },
      });
    reflectNativeTitle?.();
    const panel = panels.getSnapshot();
    const panelKey = resourceScopeId + '/' + thread;
    if (!panel || panel.scopeKey === panelKey) return;
    panels.update({
      ...panel,
      scopeKey: panelKey,
      publicationManagement: {
        organizationId,
        employeeInstanceId: selection.employeeInstanceId,
        threadId: thread,
      },
      materials: {
        ...panel.materials,
        ownerKey: panelKey,
        sessionId: thread,
      },
      files: {
        ...panel.files,
        ownerKey: panelKey,
        sessionId: thread,
        refreshKey: panelKey,
      },
      filePreview: undefined,
    });
  }

  function followSelection() {
    if (signal!.aborted || switchingScope || !activeNativeSession) return;
    const current = sidebar.getSnapshot();
    const root = registered.get(activeNativeSession);
    const thread = root?.threadId;
    if (
      root?.scopeId !== resourceScopeId ||
      !thread ||
      !current?.tree ||
      current.tree.activeId === thread ||
      !current.tree.sessions.some((row) => row.id === thread)
    )
      return;
    selectThread(thread);
    parent.postMessage(
      {
        type: pageNativeThreadSelected,
        scopeId,
        resourceScopeId,
        selection: { ...selection, threadId: thread },
      },
      location.origin,
    );
  }

  // rc.2 publishes the Session displayed by the Conversation through its
  // native sidebar controller. A registered fork may never become selected.
  ctx.inject(['sidebarRight'], (native) => {
    native.effect(() => {
      const update = () => {
        activeNativeSession = native.sidebarRight.mounted.getSnapshot();
        followSelection();
        reflectNativeTitle?.();
      };
      const unsubscribe = native.sidebarRight.mounted.subscribe(update);
      update();
      return unsubscribe;
    }, 'AllRice selected native conversation');
  });

  const clear = () => {
    sidebar.update(null);
    panels.update(null);
  };
  signal.addEventListener('abort', clear, { once: true });
  ctx.effect(() => () => {
    signal.removeEventListener('abort', clear);
    document.removeEventListener(pageNativeThreadRegistered, registerThread);
    clear();
  });
  ctx.inject(['uiWorkspace', 'sessions', 'workspaces', 'layout'], (native) => {
    native.effect(() => {
      const list = native.sessions.list;
      const beginNavigation = () => native.layout.beginNavigation();
      beginNativeNavigation = beginNavigation;
      const reflect = () => {
        if (signal.aborted || switchingScope) return;
        const current = sidebar.getSnapshot();
        if (!current?.tree) return;
        const catalog = list.getSnapshot();
        const titles = new Map<string, string>();
        for (const nativeId of catalog.ids) {
          const root = registered.get(nativeId);
          const title = catalog.byId[nativeId]?.title;
          if (root && title) titles.set(root.threadId, title);
        }
        if (!titles.size) return;
        let changed = false;
        const sessions = current.tree.sessions.map((session) => {
          const title = titles.get(session.id);
          if (
            !title ||
            title === session.title ||
            sessionEmployeeKey(session) !== selection.employeeInstanceId ||
            session.ownerId !== viewerId
          )
            return session;
          changed = true;
          return { ...session, title };
        });
        if (!changed) return;
        sidebar.update({
          ...current,
          tree: {
            ...current.tree,
            sessions,
            workspace: { ...current.tree.workspace, sessions },
          },
        });
      };
      reflectNativeTitle = reflect;
      const unsubscribeTitle = list.subscribe(reflect);
      reflect();
      const select = (thread: string) => {
        if (signal.aborted || switchingScope) return false;
        const session = list.getSnapshot().ids.find((candidate) => {
          const root = registered.get(candidate);
          return root?.scopeId === resourceScopeId && root.threadId === thread;
        });
        if (session === undefined) return false;
        beginNavigation();
        native.uiWorkspace.openSession(session);
        return true;
      };
      let disposed = false;
      let creating = false;
      const start = (onError: () => void) => {
        const source = activeNativeSession;
        const sourceScope = resourceScopeId;
        if (signal.aborted || switchingScope || !source) return false;
        const sourceRoot = registered.get(source);
        if (
          sourceRoot?.scopeId !== sourceScope ||
          sourceRoot.threadId !== activeThreadId
        )
          return false;
        const workspace = native.workspaces.list
          .getSnapshot()
          .items.find((item) => item.sessionIds.some((id) => id === source));
        if (!workspace) return false;
        if (creating) return true;
        creating = true;
        const sourceThread = activeThreadId;
        const navigation = beginNavigation();
        const current = () =>
          !disposed &&
          !signal.aborted &&
          !navigation.aborted &&
          !switchingScope &&
          activeThreadId === sourceThread &&
          resourceScopeId === sourceScope;
        // rc.2 makes the created session addressable before resolving.
        // Its business registration arrived on this same authenticated scope.
        void native.sessions
          .create({ workspaceId: workspace.workspaceId })
          .then((id) => {
            if (!current()) return;
            const root = registered.get(id);
            if (root?.scopeId !== sourceScope) return onError();
            if (!select(root.threadId))
              navigate(selection.employeeInstanceId, root.threadId);
          })
          .catch(() => {
            if (current()) onError();
          })
          .finally(() => {
            creating = false;
          });
        return true;
      };
      openRegisteredSession = select;
      startNativeSession = start;
      const open = () => {
        if (signal.aborted) return;
        // rc.2 cannot retain a Session until its native summary has arrived.
        const root = list
          .getSnapshot()
          .ids.find((id) => id === nativeSessionId);
        if (root === undefined) return;
        unsubscribe();
        // rc.2 restores its last selection during the same catalog update.
        // Let those subscribers finish, then supersede any pending restore.
        queueMicrotask(() => {
          if (disposed || signal.aborted || switchingScope) return;
          native.layout.beginNavigation();
          native.uiWorkspace.openSession(root);
        });
      };
      const unsubscribe = list.subscribe(open);
      open();
      return () => {
        disposed = true;
        if (openRegisteredSession === select) openRegisteredSession = undefined;
        if (startNativeSession === start) startNativeSession = undefined;
        if (reflectNativeTitle === reflect) reflectNativeTitle = undefined;
        if (beginNativeNavigation === beginNavigation)
          beginNativeNavigation = undefined;
        unsubscribeTitle();
        unsubscribe();
      };
    }, 'AllRice employee native root');
  });
  ctx.inject(
    ['uiWorkspace', 'sessions', 'connection', 'sidebarRight'],
    (native) => {
      native.effect(() => {
        // rc.2 exports the browser handle without augmenting Cordis Context.
        // This effect is installed only while Cordis injects that service.
        const { connection } = native as Context & {
          connection: ConnectionHandle;
        };
        let pending:
          | {
              scope: PageThreadScope;
              oldGeneration: ReturnType<
                typeof connection.generation.getSnapshot
              >;
              opened: boolean;
            }
          | undefined;
        const update = () => {
          if (!pending || signal.aborted) return;
          const request = pending;
          const generation = connection.generation.getSnapshot();
          if (!generation || generation === pending.oldGeneration) return;
          const root = native.sessions.list
            .getSnapshot()
            .ids.find((id) => id === pending?.scope.nativeSessionId);
          if (!root) return;
          if (!pending.opened) {
            pending.opened = true;
            native.uiWorkspace.openSession(root);
          }
          if (pending !== request) return;
          if (native.sidebarRight.mounted.getSnapshot() !== root) return;
          const next = pending.scope;
          pending = undefined;
          switchingScope = false;
          activeNativeSession = next.nativeSessionId;
          selectThread(next.threadId);
          parent.postMessage(
            {
              type: pageThreadSelected,
              scopeId,
              resourceScopeId: next.scopeId,
            },
            location.origin,
          );
        };
        const onScope = (event: Event) => {
          if (signal.aborted) return;
          const next = (event as CustomEvent<PageThreadScope>).detail;
          beginNativeNavigation?.();
          resourceScopeId = next.scopeId;
          registered.set(next.nativeSessionId, {
            threadId: next.threadId,
            scopeId: next.scopeId,
          });
          switchingScope = true;
          pending = {
            scope: next,
            oldGeneration: connection.generation.getSnapshot(),
            opened: false,
          };
          connection.reconnect();
        };
        document.addEventListener(pageThreadScope, onScope);
        const cleanup = [
          connection.generation.subscribe(update),
          native.sessions.list.subscribe(update),
          native.sidebarRight.mounted.subscribe(update),
        ];
        parent.postMessage({ type: pageSwitchReady, scopeId }, location.origin);
        return () => {
          document.removeEventListener(pageThreadScope, onScope);
          cleanup.forEach((unsubscribe) => unsubscribe());
        };
      }, 'AllRice authorized thread selection');
    },
  );

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

  function registerThread(event: Event) {
    if (signal!.aborted) return;
    const receipt = (event as CustomEvent<PageNativeThreadRegistration>).detail;
    if (
      !receipt ||
      receipt.scopeId !== scopeId ||
      receipt.resourceScopeId !== resourceScopeId ||
      typeof receipt.nativeSessionId !== 'string' ||
      !receipt.nativeSessionId
    )
      return;
    if (registered.get(receipt.nativeSessionId)?.scopeId === resourceScopeId)
      return;
    const parsed = ChatSessionSchema.safeParse(receipt.thread);
    if (!parsed.success) return;
    const session = parsed.data;
    if (
      session.ownerId !== viewerId ||
      session.organizationId !== organizationId ||
      session.workspaceId !== selection.workspaceId ||
      sessionEmployeeKey(session) !== selection.employeeInstanceId ||
      session.visibility !== 'private' ||
      session.archivedAt !== null
    )
      return;
    registered.set(receipt.nativeSessionId, {
      threadId: session.id,
      scopeId: receipt.resourceScopeId,
    });
    void workspaceTask
      .then(() => {
        if (signal!.aborted) return;
        const current = sidebar.getSnapshot();
        if (!current?.tree) return;
        const sessions = [
          session,
          ...current.tree.sessions.filter(({ id }) => id !== session.id),
        ];
        sidebar.update({
          ...current,
          tree: {
            ...current.tree,
            sessions,
            workspace: { ...current.tree.workspace, sessions },
          },
        });
        followSelection();
        reflectNativeTitle?.();
      })
      .catch(() => {});
  }
  document.addEventListener(pageNativeThreadRegistered, registerThread);

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
          activeId: activeThreadId,
          onSelectSession(id) {
            if (switchingScope) return;
            const tree = sidebar.getSnapshot()?.tree;
            if (!tree || id === tree.activeId) return;
            const selected = tree.sessions.find((session) => session.id === id);
            if (!selected) return;
            if (!openRegisteredSession?.(id))
              navigate(sessionEmployeeKey(selected), selected.id);
          },
          onEmployeeNavigate(id) {
            if (!employeeChoice(workspace, id)) return;
            if (id === selection.employeeInstanceId) {
              navigate(id, activeThreadId);
              return;
            }
            const session = sessions.find(
              (row) => sessionEmployeeKey(row) === id,
            );
            navigate(id, session?.id, !session);
          },
          onNewSession(id) {
            if (!employeeChoice(workspace, id) || switchingScope) return;
            if (
              id === selection.employeeInstanceId &&
              startNativeSession?.(() => notice('暂时无法新建会话。'))
            )
              return;
            navigate(id);
          },
          onDetails: () => notice('当前入口暂无法打开员工详情。'),
        },
      };
      function notice(error: string) {
        const current = sidebar.getSnapshot();
        if (!signal!.aborted && current) sidebar.update({ ...current, error });
      }
      sidebar.update(initial);
      followSelection();
      reflectNativeTitle?.();
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
          onCreated: (instance) => navigate(instance.id, undefined, true),
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
        sessionId: activeThreadId,
        headers: requestHeaders,
      };
      const skillWrites: EmployeeSkillWriteStore = new Map();
      const employeeName = employee.currentVersion.manifest.name;
      const workflow: EmployeePanelsSnapshot['workflow'] = ({
        signal: tabSignal,
      }) => {
        const scopeKey = panels.getSnapshot()?.scopeKey ?? ownerKey;
        const root = activeNativeSession;
        const selectedThread = activeThreadId;
        const skillScope = {
          scopeId: scopeKey,
          workspaceId: selection.workspaceId,
          instanceId: selection.employeeInstanceId,
          headers: requestHeaders,
        };
        return {
          employeeName,
          scopeKey,
          onRead() {},
          showSkills: true,
          children: null,
          skillsHost: {
            scope: skillScope,
            ownerView: true,
            employeeName,
            writes: skillWrites,
            copy: employeeSkillHostCopy,
            backLabel: '返回能力列表',
            // Configuration is available independently of the Guest registry.
            readOnlyCatalog: async (caller) => {
              const active = AbortSignal.any([signal, tabSignal, caller]);
              const assertCurrent = () => {
                active.throwIfAborted();
                if (
                  !root ||
                  panelSelection(root)?.selection.threadId !== selectedThread ||
                  panels.getSnapshot()?.scopeKey !== scopeKey
                )
                  throw new DOMException(
                    'Employee panel retired',
                    'AbortError',
                  );
              };
              assertCurrent();
              const skills = await readDEntryEmployeeSkills(
                skillScope,
                { threadId: selectedThread, expectedViewerId: viewerId },
                active,
              );
              assertCurrent();
              return skills;
            },
            scopeSignal: signal,
            lifetimeSignal: tabSignal,
          },
        };
      };
      const initial: EmployeePanelsSnapshot = {
        scopeKey: ownerKey,
        publicationManagement: {
          organizationId,
          employeeInstanceId: selection.employeeInstanceId,
          threadId: activeThreadId,
        },
        filesUnread: null,
        filesUnreadSource: unread,
        workflow,
        materials: { ...common, readOnly: true },
        files: {
          ...common,
          readOnly: true,
          refreshKey: ownerKey,
          currentEmployee: {
            id: selection.employeeInstanceId,
            name: employeeName,
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
        experience:
          pageWrites || parent === window
            ? {
                management: {
                  scopeId: ownerKey,
                  workspaceId: selection.workspaceId,
                  instanceId: selection.employeeInstanceId,
                  employeeName: employee.currentVersion.manifest.name,
                  headers: requestHeaders,
                  ownerSignal: signal,
                  pageWrites,
                  writes: pageWrites ? undefined : new Map(),
                  readSource:
                    personalEmployeeMemorySourceReader(requestHeaders),
                },
              }
            : undefined,
      };
      panels.update(initial);
      await bindEmployeePanelsHttp(
        ctx,
        {
          getSnapshot: (id) =>
            panelSelection(id) ? panels.getSnapshot() : null,
          subscribe: (_id, listener) => panels.subscribe(listener),
        },
        panelSelection,
      );
      refreshUnread();
    })
    .catch(() => {});
  return true;
}
