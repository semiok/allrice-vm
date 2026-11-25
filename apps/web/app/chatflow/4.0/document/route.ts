import {
  DEntryPageBorrowSchema,
  DEntrySelectionInputSchema,
} from '@allrice/contracts';
import { requireRequestContext } from '../../../../lib/identity/session';
import { currentNativeRequest } from '../../../../lib/d-entry/native-request';
import { DEntryDependencyUnavailable } from '../../../../lib/d-entry/release-policy';
import { resolveDEntryIdentity } from '../../../../lib/d-entry/identity';
import {
  exactProfileQuery,
  profileAddress,
  profileDirectory,
} from '../../../../lib/d-entry/profile';
import { dEntryErrorResponse } from '../../../../lib/d-entry/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let response: Response;
  try {
    const context = await requireRequestContext(request);
    const query = exactProfileQuery(request.url);
    if (!('scopeId' in query)) {
      await resolveDEntryIdentity(
        context,
        DEntrySelectionInputSchema.parse(query),
        'history',
      );
      throw new DEntryDependencyUnavailable('native-route');
    }
    const { scopeId, ...selection } = DEntryPageBorrowSchema.parse(query);
    const input = await currentNativeRequest(
      request,
      selection,
      context,
      'history',
    );
    const location = await profileAddress(input, scopeId);
    response = new Response(null, {
      status: 307,
      headers: {
        location: profileDirectory('document', location) + '/native/index.html',
      },
    });
  } catch (error) {
    response = dEntryErrorResponse(error);
  }
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}
