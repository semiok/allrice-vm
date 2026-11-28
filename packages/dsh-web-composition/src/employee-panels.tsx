import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {
  PropsRuntime,
  SessionIdOf,
} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path';
import { EnterpriseMaterialsPanel } from '../../../apps/web/app/chatflow/enterprise-materials-panel';
import { WorkbenchFilesPanel } from '../../../apps/web/app/chatflow/workbench-files-panel';
import { EmployeeMemorySidebar } from '../../../apps/web/app/chatflow/employee-memory-sidebar';
import { EmployeeMemoryManager } from '../../../apps/web/app/chatflow/employee-memory-manager';
import { EmployeeCapabilitiesPanel } from '../../../apps/web/app/chatflow/employee-capabilities-panel';
import {
  WorkbenchEntries,
  WorkbenchStart,
  moduleLabels,
} from '../../../apps/web/app/chatflow/workbench-modules';
import {
  assertEmployeePanelsCurrent,
  assertEmployeePanelSession,
  employeePanelKinds,
  employeePanelsActions,
  employeePanelsSnapshot,
  guardEmployeePanelProps,
  subscribeEmployeePanels,
  insertEmployeePanelReference,
  type EmployeePanelKind,
} from './employee-panels-model';
import type {
  EmployeePanelsBinding,
  EmployeePanelsPort,
  EmployeePanelsSnapshot,
} from './employee-panels-port';
import { WorkbenchDeliverablePreview } from '../../../apps/web/app/chatflow/workspace-file-preview';
import type { ReferencePublicationTarget } from '../../../apps/web/app/chatflow/reference-publication-dialog';
import type { ReferencePublicationOptions } from '../../../apps/web/app/chatflow/use-reference-publication-options';
import publicationCss from '../../../apps/web/app/chatflow/enterprise-materials-panel.module.css';
import '@allrice/ui/tokens.css';
import css from './employee-panels.module.css';
import {
  createEmployeePanelsDataPort,
  type EmployeePanelsDataResolver,
} from './employee-panels-data';
import {
  createEmployeePanelsHttpResolver,
  type EmployeePanelsHttpOptions,
} from '../../../apps/web/lib/chatflow/employee-panel-data-http';

const ReferencePublicationDialog = lazy(() =>
  import('../../../apps/web/app/chatflow/reference-publication-dialog').then(
    ({ ReferencePublicationDialog }) => ({
      default: ReferencePublicationDialog,
    }),
  ),
);
const ReferencePublicationPending = lazy(() =>
  import('../../../apps/web/app/chatflow/reference-publication-dialog').then(
    ({ ReferencePublicationPending }) => ({
      default: ReferencePublicationPending,
    }),
  ),
);
const publicationNotices = {
  file: '已添加为企业资料',
  upload: '已发布',
  audience: '范围已修改',
  revoke: '资料已撤销',
  delete: '资料已删除',
};

function useOwner(binding: EmployeePanelsBinding, sessionId: SessionIdOf) {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeEmployeePanels(binding, sessionId, listener),
    [binding, sessionId],
  );
  const read = useCallback(
    () => employeePanelsSnapshot(binding, sessionId),
    [binding, sessionId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

type EmployeePanelContentProps = {
  ctx: Context;
  binding: EmployeePanelsBinding;
  sessionId: SessionIdOf;
  snapshot: EmployeePanelsSnapshot;
  signal: AbortSignal;
  kind: EmployeePanelKind;
};

type PublicationActions = {
  edit(
    target: ReferencePublicationTarget,
    options?: ReferencePublicationOptions,
  ): void;
  createdMaterial?: { sourceId: string; revisionId: string };
};

/** Exported render seam uses the real components. */
export function EmployeePanelContent(props: EmployeePanelContentProps) {
  const { kind, snapshot } = props;
  if (
    kind === 'experience' &&
    snapshot.experience &&
    'management' in snapshot.experience
  )
    return (
      <EmployeePersonalMemoryPanel
        {...props}
        management={snapshot.experience.management}
      />
    );
  if (kind === 'materials' || kind === 'files') {
    const data = snapshot[kind];
    if (snapshot.publicationManagement && data.viewerId && data.dataClient)
      return (
        <EmployeePublicationPanel
          key={JSON.stringify([
            snapshot.scopeKey,
            data.viewerId,
            snapshot.publicationManagement,
          ])}
          {...props}
          kind={kind}
          viewerId={data.viewerId}
        />
      );
  }
  return employeePanelView(props);
}

function EmployeePersonalMemoryPanel({
  ctx,
  binding,
  sessionId,
  snapshot: { scopeKey },
  signal,
  management,
}: EmployeePanelContentProps & {
  management: React.ComponentProps<typeof EmployeeMemoryManager>;
}) {
  const assertCurrent = useCallback(() => {
    assertEmployeePanelSession(ctx, sessionId);
    assertEmployeePanelsCurrent(binding, sessionId, { scopeKey }, signal);
  }, [ctx, binding, sessionId, scopeKey, signal]);
  return (
    <EmployeeMemoryManager
      {...management}
      active
      lifetimeSignal={signal}
      assertCurrent={assertCurrent}
    />
  );
}

function EmployeePublicationPanel({
  viewerId,
  ...props
}: Omit<EmployeePanelContentProps, 'kind'> & {
  kind: 'materials' | 'files';
  viewerId: string;
}) {
  const { binding, kind, signal, snapshot } = props;
  const { workspaceId, headers, dataClient } = snapshot[kind];
  const [publication, setPublication] = useState<{
    target: ReferencePublicationTarget;
    options?: ReferencePublicationOptions;
  } | null>(null);
  const [notice, setNotice] = useState('');
  const [createdMaterial, setCreatedMaterial] = useState<{
    sourceId: string;
    revisionId: string;
  }>();
  return (
    <>
      {dataClient && snapshot.publicationManagement && (
        <Suspense fallback={null}>
          <ReferencePublicationPending
            workspaceId={workspaceId}
            viewerId={viewerId}
            receiptScope={snapshot.publicationManagement}
            dataClient={dataClient}
            panel={kind}
            dialogOpen={publication !== null}
            signal={signal}
          />
        </Suspense>
      )}
      {employeePanelView(props, {
        createdMaterial,
        edit(target, options) {
          setNotice('');
          setPublication({ target, options });
        },
      })}
      {publication && (
        <Suspense fallback={null}>
          <ReferencePublicationDialog
            workspaceId={workspaceId}
            viewerId={viewerId}
            headers={headers}
            dataClient={dataClient}
            receiptScope={snapshot.publicationManagement}
            target={publication.target}
            options={publication.options}
            onClose={() => setPublication(null)}
            onSaved={(saved) => {
              if (signal.aborted || binding.signal.aborted) return;
              if (publication.target.kind === 'upload' && saved.revisionId)
                setCreatedMaterial({
                  sourceId: saved.sourceId,
                  revisionId: saved.revisionId,
                });
              setPublication(null);
              setNotice(publicationNotices[publication.target.kind]);
              window.dispatchEvent(
                new Event('allrice:workbench-files-changed'),
              );
            }}
          />
        </Suspense>
      )}
      {notice && (
        <div className={publicationCss.toast} role="status">
          {notice}
        </div>
      )}
    </>
  );
}

function employeePanelView(
  {
    binding,
    ctx,
    kind,
    sessionId,
    signal,
    snapshot,
  }: EmployeePanelContentProps,
  publication?: PublicationActions,
) {
  const current = () => {
    assertEmployeePanelSession(ctx, sessionId);
    assertEmployeePanelsCurrent(binding, sessionId, snapshot, signal);
  };
  const reference = (
    value: Parameters<typeof insertEmployeePanelReference>[4],
  ) => {
    current();
    insertEmployeePanelReference(binding, sessionId, snapshot, signal, value);
  };
  const edit = (
    target: ReferencePublicationTarget,
    options?: ReferencePublicationOptions,
  ) => {
    current();
    publication?.edit(target, options);
  };
  switch (kind) {
    case 'materials': {
      const props = guardEmployeePanelProps(snapshot.materials, current);
      return (
        <EnterpriseMaterialsPanel
          {...props}
          active
          readOnly={snapshot.materials.readOnly || !binding.port.useReference}
          initialReference={
            publication?.createdMaterial ?? props.initialReference
          }
          onUse={reference}
          onUpload={
            publication
              ? (options) => edit({ kind: 'upload' }, options)
              : props.onUpload
          }
          onManage={
            publication
              ? (reference, kind, options) => edit({ kind, reference }, options)
              : props.onManage
          }
        />
      );
    }
    case 'files': {
      const readOnly = snapshot.files.readOnly || !binding.port.useReference;
      const props = guardEmployeePanelProps(snapshot.files, current);
      const publish: typeof props.onPublish = publication
        ? (file) => edit({ kind: 'file', file })
        : props.onPublish;
      if (snapshot.filePreview)
        return (
          <WorkbenchDeliverablePreview
            scope={snapshot.scopeKey}
            viewerId={props.viewerId}
            objectId={snapshot.filePreview.objectId}
            workspaceId={props.workspaceId}
            tenantHeaders={props.headers}
            dataClient={props.dataClient}
            active
            onBack={() => {
              current();
              snapshot.filePreview?.close();
            }}
            onPublish={publication ? publish : undefined}
            fileActions={
              readOnly
                ? undefined
                : { sessionId: props.sessionId, onUse: reference }
            }
          />
        );
      return (
        <WorkbenchFilesPanel
          {...props}
          active
          readOnly={readOnly}
          onUse={reference}
          onPublish={publish}
        />
      );
    }
    case 'experience':
      if (!snapshot.experience || 'management' in snapshot.experience)
        return null;
      return (
        <EmployeeMemorySidebar
          {...guardEmployeePanelProps(snapshot.experience, current)}
          active
        />
      );
    case 'workflow':
      if (!snapshot.workflow) return null;
      return (
        <EmployeeCapabilitiesPanel
          {...guardEmployeePanelProps(
            snapshot.workflow(
              employeePanelsActions(ctx, binding, sessionId, snapshot, signal),
            ),
            current,
          )}
          active
        />
      );
  }
}

export function EmployeePanelBody({
  ctx,
  binding,
  kind,
  sessionId,
  useTabInfo,
}: PropsRuntime<'sidebar.right.pane.tab'> & {
  ctx: Context;
  binding: EmployeePanelsBinding;
  kind: EmployeePanelKind;
}) {
  const snapshot = useOwner(binding, sessionId);
  const { tab } = useTabInfo();
  const lifetime = useMemo(
    () => new AbortController(),
    [sessionId, snapshot?.scopeKey, tab.signal, tab.visible],
  );
  useEffect(() => () => lifetime.abort(), [lifetime]);
  const signal = useMemo(
    () => AbortSignal.any([binding.signal, tab.signal, lifetime.signal]),
    [binding.signal, tab.signal, lifetime],
  );
  if (!snapshot || !tab.visible || signal.aborted) return null;
  return (
    <div className={`${css.surface} ${css.body}`} key={snapshot.scopeKey}>
      <EmployeePanelContent
        ctx={ctx}
        binding={binding}
        sessionId={sessionId}
        snapshot={snapshot}
        signal={signal}
        kind={kind}
      />
    </div>
  );
}

export function EmployeePanelsHeader({
  ctx,
  binding,
  sessionId,
}: PropsRuntime<'conversation.session.header.actions'> & {
  ctx: Context;
  binding: EmployeePanelsBinding;
}) {
  const snapshot = useOwner(binding, sessionId);
  const filesUnread = useEmployeePanelsUnread(snapshot);
  return snapshot ? (
    <div className={`${css.surface} ${css.header}`}>
      <EmployeePanelsEntries
        ctx={ctx}
        binding={binding}
        sessionId={sessionId}
        snapshot={snapshot}
        filesUnread={filesUnread}
      />
    </div>
  ) : null;
}

const noUnreadSubscription = () => () => undefined;

export function useEmployeePanelsUnread(
  snapshot: EmployeePanelsSnapshot | null,
) {
  const source = snapshot?.filesUnreadSource;
  const read = source?.getSnapshot ?? (() => snapshot?.filesUnread ?? null);
  return useSyncExternalStore(
    source?.subscribe ?? noUnreadSubscription,
    read,
    read,
  );
}

/** Four launchers reuse the approved view; native panes own selection state. */
export function EmployeePanelsEntries({
  ctx,
  binding,
  sessionId,
  snapshot,
  filesUnread = snapshot.filesUnread,
}: {
  ctx: Context;
  binding: EmployeePanelsBinding;
  sessionId: SessionIdOf;
  snapshot: EmployeePanelsSnapshot;
  filesUnread?: number | null;
}) {
  return (
    <WorkbenchEntries
      counts={{
        files: filesUnread ?? 0,
        materials: 0,
        experience: 0,
        workflow: 0,
      }}
      experience={!!snapshot.experience}
      workflow={!!snapshot.workflow}
      open={ctx.sidebarRight.isExpanded()}
      showToggle={false}
      onToggle={() => ctx.sidebarRight.toggleExpanded()}
      onOpen={(kind) => {
        assertEmployeePanelSession(ctx, sessionId);
        assertEmployeePanelsCurrent(binding, sessionId, snapshot);
        ctx.sidebarRight.openTab(employeePanelKinds[kind]);
      }}
    />
  );
}

/** Native guide tab/chrome remain the owner; reuse the existing four cards. */
export function EmployeePanelsGuide({
  ctx,
  binding,
  sessionId,
  useTabInfo,
}: PropsRuntime<'sidebar.right.tab.guide'> & {
  ctx: Context;
  binding: EmployeePanelsBinding;
}) {
  const snapshot = useOwner(binding, sessionId);
  const { tab } = useTabInfo();
  if (!snapshot || !tab.visible) return null;
  return (
    <div className={`${css.surface} ${css.body}`}>
      <WorkbenchStart
        experience={!!snapshot.experience}
        workflow={!!snapshot.workflow}
        onOpen={(kind) => {
          assertEmployeePanelSession(ctx, sessionId);
          assertEmployeePanelsCurrent(binding, sessionId, snapshot, tab.signal);
          tab.actions.openTab(employeePanelKinds[kind], { replaceTab: true });
        }}
      />
    </div>
  );
}

const nativeDeliveryTab = 'allrice-native-delivery';
const exactDeliveryResource = 'dsh-resource://allrice-delivery-version/';

function presentedCoordinates(actionUrl: string, sessionId: string) {
  const url = new URL(actionUrl, 'https://allrice.invalid/');
  const fields = url.searchParams;
  const sequence = Number(fields.get('seq'));
  const index = Number(fields.get('index'));
  if (
    url.origin !== 'https://allrice.invalid' ||
    url.pathname !== '/api/present.open' ||
    fields.get('sessionId') !== sessionId ||
    !fields.has('seq') ||
    !fields.has('index') ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= 8
  )
    return;
  return { sequence, index };
}

function exactDeliveryAddress(address: string) {
  if (!address.startsWith(exactDeliveryResource)) return;
  const [session, sequence, index, extra] = address
    .slice(exactDeliveryResource.length)
    .split('/');
  if (!session || extra !== undefined) return;
  try {
    const sessionId = decodeURIComponent(session);
    const query = new URLSearchParams({
      sessionId,
      seq: sequence ?? '',
      index: index ?? '',
    });
    const coords = presentedCoordinates('api/present.open?' + query, sessionId);
    return coords && { sessionId, ...coords };
  } catch {
    return;
  }
}

function NativeDeliveryVersionAction({
  actionUrl,
  sessionId,
  ctx,
  binding,
}: PropsRuntime<'deliverables.file.actions'> & {
  ctx: Context;
  binding: EmployeePanelsBinding;
}) {
  const snapshot = useOwner(binding, sessionId);
  const coords = presentedCoordinates(actionUrl, sessionId);
  if (!coords || !snapshot?.files.dataClient) return null;
  return (
    <button
      type="button"
      onClick={() => {
        assertEmployeePanelSession(ctx, sessionId);
        assertEmployeePanelsCurrent(
          binding,
          sessionId,
          { scopeKey: snapshot.scopeKey },
          binding.signal,
        );
        ctx.sidebarRight.openResource(
          exactDeliveryResource +
            [encodeURIComponent(sessionId), coords.sequence, coords.index].join(
              '/',
            ),
        );
      }}
    >
      查看此版本详情
    </button>
  );
}

function nativeDeliveryAddress(ctx: Context, address: string) {
  const file = parseFileAddress(address);
  const currentSessionId = ctx.sidebarRight.mounted.getSnapshot();
  if (
    file?.scope !== 'session' ||
    !currentSessionId ||
    file.sessionId !== currentSessionId ||
    (file.path.startsWith('/') && !file.path.startsWith('/work/'))
  )
    return;
  const canonical = file.path.startsWith('/')
    ? file.path
    : [
        ctx.sessions?.list.getSnapshot().byId[currentSessionId]?.cwd,
        file.path,
      ].join('/');
  if (!canonical.startsWith('/work/')) return;
  const parts = canonical
    .slice('/work/'.length)
    .split('/')
    .filter((part) => part && part !== '.');
  if (
    !parts.length ||
    parts.some((part) => part.startsWith('.')) ||
    Array.from(file.path).some(
      (part) => part < ' ' || part === '\u007f' || part === '\\',
    )
  )
    return;
  return {
    sessionId: currentSessionId,
    path: '/work/' + parts.join('/'),
    name: parts.at(-1)!,
  };
}

/** A file address does not encode its triggering view. Only addresses
 * announced by a loaded native delivery card belong to this extension. */
function visibleNativeDelivery(ctx: Context, address: string) {
  const file = nativeDeliveryAddress(ctx, address);
  if (!file) return;
  try {
    const chat = ctx.uiConversation
      .binding(file.sessionId)
      .target('chat')
      .getSnapshot();
    if (
      chat?.nodes.values().some(({ location }) => {
        if (location.kind !== 'turn' && location.kind !== 'step') return false;
        const data = location.turn.data as {
          get(
            key: 'deliverables',
          ): { presented?: readonly { path: string }[] } | undefined;
        };
        return (
          data
            .get('deliverables')
            ?.presented?.some(({ path }) => path === file.path) ?? false
        );
      })
    )
      return file;
  } catch {
    // A disposed native Session does not own any deliverable addresses.
  }
}

async function deliveryDigest(value: readonly (string | number)[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function EmployeeNativeDelivery({
  ctx,
  binding,
  sessionId,
  useTabInfo,
}: PropsRuntime<'sidebar.right.pane.tab'> & {
  ctx: Context;
  binding: EmployeePanelsBinding;
}) {
  const snapshot = useOwner(binding, sessionId);
  const { tab } = useTabInfo();
  const visit = tab.navigation.revision;
  const lifetime = useMemo(
    () => new AbortController(),
    [
      sessionId,
      tab.signal,
      tab.contentId,
      tab.visible,
      snapshot?.scopeKey,
      visit,
    ],
  );
  useEffect(() => () => lifetime.abort(), [lifetime]);
  const signal = useMemo(
    () => AbortSignal.any([binding.signal, tab.signal, lifetime.signal]),
    [binding.signal, tab.signal, lifetime.signal],
  );
  const data = snapshot?.files.dataClient;
  const workspaceId = snapshot?.files.workspaceId;
  const scopeKey = snapshot?.scopeKey;
  const [resolution, setResolution] = useState<{
    signal: AbortSignal;
    objectId: string | null;
  }>();
  useEffect(() => {
    const address = nativeDeliveryAddress(ctx, tab.contentId);
    const exact = exactDeliveryAddress(tab.contentId);
    if (
      !tab.visible ||
      (!address && !exact) ||
      !data ||
      !workspaceId ||
      !scopeKey ||
      signal.aborted
    )
      return;
    const pending = new AbortController();
    const active = AbortSignal.any([signal, pending.signal]);
    const assertCurrent = () => {
      assertEmployeePanelSession(ctx, sessionId);
      assertEmployeePanelsCurrent(binding, sessionId, { scopeKey }, active);
    };
    const load = async () => {
      assertCurrent();
      let path = address?.path;
      let occurrence: string | undefined;
      if (exact) {
        if (exact.sessionId !== sessionId)
          throw Error('DELIVERY_VERSION_UNAVAILABLE');
        // The native history endpoint is already admitted for this exact Session.
        // Its event is only a selector; it cannot create or replace stored bytes.
        const page = await ctx.remote.session.page(
          {
            address: { kind: 'session', sessionId },
            throughSeq: exact.sequence,
            maxMessages: 1,
          },
          active,
        );
        const event =
          page.ok &&
          page.value.records.find(
            ({ event }) =>
              event.seq === exact.sequence &&
              event.type === 'deliverables/presented',
          )?.event;
        const value =
          event &&
          (event.data as {
            turn?: number;
            callId?: string;
            files?: { path?: string }[];
          });
        if (
          !value ||
          !Number.isSafeInteger(value.turn) ||
          typeof value.callId !== 'string'
        )
          throw Error('DELIVERY_VERSION_UNAVAILABLE');
        const call =
          page.ok &&
          page.value.records
            .map(({ event }) => event)
            .filter((event) => {
              if (event.type !== 'tool/call' || event.seq >= exact.sequence)
                return false;
              const data = event.data as {
                name?: string;
                turn?: number;
                callId?: string;
              };
              return (
                data.name === 'present' &&
                data.turn === value.turn &&
                data.callId === value.callId
              );
            })
            .sort((a, b) => b.seq - a.seq)[0];
        if (!call) throw Error('DELIVERY_VERSION_UNAVAILABLE');
        path = value.files?.[exact.index]?.path;
        occurrence = await deliveryDigest([
          value.turn!,
          call.seq,
          value.callId,
          exact.index,
        ]);
      }
      if (!path?.startsWith('/work/'))
        throw Error('DELIVERY_VERSION_UNAVAILABLE');
      const coordinate = await deliveryDigest([
        (address ?? exact)!.sessionId,
        path,
      ]);
      assertCurrent();
      const { objectId } = await data.resolveNativeDelivery(
        { workspaceId, coordinate, occurrence },
        active,
      );
      active.throwIfAborted();
      setResolution({ signal, objectId });
    };
    void load().catch(() => {
      if (!active.aborted) setResolution({ signal, objectId: null });
    });
    return () => pending.abort();
  }, [
    ctx,
    binding,
    data,
    workspaceId,
    scopeKey,
    sessionId,
    signal,
    tab.contentId,
    tab.visible,
  ]);
  if (!snapshot || !tab.visible || signal.aborted) return null;
  const current = resolution?.signal === signal ? resolution : undefined;
  return (
    <div className={`${css.surface} ${css.body}`}>
      {current?.objectId ? (
        <EmployeePanelContent
          ctx={ctx}
          binding={binding}
          sessionId={sessionId}
          signal={signal}
          kind="files"
          snapshot={{
            ...snapshot,
            filePreview: {
              objectId: current.objectId,
              close: tab.actions.close,
            },
          }}
        />
      ) : (
        <p role="status">
          {current ? '文件尚未归档到交付成果。' : '正在读取交付成果…'}
        </p>
      )}
    </div>
  );
}

/** Only public registries; no default owner, private component or Dock store. */
export function apply(ctx: Context) {
  ctx.inject(
    ['allriceEmployeePanels', 'sidebarRightTabs', 'sidebarRight', 'layout'],
    (scope) => {
      const binding = scope.allriceEmployeePanels;
      scope.inject(
        ['uiConversation', 'sessions', 'remote'],
        (deliveryScope) => {
          deliveryScope.effect(() =>
            deliveryScope.sidebarRightTabs.register({
              id: nativeDeliveryTab,
              kind: nativeDeliveryTab,
              patterns: [
                'dsh-resource://file/session/[\\s\\S]+',
                exactDeliveryResource + '[\\s\\S]+',
              ],
              priority: 'extension',
              canOpen: (address) =>
                !!(
                  visibleNativeDelivery(deliveryScope, address) ??
                  exactDeliveryAddress(address)
                ),
              title: (address) =>
                nativeDeliveryAddress(deliveryScope, address)?.name ??
                '交付成果',
            }),
          );
          deliveryScope.slots.inject('sidebar.right.pane.tab', () =>
            deliveryScope.slots.register(
              { name: 'sidebar.right.pane.tab', key: nativeDeliveryTab },
              (props: PropsRuntime<'sidebar.right.pane.tab'>) => (
                <EmployeeNativeDelivery
                  {...props}
                  ctx={deliveryScope}
                  binding={binding}
                />
              ),
            ),
          );
          deliveryScope.slots.inject('deliverables.file.actions', () =>
            deliveryScope.slots.register(
              {
                name: 'deliverables.file.actions',
                id: 'allrice-native-delivery-version',
              },
              (props: PropsRuntime<'deliverables.file.actions'>) => (
                <NativeDeliveryVersionAction
                  {...props}
                  ctx={deliveryScope}
                  binding={binding}
                />
              ),
            ),
          );
        },
      );
      for (const kind of Object.keys(
        employeePanelKinds,
      ) as EmployeePanelKind[]) {
        const id = employeePanelKinds[kind];
        scope.effect(() =>
          scope.sidebarRightTabs.register({
            id,
            kind: id,
            title: () => moduleLabels[kind],
          }),
        );
        scope.slots.inject('sidebar.right.pane.tab', () =>
          scope.slots.register(
            { name: 'sidebar.right.pane.tab', key: id },
            (props: PropsRuntime<'sidebar.right.pane.tab'>) => (
              <EmployeePanelBody
                {...props}
                ctx={scope}
                binding={binding}
                kind={kind}
              />
            ),
          ),
        );
      }
      scope.slots.inject('conversation.session.header.actions', () =>
        scope.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'allrice-employee-panels.header',
            order: 20,
          },
          (props: PropsRuntime<'conversation.session.header.actions'>) => (
            <EmployeePanelsHeader {...props} ctx={scope} binding={binding} />
          ),
        ),
      );
      scope.slots.inject('sidebar.right.tab.guide', () =>
        scope.slots.register(
          { name: 'sidebar.right.tab.guide', select: () => ({}) },
          (props: PropsRuntime<'sidebar.right.tab.guide'>) => (
            <EmployeePanelsGuide {...props} ctx={scope} binding={binding} />
          ),
        ),
      );
    },
  );
}

/** Authenticated owner installs this child in its own Cordis lifetime.
 * Disposing the returned fork removes the service and aborts detached intents. */
export function bindEmployeePanels(
  ctx: Context,
  port: EmployeePanelsPort,
  resolve: EmployeePanelsDataResolver = () => null,
) {
  return ctx.plugin({
    apply(owner: Context) {
      const lifetime = new AbortController();
      owner.effect(() => () => lifetime.abort());
      owner.provide('allriceEmployeePanels', {
        port: createEmployeePanelsDataPort(port, resolve, lifetime.signal),
        signal: lifetime.signal,
      });
    },
  });
}

/** Explicit data entry remains an alias of the guarded public default. */
export const bindEmployeePanelsData = bindEmployeePanels;

export type EmployeePanelsHttpOwnerResolver = Parameters<
  typeof createEmployeePanelsHttpResolver<EmployeePanelsSnapshot>
>[0];

/** The authenticated owner supplies its current catalog selection. A native
 * Session id is only an address; an absent owner never selects a legacy route. */
export function bindEmployeePanelsHttp(
  ctx: Context,
  port: EmployeePanelsPort,
  resolve: EmployeePanelsHttpOwnerResolver = () => null,
  options: Pick<EmployeePanelsHttpOptions, 'fetch'> = {},
) {
  return ctx.plugin({
    async apply(owner: Context) {
      const lifetime = new AbortController();
      owner.effect(() => () => lifetime.abort());
      await bindEmployeePanels(
        owner,
        port,
        createEmployeePanelsHttpResolver(resolve, lifetime.signal, options),
      );
    },
  });
}

export { createEmployeePanelsDataPort } from './employee-panels-data';
export { createEmployeePanelDataClient } from '../../../apps/web/lib/chatflow/employee-panel-data';
export { uploadPersonalDeliverable } from '../../../apps/web/lib/chatflow/employee-panel-upload';
export {
  createEmployeePanelsHttpResolver,
  readEmployeePanelsWriteReceipt,
  EmployeePanelsWriteUnknownError,
} from '../../../apps/web/lib/chatflow/employee-panel-data-http';

export type {
  EmployeePanelsActions,
  EmployeePanelsBinding,
  EmployeePanelsPort,
  EmployeePanelsReference,
  EmployeePanelsSnapshot,
} from './employee-panels-port';
