import { randomUUID } from 'node:crypto';
import { PersonVmError } from '@allrice/person-vm';
import type { RequestContext } from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import type * as Database from '@allrice/database';
import { afterEach, expect, it, vi } from 'vitest';
import { currentDEntryNativeDataPort } from '../d-entry/native-data.js';
import {
  installDEntryNativeOwnerPort,
  resolveDEntryNativeResource,
  type ResolvedDEntryNativeOwner,
} from '../d-entry/native-owner.js';
import { NativeRootJoinUnknown } from '../native-web/owner.js';
import { installProductionDEntrySource } from './production-dentry-source.js';

const { current, policy, profile } = vi.hoisted(() => ({
  current: vi.fn(),
  policy: vi.fn(),
  profile: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
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
  const route = {
    provider: 'managed-test',
    model: 'fixture',
    revoked: new AbortController().signal,
  };
  const assertCurrent = vi.fn(async () => {});
  profile.mockResolvedValue({ assertCurrent });
  current.mockResolvedValue(identity);
  policy.mockResolvedValue({
    revision: 'fixture',
    defaultGeneration: '3.x',
    selections: [
      { organizationId: binding.organizationId, personId: binding.personId },
    ],
  });
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
  const confirmPhysical = vi.fn(async () => {});
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
  let verified: AbortSignal | null = null;
  let proof!: Proof;
  const uninstallProof = vi.fn(() => {
    verified = null;
  });
  const group = new AbortController();
  const startup = {
    assertAuthenticatedGroup: vi.fn(() => group.signal),
    catalog: vi.fn(() => ({ ...roster, owner: host })),
    installStartingEditorProof(value: Proof) {
      proof = value;
      return uninstallProof;
    },
    assertVerifiedEditor(next: typeof binding) {
      if (
        !verified ||
        verified.aborted ||
        binding.leaseEpoch !== next.leaseEpoch
      )
        throw Error('RUNTIME_NOT_READY');
      return verified;
    },
    async ensureVerifiedEditor(_context: RequestContext, next: typeof binding) {
      return this.assertVerifiedEditor(next);
    },
  };
  const source = installProductionDEntrySource({
    startup: startup as unknown as Input['startup'],
    admission: admission as unknown as Input['admission'],
    lifetime: signal,
    confirmPhysical,
    resolveSendRoute,
  });
  cleanup.push(source.close);
  const verificationOwner = {};
  async function prove(modelAdapterId?: string) {
    verified = await proof(
      {
        binding,
        endpoint,
        context,
        ...(modelAdapterId && { modelAdapterId }),
        readModels,
        profile: {
          revoked: signal,
          verificationOwner,
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
    group,
    assertAuthenticatedGroup: startup.assertAuthenticatedGroup,
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
    confirmPhysical,
    resolveSendRoute,
    owner,
    host,
    uninstallProof,
  };
}

it('reuses model catalog proof for the installed adapter and rechecks live route on every page', async () => {
  const f = fixture();
  await f.prove('original-adapter');
  await f.prove('original-adapter');
  expect(f.readModels).toHaveBeenCalledOnce();
  expect(f.resolveSendRoute).toHaveBeenCalledTimes(2);
  expect(f.assertCurrent).toHaveBeenCalledTimes(2);

  await f.prove('replacement-adapter');
  expect(f.readModels).toHaveBeenCalledTimes(2);
  f.resolveSendRoute.mockRejectedValueOnce(
    new DataAccessError('authorization_denied'),
  );
  await expect(f.prove('replacement-adapter')).rejects.toMatchObject({
    code: 'authorization_denied',
  });
  expect(f.readModels).toHaveBeenCalledTimes(2);
});

it('publishes exact-generation readiness only after same Host artifact, native model and managed route verification', async () => {
  const f = fixture();
  await expect(f.source.readiness(f.binding, f.signal)).rejects.toThrow(
    'RUNTIME_NOT_READY',
  );
  expect(await f.prove()).toBe(f.route.revoked);
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

it('requires the live physical proof even with the current employee already verified', async () => {
  const f = fixture();
  const uninstall = installDEntryNativeOwnerPort({
    resolve: async () => f.owner,
  });
  try {
    await f.prove();
    f.confirmPhysical.mockRejectedValueOnce(
      new PersonVmError('RUNTIME_NOT_READY'),
    );
    await expect(
      f.port.confirmVerifiedEditor!(f.context, f.identity, f.signal),
    ).resolves.toBeUndefined();
    const ready = await f.port.confirmVerifiedEditor!(
      f.context,
      f.identity,
      f.signal,
    );
    expect(ready?.binding).toEqual(f.binding);
    expect(ready?.proof.aborted).toBe(false);
    expect(f.confirmPhysical).toHaveBeenCalledWith(
      f.context,
      f.identity,
      f.binding,
      expect.any(AbortSignal),
    );
  } finally {
    uninstall();
  }
});

it('ties the selected prewarm proof to the revocation of the authenticated Host group', async () => {
  const f = fixture();
  const uninstall = installDEntryNativeOwnerPort({
    resolve: async () => f.owner,
  });
  try {
    await f.prove();
    const proof = await f.port.assertEditorReady!(
      f.context,
      f.identity,
      f.signal,
    );
    expect(f.assertAuthenticatedGroup).toHaveBeenCalledWith(
      f.binding,
      expect.any(AbortSignal),
    );
    expect(proof.aborted).toBe(false);
    const siblingLost = Error('fixture sibling lost');
    f.group.abort(siblingLost);
    expect(f.owner.revoked.aborted).toBe(false);
    expect(f.route.revoked.aborted).toBe(false);
    expect(proof.aborted).toBe(true);
    expect(proof.reason).toBe(siblingLost);
  } finally {
    uninstall();
  }
});

it('requires rollout authority, a routable exact model and a current employee after all async evidence', async () => {
  const f = fixture();
  policy.mockResolvedValueOnce({
    revision: 'fixture-history',
    defaultGeneration: '3.x',
    selections: [],
  });
  expect(await f.prove()).toBeNull();
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

it('does not release admission on an unconfirmed native root outcome', async () => {
  const f = fixture();
  await f.prove();
  await f.port.resolveAdmissionOwner({
    context: f.context,
    identity: { ...f.identity, threadId: randomUUID() },
    owner: f.owner,
    operationId: randomUUID(),
    signal: f.signal,
  });
  const unknown = new NativeRootJoinUnknown(Error('broken native wire'));
  f.host.createRootFor.mockRejectedValueOnce(unknown);
  const activity = f.port.acquireRoot(
    { owner: f.owner, request: {} },
    f.signal,
  );
  await expect(activity.run(f.signal)).rejects.toBe(unknown);
  await expect(activity.close()).rejects.toBe(unknown);
});

it('requires a live DSH agent in the current pinned ancestry before authorizing a model call', async () => {
  const f = fixture();
  const identity = { ...f.identity, threadId: randomUUID() };
  const id = 'current-child';
  const root = 'current-root';
  const pin = vi.fn(async () => ({
    identity,
    rootNativeSessionId: root,
    rootOriginDigest: 'sha256:fixture',
    rootBindingRef: randomUUID(),
    vmId: f.binding.vmId,
  }));
  const persisted = await pin();
  pin.mockResolvedValue(persisted);
  function state(running: boolean, agentAvailable: boolean) {
    f.owner.readSessions.mockResolvedValue({
      ok: true,
      value: {
        items: [
          {
            sessionId: root,
            updatedAt: 1,
            blank: false,
            running: false,
            agentAvailable: true,
          },
          {
            sessionId: id,
            parentSessionId: root,
            origin: 'subagent',
            updatedAt: 2,
            blank: false,
            running,
            agentAvailable,
          },
        ],
      },
    });
  }
  const modelRequest = {
    context: f.context,
    identity,
    owner: f.owner,
    nativeSessionId: id,
    signal: new AbortController().signal,
    root: pin,
    requireRunning: true,
    requireLiveAgent: true,
  };
  state(false, true);
  await expect(resolveDEntryNativeResource(modelRequest)).rejects.toMatchObject(
    { code: 'authorization_denied' },
  );
  state(true, false);
  await expect(resolveDEntryNativeResource(modelRequest)).rejects.toMatchObject(
    { code: 'authorization_denied' },
  );
  state(true, true);
  await expect(
    resolveDEntryNativeResource(modelRequest),
  ).resolves.toMatchObject({
    threadId: identity.threadId,
    parentNativeSessionId: root,
    nativeSessionId: id,
    nativeAddress: {
      kind: 'subagent',
      parentSessionId: root,
      childSessionId: id,
      mode: 'unknown',
    },
  });
});
