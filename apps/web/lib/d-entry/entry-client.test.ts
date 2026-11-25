import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  employeeEntryQuery,
  prepareEmployeeEntry,
  prewarmEmployeeEntry,
} from './entry-client';

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

it.each([204, 403, 503])(
  'consumes the activation’s original prewarm response %i without posting again',
  async (status) => {
    const input = employeeEntryQuery(query + '&threadId=' + randomUUID(), true);
    const { promise, resolve } = Promise.withResolvers<Response>();
    const fetch = vi.fn(() => promise);
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const opening = vi.fn();
    const background = prewarmEmployeeEntry(input.selection, signal);
    const entry = prepareEmployeeEntry(input, signal, opening, background);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(opening).not.toHaveBeenCalled();
    resolve(new Response(null, { status }));
    if (status === 204) {
      await expect(entry).resolves.toEqual(input.selection);
      expect(opening).toHaveBeenCalledOnce();
    } else {
      await expect(entry).rejects.toMatchObject({ status });
      expect(opening).not.toHaveBeenCalled();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
