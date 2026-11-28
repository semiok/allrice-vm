import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import type { PanelDataState } from '../../../../packages/dsh-web-composition/tests/fixtures/employee-panels/employee-panel-data-types';

// Business data is an explicit in-browser contract substitute. Product panels,
// hooks, forms, actions and native document components are the actual code.
// This suite proves neither authenticated BFF/PG nor production storage effects.
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const environments = [
  { width: 1440, theme: 'light' },
  { width: 1440, theme: 'dark' },
  { width: 390, theme: 'light' },
  { width: 390, theme: 'dark' },
] as const;
const root = (page: Page) =>
  page.getByRole('main', { name: '资料成果真实组件' });
const evidence = (page: Page) =>
  page.evaluate(() => window.__panelDataFixture.evidence());
const control = (
  page: Page,
  state: PanelDataState,
  kind: 'files' | 'materials',
) =>
  page.evaluate(
    ({ state, kind }) => {
      window.__panelDataFixture.setState(state);
      window.__panelDataFixture.setKind(kind);
    },
    { state, kind },
  );
const readLayout = (page: Page) =>
  root(page).evaluate((node) => {
    const inspect = (selector: string) => {
      const element = node.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        className: element.className,
        width: box.width,
        height: box.height,
        display: style.display,
        visibility: style.visibility,
        cssWidth: style.width,
        minWidth: style.minWidth,
        flex: style.flex,
      };
    };
    return {
      select: inspect('[data-select-field]'),
      search: inspect('[data-search-field]'),
      input: inspect('input[type="search"]'),
      root: { width: node.clientWidth, scrollWidth: node.scrollWidth },
      stylesheets: [...document.styleSheets].map((sheet) => ({
        href: sheet.href,
        disabled: sheet.disabled,
      })),
    };
  });
const firstFile = '第四季度销售口径说明.pdf';
const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

suite(
  'MET-282 bound contract -> real materials and deliverables components',
  () => {
    let browser: Browser, server: Server, origin: string;
    const output = resolve(
      process.env.ALLRICE_PANEL_DATA_ARTIFACT_DIR ??
        '.local/employee-panel-data-browser',
    );
    beforeAll(async () => {
      await mkdir(output, { recursive: true });
      const require = createRequire(import.meta.url);
      const { build } = createRequire(require.resolve('tsx'))('esbuild');
      const built = await build({
        absWorkingDir: process.cwd(),
        entryPoints: [
          'packages/dsh-web-composition/tests/fixtures/employee-panels/employee-panel-data-page.tsx',
        ],
        bundle: true,
        format: 'esm',
        splitting: true,
        platform: 'browser',
        write: false,
        metafile: true,
        outdir: '/unused-employee-panel-data',
        jsx: 'automatic',
        loader: {
          '.woff2': 'dataurl',
          '.woff': 'dataurl',
          '.ttf': 'dataurl',
          '.svg': 'dataurl',
        },
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      await mkdir(join(output, 'fixture-assets'), { recursive: true });
      for (const file of built.outputFiles)
        await writeFile(
          join(output, 'fixture-assets', file.path.split('/').at(-1)!),
          file.contents,
        );
      await writeFile(
        join(output, 'fixture-build.json'),
        JSON.stringify(built.metafile, null, 2),
      );
      const assets = new Map<string, Uint8Array>(
        built.outputFiles.map(
          (file: { path: string; contents: Uint8Array }) => [
            file.path.slice(file.path.lastIndexOf('/')),
            file.contents,
          ],
        ),
      );
      server = createServer((request, response) => {
        const path = new URL(request.url!, origin).pathname;
        const asset = assets.get(path);
        if (asset) {
          response.writeHead(200, {
            'Content-Type': path.endsWith('.css')
              ? 'text/css'
              : 'application/javascript',
          });
          response.end(asset);
        } else if (path === '/') {
          response.writeHead(200, { 'Content-Type': 'text/html' });
          response.end(
            '<!doctype html><html lang="zh-CN" data-allrice-framework="v2"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-panel-data-page.css"></head><body><div id="root"></div><script type="module" src="/employee-panel-data-page.js"></script></body></html>',
          );
        } else {
          response.writeHead(404);
          response.end();
        }
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const { chromium } = require('playwright-core');
      const executablePath =
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : undefined);
      browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
      await writeFile(
        join(output, 'environment.json'),
        JSON.stringify(
          {
            head: execFileSync('git', ['rev-parse', 'HEAD'], {
              encoding: 'utf8',
            }).trim(),
            browser: browser.version(),
            os: process.platform,
            dpr: 1,
            data: 'explicit synthetic contract; no authenticated BFF/storage',
            components: 'current product components; unchanged rev2 CSS',
            environments,
          },
          null,
          2,
        ),
      );
    }, 60_000);
    afterAll(async () => {
      await browser?.close();
      server?.closeAllConnections();
      if (server) await new Promise<void>((done) => server.close(() => done()));
    });

    it.each([
      { status: 403 },
      { status: 409, code: 'EMPLOYEE_INSTANCE_ARCHIVED' },
    ])(
      'removes file contents and actions after the terminal metadata status $status',
      async ({ status, code }) => {
        const page = await browser.newPage();
        try {
          await page.goto(origin);
          await root(page).getByText(firstFile, { exact: true }).click();
          await root(page)
            .getByText('这是固定文件第一页。', { exact: false })
            .waitFor();
          await page.evaluate(
            ({ status, code }) =>
              window.__panelDataFixture.refusePreview(status, code),
            { status, code },
          );
          await root(page).getByText('无权访问', { exact: true }).waitFor();
          expect(
            await root(page)
              .getByText('这是固定文件第一页。', { exact: false })
              .count(),
          ).toBe(0);
          expect(
            await root(page).locator('header[aria-label="文件操作"]').count(),
          ).toBe(0);
          expect(
            (await evidence(page)).calls.filter(
              (call) =>
                call.method === 'listDeliverables' &&
                (call.input as { objectId?: string }).objectId,
            ),
          ).toHaveLength(2);
        } finally {
          await page.close();
        }
      },
    );

    it('reopens cleanly and retries the original publication through the normal button without a duplicate upload', async () => {
      const page = await browser.newPage();
      try {
        await page.goto(origin);
        await page
          .getByRole('button', { name: '企业资料', exact: true })
          .click();
        await page.evaluate(() =>
          window.__panelDataFixture.losePublicationReply(),
        );
        const open = () =>
          root(page).getByRole('button', { name: '上传', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '上传企业资料' });
        const choose = () =>
          dialog.getByLabel('选择文件', { exact: true }).setInputFiles({
            name: '上传回归.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('same canonical write'),
          });
        const publish = () =>
          dialog.getByRole('button', { name: '发布', exact: true }).click();
        await open();
        await choose();
        await publish();
        await dialog.getByText('上传中断，请重试。', { exact: true }).waitFor();
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        await open();
        await dialog.getByRole('textbox').waitFor();
        expect(await dialog.getByRole('alert').count()).toBe(0);
        expect(await dialog.getByRole('button', { name: /核对/ }).count()).toBe(
          0,
        );
        await expect
          .poll(
            async () =>
              (await evidence(page)).calls.filter(
                ({ method }) => method === 'readWriteReceipt',
              ).length,
          )
          .toBe(1);
        await page.evaluate(() => window.__panelDataFixture.finishReceipt());
        await choose();
        await publish();
        await dialog.waitFor({ state: 'hidden' });
        const calls = (await evidence(page)).calls;
        const uploads = calls.filter((call) => call.method === 'publishUpload');
        expect(uploads).toHaveLength(1);
        const requestId = (uploads[0]!.input as { requestId: string })
          .requestId;
        expect(await page.getByText(requestId, { exact: false }).count()).toBe(
          0,
        );
        expect(
          calls
            .filter((call) => call.method === 'readWriteReceipt')
            .map(({ input }) => input),
        ).toEqual([
          expect.objectContaining({ requestId, operation: 'publish-upload' }),
          expect.objectContaining({ requestId, operation: 'publish-upload' }),
        ]);
      } finally {
        await page.close();
      }
    });

    it('shows the file limit and disables the publishing button until the upload completes', async () => {
      const page = await browser.newPage();
      const folder = await mkdtemp(join(tmpdir(), 'allrice-material-limit-'));
      const oversized = join(folder, '过大的资料.txt');
      try {
        await writeFile(oversized, '');
        await truncate(oversized, 50 * 1024 ** 2 + 1);
        await page.goto(origin);
        await page
          .getByRole('button', { name: '企业资料', exact: true })
          .click();
        await root(page)
          .getByRole('button', { name: '上传', exact: true })
          .click();
        const dialog = page.getByRole('dialog', { name: '上传企业资料' });
        const input = dialog.getByLabel('选择文件', { exact: true });
        const publish = dialog.getByRole('button', {
          name: '发布',
          exact: true,
        });
        const limit = dialog.getByText('文件超过 50 MB 上限。', {
          exact: true,
        });
        const choose = () =>
          input.setInputFiles({
            name: '普通资料.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('可以上传的资料'),
          });
        await input.setInputFiles(oversized);
        await limit.waitFor();
        expect(await publish.isDisabled()).toBe(true);
        expect(
          (await evidence(page)).calls.filter(
            ({ method }) => method === 'publishUpload',
          ),
        ).toHaveLength(0);
        await choose();
        expect(await limit.count()).toBe(0);
        await page.evaluate(() =>
          window.__panelDataFixture.rejectNextPublication(413),
        );
        await publish.click();
        await limit.waitFor();
        await page.evaluate(() => window.__panelDataFixture.holdPublication());
        await publish.click();
        const publishing = dialog.getByRole('button', {
          name: '发布中...',
          exact: true,
        });
        await publishing.waitFor();
        expect(await publishing.isDisabled()).toBe(true);
        expect(await publishing.getAttribute('aria-busy')).toBe('true');
        await page.screenshot({
          path: join(output, 'publication-pending.png'),
        });
        await page.evaluate(() =>
          window.__panelDataFixture.finishPublication(),
        );
        await dialog.waitFor({ state: 'hidden' });
        await root(page).getByText('普通资料.txt', { exact: true }).waitFor();
        expect(
          (await evidence(page)).calls.filter(
            ({ method }) => method === 'publishUpload',
          ),
        ).toHaveLength(2);
      } finally {
        await page.close();
        await rm(folder, { recursive: true });
      }
    });

    it('keeps two different intents and permits the second while the first receipt GET is held', async () => {
      const page = await browser.newPage();
      const dialog = page.getByRole('dialog', { name: '上传企业资料' });
      const writes = async () =>
        (await evidence(page)).calls
          .filter((call) => call.method === 'publishUpload')
          .map(
            (call) =>
              call.input as {
                requestId: string;
                purpose: string;
                audience: { scope: string };
              },
          );
      const inquiries = async () =>
        (await evidence(page)).calls
          .filter((call) => call.method === 'readWriteReceipt')
          .map((call) => (call.input as { requestId: string }).requestId);
      const open = () =>
        root(page).getByRole('button', { name: '上传', exact: true }).click();
      async function chooseMaterials() {
        await page
          .getByRole('button', { name: '企业资料', exact: true })
          .click();
      }
      async function selectFile() {
        await dialog.getByLabel('选择文件', { exact: true }).setInputFiles({
          name: '同一个文件.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('相同字节'),
        });
      }
      try {
        await page.goto(origin);
        await chooseMaterials();
        await page.evaluate(() =>
          window.__panelDataFixture.losePublicationReply(),
        );
        await open();
        await selectFile();
        await dialog.getByRole('radio', { name: '全公司' }).check();
        await dialog.getByRole('textbox').fill('A 的用途');
        await dialog.getByRole('button', { name: '发布', exact: true }).click();
        await dialog.getByRole('alert').waitFor();
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        const [a] = await writes();
        expect(a).toMatchObject({
          purpose: 'A 的用途',
          audience: { scope: 'company' },
        });
        await page.evaluate(() => window.__panelDataFixture.holdReceipt());
        await open();
        await expect.poll(inquiries).toEqual([a!.requestId]);
        await selectFile();
        await dialog.getByRole('radio', { name: '仅自己' }).check();
        await dialog.getByRole('textbox').fill('B 的用途');
        const publish = dialog.getByRole('button', {
          name: '发布',
          exact: true,
        });
        expect(await publish.isEnabled()).toBe(true);
        await publish.click();
        await expect.poll(async () => (await writes()).length).toBe(2);
        const [, b] = await writes();
        expect(b).toMatchObject({
          purpose: 'B 的用途',
          audience: { scope: 'personal' },
        });
        expect(b!.requestId).not.toBe(a!.requestId);
        expect(await inquiries()).toEqual([a!.requestId]);
        expect(await dialog.getByRole('button', { name: /核对/ }).count()).toBe(
          0,
        );
        await page.reload();
        await chooseMaterials();
        await open();
        await expect.poll(inquiries).toEqual([b!.requestId, a!.requestId]);
        expect(await writes()).toEqual([]);
        // Change one identity field from the saved request at a time.
        for (const scope of [
          { employee: uid(99), thread: uid(7), viewer: uid(1) },
          { employee: uid(3), thread: uid(98), viewer: uid(1) },
          { employee: uid(3), thread: uid(7), viewer: uid(97) },
        ]) {
          await page.evaluate(({ employee, thread, viewer }) => {
            window.__panelDataFixture.selectReceiptScope(employee, thread);
            window.__panelDataFixture.selectReceiptViewer(viewer);
          }, scope);
          await expect
            .poll(() =>
              dialog.getByRole('button', { name: /核对结果/ }).count(),
            )
            .toBe(0);
          expect(await inquiries()).toEqual([b!.requestId, a!.requestId]);
        }
      } finally {
        await page.close();
      }
    });

    it('uses the request present at click time when its receipt completes during the same intent hash', async () => {
      const page = await browser.newPage();
      const dialog = page.getByRole('dialog', { name: '上传企业资料' });
      const upload = root(page).getByRole('button', {
        name: '上传',
        exact: true,
      });
      const publish = dialog.getByRole('button', { name: '发布', exact: true });
      const choose = () =>
        dialog.getByLabel('选择文件', { exact: true }).setInputFiles({
          name: '同一意图.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('原件'),
        });
      try {
        await page.goto(origin);
        await page
          .getByRole('button', { name: '企业资料', exact: true })
          .click();
        await page.evaluate(() =>
          window.__panelDataFixture.losePublicationReply(),
        );
        await upload.click();
        await choose();
        await publish.click();
        await dialog.getByRole('alert').waitFor();
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        await page.evaluate(() => {
          window.__panelDataFixture.holdReceipt();
          const original = crypto.subtle.digest.bind(crypto.subtle);
          crypto.subtle.digest = async (algorithm, bytes) => {
            document.body.dataset.publicationHashHeld = 'true';
            await new Promise<void>((resolve) =>
              window.addEventListener(
                'release-publication-hash',
                () => resolve(),
                { once: true },
              ),
            );
            return original(algorithm, bytes);
          };
        });
        await upload.click();
        await expect
          .poll(
            async () =>
              (await evidence(page)).calls.filter(
                (call) => call.method === 'readWriteReceipt',
              ).length,
          )
          .toBe(1);
        await choose();
        await publish.click();
        await page.waitForFunction(
          () => document.body.dataset.publicationHashHeld === 'true',
        );
        await page.evaluate(() => window.__panelDataFixture.finishReceipt());
        await expect
          .poll(async () =>
            page.evaluate(
              () =>
                Object.keys(sessionStorage).filter((key) =>
                  key.startsWith('allrice:publication-receipts:v2:'),
                ).length,
            ),
          )
          .toBe(0);
        await page.evaluate(() =>
          window.dispatchEvent(new Event('release-publication-hash')),
        );
        await dialog.waitFor({ state: 'hidden' });
        const calls = (await evidence(page)).calls;
        const writes = calls.filter((call) => call.method === 'publishUpload');
        expect(writes).toHaveLength(1);
        expect(
          calls.filter((call) => call.method === 'readWriteReceipt'),
        ).toMatchObject([
          {
            input: {
              requestId: (writes[0]!.input as { requestId: string }).requestId,
            },
          },
        ]);
        await expect.poll(() => dialog.getByRole('alert').count()).toBe(0);
      } finally {
        await page.close();
      }
    });

    it('blocks the POST if session storage refuses the original key', async () => {
      const page = await browser.newPage();
      try {
        await page.addInitScript(() => {
          const write = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (key.startsWith('allrice:publication-receipts:v2:'))
              throw new DOMException(
                'Storage is unavailable',
                'QuotaExceededError',
              );
            write.call(this, key, value);
          };
        });
        await page.goto(origin);
        await page
          .getByRole('button', { name: '企业资料', exact: true })
          .click();
        await root(page)
          .getByRole('button', { name: '上传', exact: true })
          .click();
        const dialog = page.getByRole('dialog', { name: '上传企业资料' });
        await dialog.getByLabel('选择文件', { exact: true }).setInputFiles({
          name: '未获保留的发布.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('内容'),
        });
        await dialog.getByRole('button', { name: '发布', exact: true }).click();
        await dialog.getByText('上传中断，请重试。', { exact: true }).waitFor();
        expect(
          (await evidence(page)).calls.filter(
            (call) => call.method === 'publishUpload',
          ),
        ).toEqual([]);
      } finally {
        await page.close();
      }
    });

    it('allows the same intent after a definitive rejection even when removing its local receipt fails', async () => {
      const page = await browser.newPage();
      const dialog = page.getByRole('dialog', { name: '上传企业资料' });
      const publish = dialog.getByRole('button', { name: '发布', exact: true });
      try {
        await page.goto(origin);
        await page
          .getByRole('button', { name: '企业资料', exact: true })
          .click();
        await root(page)
          .getByRole('button', { name: '上传', exact: true })
          .click();
        await dialog.getByLabel('选择文件', { exact: true }).setInputFiles({
          name: '真实拒绝后重新提交.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('相同的发布意图'),
        });
        await page.evaluate(() => {
          window.__panelDataFixture.rejectNextPublication();
          const remove = Storage.prototype.removeItem;
          Storage.prototype.removeItem = function (key) {
            if (key.startsWith('allrice:publication-receipts:v2:'))
              throw new DOMException(
                'Cannot remove old receipt',
                'QuotaExceededError',
              );
            remove.call(this, key);
          };
        });
        await publish.click();
        await dialog.getByText('上传中断，请重试。', { exact: true }).waitFor();
        expect(
          await dialog
            .getByRole('button', { name: '核对结果', exact: true })
            .count(),
        ).toBe(0);
        await publish.click();
        await dialog.waitFor({ state: 'hidden' });
        const calls = (await evidence(page)).calls;
        const ids = calls
          .filter(({ method }) => method === 'publishUpload')
          .map(({ input }) => (input as { requestId: string }).requestId);
        expect(ids).toHaveLength(2);
        expect(ids[0]).not.toBe(ids[1]);
        expect(
          calls.filter(({ method }) => method === 'readWriteReceipt'),
        ).toEqual([]);
      } finally {
        await page.close();
      }
    });

    for (const env of environments)
      it(`${env.width}/${env.theme}: search, cross-employee favorites, exact quote, preview, download, fixed copy, upload and failure states`, async () => {
        const context = await browser.newContext({
          viewport: { width: env.width, height: 900 },
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
          acceptDownloads: true,
        });
        const page = await context.newPage();
        const failures: string[] = [],
          legacyRequests: string[] = [];
        page.on('pageerror', (error) => failures.push(error.message));
        page.on('request', (request) => {
          if (new URL(request.url()).pathname.startsWith('/api/'))
            legacyRequests.push(request.url());
        });
        const screenshot = (name: string) =>
          page.screenshot({
            path: join(output, `${env.width}-${env.theme}-${name}.png`),
            fullPage: true,
          });
        const checkSearch = async (kind: 'files' | 'materials') => {
          const layout = await readLayout(page);
          await writeFile(
            join(output, `${env.width}-${env.theme}-${kind}-layout.json`),
            JSON.stringify(layout, null, 2),
          );
          const input = root(page).getByRole('searchbox', {
            name:
              kind === 'files' ? '查找文件' : '查找资料（文件名、用途、正文）',
            exact: true,
          });
          expect(await input.isVisible()).toBe(true);
          expect(await input.isEditable()).toBe(true);
          expect(layout.input!.width).toBeGreaterThan(0);
          expect(layout.input!.height).toBeGreaterThan(0);
          if (kind === 'files')
            expect(Math.abs(layout.select!.width - 126)).toBeLessThanOrEqual(
              0.5,
            );
        };
        try {
          await page.goto(origin + '/?theme=' + env.theme);
          await page.waitForFunction(() => !!window.__panelDataFixture);
          await root(page).getByText(firstFile, { exact: true }).waitFor();
          await checkSearch('files');
          expect(
            await root(page)
              .getByRole('combobox', { name: '按员工筛选' })
              .inputValue(),
          ).toBe(uid(3));
          await screenshot('files-list');
          await root(page)
            .getByRole('button', { name: '我的收藏', exact: true })
            .click();
          await root(page)
            .getByText('销售复盘与行动清单.md', { exact: true })
            .waitFor();
          expect(
            await root(page)
              .getByRole('combobox', { name: '按员工筛选' })
              .isDisabled(),
          ).toBe(true);
          const favoriteRequest = (await evidence(page)).calls
            .filter((call) => call.method === 'listDeliverables')
            .at(-1)!.input as { category: string; employeeInstanceId?: string };
          expect(favoriteRequest).toMatchObject({ category: 'favorite' });
          expect(favoriteRequest.employeeInstanceId).toBeUndefined();
          await screenshot('files-favorites');

          await root(page)
            .getByRole('button', { name: '全部', exact: true })
            .click();
          await root(page)
            .getByRole('combobox', { name: '按员工筛选' })
            .selectOption('');
          await root(page)
            .getByRole('searchbox', { name: '查找文件', exact: true })
            .fill('第四季度');
          await root(page).getByText(firstFile, { exact: true }).waitFor();
          await root(page)
            .getByRole('button', {
              name: '引用到对话 ' + firstFile,
              exact: true,
            })
            .click();
          await expect
            .poll(async () => (await evidence(page)).used.length)
            .toBe(1);
          expect((await evidence(page)).used[0]).toMatchObject({
            sourceId: uid(100),
            revisionId: uid(200),
            revision: 1,
          });
          await root(page).getByText(firstFile, { exact: true }).click();
          await root(page)
            .getByText('这是固定文件第一页。', { exact: false })
            .waitFor();
          await root(page)
            .getByRole('button', { name: '下一页', exact: true })
            .click();
          await root(page)
            .getByText('这是固定文件末页。', { exact: false })
            .waitFor();
          expect(
            (await evidence(page)).calls.some(
              (call) =>
                call.method === 'previewDeliverable' &&
                (call.input as { offset?: number }).offset === 3,
            ),
          ).toBe(true);
          const download = page.waitForEvent('download');
          await root(page)
            .locator('header[aria-label="文件操作"]')
            .getByRole('button', { name: '下载', exact: true })
            .click();
          const received = await download;
          const path = join(output, `${env.width}-${env.theme}-download.bin`);
          await received.saveAs(path);
          expect(
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ).toBe(createHash('sha256').update('固定原件内容').digest('hex'));
          await root(page)
            .locator('header[aria-label="文件操作"]')
            .getByRole('button', { name: '收藏', exact: true })
            .click();
          await expect
            .poll(
              async () =>
                (await evidence(page)).files.find(
                  (f) => f.objectId === uid(300),
                )?.favorite,
            )
            .toBe(true);
          await root(page)
            .locator('header[aria-label="文件操作"]')
            .getByRole('button', { name: '取消收藏', exact: true })
            .click();
          await expect
            .poll(
              async () =>
                (await evidence(page)).files.find(
                  (f) => f.objectId === uid(300),
                )?.favorite,
            )
            .toBe(false);
          await root(page)
            .locator('header[aria-label="文件操作"]')
            .getByRole('button', { name: '添加为企业资料', exact: true })
            .click();
          const dialog = page.getByRole('dialog', {
            name: '添加为企业资料',
            exact: true,
          });
          await dialog
            .getByRole('radio', { name: '全公司', exact: true })
            .check();
          await dialog
            .getByRole('textbox', { name: '用途', exact: true })
            .fill('固定副本，不随原件改变');
          await screenshot('publication-dialog');
          await dialog
            .getByRole('button', { name: '确认', exact: true })
            .click();
          await dialog.waitFor({ state: 'hidden' });
          await expect
            .poll(async () => (await evidence(page)).writes.length)
            .toBe(1);
          await page.evaluate(() => window.__panelDataFixture.mutateOriginal());
          expect((await evidence(page)).copies[0]?.[1]).toBe('固定原件内容');
          await screenshot('files-detail');

          for (let i = 0; i < 2; i++) {
            await page
              .getByLabel('上传个人成果', { exact: true })
              .setInputFiles({
                name: '我的成果.txt',
                mimeType: 'text/plain',
                buffer: Buffer.from('本人独立上传'),
              });
            await expect
              .poll(
                async () =>
                  (await evidence(page)).calls.filter(
                    (call) => call.method === 'uploadDeliverable',
                  ).length,
              )
              .toBe(i + 1);
          }
          const uploaded = (await evidence(page)).files.filter((f) =>
            f.fileName.startsWith('我的成果.txt'),
          );
          expect(uploaded).toHaveLength(2);
          expect(new Set(uploaded.map((f) => f.objectId)).size).toBe(2);

          await control(page, 'list', 'materials');
          await root(page)
            .getByText(firstFile, { exact: true })
            .first()
            .waitFor();
          await checkSearch('materials');
          await root(page)
            .getByRole('searchbox', { name: '查找资料（文件名、用途、正文）' })
            .fill('销售');
          await root(page).locator('mark').first().waitFor();
          expect(
            await root(page).locator('[data-file-row-scope]').allTextContents(),
          ).toEqual(expect.arrayContaining(['全公司', '销售部', '仅自己']));
          await root(page)
            .getByRole('button', { name: '引用到对话', exact: true })
            .first()
            .click();
          await expect
            .poll(async () => (await evidence(page)).used.length)
            .toBe(2);
          await screenshot('materials-search');

          for (const kind of ['files', 'materials'] as const) {
            for (const state of [
              'empty',
              'loading',
              'error',
              'denied',
              'unbound',
              'longname',
            ] as const) {
              await control(page, state, kind);
              if (state === 'loading')
                await root(page).getByRole('status').first().waitFor();
              else if (state === 'empty')
                await root(page)
                  .getByText(
                    kind === 'files' ? '还没有交付成果' : '还没有企业资料',
                    { exact: true },
                  )
                  .waitFor();
              else if (state === 'longname')
                await root(page)
                  .getByText(
                    '2026年度企业服务重点客户续约与交付情况汇总表（华东区最终确认版本）.xlsx',
                    { exact: true },
                  )
                  .waitFor();
              else {
                await root(page).getByRole('alert').waitFor();
                expect(
                  await root(page)
                    .getByText(firstFile, { exact: true })
                    .count(),
                ).toBe(0);
              }
              const overflow = await root(page).evaluate(
                (node) => node.scrollWidth - node.clientWidth,
              );
              expect(overflow).toBeLessThanOrEqual(1);
              await screenshot(`${kind}-${state}`);
            }
          }
          expect(legacyRequests).toEqual([]);
          expect(failures).toEqual([]);
          await writeFile(
            join(output, `${env.width}-${env.theme}-receipt.json`),
            JSON.stringify(
              {
                ...env,
                legacyRequests,
                failures,
                evidence: await evidence(page),
              },
              null,
              2,
            ),
          );
        } catch (error) {
          await screenshot('first-failure');
          await writeFile(
            join(output, `${env.width}-${env.theme}-first-failure.json`),
            JSON.stringify(
              {
                ...env,
                legacyRequests,
                failures,
                layout: await readLayout(page).catch(() => null),
                evidence: await evidence(page).catch(() => null),
              },
              null,
              2,
            ),
          );
          throw error;
        } finally {
          await context.close();
        }
      }, 120_000);
  },
);
