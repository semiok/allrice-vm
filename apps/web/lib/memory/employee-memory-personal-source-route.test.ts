import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const ports = vi.hoisted(() => ({
  context: vi.fn(),
  read: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../identity/session', () => ({
  requireRequestContext: ports.context,
}));
vi.mock('./employee-memory-personal-source', () => ({
  readPersonalEmployeeMemorySource: ports.read,
}));
vi.mock('../storage/responses', () => ({ storageErrorResponse: ports.error }));
import { GET } from '../../app/api/v1/memories/[id]/source/route';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = { workspaceId: id(1), instanceId: id(2), memoryId: id(3) };
const context = { actor: { type: 'user', id: id(4) } };
const source = {
  sourceType: 'message',
  sourceLabel: '模型提取候选',
  capturedAt: '2026-11-20T17:34:00.000Z',
};
const url = `https://allrice.test/api/v1/memories/${target.memoryId}/source?workspaceId=${target.workspaceId}&instanceId=${target.instanceId}`;
const route = (id = target.memoryId) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  ports.context.mockResolvedValue(context);
  ports.read.mockResolvedValue(source);
  ports.error.mockImplementation((cause) =>
    Response.json(
      { error: 'closed' },
      { status: cause instanceof z.ZodError ? 400 : (cause.status ?? 500) },
    ),
  );
});

describe('personal source HTTP adapter', () => {
  it('passes the original request identity, exact selector and cancellation to the personal owner', async () => {
    const request = new Request(url);
    const response = await GET(request, route());
    expect(ports.context).toHaveBeenCalledExactlyOnceWith(request);
    expect(ports.read).toHaveBeenCalledExactlyOnceWith(
      context,
      target,
      request.signal,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(source);
  });

  it.each([
    'ownerId',
    'organizationId',
    'memoryId',
    'workspaceId',
    'instanceId',
  ])('rejects extra or repeated %s query keys', async (key) => {
    const response = await GET(new Request(`${url}&${key}=${id(5)}`), route());
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(ports.read).not.toHaveBeenCalled();
  });

  it('rejects a malformed path ID before reading and refuses output outside the three-field projection', async () => {
    expect((await GET(new Request(url), route('bad'))).status).toBe(400);
    expect(ports.read).not.toHaveBeenCalled();
    ports.read.mockResolvedValueOnce({ ...source, rawMessage: 'private' });
    const response = await GET(new Request(url), route());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'closed' });
  });

  it('suppresses a late source after request cancellation', async () => {
    let complete!: (value: typeof source) => void;
    ports.read.mockImplementationOnce(
      () =>
        new Promise<typeof source>((resolve) => {
          complete = resolve;
        }),
    );
    const controller = new AbortController();
    const request = new Request(url, { signal: controller.signal });
    const pending = GET(request, route());
    await vi.waitFor(() =>
      expect(ports.read).toHaveBeenCalledExactlyOnceWith(
        context,
        target,
        request.signal,
      ),
    );
    controller.abort();
    complete(source);
    const response = await pending;
    expect(ports.error).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AbortError' }),
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ error: 'closed' });
  });
});
