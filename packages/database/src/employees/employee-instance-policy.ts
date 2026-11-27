import type { EmployeeInstanceSnapshot } from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import type { getDatabase } from '../core/client.ts';

type ContentSql = ReturnType<typeof getDatabase> | TransactionSql;

/** Recognize only the persisted legacy platform mapping when preserving its
 * old no-snapshot tool restriction. This does not authorize any operation. */
export async function hasRetiredGeneralEmployeeBinding(
  instance: EmployeeInstanceSnapshot,
  sql: ContentSql,
) {
  const { source } = instance;
  if (instance.kind !== 'general' || source.kind !== 'platform') return false;
  const [row] = await sql<{ present: number }[]>`
    select 1 as present from allrice_employee_assignments a
    join allrice_employees e on e.id=a.employee_id
      and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
    join allrice_employee_version_sources s on s.employee_id=e.id
      and s.organization_id=e.organization_id and s.workspace_id=e.workspace_id
      and s.employee_version_id=${source.employeeVersionId}
    join allrice_platform_employee_revisions r on r.id=s.platform_revision_id
      and r.employee_id=s.platform_employee_id
    join allrice_platform_employees p on p.id=r.employee_id
    where a.id=${instance.assignmentId} and a.organization_id=${instance.organizationId}
      and a.workspace_id=${instance.workspaceId} and a.user_id=${instance.ownerId}
      and e.employee_key='default-assistant'
      and s.platform_employee_id=${source.templateId} and r.id=${source.templateRevisionId}
      and r.checksum=${source.templateChecksum} and r.revision=${source.templateRevision}
      and p.employee_key='rice' and r.definition->>'key'='rice' and r.status='published'
  `;
  return !!row;
}

/** Directory callers enforce owner visibility before projecting a personal name. */
export function personalInstanceNameSql(sql: ContentSql) {
  return sql`i.kind='custom'`;
}

/** The caller must establish current owner and assignment authority. */
export function canUsePersonalEmployeeScenes(
  instance: Pick<EmployeeInstanceSnapshot, 'kind'>,
) {
  return instance.kind === 'custom';
}
