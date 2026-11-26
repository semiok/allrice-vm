import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import {
  CheckFailed,
  DSH_EDITOR,
  entry,
  isId,
  paths,
  publicOrigin,
  requireFact,
  sameSelection,
} from './contracts.mjs';

const webRequire = createRequire(
  new URL('../../../apps/web/package.json', import.meta.url),
);
const duration = (from) => Math.round(performance.now() - from);
const POLL_LIMIT_MS = 5 * 60_000; // #23 entry-client.ts
const FRAME = 'iframe[title="员工工作区"]';
const readPaths = new Set([
  '/',
  '/login',
  '/chatflow',
  entry,
  paths.identity,
  paths.poll,
]);

function navigation(url, path) {
  return url.origin === publicOrigin && url.pathname === path;
}

function responseStatus(status, expected, code) {
  requireFact(status === expected, code, status);
}

/** Observe the browser's own requests, including the single polling loop. */
function browserFlow({ identity, account, employeeName, receipt }) {
  let selection;
  let phase = 'cold';
  let loginStarted;
  let employeeStarted;
  let pollInFlight = false;
  let ticket;
  let prewarmStarted;
  let acceptedAt;
  const phases = receipt.browser;
  const current = () => phases[phase];

  function allowWrite(path, url, body) {
    switch (path) {
      case paths.login:
        return (
          !loginStarted &&
          !url.search &&
          body?.username === account.username &&
          body?.password === account.password
        );
      case paths.employee:
        return (
          receipt.stages.zeroEmployee === 'passed' &&
          !employeeStarted &&
          !url.search &&
          body?.workspaceId === identity.workspaceId &&
          !Object.hasOwn(body, 'assignmentId') &&
          isId(body.requestId) &&
          body.profile?.name === employeeName
        );
      case paths.prewarm:
        return (
          selection &&
          !current().prewarmRequests &&
          !url.search &&
          body?.trigger === 'page' &&
          sameSelection(body.selection, selection)
        );
      case paths.thread:
        return (
          phase === 'cold' &&
          current().prewarmReady &&
          !current().threadRequested &&
          !selection?.threadId &&
          !Object.hasOwn(body ?? {}, 'operationId') &&
          url.search === '?entry=4.0' &&
          sameSelection(body?.selection, selection)
        );
      default:
        return false;
    }
  }

  async function request(
    { url, method, body, organization, workspace },
    exchange,
  ) {
    const path = url.pathname;
    requireFact(
      url.origin === publicOrigin && !url.username && !url.password,
      'origin-blocked',
    );
    const query = Object.fromEntries(url.searchParams);
    const isPoll = path === paths.poll && method === 'GET';
    if (method === 'POST') {
      requireFact(allowWrite(path, url, body), 'write-blocked');
      if (path === paths.login) loginStarted = performance.now();
      if (path === paths.employee) {
        requireFact(
          organization === identity.organizationId &&
            workspace === identity.workspaceId,
          'employee-request-scope',
        );
        employeeStarted = performance.now();
      }
      if (path === paths.prewarm) {
        current().prewarmRequests = 1;
        prewarmStarted = performance.now();
      }
      if (path === paths.thread) current().threadRequested = true;
    } else {
      requireFact(method === 'GET', 'write-blocked');
      requireFact(
        readPaths.has(path) ||
          path === `${entry}/document` ||
          path.startsWith(`${entry}/document/`) ||
          path.startsWith('/_next/static/') ||
          path === '/api/v1/d-entry/profile/bootstrap' ||
          path === '/api/v1/d-entry/profile/assets' ||
          path.startsWith('/api/v1/d-entry/profile/assets/static/'),
        'read-blocked',
      );
    }
    if (isPoll) {
      requireFact(
        phase === 'cold' &&
          ticket &&
          !current().prewarmReady &&
          !pollInFlight &&
          duration(acceptedAt) <= POLL_LIMIT_MS &&
          current().polls.length < 300 &&
          query.operationId === ticket.operationId &&
          sameSelection(query, selection) &&
          [...url.searchParams].length === 3,
        'poll-scope-or-budget',
      );
      pollInFlight = true;
    }
    const reply = await exchange();
    const data = reply.json;
    switch (`${method} ${path}`) {
      case `POST ${paths.login}`:
        responseStatus(reply.status, 200, 'login-http');
        requireFact(
          data?.user?.id === identity.personId && data.homePath === '/chatflow',
          'login-identity',
        );
        receipt.timings.loginHttpMs = duration(loginStarted);
        break;
      case `POST ${paths.employee}`: {
        responseStatus(reply.status, 201, 'employee-http');
        const instance = data?.instance;
        requireFact(
          instance?.organizationId === identity.organizationId &&
            instance.workspaceId === identity.workspaceId &&
            instance.ownerId === identity.personId &&
            instance.kind === 'custom' &&
            isId(instance.id),
          'employee-scope',
        );
        selection = {
          workspaceId: instance.workspaceId,
          employeeInstanceId: instance.id,
        };
        receipt.timings.employeeCreationHttpMs = duration(employeeStarted);
        break;
      }
      case `POST ${paths.prewarm}`:
        current().initialHttp = reply.status;
        if (phase === 'cold')
          receipt.timings.coldInitialResponseMs = duration(prewarmStarted);
        responseStatus(
          reply.status,
          phase === 'cold' ? 202 : 204,
          `${phase}-prewarm-http`,
        );
        if (phase === 'warm') current().prewarmReady = true;
        else {
          requireFact(
            isId(data?.operationId) &&
              Number.isInteger(data.pollAfterMs) &&
              data.pollAfterMs >= 1000 &&
              data.pollAfterMs <= 3000 &&
              Number.isFinite(Date.parse(data.expiresAt)),
            'invalid-prewarm-ticket',
          );
          ticket = data;
          acceptedAt = performance.now();
        }
        break;
      case `GET ${paths.poll}`: {
        pollInFlight = false;
        const state = [
          'accepted',
          'starting',
          'ready',
          'expired',
          'failed',
        ].find((value) => value === data?.state);
        current().polls.push({
          status: reply.status,
          state: state ?? 'unrecognized',
        });
        if (reply.status === 410 && state === 'expired')
          throw new CheckFailed('prewarm-expired', 410);
        responseStatus(reply.status, 200, 'prewarm-status-http');
        requireFact(state && state !== 'expired', 'invalid-prewarm-status');
        if (state === 'failed') {
          const code =
            data.code === 'AUTHORITY_REVOKED'
              ? 'prewarm-authority-revoked'
              : 'prewarm-start-failed';
          throw new CheckFailed(code, reply.status);
        }
        if (state === 'ready') {
          current().prewarmReady = true;
          receipt.timings.coldPrewarmToReadyObservedMs =
            duration(prewarmStarted);
        }
        break;
      }
      case `POST ${paths.thread}`:
        responseStatus(reply.status, 200, 'thread-entry-http');
        requireFact(
          isId(data?.threadId) &&
            sameSelection(data, { ...selection, threadId: data.threadId }),
          'thread-entry-scope',
        );
        selection.threadId = data.threadId;
        current().threadOpened = true;
        break;
      case `GET ${paths.identity}`:
        responseStatus(reply.status, 200, 'native-identity-http');
        requireFact(
          current().prewarmReady &&
            isId(selection?.threadId) &&
            sameSelection(query, selection) &&
            sameSelection(data?.identity, selection) &&
            data.identity.personId === identity.personId &&
            data.identity.organizationId === identity.organizationId,
          'native-identity-scope',
        );
        current().identityVerified = true;
        break;
    }
    return reply;
  }

  return {
    request,
    selection: () => selection,
    warm: () => {
      phase = 'warm';
    },
  };
}

export async function runBrowser({
  driver,
  account,
  employeeName,
  timeout,
  identity,
  receipt,
  browserExecutable,
  fail,
}) {
  const { chromium } = webRequire('playwright-core');
  const browser = await chromium.launch({
    executablePath: browserExecutable,
    timeout,
    headless: true,
    args: driver.chromiumArgs,
    env: Object.fromEntries(
      [
        'PATH',
        'HOME',
        'TMPDIR',
        'LANG',
        'DISPLAY',
        'XAUTHORITY',
        'XDG_RUNTIME_DIR',
        'LD_LIBRARY_PATH',
      ]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    ),
  });
  let rejectNetwork;
  const networkFailure = new Promise((_, reject) => {
    rejectNetwork = reject;
  });
  void networkFailure.catch(() => {});
  let stage = 'browser';
  let routeFailed = false;
  const flow = browserFlow({ identity, account, employeeName, receipt });
  function failure(error) {
    if (routeFailed) return;
    routeFailed = true;
    fail(stage, error);
    rejectNetwork(error);
  }
  const guarded = (action) => Promise.race([action, networkFailure]);
  let context;
  try {
    context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    context.setDefaultTimeout(timeout);
    await driver.install(context, {
      inspect: (request, exchange) => {
        requireFact(!routeFailed, 'request-after-failure');
        return flow.request(request, exchange);
      },
      fail: failure,
    });
    const page = await context.newPage();
    stage = 'login';
    const loginStart = performance.now();
    await guarded(page.goto(publicOrigin, { waitUntil: 'domcontentloaded' }));
    await guarded(
      page.waitForURL((url) => navigation(url, '/login'), { timeout }),
    );
    await guarded(
      page.locator('input[name="username"]').fill(account.username),
    );
    await guarded(
      page.locator('input[name="password"]').fill(account.password),
    );
    await guarded(
      page.getByRole('button', { name: '登录', exact: true }).click(),
    );
    await guarded(
      page.waitForURL((url) => navigation(url, entry) && !url.search, {
        timeout,
      }),
    );
    requireFact(receipt.timings.loginHttpMs !== null, 'login-not-observed');
    receipt.timings.loginToEntryMs = duration(loginStart);
    receipt.stages.login = 'passed';
    stage = 'zeroEmployee';
    await guarded(
      page
        .getByRole('heading', { name: '新建你的第一个员工', exact: true })
        .waitFor(),
    );
    requireFact(
      (await page.locator(FRAME).count()) === 0,
      'zero-employee-frame-present',
    );
    receipt.stages.zeroEmployee = 'passed';
    stage = 'employeeCreation';
    await guarded(
      page.getByRole('button', { name: '创建员工', exact: true }).click(),
    );
    const dialog = page.getByRole('dialog', {
      name: '创建 AI 员工',
      exact: true,
    });
    await guarded(dialog.locator('[data-employee-name]').fill(employeeName));
    const coldStart = performance.now();
    await guarded(
      dialog.getByRole('button', { name: '确认创建', exact: true }).click(),
    );
    await guarded(
      page.waitForURL(
        (url) =>
          navigation(url, entry) && url.searchParams.has('employeeInstanceId'),
        { timeout },
      ),
    );
    requireFact(
      flow.selection() && receipt.timings.employeeCreationHttpMs !== null,
      'employee-creation-not-observed',
    );
    receipt.stages.employeeCreation = 'passed';

    async function focusedEditor(phase, start) {
      stage = `${phase}Editor`;
      await guarded(page.locator(FRAME).waitFor({ state: 'visible', timeout }));
      const child = page.frameLocator(FRAME);
      const editor = child.locator(DSH_EDITOR);
      await guarded(editor.waitFor({ state: 'visible', timeout }));
      requireFact(
        await guarded(editor.evaluate((node) => node.isContentEditable)),
        'composer-not-editable',
      );
      // Focus without inserting text, issuing keyboard shortcuts, or sending.
      await guarded(editor.focus());
      requireFact(
        await guarded(
          editor.evaluate(
            (node) =>
              node.ownerDocument.activeElement === node &&
              node.isContentEditable,
          ),
        ),
        'composer-not-focused',
      );
      const url = new URL(page.url());
      requireFact(
        navigation(url, entry) &&
          sameSelection(
            Object.fromEntries(url.searchParams),
            flow.selection(),
          ) &&
          receipt.browser[phase].prewarmReady &&
          receipt.browser[phase].identityVerified,
        'composer-scope-unverified',
      );
      receipt.timings[`${phase}ToEditableMs`] = duration(start);
      receipt.stages[`${phase}Editor`] = 'passed';
    }
    await focusedEditor('cold', coldStart);
    flow.warm();
    stage = 'warmReopen';
    const warmStart = performance.now();
    await guarded(page.reload({ waitUntil: 'domcontentloaded' }));
    await focusedEditor('warm', warmStart);
  } catch (error) {
    fail(stage, error);
    throw error;
  } finally {
    try {
      await context?.close();
    } finally {
      await browser.close();
      receipt.browser.closed = true;
    }
  }
}
