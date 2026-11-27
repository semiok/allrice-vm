import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { startInstalledProfile } from './installed-profile';
import { createBrowserArtifacts } from './browser-artifacts';
import { createSidebarFixtureData } from './fixtures/sidebar-data.mjs';
import { employeeSettingsBrowserCases } from './employee-settings.browser-cases';

interface SettingsEvidence {
  accountOpened: number;
  oldSignalAborted: boolean;
  lateResponseApplied: boolean;
  lateResponseRejected: boolean;
  notificationCalls: number;
  bindings: number;
  unbindings: number;
  feedback: boolean[];
  settingsOpen: boolean;
  launcherReady: boolean;
  scopeKey: string | null;
  nativeShells: number;
  nativeLaunchers: number;
}
declare global {
  interface Window {
    __allriceSettingsIntegration?: {
      evidence: () => SettingsEvidence;
      markStage: (name: string) => void;
      diagnostics: () => unknown;
      closeAccount: () => void;
      setTheme: (theme: 'light' | 'dark') => void;
      toggleSidebar: () => void;
      holdPreferenceWrite: () => void;
      switchIdentity: () => void;
      releaseHeldPreferenceWrite: () => void;
      revokeIdentity: () => void;
      unload: () => Promise<void>;
      staleOpen: () => void;
      rebuild: () => Promise<void>;
      pulseNativeShell: () => Promise<void>;
    };
  }
}
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );

// Real installed native Host/Renderer/SettingsRoot. Every business surface is
// explicitly a synthetic test owner, never evidence of migrated 3.x business.
suite(
  'installed native settings with synthetic business owner (not 3.x migration)',
  () => {
    let browser: Browser, page: Page, artifacts: string;
    let host: Awaited<ReturnType<typeof startInstalledProfile>>;
    const errors: string[] = [],
      legacyRequests: string[] = [];
    const errorEvents: {
      observedDuringTest: string | null;
      source: 'pageerror' | 'console';
      message: string;
    }[] = [];
    let currentTest: string | null = null;
    const nativePanel = () => page.locator('[data-shortcut-modal="settings"]');
    const evidence = () =>
      page.evaluate(() => window.__allriceSettingsIntegration!.evidence());
    const openSettings = async () => {
      await page.evaluate(() => {
        window.__allriceSettingsIntegration!.markStage('openSettings:before');
        window.__allriceSettingsIntegration!.closeAccount();
      });
      if (await nativePanel().isVisible()) return;
      await page.waitForFunction(
        () => window.__allriceSettingsIntegration?.evidence().launcherReady,
      );
      const trigger = page
        .locator('#chat-sidebar')
        .getByRole('button', { name: '设置', exact: true });
      if (!(await trigger.isVisible()))
        await page.evaluate(() =>
          window.__allriceSettingsIntegration!.toggleSidebar(),
        );
      // This actually clicks the product button and its committed native action.
      await trigger.click();
      await nativePanel().waitFor({ state: 'visible' });
    };
    beforeAll(async () => {
      artifacts = await createBrowserArtifacts();
      console.info(`Synthetic-owner native settings evidence: ${artifacts}`);
      host = await startInstalledProfile(
        new URL('./fixtures/settings-integration-client.js', import.meta.url),
        {
          fixtureGlobals: {
            __allriceSidebarFixtureData: createSidebarFixtureData(),
          },
        },
      );
      browser = await chromium.launch({
        headless: true,
        ...(process.env.ALLRICE_BROWSER_EXECUTABLE
          ? { executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE }
          : {}),
      });
      await writeFile(
        join(artifacts, 'browser-identity.json'),
        JSON.stringify(
          {
            browser: browser.version(),
            node: process.version,
            nativeVersion: '0.2.1-rc.2',
            clock: '2026-11-21T12:00:00.000Z',
            dpr: 1,
            reducedMotion: 'reduce',
            screenshots: [1440, 390].flatMap((width) =>
              ['light', 'dark'].map((theme) => ({ width, theme })),
            ),
            businessOwner: 'synthetic fixture, not 3.x migration',
            artifactSha256: createHash('sha256')
              .update(
                await readFile(new URL('../dist/client.js', import.meta.url)),
              )
              .digest('hex'),
          },
          null,
          2,
        ),
      );
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        timezoneId: 'UTC',
      });
      await context.addInitScript(() => {
        Date.now = () => Date.parse('2026-11-21T12:00:00.000Z');
      });
      page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (error) => {
        errors.push(error.message);
        errorEvents.push({
          observedDuringTest: currentTest,
          source: 'pageerror',
          message: error.message,
        });
      });
      page.on('console', (message) => {
        if (message.type() === 'error') {
          errors.push(message.text());
          errorEvents.push({
            observedDuringTest: currentTest,
            source: 'console',
            message: message.text(),
          });
        }
      });
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/v1/')) legacyRequests.push(path);
      });
      await page.goto(host.authUrl);
      const proceed = page.getByRole('button', { name: /^(Continue|继续)$/ });
      await proceed
        .waitFor({ state: 'visible', timeout: 5000 })
        .catch(() => undefined);
      if (await proceed.isVisible()) await proceed.click();
    }, 90_000);
    beforeEach(async ({ task }) => {
      currentTest = task.name;
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(host.origin);
      await page.waitForFunction(
        () => window.__allriceSettingsIntegration?.evidence().launcherReady,
      );
      await settle(page);
    });
    afterEach(async ({ task }) => {
      const nativeDiagnostics =
        page && !page.isClosed()
          ? await page
              .evaluate(() =>
                window.__allriceSettingsIntegration?.diagnostics(),
              )
              .catch((error) => ({ captureError: String(error) }))
          : null;
      if (artifacts && page && !page.isClosed())
        await writeFile(
          join(artifacts, `owner-state-${task.id}.json`),
          JSON.stringify(
            {
              name: task.name,
              state: task.result?.state,
              owner: await evidence().catch(() => null),
              pageErrors: errors,
              errorEvents,
              nativeDiagnostics,
              legacyRequests,
            },
            null,
            2,
          ),
        );
      if (task.result?.state === 'fail' && artifacts) {
        await writeFile(
          join(artifacts, `first-failure-${task.id}.json`),
          JSON.stringify(
            {
              name: task.name,
              errors: task.result.errors,
              pageErrors: errors,
              errorEvents,
              nativeDiagnostics,
              legacyRequests,
              owner:
                page && !page.isClosed()
                  ? await evidence().catch(() => null)
                  : null,
            },
            null,
            2,
          ),
        );
        if (page && !page.isClosed())
          await page.screenshot({
            path: join(artifacts, `first-failure-${task.id}.png`),
            fullPage: true,
            animations: 'disabled',
          });
      }
    });
    afterAll(async () => {
      try {
        await browser?.close();
      } finally {
        await host?.close();
      }
    });

    employeeSettingsBrowserCases({
      page: () => page,
      artifacts: () => artifacts,
      openSettings,
      setTheme: async (theme) => {
        await page.evaluate(
          (mode) => window.__allriceSettingsIntegration!.setTheme(mode),
          theme,
        );
        await settle(page);
      },
      holdPreferenceWrite: async () => {
        await page.evaluate(() =>
          window.__allriceSettingsIntegration!.holdPreferenceWrite(),
        );
      },
      switchIdentity: async () => {
        await page.evaluate(() =>
          window.__allriceSettingsIntegration!.switchIdentity(),
        );
      },
      releaseHeldPreferenceWrite: async () => {
        await page.evaluate(() =>
          window.__allriceSettingsIntegration!.releaseHeldPreferenceWrite(),
        );
        expect((await evidence()).lateResponseRejected).toBe(true);
        expect(
          await page
            .getByRole('switch', { name: '流式输出', exact: true })
            .getAttribute('aria-checked'),
        ).toBe('true');
      },
      revokeIdentity: async () => {
        await page.evaluate(() =>
          window.__allriceSettingsIntegration!.revokeIdentity(),
        );
      },
      ownerEvidence: evidence,
    });

    it('clicks the only AllRice trigger in the real native shell and feeds native open state back', async () => {
      const trigger = page
        .locator('#chat-sidebar')
        .getByRole('button', { name: '设置', exact: true });
      expect(await trigger.count()).toBe(1);
      expect((await evidence()).nativeShells).toBe(1);
      expect((await evidence()).nativeLaunchers).toBe(1);
      await openSettings();
      expect(await nativePanel().count()).toBe(1);
      expect(await trigger.getAttribute('aria-expanded')).toBe('true');
      expect((await evidence()).settingsOpen).toBe(true);
      // The native shell owns the row; the renderer contributes the button alone.
      expect(
        await trigger.evaluate(
          (node) =>
            node.parentElement?.querySelectorAll(
              ':scope > button[aria-label="设置"]',
            ).length,
        ),
      ).toBe(1);
      await nativePanel()
        .getByRole('button', { name: '关闭', exact: true })
        .click();
      await nativePanel().waitFor({ state: 'detached' });
      expect((await evidence()).settingsOpen).toBe(false);
      expect((await evidence()).feedback).toEqual([true, false]);
      expect(legacyRequests).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('unloads the actual installed composition fiber, invalidates its old action and reapplies through public Cordis', async () => {
      await openSettings();
      await page.evaluate(() => window.__allriceSettingsIntegration!.unload());
      await nativePanel().waitFor({ state: 'detached' });
      expect((await evidence()).nativeShells).toBe(0);
      expect((await evidence()).launcherReady).toBe(false);
      await page.evaluate(() =>
        window.__allriceSettingsIntegration!.staleOpen(),
      );
      expect(await nativePanel().count()).toBe(0);
      await page.evaluate(() => window.__allriceSettingsIntegration!.rebuild());
      await page.waitForFunction(
        () => window.__allriceSettingsIntegration?.evidence().launcherReady,
      );
      expect((await evidence()).nativeShells).toBe(1);
      await openSettings();
      await nativePanel()
        .getByRole('button', { name: 'AllRice 账号', exact: true })
        .click();
      await page
        .getByRole('button', { name: '打开账号设置', exact: true })
        .waitFor();
      expect(errors).toEqual([]);
    });

    it('settles bindings when real SettingsRoot recreates onboarding and shortcut props on parent renders', async () => {
      await openSettings();
      const before = (await evidence()).bindings;
      await page.evaluate(() =>
        window.__allriceSettingsIntegration!.pulseNativeShell(),
      );
      await settle(page);
      const settled = (await evidence()).bindings;
      expect(settled).toBeGreaterThan(before);
      expect(settled - before).toBeLessThanOrEqual(48);
      await settle(page);
      expect((await evidence()).bindings).toBe(settled);
      expect((await evidence()).settingsOpen).toBe(true);
      expect(await nativePanel().count()).toBe(1);
      expect(errors).toEqual([]);
    });
  },
);

suite('production settings owner in the installed rc.2 workbench', () => {
  let host: Awaited<ReturnType<typeof startInstalledProfile>>;
  let browser: Browser;
  let artifacts: string;
  const id = (index: number) =>
    '10000000-0000-4000-8000-' + String(index).padStart(12, '0');
  const loginSessionId = id(6);

  beforeAll(async () => {
    artifacts = await createBrowserArtifacts();
    host = await startInstalledProfile();
    browser = await chromium.launch({
      headless: true,
      ...(process.env.ALLRICE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE }
        : {}),
    });
  }, 90_000);
  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await host?.close();
    }
  });

  it('opens the two approved settings entries, calls native General and sends account actions for the exact login', async () => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      const authenticated = await context.request.get(host.authUrl);
      expect(authenticated.ok()).toBe(true);
      const employee = createSidebarFixtureData().employees[1]!;
      const roster = {
        organizationId: id(1),
        workspaceId: id(2),
        viewerId: id(3),
        employees: [{ ...employee, id: id(4), employeeId: id(4) }],
        sessions: [
          {
            ...createSidebarFixtureData().sessions[1],
            id: id(5),
            ownerId: id(3),
            employeeInstanceId: id(4),
            employeeAssignmentId: id(4),
            executionGeneration: '4.0',
          },
        ],
      };
      const documentOwner = `<script>const documentLifetime = new AbortController(); window.__ALLRICE_D_ENTRY_LIFETIME__ = documentLifetime.signal; window.revokeTestDocument = () => documentLifetime.abort();</script>
        <div hidden id="app" data-organization-id="${id(1)}" data-workspace-id="${id(2)}" data-viewer-id="${id(3)}" data-employee-instance-id="${id(4)}" data-thread-id="${id(5)}" data-login-session-id="${loginSessionId}" data-scope-id="${id(7)}" data-native-session-id="session-00000000-0000-4000-8000-000000000036"></div>
        <script id="allrice-employee-directory" type="application/json">${JSON.stringify(roster).replaceAll('<', '\\u003c')}</script>`;
      await page.route(host.origin + '/', async (route) => {
        const upstream = await route.fetch();
        const html = await upstream.text();
        expect(html).toContain('</body>');
        await route.fulfill({
          response: upstream,
          body: html.replace('</body>', documentOwner + '</body>'),
        });
      });
      await page.route('**/api/v1/d-entry/panels/**', (route) =>
        route.fulfill({ status: 403, json: {} }),
      );
      await page.route('**/api/v1/auth/password', (route) => {
        expect(route.request().method()).toBe('POST');
        expect(route.request().headers()['x-allrice-expected-session-id']).toBe(
          loginSessionId,
        );
        return route.fulfill({ status: 401 });
      });
      await page.route('**/api/v1/auth/logout', (route) => {
        expect(route.request().method()).toBe('POST');
        expect(route.request().headers()['x-allrice-expected-session-id']).toBe(
          loginSessionId,
        );
        return route.fulfill({ status: 204 });
      });
      await page.route(host.origin + '/login', (route) =>
        route.fulfill({ body: 'synthetic sign-in landing' }),
      );
      await page.goto(host.origin);
      const trigger = page.locator('#chat-sidebar').getByRole('button', {
        name: '设置',
        exact: true,
      });
      await trigger.click();
      const pane = page.getByRole('region', { name: '设置', exact: true });
      await pane.waitFor();
      expect(await pane.getByRole('button').allTextContents()).toEqual([
        'AllRice 账号',
        '通用设置 ↗',
      ]);
      await page.screenshot({
        path: join(artifacts, 'production-settings-1440.png'),
      });
      await pane
        .getByRole('button', { name: '通用设置 ↗', exact: true })
        .click();
      const native = page.locator('[data-shortcut-modal="settings"]');
      await native.waitFor({ state: 'visible' });
      expect(
        await native
          .getByRole('button', { name: '通用设置', exact: true })
          .count(),
      ).toBe(1);
      for (const name of ['我的电脑', '工作方式', '已链接应用'])
        expect(
          await native.getByRole('button', { name, exact: true }).count(),
        ).toBe(0);
      await page.keyboard.press('Escape');
      await native.waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 390, height: 844 });
      await pane.waitFor();
      await page.screenshot({
        path: join(artifacts, 'production-settings-390.png'),
      });
      await pane
        .getByRole('button', { name: 'AllRice 账号', exact: true })
        .click();
      await pane.getByText('修改登录密码', { exact: true }).click();
      await pane
        .getByLabel('当前密码', { exact: true })
        .fill('old-test-password');
      await pane
        .getByLabel('新密码', { exact: true })
        .fill('new-test-password');
      await pane
        .getByLabel('确认新密码', { exact: true })
        .fill('new-test-password');
      await pane.getByRole('button', { name: '修改密码并重新登录' }).click();
      await pane
        .getByRole('alert')
        .getByText('当前密码不正确，或登录已过期。')
        .waitFor();
      await pane.getByRole('button', { name: '退出登录', exact: true }).click();
      await page.waitForURL(host.origin + '/login');
    } finally {
      await context.close();
    }
  }, 45_000);
});
