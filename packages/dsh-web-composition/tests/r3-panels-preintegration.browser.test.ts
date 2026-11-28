import { decodeEmployeeFileMention } from '@allrice/contracts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserArtifacts } from './browser-artifacts';
import {
  createSyntheticPanelsData,
  panelsClock,
  panelsEmployee,
  panelsViewer,
  panelsWorkspace,
  uid,
} from './fixtures/employee-panels/data';
import { createSidebarFixtureData } from './fixtures/sidebar-data.mjs';
import { startInstalledProfile } from './installed-profile';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;

const organizationId = uid(4);
const threadId = uid(7);
const nativeSessionId = 'session-00000000-0000-4000-8000-000000000036';
const employeeName = '虚拟哥';
const labels = ['交付成果', '企业资料', '记忆', '能力'];
const messages = '请核对三条销售记录，计算合计，并简要说明结果。';

interface FixtureWorkbench {
  mount(markup: string): Promise<void>;
  references(): Promise<{ label: string; text: string }[]>;
}
declare global {
  interface Window {
    __allriceSettingsWorkbench?: FixtureWorkbench;
  }
}

function employeeDocument() {
  const samples = createSidebarFixtureData();
  const employee = samples.employees[1]!;
  employee.currentVersion.manifest.name = employeeName;
  const directory = {
    organizationId,
    workspaceId: panelsWorkspace,
    viewerId: panelsViewer,
    employees: [
      { ...employee, id: panelsEmployee, employeeId: panelsEmployee },
    ],
    sessions: [
      {
        ...samples.sessions[1]!,
        id: threadId,
        ownerId: panelsViewer,
        employeeInstanceId: panelsEmployee,
        employeeAssignmentId: panelsEmployee,
        executionGeneration: '4.0',
      },
    ],
  };
  return `<div hidden id="app" data-organization-id="${organizationId}"
    data-workspace-id="${panelsWorkspace}" data-viewer-id="${panelsViewer}"
    data-employee-instance-id="${panelsEmployee}" data-thread-id="${threadId}"
    data-login-session-id="${uid(8)}" data-scope-id="${uid(9)}"
    data-native-session-id="${nativeSessionId}"></div>
    <script id="allrice-employee-directory" type="application/json">${JSON.stringify(directory).replaceAll('<', '\\u003c')}</script>`;
}

async function fixtureApis(page: Page, requests: string[]) {
  const sample = createSyntheticPanelsData();
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    requests.push(method + ' ' + url.pathname);
    if (url.pathname === '/api/v1/memories/manage') {
      expect(url.searchParams.get('workspaceId')).toBe(panelsWorkspace);
      expect(url.searchParams.get('instanceId')).toBe(panelsEmployee);
      const rows = sample.memories.map((row) => ({
        ...row,
        details: undefined,
      }));
      const active = rows.filter((row) => row.state === 'active');
      const pending = rows.filter((row) => row.state === 'pending');
      return route.fulfill({
        json: {
          schemaVersion: 2,
          workspaceId: panelsWorkspace,
          instanceId: panelsEmployee,
          counts: {
            active: active.length,
            pending: pending.length,
            maxActive: 100,
          },
          active,
          pending,
        },
      });
    }
    const prefix = `/api/v1/d-entry/panels/${panelsEmployee}/`;
    if (!url.pathname.startsWith(prefix))
      throw Error(`Unexpected production request: ${method} ${url.pathname}`);
    expect(request.headers()['x-allrice-expected-viewer-id']).toBe(
      panelsViewer,
    );
    expect(url.searchParams.get('threadId')).toBe(threadId);
    const key = url.pathname.slice(prefix.length);
    if (key === 'skills') return route.fulfill({ json: sample.skills });
    if (key === 'materials') {
      const search = url.searchParams.get('query') ?? '';
      return route.fulfill({
        json: {
          ...sample.catalog,
          references: sample.catalog.references
            .filter((row) => row.fileName.includes(search))
            .map((row) => ({ ...row, fullTextReady: true })),
        },
      });
    }
    if (key === 'materials/options')
      return route.fulfill({
        json: { viewerId: panelsViewer, options: sample.options },
      });
    if (key === 'deliverables')
      return route.fulfill({
        json: {
          ...sample.files,
          files: sample.files.files.filter(
            (file) =>
              (!url.searchParams.get('objectId') ||
                file.objectId === url.searchParams.get('objectId')) &&
              (!url.searchParams.get('query') ||
                file.fileName.includes(url.searchParams.get('query')!)),
          ),
          employees: [{ id: panelsEmployee, name: employeeName }],
        },
      });
    if (key.startsWith('materials/revisions/') && key.endsWith('/selection'))
      return route.fulfill({
        json: { ...sample.selection(key.split('/')[2]!), canReference: true },
      });
    if (
      key === `deliverables/${sample.files.files[1]!.objectId}/reference` &&
      method === 'POST'
    )
      return route.fulfill({ json: { reference: sample.references[1] } });
    throw Error(`Unexpected panel request: ${method} ${key}`);
  });
  return sample;
}

suite('R3 preintegration through the installed workbench', () => {
  let host: Awaited<ReturnType<typeof startInstalledProfile>>;
  let browser: Browser;
  let artifacts: string;

  beforeAll(async () => {
    artifacts = await createBrowserArtifacts();
    console.info(`R3 panel preintegration evidence: ${artifacts}`);
    host = await startInstalledProfile(
      new URL('./fixtures/settings-workbench-client.js', import.meta.url),
    );
    const internal = join(host.root, 'workspace', 'allrice-memory');
    await mkdir(internal);
    await writeFile(
      join(internal, 'private-fixture.md'),
      'Private filesystem fixture',
    );
    browser = await chromium.launch({
      headless: true,
      ...(process.env.ALLRICE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE }
        : {}),
    });
    await writeFile(
      join(artifacts, 'r3-panel-browser.json'),
      JSON.stringify(
        {
          browser: browser.version(),
          buildSha256: createHash('sha256')
            .update(
              await readFile(new URL('../dist/client.js', import.meta.url)),
            )
            .digest('hex'),
          nativeVersion: '0.2.1-rc.2',
          data: 'synthetic BFF replies, actual installed production owners',
          views: [1440, 390],
        },
        null,
        2,
      ),
    );
  }, 90_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await host?.close();
    }
  });

  it.each([1440, 390])(
    'uses the native @ picker for authorized materials and deliverables at %ipx',
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 1000 },
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12_000);
      const requests: string[] = [];
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      page.on('pageerror', (error) => errors.push(error.message));
      const shot = (name: string) =>
        page.screenshot({
          path: join(artifacts, `r3-mention-${width}-${name}.png`),
          animations: 'disabled',
        });
      try {
        const data = await fixtureApis(page, requests);
        await page.goto(host.authUrl);
        const proceed = page.getByRole('button', { name: /^(Continue|继续)$/ });
        await proceed.waitFor({ timeout: 5_000 }).catch(() => {});
        if (await proceed.isVisible()) await proceed.click();
        await page.goto(host.origin);
        await page.waitForFunction(() =>
          Boolean(window.__allriceSettingsWorkbench),
        );
        await page.evaluate(
          (markup) => window.__allriceSettingsWorkbench!.mount(markup),
          employeeDocument(),
        );
        const editor = page.locator('[contenteditable="true"]');
        const menu = page.locator('[data-trigger-menu]');
        const options = menu.getByRole('option');
        const folder = menu.getByRole('option', {
          name: '企业资料',
          exact: false,
        });
        const file = data.files.files[2]!;
        const material = data.references[0]!;
        const output = menu.getByRole('option', {
          name: file.fileName,
          exact: true,
        });
        await editor.click();
        await page.keyboard.insertText('@');
        await output.waitFor();
        expect(await options.first().getAttribute('id')).toBe(
          await folder.getAttribute('id'),
        );
        expect(await menu.innerText()).not.toContain('allrice-memory');
        expect(await menu.innerText()).not.toContain('private-fixture.md');
        expect(await menu.innerText()).not.toContain(
          data.files.files[0]!.fileName,
        );
        await menu
          .getByRole('option', { name: '新建对话', exact: true })
          .first()
          .waitFor();
        expect(await menu.innerText()).not.toMatch(/session-[\da-f]{8}-/iu);
        await shot('root');
        await page.keyboard.press('Tab');
        const reference = menu.getByRole('option', {
          name: material.fileName,
          exact: true,
        });
        await reference.waitFor();
        await shot('tab');
        await page.keyboard.insertText(material.fileName.slice(0, 4));
        await expect.poll(() => options.count()).toBe(1);
        await page.keyboard.press('Enter');
        await editor.getByText(material.fileName, { exact: true }).waitFor();
        await page.keyboard.press('End');
        await page.keyboard.insertText(' @"');
        await folder.click();
        await reference.waitFor();
        expect(await editor.innerText()).toContain('@"企业资料/');
        await menu
          .getByRole('button', { name: '文件与文件夹', exact: true })
          .click();
        expect((await editor.innerText()).trimEnd().endsWith('@"')).toBe(true);
        await output.click();
        await editor.getByText(file.fileName, { exact: true }).waitFor();
        const references = await page.evaluate(() =>
          window.__allriceSettingsWorkbench!.references(),
        );
        expect(references.map(({ label }) => label)).toEqual([
          material.fileName,
          file.fileName,
        ]);
        expect(
          references.map(({ text }) => decodeEmployeeFileMention(text.trim())),
        ).toEqual([
          {
            threadId,
            label: material.fileName,
            pin: {
              kind: 'material',
              sourceId: material.sourceId,
              revisionId: material.revisionId,
              revision: material.revision,
              checksum: material.checksum,
            },
          },
          {
            threadId,
            label: file.fileName,
            pin: {
              kind: 'deliverable',
              objectId: file.objectId,
              checksum: file.checksum,
            },
          },
        ]);
        expect(
          requests.every(
            (entry) =>
              entry.startsWith('GET ') &&
              !entry.endsWith('/preview') &&
              !entry.endsWith('/selection'),
          ),
        ).toBe(true);
        await shot('references');
      } catch (error) {
        await shot('first-failure');
        throw error;
      } finally {
        await writeFile(
          join(artifacts, `r3-mention-${width}-requests.json`),
          JSON.stringify({ requests, errors }, null, 2),
        );
        await context.close();
      }
    },
    45_000,
  );

  it.each([1440, 390])(
    'opens five real panes and keeps both native references at %ipx',
    async (width) => {
      const mobile = width === 390;
      const context = await browser.newContext({
        viewport: { width, height: mobile ? 844 : 1000 },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        timezoneId: 'UTC',
      });
      await context.addInitScript((clock) => {
        Date.now = () => Date.parse(clock);
      }, panelsClock);
      const page = await context.newPage();
      page.setDefaultTimeout(12_000);
      const requests: string[] = [];
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const shot = (name: string) =>
        page.screenshot({
          path: join(artifacts, `r3-panel-${width}-${name}.png`),
          animations: 'disabled',
        });
      try {
        const data = await fixtureApis(page, requests);
        await page.goto(host.authUrl);
        const proceed = page.getByRole('button', { name: /^(Continue|继续)$/ });
        await proceed.waitFor({ timeout: 5_000 }).catch(() => {});
        if (await proceed.isVisible()) await proceed.click();
        await page.goto(host.origin);
        await page.waitForFunction(() =>
          Boolean(window.__allriceSettingsWorkbench),
        );
        await page.evaluate(
          (markup) => window.__allriceSettingsWorkbench!.mount(markup),
          employeeDocument(),
        );
        await page.getByText(messages, { exact: true }).waitFor();

        const entries = page.getByLabel('工作台入口', { exact: true });
        const corner = page.getByRole('button', {
          name: '打开右侧边栏',
          exact: true,
        });
        const hideRight = page.getByRole('button', {
          name: '收起右侧边栏',
          exact: true,
        });
        const tab = (name: string) =>
          page
            .getByRole('tab')
            .filter({ has: page.getByText(name, { exact: true }) });
        const card = (name: string) =>
          page.getByRole('button').filter({
            has: page.locator('strong').getByText(name, { exact: true }),
          });
        const open = async (name: string) => {
          if (mobile) {
            if (await corner.isVisible()) await corner.click();
            if (await tab(name).isVisible()) {
              await tab(name).click();
            } else {
              if (!(await card(name).isVisible()))
                await page
                  .getByRole('button', { name: '新标签页', exact: true })
                  .click();
              await card(name).click();
            }
          } else {
            await entries
              .getByRole('button', { name: new RegExp(`^${name}(?:，|$)`) })
              .click();
          }
          await tab(name).waitFor();
          expect(await tab(name).count()).toBe(1);
        };

        if (mobile) {
          expect(await entries.isVisible()).toBe(false);
          await corner.click();
          for (const label of labels) await card(label).waitFor();
        } else {
          const buttons = entries.getByRole('button');
          await buttons.last().waitFor();
          expect(
            await buttons.evaluateAll((rows) =>
              rows.map((row) => row.getAttribute('aria-label')?.split('，')[0]),
            ),
          ).toEqual(labels);
        }
        await shot('entries');
        const file = data.references[1]!;
        const material = data.references[0]!;
        await open('交付成果');
        const files = page.getByRole('region', {
          name: '交付成果',
          exact: true,
        });
        await files
          .getByRole('button', {
            name: `引用到对话 ${file.fileName}`,
            exact: true,
          })
          .click();
        await shot('files');

        await open('企业资料');
        const materials = page.getByRole('region', {
          name: '企业资料',
          exact: true,
        });
        await materials
          .getByRole('button', { name: new RegExp('^引用到对话') })
          .first()
          .click();
        await shot('materials');

        await open('记忆');
        const memory = page.getByRole('region', {
          name: `${employeeName} · 记忆`,
          exact: true,
        });
        await memory
          .getByText(data.memories[0]!.summary, { exact: true })
          .first()
          .waitFor();
        await shot('memory');

        await open('能力');
        const capability = page.getByRole('region', {
          name: `${employeeName} · 能力`,
          exact: true,
        });
        await capability
          .getByRole('button', { name: /销售数据分析/ })
          .waitFor();
        await shot('capability');

        if (mobile) await hideRight.click();
        const settingsTrigger = page
          .locator('#chat-sidebar')
          .getByRole('button', { name: '设置', exact: true });
        if (!(await settingsTrigger.isVisible()))
          await page
            .getByRole('button', { name: '打开侧边栏', exact: true })
            .click();
        await page
          .locator('#chat-sidebar')
          .getByRole('button', { name: '自动化任务', exact: true })
          .click();
        await page
          .getByText('还没有自动化任务，在会话中创建的任务会显示在这里', {
            exact: true,
          })
          .waitFor();
        await shot('schedule');
        if (!(await settingsTrigger.isVisible()))
          await page
            .getByRole('button', { name: '打开侧边栏', exact: true })
            .click();
        await settingsTrigger.click();
        const settings = page.getByRole('region', {
          name: '设置',
          exact: true,
        });
        await settings.waitFor();
        expect(await settings.getByRole('button').allTextContents()).toEqual([
          'AllRice 账号',
          '通用设置 ↗',
        ]);
        await shot('settings');
        await settings
          .getByRole('button', { name: 'AllRice 账号', exact: true })
          .click();
        await settings.getByText('修改登录密码', { exact: true }).waitFor();
        await settings
          .getByRole('button', { name: '退出登录', exact: true })
          .waitFor();
        await settings
          .getByRole('button', { name: '通用设置 ↗', exact: true })
          .click();
        const native = page.locator('[data-shortcut-modal="settings"]');
        await native
          .getByRole('button', { name: '通用设置', exact: true })
          .waitFor();
        await page.keyboard.press('Escape');
        await native.waitFor({ state: 'hidden' });
        await open('企业资料');
        await materials.getByText(material.fileName, { exact: true }).waitFor();
        if (mobile) await hideRight.click();
        const input = page.locator('[contenteditable="true"]');
        await input.getByText(file.fileName, { exact: true }).waitFor();
        await input.getByText(material.fileName, { exact: true }).waitFor();
        const references = await page.evaluate(() =>
          window.__allriceSettingsWorkbench!.references(),
        );
        expect(references).toHaveLength(2);
        expect(references).toEqual(
          expect.arrayContaining([
            {
              label: file.fileName,
              text: expect.stringContaining(file.revisionId),
            },
            {
              label: material.fileName,
              text: expect.stringContaining(material.revisionId),
            },
          ]),
        );
        await shot('references');
        expect(errors).toEqual([]);
      } catch (error) {
        await shot('first-failure');
        throw error;
      } finally {
        await writeFile(
          join(artifacts, `r3-panel-${width}-trace.json`),
          JSON.stringify({ requests, errors }, null, 2),
        );
        await context.close();
      }
    },
    70_000,
  );
});
