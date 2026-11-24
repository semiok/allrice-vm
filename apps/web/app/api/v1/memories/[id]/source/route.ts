import {
  EmployeeMemoryListQuerySchema,
  MemoryDetailQueryProjectionSchema,
  MemorySourceViewProjectionSchema,
} from '@allrice/contracts';
import { requireRequestContext } from '../../../../../../lib/identity/session';
import { readPersonalEmployeeMemorySource } from '../../../../../../lib/memory/employee-memory-personal-source';
import { storageErrorResponse } from '../../../../../../lib/storage/responses';

export const runtime = 'nodejs';
const headers = { 'cache-control': 'private, no-store' };

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireRequestContext(request);
    const { id } = await route.params;
    const params = new URL(request.url).searchParams;
    const query = EmployeeMemoryListQuerySchema.parse(
      params.size === 2 ? Object.fromEntries(params) : {},
    );
    const target = MemoryDetailQueryProjectionSchema.parse({
      ...query,
      memoryId: id,
    });
    const source = await readPersonalEmployeeMemorySource(
      context,
      target,
      request.signal,
    );
    request.signal.throwIfAborted();
    return Response.json(MemorySourceViewProjectionSchema.parse(source), {
      headers,
    });
  } catch (error) {
    const response = storageErrorResponse(error);
    response.headers.set('cache-control', headers['cache-control']);
    return response;
  }
}
