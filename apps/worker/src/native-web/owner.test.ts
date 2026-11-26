import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import ts from 'typescript';
import { composeEntries } from '@deepseek-ai/dsh-app-boot';
import type {
  PersonVmBootstrapScope,
  PersonVmJobExit,
} from '@allrice/person-vm';
import { deferred } from '../../../../packages/model-gateway/src/gateway.fixture.js';
import { prepareNativeWebLaunch } from './launch.js';
import { openNativeWebOwner, readNativeModelAttempt } from './owner.js';

const binding = {
  vmId: randomUUID(),
  instanceId: randomUUID(),
  personId: randomUUID(),
  organizationId: randomUUID(),
  leaseEpoch: 1,
};
it('生产compiler收集全部native Web产品而不emit测试；typecheck仍收集完整测试', () => {
  const worker = fileURLToPath(new URL('../../', import.meta.url));
  function configuration(name: string) {
    const loaded = ts.readConfigFile(join(worker, name), ts.sys.readFile);
    expect(loaded.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, worker);
    expect(parsed.errors).toEqual([]);
    return parsed;
  }
  const build = configuration('tsconfig.build.json'),
    typecheck = configuration('tsconfig.json');
  for (const file of ['launch', 'owner', 'transport', 'composition'])
    expect(build.fileNames).toContain(
      join(worker, `src/native-web/${file}.ts`),
    );
  expect(build.fileNames.filter((file) => file.endsWith('.test.ts'))).toEqual(
    [],
  );
  for (const file of [
    'composition.test.ts',
    'owner.native.integration.test.ts',
  ])
    expect(typecheck.fileNames).toContain(join(worker, 'src/native-web', file));
  expect(build.options.rootDir).toBe(join(worker, 'src'));
  expect(build.options.paths).toEqual({});
});
it('stage实际native Host插件/patch，独立员工HOME并保原生no-open CLI；不写token或端口池', async () => {
  const config = {
    origin: 'http://127.0.0.1:32179/',
    publicUrl: 'https://e1.example.test/',
    guestAddress: '10.0.0.2',
    guestPort: 8080,
    dshHome: '/work/employee-a/dsh',
    agentsHome: '/work/employee-a/agents',
    workdir: '/work/shared',
    cliPath: '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
    startupTimeoutMs: 5000,
    principalProfile: {
      workspaceId: randomUUID(),
      employeeInstanceId: randomUUID(),
      employeeRevision: 1,
      employeeVersionId: randomUUID(),
    },
  };
  const profile = [
    { path: 'package.json', contents: '{"name":"fixture-profile"}' },
  ] as const;
  const a = await prepareNativeWebLaunch(config, binding, profile),
    b = await prepareNativeWebLaunch(
      {
        ...config,
        dshHome: '/work/employee-b/dsh',
        principalProfile: {
          ...config.principalProfile,
          employeeInstanceId: randomUUID(),
          employeeVersionId: randomUUID(),
        },
      },
      binding,
      profile,
    );
  expect(a.command.args.slice(1, 3)).toEqual(['--profile', 'allrice-web']);
  expect(a.command.args).toContain('--no-open');
  expect(a.command.args.indexOf('--patch')).toBeLessThan(
    a.command.args.indexOf('--no-open'),
  );
  expect(a.command.env).toEqual({
    DSH_HOME: config.dshHome,
    DSH_AGENTS_HOME: config.agentsHome,
  });
  expect(a.files[0]!.contents).toContain(
    'ctx.connection.authenticatedUrl(baseUrl)',
  );
  const patch = a.files.find((file) => file.path.endsWith('/owner.patch.json'));
  if (!patch) throw Error('actual native owner patch missing');
  const entries = JSON.parse(patch.contents);
  expect(entries[1].insert.map((entry: { id: string }) => entry.id)).toEqual([
    'allrice-current-principal',
    'allrice-native-web-owner',
  ]);
  expect(entries[1].insert[0]).toEqual({
    id: 'allrice-current-principal',
    name: 'file:///work/employee-a/dsh/native-web/current-principal.mjs',
    config: {
      profile: config.principalProfile,
      binding,
      moduleBase: config.cliPath,
    },
  });
  const plugin = a.files.find((file) =>
    file.path.endsWith('/current-principal.mjs'),
  );
  if (!plugin) throw Error('actual sealed principal plugin missing');
  expect(plugin.mode).toBe(0o600);
  expect(plugin.contents).toContain('PRINCIPAL_METADATA_INVALID');
  expect(entries[0]).toEqual({
    id: 'web-runtime',
    config: {
      openBrowser: false,
      publicUrl: config.publicUrl,
      surfaceContext: true,
      printUrl: false,
    },
  });
  // Use rc.2's public boot composition, which replaces the whole config.
  const composed = composeEntries([
    [
      {
        insert: [
          {
            id: 'web-runtime',
            name: '@deepseek-ai/dsh-web-app',
            config: {
              openBrowser: true,
              publicUrl: 'http://10.0.0.2:8080/',
              surfaceContext: true,
              printUrl: true,
            },
          },
        ],
      },
    ],
    entries,
  ]);
  expect(composed.find((entry) => entry.id === 'web-runtime')?.config).toEqual({
    openBrowser: false,
    publicUrl: config.publicUrl,
    surfaceContext: true,
    printUrl: false,
  });
  expect(b.auth.nonce).not.toBe(a.auth.nonce);
  expect(JSON.stringify(a)).not.toContain('?token=');
  for (const guestAddress of ['0.0.0.0', '::', 'guest.example.test'])
    await expect(
      prepareNativeWebLaunch({ ...config, guestAddress }, binding, profile),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  for (const suffix of ['?workspaceId=fixture', '#fragment', '?', '#'])
    await expect(
      prepareNativeWebLaunch(
        { ...config, publicUrl: config.publicUrl + suffix },
        binding,
        profile,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
});

it('真实Web启动缺有界auth capability时先拒绝，不launch或假ready', async () => {
  const launch = {
    binding,
    auth: {
      dshHome: '/work/a',
      origin: 'http://127.0.0.1:32179/',
      nonce: randomUUID(),
      timeoutMs: 3000,
    },
    files: [],
    command: { executable: 'node', args: [] },
  };
  const scope = {
    launch: vi.fn(),
    assertCurrent: vi.fn(),
    signal: new AbortController().signal,
  } as unknown as PersonVmBootstrapScope;
  await expect(
    openNativeWebOwner({
      scope,
      launch,
      context: {} as never,
      vm: { assertCurrentBinding: vi.fn() },
      lifetime: new AbortController().signal,
      cleanupTimeoutMs: 3000,
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  expect(scope.launch).not.toHaveBeenCalled();
});

it('启动plan绑定exact host epoch，旧plan不能在新scope dispatch', async () => {
  const scope = {
    binding,
    launch: vi.fn(),
    assertCurrent: vi.fn(),
    readNativeWebAuth: vi.fn(),
    signal: new AbortController().signal,
  };
  await expect(
    openNativeWebOwner({
      scope,
      launch: {
        binding: { ...binding, leaseEpoch: binding.leaseEpoch + 1 },
        auth: {
          dshHome: '/work/a',
          nonce: randomUUID(),
          origin: 'http://127.0.0.1:32179/',
          timeoutMs: 3000,
        },
        files: [],
        command: { executable: 'node', args: [] },
      },
      context: {} as never,
      vm: { assertCurrentBinding: vi.fn() },
      lifetime: new AbortController().signal,
      cleanupTimeoutMs: 3000,
    }),
  ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  expect(scope.launch).not.toHaveBeenCalled();
});

it('CLI 启动退出会取消本次认证读取，等读取和原生关闭收尾后返回脱敏错误', async () => {
  const lifetime = new AbortController();
  const guestExited = deferred<PersonVmJobExit>();
  const readerStarted = deferred<AbortSignal | undefined>();
  const readerClosed = deferred<void>();
  const cancelStarted = deferred<AbortSignal>();
  const cancelClosed = deferred<void>();
  const exit = { exitCode: 1, timedOut: false };
  const cancelAndWait = vi.fn(async (signal: AbortSignal) => {
    cancelStarted.resolve(signal);
    await cancelClosed.promise;
    return exit;
  });
  const launch = {
    binding,
    auth: {
      dshHome: '/work/a',
      origin: 'http://127.0.0.1:32179/',
      nonce: randomUUID(),
      timeoutMs: 60000,
    },
    files: [],
    command: { executable: 'node', args: [] },
  };
  const scope: PersonVmBootstrapScope = {
    binding,
    signal: new AbortController().signal,
    assertCurrent: vi.fn().mockResolvedValue(undefined),
    launch: vi.fn().mockResolvedValue({
      binding,
      jobId: 'fixture-launch',
      wait: () => guestExited.promise,
      cancelAndWait,
    }),
    readNativeWebAuth: async (request, signal) => {
      expect(request).toBe(launch.auth);
      readerStarted.resolve(signal);
      await readerClosed.promise;
      throw Error('fixture private reader diagnostic');
    },
  };
  let settled = false;
  const outcome = openNativeWebOwner({
    scope,
    launch,
    context: {} as never,
    vm: { assertCurrentBinding: vi.fn() },
    lifetime: lifetime.signal,
    cleanupTimeoutMs: 2000,
  })
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    const readerSignal = await readerStarted.promise;
    guestExited.resolve(exit);
    await vi.waitFor(() => expect(readerSignal?.aborted).toBe(true));
    expect(scope.signal.aborted).toBe(false);
    expect(lifetime.signal.aborted).toBe(false);
    expect(settled).toBe(false);
    readerClosed.resolve(undefined);
    expect((await cancelStarted.promise).aborted).toBe(false);
    expect(settled).toBe(false);
    cancelClosed.resolve(undefined);
    const failure = await outcome;
    expect(failure).toMatchObject({
      code: 'PROVIDER_FAILED',
      message: 'PROVIDER_FAILED',
    });
    expect(failure).not.toHaveProperty('cause');
    expect(cancelAndWait).toHaveBeenCalledTimes(1);
  } finally {
    guestExited.resolve(exit);
    readerClosed.resolve(undefined);
    cancelClosed.resolve(undefined);
    lifetime.abort();
    await outcome;
  }
});

it('requires the exact current compaction bracket and cannot substitute it for the assistant call', () => {
  function event(
    type: string,
    seq: number,
    data: { compactionId?: string; turn?: number | null } = {},
  ) {
    return { type: 'event' as const, event: { type, seq, time: 1, data } };
  }
  const start = event('compaction/start', 8, {
    compactionId: 'actual-compact',
    turn: 3,
  });
  expect(readNativeModelAttempt({ records: [start] }, 'compaction')).toEqual({
    kind: 'compaction',
    id: 'actual-compact',
    turn: 3,
    cursor: 8,
  });
  expect(readNativeModelAttempt({ records: [start] }, 'assistant')).toBeNull();
  for (const type of ['session/end-seed', 'compaction/end'])
    expect(
      readNativeModelAttempt(
        { records: [start, event(type, 9)] },
        'compaction',
      ),
    ).toBeNull();
});
