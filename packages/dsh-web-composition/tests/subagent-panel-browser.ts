import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type WebSocketRoute } from 'playwright-core';
import { expect, it } from 'vitest';
import { startInstalledProfile } from './installed-profile';

const rootId = 'session-00000000-0000-4000-8000-000000000086';
export function registerSubagentPanelBrowserTest() {
  it('keeps the parent draft and follows both native child modes read-only across reconnect', async () => {
    const host = await startInstalledProfile(undefined, {
      hostFixture: {
        source: new URL('./fixtures/subagent-host.js', import.meta.url),
        patch: [],
      },
    });
    const fixture = (name: string) => join(host.root, 'fixture-plugin', name);
    try {
      await expect
        .poll(async () => {
          const error = await readFile(fixture('fixture-error'), 'utf8').catch(
            () => undefined,
          );
          if (error) throw new Error(error);
          return access(fixture('root-ready')).then(
            () => true,
            () => false,
          );
        })
        .toBe(true);
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE,
      });
      try {
        const page = await browser.newPage({
          viewport: { width: 1440, height: 1000 },
          deviceScaleFactor: 1,
        });
        page.setDefaultTimeout(15_000);
        const sockets: WebSocketRoute[] = [];
        let reconnectGate: Promise<void> | undefined;
        await page.routeWebSocket('**/api/remote.mux', async (route) => {
          await reconnectGate;
          route.connectToServer();
          sockets.push(route);
        });
        try {
          await page.goto(host.authUrl);
          const proceed = page.getByRole('button', {
            name: /^(Continue|继续)$/,
          });
          await proceed
            .waitFor({ state: 'visible', timeout: 5000 })
            .catch(() => undefined);
          if (await proceed.isVisible()) await proceed.click();
          await page.goto(host.origin);
          await page.waitForFunction(() => !!window.__allriceCompositionTest);
          await page.evaluate(
            (id) => window.__allriceCompositionTest!.openSession(id),
            rootId,
          );
          const root = page.getByText('主对话历史仍在。', { exact: true });
          await root.waitFor();
          const count = page.getByRole('button', { name: /\d+ 个子智能体/ });
          expect(await count.count()).toBe(0);
          const editor = page.getByRole('textbox', {
            name: /发消息或创建任务/,
          });
          const draft = '这里是没有发送的主会话草稿';
          await editor.fill(draft);
          await writeFile(fixture('add-children'), '');
          const two = page.getByRole('button', {
            name: '2 个子智能体',
            exact: true,
          });
          const sidebar = page.locator('[data-sidebar-chat]:visible');
          const openChild = async (label: string, text: string) => {
            await two.click();
            await page
              .getByRole('treeitem', { name: new RegExp(label) })
              .click();
            await sidebar.getByText(text, { exact: true }).waitFor();
            await sidebar
              .getByText('只读会话 · 由主员工安排后续工作', { exact: true })
              .waitFor();
            expect(await sidebar.getByRole('textbox').count()).toBe(0);
            await page.getByRole('tab', { name: new RegExp(label) }).waitFor();
          };
          await openChild('核对销售记录', '单次任务核对完成。');
          await openChild('持续整理会议纪要和行动清单', '持续任务已记录结论。');
          const oneShot = page.getByRole('tab', { name: /核对销售记录/ });
          const continuable = page.getByRole('tab', {
            name: /持续整理会议纪要和行动清单/,
          });
          const oneShotReply = sidebar.getByText('单次任务核对完成。', {
            exact: true,
          });
          const continuableReply = sidebar.getByText('持续任务已记录结论。', {
            exact: true,
          });
          const liveReply = sidebar.getByText('子任务实时补充已到达。', {
            exact: true,
          });
          await writeFile(fixture('child-live'), '');
          await liveReply.waitFor();
          await oneShot.click();
          await oneShotReply.waitFor();
          await continuableReply.waitFor({ state: 'hidden' });
          expect(await liveReply.count()).toBe(0);
          expect(await oneShot.getAttribute('aria-selected')).toBe('true');
          await continuable.click();
          await continuableReply.waitFor();
          await oneShotReply.waitFor({ state: 'hidden' });
          expect(await continuable.getAttribute('aria-selected')).toBe('true');
          await liveReply.waitFor();
          expect(await liveReply.count()).toBe(1);
          const connections = sockets.length;
          expect(connections).toBeGreaterThan(0);
          const reconnect = Promise.withResolvers<void>();
          reconnectGate = reconnect.promise;
          try {
            await sockets
              .at(-1)!
              .close({ code: 4012, reason: 'isolated reconnect' });
            await writeFile(fixture('child-reconnect'), '');
            await expect
              .poll(() =>
                access(fixture('child-reconnect-ready')).then(
                  () => true,
                  () => false,
                ),
              )
              .toBe(true);
            expect(sockets).toHaveLength(connections);
          } finally {
            reconnectGate = undefined;
            reconnect.resolve();
          }
          await expect.poll(() => sockets.length).toBeGreaterThan(connections);
          const replay = sidebar.getByText('子任务在重连后仍完整。', {
            exact: true,
          });
          await replay.waitFor();
          expect(await replay.count()).toBe(1);
          expect(await liveReply.count()).toBe(1);
          for (const width of [1440, 390])
            for (const theme of ['light', 'dark'] as const) {
              await page.setViewportSize({ width, height: 1000 });
              await page.evaluate(
                (mode) => window.__allriceCompositionTest!.setTheme(mode),
                theme,
              );
              await replay.waitFor();
              expect(await sidebar.getByRole('textbox').count()).toBe(0);
              expect(
                await page.evaluate(() => document.documentElement.scrollWidth),
              ).toBeLessThanOrEqual(width);
              if (process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR) {
                const target = resolve(
                  process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR,
                );
                await mkdir(target, { recursive: true });
                await page.screenshot({
                  path: join(target, `subagent-${width}-${theme}.png`),
                  animations: 'disabled',
                });
              }
            }
          await page.setViewportSize({ width: 1440, height: 1000 });
          expect(await editor.textContent()).toContain(draft);
          await root.waitFor();
        } catch (error) {
          console.info(
            'Isolated rc.2 sidebar state:\n' +
              (await page.locator('body').ariaSnapshot()).slice(0, 12000),
          );
          console.info(
            'Isolated native fixture error:',
            await readFile(fixture('fixture-error'), 'utf8').catch(
              () => 'none',
            ),
          );
          throw error;
        }
      } finally {
        await browser.close();
      }
    } finally {
      await host.close();
    }
  }, 90_000);
}
