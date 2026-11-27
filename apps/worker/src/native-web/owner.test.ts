import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import ts from 'typescript';
import { composeEntries } from '@deepseek-ai/dsh-app-boot';
import type {
  PersonVmBootstrapScope,
  PersonVmJobExit,
  PersonVmNativeWebGuestAddress,
} from '@allrice/person-vm';
import { deferred } from '../../../../packages/model-gateway/src/gateway.fixture.js';
import { nativeWebLaunchOnGuest, prepareNativeWebLaunch } from './launch.js';
import { openNativeWebOwner, readNativeModelAttempt } from './owner.js';
import { nativeSetupError } from './startup-diagnostic.js';

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
  const staged = await prepareNativeWebLaunch(config, binding, profile);
  expect(staged.commandWithoutHost.args).not.toContain('--host');
  const a = nativeWebLaunchOnGuest(
    staged,
    '10.0.0.2' as PersonVmNativeWebGuestAddress,
  );
  const b = nativeWebLaunchOnGuest(
    await prepareNativeWebLaunch(
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
    ),
    '10.0.0.6' as PersonVmNativeWebGuestAddress,
  );
  expect(a.command.args.slice(1, 3)).toEqual(['--profile', 'allrice-web']);
  expect(a.command.args).toContain('--no-open');
  expect(a.command.args.slice(a.command.args.indexOf('--port'))).toEqual([
    '--port',
    '8080',
    '--public-url',
    config.publicUrl,
    '--trusted-host',
    '127.0.0.1:32179',
    '--trusted-host',
    'e1.example.test',
    '--host',
    '10.0.0.2',
  ]);
  expect(a.auth.origin).toBe(config.origin);
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
  const terminalIds = ['terminal-controller', 'ui-sidebar-terminal'];
  expect(
    entries.filter(({ id }: { id?: string }) => terminalIds.includes(id ?? '')),
  ).toEqual([]);
  const restricted = await prepareNativeWebLaunch(
    { ...config, terminalEnabled: false },
    binding,
    profile,
  );
  const restrictedPatch = restricted.files.find((file) =>
    file.path.endsWith('/owner.patch.json'),
  );
  if (!restrictedPatch) throw Error('actual native owner patch missing');
  expect(JSON.parse(restrictedPatch.contents)).toEqual(
    expect.arrayContaining(terminalIds.map((id) => ({ id, disabled: true }))),
  );
  expect(entries[1].insert.map((entry: { id: string }) => entry.id)).toEqual([
    'allrice-current-principal',
    'allrice-native-web-owner',
  ]);
  expect(entries[1].insert[1].config.baseUrl).toBe(config.origin);
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
  for (const guestAddress of [
    '0.0.0.0',
    '127.0.0.1',
    '172.16.0.5',
    '198.51.100.6',
    '::',
    '::1%lo0',
    'guest.example.test',
  ])
    expect(() =>
      nativeWebLaunchOnGuest(
        staged,
        guestAddress as PersonVmNativeWebGuestAddress,
      ),
    ).toThrow(expect.objectContaining({ code: 'PROVIDER_FAILED' }));
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

it.each([
  ['/connect', 'authenticate'],
  ['/', 'authenticate-index'],
] as const)(
  'reports a rejected %s exchange before native cleanup without leaking credentials',
  async (path, step) => {
    const secrets = {
      token: 'synthetic-launch-token',
      cookie: 'synthetic-cookie-value',
      body: 'synthetic-private-response',
      redirect: 'synthetic-redirect-token',
      nonce: randomUUID(),
    };
    const server = createServer((request, response) => {
      const pathname = new URL(request.url!, 'http://fixture').pathname;
      if (pathname === path) {
        response.writeHead(401, {
          location: '/?token=' + secrets.redirect,
          'set-cookie': 'private=' + secrets.cookie,
        });
        if (path === '/') response.write(secrets.body);
        else response.end(secrets.body);
      } else {
        response.writeHead(302, {
          location: './api/remote.mux',
          'set-cookie': 'private=' + secrets.cookie,
        });
        response.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const target = `127.0.0.1:${(server.address() as { port: number }).port}`;
    const origin = `http://${target}/`;
    const requestId = randomUUID();
    const calls: string[] = [];
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {
      calls.push('log');
    });
    const destroy = IncomingMessage.prototype.destroy;
    const responseDiscarded = vi.fn();
    const discard = vi
      .spyOn(IncomingMessage.prototype, 'destroy')
      .mockImplementation(function (
        this: IncomingMessage,
        ...args: Parameters<IncomingMessage['destroy']>
      ) {
        if (this.statusCode === 401 && !this.complete) responseDiscarded();
        return destroy.apply(this, args);
      });
    const auditStarted = deferred<void>();
    const auditFinished = deferred<void>();
    const audit = vi.fn(async (_diagnostic: unknown, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      calls.push('audit');
      auditStarted.resolve(undefined);
      await auditFinished.promise;
      calls.push('audit-finished');
    });
    const exited = deferred<PersonVmJobExit>();
    const exit = { exitCode: 1, timedOut: false };
    const lifetime = new AbortController();
    const cancelAndWait = vi.fn(async () => {
      calls.push('cancel');
      exited.resolve(exit);
      return exit;
    });
    try {
      const outcome = openNativeWebOwner({
        scope: {
          binding,
          signal: new AbortController().signal,
          assertCurrent: vi.fn().mockResolvedValue(undefined),
          launch: vi.fn().mockResolvedValue({
            binding,
            jobId: 'fixture',
            wait: () => exited.promise,
            cancelAndWait,
          }),
          readNativeWebAuth: async () => ({
            authenticatedUrl: origin + '?token=' + secrets.token,
          }),
        },
        launch: {
          binding,
          auth: {
            dshHome: '/work/a',
            origin,
            nonce: secrets.nonce,
            timeoutMs: 5000,
          },
          files: [],
          command: { executable: 'node', args: [] },
        },
        context: { requestId } as never,
        vm: { assertCurrentBinding: vi.fn() },
        lifetime: lifetime.signal,
        cleanupTimeoutMs: 3000,
        recordStartupFailure: audit,
      });
      const assertion = expect(outcome).rejects.toMatchObject({
        code: 'PROVIDER_FAILED',
        message: 'PROVIDER_FAILED',
      });
      await auditStarted.promise;
      expect(calls).toEqual(['log', 'audit']);
      expect(responseDiscarded).not.toHaveBeenCalled();
      auditFinished.resolve(undefined);
      await assertion;
      if (path === '/') expect(responseDiscarded).toHaveBeenCalled();
      const fields = {
        step,
        errorType: 'HttpError',
        errorCode: 'UNEXPECTED_HTTP_RESPONSE',
        httpStatus: 401,
        target,
      };
      expect(calls).toEqual(['log', 'audit', 'audit-finished', 'cancel']);
      expect(audit).toHaveBeenCalledExactlyOnceWith(
        fields,
        expect.any(AbortSignal),
      );
      expect(warning.mock.calls).toEqual([
        [
          '[MET-273] native Web startup failed',
          {
            requestId,
            vmId: binding.vmId,
            leaseEpoch: binding.leaseEpoch,
            ...fields,
          },
        ],
      ]);
      const recorded = JSON.stringify([
        warning.mock.calls,
        audit.mock.calls[0]?.[0],
      ]);
      for (const value of Object.values(secrets))
        expect(recorded).not.toContain(value);
    } finally {
      auditFinished.resolve(undefined);
      lifetime.abort();
      exited.resolve(exit);
      warning.mockRestore();
      discard.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);

it('does not copy arbitrary names, codes, causes or opaque abort reasons', () => {
  const privateValue = 'synthetic-private-diagnostic';
  const error = Object.assign(
    new Error(privateValue, { cause: privateValue }),
    {
      name: privateValue,
      code: privateValue,
    },
  );
  expect(nativeSetupError(error)).toEqual({ errorType: 'Error' });
  const opaque = new Proxy(error, {
    getPrototypeOf() {
      throw error;
    },
  });
  expect(nativeSetupError(opaque)).toEqual({ errorType: 'Error' });
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
