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
import { pageEditorMounted } from '../../../lib/d-entry/page-messages';

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
            await delay(240);
            timing.end = performance.now();
            if (reject) return response.writeHead(403).end();
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
          case '/api/v1/sessions':
            birthRequests++;
            return response.writeHead(500).end();
          case '/chatflow/4.0/document': {
            const scopeId = address.searchParams.get('scopeId');
            expect(scopeId).toBeTruthy();
            expect(address.searchParams.get('threadId')).toBe(
              f.selection.threadId,
            );
            requests.push({ phase: 'document', start: performance.now() });
            return html(`<!doctype html><head><script data-scope-id="${scopeId}">${initialDocumentLifecycle}</script></head>
            <body><div contenteditable="true" role="textbox" aria-label="消息"></div>
            <script>parent.postMessage(${JSON.stringify({ type: pageEditorMounted, scopeId })}, location.origin)</script>`);
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
            const document = phases.find(({ phase }) => phase === 'document')!;
            expect(document.start).toBeGreaterThanOrEqual(
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
              documentStartMs: Math.round(document.start - start),
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
      await context.close();
    },
  );
});
