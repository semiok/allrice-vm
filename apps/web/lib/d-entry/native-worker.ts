import {
  ApiErrorSchema,
  type DEntrySelectionInput,
  type RequestContext,
} from '@allrice/contracts';
import { DEntryDependencyUnavailable } from './release-policy';

const prewarmHttpTimeoutMs = 15_000;

type WorkerRequest = {
  token: string;
  context: RequestContext;
  selection: DEntrySelectionInput;
  signal: AbortSignal;
};

export class DEntryWorkerProblem extends Error {
  constructor(
    readonly status: number,
    readonly problem: ReturnType<typeof ApiErrorSchema.parse>,
  ) {
    super('The selected entry is not available');
  }
}

/** Original login Bearer only to the fixed existing Worker deployment address.
 * Never forwards a browser URL, Cookie, supplied identity or redirect. */
export async function requestDEntryWorker(
  input: WorkerRequest,
  path:
    | 'native-owner'
    | 'native-resource'
    | 'native-rpc'
    | 'native-rpc?carrier=page'
    | 'native-root'
    | 'native-prewarm',
  fields: Record<string, unknown> = {},
) {
  input.signal.throwIfAborted();
  const prewarm = path === 'native-prewarm';
  const response = await requestWorker(
    input.signal,
    new URL(`/internal/d-entry/${path}`, workerBase()),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify({
        ...fields,
        organizationId: input.context.organizationId,
        selection: input.selection,
      }),
    },
    { short: prewarm, allowExpired: prewarm },
  );
  return response;
}

export function requestDEntryPrewarmStatus(
  input: WorkerRequest,
  operationId: string,
  method: 'GET' | 'DELETE' = 'GET',
) {
  const target = new URL(
    '/internal/d-entry/native-prewarm/status',
    workerBase(),
  );
  target.search = new URLSearchParams({
    ...input.selection,
    organizationId: input.context.organizationId,
    operationId,
  }).toString();
  return requestWorker(
    input.signal,
    target,
    { method, headers: { authorization: `Bearer ${input.token}` } },
    { short: true, allowExpired: true },
  );
}

function workerBase() {
  let base: URL;
  try {
    base = new URL(
      process.env.ALLRICE_WORKER_INTERNAL_URL?.trim() ||
        `http://127.0.0.1:${process.env.ALLRICE_WORKER_PORT ?? '3101'}`,
    );
  } catch (error) {
    throw new DEntryDependencyUnavailable('native-route', { cause: error });
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new DEntryDependencyUnavailable('native-route');
  return base;
}

export function requestDEntryProfile(
  input: {
    token: string;
    context: RequestContext;
    selection: DEntrySelectionInput;
    signal: AbortSignal;
  },
  type: 'bootstrap' | 'assets' | 'events' | 'switch',
  selectors: Record<string, string>,
  request?: 'document' | 'static',
) {
  input.signal.throwIfAborted();
  const target = new URL(`/internal/d-entry/profile/${type}`, workerBase());
  target.search = new URLSearchParams({
    ...selectors,
    ...input.selection,
    organizationId: input.context.organizationId,
  }).toString();
  return requestWorker(input.signal, target, {
    method: type === 'switch' ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${input.token}`,
      ...(request && { 'x-allrice-profile-request': request }),
    },
  });
}

async function requestWorker(
  signal: AbortSignal,
  url: URL,
  init: RequestInit,
  options: { short?: boolean; allowExpired?: boolean } = {},
) {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    cache: 'no-store',
    signal: options.short
      ? AbortSignal.any([signal, AbortSignal.timeout(prewarmHttpTimeoutMs)])
      : signal,
  }).catch((error) => {
    signal.throwIfAborted();
    throw new DEntryDependencyUnavailable('native-route', { cause: error });
  });
  if (!response.ok && !(options.allowExpired && response.status === 410)) {
    let problem: unknown;
    try {
      problem = await response.json();
    } catch (error) {
      throw new DEntryDependencyUnavailable('native-route', { cause: error });
    }
    const parsed = ApiErrorSchema.safeParse(problem);
    if (parsed.success)
      throw new DEntryWorkerProblem(response.status, parsed.data);
    throw new DEntryDependencyUnavailable('native-route');
  }
  return response;
}

export async function readDEntryWorkerJson<T>(
  response: Response,
  parse: (value: unknown) => T,
): Promise<T> {
  try {
    return parse(await response.json());
  } catch (error) {
    throw new DEntryDependencyUnavailable('native-route', { cause: error });
  }
}
