import { randomUUID } from 'node:crypto';
import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import type { DEntryPrincipalIssue } from '@allrice/d-entry-principal/types';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  deferredPromptFact,
  type NativePromptObservation,
} from '../native-web/prompt-observation.js';
import type { openNativeWebOwner } from '../native-web/owner.js';
import { createProductionNativeModelExecution } from './production-native-model-execution.js';

const mocks = vi.hoisted(() => ({ pin: vi.fn(), watch: vi.fn() }));
vi.mock('@allrice/database', () => ({
  getDEntryNativeRootPin: mocks.pin,
  watchDEntryNativeRosterAuthority: mocks.watch,
}));

type Observer = NonNullable<
  Parameters<typeof openNativeWebOwner>[0]['beforePrompt']
>;
type Attach = ReturnType<typeof createProductionNativeModelExecution>['attach'];
const identity: DEntryIdentity = {
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  personId: randomUUID(),
  employeeInstanceId: randomUUID(),
  employeeRevision: 1,
  employeeVersionId: randomUUID(),
  threadId: randomUUID(),
};
const binding = Object.freeze({
  vmId: randomUUID(),
  organizationId: identity.organizationId,
  personId: identity.personId,
  instanceId: randomUUID(),
  leaseEpoch: 1,
});
const issue: DEntryPrincipalIssue = {
  scopeId: randomUUID(),
  identity,
  access: 'execute',
  root: {
    nativeSessionId: 'native-root',
    rootBindingRef: 'binding',
    rootOriginDigest: 'origin',
  },
};
const login = (sessionId = randomUUID()): RequestContext => ({
  actor: { type: 'user', id: identity.personId },
  organizationId: identity.organizationId,
  workspaceId: identity.workspaceId,
  memberships: [],
  requestId: randomUUID(),
  sessionId,
  authenticatedAt: new Date().toISOString(),
});
beforeEach(() => {
  mocks.pin.mockReset().mockResolvedValue({
    vmId: binding.vmId,
    rootNativeSessionId: issue.root.nativeSessionId,
    rootBindingRef: issue.root.rootBindingRef,
    rootOriginDigest: issue.root.rootOriginDigest,
  });
  mocks.watch
    .mockReset()
    .mockImplementation(
      async (_context, _selector, _identity, signal: AbortSignal) => ({
        revoked: signal,
        close: vi.fn(async () => {}),
        assertObserved: vi.fn(async () => {}),
      }),
    );
});

function nativeFacts() {
  let inserted = false;
  const settled = deferredPromptFact<'discarded' | 'ended'>();
  const closed = deferredPromptFact<void>();
  const observation = {
    ready: Promise.resolve(),
    settled: settled.promise,
    close: vi.fn(async () => {
      settled.reject(Error('observer closed'));
      closed.resolve();
    }),
    inserted: () => inserted,
    assertClaimed: vi.fn(async () => {}),
    confirmedReplay: vi.fn(async () => false),
  } satisfies NativePromptObservation;
  return {
    observation,
    closed: closed.promise,
    settle: settled.resolve,
    insert() {
      inserted = true;
    },
  };
}

async function setup() {
  const lifetime = new AbortController();
  let observed!: Observer;
  const profile = {
    owner: { modelAdapterId: 'adapter' },
    bindingRef: 'binding',
    receipt: { rosterDigest: 'roster' },
    revoked: lifetime.signal,
  };
  const attached = await createProductionNativeModelExecution().attach(
    {
      lifetime: lifetime.signal,
      startup: {
        installModelAdapter: () => () => {},
        installModelPromptObserver(observer: Observer) {
          observed = observer;
          return () => {};
        },
        catalog: () => profile,
      },
    } as unknown as Parameters<Attach>[0],
    {
      routeRevoked: lifetime.signal,
      assertRouteCurrent: async () => lifetime.signal,
    } as unknown as Parameters<Attach>[1],
  );
  return {
    admit(
      context: RequestContext,
      requestId: string,
      native: ReturnType<typeof nativeFacts>,
      mode: 'queue' | 'steer' = 'queue',
    ) {
      return observed(
        {
          binding,
          adapterId: 'adapter',
          context,
          issue,
          requestId,
          mode,
          observe: () => native.observation,
        },
        lifetime.signal,
      );
    },
    async close() {
      lifetime.abort();
      await attached.close();
    },
  };
}

it('releases a removed queue occurrence so another login can send after the claimed turn ends', async () => {
  const f = await setup();
  try {
    const a = login(),
      b = login();
    const first = nativeFacts(),
      queued = nativeFacts();
    const firstCall = await f.admit(a, 'first', first);
    first.insert();
    firstCall.accepted();
    const queuedCall = await f.admit(a, 'queued', queued);
    queued.insert();
    queuedCall.accepted();
    const duplicate = nativeFacts();
    duplicate.observation.confirmedReplay.mockResolvedValue(true);
    (await f.admit(a, 'queued', duplicate)).accepted();
    await duplicate.closed;
    expect(queued.observation.close).not.toHaveBeenCalled();
    await expect(
      f.admit(b, 'other', nativeFacts(), 'steer'),
    ).rejects.toMatchObject({ code: 'VM_ACTIVE' });
    first.settle('ended');
    await Promise.resolve();
    await expect(
      f.admit(b, 'other', nativeFacts(), 'steer'),
    ).rejects.toMatchObject({ code: 'VM_ACTIVE' });
    const admitted = f.admit(b, 'other', nativeFacts());
    queued.settle('discarded');
    await queued.closed;
    await (await admitted).undispatched();
  } finally {
    await f.close();
  }
});

it('frees only a certain pre-dispatch failure and keeps a carrier-unknown prompt', async () => {
  const f = await setup();
  try {
    const a = login(),
      b = login();
    const rejected = nativeFacts();
    await (await f.admit(a, 'rejected', rejected)).undispatched();
    expect(rejected.observation.close).toHaveBeenCalledOnce();
    const unknown = nativeFacts();
    (await f.admit(b, 'same-id', unknown, 'steer')).unknown();
    await expect(
      f.admit(a, 'other', nativeFacts(), 'steer'),
    ).rejects.toMatchObject({ code: 'VM_ACTIVE' });
    await expect(f.admit(b, 'same-id', nativeFacts())).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
    unknown.insert();
    const retry = nativeFacts();
    retry.observation.confirmedReplay.mockResolvedValue(true);
    (await f.admit(b, 'same-id', retry)).accepted();
    await retry.closed;
    expect(unknown.observation.close).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
