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
} from '../../../../lib/d-entry/profile';
import { renderEmployeeDocument } from '../../../../lib/d-entry/employee-document';
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
    const address = await profileAddress(input, scopeId);
    response = await renderEmployeeDocument(request, input, address, true);
  } catch (error) {
    response = dEntryErrorResponse(error);
  }
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

// Next otherwise falls back to GET for HEAD, which would consume the
// page scope's one-shot bootstrap without returning its body.
export function HEAD() {
  return new Response(null, {
    status: 405,
    headers: { Allow: 'GET', 'Cache-Control': 'private, no-store' },
  });
}
