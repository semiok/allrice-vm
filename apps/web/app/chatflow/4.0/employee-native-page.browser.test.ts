import type { DEntryIdentity } from '@allrice/contracts';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
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
  pageCompletion,
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

async function exerciseMultiEmployeeNavigation(
  browser: Browser,
  origin: string,
  identity: DEntryIdentity,
) {
  const names = ['甲研究员', '乙编辑', '丙分析师', '丁文案', '戊顾问'];
  const employees = names.map((name) => ({
    id: randomUUID(),
    isDefault: false,
    currentVersion: { id: randomUUID(), manifest: { name } },
  }));
  const [a, b, c, d, e] = employees.map((employee) => employee.id) as [
    string,
    string,
    string,
    string,
    string,
  ];
  const threads = new Map<string, string>(
    [a, b, d, e].map((employee) => [employee, randomUUID()]),
  );
  const opens: string[] = [];
  const warmups: string[] = [];
  const creates: string[] = [];
  const capacityTicket = randomUUID();
  const capacityDeletes: string[] = [];
  const capacityCancellation = deferred<void>();
  const allowCapacityCancellation = deferred<void>();
  const firstClose = deferred<void>();
  const releaseClose = deferred<void>();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  try {
    await context.routeWebSocket(
      /\/api\/v1\/d-entry\/native-mux\?/,
      (socket) => {
        const employee = new URL(socket.url()).searchParams.get(
          'employeeInstanceId',
        )!;
        const scopeId = randomUUID();
        let streamId: string;
        socket.onMessage(async (raw) => {
          const packet = JSON.parse(raw.toString());
          const send = (message: object) =>
            socket.send(JSON.stringify({ streamId, ...message }));
          if (packet.type === 'open') {
            streamId = packet.streamId;
            opens.push(employee);
            send({
              type: 'item',
              value: {
                type: 'opened',
                scopeReference: { scopeId },
                bindingRef: 'test-owner',
              },
            });
          } else if (packet.type === 'end') {
            if (opens.length === 1) {
              firstClose.resolve();
              await releaseClose.promise;
            }
            send({ type: 'item', value: { type: 'closed', scopeId } });
            send({ type: 'end' });
            await socket.close({ code: 1000 });
          }
        });
      },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.addInitScript((completion) => {
      if (window !== window.top) return;
      addEventListener('message', (event) => {
        if (event.origin === location.origin && event.data?.type === completion)
          document.documentElement.dataset.fixtureOldDocumentClosed = 'yes';
        if (
          event.origin === location.origin &&
          event.data?.fixtureLate === true
        )
          document.documentElement.dataset.fixtureLateDelivered = 'yes';
      });
    }, pageCompletion);
    await page.route('**/api/v1/d-entry/native-prewarm', async (route) => {
      const { selection } = route.request().postDataJSON();
      warmups.push(selection.employeeInstanceId);
      if (selection.employeeInstanceId === c) {
        const attempt = warmups.filter((id) => id === c).length;
        if (attempt === 1) return route.fulfill({ status: 503 });
        if (attempt === 2)
          return route.fulfill({
            status: 202,
            json: {
              operationId: capacityTicket,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              pollAfterMs: 1000,
            },
          });
      }
      await route.fulfill({ status: 204 });
    });
    await page.route(
      '**/api/v1/d-entry/native-prewarm/status?**',
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        expect(url.origin).toBe(origin);
        expect(Object.fromEntries(url.searchParams)).toEqual({
          workspaceId: identity.workspaceId,
          employeeInstanceId: c,
          operationId: capacityTicket,
        });
        if (request.method() === 'DELETE') {
          capacityDeletes.push(request.method());
          capacityCancellation.resolve();
          await allowCapacityCancellation.promise;
          return route.fulfill({ status: 410, json: { state: 'expired' } });
        }
        expect(request.method()).toBe('GET');
        await route.fulfill({
          json: { state: 'waiting_for_capacity', activeLimit: 3 },
        });
      },
    );
    await page.route('**/api/v1/sessions?entry=4.0', async (route) => {
      const { selection, operationId } = route.request().postDataJSON();
      expect(selection).toEqual({
        workspaceId: identity.workspaceId,
        employeeInstanceId: c,
      });
      expect(operationId).toBeUndefined();
      creates.push(selection.employeeInstanceId);
      const threadId = randomUUID();
      threads.set(c, threadId);
      await route.fulfill({ json: { ...selection, threadId } });
    });
    await page.route('**/api/v1/d-entry/identity?**', async (route) => {
      const query = new URL(route.request().url()).searchParams;
      const employeeInstanceId = query.get('employeeInstanceId')!;
      const threadId = query.get('threadId');
      expect(threadId).toBe(threads.get(employeeInstanceId));
      expect(query.get('workspaceId')).toBe(identity.workspaceId);
      await route.fulfill({
        json: { identity: { ...identity, employeeInstanceId, threadId } },
      });
    });
    await page.route('**/chatflow/4.0/document?**', async (route) => {
      const query = new URL(route.request().url()).searchParams;
      const scopeId = query.get('scopeId');
      const employee = query.get('employeeInstanceId');
      const thread = query.get('threadId');
      const directory = {
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        viewerId: identity.personId,
        employees,
        sessions: [...threads].map(([employeeInstanceId, id]) => ({
          id,
          employeeInstanceId,
          employeeAssignmentId: employeeInstanceId,
          employeeVersionId: identity.employeeVersionId,
          title: '合成对话',
          ownerId: identity.personId,
          visibility: 'private',
          updatedAt: '2026-11-27T00:00:00.000Z',
          archivedAt: null,
        })),
      };
      await route.fulfill({
        contentType: 'text/html',
        body: [
          '<!doctype html><meta charset="utf-8">',
          '<script data-scope-id="' +
            scopeId +
            '">' +
            initialDocumentLifecycle +
            '</script>',
          '<div id="app" data-native-session-id="same-native-id" data-organization-id="' +
            identity.organizationId +
            '" data-viewer-id="' +
            identity.personId +
            '" data-workspace-id="' +
            identity.workspaceId +
            '" data-employee-instance-id="' +
            employee +
            '" data-thread-id="' +
            thread +
            '" data-scope-id="' +
            scopeId +
            '"></div>',
          '<script id="allrice-employee-directory" type="application/json">' +
            JSON.stringify(directory) +
            '</script>',
          '<script src="/outer.js"></script>',
        ].join(''),
      });
    });
    await page.goto(
      origin +
        '/chatflow/4.0?' +
        new URLSearchParams({
          workspaceId: identity.workspaceId,
          employeeInstanceId: a,
          threadId: threads.get(a)!,
        }),
    );
    const frame = page.frameLocator('iframe');
    const employeeButton = (index: number) =>
      frame.getByRole('treeitem').filter({ hasText: names[index]! }).first();
    const editor = frame.getByRole('textbox', { name: '消息' });
    await editor.waitFor();
    await editor.fill('甲的草稿');
    await employeeButton(1).evaluate((button, latest) => {
      if (!(button instanceof HTMLElement))
        throw new Error('Expected an employee card');
      button.click();
      const card = document.querySelector('[aria-label="' + latest + '"]')!;
      card.querySelector<HTMLElement>('[role=treeitem]')!.click();
    }, names[2]!);
    await firstClose.promise;
    await page.locator('html[data-fixture-old-document-closed="yes"]').waitFor({
      state: 'attached',
    });
    await frame.locator('#app').evaluate(
      (container, late) => {
        parent.postMessage(
          {
            type: late.type,
            scopeId: (container as HTMLElement).dataset.scopeId,
            selection: late.selection,
            fixtureLate: true,
          },
          location.origin,
        );
      },
      {
        type: pageNavigate,
        selection: { workspaceId: identity.workspaceId, employeeInstanceId: d },
      },
    );
    await page.locator('html[data-fixture-late-delivered="yes"]').waitFor({
      state: 'attached',
    });
    expect(warmups).toEqual([a]);
    releaseClose.resolve();
    await page
      .getByRole('alert')
      .getByText('可以点重试，或者返回员工页。')
      .waitFor();
    expect(warmups).toEqual([a, c]);
    expect(creates).toEqual([]);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    const waiting = page.getByRole('status');
    await waiting
      .getByRole('heading', { name: '正在等待工作台名额' })
      .waitFor();
    expect(
      await waiting
        .getByText(
          '当前工作台的 3 个运行名额已占用。有空位会自动继续，也可以取消等待。',
          {
            exact: true,
          },
        )
        .isVisible(),
    ).toBe(true);
    expect(creates).toEqual([]);
    await page.getByRole('button', { name: '取消等待', exact: true }).click();
    await capacityCancellation.promise;
    const continueButton = page.getByRole('button', {
      name: '继续',
      exact: true,
    });
    expect(await continueButton.isDisabled()).toBe(true);
    expect(capacityDeletes).toEqual(['DELETE']);
    expect(creates).toEqual([]);
    allowCapacityCancellation.resolve();
    await expect.poll(() => continueButton.isEnabled()).toBe(true);
    await continueButton.click();
    await editor.waitFor();
    expect(warmups).toEqual([a, c, c, c]);
    expect(await editor.inputValue()).toBe('');
    expect(creates).toEqual([c]);
    await editor.fill('丙的草稿');
    for (const [index, id] of [
      [1, b],
      [3, d],
      [4, e],
      [0, a],
      [2, c],
    ] as const) {
      await employeeButton(index).click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('employeeInstanceId'))
        .toBe(id);
      await frame.locator(`#app[data-employee-instance-id="${id}"]`).waitFor();
      await editor.waitFor();
      expect(await editor.inputValue()).toBe(
        id === a ? '甲的草稿' : id === c ? '丙的草稿' : '',
      );
    }
    expect(opens).toEqual([a, c, b, d, e, a, c]);
    expect(creates).toEqual([c]);
    const historyLength = await page.evaluate(() => history.length);
    const currentScope = await frame
      .locator('#app')
      .getAttribute('data-scope-id');
    await employeeButton(3).evaluate((row, current) => {
      if (!(row instanceof HTMLElement))
        throw Error('Expected an employee card');
      row.click();
      document
        .querySelector<HTMLElement>(
          '[aria-label="' + current + '"] [role=treeitem]',
        )!
        .click();
    }, names[2]!);
    await expect
      .poll(() => frame.locator('#app').getAttribute('data-scope-id'))
      .not.toBe(currentScope);
    await editor.waitFor();
    expect(opens).toEqual([a, c, b, d, e, a, c, c]);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await page.route('**/api/v1/employee-instances', (route) =>
      route.fulfill({ status: 401 }),
    );
    await frame.getByRole('button', { name: '创建员工', exact: true }).click();
    const dialog = frame.getByRole('dialog', { name: '创建 AI 员工' });
    await dialog.locator('[data-employee-name]').fill('资料专员');
    await dialog.getByRole('button', { name: '确认创建' }).click();
    await dialog
      .getByRole('alert')
      .getByText('登录已过期，请重新登录')
      .waitFor();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(await editor.inputValue()).toBe('丙的草稿');
  } finally {
    releaseClose.resolve();
    allowCapacityCancellation.resolve();
    await context.close();
  }
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
          import { useSyncExternalStore, useState } from 'react';
          import { EmployeeNativePage } from './app/chatflow/4.0/employee-native-page';
          import { EmployeeFirstStart } from './app/chatflow/4.0/employee-first-start';
          import { EmployeeCreateDialog } from './app/chatflow/employee-create-dialog';
          import { EmployeeSidebarView } from './app/chatflow/employee-sidebar-view';
          import { installEmployeeProductOwner } from '../../packages/dsh-web-composition/src/employee-product-owner';
          import { installEmployeeDraftStorage } from '../../packages/dsh-web-composition/src/employee-draft-storage';
          import { readEmployeeDocument } from './lib/d-entry/profile-browser';
          const app = document.getElementById('app');
          if (app) {
            const owner = window.__ALLRICE_EMPLOYEE_DOCUMENT__;
            window.__ALLRICE_D_ENTRY_LIFETIME__ = owner.signal;
            installEmployeeDraftStorage(readEmployeeDocument(app.dataset));
            const storageKey = 'dsh.conversation.fixture';
            const root = createRoot(app);
            function Sidebar({ port }) {
              const snapshot = useSyncExternalStore(port.subscribe, port.getSnapshot);
              const [draft, setDraft] = useState(() => localStorage.getItem(storageKey) ?? '');
              const [creating, setCreating] = useState(false);
              return snapshot && <><EmployeeSidebarView {...snapshot.tree} collapsed={false}/>
                {snapshot.error && <p role="alert">{snapshot.error}</p>}
                <button onClick={() => setCreating(true)}>创建员工</button>
                {creating && <EmployeeCreateDialog {...port.createEmployee} personal onClose={() => setCreating(false)}/>}
                <label>消息<input value={draft} onChange={e => {
                  setDraft(e.target.value); localStorage.setItem(storageKey, e.target.value);
                }}/></label></>;
            }
            installEmployeeProductOwner({ effect() {}, inject() {}, provide(name, port) {
              if (name !== 'allriceEmployeeSidebar') return;
              root.render(<Sidebar port={port}/>);
              parent.postMessage({type: '${pageEditorMounted}', scopeId: owner.scopeId}, location.origin);
            }});
          } else createRoot(document.getElementById('root')).render(location.search
            ? <EmployeeNativePage prepare query={location.search.slice(1)} />
            : <EmployeeFirstStart workspaceId={${JSON.stringify(workspaceId)}} organizationId={${JSON.stringify(f.identity.organizationId)}} viewerId={${JSON.stringify(f.identity.personId)}} />);`,
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
          if (warmCalls.length === 1 || warmCalls.length === 7)
            return response.writeHead(503).end();
          if (warmCalls.length === 2) {
            response.once('close', () => retryClosed.resolve());
            firstRetry.resolve(response);
            return;
          }
          // The foreground upgrade adds one ticket before switching chats.
          if (warmCalls.length >= 4 && warmCalls.length <= 6)
            return response
              .writeHead(202, { 'content-type': 'application/json' })
              .end(
                JSON.stringify({
                  operationId:
                    warmCalls.length <= 5 ? ticket : sameEmployeeTicket,
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                  pollAfterMs: 1000,
                }),
              );
          if (warmCalls.length === 9) {
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
          if (++polls === 1)
            return json({ state: 'failed', code: 'UPGRADE_OPEN_REQUIRED' });
          if (polls === 2) {
            await allowStarting.promise;
            return json({ state: 'restarting' });
          }
          await allowReady.promise;
          if (polls === 3) return response.writeHead(503).end();
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
      const extensionHint =
        '如果一直打不开，请关闭浏览器扩展或者用无痕窗口再试';
      expect(await page.getByText(extensionHint, { exact: true }).count()).toBe(
        0,
      );
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
          .getByText(extensionHint, { exact: true })
          .isVisible(),
      ).toBe(true);
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
        await page
          .getByRole('button', { name: '打开员工', exact: true })
          .waitFor();
        expect(warmCalls).toHaveLength(4);
        await page
          .getByRole('button', { name: '打开员工', exact: true })
          .click();
        allowStarting.resolve();
        await assertWaiting(
          '版本已更新，正在重新启动员工',
          '重启后会继续打开工作台。',
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
      expect(polls).toBe(3);
      expect(warmCalls).toHaveLength(5);
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
      expect(polls).toBe(4);
      expect(warmCalls).toHaveLength(5);
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
      await expect.poll(() => warmCalls.length).toBe(6);
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
        [employee, employee, employee, f.selection, f.selection, employee].map(
          (selection, index) => ({
            selection,
            trigger: index === 4 ? 'open' : 'page',
          }),
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
      expect(warmCalls.slice(6)).toEqual([
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
      expect(warmCalls.slice(8)).toEqual([
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

      for (const [code, title] of [
        [400, '暂时打不开这条对话'],
        [401, '请重新登录'],
        [403, '当前请求未获授权'],
        [404, '暂时打不开这条对话'],
      ] as const) {
        const unavailable = await context.newPage();
        try {
          await unavailable.route('**/api/v1/d-entry/native-prewarm', (route) =>
            route.fulfill({ status: code }),
          );
          await unavailable.goto(
            f.origin + '/chatflow/4.0?' + new URLSearchParams(f.selection),
          );
          const signIn = code === 401;
          await unavailable
            .getByRole('alert')
            .getByRole('heading', {
              name: title,
              exact: true,
            })
            .waitFor();
          if (code !== 403)
            expect(
              await unavailable
                .getByRole('link', {
                  name: signIn ? '重新登录' : '返回员工页',
                  exact: true,
                })
                .getAttribute('href'),
            ).toBe(signIn ? '/login?next=%2Fchatflow%2F4.0' : '/chatflow/4.0');
          expect(
            await unavailable.getByText(extensionHint, { exact: true }).count(),
          ).toBe(0);
          expect(await unavailable.locator('iframe').count()).toBe(0);
        } finally {
          await unavailable.close();
        }
      }

      for (const source of ['new-thread', 'identity'] as const) {
        const mismatchedEntry = await context.newPage();
        try {
          await mismatchedEntry.route(
            '**/api/v1/d-entry/native-prewarm',
            (route) => route.fulfill({ status: 204 }),
          );
          const anotherThreadId = randomUUID();
          const query = new URLSearchParams(employee);
          if (source === 'new-thread') {
            query.set('new', randomUUID());
            await mismatchedEntry.route(
              (url) =>
                url.pathname === '/api/v1/sessions' &&
                url.search === '?entry=4.0',
              (route) =>
                route.fulfill({
                  json: { ...employee, threadId: anotherThreadId },
                }),
            );
          } else {
            query.set('threadId', f.selection.threadId);
            await mismatchedEntry.route(
              '**/api/v1/d-entry/identity?*',
              (route) =>
                route.fulfill({
                  json: {
                    identity: {
                      ...f.selectionIdentity(f.selection),
                      threadId: anotherThreadId,
                    },
                  },
                }),
            );
          }
          await mismatchedEntry.goto(f.origin + '/chatflow/4.0?' + query);
          await mismatchedEntry
            .getByRole('alert')
            .getByRole('heading', {
              name: '暂时打不开这条对话',
              exact: true,
            })
            .waitFor();
          expect(await mismatchedEntry.locator('iframe').count()).toBe(0);
        } finally {
          await mismatchedEntry.close();
        }
      }

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

      const disconnected = await context.newPage();
      const pageSocket = deferred<Duplex>();
      const capture = (_request: IncomingMessage, socket: Duplex) =>
        pageSocket.resolve(socket);
      f.web.once('upgrade', capture);
      try {
        await disconnected.route('**/api/v1/d-entry/native-prewarm', (route) =>
          route.fulfill({ status: 204 }),
        );
        const url =
          f.origin + '/chatflow/4.0?' + new URLSearchParams(f.selection);
        const markReady = () =>
          disconnected
            .frameLocator('iframe')
            .locator('body[data-mount-ready=yes]')
            .evaluate(() => {
              Reflect.get(window, 'publishMount')();
              return Reflect.get(window, '__ALLRICE_EMPLOYEE_DOCUMENT__')
                .scopeId as string;
            });
        await disconnected.goto(url);
        const socket = await pageSocket.promise;
        const oldScope = await markReady();
        await disconnected.locator('iframe').waitFor({ state: 'visible' });
        const before = documents.length;
        await disconnected.evaluate(() => {
          document.documentElement.dataset.oldDocument = 'yes';
        });

        // Drop the real browser-to-Web socket before a closed/end exchange.
        socket.destroy();
        await disconnected
          .getByRole('alert')
          .getByText('无法确认旧连接已关闭。', { exact: true })
          .waitFor();
        expect(
          await disconnected.getByRole('button', { name: '重试' }).count(),
        ).toBe(0);
        expect(documents).toHaveLength(before);

        const reload = disconnected.getByRole('button', {
          name: '刷新页面',
          exact: true,
        });
        expect(await reload.count()).toBe(1);
        await reload.click();
        await disconnected.waitForSelector('html:not([data-old-document])');
        expect(disconnected.url()).toBe(url);
        expect(await markReady()).not.toBe(oldScope);
        await disconnected.locator('iframe').waitFor({ state: 'visible' });
        expect(documents).toHaveLength(before + 1);
      } finally {
        f.web.off('upgrade', capture);
        await disconnected.close();
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

      await exerciseMultiEmployeeNavigation(browser, f.origin, f.identity);
      await page.route('**/api/v1/auth/session', (route) =>
        route.fulfill({ status: 401 }),
      );
      await page.route(f.origin + '/chatflow/4.0', (route) =>
        route.fulfill({ status: 307, headers: { location: '/login' } }),
      );
      await page.route('**/login', (route) =>
        route.fulfill({ body: 'synthetic login' }),
      );
      f.identityRevoked.abort();
      await page.waitForURL(f.origin + '/login');
    },
  );
});
