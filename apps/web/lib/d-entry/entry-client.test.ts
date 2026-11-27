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
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('polls one ticket at 1, 2, then 3 seconds and can open after 125 seconds without another POST', async () => {
  vi.useFakeTimers();
  const input = employeeEntryQuery(query + '&threadId=' + randomUUID(), true);
  const operationId = randomUUID();
  const pollTimes: number[] = [];
  const start = Date.now();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_path, options) => {
    if (options?.method === 'POST')
      return Response.json(
        {
          operationId,
          expiresAt: new Date(start + 600_000).toISOString(),
          pollAfterMs: 1000,
        },
        { status: 202 },
      );
    pollTimes.push(Date.now() - start);
    return Response.json({
      state: Date.now() - start >= 126_000 ? 'ready' : 'starting',
    });
  });
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  const progress = vi.fn();
  const opening = vi.fn();
  const work = prepareEmployeeEntry(
    input,
    signal,
    opening,
    prewarmEmployeeEntry(input.selection, signal, { progress }),
  );
  await vi.advanceTimersByTimeAsync(125_000);
  expect(opening).not.toHaveBeenCalled();
  expect(pollTimes.slice(0, 4)).toEqual([1000, 3000, 6000, 9000]);
  expect(progress).toHaveBeenNthCalledWith(1, 'accepted');
  expect(progress).toHaveBeenNthCalledWith(2, 'starting');
  await vi.advanceTimersByTimeAsync(1000);
  await expect(work).resolves.toEqual(input.selection);
  expect(opening).toHaveBeenCalledOnce();
  expect(
    fetch.mock.calls.filter(([, options]) => options?.method === 'POST'),
  ).toHaveLength(1);
});

it('never restarts an expired ticket or polls after the browser abandons its wait', async () => {
  vi.useFakeTimers();
  const reply = () =>
    Response.json(
      {
        operationId: randomUUID(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        pollAfterMs: 1000,
      },
      { status: 202 },
    );
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(reply())
    .mockResolvedValueOnce(Response.json({ state: 'expired' }, { status: 410 }))
    .mockResolvedValueOnce(reply());
  vi.stubGlobal('fetch', fetch);
  const expired = expect(
    prewarmEmployeeEntry(selection, new AbortController().signal),
  ).rejects.toMatchObject({ status: 410 });
  await vi.advanceTimersByTimeAsync(1000);
  await expired;
  expect(fetch).toHaveBeenCalledTimes(2);
  const controller = new AbortController();
  const abandoned = expect(
    prewarmEmployeeEntry(selection, controller.signal),
  ).rejects.toBeInstanceOf(Error);
  await vi.advanceTimersByTimeAsync(10);
  controller.abort();
  await vi.advanceTimersByTimeAsync(12_000);
  await abandoned;
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([
  'deadline',
  'gateway',
  'network',
  'truncated status',
  'schema mismatch',
  'rate limit',
])(
  'resumes a paused wait with the original ticket after %s',
  async (reason) => {
    vi.useFakeTimers();
    const ticket = {
      operationId: randomUUID(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      pollAfterMs: 1000,
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>(async () => {
        if (reason === 'network') throw new TypeError('Failed to fetch');
        if (reason === 'truncated status') return new Response('{');
        if (reason === 'schema mismatch') return Response.json({});
        if (reason === 'rate limit') return new Response(null, { status: 429 });
        return reason === 'gateway'
          ? new Response(null, { status: 503 })
          : Response.json({ state: 'starting' });
      })
      .mockResolvedValueOnce(Response.json(ticket, { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    const paused = expect(
      prewarmEmployeeEntry(selection, new AbortController().signal),
    ).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(reason === 'deadline' ? 300_000 : 1000);
    await paused;
    fetch.mockClear().mockResolvedValueOnce(Response.json({ state: 'ready' }));
    const done = prewarmEmployeeEntry(selection, new AbortController().signal, {
      ticket,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/d-entry/native-prewarm/status?' +
        new URLSearchParams({ ...selection, operationId: ticket.operationId }),
      expect.objectContaining({ method: 'GET' }),
    );
  },
);

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
  ).rejects.toMatchObject({ status: 403, reason: 'response-mismatch' });
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
    let respond!: (response: Response) => void;
    const promise = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    const fetch = vi.fn(() => promise);
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const opening = vi.fn();
    const background = prewarmEmployeeEntry(input.selection, signal);
    const entry = prepareEmployeeEntry(input, signal, opening, background);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(opening).not.toHaveBeenCalled();
    respond(new Response(null, { status }));
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
