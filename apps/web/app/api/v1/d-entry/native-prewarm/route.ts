import {
  dEntryWarmIdentityHeader,
  DEntryNativePrewarmAcceptedSchema,
  DEntryNativePrewarmInputSchema,
  DEntryNativePrewarmResultSchema,
  DEntryNativePrewarmStatusSchema,
  sameDEntryIdentity,
} from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import {
  authenticateNativeRequest,
  currentNativeRequest,
} from '../../../../../lib/d-entry/native-request';
import {
  requestDEntryWorker,
  readDEntryWorkerJson,
} from '../../../../../lib/d-entry/native-worker';
import { DEntryDependencyUnavailable } from '../../../../../lib/d-entry/release-policy';
import { dEntryErrorResponse } from '../../../../../lib/d-entry/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Best effort page/first-input prewarm; no prompt or readiness capability. */
export async function POST(request: Request) {
  try {
    const context = await authenticateNativeRequest(request);
    const { selection, trigger } = DEntryNativePrewarmInputSchema.parse(
      await request.json(),
    );
    const input = await currentNativeRequest(request, selection, context);
    const response = await requestDEntryWorker(input, 'native-prewarm', {
      trigger,
    });
    if (response.status === 410) {
      const result = await readDEntryWorkerJson(
        response,
        DEntryNativePrewarmStatusSchema.parse,
      );
      if (result.state !== 'expired')
        throw new DEntryDependencyUnavailable('native-route');
      return Response.json(result, {
        status: 410,
        headers: { 'cache-control': 'private, no-store' },
      });
    }
    if (response.status !== 202 && response.status !== 200)
      throw new DEntryDependencyUnavailable('native-route');
    const result = await readDEntryWorkerJson(response, (value) =>
      response.status === 202
        ? DEntryNativePrewarmAcceptedSchema.parse(value)
        : DEntryNativePrewarmResultSchema.parse(value),
    );
    if (
      !sameDEntryIdentity(input.identity, result.identity) ||
      result.trigger !== trigger
    )
      throw new DataAccessError('authorization_denied');
    if ('ticket' in result)
      return Response.json(result.ticket, {
        status: 202,
        headers: { 'cache-control': 'private, no-store' },
      });
    return new Response(null, {
      status: 204,
      headers: {
        'cache-control': 'private, no-store',
        [dEntryWarmIdentityHeader]: JSON.stringify({
          identity: result.identity,
        }),
      },
    });
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
