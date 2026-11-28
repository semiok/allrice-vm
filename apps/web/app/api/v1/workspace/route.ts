import { DEntrySelectionInputSchema } from '@allrice/contracts';
import {
  DataAccessError,
  getEmployeeWorkspace,
  getUserPreferences,
  readDEntryEmployeeDirectory,
} from '@allrice/database';

import { getRequestContext } from '../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../lib/storage/responses';
import { dEntryErrorResponse } from '../../../../lib/d-entry/responses';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  if (query.has('entry')) {
    try {
      if (
        query.get('entry') !== '4.0' ||
        [...query.keys()].some((key) => query.getAll(key).length !== 1)
      )
        throw new SyntaxError('Invalid entry selectors');
      query.delete('entry');
      const selection = DEntrySelectionInputSchema.parse(
        Object.fromEntries(query),
      );
      const context = await getRequestContext(request);
      if (!context) throw new DataAccessError('authentication_required');
      if (
        context.actor.type !== 'user' ||
        request.headers.get('x-allrice-expected-viewer-id') !== context.actor.id
      )
        throw new DataAccessError('authorization_denied');
      return Response.json(
        await readDEntryEmployeeDirectory(context, selection, request.signal),
        { headers: { 'cache-control': 'private, no-store' } },
      );
    } catch (error) {
      return dEntryErrorResponse(error);
    }
  }
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    const workspace = await getEmployeeWorkspace(
      context,
      workspaceId ?? undefined,
      new URL(request.url).searchParams.get('instanceId') ?? undefined,
    );
    return Response.json(
      {
        workspace: {
          ...workspace,
          canAdminister: workspace.canAdminister,
          viewerId: context.actor.type === 'user' ? context.actor.id : null,
          preferences:
            context.actor.type === 'user'
              ? await getUserPreferences(context)
              : undefined,
        },
      },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}
