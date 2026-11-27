import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import type { Browser } from '../../../../worker/node_modules/playwright-core/index.js';
import { expect, it, vi } from 'vitest';
import * as database from '@allrice/database';
import { deferred } from '../../../../../packages/d-entry-principal/test/host-fixture';
import {
  buildProfileFixture,
  closes,
  fixture,
  sessionToken,
} from '../../../../worker/src/d-entry/principal-page-carrier.fixture';
import * as authorization from '../../../lib/identity/session';
import * as nativeRequest from '../../../lib/d-entry/native-request';
import * as assets from '../../../lib/d-entry/released-profile-assets';
import { GET as documentRedirect } from './document/route';
import { GET as documentRoute } from './document/[...publicationPath]/route';

it.skipIf(process.env.ALLRICE_RUN_BROWSER_INTEGRATION !== '1')(
  'fits the native workbench to the viewport without scrolling either document',
  { timeout: 90_000 },
  async () => {
    const release = await buildProfileFixture();
    const f = await fixture(release);
    const { identity, selection } = f;
    f.host.catalog.items = f.host.catalog.items.map((row) =>
      String(row.sessionId) === 'root' ? { ...row, cwd: '/work' } : row,
    );
    f.host.catalog.pageRecords = [
      {
        type: 'event',
        event: {
          type: 'fixture-viewport',
          seq: 0,
          time: 1,
          data: {},
          ignorable: true,
        },
      },
    ];
    const version = {
      id: identity.employeeVersionId,
      manifest: {
        name: '验收员工',
        description: '隔离的工作台布局测试',
        appearance: undefined,
      },
    };
    vi.spyOn(database, 'readDEntryEmployeeDirectory').mockResolvedValue({
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      viewerId: identity.personId,
      employees: [
        {
          id: identity.employeeInstanceId,
          instanceId: identity.employeeInstanceId,
          employeeId: identity.employeeInstanceId,
          isDefault: false,
          currentVersion: version,
          versions: [version],
        },
      ],
      sessions: [
        {
          id: selection.threadId,
          employeeInstanceId: identity.employeeInstanceId,
          organizationId: identity.organizationId,
          workspaceId: identity.workspaceId,
          employeeAssignmentId: identity.employeeInstanceId,
          employeeVersionId: identity.employeeVersionId,
          ownerId: identity.personId,
          visibility: 'private',
          archivedAt: null,
          employeeName: version.manifest.name,
          activeRunIds: [],
          running: false,
          pendingInteraction: undefined,
          updatedAt: '2026-01-01T00:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
          title: '工作台布局验收',
        },
      ],
    });
    vi.spyOn(authorization, 'requireRequestContext').mockResolvedValue(
      f.context,
    );
    vi.spyOn(nativeRequest, 'currentNativeRequest').mockImplementation(
      async (request, selected, context) => ({
        identity,
        selection: selected,
        context,
        token: sessionToken,
        signal: request.signal,
      }),
    );
    vi.stubEnv(
      'ALLRICE_WORKER_INTERNAL_URL',
      'http://127.0.0.1:' + (f.worker.address() as AddressInfo).port,
    );

    const manifest: { files: { path: string }[] } = JSON.parse(
      await readFile(join(release.directory, 'artifact.json'), 'utf8'),
    );
    const files = new Set(manifest.files.map(({ path }) => path));
    const assetRoot = '/_next/static/dsh-profile/' + '0'.repeat(64) + '/';
    vi.spyOn(assets, 'readReleasedProfileAssets').mockResolvedValue({
      root: assetRoot,
      paths: files,
      bundles: [],
    });
    const require = createRequire(
      new URL(
        '../../../../../packages/dsh-web-composition/package.json',
        import.meta.url,
      ),
    );
    const bundle: { outputFiles: { path: string; contents: Uint8Array }[] } =
      await require('esbuild').build({
        stdin: {
          contents: `import './app/styles/base.css';
        import { createRoot } from 'react-dom/client';
        import { EmployeeNativePage } from './app/chatflow/4.0/employee-native-page';
        createRoot(document.getElementById('root')).render(<EmployeeNativePage prepare query={location.search.slice(1)} />);`,
          loader: 'tsx',
          resolveDir: join(process.cwd(), 'apps/web'),
        },
        bundle: true,
        write: false,
        outdir: '/viewport-test',
        jsx: 'automatic',
        loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      });
    const markup =
      '<!doctype html><link rel="stylesheet" href="/stdin.css"><div id="root"></div><script src="/stdin.js"></script>';
    const types: Record<string, string> = {
      '.css': 'text/css',
      '.js': 'text/javascript',
      '.wasm': 'application/wasm',
    };
    const errors: string[] = [];
    const loadDocument = deferred<void>();
    f.web.on('request', async (request, response) => {
      const url = new URL(request.url!, f.origin);
      const send = (type: string, data: string | Uint8Array) =>
        response.writeHead(200, { 'content-type': type }).end(data);
      const relay = async (result: Response) =>
        response
          .writeHead(result.status, Object.fromEntries(result.headers))
          .end(Buffer.from(await result.arrayBuffer()));
      try {
        const output = bundle.outputFiles.find(
          ({ path }) => path === '/viewport-test' + url.pathname,
        );
        if (output) return send(types[extname(url.pathname)]!, output.contents);
        if (url.pathname === '/chatflow/4.0') return send('text/html', markup);
        if (url.pathname === '/api/v1/d-entry/native-prewarm')
          return response.writeHead(204).end();
        if (url.pathname === '/api/v1/d-entry/identity')
          return send('application/json', JSON.stringify({ identity }));
        if (url.pathname === '/api/v1/d-entry/native-rpc') {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const input = JSON.parse(Buffer.concat(chunks).toString());
          return await relay(
            await f.invoke(input.scopeId, sessionToken, input),
          );
        }
        for (const kind of ['bootstrap', 'assets'] as const) {
          if (url.pathname === '/api/v1/d-entry/profile/' + kind)
            return await relay(
              await f.publish(
                kind,
                url.searchParams.get('scopeId')!,
                Object.fromEntries(url.searchParams),
              ),
            );
        }
        if (url.pathname === '/chatflow/4.0/document') {
          await loadDocument.promise;
          return await relay(await documentRedirect(new Request(url)));
        }
        const documentPrefix = '/chatflow/4.0/document/';
        if (url.pathname.startsWith(documentPrefix))
          return await relay(
            await documentRoute(new Request(url), {
              params: Promise.resolve({
                publicationPath: url.pathname
                  .slice(documentPrefix.length)
                  .split('/'),
              }),
            }),
          );
        if (url.pathname.startsWith(assetRoot)) {
          const asset = url.pathname.slice(assetRoot.length);
          if (files.has(asset))
            return send(
              types[extname(asset)] ?? 'application/octet-stream',
              await readFile(join(release.directory, asset)),
            );
        }
        return response.writeHead(404).end();
      } catch (error) {
        errors.push(String(error));
        return response.writeHead(500).end();
      }
    });

    const executablePath =
      process.env.ALLRICE_BROWSER_EXECUTABLE ??
      process.env.ALLRICE_MANAGED_BROWSER_EXECUTABLE;
    const browser: Browser = await require('playwright-core').chromium.launch({
      executablePath,
    });
    closes.push(() => browser.close());
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    await context.addCookies([
      { name: 'allrice_session', value: sessionToken, url: f.origin },
    ]);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (result) => {
      if (result.status() >= 400)
        errors.push(result.status() + ' ' + new URL(result.url()).pathname);
    });
    await page.goto(
      f.origin + '/chatflow/4.0?' + new URLSearchParams(selection),
      { waitUntil: 'domcontentloaded' },
    );
    const iframe = page.locator('iframe[title="员工工作区"]');
    const workbench = iframe.contentFrame();
    const editor = workbench.locator(
      '[role="textbox"][data-composer-input][contenteditable="true"]',
    );
    try {
      try {
        await iframe.waitFor({ state: 'attached' });
        expect(
          await iframe.evaluate((frame) => getComputedStyle(frame).visibility),
        ).toBe('hidden');
        expect(
          await page.evaluate(
            () => getComputedStyle(document.documentElement).overflowY,
          ),
        ).toBe('scroll');
      } finally {
        loadDocument.resolve();
      }
      await editor.waitFor();
      await iframe.waitFor();
      await workbench.locator('#chat-sidebar').waitFor();
      await workbench.locator('#app [data-phase="active"]').waitFor();
      expect(await editor.isEditable()).toBe(true);
      await editor.fill('你好，帮我检查工作台布局。');
    } catch (error) {
      throw Error(JSON.stringify(errors), { cause: error });
    }
    for (const [width, height] of [
      [1440, 900],
      [1920, 1080],
      [1280, 720],
      [1050, 610],
    ] as const) {
      await page.setViewportSize({ width, height });
      const outer = await iframe.evaluate((frame) => ({
        bottom: frame.getBoundingClientRect().bottom,
        width: frame.getBoundingClientRect().width,
        scrollHeight: document.scrollingElement!.scrollHeight,
        overflowY: getComputedStyle(document.documentElement).overflowY,
      }));
      const inner = await editor.evaluate((input) => ({
        mount: document.getElementById('app')!.getBoundingClientRect().bottom,
        sidebar: document
          .getElementById('chat-sidebar')!
          .getBoundingClientRect().bottom,
        conversation: input
          .closest('[data-phase="active"]')!
          .getBoundingClientRect().bottom,
        composer: input.closest('[data-composer-card]')!.getBoundingClientRect()
          .bottom,
        scrollHeight: document.scrollingElement!.scrollHeight,
        overflowY: [document.documentElement, document.body].map(
          (element) => getComputedStyle(element).overflowY,
        ),
        height: innerHeight,
      }));
      expect(outer.bottom).toBeCloseTo(height, 0);
      expect(outer.width).toBeCloseTo(width, 0);
      expect(outer.scrollHeight).toBe(height);
      expect(inner.height).toBe(height);
      expect(inner.mount).toBeCloseTo(height, 0);
      expect(inner.sidebar).toBeCloseTo(height, 0);
      expect(inner.conversation).toBeCloseTo(height, 0);
      expect(inner.composer).toBeGreaterThan(height - 32);
      expect(inner.composer).toBeLessThanOrEqual(height);
      expect(inner.scrollHeight).toBe(height);
      expect(inner.overflowY).not.toContain('scroll');
      expect(outer.overflowY).not.toBe('scroll');
    }
    await context.close();
  },
);
