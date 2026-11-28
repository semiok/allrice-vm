import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import {
  makeObjectKey,
  type DeliveryFormat,
  type RequestContext,
  type StorageObject,
  type StoragePort,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import type { DEntryNativeRunCandidate } from './d-entry-native-execution.ts';
import { allocateWorkbenchFileName } from './workbench-file-name.ts';

const formats = {
  md: ['markdown', 'text/markdown'],
  markdown: ['markdown', 'text/markdown'],
  txt: ['text', 'text/plain'],
  csv: ['text', 'text/csv'],
  tsv: ['text', 'text/tab-separated-values'],
  json: ['json', 'application/json'],
  html: ['html', 'text/html'],
  htm: ['html', 'text/html'],
  pdf: ['pdf', 'application/pdf'],
  docx: [
    'docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  xlsx: [
    'xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  pptx: [
    'pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  png: ['png', 'image/png'],
  jpg: ['jpeg', 'image/jpeg'],
  jpeg: ['jpeg', 'image/jpeg'],
  webp: ['webp', 'image/webp'],
} as const satisfies Record<string, readonly [DeliveryFormat, string]>;

function fileFormat(path: string) {
  const ext = posix.extname(path).slice(1).toLowerCase();
  return Object.hasOwn(formats, ext)
    ? formats[ext as keyof typeof formats]
    : undefined;
}

const nativePath = z
  .string()
  .max(1024)
  .refine(
    (path) =>
      path.startsWith('/work/') &&
      !Array.from(path).some(
        (part) => part < ' ' || part === '\u007f' || part === '\\',
      ) &&
      path
        .slice('/work/'.length)
        .split('/')
        .every((part) => part && !part.startsWith('.')) &&
      posix.basename(path).length <= 255 &&
      !!fileFormat(path),
  );
export const DEntryCapturedDeliveriesSchema = z
  .array(
    z.strictObject({
      path: nativePath,
      base64: z.base64().max(10_666_668),
    }),
  )
  .max(8);
export type DEntryCapturedDeliveries = z.infer<
  typeof DEntryCapturedDeliveriesSchema
>;

const sha256 = (input: string | Uint8Array) =>
  createHash('sha256').update(input).digest('hex');
const requestPrefix = (sessionId: string, path: string) =>
  `dsh-delivery:${sha256(JSON.stringify([sessionId, path]))}:`;

export const DEntryNativeDeliveryClaimSchema = z.strictObject({
  ticket: z.uuid(),
  sessionId: z.string().min(1).max(256),
  turn: z.number().int().positive(),
  callId: z.string().min(1).max(256),
});
export const DEntryNativeDeliveryCaptureSchema =
  DEntryNativeDeliveryClaimSchema.extend({
    files: DEntryCapturedDeliveriesSchema.min(1),
  });
export type DEntryNativeDeliveryClaim = z.infer<
  typeof DEntryNativeDeliveryClaimSchema
>;
export type DEntryNativeDeliveryCapture = z.infer<
  typeof DEntryNativeDeliveryCaptureSchema
>;

function objectIdFor(requestKey: string) {
  const h = sha256(requestKey);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Keep the storage write outside SQL transactions. A lost response to either
 * COMMIT can only retry the same reservation; it never deletes an object. */
export async function publishCapturedDEntryDelivery(
  candidate: DEntryNativeRunCandidate,
  input: DEntryNativeDeliveryCapture,
  storage: StoragePort,
  current: (transaction: TransactionSql) => Promise<void>,
  signal: AbortSignal,
) {
  const capture = DEntryNativeDeliveryCaptureSchema.parse(input);
  const { organizationId, workspaceId, ownerId, runId, prompt, attempt } =
    candidate;
  if (
    capture.sessionId !== attempt.sessionId ||
    capture.turn !== attempt.turn ||
    attempt.kind !== 'assistant'
  )
    throw new DataAccessError('not_found');
  const unique = new Set<string>();
  let total = 0;
  const files = capture.files.map(({ path, base64 }, index) => {
    const bytes = Buffer.from(base64, 'base64');
    total += bytes.length;
    if (unique.has(path) || bytes.length > 8_000_000 || total > 16_000_000)
      throw new DataAccessError('not_found');
    unique.add(path);
    const prefix = requestPrefix(capture.sessionId, path);
    const occurrence = sha256(
      JSON.stringify([capture.turn, capture.callId, index]),
    );
    const requestId = prefix + occurrence;
    const id = objectIdFor(
      JSON.stringify([
        'dsh-present-v1',
        organizationId,
        workspaceId,
        ownerId,
        prompt.threadId,
        requestId,
      ]),
    );
    const [format, mediaType] = fileFormat(path)!;
    const checksum = `sha256:${sha256(bytes)}`;
    const object: StorageObject = {
      id,
      organizationId,
      workspaceId,
      ownerId,
      mediaType,
      checksum,
      sizeBytes: bytes.length,
      retentionUntil: null,
      deletedAt: null,
      immutable: true,
      key: makeObjectKey({
        organizationId,
        workspaceId,
        ownerId,
        category: 'exports',
        objectId: id,
      }),
    };
    return { path, bytes, prefix, requestId, object, format };
  });
  const db = getDatabase();
  async function authorize(tx: TransactionSql) {
    signal.throwIfAborted();
    await lockWorkspaceStorageQuota(tx, organizationId, workspaceId);
    await current(tx);
    signal.throwIfAborted();
  }
  async function readReservation(tx: TransactionSql, object: StorageObject) {
    const [row] = await tx<
      {
        state: string;
        checksum: string;
        object_key: string;
        size_bytes: string;
        media_type: string;
        visibility: string;
        immutable: boolean;
      }[]
    >`
      select state, checksum, object_key, size_bytes, media_type, visibility, immutable
      from allrice_storage_objects
      where id=${object.id} and organization_id=${organizationId} and workspace_id=${workspaceId}
        and owner_id=${ownerId} and category='exports' and deleted_at is null
      for update
    `;
    if (
      row &&
      (row.checksum !== object.checksum ||
        row.object_key !== object.key ||
        Number(row.size_bytes) !== object.sizeBytes ||
        row.media_type !== object.mediaType ||
        row.visibility !== 'private' ||
        !row.immutable)
    )
      throw new DataAccessError('not_found');
    return row;
  }
  async function ready(tx: TransactionSql, file: (typeof files)[number]) {
    const [row] = await tx`select d.id from allrice_deliverable_versions d
      join allrice_workbench_artifacts a on a.version_id=d.id
      where d.object_id=${file.object.id} and d.session_id=${prompt.threadId} and d.organization_id=${organizationId}
        and d.workspace_id=${workspaceId} and d.owner_id=${ownerId} and a.request_id=${file.requestId}`;
    if (!row) throw new DataAccessError('not_found');
  }
  const pending = await db.begin(async (tx) => {
    await authorize(tx);
    const writes: typeof files = [];
    const [quota] = await tx<{ remainder: string | null }[]>`
      select q.limit_bytes - coalesce(sum(o.size_bytes) filter (where o.state <> 'deleted'), 0) as remainder
      from allrice_workspaces w
      left join allrice_storage_quotas q on q.organization_id=w.organization_id and q.workspace_id=w.id
      left join allrice_storage_objects o on o.organization_id=w.organization_id and o.workspace_id=w.id
      where w.organization_id=${organizationId} and w.id=${workspaceId} and w.archived_at is null
      group by q.limit_bytes
    `;
    if (!quota) throw new DataAccessError('not_found');
    let remainder =
      quota.remainder === null ? Infinity : Number(quota.remainder);
    for (const file of files) {
      const { object } = file;
      const previous = await readReservation(tx, object);
      if (previous?.state === 'ready') {
        await ready(tx, file);
        continue;
      }
      if (!previous) {
        remainder -= object.sizeBytes;
        if (remainder < 0) throw new DataAccessError('quota_exceeded');
        await tx`insert into allrice_storage_objects
          (id, organization_id, workspace_id, owner_id, object_key, category, media_type, size_bytes, checksum, visibility, immutable)
          values (${object.id}, ${organizationId}, ${workspaceId}, ${ownerId}, ${object.key}, 'exports', ${object.mediaType}, ${object.sizeBytes}, ${object.checksum}, 'private', true)`;
        await tx`insert into allrice_audit_events
          (organization_id, workspace_id, actor_id, action, resource_type, resource_id, decision, reason)
          values (${organizationId}, ${workspaceId}, ${ownerId}, 'artifact.native_delivery.reserve', 'storage_object', ${object.id}, 'allowed', 'native_present')`;
      } else {
        await tx`update allrice_storage_objects set updated_at=clock_timestamp() where id=${object.id} and state='pending'`;
      }
      writes.push(file);
    }
    return writes;
  });
  for (const { object, bytes } of pending) {
    signal.throwIfAborted();
    await storage.put(object, new Blob([new Uint8Array(bytes)]).stream());
  }
  await db.begin(async (tx) => {
    await authorize(tx);
    for (const file of files) {
      const { object, prefix, requestId, path, format } = file;
      const reservation = await readReservation(tx, object);
      if (!reservation) throw new DataAccessError('not_found');
      if (reservation.state === 'ready') {
        await ready(tx, file);
        continue;
      }
      if (reservation.state !== 'pending')
        throw new DataAccessError('not_found');
      const [previous] = await tx<
        { id: string; series_id: string; version: number; file_name: string }[]
      >`
        select d.id, d.series_id, d.version, d.file_name from allrice_deliverable_versions d
        join allrice_workbench_artifacts a on a.version_id=d.id
        where d.organization_id=${organizationId} and d.workspace_id=${workspaceId}
          and d.owner_id=${ownerId} and d.session_id=${prompt.threadId}
          and left(a.request_id, ${prefix.length})=${prefix}
        order by d.version desc limit 1`;
      const fileName =
        previous?.file_name ??
        (await allocateWorkbenchFileName(
          tx,
          candidate,
          object.id,
          posix.basename(path),
        ));
      const versionId = randomUUID();
      await tx`insert into allrice_deliverable_versions
        (id, organization_id, workspace_id, owner_id, object_id, series_id, version, parent_version_id, session_id, file_name, format)
        values (${versionId}, ${organizationId}, ${workspaceId}, ${ownerId}, ${object.id}, ${previous?.series_id ?? randomUUID()}, ${(previous?.version ?? 0) + 1}, ${previous?.id ?? null}, ${prompt.threadId}, ${fileName}, ${format})`;
      await tx`insert into allrice_workbench_artifacts
        (version_id, organization_id, workspace_id, owner_id, run_id, kind, provenance, request_id, request_digest)
        values (${versionId}, ${organizationId}, ${workspaceId}, ${ownerId}, ${runId}, 'file', ${tx.json({ kind: 'tool_result', runId, operationId: null, stepId: candidate.executionId })}, ${requestId}, ${'sha256:' + sha256(JSON.stringify([requestId, object.checksum]))})`;
      await tx`update allrice_storage_objects set state='ready',updated_at=clock_timestamp() where id=${object.id} and state='pending'`;
    }
    signal.throwIfAborted();
  });
}

/** The panel caller first qualifies the current employee and owned thread. */
export async function findDEntryNativeDelivery(
  context: RequestContext,
  selection: {
    workspaceId: string;
    employeeInstanceId: string;
    threadId?: string;
  },
  coordinate: string,
  occurrence?: string,
) {
  if (
    !selection.threadId ||
    context.actor.type !== 'user' ||
    context.workspaceId !== selection.workspaceId
  )
    throw new DataAccessError('not_found');
  const prefix = `dsh-delivery:${z.hash('sha256').parse(coordinate)}:`;
  const sql = getDatabase();
  const exact =
    occurrence === undefined
      ? sql``
      : sql`and a.request_id=${prefix + z.hash('sha256').parse(occurrence)}`;
  const [object] = await sql<{ object_id: string }[]>`
    select v.object_id from allrice_deliverable_versions v
    join allrice_workbench_artifacts a on a.version_id=v.id
    join allrice_chat_sessions s on s.id=v.session_id and s.organization_id=v.organization_id
      and s.workspace_id=v.workspace_id and s.owner_id=v.owner_id
    join allrice_storage_objects o on o.id=v.object_id
    where v.organization_id=${context.organizationId} and v.workspace_id=${selection.workspaceId}
      and v.owner_id=${context.actor.id} and s.id=${selection.threadId}
      and s.execution_generation='4.0' and s.d_entry_native_root is not null and s.archived_at is null
      and coalesce(s.employee_instance_id,s.employee_assignment_id)=${selection.employeeInstanceId}
      and left(a.request_id, ${prefix.length})=${prefix}
      ${exact}
      and o.state='ready' and o.deleted_at is null and (o.retention_until is null or o.retention_until>clock_timestamp())
    order by v.version desc limit 1
  `;
  if (!object) throw new DataAccessError('not_found');
  return object.object_id;
}

/** Abandoned reservations are never served. Claim only expired pending rows
 * previously tagged by this publisher, then clean their tombstoned bytes.
 * An interrupted sweep can resume from the tombstone without re-opening it. */
export async function sweepDEntryNativeDeliveryReservations(
  storage: StoragePort,
  signal: AbortSignal,
) {
  const db = getDatabase();
  signal.throwIfAborted();
  await db`
    with expired as (
      select o.id from allrice_storage_objects o
      where o.state='pending' and o.updated_at < clock_timestamp() - interval '1 hour'
        and exists (
          select 1 from allrice_audit_events a
          where a.resource_id=o.id and a.organization_id=o.organization_id
            and a.workspace_id=o.workspace_id and a.actor_id=o.owner_id
            and a.action='artifact.native_delivery.reserve'
        )
      order by o.updated_at, o.id limit 32 for update of o skip locked
    )
    update allrice_storage_objects o
    set state='deleted', deleted_at=clock_timestamp(), updated_at=clock_timestamp()
    from expired where o.id=expired.id and o.state='pending'
  `;
  const deleted = await db<
    {
      id: string;
      organization_id: string;
      workspace_id: string;
      owner_id: string;
      object_key: string;
      checksum: string;
      media_type: string;
      size_bytes: string;
      deleted_at: Date;
    }[]
  >`
    select o.id, o.organization_id, o.workspace_id, o.owner_id, o.object_key,
      o.checksum, o.media_type, o.size_bytes, o.deleted_at
    from allrice_storage_objects o
    where o.state='deleted' and o.deleted_at < clock_timestamp() - interval '5 minutes'
      and exists (
        select 1 from allrice_audit_events a
        where a.resource_id=o.id and a.organization_id=o.organization_id
          and a.workspace_id=o.workspace_id and a.actor_id=o.owner_id
          and a.action='artifact.native_delivery.reserve'
      ) and not exists (
        select 1 from allrice_audit_events a
        where a.resource_id=o.id and a.organization_id=o.organization_id
          and a.workspace_id=o.workspace_id and a.actor_id=o.owner_id
          and a.action='artifact.native_delivery.swept'
      )
    order by o.updated_at, o.id limit 32
  `;
  for (const row of deleted) {
    signal.throwIfAborted();
    await storage.delete({
      id: row.id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      key: row.object_key,
      mediaType: row.media_type,
      checksum: row.checksum,
      sizeBytes: Number(row.size_bytes),
      immutable: false,
      retentionUntil: null,
      deletedAt: row.deleted_at.toISOString(),
    });
    await db`insert into allrice_audit_events
      (organization_id, workspace_id, actor_id, action, resource_type, resource_id, decision, reason)
      values (${row.organization_id}, ${row.workspace_id}, ${row.owner_id}, 'artifact.native_delivery.swept', 'storage_object', ${row.id}, 'allowed', 'expired_reservation')`;
  }
}
