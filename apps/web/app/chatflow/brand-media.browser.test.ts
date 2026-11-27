import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  brandMediaRelease,
  type BrandMediaArticle,
  type BrandMediaTopic,
  type ReferenceRevision,
  type RunSnapshot,
} from '@allrice/contracts';
import type {
  Browser,
  Download,
  Page,
  Request,
} from '../../../worker/node_modules/playwright-core/index.js';
import { createLegacySidebarSnapshot } from '../../../../packages/dsh-web-composition/tests/legacy-sidebar-baseline';

// The retired 3.x panel is replayed from the last source before cleanup.
// HTTP/model/storage outcomes below are synthetic; the PG suite owns authority.
const retiredBrandPanelHead = '9988911c6a2c6c5ff161d219bb2c2aaaecbbbeeb';
const retiredBrandPanelPaths = new Set(
  [
    'frontend-wiring.tsx',
    'frontend-wiring.module.css',
    'images.tsx',
    'panel.tsx',
    'panel.module.css',
  ].map((name) => 'apps/web/app/chatflow/brand-media/' + name),
);
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const id = (n: number) =>
  `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = {
  organizationId: id(1),
  workspaceId: id(2),
  ownerId: id(3),
  instanceId: id(4),
};
const stamp = '2026-11-16T12:00:00.000Z',
  checksum = 'sha256:' + 'a'.repeat(64);
const file = { objectId: id(8), versionId: id(9), checksum };
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const imageFile = { objectId: id(80), versionId: id(81), checksum };
type ImageFile = { fileName: string; mediaType: string; base64: string };
const cursor = { createdAt: stamp, id: id(200) };
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const moduleDirectory = (url: URL) => url.pathname.endsWith('/modules');
const brandEndpoint = (url: URL) => url.pathname.endsWith('/brand-media');
const brandView = (url: URL, view: string) =>
  brandEndpoint(url) && url.searchParams.get('view') === view;
const accessProblem = (
  message: string,
  code:
    | 'AUTHENTICATION_REQUIRED'
    | 'AUTHORIZATION_DENIED'
    | 'REFERENCE_SELECTION_UNAVAILABLE'
    | 'VERSION_CONFLICT'
    | 'RESOURCE_NOT_FOUND' = 'AUTHORIZATION_DENIED',
) =>
  ApiErrorSchema.parse({
    error: { code, message, requestId: id(777), retryable: false },
  });
const topic = (n = 10): BrandMediaTopic => ({
  workspaceId: scope.workspaceId,
  instanceId: scope.instanceId,
  id: id(n),
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp,
  candidate: { title: '新品故事 ' + n, summary: '让用户理解新品的日常用途' },
  direction: '新品日常',
  sourceRunId: id(30),
  references: [],
});
// Keep wire records strict: tenancy comes from the client, not business rows.
function article(n = 20): BrandMediaArticle {
  return {
    workspaceId: scope.workspaceId,
    instanceId: scope.instanceId,
    id: id(n),
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
    topicId: id(10),
    title: n === 99 ? '月历里的旧文章' : '文章 ' + n,
    requirements: '',
    body: file,
    references: [],
    images: [],
    publication: { state: 'draft', schedule: null, links: null },
  };
}
function runSnapshot(
  n: number,
  status: RunSnapshot['status'] = 'succeeded',
): RunSnapshot {
  return {
    id: id(n),
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    ownerId: scope.ownerId,
    status,
    job: {
      id: id(n + 1000),
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      ownerId: scope.ownerId,
      status: status === 'needs_attention' ? 'failed' : status,
      idempotencyKey: 'browser-' + n,
      priority: 0,
      attempt: 0,
      maxAttempts: 3,
      availableAt: stamp,
      timeoutAt: stamp,
      payload: { schemaVersion: 1, type: 'allrice.employee.run', input: {} },
      lease: null,
    },
    cancelRequestedAt: null,
    result: null,
    error:
      status === 'failed'
        ? { code: 'fixture_failure', message: '本次生成未完成' }
        : null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}
function reference(n: number, name: string): ReferenceRevision {
  return {
    sourceId: id(n),
    revisionId: id(n + 100),
    revision: 2,
    ownership: { scope: 'company', organizationId: scope.organizationId },
    fileName: name,
    purpose: '经审核的品牌资料',
    checksum,
    sizeBytes: 20,
    mediaType: 'text/plain',
    status: 'active',
    processing: 'ready',
    failure: null,
    canMaintain: false,
    canReference: true,
    publication: {
      origin: 'upload',
      publisherId: scope.ownerId,
      publisherName: '品牌同事',
      audience: { scope: 'company', departmentIds: [] },
      audienceRevision: 1,
    },
    createdAt: stamp,
    origin: null,
  };
}
const refs = [reference(50, '品牌介绍.txt'), reference(51, '客户问题.txt')];
const binding = {
  ...scope,
  release: brandMediaRelease,
  revision: 1,
  enabledAt: stamp,
  revokedAt: null,
};
type Recovery = {
  run: RunSnapshot;
  sessionId: string;
  invocation: { module: typeof binding; intent: Record<string, unknown> };
  submission: { articleUpdated: boolean; revision: number | null } | null;
  addedCandidates: BrandMediaTopic['candidate'][];
  unavailable: boolean;
  image?: {
    operationId: string | null;
    status: 'running' | 'succeeded' | 'failed' | 'unknown' | null;
    file: typeof file | null;
    fileName: string | null;
    adoptable: boolean;
    retryable: boolean;
  } | null;
  deliveries: Array<{ file: typeof file; format: string; content: string }>;
};
function recovery(
  operation: 'candidates' | 'article' | 'image',
  status: RunSnapshot['status'] = 'succeeded',
  n = 300,
): Recovery {
  const intent =
    operation === 'candidates'
      ? {
          operation,
          workspaceId: scope.workspaceId,
          instanceId: scope.instanceId,
          requestId: id(n + 1),
          direction: '面向通勤族',
          references: [],
        }
      : operation === 'image'
        ? {
            operation,
            workspaceId: scope.workspaceId,
            instanceId: scope.instanceId,
            requestId: id(n + 1),
            articleId: id(20),
            expectedRevision: 1,
            description: '一张蓝色新品封面',
          }
        : {
            operation,
            workspaceId: scope.workspaceId,
            instanceId: scope.instanceId,
            requestId: id(n + 1),
            articleId: id(20),
            expectedRevision: 1,
            instructions: '写完整',
            references: [],
          };
  return {
    run: runSnapshot(n, status),
    sessionId: id(6),
    invocation: { module: binding, intent },
    submission: null,
    addedCandidates: [],
    unavailable: false,
    image:
      operation === 'image'
        ? {
            operationId: id(n + 50),
            status:
              status === 'succeeded'
                ? 'succeeded'
                : status === 'failed'
                  ? 'failed'
                  : 'running',
            file: status === 'succeeded' ? imageFile : null,
            fileName: status === 'succeeded' ? '原生封面.png' : null,
            adoptable: status === 'succeeded',
            retryable: status === 'failed',
          }
        : null,
    deliveries:
      status === 'succeeded' && operation !== 'image'
        ? [
            {
              file,
              format: operation === 'candidates' ? 'json' : 'txt',
              content:
                operation === 'candidates'
                  ? JSON.stringify({
                      candidates: [
                        {
                          title: '十分钟的新品体验',
                          summary: '下班后的轻松时刻',
                        },
                      ],
                    })
                  : '保留的正文成果',
            },
          ]
        : [],
  };
}

type State = {
  installed: Set<string>;
  topics: BrandMediaTopic[];
  articles: BrandMediaArticle[];
  runs: Recovery[];
  requests: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }>;
  helpGate?: Promise<void>;
  addGate?: Promise<void>;
  failGenerateOnce?: boolean;
  loseGenerateResponseOnce?: boolean;
  failCandidateOnce?: boolean;
  failAllRecovery?: boolean;
  failRecoveryAfterGenerate?: boolean;
  moreTopics?: boolean;
  moreArticles?: boolean;
  imageFiles: Record<string, ImageFile>;
  uploadGate?: Promise<void>;
  bodyGate?: Promise<void>;
};

async function compareComposerProbes(
  page: Page,
  cyan: Buffer,
  magenta: Buffer,
) {
  return page.evaluate(
    async ([cyan, magenta]) => {
      const decode = async (data: string) => {
        const response = await fetch(`data:image/png;base64,${data}`);
        const image = await createImageBitmap(await response.blob(), {
          colorSpaceConversion: 'none',
        });
        try {
          const { width, height } = image;
          const context = new OffscreenCanvas(width, height).getContext('2d');
          if (!context) throw Error('Cannot read composer probe pixels');
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, width, height);
        } finally {
          image.close();
        }
      };
      const [first, second] = await Promise.all([
        decode(cyan),
        decode(magenta),
      ]);
      const { width, height, data: before } = first;
      if (width !== second.width || height !== second.height)
        throw Error('Composer probe screenshot dimensions changed');
      const after = second.data;
      let changedPixels = 0,
        neutralPixels = 0,
        probePixels = 0;
      let firstDifference;
      const gray = (pixels: Uint8ClampedArray, offset: number) =>
        pixels[offset] === pixels[offset + 1] &&
        pixels[offset + 1] === pixels[offset + 2];
      for (let offset = 0; offset < before.length; offset += 4) {
        const red = after[offset]! - before[offset]!,
          green = after[offset + 1]! - before[offset + 1]!,
          blue = after[offset + 2]! - before[offset + 2]!,
          alpha = after[offset + 3]! - before[offset + 3]!;
        if (red === 0 && green === 0 && blue === 0 && alpha === 0) continue;
        changedPixels++;
        firstDifference ??= {
          x: (offset / 4) % width,
          y: Math.floor(offset / 4 / width),
          cyan: Array.from(before.subarray(offset, offset + 4)),
          magenta: Array.from(after.subarray(offset, offset + 4)),
        };
        // Gray foreground redraws change luminance only. An exposed cyan to
        // magenta switch increases red and decreases green, even under a scrim.
        if (alpha === 0 && gray(before, offset) && gray(after, offset))
          neutralPixels++;
        if (red > 0 && green < 0 && blue === 0 && alpha === 0) probePixels++;
      }
      return {
        width,
        height,
        changedPixels,
        neutralPixels,
        probePixels,
        firstDifference,
      };
    },
    [cyan.toString('base64'), magenta.toString('base64')] as const,
  );
}

suite('MET-224 main-area brand media text workflow', () => {
  let browser: Browser, server: Server, origin: string;
  const evidence = resolve('.local/met224-brand-media-p3');
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      stdin: {
        sourcefile: 'brand-media-page.tsx',
        loader: 'tsx',
        resolveDir: resolve('apps/web'),
        contents: `
        import { useEffect, useMemo, useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { BrandMediaHost, BrandMediaPluginSection, BrandMediaPluginPicker, useBrandMediaEntry } from './app/chatflow/brand-media/frontend-wiring';
        import { BrandMediaPanel } from './app/chatflow/brand-media/panel';
        import { ChatComposer } from './app/chatflow/chat-composer';
        import conversationUi from './app/chatflow/dsh-upstream/ConversationRoot.module.css';
        import './app/dsh-upstream/design-platform.css';
        import './app/dsh-upstream/base.css';
        import '@allrice/ui/tokens.css';
        import './app/styles/base.css';
        import '@allrice/ui/styles.css';
        const ids = ${JSON.stringify(scope)};
        const nativeComposer = new URLSearchParams(location.search).has('nativeComposer');
        function NativeConversation({ draft, setDraft }) {
          const input = useRef(null), file = useRef(null), composing = useRef(false);
          const noop = () => {};
          return <div className={conversationUi.root} data-phase="active">
            <h1>原聊天</h1>
            <div className={conversationUi.scrollBody}>
              <div className={conversationUi.viewArea}>保留的会话正文</div>
              <div className={conversationUi.composerSeat} data-composer-seat>
                <ChatComposer employeeName="Rice" draft={draft} onDraftChange={setDraft}
                  composerInput={input} fileInput={file} composing={composing}
                  attachmentMenuOpen={false} busy={false} isRunning={false} error=""
                  localWorkspaceOnline={false} bridgeConnectionState="offline" pendingAttachments={[]}
                  onAttachmentMenuOpenChange={noop} onCancelRun={noop} onLoadBridgeDevices={noop}
                  onOpenAttachment={noop} onRemoveAttachment={noop} onRetryAttachment={noop}
                  onSendMessage={noop} onUploadAttachments={noop}/>
              </div>
            </div>
          </div>;
        }
        function Fixture() {
          const [instanceId, setInstance] = useState(ids.instanceId), [open, setOpen] = useState(false), [serial, setSerial] = useState(0);
          const [draft, setDraft] = useState('未发送的聊天草稿');
          const headers = useMemo(() => ({ 'x-allrice-organization-id': ids.organizationId, 'x-allrice-workspace-id': ids.workspaceId }), []);
          const controller = useBrandMediaEntry({ ...ids, instanceId, headers });
          useEffect(() => {
            const navigate = () => setOpen(false);
            window.addEventListener('fixture-employee-navigation', navigate);
            return () => window.removeEventListener('fixture-employee-navigation', navigate);
          }, []);
          const launch = () => { setSerial(n => n + 1); setOpen(true); };
          return <div style={{ display:'flex', height:'100vh', width:'100vw' }}>
            <aside aria-label="员工侧栏" style={{ width:nativeComposer && innerWidth < 700 ? 56 : 300, flexShrink:0 }}>
              <button onClick={() => setOpen(false)}>Rice 员工</button>
              <button onClick={() => { setOpen(false); setInstance(${JSON.stringify(id(5))}); }}>另一个员工</button>
              {controller.picker ? <BrandMediaPluginPicker controller={controller} employeeName={instanceId === ids.instanceId ? 'Rice' : '小米'}/> : <BrandMediaPluginSection controller={controller} headingId="plugins" onOpen={launch}/>}
            </aside>
            <main style={{ display:'flex', flex:1, minWidth:0 }}>
              <BrandMediaHost open={open} serial={serial} panel={controller.client ? <BrandMediaPanel key={instanceId + ':' + serial} client={controller.client} active={open} sessionId={${JSON.stringify(id(6))}} onReturn={() => setOpen(false)}/> : null}>
                {nativeComposer ? <NativeConversation draft={draft} setDraft={setDraft}/> : <><h1>原聊天</h1><textarea aria-label="聊天草稿" value={draft} onChange={e => setDraft(e.target.value)}/><span aria-label="草稿附件">原附件.pdf</span><button>发送</button></>}
              </BrandMediaHost>
            </main>
          </div>;
        }
        createRoot(document.getElementById('root')).render(<Fixture/>);
      `,
      },
      bundle: true,
      nodePaths: [resolve('apps/web/node_modules')],
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/brand-media-fixture',
      jsx: 'automatic',
      plugins: [
        {
          ...createLegacySidebarSnapshot(
            (path) =>
              execFileSync(
                'git',
                ['show', `${retiredBrandPanelHead}:${path}`],
                {
                  encoding: 'utf8',
                },
              ),
            retiredBrandPanelPaths,
            true,
          ),
          name: 'pinned-retired-brand-panel',
        },
      ],
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    const assets = new Map<string, Uint8Array>(
      result.outputFiles.map(
        (entry: { path: string; contents: Uint8Array }) => [
          entry.path.slice(entry.path.lastIndexOf('/')),
          entry.contents,
        ],
      ),
    );
    server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname,
        asset = assets.get(path);
      response.setHeader(
        'content-type',
        asset
          ? path.endsWith('.css')
            ? 'text/css'
            : 'text/javascript'
          : 'text/html',
      );
      response.end(
        asset ??
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/stdin.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/stdin.js"></script></body></html>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('No browser fixture port');
    origin = 'http://127.0.0.1:' + address.port;
    const { chromium } = createRequire(resolve('apps/worker/package.json'))(
      'playwright-core',
    );
    browser = await chromium.launch({
      headless: true,
      // Use Chromium's software compositor for repeatable probe captures.
      // macOS GPU rasterization changes rounded-edge gray values between
      // screenshots even when an opaque layer fully covers the changed seat.
      args: ['--disable-gpu'],
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
    await mkdir(evidence, { recursive: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  });

  async function fixture(
    options: Partial<State> = {},
    reducedMotion: 'reduce' | 'no-preference' = 'no-preference',
    nativeComposer?: { width: number; colorScheme: 'light' | 'dark' },
  ) {
    const state: State = {
      installed: new Set([scope.instanceId]),
      topics: [topic()],
      articles: [article()],
      runs: [],
      requests: [],
      imageFiles: {
        [imageFile.objectId]: {
          fileName: '原生封面.png',
          mediaType: 'image/png',
          base64: png,
        },
      },
      ...options,
    };
    const context = await browser.newContext({
        viewport: { width: nativeComposer?.width ?? 1440, height: 1000 },
        colorScheme: nativeComposer?.colorScheme ?? 'light',
        reducedMotion,
        timezoneId: 'Asia/Shanghai',
      }),
      page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.route('**/api/**', async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        path = url.pathname;
      const body =
        req.method() === 'POST'
          ? (req.postDataJSON() as Record<string, unknown>)
          : undefined;
      state.requests.push({
        method: req.method(),
        path: path + url.search,
        body,
      });
      const reply = (value: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(value),
        });
      if (path.endsWith('/modules')) {
        const employee = path.split('/')[4]!;
        if (body) {
          if (state.addGate && employee === scope.instanceId)
            await state.addGate;
          state.installed.add(employee);
          return reply({ binding });
        }
        return reply({
          modules: [
            {
              descriptor: {
                id: 'allrice.brand-media',
                displayName: '品牌自媒体',
              },
              binding: state.installed.has(employee)
                ? { ...binding, instanceId: employee }
                : null,
              enabled: state.installed.has(employee),
              available: !state.installed.has(employee),
            },
          ],
        });
      }
      if (path.endsWith('/brand-media')) {
        const view = url.searchParams.get('view');
        if (!body) {
          if (view === 'help') {
            if (state.helpGate) await state.helpGate;
            return reply({
              content: '# 使用说明\n填写方向，再把喜欢的候选加入选题库。',
              checksum,
            });
          }
          if (view === 'runs') {
            if (
              state.failAllRecovery ||
              (state.failRecoveryAfterGenerate && state.runs.length)
            )
              return reply({ message: '恢复读取暂时失败' }, 503);
            return reply({ runs: state.runs });
          }
          if (view === 'topics')
            return reply({
              view,
              items: state.topics,
              nextCursor:
                state.moreTopics && !url.searchParams.has('cursor')
                  ? cursor
                  : null,
            });
          if (view === 'article')
            return reply({
              view,
              article:
                state.articles.find(
                  (row) => row.id === url.searchParams.get('articleId'),
                ) ?? article(99),
            });
          if (view === 'articles')
            return reply({
              view,
              items: state.articles
                .filter(
                  (row) =>
                    !url.searchParams.has('state') ||
                    row.publication.state === url.searchParams.get('state'),
                )
                .filter((row) => !state.moreArticles || row.id !== id(99)),
              nextCursor: state.moreArticles ? cursor : null,
            });
          if (view === 'calendar') {
            const month = url.searchParams.get('month')!;
            return reply({
              view,
              items: state.articles.filter((row) =>
                row.publication.schedule?.plannedAt.startsWith(month),
              ),
            });
          }
        }
        if (
          body?.operation === 'candidates' ||
          body?.operation === 'article' ||
          body?.operation === 'image'
        ) {
          if (state.failGenerateOnce) {
            state.failGenerateOnce = false;
            return reply({ message: '网络中断，请重试' }, 503);
          }
          let row = state.runs.find(
            (existing) =>
              existing.invocation.intent.requestId === body.requestId,
          );
          if (!row) {
            row = recovery(
              body.operation,
              'queued',
              310 + state.runs.length * 2,
            );
            row.invocation.intent = body;
            state.runs.unshift(row);
          }
          if (state.loseGenerateResponseOnce) {
            state.loseGenerateResponseOnce = false;
            return reply({ message: '生成已受理但回执丢失' }, 503);
          }
          return reply({
            run: row.run,
            invocation: row.invocation,
            userMessage: { sessionId: row.sessionId },
          });
        }
        if (body?.operation === 'topic.add') {
          if (state.failCandidateOnce) {
            state.failCandidateOnce = false;
            return reply({ message: '选入请求网络中断' }, 503);
          }
          const run = state.runs.find((row) => row.run.id === body.sourceRunId);
          run?.addedCandidates.push(
            body.candidate as BrandMediaTopic['candidate'],
          );
          const added = {
            ...topic(11),
            candidate: body.candidate,
          } as BrandMediaTopic;
          state.topics.push(added);
          return reply({
            result: { kind: 'topic', topic: added },
            replayed: false,
          });
        }
        if (body?.operation === 'article.start') {
          const added = {
            ...article(21),
            body: null,
            requirements: body.requirements,
            references: body.references,
          } as BrandMediaArticle;
          state.articles.unshift(added);
          return reply({
            result: { kind: 'article', article: added },
            replayed: false,
          });
        }
        if (body?.operation === 'article.references') {
          const row = state.articles.find((row) => row.id === body.articleId)!;
          row.references = body.references as BrandMediaArticle['references'];
          row.revision++;
          return reply({
            result: { kind: 'article', article: row },
            replayed: false,
          });
        }
        if (
          body?.operation === 'article.image.add' ||
          body?.operation === 'article.image.remove'
        ) {
          const row = state.articles.find((row) => row.id === body.articleId)!;
          if (row.revision !== body.expectedRevision)
            return reply({ message: '记录已更新，本次没有覆盖' }, 409);
          if (body.operation === 'article.image.add')
            row.images.push(body.image as BrandMediaArticle['images'][number]);
          else
            row.images = row.images.filter((image) =>
              'upload' in body
                ? !(
                    'origin' in image &&
                    image.origin === 'upload' &&
                    image.file.objectId ===
                      (body.upload as typeof file).objectId &&
                    image.file.checksum ===
                      (body.upload as typeof file).checksum
                  )
                : !('versionId' in image.file) ||
                  image.file.versionId !== body.versionId,
            );
          row.revision++;
          return reply({
            result: { kind: 'article', article: row },
            replayed: false,
          });
        }
      }
      if (path.endsWith('/cancel')) {
        const row = state.runs.find((row) => path.includes(row.run.id))!;
        row.run = runSnapshot(Number(row.run.id.slice(-12)), 'canceled');
        return reply({ run: row.run });
      }
      if (path.endsWith('/events'))
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: '',
        });
      if (
        path.startsWith('/api/v1/workbench/files/') &&
        (path.endsWith('/preview') || path.endsWith('/download'))
      ) {
        const stored = state.imageFiles[path.split('/')[5]!];
        if (!stored) return reply({ message: '图片已不可用' }, 403);
        if (path.endsWith('/preview'))
          return reply({
            kind: 'image',
            mediaType: stored.mediaType,
            base64: stored.base64,
          });
        return route.fulfill({
          status: 200,
          contentType: stored.mediaType,
          headers: {
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(stored.fileName)}`,
          },
          body: Buffer.from(stored.base64, 'base64'),
        });
      }
      if (path.endsWith('/download')) {
        if (state.bodyGate) await state.bodyGate;
        return route.fulfill({
          status: 200,
          contentType: 'text/plain',
          headers: {
            'Content-Disposition':
              "attachment; filename*=UTF-8''allrice-export",
          },
          body: '不可直接改写的正文\n第二段',
        });
      }
      if (path === '/api/v1/references/publications') {
        const query = url.searchParams.get('query') ?? '';
        return reply({
          viewerId: scope.ownerId,
          references: query
            ? refs.filter((row) => row.fileName.includes(query))
            : url.searchParams.has('cursor')
              ? [refs[1]]
              : [refs[0]],
          nextCursor:
            !query && !url.searchParams.has('cursor')
              ? {
                  queryDigest: checksum,
                  createdAt: stamp,
                  sourceId: refs[0]!.sourceId,
                }
              : null,
        });
      }
      if (path.endsWith('/selection')) {
        const row = refs.find((row) => path.includes(row.revisionId))!;
        return reply({
          viewerId: scope.ownerId,
          workspaceId: scope.workspaceId,
          selection: {
            sourceId: row.sourceId,
            revisionId: row.revisionId,
            revision: row.revision,
            fileName: row.fileName,
            purpose: row.purpose,
            digest: checksum,
            checksum,
            ownership: row.ownership,
          },
          canReference: true,
        });
      }
      if (path === '/api/v1/workbench/files') {
        if (body) {
          const objectId = id(
            90 +
              Object.keys(state.imageFiles).filter(
                (key) => Number(key.slice(-12)) >= 90,
              ).length,
          );
          state.imageFiles[objectId] = {
            fileName: String(body.fileName),
            mediaType: String(body.mediaType),
            base64: String(body.contentBase64),
          };
          if (state.uploadGate) await state.uploadGate;
          return reply({ objectId }, 201);
        }
        const uploadedId = url.searchParams.get('objectId') ?? id(90),
          uploaded = state.imageFiles[uploadedId];
        return reply({
          viewerId: scope.ownerId,
          files: [
            {
              objectId: uploadedId,
              workspaceId: scope.workspaceId,
              fileName: uploaded?.fileName ?? '品牌参考.jpg',
              mediaType: uploaded?.mediaType ?? 'image/jpeg',
              checksum,
              sizeBytes: uploaded
                ? Buffer.from(uploaded.base64, 'base64').length
                : 4,
              createdAt: stamp,
              ownedByMe: true,
              canMaintain: true,
              revision: 0,
              sharing: {
                scope: 'personal',
                departmentIds: [],
                departmentNames: [],
              },
              category: 'upload',
              sessionIds: [],
              artifact: null,
              isReference: false,
              reference: null,
              origin: 'user-upload',
              sources: [],
              favorite: false,
            },
          ],
          employees: [],
          nextCursor: null,
        });
      }
      return reply(
        { message: 'Unexpected fixture request ' + req.method() + ' ' + path },
        500,
      );
    });
    await page.goto(origin + (nativeComposer ? '?nativeComposer=1' : ''));
    await page.getByRole('heading', { name: '原聊天' }).waitFor();
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    const open = async () => {
      await page
        .getByRole('button', { name: '打开 品牌自媒体', exact: true })
        .click();
      await page.getByRole('tabpanel', { name: '排期表' }).waitFor();
    };
    return {
      page,
      state,
      open,
      close: async () => {
        await context.close();
        expect(errors).toEqual([]);
      },
    };
  }
  const panel = (page: Page) =>
    page.getByRole('region', { name: '品牌自媒体', exact: true });
  async function finishDespiteAbort(
    page: Page,
    path: string,
    observeBlob = false,
  ) {
    await page.evaluate(
      ({ path, observeBlob }) => {
        const fetch = window.fetch.bind(window);
        window.fetch = async (input, options) => {
          if (
            typeof input !== 'string' ||
            new URL(input, location.href).pathname !== path
          )
            return fetch(input, options);
          const response = await fetch(input, {
            ...options,
            signal: undefined,
          });
          if (observeBlob) {
            const settled = () => {
              document.body.dataset.lateImageRead = 'settled';
            };
            if (options?.signal?.aborted) setTimeout(settled, 0);
            const blob = response.blob.bind(response);
            response.blob = async () => {
              const bytes = await blob();
              setTimeout(settled, 0);
              return bytes;
            };
          }
          return response;
        };
      },
      { path, observeBlob },
    );
  }
  async function holdBodyDelivery(page: Page, path: string) {
    await page.evaluate((path) => {
      const fetch = window.fetch.bind(window);
      const click = HTMLAnchorElement.prototype.click;
      const release = new Promise<void>((done) => {
        window.addEventListener('finish-body-delivery', () => done(), {
          once: true,
        });
      });
      let first = true;
      window.fetch = async (input, options) => {
        const response = await fetch(input, options);
        if (
          first &&
          typeof input === 'string' &&
          new URL(input, location.href).pathname === path
        ) {
          first = false;
          const blob = response.blob.bind(response);
          response.blob = async () => {
            document.body.dataset.deliveryHeaders = String(response.status);
            await release;
            const bytes = await blob();
            setTimeout(() => {
              document.body.dataset.deliveryBytes = String(bytes.size);
            }, 0);
            return bytes;
          };
        }
        return response;
      };
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        if (this.hasAttribute('download'))
          document.body.dataset.deliverySave = this.download;
        click.call(this);
      };
    }, path);
  }
  async function observeLateRunRead(page: Page) {
    await page.evaluate(() => {
      const fetch = window.fetch.bind(window);
      window.fetch = async (input, options) => {
        const response = await fetch(input, options);
        if (response.headers.has('x-fixture-late-run-read')) {
          const json = response.json.bind(response);
          response.json = async () => {
            const value = await json();
            setTimeout(() => {
              document.body.dataset.lateRunRead = 'settled';
            }, 0);
            return value;
          };
        }
        return response;
      };
    });
  }
  async function topicsPage(page: Page) {
    await page.getByRole('tab', { name: '选题库', exact: true }).click();
  }
  async function candidatesPage(page: Page) {
    await topicsPage(page);
    await page.getByRole('button', { name: '＋ 想选题', exact: true }).click();
    await page.getByLabel('内容方向', { exact: true }).waitFor();
  }
  const generates = (state: State) =>
    state.requests.filter(
      (req) =>
        req.body?.operation === 'candidates' ||
        req.body?.operation === 'article' ||
        req.body?.operation === 'image',
    );

  it('removes cached brand content on current access loss and never restores a late result or a reopened copy', async () => {
    const f = await fixture();
    const { page } = f;
    const lateEntered = gate();
    const releaseLate = gate();
    const lateFinished = gate<{ canceled: boolean; error?: unknown }>();
    const checkEntered = gate();
    const releaseCheck = gate();
    const accessDenied = accessProblem(
      '当前员工尚未添加这个插件，或绑定已撤销。',
    );
    try {
      await f.open();
      await topicsPage(page);
      await panel(page).getByText('新品故事 10', { exact: true }).waitFor();
      await page.getByRole('tab', { name: '文章库', exact: true }).click();
      await expect
        .poll(() => page.getByLabel('文章正文').textContent())
        .toContain('不可直接改写的正文');
      await page.getByRole('tab', { name: '排期表', exact: true }).click();

      await page.route(
        (url) => brandView(url, 'articles'),
        async (route) => {
          lateEntered.resolve();
          await releaseLate.promise;
          try {
            await route.fulfill({
              json: {
                view: 'articles',
                items: [article(99)],
                nextCursor: null,
              },
            });
            lateFinished.resolve({ canceled: false });
          } catch (error) {
            lateFinished.resolve({
              canceled:
                route.request().failure()?.errorText === 'net::ERR_ABORTED',
              error,
            });
          }
        },
      );
      await page.route(
        (url) => brandView(url, 'calendar'),
        async (route) => {
          await lateEntered.promise;
          await route.fulfill({ status: 403, json: accessDenied });
        },
      );
      await page.route(moduleDirectory, async (route) => {
        checkEntered.resolve();
        await releaseCheck.promise;
        await route.fulfill({
          json: {
            modules: [
              {
                descriptor: {
                  id: 'allrice.brand-media',
                  displayName: '品牌自媒体',
                },
                binding: { ...binding, revokedAt: stamp },
                enabled: false,
                available: false,
              },
            ],
          },
        });
      });

      await page.getByRole('button', { name: '下个月', exact: true }).click();
      await checkEntered.promise;
      await panel(page).getByRole('alert').waitFor();
      expect(await panel(page).getByRole('tab').count()).toBe(0);
      expect(await panel(page).textContent()).not.toMatch(
        /不可直接改写的正文|新品故事|文章 20/,
      );

      const checked = page.waitForResponse((response) =>
        moduleDirectory(new URL(response.url())),
      );
      releaseCheck.resolve();
      expect((await checked).ok()).toBe(true);
      releaseLate.resolve();
      const late = await lateFinished.promise;
      if (!late.canceled && late.error) throw late.error;
      expect(await panel(page).getByRole('tab').count()).toBe(0);
      expect(await panel(page).textContent()).not.toMatch(
        /不可直接改写的正文|月历里的旧文章/,
      );
      await panel(page).getByRole('button', { name: '← 回到对话' }).click();
      await page.getByRole('heading', { name: '原聊天' }).waitFor();
      expect(await page.getByLabel('聊天草稿').inputValue()).toBe(
        '未发送的聊天草稿',
      );
      await page.getByLabel('草稿附件').waitFor();

      await page.route(brandEndpoint, (route) =>
        route.fulfill({ status: 403, json: accessDenied }),
      );
      await page
        .getByRole('button', { name: '打开 品牌自媒体', exact: true })
        .click();
      await panel(page).getByRole('alert').waitFor();
      expect(await panel(page).getByRole('tab').count()).toBe(0);
      expect(await panel(page).textContent()).not.toMatch(
        /不可直接改写的正文|新品故事|月历里的旧文章/,
      );
      expect(
        f.state.requests.filter((request) => request.method === 'POST'),
      ).toHaveLength(0);
    } finally {
      lateEntered.resolve();
      releaseLate.resolve();
      releaseCheck.resolve();
      await f.close();
    }
  });

  it.each(['forbidden', 'binding-conflict', 'readonly', 'offline'] as const)(
    'suspends private content only for a possible loss of access on a write (%s)',
    async (outcome) => {
      const document = article();
      document.publication = {
        state: 'scheduled',
        schedule: { plannedAt: stamp, timezone: 'Asia/Shanghai' },
        links: null,
      };
      const f = await fixture({ articles: [document] });
      const { page } = f;
      const check = gate();
      let checkCount = 0;
      try {
        await f.open();
        await page.getByRole('tab', { name: '文章库', exact: true }).click();
        const body = page.getByLabel('文章正文');
        await expect
          .poll(() => body.textContent())
          .toContain('不可直接改写的正文');
        await page.route(brandEndpoint, (route) => {
          if (route.request().method() !== 'POST') return route.fallback();
          if (outcome === 'offline') return route.abort('internetdisconnected');
          return route.fulfill({
            status: outcome === 'binding-conflict' ? 409 : 403,
            json: accessProblem(
              '取消排期被服务拒绝',
              outcome === 'binding-conflict'
                ? 'VERSION_CONFLICT'
                : 'AUTHORIZATION_DENIED',
            ),
          });
        });
        await page.route(moduleDirectory, async (route) => {
          checkCount++;
          await check.promise;
          if (outcome === 'readonly') return route.fallback();
          return route.fulfill({
            status: 503,
            json: { message: '目录暂不可用' },
          });
        });
        await panel(page)
          .getByRole('button', { name: '取消排期', exact: true })
          .click();
        await panel(page).getByRole('alert').waitFor();
        if (outcome === 'offline') {
          expect(checkCount).toBe(0);
        } else {
          await expect.poll(() => checkCount).toBe(1);
          expect(await panel(page).getByRole('tab').count()).toBe(0);
          expect(await panel(page).textContent()).not.toContain(
            '不可直接改写的正文',
          );
          const reply = page.waitForResponse((response) =>
            moduleDirectory(new URL(response.url())),
          );
          check.resolve();
          await (await reply).finished();
          if (outcome !== 'readonly') {
            await page.evaluate(() => new Promise(requestAnimationFrame));
            expect(await panel(page).getByRole('tab').count()).toBe(0);
            expect(await panel(page).textContent()).not.toContain(
              '不可直接改写的正文',
            );
          }
        }
        if (outcome === 'offline' || outcome === 'readonly') {
          await panel(page)
            .getByRole('tab', { name: '文章库', exact: true })
            .waitFor();
          await expect
            .poll(() => body.textContent())
            .toContain('不可直接改写的正文');
        }
        await panel(page).getByRole('button', { name: '← 回到对话' }).click();
        expect(await page.getByLabel('聊天草稿').inputValue()).toBe(
          '未发送的聊天草稿',
        );
      } finally {
        check.resolve();
        await f.close();
      }
    },
  );

  it.each(['topics', 'article'] as const)(
    'an enabled catalog does not restore a denied %s projection before a fresh authorized read',
    async (view) => {
      const f = await fixture({
        articles: [article(), { ...article(21), body: null }],
      });
      const { page } = f;
      let denied = true;
      const missing = view === 'topics' ? '新品故事 10' : '文章 20';
      const message = '固定文件现权已撤销';
      try {
        await f.open();
        await topicsPage(page);
        await panel(page).getByText('新品故事 10', { exact: true }).waitFor();
        await page.getByRole('tab', { name: '文章库', exact: true }).click();
        await expect
          .poll(() => page.getByLabel('文章正文').textContent())
          .toContain('不可直接改写的正文');
        await page.route(
          (url) =>
            brandView(url, view) &&
            (view === 'topics' || url.searchParams.get('articleId') === id(20)),
          (route) =>
            denied
              ? route.fulfill({ status: 403, json: accessProblem(message) })
              : route.fallback(),
        );
        await page.getByRole('tab', { name: '排期表', exact: true }).click();
        await panel(page)
          .getByRole('button', { name: '下个月', exact: true })
          .click();
        await panel(page)
          .getByRole('alert')
          .filter({ hasText: message })
          .waitFor();

        await topicsPage(page);
        expect(
          await panel(page).getByText('新品故事 10', { exact: true }).count(),
        ).toBe(view === 'topics' ? 0 : 1);
        await page.getByRole('tab', { name: '文章库', exact: true }).click();
        const other = panel(page).getByRole('button', {
          name: '文章 21',
          exact: true,
        });
        await other.waitFor();
        if (view === 'article') {
          expect(
            await panel(page).getByText(missing, { exact: true }).count(),
          ).toBe(0);
          expect(await panel(page).getByLabel('文章正文').count()).toBe(0);
          await other.click();
          await panel(page)
            .getByRole('heading', { name: '文章 21', exact: true })
            .waitFor();
        }
        denied = false;
        const fresh = '重新授权的内容';
        if (view === 'topics') f.state.topics[0]!.candidate.title = fresh;
        else f.state.articles[0]!.title = fresh;
        await page.getByRole('tab', { name: '排期表', exact: true }).click();
        await panel(page)
          .getByRole('button', { name: '下个月', exact: true })
          .click();
        await page
          .getByRole('tab', {
            name: view === 'topics' ? '选题库' : '文章库',
            exact: true,
          })
          .click();
        await panel(page).getByText(fresh, { exact: true }).first().waitFor();
        expect(
          await panel(page).getByText(missing, { exact: true }).count(),
        ).toBe(0);
      } finally {
        await f.close();
      }
    },
  );

  it('only a catalog started after a rejected write can clear that access warning', async () => {
    const stored = article();
    stored.publication = {
      state: 'scheduled',
      schedule: { plannedAt: stamp, timezone: 'Asia/Shanghai' },
      links: null,
    };
    const f = await fixture({ articles: [stored] });
    const { page } = f;
    const entered = gate();
    const refuse = gate();
    const oldCheck = gate();
    const newCheck = gate();
    let checks = 0;
    const readDenied = '选题固定资料已撤销';
    const writeDenied = '取消排期时绑定已撤销';
    try {
      await f.open();
      await panel(page)
        .getByRole('tab', { name: '文章库', exact: true })
        .click();
      await expect
        .poll(() => panel(page).getByLabel('文章正文').textContent())
        .toContain('不可直接改写的正文');
      await page.route(brandEndpoint, async (route) => {
        if (route.request().method() === 'POST') {
          entered.resolve();
          await refuse.promise;
          return route.fulfill({
            status: 403,
            json: accessProblem(writeDenied),
          });
        }
        if (brandView(new URL(route.request().url()), 'topics'))
          return route.fulfill({
            status: 403,
            json: accessProblem(readDenied),
          });
        return route.fallback();
      });
      await page.route(moduleDirectory, async (route) => {
        if (++checks === 1) {
          await oldCheck.promise;
          return route.fallback();
        }
        await newCheck.promise;
        return route.fulfill({
          status: 503,
          json: { message: '最新目录暂不可用' },
        });
      });
      await panel(page)
        .getByRole('button', { name: '取消排期', exact: true })
        .click();
      await entered.promise;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await panel(page)
        .getByRole('alert')
        .filter({ hasText: readDenied })
        .waitFor();
      await expect.poll(() => checks).toBe(1);
      refuse.resolve();
      await panel(page)
        .getByRole('alert')
        .filter({ hasText: writeDenied })
        .waitFor();
      const oldReply = page.waitForResponse((response) =>
        moduleDirectory(new URL(response.url())),
      );
      oldCheck.resolve();
      await (await oldReply).finished();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      expect(await panel(page).getByRole('tab').count()).toBe(0);
      expect(await panel(page).textContent()).not.toContain(
        '不可直接改写的正文',
      );
      await expect.poll(() => checks).toBe(2);
      const newReply = page.waitForResponse(
        (response) =>
          moduleDirectory(new URL(response.url())) && response.status() === 503,
      );
      newCheck.resolve();
      await (await newReply).finished();
      expect(await panel(page).getByRole('tab').count()).toBe(0);
    } finally {
      refuse.resolve();
      oldCheck.resolve();
      newCheck.resolve();
      await f.close();
    }
  });

  it('a late article A refusal removes A after selecting B and fences an older list result', async () => {
    const f = await fixture({ articles: [article(), article(21)] });
    const { page } = f;
    const detailStarted = gate();
    const detail = gate();
    const listStarted = gate();
    const list = gate();
    let holdList = false;
    let denyA = true;
    const missing = '文章 20';
    const independent = '文章 21';
    const denial = '当前员工的这篇文章已删除';
    const denialAlert = panel(page)
      .getByRole('alert')
      .filter({ hasText: denial });
    try {
      await f.open();
      await panel(page)
        .getByRole('tab', { name: '文章库', exact: true })
        .click();
      await expect
        .poll(() => panel(page).getByLabel('文章正文').textContent())
        .toContain('不可直接改写的正文');
      await page.route(brandEndpoint, async (route) => {
        const url = new URL(route.request().url());
        if (
          denyA &&
          brandView(url, 'article') &&
          url.searchParams.get('articleId') === id(20)
        ) {
          detailStarted.resolve();
          await detail.promise;
          return route.fulfill({
            status: 404,
            json: accessProblem(denial, 'RESOURCE_NOT_FOUND'),
          });
        }
        if (holdList && brandView(url, 'articles')) {
          listStarted.resolve();
          await list.promise;
        }
        return route.fallback();
      });
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await detailStarted.promise;
      const otherRead = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          brandView(url, 'article') &&
          url.searchParams.get('articleId') === id(21)
        );
      });
      await panel(page)
        .getByRole('button', { name: independent, exact: true })
        .click();
      await (await otherRead).finished();
      await panel(page)
        .getByRole('heading', { name: independent, exact: true })
        .waitFor();

      holdList = true;
      const refreshedB = '文章 21 的列表已更新';
      f.state.articles[1] = { ...article(21), title: refreshedB };
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await listStarted.promise;
      detail.resolve();
      await denialAlert.waitFor();
      await panel(page)
        .getByRole('heading', { name: independent, exact: true })
        .waitFor();
      expect(
        await panel(page)
          .getByRole('button', { name: missing, exact: true })
          .count(),
      ).toBe(0);
      holdList = false;
      list.resolve();
      await panel(page)
        .getByRole('button', { name: refreshedB, exact: true })
        .waitFor();
      expect(
        await panel(page)
          .getByRole('button', { name: missing, exact: true })
          .count(),
      ).toBe(0);
      expect(await denialAlert.isVisible()).toBe(true);

      const newerB = '文章 21 再次成功读取';
      f.state.articles = [{ ...article(21), title: newerB }];
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await panel(page)
        .getByRole('button', { name: newerB, exact: true })
        .waitFor();
      expect(await denialAlert.isVisible()).toBe(true);

      denyA = false;
      const restored = '文章 20 重新取得授权';
      f.state.articles.push({ ...article(), title: restored });
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await panel(page)
        .getByRole('button', { name: restored, exact: true })
        .click();
      await panel(page)
        .getByRole('heading', { name: restored, exact: true })
        .waitFor();
      await denialAlert.waitFor({ state: 'hidden' });
    } finally {
      detail.resolve();
      list.resolve();
      await f.close();
    }
  });

  it('keeps independently authorized detail, calendar, and Run results when the article list is denied', async () => {
    const stored = article(21);
    const month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date());
    stored.publication = {
      state: 'scheduled',
      schedule: {
        plannedAt: month + '-16T08:00:00.000Z',
        timezone: 'Asia/Shanghai',
      },
      links: null,
    };
    const f = await fixture({ articles: [article(), stored] });
    const { page } = f;
    const directory = gate();
    const denial = '文章列表中的一份资料不可读';
    try {
      await f.open();
      await panel(page)
        .getByRole('tab', { name: '文章库', exact: true })
        .click();
      const detail = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          brandView(url, 'article') &&
          url.searchParams.get('articleId') === stored.id
        );
      });
      await panel(page)
        .getByRole('button', { name: stored.title, exact: true })
        .click();
      await (await detail).finished();
      await expect
        .poll(() => panel(page).getByLabel('文章正文').textContent())
        .toContain('不可直接改写的正文');

      const updated = { ...stored, revision: 2, title: '仍受权的新日历文章' };
      f.state.articles[1] = updated;
      const run = recovery('article');
      run.invocation.intent.articleId = stored.id;
      run.submission = { articleUpdated: false, revision: null };
      f.state.runs = [run];
      await page.route(
        (url) => brandView(url, 'articles'),
        (route) => route.fulfill({ status: 403, json: accessProblem(denial) }),
      );
      await page.route(moduleDirectory, async (route) => {
        await directory.promise;
        await route.fallback();
      });
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await panel(page)
        .getByRole('alert')
        .filter({ hasText: denial })
        .waitFor();
      directory.resolve();
      await panel(page)
        .getByRole('heading', { name: updated.title, exact: true })
        .waitFor();
      expect(
        await panel(page)
          .getByRole('button', { name: '文章 20', exact: true })
          .count(),
      ).toBe(0);
      await panel(page)
        .getByText('本次正文成果已保留，文章未更新，请核对当前文章。', {
          exact: true,
        })
        .waitFor();
      await panel(page)
        .getByRole('tab', { name: '排期表', exact: true })
        .click();
      await panel(page)
        .getByRole('button', { name: updated.title, exact: true })
        .waitFor();
    } finally {
      directory.resolve();
      await f.close();
    }
  });

  it('opening only the main area preserves the original draft/attachment, sidebar geometry and visible focus across all tabs', async () => {
    const f = await fixture();
    const { page } = f;
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
      'BODY',
    );
    await page.getByLabel('聊天草稿').fill('写到一半\n保留换行');
    const before = await page.getByLabel('员工侧栏').boundingBox();
    await f.open();
    expect(await page.getByLabel('员工侧栏').boundingBox()).toEqual(before);
    const slide = page.locator('[data-brand-media-host]');
    expect(
      await slide.evaluate((el) => ({
        duration: getComputedStyle(el).transitionDuration,
        timing: getComputedStyle(el).transitionTimingFunction,
      })),
    ).toEqual({ duration: '0.24s', timing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    expect(
      await page
        .getByLabel('聊天草稿')
        .evaluate((el) => !!el.closest('[inert]')),
    ).toBe(true);
    for (const tab of ['选题库', '文章库', '排期表']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      expect(
        await page.getByRole('button', { name: 'ⓘ 使用说明' }).isVisible(),
      ).toBe(true);
    }
    await page.getByRole('button', { name: 'ⓘ 使用说明' }).click();
    await page.getByRole('dialog', { name: '使用说明' }).waitFor();
    await page.screenshot({ path: resolve(evidence, 'help-main-area.png') });
    await page
      .getByRole('button', { name: 'Rice 员工', exact: true })
      .click({ force: true });
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await expect
      .poll(() =>
        page
          .getByLabel('聊天草稿')
          .evaluate((el) => document.activeElement === el),
      )
      .toBe(true);
    expect(await page.getByLabel('聊天草稿').inputValue()).toBe(
      '写到一半\n保留换行',
    );
    expect(await page.getByLabel('草稿附件').textContent()).toBe('原附件.pdf');
    expect(await page.getByLabel('员工侧栏').boundingBox()).toEqual(before);
    await f.open();
    expect(
      await page.getByRole('tabpanel', { name: '排期表' }).isVisible(),
    ).toBe(true);
    await page.getByRole('button', { name: '← 回到对话' }).click();
    await f.close();
  });

  it.each([
    { width: 1440, colorScheme: 'light' as const },
    { width: 1440, colorScheme: 'dark' as const },
    { width: 390, colorScheme: 'light' as const },
    { width: 390, colorScheme: 'dark' as const },
  ])(
    'the actual conversation composer cannot paint through the plugin or help ($width, $colorScheme)',
    async (surface) => {
      const f = await fixture({}, 'reduce', surface);
      const { page } = f;
      try {
        await page.evaluate((theme) => {
          document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark');
        }, surface.colorScheme);
        const addButton = page.getByRole('button', {
          name: '添加插件',
          exact: true,
        });
        const openButton = page.getByRole('button', {
          name: '打开 品牌自媒体',
          exact: true,
        });
        await openButton.waitFor();
        const geometry = (element: HTMLElement) => {
          const style = getComputedStyle(element);
          return {
            height: element.getBoundingClientRect().height,
            padding: style.padding,
            radius: style.borderRadius,
            fontSize: style.fontSize,
          };
        };
        expect(await openButton.evaluate(geometry)).toEqual(
          await addButton.evaluate(geometry),
        );
        expect(await openButton.textContent()).not.toContain('↗');
        expect(
          await openButton.evaluate((el) => {
            const style = getComputedStyle(el);
            return [style.backgroundColor, style.color];
          }),
        ).toEqual(['rgb(15, 17, 21)', 'rgb(255, 255, 255)']);
        const input = page.getByRole('textbox', { name: '给 Rice 的消息' });
        await input.fill('保留真实输入框的草稿');
        const seat = page.locator('[data-composer-seat]');
        expect(await seat.evaluate((el) => getComputedStyle(el).zIndex)).toBe(
          '7',
        );
        const seatRect = await seat.boundingBox();
        expect(seatRect).not.toBeNull();
        expect(seatRect!.height).toBeGreaterThan(0);
        expect(seatRect!.y).toBeLessThan(1000);
        const viewport = page.viewportSize()!;
        const composerClip = {
          x: Math.max(0, seatRect!.x),
          y: Math.max(0, seatRect!.y),
          width:
            Math.min(viewport.width, seatRect!.x + seatRect!.width) -
            Math.max(0, seatRect!.x),
          height:
            Math.min(viewport.height, seatRect!.y + seatRect!.height) -
            Math.max(0, seatRect!.y),
        };
        expect(composerClip.height).toBeGreaterThan(0);
        await f.open();
        const insets = await page
          .locator('[data-brand-media-host]')
          .evaluate((host) => {
            const outer = host.getBoundingClientRect();
            const inner = host
              .querySelector('[data-brand-media-surface]')!
              .getBoundingClientRect();
            return [
              inner.top - outer.top,
              inner.left - outer.left,
              outer.right - inner.right,
              outer.bottom - inner.bottom,
            ];
          });
        for (const inset of insets)
          expect(Math.abs(inset - 12)).toBeLessThanOrEqual(0.5);
        const assertComposerPaint = async (name: string, covered = true) => {
          const label = `native-composer-${surface.width}-${surface.colorScheme}-${name}`;
          const prefix = resolve(evidence, label);
          // inert does not stop painting. Keep the native seat and all layers
          // mounted in both probes. Only the same paint variable changes;
          // adding/removing layers can rerasterize unrelated alpha edges.
          if (covered)
            await page.screenshot({
              path: prefix + '-mounted.png',
              animations: 'disabled',
            });
          await seat.evaluate((el) =>
            el.style.setProperty('--met224-probe-color', 'cyan'),
          );
          const probe = await page.addStyleTag({
            // Hide the caret for both frames without Playwright changing the
            // visible article editor's inline style for each screenshot.
            content: `input, textarea, [contenteditable] { caret-color: transparent !important; }
              [data-composer-seat], [data-composer-seat] * { background: var(--met224-probe-color) !important; color: var(--met224-probe-color) !important; border-color: var(--met224-probe-color) !important; box-shadow: none !important; }`,
          });
          const paint = () =>
            page.evaluate(
              () =>
                new Promise<void>((done) =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => done()),
                  ),
                ),
            );
          try {
            await paint();
            const cyan = await page.screenshot({
              path: prefix + '-composer-cyan.png',
              animations: 'disabled',
              caret: 'initial',
              clip: composerClip,
            });
            await seat.evaluate((el) =>
              el.style.setProperty('--met224-probe-color', 'magenta'),
            );
            await paint();
            const magenta = await page.screenshot({
              path: prefix + '-composer-magenta.png',
              animations: 'disabled',
              caret: 'initial',
              clip: composerClip,
            });
            const equalPng = cyan.equals(magenta);
            if (covered && equalPng) return;
            const preserve = async (comparison: object) => {
              const batch = process.env.ALLRICE_CI_COLLECTION_BATCH;
              const directory = batch
                ? resolve(dirname(resolve(batch)), 'brand-media-composer')
                : evidence;
              await mkdir(directory, { recursive: true });
              const files = ['composer-cyan', 'composer-magenta'];
              if (covered) files.push('mounted');
              await Promise.all([
                writeFile(
                  resolve(directory, label + '-comparison.json'),
                  JSON.stringify(
                    {
                      name,
                      surface,
                      composerClip,
                      covered,
                      equalPng,
                      browserVersion: browser.version(),
                      comparison,
                    },
                    null,
                    2,
                  ),
                ),
                ...(batch
                  ? files.map((file) =>
                      copyFile(
                        `${prefix}-${file}.png`,
                        resolve(directory, `${label}-${file}.png`),
                      ),
                    )
                  : []),
              ]);
            };
            const pixels = await compareComposerProbes(
              page,
              cyan,
              magenta,
            ).catch(async (error: unknown) => {
              await preserve({ error: String(error) });
              throw error;
            });
            if (covered || pixels.probePixels === 0) await preserve(pixels);
            if (covered) {
              expect(pixels.changedPixels - pixels.neutralPixels, label).toBe(
                0,
              );
            } else {
              expect(pixels.probePixels, label).toBeGreaterThan(0);
            }
          } finally {
            await probe.evaluate((el) => (el as HTMLStyleElement).remove());
            await seat.evaluate((el) =>
              el.style.removeProperty('--met224-probe-color'),
            );
          }
        };
        for (const tab of ['排期表', '选题库', '文章库']) {
          await page.getByRole('tab', { name: tab, exact: true }).click();
          if (tab === '文章库')
            await expect
              .poll(() => page.getByLabel('文章正文').textContent())
              .toContain('不可直接改写的正文');
          await page.evaluate(() => document.fonts.ready);
          await assertComposerPaint(tab);
        }
        await page.getByRole('button', { name: 'ⓘ 使用说明' }).click();
        await page.getByRole('dialog', { name: '使用说明' }).waitFor();
        await assertComposerPaint('help');
        const conversation = seat.locator('xpath=ancestor::*[@aria-hidden][1]');
        await conversation.evaluate((el) => {
          (el as HTMLElement).style.isolation = 'auto';
        });
        try {
          await assertComposerPaint('without-isolation', false);
        } finally {
          await conversation.evaluate((el) =>
            (el as HTMLElement).style.removeProperty('isolation'),
          );
        }
        await page.getByRole('button', { name: '关闭使用说明' }).click();
        await page.getByRole('button', { name: '← 回到对话' }).click();
        expect(await input.inputValue()).toBe('保留真实输入框的草稿');
        expect(await input.isVisible()).toBe(true);
        expect(generates(f.state)).toHaveLength(0);
      } finally {
        await f.close();
      }
    },
  );

  it('reduced motion disables the main slide and late help responses cannot revive a hidden modal layer', async () => {
    let release!: () => void;
    const f = await fixture(
      {
        helpGate: new Promise<void>((done) => {
          release = done;
        }),
      },
      'reduce',
    );
    await f.open();
    expect(
      await f.page
        .locator('[data-brand-media-host]')
        .evaluate((el) => getComputedStyle(el).transitionDuration),
    ).toBe('0s');
    await f.page.getByRole('button', { name: 'ⓘ 使用说明' }).click();
    await expect
      .poll(() =>
        f.state.requests.some((req) => req.path.includes('view=help')),
      )
      .toBe(true);
    await f.page
      .getByRole('button', { name: 'Rice 员工', exact: true })
      .click();
    release();
    await expect
      .poll(() =>
        f.page
          .getByLabel('聊天草稿')
          .evaluate((el) => document.activeElement === el),
      )
      .toBe(true);
    await f.page.keyboard.press('Escape');
    expect(await f.page.getByRole('dialog').count()).toBe(0);
    await f.open();
    expect(await f.page.getByRole('dialog').count()).toBe(0);
    await f.close();
  });

  it('the side picker uses the approved hierarchy and native checkbox; a late A addition cannot disable B', async () => {
    let release!: () => void;
    const f = await fixture({
      installed: new Set(),
      addGate: new Promise<void>((done) => {
        release = done;
      }),
    });
    const { page } = f;
    await page.getByRole('button', { name: '添加插件' }).click();
    expect(
      await page
        .getByRole('heading', { name: '添加插件', exact: true })
        .isVisible(),
    ).toBe(true);
    expect(
      await page
        .getByText('选择插件，添加给 Rice。', { exact: true })
        .isVisible(),
    ).toBe(true);
    await page
      .getByRole('region', { name: '选择插件', exact: true })
      .getByText('想选题、写文章、安排发布计划', { exact: true })
      .waitFor({ state: 'visible' });
    expect(await page.getByRole('dialog').count()).toBe(0);
    await page
      .getByRole('checkbox', { name: '品牌自媒体', exact: true })
      .check();
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await expect
      .poll(
        () =>
          f.state.requests.filter(
            (req) => req.method === 'POST' && req.path.endsWith('/modules'),
          ).length,
      )
      .toBe(1);
    await page.getByRole('button', { name: '另一个员工' }).click();
    await page.getByRole('button', { name: '添加插件' }).click();
    await page
      .getByRole('checkbox', { name: '品牌自媒体', exact: true })
      .check();
    expect(
      await page.getByRole('button', { name: '添加', exact: true }).isEnabled(),
    ).toBe(true);
    release();
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await page
      .getByRole('button', { name: '打开 品牌自媒体', exact: true })
      .waitFor();
    const adds = f.state.requests.filter(
      (req) => req.method === 'POST' && req.path.endsWith('/modules'),
    );
    expect(adds).toHaveLength(2);
    expect(adds[0]!.body!.instanceId).toBe(scope.instanceId);
    expect(adds[1]!.body!.instanceId).toBe(id(5));
    expect(adds[0]!.body!.requestId).not.toBe(adds[1]!.body!.requestId);
    expect(
      await page
        .getByText('带有独立界面的工具，点击打开新页面。', { exact: true })
        .isVisible(),
    ).toBe(true);
    await f.close();
  });

  it.each(['denied', 'restored', 'restored-later', 'offline'] as const)(
    'refreshes picker availability on a rejected add and keeps uncertain retries (%s)',
    async (outcome) => {
      const f = await fixture({ installed: new Set() });
      const { page } = f;
      const check = gate();
      let reads = 0;
      let available = outcome === 'restored';
      const adds: unknown[] = [];
      const picker = page.getByRole('region', {
        name: '选择插件',
        exact: true,
      });
      const checkbox = picker.getByRole('checkbox', {
        name: '品牌自媒体',
        exact: true,
      });
      const add = picker.getByRole('button', { name: '添加', exact: true });
      const message = '当前账号无权添加插件';
      try {
        await page
          .getByRole('button', { name: '添加插件', exact: true })
          .click();
        await checkbox.check();
        await page.route(moduleDirectory, async (route) => {
          const request = route.request();
          if (request.method() === 'POST') {
            adds.push(request.postDataJSON().requestId);
            if (adds.length > 1) return route.fallback();
            return outcome === 'offline'
              ? route.abort('internetdisconnected')
              : route.fulfill({ status: 403, json: accessProblem(message) });
          }
          reads++;
          if (outcome === 'offline') return route.fallback();
          await check.promise;
          return route.fulfill({
            json: {
              modules: [
                {
                  descriptor: {
                    id: 'allrice.brand-media',
                    displayName: '品牌自媒体',
                  },
                  binding: null,
                  enabled: false,
                  available,
                },
              ],
            },
          });
        });
        await add.click();
        await picker.getByRole('alert').waitFor();
        if (outcome === 'offline') {
          expect(reads).toBe(0);
          expect(await checkbox.isChecked()).toBe(true);
          await add.click();
          await page
            .getByRole('button', { name: '打开 品牌自媒体', exact: true })
            .waitFor();
          expect(adds).toHaveLength(2);
          expect(adds[0]).toBe(adds[1]);
          return;
        }
        await expect.poll(() => reads).toBe(1);
        expect(await checkbox.count()).toBe(0);
        expect(await add.isDisabled()).toBe(true);
        const reply = page.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            moduleDirectory(new URL(response.url())),
        );
        check.resolve();
        await (await reply).finished();
        if (outcome === 'restored') {
          await checkbox.waitFor();
          expect(await checkbox.isChecked()).toBe(false);
        } else {
          await picker
            .getByRole('heading', { name: '暂无可添加的插件', exact: true })
            .waitFor();
          expect(await checkbox.count()).toBe(0);
        }
        if (outcome === 'restored-later') {
          await picker
            .getByRole('button', { name: '取消', exact: true })
            .click();
          available = true;
          await page
            .getByRole('button', { name: '添加插件', exact: true })
            .click();
          await expect.poll(() => reads).toBe(2);
          await checkbox.waitFor();
          expect(await checkbox.isChecked()).toBe(false);
        }
        expect(await add.isDisabled()).toBe(true);
        expect(adds).toHaveLength(1);
      } finally {
        check.resolve();
        await f.close();
      }
    },
  );

  it('distinguishes loading, confirmed empty and directory errors on picker reopen', async () => {
    const f = await fixture({ installed: new Set() });
    const { page } = f;
    const reply = [gate(), gate(), gate()];
    let requested = 0;
    const picker = page.getByRole('region', { name: '选择插件', exact: true });
    const open = page.getByRole('button', { name: '添加插件', exact: true });
    const empty = picker.getByRole('heading', {
      name: '暂无可添加的插件',
      exact: true,
    });
    const add = picker.getByRole('button', { name: '添加', exact: true });
    const loading = picker.getByRole('status').filter({ hasText: '正在读取…' });
    const checkbox = picker.getByRole('checkbox', {
      name: '品牌自媒体',
      exact: true,
    });
    try {
      await page.route(moduleDirectory, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const step = requested++;
        await reply[step]?.promise;
        if (step === 0)
          return route.fulfill({
            status: 503,
            json: { message: '当前目录暂时无法读取' },
          });
        if (step === 1) return route.fulfill({ json: { modules: [] } });
        return route.fallback();
      });
      for (const step of [0, 1, 2]) {
        await open.click();
        await expect.poll(() => requested).toBe(step + 1);
        expect(await empty.count()).toBe(0);
        await loading.waitFor();
        expect(await add.isDisabled()).toBe(true);
        reply[step]!.resolve();
        if (step === 0) {
          await picker
            .getByRole('alert')
            .filter({ hasText: '当前目录暂时无法读取' })
            .waitFor();
          expect(await empty.count()).toBe(0);
        } else if (step === 1) {
          await empty.waitFor();
          expect(await picker.getByRole('alert').count()).toBe(0);
        } else {
          await checkbox.waitFor();
          expect(await checkbox.isChecked()).toBe(false);
          expect(await empty.count()).toBe(0);
          expect(await picker.getByRole('alert').count()).toBe(0);
        }
        expect(await loading.count()).toBe(0);
        expect(await add.isDisabled()).toBe(true);
        await picker.getByRole('button', { name: '取消', exact: true }).click();
      }
      expect(
        f.state.requests.filter((request) => request.method === 'POST'),
      ).toHaveLength(0);
    } finally {
      for (const pending of reply) pending.resolve();
      await f.close();
    }
  });

  it('candidate direction, references and immutable candidates stay on one page, and only a human adds a topic', async () => {
    const f = await fixture({
      runs: [recovery('candidates')],
      moreTopics: true,
    });
    const { page } = f;
    await f.open();
    await topicsPage(page);
    expect(
      await page.getByText('已加载 1 个选题', { exact: true }).isVisible(),
    ).toBe(true);
    await candidatesPage(page);
    expect(
      await page.getByRole('button', { name: '← 选题库' }).isVisible(),
    ).toBe(true);
    expect(await page.getByRole('dialog').count()).toBe(0);
    expect(
      await page
        .getByRole('heading', { name: '十分钟的新品体验', exact: true })
        .isVisible(),
    ).toBe(true);
    expect(f.state.topics).toHaveLength(1);
    await page.getByRole('button', { name: '加入选题库', exact: true }).click();
    await expect.poll(() => f.state.topics.length).toBe(2);
    const selected = f.state.requests.find(
      (req) => req.body?.operation === 'topic.add',
    )!.body!;
    expect(selected.sourceRunId).toBe(id(300));
    expect(selected.candidate).toEqual({
      title: '十分钟的新品体验',
      summary: '下班后的轻松时刻',
    });
    expect(selected).not.toHaveProperty('moduleInvocation');
    await page.getByRole('button', { name: '已加入 ✓', exact: true }).waitFor();
    await page.getByRole('button', { name: '← 选题库', exact: true }).click();
    await page.getByRole('button', { name: '← 回到对话' }).click();
    await f.open();
    await candidatesPage(page);
    expect(
      await page
        .getByRole('button', { name: '已加入 ✓', exact: true })
        .isDisabled(),
    ).toBe(true);
    expect(
      f.state.requests.filter((req) => req.body?.operation === 'topic.add'),
    ).toHaveLength(1);
    await page.getByRole('button', { name: '← 选题库' }).click();
    expect(
      await page.getByText('已加载 2 个选题', { exact: true }).isVisible(),
    ).toBe(true);
    await f.close();
  });

  it('candidate selection keeps the same operation identity after an uncertain request and a full host remount', async () => {
    const f = await fixture({
      runs: [recovery('candidates')],
      failCandidateOnce: true,
    });
    await f.open();
    await candidatesPage(f.page);
    await f.page
      .getByRole('button', { name: '加入选题库', exact: true })
      .click();
    await f.page.getByText('选入请求网络中断', { exact: false }).waitFor();
    await f.page.getByRole('button', { name: '← 选题库', exact: true }).click();
    await f.page.getByRole('button', { name: '← 回到对话' }).click();
    await f.open();
    await candidatesPage(f.page);
    await f.page
      .getByRole('button', { name: '加入选题库', exact: true })
      .click();
    await f.page
      .getByRole('button', { name: '已加入 ✓', exact: true })
      .waitFor();
    const adds = f.state.requests.filter(
      (req) => req.body?.operation === 'topic.add',
    );
    expect(adds).toHaveLength(2);
    expect(adds[1]!.body!.requestId).toBe(adds[0]!.body!.requestId);
    expect(f.state.topics).toHaveLength(2);
    await f.close();
  });

  it.each(['failed', 'canceled'] as const)(
    'cold article %s retry sends the original instructions, exact target and pins as a new controlled request',
    async (status) => {
      const failed = recovery('article', status),
        pin = { origin: 'upload', file: { objectId: id(90), checksum } };
      failed.invocation.intent.instructions = '保留结构，给通勤族增加真实场景';
      failed.invocation.intent.references = [pin];
      const f = await fixture({ runs: [failed] });
      await f.open();
      await f.page.getByRole('tab', { name: '文章库', exact: true }).click();
      await f.page.getByRole('button', { name: '重试', exact: true }).click();
      await f.page.getByText('已排队，等待当前员工', { exact: true }).waitFor();
      const sent = generates(f.state);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toMatchObject({
        operation: 'article',
        articleId: id(20),
        expectedRevision: 1,
        instructions: failed.invocation.intent.instructions,
        references: [pin],
        sessionId: failed.sessionId,
      });
      expect(sent[0]!.body!.requestId).not.toBe(
        failed.invocation.intent.requestId,
      );
      expect(sent[0]!.body).not.toHaveProperty('deliveryMode');
      await f.close();
    },
  );

  it('terminal retry replays one accepted request after a lost receipt, while a newly failed successor can start its own retry', async () => {
    const original = recovery('article', 'failed');
    original.invocation.intent.instructions = '原始修改意见';
    original.invocation.intent.references = [
      { origin: 'upload', file: { objectId: id(90), checksum } },
    ];
    const f = await fixture({
      runs: [original],
      loseGenerateResponseOnce: true,
    });
    await f.open();
    await f.page.getByRole('tab', { name: '文章库', exact: true }).click();
    await f.page.getByRole('button', { name: '重试', exact: true }).click();
    await f.page.getByText('生成已受理但回执丢失', { exact: false }).waitFor();
    expect(f.state.runs).toHaveLength(2); // Server already accepted this new Run.
    await f.page.getByRole('button', { name: '重试', exact: true }).click();
    await f.page.getByText('已排队，等待当前员工', { exact: true }).waitFor();
    const attempts = generates(f.state);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.body).toEqual(attempts[0]!.body);
    expect(attempts[1]!.body).toMatchObject({
      articleId: id(20),
      expectedRevision: 1,
      instructions: original.invocation.intent.instructions,
      references: original.invocation.intent.references,
    });
    expect(f.state.runs).toHaveLength(2);
    const successor = f.state.runs[0]!;
    successor.run = runSnapshot(Number(successor.run.id.slice(-12)), 'failed');
    await f.page.getByRole('button', { name: '← 回到对话' }).click();
    await f.open();
    await f.page.getByRole('tab', { name: '文章库', exact: true }).click();
    await f.page.getByRole('button', { name: '重试', exact: true }).click();
    await f.page.getByText('已排队，等待当前员工', { exact: true }).waitFor();
    expect(generates(f.state)).toHaveLength(3);
    expect(generates(f.state)[2]!.body!.requestId).not.toBe(
      attempts[0]!.body!.requestId,
    );
    expect(f.state.runs).toHaveLength(3);
    await f.close();
  });

  it('restores the same frozen retry identity across a full remount when the first request outcome is unknown', async () => {
    const original = recovery('article', 'canceled');
    const f = await fixture({ runs: [original], failGenerateOnce: true });
    await f.open();
    await f.page.getByRole('tab', { name: '文章库', exact: true }).click();
    await f.page.getByRole('button', { name: '重试', exact: true }).click();
    await f.page.getByText('网络中断，请重试', { exact: false }).waitFor();
    await f.page.getByRole('button', { name: '← 回到对话' }).click();
    await f.open();
    await f.page.getByRole('tab', { name: '文章库', exact: true }).click();
    await f.page.getByRole('button', { name: '重试', exact: true }).click();
    await f.page.getByText('已排队，等待当前员工', { exact: true }).waitFor();
    const attempts = generates(f.state);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.body).toEqual(attempts[0]!.body);
    expect(attempts[1]!.body!.requestId).not.toBe(
      original.invocation.intent.requestId,
    );
    expect(f.state.runs).toHaveLength(2);
    await f.close();
  });

  it('applies legal topics, articles and calendar even when recovery reading fails, and preserves cancel for an unavailable historical target', async () => {
    const missing = recovery('article', 'queued');
    missing.invocation.intent.articleId = id(777);
    missing.unavailable = true;
    const scheduled = article();
    scheduled.publication = {
      state: 'scheduled',
      schedule: { plannedAt: '2026-11-20T08:00:00.000Z', timezone: 'UTC' },
      links: null,
    };
    const f = await fixture({
      failAllRecovery: true,
      articles: [scheduled],
      runs: [missing],
    });
    await f.open();
    await f.page.getByText('恢复读取暂时失败', { exact: false }).waitFor();
    await f.page
      .getByRole('button', { name: '文章 20', exact: true })
      .waitFor();
    await topicsPage(f.page);
    await f.page.getByText('1 个选题', { exact: true }).waitFor();
    await f.page.getByRole('tab', { name: '文章库', exact: true }).click();
    await f.page
      .getByRole('heading', { name: '文章 20', exact: true })
      .waitFor();
    f.state.failAllRecovery = false;
    await f.page.getByRole('button', { name: '刷新', exact: true }).click();
    await f.page
      .getByText(
        '这次生成的文章或参考资料已不可用。已保存的成果可在交付成果中核对。',
      )
      .waitFor();
    await f.page.getByRole('button', { name: '取消', exact: true }).click();
    await f.page.getByText('已取消生成', { exact: true }).waitFor();
    expect(
      f.state.requests.some((req) => req.path.includes(id(300) + '/cancel')),
    ).toBe(true);
    expect(
      await f.page.getByRole('button', { name: '重试', exact: true }).count(),
    ).toBe(0);
    await f.close();
  });

  it('uncertain HTTP retry keeps its request ID, native active Run disables regeneration, cancel and terminal retry use actual Run facts', async () => {
    const f = await fixture({ failGenerateOnce: true });
    const { page } = f;
    await f.open();
    await candidatesPage(page);
    await page
      .getByLabel('内容方向', { exact: true })
      .fill('给通勤上班族想几个新品选题');
    const action = page.getByRole('button', {
      name: '出选题',
      exact: true,
    });
    await action.click();
    await page.getByText('网络中断，请重试', { exact: true }).waitFor();
    await action.click();
    await page.getByText('已排队，等待当前员工', { exact: true }).waitFor();
    expect(generates(f.state)).toHaveLength(2);
    expect(generates(f.state)[1]!.body!.requestId).toBe(
      generates(f.state)[0]!.body!.requestId,
    );
    expect(await action.isDisabled()).toBe(true);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByText('已取消生成', { exact: true }).waitFor();
    expect(await action.isEnabled()).toBe(true);
    await action.click();
    await expect.poll(() => generates(f.state).length).toBe(3);
    expect(generates(f.state)[2]!.body!.requestId).not.toBe(
      generates(f.state)[1]!.body!.requestId,
    );
    expect(generates(f.state)[2]!.body).toMatchObject({
      operation: 'candidates',
      direction: '给通勤上班族想几个新品选题',
      sessionId: id(6),
    });
    expect(generates(f.state)[2]!.body).not.toHaveProperty('deliveryMode');
    await f.close();
  });

  it('uses the new native Run receipt to keep generation disabled and cancellable when recovery reading fails', async () => {
    const f = await fixture({ failRecoveryAfterGenerate: true }),
      { page } = f;
    await f.open();
    await candidatesPage(page);
    await page
      .getByLabel('内容方向', { exact: true })
      .fill('面向上班族的新品选题');
    const action = page.getByRole('button', {
      name: '出选题',
      exact: true,
    });
    await action.click();
    await page.getByText('已排队，等待当前员工', { exact: true }).waitFor();
    await page.getByText('恢复读取暂时失败', { exact: false }).waitFor();
    expect(await action.isDisabled()).toBe(true);
    expect(
      await page.getByRole('button', { name: '取消', exact: true }).isVisible(),
    ).toBe(true);
    expect(generates(f.state)).toHaveLength(1);
    f.state.failRecoveryAfterGenerate = false;
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByText('已取消生成', { exact: true }).waitFor();
    expect(await action.isEnabled()).toBe(true);
    await f.close();
  });

  it('start writing accepts empty optional requirements and editing stays inline below a read-only body', async () => {
    const f = await fixture();
    const { page } = f;
    await f.open();
    await topicsPage(page);
    await page.getByRole('button', { name: '写正文', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '写正文' });
    await modal.waitFor();
    expect(await modal.getByLabel('补充写作要求（可选）').inputValue()).toBe(
      '',
    );
    expect(
      await modal
        .getByRole('button', { name: '开始写', exact: true })
        .isEnabled(),
    ).toBe(true);
    await modal.getByRole('button', { name: '开始写', exact: true }).click();
    await expect.poll(() => generates(f.state).length).toBe(1);
    const start = f.state.requests.find(
      (req) => req.body?.operation === 'article.start',
    )!.body!;
    expect(start.requirements).toBe('');
    expect(generates(f.state)[0]!.body).toMatchObject({
      operation: 'article',
      articleId: id(21),
      expectedRevision: 1,
    });
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await page.getByRole('button', { name: '文章 20', exact: true }).click();
    const body = page.getByLabel('文章正文');
    await expect.poll(() => body.textContent()).toContain('不可直接改写的正文');
    expect(
      await body.locator('textarea,input,[contenteditable=true]').count(),
    ).toBe(0);
    expect(await page.getByLabel('修改意见').isVisible()).toBe(true);
    expect(
      await page
        .getByRole('button', { name: '修改', exact: true })
        .isDisabled(),
    ).toBe(true);
    await page.getByLabel('修改意见').fill('缩短第二段');
    await page.getByRole('button', { name: '修改', exact: true }).click();
    await expect.poll(() => generates(f.state).length).toBe(2);
    expect(generates(f.state)[1]!.body).toMatchObject({
      operation: 'article',
      articleId: id(20),
      expectedRevision: 1,
      instructions: '缩短第二段',
    });
    expect(
      f.state.requests.some((req) => req.body?.operation === 'article.submit'),
    ).toBe(false);
    await f.close();
  });

  it('enterprise search and cursor use exact selection pins, preserve multiselect and scope labels', async () => {
    const f = await fixture();
    const { page } = f;
    await f.open();
    await candidatesPage(page);
    await page
      .getByRole('button', { name: '添加参考资料', exact: true })
      .click();
    const modal = page.getByRole('dialog', { name: '添加参考资料' });
    await modal.waitFor();
    await modal
      .getByRole('checkbox', { name: '品牌介绍.txt · v2', exact: true })
      .check();
    expect(await modal.getByText('全公司', { exact: true }).isVisible()).toBe(
      true,
    );
    await modal.getByRole('button', { name: '加载更多资料' }).click();
    await modal
      .getByRole('checkbox', { name: '客户问题.txt · v2', exact: true })
      .check();
    await modal.getByRole('button', { name: '添加 2 份' }).click();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await page
      .getByLabel('已选参考资料', { exact: true })
      .getByText('品牌介绍.txt', { exact: true })
      .waitFor();
    await page
      .getByLabel('已选参考资料', { exact: true })
      .getByText('客户问题.txt', { exact: true })
      .waitFor();
    const selected = f.state.requests.filter((req) =>
      req.path.includes('/selection'),
    );
    expect(selected).toHaveLength(4);
    await page
      .getByRole('button', { name: '添加参考资料', exact: true })
      .click();
    await modal.getByLabel('搜索企业资料').fill('客户');
    await expect.poll(() => modal.getByRole('checkbox').count()).toBe(1);
    expect(
      await modal
        .getByRole('checkbox', { name: '客户问题.txt · v2', exact: true })
        .isChecked(),
    ).toBe(true);
    await modal.getByRole('button', { name: '添加 2 份' }).click();
    await page
      .getByLabel('内容方向', { exact: true })
      .fill('把两个企业资料结合起来');
    await page.getByRole('button', { name: '出选题', exact: true }).click();
    await expect.poll(() => generates(f.state).length).toBe(1);
    expect(generates(f.state)[0]!.body!.references).toEqual(
      refs.map((row) => ({
        origin: 'reference',
        sourceId: row.sourceId,
        revisionId: row.revisionId,
      })),
    );
    expect(
      f.state.requests.some(
        (req) =>
          req.path.includes('cursor=') &&
          req.path.startsWith('/api/v1/references/publications'),
      ),
    ).toBe(true);
    await f.close();
  });

  it('a cold article reopens exact reference filenames without changing frozen pins or starting a Run', async () => {
    const stored = article();
    stored.references = [
      {
        origin: 'reference',
        sourceId: refs[0]!.sourceId,
        revisionId: refs[0]!.revisionId,
      },
      { origin: 'upload', file: { objectId: id(90), checksum } },
    ];
    const f = await fixture({ articles: [stored] });
    try {
      for (let visit = 0; visit < 2; visit++) {
        await f.open();
        await f.page.getByRole('tab', { name: '文章库', exact: true }).click();
        const chips = f.page.getByLabel('已选参考资料');
        await chips.getByText('品牌介绍.txt', { exact: true }).waitFor();
        await chips.getByText('品牌参考.jpg', { exact: true }).waitFor();
        expect(await chips.textContent()).not.toContain(id(90));
        await f.page.getByRole('button', { name: '← 回到对话' }).click();
      }
      expect(f.state.articles[0]!.references).toEqual(stored.references);
      expect(f.state.requests.filter((r) => r.method === 'POST')).toHaveLength(
        0,
      );
      expect(
        f.state.requests.filter((r) =>
          r.path.includes(`/revisions/${refs[0]!.revisionId}/selection`),
        ),
      ).toHaveLength(2);
      expect(
        f.state.requests.filter((r) =>
          r.path.includes(`view=deliverables&objectId=${id(90)}`),
        ),
      ).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  it.each(['denied', 'mismatched-pin'] as const)(
    'unavailable reference metadata (%s) never substitutes another filename or mutates the article',
    async (reason) => {
      const stored = article();
      stored.references = [
        {
          origin: 'reference',
          sourceId: refs[0]!.sourceId,
          revisionId: refs[0]!.revisionId,
        },
      ];
      const f = await fixture({ articles: [stored] });
      try {
        await f.page.route('**/references/revisions/*/selection?*', (route) =>
          route.fulfill({
            status: reason === 'denied' ? 403 : 200,
            contentType: 'application/json',
            body: JSON.stringify(
              reason === 'denied'
                ? { message: '无权读取' }
                : {
                    viewerId: scope.ownerId,
                    workspaceId: scope.workspaceId,
                    selection: {
                      sourceId: refs[1]!.sourceId,
                      revisionId: refs[1]!.revisionId,
                      revision: 2,
                      fileName: '不属于该冻结版本.txt',
                      purpose: '',
                      digest: checksum,
                      checksum,
                      ownership: refs[1]!.ownership,
                    },
                  },
            ),
          }),
        );
        await f.open();
        await f.page.getByRole('tab', { name: '文章库', exact: true }).click();
        const chips = f.page.getByLabel('已选参考资料');
        await chips.getByText('资料暂不可读', { exact: true }).waitFor();
        expect(await chips.textContent()).not.toContain('不属于该冻结版本.txt');
        expect(f.state.articles[0]!.references).toEqual(stored.references);
        expect(
          f.state.requests.filter((r) => r.method === 'POST'),
        ).toHaveLength(0);
      } finally {
        await f.close();
      }
    },
  );

  it('upload saves a JPG in private deliverables and nominates its upload pin without publishing or creating an index', async () => {
    const f = await fixture();
    const { page } = f;
    await f.open();
    await candidatesPage(page);
    await page
      .getByRole('button', { name: '添加参考资料', exact: true })
      .click();
    const modal = page.getByRole('dialog', { name: '添加参考资料' });
    await modal.getByRole('tab', { name: '上传文件', exact: true }).click();
    await modal.getByLabel('上传参考文件').setInputFiles({
      name: '品牌参考.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([255, 216, 255, 217]),
    });
    await modal.getByRole('button', { name: '上传并添加' }).click();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await page
      .getByLabel('内容方向', { exact: true })
      .fill('参考这张产品照片想选题');
    await page.getByRole('button', { name: '出选题', exact: true }).click();
    await expect.poll(() => generates(f.state).length).toBe(1);
    expect(generates(f.state)[0]!.body!.references).toEqual([
      { origin: 'upload', file: { objectId: id(90), checksum } },
    ]);
    const upload = f.state.requests.find(
      (req) =>
        req.method === 'POST' && req.path.startsWith('/api/v1/workbench/files'),
    )!;
    expect(upload.body).toMatchObject({
      fileName: '品牌参考.jpg',
      mediaType: 'image/jpeg',
      workspaceId: scope.workspaceId,
    });
    expect(
      f.state.requests.some(
        (req) =>
          req.method === 'POST' && req.path.startsWith('/api/v1/references'),
      ),
    ).toBe(false);
    expect(
      f.state.requests.some((req) => req.path.includes('/reference?')),
    ).toBe(false);
    await f.close();
  });

  it.each(['user-navigation', 'external-navigation'] as const)(
    'closing with a candidate reference Modal releases its focus layer and keeps the original conversation through %s',
    async (navigation) => {
      const f = await fixture();
      const { page } = f;
      await f.open();
      await candidatesPage(page);
      await page
        .getByRole('button', { name: '添加参考资料', exact: true })
        .click();
      await page.getByRole('dialog', { name: '添加参考资料' }).waitFor();
      expect(
        await page.locator('[data-brand-media-host]').getAttribute('data-open'),
      ).toBe('true');
      if (navigation === 'user-navigation') {
        await page.keyboard.press('Escape');
        await page
          .getByRole('dialog', { name: '添加参考资料' })
          .waitFor({ state: 'detached' });
        await page
          .getByRole('button', { name: 'Rice 员工', exact: true })
          .click();
      } else {
        await page.evaluate(() =>
          window.dispatchEvent(new Event('fixture-employee-navigation')),
        );
      }
      await expect
        .poll(() =>
          page.locator('[data-brand-media-host]').getAttribute('data-open'),
        )
        .toBe('false');
      await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
      await expect
        .poll(() =>
          page
            .getByLabel('聊天草稿')
            .evaluate((el) => document.activeElement === el),
        )
        .toBe(true);
      await page.keyboard.press('Escape');
      expect(await page.getByLabel('聊天草稿').inputValue()).toBe(
        '未发送的聊天草稿',
      );
      await f.close();
    },
  );

  it('a completed A addition cannot close B picker or clear its in-flight request after the catalog await', async () => {
    const f = await fixture({ installed: new Set() }),
      { page } = f;
    let releaseA = () => {},
      releaseB = () => {},
      heldA = false;
    const catalog = new Promise<void>((done) => {
      releaseA = done;
    });
    const postB = new Promise<void>((done) => {
      releaseB = done;
    });
    let bRequest: Record<string, unknown> | undefined;
    await page.route(
      (url) => url.pathname.endsWith('/modules'),
      async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        if (
          request.method() === 'GET' &&
          path.includes(scope.instanceId) &&
          f.state.installed.has(scope.instanceId)
        ) {
          heldA = true;
          await catalog;
        }
        if (request.method() === 'POST' && path.includes(id(5))) {
          bRequest = request.postDataJSON();
          await postB;
        }
        await route.fallback();
      },
    );
    try {
      await page.getByRole('button', { name: '添加插件', exact: true }).click();
      await page
        .getByRole('checkbox', { name: '品牌自媒体', exact: true })
        .check();
      await page.getByRole('button', { name: '添加', exact: true }).click();
      await expect.poll(() => heldA).toBe(true);
      expect(f.state.installed.has(scope.instanceId)).toBe(true);
      await page.getByRole('button', { name: '另一个员工' }).click();
      await page.getByRole('button', { name: '添加插件', exact: true }).click();
      await page
        .getByRole('checkbox', { name: '品牌自媒体', exact: true })
        .check();
      await page.getByRole('button', { name: '添加', exact: true }).click();
      await expect.poll(() => !!bRequest).toBe(true);
      const pending = structuredClone(bRequest);
      const aResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname.includes(scope.instanceId) &&
          new URL(response.url()).pathname.endsWith('/modules'),
      );
      releaseA();
      await (await aResponse).finished();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      expect(
        await page
          .getByRole('region', { name: '选择插件', exact: true })
          .count(),
      ).toBe(1);
      expect(
        await page
          .getByRole('button', { name: '添加', exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(bRequest).toEqual(pending);
      releaseB();
      await page
        .getByRole('button', { name: '打开 品牌自媒体', exact: true })
        .waitFor();
      const adds = f.state.requests.filter(
        (request) =>
          request.method === 'POST' && request.path.endsWith('/modules'),
      );
      expect(adds).toHaveLength(2);
      expect(adds[1]!.body).toEqual(pending);
    } finally {
      releaseA();
      releaseB();
      await f.close();
    }
  });

  it.each([false, true])(
    'online recovers the exact active brand Run after seven exhausted connections (old refresh held=%s)',
    async (holdOld) => {
      const f = await fixture(),
        { page } = f;
      f.state.runs = [recovery('candidates', 'running')];
      let attempts = 0,
        finished = 0,
        reads = 0,
        exhaustedRead = false;
      let heldRequest: Request | undefined;
      let oldFinished = false;
      let first = () => {},
        terminal = () => {},
        old = () => {};
      const firstGate = new Promise<void>((done) => {
        first = done;
      });
      const terminalGate = new Promise<void>((done) => {
        terminal = done;
      });
      const oldGate = new Promise<void>((done) => {
        old = done;
      });
      const events = (url: URL) =>
        url.pathname === `/api/v1/runs/${id(300)}/events`;
      page.on('requestfinished', (request) => {
        if (events(new URL(request.url()))) finished++;
        if (request === heldRequest) oldFinished = true;
      });
      await page.route(events, async (route) => {
        attempts++;
        expect(
          new URL(route.request().url()).searchParams.get('workspaceId'),
        ).toBe(scope.workspaceId);
        if (attempts === 1) await firstGate;
        if (attempts === 8) await terminalGate;
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body:
            attempts < 8
              ? ''
              : `data: ${JSON.stringify({ schemaVersion: 3, eventId: id(999), organizationId: scope.organizationId, workspaceId: scope.workspaceId, conversationId: id(6), runId: id(300), generation: 1, cursor: 'brand:1', sequence: 1, harness: 'dsh', occurredAt: stamp, sourceEvent: null, type: 'run.succeeded', payload: {} })}\n\n`,
        });
      });
      await page.route(
        (url) =>
          url.pathname.endsWith('/brand-media') &&
          url.searchParams.get('view') === 'runs',
        async (route) => {
          reads++;
          const snapshot = structuredClone(f.state.runs);
          if (attempts === 7 && !exhaustedRead) {
            exhaustedRead = true;
            heldRequest = route.request();
            if (holdOld) await oldGate;
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ runs: snapshot }),
          });
        },
      );
      try {
        await f.open();
        await page.clock.install();
        first();
        for (let index = 0; index < 7; index++) {
          await expect.poll(() => attempts).toBe(index + 1);
          await expect.poll(() => finished).toBe(index + 1);
          await page.clock.runFor(3000);
        }
        await expect.poll(() => exhaustedRead).toBe(true);
        await page.clock.runFor(30000);
        expect(attempts).toBe(7);
        const before = reads;
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await expect.poll(() => attempts).toBe(8);
        await expect.poll(() => reads).toBeGreaterThan(before);
        expect(f.state.runs[0]!.run.status).toBe('running');
        if (holdOld) expect(oldFinished).toBe(false);
        await page.clock.resume();
        await candidatesPage(page);
        await page.getByLabel('内容方向', { exact: true }).fill('面向通勤族');
        expect(
          await page
            .getByRole('button', {
              name: '出选题',
              exact: true,
            })
            .isDisabled(),
        ).toBe(true);
        expect(
          await page
            .getByRole('button', { name: '取消', exact: true })
            .isVisible(),
        ).toBe(true);
        f.state.runs = [recovery('candidates')];
        terminal();
        await page.getByText('本次生成已完成', { exact: true }).waitFor();
        await page
          .getByRole('heading', { name: '十分钟的新品体验', exact: true })
          .waitFor();
        old();
        await expect.poll(() => oldFinished).toBe(true);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        expect(
          await page
            .getByRole('button', {
              name: '出选题',
              exact: true,
            })
            .isEnabled(),
        ).toBe(true);
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await page.evaluate(() => new Promise(requestAnimationFrame));
        expect(attempts).toBe(8);
      } finally {
        first();
        terminal();
        old();
        await f.close();
      }
    },
  );

  it.each(['snapshot', 'failure'] as const)(
    'a late detail %s cannot reverse a newer reload or command receipt, its body pin or the next CAS',
    async (outcome) => {
      const f = await fixture(),
        { page } = f;
      let release = () => {},
        held = false;
      let heldRequest: Request | undefined,
        completedRevision = 0;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.route(
        (url) =>
          url.pathname.endsWith('/brand-media') &&
          url.searchParams.get('view') === 'article',
        async (route) => {
          const snapshot = structuredClone(f.state.articles[0]);
          const first = !held;
          if (first) {
            held = true;
            heldRequest = route.request();
            await gate;
          }
          await route.fulfill({
            status: first && outcome === 'failure' ? 503 : 200,
            contentType: 'application/json',
            body: JSON.stringify(
              first && outcome === 'failure'
                ? { message: '过期详情读取失败' }
                : { view: 'article', article: snapshot },
            ),
          });
          if (!first)
            completedRevision = Math.max(completedRevision, snapshot!.revision);
        },
      );
      await page.route(
        (url) => url.pathname === `/api/v1/files/${id(82)}/download`,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/plain',
            body: 'N+1的原始正文',
          }),
      );
      try {
        await f.open();
        await expect.poll(() => held).toBe(true);
        f.state.articles[0] = {
          ...article(),
          revision: 2,
          title: '更新后的文章N+1',
          body: { objectId: id(82), versionId: id(83), checksum },
        };
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await page.getByRole('tab', { name: '文章库', exact: true }).click();
        await page
          .getByRole('heading', { name: '更新后的文章N+1', exact: true })
          .waitFor();
        await expect
          .poll(() => page.getByLabel('文章正文').textContent())
          .toBe('N+1的原始正文');
        await page
          .getByRole('button', { name: '添加参考资料', exact: true })
          .click();
        const modal = page.getByRole('dialog', {
          name: '添加参考资料',
          exact: true,
        });
        await modal
          .getByRole('checkbox', { name: '品牌介绍.txt · v2', exact: true })
          .check();
        await modal
          .getByRole('button', { name: '添加 1 份', exact: true })
          .click();
        await page
          .getByLabel('已选参考资料', { exact: true })
          .getByText('品牌介绍.txt', { exact: true })
          .waitFor();
        expect(f.state.articles[0]!.revision).toBe(3);
        await expect.poll(() => completedRevision).toBe(3);
        const oldResponse = page.waitForResponse(
          (response) => response.request() === heldRequest,
        );
        release();
        await (await oldResponse).finished();
        await page.evaluate(() => new Promise(requestAnimationFrame));
        expect(
          await page.getByText('过期详情读取失败', { exact: true }).count(),
        ).toBe(0);
        expect(
          await page
            .getByRole('heading', { name: '更新后的文章N+1', exact: true })
            .isVisible(),
        ).toBe(true);
        expect(
          await page
            .getByLabel('已选参考资料', { exact: true })
            .getByText('品牌介绍.txt', { exact: true })
            .isVisible(),
        ).toBe(true);
        await page
          .getByRole('button', { name: '复制正文', exact: true })
          .click();
        await page.getByText('正文已复制', { exact: true }).waitFor();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          'N+1的原始正文',
        );
        await page
          .getByLabel('修改意见', { exact: true })
          .fill('保留最新正文，补充结尾');
        await page.getByRole('button', { name: '修改', exact: true }).click();
        await expect.poll(() => generates(f.state).length).toBe(1);
        expect(generates(f.state)[0]!.body!.expectedRevision).toBe(3);
        expect(f.state.articles[0]!.body).toEqual({
          objectId: id(82),
          versionId: id(83),
          checksum,
        });
      } finally {
        release();
        await f.close();
      }
    },
  );

  it('a calendar article beyond the first page stays selected after filter reset and Run refresh; conflicts report retained delivery facts', async () => {
    const old = article(99),
      receipt = recovery('article');
    const month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date());
    old.publication = {
      state: 'scheduled',
      schedule: {
        plannedAt: month + '-16T08:00:00.000Z',
        timezone: 'Asia/Shanghai',
      },
      links: null,
    };
    receipt.invocation.intent.articleId = old.id;
    receipt.submission = { articleUpdated: false, revision: null };
    const f = await fixture({
      articles: [article(), old],
      moreArticles: true,
      runs: [receipt],
    });
    const { page } = f;
    await f.open();
    await page.getByRole('tab', { name: '文章库', exact: true }).click();
    await page.getByRole('button', { name: '草稿', exact: true }).click();
    await page.getByRole('tab', { name: '排期表', exact: true }).click();
    await page
      .getByRole('button', { name: '月历里的旧文章', exact: true })
      .click();
    await page
      .getByRole('heading', { name: '月历里的旧文章', exact: true })
      .waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    expect(
      await page
        .getByRole('heading', { name: '月历里的旧文章', exact: true })
        .isVisible(),
    ).toBe(true);
    expect(
      await page
        .getByText('本次正文成果已保留，文章未更新，请核对当前文章。', {
          exact: true,
        })
        .isVisible(),
    ).toBe(true);
    await expect
      .poll(() => page.getByLabel('文章正文').textContent())
      .toBe('不可直接改写的正文\n第二段');
    const url = new URL(
      `/api/v1/files/${file.objectId}/download?workspaceId=${scope.workspaceId}`,
      page.url(),
    ).href;
    const requested = page.waitForRequest((request) => request.url() === url);
    const response = page.waitForResponse((reply) => reply.url() === url);
    await page.evaluate(() => {
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        if (this.download)
          document.body.dataset.requestedAttachmentName = this.download;
        click.call(this);
      };
    });
    const delivered = page.waitForEvent('download');
    const action = page.getByRole('button', {
      name: '查看本次正文成果',
      exact: true,
    });
    await action.focus();
    expect(
      await action.evaluate((element) => document.activeElement === element),
    ).toBe(true);
    await page.keyboard.press('Enter');
    expect((await requested).method()).toBe('GET');
    expect((await response).headers()).toMatchObject({
      'content-type': 'text/plain',
      'content-disposition': "attachment; filename*=UTF-8''allrice-export",
    });
    const download = await delivered;
    expect(
      await page.locator('body').getAttribute('data-requested-attachment-name'),
    ).toBe('allrice-export');
    expect(download.suggestedFilename()).toBe('allrice-export');
    expect(await readFile((await download.path())!, 'utf8')).toBe(
      '不可直接改写的正文\n第二段',
    );
    expect(
      await page
        .getByRole('button', { name: '改时间', exact: true })
        .isVisible(),
    ).toBe(true);
    await f.close();
  });
  it.each([403, 404])(
    'a refused article delivery (%i) evicts only its pin and clears on its own successful read',
    async (status) => {
      const newFile = {
        objectId: id(82),
        versionId: id(83),
        checksum: 'sha256:' + 'b'.repeat(64),
      };
      const stored = { ...article(), body: newFile };
      const run = recovery('article');
      const original = run.deliveries[0]!;
      const current = { ...original, file: newFile };
      run.deliveries = [original, current];
      const f = await fixture({ articles: [stored], runs: [run] });
      const { page } = f;
      const path = `/api/v1/files/${original.file.objectId}/download`;
      const contents = page.getByLabel('文章正文');
      const deliveries = panel(page).getByRole('button', {
        name: '查看本次正文成果',
        exact: true,
      });
      const warning = panel(page)
        .getByRole('alert')
        .filter({ hasText: '正文文件暂时不可读' });
      let saves = 0;
      let refused = true;
      page.on('download', () => saves++);
      try {
        await f.open();
        await panel(page)
          .getByRole('tab', { name: '文章库', exact: true })
          .click();
        await expect
          .poll(() => contents.textContent())
          .toContain('不可直接改写的正文');
        await expect.poll(() => deliveries.count()).toBe(2);
        await page.route(
          (url) => url.pathname === path,
          (route) =>
            refused
              ? route.fulfill({
                  status,
                  json: accessProblem(
                    '该正文文件已不可读取',
                    status === 403
                      ? 'AUTHORIZATION_DENIED'
                      : 'RESOURCE_NOT_FOUND',
                  ),
                })
              : route.fallback(),
        );
        await deliveries.first().press('Enter');
        await warning.waitFor();
        expect(await deliveries.count()).toBe(1);
        expect(await contents.textContent()).toContain('不可直接改写的正文');
        expect(saves).toBe(0);

        refused = false;
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await expect.poll(() => deliveries.count()).toBe(2);
        expect(await warning.isVisible()).toBe(true);
        const saved = page.waitForEvent('download');
        await deliveries.first().press('Enter');
        expect((await saved).suggestedFilename()).toBe('allrice-export');
        await warning.waitFor({ state: 'hidden' });
        expect(saves).toBe(1);
      } finally {
        await f.close();
      }
    },
  );

  it('fences a pending download after a later refusal for the same body pin', async () => {
    const f = await fixture({ runs: [recovery('article')] });
    const { page } = f;
    const path = `/api/v1/files/${file.objectId}/download`;
    const contents = page.getByLabel('文章正文');
    const deliveries = panel(page).getByRole('button', {
      name: '查看本次正文成果',
      exact: true,
    });
    const expected = '不可直接改写的正文\n第二段';
    let fileRequests = 0;
    let deny = true;
    try {
      await f.open();
      await panel(page).getByRole('tab', { name: '文章库' }).click();
      await expect.poll(() => contents.textContent()).toBe(expected);
      await holdBodyDelivery(page, path);
      await page.route(
        (url) => url.pathname === path,
        async (route) => {
          if (++fileRequests === 1 || !deny) return route.fallback();
          return route.fulfill({
            status: 403,
            json: accessProblem('该文件已撤销当前读取授权'),
          });
        },
      );
      await deliveries.press('Enter');
      await page.locator('body[data-delivery-headers="200"]').waitFor();
      await panel(page).getByRole('button', { name: '复制正文' }).click();
      await panel(page)
        .getByRole('alert')
        .filter({ hasText: '正文文件暂时不可读' })
        .waitFor();
      expect(await deliveries.count()).toBe(0);
      expect(await contents.count()).toBe(0);
      expect(fileRequests).toBe(2);

      await page.evaluate(() =>
        window.dispatchEvent(new Event('finish-body-delivery')),
      );
      await page
        .locator(`body[data-delivery-bytes="${Buffer.byteLength(expected)}"]`)
        .waitFor();
      expect(
        await page.locator('body').getAttribute('data-delivery-save'),
      ).toBeNull();

      deny = false;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect.poll(() => contents.textContent()).toBe(expected);
      const saved = page.waitForEvent('download');
      await deliveries.press('Enter');
      const download = await saved;
      expect(download.suggestedFilename()).toBe('allrice-export');
      expect(await readFile((await download.path())!, 'utf8')).toBe(expected);
    } finally {
      await page.evaluate(() =>
        window.dispatchEvent(new Event('finish-body-delivery')),
      );
      await f.close();
    }
  });

  it.each(['unavailable', 'empty'] as const)(
    'keeps independent delivery buttons after the current pin is refused and honors a fresh %s Run read',
    async (outcome) => {
      const run = recovery('article');
      const sibling = { ...file, objectId: id(82), versionId: id(83) };
      run.deliveries.push({ ...run.deliveries[0]!, file: sibling });
      const f = await fixture({ runs: [run] });
      const { page } = f;
      const topicsStarted = gate();
      const finishTopics = gate();
      const deliveries = panel(page).getByRole('button', {
        name: '查看本次正文成果',
        exact: true,
      });
      const contents = page.getByLabel('文章正文');
      try {
        await f.open();
        await panel(page).getByRole('tab', { name: '文章库' }).click();
        await expect
          .poll(() => contents.textContent())
          .toContain('不可直接改写的正文');
        await expect.poll(() => deliveries.count()).toBe(2);
        await page.route(
          (url) => url.pathname === `/api/v1/files/${file.objectId}/download`,
          (route) => route.fulfill({ status: 404, body: '' }),
        );
        await deliveries.first().press('Enter');
        await panel(page)
          .getByRole('alert')
          .filter({ hasText: '正文文件暂时不可读' })
          .waitFor();
        expect(await contents.count()).toBe(0);
        expect(
          await panel(page).getByText('文章 20', { exact: true }).count(),
        ).toBe(0);
        expect(await deliveries.count()).toBe(1);
        const request = page.waitForRequest(
          (req) =>
            new URL(req.url()).pathname ===
            `/api/v1/files/${sibling.objectId}/download`,
        );
        const saved = page.waitForEvent('download');
        await deliveries.press('Enter');
        expect((await request).method()).toBe('GET');
        expect((await saved).suggestedFilename()).toBe('allrice-export');

        f.state.articles[0] = { ...article(), revision: 2, body: null };
        f.state.runs =
          outcome === 'empty'
            ? []
            : [{ ...run, unavailable: true, deliveries: [] }];
        await page.route(
          (url) => brandView(url, 'topics'),
          async (route) => {
            topicsStarted.resolve();
            await finishTopics.promise;
            return route.fallback();
          },
        );
        const reread = page.waitForResponse((response) =>
          brandView(new URL(response.url()), 'runs'),
        );
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await topicsStarted.promise;
        expect(await (await reread).json()).toEqual({ runs: f.state.runs });
        await expect.poll(() => deliveries.count()).toBe(0);
        finishTopics.resolve();
        await expect.poll(() => contents.textContent()).toBe('正文还未生成');
        expect(await deliveries.count()).toBe(0);
      } finally {
        finishTopics.resolve();
        await f.close();
      }
    },
  );

  it.each(['unavailable', 'empty', 'authorized'] as const)(
    'checks a fresh %s Run before saving a pending delivery',
    async (outcome) => {
      const run = recovery('article');
      const f = await fixture({ runs: [run] });
      const { page } = f;
      const deliveries = panel(page).getByRole('button', {
        name: '查看本次正文成果',
        exact: true,
      });
      const expected = '不可直接改写的正文\n第二段';
      try {
        await f.open();
        await panel(page).getByRole('tab', { name: '文章库' }).click();
        await expect
          .poll(() => page.getByLabel('文章正文').textContent())
          .toBe(expected);
        await holdBodyDelivery(page, `/api/v1/files/${file.objectId}/download`);
        await deliveries.press('Enter');
        await page.locator('body[data-delivery-headers="200"]').waitFor();

        f.state.runs =
          outcome === 'empty'
            ? []
            : [
                outcome === 'unavailable'
                  ? { ...run, unavailable: true, deliveries: [] }
                  : {
                      ...run,
                      submission: { articleUpdated: true, revision: 2 },
                    },
              ];
        const reread = page.waitForResponse((response) =>
          brandView(new URL(response.url()), 'runs'),
        );
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        expect(await (await reread).json()).toEqual({ runs: f.state.runs });
        const saved =
          outcome === 'authorized' ? page.waitForEvent('download') : null;
        if (saved) {
          await panel(page)
            .getByText('本次正文已保存（版本 2）', { exact: true })
            .waitFor();
        } else {
          await expect.poll(() => deliveries.count()).toBe(0);
        }
        await page.evaluate(() =>
          window.dispatchEvent(new Event('finish-body-delivery')),
        );
        await page
          .locator(`body[data-delivery-bytes="${Buffer.byteLength(expected)}"]`)
          .waitFor();
        if (saved) {
          const download = await saved;
          expect(download.suggestedFilename()).toBe('allrice-export');
          expect(await readFile((await download.path())!, 'utf8')).toBe(
            expected,
          );
        } else {
          expect(
            await page.locator('body').getAttribute('data-delivery-save'),
          ).toBeNull();
        }
      } finally {
        await page.evaluate(() =>
          window.dispatchEvent(new Event('finish-body-delivery')),
        );
        await f.close();
      }
    },
  );

  it.each(['unavailable', 'empty', 'pin removed', 'sibling removed'] as const)(
    'keeps the original download decision after a %s Run projection changes',
    async (outcome) => {
      const run = recovery('article');
      const main = run.deliveries[0]!;
      const sibling = {
        ...main,
        file: { ...file, objectId: id(82), versionId: id(83) },
      };
      run.deliveries.push(sibling);
      const f = await fixture({ runs: [run] });
      const { page } = f;
      const path = `/api/v1/files/${file.objectId}/download`;
      const expected = '不可直接改写的正文\n第二段';
      const deliveries = panel(page).getByRole('button', {
        name: '查看本次正文成果',
        exact: true,
      });
      const continuouslyAllowed = outcome === 'sibling removed';
      const applyRuns = async (runs: Recovery[]) => {
        f.state.runs = runs;
        const response = page.waitForResponse((value) =>
          brandView(new URL(value.url()), 'runs'),
        );
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        expect(await (await response).json()).toEqual({ runs });
      };
      const finishDownload = () =>
        page.evaluate(() =>
          window.dispatchEvent(new Event('finish-body-delivery')),
        );
      try {
        await f.open();
        await panel(page).getByRole('tab', { name: '文章库' }).click();
        await expect
          .poll(() => page.getByLabel('文章正文').textContent())
          .toBe(expected);
        await expect.poll(() => deliveries.count()).toBe(2);
        await holdBodyDelivery(page, path);
        await deliveries.first().press('Enter');
        await page.locator('body[data-delivery-headers="200"]').waitFor();

        const changed = {
          unavailable: [{ ...run, unavailable: true, deliveries: [] }],
          empty: [],
          'pin removed': [{ ...run, deliveries: [sibling] }],
          'sibling removed': [{ ...run, deliveries: [main] }],
        }[outcome];
        await applyRuns(changed);
        await expect
          .poll(() => deliveries.count())
          .toBe(changed[0]?.deliveries.length ?? 0);
        if (!continuouslyAllowed) {
          await applyRuns([run]);
          await expect.poll(() => deliveries.count()).toBe(2);
        }

        let saved = continuouslyAllowed
          ? page.waitForEvent('download')
          : undefined;
        await finishDownload();
        await page
          .locator(`body[data-delivery-bytes="${Buffer.byteLength(expected)}"]`)
          .waitFor();
        if (!saved) {
          expect(
            await page.locator('body').getAttribute('data-delivery-save'),
          ).toBeNull();
          const request = page.waitForRequest(
            (value) => new URL(value.url()).pathname === path,
          );
          saved = page.waitForEvent('download');
          await deliveries.first().press('Enter');
          expect((await request).method()).toBe('GET');
        }
        const download = await saved;
        expect(download.suggestedFilename()).toBe('allrice-export');
        expect(await readFile((await download.path())!, 'utf8')).toBe(expected);
      } finally {
        await finishDownload();
        await f.close();
      }
    },
  );

  it.each(['unavailable', 'forbidden', '503'] as const)(
    'settles an in-flight save when an overlapping Run read returns %s',
    async (outcome) => {
      const run = recovery('article');
      const f = await fixture({ runs: [run] });
      const { page } = f;
      const deliveries = panel(page).getByRole('button', {
        name: '查看本次正文成果',
        exact: true,
      });
      const expected = '不可直接改写的正文\n第二段';
      const olderStarted = gate();
      const releaseOlder = gate();
      const latestStarted = gate();
      const releaseLatest = gate();
      const finishDownload = () =>
        page.evaluate(() =>
          window.dispatchEvent(new Event('finish-body-delivery')),
        );
      let requests = 0;
      try {
        await f.open();
        await panel(page).getByRole('tab', { name: '文章库' }).click();
        await expect
          .poll(() => page.getByLabel('文章正文').textContent())
          .toBe(expected);
        await deliveries.waitFor();
        await observeLateRunRead(page);
        await page.route(
          (url) => brandView(url, 'runs'),
          async (route) => {
            if (++requests !== 1) {
              latestStarted.resolve();
              await releaseLatest.promise;
              return route.fallback();
            }
            olderStarted.resolve();
            await releaseOlder.promise;
            const response = {
              unavailable: {
                status: 200,
                json: { runs: [{ ...run, unavailable: true, deliveries: [] }] },
              },
              forbidden: {
                status: 403,
                json: accessProblem('较早的成果读取已拒绝'),
              },
              503: { status: 503, json: { message: '成果读取暂时不可用' } },
            }[outcome];
            return route.fulfill({
              ...response,
              headers: { 'x-fixture-late-run-read': 'yes' },
            });
          },
        );
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await olderStarted.promise;
        await holdBodyDelivery(page, `/api/v1/files/${file.objectId}/download`);
        await deliveries.press('Enter');
        await page.locator('body[data-delivery-headers="200"]').waitFor();

        f.state.runs = [
          { ...run, submission: { articleUpdated: true, revision: 2 } },
        ];
        const latestStatus = panel(page).getByText('本次正文已保存（版本 2）', {
          exact: true,
        });
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await latestStarted.promise;
        releaseOlder.resolve();
        await page.locator('body[data-late-run-read="settled"]').waitFor();
        if (outcome === 'forbidden') {
          releaseLatest.resolve();
          await latestStatus.waitFor();
        }

        const saved =
          outcome === '503' ? page.waitForEvent('download') : undefined;
        await finishDownload();
        await page
          .locator(`body[data-delivery-bytes="${Buffer.byteLength(expected)}"]`)
          .waitFor();
        if (saved) {
          const download = await saved;
          expect(download.suggestedFilename()).toBe('allrice-export');
          expect(await readFile((await download.path())!, 'utf8')).toBe(
            expected,
          );
        } else {
          expect(
            await page.locator('body').getAttribute('data-delivery-save'),
          ).toBeNull();
        }
        await expect
          .poll(() => deliveries.count())
          .toBe(outcome === 'unavailable' ? 0 : 1);
        releaseLatest.resolve();
        await latestStatus.waitFor();
        expect(await deliveries.count()).toBe(1);
      } finally {
        releaseOlder.resolve();
        releaseLatest.resolve();
        await finishDownload();
        await f.close();
      }
    },
  );

  it.each(['new read', 'new visit'] as const)(
    'preserves a save authorized by a %s when an older Run read returns unavailable',
    async (outcome) => {
      const run = recovery('article');
      const f = await fixture({ runs: [run] });
      const { page } = f;
      const expected = '不可直接改写的正文\n第二段';
      const olderStarted = gate();
      const releaseOlder = gate();
      const deliveries = panel(page).getByRole('button', {
        name: '查看本次正文成果',
        exact: true,
      });
      const finishDownload = () =>
        page.evaluate(() =>
          window.dispatchEvent(new Event('finish-body-delivery')),
        );
      let first = true;
      try {
        await f.open();
        await panel(page).getByRole('tab', { name: '文章库' }).click();
        await deliveries.waitFor();
        if (outcome === 'new visit')
          await finishDespiteAbort(
            page,
            `/api/v1/employee-instances/${scope.instanceId}/brand-media`,
          );
        await observeLateRunRead(page);
        await page.route(
          (url) => brandView(url, 'runs'),
          async (route) => {
            if (!first) return route.fallback();
            first = false;
            olderStarted.resolve();
            await releaseOlder.promise;
            return route.fulfill({
              status: 200,
              headers: { 'x-fixture-late-run-read': 'yes' },
              json: { runs: [{ ...run, unavailable: true, deliveries: [] }] },
            });
          },
        );
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await olderStarted.promise;
        f.state.runs = [
          { ...run, submission: { articleUpdated: true, revision: 2 } },
        ];
        if (outcome === 'new visit') {
          await panel(page).getByRole('button', { name: '← 回到对话' }).click();
          await f.open();
          await panel(page).getByRole('tab', { name: '文章库' }).click();
        } else {
          await page.evaluate(() => window.dispatchEvent(new Event('online')));
        }
        const latestStatus = panel(page).getByText('本次正文已保存（版本 2）', {
          exact: true,
        });
        await latestStatus.waitFor();
        await expect
          .poll(() => page.getByLabel('文章正文').textContent())
          .toBe(expected);
        await holdBodyDelivery(page, `/api/v1/files/${file.objectId}/download`);
        await deliveries.press('Enter');
        await page.locator('body[data-delivery-headers="200"]').waitFor();

        releaseOlder.resolve();
        await page.locator('body[data-late-run-read="settled"]').waitFor();
        expect(await latestStatus.isVisible()).toBe(true);
        expect(await deliveries.count()).toBe(1);
        const saved = page.waitForEvent('download');
        await finishDownload();
        const download = await saved;
        expect(download.suggestedFilename()).toBe('allrice-export');
        expect(await readFile((await download.path())!, 'utf8')).toBe(expected);
      } finally {
        releaseOlder.resolve();
        await finishDownload();
        await f.close();
      }
    },
  );

  it.each(['pending', '503', 'one pin'] as const)(
    'does not request a withdrawn delivery before fresh Run authorization (%s)',
    async (outcome) => {
      const run = recovery('article');
      const target = { ...file, objectId: id(82), versionId: id(83) };
      const sibling = { ...file, objectId: id(85), versionId: id(86) };
      const output = run.deliveries[0]!;
      run.deliveries = [
        { ...output, file: target },
        { ...output, file: sibling },
      ];
      const f = await fixture({ runs: [run] });
      const { page } = f;
      const deliveries = panel(page).getByRole('button', {
        name: '查看本次正文成果',
        exact: true,
      });
      const staleAction = page.locator('[data-fixture-withdrawn-delivery]');
      const path = `/api/v1/files/${target.objectId}/download`;
      const fileRequests = () =>
        page
          .locator('body')
          .getAttribute('data-fixture-target-gets')
          .then(Number);
      const positiveStarted = gate();
      const releasePositive = gate();
      const olderStarted = gate();
      const releaseOlder = gate();
      const latestStarted = gate();
      const releaseLatest = gate();
      const refresh = () =>
        page.evaluate(() => window.dispatchEvent(new Event('online')));
      let holdOlderPositive = outcome === 'pending';
      let reads = 0;
      try {
        await f.open();
        await panel(page).getByRole('tab', { name: '文章库' }).click();
        await expect.poll(() => deliveries.count()).toBe(2);
        await deliveries
          .first()
          .evaluate((button) =>
            button.setAttribute('data-fixture-withdrawn-delivery', ''),
          );
        await observeLateRunRead(page);
        await page.evaluate((path) => {
          const fetch = window.fetch.bind(window);
          document.body.dataset.fixtureTargetGets = '0';
          window.fetch = (input, options) => {
            if (
              typeof input === 'string' &&
              new URL(input, location.href).pathname === path
            ) {
              const body = document.body;
              body.dataset.fixtureTargetGets = String(
                Number(body.dataset.fixtureTargetGets) + 1,
              );
            }
            return fetch(input, options);
          };
        }, path);
        await page.route(
          (url) => brandView(url, 'runs'),
          async (route) => {
            if (holdOlderPositive) {
              holdOlderPositive = false;
              positiveStarted.resolve();
              await releasePositive.promise;
              return route.fulfill({
                status: 200,
                headers: { 'x-fixture-late-run-read': 'yes' },
                json: { runs: [run] },
              });
            }
            if (++reads === 1) {
              olderStarted.resolve();
              await releaseOlder.promise;
              const row =
                outcome === 'one pin'
                  ? { ...run, deliveries: [run.deliveries[1]!] }
                  : { ...run, unavailable: true, deliveries: [] };
              return route.fulfill({
                status: 200,
                headers: { 'x-fixture-late-run-read': 'yes' },
                json: { runs: [row] },
              });
            }
            if (reads === 2) {
              latestStarted.resolve();
              await releaseLatest.promise;
              if (outcome === '503')
                return route.fulfill({
                  status: 503,
                  json: { message: '成果读取暂时不可用' },
                });
            }
            return route.fallback();
          },
        );

        if (outcome === 'pending') {
          await refresh();
          await positiveStarted.promise;
        }
        await refresh();
        await olderStarted.promise;
        await refresh();
        await latestStarted.promise;
        releaseOlder.resolve();
        await page.locator('body[data-late-run-read="settled"]').waitFor();
        if (outcome === 'pending') {
          await page.evaluate(() => {
            delete document.body.dataset.lateRunRead;
          });
          releasePositive.resolve();
          await page.locator('body[data-late-run-read="settled"]').waitFor();
        }
        if (outcome === '503') {
          releaseLatest.resolve();
          await panel(page)
            .getByRole('alert')
            .filter({ hasText: '成果读取暂时不可用' })
            .waitFor();
        }
        expect(await fileRequests()).toBe(0);
        if (await staleAction.isVisible()) {
          const requested = page
            .waitForRequest(
              (request) => new URL(request.url()).pathname === path,
            )
            .catch(() => null);
          await staleAction.press('Enter');
          if (await fileRequests())
            expect((await requested)?.method()).toBe('GET');
        }
        expect(await fileRequests()).toBe(0);
        expect(await deliveries.count()).toBe(outcome === 'one pin' ? 1 : 0);

        if (outcome === 'one pin') {
          const requested = page.waitForRequest(
            (request) =>
              new URL(request.url()).pathname ===
              `/api/v1/files/${sibling.objectId}/download`,
          );
          const saved = page.waitForEvent('download');
          await deliveries.press('Enter');
          expect((await requested).method()).toBe('GET');
          expect((await saved).suggestedFilename()).toBe('allrice-export');
          expect(await fileRequests()).toBe(0);
        }

        if (outcome === '503') await refresh();
        else releaseLatest.resolve();
        await expect.poll(() => deliveries.count()).toBe(2);
        const saved = page.waitForEvent('download');
        await deliveries.first().press('Enter');
        const download = await saved;
        expect(await fileRequests()).toBe(1);
        expect(download.suggestedFilename()).toBe('allrice-export');
        expect(await readFile((await download.path())!, 'utf8')).toBe(
          '不可直接改写的正文\n第二段',
        );
      } finally {
        releasePositive.resolve();
        releaseOlder.resolve();
        releaseLatest.resolve();
        await f.close();
      }
    },
  );

  it('saves an authorized response across a same-Run generation receipt replay', async () => {
    const f = await fixture({ loseGenerateResponseOnce: true });
    const { page } = f;
    const expected = '不可直接改写的正文\n第二段';
    const pin = { ...file, objectId: id(82), versionId: id(83) };
    const path = `/api/v1/files/${pin.objectId}/download`;
    const deliveries = panel(page).getByRole('button', {
      name: '查看本次正文成果',
      exact: true,
    });
    const action = page.getByRole('button', { name: '修改', exact: true });
    const refreshEntered = gate();
    const releaseRefresh = gate();
    const downloads: Download[] = [];
    page.on('download', (download) => downloads.push(download));
    const runResponse = () =>
      page.waitForResponse((response) =>
        brandView(new URL(response.url()), 'runs'),
      );
    const finishDownload = () =>
      page.evaluate(() =>
        window.dispatchEvent(new Event('finish-body-delivery')),
      );

    try {
      await f.open();
      await panel(page).getByRole('tab', { name: '文章库' }).click();
      await expect
        .poll(() => page.getByLabel('文章正文').textContent())
        .toBe(expected);
      await page.getByLabel('修改意见').fill('保留正文并生成一份改稿');
      await action.click();
      await page.getByText('生成已受理但回执丢失', { exact: true }).waitFor();

      const originalRequest = generates(f.state)[0]!.body;
      const row = f.state.runs[0]!;
      const runId = row.run.id;
      row.run = runSnapshot(Number(runId.slice(-12)), 'succeeded');
      row.deliveries = [{ file: pin, format: 'txt', content: expected }];
      row.submission = { articleUpdated: false, revision: null };
      const initial = runResponse();
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      const initialSnapshot = await (await initial).json();
      expect(initialSnapshot).toEqual({ runs: [row] });
      await expect.poll(() => deliveries.count()).toBe(1);

      await holdBodyDelivery(page, path);
      const requested = page.waitForRequest(
        (request) => new URL(request.url()).pathname === path,
      );
      await deliveries.press('Enter');
      expect((await requested).method()).toBe('GET');
      await page.locator('body[data-delivery-headers="200"]').waitFor();

      let refreshes = 0;
      await page.route(
        (url) => brandView(url, 'runs'),
        async (route) => {
          refreshes++;
          refreshEntered.resolve();
          await releaseRefresh.promise;
          await route.fallback();
        },
      );
      const replay = page.waitForResponse(
        (response) =>
          brandEndpoint(new URL(response.url())) &&
          response.request().method() === 'POST',
      );
      await action.click();
      expect((await (await replay).json()).run.id).toBe(runId);
      expect(generates(f.state)).toHaveLength(2);
      expect(generates(f.state)[1]!.body).toEqual(originalRequest);
      await refreshEntered.promise;

      await finishDownload();
      await page
        .locator(`body[data-delivery-bytes="${Buffer.byteLength(expected)}"]`)
        .waitFor();
      expect(
        await page.locator('body').getAttribute('data-delivery-save'),
      ).toBe('allrice-export');
      await expect.poll(() => downloads.length).toBe(1);
      const download = downloads[0]!;
      expect(download.suggestedFilename()).toBe('allrice-export');
      expect(await readFile((await download.path())!, 'utf8')).toBe(expected);
      expect(await deliveries.count()).toBe(1);

      const refreshed = runResponse();
      releaseRefresh.resolve();
      expect(await (await refreshed).json()).toEqual(initialSnapshot);
      expect(refreshes).toBe(1);
    } finally {
      releaseRefresh.resolve();
      await finishDownload();
      await f.close();
    }
  });

  it('keeps only independently authorized Run deliveries while article detail is refused', async () => {
    const stored = article();
    stored.references = [
      {
        origin: 'reference',
        sourceId: refs[0]!.sourceId,
        revisionId: refs[0]!.revisionId,
      },
    ];
    const run = recovery('article');
    const f = await fixture({ articles: [stored], runs: [run] });
    const { page } = f;
    const restoreDetail = gate();
    const deliveries = panel(page).getByRole('button', {
      name: '查看本次正文成果',
      exact: true,
    });
    const contents = panel(page).getByLabel('文章正文');
    const message = '这篇文章新加入的参考资料已不可读';
    let refused = true;
    try {
      await f.open();
      await panel(page).getByRole('tab', { name: '文章库' }).click();
      await expect
        .poll(() => contents.textContent())
        .toContain('不可直接改写的正文');
      await panel(page).getByText(refs[0]!.fileName, { exact: true }).waitFor();
      await holdBodyDelivery(page, `/api/v1/files/${file.objectId}/download`);
      await deliveries.press('Enter');
      await page.locator('body[data-delivery-headers="200"]').waitFor();
      await page.route(brandEndpoint, async (route) => {
        const url = new URL(route.request().url());
        if (
          refused &&
          (brandView(url, 'articles') || brandView(url, 'article'))
        )
          return route.fulfill({
            status: 409,
            json: accessProblem(message, 'REFERENCE_SELECTION_UNAVAILABLE'),
          });
        if (brandView(url, 'article')) await restoreDetail.promise;
        return route.fallback();
      });
      const reread = page.waitForResponse((response) =>
        brandView(new URL(response.url()), 'runs'),
      );
      const detail = page.waitForResponse((response) =>
        brandView(new URL(response.url()), 'article'),
      );
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      expect(await (await reread).json()).toEqual({ runs: [run] });
      expect((await detail).status()).toBe(409);
      await panel(page)
        .getByRole('alert')
        .filter({ hasText: message })
        .waitFor();
      await contents.waitFor({ state: 'detached' });
      expect(
        await panel(page).getByText(stored.title, { exact: true }).count(),
      ).toBe(0);
      expect(
        await panel(page).getByText(refs[0]!.fileName, { exact: true }).count(),
      ).toBe(0);
      expect(await deliveries.count()).toBe(1);
      const saved = page.waitForEvent('download');
      await page.evaluate(() =>
        window.dispatchEvent(new Event('finish-body-delivery')),
      );
      const download = await saved;
      expect(download.suggestedFilename()).toBe('allrice-export');
      expect(await readFile((await download.path())!, 'utf8')).toBe(
        '不可直接改写的正文\n第二段',
      );

      f.state.runs = [{ ...run, unavailable: true, deliveries: [] }];
      f.state.articles[0] = {
        ...article(),
        revision: 2,
        title: '重新获权的文章',
      };
      refused = false;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await panel(page)
        .getByRole('button', { name: '重新获权的文章', exact: true })
        .waitFor();
      expect(await contents.count()).toBe(0);
      expect(await deliveries.count()).toBe(0);

      restoreDetail.resolve();
      await panel(page)
        .getByRole('heading', { name: '重新获权的文章', exact: true })
        .waitFor();
      await expect
        .poll(() => contents.textContent())
        .toContain('不可直接改写的正文');
      expect(await deliveries.count()).toBe(0);
    } finally {
      await page.evaluate(() =>
        window.dispatchEvent(new Event('finish-body-delivery')),
      );
      restoreDetail.resolve();
      await f.close();
    }
  });

  it('reports a clipboard rejection after concurrent help opens successfully', async () => {
    const f = await fixture();
    const { page } = f;
    const copy = panel(page).getByRole('button', {
      name: '复制正文',
      exact: true,
    });
    const problem = panel(page)
      .getByRole('alert')
      .filter({ hasText: '未能复制正文' });
    try {
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write']);
      await f.open();
      await panel(page).getByRole('tab', { name: '文章库' }).click();
      await expect.poll(() => copy.isEnabled()).toBe(true);
      await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: () =>
            new Promise<void>((_, reject) => {
              window.addEventListener(
                'reject-brand-copy',
                () => reject(Error('Synthetic clipboard rejection')),
                { once: true },
              );
              document.body.dataset.brandCopyPending = 'true';
            }),
        });
      });
      await copy.click();
      await page.locator('body[data-brand-copy-pending="true"]').waitFor();
      await panel(page).getByRole('button', { name: 'ⓘ 使用说明' }).click();
      const help = page.getByRole('dialog', { name: '使用说明' });
      await help.waitFor();
      await page.evaluate(() =>
        window.dispatchEvent(new Event('reject-brand-copy')),
      );
      await help.getByRole('button', { name: '关闭使用说明' }).click();
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      expect(await problem.isVisible()).toBe(true);
      expect(
        await panel(page).getByText('正文已复制', { exact: true }).count(),
      ).toBe(0);
      await page.evaluate(() =>
        Reflect.deleteProperty(navigator.clipboard, 'writeText'),
      );
      await copy.click();
      await panel(page).getByText('正文已复制', { exact: true }).waitFor();
      expect(await problem.count()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('keeps separate read refusals and a failed clipboard action through independent recovery', async () => {
    const other = {
      ...article(21),
      body: { ...file, objectId: id(82), versionId: id(83) },
    };
    const f = await fixture({ articles: [article(), other] });
    const { page } = f;
    const started = gate();
    const release = gate();
    const alerts = panel(page).getByRole('alert');
    const bodyFailure = alerts.filter({ hasText: '正文文件暂时不可读' });
    const topicMessage = '这次选题读取的参考资料已不可用';
    const topicFailure = alerts.filter({ hasText: topicMessage });
    const copyFailure = alerts.filter({ hasText: '未能复制正文' });
    const copy = panel(page).getByRole('button', {
      name: '复制正文',
      exact: true,
    });
    let denyTopics = true;
    try {
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write']);
      await f.open();
      await panel(page).getByRole('tab', { name: '文章库' }).click();
      await expect.poll(() => copy.isEnabled()).toBe(true);
      await page.route(
        (url) => url.pathname === `/api/v1/files/${file.objectId}/download`,
        (route) => route.fulfill({ status: 403, body: '' }),
      );
      await page.route(
        (url) => brandView(url, 'topics'),
        async (route) => {
          if (!denyTopics) return route.fallback();
          started.resolve();
          await release.promise;
          return route.fulfill({
            status: 409,
            json: accessProblem(
              topicMessage,
              'REFERENCE_SELECTION_UNAVAILABLE',
            ),
          });
        },
      );
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await started.promise;
      await copy.click();
      await bodyFailure.waitFor();
      await panel(page)
        .getByRole('button', { name: other.title, exact: true })
        .click();
      await expect.poll(() => copy.isEnabled()).toBe(true);
      release.resolve();
      await topicFailure.waitFor();
      expect(await bodyFailure.isVisible()).toBe(true);

      await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: async () => {
            throw new Error('Synthetic clipboard rejection');
          },
        });
      });
      await copy.click();
      await copyFailure.waitFor();
      expect(await bodyFailure.isVisible()).toBe(true);
      expect(await topicFailure.isVisible()).toBe(true);

      denyTopics = false;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await topicFailure.waitFor({ state: 'hidden' });
      expect(await bodyFailure.isVisible()).toBe(true);
      expect(await copyFailure.isVisible()).toBe(true);

      await page.evaluate(() =>
        Reflect.deleteProperty(navigator.clipboard, 'writeText'),
      );
      await copy.click();
      await page.getByText('正文已复制', { exact: true }).waitFor();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        '不可直接改写的正文\n第二段',
      );
      expect(await copyFailure.isVisible()).toBe(false);
      expect(await bodyFailure.isVisible()).toBe(true);
    } finally {
      release.resolve();
      await f.close();
    }
  });

  async function imagesPage(f: Awaited<ReturnType<typeof fixture>>) {
    await f.open();
    await f.page.getByRole('tab', { name: '文章库', exact: true }).click();
    await f.page
      .getByRole('button', { name: '＋ 加配图', exact: true })
      .click();
    return f.page.getByRole('dialog', { name: '加配图', exact: true });
  }
  const imageCommands = (state: State) =>
    state.requests.filter((req) => req.body?.operation === 'article.image.add');

  it('creates one target-bound image without adopting, disables a running request, then restores the exact native preview and explicitly uses it', async () => {
    const f = await fixture(),
      modal = await imagesPage(f),
      { page } = f;
    expect(
      await modal
        .getByRole('button', { name: '生成', exact: true })
        .isEnabled(),
    ).toBe(false);
    await modal.getByLabel('画面描述').fill('一张蓝色新品封面');
    await modal.getByRole('button', { name: '生成', exact: true }).click();
    await expect.poll(() => generates(f.state).length).toBe(1);
    expect(generates(f.state)[0]!.body).toMatchObject({
      operation: 'image',
      articleId: id(20),
      expectedRevision: 1,
      description: '一张蓝色新品封面',
    });
    for (const field of ['references', 'source', 'imageModel', 'module'])
      expect(generates(f.state)[0]!.body).not.toHaveProperty(field);
    await expect
      .poll(() =>
        modal.getByRole('button', { name: '生成', exact: true }).isEnabled(),
      )
      .toBe(false);
    await expect
      .poll(() =>
        modal.getByRole('button', { name: '生成', exact: true }).textContent(),
      )
      .toBe('生成中…');
    expect(
      await modal.getByRole('button', { name: '取消', exact: true }).count(),
    ).toBe(2);
    expect(imageCommands(f.state)).toEqual([]);
    const row = f.state.runs[0]!,
      done = recovery('image');
    row.run = runSnapshot(Number(row.run.id.slice(-12)));
    row.image = done.image;
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '← 回到对话' }).click();
    await imagesPage(f);
    await modal
      .getByRole('button', { name: '查看原图: 配图预览', exact: true })
      .click();
    await page.getByRole('dialog', { name: '配图原图', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await expect
      .poll(() => page.getByRole('dialog', { name: '配图原图' }).count())
      .toBe(0);
    expect(imageCommands(f.state)).toHaveLength(0);
    await modal.getByRole('button', { name: '用这张', exact: true }).click();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    expect(imageCommands(f.state)).toHaveLength(1);
    expect(imageCommands(f.state)[0]!.body!.image).toEqual({
      source: 'generated',
      file: imageFile,
      operationId: done.image!.operationId,
    });
    expect(f.state.articles[0]!.images).toHaveLength(1);
    await page.getByRole('button', { name: '＋ 加配图' }).click();
    expect(
      await modal
        .getByRole('button', { name: '已加入', exact: true })
        .isEnabled(),
    ).toBe(false);
    expect(generates(f.state)).toHaveLength(1);
    await f.close();
  });

  it.each(['unknown', 'succeeded'] as const)(
    'a failed Run with an existing %s original restores preview/download without enabling a fee retry; external host closure releases both native layers',
    async (status) => {
      const row = recovery('image', 'failed');
      row.image = {
        ...recovery('image').image!,
        status,
        adoptable: status === 'succeeded',
        retryable: false,
      };
      const f = await fixture({ runs: [row] }),
        modal = await imagesPage(f),
        { page } = f;
      await modal
        .getByRole('button', { name: '查看原图: 配图预览', exact: true })
        .waitFor();
      expect(
        await modal
          .getByRole('button', { name: '用这张', exact: true })
          .isEnabled(),
      ).toBe(status === 'succeeded');
      expect(
        await modal.getByRole('button', { name: '重试', exact: true }).count(),
      ).toBe(0);
      const download = page.waitForEvent('download');
      await modal
        .getByRole('button', { name: '下载原图', exact: true })
        .click();
      const original = await download;
      expect(original.suggestedFilename()).toBe('原生封面.png');
      expect(await readFile((await original.path())!)).toEqual(
        Buffer.from(png, 'base64'),
      );
      await modal
        .getByRole('button', { name: '查看原图: 配图预览', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: '配图原图', exact: true })
        .waitFor();
      await page.evaluate(() =>
        window.dispatchEvent(new Event('fixture-employee-navigation')),
      );
      await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
      await expect
        .poll(() =>
          page
            .getByLabel('聊天草稿')
            .evaluate((el) => document.activeElement === el),
        )
        .toBe(true);
      expect(await page.getByLabel('聊天草稿').inputValue()).toBe(
        '未发送的聊天草稿',
      );
      expect(imageCommands(f.state)).toHaveLength(0);
      expect(generates(f.state)).toHaveLength(0);
      await f.close();
    },
  );

  it.each(['failed', 'succeeded'] as const)(
    'a confirmed failed image in a %s Run keeps its frozen retry intent and request ID after a lost response and cold reopening',
    async (terminalStatus) => {
      const failed = recovery('image', 'failed');
      failed.run = runSnapshot(300, terminalStatus);
      const f = await fixture({
        runs: [failed],
        loseGenerateResponseOnce: true,
      });
      const modal = await imagesPage(f),
        { page } = f;
      await modal.getByLabel('画面描述').fill('编辑框里的新文字不能替换原重试');
      await modal.getByRole('button', { name: '重试', exact: true }).click();
      await modal.getByRole('alert').waitFor();
      await modal.getByRole('button', { name: '重试', exact: true }).click();
      await expect.poll(() => generates(f.state).length).toBe(2);
      expect(generates(f.state)[1]!.body).toEqual(generates(f.state)[0]!.body);
      expect(generates(f.state)[0]!.body).toMatchObject({
        retryOfRunId: failed.run.id,
        description: failed.invocation.intent.description,
        articleId: failed.invocation.intent.articleId,
        expectedRevision: failed.invocation.intent.expectedRevision,
      });
      expect(f.state.runs).toHaveLength(2);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '← 回到对话' }).click();
      await imagesPage(f);
      expect(
        await modal
          .getByRole('button', { name: '生成', exact: true })
          .isEnabled(),
      ).toBe(false);
      expect(generates(f.state)).toHaveLength(2);
      await f.close();
    },
  );

  it('upload waits for “用这张”, freezes its in-flight entry, and treats a Markdown-shaped filename only as an accessible label', async () => {
    let release!: () => void;
    const f = await fixture(),
      modal = await imagesPage(f),
      { page } = f;
    await modal.getByRole('tab', { name: '自己上传', exact: true }).click();
    const input = modal.getByLabel('选择配图'),
      name =
        '封面 ](https://invalid.example)\n![注入](https://invalid.example/x).png';
    await input.setInputFiles({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    });
    await modal
      .getByRole('button', { name: '查看原图: 配图预览', exact: true })
      .waitFor();
    expect(await modal.getByRole('link').count()).toBe(0);
    expect(await modal.getByRole('img').count()).toBe(1);
    expect(
      f.state.requests.some(
        (req) =>
          req.method === 'POST' &&
          req.path.startsWith('/api/v1/workbench/files'),
      ),
    ).toBe(false);
    f.state.uploadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await modal.getByRole('button', { name: '用这张', exact: true }).click();
    await expect
      .poll(
        () =>
          f.state.requests.filter(
            (req) =>
              req.method === 'POST' &&
              req.path.startsWith('/api/v1/workbench/files'),
          ).length,
      )
      .toBe(1);
    expect(await input.isDisabled()).toBe(true);
    // Exercise a late change event as well as the real disabled user control.
    await input.setInputFiles({
      name: '另一张.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    });
    f.state.uploadGate = undefined;
    release();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    expect(imageCommands(f.state)[0]!.body!.image).toEqual({
      source: 'uploaded',
      origin: 'upload',
      file: { objectId: id(90), checksum },
    });
    expect(f.state.imageFiles[id(90)]!.fileName).toBe(name);
    await page.getByRole('button', { name: '＋ 加配图' }).click();
    await modal.getByRole('button', { name: '用这张', exact: true }).click();
    await expect.poll(() => imageCommands(f.state).length).toBe(2);
    expect(f.state.imageFiles[id(91)]!.fileName).toBe('另一张.png');
    expect(imageCommands(f.state)[1]!.body!.image).toMatchObject({
      file: { objectId: id(91) },
    });
    expect(
      f.state.requests.some(
        (req) =>
          req.method === 'POST' && req.path.startsWith('/api/v1/references'),
      ),
    ).toBe(false);
    expect(generates(f.state)).toHaveLength(0);
    await f.close();
  });

  it('downloads originals sequentially in article order without a ZIP, labels the first as cover, and removal leaves the private original intact', async () => {
    const document = article();
    document.images = [
      { source: 'generated', operationId: id(350), file: imageFile },
      {
        source: 'uploaded',
        origin: 'upload',
        file: { objectId: id(90), checksum },
      },
    ];
    const f = await fixture({
        articles: [document],
        imageFiles: {
          [id(80)]: {
            fileName: '封面原图.png',
            mediaType: 'image/png',
            base64: png,
          },
          [id(90)]: {
            fileName: '第二张原图.png',
            mediaType: 'image/png',
            base64: png,
          },
        },
      }),
      { page } = f;
    await f.open();
    await page.getByRole('tab', { name: '文章库', exact: true }).click();
    const section = page.getByRole('region', { name: '文章配图' });
    await section
      .getByLabel('封面图', { exact: true })
      .getByRole('button', { name: '下载', exact: true })
      .waitFor();
    const downloads: Array<Promise<{ name: string; bytes: Buffer }>> = [];
    page.on('download', (item) => {
      downloads.push(
        (async () => ({
          name: item.suggestedFilename(),
          bytes: await readFile((await item.path())!),
        }))(),
      );
    });
    await section
      .getByRole('button', { name: '下载全部', exact: true })
      .click();
    await expect.poll(() => downloads.length).toBe(2);
    expect(await Promise.all(downloads)).toEqual([
      { name: '封面原图.png', bytes: Buffer.from(png, 'base64') },
      { name: '第二张原图.png', bytes: Buffer.from(png, 'base64') },
    ]);
    expect(
      f.state.requests
        .filter(
          (req) =>
            req.path.startsWith('/api/v1/workbench/files/') &&
            req.path.includes('/download'),
        )
        .map((req) => req.path.split('/')[5]),
    ).toEqual([id(80), id(90)]);
    await section
      .getByLabel('封面图', { exact: true })
      .getByRole('button', { name: '删除', exact: true })
      .click();
    await expect.poll(() => f.state.articles[0]!.images.length).toBe(1);
    expect(f.state.articles[0]!.images[0]!.file.objectId).toBe(id(90));
    expect(f.state.imageFiles[id(80)]!.base64).toBe(png);
    await expect
      .poll(() =>
        section.getByLabel('封面图', { exact: true }).getByRole('img').count(),
      )
      .toBe(1);
    await f.close();
  });

  it('published articles retain image preview/download but expose no copy/add/remove controls', async () => {
    const document = article();
    document.publication = {
      state: 'published',
      schedule: { plannedAt: stamp, timezone: 'Asia/Shanghai' },
      links: { wechat: null, xiaohongshu: null },
    };
    document.images = [
      { source: 'generated', operationId: id(350), file: imageFile },
    ];
    const f = await fixture({ articles: [document] }),
      { page } = f;
    await f.open();
    await page.getByRole('tab', { name: '文章库', exact: true }).click();
    const section = page.getByRole('region', { name: '文章配图' });
    await section
      .getByRole('button', { name: '查看原图: 配图预览', exact: true })
      .waitFor();
    for (const name of ['复制正文', '＋ 加配图', '删除'])
      expect(
        await panel(page).getByRole('button', { name, exact: true }).count(),
      ).toBe(0);
    expect(
      await section
        .getByRole('button', { name: '下载', exact: true })
        .isEnabled(),
    ).toBe(true);
    await f.close();
  });

  it.each(['image', 'body'] as const)(
    'never downloads a late original or starts the next image after returning and reopening without access (%s)',
    async (kind) => {
      const stored = article();
      stored.images = [
        { source: 'generated', operationId: id(350), file: imageFile },
        {
          source: 'uploaded',
          origin: 'upload',
          file: { objectId: id(90), checksum },
        },
      ];
      const f = await fixture({
        articles: [stored],
        runs: kind === 'body' ? [recovery('article')] : [],
      });
      const { page } = f;
      const first =
        kind === 'body'
          ? `/api/v1/files/${file.objectId}/download`
          : `/api/v1/workbench/files/${id(80)}/download`;
      const second = `/api/v1/workbench/files/${id(90)}/download`;
      const requested = gate();
      const release = gate();
      const downloads: string[] = [];
      page.on('download', (item) => downloads.push(item.suggestedFilename()));
      try {
        await f.open();
        await panel(page)
          .getByRole('tab', { name: '文章库', exact: true })
          .click();
        await expect
          .poll(() => panel(page).getByLabel('文章正文').textContent())
          .toContain('不可直接改写的正文');
        await finishDespiteAbort(page, first, true);
        await page.evaluate(() => {
          const click = HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click = function (
            this: HTMLAnchorElement,
          ) {
            if (this.download)
              document.body.dataset.lateImageSave = this.download;
            click.call(this);
          };
        });
        await page.route(
          (url) => url.pathname === first,
          async (route) => {
            requested.resolve();
            await release.promise;
            await route.fallback();
          },
        );
        const action = panel(page).getByRole('button', {
          name: kind === 'body' ? '查看本次正文成果' : '下载全部',
          exact: true,
        });
        if (kind === 'body') await action.press('Enter');
        else await action.click();
        await requested.promise;
        await panel(page).getByRole('button', { name: '← 回到对话' }).click();
        await page
          .getByRole('heading', { name: '原聊天', exact: true })
          .waitFor();
        expect(await page.getByLabel('聊天草稿').inputValue()).toBe(
          '未发送的聊天草稿',
        );

        const message = '当前员工的品牌自媒体绑定已撤销';
        await page.route(brandEndpoint, (route) =>
          route.fulfill({ status: 403, json: accessProblem(message) }),
        );
        await page.route(moduleDirectory, (route) =>
          route.fulfill({
            json: {
              modules: [
                {
                  descriptor: {
                    id: 'allrice.brand-media',
                    displayName: '品牌自媒体',
                  },
                  binding: { ...binding, revokedAt: stamp },
                  enabled: false,
                  available: false,
                },
              ],
            },
          }),
        );
        const checked = page.waitForResponse((response) =>
          moduleDirectory(new URL(response.url())),
        );
        await page
          .getByRole('button', { name: '打开 品牌自媒体', exact: true })
          .click();
        await (await checked).finished();
        await panel(page)
          .getByRole('alert')
          .filter({ hasText: message })
          .waitFor();
        expect(await panel(page).getByRole('tab').count()).toBe(0);
        const settled = Promise.race([
          page.waitForEvent('download').then(() => 'saved'),
          page
            .locator('body[data-late-image-read="settled"]')
            .waitFor({ state: 'attached' })
            .then(() => 'read'),
        ]);
        release.resolve();
        expect(await settled).toBe('read');
        expect(
          await page.locator('body').getAttribute('data-late-image-save'),
        ).toBeNull();
        expect(downloads).toEqual([]);
        expect(
          f.state.requests.some((request) => request.path.startsWith(second)),
        ).toBe(false);
      } finally {
        release.resolve();
        await f.close();
      }
    },
  );

  it.each(['loaded', 'late', 'offline'] as const)(
    'keeps other previews and only clears a file on a definitive denied download (%s)',
    async (kind) => {
      const stored = article();
      stored.images = [
        { source: 'generated', operationId: id(350), file: imageFile },
        {
          source: 'uploaded',
          origin: 'upload',
          file: { objectId: id(90), checksum },
        },
      ];
      const f = await fixture({
        articles: [stored],
        imageFiles: {
          [id(80)]: {
            fileName: '封面原图.png',
            mediaType: 'image/png',
            base64: png,
          },
          [id(90)]: {
            fileName: '第二张原图.png',
            mediaType: 'image/png',
            base64: png,
          },
        },
      });
      const { page } = f;
      const preview = gate();
      const coverPath = `/api/v1/workbench/files/${id(80)}`;
      const section = page.getByRole('region', { name: '文章配图' });
      const cover = section.getByLabel('封面图', { exact: true });
      const other = section.getByLabel('配图 1', { exact: true });
      try {
        if (kind === 'late') {
          await page.route(
            (url) => url.pathname === coverPath + '/preview',
            async (route) => {
              await preview.promise;
              await route.fallback();
            },
          );
        }
        await f.open();
        await panel(page)
          .getByRole('tab', { name: '文章库', exact: true })
          .click();
        await other.getByRole('img').waitFor();
        if (kind !== 'late') await cover.getByRole('img').waitFor();
        await page.route(
          (url) => url.pathname === coverPath + '/download',
          (route) =>
            kind === 'offline'
              ? route.abort('internetdisconnected')
              : route.fulfill({
                  status: kind === 'late' ? 404 : 403,
                  json: accessProblem(
                    '当前配图已不可读取',
                    kind === 'late'
                      ? 'RESOURCE_NOT_FOUND'
                      : 'AUTHORIZATION_DENIED',
                  ),
                }),
        );
        await cover.getByRole('button', { name: '下载', exact: true }).click();
        await section.getByRole('alert').first().waitFor();
        if (kind === 'late') {
          const reply = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === coverPath + '/preview',
          );
          preview.resolve();
          expect((await reply).ok()).toBe(true);
          await page.evaluate(
            () =>
              new Promise<void>((done) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => done()),
                ),
              ),
          );
        }
        expect(await cover.getByRole('img').count()).toBe(
          kind === 'offline' ? 1 : 0,
        );
        expect(await other.getByRole('img').isVisible()).toBe(true);
      } finally {
        preview.resolve();
        await f.close();
      }
    },
  );

  it('copies only the exact plain body and reports clipboard rejection without claiming success', async () => {
    const f = await fixture(),
      { page } = f;
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    await f.open();
    await page.getByRole('tab', { name: '文章库', exact: true }).click();
    const copy = page.getByRole('button', { name: '复制正文', exact: true });
    await expect.poll(() => copy.isEnabled()).toBe(true);
    await copy.click();
    await page.getByText('正文已复制', { exact: true }).waitFor();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      '不可直接改写的正文\n第二段',
    );
    await page.getByRole('button', { name: '← 回到对话' }).click();
    await f.open();
    await page.getByRole('tab', { name: '文章库', exact: true }).click();
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async () => {
          throw new Error('Synthetic clipboard rejection');
        },
      });
    });
    await expect.poll(() => copy.isEnabled()).toBe(true);
    await copy.click();
    await page.getByRole('alert').filter({ hasText: '未能复制正文' }).waitFor();
    expect(await page.getByText('正文已复制', { exact: true }).count()).toBe(0);
    await f.close();
  });

  it.each(['new-pin', 'switch-to-B', 'expired-visit', 'closed-visit'] as const)(
    'a late denial for the copied body evicts only its exact article and pin (%s)',
    async (change) => {
      const old = article();
      const month = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
      }).format(new Date());
      old.publication = {
        state: 'scheduled',
        schedule: {
          plannedAt: month + '-16T08:00:00.000Z',
          timezone: 'Asia/Shanghai',
        },
        links: null,
      };
      const newPin = {
        objectId: id(82),
        versionId: id(83),
        checksum: 'sha256:' + 'b'.repeat(64),
      };
      const next = {
        ...old,
        id: change === 'switch-to-B' ? id(21) : old.id,
        revision: 2,
        body: newPin,
        title: '独立授权的新文章正文',
      };
      const run = recovery('article');
      run.invocation.intent.articleId = next.id;
      run.submission = { articleUpdated: false, revision: null };
      const delivery = { ...run.deliveries[0]!, file: newPin };
      run.deliveries =
        change === 'switch-to-B' ? [delivery] : [run.deliveries[0]!, delivery];
      const f = await fixture({
        articles: change === 'switch-to-B' ? [old, next] : [old],
        runs: [run],
      });
      const { page } = f;
      const requested = gate();
      const refuse = gate();
      const bodyPath = (objectId: string) =>
        '/api/v1/files/' + objectId + '/download';
      const authLost = change === 'expired-visit' || change === 'closed-visit';
      try {
        await page
          .context()
          .grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.evaluate(() =>
          navigator.clipboard.writeText('保持原剪贴板'),
        );
        await f.open();
        await panel(page)
          .getByRole('tab', { name: '文章库', exact: true })
          .click();
        await expect
          .poll(() => page.getByLabel('文章正文').textContent())
          .toContain('不可直接改写的正文');
        if (change === 'closed-visit')
          await finishDespiteAbort(page, bodyPath(file.objectId));
        await page.route(
          (url) => url.pathname === bodyPath(file.objectId),
          async (route) => {
            requested.resolve();
            await refuse.promise;
            await route.fulfill({
              status: authLost ? 401 : 403,
              json: authLost
                ? accessProblem(
                    'Authentication required',
                    'AUTHENTICATION_REQUIRED',
                  )
                : accessProblem('旧正文的文件授权已撤销'),
            });
          },
        );
        await page.route(
          (url) => url.pathname === bodyPath(newPin.objectId),
          (route) =>
            route.fulfill({
              contentType: 'text/plain',
              body: '经独立读取的新版本字节',
            }),
        );
        await panel(page)
          .getByRole('button', { name: '复制正文', exact: true })
          .click();
        await requested.promise;
        const authorized = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            brandView(url, 'article') &&
            url.searchParams.get('articleId') === next.id
          );
        });
        if (change !== 'switch-to-B') {
          f.state.articles[0] = next;
          await page.evaluate(() => window.dispatchEvent(new Event('online')));
        } else {
          await panel(page)
            .getByRole('button', { name: next.title, exact: true })
            .click();
        }
        const receipt = await authorized;
        expect((await receipt.json()).article.body).toEqual(newPin);
        await expect
          .poll(() => page.getByLabel('文章正文').textContent())
          .toBe('经独立读取的新版本字节');
        if (authLost) {
          if (change === 'closed-visit') {
            await panel(page)
              .getByRole('button', { name: '← 回到对话' })
              .click();
            await f.open();
            await panel(page)
              .getByRole('tab', { name: '文章库', exact: true })
              .click();
            await expect
              .poll(() => page.getByLabel('文章正文').textContent())
              .toBe('经独立读取的新版本字节');
          }
          const denied = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === bodyPath(file.objectId) &&
              response.status() === 401,
          );
          refuse.resolve();
          const response = await denied;
          // The active 401 terminates its own response body with the visit.
          // A retired response deliberately lets its body finish uncooperatively.
          if (change === 'closed-visit') await response.finished();
          await page.evaluate(
            () =>
              new Promise<void>((done) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => done()),
                ),
              ),
          );
          const expired = panel(page)
            .getByRole('alert')
            .filter({ hasText: '登录已过期，请重新登录' });
          if (change === 'expired-visit') {
            expect(await expired.isVisible()).toBe(true);
            expect(await panel(page).getByRole('tab').count()).toBe(0);
            expect(await panel(page).getByLabel('文章正文').count()).toBe(0);
            await panel(page)
              .getByRole('button', { name: '← 回到对话' })
              .click();
            expect(await page.getByLabel('聊天草稿').inputValue()).toBe(
              '未发送的聊天草稿',
            );
          } else {
            expect(await expired.count()).toBe(0);
            expect(await page.getByLabel('文章正文').textContent()).toBe(
              '经独立读取的新版本字节',
            );
          }
          expect(
            await page.evaluate(() => navigator.clipboard.readText()),
          ).toBe('保持原剪贴板');
          return;
        }
        refuse.resolve();
        await panel(page)
          .getByRole('alert')
          .filter({ hasText: '正文文件暂时不可读' })
          .waitFor();
        expect(
          await panel(page)
            .getByRole('heading', { name: next.title, exact: true })
            .isVisible(),
        ).toBe(true);
        expect(await page.getByLabel('文章正文').textContent()).toBe(
          '经独立读取的新版本字节',
        );
        expect(
          await panel(page)
            .getByRole('button', { name: next.title, exact: true })
            .isVisible(),
        ).toBe(true);
        expect(
          await panel(page)
            .getByRole('button', { name: old.title, exact: true })
            .count(),
        ).toBe(0);
        expect(
          await panel(page)
            .getByRole('button', { name: '查看本次正文成果', exact: true })
            .count(),
        ).toBe(1);
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          '保持原剪贴板',
        );
        await panel(page)
          .getByRole('tab', { name: '排期表', exact: true })
          .click();
        expect(
          await panel(page)
            .getByRole('button', { name: next.title, exact: true })
            .isVisible(),
        ).toBe(true);
        expect(
          await panel(page)
            .getByRole('button', { name: old.title, exact: true })
            .count(),
        ).toBe(0);
      } finally {
        refuse.resolve();
        await f.close();
      }
    },
  );

  it.each(['body-pin', 'host-hidden', 'scope-unmount'] as const)(
    'a delayed copy read cannot overwrite the clipboard after %s changes',
    async (change) => {
      const f = await fixture(),
        { page } = f;
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.evaluate(() => navigator.clipboard.writeText('保留原剪贴板'));
      await f.open();
      await page.getByRole('tab', { name: '文章库', exact: true }).click();
      const copy = page.getByRole('button', { name: '复制正文', exact: true });
      await expect.poll(() => copy.isEnabled()).toBe(true);
      await finishDespiteAbort(page, `/api/v1/files/${file.objectId}/download`);
      let release!: () => void;
      f.state.bodyGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const before = f.state.requests.filter((req) =>
        req.path.startsWith('/api/v1/files/'),
      ).length;
      const copyRequested = page.waitForRequest(
        (req) =>
          new URL(req.url()).pathname ===
          `/api/v1/files/${file.objectId}/download`,
      );
      await copy.click();
      const copyRequest = await copyRequested;
      await expect
        .poll(
          () =>
            f.state.requests.filter((req) =>
              req.path.startsWith('/api/v1/files/'),
            ).length,
        )
        .toBe(before + 1);
      if (change === 'body-pin') {
        f.state.articles[0] = {
          ...article(),
          revision: 2,
          title: '同一文章的新正文版本',
          body: {
            ...file,
            versionId: id(200),
            checksum: 'sha256:' + 'b'.repeat(64),
          },
        };
        await page.getByRole('button', { name: '草稿', exact: true }).click();
        await page
          .getByRole('heading', { name: '同一文章的新正文版本', exact: true })
          .waitFor();
      } else if (change === 'host-hidden') {
        await page.evaluate(() =>
          window.dispatchEvent(new Event('fixture-employee-navigation')),
        );
        await expect
          .poll(() =>
            page.locator('[data-brand-media-host]').getAttribute('data-open'),
          )
          .toBe('false');
      } else
        await page
          .getByRole('button', { name: '另一个员工', exact: true })
          .click();
      const response = page.waitForResponse(
        (res) => res.request() === copyRequest,
      );
      f.state.bodyGate = undefined;
      release();
      await response;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        '保留原剪贴板',
      );
      expect(await page.getByText('正文已复制', { exact: true }).count()).toBe(
        0,
      );
      await f.close();
    },
  );
});
