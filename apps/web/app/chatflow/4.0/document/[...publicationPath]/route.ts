import { DataAccessError } from '@allrice/database';
import { apiProblem } from '../../../../../lib/api-error-response';
import {
  profileAddress,
  profileInput,
  profileStaticFile,
  readProfileDirectory,
} from '../../../../../lib/d-entry/profile';
import { dEntryErrorResponse } from '../../../../../lib/d-entry/responses';
import { renderEmployeeDocument } from '../../../../../lib/d-entry/employee-document';
import { headlessPresentedHost } from '../../../../../lib/d-entry/presented-host';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const unavailable = () =>
  apiProblem({
    status: 403,
    code: 'AUTHORIZATION_DENIED',
    message: 'This native route requires the Host owner',
    retryable: false,
  });
type Params = { params: Promise<{ publicationPath: string[] }> };
export async function GET(request: Request, { params }: Params) {
  try {
    const target = readProfileDirectory(
      request,
      (await params).publicationPath,
    );
    const input = await profileInput(request, target.selection);
    if (target.path === 'native/api/file') {
      await qualifyDocument(input, target);
      return unavailable();
    }
    if (new URL(request.url).search) throw new DataAccessError('not_found');
    if (target.path === 'native/api/present.host') {
      await qualifyDocument(input, target);
      return headlessPresentedHost();
    }
    if (target.path !== 'native/index.html')
      return await profileStaticFile(input, target, target.path);
    const address = await qualifyDocument(input, target);
    return await renderEmployeeDocument(request, input, address, false);
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
export async function POST(request: Request, { params }: Params) {
  try {
    const target = readProfileDirectory(
      request,
      (await params).publicationPath,
    );
    if (target.path !== 'native/api/session/uploadFileBinary')
      throw new DataAccessError('not_found');
    await qualifyDocument(
      await profileInput(request, target.selection),
      target,
    );
    return unavailable();
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}

async function qualifyDocument(
  input: Awaited<ReturnType<typeof profileInput>>,
  target: ReturnType<typeof readProfileDirectory>,
) {
  const address = await profileAddress(input, target.scopeId);
  if (
    target.bindingRef !== address.bindingRef ||
    target.manifestSha256 !== address.manifestSha256 ||
    target.graphRev !== address.graphRev
  )
    throw new DataAccessError('not_found');
  return address;
}
