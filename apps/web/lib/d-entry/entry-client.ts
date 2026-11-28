import {
  DEntryIdentityResultSchema,
  DEntryNativePrewarmStatusSchema,
  DEntryNativePrewarmTicketSchema,
  type DEntryNativePrewarmTicket,
  DEntrySelectionInputSchema,
  UuidSchema,
  type DEntrySelectionInput,
  type DEntryNativePrewarmTrigger,
} from '@allrice/contracts';

export class EmployeeEntryError extends Error {
  constructor(
    readonly status: number,
    public readonly reason?: 'response-mismatch' | 'UPGRADE_OPEN_REQUIRED',
  ) {
    super('Employee entry is unavailable');
  }
}

export function employeeEntryQuery(query: string, prepare: boolean) {
  const params = new URLSearchParams(query);
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
    throw new EmployeeEntryError(400);
  const rawOperation = prepare ? params.get('new') : null;
  if (rawOperation !== null) params.delete('new');
  const selection = DEntrySelectionInputSchema.safeParse(
    Object.fromEntries(params),
  );
  const operation = UuidSchema.optional().safeParse(rawOperation ?? undefined);
  if (
    !selection.success ||
    !operation.success ||
    (operation.data && selection.data.threadId)
  )
    throw new EmployeeEntryError(400);
  return { params, selection: selection.data, operationId: operation.data };
}

export async function readEmployeeEntryIdentity(
  selection: DEntrySelectionInput,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const response = await fetch(
    '/api/v1/d-entry/identity?' + new URLSearchParams(selection),
    { signal, cache: 'no-store', credentials: 'same-origin' },
  );
  if (!response.ok) throw new EmployeeEntryError(response.status);
  const { identity } = DEntryIdentityResultSchema.parse(await response.json());
  signal.throwIfAborted();
  if (
    identity.workspaceId !== selection.workspaceId ||
    identity.employeeInstanceId !== selection.employeeInstanceId ||
    identity.threadId !== (selection.threadId ?? null)
  )
    throw new EmployeeEntryError(403, 'response-mismatch');
  return identity;
}

function postEmployeeEntry(path: string, data: object, signal: AbortSignal) {
  signal.throwIfAborted();
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
  });
}

export type EmployeePrewarmProgress = 'accepted' | 'starting' | 'restarting';
const prewarmRequestMs = 20_000;
const prewarmWaitMs = 5 * 60_000;

function prewarmStatusPath(
  selection: DEntrySelectionInput,
  operationId: string,
) {
  return (
    '/api/v1/d-entry/native-prewarm/status?' +
    new URLSearchParams({ ...selection, operationId })
  );
}

/** A cancellation applies only while this exact ticket is waiting for capacity. */
export async function cancelEmployeeCapacityWait(
  selection: DEntrySelectionInput,
  ticket: DEntryNativePrewarmTicket,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const response = await fetch(
    prewarmStatusPath(selection, ticket.operationId),
    {
      method: 'DELETE',
      signal: AbortSignal.any([signal, AbortSignal.timeout(prewarmRequestMs)]),
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    },
  );
  signal.throwIfAborted();
  if (response.status !== 200 && response.status !== 410)
    throw new EmployeeEntryError(response.status);
  const status = DEntryNativePrewarmStatusSchema.parse(await response.json());
  signal.throwIfAborted();
  if ((status.state === 'expired') !== (response.status === 410))
    throw new EmployeeEntryError(502, 'response-mismatch');
  return status.state === 'expired';
}

function waitForPrewarmPoll(delay: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, delay);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export async function prewarmEmployeeEntry(
  selection: DEntrySelectionInput,
  signal: AbortSignal,
  options: {
    ticket?: DEntryNativePrewarmTicket;
    trigger?: DEntryNativePrewarmTrigger;
    accepted?(ticket: DEntryNativePrewarmTicket): void;
    progress?(state: EmployeePrewarmProgress, activeLimit?: number): void;
  } = {},
) {
  let ticket = options.ticket;
  if (!ticket) {
    const warm = await postEmployeeEntry(
      '/api/v1/d-entry/native-prewarm',
      { selection, trigger: options.trigger ?? 'page' },
      AbortSignal.any([signal, AbortSignal.timeout(prewarmRequestMs)]),
    );
    signal.throwIfAborted();
    if (warm.status === 204) return;
    if (warm.status !== 202) throw new EmployeeEntryError(warm.status);
    ticket = DEntryNativePrewarmTicketSchema.parse(await warm.json());
  }
  signal.throwIfAborted();
  options.accepted?.(ticket);
  options.progress?.('accepted');
  const { operationId, pollAfterMs, expiresAt } = ticket;
  const statusPath = prewarmStatusPath(selection, operationId);
  const pause = new AbortController();
  // Give even a cached ticket near its deadline one short poll so the Worker,
  // rather than the browser clock, can report that it has expired.
  const budget = Math.min(
    prewarmWaitMs,
    Math.max(prewarmRequestMs, Date.parse(expiresAt) - Date.now()),
  );
  const timer = setTimeout(
    () => pause.abort(new EmployeeEntryError(408)),
    budget,
  );
  const wait = AbortSignal.any([signal, pause.signal]);
  try {
    for (let delay = pollAfterMs; ; delay = Math.min(3000, delay + 1000)) {
      await waitForPrewarmPoll(delay, wait);
      const request = AbortSignal.any([
        wait,
        AbortSignal.timeout(prewarmRequestMs),
      ]);
      const response = await fetch(statusPath, {
        method: 'GET',
        signal: request,
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
      }).catch((error: unknown) => {
        request.throwIfAborted();
        if (error instanceof TypeError) throw new EmployeeEntryError(408);
        throw error;
      });
      request.throwIfAborted();
      // A gateway outage says nothing about an already admitted operation.
      // Let an explicit retry resume the same ticket when polling is available.
      if (response.status === 429 || response.status >= 500)
        throw new EmployeeEntryError(408);
      if (response.status !== 200 && response.status !== 410)
        throw new EmployeeEntryError(response.status);
      const body = await response.json().catch((error: unknown) => {
        request.throwIfAborted();
        if (error instanceof TypeError || error instanceof SyntaxError)
          throw new EmployeeEntryError(408);
        throw error;
      });
      request.throwIfAborted();
      const parsed = DEntryNativePrewarmStatusSchema.safeParse(body);
      if (!parsed.success) throw new EmployeeEntryError(408);
      const status = parsed.data;
      if (response.status === 410 || status.state === 'expired')
        throw new EmployeeEntryError(410);
      if (status.state === 'failed' && status.code === 'UPGRADE_OPEN_REQUIRED')
        throw new EmployeeEntryError(409, status.code);
      if (status.state === 'failed')
        throw new EmployeeEntryError(
          status.code === 'AUTHORITY_REVOKED' ? 403 : 503,
        );
      if (status.state === 'ready') return;
      if (status.state === 'waiting_for_capacity')
        options.progress?.('starting', status.activeLimit);
      else options.progress?.(status.state);
    }
  } catch (error) {
    wait.throwIfAborted();
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new EmployeeEntryError(408);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function prepareEmployeeEntry(
  input: ReturnType<typeof employeeEntryQuery>,
  signal: AbortSignal,
  opening: () => void,
  prewarming?: Promise<void>,
) {
  const { selection, operationId } = input;
  await (prewarming ?? prewarmEmployeeEntry(selection, signal));
  signal.throwIfAborted();
  opening();
  if (selection.threadId) return selection;

  const response = await postEmployeeEntry(
    '/api/v1/sessions?entry=4.0',
    { selection, operationId },
    signal,
  );
  if (!response.ok) throw new EmployeeEntryError(response.status);
  const next: DEntrySelectionInput = DEntrySelectionInputSchema.parse(
    await response.json(),
  );
  signal.throwIfAborted();
  if (
    next.workspaceId !== selection.workspaceId ||
    next.employeeInstanceId !== selection.employeeInstanceId ||
    !next.threadId ||
    (operationId && operationId !== next.threadId)
  )
    throw new EmployeeEntryError(403, 'response-mismatch');
  return next;
}
