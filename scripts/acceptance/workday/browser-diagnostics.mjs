import { randomUUID } from 'node:crypto';

// Finite projections only: Playwright messages can contain selectors, URLs,
// page text or credentials. Never persist arbitrary exception messages/logs.
const messages = {
  'identity-http': 'Current identity request failed',
  'identity-scope-mismatch':
    'Current identity differs from the authorized scope',
  'owner-http': 'Current native owner request failed',
  'owner-binding-mismatch': 'Native generation or exact owner changed',
  'navigation-http': 'Owner route did not return HTTP 200',
  'navigation-origin-mismatch': 'Owner route left the authorized origin',
  'scope-mismatch': 'Displayed employee scope differs',
};

export function browserFailure(code, status) {
  if (!Object.hasOwn(messages, code))
    throw new Error('Unknown diagnostic code');
  const error = new Error(messages[code]);
  error.diagnostic = { code, message: messages[code] };
  if (Number.isInteger(status)) error.diagnostic.status = status;
  return error;
}

function diagnostic(stage, error) {
  const type = [
    'Error',
    'TimeoutError',
    'AbortError',
    'TypeError',
    'SyntaxError',
  ].includes(error?.name)
    ? error.name
    : 'UnknownError';
  // Only errors created here carry a controlled message/status projection.
  if (
    error instanceof Error &&
    Object.hasOwn(messages, error.diagnostic?.code) &&
    error.message === messages[error.diagnostic.code]
  ) {
    const { code, status } = error.diagnostic;
    return {
      stage,
      type,
      code,
      message: messages[code],
      ...(Number.isInteger(status) ? { status } : {}),
    };
  }
  return {
    stage,
    type,
    code: stage + (type === 'TimeoutError' ? '-timeout' : '-error'),
    message: 'Native browser operation failed; private call log omitted',
  };
}

function describe(failure) {
  return `${failure.stage}/${failure.code} ${failure.type}${failure.status === undefined ? '' : ` HTTP ${failure.status}`}: ${failure.message}`;
}

/** Restrict page traffic to the owner-approved document and exact read APIs. */
export function readOnlyPageRoute(origin, recipe) {
  const document = new URL(recipe.path, origin);
  document.hash = '';
  const reads = new Set(
    (recipe.readApiPaths ?? []).map((path) => new URL(path, origin).href),
  );
  if (document.origin !== origin || document.pathname.startsWith('/api/'))
    throw new Error('The approved document must be a same-origin page');
  for (const href of reads) {
    const url = new URL(href);
    if (
      url.origin !== origin ||
      !url.pathname.startsWith('/api/v1/') ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error('Read API paths must be exact same-origin URLs');
  }
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const permitted = request.isNavigationRequest()
      ? url.href === document.href
      : url.pathname.startsWith('/_next/static/') || reads.has(url.href);
    if (
      url.origin !== origin ||
      !permitted ||
      !['GET', 'HEAD'].includes(request.method())
    ) {
      await route.abort('blockedbyclient');
      return;
    }
    // Continuing a browser request would allow Playwright redirect hops
    // without returning through the route handler.
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0 });
      if (response.status() >= 300 && response.status() < 400)
        await route.abort('blockedbyclient');
      else await route.fulfill({ response });
    } catch {
      // Report a failed resource to Chromium without leaking the private
      // Playwright call log when a fetch rejects or the page is closing.
      await route.abort('failed').catch(() => {});
    } finally {
      await response?.dispose().catch(() => {});
    }
  };
}

/** Existing single-page read, extracted so failure/capture composition is tested
 * without launching a browser or presenting injected pages as Dev evidence. */
export async function readPage(
  page,
  { origin, employeeInstanceId, recipe, identity, saveScreenshot, screenshot },
) {
  let stage = 'identity-before';
  const assertScope = async (scope) => {
    if (new URL(page.url()).origin !== origin)
      throw browserFailure('navigation-origin-mismatch');
    if (
      (await scope.count()) !== 1 ||
      (await scope.getAttribute(recipe.scopeAttribute)) !== employeeInstanceId
    )
      throw browserFailure('scope-mismatch');
  };
  try {
    await identity();
    stage = 'navigation';
    const response = await page.goto(new URL(recipe.path, origin).href);
    if (!response || response.status() !== 200)
      throw browserFailure('navigation-http', response?.status());
    stage = 'scope';
    const scope = page.locator(recipe.scopeLocator).filter({ visible: true });
    await scope.first().waitFor({ state: 'visible' });
    await assertScope(scope);
    stage = 'locator';
    await scope.locator(recipe.locator).first().waitFor({ state: 'visible' });
    if (recipe.text !== undefined) {
      stage = 'text';
      await scope
        .getByText(recipe.text, { exact: true })
        .first()
        .waitFor({ state: 'visible' });
    }
    stage = 'fonts';
    await page.evaluate(() => globalThis.document.fonts.ready);
    stage = 'identity-after';
    await identity();
    stage = 'scope';
    await assertScope(scope);
    stage = 'capture';
    // A locator screenshot crops the composited page. Hide sibling and portal
    // layers so their pixels do not enter the authorized rectangle.
    const marker = 'data-workday-capture-' + randomUUID();
    await scope.evaluate((element, name) => {
      element.setAttribute(name, '');
      // Preserve the layout and override inline visibility on off-scope
      // branches. The dedicated page is closed after this capture.
      for (const other of element.ownerDocument.querySelectorAll('*')) {
        if (element.contains(other) || other.contains(element)) continue;
        if ('style' in other)
          other.style.setProperty('opacity', '0', 'important');
      }
    }, marker);
    const target = scope.and(page.locator(`[${marker}]`));
    const outside = `:not([${marker}], [${marker}] *)`;
    const image = await target.screenshot({
      style: `${outside}, ${outside}::before, ${outside}::after, ${outside}::backdrop {
        visibility: hidden !important;
      }
      [${marker}] { visibility: visible !important; }`,
    });
    stage = 'identity-after-capture';
    await identity();
    stage = 'scope';
    await assertScope(scope);
    stage = 'capture';
    await saveScreenshot(image);
    return {
      status: 'passed',
      screenshot,
      reason:
        '真实浏览器当前授权read-only页面/owner locator可见；禁写/禁WS，不证明模型过程或业务读写闭环',
    };
  } catch (error) {
    const failure = diagnostic(stage, error);
    return {
      status: 'failed',
      screenshot: null,
      failure,
      captureFailure: stage === 'capture' ? failure : null,
      reason: describe(failure),
      noScreenshotReason: describe(failure),
    };
  }
}
