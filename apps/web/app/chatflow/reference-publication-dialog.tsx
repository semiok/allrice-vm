'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import {
  EmployeePanelsWriteUnknownError,
  EmployeePanelsWriteRejectedError,
} from '../../lib/chatflow/employee-panel-data-http';
import {
  REFERENCE_UPLOAD_MAX_BYTES,
  ReferenceAudienceSchema,
  ReferencePublicationActionSchema,
  ReferencePublishInputSchema,
  UuidSchema,
  type ReferenceRevision,
  type WorkbenchDeliverable,
} from '@allrice/contracts';
import {
  Button,
  FileTypeIcon,
  IconDownloadOutlineRegular,
  classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { DshDialog } from './dsh-upstream/Dialog';
import { WorkbenchFileIcon } from './workbench-file-icon';
import {
  EmployeePanelDataUnavailableError,
  type EmployeePanelDataClient,
} from '../../lib/chatflow/employee-panel-data';
import {
  useEmployeePanelData,
  useEmployeePanelDownload,
} from './use-employee-panel-data';
import css from './reference-publication-dialog.module.css';
import {
  useReferencePublicationOptions,
  type ReferencePublicationOptions,
} from './use-reference-publication-options';

const receiptScopeSchema = z.strictObject({
  organizationId: UuidSchema,
  employeeInstanceId: UuidSchema,
  threadId: UuidSchema.nullable(),
});
export type ReferencePublicationScope = z.infer<typeof receiptScopeSchema>;

export type ReferencePublicationTarget =
  | { kind: 'file'; file: WorkbenchDeliverable }
  | { kind: 'upload' }
  | {
      kind: 'audience' | 'revoke' | 'delete';
      reference: ReferenceRevision;
    };
type Props = {
  workspaceId: string;
  viewerId: string;
  headers: Record<string, string>;
  options?: ReferencePublicationOptions;
  dataClient?: EmployeePanelDataClient;
  receiptScope?: ReferencePublicationScope;
  target: ReferencePublicationTarget;
  onClose: () => void;
  onSaved: (result: { sourceId: string; revisionId?: string }) => void;
};

const receiptSchema = z.strictObject({
  operation: z.enum(['publish-file', 'publish-upload', 'change-publication']),
  requestId: UuidSchema,
  sourceId: UuidSchema.optional(),
  intentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(['recorded', 'rejected']).optional(),
});
type PublicationReceipt = z.infer<typeof receiptSchema>;
const receiptList = z.array(receiptSchema);
type SavedPublication = Parameters<Props['onSaved']>[0];
type Resolution =
  { outcome: 'recorded'; saved: SavedPublication } | { outcome: 'rejected' };
const settledPublications = new Map<string, Resolution>();
const publicationRecordKey = (key: string, requestId: string) =>
  key + '/' + requestId;
const receiptPrefix = 'allrice:publication-receipts:v2:';
const receiptAddress = z.tuple([
  UuidSchema,
  UuidSchema,
  UuidSchema,
  UuidSchema,
  UuidSchema.nullable(),
  z.enum(['file', 'upload', 'audience', 'revoke', 'delete']),
  UuidSchema.nullable(),
]);
// Keep the original selector, intent digest and known status across reloads.
// File bytes and display metadata stay in the active form.
function storedPublications(key: string | undefined) {
  if (!key) return [];
  const value = sessionStorage.getItem(key);
  return receiptList.parse(value ? JSON.parse(value) : []);
}
function pendingPublications(key: string | undefined) {
  if (!key) return [];
  return storedPublications(key).filter(
    (receipt) =>
      !receipt.outcome &&
      !settledPublications.has(publicationRecordKey(key, receipt.requestId)),
  );
}

function rememberPublications(key: string, values: PublicationReceipt[]) {
  if (values.length) sessionStorage.setItem(key, JSON.stringify(values));
  else sessionStorage.removeItem(key);
}
function restorePublications(key: string | undefined) {
  try {
    return pendingPublications(key);
  } catch {
    return [];
  }
}
function settlePublication(
  key: string,
  receipt: PublicationReceipt,
  resolution: Resolution,
) {
  settledPublications.set(
    publicationRecordKey(key, receipt.requestId),
    resolution,
  );
  try {
    rememberPublications(key, pendingPublications(key));
  } catch {
    // Persist the known result if deleting the last pending entry failed.
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify(
          storedPublications(key).map((value) =>
            value.requestId === receipt.requestId
              ? { ...value, outcome: resolution.outcome }
              : value,
          ),
        ),
      );
    } catch {
      // This tab can still retain the authoritative result in memory.
    }
  }
}

async function publicationFingerprint(value: unknown) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

class ReceiptStorageUnavailable extends Error {}

const fileSizeError = `文件超过 ${REFERENCE_UPLOAD_MAX_BYTES / 1024 ** 2} MB 上限。`;
const publishError = '发布未完成，请重试。';
const uploadError = '上传中断，请重试。';
function saveError(error: unknown, upload: boolean) {
  const failure =
    error instanceof EmployeePanelsWriteUnknownError ? error.cause : error;
  if (
    upload &&
    failure instanceof Error &&
    'status' in failure &&
    failure.status === 413
  ) {
    return 'code' in failure && failure.code === 'QUOTA_EXCEEDED'
      ? '企业资料存储空间不足。'
      : '服务器拒绝接收此文件，请换一个更小的文件重试。';
  }
  return upload ? uploadError : publishError;
}

async function checkPublication(
  data: EmployeePanelDataClient,
  workspaceId: string,
  key: string,
  receipt: PublicationReceipt,
  signal: AbortSignal,
): Promise<Resolution | undefined> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  const known = settledPublications.get(
    publicationRecordKey(key, receipt.requestId),
  );
  if (known) return known;
  const response = await data.readWriteReceipt(
    {
      workspaceId,
      operation: receipt.operation,
      requestId: receipt.requestId,
      sourceId: receipt.sourceId,
    },
    signal,
  );
  signal.throwIfAborted();
  const saved = response.result;
  if (
    response.status !== 'recorded' ||
    !saved ||
    !('sourceId' in saved) ||
    (receipt.operation !== 'change-publication' &&
      (response.ready !== true || !('revisionId' in saved)))
  )
    return;
  // A background read can refresh the list, but only a matching submission
  // can acknowledge the result and retire its intent.
  return { outcome: 'recorded', saved } as const;
}

function refreshPublishedFiles() {
  window.dispatchEvent(new Event('allrice:workbench-files-changed'));
}

/** Read earlier writes on panel entry without exposing their internal keys. */
export function ReferencePublicationPending({
  workspaceId,
  viewerId,
  receiptScope,
  dataClient,
  panel,
  dialogOpen,
  signal,
}: {
  workspaceId: string;
  viewerId: string;
  receiptScope: ReferencePublicationScope;
  dataClient: EmployeePanelDataClient;
  panel: 'files' | 'materials';
  dialogOpen: boolean;
  signal: AbortSignal;
}) {
  const { organizationId, employeeInstanceId, threadId } = receiptScope;
  useEffect(() => {
    if (dialogOpen || signal.aborted) return;
    const records: { key: string; receipt: PublicationReceipt }[] = [];
    try {
      for (let index = 0; index < sessionStorage.length; index++) {
        const key = sessionStorage.key(index);
        if (!key?.startsWith(receiptPrefix)) continue;
        try {
          const [org, viewer, workspace, employee, thread, action, target] =
            receiptAddress.parse(JSON.parse(key.slice(receiptPrefix.length)));
          if (
            org !== organizationId ||
            viewer !== viewerId ||
            workspace !== workspaceId ||
            employee !== employeeInstanceId ||
            thread !== threadId ||
            (action === 'file') !== (panel === 'files')
          )
            continue;
          for (const receipt of pendingPublications(key)) {
            const matches =
              action === 'file'
                ? target &&
                  receipt.operation === 'publish-file' &&
                  !receipt.sourceId
                : action === 'upload'
                  ? target === null &&
                    receipt.operation === 'publish-upload' &&
                    !receipt.sourceId
                  : target &&
                    receipt.sourceId === target &&
                    receipt.operation === 'change-publication';
            if (matches) records.push({ key, receipt });
          }
        } catch {
          // Ignore malformed storage records without touching other requests.
        }
      }
    } catch {
      return;
    }
    const controller = new AbortController();
    const active = AbortSignal.any([signal, controller.signal]);
    for (const { key, receipt } of records)
      void checkPublication(dataClient, workspaceId, key, receipt, active)
        .then((result) => {
          if (!active.aborted && result?.outcome === 'recorded')
            refreshPublishedFiles();
        })
        .catch(() => {});
    return () => controller.abort();
  }, [
    dataClient,
    dialogOpen,
    employeeInstanceId,
    organizationId,
    panel,
    signal,
    threadId,
    viewerId,
    workspaceId,
  ]);
  return null;
}

// Replacing the account, workspace or precise target discards local form state
// and aborts its transport; expected-viewer is a write precondition, not owner.
export function ReferencePublicationDialog(props: Props) {
  const target = props.target;
  const identity =
    target.kind === 'file'
      ? target.file.objectId
      : 'reference' in target
        ? `${target.reference.sourceId}:${target.reference.publication?.audienceRevision}`
        : 'upload';
  return (
    <PublicationForm
      key={JSON.stringify([
        props.workspaceId,
        props.viewerId,
        target.kind,
        identity,
        props.receiptScope,
        props.headers,
      ])}
      {...props}
    />
  );
}

function PublicationForm({
  workspaceId,
  viewerId,
  headers,
  options: suppliedOptions,
  dataClient,
  receiptScope,
  target,
  onClose,
  onSaved,
}: Props) {
  const data = useEmployeePanelData({ dataClient, headers, viewerId });
  const download = useEmployeePanelDownload(
    data,
    `${workspaceId}/${viewerId}`,
    true,
  );
  const purposeLabelId = useId();
  const available = useReferencePublicationOptions({
    workspaceId,
    viewerId,
    headers,
    active: true,
    supplied: suppliedOptions,
    dataClient,
  });
  const options = available.options;
  const reference = 'reference' in target ? target.reference : null;
  const parsedScope = receiptScopeSchema.safeParse(receiptScope);
  const receiptKey =
    dataClient && parsedScope.success
      ? receiptPrefix +
        JSON.stringify([
          parsedScope.data.organizationId,
          viewerId,
          workspaceId,
          parsedScope.data.employeeInstanceId,
          parsedScope.data.threadId,
          target.kind,
          target.kind === 'file' ? target.file.objectId : reference?.sourceId,
        ])
      : undefined;
  const publication = reference?.publication;
  const destructive = target.kind === 'revoke' || target.kind === 'delete';
  const [scope, setScope] = useState(publication?.audience.scope ?? 'personal');
  const [departmentIds, setDepartmentIds] = useState<string[]>(
    publication?.audience.departmentIds ?? [],
  );
  const [purpose, setPurpose] = useState(reference?.purpose ?? '');
  const [upload, setUpload] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const transport = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const requestIds = useRef(new Map<string, string>());
  const edits = useRef(0);
  const checks = useRef(
    new Map<
      string,
      {
        controller: AbortController;
        result: Promise<Resolution | undefined>;
      }
    >(),
  ).current;
  const [initialReceipts] = useState(() => restorePublications(receiptKey));
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      transport.current?.abort();
      for (const { controller } of checks.values()) controller.abort();
      checks.clear();
    };
  }, [checks]);

  const reconcile = useCallback(
    (receipt: PublicationReceipt) => {
      if (!receiptKey) return;
      const existing = checks.get(receipt.requestId);
      if (existing) return existing.result;
      const controller = new AbortController();
      const result = checkPublication(
        data,
        workspaceId,
        receiptKey,
        receipt,
        controller.signal,
      )
        .catch(() => undefined)
        .finally(() => {
          if (checks.get(receipt.requestId)?.controller === controller)
            checks.delete(receipt.requestId);
        });
      checks.set(receipt.requestId, { controller, result });
      return result;
    },
    [checks, data, receiptKey, workspaceId],
  );
  useEffect(() => {
    for (const receipt of initialReceipts)
      void reconcile(receipt)?.then((result) => {
        if (alive.current && result?.outcome === 'recorded')
          refreshPublishedFiles();
      });
  }, [initialReceipts, reconcile]);

  const title = {
    file: '添加为企业资料',
    upload: '上传企业资料',
    audience: '编辑资料',
    revoke: '撤销这份企业资料？',
    delete: '删除这份企业资料？',
  }[target.kind];
  const confirmation = {
    file: '确认',
    upload: '发布',
    audience: '保存',
    revoke: '撤销资料',
    delete: '删除资料',
  }[target.kind];
  const names = (options?.departments ?? [])
    .filter((department) => departmentIds.includes(department.id))
    .map((department) => department.name);
  const audienceLabel =
    scope === 'personal'
      ? '仅自己'
      : scope === 'company'
        ? '全公司'
        : names.join('、');
  const permitted =
    options?.workspaceId === workspaceId &&
    options.writable &&
    (target.kind === 'file'
      ? target.file.canPublishReference === true
      : target.kind === 'upload'
        ? true
        : reference?.canMaintain === true &&
          publication?.publisherId === viewerId &&
          (target.kind === 'audience' ||
            (target.kind === 'revoke' && publication.origin === 'file') ||
            (target.kind === 'delete' && publication.origin === 'upload')));

  function chooseUpload(file: File | null) {
    edits.current++;
    const oversized = file !== null && file.size > REFERENCE_UPLOAD_MAX_BYTES;
    setUpload(oversized ? null : file);
    setError(oversized ? fileSizeError : undefined);
    if (oversized && fileInput.current) fileInput.current.value = '';
  }

  async function save() {
    if (
      !permitted ||
      pending.current ||
      (!destructive && scope === 'departments' && departmentIds.length === 0) ||
      (target.kind === 'upload' && !upload)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    const controller = new AbortController();
    const formVersion = edits.current;
    transport.current = controller;
    let issued: PublicationReceipt | undefined;
    try {
      function readPending() {
        if (!receiptKey) throw new ReceiptStorageUnavailable();
        try {
          return pendingPublications(receiptKey);
        } catch {
          throw new ReceiptStorageUnavailable();
        }
      }
      const atClick = dataClient ? readPending() : [];
      const audience = ReferenceAudienceSchema.parse({
        scope,
        departmentIds: scope === 'departments' ? [...departmentIds].sort() : [],
      });
      let value: Record<string, unknown>;
      if (target.kind === 'file') {
        value = {
          workspaceId,
          origin: 'file',
          objectId: target.file.objectId,
          audience,
          purpose,
        };
      } else if (target.kind === 'upload' && upload) {
        const contentBase64 = await fileBase64(upload);
        if (!alive.current || controller.signal.aborted) return;
        value = {
          workspaceId,
          origin: 'upload',
          fileName: upload.name,
          mediaType: upload.type || 'application/octet-stream',
          contentBase64,
          audience,
          purpose,
        };
      } else if (reference && publication) {
        value = {
          workspaceId,
          expectedRevision: publication.audienceRevision,
          action: target.kind === 'audience' ? 'edit' : target.kind,
          ...(target.kind === 'audience' ? { audience, purpose } : {}),
        };
      } else return;

      const schema = reference
        ? ReferencePublicationActionSchema
        : ReferencePublishInputSchema;
      const parsed = schema.parse({ ...value, requestId: crypto.randomUUID() });
      const { requestId: proposed, ...canonical } = parsed;
      const intentDigest = await publicationFingerprint(canonical);
      if (
        !alive.current ||
        controller.signal.aborted ||
        edits.current !== formVersion
      )
        return;
      let requestId = requestIds.current.get(intentDigest) ?? proposed;
      if (dataClient) {
        if (!receiptKey) throw new ReceiptStorageUnavailable();
        const held = readPending();
        const sameIntent = (receipt: PublicationReceipt) =>
          receipt.intentDigest === intentDigest;
        const prior =
          atClick.find(sameIntent) ??
          held.find(sameIntent) ??
          initialReceipts.find(
            (receipt) =>
              sameIntent(receipt) &&
              settledPublications.get(
                publicationRecordKey(receiptKey, receipt.requestId),
              )?.outcome === 'recorded',
          );
        if (prior) {
          // An unknown response never authorizes a second write. The normal
          // publish button checks the exact saved request instead.
          const resolution = await reconcile(prior);
          if (
            !alive.current ||
            controller.signal.aborted ||
            edits.current !== formVersion
          )
            return;
          if (resolution?.outcome === 'recorded') {
            settlePublication(receiptKey, prior, resolution);
            onSaved(resolution.saved);
          } else
            setError(target.kind === 'upload' ? uploadError : publishError);
          return;
        }
        requestId = proposed;
        const record: PublicationReceipt = {
          requestId,
          operation: reference
            ? 'change-publication'
            : target.kind === 'file'
              ? 'publish-file'
              : 'publish-upload',
          ...(reference ? { sourceId: reference.sourceId } : {}),
          intentDigest,
        };
        // Save the exact selector and intent before admitting its POST.
        try {
          rememberPublications(receiptKey, [record, ...held]);
        } catch {
          throw new ReceiptStorageUnavailable();
        }
        issued = record;
      } else requestIds.current.set(intentDigest, requestId);
      const saved = reference
        ? await data.changePublication(
            {
              sourceId: reference.sourceId,
              body: ReferencePublicationActionSchema.parse({
                ...canonical,
                requestId,
              }),
            },
            controller.signal,
          )
        : await (() => {
            const body = ReferencePublishInputSchema.parse({
              ...canonical,
              requestId,
            });
            return body.origin === 'file'
              ? data.publishFile(body, controller.signal)
              : data.publishUpload(body, controller.signal);
          })();
      if (issued && receiptKey)
        settlePublication(receiptKey, issued, { outcome: 'recorded', saved });
      if (
        alive.current &&
        !controller.signal.aborted &&
        edits.current === formVersion
      )
        onSaved(saved);
    } catch (caught) {
      const definite =
        caught instanceof EmployeePanelDataUnavailableError ||
        caught instanceof EmployeePanelsWriteRejectedError;
      if (issued && receiptKey && definite)
        settlePublication(receiptKey, issued, { outcome: 'rejected' });
      if (alive.current && !controller.signal.aborted)
        setError(saveError(caught, target.kind === 'upload'));
    } finally {
      if (alive.current && !controller.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  const shownError = error || download.error || available.error;
  return (
    <DshDialog
      title={title}
      ariaLabel={title}
      onClose={() => {
        if (!pending.current) onClose();
      }}
      closeDisabled={busy}
      className={css.dialog}
      bodyClassName={css.body}
    >
      {destructive && reference ? (
        <>
          <p className={css.description}>
            {reference.fileName} · {audienceLabel}
          </p>
          <ul className={css.destructiveCopy}>
            {target.kind === 'revoke' ? (
              <>
                <li>
                  {scope === 'personal'
                    ? '你'
                    : scope === 'company'
                      ? '公司里所有人'
                      : audienceLabel + '的人'}
                  和 AI 员工都看不到、搜不到它了。
                </li>
                <li>你的交付成果里原文件还在，以后可以再添加。</li>
              </>
            ) : (
              <li>
                这份是直接上传的，交付成果里没有它，删除后谁都看不到了，需要的话先下载。
              </li>
            )}
          </ul>
        </>
      ) : (
        <>
          {target.kind === 'file' && (
            <>
              <p className={css.description}>
                把这个文件复制一份放进企业资料。之后原文件怎么改都不影响它。
              </p>
              <div className={css.file}>
                <FileTypeIcon
                  kind={classifyFileType(target.file.fileName)}
                  size={32}
                />
                <div>
                  <strong>{target.file.fileName}</strong>
                  <span>
                    {new Date(target.file.createdAt).toLocaleString('zh-CN', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>
            </>
          )}
          {target.kind === 'upload' && (
            <div
              className={css.dropzone}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];
                if (!pending.current && file) chooseUpload(file);
              }}
            >
              <WorkbenchFileIcon kind="upload" />
              <p>
                拖文件到这里，或{' '}
                <button
                  type="button"
                  disabled={busy}
                  className={css.textLink}
                  onClick={() => fileInput.current?.click()}
                >
                  选择文件
                </button>
              </p>
              {upload && <p className={css.caption}>已选：{upload.name}</p>}
              <input
                ref={fileInput}
                type="file"
                aria-label="选择文件"
                hidden
                disabled={busy}
                onChange={(event) =>
                  chooseUpload(event.target.files?.[0] ?? null)
                }
              />
            </div>
          )}
          <fieldset className={css.field} disabled={busy || !permitted}>
            <legend>谁能看到</legend>
            <div className={css.choices}>
              {(['personal', 'departments', 'company'] as const).map(
                (value, index) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="publication-audience"
                      value={value}
                      checked={scope === value}
                      onChange={() => {
                        edits.current++;
                        setScope(value);
                      }}
                    />
                    {['仅自己', '指定部门', '全公司'][index]}
                  </label>
                ),
              )}
            </div>
          </fieldset>
          {scope === 'departments' && (
            <fieldset className={css.field} disabled={busy || !permitted}>
              <legend>部门（可多选）</legend>
              <div className={css.departments}>
                {(options?.departments ?? []).map((department) => (
                  <label key={department.id}>
                    <input
                      type="checkbox"
                      checked={departmentIds.includes(department.id)}
                      onChange={(event) => {
                        edits.current++;
                        setDepartmentIds((ids) =>
                          event.target.checked
                            ? [...ids, department.id]
                            : ids.filter((id) => id !== department.id),
                        );
                      }}
                    />
                    {department.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <label className={css.field}>
            <span id={purposeLabelId}>用途</span>
            <textarea
              aria-labelledby={purposeLabelId}
              value={purpose}
              maxLength={1000}
              disabled={busy || !permitted}
              onChange={(event) => {
                edits.current++;
                setPurpose(event.target.value);
              }}
              placeholder="例如：每月经营报告的格式参考"
            />
          </label>
          <p className={css.hint}>
            {scope === 'personal'
              ? '只有你能看到和下载，AI 员工为你工作时也会查到它。'
              : scope === 'company'
                ? '公司里所有人都能看到和下载，AI 员工为他们工作时也会查到它。'
                : names.length
                  ? names.join('、') +
                    '的人都能看到和下载，AI 员工为他们工作时也会查到它。'
                  : '请选择至少一个部门。'}
          </p>
        </>
      )}
      {shownError && (
        <p role="alert" className={css.error}>
          {shownError}
        </p>
      )}
      <footer className={css.actions}>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        {target.kind === 'delete' &&
          (dataClient ? (
            <button
              type="button"
              className={css.download}
              onClick={() =>
                void download.download(
                  (signal) =>
                    data.downloadMaterial(
                      { workspaceId, revisionId: target.reference.revisionId },
                      signal,
                    ),
                  target.reference.fileName,
                )
              }
            >
              <IconDownloadOutlineRegular size={18} />
              先下载
            </button>
          ) : (
            <a
              className={css.download}
              href={`/api/v1/references/revisions/${encodeURIComponent(target.reference.revisionId)}/download?workspaceId=${encodeURIComponent(workspaceId)}`}
              download
            >
              <IconDownloadOutlineRegular size={18} />
              先下载
            </a>
          ))}
        <Button
          type="button"
          variant="primary"
          aria-busy={busy || undefined}
          className={destructive ? css.danger : undefined}
          disabled={
            busy ||
            !permitted ||
            (!destructive &&
              scope === 'departments' &&
              !departmentIds.length) ||
            (target.kind === 'upload' && !upload)
          }
          onClick={() => void save()}
        >
          {busy && target.kind === 'upload' ? '发布中...' : confirmation}
        </Button>
      </footer>
    </DshDialog>
  );
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== 'string' || !value.includes(','))
        reject(Error('File read failed'));
      else resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
