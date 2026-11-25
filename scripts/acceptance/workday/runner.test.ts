/** Automatically collected offline regressions; no Host/browser/VM/model switch. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import {
  browserFailure,
  readOnlyPageRoute,
  readPage,
} from './browser-diagnostics.mjs';

it('runs the standard-library Python runner regression suite in ordinary CI', () => {
  execFileSync(
    'python3',
    [fileURLToPath(new URL('./run.test.py', import.meta.url)), '-v'],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    },
  );
  // execFileSync rejects nonzero status; the Python assertions are authoritative.
});

function pageFixture() {
  const locator = {
    first: () => locator,
    waitFor: vi.fn(async () => {}),
  };
  const scope = {
    first: () => scope,
    filter: vi.fn(() => scope),
    and: vi.fn(() => scope),
    evaluate:
      vi.fn<
        (
          fn: (node: Element, name: string) => void,
          name: string,
        ) => Promise<void>
      >(),
    locator: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    count: vi.fn(async () => 1),
    waitFor: vi.fn(async () => {}),
    getAttribute: vi.fn(async () => 'employee-fixture'),
    screenshot: vi.fn(async () => Buffer.from('synthetic-unit-only')),
  };
  const page = {
    goto: vi.fn(async () => ({ status: () => 200 })),
    url: () => 'https://fixture.invalid/readonly',
    locator: vi.fn(() => scope),
    evaluate: vi.fn(async () => {}),
  };
  const options = {
    origin: 'https://fixture.invalid',
    employeeInstanceId: 'employee-fixture',
    recipe: {
      path: '/readonly',
      locator: 'fixture',
      scopeLocator: 'fixture',
      scopeAttribute: 'fixture',
    },
    identity: vi.fn(async () => {}),
    saveScreenshot: vi.fn(async () => {}),
    screenshot: 'never-written.png',
  };
  return { page, locator, scope, options };
}

it('keeps locator first failure without private call logs or a screenshot', async () => {
  const { page, locator, scope, options } = pageFixture();
  const timeout = new Error(
    'Cookie: private-session https://fixture.invalid/?token=secret <private-page>',
  );
  timeout.name = 'TimeoutError';
  locator.waitFor.mockRejectedValueOnce(timeout);
  const row = await readPage(page, options);
  expect(row).toMatchObject({
    status: 'failed',
    screenshot: null,
    failure: {
      stage: 'locator',
      code: 'locator-timeout',
      type: 'TimeoutError',
    },
    captureFailure: null,
  });
  expect(row.reason).toContain('locator/locator-timeout');
  expect(row.noScreenshotReason).toContain('locator/locator-timeout');
  for (const secret of ['private-session', 'token=secret', 'private-page', '?'])
    expect(JSON.stringify(row)).not.toContain(secret);
  expect(page.locator.mock.calls).toEqual([[options.recipe.scopeLocator]]);
  expect(scope.locator).toHaveBeenCalledExactlyOnceWith(options.recipe.locator);
  expect(scope.screenshot).not.toHaveBeenCalled();
  expect(options.saveScreenshot).not.toHaveBeenCalled();
  expect(options.identity).toHaveBeenCalledOnce();
});

it('retains safe HTTP status and owner-binding failure without saving a page', async () => {
  for (const { error, code, status } of [
    {
      error: browserFailure('identity-http', 500),
      code: 'identity-http',
      status: 500,
    },
    {
      error: browserFailure('owner-binding-mismatch'),
      code: 'owner-binding-mismatch',
      status: undefined,
    },
  ]) {
    const { page, scope, options } = pageFixture();
    options.identity.mockRejectedValueOnce(error);
    const row = await readPage(page, options);
    expect(row.status).toBe('failed');
    expect(row.failure).toMatchObject({
      stage: 'identity-before',
      code,
    });
    expect(row.failure.status).toBe(status);
    expect(row.screenshot).toBeNull();
    expect(row.captureFailure).toBeNull();
    expect(page.goto).not.toHaveBeenCalled();
    expect(scope.screenshot).not.toHaveBeenCalled();
  }
});

it('distinguishes scope failure from capture failure and rechecks identity after reads', async () => {
  const scope = pageFixture();
  scope.scope.getAttribute.mockResolvedValueOnce('foreign-employee');
  const scopeRow = await readPage(scope.page, scope.options);
  expect(scopeRow.failure).toMatchObject({
    stage: 'scope',
    code: 'scope-mismatch',
  });
  expect(scope.options.identity).toHaveBeenCalledOnce();
  expect(scope.scope.screenshot).not.toHaveBeenCalled();
  expect(scope.scope.filter).toHaveBeenCalledExactlyOnceWith({ visible: true });

  const capture = pageFixture();
  capture.scope.screenshot.mockRejectedValueOnce(new Error('private-capture'));
  const row = await readPage(capture.page, capture.options);
  expect(row.failure).toMatchObject({
    stage: 'capture',
    code: 'capture-error',
  });
  expect(row.captureFailure).toMatchObject({
    stage: 'capture',
    code: 'capture-error',
  });
  expect(capture.options.identity).toHaveBeenCalledTimes(2);
  expect(row.screenshot).toBeNull();
  expect(JSON.stringify(row)).not.toContain('private-');
});

it('persists only the scoped image after verifying identity and the marker again', async () => {
  const authorized = pageFixture();
  authorized.options.recipe.text = 'Owned evidence';
  expect(await readPage(authorized.page, authorized.options)).toMatchObject({
    status: 'passed',
    screenshot: 'never-written.png',
  });
  expect(authorized.scope.getByText).toHaveBeenCalledWith('Owned evidence', {
    exact: true,
  });
  expect(authorized.options.identity).toHaveBeenCalledTimes(3);
  const marker = authorized.scope.evaluate.mock.calls.at(0)?.[1];
  expect(marker).toMatch(/^data-workday-capture-/);
  expect(authorized.scope.screenshot).toHaveBeenCalledExactlyOnceWith({
    animations: 'disabled',
    style: expect.stringContaining(`:not([${marker}], [${marker}] *)`),
  });
  expect(authorized.options.saveScreenshot).toHaveBeenCalledExactlyOnceWith(
    Buffer.from('synthetic-unit-only'),
  );
  const revoked = pageFixture();
  revoked.options.identity
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(browserFailure('owner-binding-mismatch'));
  expect(await readPage(revoked.page, revoked.options)).toMatchObject({
    status: 'failed',
    screenshot: null,
    failure: {
      stage: 'identity-after-capture',
      code: 'owner-binding-mismatch',
    },
  });
  expect(revoked.options.saveScreenshot).not.toHaveBeenCalled();
});

it('fetches only the approved document, static resources and exact read APIs without following redirects', async () => {
  const origin = 'https://fixture.invalid';
  const handler = readOnlyPageRoute(origin, {
    path: '/readonly?employee=fixture',
    readApiPaths: ['/api/v1/workspace?employee=fixture'],
  });
  for (const [url, navigation, method, responseCode, fetched] of [
    [origin + '/readonly?employee=fixture', true, 'GET', 200, true],
    [origin + '/_next/static/chunk.js', false, 'GET', 302, true],
    [origin + '/api/v1/workspace?employee=fixture', false, 'GET', 200, true],
    [origin + '/api/v1/workspace?employee=other', false, 'GET', 200, false],
    [origin + '/api/v1/connections/callback', false, 'GET', 200, false],
    [origin + '/api/v1/workspace?employee=fixture', false, 'POST', 200, false],
    ['https://outside.invalid/_next/static/chunk.js', false, 'GET', 200, false],
  ] as const) {
    const response = {
      status: () => responseCode,
      dispose: vi.fn(async () => {}),
    };
    const route = {
      request: () => ({
        url: () => url,
        isNavigationRequest: () => navigation,
        method: () => method,
      }),
      fetch: vi.fn(async () => response),
      abort: vi.fn(),
      fulfill: vi.fn(),
    };
    await handler(route);
    if (fetched) {
      expect(route.fetch).toHaveBeenCalledExactlyOnceWith({ maxRedirects: 0 });
      expect(response.dispose).toHaveBeenCalledOnce();
    } else expect(route.fetch).not.toHaveBeenCalled();
    if (fetched && responseCode === 200)
      expect(route.fulfill).toHaveBeenCalledExactlyOnceWith({ response });
    else expect(route.abort).toHaveBeenCalledExactlyOnceWith('blockedbyclient');
  }
});

it('aborts a failed approved fetch without escaping the private route error', async () => {
  const origin = 'https://fixture.invalid';
  const handler = readOnlyPageRoute(origin, { path: '/readonly' });
  const route = {
    request: () => ({
      url: () => origin + '/readonly',
      isNavigationRequest: () => true,
      method: () => 'GET',
    }),
    fetch: vi.fn().mockRejectedValue(new Error('private request data')),
    abort: vi.fn(async () => {}),
    fulfill: vi.fn(),
  };
  await handler(route);
  expect(route.abort).toHaveBeenCalledExactlyOnceWith('failed');
  expect(route.fulfill).not.toHaveBeenCalled();
});
