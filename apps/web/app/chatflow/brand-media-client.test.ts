import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiErrorSchema, brandMediaModule } from '@allrice/contracts';
import { createBrandMediaClient } from './brand-media/frontend-wiring';

const id = (n: number) =>
  `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = {
  organizationId: id(1),
  workspaceId: id(2),
  ownerId: id(3),
  instanceId: id(4),
  headers: { 'x-allrice-workspace-id': id(2) },
};
const pin = {
  origin: 'reference' as const,
  sourceId: id(5),
  revisionId: id(6),
};
const checksum = 'sha256:' + 'a'.repeat(64);
const receipt = () => ({
  viewerId: scope.ownerId,
  workspaceId: scope.workspaceId,
  selection: {
    sourceId: pin.sourceId,
    revisionId: pin.revisionId,
    revision: 3,
    fileName: '已固定的品牌资料.pdf',
    purpose: '',
    digest: checksum,
    checksum,
    ownership: { scope: 'company', organizationId: scope.organizationId },
  },
});

describe('brand-media scoped access', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  const denied = (
    status = 403,
    code: 'AUTHORIZATION_DENIED' | 'VERSION_CONFLICT' = 'AUTHORIZATION_DENIED',
  ) =>
    Response.json(
      ApiErrorSchema.parse({
        error: {
          code,
          message: '当前品牌请求被拒绝',
          requestId: id(11),
          retryable: false,
        },
      }),
      { status },
    );
  const catalog = (enabled: boolean) =>
    Response.json({
      modules: [
        {
          descriptor: brandMediaModule,
          binding: null,
          available: false,
          enabled,
        },
      ],
    });
  function panelClient() {
    const lifetime = new AbortController();
    const revoke = vi.fn((error: Error) => lifetime.abort(error));
    const hide = vi.fn();
    const reveal = vi.fn();
    return {
      client: createBrandMediaClient(scope).forPanel({
        signal: lifetime.signal,
        hide,
        reveal,
        revoke,
      }),
      hide,
      reveal,
      revoke,
    };
  }

  it('fences an already requested body on the module-only denial without waiting for another read', async () => {
    const late = deferred<Response>();
    const fetch = vi.fn((url: string) =>
      url.includes('/download') ? late.promise : Promise.resolve(denied()),
    );
    vi.stubGlobal('fetch', fetch);
    const { client, hide, revoke } = panelClient();
    // This simulated byte source returns a late response despite cancellation.
    const body = client.body({ objectId: id(7), versionId: id(8), checksum });
    const refused = expect(body).rejects.toThrow('当前品牌请求被拒绝');
    await expect(client.help()).rejects.toThrow('当前品牌请求被拒绝');
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(hide).not.toHaveBeenCalled();
    late.resolve(new Response('迟到的私有正文'));
    await refused;
    await expect(client.read({ view: 'topics' })).rejects.toThrow(
      '当前品牌请求被拒绝',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['disabled', 'enabled', 'unknown'] as const)(
    'joins one scoped catalog check for concurrent branded record denials (%s)',
    async (outcome) => {
      const check = deferred<Response>();
      const hidden = deferred<void>();
      const fetch = vi.fn((url: string) => {
        if (url.includes('/modules')) return check.promise;
        return Promise.resolve(denied());
      });
      vi.stubGlobal('fetch', fetch);
      const { client, hide, reveal, revoke } = panelClient();
      const discard = vi.fn();
      hide.mockImplementation(() => {
        if (hide.mock.calls.length === 2) hidden.resolve();
      });
      const current = expect(
        client.read({ view: 'articles' }, undefined, discard),
      ).rejects.toThrow('当前品牌请求被拒绝');
      const other = expect(
        client.read({ view: 'topics' }, undefined, discard),
      ).rejects.toThrow('当前品牌请求被拒绝');
      await hidden.promise;
      expect(discard).toHaveBeenCalledTimes(2);
      expect(hide).toHaveBeenCalled();
      expect(reveal).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      check.resolve(
        outcome === 'unknown'
          ? Response.json({ message: '目录暂不可用' }, { status: 503 })
          : catalog(outcome === 'enabled'),
      );
      await Promise.all([current, other]);
      expect(
        fetch.mock.calls.filter(([url]) => url.includes('/modules')),
      ).toHaveLength(1);
      expect(revoke).toHaveBeenCalledTimes(outcome === 'disabled' ? 1 : 0);
      expect(reveal.mock.calls.length > 0).toBe(outcome === 'enabled');
    },
  );

  it.each([
    [403, 'AUTHORIZATION_DENIED'],
    [409, 'VERSION_CONFLICT'],
  ] as const)(
    'masks the panel on a typed %i from a write even when its catalog is down',
    async (status, code) => {
      const check = deferred<Response>();
      const catalogRequested = deferred<void>();
      const fetch = vi.fn((url: string) => {
        if (url.includes('/modules')) {
          catalogRequested.resolve();
          return check.promise;
        }
        return Promise.resolve(denied(status, code));
      });
      vi.stubGlobal('fetch', fetch);
      const { client, hide, reveal, revoke } = panelClient();
      const command = expect(
        client.command({
          operation: 'article.publication',
          articleId: id(20),
          requestId: id(21),
          expectedRevision: 1,
          change: { action: 'unschedule' },
        }),
      ).rejects.toThrow('当前品牌请求被拒绝');
      await catalogRequested.promise;
      expect(hide).toHaveBeenCalledOnce();
      check.resolve(
        Response.json({ message: '目录暂不可用' }, { status: 503 }),
      );
      await command;
      expect(reveal).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    },
  );

  it('ignores an older in-flight enabled catalog after a later write refusal', async () => {
    const old = deferred<Response>();
    const fresh = deferred<Response>();
    const oldStarted = deferred<void>();
    const writeHidden = deferred<void>();
    let checks = 0;
    const fetch = vi.fn((url: string, options?: RequestInit) => {
      if (!url.includes('/modules'))
        return Promise.resolve(
          options?.method === 'POST'
            ? denied(409, 'VERSION_CONFLICT')
            : denied(),
        );
      if (++checks !== 1) return fresh.promise;
      oldStarted.resolve();
      return old.promise;
    });
    vi.stubGlobal('fetch', fetch);
    const { client, hide, reveal, revoke } = panelClient();
    hide.mockImplementation(() => {
      if (hide.mock.calls.length === 2) writeHidden.resolve();
    });
    const reading = expect(client.read({ view: 'topics' })).rejects.toThrow(
      '当前品牌请求被拒绝',
    );
    await oldStarted.promise;
    const writing = expect(
      client.command({
        operation: 'article.publication',
        articleId: id(20),
        requestId: id(21),
        expectedRevision: 1,
        change: { action: 'unschedule' },
      }),
    ).rejects.toThrow('当前品牌请求被拒绝');
    await writeHidden.promise;
    old.resolve(catalog(true));
    await reading;
    try {
      expect(checks).toBe(2);
      expect(reveal).not.toHaveBeenCalled();
    } finally {
      fresh.resolve(
        Response.json({ message: '最新目录暂不可用' }, { status: 503 }),
      );
      await writing;
    }
    expect(revoke).not.toHaveBeenCalled();
  });

  it('keeps direct reference refusals and an offline brand read local to each operation', async () => {
    const fetch = vi.fn((url: string) =>
      url.includes('/references/')
        ? Promise.resolve(denied())
        : Promise.reject(new TypeError('Network connection unavailable')),
    );
    vi.stubGlobal('fetch', fetch);
    const { client, hide, reveal, revoke } = panelClient();
    await expect(client.referenceLabel(pin)).rejects.toThrow(
      '当前品牌请求被拒绝',
    );
    await expect(client.read({ view: 'topics' })).rejects.toThrow(
      'Network connection unavailable',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(hide).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('brand-media reference display metadata', () => {
  it('reads the exact frozen revision with the current scope and abort signal, without writing or choosing latest', async () => {
    const fetch = vi.fn(async () => Response.json(receipt()));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    expect(
      await createBrandMediaClient(scope).referenceLabel(pin, signal),
    ).toBe('已固定的品牌资料.pdf');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/references/revisions/${pin.revisionId}/selection?workspaceId=${scope.workspaceId}`,
      {
        headers: { 'Content-Type': 'application/json', ...scope.headers },
        cache: 'no-store',
        signal,
      },
    );
    expect(pin).toEqual({
      origin: 'reference',
      sourceId: id(5),
      revisionId: id(6),
    });
  });

  it.each(['viewer', 'workspace', 'source', 'revision'] as const)(
    'refuses a filename from a mismatched %s receipt',
    async (field) => {
      const wrong = receipt();
      if (field === 'viewer') wrong.viewerId = id(99);
      if (field === 'workspace') wrong.workspaceId = id(99);
      if (field === 'source') wrong.selection.sourceId = id(99);
      if (field === 'revision') wrong.selection.revisionId = id(99);
      const fetch = vi.fn(async () => Response.json(wrong));
      vi.stubGlobal('fetch', fetch);
      await expect(
        createBrandMediaClient(scope).referenceLabel(pin),
      ).rejects.toThrow('资料版本或当前权限已变化');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves an authorization failure instead of searching for a substitute revision', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ message: '无权读取资料' }, { status: 403 }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      createBrandMediaClient(scope).referenceLabel(pin),
    ).rejects.toThrow('无权读取资料');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
