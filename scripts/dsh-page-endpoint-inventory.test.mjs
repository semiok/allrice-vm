import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sensitivePageCapability } from '../packages/d-entry-principal/src/page-capability-policy.ts';
import {
  addedSensitivePageEndpoints,
  collectPageEndpoints,
} from './dsh-page-endpoint-inventory.mjs';

const endpoint = (namespace, method, service = namespace) => ({
  namespace,
  method,
  service,
});

it('reads public generated metadata for the pinned release while old store entries exist', async () => {
  const store = await mkdtemp(join(tmpdir(), 'dsh-page-endpoints-'));
  try {
    const name = '@deepseek-ai/dsh-test';
    const version = '0.2.1-rc.2';
    const packageRoot = join(
      store,
      `@deepseek-ai+dsh-test@${version}_peer`,
      'node_modules',
      name,
    );
    await mkdir(join(store, '@deepseek-ai+dsh-test@0.2.0-rc.2'));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name, version, exports: { './typert': './host.mjs' } }),
    );
    await writeFile(
      join(packageRoot, 'host.mjs'),
      `export const TYPERT = ${JSON.stringify({
        package: name,
        face: 'host',
        invocations: [endpoint('session', 'futureMethod', 'sessionController')],
      })}`,
    );
    await expect(collectPageEndpoints(store, version)).resolves.toEqual([
      `${name}\tsession/futureMethod\tsessionController\tunary`,
    ]);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

it('groups new methods by managed DSH capability and leaves the peer snapshot and ordinary verbs available', () => {
  expect(
    sensitivePageCapability(endpoint('remoteAccess', 'follow')),
  ).toBeUndefined();
  expect(sensitivePageCapability(endpoint('remoteAccess', 'mint'))).toBe(
    'native-identity',
  );
  expect(sensitivePageCapability(endpoint('account', 'newSignIn'))).toBe(
    'native-identity',
  );
  expect(
    sensitivePageCapability(endpoint('addon', 'activate', 'pluginManager')),
  ).toBe('plugin-management');
  expect(sensitivePageCapability(endpoint('updater', 'applyRelease'))).toBe(
    'runtime-upgrade',
  );
  expect(sensitivePageCapability(endpoint('credentials', 'repin'))).toBe(
    'provider-configuration',
  );
  expect(sensitivePageCapability(endpoint('llm', 'discoverModels'))).toBe(
    'provider-configuration',
  );
  expect(
    sensitivePageCapability(endpoint('llm', 'listProviders')),
  ).toBeUndefined();
  expect(
    sensitivePageCapability(endpoint('session', 'futureMethod')),
  ).toBeUndefined();
});

it('distinguishes an installed provider’s native settings namespace from ordinary settings', () => {
  const mutation = endpoint('settings', 'mutate', 'settingsController');
  const providerSettings = new Set(['configured-model-backend']);
  expect(
    sensitivePageCapability(mutation, {
      providerSettings,
      args: { ns: 'configured-model-backend' },
    }),
  ).toBe('provider-configuration');
  expect(
    sensitivePageCapability(mutation, {
      providerSettings,
      args: { ns: 'language-and-theme' },
    }),
  ).toBeUndefined();
  expect(sensitivePageCapability(mutation)).toBe('provider-configuration');
});

it('keeps plugin lifecycle and platform settings managed while relaying inventory and inspection', () => {
  for (const method of [
    'inventory',
    'syncInspectManifest',
    'resolveInspectQuery',
  ]) {
    expect(
      sensitivePageCapability(endpoint('dynamicCordisRunner', method)),
    ).toBeUndefined();
  }
  for (const method of [
    'runHostHalf',
    'settleUserRun',
    'resolveRequestRun',
    'stopFromPanel',
    'undefineFromPanel',
  ]) {
    expect(
      sensitivePageCapability(endpoint('dynamicCordisRunner', method)),
    ).toBe('plugin-management');
  }
  expect(
    sensitivePageCapability(endpoint('pluginMarket', 'search')),
  ).toBeUndefined();
  expect(sensitivePageCapability(endpoint('pluginMarket', 'setIndexes'))).toBe(
    'plugin-management',
  );
  expect(
    sensitivePageCapability(endpoint('settings', 'openSettingsDocument')),
  ).toBe('platform-settings');
});

it('reports only additions matching sensitive capabilities and ignores removals and existing endpoints', () => {
  const row = (path, service, mode = 'unary') =>
    `@deepseek-ai/dsh-test\t${path}\t${service}\t${mode}`;
  const old = row('account/startSignIn', 'accountController');
  expect(
    addedSensitivePageEndpoints(
      [old, row('workspace/follow', 'workspaceController', 'stream')],
      [
        old,
        row('session/nextOrdinaryAction', 'sessionController'),
        row('pluginManager/installFromArchive', 'pluginManager'),
        row('credentials/watch', 'credentialsController', 'stream'),
        row('terminal/create', 'terminalController'),
      ],
    ).map(({ endpoint, category }) => [endpoint, category]),
  ).toEqual([
    ['pluginManager/installFromArchive', 'plugin-management'],
    ['credentials/watch', 'provider-configuration'],
  ]);
});
