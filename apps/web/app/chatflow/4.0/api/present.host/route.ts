import { headlessPresentedHost } from '../../../../../lib/d-entry/presented-host';
import { dEntryErrorResponse } from '../../../../../lib/d-entry/responses';
import { requireRequestContext } from '../../../../../lib/identity/session';

export async function GET(request: Request) {
  try {
    await requireRequestContext(request);
    return headlessPresentedHost();
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
