import {
  DataAccessError,
  correctManagedEmployeeMemory,
  deleteManagedEmployeeMemory,
} from '@allrice/database';
import {
  EmployeeMemoryListQuerySchema,
  EmployeeMemoryWriteResponseSchema,
  MemoryDetailQueryProjectionSchema,
} from '@allrice/contracts';

import { getRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { storageErrorResponse } from '../../../../../lib/storage/responses';
import {
  personalEmployeeMemory,
  requireEmployeeMemoryModule,
} from '../../../../../lib/memory/employee-memory-personal-source';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const query = EmployeeMemoryListQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const result = await personalEmployeeMemory.detail(
      context,
      MemoryDetailQueryProjectionSchema.parse({
        ...query,
        memoryId: (await route.params).id,
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

export async function PATCH(
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
    const input = await request.json();
    await requireEmployeeMemoryModule(request.signal);
    const { counts, ...memory } = await correctManagedEmployeeMemory(
      context,
      workspaceId,
      id,
      input,
    );
    return Response.json(
      EmployeeMemoryWriteResponseSchema.parse({
        schemaVersion: 2,
        memory,
        counts,
      }),
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    const response = storageErrorResponse(error);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  }
}

export async function DELETE(
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
    const body = await request.text();
    await requireEmployeeMemoryModule(request.signal);
    await deleteManagedEmployeeMemory(
      context,
      workspaceId,
      id,
      body ? JSON.parse(body) : undefined,
    );
    return new Response(null, {
      status: 204,
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    const response = storageErrorResponse(error);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  }
}
