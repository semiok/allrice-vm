import {
  CompanyDeliverablesFilterSchema,
  UuidSchema,
  type CompanyDeliverable,
  type CompanyDeliverables,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { getManagedOrganization } from './organization-administration.ts';
import {
  businessDeliverablePredicate,
  organizationDashboardPeriod,
  organizationWorkSource,
} from './organization-dashboard.ts';
import { diagnosticText } from './tenant-validation.ts';
import { workbenchFileAccess } from './workbench-file-access.ts';

export async function listCompanyDeliverables(
  context: RequestContext,
  orgInput: string,
  input: unknown = {},
): Promise<CompanyDeliverables> {
  const organizationId = UuidSchema.parse(orgInput),
    filter = CompanyDeliverablesFilterSchema.parse(input);
  await getManagedOrganization(context, organizationId);
  const db = getDatabase(),
    period = organizationDashboardPeriod(filter),
    source = organizationWorkSource(db, organizationId, filter);
  const eligible = db`select dv.*,o.size_bytes,
    case when o.deleted_at is not null then 'deleted' when o.retention_until<=clock_timestamp() then 'expired'
      when o.state='ready' and w.archived_at is null then 'ready' else 'unavailable' end as availability,
    coalesce(person.display_name,u.display_name) as owner_name,
    a.run_id,origin.state as run_status,origin.employee_id,origin.employee_name,
    max(dv.version) over(partition by dv.organization_id,dv.workspace_id,dv.owner_id,dv.series_id) as latest_published_version
    from allrice_deliverable_versions dv
    join allrice_storage_objects o on o.id=dv.object_id and o.organization_id=dv.organization_id and o.workspace_id=dv.workspace_id and o.owner_id=dv.owner_id
    join allrice_chat_sessions s on s.id=dv.session_id and s.organization_id=dv.organization_id and s.workspace_id=dv.workspace_id and s.owner_id=dv.owner_id
    join allrice_users u on u.id=dv.owner_id
    join allrice_workspaces w on w.id=dv.workspace_id and w.organization_id=dv.organization_id
    left join allrice_organization_people person on person.organization_id=dv.organization_id and person.user_id=dv.owner_id
    left join allrice_workbench_artifacts a on a.version_id=dv.id and a.organization_id=dv.organization_id and a.workspace_id=dv.workspace_id and a.owner_id=dv.owner_id
    left join scoped_runs origin on origin.id=a.run_id
    where dv.organization_id=${organizationId} and dv.platform_test_run_id is null
      and exists(select 1 from scoped_runs f where f.workspace_id=dv.workspace_id and f.owner_id=dv.owner_id and f.session_id=dv.session_id and (a.run_id is null or a.run_id=f.id))
      and (${filter.employeeId ?? null}::uuid is null or a.run_id is not null)
      and ${businessDeliverablePredicate(db)}`;
  const candidates = filter.seriesId
    ? db`select * from eligible where series_id=${filter.seriesId}`
    : db`select distinct on(series_id) * from eligible order by series_id,(availability='ready') desc,version desc,id desc`;
  const cte = db`with scoped_runs as(select r.id,r.state,r.workspace_id,r.owner_id,er.session_id,coalesce(d.employee_id,e.id) as employee_id,v.name as employee_name ${source}),eligible as(${eligible}),candidates as(${candidates})`;
  let cursor: { id: string; cursor_at: string } | undefined;
  if (filter.before) {
    const [candidate] = await db<
      { id: string; cursor_at: string; object_id: string }[]
    >`
      ${cte} select id,object_id,created_at::text as cursor_at from candidates where id=${filter.before}`;
    if (!candidate) throw new DataAccessError('not_found');
    const access = await workbenchFileAccess(context, candidate.object_id, db);
    if (access && !access.canRead) throw new DataAccessError('not_found');
    cursor = candidate;
  }
  type Row = {
    id: string;
    series_id: string;
    workspace_id: string;
    owner_id: string;
    owner_name: string;
    object_id: string;
    session_id: string;
    run_id: string | null;
    run_status: CompanyDeliverable['runStatus'];
    employee_id: string | null;
    employee_name: string | null;
    file_name: string;
    format: CompanyDeliverable['format'];
    version: number;
    latest_published_version: number;
    created_at: Date;
    size_bytes: string;
    availability: CompanyDeliverable['state'];
    cursor_at: string;
  };
  const visible: Row[] = [];
  while (visible.length < 51) {
    const batch = await db<
      Row[]
    >`${cte} select *,created_at::text as cursor_at from candidates
      where (${filter.includeUnavailable} or availability='ready')
        and (${filter.format ?? null}::text is null or format=${filter.format ?? null})
        and (${!filter.periodOnly} or (created_at>=${period.from}::timestamptz and created_at<${period.to}::timestamptz))
        and (${cursor?.cursor_at ?? null}::text::timestamptz is null or
          (created_at,id)<(${cursor?.cursor_at ?? null}::text::timestamptz,${cursor?.id ?? null}::uuid))
      order by created_at desc,id desc limit 51`;
    for (const row of batch) {
      const access = await workbenchFileAccess(context, row.object_id, db);
      if (!access || access.canRead) visible.push(row);
      if (visible.length === 51) break;
    }
    if (batch.length < 51) break;
    cursor = batch.at(-1);
  }
  const page = visible.slice(0, 50);
  await getManagedOrganization(context, organizationId);
  return {
    organizationId,
    seriesId: filter.seriesId ?? null,
    nextCursor: visible.length > 50 ? page.at(-1)!.id : null,
    deliverables: page.map((r) => ({
      id: r.id,
      seriesId: r.series_id,
      workspaceId: r.workspace_id,
      ownerId: r.owner_id,
      ownerName: diagnosticText(r.owner_name),
      sessionId: r.session_id,
      sessionTitle: '会话',
      runId: r.run_id,
      runStatus: r.run_status,
      employeeId: r.employee_id,
      employeeName:
        r.employee_name === null ? null : diagnosticText(r.employee_name),
      fileName: r.file_name,
      format: r.format,
      version: r.version,
      latestPublishedVersion: r.latest_published_version,
      createdAt: r.created_at.toISOString(),
      sizeBytes: Number(r.size_bytes),
      state: r.availability,
    })),
  };
}
