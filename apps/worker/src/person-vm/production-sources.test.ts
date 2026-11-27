import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { modelBinding } from '../../../../packages/model-gateway/src/gateway.fixture.js';
import {
  PersonVmError,
  PersonVmService,
  PostgresPersonVmStore,
  type PersonVmBootstrapScope,
  type PersonVmNativePort,
  type PersonVmNativeWebGuestAddress,
} from '@allrice/person-vm';
import {
  MemoryStore,
  harness,
} from '../../../../packages/person-vm/src/test-support.ts';
import {
  deferred,
  nativeEntryFixture,
  nativeEntryServer,
} from '../d-entry/native-entry.fixture.js';
import { installDEntryNativePrewarm } from '../business-runtime/native-prewarm.js';
import { installAssignedDEntryNativeCatalog } from '../business-runtime/native-catalog.js';
import { createAssignedNativeWebStartup } from '../native-web/composition.js';
import type * as NativeOwner from '../native-web/owner.js';
import type { ProductionPersonVmHostSources } from './production-host.js';
import type * as ProductionDEntrySource from './production-dentry-source.js';
import type { createProductionEgressAuthority } from './production-egress-authority.js';
import type { createProductionScheduledWakeSource } from './production-scheduled-wake.js';
import type { createProductionCodexRuntime as loadCodexRuntime } from './production-codex-runtime.js';
import {
  createProductionPersonVmSources,
  type ProductionNativeModelExecution,
} from './production-sources.js';

const io = vi.hoisted(() => ({
  codex: vi.fn<typeof loadCodexRuntime>(),
  entry: vi.fn<typeof ProductionDEntrySource.installProductionDEntrySource>(),
  egress: vi.fn<typeof createProductionEgressAuthority>(),
  wake: vi.fn<typeof createProductionScheduledWakeSource>(),
  identity: vi.fn(),
  openNativeWeb: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  requireDEntryNativeIdentity: io.identity,
}));
vi.mock('../native-web/owner.js', async (original) => ({
  ...(await original<typeof NativeOwner>()),
  openNativeWebOwner: io.openNativeWeb,
}));
vi.mock('./production-codex-runtime.js', () => ({
  createProductionCodexRuntime: io.codex,
}));
vi.mock('./production-dentry-source.js', () => ({
  installProductionDEntrySource: io.entry,
}));
vi.mock('./production-egress-authority.js', () => ({
  createProductionEgressAuthority: io.egress,
}));
vi.mock('./production-scheduled-wake.js', () => ({
  createProductionScheduledWakeSource: io.wake,
}));
afterEach(() => vi.resetAllMocks());

function fixture() {
  const lifetime = new AbortController();
  const guest = new AbortController();
  const codex = new AbortController();
  const issued = {
    ...modelBinding(),
    provider: 'openai-codex' as const,
    model: 'gpt-6.2-sol' as const,
  };
  const workspaceId = randomUUID();
  issued.context.workspaceId = workspaceId;
  const candidate = {
    context: issued.context,
    binding: issued.vm,
    identity: {
      personId: issued.vm.personId,
      organizationId: issued.vm.organizationId,
      workspaceId,
      employeeInstanceId: issued.employeeInstanceId,
      employeeVersionId: issued.employeeRelease,
      employeeRevision: 1,
      threadId: issued.allriceThreadRef,
    },
  } satisfies Parameters<ProductionDEntrySource.ResolveProductionDEntrySendRoute>[0];
  const route = {
    provider: issued.provider,
    model: issued.model,
    transport: 'sse' as const,
    classify: () => null,
  };
  const codexClose = vi.fn(async () => {});
  io.codex.mockResolvedValue({
    revoked: codex.signal,
    route,
    readModelMetadata: vi.fn(async () => ({
      modelInfo: {
        id: route.model,
        name: route.model,
        provider: route.provider,
      },
      historicalModels: [],
    })),
    scopeStream: undefined,
    transport: {
      fetchOwned: vi.fn(),
      close: vi.fn(),
      stoppedEvidence: vi.fn(),
      beforeDispatch: vi.fn(),
    },
    confirmTransportStopped: vi.fn(),
    assertCurrent: vi.fn(async (signal) => {
      signal?.throwIfAborted();
      return codex.signal;
    }),
    llm: { prepareCall: vi.fn() },
    close: codexClose,
  });
  const entryClose = vi.fn(async () => {});
  io.entry.mockReturnValue({ close: entryClose, readiness: vi.fn() });
  const bindModelCall = vi.fn();
  io.egress.mockReturnValue({
    authority: { context: vi.fn(), allow: vi.fn() },
    bindModelCall,
    bindWebSearch: vi.fn(),
  });
  const nativeClose = vi.fn(async () => {});
  const authority = {
    assertCall: vi.fn(async () => {}),
    authorizeUsage: vi.fn(),
    confirmOwnerStopped: vi.fn(),
  };
  const resolve = vi
    .fn<ProductionDEntrySource.ResolveProductionDEntrySendRoute>()
    .mockResolvedValue({
      provider: route.provider,
      model: route.model,
      revoked: guest.signal,
    });
  const attach = vi
    .fn<ProductionNativeModelExecution['attach']>()
    .mockResolvedValue({
      activity: vi.fn(),
      close: nativeClose,
      resolveSendRoute: resolve,
    });
  const wake = { assertDeliverable: vi.fn(), start: vi.fn() };
  io.wake.mockReturnValue(wake);
  let selectionActive = false;
  const physicalReady = vi.fn(async () => {
    expect(selectionActive).toBe(true);
  });
  const withCurrentSelection = vi.fn(
    async (_context, _identity, _active, work: () => Promise<void>) => {
      selectionActive = true;
      try {
        return await work();
      } finally {
        selectionActive = false;
      }
    },
  );
  const host = Object.freeze({
    vm: Object.freeze({ assertRunningReadiness: physicalReady }),
    current: Object.freeze({ withCurrentSelection }),
    startup: Object.freeze({ slottedEntryReceipt: vi.fn() }),
    admission: Object.freeze({}),
    providers: { configuration: { lifecycle: { cleanupTimeoutMs: 10_000 } } },
    lifetime: lifetime.signal,
  }) as unknown as Parameters<ProductionPersonVmHostSources['bind']>[0];
  return {
    lifetime,
    guest,
    codex,
    issued,
    candidate,
    route,
    codexClose,
    entryClose,
    bindModelCall,
    nativeClose,
    authority,
    resolve,
    attach,
    physicalReady,
    withCurrentSelection,
    host,
    wake,
  };
}

it('shares the exact route and call association between A, B and the selected Codex owner', async () => {
  const f = fixture();
  const sources = createProductionPersonVmSources({
    authority: f.authority,
    attach: f.attach,
  });
  const bound = await sources.bind(f.host);
  expect(io.wake).toHaveBeenCalledExactlyOnceWith(f.host.vm);
  expect(bound.scheduledWake).toBe(f.wake);
  const { confirmPhysical, resolveSendRoute } = io.entry.mock.calls[0]![0];
  const { context, identity, binding } = f.candidate;
  await confirmPhysical!(context, identity, binding, f.lifetime.signal);
  expect(f.withCurrentSelection).toHaveBeenCalledWith(
    context,
    identity,
    f.lifetime.signal,
    expect.any(Function),
  );
  expect(f.physicalReady).toHaveBeenCalledWith(
    context,
    binding,
    f.lifetime.signal,
    undefined,
  );
  const issuance = f.attach.mock.calls[0]![1];
  expect(issuance.route).toBe(f.route);
  const ref = await issuance.issueCall(f.issued, f.lifetime.signal);
  await expect(
    bound.model.resolveCall(
      { 'x-allrice-model-call-reference': ref },
      f.issued.vm,
      f.lifetime.signal,
    ),
  ).resolves.toEqual(f.issued);
  expect(bound.egress.bindModelCall).toBe(f.bindModelCall);
  const result = await resolveSendRoute(f.candidate, f.lifetime.signal);
  f.resolve.mockResolvedValueOnce({ ...result, model: 'other' });
  await expect(
    resolveSendRoute(f.candidate, f.lifetime.signal),
  ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
  f.guest.abort();
  expect(result.revoked.aborted).toBe(true);
  await bound.runtime.close();
  expect(f.entryClose).toHaveBeenCalledTimes(1);
  expect(f.nativeClose).toHaveBeenCalledTimes(1);
  expect(f.codexClose).not.toHaveBeenCalled();
  await bound.egress.close();
  expect(f.codexClose).toHaveBeenCalledTimes(1);
});

it.each(['ready', 'failed', 'waiting'] as const)(
  'uses actual production slotted proof on direct and ticket HTTP paths after a sibling hot-add (%s)',
  { timeout: 15000 },
  async (scenario) => {
    const model = fixture();
    const f = nativeEntryFixture();
    const { context, identity } = f;
    io.identity.mockResolvedValue(identity);
    const actual = await vi.importActual<typeof ProductionDEntrySource>(
      './production-dentry-source.js',
    );
    io.entry.mockImplementation(actual.installProductionDEntrySource);

    const store = new MemoryStore();
    const h = harness(store);
    const signal = model.lifetime.signal;
    await h.service.prewarm(context, { trigger: 'page' }, signal);
    const binding = await h.service.resolve(context, signal);
    const added = { ...identity, employeeInstanceId: randomUUID() };
    const receipt = {
      binding,
      rosterDigest: 'initial-roster',
      endpoints: [f.endpoint],
      slots: [
        { hostPort: f.endpoint.hostPort, guestPort: f.endpoint.guestPort },
        {
          hostPort: f.endpoint.hostPort + 1,
          guestPort: f.endpoint.guestPort + 1,
        },
      ],
    };
    const roster = {
      personId: binding.personId,
      organizationId: binding.organizationId,
      entries: [identity, added],
      digest: 'current-roster',
    };
    const inspect = vi
      .fn<NonNullable<PersonVmNativePort['assertWebEndpoints']>>()
      .mockResolvedValue(undefined);
    const prepare = vi.fn(async () => {
      throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
    });
    h.native.assertWebEndpoints = inspect;
    h.native.prepareWebEndpoints = prepare;
    const ping = vi.spyOn(h.native, 'ping');
    const vm = new PersonVmService({
      ...h.options,
      nativeWeb: { prepare: async () => roster },
    });
    const scope = {
      binding,
      signal,
      assertCurrent: () => vm.assertCurrentBinding(context, binding, signal),
      launch: vi.fn(),
      readNativeWebGuestAddress: async () =>
        '172.16.0.6' as PersonVmNativeWebGuestAddress,
    } satisfies PersonVmBootstrapScope;
    const startup = createAssignedNativeWebStartup({
      vm,
      readRoster: async () => roster,
      memoryGuestPlan: h.runtime.memoryGuestPlan,
      hotGuest: { bootstrap: async () => scope, assertWebEndpoints: inspect },
      readEmployeeProfile: async () => [
        { path: 'package.json', contents: '{"name":"fixture-profile"}' },
      ],
      configuration: {
        cliPath: '/opt/dsh/lib/bin.js',
        startupTimeoutMs: 3000,
        publicUrl: () => 'https://editor.example.test/',
      },
      lifetime: signal,
      cleanupTimeoutMs: 1000,
    });
    io.openNativeWeb.mockImplementation(async () => ({
      revoked: signal,
      controlReady: () => true,
      verifyStartingEditor: async () => signal,
      close: async () => {},
    }));
    const openSql = () => {
      throw Error('Admission in this fixture must use the supplied boundary');
    };
    const admission = new PersonVmService({
      ...h.options,
      store: new PostgresPersonVmStore(openSql),
    }).createAdmissionHost({ openSql });
    const { boundary, participant } = f.admission;
    vi.spyOn(admission, 'participant').mockReturnValue(participant);
    vi.spyOn(admission, 'admit').mockResolvedValue({ ...f.permit, binding });
    vi.spyOn(admission, 'queued').mockImplementation(boundary.queued);
    vi.spyOn(admission, 'activate').mockImplementation(boundary.activate);
    vi.spyOn(admission, 'waitUntilReady').mockImplementation(
      boundary.waitUntilReady,
    );
    vi.spyOn(admission, 'finish').mockImplementation(boundary.finish);
    const bound = await createProductionPersonVmSources({
      authority: model.authority,
      attach: model.attach,
    }).bind({
      ...model.host,
      vm,
      startup,
      admission,
    });
    const finishPhysical = deferred<void>();
    const opened: (() => Promise<void>)[] = [];
    try {
      const web = { receipt, context };
      await startup.memoryGuestPlan(binding, signal, web);
      await startup.start(binding, signal, scope, web);
      await startup.synchronizeEmployee(
        context,
        binding,
        added,
        async () => {},
        signal,
      );
      expect(
        startup.catalog(binding, added.employeeInstanceId).receipt.rosterDigest,
      ).toBe(roster.digest);
      expect(
        startup.catalog(binding, identity.employeeInstanceId).receipt
          .rosterDigest,
      ).toBe(receipt.rosterDigest);
      inspect.mockClear();

      const catalog = installAssignedDEntryNativeCatalog({
        vm,
        startup,
        lifetime: signal,
      });
      opened.push(catalog.close);
      const prewarmCurrent = vi.fn(async () => {
        throw Error('unexpected VM start');
      });
      const installed = installDEntryNativePrewarm({
        prewarmCurrent,
        lifetime: signal,
        requireEditorProof: true,
        isLiveSlottedBinding: startup.isLiveSlottedBinding,
        readCoordination: async () => ({
          authorityRevision: 'current',
          vm: store.readWithVersion(binding.personId),
        }),
      });
      opened.push(installed.close);
      const server = await nativeEntryServer(f);
      opened.push(server.close);
      if (scenario === 'failed')
        inspect.mockRejectedValue(new PersonVmError('WEB_ENDPOINTS_PREPARING'));
      if (scenario === 'waiting')
        inspect
          .mockImplementationOnce(async (_receipt, active) => {
            active.throwIfAborted();
            await once(active, 'abort');
            active.throwIfAborted();
          })
          .mockImplementationOnce(async () => {
            await finishPhysical.promise;
          });

      const result = await server.request('native-prewarm', {
        ...f.body,
        trigger: 'page',
      });
      if (scenario === 'ready') {
        expect(result.status).toBe(200);
        expect(ping).toHaveBeenCalledExactlyOnceWith(
          binding,
          expect.any(AbortSignal),
        );
      } else {
        expect(result.status).toBe(202);
        const { ticket } = await result.json();
        const status = async () => {
          const query = new URLSearchParams({
            ...f.selection,
            organizationId: identity.organizationId,
            operationId: ticket.operationId,
          });
          const response = await fetch(
            `${server.origin}/internal/d-entry/native-prewarm/status?${query}`,
            {
              headers: {
                authorization: 'Bearer original_session_opaque_token',
              },
            },
          );
          expect(response.status).toBe(200);
          return response.json();
        };
        expect(ping).not.toHaveBeenCalled();
        if (scenario === 'failed') {
          expect(await status()).toEqual({
            state: 'failed',
            code: 'START_UNAVAILABLE',
          });
        } else {
          expect(await status()).toEqual({ state: 'starting' });
          finishPhysical.resolve();
          await vi.waitFor(async () =>
            expect(await status()).toEqual({ state: 'ready' }),
          );
          expect(ping).toHaveBeenCalledExactlyOnceWith(
            binding,
            expect.any(AbortSignal),
          );
        }
      }
      expect(inspect).toHaveBeenCalledTimes(scenario === 'ready' ? 1 : 2);
      expect(inspect.mock.calls.map(([checked]) => checked)).toEqual(
        Array.from({ length: scenario === 'ready' ? 1 : 2 }, () => receipt),
      );
      expect(prepare).not.toHaveBeenCalled();
      expect(prewarmCurrent).not.toHaveBeenCalled();
    } finally {
      finishPhysical.resolve();
      for (const close of opened.reverse()) await close();
      await bound.runtime.close();
      await bound.egress.close();
      await startup.close();
    }
  },
);

it('joins already attached native and Codex owners on source construction failure', async () => {
  const f = fixture();
  const failed = Error('entry data owner could not be installed');
  io.entry.mockImplementationOnce(() => {
    throw failed;
  });
  const sources = createProductionPersonVmSources({
    authority: f.authority,
    attach: f.attach,
  });
  await expect(sources.bind(f.host)).rejects.toBe(failed);
  expect(f.nativeClose).toHaveBeenCalledTimes(1);
  expect(f.codexClose).toHaveBeenCalledTimes(1);
});
