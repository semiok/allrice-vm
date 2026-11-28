import type { Sql } from 'postgres';
import type {
  DEntryIdentity,
  EmployeeFileMentionPin,
  RequestContext,
} from '@allrice/contracts';
import { withDedicatedCallerTransaction } from './business-runtime/caller-transaction.ts';
import { getDatabase } from './core/client.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { requireEmployeePanelsAccess } from './employee-panels-access.ts';
import { DataAccessError } from './data.ts';
import { readReferenceSelection } from './reference-runtime.ts';
import { readWorkbenchFile } from './workbench-files.ts';
import { personalWorkbenchOrigins } from './workbench-file-personal.ts';
import { lockNativeMemoryCodexDispatch } from './employee-memory-runtime.ts';

type Owner = {
  workspaceId: string;
  employeeInstanceId: string;
  threadId: string;
  employeeVersionId: string;
};

async function requireOriginal(
  tx: Sql,
  context: RequestContext,
  pin: EmployeeFileMentionPin,
) {
  if (pin.kind === 'material') {
    const current = await readReferenceSelection(
      context,
      pin.revisionId,
      tx,
      true,
    );
    const exact = current.selection;
    if (
      !current.publication ||
      (!current.readCapabilities.text && !current.readCapabilities.archive) ||
      exact.sourceId !== pin.sourceId ||
      exact.revision !== pin.revision ||
      exact.checksum !== pin.checksum ||
      (pin.digest !== undefined && exact.digest !== pin.digest)
    )
      throw new DataAccessError('not_found');
    return {
      object: current.object,
      fileName: exact.fileName,
      archive: current.readCapabilities.archive,
    };
  }
  // Lock the immutable original and business directory witnesses. This uses the
  // same owner-only origins as the 4.0 directory, including legacy exclusions.
  const [original] = await tx`
    select id from allrice_storage_objects
    where id=${pin.objectId} and organization_id=${context.organizationId}
      and workspace_id=${context.workspaceId!} and owner_id=${context.actor.id}
      and checksum=${pin.checksum} and immutable and state='ready'
      and deleted_at is null
      and (retention_until is null or retention_until>clock_timestamp())
    for share`;
  if (!original) throw new DataAccessError('not_found');
  await tx`
    select dv.id from allrice_deliverable_versions dv
    join allrice_chat_sessions s on s.id=dv.session_id
      and s.organization_id=dv.organization_id and s.workspace_id=dv.workspace_id
      and s.owner_id=dv.owner_id
    where dv.object_id=${pin.objectId} and dv.organization_id=${context.organizationId}
      and dv.workspace_id=${context.workspaceId!} and dv.owner_id=${context.actor.id}
    order by dv.id for share of dv,s`;
  await tx`
    select a.id from allrice_workbench_artifacts a
    join allrice_deliverable_versions dv on dv.id=a.version_id
    where dv.object_id=${pin.objectId} and a.organization_id=${context.organizationId}
      and a.workspace_id=${context.workspaceId!} and a.owner_id=${context.actor.id}
    order by a.id for share of a`;
  const [eligible] = await tx`with ${personalWorkbenchOrigins(tx, {
    organizationId: context.organizationId,
    workspaceId: context.workspaceId!,
    ownerId: context.actor.id,
  })} select id from origins where id=${pin.objectId} and category='artifact'`;
  if (!eligible) throw new DataAccessError('not_found');
  const file = await readWorkbenchFile(context, pin.objectId, tx);
  if (file.object.checksum !== pin.checksum)
    throw new DataAccessError('not_found');
  return { object: file.object, fileName: file.row.file_name, archive: false };
}

/** Model Host only. Dispatch joins the memory transaction if present. The
 * authorized body must reach the owned dispatcher before these locks release. */
export async function withEmployeeFileMentions<T>(
  context: RequestContext,
  owner: Owner,
  pins: readonly EmployeeFileMentionPin[],
  signal: AbortSignal,
  qualify: (identity: DEntryIdentity) => Promise<void>,
  body: (files: Awaited<ReturnType<typeof requireOriginal>>[]) => Promise<T>,
  dispatch?: {
    transaction?: Sql;
    codex?: Parameters<typeof lockNativeMemoryCodexDispatch>[1];
  },
) {
  async function run(tx: Sql) {
    signal.throwIfAborted();
    if (!(await readContentPrincipal(context, tx, true)))
      throw new DataAccessError('authorization_denied');
    const { employeeVersionId, ...selection } = owner;
    const identity = await requireEmployeePanelsAccess(context, selection, tx);
    if (identity.employeeVersionId !== employeeVersionId)
      throw new DataAccessError('authorization_denied');
    await qualify(identity);
    const files = [];
    for (const pin of pins) {
      signal.throwIfAborted();
      files.push(await requireOriginal(tx, context, pin));
    }
    if (dispatch?.codex && !dispatch.transaction)
      await lockNativeMemoryCodexDispatch(tx, dispatch.codex);
    signal.throwIfAborted();
    return body(files);
  }
  return dispatch?.transaction
    ? run(dispatch.transaction)
    : withDedicatedCallerTransaction(getDatabase(), run, signal);
}
