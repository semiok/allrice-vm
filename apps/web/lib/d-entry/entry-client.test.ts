import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { employeeEntryQuery, prepareEmployeeEntry } from './entry-client';

const selection = {
  workspaceId: randomUUID(),
  employeeInstanceId: randomUUID(),
};
const query = new URLSearchParams(selection).toString();
afterEach(() => vi.unstubAllGlobals());

it('keeps the New operation ID out of the prewarm selector and requires its exact reply', async () => {
  const id = randomUUID();
  const input = employeeEntryQuery(query + '&new=' + id, true);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(
      Response.json({ ...selection, threadId: randomUUID() }),
    );
  vi.stubGlobal('fetch', fetch);
  await expect(
    prepareEmployeeEntry(input, new AbortController().signal, () => {}),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    fetch.mock.calls.map(([path, options]) => [
      path,
      JSON.parse(String(options?.body)),
    ]),
  ).toEqual([
    ['/api/v1/d-entry/native-prewarm', { selection, trigger: 'page' }],
    ['/api/v1/sessions?entry=4.0', { selection, operationId: id }],
  ]);
  expect(() =>
    employeeEntryQuery(query + '&new=' + id + '&threadId=' + id, true),
  ).toThrow();
  expect(() =>
    employeeEntryQuery(query + '&workspaceId=' + selection.workspaceId, true),
  ).toThrow();
});

it('cannot dispatch creation after cancellation even if the HTTP prewarm resolves', async () => {
  const lifetime = new AbortController();
  const fetch = vi.fn(async () => {
    lifetime.abort();
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetch);
  const opening = vi.fn();
  await expect(
    prepareEmployeeEntry(
      employeeEntryQuery(query, true),
      lifetime.signal,
      opening,
    ),
  ).rejects.toBe(lifetime.signal.reason);
  expect(opening).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});
