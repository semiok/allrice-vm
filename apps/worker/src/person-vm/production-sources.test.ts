import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { modelBinding } from '../../../../packages/model-gateway/src/gateway.fixture.js';
import type { ProductionPersonVmHostSources } from './production-host.js';
import type {
  installProductionDEntrySource,
  ResolveProductionDEntrySendRoute,
} from './production-dentry-source.js';
import type { createProductionEgressAuthority } from './production-egress-authority.js';
import type { createProductionCodexRuntime as loadCodexRuntime } from './production-codex-runtime.js';
import {
  createProductionPersonVmSources,
  type ProductionNativeModelExecution,
} from './production-sources.js';

const io = vi.hoisted(() => ({
  codex: vi.fn<typeof loadCodexRuntime>(),
  entry: vi.fn<typeof installProductionDEntrySource>(),
  egress: vi.fn<typeof createProductionEgressAuthority>(),
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
  } satisfies Parameters<ResolveProductionDEntrySendRoute>[0];
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
  });
  const nativeClose = vi.fn(async () => {});
  const authority = {
    assertCall: vi.fn(async () => {}),
    authorizeUsage: vi.fn(),
    confirmOwnerStopped: vi.fn(),
  };
  const resolve = vi.fn<ResolveProductionDEntrySendRoute>().mockResolvedValue({
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
    startup: Object.freeze({}),
    admission: Object.freeze({}),
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
  };
}

it('shares the exact route and call association between A, B and the selected Codex owner', async () => {
  const f = fixture();
  const sources = createProductionPersonVmSources({
    authority: f.authority,
    attach: f.attach,
  });
  const bound = await sources.bind(f.host);
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
