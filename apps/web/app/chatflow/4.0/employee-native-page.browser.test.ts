import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Browser } from '../../../../worker/node_modules/playwright-core/index.js';
import { describe, expect, it } from 'vitest';
import {
  closes,
  fixture,
  sessionToken,
} from '../../../../worker/src/d-entry/principal-page-carrier.fixture';
import { deferred } from '../../../../../packages/d-entry-principal/test/host-fixture';
import { initialDocumentLifecycle } from '../../../lib/d-entry/initial-document';
import {
  pageClosing,
  pageEditorMounted,
  pageNavigate,
} from '../../../lib/d-entry/page-messages';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;

async function readJson(request: IncomingMessage): Promise<unknown> {
  const bytes: Buffer[] = [];
  for await (const chunk of request) bytes.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(bytes).toString());
}

suite('4.0 browser cold entry', () => {
  it(
    'waits, cancels and retries prewarm, then opens the first and next owned page',
    { timeout: 45_000 },
    async () => {
      const f = await fixture();
      const { workspaceId, employeeInstanceId } = f.selection;
      const employee = { workspaceId, employeeInstanceId };
      const require = createRequire(
        new URL(
          '../../../../../packages/dsh-web-composition/package.json',
          import.meta.url,
        ),
      );
      const bundle: { outputFiles: { path: string; text: string }[] } =
        await require('esbuild').build({
          stdin: {
            contents: `import { createRoot } from 'react-dom/client';
          import { EmployeeNativePage } from './app/chatflow/4.0/employee-native-page';
          import { EmployeeFirstStart } from './app/chatflow/4.0/employee-first-start';
          createRoot(document.getElementById('root')).render(location.search
            ? <EmployeeNativePage prepare query={location.search.slice(1)} />
            : <EmployeeFirstStart workspaceId={${JSON.stringify(workspaceId)}} organizationId={${JSON.stringify(f.identity.organizationId)}} viewerId={${JSON.stringify(f.identity.personId)}} creationBlocked={location.pathname === '/creation-limited'} />);`,
            loader: 'tsx',
            resolveDir: join(process.cwd(), 'apps/web'),
          },
          bundle: true,
          write: false,
          outdir: '/employee-entry-test',
          jsx: 'automatic',
          loader: {
            '.woff': 'dataurl',
            '.woff2': 'dataurl',
            '.ttf': 'dataurl',
          },
        });
      const firstRetry = deferred<ServerResponse>();
      const retryClosed = deferred<void>();
      const supersededWarmup = deferred<ServerResponse>();
      const supersededClosed = deferred<void>();
      let opening = false;
      const allowOpening = deferred<void>();
      const allowStarting = deferred<void>();
      const allowReady = deferred<void>();
      const ticket = randomUUID();
      const sameEmployeeTicket = randomUUID();
      const sameEmployeeStarting = deferred<void>();
      const sameEmployeeReady = deferred<void>();
      let polls = 0;
      let sameEmployeePolls = 0;
      const warmCalls: unknown[] = [],
        births: unknown[] = [],
        documents: string[] = [];
      f.web.on('request', async (request, response) => {
        const address = new URL(request.url!, f.origin);
        const json = (body: unknown) =>
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(body));
        const html = (body: string) =>
          response
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end(body);
        if (address.pathname === '/api/v1/d-entry/native-prewarm') {
          warmCalls.push(await readJson(request));
          if (warmCalls.length === 1 || warmCalls.length === 6)
            return response.writeHead(503).end();
          if (warmCalls.length === 2) {
            response.once('close', () => retryClosed.resolve());
            firstRetry.resolve(response);
            return;
          }
          if (warmCalls.length === 4 || warmCalls.length === 5)
            return response
              .writeHead(202, { 'content-type': 'application/json' })
              .end(
                JSON.stringify({
                  operationId:
                    warmCalls.length === 4 ? ticket : sameEmployeeTicket,
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                  pollAfterMs: 1000,
                }),
              );
          if (warmCalls.length === 8) {
            response.once('close', () => supersededClosed.resolve());
            supersededWarmup.resolve(response);
            return;
          }
          return response.writeHead(204).end();
        }
        if (address.pathname === '/api/v1/d-entry/native-prewarm/status') {
          if (request.method !== 'GET') return response.writeHead(404).end();
          if (address.searchParams.get('operationId') === sameEmployeeTicket) {
            if (++sameEmployeePolls === 1) return json({ state: 'starting' });
            sameEmployeeStarting.resolve();
            await sameEmployeeReady.promise;
            return json({ state: 'ready' });
          }
          if (address.searchParams.get('operationId') !== ticket)
            return response.writeHead(404).end();
          if (++polls === 1) {
            await allowStarting.promise;
            return json({ state: 'starting' });
          }
          await allowReady.promise;
          if (polls === 2) return response.writeHead(503).end();
          return json({ state: 'ready' });
        }
        if (
          address.pathname === '/api/v1/sessions' &&
          address.search === '?entry=4.0'
        ) {
          const input = (await readJson(request)) as {
            operationId?: string;
          };
          births.push(input);
          const threadId = input.operationId ?? f.selection.threadId;
          if (input.operationId) f.registerThread(threadId);
          return json({ ...employee, threadId });
        }
        if (address.pathname === '/api/v1/d-entry/identity')
          return json({
            identity: f.selectionIdentity(
              Object.fromEntries(address.searchParams),
            ),
          });
        if (address.pathname === '/chatflow/4.0/document') {
          const scopeId = address.searchParams.get('scopeId')!;
          documents.push(address.searchParams.get('threadId')!);
          return html(`<!doctype html><head><script data-scope-id="${scopeId}">${initialDocumentLifecycle}</script></head>
          <body><button id="new">新建对话</button><label>消息<textarea></textarea></label>
          <script>
            window.publishMount = () => parent.postMessage(${JSON.stringify({ type: pageEditorMounted, scopeId })}, location.origin);
            document.querySelector('#new').onclick = () => parent.postMessage(${JSON.stringify({ type: pageNavigate, scopeId, selection: employee })}, location.origin);
            document.body.dataset.mountReady = 'yes';
          </script>`);
        }
        if (
          address.pathname === '/outer.js' ||
          address.pathname === '/outer.css'
        ) {
          const css = address.pathname.endsWith('.css');
          return response
            .writeHead(200, {
              'content-type': css ? 'text/css' : 'application/javascript',
            })
            .end(
              bundle.outputFiles.find((file) =>
                file.path.endsWith(css ? '.css' : '.js'),
              )!.text,
            );
        }
        if (address.pathname === '/chatflow' && !address.search)
          return response.writeHead(307, { location: '/chatflow/4.0' }).end();
        return html(
          '<!doctype html><link rel="stylesheet" href="/outer.css"><div id="root"></div><script src="/outer.js"></script>',
        );
      });
      const executablePath =
        process.env.ALLRICE_BROWSER_EXECUTABLE ??
        process.env.ALLRICE_MANAGED_BROWSER_EXECUTABLE;
      if (!executablePath)
        throw Error('Locked Chromium executable is required');
      const browser: Browser = await require('playwright-core').chromium.launch(
        { executablePath },
      );
      closes.push(() => browser.close());
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        reducedMotion: 'no-preference',
      });
      await context.addCookies([
        { name: 'allrice_session', value: sessionToken, url: f.origin },
      ]);
      const page = await context.newPage();
      const status = page.getByRole('status');
      const spinner = status.locator('[data-state="ongoing"]');
      async function assertWaiting(title: string, description: string) {
        await status
          .getByRole('heading', { name: title, exact: true })
          .waitFor();
        expect(
          await status.getByText(description, { exact: true }).isVisible(),
        ).toBe(true);
        expect(await status.getAttribute('aria-atomic')).toBe('true');
        expect(await spinner.getAttribute('aria-hidden')).toBe('true');
      }
      await page.addInitScript(() => {
        if (window.top === window && !sessionStorage.getItem('entry-visible'))
          Object.defineProperty(document, 'hidden', {
            configurable: true,
            value: true,
          });
      });
      await page.goto(
        f.origin + '/chatflow/4.0?' + new URLSearchParams(employee),
      );
      await assertWaiting('正在打开对话', '马上就好。');
      const animations = () =>
        spinner.evaluate(
          (element) => element.getAnimations({ subtree: true }).length,
        );
      await expect.poll(animations).toBeGreaterThan(0);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect.poll(animations).toBe(0);
      await assertWaiting('正在打开对话', '马上就好。');
      await page.evaluate(
        () => new Promise((painted) => requestAnimationFrame(painted)),
      );
      expect(warmCalls).toEqual([]);
      await page.evaluate(() => {
        sessionStorage.setItem('entry-visible', '1');
        Object.defineProperty(document, 'hidden', { value: false });
        document.dispatchEvent(new Event('visibilitychange'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page
        .getByRole('alert')
        .getByRole('heading', { name: '暂时打不开工作台', exact: true })
        .waitFor();
      expect(
        await page
          .getByRole('alert')
          .getByText('可以点重试，或者返回员工页。', { exact: true })
          .isVisible(),
      ).toBe(true);
      expect(births).toEqual([]);
      await page.getByRole('button', { name: '重试' }).click();
      const held = await firstRetry.promise;
      await page.getByRole('heading', { name: '正在打开对话' }).waitFor();
      await page.getByRole('button', { name: '取消等待' }).click();
      await retryClosed.promise;
      expect(held.writableFinished).toBe(false);
      expect(births).toEqual([]);
      expect(documents).toEqual([]);
      const watch = f.deps.watch.getMockImplementation()!;
      f.deps.watch.mockImplementationOnce(async () => {
        opening = true;
        await allowOpening.promise;
        return watch();
      });
      try {
        await page.getByRole('button', { name: '继续' }).click();
        await expect.poll(() => opening).toBe(true);
        expect(documents).toEqual([]);
        await page.getByRole('button', { name: '取消等待' }).click();
        expect(
          await page.getByRole('button', { name: '继续' }).isDisabled(),
        ).toBe(true);
      } finally {
        allowOpening.resolve();
      }
      await expect
        .poll(() => page.getByRole('button', { name: '继续' }).isEnabled())
        .toBe(true);
      expect(f.owner.acquirePrincipal).toHaveBeenCalledTimes(1);
      expect(documents).toEqual([]);
      const birthsBeforePolling = births.slice();
      await page.getByRole('button', { name: '继续' }).click();
      try {
        await assertWaiting('正在准备你的工作台', '准备好会自动打开对话。');
        allowStarting.resolve();
        await assertWaiting(
          '正在启动工作台',
          '第一次启动需要一两分钟，留在这页就行。',
        );
        expect(
          await page.getByRole('button', { name: '取消等待' }).isEnabled(),
        ).toBe(true);
        expect(documents).toEqual([]);
      } finally {
        allowStarting.resolve();
        allowReady.resolve();
      }
      const pollingFailure = page.getByRole('alert');
      await pollingFailure
        .getByRole('heading', { name: '暂时打不开工作台', exact: true })
        .waitFor();
      expect(
        await pollingFailure
          .getByText('可以点重试，或者返回员工页。', { exact: true })
          .isVisible(),
      ).toBe(true);
      expect(
        await page
          .getByRole('link', { name: '返回员工页', exact: true })
          .getAttribute('href'),
      ).toBe('/chatflow/4.0');
      expect(polls).toBe(2);
      expect(warmCalls).toHaveLength(4);
      expect(births).toEqual(birthsBeforePolling);
      await page.getByRole('button', { name: '重试', exact: true }).click();
      async function showEditor(threadId: string) {
        await assertWaiting('工作台已就绪', '正在打开对话。');
        const iframe = page.locator('iframe');
        await iframe.waitFor({ state: 'attached' });
        const currentDocument = () =>
          iframe.evaluate(
            (node) => (node as HTMLIFrameElement).contentDocument?.URL,
          );
        await expect
          .poll(async () => {
            const url = await currentDocument();
            return url && new URL(url, f.origin).searchParams.get('threadId');
          })
          .toBe(threadId);
        const source = new URL((await currentDocument())!, f.origin);
        expect(await iframe.isVisible()).toBe(false);
        const child = page.frameLocator('iframe');
        await child
          .locator('body[data-mount-ready=yes]')
          .evaluate(() =>
            (window as unknown as { publishMount(): void }).publishMount(),
          );
        await iframe.waitFor({ state: 'visible' });
        await child
          .getByRole('textbox', { name: '消息' })
          .fill('第一条工作消息');
        expect(
          await child.getByRole('textbox', { name: '消息' }).inputValue(),
        ).toBe('第一条工作消息');
        const scopeId = source.searchParams.get('scopeId')!;
        expect((await f.invokeThread(scopeId, threadId)).status).toBe(200);
        return scopeId;
      }
      const oldScope = await showEditor(f.selection.threadId);
      const originalFrame = page.locator('iframe');
      await originalFrame.evaluate((node) => {
        (node as HTMLIFrameElement).dataset.retainedFrameProof = 'current';
      });
      expect(polls).toBe(3);
      expect(warmCalls).toHaveLength(4);
      const oldDocument = page.frameLocator('iframe').locator('body');
      const claim = () =>
        oldDocument.evaluate(() =>
          (
            window as unknown as {
              __ALLRICE_EMPLOYEE_DOCUMENT__: { claim(): boolean };
            }
          ).__ALLRICE_EMPLOYEE_DOCUMENT__.claim(),
        );
      const finish = () =>
        oldDocument.evaluate(() => {
          (
            window as unknown as {
              __ALLRICE_EMPLOYEE_DOCUMENT__: { finish(state: 'closed'): void };
            }
          ).__ALLRICE_EMPLOYEE_DOCUMENT__.finish('closed');
        });
      expect(await claim()).toBe(true);
      await page
        .frameLocator('iframe')
        .getByRole('button', { name: '新建对话' })
        .click();
      await expect.poll(() => warmCalls.length).toBe(5);
      expect(births).toEqual([{ selection: employee }]);
      expect(documents).toEqual([f.selection.threadId]);
      expect(new URL(page.url()).searchParams.get('threadId')).toBe(
        f.selection.threadId,
      );
      await finish();
      await page.waitForURL((url) => url.searchParams.has('new'));
      const next = new URL(page.url()).searchParams.get('new')!;
      expect(next).not.toBe(f.selection.threadId);
      try {
        await sameEmployeeStarting.promise;
        await assertWaiting('正在打开对话', '马上就好。');
        expect(
          await page.getByRole('heading', { name: '正在启动工作台' }).count(),
        ).toBe(0);
        expect(documents).toEqual([f.selection.threadId]);
      } finally {
        sameEmployeeReady.resolve();
      }
      const newScope = await showEditor(next);
      expect(newScope).not.toBe(oldScope);
      expect(
        await originalFrame.getAttribute('data-retained-frame-proof'),
      ).toBe('current');
      expect(
        (await f.invokeThread(oldScope, f.selection.threadId)).status,
      ).toBe(404);
      expect(
        (await f.invokeThread(newScope, f.selection.threadId)).status,
      ).toBe(404);
      expect(new URL(page.url()).searchParams.get('threadId')).toBe(next);
      expect(births).toEqual([
        { selection: employee },
        { selection: employee, operationId: next },
      ]);
      expect(warmCalls).toEqual(
        [employee, employee, employee, f.selection, employee].map(
          (selection) => ({ selection, trigger: 'page' }),
        ),
      );
      expect(documents).toEqual([f.selection.threadId, next]);

      await page
        .frameLocator('iframe')
        .getByRole('button', { name: '新建对话' })
        .click();
      await page
        .getByRole('alert')
        .getByRole('heading', { name: '暂时打不开工作台', exact: true })
        .waitFor();
      expect(births).toHaveLength(2);

      await page.evaluate(() => history.back());
      await page.waitForURL((url) => url.searchParams.get('threadId') === next);
      await showEditor(next);
      expect(births).toHaveLength(2);
      expect(warmCalls.slice(5)).toEqual([
        { selection: employee, trigger: 'page' },
        { selection: { ...employee, threadId: next }, trigger: 'page' },
      ]);

      expect(await claim()).toBe(true);
      try {
        await page
          .frameLocator('iframe')
          .getByRole('button', { name: '新建对话' })
          .click();
        const waiting = await supersededWarmup.promise;
        await page.evaluate(() => history.back());
        await page.waitForURL(
          (url) => url.searchParams.get('threadId') === f.selection.threadId,
        );
        await supersededClosed.promise;
        expect(waiting.writableFinished).toBe(false);
        expect(births).toHaveLength(2);
      } finally {
        await finish();
      }
      await showEditor(f.selection.threadId);
      expect(warmCalls.slice(7)).toEqual([
        { selection: employee, trigger: 'page' },
        { selection: f.selection, trigger: 'page' },
      ]);
      expect(births).toHaveLength(2);

      const returnPage = await context.newPage();
      await returnPage.route('**/api/v1/d-entry/native-prewarm', (route) =>
        route.fulfill({ status: 503 }),
      );
      await returnPage.goto(
        f.origin + '/chatflow/4.0?' + new URLSearchParams(employee),
      );
      const back = returnPage.getByRole('link', {
        name: '返回员工页',
        exact: true,
      });
      await back.press('Enter');
      await returnPage.waitForURL(
        (url) => url.pathname === '/chatflow/4.0' && !url.search,
      );
      await returnPage.close();

      const stalledDocument = await context.newPage();
      const waitingDocument = deferred<URL>();
      const releaseDocument = deferred<void>();
      await stalledDocument.route('**/api/v1/d-entry/native-prewarm', (route) =>
        route.fulfill({ status: 204 }),
      );
      await stalledDocument.route(
        '**/chatflow/4.0/document?*',
        async (route) => {
          waitingDocument.resolve(new URL(route.request().url()));
          await releaseDocument.promise;
          await route.abort().catch(() => {});
        },
      );
      try {
        await stalledDocument.goto(
          f.origin + '/chatflow/4.0?' + new URLSearchParams(f.selection),
          { waitUntil: 'domcontentloaded' },
        );
        const documentUrl = await waitingDocument.promise;
        const scopeId = documentUrl.searchParams.get('scopeId')!;
        expect(
          (await f.invokeThread(scopeId, f.selection.threadId)).status,
        ).toBe(200);
        await stalledDocument.getByRole('button', { name: '取消等待' }).click();
        const resume = stalledDocument.getByRole('button', { name: '继续' });
        await expect.poll(() => resume.isEnabled()).toBe(true);
        expect(
          (await f.invokeThread(scopeId, f.selection.threadId)).status,
        ).toBe(404);
        expect(await stalledDocument.locator('iframe').count()).toBe(0);
      } finally {
        releaseDocument.resolve();
        await stalledDocument.close();
      }

      const stalledClose = await context.newPage();
      try {
        await stalledClose.route('**/api/v1/d-entry/native-prewarm', (route) =>
          route.fulfill({ status: 204 }),
        );
        await stalledClose.clock.install();
        await stalledClose.goto(
          f.origin + '/chatflow/4.0?' + new URLSearchParams(f.selection),
        );
        const child = stalledClose.frameLocator('iframe');
        const body = child.locator('body[data-mount-ready=yes]');
        await body.evaluate((_, type) => {
          const owner = Reflect.get(window, '__ALLRICE_EMPLOYEE_DOCUMENT__');
          owner.claim();
          parent.postMessage({ type, scopeId: owner.scopeId }, location.origin);
        }, pageClosing);
        const failure = stalledClose.getByRole('heading', {
          name: '暂时打不开工作台',
          exact: true,
        });
        await failure.waitFor();
        expect(
          await stalledClose.getByRole('button', { name: '重试' }).isDisabled(),
        ).toBe(true);
        await stalledClose.clock.fastForward(10_000);
        await stalledClose
          .getByRole('heading', { name: '正在结束上一次连接' })
          .waitFor();
        await stalledClose.clock.fastForward(50_000);
        await stalledClose
          .getByRole('alert')
          .getByText('无法确认旧连接已关闭。')
          .waitFor();
        expect(
          await stalledClose.getByRole('button', { name: '重试' }).count(),
        ).toBe(0);
        await body.evaluate(() =>
          Reflect.get(window, '__ALLRICE_EMPLOYEE_DOCUMENT__').finish('closed'),
        );
        await failure.waitFor();
        await expect
          .poll(() =>
            stalledClose.getByRole('button', { name: '重试' }).isEnabled(),
          )
          .toBe(true);
      } finally {
        await stalledClose.close();
      }

      const firstStart = await context.newPage();
      try {
        const { organizationId, personId, employeeVersionId } = f.identity;
        let payload: Record<string, unknown> | undefined;
        await firstStart.route(
          '**/api/v1/employee-instances',
          async (route) => {
            expect(route.request().method()).toBe('POST');
            expect(route.request().headers()['x-allrice-organization-id']).toBe(
              organizationId,
            );
            expect(route.request().headers()['x-allrice-workspace-id']).toBe(
              workspaceId,
            );
            payload = route.request().postDataJSON();
            const version = { kind: 'tenant_version', employeeVersionId };
            const now = new Date().toISOString();
            await route.fulfill({
              status: 201,
              json: {
                instance: {
                  id: employeeInstanceId,
                  assignmentId: employeeInstanceId,
                  organizationId,
                  workspaceId,
                  ownerId: personId,
                  kind: 'custom',
                  revision: 1,
                  profile: payload?.profile,
                  source: version,
                  creationSource: version,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            });
          },
        );
        const previousBirths = births.length;
        await firstStart.goto(f.origin + '/chatflow');
        await firstStart
          .getByRole('heading', { name: '新建你的第一个员工', exact: true })
          .waitFor();
        await firstStart
          .getByText('给员工起个名字，建好后就能打开工作台。', { exact: true })
          .waitFor();
        await firstStart
          .getByRole('button', { name: '创建员工', exact: true })
          .click();
        const dialog = firstStart.getByRole('dialog', {
          name: '创建 AI 员工',
          exact: true,
        });
        await dialog
          .getByPlaceholder('例如：文案专家、财务专员', { exact: true })
          .fill('文案专家');
        await dialog
          .getByRole('button', { name: '确认创建', exact: true })
          .click();
        await firstStart.waitForURL(
          (url) =>
            url.pathname === '/chatflow/4.0' &&
            url.searchParams.get('employeeInstanceId') === employeeInstanceId,
        );
        const frame = firstStart.frameLocator('iframe');
        await frame
          .locator('body[data-mount-ready=yes]')
          .evaluate(() =>
            (window as unknown as { publishMount(): void }).publishMount(),
          );
        await frame.getByRole('textbox', { name: '消息' }).waitFor();
        expect(births.slice(previousBirths)).toEqual([{ selection: employee }]);
        expect(payload).toMatchObject({
          workspaceId,
          profile: { name: '文案专家' },
        });
        expect(payload).not.toHaveProperty('assignmentId');
        expect(payload).toHaveProperty('expectedOwnerId', f.identity.personId);
      } finally {
        await firstStart.close();
      }

      const limited = await context.newPage();
      try {
        const createRequests: string[] = [];
        await limited.route('**/api/v1/employee-instances', async (route) => {
          createRequests.push(route.request().method());
          await route.abort();
        });
        await limited.goto(f.origin + '/creation-limited');
        const notice = limited.getByRole('status').filter({
          hasText: '暂时每人只能创建一个 4.0 员工，多员工马上开放。',
        });
        await notice.waitFor();
        expect(await notice.textContent()).toBe(
          '暂时每人只能创建一个 4.0 员工，多员工马上开放。',
        );
        expect(
          await limited
            .getByRole('button', { name: '创建员工', exact: true })
            .count(),
        ).toBe(0);
        expect(await limited.getByRole('dialog').count()).toBe(0);
        expect(createRequests).toEqual([]);
      } finally {
        await limited.close();
      }
    },
  );
});
