import { cookies } from 'next/headers';

import { revokeSession } from '@allrice/database';
import { authenticationRequiredProblem } from '../../../../../lib/api-error-response';

import {
  getRequestContext,
  sessionCookieName,
  sessionCookieOptions,
} from '../../../../../lib/identity/session';
import {
  portalSessionCookieName,
  portalSessionCookieOptions,
} from '../../../../../lib/portal/session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const expectedSession = request.headers.get('x-allrice-expected-session-id');
  if (expectedSession !== null) {
    const context = await getRequestContext(request);
    if (!context || context.sessionId !== expectedSession)
      return authenticationRequiredProblem();
  }
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  if (token) await revokeSession(token);
  // A late response from the old workbench must leave a replacement login alone.
  if (expectedSession !== null) return new Response(null, { status: 204 });
  cookieStore.set(sessionCookieName, '', {
    ...sessionCookieOptions,
    expires: new Date(0),
  });
  cookieStore.set(portalSessionCookieName, '', {
    ...portalSessionCookieOptions,
    expires: new Date(0),
  });
  return new Response(null, { status: 204 });
}
