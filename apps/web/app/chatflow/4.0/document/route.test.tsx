import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GET } from './route';
import {
  GET as documentAsset,
  POST as documentUpload,
} from './[...publicationPath]/route';
import EntryPage from '../page';
import { DataAccessError } from '@allrice/database';
import type * as NativeWorker from '../../../../lib/d-entry/native-worker';
import type * as SessionIdentity from '../../../../lib/identity/session';
import type * as Database from '@allrice/database';
import {
  buildProfileFixture,
  closePage,
  closes,
  fixture,
  open,
  sessionToken,
} from '../../../../../worker/src/d-entry/principal-page-carrier.fixture';
import { deferred } from '../../../../../../packages/d-entry-principal/test/host-fixture';

const authenticated = vi.hoisted(() => vi.fn());
const historyIdentity = vi.hoisted(() => vi.fn());
const profileRequest = vi.hoisted(() => vi.fn());
const directory = vi.hoisted(() => vi.fn());
const releasedAssets = vi.hoisted(() => vi.fn());
const cookie = vi.hoisted(() => ({ value: '' }));
vi.mock('@allrice/database', async (load) => ({
  ...(await load<typeof Database>()),
  readDEntryEmployeeDirectory: directory,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => cookie,
  }),
}));
vi.mock('../../../../lib/d-entry/native-worker', async (importOriginal) => ({
  ...(await importOriginal<typeof NativeWorker>()),
  requestDEntryProfile: profileRequest,
}));
vi.mock('../../../../lib/identity/session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionIdentity>()),
  requireRequestContext: authenticated,
}));
vi.mock('../../../../lib/d-entry/released-profile-assets', () => ({
  readReleasedProfileAssets: releasedAssets,
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
  directory.mockReset();
  releasedAssets.mockReset();
  cookie.value = 'unit-test-original-session-cookie';
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
  const threadId = '00000000-0000-4000-8000-000000000006';
  authenticated.mockResolvedValue({
    actor: { type: 'user', id: '00000000-0000-4000-8000-000000000004' },
    organizationId: '00000000-0000-4000-8000-000000000005',
  });
  const claims = {
    bindingRef: 'leased-profile',
    graphRev: 'verified-graph',
    manifestSha256: '1'.repeat(64),
  };
  profileRequest.mockImplementation(async () =>
    Response.json({ ...claims, nativeSessionId: 'real-native-root' }),
  );
  directory.mockResolvedValue({
    sessions: [{ id: threadId, title: '</script><script>unexpected</script>' }],
    employees: [],
  });
  const entry = await GET(
    request(query + '&scopeId=' + scopeId + '&threadId=' + threadId),
  );
  expect(entry.status).toBe(307);
  const location = entry.headers.get('location')!;
  const parts = location.split('/').slice(4);
  expect(parts).toEqual([
    scopeId,
    selection.workspaceId,
    selection.employeeInstanceId,
    threadId,
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
  const assetRoot = '/_next/static/dsh-profile/' + claims.manifestSha256 + '/';
  releasedAssets.mockResolvedValue({
    root: assetRoot,
    paths: new Set([
      'native/assets/index-BxpfOGf3.css',
      'managed/employee-web-entry.js',
    ]),
    bundles: [
      {
        reference: 'plugins/??bundle/client.js&rev=r1',
        revision: 'r1',
        sha256: '2'.repeat(64),
      },
    ],
  });
  const doc = await call('index.html');
  expect(doc.status).toBe(200);
  const html = await doc.text();
  expect(html).toContain('data-native-session-id="real-native-root"');
  expect(doc.headers.get('cache-control')).toBe('private, no-store');
  expect(releasedAssets).toHaveBeenCalledExactlyOnceWith(claims.manifestSha256);
  expect(html).toContain(
    'src="' + assetRoot + 'managed/employee-web-entry.js"',
  );
  expect(html).toContain(
    'href="' + assetRoot + 'native/assets/index-BxpfOGf3.css"',
  );
  expect(html).toContain('href="assets/vendor-DV2921Zo.css"');
  expect(html).toContain('data-public-asset-root="' + assetRoot + '"');
  expect(html).toContain('&amp;rev=r1');
  const lifecycle = html.indexOf('__ALLRICE_EMPLOYEE_DOCUMENT__');
  const stylesheetTags = [
    ...html.matchAll(/data-allrice-document-asset="style"/g),
  ];
  expect(lifecycle).toBeGreaterThan(0);
  expect(stylesheetTags).toHaveLength(3);
  for (const stylesheet of stylesheetTags)
    expect(stylesheet.index).toBeGreaterThan(lifecycle);
  expect(html.indexOf('data-allrice-document-asset="entry"')).toBeGreaterThan(
    lifecycle,
  );
  expect(html).toContain(
    'id="allrice-employee-directory" type="application/json"',
  );
  expect(html).not.toContain('<script>unexpected</script>');
  expect(directory).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      actor: expect.objectContaining({ type: 'user' }),
    }),
    { ...selection, threadId },
    expect.any(AbortSignal),
  );
  expect((await call('api/file?path=%2Ftest')).status).toBe(403);
  expect((await call('api/session/uploadFileBinary', 'POST')).status).toBe(403);
  expect(profileRequest.mock.calls.map((args) => args.slice(1))).toEqual([
    ['bootstrap', { scopeId }, 'document'],
    ['bootstrap', { scopeId }, 'document'],
    ['bootstrap', { scopeId }, 'document'],
    ['bootstrap', { scopeId }, 'document'],
    ['bootstrap', { scopeId }, 'document'],
  ]);
});

it(
  'refuses HTML when the actual original Worker carrier closes during the directory read',
  { timeout: 30_000 },
  async () => {
    const release = await buildProfileFixture();
    const worker = await fixture(release);
    const issued = await open(worker);
    const neighbor = await open(worker);
    const readDirectory = deferred<AbortSignal>();
    const finishDirectory = deferred();
    closes.push(async () => finishDirectory.resolve());
    directory.mockImplementationOnce(async (_context, _selection, signal) => {
      readDirectory.resolve(signal);
      await finishDirectory.promise;
      return {
        employees: [{ name: 'private employee from directory' }],
        sessions: [{ title: 'private session from directory' }],
      };
    });
    authenticated.mockResolvedValue(worker.context);
    historyIdentity.mockResolvedValue(worker.identity);
    cookie.value = sessionToken;
    const native = await vi.importActual<typeof NativeWorker>(
      '../../../../lib/d-entry/native-worker',
    );
    profileRequest.mockImplementation(native.requestDEntryProfile);
    const query = new URLSearchParams({
      ...worker.selection,
      scopeId: issued.scopeId,
    });
    const outer = await GET(request(query.toString()));
    expect(outer.status).toBe(307);
    const location = new URL(
      outer.headers.get('location')!,
      'https://allrice.test',
    );
    const definitive = new Request(location, {
      headers: { cookie: 'allrice_session=' + sessionToken },
    });
    const pending = documentAsset(definitive, {
      params: Promise.resolve({
        publicationPath: location.pathname.split('/').slice(4),
      }),
    });
    try {
      await Promise.race([
        readDirectory.promise,
        pending.then((output) => {
          throw Error(
            'Directory did not hold the HTTP request: ' + output.status,
          );
        }),
      ]);
      closePage(issued.peer);
      expect(await issued.receive()).toMatchObject({
        value: { type: 'closed' },
      });
      expect(await issued.receive()).toEqual({ type: 'end', streamId: 'life' });
      expect(definitive.signal.aborted).toBe(false);
    } finally {
      finishDirectory.resolve();
    }
    const denied = await pending;
    expect(denied.status).toBe(404);
    expect(denied.headers.get('content-type')).toContain('application/json');
    expect(await denied.text()).not.toMatch(
      /private employee|private session|<script/,
    );
    expect(profileRequest).toHaveBeenCalledTimes(3);
    expect(
      profileRequest.mock.calls.every(
        ([input]) =>
          input.token === sessionToken &&
          input.context.sessionId === worker.context.sessionId &&
          input.selection.threadId === worker.selection.threadId,
      ),
    ).toBe(true);
    const other = await worker.publish(
      'bootstrap',
      neighbor.scopeId,
      {},
      'document',
    );
    expect(other.status).toBe(200);
    await other.json();
  },
);
