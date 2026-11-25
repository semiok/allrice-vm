import { randomUUID } from 'node:crypto';
import type { RequestContext } from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import { afterEach, expect, it, vi } from 'vitest';
import { currentDEntryNativeDataPort } from '../d-entry/native-data.js';
import type { ResolvedDEntryNativeOwner } from '../d-entry/native-owner.js';
import { installProductionDEntrySource } from './production-dentry-source.js';

const { current, policy, profile } = vi.hoisted(() => ({
  current: vi.fn(),
  policy: vi.fn(),
  profile: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof import('@allrice/database')>()),
  requireDEntryNativeIdentity: current,
  readDEntryReleasePolicy: policy,
}));
vi.mock('../d-entry/released-profile.js', () => ({
  holdReleasedProfile: profile,
  readWorkerEmployeeWebSeal: async () => ({
    directory: '/worker/sealed',
    manifestSha256: 'manifest',
  }),
}));

type Input = Parameters<typeof installProductionDEntrySource>[0];
type Proof = Parameters<Input['startup']['installStartingEditorProof']>[0];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  vi.resetAllMocks();
});

function fixture() {
  const lifetime = new AbortController();
  const binding = {
    personId: randomUUID(),
    organizationId: randomUUID(),
    vmId: randomUUID(),
    instanceId: randomUUID(),
    leaseEpoch: 2,
  };
  const endpoint = {
    workspaceId: randomUUID(),
    employeeInstanceId: randomUUID(),
    employeeRevision: 3,
    employeeVersionId: randomUUID(),
    guestPort: 34000,
    hostPort: 34010,
  };
  const context: RequestContext = {
    actor: { type: 'user', id: binding.personId },
    organizationId: binding.organizationId,
    workspaceId: endpoint.workspaceId,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
  const identity = {
    personId: binding.personId,
    organizationId: binding.organizationId,
    workspaceId: endpoint.workspaceId,
    employeeInstanceId: endpoint.employeeInstanceId,
    employeeRevision: endpoint.employeeRevision,
    employeeVersionId: endpoint.employeeVersionId,
    threadId: null,
  };
  const route = { provider: 'managed-test', model: 'fixture' };
  const assertCurrent = vi.fn(async () => {});
  profile.mockResolvedValue({ assertCurrent });
  current.mockResolvedValue(identity);
  policy.mockResolvedValue({ defaultGeneration: '4.0', selections: [] });
  const readModels = vi.fn<Parameters<Proof>[0]['readModels']>(async () => ({
    ok: true,
    value: {
      default: route,
      groups: [
        {
          id: route.provider,
          name: 'fixture',
          models: [{ id: route.model, name: 'fixture' }],
        },
      ],
      routableProviders: [route.provider],
      failures: [],
    },
  }));
  const resolveSendRoute = vi.fn(async () => route);
  const signal = lifetime.signal;
  const participant = { participant: 'entry' };
  const admission = { participant: vi.fn(() => participant) };
  const host = { createRootFor: vi.fn(), revoked: signal };
  const roster = {
    receipt: { binding, rosterDigest: 'roster', endpoints: [endpoint] },
    endpoint,
    bindingRef: randomUUID(),
    revoked: signal,
  };
  const owner = {
    ...roster,
    controlReady: () => true,
    assertCurrent: vi.fn(async () => {}),
    acquirePrincipal: vi.fn(),
    readSessions: vi.fn(),
  } satisfies ResolvedDEntryNativeOwner;
  let verified = false;
  let proof!: Proof;
  const uninstallProof = vi.fn(() => {
    verified = false;
  });
  const startup = {
    catalog: vi.fn(() => ({ ...roster, owner: host })),
    installStartingEditorProof(value: Proof) {
      proof = value;
      return uninstallProof;
    },
    assertVerifiedEditor(next: typeof binding) {
      if (!verified || binding.leaseEpoch !== next.leaseEpoch)
        throw Error('RUNTIME_NOT_READY');
    },
  };
  const source = installProductionDEntrySource({
    startup: startup as unknown as Input['startup'],
    admission: admission as unknown as Input['admission'],
    lifetime: signal,
    resolveSendRoute,
  });
  cleanup.push(source.close);
  async function prove() {
    verified = await proof(
      {
        binding,
        endpoint,
        context,
        readModels,
        profile: {
          revoked: signal,
          readImmutableGraph: vi.fn(),
          readImmutableBundle: vi.fn(),
        },
      },
      signal,
    );
    return verified;
  }
  return {
    source,
    port: currentDEntryNativeDataPort()!,
    binding,
    endpoint,
    identity,
    context,
    signal,
    admit: admission.participant,
    participant,
    prove,
    route,
    assertCurrent,
    readModels,
    resolveSendRoute,
    owner,
    host,
    uninstallProof,
  };
}

it('publishes exact-generation readiness only after same Host artifact, native model and managed route verification', async () => {
  const f = fixture();
  await expect(f.source.readiness(f.binding, f.signal)).rejects.toThrow(
    'RUNTIME_NOT_READY',
  );
  expect(await f.prove()).toBe(true);
  expect(f.assertCurrent).toHaveBeenCalledOnce();
  expect(f.resolveSendRoute).toHaveBeenCalledWith(
    { context: f.context, identity: f.identity, binding: f.binding },
    expect.any(AbortSignal),
  );
  await expect(f.source.readiness(f.binding, f.signal)).resolves.toEqual({
    binding: f.binding,
    authenticated: true,
    editorReady: true,
    canSend: true,
  });
  await expect(
    f.source.readiness({ ...f.binding, leaseEpoch: 3 }, f.signal),
  ).rejects.toThrow('RUNTIME_NOT_READY');
  await f.source.close();
  expect(f.uninstallProof).toHaveBeenCalledOnce();
  expect(currentDEntryNativeDataPort()).toBeUndefined();
});

it('requires rollout authority, a routable exact model and a current employee after all async evidence', async () => {
  const f = fixture();
  policy.mockResolvedValueOnce({ defaultGeneration: '3.x', selections: [] });
  expect(await f.prove()).toBe(false);
  expect(f.readModels).not.toHaveBeenCalled();
  f.resolveSendRoute.mockResolvedValueOnce({ ...f.route, model: 'different' });
  await expect(f.prove()).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
  current.mockResolvedValueOnce(f.identity).mockResolvedValueOnce({
    ...f.identity,
    employeeRevision: f.identity.employeeRevision + 1,
  });
  await expect(f.prove()).rejects.toBeInstanceOf(DataAccessError);
  await expect(f.source.readiness(f.binding, f.signal)).rejects.toThrow(
    'RUNTIME_NOT_READY',
  );
});

it('binds the same entry participant and keeps native root creation inert until run, then joins it on close', async () => {
  const f = fixture();
  await f.prove();
  expect(f.admit).toHaveBeenCalledWith('entry');
  expect(f.port.admission.participant).toBe(f.participant);
  const operationId = randomUUID();
  const owned = await f.port.resolveAdmissionOwner({
    context: f.context,
    identity: { ...f.identity, threadId: randomUUID() },
    owner: f.owner,
    operationId,
    signal: f.signal,
  });
  expect(owned.operationId).toBe(operationId);
  const activity = f.port.acquireRoot(
    { owner: f.owner, request: {} },
    f.signal,
  );
  expect(f.host.createRootFor).not.toHaveBeenCalled();
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.host.createRootFor.mockImplementationOnce(async () => {
    start();
    await done;
  });
  const running = activity.run(f.signal);
  await started;
  let closed = false;
  const closing = activity.close().then(() => {
    closed = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
  } finally {
    finish();
    await Promise.allSettled([running, closing]);
  }
  expect(f.port.acquireRpc).toBeUndefined();
  expect(f.port.acquireMux).toBeUndefined();
});
