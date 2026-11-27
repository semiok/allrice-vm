import { UuidSchema, type RequestContext } from '@allrice/contracts';
import { requireCurrentPlatformAdmin } from './platform-authority.ts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';

/** Durable VM row only. No lease acquisition or guest/disk probing. */
export async function readPersonVmAdministrationSummary(
  context: RequestContext,
  target: { organizationId: string; personId: string },
) {
  const organizationId = UuidSchema.parse(target.organizationId);
  const personId = UuidSchema.parse(target.personId);
  const db = getDatabase();
  await requireCurrentPlatformAdmin(context, db, false);
  const [row] = await db<
    {
      personId: string;
      organizationId: string;
      vmId: string;
      phase: string;
      diskRetained: boolean;
      diskTier: string;
      leaseEpoch: string;
      gatewayPortCount: number;
      stoppedAt: Date | null;
      recordedAt: Date;
    }[]
  >`
    select vm.person_id as "personId", vm.organization_id as "organizationId",
      vm.vm_id as "vmId", vm.phase, vm.disk_retained as "diskRetained", vm.disk_tier as "diskTier",
      vm.lease_epoch::text as "leaseEpoch", jsonb_array_length(vm.gateway_ports) as "gatewayPortCount",
      vm.stopped_at as "stoppedAt", vm.updated_at as "recordedAt"
    from person_virtual_machines vm
    join allrice_organizations o on o.id=vm.organization_id and o.archived_at is null
    where vm.person_id=${personId} and vm.organization_id=${organizationId}
  `;
  await requireCurrentPlatformAdmin(context, db, false);
  if (!row) throw new DataAccessError('not_found');
  return { ...row, source: 'recorded_vm_state' as const };
}
