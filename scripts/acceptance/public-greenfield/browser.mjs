import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
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
import { createHelloProbe, nativeReadMethods } from './live-native.mjs';

const webRequire = createRequire(
  new URL('../../../apps/web/package.json', import.meta.url),
);
const duration = (from) => Math.round(performance.now() - from);
const POLL_LIMIT_MS = 5 * 60_000; // #23 entry-client.ts
const POLL_REQUEST_MS = 20_000;
const POLL_JITTER_MS = 50;
const FRAME = 'iframe[title="员工工作区"]';
const documentPath = `${entry}/document`;
const profileToken = /^[a-zA-Z0-9_-]{1,160}$/;
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
function browserFlow({
  identity,
  account,
  employeeName,
  receipt,
  onColdTicket,
  hello,
}) {
  let selection;
  let employeeVersion;
  let carrier;
  let previousScope;
  let phase = 'cold';
  let loginStarted;
  let employeeStarted;
  let pollInFlight = false;
  let ticket;
  let prewarmStarted;
  let pollAfterMs;
  let lastPollResponseAt;
  let pollDeadline;
  const phases = receipt.browser;
  const current = () => phases[phase];

  function isDocumentSource(url) {
    const query = Object.fromEntries(url.searchParams);
    return (
      carrier &&
      navigation(url, documentPath) &&
      [...url.searchParams].length === 4 &&
      query.scopeId === carrier.scopeId &&
      sameSelection(query, selection)
    );
  }

  function hasDocumentScope({ source, loaded, scopeId }) {
    if (
      !source ||
      !loaded ||
      !isDocumentSource(new URL(source)) ||
      scopeId !== carrier.scopeId
    )
      return false;
    const url = new URL(loaded);
    if (isDocumentSource(url)) return true;
    if (
      url.origin !== publicOrigin ||
      !url.pathname.startsWith(documentPath + '/') ||
      url.search
    )
      return false;
    const parts = url.pathname.slice(documentPath.length + 1).split('/');
    const [
      scope,
      workspaceId,
      employeeInstanceId,
      threadId,
      bindingRef,
      graph,
      digest,
      folder,
      file,
    ] = parts;
    return (
      parts.length === 9 &&
      scope === scopeId &&
      bindingRef === carrier.bindingRef &&
      sameSelection({ workspaceId, employeeInstanceId, threadId }, selection) &&
      profileToken.test(graph) &&
      /^[a-f0-9]{64}$/.test(digest) &&
      folder === 'native' &&
      file === 'index.html'
    );
  }

  function muxRole(url) {
    const query = Object.fromEntries(url.searchParams);
    requireFact(
      current().identityVerified &&
        url.protocol === 'wss:' &&
        url.host === new URL(publicOrigin).host &&
        !url.username &&
        !url.password &&
        url.pathname === paths.mux &&
        url.searchParams.size === (query.scopeId ? 6 : 5) &&
        new Set(url.searchParams.keys()).size === url.searchParams.size &&
        query.carrier === 'page' &&
        query.organizationId === identity.organizationId &&
        sameSelection(query, selection) &&
        (query.scopeId ? query.scopeId === carrier?.scopeId : !carrier),
      'carrier-address-unverified',
    );
    return query.scopeId ? 'streams' : 'owner';
  }

  function beginCarrier(url, frame) {
    const { payload } = frame ?? {};
    requireFact(
      muxRole(url) === 'owner' &&
        frame?.type === 'open' &&
        frame.endpoint === '$d-entry/page' &&
        isId(frame.streamId) &&
        payload?.args &&
        Object.keys(payload).length === 1 &&
        Object.keys(payload.args).length === 0 &&
        typeof payload.args === 'object' &&
        !Array.isArray(payload.args),
      'carrier-request-unverified',
    );
    return (reply) => {
      const { scopeReference, bindingRef } = reply?.value ?? {};
      requireFact(
        reply?.type === 'item' &&
          reply.streamId === frame.streamId &&
          reply.value?.type === 'opened' &&
          isId(scopeReference?.scopeId) &&
          Object.keys(scopeReference).length === 1 &&
          Object.keys(reply.value).length === 3 &&
          scopeReference.scopeId !== previousScope &&
          typeof bindingRef === 'string' &&
          profileToken.test(bindingRef),
        'carrier-open-unverified',
      );
      carrier = { scopeId: scopeReference.scopeId, bindingRef };
      current().carrierVerified = true;
      return reply;
    };
  }

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
          (!onColdTicket || body.expectedOwnerId === identity.personId) &&
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
    let poll;
    let prompt;
    if (method === 'POST') {
      if (path === paths.rpc && onColdTicket) {
        requireFact(
          url.search === '?carrier=page' &&
            carrier &&
            body?.scopeId === carrier.scopeId &&
            sameSelection(body.selection, selection),
          'native-rpc-scope',
        );
        if (body.endpoint === 'session/prompt' && hello) {
          prompt = hello.dispatch(body);
        } else {
          requireFact(nativeReadMethods.has(body.endpoint), 'write-blocked');
        }
      } else {
        requireFact(allowWrite(path, url, body), 'write-blocked');
      }
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
          (onColdTicket &&
            [
              '/favicon.ico',
              '/brand/allrice-icon-v1.svg',
              '/brand/apple-touch-icon-v1.png',
            ].includes(path)) ||
          path === documentPath ||
          path.startsWith(documentPath + '/') ||
          path.startsWith('/_next/static/') ||
          path === '/api/v1/d-entry/profile/bootstrap' ||
          path === '/api/v1/d-entry/profile/assets' ||
          path.startsWith('/api/v1/d-entry/profile/assets/static/'),
        'read-blocked',
      );
      if (path === documentPath)
        requireFact(isDocumentSource(url), 'native-document-scope');
    }
    if (path === paths.poll && method === 'GET') {
      const now = performance.now();
      requireFact(
        phase === 'cold' &&
          ticket &&
          !current().prewarmReady &&
          !pollInFlight &&
          now <= pollDeadline &&
          current().polls.length < 300 &&
          query.operationId === ticket.operationId &&
          sameSelection(query, selection) &&
          [...url.searchParams].length === 3,
        'poll-scope-or-budget',
      );
      poll = {
        intervalMs: Math.round(now - lastPollResponseAt),
        requiredMs: pollAfterMs,
      };
      current().polls.push(poll);
      requireFact(
        now - lastPollResponseAt + POLL_JITTER_MS >= pollAfterMs,
        'poll-too-early',
      );
      pollInFlight = true;
    }
    const reply = await exchange();
    const data = reply.json;
    if (
      onColdTicket &&
      [401, 403, 410].includes(reply.status) &&
      (path === documentPath ||
        path.startsWith(documentPath + '/') ||
        path.startsWith('/api/v1/d-entry/profile/') ||
        path === paths.rpc)
    ) {
      throw new CheckFailed('native-page-access-denied', reply.status);
    }
    if (prompt) hello.accept(prompt, reply);
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
            isId(instance.id) &&
            Number.isSafeInteger(instance.revision) &&
            instance.revision > 0 &&
            isId(instance.source?.employeeVersionId),
          'employee-scope',
        );
        selection = {
          workspaceId: instance.workspaceId,
          employeeInstanceId: instance.id,
        };
        employeeVersion = {
          revision: instance.revision,
          id: instance.source.employeeVersionId,
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
          onColdTicket?.(data.operationId);
          pollAfterMs = data.pollAfterMs;
          lastPollResponseAt = performance.now();
          pollDeadline =
            lastPollResponseAt +
            Math.min(
              POLL_LIMIT_MS,
              Math.max(
                POLL_REQUEST_MS,
                Date.parse(ticket.expiresAt) - Date.now(),
              ),
            );
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
        poll.status = reply.status;
        poll.state = state ?? 'unrecognized';
        lastPollResponseAt = performance.now();
        requireFact(
          lastPollResponseAt <= pollDeadline + POLL_JITTER_MS,
          'poll-scope-or-budget',
        );
        pollAfterMs = Math.min(3000, pollAfterMs + 1000);
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
          if (onColdTicket) current().readyObservedAt = performance.now();
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
            [...url.searchParams].length === 3 &&
            sameSelection(query, selection) &&
            sameSelection(data?.identity, selection) &&
            Object.keys(data).length === 1 &&
            Object.keys(data.identity).length === 7 &&
            data.identity.personId === identity.personId &&
            data.identity.organizationId === identity.organizationId &&
            data.identity.employeeRevision === employeeVersion.revision &&
            data.identity.employeeVersionId === employeeVersion.id,
          'native-identity-scope',
        );
        current().identityVerified = true;
        break;
    }
    return reply;
  }

  return {
    request,
    muxRole,
    beginCarrier,
    openCarrier: (url, frame, exchange) =>
      beginCarrier(url, frame)(exchange(frame)),
    hasDocumentScope,
    selection: () => selection,
    warm: () => {
      previousScope = carrier.scopeId;
      carrier = undefined;
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
  onColdTicket,
  sendHello = false,
  beforeHello,
  reopenWarm = true,
  signal,
  launch = (options) => webRequire('playwright-core').chromium.launch(options),
}) {
  requireFact(!signal?.aborted, 'acceptance-interrupted');
  const browser = await launch({
    executablePath: browserExecutable,
    timeout: onColdTicket ? 30_000 : timeout,
    handleSIGINT: !onColdTicket,
    handleSIGTERM: !onColdTicket,
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
  const hello = sendHello ? createHelloProbe(receipt) : null;
  const flow = browserFlow({
    identity,
    account,
    employeeName,
    receipt,
    onColdTicket,
    hello,
  });
  function failure(error) {
    if (routeFailed) return;
    routeFailed = true;
    fail(stage, error);
    rejectNetwork(error);
  }
  const cancel = () => failure(new CheckFailed('acceptance-interrupted'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const guarded = (action) => Promise.race([action, networkFailure]);
  let context;
  let publicEditor;
  let pendingPrewarm;
  try {
    requireFact(!signal?.aborted, 'acceptance-interrupted');
    context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    context.setDefaultTimeout(timeout);
    await driver.install(context, {
      inspect: (request, exchange) => {
        requireFact(!routeFailed, 'request-after-failure');
        const result = flow.request(request, exchange);
        if (
          onColdTicket &&
          !pendingPrewarm &&
          request.method === 'POST' &&
          request.url.pathname === paths.prewarm
        )
          pendingPrewarm = result;
        return result;
      },
      openCarrier: (url, frame, exchange) => {
        requireFact(!routeFailed, 'request-after-failure');
        return flow.openCarrier(url, frame, exchange);
      },
      muxRole: (url) => {
        requireFact(!routeFailed, 'carrier-after-failure');
        return flow.muxRole(url);
      },
      beginCarrier: (url, frame) => {
        requireFact(!routeFailed, 'carrier-after-failure');
        return flow.beginCarrier(url, frame);
      },
      observeFollow: (sessionId, item) => hello?.follow(sessionId, item),
      followClosed: (sessionId) => hello?.closed(sessionId),
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
    if (onColdTicket)
      receipt.timings.loginToZeroEmployeeMs = duration(loginStart);
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
      const readEditor = () =>
        guarded(
          editor.evaluate((node) => {
            const view = node.ownerDocument.defaultView;
            return {
              source: view.frameElement?.src,
              loaded: node.ownerDocument.URL,
              scopeId: view.__ALLRICE_EMPLOYEE_DOCUMENT__?.scopeId,
              nativeSessionId: node.ownerDocument
                .querySelector('[data-native-session-id]')
                ?.getAttribute('data-native-session-id'),
              editable: node.isContentEditable,
              focused: node.ownerDocument.activeElement === node,
            };
          }),
        );
      const before = await readEditor();
      requireFact(flow.hasDocumentScope(before), 'native-document-scope');
      requireFact(before.editable, 'composer-not-editable');
      // Focus without inserting text, issuing keyboard shortcuts, or sending.
      await guarded(editor.focus());
      const after = await readEditor();
      requireFact(flow.hasDocumentScope(after), 'native-document-scope');
      requireFact(after.focused && after.editable, 'composer-not-focused');
      const url = new URL(page.url());
      requireFact(
        navigation(url, entry) &&
          sameSelection(
            Object.fromEntries(url.searchParams),
            flow.selection(),
          ) &&
          receipt.browser[phase].prewarmReady &&
          receipt.browser[phase].identityVerified &&
          receipt.browser[phase].carrierVerified,
        'composer-scope-unverified',
      );
      receipt.browser[phase].documentVerified = true;
      receipt.timings[`${phase}ToEditableMs`] = duration(start);
      if (onColdTicket && phase === 'cold') {
        receipt.timings.readyToEditableMs = duration(
          receipt.browser.cold.readyObservedAt,
        );
        delete receipt.browser.cold.readyObservedAt;
      }
      receipt.stages[`${phase}Editor`] = 'passed';
      return {
        child,
        editor,
        nativeSessionId: after.nativeSessionId,
        readEditor,
      };
    }
    const { child, editor, nativeSessionId, readEditor } = await focusedEditor(
      'cold',
      coldStart,
    );
    if (onColdTicket) publicEditor = editor;
    if (hello) {
      stage = 'hello';
      await guarded(beforeHello());
      const current = await readEditor();
      requireFact(
        flow.hasDocumentScope(current) &&
          current.nativeSessionId === nativeSessionId &&
          current.editable &&
          current.focused,
        'hello-native-session-unverified',
      );
      requireFact(
        !(await guarded(editor.innerText())).trim(),
        'hello-draft-not-empty',
      );
      await guarded(page.keyboard.insertText('你好'));
      requireFact(
        (await guarded(editor.innerText())).trim() === '你好',
        'hello-draft-mismatch',
      );
      const send = child.getByRole('button', {
        name: /^(发送消息|Send message)$/u,
      });
      await guarded(send.waitFor({ state: 'visible' }));
      requireFact(await guarded(send.isEnabled()), 'hello-send-disabled');
      hello.arm(nativeSessionId);
      await guarded(send.click());
      await guarded(
        Promise.race([
          (async () => {
            const turn = await hello.boundTurn;
            // Observe the pinned DSH ChatView's assistant turn and Markdown
            // wrapper. Reasoning disclosures have data-variant="think".
            const responses = child
              .locator(
                `[data-chat-flow-kind="assistant-step"][data-chat-turn="${turn}"]:not([data-chat-group-part="reasoning"]) [class~="MarkdownText_markdown"]:not([data-variant="think"] *):visible`,
              )
              .filter({ hasText: /\S/u });
            await responses.first().waitFor({ timeout: 120_000 });
            receipt.timings.helloToFirstReplyMs = hello.elapsed();
            await hello.complete;
            await child
              .locator(
                `[data-turn-tail="${turn}"][data-actions-reveal="always"]`,
              )
              .waitFor({ timeout: 120_000 });
            const final = await readEditor();
            requireFact(
              flow.hasDocumentScope(final) &&
                final.nativeSessionId === nativeSessionId &&
                (await responses.last().isVisible()),
              'hello-reply-not-visible',
            );
            receipt.timings.helloToCompleteReplyMs = hello.elapsed();
          })(),
          delay(120_000, undefined, { ref: false }).then(() => {
            throw new CheckFailed('hello-reply-timeout');
          }),
        ]),
      );
      receipt.stages.hello = 'passed';
    }
    if (reopenWarm) {
      flow.warm();
      stage = 'warmReopen';
      const warmStart = performance.now();
      await guarded(page.reload({ waitUntil: 'domcontentloaded' }));
      await focusedEditor('warm', warmStart);
    }
  } catch (error) {
    fail(stage, error);
    throw error;
  } finally {
    try {
      if (pendingPrewarm) {
        // Let the one already-dispatched request yield its actual ticket. A
        // lost reply is unknown ownership; no second POST is permitted.
        await Promise.race([
          pendingPrewarm.catch(() => {}),
          delay(POLL_REQUEST_MS, undefined, { ref: false }),
        ]);
      }
      if (publicEditor) {
        try {
          // Use the existing authenticated document carrier's completion
          // handshake before killing the Playwright context.
          const joined = await publicEditor.evaluate(
            (node) => {
              const view = node.ownerDocument.defaultView;
              const scopeId = view.__ALLRICE_EMPLOYEE_DOCUMENT__?.scopeId;
              return new Promise((resolve) => {
                let remoteClosed = false;
                let frameClosed = false;
                const finish = (closed) => {
                  view.clearTimeout(timer);
                  view.removeEventListener('message', receiveRemote);
                  view.parent.removeEventListener('message', receiveFrame);
                  resolve(closed);
                };
                const completion = (event, source) =>
                  scopeId &&
                  event.source === source &&
                  event.origin === view.location.origin &&
                  event.data?.scopeId === scopeId &&
                  event.data.type === 'allrice:d-entry:completion';
                const receiveRemote = (event) => {
                  if (!completion(event, view.parent)) return;
                  if (event.data.state !== 'closed') return finish(false);
                  remoteClosed = true;
                  if (frameClosed) finish(true);
                };
                const receiveFrame = (event) => {
                  if (!completion(event, view)) return;
                  if (event.data.state !== 'closed') return finish(false);
                  frameClosed = true;
                  if (remoteClosed) finish(true);
                };
                const timer = view.setTimeout(() => finish(false), 15_000);
                view.addEventListener('message', receiveRemote);
                view.parent.addEventListener('message', receiveFrame);
                // The actual native local entry closes on pagehide and asks
                // the parent carrier to join before it acknowledges disposal.
                view.dispatchEvent(new view.PageTransitionEvent('pagehide'));
              });
            },
            undefined,
            { timeout: 15_000 },
          );
          requireFact(joined, 'public-carrier-close-unconfirmed');
          receipt.browser.carrierJoined = true;
        } catch (error) {
          fail('carrierClose', error);
        }
      }
      await context?.close();
    } finally {
      try {
        await browser.close();
        receipt.browser.closed = true;
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    }
  }
}
