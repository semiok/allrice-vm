import { EmployeeMemoryListQuerySchema } from '@allrice/contracts';
import { requireRequestContext } from '../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../lib/storage/responses';
import { personalEmployeeMemory } from '../../../../../lib/memory/employee-memory-personal-source';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const context = await requireRequestContext(request);
    const query = EmployeeMemoryListQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const result = await personalEmployeeMemory.list(
      context,
      query,
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
