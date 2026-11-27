import {
  DEntryNativeRpcRequestSchema,
  DEntryPageRpcRequestSchema,
  decodeDEntryRegisteredThread,
  dEntryRegisteredThreadHeader,
} from '@allrice/contracts';
import { apiProblem } from '../../../../../lib/api-error-response';
import {
  authenticateNativeRequest,
  currentNativeRequest,
} from '../../../../../lib/d-entry/native-request';
import { requestDEntryWorker } from '../../../../../lib/d-entry/native-worker';
import { dEntryErrorResponse } from '../../../../../lib/d-entry/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const context = await authenticateNativeRequest(request);
    const { searchParams } = new URL(request.url);
    const page = searchParams.has('carrier');
    if (
      page &&
      (searchParams.size !== 1 || searchParams.get('carrier') !== 'page')
    )
      return apiProblem({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'Invalid page carrier',
      });
    const { selection, ...fields } = (
      page ? DEntryPageRpcRequestSchema : DEntryNativeRpcRequestSchema
    ).parse(await request.json());
    const input = await currentNativeRequest(
      request,
      selection,
      context,
      page ? 'history' : 'execute',
    );
    const response = await requestDEntryWorker(
      input,
      page ? 'native-rpc?carrier=page' : 'native-rpc',
      fields,
    );
    const registeredThread = response.headers.get(dEntryRegisteredThreadHeader);
    const registered =
      page &&
      response.ok &&
      ['session/create', 'session/fork'].includes(fields.endpoint) &&
      registeredThread &&
      decodeDEntryRegisteredThread(registeredThread);
    return new Response(response.body, {
      status: response.status,
      headers: {
        'content-type':
          response.headers.get('content-type') ?? 'application/json',
        'cache-control': 'private, no-store',
        ...(registered && {
          [dEntryRegisteredThreadHeader]: registeredThread,
        }),
      },
    });
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
