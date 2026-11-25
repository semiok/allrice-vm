import { randomUUID } from 'node:crypto';
import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import type { DEntryPrincipalIssue } from '@allrice/d-entry-principal/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deferredPromptFact,
  type NativePromptObservation,
} from '../native-web/prompt-observation.js';
import type { openNativeWebOwner } from '../native-web/owner.js';
import {
  createProductionNativeModelExecution,
  nativeRunExecutionIds,
  readNativePromptContributors,
} from './production-native-model-execution.js';

const mocks = vi.hoisted(() => ({ pin: vi.fn(), watch: vi.fn() }));
vi.mock('@allrice/database', () => ({
  getDEntryNativeRootPin: mocks.pin,
  watchDEntryNativeRosterAuthority: mocks.watch,
}));

type Observer = NonNullable<
  Parameters<typeof openNativeWebOwner>[0]['beforePrompt']
>;
type Attach = ReturnType<typeof createProductionNativeModelExecution>['attach'];
type RootWake = Awaited<
  ReturnType<
    Awaited<ReturnType<typeof openNativeWebOwner>>['readNativeRootWakeFor']
  >
>;
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
  const readRootWake = vi.fn<() => Promise<RootWake>>(async () => ({
    kind: 'clear',
  }));
  const profile = {
    owner: { modelAdapterId: 'adapter', readNativeRootWakeFor: readRootWake },
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
    readRootWake,
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

describe('native delegated execution', () => {
  it('fences another login before a wake model reference and releases it after the same native root ends', async () => {
    const f = await setup();
    try {
      const original = nativeFacts();
      const a = login();
      const b = login();
      const admitted = await f.admit(a, 'original', original);
      original.insert();
      admitted.accepted();
      original.settle('ended');
      await Promise.resolve();

      f.readRootWake.mockResolvedValue({
        kind: 'delegated',
        turn: 2,
        promptIds: ['original'],
      });
      const otherSteer = nativeFacts();
      await expect(
        f.admit(b, 'foreign', otherSteer, 'steer'),
      ).rejects.toMatchObject({
        code: 'VM_ACTIVE',
      });
      expect(otherSteer.observation.close).toHaveBeenCalledOnce();
      await (
        await f.admit(a, 'same-login', nativeFacts(), 'steer')
      ).undispatched();
      expect(original.observation.assertClaimed).toHaveBeenCalledOnce();

      f.readRootWake.mockResolvedValue({ kind: 'unproven' });
      await expect(
        f.admit(b, 'unknown', nativeFacts(), 'steer'),
      ).rejects.toMatchObject({
        code: 'VM_ACTIVE',
      });
      f.readRootWake.mockResolvedValue({ kind: 'clear' });
      await (
        await f.admit(b, 'after-end', nativeFacts(), 'steer')
      ).undispatched();
      expect(original.observation.close).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('keeps an ended native source without occupying the queue and reuses its login authority watch', async () => {
    const f = await setup();
    try {
      const context = login();
      const original = nativeFacts();
      const send = await f.admit(context, 'origin', original);
      original.insert();
      send.accepted();
      original.settle('ended');
      await Promise.resolve();

      const next = nativeFacts();
      const sameLogin = await f.admit(context, 'second', next);
      expect(mocks.watch).toHaveBeenCalledTimes(1);
      expect(original.observation.close).not.toHaveBeenCalled();
      await sameLogin.undispatched();

      const other = await f.admit(
        login(),
        'another-login',
        nativeFacts(),
        'steer',
      );
      expect(mocks.watch).toHaveBeenCalledTimes(2);
      expect(original.observation.close).not.toHaveBeenCalled();
      await other.undispatched();
    } finally {
      await f.close();
    }
  });

  it('requires every contributing request to retain the same exact authorization', () => {
    const logout = new AbortController();
    const authority = {
      authorityKey: 'thread-owner-login',
      revoked: logout.signal,
    };
    const contributors = new Map([
      ['original', authority],
      ['same-login', { ...authority }],
      [
        'different-login',
        {
          authorityKey: 'thread-owner-other-login',
          revoked: new AbortController().signal,
        },
      ],
    ]);
    const read = (id: string) => contributors.get(id);

    expect(
      readNativePromptContributors(['original', 'same-login'], read)?.first,
    ).toBe(authority);
    expect(
      readNativePromptContributors(['original', 'different-login'], read),
    ).toBeNull();
    expect(
      readNativePromptContributors(['missing', 'same-login'], read),
    ).toBeNull();
    logout.abort();
    expect(readNativePromptContributors(['original'], read)).toBeNull();
    expect(
      readNativePromptContributors(['different-login'], read),
    ).not.toBeNull();
  });

  it('keeps the originating human Run, child turn, and idle parent wakeup distinct', () => {
    const ids = new Map<string, string>();
    const attempt = { kind: 'assistant' as const, id: 'attempt-1' };
    const main = (sourceTurn: number, delegated: boolean) =>
      nativeRunExecutionIds(ids, 'original-run', {
        ...attempt,
        sessionId: 'root',
        sourceTurn,
        delegated,
      });
    const child = (sourceTurn: number, id = attempt.id) =>
      nativeRunExecutionIds(ids, 'original-run', {
        ...attempt,
        id,
        sessionId: 'child',
        sourceTurn,
        delegated: true,
      });
    const original = main(1, false);
    const background = child(1);
    const wakeup = main(2, true);
    expect(original.runId).toBe('original-run');
    expect(new Set([original.runId, background.runId, wakeup.runId]).size).toBe(
      3,
    );
    expect(child(1)).toEqual(background);
    expect(child(1, 'attempt-2')).toMatchObject({ runId: background.runId });
    expect(child(1, 'attempt-2').executionId).not.toBe(background.executionId);
    expect(child(2).runId).not.toBe(background.runId);
  });
});
