import { createRequire } from 'node:module';
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
          createRoot(document.getElementById('root')).render(<EmployeeNativePage prepare query={location.search.slice(1)} />);`,
            loader: 'tsx',
            resolveDir: join(process.cwd(), 'apps/web'),
          },
          bundle: true,
          write: false,
          outdir: '/employee-entry-test',
          jsx: 'automatic',
        });
      const firstRetry = deferred<ServerResponse>();
      const retryClosed = deferred<void>();
      let opening = false;
      const allowOpening = deferred<void>();
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
          if (warmCalls.length === 1) return response.writeHead(503).end();
          if (warmCalls.length === 2) {
            response.once('close', () => retryClosed.resolve());
            firstRetry.resolve(response);
            return;
          }
          return response.writeHead(204).end();
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
      });
      await context.addCookies([
        { name: 'allrice_session', value: sessionToken, url: f.origin },
      ]);
      const page = await context.newPage();
      await page.goto(
        f.origin + '/chatflow/4.0?' + new URLSearchParams(employee),
      );
      await page
        .getByRole('alert')
        .getByRole('heading', { name: '暂时无法打开工作台' })
        .waitFor();
      expect(births).toEqual([]);
      await page.getByRole('button', { name: '重试' }).click();
      const held = await firstRetry.promise;
      await page.getByRole('heading', { name: '正在启动工作台' }).waitFor();
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
      await page.getByRole('button', { name: '继续' }).click();
      async function showEditor(threadId: string) {
        await page.getByRole('heading', { name: '正在打开对话' }).waitFor();
        const iframe = page.locator('iframe');
        await iframe.waitFor({ state: 'attached' });
        const source = new URL((await iframe.getAttribute('src'))!, f.origin);
        expect(source.searchParams.get('threadId')).toBe(threadId);
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
      await page
        .frameLocator('iframe')
        .getByRole('button', { name: '新建对话' })
        .click();
      await page.waitForURL((url) => url.searchParams.has('new'));
      const next = new URL(page.url()).searchParams.get('new')!;
      expect(next).not.toBe(f.selection.threadId);
      await showEditor(next);
      expect(
        (await f.invokeThread(oldScope, f.selection.threadId)).status,
      ).toBe(404);
      expect(new URL(page.url()).searchParams.get('threadId')).toBe(next);
      expect(births).toEqual([
        { selection: employee },
        { selection: employee },
        { selection: employee, operationId: next },
      ]);
      expect(warmCalls).toEqual(
        Array.from({ length: 5 }, () => ({
          selection: employee,
          trigger: 'page',
        })),
      );
      expect(documents).toEqual([f.selection.threadId, next]);
    },
  );
});
