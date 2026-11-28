import { readAdministrationRuntimeTimeline } from '@allrice/database';
import {
  administrationError,
  administrationHeaders,
  requireAdministrationLogin,
} from '../../../../../../../lib/identity/administration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  route: { params: Promise<{ sessionId: string }> },
) {
  try {
    const context = await requireAdministrationLogin(request);
    const { sessionId } = await route.params;
    const organizationId = new URL(request.url).searchParams.get(
      'organizationId',
    );
    return Response.json(
      {
        timeline: await readAdministrationRuntimeTimeline(
          context,
          sessionId,
          organizationId,
        ),
      },
      { headers: administrationHeaders },
    );
  } catch (error) {
    return administrationError(error);
  }
}
