import {
  DEntrySelectionInputSchema,
  DEntrySessionChangeSchema,
  DEntrySessionChangeResultSchema,
  UuidSchema,
} from '@allrice/contracts';
import {
  DataAccessError,
  SessionActiveError,
  SessionReferenceError,
  getChatSessionHistory,
  updateChatSession,
} from '@allrice/database';

import { getRequestContext } from '../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../lib/storage/responses';
import {
  authenticateNativeRequest,
  currentNativeRequest,
} from '../../../../../lib/d-entry/native-request';
import { requestDEntryWorker } from '../../../../../lib/d-entry/native-worker';
import { dEntryErrorResponse } from '../../../../../lib/d-entry/responses';

export const runtime = 'nodejs';

function workspaceId(request: Request) {
  const id = new URL(request.url).searchParams.get('workspaceId');
  if (!id) throw new DataAccessError('not_found');
  return id;
}

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    return Response.json({
      history: await getChatSessionHistory(context, workspaceId(request), id),
    });
  } catch (error) {
    if (error instanceof SessionReferenceError)
      return Response.json(
        { error: { message: error.message } },
        { status: 400 },
      );
    return storageErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const query = new URL(request.url).searchParams;
  const entry = query.getAll('entry');
  if (entry.length) {
    try {
      const context = await authenticateNativeRequest(request);
      const expected = request.headers.get('x-allrice-expected-viewer-id');
      if (expected && expected !== context.actor.id)
        throw new DataAccessError('authorization_denied');
      if (
        entry.length !== 1 ||
        entry[0] !== '4.0' ||
        query.getAll('workspaceId').length !== 1 ||
        query.getAll('employeeInstanceId').length !== 1
      )
        throw new SyntaxError('Invalid session entry');
      const selection = DEntrySelectionInputSchema.extend({
        threadId: UuidSchema,
      }).parse({
        workspaceId: workspaceId(request),
        employeeInstanceId: query.get('employeeInstanceId'),
        threadId: (await route.params).id,
      });
      const change = DEntrySessionChangeSchema.parse(await request.json());
      const current = await currentNativeRequest(
        request,
        selection,
        context,
        'history',
      );
      const response = await requestDEntryWorker(current, 'session-change', {
        change,
      });
      const result = DEntrySessionChangeResultSchema.parse(
        await response.json(),
      );
      request.signal.throwIfAborted();
      const options = { headers: { 'cache-control': 'private, no-store' } };
      if (result.state === 'active')
        return Response.json(
          {
            error: {
              code: 'SESSION_ACTIVE',
              message: '会话还有工作正在进行。',
              activity: result.activity,
            },
          },
          { ...options, status: 409 },
        );
      if (result.state === 'employee_archived')
        return Response.json(
          {
            error: {
              code: 'EMPLOYEE_INSTANCE_ARCHIVED',
              message: '请先恢复这位员工，再恢复会话。',
            },
          },
          { ...options, status: 409 },
        );
      const { session } = result;
      if (
        session.id !== selection.threadId ||
        session.employeeInstanceId !== selection.employeeInstanceId ||
        session.ownerId !== context.actor.id ||
        session.workspaceId !== selection.workspaceId ||
        session.organizationId !== context.organizationId
      )
        throw new DataAccessError('authorization_denied');
      if (
        'archived' in change &&
        Boolean(session.archivedAt) !== change.archived
      )
        return Response.json(
          {
            error: {
              code: 'CONFLICT',
              message: '会话归档状态已变化，请刷新后重试。',
            },
          },
          { ...options, status: 409 },
        );
      return Response.json({ session }, options);
    } catch (error) {
      return dEntryErrorResponse(error);
    }
  }
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    const session = await updateChatSession(
      context,
      workspaceId(request),
      id,
      await request.json(),
    );
    return Response.json({ session });
  } catch (error) {
    if (error instanceof SessionActiveError) {
      return Response.json(
        {
          error: {
            code: 'SESSION_ACTIVE',
            message: error.message,
            activity: error.activity,
          },
        },
        { status: 409 },
      );
    }
    if (error instanceof SessionReferenceError)
      return Response.json(
        { error: { message: error.message } },
        { status: 400 },
      );
    return storageErrorResponse(error);
  }
}
