import {
  DataAccessError,
  createChatSession,
  listChatSessions,
  readDEntrySessionArchivePage,
} from '@allrice/database';

import { getRequestContext } from '../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../lib/storage/responses';
import {
  dEntryThreadRequest,
  openDEntryThread,
} from '../../../../lib/d-entry/entry-threads';
import { authenticateNativeRequest } from '../../../../lib/d-entry/native-request';
import { dEntryErrorResponse } from '../../../../lib/d-entry/responses';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const query = new URL(request.url).searchParams;
    const workspaceId = query.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const entry = query.getAll('entry');
    if (entry.length) {
      const expected = request.headers.get('x-allrice-expected-viewer-id');
      if (expected && expected !== context.actor.id)
        throw new DataAccessError('authorization_denied');
      if (
        entry.length !== 1 ||
        entry[0] !== '4.0' ||
        query.has('employeeAssignmentId')
      )
        throw new DataAccessError('not_found');
      return Response.json(
        await readDEntrySessionArchivePage(context, workspaceId, {
          cursor: query.get('cursor') ?? undefined,
          employeeInstanceId: query.get('employeeInstanceId') ?? undefined,
          includeArchived: query.get('archived') === 'true',
          archivedOnly: query.get('archived') === 'only',
        }),
        { headers: { 'cache-control': 'private, no-store' } },
      );
    }
    return Response.json(
      await listChatSessions(context, workspaceId, {
        cursor: query.get('cursor') ?? undefined,
        employeeAssignmentId: query.get('employeeAssignmentId') ?? undefined,
        employeeInstanceId: query.get('employeeInstanceId') ?? undefined,
        includeEmployeeGroups:
          !query.has('employeeAssignmentId') &&
          !query.has('employeeInstanceId'),
        query: (query.get('q') ?? '').slice(0, 240),
        includeArchived: query.get('archived') === 'true',
        archivedOnly: query.get('archived') === 'only',
      }),
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const entry = new URL(request.url).searchParams.getAll('entry');
  if (entry.length) {
    try {
      const context = await authenticateNativeRequest(request);
      if (entry.length !== 1 || entry[0] !== '4.0')
        throw new SyntaxError('Invalid session entry');
      const input = dEntryThreadRequest.parse(await request.json());
      const selection = await openDEntryThread(context, input, request.signal);
      return Response.json(selection, {
        headers: { 'cache-control': 'private, no-store' },
      });
    } catch (error) {
      return dEntryErrorResponse(error);
    }
  }
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const session = await createChatSession(context, await request.json(), {
      freezeAccountCapabilities: true,
      requireLegacyBrowserWriter: true,
    });
    return Response.json({ session }, { status: 201 });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
