import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from 'react';
import { createRoot } from 'react-dom/client';
import { EmployeeSidebar } from '../app/chatflow/employee-sidebar';
import { NativeSubagentDirectory } from '../app/chatflow/native-subagent-directory';
import { LegacySubagentDetailFixture } from './native-subagent-detail.fixture';
import {
  WorkbenchEntries,
  WorkbenchStart,
  moduleLabels,
  type WorkbenchModule,
} from '../app/chatflow/workbench-modules';
import { applyTheme } from '../lib/theme/theme';
import { NativeSubagentWorkbench } from '../app/chatflow/native-subagent-workbench';
import { WorkProcess } from '../app/chatflow/work-process';
import type {
  NativeSubagentReference,
  NativeSubagentViewScope,
} from '../lib/chatflow/native-subagent-view';
import { presentationPolicyFor } from '../app/chatflow/dsh-upstream/presentation/presentation-policy';
import {
  nativeSubagentReadyKey,
  useNativeSubagents,
} from '../app/chatflow/use-native-subagents';
import { createSessionRunStream } from '../app/chatflow/session-run-stream';
import conversationUi from '../app/chatflow/dsh-upstream/ConversationRoot.module.css';
import shellUi from '../app/chatflow/dsh-saas.module.css';
import type { Session, Workspace } from '../app/chatflow/chatflow-types';
import { DshDialog } from '../app/chatflow/dsh-upstream/Dialog';
import workbenchUi from '../app/chatflow/workbench-modules.module.css';
import { FocusController } from '../components/theme/focus-controller';

function FocusDialogFixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={workbenchUi.iconButton} onClick={() => setOpen(true)}>
        打开焦点测试表单
      </button>
      {open && (
        <DshDialog
          ariaLabel="焦点测试表单"
          title="焦点测试表单"
          initialFocusSelector="input"
          onClose={() => setOpen(false)}
        >
          <input aria-label="表单内容" />
        </DshDialog>
      )}
    </>
  );
}

export const sessions: Session[] = ['parent-a', 'parent-b', 'parent-c'].map(
  (id) => ({
    id,
    title: `${id} 父级任务`,
    ownerId: 'viewer',
    employeeAssignmentId: 'employee',
    employeeVersionId: 'version',
    visibility: 'private',
    updatedAt: '2026-10-30T00:00:00Z',
    archivedAt: null,
    running: false,
  }),
);
const workspace: Workspace = {
  viewerId: 'viewer',
  organizationId: 'org',
  workspaceId: 'workspace',
  employees: [],
  employeeProfiles: [],
  sessions,
  sessionModels: [],
  canAdminister: false,
};
const headers = {
  'x-allrice-organization-id': 'org',
  'x-allrice-workspace-id': 'workspace',
};
const rootRunId = 'root-run';
declare global {
  interface Window {
    nativeSubagentViewFixture: {
      reference: NativeSubagentReference | null;
      active: (value: boolean) => void;
      scope: (patch: Partial<NativeSubagentViewScope>) => void;
      close: () => void;
    };
  }
}
// Drives the fixture-only summary interactions.
function DetailFixture(
  props: Omit<
    ComponentProps<typeof LegacySubagentDetailFixture>,
    'selected' | 'onClose'
  >,
) {
  const [id, setId] = useState('fork-a');
  const [selected, setSelected] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <section
        aria-label="详情组件测试入口"
        style={{ position: 'fixed', top: 0, left: 0, zIndex: 90, width: 220 }}
      >
        <input
          aria-label="子任务 ID（测试）"
          style={{ width: 100 }}
          value={id}
          onChange={(event) => setId(event.target.value)}
        />
        <button ref={trigger} onClick={() => setSelected(id)}>
          打开详情（测试）
        </button>
        <button onClick={props.observation.refresh}>刷新观察（测试）</button>
      </section>
      <LegacySubagentDetailFixture
        {...props}
        selected={selected}
        onClose={() => {
          setSelected(null);
          trigger.current?.focus();
        }}
      />
    </>
  );
}
function Page() {
  const [activeId, setActiveId] = useState('parent-a');
  const query = new URLSearchParams(location.search);
  const childView = query.has('workbench');
  const [reference, setReference] = useState<NativeSubagentReference | null>(
    null,
  );
  const [childActive, setChildActive] = useState(true);
  const [scopePatch, setScopePatch] = useState<
    Partial<NativeSubagentViewScope>
  >({});
  const icons = query.has('icons');
  const [selected, setSelected] = useState<WorkbenchModule | null>(null);
  const rootEvents = query.has('root-events');
  const stream = useMemo(
    () =>
      createSessionRunStream({
        sessionId: activeId,
        workspaceId: 'workspace',
        tenantHeaders: headers,
        loadHistory: async () => {},
        loadWorkspace: async () => {},
        setError: () => {},
      }),
    [activeId],
  );
  const { runViews } = useSyncExternalStore(
    stream.subscribe,
    stream.getSnapshot,
    stream.getSnapshot,
  );
  useEffect(() => {
    stream.activate();
    if (rootEvents) void stream.streamRun(rootRunId);
    return stream.deactivate;
  }, [stream, rootEvents]);
  const nativeReadyKey = nativeSubagentReadyKey(runViews[rootRunId]);
  const childScope: NativeSubagentViewScope = {
    organizationId: headers['x-allrice-organization-id'],
    workspaceId: headers['x-allrice-workspace-id'],
    sessionId: activeId,
    viewerId: workspace.viewerId ?? null,
    ownerId: workspace.viewerId ?? null,
    rootRunId,
    generation: 1,
    bindingRevision: `initial/${nativeReadyKey}`,
    ...scopePatch,
  };
  window.nativeSubagentViewFixture = {
    reference,
    active: setChildActive,
    scope: setScopePatch,
    close: () => setReference(null),
  };
  const observation = useNativeSubagents(
    'workspace',
    headers,
    { [activeId]: `initial/${nativeReadyKey}` },
    false,
  );
  const presentation = presentationPolicyFor(
    query.get('view') === 'verbose' ? 'verbose' : 'detailed',
    query.get('collapse') === 'next-input' ? 'next-input' : 'completion',
  );
  return (
    <main style={{ display: 'flex', minHeight: 600 }}>
      <FocusController />
      <nav
        aria-label="业务会话"
        style={{
          width: 230,
          height: 500,
          display: icons ? 'none' : 'flex',
          flexDirection: 'column',
        }}
      >
        <EmployeeSidebar
          workspace={workspace}
          sessions={
            query.has('transport-pressure')
              ? [
                  ...sessions,
                  {
                    ...sessions[0]!,
                    id: 'parent-d',
                    title: 'parent-d 父级任务',
                  },
                ]
              : sessions
          }
          activeId={activeId}
          nativeReadyKey={nativeReadyKey}
          nativeReads={observation.reads}
          collapsed={false}
          onSelectSession={setActiveId}
          onPrepareSession={() => {}}
          onDetails={() => {}}
        />
      </nav>
      <section style={{ minWidth: 0, flex: icons ? 1 : undefined }}>
        <header className={shellUi.conversationHeader}>
          <div className={conversationUi.titleRow}>
            <h1>{activeId} 父级任务</h1>
            <div
              className={`${conversationUi.headerActions} ${shellUi.conversationActions}`}
            >
              <NativeSubagentDirectory
                key={activeId}
                workspaceId="workspace"
                sessionId={activeId}
                observation={observation}
                scope={childView ? childScope : undefined}
                onOpen={
                  childView
                    ? (next) => {
                        setReference(next);
                        setChildActive(true);
                      }
                    : undefined
                }
              />
              <WorkbenchEntries
                counts={{ files: 33, materials: 0, experience: 1, workflow: 0 }}
                experience
                workflow={icons && !query.has('no-workflow')}
                open={icons && selected !== null}
                selected={selected}
                onOpen={icons ? setSelected : () => {}}
                onToggle={() => {}}
              />
            </div>
          </div>
        </header>
        {query.has('focus') && <FocusDialogFixture />}
        {childView && query.has('compare') && (
          <WorkProcess
            label="主过程布局对照（测试）"
            items={[
              {
                id: 'tool:comparison',
                kind: 'tool',
                status: 'failed',
                sequence: 1,
                title: '读取记录',
                toolName: 'local.fs.read',
                detail: '授权可读的核对记录。'.repeat(12),
              },
            ]}
            running={false}
            streaming={false}
            failed={false}
            canceled={false}
            collapseTiming="next-input"
            onRetry={() => {}}
          />
        )}
        {childView && reference && (
          <NativeSubagentWorkbench
            scope={childScope}
            reference={reference}
            active={childActive}
            observation={observation}
            headers={headers}
            presentation={presentation}
          />
        )}
        {!childView && query.has('details') && (
          <DetailFixture
            key={activeId}
            workspaceId="workspace"
            sessionId={activeId}
            headers={headers}
            observation={observation}
            presentation={presentation}
          />
        )}
        {icons && !childView && (
          <section aria-label="图标工作台">
            <WorkbenchStart
              experience
              workflow={!query.has('no-workflow')}
              onOpen={setSelected}
            />
            <output aria-label="当前工作台模块">
              {selected ? moduleLabels[selected] : '未选择'}
            </output>
          </section>
        )}
        {rootEvents && (
          <output aria-label="root事件游标">
            {runViews[rootRunId]?.cursor ?? 'empty'}
          </output>
        )}
      </section>
    </main>
  );
}
const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'light' || theme === 'dark') applyTheme(theme);
createRoot(document.getElementById('root')!).render(<Page />);
