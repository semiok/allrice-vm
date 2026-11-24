'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { EmployeePanelsWriteRejectedError } from '../../lib/chatflow/employee-panel-data-http';
import {
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
  target: ReferencePublicationTarget;
  onClose: () => void;
  onSaved: (result: { sourceId: string; revisionId?: string }) => void;
};

const receiptSchema = z.strictObject({
  operation: z.enum(['publish-file', 'publish-upload', 'change-publication']),
  requestId: UuidSchema,
  sourceId: UuidSchema.optional(),
  uploadDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
type PublicationReceipt = z.infer<typeof receiptSchema>;
const receiptList = z.array(receiptSchema);
const unresolvedPublications = new Map<string, PublicationReceipt[]>();

// Only the original receipt selectors and an upload fingerprint survive a
// reload of this tab. Keep file content and display metadata in the form.
function pendingPublications(key: string) {
  const known = unresolvedPublications.get(key);
  if (known) return known;
  try {
    const value = sessionStorage.getItem(key);
    const parsed = receiptList.safeParse(value ? JSON.parse(value) : []);
    if (parsed.success) return parsed.data;
  } catch {}
  return [];
}

function rememberPublications(key: string, values: PublicationReceipt[]) {
  unresolvedPublications.set(key, values);
  try {
    if (values.length) sessionStorage.setItem(key, JSON.stringify(values));
    else sessionStorage.removeItem(key);
  } catch {}
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

const waitingForReceipt = '发布结果待核，请按原请求核对。';

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
      key={`${props.workspaceId}:${props.viewerId}:${target.kind}:${identity}:${JSON.stringify(props.headers)}`}
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
  const receiptKey =
    'allrice:publication-receipts:v1:' +
    JSON.stringify([
      headers['x-allrice-organization-id'],
      workspaceId,
      viewerId,
      target.kind,
      target.kind === 'file' ? target.file.objectId : reference?.sourceId,
    ]);
  const publication = reference?.publication;
  const destructive = target.kind === 'revoke' || target.kind === 'delete';
  const [scope, setScope] = useState(publication?.audience.scope ?? 'personal');
  const [departmentIds, setDepartmentIds] = useState<string[]>(
    publication?.audience.departmentIds ?? [],
  );
  const [purpose, setPurpose] = useState(reference?.purpose ?? '');
  const [upload, setUpload] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const transport = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const requestIds = useRef(new Map<string, string>());
  const [initialReceipts] = useState(() =>
    dataClient ? pendingPublications(receiptKey) : [],
  );
  const [receipts, setReceipts] = useState(initialReceipts);
  const receipt = receipts[0];
  const checking = !!receipt && (target.kind !== 'upload' || !upload);
  const savedResult = useRef(onSaved);
  savedResult.current = onSaved;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      transport.current?.abort();
    };
  }, []);

  const reconcile = useCallback(
    async (value: PublicationReceipt) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setError(waitingForReceipt);
      const controller = new AbortController();
      transport.current = controller;
      try {
        const result = await data.readWriteReceipt(
          {
            workspaceId,
            operation: value.operation,
            requestId: value.requestId,
            sourceId: value.sourceId,
          },
          controller.signal,
        );
        if (!alive.current || controller.signal.aborted) return;
        if (
          result.status === 'recorded' &&
          result.ready !== false &&
          result.result &&
          'sourceId' in result.result
        ) {
          const previous = pendingPublications(receiptKey);
          if (
            !previous.some((pending) => pending.requestId === value.requestId)
          )
            return;
          const remaining = previous.filter(
            (pending) => pending.requestId !== value.requestId,
          );
          rememberPublications(receiptKey, remaining);
          setReceipts(remaining);
          setError('');
          savedResult.current(result.result);
        }
      } catch {
        // A refused or interrupted receipt read still leaves the write unknown.
      } finally {
        if (alive.current && !controller.signal.aborted) {
          pending.current = false;
          setBusy(false);
        }
      }
    },
    [data, receiptKey, workspaceId],
  );
  useEffect(() => {
    if (initialReceipts[0]) void reconcile(initialReceipts[0]);
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

  function forget(value: PublicationReceipt) {
    const remaining = pendingPublications(receiptKey).filter(
      (pending) => pending.requestId !== value.requestId,
    );
    rememberPublications(receiptKey, remaining);
    if (alive.current) setReceipts(remaining);
  }

  async function save() {
    const previous = dataClient ? pendingPublications(receiptKey) : [];
    if (previous[0] && (target.kind !== 'upload' || !upload)) {
      setReceipts(previous);
      await reconcile(previous[0]);
      return;
    }
    if (
      !permitted ||
      pending.current ||
      (!destructive && scope === 'departments' && departmentIds.length === 0) ||
      (target.kind === 'upload' && !upload)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    transport.current = controller;
    let issued: PublicationReceipt | undefined;
    try {
      const audience = ReferenceAudienceSchema.parse({
        scope,
        departmentIds: scope === 'departments' ? departmentIds : [],
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
      const uploadDigest =
        parsed && 'origin' in parsed && parsed.origin === 'upload'
          ? await publicationFingerprint({
              fileName: parsed.fileName,
              mediaType: parsed.mediaType,
              contentBase64: parsed.contentBase64,
            })
          : undefined;
      const key = dataClient
        ? undefined
        : await publicationFingerprint(canonical);
      if (!alive.current || controller.signal.aborted) return;
      const requestId = (key && requestIds.current.get(key)) || proposed;
      if (key) requestIds.current.set(key, requestId);
      if (dataClient) {
        const held = pendingPublications(receiptKey);
        const prior = uploadDigest
          ? held.find((pending) => pending.uploadDigest === uploadDigest)
          : held[0];
        if (prior) {
          setReceipts(held);
          pending.current = false;
          await reconcile(prior);
          return;
        }
        issued = {
          requestId,
          operation: reference
            ? 'change-publication'
            : target.kind === 'file'
              ? 'publish-file'
              : 'publish-upload',
          ...(reference ? { sourceId: reference.sourceId } : {}),
          ...(uploadDigest ? { uploadDigest } : {}),
        };
        rememberPublications(receiptKey, [issued, ...held]);
      }
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
      if (issued) forget(issued);
      if (alive.current && !controller.signal.aborted) onSaved(saved);
    } catch (caught) {
      const definite =
        caught instanceof EmployeePanelDataUnavailableError ||
        caught instanceof EmployeePanelsWriteRejectedError;
      if (issued && !definite) {
        if (alive.current && !controller.signal.aborted) {
          setReceipts(pendingPublications(receiptKey));
          setUpload(null);
          setError(waitingForReceipt);
        }
        return;
      }
      if (issued) forget(issued);
      if (alive.current && !controller.signal.aborted) {
        setError(
          definite ||
            (reference && caught instanceof Error && 'status' in caught)
            ? caught.message
            : '发布未完成，请重试。',
        );
      }
    } finally {
      if (alive.current && !controller.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

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
                if (!busy && event.dataTransfer.files[0])
                  setUpload(event.dataTransfer.files[0]);
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
                onChange={(event) => {
                  setUpload(event.target.files?.[0] ?? null);
                }}
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
                      onChange={() => setScope(value)}
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
                      onChange={(event) =>
                        setDepartmentIds((ids) =>
                          event.target.checked
                            ? [...ids, department.id]
                            : ids.filter((id) => id !== department.id),
                        )
                      }
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
              onChange={(event) => setPurpose(event.target.value)}
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
      {(error || download.error || available.error) && (
        <p role="alert" className={css.error}>
          {error || download.error || available.error}
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
        {receipt && !checking && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void reconcile(receipt)}
          >
            核对结果
          </Button>
        )}
        <Button
          type="button"
          variant="primary"
          className={destructive ? css.danger : undefined}
          disabled={
            busy ||
            (!checking &&
              (!permitted ||
                (!destructive &&
                  scope === 'departments' &&
                  !departmentIds.length) ||
                (target.kind === 'upload' && !upload)))
          }
          onClick={() => void save()}
        >
          {checking ? '核对结果' : confirmation}
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
