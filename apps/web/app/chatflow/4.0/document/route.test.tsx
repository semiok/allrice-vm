import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GET } from './route';
import {
  GET as documentAsset,
  POST as documentUpload,
} from './[...publicationPath]/route';
import EntryPage from '../page';
import { DataAccessError } from '@allrice/database';

const authenticated = vi.hoisted(() => vi.fn());
const historyIdentity = vi.hoisted(() => vi.fn());
const profileRequest = vi.hoisted(() => vi.fn());
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => ({ value: 'unit-test-original-session-cookie' }),
  }),
}));
vi.mock('../../../../lib/d-entry/native-worker', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../../lib/d-entry/native-worker')
  >()),
  requestDEntryProfile: profileRequest,
}));
vi.mock('../../../../lib/identity/session', () => ({
  requireRequestContext: authenticated,
}));
vi.mock('../../../../lib/d-entry/identity', () => ({
  resolveDEntryIdentity: historyIdentity,
}));

const selection = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  employeeInstanceId: '00000000-0000-4000-8000-000000000002',
};
const query = new URLSearchParams(selection).toString();
const request = (suffix = query) =>
  new Request(`https://allrice.test/chatflow/4.0/document?${suffix}`, {
    headers: {
      cookie: 'allrice_session=unit-test-session',
      // Neither a caller's owner claim nor a fixture flag can install a carrier.
      'x-allrice-owner': 'true',
      'x-allrice-fixture': 'enabled',
    },
  });
beforeEach(() => {
  authenticated.mockReset();
  historyIdentity.mockReset();
  profileRequest.mockReset();
  authenticated.mockResolvedValue({ actor: { type: 'user', id: 'actor' } });
});

it('the Next product page preserves selection before the client opens its long-lived owner', async () => {
  const page = await EntryPage({ searchParams: Promise.resolve(selection) });
  const html = renderToStaticMarkup(page);
  expect(html).toContain('data-employee-selection=');
  expect(html).not.toContain('<iframe');
  expect(html).toContain('workspaceId=');
  expect(html).not.toContain('native-owner');
  expect(html).not.toContain('<script');
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(historyIdentity).toHaveBeenCalledExactlyOnceWith(
    { actor: { type: 'user', id: 'actor' } },
    selection,
    'history',
  );
});

it('checks the original Request/Cookie before accepting even invalid selectors', async () => {
  authenticated.mockRejectedValueOnce(
    new DataAccessError('authentication_required'),
  );
  const original = request('owner=true');
  const response = await GET(original);
  expect(authenticated).toHaveBeenCalledExactlyOnceWith(original);
  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe('AUTHENTICATION_REQUIRED');
  expect(historyIdentity).not.toHaveBeenCalled();
});

it.each([
  '',
  `${query}&workspaceId=${selection.workspaceId}`,
  `${query}&principal=owner`,
  `${query}&generation=4.0`,
  `${query}&nativeSessionId=not-an-authority`,
])(
  'rejects missing, duplicate or caller-supplied authority selectors: %s',
  async (suffix) => {
    const response = await GET(request(suffix));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_FAILED');
    expect(historyIdentity).not.toHaveBeenCalled();
  },
);

it.each([
  ['not_found', 404, 'RESOURCE_NOT_FOUND'],
  ['authorization_denied', 403, 'AUTHORIZATION_DENIED'],
] as const)(
  'returns the existing history owner refusal for %s',
  async (reason, status, code) => {
    historyIdentity.mockRejectedValueOnce(new DataAccessError(reason));
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
  },
);

it('cannot turn build identity, browser headers or fixture input into an executable document', async () => {
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  const body = await response.text();
  expect(JSON.parse(body).error).toMatchObject({
    code: 'DEPENDENCY_UNAVAILABLE',
    retryable: false,
  });
  expect(body).not.toMatch(/<script|__DSH_|owner|grants|native-owner/);
});

it('preserves invalid empty/duplicate values on the page for the document parser', async () => {
  const html = renderToStaticMarkup(
    await EntryPage({
      searchParams: Promise.resolve({
        ...selection,
        principal: '',
        threadId: ['a', 'b'],
      }),
    }),
  );
  expect(html).toContain('principal=');
  expect(html).toContain('threadId=a');
  expect(html).toContain('threadId=b');
});

it('requires the issued scope in the document address and leaves the two exact native HTTP routes denied', async () => {
  const scopeId = '00000000-0000-4000-8000-000000000003';
  const claims = {
    bindingRef: 'leased-profile',
    graphRev: 'verified-graph',
    manifestSha256: '1'.repeat(64),
  };
  profileRequest.mockImplementation(async () =>
    Response.json({ ...claims, nativeSessionId: 'real-native-root' }),
  );
  const entry = await GET(request(query + '&scopeId=' + scopeId));
  expect(entry.status).toBe(307);
  const location = entry.headers.get('location')!;
  const parts = location.split('/').slice(4);
  expect(parts).toEqual([
    scopeId,
    selection.workspaceId,
    selection.employeeInstanceId,
    '_',
    claims.bindingRef,
    claims.graphRev,
    claims.manifestSha256,
    'native',
    'index.html',
  ]);
  const call = (path: string, method = 'GET') => {
    const target = new URL(location, 'https://allrice.test');
    target.pathname = target.pathname.replace(
      'index.html',
      path.split('?')[0]!,
    );
    target.search = path.includes('?') ? path.split('?')[1]! : '';
    const publicationPath = target.pathname.split('/').slice(4);
    return (method === 'POST' ? documentUpload : documentAsset)(
      new Request(target, { method }),
      { params: Promise.resolve({ publicationPath }) },
    );
  };
  const doc = await call('index.html');
  expect(doc.status).toBe(200);
  const html = await doc.text();
  expect(html).toContain('data-native-session-id="real-native-root"');
  expect(html).toContain('/managed/employee-web-entry.js');
  expect((await call('api/file?path=%2Ftest')).status).toBe(403);
  expect((await call('api/session/uploadFileBinary', 'POST')).status).toBe(403);
  expect(profileRequest.mock.calls.map((args) => args.slice(1))).toEqual([
    ['bootstrap', { scopeId }, 'document'],
    ['bootstrap', { scopeId }, 'document'],
    ['bootstrap', { scopeId }, 'document'],
    ['bootstrap', { scopeId }, 'document'],
  ]);
});
