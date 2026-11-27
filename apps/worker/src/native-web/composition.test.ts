import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import type {
  PersonVmBootstrapScope,
  PersonVmWebStartup,
  PersonVmMemoryGuestPlan,
  PersonVmNativeWebGuestAddress,
  PersonVmStore,
  PersonVmBinding,
  ReadonlyCommandMemoryDirectory,
} from '@allrice/person-vm';
import { PersonVmError, PersonVmService } from '@allrice/person-vm';
import { createVmMemoryGuestPlan } from '@allrice/vm-memory/guest-plan';
import { readPlatformPersonVmConfiguration } from '@allrice/contracts';
import type { NativeWebOwner, openNativeWebOwner } from './owner.js';
import {
  harness,
  MemoryStore,
  signal,
} from '../../../../packages/person-vm/src/test-support.ts';
import {
  createAssignedNativeWebStartup,
  personNativeWebRoster,
} from './composition.js';
import { dEntryNativePublicUrl } from './launch.js';
const { open, prepareRoster } = vi.hoisted(() => ({
  open: vi.fn(),
  prepareRoster: vi.fn(),
}));
const firstGuestAddress = '172.16.0.6' as PersonVmNativeWebGuestAddress;
const retainedGuestAddress = '172.16.0.10' as PersonVmNativeWebGuestAddress;
vi.mock('./owner.js', () => ({ openNativeWebOwner: open }));
vi.mock('@allrice/database', () => ({
  preparePersonNativeWebRoster: prepareRoster,
}));
afterEach(() => vi.resetAllMocks());
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  commandMemory?: {
    controls: ReadonlyCommandMemoryDirectory;
    readonlyDshDirectory: string;
  },
  publicOrigin?: string,
) {
  const binding = {
    vmId: randomUUID(),
    instanceId: randomUUID(),
    personId: randomUUID(),
    organizationId: randomUUID(),
    leaseEpoch: 3,
  };
  const context: RequestContext = {
    actor: { type: 'user', id: binding.personId },
    organizationId: binding.organizationId,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    workspaceId: null,
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
  const web: PersonVmWebStartup = {
    context,
    receipt: {
      binding,
      rosterDigest: `sha256:${'a'.repeat(64)}`,
      endpoints: [32171, 32172].map((hostPort) => ({
        workspaceId: randomUUID(),
        employeeInstanceId: randomUUID(),
        employeeRevision: 2,
        employeeVersionId: randomUUID(),
        hostPort,
        guestPort: hostPort,
      })),
    },
  };
  const lifetime = new AbortController(),
    startup = new AbortController();
  const memory = {
    files: [
      { path: '/person/init.cjs', contents: '// fixture plan', mode: 0o600 },
    ],
    initialize: { executable: 'node' as const, args: ['/person/init.cjs'] },
    launcher: '/person/launcher',
    env: {},
  };
  const memoryGuestPlan = vi.fn(
    async (): Promise<PersonVmMemoryGuestPlan> => memory,
  );
  const service = createAssignedNativeWebStartup({
    vm: { assertCurrentBinding: vi.fn() },
    memoryGuestPlan,
    commandMemory,
    readEmployeeProfile: async () => [
      { path: 'package.json', contents: '{"name":"fixture-profile"}' },
    ],
    lifetime: lifetime.signal,
    cleanupTimeoutMs: 5000,
    configuration: {
      cliPath: commandMemory
        ? commandMemory.readonlyDshDirectory + '/lib/bin.js'
        : '/opt/dsh/lib/bin.js',
      startupTimeoutMs: 3000,
      publicUrl: (endpoint) =>
        publicOrigin
          ? dEntryNativePublicUrl(publicOrigin, endpoint)
          : `https://native.example.test/e/${endpoint.employeeInstanceId}/`,
    },
  });
  const readNativeWebGuestAddress = vi.fn(async () => firstGuestAddress);
  const scope = {
    binding,
    signal: startup.signal,
    assertCurrent: vi.fn(async () => {}),
    launch: vi.fn(),
    readNativeWebGuestAddress,
  } as PersonVmBootstrapScope;
  return {
    binding,
    web,
    memory,
    memoryGuestPlan,
    service,
    scope,
    readNativeWebGuestAddress,
    startup,
    lifetime,
  };
}
it('实际DB producer直接绑定service roster，取消仍等待已发SQL结束；不接受请求体清单', async () => {
  const f = fixture(),
    entered = latch(),
    joined = latch(),
    cancellation = new AbortController();
  prepareRoster.mockImplementationOnce(async () => {
    entered.resolve();
    await joined.promise;
    return {
      personId: f.binding.personId,
      organizationId: f.binding.organizationId,
      entries: f.web.receipt.endpoints,
      digest: f.web.receipt.rosterDigest,
    };
  });
  let settled = false;
  const reading = personNativeWebRoster
    .prepare(f.web.context, cancellation.signal)
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  await entered.promise;
  cancellation.abort();
  await new Promise<void>((done) => setImmediate(done));
  expect(settled).toBe(false);
  joined.resolve();
  expect(await reading).toBeDefined();
  expect(prepareRoster).toHaveBeenCalledExactlyOnceWith(f.web.context);
  await f.service.close();
});
it('实际employee receipt派生独立HOME/共享workdir；真实public owner逐个接收绑定，control不冒充editor ready', async () => {
  const f = fixture();
  const ownerLifetimes = f.web.receipt.endpoints.map(
    () => new AbortController(),
  );
  const owners = ownerLifetimes.map(({ signal }) => ({
    ...catalogOwner(),
    revoked: signal,
  }));
  owners.forEach((owner) => open.mockResolvedValueOnce(owner));
  const plan = await f.service.memoryGuestPlan(
    f.binding,
    f.scope.signal,
    f.web,
  );
  expect(plan.initialize).toBe(f.memory.initialize);
  expect(plan.launcher).toBe(f.memory.launcher);
  expect(plan.files).toHaveLength(1 + 5 * f.web.receipt.endpoints.length);
  expect(
    plan.files.filter(({ path }) =>
      path.endsWith('/allrice-native-run-journal.mjs'),
    ),
  ).toHaveLength(f.web.receipt.endpoints.length);
  expect(f.readNativeWebGuestAddress).not.toHaveBeenCalled();
  await f.service.start(f.binding, f.scope.signal, f.scope, f.web);
  expect(f.memoryGuestPlan).toHaveBeenCalledTimes(1);
  expect(f.readNativeWebGuestAddress).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(2);
  for (const [index, endpoint] of f.web.receipt.endpoints.entries()) {
    const input = open.mock.calls[index]![0];
    expect(input.context).toBe(f.web.context);
    expect(input.scope).toBe(f.scope);
    expect(input.launch.binding).toEqual(f.binding);
    expect(input.launch.auth.origin).toBe(
      `http://127.0.0.1:${endpoint.hostPort}/`,
    );
    expect(input.launch.command.env).toEqual({
      DSH_HOME: `/work/.allrice/employees/${endpoint.employeeInstanceId}/dsh`,
      DSH_AGENTS_HOME: `/work/.allrice/employees/${endpoint.employeeInstanceId}/agents`,
    });
    expect(input.launch.command.args.slice(1, 3)).toEqual([
      '--profile',
      'allrice-web',
    ]);
    expect(input.launch.command.args).toEqual(
      expect.arrayContaining(['--host', '172.16.0.6']),
    );
    expect(plan.files).toContainEqual({
      path: `/work/.allrice/employees/${endpoint.employeeInstanceId}/dsh/profiles/allrice-web/package.json`,
      contents: '{"name":"fixture-profile"}',
      mode: 0o600,
    });
    const patch = input.launch.files.find((file: { path: string }) =>
      file.path.endsWith('/owner.patch.json'),
    );
    if (!patch) throw Error('real staged native patch missing');
    expect(JSON.parse(patch.contents)[1].insert[0].config).toEqual({
      profile: {
        workspaceId: endpoint.workspaceId,
        employeeInstanceId: endpoint.employeeInstanceId,
        employeeRevision: endpoint.employeeRevision,
        employeeVersionId: endpoint.employeeVersionId,
      },
      binding: f.binding,
      moduleBase: '/opt/dsh/lib/bin.js',
    });
    expect(input.launch.command.workdir).toBe('/work');
    expect(input.lifetime).not.toBe(f.scope.signal);
    expect(f.service.owner(f.binding, endpoint.employeeInstanceId)).toBe(
      owners[index],
    );
  }
  const wholeGroup = f.service.assertAuthenticatedGroup(f.binding, signal());
  expect(wholeGroup.aborted).toBe(false);
  expect(() =>
    f.service.assertAuthenticatedGroup(
      { ...f.binding, leaseEpoch: f.binding.leaseEpoch + 1 },
      signal(),
    ),
  ).toThrow('RUNTIME_NOT_READY');
  owners[1]!.controlReady.mockReturnValue(false);
  expect(() => f.service.assertAuthenticatedGroup(f.binding, signal())).toThrow(
    'RUNTIME_NOT_READY',
  );
  const siblingLost = new PersonVmError('LEASE_LOST');
  ownerLifetimes[1]!.abort(siblingLost);
  expect(owners[0]!.revoked.aborted).toBe(false);
  expect(wholeGroup.aborted).toBe(true);
  expect(wholeGroup.reason).toBe(siblingLost);
  expect(f.service).not.toHaveProperty('readiness');
  f.startup.abort();
  expect(owners[0]!.close).not.toHaveBeenCalled();
  await f.service.close();
  expect(owners.every((owner) => owner.close.mock.calls.length === 1)).toBe(
    true,
  );
  expect(() =>
    f.service.owner(f.binding, f.web.receipt.endpoints[0]!.employeeInstanceId),
  ).toThrow();
});
it('refuses to spawn any owner when the exact startup scope has no native address reader', async () => {
  const f = fixture();
  const scope = {
    binding: f.scope.binding,
    signal: f.scope.signal,
    launch: f.scope.launch,
    assertCurrent: f.scope.assertCurrent,
  };
  await f.service.memoryGuestPlan(f.binding, scope.signal, f.web);
  await expect(
    f.service.start(f.binding, scope.signal, scope, f.web),
  ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  expect(open).not.toHaveBeenCalled();
  await f.service.close();
});
it('checks the live binding again after observing its address and before any owner starts', async () => {
  const f = fixture(),
    entered = latch(),
    release = latch();
  f.readNativeWebGuestAddress.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return firstGuestAddress;
  });
  await f.service.memoryGuestPlan(f.binding, f.scope.signal, f.web);
  const outcome = expect(
    f.service.start(f.binding, f.scope.signal, f.scope, f.web),
  ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  await entered.promise;
  expect(open).not.toHaveBeenCalled();
  vi.mocked(f.scope.assertCurrent).mockRejectedValueOnce(
    new PersonVmError('LEASE_LOST'),
  );
  release.resolve();
  await outcome;
  expect(open).not.toHaveBeenCalled();
  await f.service.close();
});
it('allows a new epoch after a failed address probe and confirmed native stop', async () => {
  const f = fixture();
  f.readNativeWebGuestAddress.mockRejectedValueOnce(
    new PersonVmError('CLEANUP_INCOMPLETE'),
  );
  await f.service.memoryGuestPlan(f.binding, signal(), f.web);
  await expect(
    f.service.start(f.binding, signal(), f.scope, f.web),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  expect(open).not.toHaveBeenCalled();
  await expect(
    f.service.retireAfterNativeStop(f.binding, signal()),
  ).resolves.toBeUndefined();

  const binding = {
    ...f.binding,
    instanceId: randomUUID(),
    leaseEpoch: f.binding.leaseEpoch + 1,
  };
  const web = { ...f.web, receipt: { ...f.web.receipt, binding } };
  open.mockResolvedValue(catalogOwner());
  await f.service.memoryGuestPlan(binding, signal(), web);
  await f.service.start(binding, signal(), { ...f.scope, binding }, web);
  expect(f.readNativeWebGuestAddress).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenCalledTimes(web.receipt.endpoints.length);
  expect(() =>
    f.service.assertAuthenticatedGroup(binding, signal()),
  ).not.toThrow();
  await f.service.close();
});
it('holds the bootstrap scope through editor proof and exposes only proved employees in that epoch', async () => {
  const f = fixture();
  const proved = f.web.receipt.endpoints[0]!;
  const skipped = f.web.receipt.endpoints[1]!;
  const route = new AbortController();
  const laterRoute = new AbortController();
  let newlyEnabled = false;
  const profile = {
    revoked: f.scope.signal,
    readImmutableGraph: vi.fn(),
    readImmutableBundle: vi.fn(),
  };
  const readModels = vi.fn();
  const verifyStartingEditor = vi.fn<NativeWebOwner['verifyStartingEditor']>(
    async (scope, active, verify) => {
      expect(scope).toBe(f.scope);
      return verify(profile, readModels, active);
    },
  );
  open.mockResolvedValue({
    ...catalogOwner(),
    verifyStartingEditor,
    verifyRunningEditor: vi.fn<NativeWebOwner['verifyRunningEditor']>(
      async (context, active, verify) => {
        expect(context).toBe(f.web.context);
        return verify(profile, readModels, active);
      },
    ),
  });
  const uninstall = f.service.installStartingEditorProof(
    async ({ endpoint, binding, context }, active) => {
      expect(binding).toEqual(f.binding);
      expect(context).toBe(f.web.context);
      active.throwIfAborted();
      return endpoint.employeeInstanceId === proved.employeeInstanceId
        ? route.signal
        : newlyEnabled
          ? laterRoute.signal
          : null;
    },
  );
  try {
    await f.service.memoryGuestPlan(f.binding, f.scope.signal, f.web);
    await f.service.start(f.binding, f.scope.signal, f.scope, f.web);
    f.startup.abort();
    expect(verifyStartingEditor).toHaveBeenCalledTimes(2);
    expect(() =>
      f.service.assertVerifiedEditor(
        f.binding,
        signal(),
        proved.employeeInstanceId,
      ),
    ).not.toThrow();
    expect(() =>
      f.service.assertVerifiedEditor(
        f.binding,
        signal(),
        skipped.employeeInstanceId,
      ),
    ).toThrow('RUNTIME_NOT_READY');
    expect(() =>
      f.service.assertVerifiedEditor(
        { ...f.binding, leaseEpoch: f.binding.leaseEpoch + 1 },
        signal(),
      ),
    ).toThrow('RUNTIME_NOT_READY');
    route.abort();
    expect(() => f.service.assertVerifiedEditor(f.binding, signal())).toThrow(
      'RUNTIME_NOT_READY',
    );
    newlyEnabled = true;
    await expect(
      f.service.ensureVerifiedEditor(
        f.web.context,
        f.binding,
        skipped.employeeInstanceId,
        signal(),
      ),
    ).resolves.toBe(laterRoute.signal);
    expect(
      f.service.assertVerifiedEditor(
        f.binding,
        signal(),
        skipped.employeeInstanceId,
      ),
    ).toBe(laterRoute.signal);
    expect(open).toHaveBeenCalledTimes(2);
  } finally {
    uninstall();
    await f.service.close();
  }
});

it('scheduled bootstrap starts the native scheduler and obtains editor proof only from a later real caller', async () => {
  const f = fixture();
  const route = new AbortController();
  const readScheduleCatalog = vi.fn<NativeWebOwner['readScheduleCatalog']>(
    async (guard, signal) => {
      await guard(signal);
      return [];
    },
  );
  const prove = vi.fn(async () => route.signal);
  const verifyStartingEditor = vi.fn<NativeWebOwner['verifyStartingEditor']>();
  open.mockResolvedValue({
    ...catalogOwner(),
    readScheduleCatalog,
    verifyStartingEditor,
    verifyRunningEditor: vi.fn<NativeWebOwner['verifyRunningEditor']>(
      async (context, active, verify) => {
        expect(context).toBe(f.web.context);
        return verify(
          {
            revoked: active,
            readImmutableGraph: vi.fn(),
            readImmutableBundle: vi.fn(),
          },
          vi.fn(),
          active,
        );
      },
    ),
  });
  const uninstall = f.service.installStartingEditorProof(prove);
  const scheduled = {
    purpose: 'scheduled-wake' as const,
    receipt: f.web.receipt,
  };
  try {
    await f.service.memoryGuestPlan(f.binding, f.scope.signal, scheduled);
    await f.service.start(f.binding, f.scope.signal, f.scope, scheduled);
    expect(readScheduleCatalog).toHaveBeenCalledTimes(2);
    expect(
      open.mock.calls.every(([input]) => input.context === undefined),
    ).toBe(true);
    expect(verifyStartingEditor).not.toHaveBeenCalled();
    expect(prove).not.toHaveBeenCalled();
    expect(() => f.service.assertVerifiedEditor(f.binding, signal())).toThrow();
    await f.service.prepareForegroundEditor(f.binding, f.web.context, signal());
    expect(prove).toHaveBeenCalledTimes(2);
    expect(f.service.assertVerifiedEditor(f.binding, signal())).toBe(
      route.signal,
    );
  } finally {
    uninstall();
    await f.service.close();
  }
});
it('launches each employee with an authenticated Web entry locator on the sealed origin', async () => {
  const origin = 'https://employees.example.test';
  const f = fixture(undefined, origin);
  const owners = f.web.receipt.endpoints.map(() => catalogOwner());
  owners.forEach((owner) => open.mockResolvedValueOnce(owner));
  try {
    await f.service.memoryGuestPlan(f.binding, f.scope.signal, f.web);
    await f.service.start(f.binding, f.scope.signal, f.scope, f.web);
    for (const [index, endpoint] of f.web.receipt.endpoints.entries()) {
      const { args } = open.mock.calls[index]![0].launch.command;
      const url = new URL(args[args.indexOf('--public-url') + 1]);
      expect(url.origin).toBe(origin);
      expect(url.pathname).toBe(
        `/chatflow/4.0/${endpoint.workspaceId}/${endpoint.employeeInstanceId}/`,
      );
      expect(url.href).toBe(origin + url.pathname);
      expect(args).toContain(url.host);
      expect(url.port).toBe('');
    }
    expect(open).toHaveBeenCalledTimes(2);
  } finally {
    await f.service.close();
  }
});

it('stages the existing governed Bash overlay for every employee from the same protected plan', async () => {
  const sha256 = 'a'.repeat(64);
  const controls = {
    sha256,
    hostDirectory: `/release/${sha256}`,
    guestDirectory: `/opt/allrice/command-memory/${sha256}`,
  };
  const readonlyDshDirectory = '/opt/allrice/dsh/' + 'b'.repeat(64);
  const f = fixture({ controls, readonlyDshDirectory });
  const platform = readPlatformPersonVmConfiguration();
  f.memoryGuestPlan.mockImplementation(async () =>
    createVmMemoryGuestPlan({
      persistentDirectory: '/work',
      policyRef: 'fixture',
      policy: {
        physicalBytes: platform.memoryMiB * 1024 ** 2,
        swapBytes: 64,
        dshLowBytes: 1,
        dshSwapMaxBytes: 1,
        commandHighBytes: platform.commandHighBytes,
        commandMaxBytes: platform.commandMaxBytes,
        commandSwapMaxBytes: platform.commandSwapMaxBytes,
        commandOomGroup: 0,
        dshOomScoreAdj: -1,
        commandOomScoreAdj: 1,
      },
      dshCommandMemory: controls,
    }),
  );
  try {
    f.memoryGuestPlan.mockResolvedValueOnce(f.memory);
    await expect(
      f.service.memoryGuestPlan(f.binding, f.scope.signal, f.web),
    ).rejects.toThrow('invalid_dsh_command_memory_patch');
    expect(open).not.toHaveBeenCalled();
    const plan = await f.service.memoryGuestPlan(
      f.binding,
      f.scope.signal,
      f.web,
    );
    const patches = plan.files.filter((file) =>
      file.path.endsWith('/owner.patch.json'),
    );
    expect(patches).toHaveLength(f.web.receipt.endpoints.length);
    for (const patch of patches) {
      expect(JSON.parse(patch.contents)).toMatchObject([
        { id: 'web-runtime' },
        {
          insert: [
            { id: 'allrice-current-principal' },
            {
              id: 'allrice-native-web-owner',
              config: {
                commandMemoryPlugin: `file://${controls.guestDirectory}/dsh-command-memory.mjs`,
              },
            },
          ],
        },
        { id: 'sandbox', disabled: true },
        { id: 'subprocess', disabled: true },
        {
          insert: [
            {
              id: 'allrice-person-vm-command-memory',
              name: `file://${controls.guestDirectory}/dsh-command-memory.mjs`,
              config: {
                readonlyDshDirectory,
                controlDirectory: controls.guestDirectory,
                guard: plan.env.BASH_ENV,
                writer: plan.env.ALLRICE_MEMORY_RECEIPT_WRITER,
              },
            },
          ],
        },
      ]);
      expect(patch.contents).not.toContain(controls.hostDirectory);
    }
  } finally {
    await f.service.close();
  }
});

it('startup缺真实receipt或当前epoch不匹配时，在memory/native owner副作用前拒绝', async () => {
  const f = fixture();
  await expect(
    f.service.memoryGuestPlan(f.binding, f.scope.signal),
  ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  await expect(
    f.service.memoryGuestPlan(
      { ...f.binding, leaseEpoch: 4 },
      f.scope.signal,
      f.web,
    ),
  ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  expect(f.memoryGuestPlan).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  await f.service.close();
});
it('close与未settle的真实owner启动竞态：先关新准入，再等待晚到owner的实际close join', async () => {
  const f = fixture(),
    entered = latch(),
    release = latch(),
    joined = latch(),
    closeEntered = latch();
  const owner = {
    revoked: new AbortController().signal,
    controlReady: () => true,
    close: vi.fn(async () => {
      closeEntered.resolve();
      await joined.promise;
    }),
  };
  open.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return owner;
  });
  await f.service.memoryGuestPlan(f.binding, f.scope.signal, f.web);
  const starting = f.service
    .start(f.binding, f.scope.signal, f.scope, f.web)
    .catch((error: unknown) => error);
  await entered.promise;
  let ended = false;
  const closing = f.service.close().then(() => {
    ended = true;
  });
  await expect(
    f.service.memoryGuestPlan(f.binding, f.scope.signal, f.web),
  ).rejects.toBeDefined();
  release.resolve();
  await closeEntered.promise;
  expect(ended).toBe(false);
  joined.resolve();
  expect(await starting).toBeDefined();
  await closing;
  expect(ended).toBe(true);
  expect(open).toHaveBeenCalledTimes(1);
});
it.each([false, true])(
  '第二个employee失败必须join第一个；unknown=%s保留真实错误不重放',
  async (unknown) => {
    const f = fixture(),
      close = vi.fn(async () => {
        if (unknown) throw Error('unknown exact job close');
      });
    open
      .mockResolvedValueOnce({ close })
      .mockRejectedValueOnce(Error('native auth failed'));
    await f.service.memoryGuestPlan(f.binding, f.scope.signal, f.web);
    const starting = f.service.start(f.binding, f.scope.signal, f.scope, f.web);
    if (unknown)
      await expect(starting).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
    else await expect(starting).rejects.toThrow('native auth failed');
    expect(open).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    if (unknown)
      await expect(f.service.close()).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
    else await f.service.close();
  },
);

it('writes the owner diagnostic through the startup lease before the normal failure audit and VM rollback', async () => {
  const f = fixture();
  const store = new MemoryStore();
  const h = harness(store);
  const entries = f.web.receipt.endpoints
    .map(
      ({
        workspaceId,
        employeeInstanceId,
        employeeRevision,
        employeeVersionId,
      }) => ({
        workspaceId,
        employeeInstanceId,
        employeeRevision,
        employeeVersionId,
      }),
    )
    .sort((a, b) => a.employeeInstanceId.localeCompare(b.employeeInstanceId));
  const facts = {
    personId: f.binding.personId,
    organizationId: f.binding.organizationId,
    entries,
  };
  const roster = {
    ...facts,
    digest: `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`,
  };
  h.native.prepareWebEndpoints = async (binding) => ({
    binding,
    rosterDigest: roster.digest,
    endpoints: f.web.receipt.endpoints,
  });
  h.native.assertWebEndpoints = async () => {};
  const bootstrap = h.native.bootstrap;
  h.native.bootstrap = async (scope, plan) => ({
    ...(await bootstrap(scope, plan)),
    readNativeWebGuestAddress: f.readNativeWebGuestAddress,
  });
  const diagnostic = {
    step: 'session-list',
    errorType: 'SystemError',
    errorCode: 'ECONNRESET',
    target: '127.0.0.1:32171',
  };
  open.mockImplementationOnce(
    async (input: Parameters<typeof openNativeWebOwner>[0]) => {
      expect(input.recordStartupFailure).toBeTypeOf('function');
      expect(input.startupPending?.()).toBe(true);
      await input.recordStartupFailure!(diagnostic, signal());
      throw new PersonVmError('PROVIDER_FAILED');
    },
  );
  const service = new PersonVmService({
    ...h.options,
    nativeWeb: { prepare: async () => roster },
    runtime: {
      ...h.runtime,
      memoryGuestPlan: f.service.memoryGuestPlan,
      start: f.service.start,
      retireAfterNativeStop: f.service.retireAfterNativeStop,
    },
  });
  try {
    await service.create(f.web.context, signal());
    await expect(service.start(f.web.context, signal())).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    expect(
      store.audits.filter(({ result }) => result === 'failed'),
    ).toMatchObject([
      {
        requestId: f.web.context.requestId,
        action: 'start.native-web.session-list',
        errorCode: JSON.stringify(diagnostic),
      },
      { action: 'start', errorCode: 'PROVIDER_FAILED' },
    ]);
    expect(h.log).toContain('native:stop');
    expect(h.mounts.size).toBe(0);
  } finally {
    await f.service.close();
  }
});

it.each(['readiness', 'save'] as const)(
  'service start已返回后%s失败：confirmed stop→exact host join→同组件新代重试（synthetic provider）',
  async (failure) => {
    class Store extends MemoryStore {
      fail = failure === 'save';
      override async withLease<T>(
        ...args: Parameters<PersonVmStore['withLease']>
      ): Promise<T> {
        const [person, options, work] = args;
        return super.withLease<T>(person, options, async (lease) => {
          const save = lease.save;
          lease.save = async (row) => {
            if (this.fail && row.phase === 'running') {
              this.fail = false;
              throw Error('synthetic save failure');
            }
            await save(row);
          };
          return work(lease);
        });
      }
    }
    const f = fixture(),
      h = harness(new Store()),
      entered = latch(),
      join = latch();
    const facts = {
      personId: f.binding.personId,
      organizationId: f.binding.organizationId,
      entries: f.web.receipt.endpoints
        .map(
          ({
            workspaceId,
            employeeInstanceId,
            employeeRevision,
            employeeVersionId,
          }) => ({
            workspaceId,
            employeeInstanceId,
            employeeRevision,
            employeeVersionId,
          }),
        )
        .sort((a, b) =>
          a.employeeInstanceId.localeCompare(b.employeeInstanceId),
        ),
    };
    const roster = {
      ...facts,
      digest: `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`,
    };
    h.native.prepareWebEndpoints = async (binding) => ({
      binding,
      rosterDigest: roster.digest,
      endpoints: f.web.receipt.endpoints,
    });
    h.native.assertWebEndpoints = async () => {};
    const bootstrap = h.native.bootstrap;
    h.native.bootstrap = async (scope, plan) => ({
      ...(await bootstrap(scope, plan)),
      async readNativeWebGuestAddress(active = scope.signal) {
        active.throwIfAborted();
        expect(h.states.get(scope.binding.vmId)).toBe('running');
        return f.readNativeWebGuestAddress();
      },
    });
    const retired = vi.fn(
      async (binding: PersonVmBinding, cleanup: AbortSignal) => {
        expect(h.states.get(binding.vmId)).toBe('stopped');
        expect(cleanup.aborted).toBe(false);
        entered.resolve();
        await join.promise;
      },
    );
    const owners = Array.from({ length: 4 }, () => ({
      revoked: new AbortController().signal,
      controlReady: () => true,
      close: vi.fn(async () => {}),
      retireAfterNativeStop: retired,
    }));
    owners.forEach((owner) => open.mockResolvedValueOnce(owner));
    const service = new PersonVmService({
      ...h.options,
      nativeWeb: { prepare: async () => roster },
      runtime: {
        ...h.runtime,
        memoryGuestPlan: f.service.memoryGuestPlan,
        start: f.service.start,
        retireAfterNativeStop: f.service.retireAfterNativeStop,
      },
    });
    if (failure === 'readiness')
      h.setReadiness({
        authenticated: true,
        editorReady: false,
        canSend: false,
      });
    await service.create(f.web.context, signal());
    const starting = service
      .start(f.web.context, signal())
      .catch((error: unknown) => error);
    try {
      await entered.promise;
      expect(open).toHaveBeenCalledTimes(2); // Runtime.start completed before outer failure.
      expect(h.mounts.size).toBe(1);
      await expect(
        service.start(f.web.context, signal()),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      const old = open.mock.calls[0]![0].launch.binding;
      expect(() =>
        f.service.owner(old, f.web.receipt.endpoints[0]!.employeeInstanceId),
      ).toThrow();
      join.resolve();
      expect(await starting).toBeInstanceOf(Error);
      expect(h.mounts.size).toBe(0);
      h.setReadiness({ authenticated: true, editorReady: true, canSend: true });
      expect((await service.start(f.web.context, signal())).ready).toBe(true);
      expect(f.readNativeWebGuestAddress).toHaveBeenCalledTimes(2);
      const next = await service.resolve(f.web.context, signal());
      expect(next.instanceId).not.toBe(old.instanceId);
      expect(next.leaseEpoch).toBeGreaterThan(old.leaseEpoch);
      expect(retired.mock.calls.map((call) => call[0])).toEqual([old, old]);
      await expect(
        f.service.retireAfterNativeStop(old, signal()),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' });
      expect(
        f.service.owner(next, f.web.receipt.endpoints[0]!.employeeInstanceId),
      ).toBe(owners[2]);
      expect(h.log.filter((entry) => entry === 'native:create')).toHaveLength(
        1,
      );
    } finally {
      join.resolve();
      await starting;
      await f.service.close();
    }
  },
);
it('retire只影响exact五字段组；host join未知保留，显式重试成功后才允许新代', async () => {
  const f = fixture(),
    unknown = new Error('unknown host join');
  const first = {
    ...catalogOwner(),
    retireAfterNativeStop: vi
      .fn()
      .mockRejectedValueOnce(unknown)
      .mockResolvedValue(undefined),
  };
  const other = {
    ...catalogOwner(),
    retireAfterNativeStop: vi.fn(async () => {}),
  };
  open.mockResolvedValue(first);
  await f.service.memoryGuestPlan(f.binding, f.scope.signal, f.web);
  await f.service.start(f.binding, f.scope.signal, f.scope, f.web);
  const b = { ...f.binding, vmId: randomUUID(), personId: randomUUID() };
  const web = {
    ...f.web,
    context: {
      ...f.web.context,
      actor: { type: 'user' as const, id: b.personId },
    },
    receipt: { ...f.web.receipt, binding: b },
  };
  open.mockResolvedValue(other);
  await f.service.memoryGuestPlan(b, signal(), web);
  await f.service.start(b, signal(), { ...f.scope, binding: b }, web);
  for (const patch of [
    { instanceId: randomUUID() },
    { leaseEpoch: 4 },
    { personId: randomUUID() },
    { organizationId: randomUUID() },
  ])
    await expect(
      f.service.retireAfterNativeStop({ ...f.binding, ...patch }, signal()),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  await expect(
    f.service.retireAfterNativeStop(f.binding, signal()),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  await f.service.memoryGuestPlan(f.binding, signal(), f.web);
  await expect(
    f.service.start(f.binding, signal(), f.scope, f.web),
  ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
  expect(f.service.owner(b, web.receipt.endpoints[0]!.employeeInstanceId)).toBe(
    other,
  );
  expect(other.retireAfterNativeStop).not.toHaveBeenCalled();
  await f.service.retireAfterNativeStop(f.binding, signal());
  await f.service.retireAfterNativeStop(f.binding, signal()); // Absent exact group is idempotent.
  await f.service.memoryGuestPlan(f.binding, signal(), f.web);
  await f.service.start(f.binding, signal(), f.scope, f.web);
  await f.service.close();
  expect(first.retireAfterNativeStop).toHaveBeenCalledTimes(4); // Two owners, two explicit attempts.
  expect(other.close).toHaveBeenCalled();
});
it('open自身host join未知且未交出owner时，不能由其他owner/物理停止/全局close伪证清组', async () => {
  const f = fixture();
  open.mockRejectedValueOnce(new PersonVmError('CLEANUP_INCOMPLETE'));
  await f.service.memoryGuestPlan(f.binding, signal(), f.web);
  await expect(
    f.service.start(f.binding, signal(), f.scope, f.web),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  await expect(
    f.service.retireAfterNativeStop(f.binding, signal()),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  await f.service.memoryGuestPlan(f.binding, signal(), f.web);
  await expect(
    f.service.start(f.binding, signal(), f.scope, f.web),
  ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
  await expect(f.service.close()).rejects.toMatchObject({
    code: 'CLEANUP_INCOMPLETE',
  });
  expect(open).toHaveBeenCalledTimes(1);
});

function catalogOwner() {
  const revoked = new AbortController();
  return {
    revoked: revoked.signal,
    controlReady: vi.fn(() => true),
    readSessionsFor: vi.fn(),
    acquirePrincipal: vi.fn<NativeWebOwner['acquirePrincipal']>(() => {
      throw new PersonVmError('RUNTIME_NOT_READY');
    }),
    close: vi.fn(async () => {}),
    retireAfterNativeStop: vi.fn(async () => {}),
  };
}
it('完整启动才发布冻结原receipt/endpoint和私有ref；lookup无start/read/editor/send/history副作用', async () => {
  const f = fixture(),
    owners = [catalogOwner(), catalogOwner()];
  owners.forEach((owner) => open.mockResolvedValueOnce(owner));
  const id = f.web.receipt.endpoints[0]!.employeeInstanceId;
  try {
    expect(() => f.service.catalog(f.binding, id)).toThrow();
    await f.service.memoryGuestPlan(f.binding, signal(), f.web);
    await f.service.start(f.binding, signal(), f.scope, f.web);
    const first = f.service.catalog(f.binding, id),
      second = f.service.catalog(f.binding, id);
    expect(first.receipt).toEqual(f.web.receipt);
    expect(second.receipt).toBe(first.receipt);
    expect(second.endpoint).toBe(first.endpoint);
    expect(second.bindingRef).toBe(first.bindingRef);
    expect(first.owner).toBe(owners[0]);
    expect(first.bindingRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.isFrozen(first.receipt)).toBe(true);
    expect(Object.isFrozen(first.receipt.binding)).toBe(true);
    expect(Object.isFrozen(first.receipt.endpoints)).toBe(true);
    expect(Object.isFrozen(first.endpoint)).toBe(true);
    expect(Reflect.set(first.endpoint, 'hostPort', 9)).toBe(false);
    expect(first.endpoint.hostPort).toBe(f.web.receipt.endpoints[0]!.hostPort);
    expect(first).not.toHaveProperty('editorReady');
    expect(first).not.toHaveProperty('canSend');
    expect(first).not.toHaveProperty('history');
    expect(owners[0]!.readSessionsFor).not.toHaveBeenCalled();
    expect(owners[0]!.acquirePrincipal).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
    owners[0]!.controlReady.mockReturnValue(false);
    expect(() => f.service.catalog(f.binding, id)).toThrowError(PersonVmError);
    owners[0]!.controlReady.mockReturnValue(true);
    expect(() =>
      f.service.catalog({ ...f.binding, leaseEpoch: 4 }, id),
    ).toThrow();
    f.lifetime.abort();
    expect(first.revoked.aborted).toBe(true);
    expect(() => f.service.catalog(f.binding, id)).toThrow();
    expect(() => f.service.owner(f.binding, id)).toThrow();
  } finally {
    await f.service.close();
  }
});

it.each([false, true])(
  '最后一个open悬挂时retire同步封闭全部lookup；late open rejects=%s仍真实join',
  async (rejects) => {
    const f = fixture(),
      owners = [catalogOwner(), catalogOwner()],
      entered = latch(),
      release = latch();
    const id = f.web.receipt.endpoints[0]!.employeeInstanceId;
    open.mockResolvedValueOnce(owners[0]).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      if (rejects) throw Error('last native owner failed');
      return owners[1];
    });
    await f.service.memoryGuestPlan(f.binding, signal(), f.web);
    const starting = f.service
      .start(f.binding, signal(), f.scope, f.web)
      .catch((error: unknown) => error);
    await entered.promise;
    expect(() => f.service.catalog(f.binding, id)).toThrow();
    expect(() => f.service.owner(f.binding, id)).toThrow();
    let retired = false;
    const retiring = f.service
      .retireAfterNativeStop(f.binding, signal())
      .then(() => {
        retired = true;
      });
    try {
      expect(() => f.service.catalog(f.binding, id)).toThrow();
      expect(() => f.service.owner(f.binding, id)).toThrow();
      await new Promise<void>((done) => setImmediate(done));
      expect(retired).toBe(false);
    } finally {
      release.resolve();
    }
    const result = await starting;
    if (rejects)
      expect(result).toMatchObject({ message: 'last native owner failed' });
    else expect(result).toMatchObject({ code: 'LEASE_LOST' });
    await retiring;
    expect(owners[0]!.close).toHaveBeenCalledTimes(1);
    expect(owners[0]!.retireAfterNativeStop).toHaveBeenCalledTimes(1);
    expect(owners[1]!.retireAfterNativeStop).toHaveBeenCalledTimes(
      rejects ? 0 : 1,
    );
    expect(() => f.service.catalog(f.binding, id)).toThrow();
    expect(() => f.service.owner(f.binding, id)).toThrow();
    await f.service.close();
  },
);

it('完成后retire立即撤旧catalog；真实host join结束后新epoch必须新ref，不改写旧receipt', async () => {
  const f = fixture(),
    owners = [catalogOwner(), catalogOwner()],
    entered = latch(),
    joined = latch();
  owners[0]!.retireAfterNativeStop.mockImplementationOnce(async () => {
    entered.resolve();
    await joined.promise;
  });
  owners.forEach((owner) => open.mockResolvedValueOnce(owner));
  const id = f.web.receipt.endpoints[0]!.employeeInstanceId;
  await f.service.memoryGuestPlan(f.binding, signal(), f.web);
  await f.service.start(f.binding, signal(), f.scope, f.web);
  const old = f.service.catalog(f.binding, id);
  const retiring = f.service.retireAfterNativeStop(f.binding, signal());
  expect(old.revoked.aborted).toBe(true);
  expect(() => f.service.catalog(f.binding, id)).toThrow();
  expect(() => f.service.owner(f.binding, id)).toThrow();
  try {
    await entered.promise;
  } finally {
    joined.resolve();
  }
  await retiring;
  const binding = { ...f.binding, instanceId: randomUUID(), leaseEpoch: 4 };
  const web = { ...f.web, receipt: { ...f.web.receipt, binding } };
  f.readNativeWebGuestAddress.mockResolvedValueOnce(retainedGuestAddress);
  open.mockResolvedValue(catalogOwner());
  await f.service.memoryGuestPlan(binding, signal(), web);
  await f.service.start(binding, signal(), { ...f.scope, binding }, web);
  const next = f.service.catalog(binding, id);
  expect(f.readNativeWebGuestAddress).toHaveBeenCalledTimes(2);
  expect(
    open.mock.calls.map(
      ([
        {
          launch: { command },
        },
      ]) => command.args[command.args.indexOf('--host') + 1],
    ),
  ).toEqual(['172.16.0.6', '172.16.0.6', '172.16.0.10', '172.16.0.10']);
  expect(next.bindingRef).not.toBe(old.bindingRef);
  expect(next.receipt.binding).toEqual(binding);
  expect(old.receipt.binding).toEqual(f.binding);
  expect(old.revoked.aborted).toBe(true);
  await f.service.close();
  expect(next.revoked.aborted).toBe(true);
});

it('retire失败清retiring也不可复活旧catalog或旧owner lookup', async () => {
  const f = fixture(),
    owners = [catalogOwner(), catalogOwner()];
  owners[0]!.retireAfterNativeStop.mockRejectedValueOnce(
    Error('host join unknown'),
  );
  owners.forEach((owner) => open.mockResolvedValueOnce(owner));
  const id = f.web.receipt.endpoints[0]!.employeeInstanceId;
  await f.service.memoryGuestPlan(f.binding, signal(), f.web);
  await f.service.start(f.binding, signal(), f.scope, f.web);
  const old = f.service.catalog(f.binding, id);
  await expect(
    f.service.retireAfterNativeStop(f.binding, signal()),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  expect(old.revoked.aborted).toBe(true);
  expect(() => f.service.catalog(f.binding, id)).toThrow();
  expect(() => f.service.owner(f.binding, id)).toThrow();
  await f.service.retireAfterNativeStop(f.binding, signal());
  await f.service.close();
});
