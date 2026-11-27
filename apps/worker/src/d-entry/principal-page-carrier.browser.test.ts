import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Page } from 'playwright-core';
import { expect, it } from 'vitest';
import {
  type DEntryPageOpenedSchema,
  DEntryProfileBootstrapSchema,
  DEntryProfileGraphSchema,
} from '@allrice/contracts';
import { deferred } from '../../../../packages/d-entry-principal/test/host-fixture.js';
import {
  initialDocumentLifecycle,
  publicStartupBundleUrls,
} from '../../../web/lib/d-entry/initial-document.js';
import {
  fixture,
  buildProfileFixture,
  closes,
  sessionToken,
} from './principal-page-carrier.fixture.js';

const browserExecutable =
  process.env.ALLRICE_BROWSER_EXECUTABLE ??
  process.env.ALLRICE_MANAGED_BROWSER_EXECUTABLE;

it.skipIf(!browserExecutable).each([false, true])(
  'boots the rc.2 composer or reports a stalled application body (stall=%s)',
  { timeout: 60_000 },
  async (stall) => {
    const release = await buildProfileFixture();
    const sealed = await readFile(join(release.directory, 'artifact.json'));
    const manifest: {
      files: { path: string }[];
      profile: { files: { reference: string; sha256: string }[] };
    } = JSON.parse(sealed.toString());
    const staticFiles = new Set(manifest.files.map(({ path }) => '/' + path));
    const mime: Record<string, string> = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.wasm': 'application/wasm',
    };
    const f = await fixture(release);
    f.host.catalog.items = f.host.catalog.items.map((row) =>
      String(row.sessionId) === 'root'
        ? { ...row, blank: true, cwd: '/work' }
        : row,
    );
    const require = createRequire(
      new URL(
        '../../../../packages/dsh-web-composition/package.json',
        import.meta.url,
      ),
    );
    const parentModule: { outputFiles: { text: string }[] } =
      await require('esbuild').build({
        entryPoints: ['apps/web/lib/d-entry/page-carrier.ts'],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'DEntryCarrier',
        write: false,
      });
    const unary: string[] = [];
    const listRead: unknown[] = [];
    const graph = DEntryProfileGraphSchema.parse(release.graph);
    const application = graph.batches.find(
      ({ phase }) => phase === 'application',
    )!;
    const publicRoot =
      '/_next/static/dsh-profile/' +
      createHash('sha256').update(sealed).digest('hex') +
      '/';
    const bundles = graph.batches.map((batch) => ({
      reference: batch.url,
      revision: batch.rev,
      sha256: manifest.profile.files.find(
        (file) => file.reference === batch.url,
      )!.sha256,
      phase: batch.phase,
    }));
    const publicBundles = new Map(
      bundles.map((bundle) => [
        publicRoot + 'bundles/' + bundle.sha256 + '.js',
        bundle,
      ]),
    );
    let earlyUrls: string[] = [];
    const seenEarly = new Set<string>();
    const earlyBootstrapSeen = deferred<void>();
    const traffic: { kind: string; start: number; end?: number }[] = [];
    let started = 0;
    let firstRpc: number | undefined;
    let applicationReads = 0;
    let browserBootstrapReads = 0;
    f.web.on('request', async (request, response) => {
      const url = new URL(request.url!, f.origin);
      const copy = async (result: Response) => {
        response
          .writeHead(result.status, {
            'content-type': result.headers.get('content-type')!,
          })
          .end(Buffer.from(await result.arrayBuffer()));
      };
      try {
        const scopeId = url.searchParams.get('scopeId');
        if (url.pathname === '/api/v1/d-entry/native-rpc') {
          firstRpc ??= performance.now();
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          unary.push(input.endpoint);
          const result = await f.invoke(input.scopeId, sessionToken, input);
          if (input.endpoint === 'session/list')
            listRead.push((await result.clone().json()).result);
          return await copy(result);
        }
        for (const kind of ['bootstrap', 'assets'] as const) {
          if (url.pathname !== '/api/v1/d-entry/profile/' + kind) continue;
          if (kind === 'bootstrap') browserBootstrapReads++;
          if (
            stall &&
            kind === 'assets' &&
            url.searchParams.get('reference') === application.url
          ) {
            applicationReads++;
            response.writeHead(200, { 'content-type': 'text/javascript' });
            response.write('/* deliberately incomplete application');
            return;
          }
          const timing = { kind, start: performance.now(), end: 0 };
          traffic.push(timing);
          await copy(
            await f.publish(
              kind,
              scopeId!,
              Object.fromEntries(url.searchParams),
            ),
          );
          timing.end = performance.now();
          return;
        }
        const publicBundle = !stall && publicBundles.get(url.pathname);
        if (publicBundle) {
          if (earlyUrls.includes(url.pathname)) {
            seenEarly.add(url.pathname);
            if (seenEarly.size === earlyUrls.length)
              earlyBootstrapSeen.resolve();
          }
          const timing = {
            kind: 'public-' + publicBundle.phase,
            start: performance.now(),
            end: 0,
          };
          traffic.push(timing);
          expect(request.headers.cookie).toBeUndefined();
          const bytes = await release.read(
            publicBundle.reference,
            new AbortController().signal,
          );
          await delay(180);
          timing.end = performance.now();
          response
            .writeHead(200, {
              'content-type': 'text/javascript',
              'cache-control': 'public, max-age=31536000, immutable',
            })
            .end(bytes);
          return;
        }
        if (staticFiles.has(url.pathname)) {
          if (
            earlyUrls.length &&
            url.pathname === '/managed/employee-web-entry.js'
          )
            await earlyBootstrapSeen.promise;
          const asset = await readFile(
            join(release.directory, url.pathname.slice(1)),
          );
          response
            .writeHead(200, {
              'content-type':
                mime[extname(url.pathname)] ?? 'application/octet-stream',
            })
            .end(asset);
          return;
        }
        if (url.pathname === '/') {
          response
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end(
              `<!doctype html><iframe data-page-mux="v1" style="width:100%;height:100vh"></iframe>
                <script>${parentModule.outputFiles[0]!.text}</script>
                <script>
                  const frame = document.querySelector('iframe');
                  const carrier = DEntryCarrier.openNativePageCarrier(
                    ${JSON.stringify(f.identity)}, ${JSON.stringify(f.selection)}, () => {}
                  );
                  carrier.ready.then(({scopeReference}) => {
                    const scopeId = scopeReference.scopeId;
                    function send(type, state) {
                      frame.contentWindow.postMessage({ type, scopeId, state }, location.origin);
                    }
                    const finish = () => carrier.close().then(
                      () => send('allrice:d-entry:completion','closed'),
                      () => send('allrice:d-entry:completion','unknown')
                    );
                    window.finishCarrier = finish;
                    window.addEventListener('message', (event) => {
                      if (event.origin !== location.origin || event.source !== frame.contentWindow ||
                        event.data?.scopeId !== scopeId) return;
                      if (event.data.type === 'allrice:d-entry:mux-attach') carrier.attachMux(event.ports[0]);
                      if (event.data.type === 'allrice:d-entry:close') void finish();
                    });
                    frame.src = '/employee?scopeId=' + encodeURIComponent(scopeId);
                  });
                </script>`,
            );
          return;
        }
        if (url.pathname !== '/employee') {
          response.writeHead(404).end();
          return;
        }
        const { identity, selection } = f;
        const version = {
          id: identity.employeeVersionId,
          manifest: { name: 'Fixture employee' },
        };
        const directory = {
          ...identity,
          viewerId: identity.personId,
          employees: [
            {
              id: identity.employeeInstanceId,
              employeeId: identity.employeeInstanceId,
              isDefault: true,
              currentVersion: version,
              versions: [version],
            },
          ],
          sessions: [
            {
              id: selection.threadId,
              employeeInstanceId: identity.employeeInstanceId,
              ownerId: identity.personId,
              updatedAt: '2026-01-01T00:00:00.000Z',
              createdAt: '2026-01-01T00:00:00.000Z',
              title: 'Fixture thread',
            },
          ],
        };
        if (!scopeId) return response.writeHead(404).end();
        const bootstrap = await f.publish('bootstrap', scopeId);
        if (!bootstrap.ok) return response.writeHead(bootstrap.status).end();
        const published = DEntryProfileBootstrapSchema.parse(
          await bootstrap.json(),
        );
        earlyUrls = stall
          ? []
          : publicStartupBundleUrls(published, {
              root: publicRoot,
              bundles,
            });
        const bootJson = JSON.stringify(published).replaceAll('<', '\\u003c');
        response.writeHead(200, { 'content-type': 'text/html' })
          .end(`<!doctype html>
          <link rel="stylesheet" href="/managed/employee-web-entry.css">
          <script data-scope-id="${scopeId}" data-public-startup-bundles='${JSON.stringify(earlyUrls)}'>${initialDocumentLifecycle}</script>
          <div id="app" data-shared-mux="1" data-scope-id="${scopeId}" data-thread-id="${selection.threadId}"
            data-workspace-id="${identity.workspaceId}" data-employee-instance-id="${identity.employeeInstanceId}"
            data-organization-id="${identity.organizationId}" data-viewer-id="${identity.personId}"
            data-native-session-id="root" data-binding-ref="${f.owner.bindingRef}" data-graph-rev="${graph.rev}"
            ${stall ? '' : `data-public-asset-root="${publicRoot}" data-public-bundles='${JSON.stringify(bundles.map(({ reference, revision, sha256 }) => ({ reference, revision, sha256 })))}'`}></div>
          <script id="allrice-employee-directory" type="application/json">${JSON.stringify(directory)}</script>
          <script id="allrice-employee-bootstrap" type="application/json">${bootJson}</script>
          <script type="module" src="/managed/employee-web-entry.js"></script>`);
      } catch {
        response.writeHead(500).end();
      }
    });
    const browser = await chromium.launch({
      executablePath: browserExecutable,
    });
    closes.push(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
      { name: 'allrice_session', value: sessionToken, url: f.origin },
    ]);
    const page = await context.newPage();
    const streams = new Map<string, string>();
    let socketCount = 0;
    const firstItems: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning')
        errors.push(message.text().split('\n')[0]!);
    });
    page.on('response', (response) => {
      if (response.status() >= 400)
        errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    page.on('websocket', (socket) => {
      socketCount++;
      socket.on('framesent', ({ payload }) => {
        const frame = JSON.parse(payload.toString());
        if (frame.type === 'open') streams.set(frame.streamId, frame.endpoint);
      });
      socket.on('framereceived', ({ payload }) => {
        const frame = JSON.parse(payload.toString());
        if (
          frame.type === 'item' &&
          ['baseline', 'snapshot'].includes(frame.value.type)
        )
          firstItems.push(`${streams.get(frame.streamId)}:${frame.value.type}`);
      });
    });
    if (stall) {
      await page.clock.install();
      await page.addInitScript(() => {
        if (window.parent !== window) return;
        window.addEventListener('message', (event) => {
          if (
            event.origin === location.origin &&
            event.data?.reason === 'asset-timeout'
          )
            document.documentElement.dataset.assetTimeout = event.data.reason;
        });
      });
    }
    started = performance.now();
    await page.goto(f.origin);
    if (stall) {
      await expect.poll(() => applicationReads, { timeout: 15_000 }).toBe(1);
      await page.clock.fastForward(30_100);
      await expect.poll(() => applicationReads, { timeout: 15_000 }).toBe(2);
      await page.clock.fastForward(30_100);
      await page.locator('html[data-asset-timeout="asset-timeout"]').waitFor();
      expect(applicationReads).toBe(2);
      expect(browserBootstrapReads).toBe(0);
      expect(socketCount).toBe(1);
      expect(unary).not.toContain('session/list');
      await context.close();
      return;
    }
    const workbench = page.frameLocator('iframe');
    const editor = workbench.locator(
      '[role="textbox"][data-composer-input][contenteditable="true"]',
    );
    try {
      await editor.fill('未发送的原生草稿', { timeout: 15_000 });
    } catch (error) {
      throw Error(
        JSON.stringify({
          unary,
          streamEndpoints: [...streams.values()],
          firstItems,
          listRead,
          errors,
          text: (await workbench.locator('body').innerText()).slice(0, 300),
        }),
        { cause: error },
      );
    }
    expect(await editor.isEditable()).toBe(true);
    expect(browserBootstrapReads).toBe(0);
    expect(socketCount).toBe(1);
    const bootstrapDownload = traffic.find(
      ({ kind }) => kind === 'public-bootstrap',
    );
    const applicationDownload = traffic.find(
      ({ kind }) => kind === 'public-application',
    );
    expect(earlyUrls).toHaveLength(2);
    expect(applicationDownload?.start).toBeLessThan(bootstrapDownload!.end!);
    expect(
      traffic.filter(({ kind }) => kind === 'public-bootstrap'),
    ).toHaveLength(1);
    expect(
      traffic.filter(({ kind }) => kind === 'public-application'),
    ).toHaveLength(1);
    console.info(
      'HOT_NATIVE_BENCHMARK ' +
        JSON.stringify({
          browser: browser.version(),
          publicDelayMs: 180,
          firstRpcMs: Math.round(firstRpc! - started),
          editableMs: Math.round(performance.now() - started),
          traffic: traffic.map(({ kind, start, end }) => ({
            kind,
            startMs: Math.round(start - started),
            endMs: typeof end === 'number' ? Math.round(end - started) : null,
          })),
        }),
    );
    await expect
      .poll(() => firstItems)
      .toEqual(
        expect.arrayContaining([
          'session/control:baseline',
          'session/follow:snapshot',
        ]),
      );
    expect(unary).toContain('session/list');
    expect(unary).not.toContain('dynamicCordisRunner/inventory');
    expect(unary).not.toContain('dynamicCordisRunner/syncInspectManifest');
    expect(unary).not.toContain('session/prompt');
    await page.evaluate(async () => {
      const finish: unknown = Reflect.get(window, 'finishCarrier');
      if (typeof finish !== 'function')
        throw Error('Fixture carrier unavailable');
      await finish();
    });

    await context.close();
  },
);

it.skipIf(!browserExecutable)(
  'joins the native page carrier in Chromium with the original browser Cookie',
  { timeout: 25_000 },
  async () => {
    const f = await fixture();
    f.web.on('request', (_, outgoing) => {
      outgoing.writeHead(200, { 'content-type': 'text/html' });
      outgoing.end('<!doctype html><title>Owned native carrier test</title>');
    });
    const require = createRequire(
      new URL(
        '../../../../packages/dsh-web-composition/package.json',
        import.meta.url,
      ),
    );
    const result: { outputFiles: { text: string }[] } =
      await require('esbuild').build({
        entryPoints: ['apps/web/lib/d-entry/page-carrier.ts'],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'DEntryCarrier',
        write: false,
      });
    const browser = await chromium.launch({
      executablePath: browserExecutable,
    });
    closes.push(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
      { name: 'allrice_session', value: sessionToken, url: f.origin },
    ]);
    const page = await context.newPage();
    await page.goto(f.origin);
    await page.addScriptTag({ content: result.outputFiles[0]!.text });
    const receipt = await page.evaluate(
      async ({ identity, selection }) => {
        const { openNativePageCarrier } = (
          window as unknown as {
            DEntryCarrier: {
              openNativePageCarrier(
                original: typeof identity,
                selectors: typeof selection,
                revoked: () => void,
              ): {
                ready: Promise<ReturnType<typeof DEntryPageOpenedSchema.parse>>;
                close(): Promise<void>;
              };
            };
          }
        ).DEntryCarrier;
        let revoked = false;
        const carrier = openNativePageCarrier(identity, selection, () => {
          revoked = true;
        });
        const opened = await carrier.ready;
        await carrier.close();
        return { opened, revoked };
      },
      { identity: f.identity, selection: f.selection },
    );
    expect(receipt).toMatchObject({
      opened: {
        type: 'opened',
        scopeReference: { scopeId: expect.any(String) },
        bindingRef: f.owner.bindingRef,
      },
      revoked: false,
    });
    expect(
      await f
        .invoke(receipt.opened.scopeReference.scopeId)
        .then((value) => value.status),
    ).toBe(404);
    expect(f.owner.acquirePrincipal).toHaveBeenCalledTimes(1);
    await context.close();
  },
);

it.skipIf(!browserExecutable)(
  'waits for the real document dispose before navigation and cancels a partial bundle on child pagehide',
  { timeout: 30_000 },
  async () => {
    const f = await fixture();
    const root = process.cwd();
    const require = createRequire(
      new URL(
        '../../../../packages/dsh-web-composition/package.json',
        import.meta.url,
      ),
    );
    const { employeeWebKernelOptions } = (await import(
      new URL(
        '../../../../packages/dsh-web-composition/build-web-entry.mjs',
        import.meta.url,
      ).href
    )) as { employeeWebKernelOptions: { loader: Record<string, string> } };
    function bundle(resolveDir: string, source: string) {
      return require('esbuild')
        .build({
          ...employeeWebKernelOptions,
          stdin: { contents: source, resolveDir, loader: 'tsx' },
          format: 'esm',
          write: false,
          outdir: '/page-close-test',
          jsx: 'automatic',
          loader: Object.fromEntries(
            Object.keys(employeeWebKernelOptions.loader!).map((key) => [
              key,
              'dataurl',
            ]),
          ),
        })
        .then(
          (result: { outputFiles: { path: string; text: string }[] }) =>
            result.outputFiles.find((file) => file.path.endsWith('.js'))!.text,
        );
    }
    const [outer, child] = await Promise.all([
      bundle(
        join(root, 'apps/web'),
        `
        import { createRoot } from 'react-dom/client';
        import { EmployeeNativePage } from './app/chatflow/4.0/employee-native-page';
        const root = createRoot(document.getElementById('root'));
        window.updateEmployeeQuery = (query) => root.render(<EmployeeNativePage query={query} />);
        window.updateEmployeeQuery(location.search.slice(1));
      `,
      ),
      bundle(
        join(root, 'packages/dsh-web-composition'),
        `
        import { AppWebEntry } from '@deepseek-ai/dsh-client-web';
        const dispose = AppWebEntry.prototype.dispose;
        const gate = Promise.withResolvers();
        window.releaseDispose = gate.resolve;
        AppWebEntry.prototype.dispose = async function () {
          document.body.dataset.dispose = 'waiting';
          const shouldFail = document.body.dataset.autoDispose ? false : await gate.promise;
          await dispose.call(this);
          if (shouldFail) throw Error('Dispose outcome unknown');
        };
        await import('./src/employee-product-entry');
      `,
      ),
    ]);
    let transfer = deferred<ServerResponse>();
    let cancelled = deferred<void>();
    let firstScript = deferred<ServerResponse>();
    let firstStyle = deferred<ServerResponse>();
    let initialScriptClose = deferred<void>();
    let initialStyleClose = deferred<void>();
    let earlyTransfer = deferred<ServerResponse>();
    let earlyClose = deferred<void>();
    const heldPublicUrl =
      '/_next/static/dsh-profile/' +
      '1'.repeat(64) +
      '/bundles/' +
      '2'.repeat(64) +
      '.js';
    let startup:
      | 'style'
      | 'entry'
      | 'pending-elements'
      | 'document'
      | 'redirect'
      | 'claimed-sync'
      | 'draft-storage'
      | 'draft-key-collision'
      | 'claimed-async'
      | undefined;
    const directoryQueries: string[] = [];
    const bootstrapScopes: string[] = [];
    const knownScopes = new Map<string, string>();
    const graph = DEntryProfileGraphSchema.parse({
      rev: 'test-graph',
      release: { version: '0.2.1-rc.2' },
      entries: [{ id: 'held', url: 'plugins/??held', rev: 'held-entry' }],
      batches: [
        {
          phase: 'bootstrap',
          url: 'plugins/??held-batch',
          rev: 'held-batch',
          entries: ['held'],
        },
      ],
    });
    f.web.on('request', (request, response) => {
      const url = new URL(request.url!, f.origin);
      const send = (type: string, body: string) =>
        response.writeHead(200, { 'Content-Type': type }).end(body);
      if (url.pathname === '/outer.js')
        return send('application/javascript', outer);
      if (url.pathname === '/child.js')
        return send('application/javascript', child);
      if (url.pathname === heldPublicUrl) {
        expect(request.headers.cookie).toBeUndefined();
        response.once('close', () => earlyClose.resolve());
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.write('/* suspended early bootstrap */');
        earlyTransfer.resolve(response);
        return;
      }
      if (url.pathname === '/first.js') {
        if (startup === 'entry') return response.writeHead(503).end();
        response.once('close', () => initialScriptClose.resolve());
        response.writeHead(200, { 'content-type': 'application/javascript' });
        response.write('/* the managed module has not loaded */\n');
        firstScript.resolve(response);
        return;
      }
      if (url.pathname === '/first.css') {
        response.once('close', () => initialStyleClose.resolve());
        firstStyle.resolve(response);
        return;
      }
      if (url.pathname === '/api/v1/d-entry/identity') {
        directoryQueries.push(url.searchParams.get('threadId')!);
        return send(
          'application/json',
          JSON.stringify({
            identity: f.selectionIdentity(Object.fromEntries(url.searchParams)),
          }),
        );
      }
      if (url.pathname === '/chatflow/4.0/document') {
        const scope = url.searchParams.get('scopeId')!;
        const thread = url.searchParams.get('threadId')!;
        knownScopes.set(scope, thread);
        const mode = thread === f.selection.threadId ? startup : undefined;
        if (mode === 'document')
          return response
            .writeHead(503, { 'content-type': 'application/json' })
            .end('{}');
        if (mode === 'redirect')
          return response
            .writeHead(307, {
              location:
                '/chatflow/4.0/document/' + scope + '/proof/native/index.html',
            })
            .end();
        const fields = {
          'scope-id': scope,
          'thread-id': thread,
          'workspace-id': f.identity.workspaceId,
          'employee-instance-id': f.identity.employeeInstanceId,
          'organization-id': f.identity.organizationId,
          'viewer-id': f.identity.personId,
          'native-session-id':
            mode === 'draft-key-collision'
              ? 'contentWidth'
              : thread === f.selection.threadId
                ? 'root'
                : 'root-' + thread,
          'binding-ref': f.owner.bindingRef,
          'graph-rev': graph.rev,
        };
        const attributes = Object.entries(fields)
          .map(([key, value]) => `data-${key}="${value}"`)
          .join(' ');
        return send(
          'text/html',
          `<!doctype html><head><script data-scope-id="${scope}"${mode === 'pending-elements' ? ` data-public-startup-bundles='["${heldPublicUrl}"]'` : ''}>${initialDocumentLifecycle}</script>${mode === 'style' || mode === 'pending-elements' ? '<link rel="stylesheet" data-allrice-document-asset="style" href="/first.css">' : ''}</head><body ${mode === 'claimed-async' ? 'data-auto-dispose="1"' : ''}><div id="app" ${attributes}></div>${mode === 'claimed-sync' ? '<script>globalThis.__DSH_BOOT_READY__ = {};</script>' : mode === 'draft-storage' ? '<script>Object.defineProperty(Storage.prototype,"getItem",{value:Storage.prototype.getItem,writable:false,configurable:false})</script>' : ''}<script type="module" data-allrice-document-asset="entry" src="/${mode === 'style' || mode === 'entry' || mode === 'pending-elements' ? 'first' : 'child'}.js"></script></body>`,
        );
      }
      if (url.pathname.startsWith('/chatflow/4.0/document/'))
        return response
          .writeHead(503, { 'content-type': 'application/json' })
          .end('{}');
      if (url.pathname === '/api/v1/d-entry/profile/bootstrap') {
        bootstrapScopes.push(url.searchParams.get('scopeId')!);
        if (
          startup === 'claimed-async' &&
          knownScopes.get(url.searchParams.get('scopeId')!) ===
            f.selection.threadId
        )
          return response.writeHead(503).end();
        return send(
          'application/json',
          JSON.stringify({
            version: 1,
            scopeReference: { scopeId: url.searchParams.get('scopeId') },
            bindingRef: f.owner.bindingRef,
            graph,
            injections: [
              {
                kind: 'script-src',
                placement: 'head',
                src: graph.batches[0]!.url,
              },
            ],
          }),
        );
      }
      if (url.pathname === '/api/v1/d-entry/profile/assets') {
        const close = cancelled;
        response.once('close', () => close.resolve());
        response.writeHead(200, { 'Content-Type': 'application/javascript' });
        response.write('window.nativeLateRegistration = ');
        transfer.resolve(response);
        return;
      }
      // The next URL is enough to detect navigation. A second VM and launch
      // are outside this test's close boundary.
      if (url.pathname === '/chatflow/4.0')
        return send('text/html', '<!doctype html><p>Next selection</p>');
      return send(
        'text/html',
        '<!doctype html><div id="root"></div><script type="module" src="/outer.js"></script>',
      );
    });
    const browser = await chromium.launch({
      executablePath: browserExecutable,
    });
    closes.push(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
      { name: 'allrice_session', value: sessionToken, url: f.origin },
    ]);
    const start = f.origin + '/old?' + new URLSearchParams(f.selection);
    const select = (page: Page, selection: typeof f.selection) =>
      page.evaluate(
        (query) =>
          (
            window as unknown as { updateEmployeeQuery(value: string): void }
          ).updateEmployeeQuery(query),
        new URLSearchParams(selection).toString(),
      );
    async function issued(page: Page, threadId: string, previous?: string) {
      let found: string | undefined;
      await expect
        .poll(async () => {
          const input = await page
            .locator('iframe')
            .evaluate(
              (node) => (node as HTMLIFrameElement).contentDocument?.URL,
            );
          if (!input) return false;
          const address = new URL(input, f.origin);
          const scope = address.searchParams.get('scopeId');
          if (
            address.searchParams.get('threadId') !== threadId ||
            !scope ||
            scope === previous
          )
            return false;
          found = scope;
          return (await f.invokeThread(scope, threadId)).status === 200;
        })
        .toBe(true);
      return found!;
    }
    async function finishLocal(
      frame: ReturnType<Page['frames']>[number],
      shouldFail: boolean,
    ) {
      await frame.evaluate(
        (fail) =>
          (
            window as unknown as { releaseDispose(fail: boolean): void }
          ).releaseDispose(fail),
        shouldFail,
      );
    }
    for (const scenario of [
      'navigate',
      'unknown',
      'child-hides',
      'query',
      'query-unknown',
      'query-roundtrip',
    ] as const) {
      transfer = deferred<ServerResponse>();
      cancelled = deferred<void>();
      const page = await context.newPage();
      try {
        await page.goto(start);
        const blocked = await transfer.promise;
        expect(blocked.writableFinished).toBe(false);
        const frame = page
          .frames()
          .find((candidate) =>
            candidate.url().includes('/chatflow/4.0/document'),
          )!;
        const scopeId = new URL(frame.url()).searchParams.get('scopeId')!;
        expect((await f.invoke(scopeId)).status).toBe(200);
        const next = { ...f.selection, threadId: randomUUID() };
        f.registerThread(next.threadId);
        if (scenario.startsWith('query')) {
          await select(page, next);
        } else
          await frame.evaluate(
            ({ scenario, scopeId, next }) => {
              if (scenario === 'child-hides')
                window.dispatchEvent(new Event('pagehide'));
              else
                parent.postMessage(
                  {
                    type: 'allrice:d-entry:navigate',
                    scopeId,
                    selection: next,
                  },
                  location.origin,
                );
            },
            { scenario, scopeId, next },
          );
        await cancelled.promise;
        expect(blocked.destroyed).toBe(true);
        expect(blocked.writableFinished).toBe(false);
        await frame.locator('body[data-dispose=waiting]').waitFor();
        expect((await f.invoke(scopeId)).status).toBe(404);
        expect(page.url()).toBe(start);
        expect(directoryQueries).not.toContain(next.threadId);
        expect(
          await frame.evaluate(() =>
            Object.hasOwn(window, 'nativeLateRegistration'),
          ),
        ).toBe(false);
        if (scenario === 'query-roundtrip') {
          await select(page, f.selection);
          transfer = deferred<ServerResponse>();
        }
        await finishLocal(
          frame,
          scenario === 'unknown' || scenario === 'query-unknown',
        );
        if (scenario === 'navigate')
          await page.waitForURL('**/chatflow/4.0?**');
        else if (scenario === 'query') {
          await issued(page, next.threadId, scopeId);
        } else if (scenario === 'query-roundtrip') {
          const fresh = await issued(page, f.selection.threadId, scopeId);
          await transfer.promise;
          const freshFrame = page
            .frames()
            .find((candidate) => candidate.url().includes(fresh))!;
          expect(directoryQueries).not.toContain(next.threadId);
          const final = { ...f.selection, threadId: randomUUID() };
          f.registerThread(final.threadId);
          await select(page, final);
          await finishLocal(freshFrame, false);
          await issued(page, final.threadId, fresh);
        } else if (scenario === 'unknown' || scenario === 'query-unknown') {
          await page.getByRole('alert').waitFor();
          expect(page.url()).toBe(start);
          expect(directoryQueries).not.toContain(next.threadId);
        }
      } finally {
        await page.close();
      }
    }
    for (const phase of [
      'style',
      'entry',
      'pending-elements',
      'document',
      'redirect',
      'claimed-sync',
      'draft-storage',
      'draft-key-collision',
      'claimed-async',
    ] as const) {
      startup = phase;
      firstScript = deferred<ServerResponse>();
      firstStyle = deferred<ServerResponse>();
      initialScriptClose = deferred();
      initialStyleClose = deferred();
      earlyTransfer = deferred();
      earlyClose = deferred();
      const page = await context.newPage();
      try {
        await page.goto(start, { waitUntil: 'commit' });
        const frameAddress = await page.locator('iframe').getAttribute('src');
        const scopeId = new URL(frameAddress!, f.origin).searchParams.get(
          'scopeId',
        )!;
        const next = { ...f.selection, threadId: randomUUID() };
        f.registerThread(next.threadId);
        if (phase === 'style' || phase === 'pending-elements') {
          const [script, style] = await Promise.all([
            firstScript.promise,
            firstStyle.promise,
          ]);
          expect(script.writableFinished).toBe(false);
          if (phase === 'style') style.writeHead(503).end();
          else {
            const early = await earlyTransfer.promise;
            await select(page, next);
            await earlyClose.promise;
            expect(early.writableFinished).toBe(false);
          }
          await initialScriptClose.promise;
          expect(script.writableFinished).toBe(false);
          if (phase === 'pending-elements') {
            await initialStyleClose.promise;
            expect(style.writableFinished).toBe(false);
          }
        }
        if (phase !== 'pending-elements')
          await page.getByRole('alert').waitFor();
        await expect
          .poll(async () => (await f.invoke(scopeId)).status)
          .toBe(404);
        if (phase === 'draft-storage' || phase === 'draft-key-collision') {
          expect(bootstrapScopes).not.toContain(scopeId);
          const refused = page
            .frames()
            .find((frame) => frame.url().includes(scopeId));
          expect(
            await refused!.locator('textarea,[contenteditable=true]').count(),
          ).toBe(0);
        }
        if (phase !== 'pending-elements') await select(page, next);
        await issued(page, next.threadId, scopeId);
      } finally {
        await page.close();
      }
    }
    await context.close();
  },
);
