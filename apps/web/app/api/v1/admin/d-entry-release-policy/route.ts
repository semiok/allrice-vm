import {
  DataAccessError,
  getDEntryReleasePolicy,
  updateDEntryReleasePolicy,
} from '@allrice/database';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';
import { administrationError } from '../../../../../lib/identity/administration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    return Response.json(
      await getDEntryReleasePolicy(await requirePlatformAdminContext(request)),
      { headers },
    );
  } catch (error) {
    return administrationError(error);
  }
}

export async function PUT(request: Request) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await requirePlatformAdminContext(request);
    return Response.json(
      await updateDEntryReleasePolicy(context, await request.json(), {
        compareRevision: true,
      }),
      { headers },
    );
  } catch (error) {
    return administrationError(error);
  }
}
