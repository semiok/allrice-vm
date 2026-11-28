import { createFileArchive } from '@allrice/file-archives';
import type {
  ModelCallBinding,
  GatewayModelInput,
} from '../../../../packages/model-gateway/src/contract.ts';
import { createProductionFileMentionContext } from '../../../worker/src/person-vm/production-file-mentions.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type {
  Browser,
  Locator,
  Page,
  Response as BrowserResponse,
} from 'playwright-core';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import {
  brandMediaModule,
  brandMediaRelease,
  encodeEmployeeFileMention,
  type EmployeeFileMentionPin,
} from '@allrice/contracts';
import {
  DataAccessError,
  addEmployeeInstanceModule,
  createChatSession,
  createEmployeeInstance,
  ensureDEntryNativeRoot,
  readDEntryEmployeeDirectory,
  requireDEntryNativeIdentity,
  updateDEntryReleasePolicy,
  type BuiltinModuleId,
} from '@allrice/database';
import { GET as readCapabilityModules } from '../../app/api/v1/d-entry/panels/[panelEmployeeInstanceId]/modules/route';
import { GET as readCapabilityBrandMedia } from '../../app/api/v1/d-entry/panels/[panelEmployeeInstanceId]/brand-media/route';
import { authorizeFixturePlatformAdministrator } from '../../../../packages/database/src/platform-authority.fixture.ts';
import * as database from '../../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../../packages/database/src/runtime.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
} from '../../../../packages/database/src/identity.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from '../../../../packages/database/src/employees/employee-config.ts';
import { ensureGeneralEmployeeInstance } from '../../../../packages/database/src/employees/employee-instances.ts';
import {
  claimReferenceProcessing,
  finishReferenceProcessing,
} from '../../../../packages/database/src/reference-processing.ts';
import {
  completeReferenceUpload,
  referenceLibraryOptions,
} from '../../../../packages/database/src/reference-library.ts';
import { createEmployeePanelsHandlers } from './employee-panels-http';
import {
  employeePanelsDependencies,
  requireEmployeePanelsContext,
} from './employee-panels-context';
import {
  createEmployeePanelsHttpClient,
  readEmployeePanelsWriteReceipt,
  EmployeePanelsWriteUnknownError,
  EmployeePanelsWriteRejectedError,
} from '../chatflow/employee-panel-data-http';
import { ReferenceSelectionUnavailableError } from '../chatflow/reference-selection';
import { GET as manageMemory } from '../../app/api/v1/memories/manage/route';
import { GET as readMemory } from '../../app/api/v1/memories/[id]/route';
import { GET as readMemorySource } from '../../app/api/v1/memories/[id]/source/route';
import { POST as confirmMemory } from '../../app/api/v1/memories/[id]/promote/route';
import { seedPersonalMemoryPair } from '../../../../packages/database/src/workspace/employee-memory-pair.fixture.ts';

// Next's request-local Cookie carrier is replaced, not authentication. The
// real production session adapter, opaque token and current DB readers run.
const cookieBridge = vi.hoisted(() => ({
  read: (): string | Promise<string> => '',
}));
vi.mock('next/headers', () => ({
  async cookies() {
    const cookie = await cookieBridge.read();
    return {
      get(name: string) {
        const part = cookie
          .split(';')
          .map((value) => value.trim())
          .find((value) => value.startsWith(name + '='));
        return part ? { value: part.slice(name.length + 1) } : undefined;
      },
    };
  },
}));
const cookieScope = new AsyncLocalStorage<string>();
cookieBridge.read = () => cookieScope.getStore() ?? '';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'Cookie authenticated n4 panel HTTP with real PostgreSQL and immutable storage',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let server: ReturnType<typeof createServer>, base: string;
    let handlers: ReturnType<typeof createEmployeePanelsHandlers>;
    const running = new Set<Promise<void>>();
    const fixtureAssets = new Map<string, Uint8Array>();
    let fixtureDocument: string | undefined;
    let receiptGate:
      | {
          requestId: string;
          beforeRead?(): Promise<void>;
          beforeReply?(): Promise<void>;
        }
      | undefined;
    let unavailableOriginalReceipt: string | undefined;
    let dropPublishReply = false;
    let incompleteReply: ServerResponse | undefined;
    const publishWrites: string[] = [];
    const publicationActions: string[] = [];
    const receiptReads: string[] = [];
    let referenceWrites = 0;
    const publicationStatuses: number[] = [];

    const routeNames: Record<
      string,
      keyof ReturnType<typeof createEmployeePanelsHandlers>
    > = {
      'GET materials': 'queryMaterials',
      'GET materials/options': 'publicationOptions',
      'GET materials/revisions/:revisionId/selection': 'selectMaterial',
      'GET materials/revisions/:revisionId/preview': 'previewMaterial',
      'GET materials/revisions/:revisionId/download': 'downloadMaterial',
      'POST materials/publications': 'publish',
      'POST materials/publications/:sourceId': 'changePublication',
      'POST materials/sources/:sourceId': 'changeSource',
      'GET deliverables': 'listDeliverables',
      'POST deliverables': 'uploadDeliverable',
      'POST deliverables/:objectId/reference': 'captureReference',
      'GET materials/revisions/:revisionId': 'readPreparedReference',
      'PUT deliverables/:objectId/favorite': 'favorite',
      'GET deliverables/:objectId/preview': 'previewDeliverable',
      'GET deliverables/:objectId/download': 'downloadDeliverable',
      'GET write-receipts/:requestId': 'readWriteReceipt',
    };
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '0');
      vi.stubEnv('ALLRICE_LOCAL_PORTAL', 'unified');
      // The real processor retains its legacy vector column write. Match the
      // reference PG fixtures: owned relations first, existing public types last.
      f = await createRuntimeFixtureDatabase();
      const [fixtureScope] = await f.db`select current_schema() as schema,
        exists(select 1 from pg_catalog.pg_extension e
          join pg_catalog.pg_namespace n on n.oid=e.extnamespace
          where e.extname='vector'
            and to_regtype(format('%I.vector',n.nspname))=to_regtype('vector')) as vector_visible,
        (select count(*)>0 and bool_and(to_regclass(quote_ident(c.relname))::oid=c.oid)
          from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid=c.relnamespace
          where n.nspname=current_schema() and starts_with(c.relname,'allrice_')
            and c.relkind in ('r','p','v','m','S','f')) as relations_owned`;
      expect(fixtureScope).toMatchObject({
        vector_visible: true,
        relations_owned: true,
      });
      expect(fixtureScope!.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      vi.spyOn(database, 'getDatabase').mockReturnValue(f.db);
      handlers = createEmployeePanelsHandlers({
        ...employeePanelsDependencies,
        storage: () => runtimeFixtureStorage(f.db),
      });
      server = createServer((incoming, outgoing) => {
        const work = cookieScope.run(
          incoming.headers.cookie ?? '',
          async () => {
            const stop = new AbortController();
            incoming.once('aborted', () =>
              stop.abort(Error('client disconnected')),
            );
            outgoing.once('close', () => {
              if (!outgoing.writableFinished)
                stop.abort(Error('client disconnected'));
            });
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
            const headers = new Headers();
            for (const [key, value] of Object.entries(incoming.headers))
              if (value !== undefined)
                headers.set(
                  key,
                  Array.isArray(value) ? value.join(',') : value,
                );
            const request = new Request(base + incoming.url, {
              method: incoming.method,
              headers,
              ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
              signal: stop.signal,
            });
            const url = new URL(request.url);
            const asset = fixtureAssets.get(url.pathname);
            if (asset) {
              outgoing.writeHead(200, {
                'content-type': url.pathname.endsWith('.css')
                  ? 'text/css'
                  : 'application/javascript',
              });
              outgoing.end(asset);
              return;
            }
            if (url.pathname === '/fixture/panels' && fixtureDocument) {
              outgoing.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
              });
              outgoing.end(fixtureDocument);
              return;
            }
            if (url.pathname.startsWith('/api/v1/memories/')) {
              const [, , , , id, operation] = url.pathname.split('/');
              const target = { params: Promise.resolve({ id: id! }) };
              const response =
                request.method === 'GET' && id === 'manage'
                  ? await manageMemory(request)
                  : request.method === 'GET' && operation === 'source'
                    ? await readMemorySource(request, target)
                    : request.method === 'GET' && !operation
                      ? await readMemory(request, target)
                      : request.method === 'POST' && operation === 'promote'
                        ? await confirmMemory(request, target)
                        : new Response(null, { status: 405 });
              outgoing.writeHead(
                response.status,
                Object.fromEntries(response.headers),
              );
              outgoing.end(Buffer.from(await response.arrayBuffer()));
              return;
            }
            const pieces = url.pathname.split('/').slice(5);
            const panelEmployeeInstanceId = pieces.shift()!;
            const parts = pieces.map((part, index) =>
              index === 2 &&
              pieces[0] === 'materials' &&
              pieces[1] === 'revisions'
                ? ':revisionId'
                : index === 2 &&
                    pieces[0] === 'materials' &&
                    ['publications', 'sources'].includes(pieces[1]!)
                  ? ':sourceId'
                  : index === 1 && pieces[0] === 'deliverables'
                    ? ':objectId'
                    : index === 1 && pieces[0] === 'write-receipts'
                      ? ':requestId'
                      : part,
            );
            const name = routeNames[`${incoming.method} ${parts.join('/')}`];
            if (!name) {
              outgoing.writeHead(404).end();
              return;
            }
            const params: {
              panelEmployeeInstanceId: string;
              revisionId?: string;
              sourceId?: string;
              objectId?: string;
              requestId?: string;
            } = { panelEmployeeInstanceId };
            parts.forEach((part, index) => {
              if (part === ':revisionId') params.revisionId = pieces[index];
              if (part === ':sourceId') params.sourceId = pieces[index];
              if (part === ':objectId') params.objectId = pieces[index];
              if (part === ':requestId') params.requestId = pieces[index];
            });
            if (
              name === 'readWriteReceipt' &&
              unavailableOriginalReceipt &&
              params.requestId === unavailableOriginalReceipt
            ) {
              unavailableOriginalReceipt = undefined;
              outgoing.writeHead(503, { 'Cache-Control': 'no-store' }).end();
              return;
            }
            const gate =
              name === 'readWriteReceipt' &&
              receiptGate?.requestId === params.requestId
                ? receiptGate
                : undefined;
            await gate?.beforeRead?.();
            const response = await handlers[name](request, {
              params: Promise.resolve(params),
            });
            if (fixtureDocument && name === 'captureReference')
              referenceWrites++;
            if (fixtureDocument && name === 'readWriteReceipt')
              receiptReads.push(params.requestId!);
            await gate?.beforeReply?.();
            if (
              fixtureDocument &&
              (name === 'publish' || name === 'changePublication')
            ) {
              const { requestId } = JSON.parse(
                Buffer.concat(chunks).toString('utf8'),
              );
              if (name === 'publish') {
                publishWrites.push(requestId);
                publicationStatuses.push(response.status);
              } else publicationActions.push(requestId);
              if (dropPublishReply && response.ok) {
                dropPublishReply = false;
                await response.body?.cancel();
                incompleteReply = outgoing;
                outgoing.writeHead(response.status, {
                  'Content-Type': 'application/json',
                  'Content-Length': '100',
                });
                outgoing.write('{"sourceId":');
                await once(outgoing, 'close');
                return;
              }
            }
            outgoing.writeHead(
              response.status,
              Object.fromEntries(response.headers),
            );
            if (response.body)
              await pipeline(
                Readable.fromWeb(
                  response.body as Parameters<typeof Readable.fromWeb>[0],
                ),
                outgoing,
                { signal: stop.signal },
              );
            else outgoing.end();
          },
        );
        running.add(work);
        void work
          .catch((error: unknown) =>
            outgoing.destroy(
              error instanceof Error ? error : Error('response failed'),
            ),
          )
          .finally(() => running.delete(work));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('test listener missing');
      base = `http://127.0.0.1:${address.port}`;
    }, 120000);
    afterAll(async () => {
      await Promise.allSettled([...running]);
      if (server)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (f) await f.close();
    }, 30000);
    async function person(role: 'admin' | 'viewer' = 'admin') {
      const p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: 'panel-' + randomUUID(),
          organizationName: 'Panel company',
          workspaceSlug: 'default',
          workspaceName: 'Panel workspace',
          email: randomUUID() + '@example.test',
          displayName: 'Panel owner',
          role,
        },
        f.db,
      );
      const login = await createSession(p.user.id),
        context = await authenticateSession(login.token, {
          organizationId: p.organizationId,
          workspaceId: p.workspaceId,
        });
      if (!context) throw Error('test login failed');
      const employeeId = randomUUID(),
        versionId = randomUUID(),
        assignmentId = randomUUID();
      const manifest = employeeManifest({
        key: 'panels',
        name: 'Panels',
        description: 'Ordinary file management; no execution',
        toolNames: [],
      });
      await f.db`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
      values(${employeeId},${p.organizationId},${p.workspaceId},'panels','Panels')`;
      await f.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
      values(${versionId},${p.organizationId},${p.workspaceId},${employeeId},1,'Panels',${manifest.provider.model},${manifest.systemPrompt},${f.db.json(manifest.capabilities)},${employeeManifestChecksum(manifest)},${f.db.json(manifest)},${f.db.json(manifest.provider)})`;
      await f.db`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id)
      values(${assignmentId},${p.organizationId},${p.workspaceId},${employeeId},${versionId},${p.user.id})`;
      await ensureGeneralEmployeeInstance(f.db, assignmentId);
      const selection = {
        workspaceId: p.workspaceId,
        employeeInstanceId: assignmentId,
      };
      const fetcher: typeof fetch = (path, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set('Cookie', 'allrice_session=' + login.token);
        if (!headers.has('Origin')) headers.set('Origin', base);
        headers.set('Connection', 'close');
        return fetch(new URL(String(path), base), { ...init, headers });
      };
      const options = { fetch: fetcher, expectedViewerId: p.user.id };
      return {
        context,
        login,
        selection,
        options,
        client: createEmployeePanelsHttpClient(selection, options),
        employeeId,
        versionId,
      };
    }
    async function release(...people: Awaited<ReturnType<typeof person>>[]) {
      const policy = {
        revision: randomUUID(),
        defaultGeneration: '3.x',
        selections: people.map((p) => ({
          organizationId: p.context.organizationId,
          personId: p.context.actor.id,
        })),
      };
      await f.db`insert into allrice_settings(scope_type,key,value) values('system','d_entry_rollout_policy',${f.db.json(policy)})
      on conflict(scope_type,scope_id,key) do update set value=excluded.value`;
    }
    async function seedLegacyThread(p: Awaited<ReturnType<typeof person>>) {
      const id = randomUUID();
      // A preexisting thread supplies the durable generation without admitting legacy execution.
      await f.db`insert into allrice_chat_sessions(
        id, organization_id, workspace_id, owner_id, title, employee_assignment_id,
        employee_instance_id, employee_version_id, execution_generation
      ) values(${id},${p.context.organizationId},${p.selection.workspaceId},
        ${p.context.actor.id},'Legacy thread',${p.selection.employeeInstanceId},
        ${p.selection.employeeInstanceId},${p.versionId},'3.x')`;
      return id;
    }
    const signal = () => new AbortController().signal;
    async function bindDirectoryThread(
      p: Awaited<ReturnType<typeof person>>,
      threadId: string,
    ) {
      const selection = { ...p.selection, threadId };
      const identity = await requireDEntryNativeIdentity(p.context, selection);
      const host = {
        binding: {
          organizationId: identity.organizationId,
          personId: identity.personId,
          vmId: 'fixture-pinned-vm',
          instanceId: 'fixture-born-instance',
          leaseEpoch: 1,
        },
        bindingRef: 'fixture-native-dock-binding',
        rosterDigest: 'fixture-enrolled-roster',
      };
      await ensureDEntryNativeRoot(p.context, selection, identity, {
        operationId: randomUUID(),
        host,
        signal: signal(),
        create: async () => ({ host, nativeSessionId: 'fixture-' + threadId }),
      });
      return selection;
    }
    function uploadInput(
      p: Awaited<ReturnType<typeof person>>,
      name = '同名.txt',
      text = '收款口径。\n中文第二行。',
    ) {
      return {
        workspaceId: p.selection.workspaceId,
        requestId: randomUUID(),
        fileName: name,
        mediaType: 'text/plain',
        contentBase64: Buffer.from(text).toString('base64'),
      };
    }
    async function processed(revisionId: string, text: string) {
      await f.db`update allrice_knowledge_processing set updated_at='2000-01-01' where revision_id=${revisionId}`;
      const claim = await claimReferenceProcessing();
      expect(claim?.revisionId).toBe(revisionId);
      if (!claim) throw Error('claim missing');
      await finishReferenceProcessing(
        claim,
        [{ content: text, start: 0, end: text.length }],
        {
          text,
          kind: 'text',
          warnings: [],
          units: [{ label: '正文', start: 0, end: text.length }],
        },
      );
    }
    async function raw(
      p: Awaited<ReturnType<typeof person>>,
      path: string,
      init: RequestInit = {},
    ) {
      return p.options.fetch(
        `/api/v1/d-entry/panels/${p.selection.employeeInstanceId}${path}?workspaceId=${p.selection.workspaceId}`,
        init,
      );
    }
    it.skipIf(process.env.ALLRICE_RUN_BROWSER_INTEGRATION !== '1')(
      'runs the product panel with the original Cookie through favorite, publication and original receipt',
      { timeout: 45_000 },
      async () => {
        const p = await person();
        await release(p);
        const session = await createChatSession(p.context, p.selection, {
          executionGeneration: '4.0',
        });
        const selectedThread = await bindDirectoryThread(p, session.id);
        const directory = await readDEntryEmployeeDirectory(
          p.context,
          selectedThread,
          signal(),
        );
        const input = uploadInput(p, '浏览器本人交付.txt');
        const original = await p.client.uploadDeliverable(input, signal());
        const require = createRequire(import.meta.url);
        const { build } = createRequire(require.resolve('tsx'))('esbuild');
        const output = await build({
          absWorkingDir: process.cwd(),
          entryPoints: [
            'packages/dsh-web-composition/tests/fixtures/employee-panels/employee-panel-live-page.tsx',
          ],
          outdir: '/unused-live-panel',
          bundle: true,
          splitting: true,
          write: false,
          platform: 'browser',
          format: 'esm',
          jsx: 'automatic',
          loader: {
            '.woff': 'dataurl',
            '.woff2': 'dataurl',
            '.ttf': 'dataurl',
            '.svg': 'dataurl',
          },
          define: { 'process.env.NODE_ENV': '"production"' },
        });
        for (const item of output.outputFiles as {
          path: string;
          contents: Uint8Array;
        }[])
          fixtureAssets.set(
            '/fixture/assets/' + item.path.split('/').at(-1),
            item.contents,
          );
        fixtureDocument = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture/assets/employee-panel-live-page.css"><div id="app" data-organization-id="${p.context.organizationId}" data-viewer-id="${p.context.actor.id}" data-workspace-id="${p.selection.workspaceId}" data-employee-instance-id="${p.selection.employeeInstanceId}" data-thread-id="${session.id}" data-scope-id="${randomUUID()}" data-native-session-id="test-dock"></div><script id="allrice-employee-directory" type="application/json">${JSON.stringify(directory).replaceAll('<', '\\u003c')}</script><script type="module" src="/fixture/assets/employee-panel-live-page.js"></script>`;
        let browser: Browser | undefined;
        let restoreStoragePut: (() => void) | undefined;
        try {
          browser = await require('playwright-core').chromium.launch({
            executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE,
          });
          const context = await browser!.newContext({
            reducedMotion: 'reduce',
          });
          await context.addCookies([
            { name: 'allrice_session', value: p.login.token, url: base },
          ]);
          const publicationPath = `/api/v1/d-entry/panels/${p.selection.employeeInstanceId}/materials/publications`;
          const browserPublicationAttempts: (string | null)[] = [];
          context.on('request', (request) => {
            const url = new URL(request.url());
            if (
              request.method() !== 'POST' ||
              url.origin !== base ||
              (url.pathname !== publicationPath &&
                !url.pathname.startsWith(publicationPath + '/'))
            )
              return;
            let requestId: string | null = null;
            try {
              requestId =
                (request.postDataJSON() as { requestId: string } | null)
                  ?.requestId ?? null;
            } catch {
              // A malformed attempt still counts before any response.
            }
            browserPublicationAttempts.push(requestId);
          });
          const page = await context.newPage();
          const receiptPath = (requestId: string) =>
            '/write-receipts/' + requestId;
          const receiptRoute = (requestId: string) =>
            '**' + receiptPath(requestId) + '?*';
          const receiptResponse =
            (requestId: string) => (response: BrowserResponse) =>
              response.request().method() === 'GET' &&
              new URL(response.url()).pathname.endsWith(receiptPath(requestId));
          function holdReceipt(
            requestId: string,
            phase: 'beforeRead' | 'beforeReply',
          ) {
            let releaseRequest!: () => void;
            let admitted = 0;
            let resumed = 0;
            const held = new Promise<void>((resolve) => {
              releaseRequest = resolve;
            });
            receiptGate = {
              requestId,
              async [phase]() {
                admitted++;
                await held;
                resumed++;
              },
            };
            return {
              arrived: () =>
                expect.poll(() => admitted, { timeout: 5000 }).toBe(1),
              release: releaseRequest,
              async assertFinished(response: BrowserResponse) {
                expect(admitted).toBe(1);
                expect(resumed).toBe(1);
                expect(await response.finished()).toBeNull();
              },
              close() {
                receiptGate = undefined;
                releaseRequest();
              },
            };
          }
          async function retryReceiptWithKeyboard(
            view: Page,
            retry: Locator,
            requestId: string,
            nextControl: Locator,
          ) {
            await retry.waitFor();
            const node = await retry.elementHandle();
            if (!node) throw Error('Receipt retry control is missing');
            const controlState = () =>
              node.evaluate((element) => ({
                focused: document.activeElement === element,
                busy: element.getAttribute('aria-busy'),
                disabled: element.getAttribute('aria-disabled'),
                label: element.textContent?.trim(),
              }));
            await retry.focus();
            const read = holdReceipt(requestId, 'beforeReply');
            let response: BrowserResponse;
            try {
              [response] = await Promise.all([
                view.waitForResponse(receiptResponse(requestId), {
                  timeout: 5000,
                }),
                (async () => {
                  try {
                    await view.keyboard.press('Enter');
                    await read.arrived();
                    await expect.poll(controlState).toEqual({
                      focused: true,
                      busy: 'true',
                      disabled: 'true',
                      label: '正在核对…',
                    });
                    await view.keyboard.press('Enter');
                  } finally {
                    read.release();
                  }
                })(),
              ]);
              await read.assertFinished(response);
            } finally {
              read.close();
            }
            await expect.poll(controlState).toEqual({
              focused: true,
              busy: null,
              disabled: 'true',
              label: '核对结束',
            });
            await view.keyboard.press('Tab');
            await expect
              .poll(() =>
                nextControl.evaluate(
                  (element) =>
                    document.activeElement === element &&
                    element.getClientRects().length > 0,
                ),
              )
              .toBe(true);
            await view
              .getByRole('button', { name: '核对结束', exact: true })
              .waitFor({ state: 'detached' });
            return response;
          }
          let deliverablesUnavailable = true;
          let gateUnreadPreflight: (() => Promise<void>) | undefined;
          const refusedFilters: (string | null)[] = [];
          const deliverablePath = publicationPath.replace(
            '/materials/publications',
            '/deliverables',
          );
          await page.route('**' + deliverablePath + '?*', async (route) => {
            const request = new URL(route.request().url());
            const isList = route.request().method() === 'GET';
            if (isList && !request.searchParams.has('employeeInstanceId')) {
              const gate = gateUnreadPreflight;
              gateUnreadPreflight = undefined;
              await gate?.();
            }
            if (!deliverablesUnavailable || !isList) {
              await route.continue();
              return;
            }
            const original = await route.fetch({ maxRetries: 0 });
            expect(original.status()).toBe(200); // Original Cookie and PostgreSQL checked.
            refusedFilters.push(request.searchParams.get('employeeInstanceId'));
            await route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({
                error: {
                  code: 'DEPENDENCY_UNAVAILABLE',
                  message: '交付成果暂时不可用',
                  requestId: randomUUID(),
                  retryable: true,
                },
              }),
            });
          });
          const memory = await seedPersonalMemoryPair(f.db, p.context, {
            workspaceId: p.selection.workspaceId,
            instanceId: p.selection.employeeInstanceId,
            summary: '发布前先复核摘要',
            details: '这是仅本人可见的记忆正文',
          });
          let sourceReads = 0;
          page.on('request', (request) => {
            if (
              new URL(request.url()).pathname ===
              `/api/v1/memories/${memory.id}/source`
            )
              sourceReads++;
          });
          await page.goto(base + '/fixture/panels');
          const draft = page.getByRole('textbox', { name: '对话草稿' });
          await draft.fill('未发送的原对话草稿');
          const openMemory = page.getByRole('button', {
            name: '记忆',
            exact: true,
          });
          await openMemory.click();
          const memoryPane = page.getByRole('region', { name: '个人记忆' });
          const pending = memoryPane.getByRole('region', { name: '待确认' });
          await pending.getByText(memory.summary, { exact: true }).click();
          const memoryDialog = page.getByRole('dialog');
          await memoryDialog
            .getByText(memory.details!, { exact: true })
            .waitFor();
          expect(sourceReads).toBe(0);
          const actualSource = page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname ===
              `/api/v1/memories/${memory.id}/source`,
          );
          await memoryDialog
            .getByRole('button', { name: '来源', exact: true })
            .click();
          const sourceReceipt = await actualSource;
          expect(sourceReceipt.status()).toBe(200);
          expect(await sourceReceipt.json()).toEqual({
            sourceType: 'user',
            sourceLabel: expect.any(String),
            capturedAt: memory.capturedAt,
          });
          await memoryDialog
            .getByRole('region', { name: '记忆来源' })
            .locator('time')
            .waitFor();
          expect(sourceReads).toBe(1);
          await memoryDialog
            .getByRole('button', { name: '关闭', exact: true })
            .click();
          const confirmation = `**/api/v1/memories/${memory.id}/promote?*`;
          let releaseConfirmation!: () => void;
          const heldConfirmation = new Promise<void>((done) => {
            releaseConfirmation = done;
          });
          await page.route(
            confirmation,
            async (route) => {
              await heldConfirmation;
              await route.continue();
            },
            { times: 1 },
          );
          try {
            await Promise.all([
              page.waitForRequest((request) =>
                new URL(request.url()).pathname.endsWith(
                  `/${memory.id}/promote`,
                ),
              ),
              pending
                .getByRole('button', { name: '确认', exact: true })
                .click(),
            ]);
            await page
              .getByRole('button', { name: '关闭记忆', exact: true })
              .click();
            await memoryPane.waitFor({ state: 'detached' });
            expect(await draft.inputValue()).toBe('未发送的原对话草稿');
            await openMemory.click();
            await pending.getByText(memory.summary, { exact: true }).waitFor();
            releaseConfirmation();
            await memoryPane
              .getByRole('region', { name: '生效中' })
              .getByText(memory.summary, { exact: true })
              .waitFor();
            // A receipt from the closed tab invalidates the new tab's list.
            expect(
              await pending.getByText(memory.summary, { exact: true }).count(),
            ).toBe(0);
            expect(await draft.inputValue()).toBe('未发送的原对话草稿');
          } finally {
            releaseConfirmation();
            await page.unroute(confirmation);
          }
          await page
            .getByRole('button', { name: '交付成果', exact: true })
            .click();

          const files = page.getByRole('region', { name: '交付成果' });
          await files
            .getByRole('alert')
            .filter({ hasText: '交付成果暂时不可用' })
            .waitFor();
          const launchers = page.getByRole('navigation', { name: '面板' });
          expect(await launchers.getAttribute('data-unread')).toBe('unknown');
          const materialsRead = page.waitForResponse(
            (response) =>
              response.request().method() === 'GET' &&
              new URL(response.url()).pathname ===
                publicationPath.replace('/publications', ''),
          );
          await launchers
            .getByRole('button', { name: '企业资料', exact: true })
            .click();
          const materialsReply = await materialsRead;
          expect(materialsReply.status()).toBe(200);
          expect(await materialsReply.finished()).toBeNull();
          await page
            .getByRole('region', { name: '企业资料' })
            .getByRole('heading', { name: '还没有企业资料' })
            .waitFor();
          expect(refusedFilters).toContain(null); // Page's independent unread preflight.
          expect(refusedFilters).toContain(p.selection.employeeInstanceId);
          await launchers
            .getByRole('button', { name: '交付成果', exact: true })
            .click();
          await files
            .getByRole('alert')
            .filter({ hasText: '交付成果暂时不可用' })
            .waitFor();
          deliverablesUnavailable = false;
          await files
            .getByRole('button', { name: '重新加载', exact: true })
            .click();
          await files
            .getByRole('alert')
            .filter({ hasText: '交付成果暂时不可用' })
            .waitFor({ state: 'detached' });
          await expect
            .poll(() => launchers.getAttribute('data-unread'))
            .toBe('0');
          console.info('employee-panel-independent-directory', {
            initialUnread: 'unknown',
            unreadPreflightRefused: refusedFilters.includes(null),
            filePanelRefused: refusedFilters.includes(
              p.selection.employeeInstanceId,
            ),
            materialsStatus: materialsReply.status(),
            filePanelRecovered: true,
          });
          await files
            .getByRole('combobox', { name: '按员工筛选' })
            .selectOption('');
          await files
            .getByRole('button', { name: '我的上传', exact: true })
            .click();
          const options = files.getByRole('button', {
            name: '文件选项 ' + input.fileName,
          });
          await options.click();
          await page
            .getByRole('menuitem', { name: '收藏', exact: true })
            .click();
          await files.getByLabel('已收藏').waitFor();
          expect(
            (
              await p.client.listDeliverables(
                { workspaceId: p.selection.workspaceId, category: 'favorite' },
                signal(),
              )
            ).files.map((file) => file.objectId),
          ).toEqual([original.objectId]);

          const row = files.getByRole('button', {
            name: input.fileName,
            exact: true,
          });
          const disabledQuote = files.getByRole('button', {
            name: '引用到对话 ' + input.fileName,
          });
          expect(await disabledQuote.isDisabled()).toBe(true);
          const captured = async () => ({
            requests: await f.db`select q.request_id
              from allrice_knowledge_save_requests q
              join allrice_knowledge_revisions r on r.id=q.revision_id
              join allrice_knowledge_sources s on s.id=r.knowledge_source_id
              where q.organization_id=${p.context.organizationId} and q.actor_id=${p.context.actor.id}
                and s.workspace_id=${p.selection.workspaceId} and q.operation='upload'
                and q.input->>'originObjectId'=${original.objectId} order by q.request_id`,
            revisions: await f.db`select r.id
              from allrice_workbench_reference_bindings b
              join allrice_knowledge_revisions r on r.knowledge_source_id=b.source_id
              where b.organization_id=${p.context.organizationId} and r.created_by=${p.context.actor.id}
                and r.workspace_id=${p.selection.workspaceId} and b.origin_object_id=${original.objectId} order by r.id`,
          });
          const noCapture = await captured();
          expect(noCapture).toEqual({ requests: [], revisions: [] });
          await row.click();
          const quote = page.getByRole('button', {
            name: '引用到对话',
            exact: true,
          });
          await expect.poll(() => quote.count()).toBe(2);
          for (const control of await quote.all())
            expect(await control.isDisabled()).toBe(true);
          expect(referenceWrites).toBe(0);
          await page
            .getByRole('button', { name: '‹ 交付成果', exact: true })
            .click();
          await files
            .getByRole('combobox', { name: '按员工筛选' })
            .selectOption('');
          await files
            .getByRole('button', { name: '我的上传', exact: true })
            .click();

          expect(await captured()).toEqual(noCapture);

          async function openPublication() {
            await options.click();
            await page
              .getByRole('menuitem', { name: '添加为企业资料', exact: true })
              .click();
          }
          await openPublication();
          const dialog = page.getByRole('dialog', { name: '添加为企业资料' });
          dropPublishReply = true;
          const [interrupted] = await Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === 'POST' &&
                response.url().includes('/materials/publications?'),
              { timeout: 5000 },
            ),
            dialog.getByRole('button', { name: '确认', exact: true }).click(),
          ]);
          expect(interrupted.status()).toBe(200);
          expect(incompleteReply?.writableFinished).toBe(false);
          incompleteReply?.destroy();
          await expect
            .poll(async () => ({
              statuses: publicationStatuses,
              dropped: !dropPublishReply,
              message: await dialog.getByRole('alert').allTextContents(),
            }))
            .toMatchObject({ statuses: [200], dropped: true });
          await dialog
            .getByText('发布结果待核，请按原请求核对。', { exact: true })
            .waitFor({ timeout: 5000 });
          const publishedId = publishWrites[0]!;
          // Chromium gives the new same-origin tab the opener's exact session
          // storage. Its document has no in-memory knowledge of the receipt.
          const [coldPage] = await Promise.all([
            page.waitForEvent('popup'),
            page.evaluate(() => {
              window.open('about:blank', '_blank');
            }),
          ]);
          try {
            expect(await coldPage.opener()).toBe(page);
            unavailableOriginalReceipt = publishedId;
            const [unavailableReceipt] = await Promise.all([
              coldPage.waitForResponse(receiptResponse(publishedId), {
                timeout: 5000,
              }),
              coldPage.goto(base + '/fixture/panels'),
            ]);
            expect(unavailableReceipt.status()).toBe(503);
            expect(await unavailableReceipt.finished()).toBeNull();
            expect(receiptReads).toEqual([]);
            expect(
              await coldPage
                .getByRole('button', {
                  name: '核对原添加为企业资料 ' + original.objectId,
                  exact: true,
                })
                .isVisible(),
            ).toBe(false);
            const confirmed = await retryReceiptWithKeyboard(
              coldPage,
              coldPage.getByRole('button', {
                name: '重试核对',
                exact: true,
              }),
              publishedId,
              coldPage
                .getByRole('region', { name: '交付成果' })
                .getByRole('combobox', { name: '按员工筛选' }),
            );
            expect(confirmed.status()).toBe(200);
            expect(await confirmed.json()).toMatchObject({
              requestId: publishedId,
              operation: 'publish-file',
              status: 'recorded',
              ready: true,
            });
            await coldPage
              .getByRole('status')
              .filter({
                hasText: '原添加为企业资料已完成。 ' + original.objectId,
              })
              .waitFor();
            expect(receiptReads).toEqual([publishedId]);
            expect(publishWrites).toEqual([publishedId]);
            console.info('publication-receipt-fixture-ready-retry', {
              requestId: publishedId,
              unavailable: unavailableReceipt.status(),
              confirmed: confirmed.status(),
              readCount: receiptReads.length,
              publishCount: publishWrites.length,
            });
          } finally {
            unavailableOriginalReceipt = undefined;
            await coldPage.close();
          }
          expect(browserPublicationAttempts).toEqual([publishedId]);
          await dialog
            .getByRole('button', { name: '取消', exact: true })
            .click();
          await openPublication();
          await dialog
            .getByText('原添加为企业资料已完成。', { exact: true })
            .waitFor();
          await dialog
            .getByRole('button', { name: '取消', exact: true })
            .click();
          await dialog.waitFor({ state: 'hidden' });
          expect(receiptReads).toEqual([publishedId, publishedId]);
          expect(publishWrites).toEqual([publishedId]);
          expect(browserPublicationAttempts).toEqual([publishedId]);
          console.info('publication-receipt-fixture-initial-posts', {
            browserAttempts: browserPublicationAttempts.length,
            confirmedWrites: publishWrites.length,
          });
          const recorded = await p.client.readWriteReceipt(
            {
              workspaceId: p.selection.workspaceId,
              requestId: publishedId,
              operation: 'publish-file',
            },
            signal(),
          );
          expect(recorded).toMatchObject({ status: 'recorded', ready: true });
          const catalog = await p.client.listDeliverables(
            {
              workspaceId: p.selection.workspaceId,
              objectId: original.objectId,
            },
            signal(),
          );
          expect(catalog.files[0]?.publication).toMatchObject({
            audience: { scope: 'personal' },
          });
          const materials = () =>
            page
              .getByRole('navigation', { name: '面板' })
              .getByRole('button', { name: '企业资料' })
              .click();
          const openUpload = () =>
            page.getByRole('button', { name: '上传', exact: true }).click();
          const material = page.getByRole('dialog', { name: '上传企业资料' });
          async function selectFile(name: string, text: string) {
            await material.locator('input[type=file]').setInputFiles({
              name,
              mimeType: 'text/plain',
              buffer: Buffer.from(text),
            });
          }
          async function publishMaterial() {
            await material
              .getByRole('button', { name: '发布', exact: true })
              .click();
          }

          if (!recorded.result || !('sourceId' in recorded.result))
            throw Error('The file publication receipt has no original source');
          const sourceId = recorded.result.sourceId;
          await materials();
          const sourceMenu = page.getByRole('button', {
            name: '资料选项 ' + input.fileName,
          });
          await sourceMenu.click();
          await page
            .getByRole('menuitem', { name: '撤销资料', exact: true })
            .click();
          const revoke = page.getByRole('dialog', {
            name: '撤销这份企业资料？',
          });
          dropPublishReply = true;
          await Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === 'POST' &&
                response
                  .url()
                  .includes('/materials/publications/' + sourceId + '?'),
              { timeout: 5000 },
            ),
            revoke
              .getByRole('button', { name: '撤销资料', exact: true })
              .click(),
          ]);
          expect(incompleteReply?.writableFinished).toBe(false);
          incompleteReply?.destroy();
          await revoke
            .getByText('发布结果待核，请按原请求核对。', { exact: true })
            .waitFor();
          expect(publicationActions).toHaveLength(1);
          const withdrawnId = publicationActions[0]!;
          expect(
            await f.db`select status from allrice_knowledge_sources where id=${sourceId}`,
          ).toEqual([{ status: 'archived' }]);
          const retained = page.getByRole('button', {
            name: '核对原撤销 ' + sourceId,
          });
          await page.addInitScript((sourceId) => {
            const remove = Storage.prototype.removeItem;
            Storage.prototype.removeItem = function (key) {
              const prefix = 'allrice:publication-receipts:v2:';
              if (
                key.startsWith(prefix) &&
                JSON.parse(key.slice(prefix.length)).at(-1) === sourceId
              )
                throw new DOMException(
                  'Storage cleanup is unavailable',
                  'QuotaExceededError',
                );
              remove.call(this, key);
            };
          }, sourceId);
          const previousReceipts = receiptReads.length;
          const ongoingReceipt = holdReceipt(withdrawnId, 'beforeReply');
          let allowUnread!: () => void;
          let enteredUnread!: () => void;
          const unreadEntered = new Promise<void>((resolve) => {
            enteredUnread = resolve;
          });
          const unreadReleased = new Promise<void>((resolve) => {
            allowUnread = resolve;
          });
          gateUnreadPreflight = () => {
            enteredUnread();
            return unreadReleased;
          };
          const receiptWire = page.waitForResponse(
            receiptResponse(withdrawnId),
          );
          void receiptWire.catch(() => {});
          try {
            await page.reload();
            await materials();
            await ongoingReceipt.arrived();
            await unreadEntered;
            expect(await launchers.getAttribute('data-unread')).toBe('unknown');
            allowUnread();
            await expect
              .poll(() => launchers.getAttribute('data-unread'))
              .not.toBe('unknown');
            ongoingReceipt.release();
            await ongoingReceipt.assertFinished(await receiptWire);
          } finally {
            gateUnreadPreflight = undefined;
            allowUnread();
            ongoingReceipt.close();
          }
          await sourceMenu.waitFor({ state: 'detached' });
          await page
            .getByRole('status')
            .filter({ hasText: '原撤销已完成。 ' + sourceId })
            .waitFor();
          expect(receiptReads.slice(previousReceipts)).toEqual([withdrawnId]);
          expect(publicationActions).toEqual([withdrawnId]);
          expect(await retained.isVisible()).toBe(false);
          expect(
            await page.evaluate(
              (requestId) =>
                Object.keys(sessionStorage).some(
                  (key) =>
                    key.startsWith('allrice:publication-receipts:v2:') &&
                    (
                      JSON.parse(sessionStorage.getItem(key)!) as {
                        requestId: string;
                        outcome: string;
                      }[]
                    ).some(
                      (entry) =>
                        entry.requestId === requestId &&
                        entry.outcome === 'recorded',
                    ),
                ),
              withdrawnId,
            ),
          ).toBe(true);

          const storage = runtimeFixtureStorage(f.db);
          const put = storage.put.bind(storage);
          const failUploadA = vi
            .spyOn(storage, 'put')
            .mockImplementationOnce(async (object, bytes) => {
              await put(object, bytes);
              throw Error('Upload A acknowledgement lost');
            });
          restoreStoragePut = () => failUploadA.mockRestore();
          handlers = createEmployeePanelsHandlers({
            ...employeePanelsDependencies,
            storage: () => storage,
          });
          await openUpload();
          await selectFile('浏览器企业资料A.txt', '资料 A 的已写字节。');
          await publishMaterial();
          await material
            .getByText('发布结果待核，请按原请求核对。', { exact: true })
            .waitFor();
          const pendingId = publishWrites[1]!;
          expect(publishWrites).toHaveLength(2);
          expect(publicationStatuses[1]).toBe(500);
          await page.reload();
          await materials();
          await openUpload();
          await expect.poll(() => receiptReads.at(-1)).toBe(pendingId);
          await selectFile('浏览器企业资料B.txt', '与 A 无关的正式资料上传。');
          await material
            .getByRole('button', { name: '核对结果', exact: true })
            .waitFor();
          await publishMaterial();
          await page
            .getByRole('status')
            .filter({ hasText: '已发布' })
            .waitFor();
          expect(publishWrites).toHaveLength(3);
          expect(publishWrites[2]).not.toBe(pendingId);
          const uploadedMaterial = await p.client.readWriteReceipt(
            {
              workspaceId: p.selection.workspaceId,
              requestId: publishWrites[2]!,
              operation: 'publish-upload',
            },
            signal(),
          );
          expect(uploadedMaterial).toMatchObject({
            status: 'recorded',
            ready: true,
          });
          await page
            .getByRole('button', { name: '‹ 企业资料', exact: true })
            .click();
          await openUpload();
          await material
            .getByRole('button', { name: '核对结果', exact: true })
            .waitFor();
          await expect.poll(() => receiptReads.at(-1)).toBe(pendingId);
          expect(publishWrites).toHaveLength(3);
          const storedA = await p.client.readWriteReceipt(
            {
              workspaceId: p.selection.workspaceId,
              requestId: pendingId,
              operation: 'publish-upload',
            },
            signal(),
          );
          expect(storedA).toMatchObject({ status: 'recorded', ready: false });
          expect(referenceWrites).toBe(0);

          const receiptFailure = (requestId: string) =>
            page.waitForEvent('requestfailed', {
              predicate: (request) =>
                request.method() === 'GET' &&
                new URL(request.url()).pathname.endsWith(
                  receiptPath(requestId),
                ),
              timeout: 5000,
            });
          async function checkReceipt(button: Locator, requestId: string) {
            const [response] = await Promise.all([
              page.waitForResponse(receiptResponse(requestId)),
              button.click(),
            ]);
            return response;
          }
          async function startUnknownUpload(fileName: string, content: string) {
            await page.route(
              '**/api/v1/d-entry/panels/*/materials/publications?*',
              (route) => route.abort('failed'),
              { times: 1 },
            );
            await selectFile(fileName, content);
            const [unadmitted] = await Promise.all([
              page.waitForRequest(
                (request) =>
                  request.method() === 'POST' &&
                  new URL(request.url()).pathname.endsWith(
                    '/materials/publications',
                  ),
              ),
              publishMaterial(),
            ]);
            return (unadmitted.postDataJSON() as { requestId: string })
              .requestId;
          }
          const independentId = await startUnknownUpload(
            '浏览器企业资料C.txt',
            '与 A 无关且回包未确认的资料。',
          );
          expect(independentId).not.toBe(pendingId);
          expect(publishWrites).toHaveLength(3);
          // The context event observes even the request stopped before the handler.
          expect(browserPublicationAttempts.at(-1)).toBe(independentId);
          console.info('publication-receipt-fixture-keys', {
            A: pendingId,
            C: independentId,
          });
          const postCheckpoint = browserPublicationAttempts.length;
          const waiting = '发布结果待核，请按原请求核对。';
          const formWaiting = material
            .getByRole('alert')
            .filter({ hasText: waiting });
          await formWaiting.waitFor();
          const checkAction = (requestId: string) =>
            material.getByRole('button', {
              name: '核对结果 ' + requestId.slice(0, 8),
              exact: true,
            });
          await checkAction(independentId).waitFor();
          const absentReceipt = await checkReceipt(
            checkAction(independentId),
            independentId,
          );
          expect(absentReceipt.status()).toBe(200);
          expect(await absentReceipt.json()).toMatchObject({
            requestId: independentId,
            status: 'unknown',
          });
          await expect
            .poll(() => checkAction(independentId).isEnabled())
            .toBe(true);

          const openDialog = await material.elementHandle();
          await authorizeFixturePlatformAdministrator(f.db, p.context.actor.id);
          const withdraw = (revision: string) =>
            updateDEntryReleasePolicy(p.context, {
              revision,
              defaultGeneration: '3.x',
              selections: [],
            });
          const restore = (revision: string) =>
            updateDEntryReleasePolicy(p.context, {
              revision,
              defaultGeneration: '3.x',
              selections: [
                {
                  organizationId: p.context.organizationId,
                  personId: p.context.actor.id,
                },
              ],
            });
          const cacheKey = (await page.evaluate(
            (id) =>
              Object.keys(sessionStorage).find(
                (key) =>
                  key.startsWith('allrice:publication-receipts:v2:') &&
                  (
                    JSON.parse(sessionStorage.getItem(key)!) as {
                      requestId: string;
                    }[]
                  ).some((entry) => entry.requestId === id),
              ),
            pendingId,
          ))!;
          expect(cacheKey).toBeDefined();
          const marker =
            'allrice:publication-receipt-denials:v1:' +
            cacheKey +
            '/' +
            pendingId;
          const readCache = (key: string) =>
            page.evaluate((key) => sessionStorage.getItem(key), key);
          const originalCache = await readCache(cacheKey);
          const failNextDenialWrite = () =>
            page.evaluate((marker) => {
              const set = Storage.prototype.setItem;
              let failOnce = true;
              Storage.prototype.setItem = function (key, value) {
                if (key === marker && failOnce) {
                  failOnce = false;
                  throw new DOMException(
                    'Denial write failed',
                    'QuotaExceededError',
                  );
                }
                set.call(this, key, value);
              };
            }, marker);
          await failNextDenialWrite();
          await withdraw('fixture-open-dialog-receipt-withdrawal');
          const readsBeforeOpenDenial = receiptReads.length;
          const deniedInDialog = await checkReceipt(
            checkAction(pendingId),
            pendingId,
          );
          expect(deniedInDialog.status()).toBe(403);
          expect(await openDialog?.evaluate((node) => node.isConnected)).toBe(
            true,
          );
          await material
            .getByRole('status')
            .filter({ hasText: '当前无法核对原发布请求。' })
            .waitFor({ timeout: 5000 });
          expect(await material.isVisible()).toBe(true);
          expect(await openDialog?.evaluate((node) => node.isConnected)).toBe(
            true,
          );
          expect(await material.getByText(pendingId.slice(0, 8)).count()).toBe(
            0,
          );
          expect(receiptReads.slice(readsBeforeOpenDenial)).toEqual([
            pendingId,
          ]);
          expect(await formWaiting.isVisible()).toBe(true);
          expect(await readCache(marker)).toBeNull();
          expect(publishWrites).toHaveLength(3);

          const sideReceipt = (requestId: string) =>
            page.getByRole('button', {
              name: '核对原发布 ' + requestId,
              exact: true,
            });
          const pendingPublication = sideReceipt(pendingId);
          const independentPublication = sideReceipt(independentId);
          const sideWaiting = page
            .getByRole('status')
            .filter({ hasText: waiting });
          const onlyIndependentVisible = async () => {
            expect(await pendingPublication.count()).toBe(0);
            await independentPublication.waitFor({ timeout: 5000 });
          };
          const closeUpload = async () => {
            await material
              .getByRole('button', { name: '取消', exact: true })
              .click();
            await material.waitFor({ state: 'hidden' });
          };
          async function enterWithA(enter: () => Promise<void>) {
            const [response] = await Promise.all([
              page.waitForResponse(receiptResponse(pendingId), {
                timeout: 5000,
              }),
              enter(),
            ]);
            return response;
          }
          async function enterWithAOnHold(
            enter: () => Promise<void>,
            whileHeld: () => Promise<void>,
          ) {
            const gate = holdReceipt(pendingId, 'beforeRead');
            try {
              const response = await enterWithA(async () => {
                try {
                  await enter();
                  await gate.arrived();
                  await whileHeld();
                } finally {
                  gate.release();
                }
              });
              await gate.assertFinished(response);
              return response;
            } finally {
              gate.close();
            }
          }
          const beforeClose = receiptReads.length;
          const deniedAfterClose = await enterWithAOnHold(
            closeUpload,
            async () => {
              await onlyIndependentVisible();
              await page.route(
                receiptRoute(independentId),
                (route) => route.abort('failed'),
                { times: 1 },
              );
              const [failure] = await Promise.all([
                receiptFailure(independentId),
                independentPublication.click(),
              ]);
              expect(failure.failure()).not.toBeNull();
              await sideWaiting.waitFor({ timeout: 5000 });
              expect(receiptReads.slice(beforeClose)).toEqual([]);
              await onlyIndependentVisible();
            },
          );
          expect(deniedAfterClose.status()).toBe(403);
          expect(receiptReads.slice(beforeClose)).toEqual([pendingId]);
          await expect.poll(() => readCache(marker)).toBe('1');
          expect(await readCache(cacheKey)).toBe(originalCache);
          await onlyIndependentVisible();

          async function returnToMaterials() {
            await page
              .getByRole('navigation', { name: '面板' })
              .getByRole('button', { name: '交付成果' })
              .click();
            await materials();
          }
          await restore('fixture-receipt-before-hard-refresh');
          expect((await enterWithA(returnToMaterials)).status()).toBe(200);
          await pendingPublication.waitFor();
          await expect.poll(() => readCache(marker)).toBeNull();
          await failNextDenialWrite();
          await withdraw('fixture-receipt-unpersisted-denial');
          expect(
            (await checkReceipt(pendingPublication, pendingId)).status(),
          ).toBe(403);
          await pendingPublication.waitFor({
            state: 'detached',
            timeout: 5000,
          });
          expect(await readCache(marker)).toBeNull();

          // Reload from only the v2 records. Give C its own authorized response
          // while A is held before its read, then withdraw and let A through.
          await restore('fixture-receipt-fresh-heap-bootstrap');
          await page.reload();
          await files.getByRole('combobox', { name: '按员工筛选' }).waitFor();
          expect(await readCache(marker)).toBeNull();
          const sidebarRetry = page.getByRole('button', {
            name: '重试核对',
            exact: true,
          });
          await page.route(
            receiptRoute(independentId),
            (route) => route.abort('failed'),
            {
              times: 1,
            },
          );
          const beforeFreshRead = receiptReads.length;
          const [freshC, deniedAfterReload, failedFreshRead] =
            await Promise.all([
              page.waitForResponse(receiptResponse(independentId), {
                timeout: 5000,
              }),
              enterWithAOnHold(materials, async () => {
                await sidebarRetry.waitFor();
                expect(await pendingPublication.count()).toBe(0);
                expect(await independentPublication.count()).toBe(0);
                expect(receiptReads.slice(beforeFreshRead)).toEqual([]);
                await sidebarRetry.click();
                await onlyIndependentVisible();
                expect(receiptReads.slice(beforeFreshRead)).toEqual([
                  independentId,
                ]);
                await withdraw('fixture-receipt-fresh-heap-withdrawal');
                await onlyIndependentVisible();
              }),
              receiptFailure(independentId),
            ]);
          expect(failedFreshRead.failure()).not.toBeNull();
          expect(freshC.status()).toBe(200);
          expect(await freshC.json()).toMatchObject({
            requestId: independentId,
            status: 'unknown',
          });
          expect(deniedAfterReload.status()).toBe(403);
          await expect.poll(() => readCache(marker)).toBe('1');
          await onlyIndependentVisible();
          expect(await sidebarRetry.count()).toBe(0);

          const deniedAfterSwitch = await enterWithA(returnToMaterials);
          expect(deniedAfterSwitch.status()).toBe(403);
          await onlyIndependentVisible();

          await page.evaluate((marker) => {
            const remove = Storage.prototype.removeItem;
            let failOnce = true;
            Storage.prototype.removeItem = function (key) {
              if (key === marker && failOnce) {
                failOnce = false;
                throw new DOMException(
                  'Denial removal failed',
                  'QuotaExceededError',
                );
              }
              remove.call(this, key);
            };
          }, marker);
          await restore('fixture-open-dialog-receipt-restored');
          const originalReceipt = await enterWithA(returnToMaterials);
          expect(originalReceipt.status()).toBe(200);
          expect(await originalReceipt.json()).toMatchObject({
            requestId: pendingId,
            status: 'recorded',
            ready: false,
          });
          await pendingPublication.waitFor();
          expect(await readCache(marker)).toBe('1');
          const otherReceipt = await checkReceipt(
            independentPublication,
            independentId,
          );
          expect(otherReceipt.status()).toBe(200);
          expect(await otherReceipt.json()).toMatchObject({
            requestId: independentId,
            status: 'unknown',
          });
          const readsBeforeUnknown = receiptReads.length;
          const unknown = await checkReceipt(pendingPublication, pendingId);
          expect(unknown.status()).toBe(200);
          expect(await unknown.json()).toMatchObject({
            requestId: pendingId,
            status: 'recorded',
            ready: false,
          });
          await expect.poll(() => readCache(marker)).toBeNull();
          expect(await readCache(cacheKey)).toBe(originalCache);
          await expect.poll(() => sideWaiting.count()).toBe(2);
          expect(receiptReads.slice(readsBeforeUnknown)).toEqual([pendingId]);

          const lateIndependent = holdReceipt(independentId, 'beforeReply');
          try {
            const [approvedBeforeWithdrawal] = await Promise.all([
              page.waitForResponse(receiptResponse(independentId), {
                timeout: 5000,
              }),
              (async () => {
                try {
                  await independentPublication.click();
                  await lateIndependent.arrived();
                  expect(receiptReads.at(-1)).toBe(independentId);
                  await withdraw('fixture-browser-receipt-withdrawal');
                  const readsBeforeDenial = receiptReads.length;
                  const denied = await checkReceipt(
                    pendingPublication,
                    pendingId,
                  );
                  expect(denied.status()).toBe(403);
                  await pendingPublication.waitFor({
                    state: 'detached',
                    timeout: 5000,
                  });
                  expect(receiptReads.slice(readsBeforeDenial)).toEqual([
                    pendingId,
                  ]);
                  expect(await independentPublication.isVisible()).toBe(true);
                  expect(await independentPublication.isDisabled()).toBe(true);
                } finally {
                  lateIndependent.release();
                }
              })(),
            ]);
            await lateIndependent.assertFinished(approvedBeforeWithdrawal);
            expect(approvedBeforeWithdrawal.status()).toBe(200);
            expect(await approvedBeforeWithdrawal.json()).toMatchObject({
              requestId: independentId,
              status: 'unknown',
            });
          } finally {
            lateIndependent.close();
          }
          expect(
            await page.getByText(pendingId, { exact: false }).count(),
          ).toBe(0);
          expect(await independentPublication.isVisible()).toBe(true);
          await expect
            .poll(() => independentPublication.isEnabled())
            .toBe(true);
          expect(await sideWaiting.count()).toBe(1);
          expect(publishWrites).toHaveLength(3);
          expect(browserPublicationAttempts.slice(postCheckpoint)).toEqual([]);

          await restore('fixture-original-publication-completes');
          expect((await enterWithA(returnToMaterials)).status()).toBe(200);
          expect(
            (
              await checkReceipt(independentPublication, independentId)
            ).status(),
          ).toBe(200);
          await expect.poll(() => sideWaiting.count()).toBe(2);
          const originalReservation = storedA.result;
          if (!originalReservation || !('revisionId' in originalReservation))
            throw Error('Original upload reservation has no revision');
          // The original reservation's immutable bytes were written before its
          // provider acknowledgement was lost. Finish that reservation in PG.
          await completeReferenceUpload(
            p.context,
            p.selection.workspaceId,
            originalReservation.revisionId,
          );
          await openUpload();
          await material
            .getByRole('status')
            .filter({ hasText: '原发布已完成。' })
            .waitFor();
          const currentFormId = await startUnknownUpload(
            '浏览器企业资料D.txt',
            '在当前弹窗里等待核对的独立上传。',
          );
          expect([pendingId, independentId]).not.toContain(currentFormId);
          console.info('publication-receipt-fixture-current-form', {
            D: currentFormId,
          });
          await formWaiting.waitFor();
          const currentDialog = await material.elementHandle();
          await withdraw('fixture-current-form-receipt-withdrawal');
          const deniedCurrentForm = await checkReceipt(
            checkAction(currentFormId),
            currentFormId,
          );
          expect(deniedCurrentForm.status()).toBe(403);
          await formWaiting.waitFor({ state: 'detached', timeout: 5000 });
          expect(
            await currentDialog?.evaluate((node) => node.isConnected),
          ).toBe(true);
          const [lastDenial] = await Promise.all([
            page.waitForResponse(receiptResponse(currentFormId), {
              timeout: 5000,
            }),
            closeUpload(),
          ]);
          expect(lastDenial.status()).toBe(403);
          await onlyIndependentVisible();
          expect(await sideReceipt(currentFormId).count()).toBe(0);
          expect(await sideWaiting.count()).toBe(1);

          // A fresh unverified C can be retried in the original dialog too.
          await restore('fixture-modal-unverified-retry');
          await page.reload();
          await files.getByRole('combobox', { name: '按员工筛选' }).waitFor();
          await page.route(
            receiptRoute(independentId),
            (route) => route.abort('failed'),
            {
              times: 2,
            },
          );
          const [, sideD] = await Promise.all([
            receiptFailure(independentId),
            page.waitForResponse(receiptResponse(currentFormId), {
              timeout: 5000,
            }),
            materials(),
          ]);
          expect(sideD.status()).toBe(200);
          expect(await sideD.finished()).toBeNull();
          await sideReceipt(currentFormId).waitFor();
          await sidebarRetry.waitFor();
          const [, dialogD] = await Promise.all([
            receiptFailure(independentId),
            page.waitForResponse(receiptResponse(currentFormId), {
              timeout: 5000,
            }),
            openUpload(),
          ]);
          expect(dialogD.status()).toBe(200);
          expect(await dialogD.finished()).toBeNull();
          const modalRetry = material.getByRole('button', {
            name: '重试核对',
            exact: true,
          });
          await modalRetry.waitFor();
          await checkAction(currentFormId).waitFor();
          expect(
            await material.getByText(independentId.slice(0, 8)).count(),
          ).toBe(0);
          const beforeModalRetry = receiptReads.length;
          const modalRetryResult = await retryReceiptWithKeyboard(
            page,
            modalRetry,
            independentId,
            material.getByRole('button', { name: '关闭', exact: true }),
          );
          expect(modalRetryResult.status()).toBe(200);
          expect(await modalRetryResult.json()).toMatchObject({
            requestId: independentId,
            status: 'unknown',
          });
          expect(receiptReads.slice(beforeModalRetry)).toEqual([independentId]);
          expect(browserPublicationAttempts.slice(postCheckpoint)).toEqual([
            currentFormId,
          ]);
          expect(publishWrites).toHaveLength(3);
          await page.unrouteAll({ behavior: 'wait' });
          console.info('publication-receipt-fixture-handoff', {
            A: pendingId,
            C: independentId,
            afterClose: deniedAfterClose.status(),
            afterReload: {
              A: deniedAfterReload.status(),
              C: freshC.status(),
            },
            heldOriginalReadsFinished: 3,
            delayedReply: { A: 403, C: 200 },
            unverifiedRetries: {
              sidebar: freshC.status(),
              dialog: modalRetryResult.status(),
            },
            originalRequestsRepeated: 0,
            serverPublicationWrites: publishWrites.length,
          });
          await context.close();
        } finally {
          await browser?.close();
          restoreStoragePut?.();
          incompleteReply?.destroy();
          incompleteReply = undefined;
          handlers = createEmployeePanelsHandlers({
            ...employeePanelsDependencies,
            storage: () => runtimeFixtureStorage(f.db),
          });
          fixtureDocument = undefined;
          fixtureAssets.clear();
          dropPublishReply = false;
        }
      },
    );
    it('distinguishes the original upload validation response from an unknown write', async () => {
      const p = await person();
      await release(p);
      const input = {
        ...uploadInput(p),
        contentBase64: '',
        origin: 'upload' as const,
        purpose: '',
        audience: { scope: 'personal' as const, departmentIds: [] },
      };
      const response = p.client.publishUpload(input, signal());
      await expect(response).rejects.toBeInstanceOf(
        EmployeePanelsWriteRejectedError,
      );
      await expect(response).rejects.toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
      expect(
        await p.client.readWriteReceipt(
          {
            workspaceId: input.workspaceId,
            requestId: input.requestId,
            operation: 'publish-upload',
          },
          signal(),
        ),
      ).toMatchObject({ status: 'unknown', result: null });
    });
    function modelCall(
      p: Awaited<ReturnType<typeof person>>,
      threadId: string,
    ) {
      return {
        provider: 'deepseek',
        context: p.context,
        employeeInstanceId: p.selection.employeeInstanceId,
        employeeRelease: p.versionId,
        allriceThreadRef: threadId,
      } as ModelCallBinding;
    }
    function referenceMessage(threadId: string, pin: EmployeeFileMentionPin) {
      const id = randomUUID() as GatewayModelInput['messages'][number]['id'];
      return [
        {
          id,
          role: 'user',
          source: { kind: 'user' },
          content: [
            {
              type: 'text',
              text:
                'Read this file.\n' +
                encodeEmployeeFileMention({
                  threadId,
                  label: 'Fixture file',
                  pin,
                }),
            },
          ],
        },
      ] satisfies GatewayModelInput['messages'];
    }
    it('rechecks a sealed file quote after queued publication withdrawal and denies other employees and organizations before reading bytes', async () => {
      const p = await person();
      const other = await person();
      const peer = await createEmployeeInstance(p.context, {
        workspaceId: p.selection.workspaceId,
        assignmentId: p.selection.employeeInstanceId,
        requestId: randomUUID(),
        profile: { name: 'Another employee under the same person' },
      });
      await release(p, other);
      const thread = await createChatSession(p.context, p.selection, {
        executionGeneration: '4.0',
      });
      const foreignThread = await createChatSession(
        other.context,
        other.selection,
        { executionGeneration: '4.0' },
      );
      const text = 'original-model-excerpt-' + randomUUID();
      const source = await p.client.uploadDeliverable(
        uploadInput(p, 'record.txt', text),
        signal(),
      );
      const published = await p.client.publishFile(
        {
          workspaceId: p.selection.workspaceId,
          origin: 'file',
          objectId: source.objectId,
          requestId: randomUUID(),
          purpose: 'Fixed private document',
          audience: { scope: 'personal', departmentIds: [] },
        },
        signal(),
      );
      await processed(published.revisionId, text);
      const { selection } = await p.client.selectMaterial(
        {
          workspaceId: p.selection.workspaceId,
          revisionId: published.revisionId,
        },
        signal(),
      );
      const pin = {
        kind: 'material' as const,
        sourceId: selection.sourceId,
        revisionId: selection.revisionId,
        revision: selection.revision,
        digest: selection.digest,
        checksum: selection.checksum,
      };
      const storage = runtimeFixtureStorage(f.db);
      const get = vi.fn(storage.get.bind(storage));
      const read = createProductionFileMentionContext({ get });
      const call = modelCall(p, thread.id);
      const messages = referenceMessage(thread.id, pin);
      await expect(
        read({ ...call, employeeInstanceId: peer.id }, messages, signal()),
      ).rejects.toThrow();
      await expect(
        read(
          modelCall(other, foreignThread.id),
          referenceMessage(foreignThread.id, pin),
          signal(),
        ),
      ).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();
      const prepared = await read(call, messages, signal());
      expect(JSON.stringify(messages)).not.toContain(text);
      expect(JSON.stringify(prepared?.messages)).toContain(text);
      const dispatch = vi.fn(async () => {});
      await prepared!.withCurrent(signal(), undefined, dispatch);
      expect(dispatch).toHaveBeenCalledTimes(1);
      dispatch.mockClear();
      const catalog = await p.client.queryMaterials(
        { workspaceId: p.selection.workspaceId, query: {} },
        signal(),
      );
      const row = catalog.references.find(
        ({ revisionId }) => revisionId === published.revisionId,
      )!;
      await p.client.changePublication(
        {
          sourceId: published.sourceId,
          body: {
            workspaceId: p.selection.workspaceId,
            requestId: randomUUID(),
            expectedRevision: row.publication!.audienceRevision,
            action: 'revoke',
          },
        },
        signal(),
      );
      await expect(
        prepared!.withCurrent(signal(), undefined, dispatch),
      ).rejects.toThrow();
      expect(dispatch).not.toHaveBeenCalled();
      await expect(read(call, messages, signal())).rejects.toThrow();
      expect(get).toHaveBeenCalledTimes(1);
    });
    it('reads an unprocessed original PDF delivery on its first call without a reference-library copy', async () => {
      const p = await person();
      await release(p);
      const thread = await createChatSession(p.context, p.selection, {
        executionGeneration: '4.0',
      });
      const marker = 'FIRST_NATIVE_PDF';
      const stream = 'BT /F1 12 Tf 40 100 Td (' + marker + ') Tj ET';
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream.replace('FIRST', 'LATER')}\nendstream`,
      ];
      let pdf = '%PDF-1.4\n';
      const offsets = objects.map((object, i) => {
        const offset = Buffer.byteLength(pdf);
        pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
        return offset;
      });
      const xref = Buffer.byteLength(pdf);
      pdf +=
        'xref\n0 8\n0000000000 65535 f \n' +
        offsets
          .map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n')
          .join('') +
        `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      const bytes = Buffer.from(pdf);
      const { objectId } = await p.client.uploadDeliverable(
        {
          ...uploadInput(p, 'first.pdf'),
          mediaType: 'application/pdf',
          contentBase64: bytes.toString('base64'),
        },
        signal(),
      );
      await f.db`insert into allrice_deliverable_versions
        (id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format)
        values (${randomUUID()},${p.context.organizationId},${p.selection.workspaceId},${p.context.actor.id},
        ${objectId},${randomUUID()},1,${thread.id},'first.pdf','pdf')`;
      const read = createProductionFileMentionContext(
        runtimeFixtureStorage(f.db),
      );
      const pin = {
        kind: 'deliverable' as const,
        objectId,
        checksum: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      };
      const prepared = await read(
        modelCall(p, thread.id),
        referenceMessage(thread.id, pin),
        signal(),
      );
      expect(JSON.stringify(prepared?.messages)).toContain(marker);
      expect(JSON.stringify(prepared?.messages)).not.toContain(
        'LATER_NATIVE_PDF',
      );
      const added = prepared!.messages[0]!.content.at(-1);
      if (added?.type !== 'text') throw Error('Missing file reference content');
      const next = JSON.parse(added.text.slice(added.text.indexOf('{'))).next;
      expect(typeof next).toBe('string');
      const nextPage = await read(
        modelCall(p, thread.id),
        [
          {
            ...prepared!.messages[0]!,
            content: [{ type: 'text', text: next }],
          },
        ],
        signal(),
      );
      expect(JSON.stringify(nextPage?.messages)).toContain('LATER_NATIVE_PDF');
      expect(JSON.stringify(nextPage?.messages)).not.toContain(marker);

      const dispatch = vi.fn(async () => {});
      await prepared!.withCurrent(signal(), undefined, dispatch);
      expect(dispatch).toHaveBeenCalledTimes(1);
      const [copies] =
        await f.db`select count(*)::int as count from allrice_knowledge_revisions where organization_id=${p.context.organizationId}`;
      expect(copies?.count).toBe(0);
    });
    it('lists the validated directory of an owned ZIP delivery without exposing member text', async () => {
      const p = await person();
      await release(p);
      const thread = await createChatSession(p.context, p.selection, {
        executionGeneration: '4.0',
      });
      const bytes = await createFileArchive([
        {
          path: 'quarter/notes.txt',
          bytes: Buffer.from('unexpanded member body'),
        },
      ]);
      const { objectId } = await p.client.uploadDeliverable(
        {
          ...uploadInput(p, 'evidence.zip'),
          mediaType: 'application/zip',
          contentBase64: Buffer.from(bytes).toString('base64'),
        },
        signal(),
      );
      await f.db`insert into allrice_deliverable_versions
        (id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format)
        values (${randomUUID()},${p.context.organizationId},${p.selection.workspaceId},${p.context.actor.id},
        ${objectId},${randomUUID()},1,${thread.id},'evidence.zip','zip')`;
      const catalog = await p.client.listDeliverables(
        {
          workspaceId: p.selection.workspaceId,
          category: 'artifact',
          mention: true,
        },
        signal(),
      );
      expect(catalog.quotableFileIds).toContain(objectId);
      const read = createProductionFileMentionContext(
        runtimeFixtureStorage(f.db),
      );
      const pin = {
        kind: 'deliverable' as const,
        objectId,
        checksum: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      };
      const prepared = await read(
        modelCall(p, thread.id),
        referenceMessage(thread.id, pin),
        signal(),
      );
      expect(JSON.stringify(prepared?.messages)).toContain('quarter/notes.txt');
      expect(JSON.stringify(prepared?.messages)).not.toContain(
        'unexpanded member body',
      );
      const dispatch = vi.fn(async () => {});
      await prepared!.withCurrent(signal(), undefined, dispatch);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
    it('uploads independent same-name files, favorites all employees, publishes a fixed copy and rejects its exact selection after revoke without B/MCP/VM', async () => {
      const p = await person();
      await release(p);
      const input = uploadInput(p),
        first = await p.client.uploadDeliverable(input, signal());
      const replay = await p.client.uploadDeliverable(input, signal());
      expect(replay).toEqual(first);
      const second = await p.client.uploadDeliverable(
        { ...input, requestId: randomUUID() },
        signal(),
      );
      expect(second.objectId).not.toBe(first.objectId);
      const list = await p.client.listDeliverables(
        { workspaceId: p.selection.workspaceId, category: 'upload' },
        signal(),
      );
      expect(list.viewerId).toBe(p.context.actor.id);
      expect(list.files.map((file) => file.fileName).sort()).toEqual([
        '同名.txt',
        '同名（2）.txt',
      ]);
      expect(list.quotableFileIds.sort()).toEqual(
        [first.objectId, second.objectId].sort(),
      );
      expect(
        await p.client.favorite(
          {
            workspaceId: p.selection.workspaceId,
            objectId: first.objectId,
            body: { favorite: true },
          },
          signal(),
        ),
      ).toEqual({
        viewerId: p.context.actor.id,
        objectId: first.objectId,
        favorite: true,
      });
      expect(
        (
          await p.client.listDeliverables(
            { workspaceId: p.selection.workspaceId, category: 'favorite' },
            signal(),
          )
        ).files.map((file) => file.objectId),
      ).toEqual([first.objectId]);
      const requestId = randomUUID(),
        published = await p.client.publishFile(
          {
            origin: 'file',
            workspaceId: p.selection.workspaceId,
            objectId: first.objectId,
            requestId,
            purpose: '固定资料',
            audience: { scope: 'personal', departmentIds: [] },
          },
          signal(),
        );
      const text = Buffer.from(input.contentBase64, 'base64').toString();
      await processed(published.revisionId, text);
      const selected = await p.client.selectMaterial(
        {
          workspaceId: p.selection.workspaceId,
          revisionId: published.revisionId,
        },
        signal(),
      );
      expect(selected.selection.revisionId).toBe(published.revisionId);
      const downloaded = await p.client.downloadMaterial(
        {
          workspaceId: p.selection.workspaceId,
          revisionId: published.revisionId,
        },
        signal(),
      );
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(
        Buffer.from(input.contentBase64, 'base64'),
      );
      const fixed = await p.client.queryMaterials(
        { workspaceId: p.selection.workspaceId, query: { query: '收款' } },
        signal(),
      );
      expect(fixed.references.map((value) => value.revisionId)).toContain(
        published.revisionId,
      );
      expect(fixed.fullTextCoverage.ready).toBeGreaterThan(0);
      const current = fixed.references.find(
        (reference) => reference.revisionId === published.revisionId,
      )!;
      await p.client.changePublication(
        {
          sourceId: published.sourceId,
          body: {
            workspaceId: p.selection.workspaceId,
            requestId: randomUUID(),
            expectedRevision: current.publication!.audienceRevision,
            action: 'revoke',
          },
        },
        signal(),
      );
      await expect(
        p.client.selectMaterial(
          {
            workspaceId: p.selection.workspaceId,
            revisionId: published.revisionId,
          },
          signal(),
        ),
      ).rejects.toBeInstanceOf(ReferenceSelectionUnavailableError);
      expect(
        (
          await p.client.listDeliverables(
            { workspaceId: p.selection.workspaceId },
            signal(),
          )
        ).files,
      ).toHaveLength(2);
      expect(
        await f.db`select id from allrice_runs where organization_id=${p.context.organizationId}`,
      ).toHaveLength(0);
      expect(
        await f.db`select id from allrice_jobs where organization_id=${p.context.organizationId}`,
      ).toHaveLength(0);
    });
    it('captures a personal exact reference before processing and returns its exact pending/prepared identity', async () => {
      const p = await person();
      await release(p);
      const input = uploadInput(p),
        file = await p.client.uploadDeliverable(input, signal());
      const captured = await p.client.captureReference(
        {
          workspaceId: p.selection.workspaceId,
          objectId: file.objectId,
          requestId: randomUUID(),
        },
        signal(),
      );
      expect(captured.reference.processing).toBe('saved');
      expect(captured.reference.checksum).toBe(
        'sha256:' +
          createHash('sha256')
            .update(Buffer.from(input.contentBase64, 'base64'))
            .digest('hex'),
      );
      expect(
        await p.client.readPreparedReference(
          {
            workspaceId: p.selection.workspaceId,
            sourceId: captured.reference.sourceId,
            revisionId: captured.reference.revisionId,
          },
          signal(),
        ),
      ).toEqual(captured.reference);
      await expect(
        p.client.readPreparedReference(
          {
            workspaceId: p.selection.workspaceId,
            sourceId: randomUUID(),
            revisionId: captured.reference.revisionId,
          },
          signal(),
        ),
      ).rejects.toThrow();
    });
    it('exposes real original-key receipts and leaves missing receipts unknown without writing', async () => {
      const p = await person();
      await release(p);
      const input = uploadInput(p),
        object = await p.client.uploadDeliverable(input, signal());
      const receipt = await readEmployeePanelsWriteReceipt(
        p.selection,
        {
          workspaceId: p.selection.workspaceId,
          requestId: input.requestId,
          operation: 'upload',
        },
        signal(),
        p.options,
      );
      expect(receipt).toMatchObject({
        status: 'recorded',
        ready: true,
        result: object,
      });
      const before =
        await f.db`select id from allrice_storage_objects where owner_id=${p.context.actor.id}`;
      const unknown = await readEmployeePanelsWriteReceipt(
        p.selection,
        {
          workspaceId: p.selection.workspaceId,
          requestId: randomUUID(),
          operation: 'upload',
        },
        signal(),
        p.options,
      );
      expect(unknown).toMatchObject({
        status: 'unknown',
        result: null,
        ready: null,
        inputDigest: null,
      });
      expect(
        await f.db`select id from allrice_storage_objects where owner_id=${p.context.actor.id}`,
      ).toEqual(before);
    });
    it('reads fixed previews, source pages and complete file downloads from owner names and bytes', async () => {
      const p = await person();
      await release(p);
      const input = uploadInput(p),
        file = await p.client.uploadDeliverable(input, signal());
      const preview = await p.client.previewDeliverable(
        {
          workspaceId: p.selection.workspaceId,
          objectId: file.objectId,
          fileName: 'forged.pdf',
        },
        signal(),
      );
      expect(preview).toMatchObject({
        kind: 'text',
        text: '收款口径。\n中文第二行。',
        offset: 1,
      });
      const page = await p.client.previewDeliverable(
        {
          workspaceId: p.selection.workspaceId,
          objectId: file.objectId,
          fileName: 'ignored',
          source: true,
          offset: 2,
        },
        signal(),
      );
      expect(page).toMatchObject({
        kind: 'text',
        text: '中文第二行。',
        offset: 2,
        eof: true,
      });
      const bytes = await p.client.downloadDeliverable(
        { workspaceId: p.selection.workspaceId, objectId: file.objectId },
        signal(),
      );
      expect(Buffer.from(await bytes.arrayBuffer())).toEqual(
        Buffer.from(input.contentBase64, 'base64'),
      );
    });
    it('offers every active company department for personal and department publishers without widening maintenance options', async () => {
      for (const level of ['personal', 'department'] as const) {
        const p = await person();
        await release(p);
        const a = randomUUID(),
          b = randomUUID(),
          archived = randomUUID();
        for (const [id, name] of [
          [a, 'A'],
          [b, 'B'],
          [archived, 'Old'],
        ])
          await f.db`insert into allrice_departments(id,organization_id,name,create_request_id,create_name,archived_at)
            values(${id!},${p.context.organizationId},${name!},${randomUUID()},${name!},${id === archived ? new Date() : null})`;
        await f.db`insert into allrice_organization_people(organization_id,user_id,display_name,department_id,content_maintenance_level)
          values(${p.context.organizationId},${p.context.actor.id},'Publisher',${a},${level})
          on conflict(organization_id,user_id) do update set department_id=excluded.department_id,content_maintenance_level=excluded.content_maintenance_level`;
        const maintenance = await referenceLibraryOptions(
          p.context,
          p.selection.workspaceId,
        );
        expect(
          maintenance.departments.map((department) => department.id),
        ).toEqual([a]);
        const options = await p.client.publicationOptions(
          { workspaceId: p.selection.workspaceId },
          signal(),
        );
        expect(options.viewerId).toBe(p.context.actor.id);
        expect(options.options).toMatchObject({
          writable: true,
          maintenanceLevel: level,
          departmentId: a,
        });
        expect(
          options.options.departments.map((department) => department.id),
        ).toEqual([a, b]);
        const published = await p.client.publishUpload(
          {
            ...uploadInput(p, '跨部门.txt'),
            origin: 'upload',
            purpose: '发布到B',
            audience: { scope: 'departments', departmentIds: [b] },
          },
          signal(),
        );
        const query = await p.client.queryMaterials(
          {
            workspaceId: p.selection.workspaceId,
            query: { sourceId: published.sourceId },
          },
          signal(),
        );
        expect(query.options.departments).toEqual(options.options.departments);
        expect(query.references[0]?.publication?.audience).toEqual({
          scope: 'departments',
          departmentIds: [b],
        });
        expect(
          await f.db`select id from allrice_runs where organization_id=${p.context.organizationId}`,
        ).toHaveLength(0);
      }
    });
    it('publishes an upload, returns true options/current viewer and preserves metadata CAS and retry', async () => {
      const p = await person();
      await release(p);
      const input = uploadInput(p, '资料.txt');
      const value = {
        origin: 'upload' as const,
        ...input,
        purpose: '原用途',
        audience: { scope: 'personal' as const, departmentIds: [] },
      };
      const saved = await p.client.publishUpload(value, signal());
      const options = await p.client.publicationOptions(
        { workspaceId: p.selection.workspaceId },
        signal(),
      );
      expect(options.viewerId).toBe(p.context.actor.id);
      expect(options.options.workspaceId).toBe(p.selection.workspaceId);
      const query = await p.client.queryMaterials(
        {
          workspaceId: p.selection.workspaceId,
          query: { sourceId: saved.sourceId },
        },
        signal(),
      );
      const revision = query.references[0]!;
      await p.client.changePublication(
        {
          sourceId: saved.sourceId,
          body: {
            workspaceId: p.selection.workspaceId,
            requestId: randomUUID(),
            action: 'edit',
            expectedRevision: revision.publication!.audienceRevision,
            purpose: '新用途',
            audience: value.audience,
          },
        },
        signal(),
      );
      expect(
        (
          await p.client.queryMaterials(
            {
              workspaceId: p.selection.workspaceId,
              query: { sourceId: saved.sourceId },
            },
            signal(),
          )
        ).references[0]!.purpose,
      ).toBe('新用途');
      await expect(
        p.client.changePublication(
          {
            sourceId: saved.sourceId,
            body: {
              workspaceId: p.selection.workspaceId,
              requestId: randomUUID(),
              action: 'edit',
              expectedRevision: revision.publication!.audienceRevision,
              purpose: '过期用途',
              audience: value.audience,
            },
          },
          signal(),
        ),
      ).rejects.toBeInstanceOf(EmployeePanelsWriteUnknownError);
      await f.db`update allrice_knowledge_processing set state='failed',failure='synthetic failure' where revision_id=${saved.revisionId}`;
      await p.client.changeSource(
        {
          sourceId: saved.sourceId,
          body: {
            workspaceId: p.selection.workspaceId,
            requestId: randomUUID(),
            expectedRevision: revision.revision,
            action: 'retry',
          },
        },
        signal(),
      );
      expect(
        (
          await p.client.readPreparedReference(
            { workspaceId: p.selection.workspaceId, ...saved },
            signal(),
          )
        ).processing,
      ).toBe('saved');
      const preview = await p.client.previewMaterial(
        { workspaceId: p.selection.workspaceId, revisionId: saved.revisionId },
        signal(),
      );
      expect(preview).toMatchObject({ kind: 'text' });
    });
    it('checks the selected workspace of an unscoped Cookie against current membership without replacing an explicit scope', async () => {
      const p = await person();
      await release(p);
      expect(await authenticateSession(p.login.token)).toMatchObject({
        workspaceId: null,
      });
      const first = await raw(p, '/deliverables');
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        viewerId: p.context.actor.id,
      });
      const otherWorkspaceId = randomUUID();
      await f.db`insert into allrice_workspaces(id,organization_id,slug,name)
        values(${otherWorkspaceId},${p.context.organizationId},${otherWorkspaceId},'Other workspace')`;
      const explicit = await raw(p, '/deliverables', {
        headers: { 'x-allrice-workspace-id': otherWorkspaceId },
      });
      expect(explicit.status).toBe(403);
      await explicit.text();
      await f.db`update allrice_memberships set workspace_id=${p.selection.workspaceId}
        where user_id=${p.context.actor.id} and organization_id=${p.context.organizationId}`;
      const permitted = await raw(p, '/deliverables');
      expect(permitted.status).toBe(200);
      expect(await permitted.json()).toMatchObject({
        viewerId: p.context.actor.id,
      });
      await f.db`update allrice_memberships set workspace_id=${otherWorkspaceId}
        where user_id=${p.context.actor.id} and organization_id=${p.context.organizationId}`;
      const removed = await raw(p, '/deliverables');
      expect(removed.status).toBe(403);
      await removed.text();
    });
    it('uses the application all-enabled policy without B, Run, VM or old module binding and ignores browser release claims', async () => {
      const p = await person();
      await release(p);
      expect(
        await f.db`select module_id from allrice_employee_module_bindings where instance_id=${p.selection.employeeInstanceId}`,
      ).toEqual([]);
      const headers = {
        'x-allrice-release-sha': 'f'.repeat(40),
        'x-allrice-builtin-modules': 'none',
        'x-allrice-module-enabled': 'false',
      };
      const listing = await raw(p, '/deliverables', { headers });
      expect(listing.status).toBe(200);
      expect(await listing.json()).toMatchObject({
        viewerId: p.context.actor.id,
        files: [],
      });
      const object = await p.client.uploadDeliverable(uploadInput(p), signal());
      // Adversarial old carrier rows are not the newly approved builtin policy.
      for (const moduleId of ['deliverables', 'enterprise-materials'])
        await f.db`insert into allrice_employee_module_bindings
          (organization_id,workspace_id,owner_id,instance_id,module_id,contract_version,content_version,digest,enabled_at,revoked_at)
          values(${p.context.organizationId},${p.selection.workspaceId},${p.context.actor.id},${p.selection.employeeInstanceId},${moduleId},1,'0.0.0',${'sha256:' + '0'.repeat(64)},'2000-01-01','2000-01-02')`;
      const published = await p.client.publishFile(
        {
          origin: 'file',
          workspaceId: p.selection.workspaceId,
          objectId: object.objectId,
          requestId: randomUUID(),
          purpose: '',
          audience: { scope: 'personal', departmentIds: [] },
        },
        signal(),
      );
      expect(
        (
          await p.client.queryMaterials(
            {
              workspaceId: p.selection.workspaceId,
              query: { sourceId: published.sourceId },
            },
            signal(),
          )
        ).references[0]?.sourceId,
      ).toBe(published.sourceId);
      const before =
        await f.db`select id from allrice_storage_objects where owner_id=${p.context.actor.id} order by id`;
      const forged = await raw(p, '/deliverables', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...uploadInput(p),
          applicationBuild: { sourceSha: 'a'.repeat(40) },
          builtinModules: { deliverables: true },
        }),
      });
      expect(forged.status).toBe(400);
      await forged.text();
      expect(
        await f.db`select id from allrice_storage_objects where owner_id=${p.context.actor.id} order by id`,
      ).toEqual(before);
      expect(
        await f.db`select id from allrice_runs where organization_id=${p.context.organizationId}`,
      ).toHaveLength(0);
      expect(
        await f.db`select id from allrice_jobs where organization_id=${p.context.organizationId}`,
      ).toHaveLength(0);
      await f.db`update allrice_memberships set active=false where user_id=${p.context.actor.id} and organization_id=${p.context.organizationId}`;
      const denied = await raw(p, '/deliverables', {
        headers: { ...headers, 'x-allrice-builtin-modules': 'all-enabled' },
      });
      expect([401, 403]).toContain(denied.status);
      await denied.text();
    });
    it('checks each Port named authority independently and both modules for a file-origin publication', async () => {
      const p = await person();
      await release(p);
      const platform = employeePanelsDependencies.builtinModules;
      let blocked: BuiltinModuleId | null = 'enterprise-materials';
      const checked: BuiltinModuleId[] = [];
      handlers = createEmployeePanelsHandlers({
        ...employeePanelsDependencies,
        storage: () => runtimeFixtureStorage(f.db),
        builtinModules: {
          async require(input, currentSignal) {
            checked.push(input.moduleId);
            expect(input.context.actor.id).toBe(p.context.actor.id);
            expect(input.identity).toMatchObject({
              personId: p.context.actor.id,
              organizationId: p.context.organizationId,
              employeeInstanceId: p.selection.employeeInstanceId,
            });
            await platform.require(input, currentSignal);
            if (input.moduleId === blocked)
              throw new DataAccessError('authorization_denied');
          },
        },
      });
      try {
        const file = await p.client.uploadDeliverable(uploadInput(p), signal());
        expect(new Set(checked)).toEqual(new Set(['deliverables']));
        const denied = await raw(p, '/materials/options');
        expect(denied.status).toBe(403);
        await denied.text();
        blocked = null;
        checked.length = 0;
        const publication = {
          origin: 'file' as const,
          workspaceId: p.selection.workspaceId,
          objectId: file.objectId,
          requestId: randomUUID(),
          purpose: '',
          audience: { scope: 'personal' as const, departmentIds: [] },
        };
        await p.client.publishFile(publication, signal());
        expect(new Set(checked)).toEqual(
          new Set(['deliverables', 'enterprise-materials']),
        );
        const before =
          await f.db`select * from allrice_knowledge_save_requests where actor_id=${p.context.actor.id} order by request_id`;
        for (const moduleId of [
          'deliverables',
          'enterprise-materials',
        ] as const) {
          blocked = moduleId;
          await expect(
            p.client.publishFile(
              { ...publication, requestId: randomUUID() },
              signal(),
            ),
          ).rejects.toBeInstanceOf(EmployeePanelsWriteUnknownError);
        }
        expect(
          await f.db`select * from allrice_knowledge_save_requests where actor_id=${p.context.actor.id} order by request_id`,
        ).toEqual(before);
      } finally {
        handlers = createEmployeePanelsHandlers({
          ...employeePanelsDependencies,
          storage: () => runtimeFixtureStorage(f.db),
        });
      }
    });
    it.each(['membership', 'resource'] as const)(
      'rejects %s withdrawal during real byte acquisition despite static builtin availability',
      async (kind) => {
        const p = await person();
        await release(p);
        const saved = await p.client.publishUpload(
          {
            ...uploadInput(p),
            origin: 'upload',
            purpose: '',
            audience: { scope: 'personal', departmentIds: [] },
          },
          signal(),
        );
        const revision = (
          await p.client.queryMaterials(
            {
              workspaceId: p.selection.workspaceId,
              query: { sourceId: saved.sourceId },
            },
            signal(),
          )
        ).references[0]!;
        const storage = runtimeFixtureStorage(f.db),
          get = storage.get.bind(storage);
        const reading = vi
          .spyOn(storage, 'get')
          .mockImplementationOnce(async (object) => {
            const bytes = await get(object);
            if (kind === 'membership')
              await f.db`update allrice_memberships set active=false where user_id=${p.context.actor.id} and organization_id=${p.context.organizationId}`;
            else {
              await p.client.changePublication(
                {
                  sourceId: saved.sourceId,
                  body: {
                    workspaceId: p.selection.workspaceId,
                    requestId: randomUUID(),
                    expectedRevision: revision.publication!.audienceRevision,
                    action: 'delete',
                  },
                },
                signal(),
              );
              expect(
                await f.db`select status from allrice_knowledge_sources where id=${saved.sourceId}`,
              ).toEqual([{ status: 'archived' }]);
            }
            return bytes;
          });
        try {
          const response = await raw(
            p,
            `/materials/revisions/${saved.revisionId}/download`,
          );
          expect([401, 403, 404]).toContain(response.status);
          expect(response.headers.get('content-disposition')).toBeNull();
          await response.text();
          expect(reading).toHaveBeenCalledTimes(1);
        } finally {
          reading.mockRestore();
        }
      },
    );
    it('enforces server default-off without creating a thread or generation pin', async () => {
      const p = await person();
      await f.db`delete from allrice_settings where scope_type='system' and key='d_entry_rollout_policy'`;
      const response = await raw(p, '/deliverables');
      expect(response.status).toBe(403);
      await response.text();
      expect(
        await f.db`select id from allrice_chat_sessions where owner_id=${p.context.actor.id}`,
      ).toHaveLength(0);
    });
    it('selects only authenticated current 4.0 threads across the private directory cursor', async () => {
      const p = await person();
      const legacy = await seedLegacyThread(p);
      await release(p);
      const create = () =>
        createChatSession(p.context, p.selection, {
          executionGeneration: '4.0',
        });
      const chosen = await create();
      const selection = await bindDirectoryThread(p, chosen.id);
      const expected = [chosen.id];
      for (let index = 0; index < 51; index++) {
        const session = await create();
        await bindDirectoryThread(p, session.id);
        expected.push(session.id);
      }
      const unbound = await create();
      const archived = await create();
      await bindDirectoryThread(p, archived.id);
      await f.db`update allrice_chat_sessions set archived_at=now() where id=${archived.id}`;
      const rows =
        () => f.db`select id,execution_generation,d_entry_native_root,archived_at
        from allrice_chat_sessions where owner_id=${p.context.actor.id} order by id`;
      const before = await rows();
      const directory = await readDEntryEmployeeDirectory(
        p.context,
        selection,
        signal(),
      );
      expect(directory.viewerId).toBe(p.context.actor.id);
      expect(directory.employees.map(({ instanceId }) => instanceId)).toEqual([
        p.selection.employeeInstanceId,
      ]);
      expect(directory.sessions.map(({ id }) => id).sort()).toEqual(
        expected.sort(),
      );
      expect(directory.sessions.map(({ id }) => id)).not.toContain(legacy);
      expect(directory.sessions.map(({ id }) => id)).not.toContain(unbound.id);
      expect(directory.sessions.map(({ id }) => id)).not.toContain(archived.id);
      await expect(
        readDEntryEmployeeDirectory(
          p.context,
          { ...selection, threadId: legacy },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        readDEntryEmployeeDirectory(
          p.context,
          { ...selection, employeeInstanceId: randomUUID() },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await release();
      await expect(
        readDEntryEmployeeDirectory(p.context, selection, signal()),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(await rows()).toEqual(before);
    });
    it('requires real Cookie, same-origin writes and matching viewer without changing stored files', async () => {
      const p = await person();
      await release(p);
      const missing = await fetch(
        `${base}/api/v1/d-entry/panels/${p.selection.employeeInstanceId}/deliverables?workspaceId=${p.selection.workspaceId}`,
        { headers: { Connection: 'close' } },
      );
      expect(missing.status).toBe(401);
      await missing.text();
      const invalidHeaders: Record<string, string>[] = [
        { Origin: 'https://evil.example' },
        { 'x-allrice-expected-viewer-id': randomUUID() },
      ];
      for (const headers of invalidHeaders) {
        const response = await raw(p, '/deliverables', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(uploadInput(p)),
        });
        expect([403, 409]).toContain(response.status);
        await response.text();
      }
      expect(
        await f.db`select id from allrice_storage_objects where owner_id=${p.context.actor.id}`,
      ).toHaveLength(0);
    });
    it('cannot exchange tenant, panel employee, viewer or directory filter for authority', async () => {
      const p = await person(),
        foreign = await person();
      await release(p, foreign);
      const secret = await foreign.client.uploadDeliverable(
        uploadInput(foreign),
        signal(),
      );
      for (const path of [
        `/api/v1/d-entry/panels/${foreign.selection.employeeInstanceId}/deliverables?workspaceId=${p.selection.workspaceId}`,
        `/api/v1/d-entry/panels/${p.selection.employeeInstanceId}/deliverables?workspaceId=${foreign.selection.workspaceId}`,
        `/api/v1/d-entry/panels/${p.selection.employeeInstanceId}/deliverables/${secret.objectId}/download?workspaceId=${p.selection.workspaceId}`,
      ]) {
        const response = await p.options.fetch(path);
        expect(response.ok).toBe(false);
        await response.text();
      }
      const list = await p.client.listDeliverables(
        {
          workspaceId: p.selection.workspaceId,
          employeeInstanceId: foreign.selection.employeeInstanceId,
        },
        signal(),
      );
      expect(list.files).toEqual([]);
      expect(list.viewerId).toBe(p.context.actor.id);
    });
    it('reads the exact database module binding only from a current 4.0 thread and withholds saved brand data after revocation', async () => {
      const p = await person();
      const legacy = await seedLegacyThread(p);
      await release(p);
      const native = await createChatSession(p.context, p.selection, {
        executionGeneration: '4.0',
      });
      const instanceId = p.selection.employeeInstanceId;
      const cookie = `allrice_session=${p.login.token}`;
      const read = (route: 'modules' | 'brand-media', threadId = native.id) => {
        const query = new URLSearchParams({
          workspaceId: p.selection.workspaceId,
          threadId,
        });
        if (route === 'brand-media') query.set('view', 'topics');
        const handler =
          route === 'modules'
            ? readCapabilityModules
            : readCapabilityBrandMedia;
        return cookieScope.run(cookie, () =>
          handler(
            new Request(
              `${base}/api/v1/d-entry/panels/${instanceId}/${route}?${query}`,
              {
                headers: {
                  'x-allrice-expected-viewer-id': p.context.actor.id,
                  'x-allrice-organization-id': p.context.organizationId,
                  'x-allrice-workspace-id': p.selection.workspaceId,
                },
              },
            ),
            {
              params: Promise.resolve({ panelEmployeeInstanceId: instanceId }),
            },
          ),
        );
      };
      expect((await read('brand-media')).status).toBe(403);
      const { binding } = await addEmployeeInstanceModule(p.context, {
        instanceId,
        workspaceId: p.selection.workspaceId,
        release: brandMediaRelease,
        requestId: randomUUID(),
      });
      const installed = await read('modules');
      expect(installed.status).toBe(200);
      expect(await installed.json()).toEqual({
        instanceId,
        modules: [
          {
            displayName: brandMediaModule.displayName,
            release: binding.release,
            revision: binding.revision,
          },
        ],
      });
      expect((await read('modules', legacy)).status).toBe(403);
      const topics = await read('brand-media');
      expect(topics.status).toBe(200);
      expect(await topics.json()).toEqual({
        view: 'topics',
        items: [],
        nextCursor: null,
      });

      let cookieReads = 0;
      const originalRead = cookieBridge.read;
      cookieBridge.read = async () => {
        const value = await originalRead();
        // The third check is the page authority recheck after the first binding read.
        if (value === cookie && ++cookieReads === 3) {
          const changed =
            await f.db`update allrice_employee_module_bindings set revoked_at=clock_timestamp(),revision=revision+1
            where organization_id=${p.context.organizationId} and workspace_id=${p.selection.workspaceId}
              and owner_id=${p.context.actor.id} and instance_id=${instanceId} and module_id=${brandMediaRelease.moduleId}
            returning revision`;
          expect(changed).toEqual([{ revision: binding.revision + 1 }]);
        }
        return value;
      };
      try {
        const lateRevocation = await read('modules');
        expect(lateRevocation.status).toBe(403);
        expect(await lateRevocation.json()).not.toHaveProperty('modules');
        expect(cookieReads).toBe(3);
      } finally {
        cookieBridge.read = originalRead;
      }
      const revoked = await read('brand-media');
      expect(revoked.status).toBe(403);
      expect(await revoked.json()).not.toHaveProperty('items');
      expect(await (await read('modules')).json()).toEqual({
        instanceId,
        modules: [],
      });
    });
    it('rejects retained Cookie after actual session or membership revocation', async () => {
      for (const kind of ['session', 'membership'] as const) {
        const p = await person();
        await release(p);
        const input = uploadInput(p),
          file = await p.client.uploadDeliverable(input, signal());
        if (kind === 'session')
          await f.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${p.context.sessionId}`;
        else
          await f.db`update allrice_memberships set active=false where user_id=${p.context.actor.id} and organization_id=${p.context.organizationId}`;
        await expect(
          p.client.downloadDeliverable(
            { workspaceId: p.selection.workspaceId, objectId: file.objectId },
            signal(),
          ),
        ).rejects.toThrow();
        await expect(
          p.client.favorite(
            {
              workspaceId: p.selection.workspaceId,
              objectId: file.objectId,
              body: { favorite: true },
            },
            signal(),
          ),
        ).rejects.toThrow();
      }
    });
    it('permits a current read-only member to manage views without granting execute or file writes', async () => {
      const p = await person('viewer');
      await release(p);
      expect(
        (
          await p.client.listDeliverables(
            { workspaceId: p.selection.workspaceId },
            signal(),
          )
        ).files,
      ).toEqual([]);
      const options = await p.client.publicationOptions(
        { workspaceId: p.selection.workspaceId },
        signal(),
      );
      expect(options.options.writable).toBe(false);
      await expect(
        p.client.uploadDeliverable(uploadInput(p), signal()),
      ).rejects.toBeInstanceOf(EmployeePanelsWriteUnknownError);
      expect(
        await f.db`select id from allrice_storage_objects where owner_id=${p.context.actor.id}`,
      ).toHaveLength(0);
    });
    it('does not turn a legacy persisted thread into a 4.0 management scope', async () => {
      const p = await person();
      await release(p);
      const threadId = randomUUID();
      await f.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_instance_id,employee_version_id)
      values(${threadId},${p.context.organizationId},${p.selection.workspaceId},${p.context.actor.id},'Legacy fixed writer',${p.selection.employeeInstanceId},${p.selection.employeeInstanceId},${p.versionId})`;
      const client = createEmployeePanelsHttpClient(
        { ...p.selection, threadId },
        p.options,
      );
      await expect(
        client.listDeliverables(
          { workspaceId: p.selection.workspaceId },
          signal(),
        ),
      ).rejects.toThrow();
      expect(
        await f.db`select execution_generation from allrice_chat_sessions where id=${threadId}`,
      ).toEqual([{ execution_generation: '3.x' }]);
    });
    it('retains pending storage acknowledgement as a reservation and only reads it by its original key', async () => {
      const p = await person();
      await release(p);
      const input = uploadInput(p, 'pending.txt');
      const storage = runtimeFixtureStorage(f.db),
        put = storage.put.bind(storage);
      const failure = vi
        .spyOn(storage, 'put')
        .mockImplementationOnce(async (object, bytes) => {
          await put(object, bytes);
          throw Error('synthetic put ACK lost');
        });
      try {
        await expect(
          p.client.publishUpload(
            {
              ...input,
              origin: 'upload',
              purpose: '',
              audience: { scope: 'personal', departmentIds: [] },
            },
            signal(),
          ),
        ).rejects.toBeInstanceOf(EmployeePanelsWriteUnknownError);
        const receipt = await readEmployeePanelsWriteReceipt(
          p.selection,
          {
            workspaceId: p.selection.workspaceId,
            requestId: input.requestId,
            operation: 'publish-upload',
          },
          signal(),
          p.options,
        );
        expect(receipt).toMatchObject({ status: 'recorded', ready: false });
        if (!receipt.result || !('revisionId' in receipt.result))
          throw Error('original reservation missing');
        const prepared = await p.client.readPreparedReference(
          {
            workspaceId: p.selection.workspaceId,
            sourceId: receipt.result.sourceId,
            revisionId: receipt.result.revisionId,
          },
          signal(),
        );
        expect(prepared.processing).toBe('uploading');
        expect(failure).toHaveBeenCalledTimes(1);
      } finally {
        failure.mockRestore();
      }
    });
    it('rechecks a real release withdrawal after byte acquisition and returns no successful body', async () => {
      const p = await person();
      await release(p);
      const saved = await p.client.uploadDeliverable(uploadInput(p), signal());
      const storage = runtimeFixtureStorage(f.db),
        get = storage.get.bind(storage);
      const read = vi
        .spyOn(storage, 'get')
        .mockImplementationOnce(async (object) => {
          const bytes = await get(object);
          await release();
          return bytes;
        });
      try {
        const response = await raw(
          p,
          `/deliverables/${saved.objectId}/download`,
        );
        expect(response.status).toBe(403);
        expect(response.headers.get('content-disposition')).toBeNull();
        await response.text();
      } finally {
        read.mockRestore();
      }
    });
    it('leaves the exact upload reservation pending when 4.0 eligibility is removed during the storage put', async () => {
      const p = await person();
      await release(p);
      await authorizeFixturePlatformAdministrator(f.db, p.context.actor.id);
      const storage = runtimeFixtureStorage(f.db);
      const put = storage.put.bind(storage);
      const input = uploadInput(p, 'revoked-during-upload.txt');
      const writing = vi
        .spyOn(storage, 'put')
        .mockImplementationOnce(async (object, bytes) => {
          await put(object, bytes);
          await updateDEntryReleasePolicy(p.context, {
            revision: 'fixture-withdraw',
            defaultGeneration: '3.x',
            selections: [],
          });
        });
      try {
        await expect(
          p.client.uploadDeliverable(input, signal()),
        ).rejects.toMatchObject({
          requestId: input.requestId,
          cause: { status: 403 },
        });
        expect(
          await f.db`select o.state
          from allrice_workbench_file_policies p
          join allrice_storage_objects o on o.id=p.object_id
          where p.upload_request_id=${input.requestId}`,
        ).toEqual([{ state: 'pending' }]);
        await release(p);
        const receipt = await p.client.readWriteReceipt(
          {
            workspaceId: p.selection.workspaceId,
            requestId: input.requestId,
            operation: 'upload',
          },
          signal(),
        );
        expect(receipt).toMatchObject({ status: 'recorded', ready: false });
      } finally {
        writing.mockRestore();
      }
    });
    it.each([
      'fresh publish-upload',
      'fresh capture',
      'recovered publish-file',
    ] as const)(
      'sequences %s completion with the real D qualification writer',
      async (scenario) => {
        const p = await person();
        await release(p);
        await authorizeFixturePlatformAdministrator(f.db, p.context.actor.id);
        const original = await p.client.uploadDeliverable(
          uploadInput(p),
          signal(),
        );
        const input = uploadInput(p, '受管资格.txt');
        const audience = { scope: 'personal' as const, departmentIds: [] };
        const operation: Parameters<
          typeof p.client.readWriteReceipt
        >[0]['operation'] =
          scenario === 'fresh capture'
            ? 'capture'
            : scenario === 'fresh publish-upload'
              ? 'publish-upload'
              : 'publish-file';
        const write = () =>
          operation === 'capture'
            ? p.client.captureReference(
                {
                  workspaceId: input.workspaceId,
                  objectId: original.objectId,
                  requestId: input.requestId,
                },
                signal(),
              )
            : operation === 'publish-upload'
              ? p.client.publishUpload(
                  { ...input, origin: 'upload', purpose: '', audience },
                  signal(),
                )
              : p.client.publishFile(
                  {
                    origin: 'file',
                    workspaceId: input.workspaceId,
                    requestId: input.requestId,
                    objectId: original.objectId,
                    purpose: '',
                    audience,
                  },
                  signal(),
                );
        const storage = runtimeFixtureStorage(f.db);
        const put = storage.put.bind(storage),
          get = storage.get.bind(storage);
        let completion = false;
        let withdrawals = 0;
        let pendingObject: string | undefined;
        const writing = vi
          .spyOn(storage, 'put')
          .mockImplementation(async (object, bytes) => {
            await put(object, bytes);
            pendingObject = object.id;
            if (operation === 'publish-file')
              throw Error('independent copy put reply lost');
            completion = true;
          });
        const reading = vi
          .spyOn(storage, 'get')
          .mockImplementation(async (object) => {
            const bytes = await get(object);
            if (operation === 'publish-file' && object.id === pendingObject)
              completion = true;
            return bytes;
          });
        handlers = createEmployeePanelsHandlers({
          ...employeePanelsDependencies,
          storage: () => storage,
          async authorize(context, selection, transaction) {
            if (transaction && completion && withdrawals === 0) {
              withdrawals++;
              await updateDEntryReleasePolicy(p.context, {
                revision: 'fixture-reference-withdraw',
                defaultGeneration: '3.x',
                selections: [],
              });
            }
            return employeePanelsDependencies.authorize(
              context,
              selection,
              transaction,
            );
          },
        });
        try {
          if (operation === 'publish-file')
            await expect(write()).rejects.toBeInstanceOf(
              EmployeePanelsWriteUnknownError,
            );
          await expect(write()).rejects.toMatchObject({
            requestId: input.requestId,
            cause: { status: 403 },
          });
          expect(withdrawals).toBe(1);
          expect(writing).toHaveBeenCalledOnce();
          expect(
            await f.db`select state from allrice_storage_objects where id=${pendingObject!}`,
          ).toEqual([{ state: 'pending' }]);
          await release(p);
          const check = {
            workspaceId: input.workspaceId,
            requestId: input.requestId,
            operation,
          };
          expect(
            await p.client.readWriteReceipt(check, signal()),
          ).toMatchObject({ status: 'recorded', ready: false });
        } finally {
          writing.mockRestore();
          reading.mockRestore();
          handlers = createEmployeePanelsHandlers({
            ...employeePanelsDependencies,
            storage: () => runtimeFixtureStorage(f.db),
          });
        }
      },
    );
    it('serializes original reference reservations and publication changes with a real D release withdrawal', async () => {
      const p = await person();
      await release(p);
      await authorizeFixturePlatformAdministrator(f.db, p.context.actor.id);
      const session = await createChatSession(p.context, p.selection, {
        executionGeneration: '4.0',
      });
      const selection = { ...p.selection, threadId: session.id };
      const client = createEmployeePanelsHttpClient(selection, p.options);
      const file = await client.uploadDeliverable(uploadInput(p), signal());
      const audience = { scope: 'personal' as const, departmentIds: [] };
      const saved = await client.publishUpload(
        { ...uploadInput(p), origin: 'upload', purpose: '', audience },
        signal(),
      );
      const storage = runtimeFixtureStorage(f.db);
      const authorize = async (
        ...args: Parameters<typeof employeePanelsDependencies.authorize>
      ) => {
        if (args[2])
          await updateDEntryReleasePolicy(p.context, {
            revision: randomUUID(),
            defaultGeneration: '3.x',
            selections: [],
          });
        return employeePanelsDependencies.authorize(...args);
      };
      const defaults = {
        ...employeePanelsDependencies,
        storage: () => storage,
      };
      handlers = createEmployeePanelsHandlers({ ...defaults, authorize });
      try {
        const captureId = randomUUID();
        await expect(
          client.captureReference(
            {
              workspaceId: selection.workspaceId,
              objectId: file.objectId,
              requestId: captureId,
            },
            signal(),
          ),
        ).rejects.toMatchObject({ cause: { status: 403 } });
        await release(p);
        const save = uploadInput(p);
        const scoped = await requireEmployeePanelsContext(
          new Request(base + '?' + new URLSearchParams(selection)),
          selection.employeeInstanceId,
          false,
          { ...defaults, context: async () => p.context, authorize },
        );
        await expect(
          scoped.materials.save(
            p.context,
            { ...save, scope: 'personal', purpose: '' },
            signal(),
          ),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        await release(p);
        await expect(
          client.favorite(
            {
              workspaceId: selection.workspaceId,
              objectId: file.objectId,
              body: { favorite: true },
            },
            signal(),
          ),
        ).rejects.toMatchObject({ status: 403 });
        expect(
          await f.db`select object_id from allrice_workbench_file_favorites where object_id=${file.objectId}`,
        ).toEqual([]);
        for (const action of ['edit', 'delete', 'retry'] as const) {
          await release(p);
          const body = {
            workspaceId: selection.workspaceId,
            requestId: randomUUID(),
            expectedRevision: 1,
          };
          const writing =
            action === 'retry'
              ? client.changeSource(
                  { sourceId: saved.sourceId, body: { ...body, action } },
                  signal(),
                )
              : client.changePublication(
                  {
                    sourceId: saved.sourceId,
                    body:
                      action === 'edit'
                        ? {
                            ...body,
                            action,
                            purpose: 'revoked change',
                            audience,
                          }
                        : { ...body, action },
                  },
                  signal(),
                );
          await expect(writing).rejects.toMatchObject({
            cause: { status: 403 },
          });
          expect(
            await f.db`select request_id from allrice_knowledge_reference_actions where request_id=${body.requestId}`,
          ).toEqual([]);
        }
        expect(
          await f.db`select request_id from allrice_knowledge_save_requests where request_id in (${captureId},${save.requestId})`,
        ).toEqual([]);
        expect(
          await f.db`select description,status from allrice_knowledge_sources where id=${saved.sourceId}`,
        ).toEqual([{ description: '企业资料', status: 'active' }]);
      } finally {
        handlers = createEmployeePanelsHandlers(defaults);
      }
    });
    it('keeps the real release writer waiting on an already authorized panel transaction', async () => {
      const p = await person();
      await release(p);
      await authorizeFixturePlatformAdministrator(f.db, p.context.actor.id);
      const uploaded = await p.client.uploadDeliverable(
        uploadInput(p),
        signal(),
      );
      let noteHeld!: (pid: number) => void;
      let finish!: () => void;
      const held = new Promise<number>((resolve) => {
        noteHeld = resolve;
      });
      const released = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const defaults = {
        ...employeePanelsDependencies,
        storage: () => runtimeFixtureStorage(f.db),
      };
      let used = false;
      let revoking: ReturnType<typeof updateDEntryReleasePolicy> | undefined;
      handlers = createEmployeePanelsHandlers({
        ...defaults,
        async authorize(context, selection, tx) {
          // Let the writer that waited on this transaction commit before the
          // final unlocked reply check, independently of pool scheduling.
          if (!tx && used) await revoking;
          const current = await defaults.authorize(context, selection, tx);
          if (tx && !used) {
            used = true;
            const [row] = await tx<
              { pid: number }[]
            >`select pg_backend_pid() pid`;
            noteHeld(row!.pid);
            await released;
          }
          return current;
        },
      });
      const favorite = (value: boolean) =>
        p.client.favorite(
          {
            workspaceId: p.selection.workspaceId,
            objectId: uploaded.objectId,
            body: { favorite: value },
          },
          signal(),
        );
      const writing = favorite(true);
      void writing.catch(() => {});
      try {
        const writer = await held;
        revoking = updateDEntryReleasePolicy(p.context, {
          revision: randomUUID(),
          defaultGeneration: '3.x',
          selections: [],
        });
        void revoking.catch(() => {});
        await expect
          .poll(
            async () =>
              (
                await f.db`select pid from pg_stat_activity
            where datname=current_database() and ${writer}=any(pg_blocking_pids(pid))`
              ).length,
          )
          .toBe(1);
      } finally {
        finish();
        await Promise.allSettled([writing, revoking]);
        handlers = createEmployeePanelsHandlers(defaults);
      }
      await revoking;
      await expect(writing).rejects.toMatchObject({ status: 403 });
      await expect(favorite(false)).rejects.toMatchObject({ status: 403 });
      expect(
        await f.db`select object_id from allrice_workbench_file_favorites where object_id=${uploaded.objectId}`,
      ).toEqual([{ object_id: uploaded.objectId }]);
    });
    it('replays the same material reservation from verified copy bytes after the original is withdrawn', async () => {
      const p = await person();
      await release(p);
      const original = await p.client.uploadDeliverable(
        uploadInput(p),
        signal(),
      );
      const input = {
        origin: 'file' as const,
        workspaceId: p.selection.workspaceId,
        requestId: randomUUID(),
        objectId: original.objectId,
        purpose: 'fixed copy',
        audience: { scope: 'personal' as const, departmentIds: [] },
      };
      const storage = runtimeFixtureStorage(f.db);
      const put = storage.put.bind(storage);
      const writing = vi
        .spyOn(storage, 'put')
        .mockImplementationOnce(async (object, bytes) => {
          await put(object, bytes);
          throw Error('copy acknowledgement lost');
        });
      try {
        await expect(
          p.client.publishFile(input, signal()),
        ).rejects.toBeInstanceOf(EmployeePanelsWriteUnknownError);
        const check = {
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          operation: 'publish-file' as const,
        };
        const pending = await p.client.readWriteReceipt(check, signal());
        expect(pending).toMatchObject({ status: 'recorded', ready: false });
        await f.db`update allrice_storage_objects
          set retention_until=created_at+interval '1 microsecond' where id=${original.objectId}`;
        const unavailable = await raw(
          p,
          `/deliverables/${original.objectId}/download`,
        );
        expect(unavailable.status).toBe(404);
        await unavailable.text();
        const replay = await p.client.publishFile(input, signal());
        expect(replay).toEqual(pending.result);
        expect(await p.client.readWriteReceipt(check, signal())).toMatchObject({
          status: 'recorded',
          ready: true,
        });
        expect(writing).toHaveBeenCalledOnce();
      } finally {
        writing.mockRestore();
      }
    });
  },
);
