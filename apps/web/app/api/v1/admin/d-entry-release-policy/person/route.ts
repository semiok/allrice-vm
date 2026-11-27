import { UuidSchema } from '@allrice/contracts';
import {
  DataAccessError,
  getDEntryPersonRollout,
  requireCurrentPlatformAdmin,
  updateDEntryPersonRollout,
} from '@allrice/database';
import {
  administrationError,
  administrationHeaders,
  requireAdministrationLogin,
} from '../../../../../../lib/identity/administration';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const context = await requireAdministrationLogin(request);
    const query = new URL(request.url).searchParams;
    return Response.json(
      await getDEntryPersonRollout(context, {
        organizationId: UuidSchema.parse(query.get('organizationId')),
        personId: UuidSchema.parse(query.get('personId')),
      }),
      { headers: administrationHeaders },
    );
  } catch (error) {
    return administrationError(error);
  }
}

export async function PUT(request: Request) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await requireAdministrationLogin(request);
    await requireCurrentPlatformAdmin(context, undefined, false);
    return Response.json(
      await updateDEntryPersonRollout(context, await request.json()),
      {
        headers: administrationHeaders,
      },
    );
  } catch (error) {
    return administrationError(error);
  }
}
