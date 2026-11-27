/** Explicit employee fixture for DB tests that need an assigned employee. */
import type { RequestContext } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employees/employee-config.ts';

export async function createTestEmployeeAssignment(
  context: RequestContext,
  workspaceId: string,
) {
  const { organizationId, actor } = context;
  if (actor.type !== 'user') throw Error('employee fixture requires a user');
  const manifest = employeeManifest({
    key: `test-employee-${actor.id}`,
    name: 'Test employee',
    description: 'Employee explicitly created for an integration test.',
  });
  return getDatabase().begin(async (sql) => {
    const [prior] = await sql<
      { id: string; employeeId: string; employeeVersionId: string }[]
    >`
      select a.id,a.employee_id as "employeeId",a.employee_version_id as "employeeVersionId"
      from allrice_employee_assignments a join allrice_employees e on e.id=a.employee_id
      where a.organization_id=${organizationId} and a.workspace_id=${workspaceId}
        and a.user_id=${actor.id} and e.employee_key=${manifest.key} and a.active
    `;
    if (prior) return prior;
    const [employee] = await sql<{ id: string }[]>`
      insert into allrice_employees (organization_id,workspace_id,employee_key,name)
      values(${organizationId},${workspaceId},${manifest.key},${manifest.name}) returning id
    `;
    const [version] = await sql<{ id: string }[]>`
      insert into allrice_employee_versions
        (organization_id,workspace_id,employee_id,version,name,description,model,
          system_prompt,capabilities,manifest,provider_snapshot,skill_version_ids,config_checksum)
      values(${organizationId},${workspaceId},${employee!.id},1,${manifest.name},
        ${manifest.description},${manifest.provider.model},${manifest.systemPrompt},
        ${sql.json(manifest.capabilities)},${sql.json(manifest)},${sql.json(manifest.provider)},
        ${sql.json(manifest.skillVersionIds)},${employeeManifestChecksum(manifest)}) returning id
    `;
    const [assignment] = await sql<{ id: string }[]>`
      insert into allrice_employee_assignments
        (organization_id,workspace_id,employee_id,employee_version_id,user_id,is_default,active)
      values(${organizationId},${workspaceId},${employee!.id},${version!.id},${actor.id},
        not exists(select 1 from allrice_employee_assignments where organization_id=${organizationId}
          and workspace_id=${workspaceId} and user_id=${actor.id} and active and is_default),true)
      returning id
    `;
    return {
      id: assignment!.id,
      employeeId: employee!.id,
      employeeVersionId: version!.id,
    };
  });
}
