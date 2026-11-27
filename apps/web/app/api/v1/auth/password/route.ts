import { cookies } from 'next/headers';
import { changePassword } from '@allrice/database';
import {
  getRequestContext,
  sessionCookieName,
  sessionCookieOptions,
} from '../../../../../lib/identity/session';
import { identityErrorResponse } from '../../../../../lib/identity/responses';
import { authenticationRequiredProblem } from '../../../../../lib/api-error-response';
import {
  portalSessionCookieName,
  portalSessionCookieOptions,
} from '../../../../../lib/portal/session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    const expectedSession = request.headers.get(
      'x-allrice-expected-session-id',
    );
    if (
      !context ||
      (expectedSession !== null && expectedSession !== context.sessionId)
    )
      return authenticationRequiredProblem();
    await changePassword(context, await request.json());
    // A scoped workbench response can arrive after another tab logs in.
    // The database has revoked the exact login, so do not overwrite its cookies.
    if (expectedSession !== null) return new Response(null, { status: 204 });
    const store = await cookies();
    store.set(sessionCookieName, '', {
      ...sessionCookieOptions,
      expires: new Date(0),
    });
    store.set(portalSessionCookieName, '', {
      ...portalSessionCookieOptions,
      expires: new Date(0),
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
