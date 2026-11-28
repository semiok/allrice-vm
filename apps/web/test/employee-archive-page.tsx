// Isolated real tenant/owner/shared detail entry; synthetic HTTP, no auth bypass.
import { useState, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { EmployeeSidebar } from '../../../packages/dsh-web-composition/src/employee-sidebar';
import { EmployeeFirstStart } from '../app/chatflow/4.0/employee-first-start';
import type { Workspace } from '../app/chatflow/chatflow-types';
import { ChatFlowClient } from '../app/chatflow/chatflow-client';
import { EmployeeDetailsDialog } from '../app/chatflow/employee-details-dialog';
import { useThemeSync } from '../components/theme/theme-controller';
import { setAppearance } from '../lib/theme/appearance';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '@allrice/ui/styles.css';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
setAppearance(
  new URLSearchParams(location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light',
);
const archiveHeaders = {
  'x-allrice-workspace-id': id(4),
  'x-allrice-organization-id': id(3),
  'x-allrice-expected-viewer-id': id(5),
};
const subscribe = () => () => {};
const panel = { activePanelId: 'conversation' };
function NativeSidebarFixture() {
  const [collapsed, setCollapsed] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace>(() => {
    const version = { id: id(18), manifest: { name: '流程哥' } };
    return {
      organizationId: id(3),
      workspaceId: id(4),
      viewerId: id(5),
      employees: [
        {
          id: id(17),
          employeeId: id(19),
          instanceId: id(17),
          isDefault: false,
          currentVersion: version,
          versions: [version],
        },
      ],
      sessions: [
        {
          id: id(1),
          ownerId: id(5),
          title: '保留的员工旧对话',
          employeeAssignmentId: id(17),
          employeeInstanceId: id(17),
          employeeVersionId: id(18),
          visibility: 'private',
          updatedAt: '2026-11-05T00:00:00.000Z',
          archivedAt: null,
        },
      ],
      employeeProfiles: [],
      sessionModels: [],
      canAdminister: false,
    };
  });
  const snapshot: NonNullable<
    ReturnType<
      ComponentProps<
        typeof EmployeeSidebar
      >['ctx']['allriceEmployeeSidebar']['getSnapshot']
    >
  > = {
    settingsOpen: false,
    tree: {
      workspace,
      sessions: workspace.sessions,
      activeId: id(1),
      onSelectSession() {},
      onNewSession() {},
      onEmployeeNavigate() {},
    },
  };
  const ctx = {
    layout: {
      panelInfo: { subscribe, getSnapshot: () => panel },
      toggleSidebar: () => setCollapsed(!collapsed),
    },
    allriceEmployeeSidebar: {
      subscribe,
      getSnapshot: () => snapshot,
      createEmployee() {},
      openEmployeeSettings() {},
      management: {
        scopeId: id(90),
        headers: archiveHeaders,
        onEmployeeChanged: (instance) =>
          setWorkspace((current) => ({
            ...current,
            employees: current.employees.map((employee) => ({
              ...employee,
              instances: [instance],
              currentVersion: {
                ...employee.currentVersion,
                manifest: {
                  name:
                    instance.profile.name ??
                    employee.currentVersion.manifest.name,
                },
              },
            })),
          })),
        onSessionChanged: (session) =>
          setWorkspace((current) => ({
            ...current,
            sessions: session.archivedAt ? [] : [session],
          })),
      } satisfies NonNullable<
        ComponentProps<
          typeof EmployeeSidebar
        >['ctx']['allriceEmployeeSidebar']['management']
      >,
    },
  };
  return (
    <main style={{ width: collapsed ? 56 : 300, height: '100dvh' }}>
      <EmployeeSidebar
        ctx={ctx as unknown as ComponentProps<typeof EmployeeSidebar>['ctx']}
        collapsed={collapsed}
        width={collapsed ? 56 : 300}
        renderSlot={() => null}
      />
    </main>
  );
}
function Fixture() {
  useThemeSync(location.pathname);
  const params = new URLSearchParams(location.search);
  if (params.has('native')) return <NativeSidebarFixture />;
  if (params.has('zero'))
    return (
      <EmployeeFirstStart
        organizationId={id(3)}
        workspaceId={id(4)}
        viewerId={id(5)}
      />
    );
  return params.has('shared') ? (
    <EmployeeDetailsDialog
      open
      scopeId={`${id(3)}/${id(4)}/${id(5)}`}
      workspaceId={id(4)}
      instanceId={id(17)}
      headers={{}}
      organizationView={{ organizationId: id(3), userId: id(5) }}
      onArchive={() => {
        throw new Error('Shared details cannot offer owner archival');
      }}
      onClose={() => history.back()}
    />
  ) : (
    <ChatFlowClient workbenchEnabled taskSuggestionsEnabled={false} />
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
