import { DataAccessError } from '@allrice/database';

import { MemoryMutationCommandProjectionSchema } from '@allrice/contracts';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import { storageErrorResponse } from '../../../../../../lib/storage/responses';
import { personalEmployeeMemory } from '../../../../../../lib/memory/employee-memory-personal-source';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    const result = await personalEmployeeMemory.confirm(
      context,
      MemoryMutationCommandProjectionSchema.parse({
        target: { workspaceId, memoryId: id },
        body: await request.json(),
      }),
      request.signal,
    );
    return Response.json(result, {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    const response = storageErrorResponse(error);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  }
}
