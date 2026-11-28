import { UuidSchema } from '@allrice/contracts';
import { readPersonVmAdministrationSummary } from '@allrice/database';
import {
  administrationError,
  administrationHeaders,
  requireAdministrationLogin,
} from '../../../../../../lib/identity/administration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  route: { params: Promise<{ personId: string }> },
) {
  try {
    const context = await requireAdministrationLogin(request);
    const organizationId = UuidSchema.parse(
      new URL(request.url).searchParams.get('organizationId'),
    );
    const { personId } = await route.params;
    return Response.json(
      await readPersonVmAdministrationSummary(context, {
        organizationId,
        personId,
      }),
      { headers: administrationHeaders },
    );
  } catch (error) {
    return administrationError(error);
  }
}
