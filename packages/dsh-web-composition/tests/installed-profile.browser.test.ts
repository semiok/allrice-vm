import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInstalledProfile } from './installed-profile';
import { registerSubagentPanelBrowserTest } from './subagent-panel-browser';
import {
  deliveryName,
  documentSession,
  processSession,
} from './native-history.mjs';

declare global {
  interface Window {
    __allriceCompositionTest?: {
      openSession: (id: string) => void;
      officeUnavailable: () => string;
      startSession: (cwd: string) => Promise<void>;
      selectFixtureEmployee: (id: 'gold' | 'orange') => void;
      setTheme: (mode: 'light' | 'dark') => void;
    };
  }
}

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('installed rc.2 subagent sidebar', registerSubagentPanelBrowserTest);
suite('installed AllRice native Web composition', () => {
  let browser: Browser, page: Page;
  let host: Awaited<ReturnType<typeof startInstalledProfile>>;
  const errors: string[] = [];

  beforeAll(async () => {
    host = await startInstalledProfile(undefined, {
      hostFixture: {
        source: new URL('./fixtures/conversation-host.js', import.meta.url),
        patch: [
          {
            id: 'agent-default-model',
            config: { provider: 'r2-browser-fixture', model: 'fixture-sol' },
          },
        ],
      },
    });
    const { origin, authUrl } = host;
    // The generated Web token stays in memory; no credential file is read/copied.
    browser = await chromium.launch({
      headless: true,
      ...(process.env.ALLRICE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE }
        : {}),
    });
    page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(authUrl);
    const proceed = page.getByRole('button', { name: /^(Continue|继续)$/ });
    await proceed
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => undefined);
    if (await proceed.isVisible()) await proceed.click();
    await page.goto(origin);
    await page.waitForFunction(() => !!window.__allriceCompositionTest);
  }, 90_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await host?.close();
    }
  });

  it('keeps native disclosure, drafts, answered questions and document preview after actual installation', async () => {
    try {
      await page
        .getByText('请核对三条销售记录，计算合计，并简要说明结果。', {
          exact: true,
        })
        .waitFor();
      for (const width of [1440, 390])
        for (const theme of ['light', 'dark'] as const) {
          await page.setViewportSize({ width, height: 1000 });
          await page.evaluate(
            (mode) => window.__allriceCompositionTest!.setTheme(mode),
            theme,
          );
          const group = page.getByRole('button', {
            name: '已完成，用时 10秒',
            exact: true,
          });
          if ((await group.getAttribute('aria-expanded')) === 'false')
            await group.click();
          const tool = page.getByRole('button', {
            name: '执行了命令',
            exact: true,
          });
          if ((await tool.getAttribute('aria-expanded')) === 'false')
            await tool.click();
          const command = page
            .getByRole('button', { name: /^运行命令/ })
            .first();
          if ((await command.getAttribute('aria-expanded')) === 'false')
            await command.click();
          expect(
            await page
              .getByText('node tasks/pair/action.cjs', { exact: true })
              .isVisible(),
          ).toBe(true);
          expect(
            await page
              .getByText(/"totalCents":5630/)
              .first()
              .isVisible(),
          ).toBe(true);
          expect(
            await page
              .getByRole('button', { name: '1 个子智能体', exact: true })
              .isVisible(),
          ).toBe(true);
          expect(
            await page
              .getByRole('tab', { name: /^(Chat|Trajectory|对话|轨迹)$/ })
              .count(),
          ).toBe(0);
          expect(
            await page
              .getByRole('button', { name: /^(更多操作|More actions)$/ })
              .count(),
          ).toBe(0);
          expect(
            await page.getByRole('button', { name: /上下文已用/ }).isVisible(),
          ).toBe(true); // documented upstream gap
          expect(await page.locator('body').innerText()).not.toContain(
            'Open In',
          );
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
          ).toBe(false);
          await command.click();
          await tool.click();
          await group.click();
        }
      const editor = page
        .locator('textarea:visible,[contenteditable=true]:visible')
        .first();
      await editor.fill('未发送的原生草稿');
      await page
        .getByRole('button', { name: '已完成，用时 10秒', exact: true })
        .click();
      expect(
        await editor.evaluate((node) =>
          node instanceof HTMLTextAreaElement ? node.value : node.textContent,
        ),
      ).toContain('未发送的原生草稿');
      await editor.fill('');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.evaluate(
        (id) => window.__allriceCompositionTest!.openSession(id),
        documentSession,
      );
      await page
        .getByText('已按你选择的 Markdown 格式交付核对说明。', { exact: true })
        .waitFor();
      const questionProcess = page
        .getByRole('button', { name: /^已完成，用时/ })
        .first();
      if ((await questionProcess.getAttribute('aria-expanded')) === 'false')
        await questionProcess.click();
      const questionStep = page.getByRole('button', {
        name: '向用户提出了问题并已调用工具',
        exact: true,
      });
      if ((await questionStep.getAttribute('aria-expanded')) === 'false')
        await questionStep.click();
      // The fixture follows the standard preset's legacy ask-user tool. Its
      // answered transcript opens inline; timed calls alone have View answers.
      const questionRow = page.getByRole('button', { name: /^提问/ });
      const questionExpanded = await questionRow.getAttribute('aria-expanded');
      expect(
        await page.getByText('1/1 已回答', { exact: true }).isVisible(),
      ).toBe(true);
      if (questionExpanded === 'false') await questionRow.click();
      expect(
        await page
          .getByText('核对说明采用哪种格式？', { exact: true })
          .isVisible(),
      ).toBe(true);
      expect(
        await page.getByText('Markdown', { exact: true }).first().isVisible(),
      ).toBe(true);
      await page
        .getByRole('button', {
          name: new RegExp(`^在侧边栏预览 .*${deliveryName}$`),
        })
        .click();
      await page.getByText('原生文档保留验证', { exact: true }).waitFor();
      expect(
        await page.getByText('56.30 元', { exact: true }).isVisible(),
      ).toBe(true);
      await page.reload();
      await page.waitForFunction(() => !!window.__allriceCompositionTest);
      await page.evaluate(
        (id) => window.__allriceCompositionTest!.openSession(id),
        processSession,
      );
      await page
        .getByText(/命令已执行一次，结果为 P4_ACTION_DONE=true/)
        .waitFor();
      expect(errors).toEqual([]);
    } catch (error) {
      // Optional screenshots contain the rendered UI only, never login URL or credentials.
      if (process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR) {
        const target = resolve(
          process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR,
        );
        await mkdir(target, { recursive: true });
        const attempt = await mkdtemp(
          join(target, 'installed-profile-failure-'),
        );
        await page.screenshot({
          path: join(attempt, 'page.png'),
          fullPage: true,
        });
        await writeFile(
          join(attempt, 'body.txt'),
          await page.locator('body').innerText(),
        );
      }
      throw error;
    }
  }, 60_000);
  it('renders native controls and live work from a real rc.2 turn', async () => {
    try {
      await page.evaluate(
        (id) => window.__allriceCompositionTest!.openSession(id),
        processSession,
      );
      await writeFile(
        join(host.root, 'workspace', 'visible-tool-witness.txt'),
        'R2 工具在这次测试中读取了原生工作区。',
      );
      const permission = page.getByRole('button', { name: /访问模式，当前/ });
      const model = page.getByRole('button', {
        name: /^请?选择模型/,
      });
      await model.waitFor();
      expect(await permission.count()).toBe(0);
      await model.click();
      await page.getByRole('menuitemradio', { name: 'Fixture Nova' }).click();
      await page.getByRole('button', { name: /当前 Fixture Nova/ }).waitFor();

      const composer = page
        .locator('textarea:visible,[contenteditable=true]:visible')
        .first();
      await composer.fill('请读取当前工作区的测试文件。');
      await composer.press('Enter');
      const running = page.getByText(/思考中.*用时/);
      await running.waitFor();
      await writeFile(join(host.root, 'fixture-plugin', 'issue-tool'), '');
      await page
        .getByRole('button', {
          name: '读取 visible-tool-witness.txt',
          exact: true,
        })
        .waitFor();
      expect(await running.isVisible()).toBe(true);
      const capture = async (name: string) => {
        const evidence = process.env.ALLRICE_RUN_BRAND_EVIDENCE;
        const directory = process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR;
        if (!directory && !evidence) return;
        const target = directory
          ? resolve(directory)
          : resolve(process.env.HOME!, '..', 'evidence', evidence!);
        await mkdir(target, { recursive: true });
        await page.screenshot({
          path: join(target, `controls-${name}.png`),
          fullPage: true,
          animations: 'disabled',
        });
      };
      const status = page.locator('[data-chat-running]');
      expect(await status.getByRole('status').textContent()).toBe('思考中');
      expect(await status.locator('svg:visible').count()).toBe(0);
      for (const width of [1440, 390])
        for (const mode of ['light', 'dark'] as const) {
          await page.setViewportSize({ width, height: 1000 });
          let previousBackground: string | undefined;
          for (const employee of ['gold', 'orange'] as const) {
            await page.evaluate(
              ({ employee, mode }) => {
                const fixture = window.__allriceCompositionTest!;
                fixture.setTheme(mode);
                fixture.selectFixtureEmployee(employee);
              },
              { employee, mode },
            );
            const accent = employee === 'gold' ? '#EAB308' : '#F97316';
            const stop = page.getByRole('button', {
              name: '停止生成',
              exact: true,
            });
            await stop.waitFor();
            const button = await stop.evaluate(async (element) => {
              // The native button animates background-color when its token changes.
              await Promise.all(
                element
                  .getAnimations()
                  .flatMap((animation) =>
                    animation instanceof CSSTransition &&
                    animation.transitionProperty === 'background-color'
                      ? [animation.finished]
                      : [],
                  ),
              );
              const css = getComputedStyle(element);
              return {
                token: css
                  .getPropertyValue('--dsw-alias-button-info-fill')
                  .trim(),
                background: css.backgroundColor,
              };
            });
            expect(button.token.toLowerCase()).toContain(accent.toLowerCase());
            expect(button.background).not.toBe(previousBackground);
            previousBackground = button.background;
            expect(
              (
                await status.evaluate((element) =>
                  getComputedStyle(element).getPropertyValue(
                    '--dsw-alias-label-deep-diving-shimmer',
                  ),
                )
              ).toLowerCase(),
            ).toContain(accent.toLowerCase());
            await capture(`running-${width}-${mode}-${employee}`);
          }
        }
      await writeFile(join(host.root, 'fixture-plugin', 'finish-turn'), '');
      await page
        .getByText('R2 浏览器收到原生回合结果。', { exact: true })
        .waitFor();
      await running.waitFor({ state: 'hidden' });

      const activity = page
        .getByRole('button', { name: /\d+ 轮 \d+ 步.*tok\/s/ })
        .last();
      const usage = page.getByRole('button', { name: /tok.*缓存命中/ }).last();
      for (const width of [1440, 390])
        for (const theme of ['light', 'dark'] as const) {
          await page.setViewportSize({ width, height: 1000 });
          await page.evaluate(
            (mode) => window.__allriceCompositionTest!.setTheme(mode),
            theme,
          );
          expect(await permission.count()).toBe(0);
          await model.waitFor();
          await activity.waitFor();
          await usage.waitFor();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          await capture(`${width}-${theme}`);
        }
      expect(errors).toEqual([]);
    } catch (error) {
      console.info(
        'R2 isolated conversation browser state:\n' +
          (await page.locator('body').ariaSnapshot()).slice(0, 10000),
      );
      throw error;
    }
  }, 60_000);
  it('renders AllRice on an actual new native conversation without the two workspace controls', async () => {
    await page.evaluate(
      (cwd) => window.__allriceCompositionTest!.startSession(cwd),
      join(host.root, 'workspace'),
    );
    const hero = page.locator('[data-allrice-hero-brand]');
    await hero.waitFor();
    expect(await hero.innerText()).toContain('AllRice');
    expect(await hero.innerText()).toContain('Do it right. Make it nice.');
    expect(await hero.getByText('预览版').isVisible()).toBe(true);
    expect(
      await page.evaluate(() =>
        window.__allriceCompositionTest!.officeUnavailable(),
      ),
    ).toBe('Office 文档暂时无法预览。请联系管理员。');
    expect(
      await hero
        .locator('img')
        .evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
    ).toBe(true);
    expect(await page.getByText('探索未至之境').isVisible()).toBe(false);
    expect(
      await page.getByRole('button', { name: /选择工作区|标准模式/ }).count(),
    ).toBe(0);
    const composer = page
      .locator('[data-composer-input][contenteditable="true"]')
      .first();
    await composer.fill('验证原生编辑器');
    const send = page.getByRole('button', { name: '发送消息', exact: true });
    await send.waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const mode of ['light', 'dark'] as const) {
        await page.evaluate(
          (mode) => window.__allriceCompositionTest!.setTheme(mode),
          mode,
        );
        const target = process.env.ALLRICE_RUN_BRAND_EVIDENCE;
        if (target) {
          const directory = resolve(
            process.env.HOME!,
            '..',
            'evidence',
            target,
          );
          await mkdir(directory, { recursive: true });
          await page.screenshot({
            path: join(directory, `hero-${width}-${mode}.png`),
            animations: 'disabled',
          });
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
      }
    }
    expect(errors).toEqual([]);
  }, 45_000);
});
