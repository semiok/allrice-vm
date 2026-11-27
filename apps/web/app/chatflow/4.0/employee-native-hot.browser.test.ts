import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser } from '../../../../worker/node_modules/playwright-core/index.js';
import { describe, expect, it } from 'vitest';
import {
  closes,
  fixture,
  sessionToken,
} from '../../../../worker/src/d-entry/principal-page-carrier.fixture';
import { initialDocumentLifecycle } from '../../../lib/d-entry/initial-document';
import {
  pageEditorMounted,
  pageNavigate,
} from '../../../lib/d-entry/page-messages';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;

suite('4.0 browser entry with a running employee', () => {
  it(
    'records warm opens and refreshes through the real shell and issued carrier',
    { timeout: 60_000 },
    async () => {
      const f = await fixture();
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
            createRoot(document.getElementById('root')).render(
              <EmployeeNativePage prepare query={location.search.slice(1)} />);`,
            loader: 'tsx',
            resolveDir: join(process.cwd(), 'apps/web'),
          },
          bundle: true,
          write: false,
          outdir: '/employee-hot-test',
          jsx: 'automatic',
          loader: {
            '.woff': 'dataurl',
            '.woff2': 'dataurl',
            '.ttf': 'dataurl',
          },
        });
      const requests: { phase: string; start: number; end?: number }[] = [];
      let birthRequests = 0;
      let cold = false;
      let coldIdentities = 0;
      let readyPolls = 0;
      let hotTransient = false;
      let hotIdentities = 0;
      let exerciseNavigation = false;
      const ticket = randomUUID();
      f.web.on('request', async (request, response) => {
        const address = new URL(request.url!, f.origin);
        const html = (body: string) =>
          response
            .writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
            })
            .end(body);
        switch (address.pathname) {
          case '/api/v1/d-entry/native-prewarm': {
            const timing = {
              phase: 'prewarm',
              start: performance.now(),
              end: 0,
            };
            requests.push(timing);
            request.resume();
            await delay(300);
            timing.end = performance.now();
            if (cold)
              return response
                .writeHead(202, { 'content-type': 'application/json' })
                .end(
                  JSON.stringify({
                    operationId: ticket,
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    pollAfterMs: 1000,
                  }),
                );
            return response.writeHead(204).end();
          }
          case '/api/v1/d-entry/native-prewarm/status':
            readyPolls++;
            expect(address.searchParams.get('operationId')).toBe(ticket);
            return response
              .writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify({ state: 'ready' }));
          case '/api/v1/d-entry/identity': {
            const timing = {
              phase: 'identity',
              start: performance.now(),
              end: 0,
            };
            requests.push(timing);
            const reject = cold && ++coldIdentities === 2;
            const earlyFailure = hotTransient && ++hotIdentities === 1;
            await delay(240);
            timing.end = performance.now();
            if (reject) return response.writeHead(403).end();
            if (earlyFailure) return response.writeHead(503).end();
            return response
              .writeHead(200, { 'content-type': 'application/json' })
              .end(
                JSON.stringify({
                  identity: f.selectionIdentity(
                    Object.fromEntries(address.searchParams),
                  ),
                }),
              );
          }
          case '/api/v1/sessions': {
            birthRequests++;
            if (!exerciseNavigation) return response.writeHead(500).end();
            const timing = {
              phase: 'new-thread',
              start: performance.now(),
              end: 0,
            };
            requests.push(timing);
            const body: Buffer[] = [];
            for await (const chunk of request) body.push(Buffer.from(chunk));
            const { selection, operationId } = JSON.parse(
              Buffer.concat(body).toString(),
            );
            expect(selection).toEqual({
              workspaceId: f.selection.workspaceId,
              employeeInstanceId: f.selection.employeeInstanceId,
            });
            expect(typeof operationId).toBe('string');
            f.registerThread(operationId);
            timing.end = performance.now();
            return response
              .writeHead(201, { 'content-type': 'application/json' })
              .end(JSON.stringify({ ...selection, threadId: operationId }));
          }
          case '/chatflow/4.0/document': {
            const scopeId = address.searchParams.get('scopeId');
            expect(scopeId).toBeTruthy();
            const threadId = address.searchParams.get('threadId');
            if (!exerciseNavigation)
              expect(threadId).toBe(f.selection.threadId);
            const selection = {
              workspaceId: f.selection.workspaceId,
              employeeInstanceId: f.selection.employeeInstanceId,
            };
            requests.push({ phase: 'document', start: performance.now() });
            return html(`<!doctype html><head><script data-scope-id="${scopeId}">${initialDocumentLifecycle}</script></head>
            <body data-thread-id="${threadId}"><div contenteditable="true" role="textbox" aria-label="消息"></div>
            <button id="create">新建对话</button><button id="previous">返回已有对话</button>
            <script>
              document.querySelector('#create').onclick = () => parent.postMessage(${JSON.stringify({ type: pageNavigate, scopeId, selection })}, location.origin);
              document.querySelector('#previous').onclick = () => parent.postMessage(${JSON.stringify({ type: pageNavigate, scopeId, selection: f.selection })}, location.origin);
              parent.postMessage(${JSON.stringify({ type: pageEditorMounted, scopeId })}, location.origin)
            </script>`);
          }
          case '/outer.js':
          case '/outer.css': {
            const css = address.pathname.endsWith('.css');
            const file = bundle.outputFiles.find((entry) =>
              entry.path.endsWith(css ? '.css' : '.js'),
            )!;
            return response
              .writeHead(200, {
                'content-type': css ? 'text/css' : 'application/javascript',
                'cache-control': 'public, max-age=3600, immutable',
              })
              .end(file.text);
          }
          default:
            return html(
              '<!doctype html><link rel="stylesheet" href="/outer.css"><div id="root"></div><script src="/outer.js"></script>',
            );
        }
      });
      const executablePath =
        process.env.ALLRICE_BROWSER_EXECUTABLE ??
        process.env.ALLRICE_MANAGED_BROWSER_EXECUTABLE;
      if (!executablePath) throw Error('Locked Chromium executable required');
      const browser: Browser = await require('playwright-core').chromium.launch(
        { executablePath },
      );
      closes.push(() => browser.close());
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      await context.addInitScript(() => {
        if (window !== top) return;
        function inspect() {
          const frame = document.querySelector<HTMLIFrameElement>(
            'iframe[title="员工工作区"]',
          );
          const input = frame?.contentDocument?.querySelector<HTMLElement>(
            '[role="textbox"][contenteditable="true"]',
          );
          // Timestamp the actual browser frame, independent of Playwright's
          // actionability polling cadence. The action below still checks input.
          if (
            frame &&
            input?.isContentEditable &&
            getComputedStyle(frame).visibility === 'visible'
          ) {
            document.documentElement.dataset.firstEditableMs = String(
              performance.now(),
            );
          } else requestAnimationFrame(inspect);
        }
        requestAnimationFrame(inspect);
      });
      await context.addCookies([
        { name: 'allrice_session', value: sessionToken, url: f.origin },
      ]);
      const url =
        f.origin + '/chatflow/4.0?' + new URLSearchParams(f.selection);
      const samples: unknown[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const page = await context.newPage();
        try {
          for (const mode of ['warm-open', 'refresh']) {
            const offset = requests.length;
            const start = performance.now();
            if (mode === 'refresh')
              await page.reload({ waitUntil: 'domcontentloaded' });
            else await page.goto(url, { waitUntil: 'domcontentloaded' });
            const frame = page.frameLocator('iframe[title="员工工作区"]');
            const input = frame.getByRole('textbox', { name: '消息' });
            await page.waitForFunction(
              () => document.documentElement.dataset.firstEditableMs,
            );
            const editableMs = await page.evaluate(() =>
              Number(document.documentElement.dataset.firstEditableMs),
            );
            await input.fill('只验证编辑器可编辑');
            expect(await input.isEditable()).toBe(true);
            await expect.poll(() => page.getByRole('status').count()).toBe(0);
            const phases = requests.slice(offset);
            expect(phases.map(({ phase }) => phase).sort()).toEqual([
              'document',
              'identity',
              'prewarm',
            ]);
            const prewarm = phases.find(({ phase }) => phase === 'prewarm')!;
            const identity = phases.find(({ phase }) => phase === 'identity')!;
            const documentRequest = phases.find(
              ({ phase }) => phase === 'document',
            )!;
            expect(documentRequest.start).toBeGreaterThanOrEqual(
              Math.max(prewarm.end!, identity.end!),
            );
            expect(identity.start).toBeLessThan(prewarm.end!);
            samples.push({
              attempt: attempt + 1,
              mode,
              editableMs: Math.round(editableMs),
              identityOverlapped: identity.start < prewarm.end!,
              prewarmStartMs: Math.round(prewarm.start - start),
              prewarmEndMs: Math.round(prewarm.end! - start),
              identityStartMs: Math.round(identity.start - start),
              identityEndMs: Math.round(identity.end! - start),
              documentStartMs: Math.round(documentRequest.start - start),
            });
          }
        } finally {
          await page.close();
        }
      }
      expect(birthRequests).toBe(0);
      console.info(
        'HOT_OUTER_BENCHMARK ' +
          JSON.stringify({
            browser: browser.version(),
            rttMs: { prewarm: 300, identity: 240 },
            samples,
          }),
      );
      exerciseNavigation = true;
      for (let attempt = 0; attempt < 3; attempt++) {
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        const wire = new Map<
          string,
          {
            path: string;
            start: number;
            status?: number;
            headers?: number;
            end?: number;
            bytes?: number;
            cache?: boolean;
          }
        >();
        const carriers: { event: string; at: number }[] = [];
        cdp.on('Network.requestWillBeSent', (event) => {
          const address = new URL(event.request.url);
          if (address.origin !== f.origin) return;
          wire.set(event.requestId, {
            path: address.pathname,
            start: performance.now(),
          });
        });
        cdp.on('Network.responseReceived', (event) => {
          const row = wire.get(event.requestId);
          if (!row) return;
          row.headers = performance.now();
          row.status = event.response.status;
          row.cache ||= event.response.fromDiskCache;
        });
        cdp.on('Network.requestServedFromCache', ({ requestId }) => {
          const row = wire.get(requestId);
          if (row) row.cache = true;
        });
        cdp.on(
          'Network.loadingFinished',
          ({ requestId, encodedDataLength }) => {
            const row = wire.get(requestId);
            if (!row) return;
            row.end = performance.now();
            row.bytes = encodedDataLength;
          },
        );
        page.on('websocket', (socket) => {
          carriers.push({ event: 'connect', at: performance.now() });
          socket.on('framereceived', ({ payload }) => {
            const frame = JSON.parse(payload.toString());
            const event = frame.value?.type;
            if (event === 'opened' || event === 'closed')
              carriers.push({ event, at: performance.now() });
          });
        });
        try {
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 200,
            downloadThroughput: 1_250_000,
            uploadThroughput: 1_250_000,
          });
          await page.goto(url);
          const iframe = page.locator('iframe[title="员工工作区"]');
          const child = iframe.contentFrame();
          await child.getByRole('textbox').waitFor();
          await iframe.evaluate((node) => {
            (node as HTMLElement).dataset.qaRetained = '1';
          });
          for (const action of ['新建对话', '返回已有对话']) {
            wire.clear();
            carriers.length = 0;
            const previousThread = await child
              .locator('body')
              .getAttribute('data-thread-id');
            const count = requests.length;
            const start = performance.now();
            await child.getByRole('button', { name: action }).click();
            await page.waitForFunction((old) => {
              const frame = document.querySelector<HTMLIFrameElement>(
                'iframe[data-qa-retained="1"]',
              );
              const child = frame?.contentDocument;
              return (
                child?.body?.dataset.threadId &&
                child.body.dataset.threadId !== old &&
                child.querySelector<HTMLElement>('[contenteditable=true]')
                  ?.isContentEditable &&
                window.getComputedStyle(frame!).visibility === 'visible'
              );
            }, previousThread);
            const elapsed = Math.round(performance.now() - start);
            const phases = requests.slice(count);
            const prewarm = phases.find(({ phase }) => phase === 'prewarm')!;
            const identity = phases.find(({ phase }) => phase === 'identity')!;
            const reopen = action === '返回已有对话';
            expect(phases.map(({ phase }) => phase).sort()).toEqual(
              reopen
                ? ['document', 'identity', 'prewarm']
                : ['document', 'identity', 'new-thread', 'prewarm'],
            );
            expect(identity.start < prewarm.end!).toBe(reopen);
            expect(carriers.map(({ event }) => event)).toEqual([
              'closed',
              'connect',
              'opened',
            ]);
            expect([...wire.values()].map(({ path }) => path)).not.toContain(
              '/chatflow/4.0',
            );
            if (reopen)
              expect(
                await child.locator('body').getAttribute('data-thread-id'),
              ).toBe(f.selection.threadId);
            console.info(
              'THREAD_SWITCH_LEDGER ' +
                JSON.stringify({
                  attempt: attempt + 1,
                  action,
                  elapsed,
                  http: [...wire.values()].map(
                    ({ start: sent, headers, end, ...row }) => ({
                      ...row,
                      start: Math.round(sent - start),
                      headers:
                        headers === undefined
                          ? undefined
                          : Math.round(headers - start),
                      end:
                        end === undefined ? undefined : Math.round(end - start),
                    }),
                  ),
                  carrier: carriers.map(({ event, at }) => ({
                    event,
                    at: Math.round(at - start),
                  })),
                }),
            );
          }
        } finally {
          await page.close();
        }
      }
      exerciseNavigation = false;
      expect(birthRequests).toBe(3);
      cold = true;
      const offset = requests.length;
      const denied = await context.newPage();
      const deniedSockets: string[] = [];
      denied.on('websocket', (socket) => deniedSockets.push(socket.url()));
      await denied.goto(url);
      await denied.getByRole('alert').waitFor();
      expect(coldIdentities).toBe(2);
      expect(readyPolls).toBe(1);
      expect(
        requests
          .slice(offset)
          .map(({ phase }) => phase)
          .sort(),
      ).toEqual(['identity', 'identity', 'prewarm']);
      expect(await denied.locator('iframe').count()).toBe(0);
      expect(deniedSockets).toEqual([]);
      await denied.close();

      cold = false;
      hotTransient = true;
      const retryOffset = requests.length;
      const recovered = await context.newPage();
      await recovered.goto(url);
      await recovered
        .frameLocator('iframe[title="员工工作区"]')
        .getByRole('textbox', { name: '消息' })
        .fill('验证热态早期瞬时失败后能打开');
      expect(hotIdentities).toBe(2);
      const recovery = requests.slice(retryOffset);
      expect(recovery.map(({ phase }) => phase).sort()).toEqual([
        'document',
        'identity',
        'identity',
        'prewarm',
      ]);
      expect(
        recovery.filter(({ phase }) => phase === 'identity')[1]!.start,
      ).toBeGreaterThanOrEqual(
        recovery.find(({ phase }) => phase === 'prewarm')!.end!,
      );
      await context.close();
    },
  );
});
