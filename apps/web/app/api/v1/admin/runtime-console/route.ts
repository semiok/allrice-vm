import {
  listDshRuntimeInventory,
  readOperationsInventory,
  listTenantRuntimeInventory,
  requireCurrentPlatformAdmin,
} from '@allrice/database';

import {
  administrationError,
  administrationHeaders,
  requireAdministrationLogin,
} from '../../../../../lib/identity/administration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const context = await requireAdministrationLogin(request);
    await requireCurrentPlatformAdmin(context, undefined, false);
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get('limit') ?? 100);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
    const scope = {
      organizationId: url.searchParams.get('organizationId') ?? undefined,
      ownerId: url.searchParams.get('ownerId') ?? undefined,
    };
    const [tenants, runtimes, employeeTenants, operations] = await Promise.all([
      listTenantRuntimeInventory(),
      listDshRuntimeInventory(limit, scope),
      scope.organizationId && scope.ownerId
        ? listTenantRuntimeInventory(scope)
        : Promise.resolve([]),
      readOperationsInventory().catch(() => null),
    ]);
    await requireCurrentPlatformAdmin(context, undefined, false);
    return Response.json(
      {
        console: {
          name: 'AllRice Runtime Console',
          authority: 'ChatFlow 3.0',
          harness: 'DSH',
          mode: 'read-only',
          source: 'allrice_conversation_runtimes',
        },
        tenants,
        runtimes,
        employeeTenants,
        operations,
        scope,
      },
      { headers: administrationHeaders },
    );
  } catch (error) {
    return administrationError(error);
  }
}
