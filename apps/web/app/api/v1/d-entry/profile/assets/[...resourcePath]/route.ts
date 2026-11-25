import { DataAccessError } from '@allrice/database';
import {
  profileInput,
  profileStaticFile,
  readProfileDirectory,
} from '../../../../../../../lib/d-entry/profile';
import { dEntryErrorResponse } from '../../../../../../../lib/d-entry/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ resourcePath: string[] }> },
) {
  try {
    const [prefix, ...parts] = (await params).resourcePath;
    if (prefix !== 'static' || new URL(request.url).search)
      throw new DataAccessError('not_found');
    const location = readProfileDirectory(request, parts);
    const input = await profileInput(request, location.selection);
    return await profileStaticFile(input, location, location.path);
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
