'use client';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { z } from 'zod';
import {
  Button,
  Checkbox,
  Input,
  InlineEditor,
  Modal,
  SegmentedTabs,
  Tag,
  TextShimmer,
  MarkdownText,
  MarkdownDelegateProvider,
  writeClipboard,
  useModalLayer,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
  ApiErrorSchema,
  BrandMediaReadResultSchema,
  BrandMediaCandidateSchema,
  BrandMediaMutationResultSchema,
  BrandMediaInvocationSchema,
  BrandMediaFileSchema,
  EmployeeModuleBindingSchema,
  RunSnapshotSchema,
  ReferenceRevisionSchema,
  ReferenceInputSelectionResultSchema,
  ReferenceSelectionErrorSchema,
  ReferenceSearchCursorSchema,
  WorkbenchDeliverablesCatalogSchema,
  type ReferenceRevision,
  brandMediaModule,
  brandMediaRelease,
  type BrandMediaArticle,
  type BrandMediaGenerateInput,
  type BrandMediaUserCommand,
  type BrandMediaReadInput,
  type BrandMediaTopic,
} from '@allrice/contracts';
import { requestFailureMessage } from '../../../lib/chatflow/request-failure';
import { EmployeePluginSection } from '../employee-capability-presentation';
import { createSessionRunStream } from '../session-run-stream';
import css from './frontend-wiring.module.css';
export { Button, Checkbox, Input, InlineEditor, Modal, SegmentedTabs, Tag };
export { writeClipboard };
export const ui = css;
const labels = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '注释',
};
export function Markdown({ text }: { text: string }) {
  return <MarkdownText text={text} labels={labels} />;
}
export type BrandMediaClientScope = {
  workspaceId: string;
  instanceId: string;
  organizationId: string;
  ownerId: string;
  headers: Record<string, string>;
};
const runsSchema = z.object({
  runs: z.array(
    z.object({
      run: RunSnapshotSchema,
      sessionId: z.uuid(),
      invocation: BrandMediaInvocationSchema,
      addedCandidates: z.array(BrandMediaCandidateSchema),
      unavailable: z.boolean(),
      image: z
        .object({
          operationId: z.uuid().nullable(),
          status: z
            .enum(['running', 'succeeded', 'failed', 'unknown'])
            .nullable(),
          file: BrandMediaFileSchema.nullable(),
          fileName: z.string().nullable(),
          adoptable: z.boolean(),
          retryable: z.boolean(),
        })
        .nullable()
        .optional(),
      submission: z
        .object({
          articleUpdated: z.boolean(),
          revision: z.number().int().positive().nullable(),
        })
        .nullable(),
      deliveries: z.array(
        z.object({
          file: BrandMediaFileSchema,
          content: z.string(),
          format: z.string(),
        }),
      ),
    }),
  ),
});
export type BrandMediaRun = z.infer<typeof runsSchema>['runs'][number];
export const runActive = (run: Pick<BrandMediaRun, 'run'>) =>
  !['succeeded', 'failed', 'canceled', 'needs_attention'].includes(
    run.run.status,
  );
async function moduleRequestId(
  scope: BrandMediaClientScope,
  operation: string,
  ...identity: string[]
) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        operation,
        scope.organizationId,
        scope.workspaceId,
        scope.ownerId,
        scope.instanceId,
        ...identity,
      ]),
    ),
  );
  const hex = Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Immutable selection/retry identities survive uncertain responses and remounts. */
export const candidateRequestId = (
  scope: BrandMediaClientScope,
  runId: string,
  candidate: BrandMediaTopic['candidate'],
) =>
  moduleRequestId(
    scope,
    'brand-media-candidate',
    runId,
    candidate.title,
    candidate.summary,
  );
export const retryRequestId = (
  scope: BrandMediaClientScope,
  failedRunId: string,
) => moduleRequestId(scope, 'brand-media-retry', failedRunId);
export const imageRequestId = (
  scope: BrandMediaClientScope,
  ...identity: string[]
) => moduleRequestId(scope, 'brand-media-image', ...identity);
class BrandMediaRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: z.infer<typeof ApiErrorSchema>['error']['code'],
  ) {
    super(message);
  }
}

function mayBeScopeDenial(cause: unknown): cause is BrandMediaRequestError {
  return (
    cause instanceof BrandMediaRequestError &&
    ((cause.status === 401 && cause.code === 'AUTHENTICATION_REQUIRED') ||
      (cause.status === 403 && cause.code === 'AUTHORIZATION_DENIED') ||
      (cause.status === 404 && cause.code === 'RESOURCE_NOT_FOUND') ||
      (cause.status === 409 &&
        (cause.code === 'EMPLOYEE_INSTANCE_ARCHIVED' ||
          cause.code === 'VERSION_CONFLICT')))
  );
}

type OnBrandReadDenied = (cause: Error) => void;

function recordReadDenied(cause: unknown): cause is BrandMediaRequestError {
  return (
    mayBeScopeDenial(cause) ||
    (cause instanceof BrandMediaRequestError &&
      cause.status === 409 &&
      (cause.code === 'CONFLICT' ||
        cause.code === 'REFERENCE_SELECTION_UNAVAILABLE' ||
        cause.code === 'REFERENCE_PUBLICATION_REVOKED'))
  );
}

async function json(
  url: string,
  headers: Record<string, string>,
  options?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, {
    cache: 'no-store',
    ...options,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  const body = await response.json();
  if (!response.ok)
    throw new BrandMediaRequestError(
      body?.message ?? body?.error?.message ?? '暂时无法完成，请刷新后重试。',
      response.status,
      ApiErrorSchema.safeParse(body).data?.error.code ??
        ReferenceSelectionErrorSchema.safeParse(body).data?.error.code,
    );
  return body;
}
type Scoped<T> = T extends unknown
  ? Omit<T, 'workspaceId' | 'instanceId'>
  : never;
type OnBrandMediaRunAccepted = (
  sessionId: string,
  run: z.infer<typeof RunSnapshotSchema>,
) => void;
type BrandMediaPanelAccess = {
  signal: AbortSignal;
  hide: (cause: Error) => void;
  reveal: (cause: Error) => void;
  revoke: (cause: Error) => void;
};
type BrandMediaScopeCheck = 'enabled' | 'unavailable' | 'unknown';

function brandMediaOperations(
  scope: BrandMediaClientScope,
  onAccepted?: OnBrandMediaRunAccepted,
  access?: BrandMediaPanelAccess,
) {
  const base = `/api/v1/employee-instances/${scope.instanceId}`,
    q = `?workspaceId=${encodeURIComponent(scope.workspaceId)}`;
  const scopedSignal = (signal?: AbortSignal | null) =>
    access && signal
      ? AbortSignal.any([access.signal, signal])
      : (access?.signal ?? signal);
  const revokeAuthentication = (status: number) => {
    if (!access || status !== 401) return;
    access.signal.throwIfAborted();
    const expired = new Error(requestFailureMessage({ status }));
    access.revoke(expired);
    throw expired;
  };
  const request = async (url: string, options?: RequestInit) => {
    const signal = scopedSignal(options?.signal);
    signal?.throwIfAborted();
    const raw = await json(
      url,
      scope.headers,
      signal ? { ...options, signal } : options,
    ).catch((cause) => {
      if (
        cause instanceof BrandMediaRequestError &&
        cause.code === 'AUTHENTICATION_REQUIRED'
      )
        revokeAuthentication(cause.status);
      throw cause;
    });
    signal?.throwIfAborted();
    return raw;
  };
  function rejectFile(
    status: number,
    cause: Error,
    onDenied?: OnBrandReadDenied,
  ): never {
    // A file response can outlive the selected pin, but only the visit that
    // issued the request may act on its authorization result.
    access?.signal.throwIfAborted();
    revokeAuthentication(status);
    if (status === 403 || status === 404) onDenied?.(cause);
    throw cause;
  }
  async function downloadResponse(
    objectId: string,
    kind: 'image' | 'delivery',
    onDenied?: OnBrandReadDenied,
    reader?: AbortSignal,
  ) {
    const signal = scopedSignal(reader);
    signal?.throwIfAborted();
    const image = kind === 'image';
    const response = await fetch(
      `/api/v1/${image ? 'workbench/files' : 'files'}/${objectId}/download${q}`,
      {
        headers: scope.headers,
        signal,
        cache: 'no-store',
      },
    );
    if (!response.ok)
      rejectFile(
        response.status,
        Error(
          image
            ? '原图暂时不可下载，请核对权限后重试。'
            : '正文文件暂时不可读，请重新核对权限。',
        ),
        onDenied,
      );
    signal?.throwIfAborted();
    return { response, signal };
  }
  const catalog = async (signal?: AbortSignal) =>
    z
      .object({
        modules: z.array(
          z.object({
            descriptor: z.object({ id: z.string(), displayName: z.string() }),
            binding: EmployeeModuleBindingSchema.nullable(),
            available: z.boolean(),
            enabled: z.boolean(),
          }),
        ),
      })
      .parse(await request(base + '/modules' + q, { signal }));
  async function readAccess(): Promise<BrandMediaScopeCheck> {
    try {
      const result = await catalog();
      const entry = result.modules.find(
        (item) => item.descriptor.id === brandMediaModule.id,
      );
      if (!entry) return 'unknown';
      return entry.enabled ? 'enabled' : 'unavailable';
    } catch (cause) {
      return mayBeScopeDenial(cause) && cause.code !== 'VERSION_CONFLICT'
        ? 'unavailable'
        : 'unknown';
    }
  }
  let pendingCheck: Promise<BrandMediaScopeCheck> | undefined;
  let latestCheck: Promise<BrandMediaScopeCheck> | undefined;
  const checkScope = (afterWrite: boolean) => {
    if (pendingCheck && !afterWrite) return pendingCheck;
    const check = readAccess().finally(() => {
      if (pendingCheck === check) pendingCheck = undefined;
    });
    latestCheck = pendingCheck = check;
    return check;
  };
  const imageDenials = new Map<string, Error>();
  const imageListeners = new Set<() => void>();
  const denyImage = (objectId: string, cause: Error) => {
    imageDenials.set(objectId, cause);
    for (const changed of imageListeners) changed();
  };
  const imageAccess = {
    subscribe(changed: () => void) {
      imageListeners.add(changed);
      return () => void imageListeners.delete(changed);
    },
    denial: (objectId: string | undefined) =>
      objectId ? imageDenials.get(objectId) : undefined,
  };
  async function readOrWriteModule(
    query: string,
    options?: RequestInit,
    {
      scopeOnly,
      onDenied,
    }: {
      scopeOnly?: boolean;
      onDenied?: OnBrandReadDenied;
    } = {},
  ) {
    try {
      return await request(base + '/brand-media' + query, options);
    } catch (cause) {
      if (access?.signal.aborted || options?.signal?.aborted) throw cause;
      // Projection denial precedes the catalog check. A current installation
      // says nothing about the authorization of a previously loaded record.
      if (onDenied && recordReadDenied(cause)) onDenied(cause);
      if (access && mayBeScopeDenial(cause)) {
        if (
          scopeOnly ||
          cause.code === 'AUTHENTICATION_REQUIRED' ||
          cause.code === 'EMPLOYEE_INSTANCE_ARCHIVED'
        ) {
          access.revoke(cause);
        } else {
          // Both reads and writes can report a lost module binding this way.
          access.hide(cause);
          const check = checkScope(options?.method === 'POST');
          const outcome = await check;
          if (!access.signal.aborted && latestCheck === check) {
            if (outcome === 'unavailable') access.revoke(cause);
            if (outcome === 'enabled') access.reveal(cause);
          }
        }
      }
      throw cause;
    }
  }
  return {
    scope,
    catalog,
    add: (requestId: string) =>
      request(base + '/modules', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: scope.workspaceId,
          instanceId: scope.instanceId,
          release: brandMediaRelease,
          requestId,
        }),
      }),
    read: async (
      input: Scoped<BrandMediaReadInput>,
      signal?: AbortSignal,
      onDenied?: OnBrandReadDenied,
    ) => {
      const params = new URLSearchParams({ workspaceId: scope.workspaceId });
      for (const [key, value] of Object.entries(input))
        if (value !== undefined)
          params.set(
            key,
            typeof value === 'object' ? JSON.stringify(value) : String(value),
          );
      return BrandMediaReadResultSchema.parse(
        await readOrWriteModule('?' + params, { signal }, { onDenied }),
      );
    },
    command: async (command: Scoped<BrandMediaUserCommand>) => {
      const response = z
        .object({
          result: BrandMediaMutationResultSchema,
          replayed: z.boolean(),
        })
        .parse(
          await readOrWriteModule('', {
            method: 'POST',
            body: JSON.stringify({
              ...command,
              workspaceId: scope.workspaceId,
              instanceId: scope.instanceId,
            }),
          }),
        );
      return response.result;
    },
    generate: async (intent: Scoped<BrandMediaGenerateInput>) => {
      const result = z
        .object({
          run: RunSnapshotSchema,
          invocation: BrandMediaInvocationSchema,
          userMessage: z.object({ sessionId: z.uuid() }),
        })
        .parse(
          await readOrWriteModule('', {
            method: 'POST',
            body: JSON.stringify({
              ...intent,
              workspaceId: scope.workspaceId,
              instanceId: scope.instanceId,
            }),
          }),
        );
      access?.signal.throwIfAborted();
      onAccepted?.(result.userMessage.sessionId, result.run);
      return result;
    },
    runs: async (signal?: AbortSignal, onDenied?: OnBrandReadDenied) =>
      runsSchema.parse(
        await readOrWriteModule(q + '&view=runs', { signal }, { onDenied }),
      ),
    help: async (signal?: AbortSignal) =>
      z.object({ content: z.string(), checksum: z.string() }).parse(
        await readOrWriteModule(
          q + '&view=help',
          { signal },
          {
            scopeOnly: true,
          },
        ),
      ),
    cancel: (runId: string) =>
      request(`/api/v1/runs/${runId}/cancel${q}`, {
        method: 'POST',
        body: JSON.stringify({ reason: '用户取消品牌自媒体生成' }),
      }),
    body: async (
      file: NonNullable<BrandMediaArticle['body']>,
      signal?: AbortSignal,
      onDenied?: OnBrandReadDenied,
    ) => {
      const { response, signal: current } = await downloadResponse(
        file.objectId,
        'delivery',
        onDenied,
        signal,
      );
      const text = await response.text();
      current?.throwIfAborted();
      return text;
    },
    references: async (
      query: string,
      cursor?: z.infer<typeof ReferenceSearchCursorSchema>,
      signal?: AbortSignal,
    ) => {
      const params = new URLSearchParams({
        workspaceId: scope.workspaceId,
        query,
        category: 'all',
        limit: '20',
      });
      if (cursor) params.set('cursor', JSON.stringify(cursor));
      return z
        .object({
          viewerId: z.uuid(),
          references: z.array(ReferenceRevisionSchema),
          nextCursor: ReferenceSearchCursorSchema.nullable(),
        })
        .parse(
          await request('/api/v1/references/publications?' + params, {
            signal,
          }),
        );
    },
    selectReference: async (reference: ReferenceRevision) => {
      const result = ReferenceInputSelectionResultSchema.parse(
        await request(
          `/api/v1/references/revisions/${reference.revisionId}/selection${q}`,
        ),
      );
      if (
        result.viewerId !== scope.ownerId ||
        result.workspaceId !== scope.workspaceId ||
        result.selection.sourceId !== reference.sourceId ||
        result.selection.revisionId !== reference.revisionId
      )
        throw Error('资料版本或当前权限已变化，请重试。');
      return {
        origin: 'reference' as const,
        sourceId: result.selection.sourceId,
        revisionId: result.selection.revisionId,
      };
    },
    referenceLabel: async (
      reference: BrandMediaTopic['references'][number],
      signal?: AbortSignal,
    ) => {
      if (reference.origin === 'reference') {
        const result = ReferenceInputSelectionResultSchema.parse(
          await request(
            `/api/v1/references/revisions/${reference.revisionId}/selection${q}`,
            { signal },
          ),
        );
        if (
          result.viewerId !== scope.ownerId ||
          result.workspaceId !== scope.workspaceId ||
          result.selection.sourceId !== reference.sourceId ||
          result.selection.revisionId !== reference.revisionId
        )
          throw Error('资料版本或当前权限已变化。');
        return result.selection.fileName;
      }
      const catalog = WorkbenchDeliverablesCatalogSchema.parse(
        await request(
          '/api/v1/workbench/files' +
            q +
            '&view=deliverables&objectId=' +
            reference.file.objectId,
          { signal },
        ),
      );
      const file = catalog.files.find(
        (entry) =>
          entry.objectId === reference.file.objectId &&
          entry.checksum === reference.file.checksum,
      );
      if (
        (catalog.viewerId && catalog.viewerId !== scope.ownerId) ||
        !file ||
        !file.ownedByMe ||
        file.workspaceId !== scope.workspaceId
      )
        throw Error('资料暂时不可读。');
      return file.fileName;
    },
    upload: async (input: {
      requestId: string;
      fileName: string;
      mediaType: string;
      contentBase64: string;
    }) => {
      const uploaded = z.object({ objectId: z.uuid() }).parse(
        await request('/api/v1/workbench/files' + q, {
          method: 'POST',
          body: JSON.stringify({
            ...input,
            workspaceId: scope.workspaceId,
          }),
        }),
      );
      const catalog = WorkbenchDeliverablesCatalogSchema.parse(
        await request(
          '/api/v1/workbench/files' +
            q +
            '&view=deliverables&objectId=' +
            uploaded.objectId,
        ),
      );
      const file = catalog.files.find(
        (entry) => entry.objectId === uploaded.objectId,
      );
      if (!file || !file.ownedByMe)
        throw Error('文件已保存，暂时无法读取上传回执，请重试同一上传。');
      return file;
    },
    imageAccess,
    previewImage: async (objectId: string, signal?: AbortSignal) => {
      const raw = await request(
        `/api/v1/workbench/files/${objectId}/preview${q}`,
        { signal },
      ).catch((cause) => {
        if (cause instanceof BrandMediaRequestError)
          rejectFile(cause.status, cause, (denial) =>
            denyImage(objectId, denial),
          );
        throw cause;
      });
      const preview = z
        .object({
          kind: z.literal('image'),
          mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
          base64: z.string(),
        })
        .parse(raw);
      return `data:${preview.mediaType};base64,${preview.base64}`;
    },
    download: async (
      objectId: string,
      kind: 'image' | 'delivery',
      onDenied?: OnBrandReadDenied,
    ) => {
      const image = kind === 'image';
      const observed = imageAccess.denial(objectId);
      const { response, signal } = await downloadResponse(
        objectId,
        kind,
        image ? (cause) => denyImage(objectId, cause) : onDenied,
      );
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const name = disposition.split("filename*=UTF-8''")[1];
      const bytes = await response.blob();
      signal?.throwIfAborted();
      const denied = imageAccess.denial(objectId);
      if (image && denied && denied !== observed) throw denied;
      // The HTTP attachment supplies the exact name. Save body bytes as an
      // opaque blob so Chromium does not infer a suffix from their media type.
      const url = URL.createObjectURL(
        image ? bytes : bytes.slice(0, bytes.size, 'application/octet-stream'),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = name
        ? decodeURIComponent(name)
        : image
          ? '配图.png'
          : 'allrice-export';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
}
export type BrandMediaClient = ReturnType<typeof brandMediaOperations>;
export function createBrandMediaClient(
  scope: BrandMediaClientScope,
  onAccepted?: OnBrandMediaRunAccepted,
) {
  return {
    ...brandMediaOperations(scope, onAccepted),
    forPanel: (access: BrandMediaPanelAccess) =>
      brandMediaOperations(scope, onAccepted, access),
  };
}
/** Display metadata only. Exact pins and current ACLs remain authoritative;
 * no label is stored in the business record or reused across client scopes. */
export function ReferenceChips({
  client,
  references,
}: {
  client: BrandMediaClient;
  references: BrandMediaTopic['references'];
}) {
  const key = JSON.stringify(references);
  const [result, setResult] = useState<{
    client: BrandMediaClient;
    key: string;
    labels: string[];
  } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all(
      references.map((reference) =>
        client
          .referenceLabel(reference, abort.signal)
          .catch(() => '资料暂不可读'),
      ),
    ).then((labels) => {
      if (!abort.signal.aborted) setResult({ client, key, labels });
    });
    return () => abort.abort();
  }, [client, key, references]);
  const current = result?.client === client && result.key === key;
  return (
    <div className={css.referenceChips} aria-label="已选参考资料">
      {references.map((reference, index) => (
        <Tag tone="neutral" key={JSON.stringify(reference)}>
          <span className={css.referenceLabel}>
            {current ? result.labels[index] : '正在读取资料名…'}
          </span>
        </Tag>
      ))}
    </div>
  );
}
const imageLabels = {
  dialog: '配图原图',
  close: '关闭原图',
  open: '查看原图',
  loading: '正在读取图片',
  failed: '图片读取失败',
};
/** Public Markdown owns image containment/lightbox; only this owner's exact
 * key can resolve to the authorized bytes. No private ImagePreview import. */
export function Image({
  client,
  objectId,
  localFile,
  label,
  active,
}: {
  client: BrandMediaClient;
  objectId?: string;
  localFile?: File | null;
  label: string;
  active: boolean;
}) {
  const denied = useSyncExternalStore(
    client.imageAccess.subscribe,
    () => client.imageAccess.denial(objectId),
    () => undefined,
  );
  const [result, setResult] = useState<{
    client: BrandMediaClient;
    objectId?: string;
    localFile?: File | null;
    denied?: Error;
    source?: string;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (denied)
      setResult((old) =>
        old?.objectId === objectId && old?.denied !== denied ? null : old,
      );
  }, [denied, objectId]);
  useEffect(() => {
    const abort = new AbortController();
    const observed = client.imageAccess.denial(objectId);
    const identity = { client, objectId, localFile, denied: observed };
    const current = () =>
      !abort.signal.aborted && client.imageAccess.denial(objectId) === observed;
    setResult(null);
    const local = localFile ? URL.createObjectURL(localFile) : '';
    if (active) {
      if (local) setResult({ ...identity, source: local });
      else if (objectId)
        void client
          .previewImage(objectId, abort.signal)
          .then((value) => {
            if (current()) setResult({ ...identity, source: value });
          })
          .catch((cause) => {
            if (current()) setResult({ ...identity, error: cause.message });
          });
    }
    return () => {
      abort.abort();
      if (local) URL.revokeObjectURL(local);
    };
  }, [client, objectId, localFile, active]);
  const displayed =
    result?.client === client &&
    result.objectId === objectId &&
    result.localFile === localFile &&
    result.denied === denied
      ? result
      : null;
  const source = displayed?.source;
  const error = displayed ? displayed.error : denied?.message;
  const key = 'brand-media-image.png';
  const resolve = useCallback(
    (path: string) => (path === key && source ? source : undefined),
    [source],
  );
  if (!active) return null;
  return error ? (
    <p role="alert">{error}</p>
  ) : source ? (
    <div aria-label={`${label}预览`}>
      <MarkdownDelegateProvider fileImages={{ resolve, labels: imageLabels }}>
        <MarkdownText
          text={`![配图预览](${key})`}
          pathImages={{ resolve }}
          labels={labels}
        />
      </MarkdownDelegateProvider>
    </div>
  ) : (
    <p role="status">正在读取图片…</p>
  );
}
type PluginDirectory = { key: string; enabled: boolean } & (
  | { status: 'loading' }
  | { status: 'ready'; available: boolean }
  | { status: 'error'; message: string }
);
export function useBrandMediaEntry(scope: BrandMediaClientScope | null) {
  const key = scope
    ? `${scope.organizationId}/${scope.workspaceId}/${scope.ownerId}/${scope.instanceId}`
    : '';
  const client = useMemo(
    () => (scope ? createBrandMediaClient(scope) : null),
    [key, scope?.headers],
  );
  const [directory, setDirectory] = useState<PluginDirectory | null>(null);
  const [picker, setPicker] = useState(false),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const current = useRef(key);
  current.current = key;
  const pending = useRef<{ key: string; requestId: string } | null>(null);
  const directoryRead = useRef(0);
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      if (!client) return false;
      const version = ++directoryRead.current;
      const latest = () =>
        current.current === key &&
        directoryRead.current === version &&
        !signal?.aborted;
      setDirectory((old) => ({
        key,
        enabled: old?.key === key && old.enabled,
        status: 'loading',
      }));
      try {
        const result = await client.catalog(signal);
        if (!latest()) return false;
        const entry = result.modules.find(
          (module) => module.descriptor.id === brandMediaModule.id,
        );
        setDirectory({
          key,
          enabled: !!entry?.enabled,
          status: 'ready',
          available: !!entry?.available,
        });
        return true;
      } catch (cause) {
        if (latest())
          setDirectory((old) => ({
            key,
            enabled: old?.key === key && old.enabled,
            status: 'error',
            message:
              cause instanceof Error
                ? cause.message
                : '暂时无法读取插件，请重试。',
          }));
        return false;
      }
    },
    [client, key],
  );
  useEffect(() => {
    const controller = new AbortController();
    setPicker(false);
    setBusy(false);
    pending.current = null;
    setChecked(false);
    setError('');
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload, key]);
  const openPicker = () => {
    setPicker(true);
    setChecked(false);
    setError('');
    void reload();
  };
  const projection = directory?.key === key ? directory : null;
  const available = projection?.status === 'ready' && projection.available;
  const add = async () => {
    if (!client || busy || !checked || !available) return;
    const capturedKey = key;
    const request =
      pending.current?.key === key
        ? pending.current
        : { key, requestId: crypto.randomUUID() };
    pending.current = request;
    const ownsRequest = () =>
      current.current === capturedKey && pending.current === request;
    setBusy(true);
    setError('');
    try {
      await client.add(request.requestId);
      if (!ownsRequest()) return;
      if (!(await reload()) || !ownsRequest()) return;
      setBusy(false);
      pending.current = null;
      setPicker(false);
    } catch (cause) {
      if (!ownsRequest()) return;
      setError(cause instanceof Error ? cause.message : '添加失败');
      if (mayBeScopeDenial(cause)) {
        setChecked(false);
        await reload();
        if (ownsRequest()) {
          pending.current = null;
          setBusy(false);
        }
      }
    } finally {
      if (ownsRequest()) setBusy(false);
    }
  };
  return {
    client,
    picker,
    setPicker,
    openPicker,
    checked,
    setChecked,
    busy,
    error: projection?.status === 'error' ? projection.message : error,
    add,
    enabled: !!projection?.enabled,
    directoryStatus: projection?.status ?? 'loading',
    available,
  };
}
export function BrandMediaPluginSection({
  controller,
  headingId,
  onOpen,
}: {
  controller: ReturnType<typeof useBrandMediaEntry>;
  headingId: string;
  onOpen: () => void;
}) {
  return (
    <>
      <EmployeePluginSection
        compactOpen
        headingId={headingId}
        plugins={
          controller.enabled
            ? [
                {
                  id: brandMediaModule.id,
                  name: brandMediaModule.displayName,
                  description: '想选题、写文章、安排发布计划',
                  href: '#brand-media',
                  onOpen,
                },
              ]
            : []
        }
        onAdd={controller.openPicker}
      />
      {controller.error && <p role="alert">{controller.error}</p>}
    </>
  );
}
export function BrandMediaPluginPicker({
  controller,
  employeeName,
}: {
  controller: ReturnType<typeof useBrandMediaEntry>;
  employeeName: string;
}) {
  return (
    <section className={css.picker} aria-label="选择插件">
      <header className={css.header}>
        <Button
          aria-label="返回插件列表"
          onClick={() => controller.setPicker(false)}
        >
          ←
        </Button>
        <h3>添加插件</h3>
      </header>
      <p>选择插件，添加给 {employeeName}。</p>
      {controller.directoryStatus === 'loading' ? (
        <p role="status" aria-busy="true">
          <TextShimmer active>正在读取…</TextShimmer>
        </p>
      ) : controller.available ? (
        <div className={css.selectionCard}>
          <Checkbox
            checked={controller.checked}
            onChange={controller.setChecked}
            label="品牌自媒体"
            disabled={controller.busy}
          />
          <p>想选题、写文章、安排发布计划</p>
        </div>
      ) : controller.directoryStatus === 'ready' ? (
        <>
          <h4>暂无可添加的插件</h4>
          <p>有可用插件时，会显示在这里。</p>
        </>
      ) : null}
      {controller.error && <p role="alert">{controller.error}</p>}
      <footer className={css.pickerFooter}>
        <Button onClick={() => controller.setPicker(false)}>取消</Button>
        <Button
          variant="primary"
          disabled={
            !controller.available || !controller.checked || controller.busy
          }
          onClick={() => void controller.add()}
        >
          添加
        </Button>
      </footer>
    </section>
  );
}
/** Only the center panel transitions. The host owns conversation DOM/drafts;
 * closing never selects a Session or cancels a native Run. */
export function BrandMediaHost({
  open,
  serial,
  children,
  panel,
}: {
  open: boolean;
  serial: number;
  children: ReactNode;
  panel: ReactNode;
}) {
  const [shown, setShown] = useState(false),
    root = useRef<HTMLDivElement>(null),
    panelRef = useRef<HTMLDivElement>(null),
    previousFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      if (!wasOpen.current) return;
      wasOpen.current = false;
      setShown(false);
      const frame = requestAnimationFrame(() => {
        const previous = previousFocus.current;
        if (
          previous?.isConnected &&
          root.current?.contains(previous) &&
          !previous.closest('[inert]')
        )
          previous.focus({ preventScroll: true });
        else
          root.current
            ?.querySelector<HTMLElement>('textarea, input, button')
            ?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
    wasOpen.current = true;
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setShown(false);
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [open, serial]);
  useLayoutEffect(() => {
    if (open && shown)
      panelRef.current
        ?.querySelector<HTMLElement>('[data-brand-return]')
        ?.focus({ preventScroll: true });
  }, [open, shown]);
  return (
    <div ref={root} className={css.host}>
      <div
        className={css.conversation}
        inert={open}
        aria-hidden={open || undefined}
      >
        {children}
      </div>
      <div
        ref={panelRef}
        className={css.slide}
        data-open={open && shown}
        inert={!open || !shown}
        aria-hidden={!open || !shown}
        data-brand-media-host
      >
        <div className={css.surface} data-brand-media-surface>
          {panel}
        </div>
      </div>
    </div>
  );
}
export function HelpDrawer({
  content,
  onClose,
}: {
  content: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useModalLayer(ref, true, onClose);
  return (
    <div
      className={css.helpMask}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={ref}
        className={css.help}
        role="dialog"
        aria-modal="true"
        aria-label="使用说明"
        tabIndex={-1}
      >
        <header className={css.helpHeader}>
          <h3>使用说明 · 品牌自媒体</h3>
          <Button
            data-modal-autofocus
            onClick={onClose}
            aria-label="关闭使用说明"
          >
            ×
          </Button>
        </header>
        <Markdown text={content} />
      </aside>
    </div>
  );
}
/** Reuse native chat streaming/reconnection. Terminal truth is always reread
 * from the Run endpoint, never inferred from connection or assistant wording. */
export function useBrandMediaRunEvents(
  client: BrandMediaClient,
  runs: BrandMediaRun[],
  refresh: () => Promise<void>,
  setError: (value: string) => void,
) {
  const ids = runs
    .filter(runActive)
    .map((row) => `${row.sessionId}:${row.run.id}`)
    .sort()
    .join(',');
  useEffect(() => {
    const streams = new Map<
      string,
      ReturnType<typeof createSessionRunStream>
    >();
    for (const row of runs.filter(runActive)) {
      let stream = streams.get(row.sessionId);
      if (!stream) {
        stream = createSessionRunStream({
          sessionId: row.sessionId,
          workspaceId: client.scope.workspaceId,
          tenantHeaders: client.scope.headers,
          loadHistory: async () => {
            void refresh();
          },
          loadWorkspace: async () => {},
          setError,
        });
        stream.activate();
        streams.set(row.sessionId, stream);
      }
      void stream.streamRun(row.run.id);
    }
    const reconnect = () => {
      for (const row of runs.filter(runActive))
        void streams.get(row.sessionId)?.streamRun(row.run.id);
      void refresh();
    };
    window.addEventListener('online', reconnect);
    return () => {
      window.removeEventListener('online', reconnect);
      for (const stream of streams.values()) stream.deactivate();
    };
  }, [client, ids, refresh, setError]);
}
