import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import type { SessionHistoryRecord } from '@deepseek-ai/dsh-api-session-controller/types';
import { chromium, type Page } from 'playwright-core';
import { expect, it, vi } from 'vitest';
import {
  dEntryRegisteredThreadHeader,
  type DEntryPageOpenedSchema,
  DEntryProfileBootstrapSchema,
  DEntryProfileGraphSchema,
  ReferenceLibraryOptionsSchema,
  ReferenceRevisionSchema,
} from '@allrice/contracts';
import {
  deferred,
  summary,
} from '../../../../packages/d-entry-principal/test/host-fixture.js';
import { skillTestCatalog } from '../../../web/test/employee-skills-host-data.js';
import {
  initialDocumentLifecycle,
  publicStartupBundleUrls,
} from '../../../web/lib/d-entry/initial-document.js';
import { publicProfileBundles } from '../../../web/lib/d-entry/public-profile-bundles.js';
import {
  fixture,
  buildProfileFixture,
  closes,
  sessionToken,
  otherToken,
} from './principal-page-carrier.fixture.js';

const browserExecutable =
  process.env.ALLRICE_BROWSER_EXECUTABLE ??
  process.env.ALLRICE_MANAGED_BROWSER_EXECUTABLE;

it
  .skipIf(!browserExecutable)
  .each([
    'refresh',
    'cold-assets',
    'stall',
    'switch',
    'baseline',
    'attached',
    'unattached',
    'native-create',
    'outer-create',
    'wallet-storage',
    'wallet-messages',
    'wallet-owned-error',
    ...(process.platform === 'darwin'
      ? (['native-create-linux'] as const)
      : []),
  ] as const)(
  'rc.2 workbench composer (%s)',
  { timeout: process.env.ALLRICE_RUN_ASSET_BENCH ? 200_000 : 120_000 },
  async (scenario) => {
    const coldAssets = scenario === 'cold-assets';
    const bench = coldAssets && process.env.ALLRICE_RUN_ASSET_BENCH;
    const stall = scenario === 'stall';
    const switching = scenario === 'switch' || scenario === 'baseline';
    const outerCreate = scenario === 'outer-create';
    const nativeCreate = outerCreate || scenario.startsWith('native-create');
    const createAfterSwitch =
      scenario === 'native-create-linux' ||
      (nativeCreate && !outerCreate && process.platform !== 'darwin');
    const wallet = scenario.startsWith('wallet-');
    const realShell = switching || nativeCreate || coldAssets || wallet;
    const release = await buildProfileFixture();
    // The production pack and guest materialize the same code separately.
    // Let rc.2 compute each graph and serve exact bytes for Worker attestation.
    const independentlyInstalled = coldAssets || scenario === 'refresh';
    const live = independentlyInstalled ? await buildProfileFixture() : release;
    const sealed = await readFile(join(release.directory, 'artifact.json'));
    const manifest: {
      source: {
        head: string;
        contributionInputs: { path: string; sha256: string }[];
      };
      files: { path: string }[];
      profile: { files: { reference: string; sha256: string }[] };
    } = JSON.parse(sealed.toString());
    const ownerPath =
      'packages/dsh-web-composition/src/employee-product-owner.ts';
    expect(manifest.source.contributionInputs).toContainEqual({
      path: ownerPath,
      sha256: createHash('sha256')
        .update(await readFile(ownerPath))
        .digest('hex'),
    });
    const staticFiles = new Set(manifest.files.map(({ path }) => '/' + path));
    const mime: Record<string, string> = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.wasm': 'application/wasm',
    };
    const f = await fixture({ ...live, directory: release.directory });
    let otherThread = randomUUID();
    let outerCreated = false;
    const revokeOther =
      switching || createAfterSwitch
        ? f.registerThread(otherThread)
        : undefined;
    const cross =
      scenario === 'switch' ? await f.registerOtherEmployee() : undefined;
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
      sessionIds:
        scenario === 'unattached'
          ? []
          : [
              'root',
              ...(switching || createAfterSwitch
                ? ['root-' + otherThread]
                : []),
            ],
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
      ['root', 'root-' + otherThread].includes(String(row.sessionId))
        ? {
            ...row,
            blank: !nativeCreate,
            cwd: '/work',
            ...(outerCreate && { agentAvailable: true }),
          }
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
    const realParent:
      { outputFiles: { path: string; text: string }[] } | undefined = realShell
      ? await require('esbuild').build({
          stdin: {
            contents: `import { createRoot } from 'react-dom/client';
              import { EmployeeNativePage } from './app/chatflow/4.0/employee-native-page';
              createRoot(document.getElementById('root')).render(
                <EmployeeNativePage prepare query={location.search.slice(1)}
                  startupAssetUrls={JSON.parse(document.getElementById('startup-assets')?.textContent ?? '[]')} />);`,
            loader: 'tsx',
            resolveDir: join(process.cwd(), 'apps/web'),
          },
          bundle: true,
          write: false,
          outdir: '/fixture-dsh-switch',
          jsx: 'automatic',
          minify: coldAssets,
          loader: {
            '.woff': 'dataurl',
            '.woff2': 'dataurl',
            '.ttf': 'dataurl',
            '.svg': 'dataurl',
          },
        })
      : undefined;
    const createdThread = randomUUID();
    const createdNativeId = 'native-created';
    const outerNativeId = 'native-outer-created';
    let expectedNativeId: string | undefined;
    if (outerCreate) {
      let records: readonly SessionHistoryRecord[] = [];
      f.host.catalog.snapshotRecords = (id) => (id === 'root' ? records : []);
      f.host.catalog.onPrompt = ({ sessionId, content, requestId }) => {
        expect(sessionId).toBe('root');
        expect(content).toEqual([{ type: 'text', text: '你好' }]);
        const message = {
          role: 'user',
          id: randomUUID(),
          source: { kind: 'user', rpcId: requestId },
          content: [{ type: 'text', text: '你好' }],
        };
        const assistant = {
          role: 'assistant',
          id: randomUUID(),
          source: { kind: 'model', provider: 'fixture', model: 'fixture' },
          content: [{ type: 'text', text: '隔离会话的首条回复' }],
        };
        const events: Omit<SessionHistoryRecord['event'], 'seq' | 'time'>[] = [
          { type: 'turn/start', data: { turn: 1 } },
          { type: 'user/message', data: message, surfaceOp: 'append' },
          { type: 'step/start', data: { turn: 1, step: 1 } },
          {
            type: 'assistant/message',
            data: {
              turn: 1,
              step: 1,
              message: assistant,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              stream: [],
            },
            surfaceOp: 'append',
          },
          { type: 'step/end', data: { turn: 1, step: 1 } },
          {
            type: 'turn/end',
            data: { turn: 1, reason: { kind: 'completed' } },
          },
        ];
        records = events.map((event, index) => ({
          type: 'event',
          event: { ...event, seq: index + 1, time: Date.now() },
        }));
      };
      f.host.catalog.allocateSessionId = () =>
        summary(expectedNativeId ?? randomUUID()).sessionId;
    }
    const nativeIdsByThread = new Map<string, string>();
    let registered = false;
    const createReplies: unknown[] = [];
    const promptReplies: unknown[] = [];
    const createdResponse = deferred();
    const deliverCreatedResponse = deferred();
    let holdCreatedResponse = false;
    let switchProofRequests = 0;
    if (nativeCreate) {
      const registerFixture = f.registerRoot.getMockImplementation()!;
      const nativeRoots = new Map<
        string,
        Awaited<ReturnType<typeof registerFixture>>
      >();
      f.findRoot.mockImplementation(async (_request, _identity, _vm, id) =>
        nativeRoots.get(id),
      );
      f.registerRoot.mockImplementation(
        async (context, identity, receipt, active) => {
          const nativeId = receipt.nativeSessionId;
          const isOuter = outerCreate && nativeId === outerNativeId;
          const registeredFixture = await registerFixture(
            context,
            identity,
            receipt,
            active,
          );
          const threadId = isOuter
            ? otherThread
            : nativeId === createdNativeId
              ? createdThread
              : registeredFixture.thread.id;
          if (isOuter) outerCreated = true;
          const root = {
            ...registeredFixture,
            identity: { ...identity, threadId },
            thread: { ...registeredFixture.thread, id: threadId },
          };
          registered = true;
          f.rememberRoot(root);
          nativeRoots.set(nativeId, root);
          nativeIdsByThread.set(threadId, nativeId);
          const created = f.host.catalog.items.find(
            ({ sessionId }) => sessionId === nativeId,
          );
          if (created) Object.assign(created, { cwd: '/work', blank: true });
          nativeWorkspace.sessionIds.push(nativeId);
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
    const unary: string[] = [];
    const startupReplies = new Map<string, unknown>();
    const startupMethods = new Set([
      'session/list',
      'dynamicCordisRunner/inventory',
      'dynamicCordisRunner/syncInspectManifest',
    ]);
    const graph = DEntryProfileGraphSchema.parse(release.graph);
    const liveGraph = DEntryProfileGraphSchema.parse(live.graph);
    const application = liveGraph.batches.find(
      ({ phase }) => phase === 'application',
    )!;
    if (independentlyInstalled)
      expect(application.rev).not.toBe(
        graph.batches.find(({ phase }) => phase === 'application')?.rev,
      );
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
    const applicationPath = [...publicBundles].find(
      ([, bundle]) => bundle.phase === 'application',
    )![0];
    let publicIndex = publicProfileBundles.parse(
      bundles.map(({ reference, revision, sha256 }) => ({
        reference,
        revision,
        sha256,
      })),
    );
    const publicEntry = publicRoot + 'managed/employee-web-entry.js';
    const publicStyle = publicRoot + 'managed/employee-web-entry.css';
    const nativeStyles = manifest.files
      .filter(({ path }) =>
        /^native\/assets\/(index|vendor)-[\w-]+\.css$/.test(path),
      )
      .map(
        ({ path }) =>
          '<link rel="stylesheet" href="' + publicRoot + path + '">',
      )
      .join('');
    let coldPaths: string[] = [];
    let stagedPaths: Set<string> | undefined;
    if (independentlyInstalled) {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'd-entry-warm-')),
      );
      closes.push(() => rm(root, { recursive: true, force: true }));
      await mkdir(join(root, 'apps/worker/dist'), { recursive: true });
      await mkdir(join(root, 'apps/web/.next/server'), { recursive: true });
      await mkdir(join(root, 'apps/web/.next/static'), { recursive: true });
      await cp(release.directory, join(root, 'apps/worker/dist/d-entry-web'), {
        recursive: true,
      });
      const stageModule = new URL(
        '../../../../scripts/dev-release/stage-dsh-profile-assets.mjs',
        import.meta.url,
      );
      const {
        stageDshProfileAssets,
      }: {
        stageDshProfileAssets(root: string, sourceSha: string): Promise<void>;
      } = await import(stageModule.href);
      await stageDshProfileAssets(root, manifest.source.head);
      const index: { paths: string[]; startup: string[]; bundles: unknown } =
        JSON.parse(
          await readFile(
            join(root, 'apps/web/.next/server/dsh-profile.json'),
            'utf8',
          ),
        );
      publicIndex = publicProfileBundles.parse(index.bundles);
      if (coldAssets && bench !== 'baseline')
        coldPaths = index.startup.map((path) => publicRoot + path);
      stagedPaths = new Set(index.paths);
    }
    const coldRequests = new Map<string, number>();
    const coldFinished = new Map<string, number>();
    let readyAt: number | undefined;
    let prewarmAt: number | undefined;
    let frameApplicationAt: number | undefined;
    const operationId = randomUUID();
    const coldWindow = bench === 'overlap' ? 3_000 : bench ? 60_000 : 1_500;
    const applicationTransfers: {
      start: number;
      end?: number;
      bytes: number;
    }[] = [];
    async function sendColdApplication(
      response: ServerResponse,
      bytes: Buffer,
    ) {
      const transfer: (typeof applicationTransfers)[number] = {
        start: performance.now(),
        bytes: 0,
      };
      applicationTransfers.push(transfer);
      const client = new AbortController();
      response.once('close', () => client.abort());
      try {
        const chunkSize = Math.ceil(bytes.length / 100);
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          const chunk = bytes.subarray(offset, offset + chunkSize);
          response.write(chunk);
          transfer.bytes += chunk.byteLength;
          if (offset + chunk.byteLength < bytes.length)
            await delay(400, undefined, { signal: client.signal });
        }
        transfer.end = performance.now();
        response.end();
      } catch (error) {
        if (!client.signal.aborted) throw error;
      }
    }
    let earlyUrls: string[] = [];
    const seenEarly = new Set<string>();
    const earlyBootstrapSeen = deferred<void>();
    const traffic: { kind: string; start: number; end?: number }[] = [];
    let started = 0;
    let firstRpc: number | undefined;
    let applicationReads = 0;
    let browserBootstrapReads = 0;
    let scopedBundleReads = 0;
    let documentLoads = 0;
    const panelPath = `/api/v1/d-entry/panels/${f.identity.employeeInstanceId}/`;
    const skillsPath = panelPath + 'skills';
    const legacySkillsPath = `/api/v1/employee-instances/${f.identity.employeeInstanceId}/skills`;
    const catalog = skillTestCatalog(
      f.identity.employeeInstanceId,
      f.identity.workspaceId,
    );
    const panelViewer = {
      viewerId: f.identity.personId,
      workspaceId: f.identity.workspaceId,
    };
    const materialPin = {
      sourceId: randomUUID(),
      revisionId: randomUUID(),
      revision: 1,
      ownership: {
        scope: 'company',
        organizationId: f.identity.organizationId,
      },
      fileName: '第四季度销售口径说明.pdf',
      purpose: '核对销售统计口径',
      checksum: 'sha256:' + 'a'.repeat(64),
    };
    const reference = ReferenceRevisionSchema.parse({
      ...materialPin,
      status: 'active',
      processing: 'ready',
      failure: null,
      canMaintain: true,
      canReference: true,
      publication: {
        origin: 'upload',
        publisherId: panelViewer.viewerId,
        publisherName: '我',
        audience: { scope: 'company', departmentIds: [] },
        audienceRevision: 1,
      },
      sizeBytes: 1024,
      mediaType: 'application/pdf',
      createdAt: '2026-11-27T12:00:00.000Z',
      origin: null,
    });
    const materialOptions = ReferenceLibraryOptionsSchema.parse({
      workspaceId: panelViewer.workspaceId,
      platformMaintainer: false,
      maintenanceLevel: 'company',
      writable: true,
      departmentId: null,
      departments: [],
    });
    const materialCatalog = {
      references: [reference],
      matches: [],
      nextCursor: null,
      fullTextCoverage: { ready: 1, unavailable: 0 },
      viewerId: panelViewer.viewerId,
      options: materialOptions,
    };
    const late = deferred();
    const reads: unknown[] = [];
    const materialReads: {
      kind: 'catalog' | 'selection';
      threadId: string | null;
      workspaceId: string | null;
      viewerId: string | string[] | undefined;
    }[] = [];
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
        const scopeId = url.searchParams.get('scopeId');
        if (url.pathname === skillsPath || url.pathname === legacySkillsPath) {
          const ordinal = reads.push({
            method: request.method,
            path: url.pathname,
            workspace: url.searchParams.get('workspaceId'),
            thread: url.searchParams.get('threadId'),
            expectedViewer: request.headers['x-allrice-expected-viewer-id'],
            organization: request.headers['x-allrice-organization-id'],
            workspaceHeader: request.headers['x-allrice-workspace-id'],
          });
          if (scenario === 'attached' && ordinal === 1) {
            await late.promise;
            return await copy(
              Response.json({
                ...catalog,
                personalSkills: catalog.personalSkills.map((skill) => ({
                  ...skill,
                  displayName: '已关闭访次的技能',
                })),
              }),
            );
          }
          return await copy(
            Response.json(
              scenario === 'attached' && ordinal === 2
                ? skillTestCatalog(randomUUID(), f.identity.workspaceId)
                : catalog,
            ),
          );
        }
        if (
          url.pathname === panelPath + 'materials' ||
          url.pathname ===
            panelPath +
              'materials/revisions/' +
              reference.revisionId +
              '/selection'
        ) {
          const selectionRead = url.pathname.endsWith('/selection');
          materialReads.push({
            kind: selectionRead ? 'selection' : 'catalog',
            threadId: url.searchParams.get('threadId'),
            workspaceId: url.searchParams.get('workspaceId'),
            viewerId: request.headers['x-allrice-expected-viewer-id'],
          });
          if (selectionRead)
            return await copy(
              Response.json({
                ...panelViewer,
                selection: { ...materialPin, digest: materialPin.checksum },
                canReference: true,
              }),
            );
          return await copy(Response.json(materialCatalog));
        }
        if (url.pathname === panelPath + 'materials/options') {
          return await copy(
            Response.json({
              viewerId: panelViewer.viewerId,
              options: materialOptions,
            }),
          );
        }
        if (realShell) {
          if (url.pathname === '/api/v1/d-entry/identity') {
            return await copy(
              Response.json({
                identity: f.selectionIdentity(
                  Object.fromEntries(url.searchParams),
                ),
              }),
            );
          }
          if (url.pathname === '/api/v1/d-entry/native-prewarm') {
            request.resume();
            if (!coldAssets) return response.writeHead(204).end();
            prewarmAt = performance.now();
            return await copy(
              new Response(
                JSON.stringify({
                  operationId,
                  pollAfterMs: 1000,
                  expiresAt: new Date(Date.now() + 180_000).toISOString(),
                }),
                {
                  status: 202,
                  headers: { 'content-type': 'application/json' },
                },
              ),
            );
          }
          if (
            coldAssets &&
            url.pathname === '/api/v1/d-entry/native-prewarm/status'
          ) {
            const ready = performance.now() - prewarmAt! >= coldWindow;
            if (ready) readyAt ??= performance.now();
            return await copy(
              Response.json({ state: ready ? 'ready' : 'starting' }),
            );
          }
          if (outerCreate && url.pathname === '/api/v1/sessions') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            otherThread = body.operationId;
            f.registerThread(otherThread);
            const nativeId = 'root-' + otherThread;
            const row = f.host.catalog.items.find(
              (item) => item.sessionId === nativeId,
            );
            Object.assign(row!, { cwd: '/work', blank: true });
            nativeWorkspace.sessionIds.push(nativeId);
            outerCreated = true;
            return await copy(
              Response.json({ ...f.selection, threadId: otherThread }),
            );
          }
          if (url.pathname === '/chatflow/4.0') {
            return response
              .writeHead(200, { 'content-type': 'text/html' })
              .end(
                '<!doctype html><link rel="stylesheet" href="/outer.css"><div id="root"></div>' +
                  (coldAssets && bench !== 'progress'
                    ? '<script id="startup-assets" type="application/json">' +
                      JSON.stringify(coldPaths) +
                      '</script>'
                    : '') +
                  '<script src="/outer.js"></script>',
              );
          }
          if (url.pathname === '/outer.js' || url.pathname === '/outer.css') {
            const css = url.pathname.endsWith('.css');
            const asset = realParent!.outputFiles.find(({ path }) =>
              path.endsWith(css ? '.css' : '.js'),
            );
            return response
              .writeHead(200, {
                'content-type': css ? 'text/css' : 'text/javascript',
                'cache-control': 'public, max-age=31536000, immutable',
              })
              .end(asset!.text);
          }
        }
        if (url.pathname === '/api/v1/d-entry/profile/switch') {
          switchProofRequests++;
          const cookie =
            request.headers.cookie
              ?.split('; ')
              .find((part) => part.startsWith('allrice_session='))
              ?.slice('allrice_session='.length) ?? '';
          return await copy(
            await f.proveSwitch(
              scopeId!,
              url.searchParams.get('targetThreadId')!,
              url.searchParams.get('requestId')!,
              cookie,
              Object.fromEntries(url.searchParams),
            ),
          );
        }
        if (url.pathname === '/api/v1/d-entry/native-rpc') {
          firstRpc ??= performance.now();
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          unary.push(input.endpoint);
          const result = await f.invoke(input.scopeId, sessionToken, input);
          if (outerCreate && input.endpoint === 'session/prompt')
            promptReplies.push({
              status: result.status,
              ...(await result.clone().json()),
            });
          if (nativeCreate && input.endpoint === 'session/create')
            createReplies.push({
              status: result.status,
              ...(await result.clone().json()),
              thread: result.headers.get(dEntryRegisteredThreadHeader),
            });
          if (holdCreatedResponse && input.endpoint === 'session/create') {
            holdCreatedResponse = false;
            createdResponse.resolve();
            await deliverCreatedResponse.promise;
          }
          if (startupMethods.has(input.endpoint))
            startupReplies.set(
              input.endpoint,
              (await result.clone().json()).result,
            );
          return await copy(result);
        }
        for (const kind of ['bootstrap', 'assets'] as const) {
          if (url.pathname !== '/api/v1/d-entry/profile/' + kind) continue;
          if (kind === 'bootstrap') browserBootstrapReads++;
          else scopedBundleReads++;
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
          const result = await f.publish(
            kind,
            scopeId!,
            Object.fromEntries(url.searchParams),
          );
          if (
            bench &&
            kind === 'assets' &&
            result.ok &&
            url.searchParams.get('reference') === application.url
          ) {
            const bytes = gzipSync(Buffer.from(await result.arrayBuffer()));
            response.writeHead(200, {
              'content-type': 'text/javascript',
              'content-encoding': 'gzip',
              'content-length': bytes.length,
              'cache-control': 'no-store',
            });
            await sendColdApplication(response, bytes);
          } else await copy(result);
          timing.end = performance.now();
          return;
        }
        const publicBundle = !stall && publicBundles.get(url.pathname);
        if (publicBundle) {
          if (coldAssets) {
            coldRequests.set(
              url.pathname,
              (coldRequests.get(url.pathname) ?? 0) + 1,
            );
            response.once('finish', () =>
              coldFinished.set(url.pathname, performance.now()),
            );
          }
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
          if (coldAssets && readyAt === undefined)
            expect(request.headers.referer).toBeUndefined();
          const bytes = await release.read(
            publicBundle.reference,
            new AbortController().signal,
          );
          // Match the production Next asset delivery. Chromium's cache limits
          // apply to the encoded HTTP response, not the decoded bundle.
          expect(request.headers['accept-encoding']).toContain('gzip');
          const encoded = gzipSync(bytes);
          await delay(180);
          timing.end = performance.now();
          response.writeHead(200, {
            'content-type': 'text/javascript',
            'cache-control': 'public, max-age=31536000, immutable',
            'content-encoding': 'gzip',
            'content-length': encoded.length,
            vary: 'accept-encoding',
          });
          if (bench && publicBundle.phase === 'application')
            await sendColdApplication(response, encoded);
          else response.end(encoded);
          return;
        }
        if (coldAssets && url.pathname.startsWith(publicRoot)) {
          const file = url.pathname.slice(publicRoot.length);
          if (
            !(stagedPaths ? stagedPaths.has(file) : staticFiles.has('/' + file))
          )
            return response.writeHead(404).end();
          if (coldPaths.includes(url.pathname)) {
            coldRequests.set(
              url.pathname,
              (coldRequests.get(url.pathname) ?? 0) + 1,
            );
            response.once('finish', () =>
              coldFinished.set(url.pathname, performance.now()),
            );
            if (readyAt === undefined) {
              expect(request.headers.cookie).toBeUndefined();
              expect(request.headers.referer).toBeUndefined();
            }
          }
          const encoded = gzipSync(
            await readFile(join(release.directory, file)),
          );
          return response
            .writeHead(200, {
              'content-type': mime[extname(file)] ?? 'application/octet-stream',
              'content-encoding': 'gzip',
              'content-length': encoded.length,
              'cache-control': 'public, max-age=31536000, immutable',
              vary: 'accept-encoding',
            })
            .end(encoded);
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
        if (
          url.pathname !== '/employee' &&
          url.pathname !== '/chatflow/4.0/document'
        ) {
          response.writeHead(404).end();
          return;
        }
        documentLoads++;
        const selection = {
          ...f.selection,
          employeeInstanceId:
            url.searchParams.get('employeeInstanceId') ??
            f.selection.employeeInstanceId,
          threadId: url.searchParams.get('threadId') ?? f.selection.threadId,
        };
        const identity = f.selectionIdentity(selection);
        const nativeId =
          nativeIdsByThread.get(selection.threadId) ??
          (selection.threadId === otherThread ? 'root-' + otherThread : 'root');
        const version = {
          id: identity.employeeVersionId,
          manifest: { name: 'Fixture employee' },
        };
        const directory = {
          ...identity,
          viewerId: identity.personId,
          employees: [
            f.selection.employeeInstanceId,
            ...(cross ? [cross.identity.employeeInstanceId] : []),
          ].map((id) => ({
            id,
            employeeId: id,
            isDefault: id === f.selection.employeeInstanceId,
            currentVersion: version,
            versions: [version],
          })),
          sessions: (switching || createAfterSwitch || outerCreated
            ? [
                f.selection.threadId,
                otherThread,
                ...(cross ? [cross.identity.threadId!] : []),
              ]
            : [selection.threadId]
          ).map((id) => ({
            id,
            employeeInstanceId:
              id === cross?.identity.threadId
                ? cross.identity.employeeInstanceId
                : f.selection.employeeInstanceId,
            ownerId: identity.personId,
            updatedAt: '2026-01-01T00:00:00.000Z',
            createdAt: '2026-01-01T00:00:00.000Z',
            title: id === otherThread ? '第二条已存在对话' : '第一条已存在对话',
          })),
        };
        if (!scopeId) return response.writeHead(404).end();
        const bootstrap = await f.publish('bootstrap', scopeId, {
          threadId: selection.threadId,
          employeeInstanceId: selection.employeeInstanceId,
        });
        if (!bootstrap.ok) return response.writeHead(bootstrap.status).end();
        const published = DEntryProfileBootstrapSchema.parse(
          await bootstrap.json(),
        );
        earlyUrls = stall
          ? []
          : publicStartupBundleUrls(published, {
              root: publicRoot,
              bundles: publicIndex,
            });
        const bootJson = JSON.stringify(published).replaceAll('<', '\\u003c');
        response.writeHead(200, { 'content-type': 'text/html' })
          .end(`<!doctype html>
          ${coldAssets ? nativeStyles : ''}
          <link rel="stylesheet" href="${coldAssets ? publicStyle : '/managed/employee-web-entry.css'}">
          <script data-scope-id="${scopeId}" data-public-startup-bundles='${JSON.stringify(earlyUrls)}'>${initialDocumentLifecycle}</script>
          <div id="app" data-shared-mux="1" data-scope-id="${scopeId}" data-thread-id="${selection.threadId}"
            data-workspace-id="${identity.workspaceId}" data-employee-instance-id="${identity.employeeInstanceId}"
            data-organization-id="${identity.organizationId}" data-viewer-id="${identity.personId}"
            data-login-session-id="${f.context.sessionId}"
            data-native-session-id="${nativeId}" data-binding-ref="${published.bindingRef}" data-graph-rev="${published.graph.rev}"
            ${stall ? '' : `data-public-asset-root="${publicRoot}" data-public-bundles='${JSON.stringify(publicIndex)}'`}></div>
          <script id="allrice-employee-directory" type="application/json">${JSON.stringify(directory)}</script>
          <script id="allrice-employee-bootstrap" type="application/json">${bootJson}</script>
          <script type="module" src="${coldAssets ? publicEntry : '/managed/employee-web-entry.js'}"></script>`);
      } catch {
        response.writeHead(500).end();
      }
    });
    const browser = await chromium.launch({
      executablePath: browserExecutable,
    });
    closes.push(() => browser.close());
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addCookies([
      { name: 'allrice_session', value: sessionToken, url: f.origin },
    ]);
    const page = await context.newPage();
    if (wallet) {
      await page.addInitScript(
        ({ denyStorage, ownedError }) => {
          const child = window !== parent;
          if (child && !location.pathname.includes('/document')) return;
          const denied = () => {
            throw new DOMException(
              'Access to storage is not allowed from this context',
              'SecurityError',
            );
          };
          if (denyStorage) {
            Object.defineProperty(window, 'localStorage', { get: denied });
            Object.defineProperty(Storage.prototype, 'getItem', {
              value: denied,
            });
            for (const name of ['caches', 'indexedDB'])
              Object.defineProperty(window, name, { get: denied });
          }
          const noise = {
            target: 'metamask-inpage',
            data: { name: 'ObjectMultiplex' },
          };
          let bursts = 0;
          const broadcast = setInterval(() => {
            const peer = child
              ? parent
              : document.querySelector('iframe')?.contentWindow;
            if (!peer) return;
            const scopeId = child
              ? document.getElementById('app')?.dataset.scopeId
              : undefined;
            for (let i = 0; i < 24; i++)
              peer.postMessage({ ...noise, scopeId }, location.origin);
            document.documentElement.dataset.walletBursts = String(++bursts);
            if (bursts === 40) clearInterval(broadcast);
          }, 10);
          if (!child) return;
          const append = Element.prototype.append;
          Element.prototype.append = function (...nodes) {
            if (
              this === document.head &&
              !document.documentElement.hasAttribute(
                'data-wallet-registration-noise',
              ) &&
              nodes.some(
                (node) => node instanceof HTMLScriptElement && node.textContent,
              )
            ) {
              document.documentElement.dataset.walletRegistrationNoise = '1';
              if (ownedError) {
                for (const node of nodes)
                  if (node instanceof HTMLScriptElement && node.textContent)
                    node.textContent +=
                      "\n;throw Error('Owned bundle registration failed');";
                return append.apply(this, nodes);
              }
              const scopeId = document.getElementById('app')!.dataset.scopeId;
              parent.dispatchEvent(
                new MessageEvent('message', {
                  origin: location.origin,
                  source: window,
                  data: { type: 'allrice:d-entry:startup-failed', scopeId },
                }),
              );
              window.dispatchEvent(
                new MessageEvent('message', {
                  origin: location.origin,
                  source: parent,
                  data: { type: 'allrice:d-entry:revoked', scopeId },
                }),
              );
              const injected = document.createElement('script');
              injected.textContent =
                "throw Error('Wallet content script noise');\n//# sourceURL=chrome-extension://fixture/injected.js";
              append.call(this, injected);
              injected.remove();
              const extra = document.createElement('script');
              extra.src = '/wallet-extension-chunk.js';
              append.call(this, extra);
            }
            append.apply(this, nodes);
          };
        },
        {
          denyStorage: scenario === 'wallet-storage',
          ownedError: scenario === 'wallet-owned-error',
        },
      );
    }
    if (bench === 'overlap') {
      const href = f.origin + applicationPath;
      page.on('request', (request) => {
        if (request.url() === href && request.frame() !== page.mainFrame())
          frameApplicationAt ??= performance.now();
      });
    }
    if (bench) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 200,
        downloadThroughput: 228_000,
        uploadThroughput: 228_000,
      });
    }
    // Keep the first test response deliverable after abort so we exercise the
    // Reader's late-result guard, independently of browser fetch cancellation.
    if (scenario === 'attached')
      await page.addInitScript((path) => {
        const original = window.fetch.bind(window);
        let held = false;
        window.fetch = async (input, init) => {
          if (
            held ||
            typeof input !== 'string' ||
            !input.startsWith(path + '?')
          )
            return original(input, init);
          held = true;
          init?.signal?.addEventListener(
            'abort',
            () => {
              document.documentElement.dataset.skillReadAborted = 'true';
            },
            { once: true },
          );
          const reply = await original(input, { ...init, signal: undefined });
          const parse = reply.json.bind(reply);
          reply.json = async () => {
            const result: unknown = await parse();
            document.documentElement.dataset.lateSkillRead = 'true';
            return result;
          };
          return reply;
        };
      }, skillsPath);
    if (nativeCreate) {
      // rc.2 restores its saved desktop selection before this test's shortcut.
      await page.addInitScript(
        ({ linuxProfile, outerCreate }) => {
          if (linuxProfile || outerCreate)
            Object.defineProperty(navigator, 'platform', {
              value: 'Linux x86_64',
            });
          if (!outerCreate)
            localStorage.setItem(
              'dsh.sessions.current',
              JSON.stringify({ sessionId: 'root' }),
            );
          // rc.2 defines this native command on every platform but provides no
          // default binding for web:linux. Use its own per-profile preferences.
          localStorage.setItem(
            'dsh.keybindings.v1',
            JSON.stringify({
              schemaVersion: 1,
              profiles: {
                'web:linux': {
                  'session.new': {
                    code: 'Period',
                    modifiers: ['primary', 'shift'],
                  },
                },
              },
            }),
          );
        },
        { linuxProfile: scenario === 'native-create-linux', outerCreate },
      );
    }
    const streams = new Map<string, string>();
    let socketCount = 0;
    let lastScopeId: string | undefined;
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
      socketCount++;
      socket.on('framesent', ({ payload }) => {
        const frame = JSON.parse(payload.toString());
        if (frame.type === 'open') streams.set(frame.streamId, frame.endpoint);
      });
      socket.on('framereceived', ({ payload }) => {
        const frame = JSON.parse(payload.toString());
        if (frame.type === 'item' && frame.value.type === 'opened')
          lastScopeId = frame.value.scopeReference.scopeId;
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
    if (scenario === 'baseline') {
      await page.addInitScript(() => {
        if (window !== top) return;
        window.addEventListener('message', (event) => {
          if (event.data?.type === 'allrice:d-entry:switch-ready')
            event.stopImmediatePropagation();
        });
      });
    }
    started = performance.now();
    await page.goto(
      realShell
        ? f.origin + '/chatflow/4.0?' + new URLSearchParams(f.selection)
        : f.origin,
      coldAssets ? { waitUntil: 'commit' } : undefined,
    );
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
    if (scenario === 'wallet-owned-error') {
      await page
        .getByRole('heading', { name: '暂时打不开工作台' })
        .waitFor({ timeout: 15_000 });
      expect(errors).toContain('Owned bundle registration failed');
      expect(workspaceBaselines).toHaveLength(0);
      await context.close();
      return;
    }
    if (coldAssets) {
      const alert = page.getByRole('heading', { name: '工作台资源下载超时' });
      await expect
        .poll(() => readyAt ?? 0, { timeout: bench ? 105_000 : 20_000 })
        .toBeGreaterThan(0);
      const elapsed = bench ? 82_000 : 20_000;
      const outcome = await Promise.race([
        alert.waitFor({ timeout: elapsed }).then(() => 'timeout'),
        editor.waitFor({ timeout: elapsed }).then(() => 'editable'),
      ]).catch(
        async () =>
          'missing: ' + (await page.locator('body').innerText()).slice(0, 300),
      );
      console.info(
        'COLD_ASSET_BENCH ' +
          JSON.stringify({
            mode: bench || 'warming-test',
            outcome,
            errors,
            scopedBundleReads,
            readyToOutcomeMs: Math.round(performance.now() - readyAt!),
            prewarmToReadyMs: Math.round(readyAt! - prewarmAt!),
            browser: browser.version(),
            applicationStartsRelativeToReadyMs: applicationTransfers.map(
              ({ start }) => Math.round(start - readyAt!),
            ),
            iframeApplicationRelativeToReadyMs:
              frameApplicationAt === undefined
                ? null
                : Math.round(frameApplicationAt - readyAt!),
            initialTransferMs: applicationTransfers.map(({ start, end }) =>
              end === undefined ? null : Math.round(end - start),
            ),
            originApplicationBytes: applicationTransfers.map(
              ({ bytes }) => bytes,
            ),
            requests: Object.fromEntries(coldRequests),
            completedBeforeReady: coldPaths.filter(
              (url) => (coldFinished.get(url) ?? Infinity) < readyAt!,
            ).length,
          }),
      );
      if (bench === 'baseline') {
        expect(outcome).toBe('timeout');
        expect(applicationTransfers).toHaveLength(2);
        expect(
          applicationTransfers.every(({ bytes, end }) => bytes > 0 && !end),
        ).toBe(true);
        expect(scopedBundleReads).toBe(1);
      } else {
        expect(outcome).toBe('editable');
        await editor.fill('冷启动后的草稿');
        expect(await editor.isEditable()).toBe(true);
        expect(scopedBundleReads).toBe(0);
        if (bench === 'overlap') {
          expect(applicationTransfers).toHaveLength(1);
          expect(applicationTransfers[0]!.start).toBeLessThan(readyAt!);
          expect(frameApplicationAt).toBeGreaterThan(readyAt!);
          expect(frameApplicationAt).toBeLessThan(
            applicationTransfers[0]!.end!,
          );
        }
        if (bench !== 'progress')
          for (const url of coldPaths) {
            if (bench !== 'overlap')
              expect(coldFinished.get(url)).toBeLessThan(readyAt!);
            expect(coldRequests.get(url)).toBe(1);
          }
      }
      await context.close();
      return;
    }
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
              sessionIds:
                scenario === 'unattached'
                  ? []
                  : [
                      'root',
                      ...(switching || createAfterSwitch
                        ? ['root-' + otherThread]
                        : []),
                    ],
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
    if (wallet) {
      expect(await editor.innerText()).toContain('未发送的原生草稿');
      await expect.poll(() => page.locator('iframe').isVisible()).toBe(true);
      expect(
        await page.getByRole('heading', { name: '工作台已就绪' }).count(),
      ).toBe(0);
      await page
        .locator('html[data-wallet-bursts]')
        .waitFor({ state: 'attached' });
      const childRoot = workbench.locator('html');
      expect(await childRoot.getAttribute('data-wallet-bursts')).toBeTruthy();
      expect(
        await childRoot.getAttribute('data-wallet-registration-noise'),
        JSON.stringify({ errors, scopedBundleReads, earlyUrls }),
      ).toBe('1');
      expect(errors).toContain('Wallet content script noise');
      expect(errors).not.toContain(
        'Access to storage is not allowed from this context',
      );
      expect(
        await workbench
          .locator('script[src="/wallet-extension-chunk.js"]')
          .count(),
      ).toBe(1);
      await context.close();
      return;
    }
    const dock = (nativeId: string) =>
      workbench.locator(
        '[data-sidebar-right-session="' +
          nativeId +
          '"][data-sidebar-right-panel]',
      );
    async function openWorkbenchPane(nativeId: string, name: string) {
      const entries = workbench.getByLabel('工作台入口', { exact: true });
      const entry = entries.getByRole('button', { name, exact: true });
      if (await entry.isVisible()) {
        await entry.click();
      } else {
        await workbench
          .locator('[data-conversation-header-corner]')
          .getByRole('button', { name: /^(打开右侧边栏|Open right sidebar)$/ })
          .click();
        await dock(nativeId)
          .getByRole('button')
          .filter({
            has: workbench.locator('strong').getByText(name, { exact: true }),
          })
          .click();
      }
    }
    async function closeWorkbenchPane(nativeId: string, name: string) {
      await dock(nativeId)
        .getByRole('tab', { name: new RegExp(name) })
        .getByRole('button', { name: /^(关闭|Close)$/ })
        .click();
    }
    async function useMaterial(nativeId: string, threadId: string) {
      const before = materialReads.length;
      const right = dock(nativeId);
      await openWorkbenchPane(nativeId, '企业资料');
      await right
        .locator(`[data-file-id="${reference.revisionId}"]`)
        .getByRole('button', { name: '引用到对话', exact: true })
        .click();
      const expectedScope = {
        threadId,
        workspaceId: f.identity.workspaceId,
        viewerId: f.identity.personId,
      };
      await expect
        .poll(() => materialReads.slice(before))
        .toEqual([
          { kind: 'catalog', ...expectedScope },
          { kind: 'selection', ...expectedScope },
        ]);
      const chip = editor.locator(
        '[data-composer-chip="allrice-panel-reference"]',
      );
      try {
        await chip.waitFor({ state: 'visible', timeout: 5_000 });
      } catch (cause) {
        const alerts = await right.getByRole('alert').allTextContents();
        throw Error(
          'Native reference insertion did not render: ' +
            JSON.stringify(alerts),
          { cause },
        );
      }
      expect(await chip.textContent()).toContain(reference.fileName);
      await closeWorkbenchPane(nativeId, '企业资料');
    }
    async function checkR3SelectedRoot(nativeId: string, threadId: string) {
      const before = reads.length;
      await workbench
        .locator('#chat-sidebar')
        .getByRole('button', {
          name: '设置',
          exact: true,
        })
        .click();
      await dock(nativeId)
        .getByRole('button', {
          name: 'AllRice 账号',
          exact: true,
        })
        .waitFor();
      await closeWorkbenchPane(nativeId, '设置');
      await openWorkbenchPane(nativeId, '能力');
      await dock(nativeId)
        .getByRole('button', {
          name: '翻译校对',
          exact: true,
        })
        .waitFor();
      expect(reads.slice(before)).toEqual([
        expect.objectContaining({
          method: 'GET',
          path: skillsPath,
          thread: threadId,
          expectedViewer: f.identity.personId,
        }),
      ]);
      await closeWorkbenchPane(nativeId, '能力');
      await useMaterial(nativeId, threadId);
    }
    if (switching) {
      const frame = page.locator('iframe');
      const mark = randomUUID();
      await workbench.locator('#app').evaluate((node, value) => {
        node.dataset.fixtureDocument = value;
      }, mark);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 200,
        downloadThroughput: 1_250_000,
        uploadThroughput: 1_250_000,
      });
      const samples: number[] = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        const other = attempt % 2 === 0;
        const target = other ? otherThread : f.selection.threadId;
        const nativeId = other ? 'root-' + otherThread : 'root';
        const row = workbench.locator(
          '[data-row-key="session:' + target + '"]',
        );
        const start = performance.now();
        await row.press('Enter');
        try {
          await page.waitForURL(
            (url) => url.searchParams.get('threadId') === target,
            { timeout: 8_000, waitUntil: 'commit' },
          );
          await workbench
            .locator(
              '[data-conversation-session="' +
                nativeId +
                '"] [data-composer-input][contenteditable="true"]',
            )
            .waitFor({ timeout: 8_000 });
        } catch (cause) {
          throw Error(
            JSON.stringify({
              attempt,
              scenario,
              socketCount,
              documentLoads,
              unary,
              errors,
            }),
            { cause },
          );
        }
        samples.push(Math.round(performance.now() - start));
        expect(await row.getAttribute('aria-selected')).toBe('true');
        if (scenario === 'switch') {
          expect(
            await workbench
              .locator('#app')
              .getAttribute('data-fixture-document'),
          ).toBe(mark);
          expect(documentLoads).toBe(1);
          expect(socketCount).toBe(1);
        }
        if (attempt === 0) await editor.fill('另一条会话的原生草稿');
        if (scenario === 'switch' && attempt === 0) {
          await checkR3SelectedRoot(nativeId, target!);
          await editor.fill('另一条会话的原生草稿');
        }
      }
      expect(await editor.innerText()).toBe('未发送的原生草稿');
      expect(await frame.count()).toBe(1);
      if (scenario === 'baseline') {
        expect(documentLoads).toBe(7);
        expect(socketCount).toBe(7);
      } else {
        await workbench
          .locator('[data-row-key="session:' + otherThread + '"]')
          .press('Enter');
        await page.waitForURL(
          (url) => url.searchParams.get('threadId') === otherThread,
        );
        expect(await editor.innerText()).toBe('另一条会话的原生草稿');
      }
      console.info(
        'NATIVE_THREAD_SWITCH_BENCHMARK ' +
          JSON.stringify({
            scenario,
            browser: browser.version(),
            samples,
            documentLoads,
            socketCount,
          }),
      );
      if (cross) {
        const before = { documentLoads, socketCount };
        const original = [...f.pageSignals].find(
          ([, signal]) => !signal.aborted,
        )?.[0];
        expect(original).toBeDefined();
        const next = {
          workspaceId: cross.identity.workspaceId,
          employeeInstanceId: cross.identity.employeeInstanceId,
          threadId: cross.identity.threadId,
        };
        await workbench.locator('#app').evaluate((node, selection) => {
          parent.postMessage(
            {
              type: 'allrice:d-entry:navigate',
              scopeId: node.dataset.scopeId,
              selection,
            },
            location.origin,
          );
        }, next);
        await page.waitForURL(
          (url) =>
            url.searchParams.get('employeeInstanceId') ===
            next.employeeInstanceId,
        );
        await editor.waitFor();
        expect(
          await workbench
            .locator('#app')
            .getAttribute('data-employee-instance-id'),
        ).toBe(next.employeeInstanceId);
        expect(
          await workbench.locator('#app').getAttribute('data-scope-id'),
        ).not.toBe(original);
        expect(await editor.innerText()).not.toContain('未发送的原生草稿');
        expect(documentLoads).toBe(before.documentLoads + 1);
        expect(socketCount).toBe(before.socketCount + 1);
        expect((await f.invokeThread(original!, otherThread)).status).toBe(404);
        console.info(
          'NATIVE_CROSS_EMPLOYEE newDocument=1 newSocket=1 oldScope=404',
        );
        await page.goto(
          f.origin + '/chatflow/4.0?' + new URLSearchParams(f.selection),
        );
        await editor.waitFor();
        const originalLoginScope = await workbench
          .locator('#app')
          .getAttribute('data-scope-id');
        await context.addCookies([
          { name: 'allrice_session', value: otherToken, url: f.origin },
        ]);
        await workbench
          .locator('[data-row-key="session:' + otherThread + '"]')
          .press('Enter');
        await page
          .getByRole('heading', { name: '暂时打不开这条对话' })
          .waitFor();
        await expect.poll(() => page.locator('iframe').count()).toBe(0);
        expect(f.pageSignals.get(originalLoginScope!)?.aborted).toBe(true);
        await context.addCookies([
          { name: 'allrice_session', value: sessionToken, url: f.origin },
        ]);
        await page.goto(
          f.origin + '/chatflow/4.0?' + new URLSearchParams(f.selection),
        );
        await editor.waitFor();
        await workbench
          .locator('[data-row-key="session:' + otherThread + '"]')
          .press('Enter');
        await page.waitForURL(
          (url) => url.searchParams.get('threadId') === otherThread,
        );
        revokeOther!.abort();
        await expect.poll(() => page.locator('iframe:visible').count()).toBe(0);
      }
      await cdp.detach();
      await context.close();
      return;
    }
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
    const nativeSession = () =>
      editor.evaluate((node) =>
        node
          .closest('[data-conversation-session]')
          ?.getAttribute('data-conversation-session'),
      );
    if (outerCreate) {
      const firstThread = f.selection.threadId;
      const firstReply = workbench.getByText('隔离会话的首条回复', {
        exact: true,
      });
      await expect.poll(nativeSession).toBe('root');
      await editor.fill('你好');
      await editor.press('Enter');
      await expect
        .poll(() => promptReplies)
        .toMatchObject([
          { status: 200, result: { ok: true, value: { accepted: true } } },
        ]);
      await page.reload();
      try {
        await firstReply.waitFor({ timeout: 10_000 });
      } catch (cause) {
        throw Error(
          JSON.stringify({
            errors,
            firstItems,
            displayed: await nativeSession(),
          }),
          {
            cause,
          },
        );
      }
      await expect.poll(nativeSession).toBe('root');

      const mark = randomUUID();
      await workbench.locator('#app').evaluate((node, value) => {
        node.dataset.fixtureDocument = value;
      }, mark);
      const before = { documentLoads, socketCount };
      const initialProofs = switchProofRequests;
      const initialRegistrations = f.registerRoot.mock.calls.length;
      expectedNativeId = outerNativeId;
      await workbench
        .getByRole('button', {
          name: '和 Fixture employee 开新会话',
          exact: true,
        })
        .click();
      await page.waitForURL(
        (url) => url.searchParams.get('threadId') === otherThread,
        { timeout: 20_000 },
      );
      await expect.poll(nativeSession).toBe(outerNativeId);
      expect(f.registerRoot).toHaveBeenCalledTimes(initialRegistrations + 1);
      expect(switchProofRequests).toBe(initialProofs + 1);
      expect(await editor.textContent()).toBe('');
      expect(await firstReply.count()).toBe(0);
      for (const [thread, nativeId] of [
        [firstThread, 'root'],
        [otherThread, outerNativeId],
        [firstThread, 'root'],
      ]) {
        await workbench
          .locator('[data-row-key="session:' + thread + '"]')
          .click();
        await page.waitForURL(
          (url) => url.searchParams.get('threadId') === thread,
        );
        await expect.poll(nativeSession).toBe(nativeId);
        if (thread === firstThread)
          await firstReply.waitFor({ timeout: 10_000 });
        else expect(await firstReply.count()).toBe(0);
      }
      expect({ documentLoads, socketCount }).toEqual(before);
      expect(
        await workbench.locator('#app').getAttribute('data-fixture-document'),
      ).toBe(mark);

      expectedNativeId = createdNativeId;
    }
    if (nativeCreate) {
      const mark = randomUUID();
      const frame = page.locator('iframe');
      const initialSockets = socketCount;
      const initialDocuments = documentLoads;
      const initialRegistrations = f.registerRoot.mock.calls.length;
      await frame.evaluate((node, mark) => {
        node.dataset.fixtureIdentity = mark;
      }, mark);
      await workbench.locator('#app').evaluate((node, mark) => {
        node.dataset.fixtureDocument = mark;
      }, mark);
      if (createAfterSwitch) {
        await workbench
          .locator('[data-row-key="session:' + otherThread + '"]')
          .click();
        await page.waitForURL(
          (url) => url.searchParams.get('threadId') === otherThread,
        );
        await editor.fill('切换后保留的草稿', { timeout: 15_000 });
      }
      const platform = await editor.evaluate(
        (node) => node.ownerDocument.defaultView!.navigator.platform,
      );
      if (scenario === 'native-create-linux')
        expect(platform).toBe('Linux x86_64');
      const chord = /darwin|mac|iphone|ipad/iu.test(platform)
        ? 'Meta+Alt+N'
        : /win/iu.test(platform)
          ? 'Control+Alt+N'
          : 'Control+Shift+Period';
      try {
        if (createAfterSwitch) {
          await workbench.locator('#app').evaluate((node) => {
            window.addEventListener('message', (event) => {
              if (
                event.source === parent &&
                event.data?.type === 'allrice:d-entry:thread-switch-prepare'
              )
                node.dataset.fixturePreparing = 'yes';
            });
          });
          holdCreatedResponse = true;
        }
        await editor.press(chord, { timeout: 10_000 });
        if (createAfterSwitch) {
          try {
            await createdResponse.promise;
            const before = switchProofRequests;
            await workbench
              .locator('[data-row-key="session:' + f.selection.threadId + '"]')
              .click();
            await workbench
              .locator('#app[data-fixture-preparing="yes"]')
              .waitFor();
            expect(switchProofRequests).toBe(before);
          } finally {
            deliverCreatedResponse.resolve();
          }
          await page.waitForURL(
            (url) => url.searchParams.get('threadId') === f.selection.threadId,
          );
          await workbench
            .locator('[data-row-key="session:' + createdThread + '"]')
            .click();
        }
        await expect
          .poll(() => unary.includes('session/create'), { timeout: 15_000 })
          .toBe(true);
        await page.waitForURL(
          (url) => url.searchParams.get('threadId') === createdThread,
          { timeout: 20_000 },
        );
      } catch (error) {
        deliverCreatedResponse.resolve();
        throw new Error(
          JSON.stringify({
            platform,
            chord,
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
      expect(documentLoads).toBe(initialDocuments);
      expect(socketCount).toBe(initialSockets);
      if (createAfterSwitch) {
        await workbench
          .locator('[data-row-key="session:' + f.selection.threadId + '"]')
          .click();
        await page.waitForURL(
          (url) => url.searchParams.get('threadId') === f.selection.threadId,
        );
        await workbench
          .locator('[data-row-key="session:' + createdThread + '"]')
          .click();
        await page.waitForURL(
          (url) => url.searchParams.get('threadId') === createdThread,
        );
        await expect.poll(() => editor.textContent()).toBe(draft);
        expect(documentLoads).toBe(1);
        expect(socketCount).toBe(initialSockets);
        expect(
          await workbench.locator('#app').getAttribute('data-fixture-document'),
        ).toBe(mark);
      }
      expect(f.registerRoot).toHaveBeenCalledTimes(initialRegistrations + 1);
      await checkR3SelectedRoot(createdNativeId, createdThread);
      if (outerCreate) {
        await workbench
          .locator('[data-row-key="session:' + f.selection.threadId + '"]')
          .click();
        await page.waitForURL(
          (url) => url.searchParams.get('threadId') === f.selection.threadId,
        );
        await expect.poll(nativeSession).toBe('root');

        // Reopening the second thread must win over rc.2's saved first
        // selection, even though both roots are in the catalog.
        const secondUrl = new URL(page.url());
        secondUrl.searchParams.set('threadId', otherThread);
        await page.goto(secondUrl.href);
        expect(
          await workbench
            .locator('#app')
            .getAttribute('data-native-session-id'),
        ).toBe(outerNativeId);
        await expect
          .poll(nativeSession, { timeout: 10_000 })
          .toBe(outerNativeId);
        expect(
          await workbench
            .getByText('隔离会话的首条回复', { exact: true })
            .count(),
        ).toBe(0);
      }
      await context.close();
      return;
    }
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
    if (!lastScopeId) throw Error('Missing fixture page carrier');
    for (const method of blockedMethods) {
      const endpoint = `dynamicCordisRunner/${method}`;
      const response = await page.request.post(
        `${f.origin}/api/v1/d-entry/native-rpc`,
        {
          data: {
            selection: f.selection,
            scopeId: lastScopeId,
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
    if (scenario === 'attached') {
      const dock = workbench.locator(
        '[data-sidebar-right-session="root"][data-sidebar-right-panel]',
      );
      // rc.2 keeps the corner on blank sessions while omitting title actions.
      // Closing the guide's sole replacement collapses the original Dock again.
      const openAbilities = async () => {
        await workbench
          .locator('[data-conversation-header-corner]')
          .getByRole('button', { name: /^(打开右侧边栏|Open right sidebar)$/ })
          .click({ timeout: 5000 });
        await dock
          .getByRole('button', { name: /^能力\s*打开这位员工的业务工作台$/ })
          .click({ timeout: 5000 });
      };
      const panel = dock.getByRole('region', {
        name: 'Fixture employee · 能力',
      });
      const closeAbilityTab = () =>
        dock
          .getByRole('tab', { name: /能力/ })
          .getByRole('button', { name: /^(关闭|Close)$/ })
          .click();
      try {
        expect(
          await workbench.locator('html').evaluate(() => innerWidth),
        ).toBeGreaterThan(760);
        expect(
          await workbench.locator('[aria-label="工作台入口"]').count(),
        ).toBe(0);
        expect(reads).toHaveLength(0);
        await openAbilities();
        await expect.poll(() => reads.length).toBe(1);
        await closeAbilityTab();
        await workbench.locator('html[data-skill-read-aborted]').waitFor();
        await panel.waitFor({ state: 'hidden' });

        await openAbilities();
        await panel.getByText('技能读取失败，请重试。').waitFor();
        expect(
          await panel.getByRole('button', { name: '翻译校对' }).count(),
        ).toBe(0);
        await panel.getByRole('button', { name: '重试', exact: true }).click();
        await panel
          .getByRole('button', { name: '翻译校对', exact: true })
          .click();
        await panel
          .getByText('translation-review.zip', { exact: true })
          .waitFor();
        await panel.getByText('v0.3.0', { exact: true }).waitFor();
        expect(
          await panel
            .getByRole('button', { name: /添加|更新|卸载|开始工作/ })
            .count(),
        ).toBe(0);
        await panel
          .getByRole('button', { name: '返回能力列表', exact: true })
          .click();
        late.resolve();
        await workbench.locator('html[data-late-skill-read]').waitFor();
        await panel
          .getByRole('button', { name: '翻译校对', exact: true })
          .waitFor();
        expect(await panel.getByText('已关闭访次的技能').count()).toBe(0);
        expect(
          await panel.getByRole('button', { name: '添加技能' }).count(),
        ).toBe(0);
        expect(await panel.getByText('品牌自媒体').count()).toBe(0);
        await closeAbilityTab();
        expect((await editor.innerText()).trim()).toBe('未发送的原生草稿');
        expect(unary).not.toContain('session/prompt');
        expect(reads).toEqual(
          Array.from({ length: 3 }, () => ({
            method: 'GET',
            path: skillsPath,
            workspace: f.identity.workspaceId,
            thread: f.selection.threadId,
            expectedViewer: f.identity.personId,
            organization: f.identity.organizationId,
            workspaceHeader: f.identity.workspaceId,
          })),
        );
        await editor.fill('');
        await useMaterial('root', f.selection.threadId!);
      } catch (error) {
        const state = await workbench.locator('html').evaluate(() => ({
          viewportWidth: innerWidth,
          toolbar: Boolean(document.querySelector('[aria-label="工作台入口"]')),
          corner: document
            .querySelector('[data-sidebar-right-expand]')
            ?.getAttribute('aria-label'),
          dock: document
            .querySelector('[data-sidebar-right-panel]')
            ?.getAttribute('data-sidebar-right-panel'),
          tabs: [
            ...document.querySelectorAll(
              '[data-sidebar-right-panel] [role="tab"]',
            ),
          ].map((tab) => tab.textContent),
        }));
        throw Error(JSON.stringify({ state, reads: reads.length, errors }), {
          cause: error,
        });
      } finally {
        late.resolve();
      }
    }
    await page.evaluate(async () => {
      const finish: unknown = Reflect.get(window, 'finishCarrier');
      if (typeof finish !== 'function')
        throw Error('Fixture carrier unavailable');
      await finish();
    });

    const downloaded = () =>
      traffic.filter(({ kind }) => kind.startsWith('public-'));
    expect(downloaded()).toHaveLength(2);
    expect(scopedBundleReads).toBe(0);
    const refreshedAt = performance.now();
    await page.reload();
    await editor.fill('刷新后的原生编辑器', { timeout: 15_000 });
    const cached = await workbench.locator('#app').evaluate(
      (_, url) =>
        performance
          .getEntriesByName(url)
          .filter(
            (entry): entry is PerformanceResourceTiming =>
              entry instanceof PerformanceResourceTiming,
          )
          .map(({ transferSize, decodedBodySize }) => ({
            transferSize,
            decodedBodySize,
          })),
      f.origin + applicationPath,
    );
    expect(cached).toEqual([
      { transferSize: 0, decodedBodySize: expect.any(Number) },
    ]);
    expect(cached[0]!.decodedBodySize).toBeGreaterThan(1_000_000);
    expect(
      downloaded()
        .map(({ kind }) => kind)
        .sort(),
    ).toEqual(['public-application', 'public-bootstrap']);
    expect(scopedBundleReads).toBe(0);
    expect(browserBootstrapReads).toBe(0);
    expect(socketCount).toBe(2);
    console.info(
      'SEALED_PROFILE_REFRESH ' +
        JSON.stringify({
          browser: browser.version(),
          sealedBundleRequests: downloaded().length - 2,
          scopedBundleRequests: scopedBundleReads,
          applicationTransferBytes: cached[0]!.transferSize,
          sealedApplicationRevision: graph.batches.find(
            ({ phase }) => phase === 'application',
          )!.rev,
          liveApplicationRevision: application.rev,
          editableMs: Math.round(performance.now() - refreshedAt),
        }),
    );
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
