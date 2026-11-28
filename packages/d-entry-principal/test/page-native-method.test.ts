import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { pageSettingsNamespaces } from '../src/page-capability-policy.js';
import {
  encodePageNativeResult,
  requirePageNativeMethod,
} from '../src/page-native-method.js';

function descriptor(
  namespace: string,
  method: string,
  options: Partial<InvocationDescriptor> = {},
): InvocationDescriptor {
  return {
    id: `@deepseek-ai/dsh-fixture#${namespace}/${method}`,
    namespace,
    method,
    service: namespace,
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: 'Fixture',
      create: () => z.string(),
    },
    ...options,
  };
}

it('uses a live DSH descriptor for new native methods and requires the matching carrier', () => {
  const search = descriptor('session', 'search');
  const registry = { get: () => search };
  expect(
    requirePageNativeMethod(registry, 'session/search', 'unary', {}, new Set()),
  ).toBe(search);
  expect(() =>
    requirePageNativeMethod(
      registry,
      'session/search',
      'stream',
      {},
      new Set(),
    ),
  ).toThrow('此操作暂不可用');
  expect(() =>
    requirePageNativeMethod(registry, 'session/other', 'unary', {}, new Set()),
  ).toThrow('此操作暂不可用');
});

it('keeps Standard managed while allowing the native preset and language reads', () => {
  const require = (endpoint: string, args = {}) => {
    const [ns, method] = endpoint.split('/') as [string, string];
    return requirePageNativeMethod(
      { get: () => descriptor(ns, method) },
      endpoint,
      'unary',
      args,
      new Set(),
    );
  };
  expect(() => require('agentPresets/select')).toThrow('此操作由平台管理');
  expect(() =>
    require('settings/update', { ns: 'agent-preset-registry' }),
  ).toThrow('此操作由平台管理');
  expect(require('agentPresets/list').method).toBe('list');
  expect(require('settings/update', { ns: 'locale' }).method).toBe('update');
});

it('admits native terminal methods with their ordinary stream uplink descriptor', () => {
  const create = descriptor('terminal', 'create');
  const attach = descriptor('terminal', 'attach', {
    mode: 'stream',
    uplink: {
      codec: {
        mode: 'strict',
        typeSymbol: 'TerminalInput',
        create: () => z.string(),
      },
    },
  });
  expect(
    requirePageNativeMethod(
      { get: () => create },
      'terminal/create',
      'unary',
      {},
      new Set(),
    ),
  ).toBe(create);
  expect(
    requirePageNativeMethod(
      { get: () => attach },
      'terminal/attach',
      'stream',
      {},
      new Set(),
    ),
  ).toBe(attach);
});

it('excludes the private AllRice registry and refuses managed operations before dispatch', () => {
  const privateMethod = descriptor('allricePrincipal', 'openScope', {
    id: '@allrice/d-entry-principal#allricePrincipal/openScope',
  });
  const activate = descriptor('dynamicCordisRunner', 'runHostHalf');
  expect(() =>
    requirePageNativeMethod(
      { get: () => privateMethod },
      'allricePrincipal/openScope',
      'unary',
      {},
      new Set(),
    ),
  ).toThrow('此操作暂不可用');
  expect(() =>
    requirePageNativeMethod(
      { get: () => activate },
      'dynamicCordisRunner/runHostHalf',
      'unary',
      {},
      new Set(),
    ),
  ).toThrow('此操作由平台管理');
});

it('allows inventories and ordinary settings through the same native boundary', () => {
  for (const [namespace, method] of [
    ['pluginManager', 'listPlugins'],
    ['pluginInventory', 'list'],
    ['dynamicCordisRunner', 'inventory'],
    ['pluginMarket', 'search'],
    ['settings', 'update'],
    ['session', 'selectModel'],
  ]) {
    const native = descriptor(namespace!, method!);
    expect(
      requirePageNativeMethod(
        { get: () => native },
        `${namespace}/${method}`,
        'unary',
        { ns: 'general' },
        new Set(['provider']),
      ),
    ).toBe(native);
  }
});

it('keeps sensitive Host effects and file preview unavailable even when registered', () => {
  const settings = descriptor('settings', 'update');
  expect(() =>
    requirePageNativeMethod(
      { get: () => settings },
      'settings/update',
      'unary',
      {
        ns: 'the-profile-market-entry',
      },
      new Set(),
      new Set(['the-profile-market-entry']),
    ),
  ).toThrow('此操作由平台管理');
  for (const [namespace, method, mode] of [
    ['account', 'watch', 'stream'],
    ['remoteAccess', 'pair', 'unary'],
    ['credentials', 'set', 'unary'],
    ['settings', 'openSettingsDocument', 'unary'],
    ['settings', 'replace', 'unary'],
    ['pluginManager', 'installBundle', 'unary'],
    ['dynamicCordisRunner', 'settleUserRun', 'unary'],
    ['pluginMarket', 'setIndexes', 'unary'],
    ['runtimeUpgrade', 'install', 'unary'],
    ['workspaceFiles', 'changes', 'stream'],
    ['workspaceFiles', 'readBytes', 'unary'],
    ['officeToPdf', 'render', 'unary'],
  ] as const) {
    const native = descriptor(
      namespace,
      method,
      mode === 'stream' ? { mode } : {},
    );
    expect(() =>
      requirePageNativeMethod(
        { get: () => native },
        `${namespace}/${method}`,
        mode,
        { ns: 'provider' },
        new Set(['provider']),
      ),
    ).toThrow(/此操作(?:由平台管理|暂不可用)/);
  }
});

it('protects the loaded default model entry under its profile ID while leaving ordinary settings available', () => {
  const { providerSettings, pluginSettings } = pageSettingsNamespaces(
    [
      {
        entry: {
          options: {
            id: 'profile-model',
            name: '@deepseek-ai/dsh-agent-default-model',
          },
        },
      },
      {
        entry: {
          options: {
            id: 'appearance',
            name: '@deepseek-ai/dsh-client-ui-theme',
          },
        },
      },
    ],
    [{ settingsNs: 'configured-provider' }],
  );
  for (const method of ['update', 'replace', 'mutate']) {
    const native = descriptor('settings', method);
    const endpoint = `settings/${method}`;
    for (const ns of ['profile-model', 'configured-provider']) {
      expect(() =>
        requirePageNativeMethod(
          { get: () => native },
          endpoint,
          'unary',
          { ns },
          providerSettings,
          pluginSettings,
        ),
      ).toThrow('此操作由平台管理');
    }
    expect(
      requirePageNativeMethod(
        { get: () => native },
        endpoint,
        'unary',
        { ns: 'appearance' },
        providerSettings,
        pluginSettings,
      ),
    ).toBe(native);
  }
});

it('retains native attachment bytes and paths, and validates results before returning them', () => {
  const attachment = descriptor('session', 'attachment', {
    result: {
      mode: 'strict',
      typeSymbol: 'FixtureBytes',
      create: () => z.object({ nested: z.array(z.instanceof(Uint8Array)) }),
      encode: (input, writeBytes) => {
        const { nested } = z
          .object({ nested: z.array(z.instanceof(Uint8Array)) })
          .parse(input);
        return {
          nested: nested.map((bytes, i) => writeBytes(bytes, ['nested', i])),
        };
      },
    },
  });
  const bytes = new Uint8Array([1, 2, 3]);
  expect(encodePageNativeResult(attachment, { nested: [bytes] })).toEqual({
    value: { nested: [null] },
    attachments: [{ bytes, path: ['nested', 0] }],
  });
  expect(() =>
    encodePageNativeResult(attachment, { nested: [false] }),
  ).toThrow();
});
