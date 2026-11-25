import {
  DEntrySelectionInputSchema,
  UuidSchema,
  type DEntrySelectionInput,
} from '@allrice/contracts';

export class EmployeeEntryError extends Error {
  constructor(readonly status: number) {
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

export async function prewarmEmployeeEntry(
  selection: DEntrySelectionInput,
  signal: AbortSignal,
) {
  const warm = await postEmployeeEntry(
    '/api/v1/d-entry/native-prewarm',
    { selection, trigger: 'page' },
    signal,
  );
  signal.throwIfAborted();
  if (warm.status !== 204) throw new EmployeeEntryError(warm.status);
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
    throw new EmployeeEntryError(403);
  return next;
}
