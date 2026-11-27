import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { chromium, type Page } from 'playwright-core';
import { expect, it, vi } from 'vitest';
import {
  dEntryRegisteredThreadHeader,
  type DEntryPageOpenedSchema,
  DEntryProfileGraphSchema,
} from '@allrice/contracts';
import { deferred } from '../../../../packages/d-entry-principal/test/host-fixture.js';
import { initialDocumentLifecycle } from '../../../web/lib/d-entry/initial-document.js';
import {
  fixture,
  buildProfileFixture,
  closes,
  closePage,
  open,
  sessionToken,
} from './principal-page-carrier.fixture.js';

const browserExecutable =
  process.env.ALLRICE_BROWSER_EXECUTABLE ??
  process.env.ALLRICE_MANAGED_BROWSER_EXECUTABLE;

it
  .skipIf(!browserExecutable)
  .each(['attached', 'unattached', 'stall', 'native-create'] as const)(
  'rc.2 workspace/follow and the blank composer (%s)',
  { timeout: 60_000 },
  async (scenario) => {
    const stall = scenario === 'stall';
    const nativeCreate = scenario === 'native-create';
    const release = await buildProfileFixture();
    const manifest: { files: { path: string }[] } = JSON.parse(
      await readFile(join(release.directory, 'artifact.json'), 'utf8'),
    );
    const staticFiles = new Set(manifest.files.map(({ path }) => '/' + path));
    const mime: Record<string, string> = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.wasm': 'application/wasm',
    };
    const f = await fixture(release);
    const fromComposition = createRequire(
      new URL(
        '../../../../packages/dsh-web-composition/package.json',
        import.meta.url,
      ),
    );
    const fromCli = createRequire(
      fromComposition.resolve('@deepseek-ai/dsh/package.json'),
    );
    const runnerModule = '@deepseek-ai/dsh-cordis-host-runner';
    const { default: CordisRunner } = await import(
      pathToFileURL(fromCli.resolve(runnerModule)).href
    );
    const { TYPERT } = await import(
      pathToFileURL(fromCli.resolve(`${runnerModule}/typert`)).href
    );
    const workspaceModule = '@deepseek-ai/dsh-api-workspace-controller';
    const { default: WorkspaceController } = await import(
      pathToFileURL(fromCli.resolve(workspaceModule)).href
    );
    const { TYPERT: WorkspaceMetadata } = await import(
      pathToFileURL(fromCli.resolve(`${workspaceModule}/typert`)).href
    );
    const nativeWorkspace = {
      id: randomUUID(),
      path: '/work',
      title: 'Fixture work',
      sessionIds: scenario === 'unattached' ? [] : ['root'],
      archivedSessionIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    f.host.host.provide('workspaceRegistry', {
      list: () => [nativeWorkspace],
      get: (id: string) =>
        id === nativeWorkspace.id ? nativeWorkspace : undefined,
      archivedSessionIds: [],
      pinnedSessionIds: [],
    });
    await f.host.host.plugin(WorkspaceController, {
      documentsDirectory: '/work',
    });
    f.host.host.typert.register(WorkspaceMetadata);

    await f.host.host.plugin(SystemPrompt);
    await f.host.host.plugin(ToolRuntime);
    await f.host.host.plugin(CordisRunner);
    f.host.host.typert.register(TYPERT);
    const runner = f.host.host.get('dynamicCordisRunner');
    if (!runner) throw Error('The native Cordis runner did not start');
    const { pluginId, packageId } = runner.define({
      sessionId: 'other',
      plugin: { kind: 'new', idPrefix: 'fixt' },
      name: 'Fixture Cordis package',
      purpose: 'Read-only inventory test',
      code: { host: 'return { name: "fixture-host" }' },
    });
    const blockedMethods = [
      'runHostHalf',
      'resolveRequestRun',
      'settleUserRun',
    ] as const;
    const blockedHandlers = blockedMethods.map((method) =>
      vi.spyOn(CordisRunner.prototype, method),
    );
    closes.push(async () =>
      blockedHandlers.forEach((handler) => handler.mockRestore()),
    );
    f.host.catalog.items = f.host.catalog.items.map((row) =>
      String(row.sessionId) === 'root'
        ? { ...row, blank: !nativeCreate, cwd: '/work' }
        : row,
    );
    const life = nativeCreate ? undefined : await open(f);
    const createdThread = randomUUID();
    const createdNativeId = 'native-created';
    let documentLoads = 0;
    let registered = false;
    const createReplies: unknown[] = [];
    if (nativeCreate) {
      const registerFixture = f.registerRoot.getMockImplementation()!;
      f.registerRoot.mockImplementation(
        async (context, identity, receipt, active) => {
          expect(receipt.nativeSessionId).toBe(createdNativeId);
          const registeredFixture = await registerFixture(
            context,
            identity,
            receipt,
            active,
          );
          const root = {
            ...registeredFixture,
            identity: { ...identity, threadId: createdThread },
            thread: { ...registeredFixture.thread, id: createdThread },
          };
          registered = true;
          f.findRoot.mockImplementation(async (_request, _identity, _vm, id) =>
            id === createdNativeId ? root : undefined,
          );
          const created = f.host.catalog.items.find(
            ({ sessionId }) => sessionId === createdNativeId,
          );
          if (created) Object.assign(created, { cwd: '/work', blank: true });
          nativeWorkspace.sessionIds.push(createdNativeId);
          f.host.host.emit('domain/changed', {
            domain: 'workspace',
            table: 'workspaces',
            operation: 'put',
            key: nativeWorkspace.id,
            value: {
              path: nativeWorkspace.path,
              title: nativeWorkspace.title,
              sessionIds: [...nativeWorkspace.sessionIds],
              createdAt: nativeWorkspace.createdAt,
              updatedAt: nativeWorkspace.updatedAt,
            },
          });
          return root;
        },
      );
    }
    const shell = nativeCreate
      ? ((await fromComposition('esbuild').build({
          stdin: {
            contents: `import { createRoot } from 'react-dom/client';
            import { EmployeeNativePage } from './app/chatflow/4.0/employee-native-page';
            createRoot(document.getElementById('shell')).render(<EmployeeNativePage prepare query={location.search.slice(1)} />);`,
            loader: 'tsx',
            resolveDir: join(process.cwd(), 'apps/web'),
          },
          bundle: true,
          write: false,
          outdir: '/employee-entry-native-create',
          jsx: 'automatic',
          loader: {
            '.woff': 'dataurl',
            '.woff2': 'dataurl',
            '.ttf': 'dataurl',
            '.svg': 'dataurl',
          },
        })) as { outputFiles: Array<{ path: string; contents: Uint8Array }> })
      : undefined;
    const unary: string[] = [];
    const startupReplies = new Map<string, unknown>();
    const startupMethods = new Set([
      'session/list',
      'dynamicCordisRunner/inventory',
      'dynamicCordisRunner/syncInspectManifest',
    ]);
    const graph = DEntryProfileGraphSchema.parse(release.graph);
    const application = graph.batches.find(
      ({ phase }) => phase === 'application',
    )!;
    let applicationReads = 0;
    f.web.on('request', async (request, response) => {
      const url = new URL(request.url!, f.origin);
      const copy = async (result: Response) => {
        response
          .writeHead(result.status, {
            'content-type': result.headers.get('content-type')!,
            ...(result.headers.has(dEntryRegisteredThreadHeader) && {
              [dEntryRegisteredThreadHeader]: result.headers.get(
                dEntryRegisteredThreadHeader,
              )!,
            }),
          })
          .end(Buffer.from(await result.arrayBuffer()));
      };
      try {
        if (nativeCreate && url.pathname === '/api/v1/d-entry/native-prewarm')
          return response.writeHead(204).end();
        if (nativeCreate && url.pathname === '/api/v1/d-entry/identity')
          return await copy(Response.json({ identity: f.identity }));
        if (shell && url.pathname === '/chatflow/4.0')
          return response
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end(
              '<!doctype html><link rel="stylesheet" href="/shell.css"><div id="shell"></div><script src="/shell.js"></script>',
            );
        if (
          shell &&
          (url.pathname === '/shell.js' || url.pathname === '/shell.css')
        ) {
          const type = extname(url.pathname);
          return response
            .writeHead(200, { 'content-type': mime[type]! })
            .end(
              shell.outputFiles.find((file) => file.path.endsWith(type))!
                .contents,
            );
        }
        if (url.pathname === '/api/v1/d-entry/native-rpc') {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          unary.push(input.endpoint);
          const result = await f.invoke(input.scopeId, sessionToken, input);
          if (nativeCreate && input.endpoint === 'session/create')
            createReplies.push({
              status: result.status,
              ...(await result.clone().json()),
              thread: result.headers.get(dEntryRegisteredThreadHeader),
            });
          if (startupMethods.has(input.endpoint))
            startupReplies.set(
              input.endpoint,
              (await result.clone().json()).result,
            );
          return await copy(result);
        }
        for (const kind of ['bootstrap', 'assets'] as const) {
          if (url.pathname !== '/api/v1/d-entry/profile/' + kind) continue;
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
          return await copy(
            await f.publish(
              kind,
              life?.scopeId ?? url.searchParams.get('scopeId')!,
              Object.fromEntries(url.searchParams),
            ),
          );
        }
        if (staticFiles.has(url.pathname)) {
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
              '<!doctype html><iframe src="/employee" style="width:100%;height:100vh"></iframe>',
            );
          return;
        }
        if (
          url.pathname !== '/employee' &&
          url.pathname !== '/chatflow/4.0/document'
        ) {
          response.writeHead(404).end();
          return;
        }
        documentLoads++;
        const scopeId = life?.scopeId ?? url.searchParams.get('scopeId');
        if (!scopeId) return response.writeHead(404).end();
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
        response.writeHead(200, { 'content-type': 'text/html' })
          .end(`<!doctype html>
          <link rel="stylesheet" href="/managed/employee-web-entry.css">
          <script data-scope-id="${scopeId}">${initialDocumentLifecycle}</script>
          <div id="app" data-scope-id="${scopeId}" data-thread-id="${selection.threadId}"
            data-workspace-id="${identity.workspaceId}" data-employee-instance-id="${identity.employeeInstanceId}"
            data-organization-id="${identity.organizationId}" data-viewer-id="${identity.personId}"
            data-native-session-id="root" data-binding-ref="${f.owner.bindingRef}" data-graph-rev="${graph.rev}"></div>
          <script id="allrice-employee-directory" type="application/json">${JSON.stringify(directory)}</script>
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
    if (nativeCreate) {
      // rc.2 restores its saved desktop selection before this test's shortcut.
      await page.addInitScript(() => {
        localStorage.setItem(
          'dsh.sessions.current',
          JSON.stringify({ sessionId: 'root' }),
        );
      });
    }
    const streams = new Map<string, string>();
    const firstItems: string[] = [];
    const workspaceBaselines: unknown[] = [];
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
        if (
          frame.type === 'item' &&
          frame.value.type === 'baseline' &&
          streams.get(frame.streamId) === 'workspace/follow'
        )
          workspaceBaselines.push(frame.value.value);
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
    await page.goto(
      nativeCreate
        ? f.origin + '/chatflow/4.0?' + new URLSearchParams(f.selection)
        : f.origin,
    );
    if (stall) {
      await expect.poll(() => applicationReads, { timeout: 15_000 }).toBe(1);
      await page.clock.fastForward(30_100);
      await expect.poll(() => applicationReads, { timeout: 15_000 }).toBe(2);
      await page.clock.fastForward(30_100);
      await page.locator('html[data-asset-timeout="asset-timeout"]').waitFor();
      expect(applicationReads).toBe(2);
      expect(unary).not.toContain('session/list');
      await context.close();
      return;
    }
    const workbench = page.frameLocator('iframe');
    const editor = workbench.locator(
      '[role="textbox"][data-composer-input][contenteditable="true"]',
    );
    try {
      // The iframe loads its native bundles before opening workspace/follow.
      // Navigation alone does not mean the browser has even sent that open.
      await expect
        .poll(() => workspaceBaselines.length, { timeout: 15_000 })
        .toBeGreaterThan(0);
      expect(workspaceBaselines).toMatchObject([
        {
          items: [
            {
              workspaceId: nativeWorkspace.id,
              sessionIds: scenario === 'unattached' ? [] : ['root'],
            },
          ],
        },
      ]);
      if (scenario === 'unattached') {
        await workbench
          .locator('[data-composer-input][contenteditable="false"]')
          .waitFor({ timeout: 15_000 });
        await workbench
          .getByText(/选择一个工作区开始|Choose a workspace to start/)
          .waitFor({ timeout: 15_000 });
        await context.close();
        return;
      }
      await editor.fill('未发送的原生草稿', { timeout: 15_000 });
    } catch (error) {
      throw Error(
        JSON.stringify({
          unary,
          streamEndpoints: [...streams.values()],
          firstItems,
          workspaceBaselines,
          startupReplies: Object.fromEntries(startupReplies),
          errors,
          text: (
            await workbench
              .locator('body')
              .innerText({ timeout: 1_000 })
              .catch(() => '')
          ).slice(0, 300),
        }),
        { cause: error },
      );
    }
    expect(await editor.isEditable()).toBe(true);
    if (nativeCreate) {
      const mark = randomUUID();
      const frame = page.locator('iframe');
      await frame.evaluate((node, mark) => {
        node.dataset.fixtureIdentity = mark;
      }, mark);
      await workbench.locator('#app').evaluate((node, mark) => {
        node.dataset.fixtureDocument = mark;
      }, mark);
      await editor.focus();
      await page.keyboard.press(
        process.platform === 'darwin' ? 'Meta+Alt+N' : 'Control+Alt+N',
      );
      await expect
        .poll(() => unary.includes('session/create'), { timeout: 15_000 })
        .toBe(true);
      try {
        await page.waitForURL(
          (url) => url.searchParams.get('threadId') === createdThread,
          { timeout: 20_000 },
        );
      } catch (error) {
        throw new Error(
          JSON.stringify({
            registered,
            createReplies,
            unary,
            errors,
            nativeSessions: await workbench
              .locator('[data-row-key^="session:"]')
              .evaluateAll((nodes) =>
                nodes.map((node) => node.getAttribute('data-row-key')),
              ),
            text: (
              await workbench
                .locator('body')
                .innerText({ timeout: 1_000 })
                .catch(() => '')
            ).slice(0, 450),
          }),
          { cause: error },
        );
      }
      const row = workbench.locator(
        '[data-row-key="session:' + createdThread + '"]',
      );
      await row.waitFor({ timeout: 15_000 });
      await expect
        .poll(
          () =>
            editor.evaluate((node) =>
              node
                .closest('[data-conversation-session]')
                ?.getAttribute('data-conversation-session'),
            ),
          { timeout: 10_000 },
        )
        .toBe(createdNativeId);
      const draft = '原生新会话草稿';
      await editor.fill(draft, { timeout: 15_000 });
      const draftPrefix =
        'allrice:d-entry:conversation:v1:' +
        [
          f.identity.organizationId,
          f.identity.personId,
          f.identity.workspaceId,
          f.identity.employeeInstanceId,
        ].join('/') +
        '/';
      await expect
        .poll(
          () =>
            page.evaluate(
              (key) => localStorage.getItem(key),
              draftPrefix +
                createdThread +
                '/dsh.conversation.' +
                createdNativeId,
            ),
          { timeout: 10_000 },
        )
        .toContain(draft);
      expect(
        await page.evaluate(
          (key) => localStorage.getItem(key),
          draftPrefix +
            f.selection.threadId +
            '/dsh.conversation.' +
            createdNativeId,
        ),
      ).toBeNull();
      expect(await editor.isEditable()).toBe(true);
      expect(await frame.getAttribute('data-fixture-identity')).toBe(mark);
      expect(
        await workbench.locator('#app').getAttribute('data-fixture-document'),
      ).toBe(mark);
      expect(documentLoads).toBe(1);
      expect(f.registerRoot).toHaveBeenCalledTimes(1);
      await context.close();
      return;
    }
    if (!life) throw Error('Missing fixture page carrier');
    expect(
      await workbench
        .getByText(/选择一个工作区开始|Choose a workspace to start/)
        .count(),
    ).toBe(0);
    await expect
      .poll(() => firstItems)
      .toEqual(
        expect.arrayContaining([
          'session/control:baseline',
          'session/follow:snapshot',
        ]),
      );
    expect(startupReplies.get('session/list')).toMatchObject({
      ok: true,
      value: {
        items: expect.arrayContaining([
          expect.objectContaining({ sessionId: 'root', blank: true }),
        ]),
      },
    });
    await expect
      .poll(() => startupReplies.get('dynamicCordisRunner/inventory'))
      .toMatchObject({
        ok: true,
        value: [
          {
            pluginId,
            agentId: 'other',
            packages: [{ packageId, name: 'Fixture Cordis package' }],
          },
        ],
      });
    await expect
      .poll(() => startupReplies.get('dynamicCordisRunner/syncInspectManifest'))
      .toEqual({ ok: true, value: null });
    expect(unary).not.toContain('session/prompt');

    const refused = {
      ok: false,
      reason: 'rejected',
      message: 'Synthetic decision',
    };
    const blockedArgs = {
      runHostHalf: {
        agentId: 'other',
        pluginId,
        packageId,
        mode: 'run',
        requestId: null,
        approveFutureVersions: false,
      },
      resolveRequestRun: { requestId: 'fixture-request', resolution: refused },
      settleUserRun: { agentId: 'other', pluginId, resolution: refused },
    };
    for (const method of blockedMethods) {
      const endpoint = `dynamicCordisRunner/${method}`;
      const response = await page.request.post(
        `${f.origin}/api/v1/d-entry/native-rpc`,
        {
          data: {
            selection: f.selection,
            scopeId: life.scopeId,
            rpcId: randomUUID(),
            endpoint,
            payload: { args: blockedArgs[method] },
          },
        },
      );
      expect(unary).toContain(endpoint);
      expect(await response.json()).toMatchObject({
        result: {
          ok: false,
          error: {
            code: 'remote-access/denied',
            details: { action: endpoint, reason: 'plugin-management' },
          },
        },
      });
    }
    for (const handler of blockedHandlers)
      expect(handler).not.toHaveBeenCalled();
    expect(unary).not.toContain('session/prompt');
    closePage(life.peer);
    expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
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
          `<!doctype html><head><script data-scope-id="${scope}">${initialDocumentLifecycle}</script>${mode === 'style' || mode === 'pending-elements' ? '<link rel="stylesheet" data-allrice-document-asset="style" href="/first.css">' : ''}</head><body ${mode === 'claimed-async' ? 'data-auto-dispose="1"' : ''}><div id="app" ${attributes}></div>${mode === 'claimed-sync' ? '<script>globalThis.__DSH_BOOT_READY__ = {};</script>' : mode === 'draft-storage' ? '<script>Object.defineProperty(Storage.prototype,"getItem",{value:Storage.prototype.getItem,writable:false,configurable:false})</script>' : ''}<script type="module" data-allrice-document-asset="entry" src="/${mode === 'style' || mode === 'entry' || mode === 'pending-elements' ? 'first' : 'child'}.js"></script></body>`,
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
          else await select(page, next);
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
