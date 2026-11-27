import {
  DEntryNativePrewarmStatusQuerySchema,
  DEntryNativePrewarmStatusSchema,
} from '@allrice/contracts';
import { requireRequestContext } from '../../../../../../lib/identity/session';
import { apiProblem } from '../../../../../../lib/api-error-response';
import { currentNativeRequest } from '../../../../../../lib/d-entry/native-request';
import {
  readDEntryWorkerJson,
  requestDEntryPrewarmStatus,
} from '../../../../../../lib/d-entry/native-worker';
import { DEntryDependencyUnavailable } from '../../../../../../lib/d-entry/release-policy';
import { dEntryErrorResponse } from '../../../../../../lib/d-entry/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const context = await requireRequestContext(request);
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some((key) => query.getAll(key).length !== 1))
      return apiProblem({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'Entry selectors must be unique',
      });
    const { operationId, ...selection } =
      DEntryNativePrewarmStatusQuerySchema.parse(Object.fromEntries(query));
    const input = await currentNativeRequest(request, selection, context);
    const response = await requestDEntryPrewarmStatus(input, operationId);
    const result = await readDEntryWorkerJson(
      response,
      DEntryNativePrewarmStatusSchema.parse,
    );
    if (response.status !== (result.state === 'expired' ? 410 : 200))
      throw new DEntryDependencyUnavailable('native-route');
    return Response.json(result, {
      status: response.status,
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
