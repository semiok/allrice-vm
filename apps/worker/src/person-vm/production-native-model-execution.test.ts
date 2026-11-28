import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import type { DEntryPrincipalIssue } from '@allrice/d-entry-principal/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deferredPromptFact,
  observeNativePrompt,
  type NativePromptObservation,
} from '../native-web/prompt-observation.js';
import type { openNativeWebOwner } from '../native-web/owner.js';
import { installDEntryNativeOwnerPort } from '../d-entry/native-owner.js';
import { selectNativeMemoryConfiguration } from './production-native-memory.js';
import {
  createProductionNativeModelExecution,
  nativeRunExecutionIds,
  readNativePromptContributors,
} from './production-native-model-execution.js';

const mocks = vi.hoisted(() => ({
  pin: vi.fn(),
  watch: vi.fn(),
  query: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof import('@allrice/database')>()),
  getDEntryNativeRootPin: mocks.pin,
  getDatabase: () =>
    Object.assign(mocks.query, { json: (value: unknown) => value }),
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
  mocks.query.mockReset();
  mocks.pin.mockReset().mockResolvedValue({
    identity,
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
        assertObservedNow: vi.fn(),
        assertCurrent: vi.fn(async () => {}),
      }),
    );
});

it('checks the exact adopted message occurrence for billing after the native turn has ended', async () => {
  const source = {
    adapterId: 'native-fixture',
    sessionId: issue.root.nativeSessionId,
    scopeId: issue.scopeId,
    requestId: 'native-request',
  };
  const adopted = { messageId: 'native-message', turn: 2 };
  const active = new AbortController().signal;
  const observer = observeNativePrompt(
    {
      async readManagedModelProof(_body, _signal, _image, receive) {
        receive?.(
          Buffer.from(
            `ready\ninserted ${JSON.stringify({ messageId: adopted.messageId })}\nclaimed ${JSON.stringify(adopted)}\nended\n`,
          ),
        );
        return null;
      },
    },
    source,
    active,
    1000,
  );
  await expect(observer.settled).resolves.toBe('ended');
  await expect(
    observer.assertInserted(adopted.messageId, active),
  ).resolves.toBeUndefined();
  const { sessionId, scopeId, requestId } = source;
  const proof = { sessionId, scopeId, requestId, ...adopted };
  await expect(observer.assertClaimed(active, proof)).resolves.toBeUndefined();
  for (const mismatch of [
    { sessionId: 'another-session' },
    { scopeId: randomUUID() },
    { messageId: 'another-message' },
    { turn: 3 },
  ]) {
    await expect(
      observer.assertClaimed(active, { ...proof, ...mismatch }),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  }
  await observer.close();
});

it('fences the private call result and joins actual publication when the native body cancels', async () => {
  const source = {
    adapterId: 'native-fixture',
    sessionId: issue.root.nativeSessionId,
    scopeId: issue.scopeId,
    requestId: 'native-request',
  };
  const ticket = randomUUID();
  const adopted = { messageId: 'native-message', turn: 2 };
  const frame = {
    ticket,
    fact: {
      attemptId: 'native-attempt',
      assistantSequence: 4,
      callId: 'native-call',
      name: 'mcp__allrice__memory_read',
      sequence: 5,
      executionSessionRef: source.sessionId,
      executionParentRef: null,
      dispatch: { kind: 'sealed-handler', version: 'fixture-memory' },
      human: {
        occurrence: {
          sessionId: source.sessionId,
          requestId: source.requestId,
          scopeId: source.scopeId,
          ...adopted,
        },
        kind: 'ordinary-human-message',
        sequence: 2,
        digest: 'sha256:' + 'a'.repeat(64),
      },
    },
  };
  const start = deferredPromptFact<AbortSignal>();
  const release = deferredPromptFact<void>();
  const finish = deferredPromptFact<void>();
  const send = deferredPromptFact<(chunk: Buffer) => void>();
  const reply = vi.fn();
  const observe = observeNativePrompt(
    {
      async readManagedModelProof(body, _signal, _image, receive) {
        if (!receive) {
          reply(body);
          return null;
        }
        expect(JSON.parse(body)).toMatchObject({ memoryCalls: true });
        receive(
          Buffer.from(
            `ready\ninserted ${JSON.stringify({ messageId: adopted.messageId })}\nclaimed ${JSON.stringify(adopted)}\n`,
          ),
        );
        send.resolve(receive);
        await finish.promise;
        return null;
      },
    },
    source,
    new AbortController().signal,
    5_000,
    undefined,
    async (fact, signal) => {
      expect(fact).toEqual(frame.fact);
      start.resolve(signal);
      await release.promise;
      return 'already-issued-ref';
    },
  );
  try {
    await observe.ready;
    const receive = await send.promise;
    receive(Buffer.from(`memory-call ${JSON.stringify(frame)}\n`));
    const active = await start.promise;
    receive(Buffer.from(`memory-call-cancel ${ticket}\nended\n`));
    expect(active.aborted).toBe(true);
    finish.resolve();
    const settled = vi.fn();
    void observe.settled.then(settled);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    release.resolve();
    await expect(observe.settled).resolves.toBe('ended');
    expect(reply).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    release.resolve();
    await observe.close();
  }
});

it.each([
  [null, 'PROVIDER_FAILED'],
  ['different-message', 'PROVIDER_FAILED'],
  ['native-message', undefined],
])(
  'validates an acknowledged child insertion before a turn claims it (%s)',
  async (messageId, code) => {
    const finish = deferredPromptFact<null>();
    const active = new AbortController().signal;
    const observer = observeNativePrompt(
      {
        readManagedModelProof(_body, signal, _image, receive) {
          if (!receive) return Promise.resolve(JSON.stringify({ messageId }));
          signal.addEventListener('abort', () => finish.reject(signal.reason), {
            once: true,
          });
          receive(Buffer.from('ready\n'));
          return finish.promise;
        },
      },
      {
        adapterId: 'native-fixture',
        sessionId: 'native-child',
        parentSessionId: issue.root.nativeSessionId,
        scopeId: issue.scopeId,
        requestId: 'native-request',
      },
      active,
      1000,
    );
    try {
      await observer.ready;
      const receipt = observer.assertInserted('native-message', active);
      if (code) await expect(receipt).rejects.toHaveProperty('code', code);
      else await expect(receipt).resolves.toBeUndefined();
    } finally {
      await observer.close();
    }
  },
);

function nativeFacts() {
  let messageId: string | undefined;
  const settled = deferredPromptFact<'discarded' | 'ended'>();
  const closed = deferredPromptFact<void>();
  const observation = {
    ready: Promise.resolve(),
    settled: settled.promise,
    close: vi.fn(async () => {
      settled.reject(Error('observer closed'));
      closed.resolve();
    }),
    inserted: () => messageId !== undefined,
    readInsertedMessageId: vi.fn(async () => messageId),
    assertInserted: vi.fn(async () => {}),
    assertClaimed: vi.fn(async () => {}),
    confirmedReplay: vi.fn(async () => false),
  } satisfies NativePromptObservation;
  return {
    observation,
    closed: closed.promise,
    settle: settled.resolve,
    insert(id = 'fixture-message') {
      messageId = id;
    },
  };
}

async function setup(
  nativeMemory?: Parameters<Attach>[0]['nativeMemory'],
  withWebSearch = false,
  scopedRouting = false,
) {
  const lifetime = new AbortController();
  let observed!: Observer;
  const readRootWake = vi.fn<() => Promise<RootWake>>(async () => ({
    kind: 'clear',
  }));
  const readNativeAttemptFor = vi.fn();
  const observeNativeSearchCallFor = vi.fn();
  const bindWebSearch =
    vi.fn<NonNullable<Parameters<Attach>[1]['webSearch']>['bind']>();
  const adapterId = 'a'.repeat(64);
  const model = 'fixture-codex';
  const nativeInstanceId = randomUUID();
  const endpoint = {
    workspaceId: identity.workspaceId,
    employeeInstanceId: identity.employeeInstanceId,
    employeeVersionId: identity.employeeVersionId,
    employeeRevision: identity.employeeRevision,
    hostPort: 12345,
    guestPort: 12346,
  };
  const receipt = { binding, rosterDigest: 'roster', endpoints: [endpoint] };
  const profile = {
    owner: {
      modelAdapterId: adapterId,
      readNativeRootWakeFor: readRootWake,
      readNativeAttemptFor,
      observeNativeSearchCallFor,
      nativeInstanceId,
    },
    endpoint,
    bindingRef: 'binding',
    receipt,
    revoked: lifetime.signal,
  };
  const runJournalOwners = vi.fn(() => []);
  const bindReference = vi.fn();
  const attached = await createProductionNativeModelExecution().attach(
    {
      lifetime: lifetime.signal,
      nativeMemory,
      providers: { applicationBuild: { manifestDigest: 'fixture-build' } },
      startup: {
        installModelAdapter: () => () => {},
        installModelPromptObserver(observer: Observer) {
          observed = observer;
          return () => {};
        },
        catalog: () => profile,
        runJournalOwners,
      },
    } as unknown as Parameters<Attach>[0],
    {
      routeRevoked: lifetime.signal,
      assertRouteCurrent: async () => lifetime.signal,
      route: { provider: 'openai-codex', model },
      bindReference,
      ...(scopedRouting && { scoped: { applies: () => true } }),
      ...(withWebSearch && {
        webSearch: { provider: { search: vi.fn() }, bind: bindWebSearch },
      }),
    } as unknown as Parameters<Attach>[1],
  );
  return {
    readRootWake,
    runJournalOwners,
    readNativeAttemptFor,
    bindReference,
    bindWebSearch,
    observeNativeSearchCallFor,
    resolveReference: attached.references?.[0]?.resolve,
    resolveSearch: attached.references?.find(
      (service) => service.id === 'web-search',
    )?.resolve,
    selection: { adapterId, provider: 'openai-codex', model },
    profile,
    async admit(
      context: RequestContext,
      requestId: string,
      native: ReturnType<typeof nativeFacts>,
      mode: 'queue' | 'steer' = 'queue',
      child?: { sessionId: string; parentSessionId: string },
    ) {
      const result = await observed(
        {
          endpoint: child ? 'subagents/prompt' : 'session/prompt',
          binding,
          adapterId,
          context,
          issue,
          requestId,
          mode,
          child,
          observe: () => native.observation,
        },
        lifetime.signal,
      );
      if (!result) throw Error('prompt observation unavailable');
      return result;
    },
    updateQueue(
      context: RequestContext,
      child?: { sessionId: string; parentSessionId: string },
      itemId = 'queue-item',
      action: 'edit' | 'remove' | 'steer' = 'remove',
    ) {
      return observed(
        {
          endpoint: 'session/updateQueue',
          binding,
          adapterId,
          context,
          issue,
          child,
          itemId,
          action,
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

it('in a new Host, selects the persisted B only after a newly adopted steer proves the same native turn', async () => {
  const publication = { root: vi.fn(), call: vi.fn() };
  const build = {
    sourceSha: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    manifestDigest: 'sha256:' + 'c'.repeat(64),
    webBuildId: 'fixture',
  };
  const source = {
    publication,
    toolVersions: { memory_read: 'read-v1', memory_remember: 'remember-v1' },
  };
  const memory = selectNativeMemoryConfiguration(source, build);
  expect(
    selectNativeMemoryConfiguration(source, build).moduleConfigRevisionRef,
  ).toBe(memory.moduleConfigRevisionRef);
  expect(
    selectNativeMemoryConfiguration(
      {
        ...source,
        toolVersions: { ...source.toolVersions, memory_read: 'read-v2' },
      },
      build,
    ).moduleConfigRevisionRef,
  ).not.toBe(memory.moduleConfigRevisionRef);
  const f = await setup(memory);
  const context = login();
  const root = SessionId(issue.root.nativeSessionId);
  const signal = new AbortController().signal;
  const uninstall = installDEntryNativeOwnerPort({
    async resolve() {
      return {
        ...f.profile,
        controlReady: () => true,
        assertCurrent: async () => {},
        acquirePrincipal: () => {
          throw Error('Unexpected scope creation');
        },
        async readSessions() {
          return {
            ok: true,
            value: {
              items: [
                {
                  sessionId: root,
                  updatedAt: 1,
                  blank: false,
                  running: true,
                  agentAvailable: true,
                },
              ],
            },
          };
        },
      };
    },
  });
  try {
    const prior = {
      sessionId: root,
      scopeId: randomUUID(),
      requestId: 'original-prompt',
      messageId: 'original-adoption',
      turn: 1,
    };
    const steer = {
      ...prior,
      scopeId: issue.scopeId,
      requestId: 'steer-request',
      messageId: 'steer-adoption',
    };
    const native = nativeFacts();
    const admission = await f.admit(context, steer.requestId, native, 'steer');
    native.insert(steer.messageId);
    admission.accepted();
    const recipient = 'r'.repeat(43);
    const attempt = {
      kind: 'assistant',
      id: randomUUID(),
      turn: 1,
      sourceTurn: 1,
      cursor: 18,
      recipient,
      rootSessionId: root,
      delegated: false,
      inheritedPromptIndexes: [],
      prompts: [prior, steer],
      observation: {
        proofState: 'adopted',
        firstMemoryAttempt: false,
        memoryToolVersions: source.toolVersions,
        originalHuman: {
          occurrence: prior,
          sequence: 3,
          digest: 'sha256:' + 'a'.repeat(64),
        },
        human: {
          kind: 'adopted-steering',
          occurrence: steer,
          sequence: 14,
          digest: 'sha256:' + 'b'.repeat(64),
        },
      },
    };
    f.readNativeAttemptFor.mockResolvedValue(attempt);
    const resolve = () => {
      const body = Buffer.from(
        JSON.stringify({ ...f.selection, sessionId: root, recipient }),
      );
      const request = Object.assign(Readable.from([body]), {
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
      });
      return f.resolveReference!(
        request as unknown as IncomingMessage,
        binding,
        signal,
      );
    };
    const b = randomUUID();
    mocks.query.mockResolvedValueOnce([{ id: b }]);
    await expect(resolve()).resolves.toMatchObject({ context });
    expect(f.bindReference.mock.lastCall?.[0].execution.runId).toBe(b);
    expect(native.observation.assertClaimed).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      steer,
    );
    expect(mocks.query.mock.lastCall).toContainEqual(
      expect.objectContaining({
        loginSessionId: context.sessionId,
        nativeRequestId: prior.requestId,
      }),
    );
    mocks.query.mockResolvedValueOnce([]);
    await expect(resolve()).rejects.toHaveProperty(
      'code',
      'AUTHORIZATION_DENIED',
    );
    expect(publication.root).not.toHaveBeenCalled();
  } finally {
    uninstall();
    await f.close();
  }
});

it('keeps standalone R2 Search closed for a scoped VM even when the Host configured its provider', async () => {
  const f = await setup(undefined, true, true);
  try {
    const resolve = f.resolveSearch;
    if (!resolve) throw Error('Native Search service unavailable');
    await expect(
      resolve(
        {} as IncomingMessage,
        f.profile.receipt.binding,
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: 'DENIED' });
    expect(f.observeNativeSearchCallFor).not.toHaveBeenCalled();
    expect(f.bindWebSearch).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('binds Search to the exact root occurrence when a child shares its request ID', async () => {
  const f = await setup(undefined, true);
  const context = login();
  const root = SessionId(issue.root.nativeSessionId);
  const child = { sessionId: SessionId('native-child'), parentSessionId: root };
  const revoked = new AbortController().signal;
  const requestId = randomUUID();
  const rootPrompt = nativeFacts();
  const childPrompt = nativeFacts();
  const occurrence = {
    sessionId: root,
    scopeId: issue.scopeId,
    requestId,
    messageId: 'adopted-root',
    turn: 1,
  };
  const uninstall = installDEntryNativeOwnerPort({
    async resolve() {
      return {
        ...f.profile,
        revoked,
        controlReady: () => true,
        assertCurrent: async () => {},
        acquirePrincipal: () => {
          throw Error('Unexpected scope creation');
        },
        async readSessions() {
          const status = {
            updatedAt: 1,
            blank: false,
            running: true,
            agentAvailable: true,
          };
          return {
            ok: true,
            value: {
              items: [
                { ...status, sessionId: root },
                { ...status, ...child, origin: 'subagent' },
              ],
            },
          };
        },
      };
    },
  });
  try {
    const admitRoot = await f.admit(context, requestId, rootPrompt);
    rootPrompt.insert(occurrence.messageId);
    admitRoot.accepted();
    const admitChild = await f.admit(
      context,
      requestId,
      childPrompt,
      'queue',
      child,
    );
    childPrompt.insert('pending-child');
    admitChild.accepted();
    const close = vi.fn(async () => {});
    const proof = { rootSessionId: root, claims: [occurrence] };
    f.observeNativeSearchCallFor.mockResolvedValue({
      proof,
      signal: revoked,
      close,
    });
    const resolve = f.resolveSearch;
    if (!resolve) throw Error('Native Search service unavailable');
    const send = () => {
      const body = Buffer.from(
        JSON.stringify({
          adapterId: f.selection.adapterId,
          sessionId: root,
          query: 'test',
          ticket: randomUUID(),
        }),
      );
      const request = Object.assign(Readable.from([body]), {
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
      });
      return resolve(
        request as unknown as IncomingMessage,
        binding,
        revoked,
        vi.fn(),
      );
    };
    const admitted = await send();
    expect(admitted).toMatchObject({ context });
    const assertCurrent = f.bindWebSearch.mock.lastCall?.[3];
    if (!assertCurrent) throw Error('Search authority unavailable');
    await assertCurrent(revoked);
    expect(rootPrompt.observation.assertClaimed).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      occurrence,
    );
    expect(childPrompt.observation.assertClaimed).not.toHaveBeenCalled();
    await admitted.close?.();

    f.observeNativeSearchCallFor.mockResolvedValue({
      proof: {
        ...proof,
        claims: [{ ...occurrence, messageId: 'different-occurrence' }],
      },
      signal: revoked,
      close,
    });
    await expect(send()).rejects.toHaveProperty('code', 'DENIED');
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    uninstall();
    await f.close();
  }
});

it('binds only adopted child occurrences when pending and steered messages share a request ID', async () => {
  const f = await setup();
  const context = login();
  const root = SessionId(issue.root.nativeSessionId);
  const child = { sessionId: SessionId('native-child'), parentSessionId: root };
  const revoked = new AbortController().signal;
  const uninstall = installDEntryNativeOwnerPort({
    async resolve() {
      return {
        ...f.profile,
        revoked,
        controlReady: () => true,
        assertCurrent: async () => {},
        acquirePrincipal: () => {
          throw Error('Unexpected scope creation');
        },
        async readSessions() {
          const status = {
            updatedAt: 1,
            blank: false,
            running: true,
            agentAvailable: true,
          };
          return {
            ok: true,
            value: {
              items: [
                { ...status, sessionId: root },
                { ...status, ...child, origin: 'subagent' },
              ],
            },
          };
        },
      };
    },
  });
  try {
    const resolve = f.resolveReference;
    if (!resolve) throw Error('Native reference service unavailable');
    const native = nativeFacts();
    const requestId = randomUUID();
    const occurrence = {
      ...child,
      requestId,
      scopeId: issue.scopeId,
      messageId: 'adopted-child-message',
      turn: 1,
    };
    const admission = await f.admit(context, requestId, native, 'queue', child);
    native.insert(occurrence.messageId);
    admission.accepted();
    const pending = nativeFacts();
    const second = { ...occurrence, messageId: 'same-request-pending-message' };
    const waiting = await f.admit(context, requestId, pending, 'queue', child);
    pending.insert(second.messageId);
    waiting.accepted();
    const recipient = 'r'.repeat(43);
    const attempt = {
      kind: 'assistant',
      id: randomUUID(),
      turn: 1,
      sourceTurn: 1,
      cursor: 3,
      recipient,
      rootSessionId: root,
      delegated: true,
      inheritedPromptIndexes: [],
    };
    const resolveReference = () => {
      const body = Buffer.from(
        JSON.stringify({
          ...f.selection,
          sessionId: child.sessionId,
          recipient,
        }),
      );
      const request = Object.assign(Readable.from([body]), {
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
      });
      return resolve(request as unknown as IncomingMessage, binding, revoked);
    };
    f.readNativeAttemptFor.mockResolvedValue({
      ...attempt,
      prompts: [{ ...occurrence, parentSessionId: 'different-parent' }],
    });
    await expect(resolveReference()).rejects.toHaveProperty(
      'code',
      'AUTHORIZATION_DENIED',
    );
    expect(f.bindReference).not.toHaveBeenCalled();
    f.readNativeAttemptFor.mockResolvedValue({
      ...attempt,
      prompts: [occurrence],
    });
    await expect(resolveReference()).resolves.toMatchObject({ context });
    expect(native.observation.assertClaimed).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      occurrence,
    );
    expect(pending.observation.assertClaimed).not.toHaveBeenCalled();
    expect(f.bindReference).toHaveBeenCalledWith(
      expect.objectContaining({
        allriceThreadRef: identity.threadId,
        native: expect.objectContaining({ ...child, rootSessionId: root }),
      }),
      expect.any(AbortSignal),
    );
    await expect(
      f.updateQueue(context, child, second.messageId, 'steer'),
    ).resolves.toBeUndefined();
    await expect(
      f.updateQueue(context, child, 'unknown-message', 'steer'),
    ).rejects.toHaveProperty('code', 'VM_ACTIVE');
    f.readNativeAttemptFor.mockResolvedValue({
      ...attempt,
      prompts: [occurrence, second],
    });
    await expect(resolveReference()).resolves.toMatchObject({ context });
    expect(pending.observation.assertClaimed).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      second,
    );
    // Re-reading the same attempt with the same adopted occurrences retains
    // the original run and attempt record identities.
    const execution = f.bindReference.mock.lastCall?.[0].execution;
    expect(execution).toEqual({
      runId: expect.any(String),
      executionId: expect.any(String),
    });
    await expect(resolveReference()).resolves.toMatchObject({ context });
    expect(f.bindReference.mock.lastCall?.[0].execution).toEqual(execution);
  } finally {
    uninstall();
    await f.close();
  }
});

it('attaches native terminal retry to the current Worker owner', async () => {
  const f = await setup();
  try {
    expect(f.runJournalOwners).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

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
    await expect(f.updateQueue(a)).rejects.toMatchObject({ code: 'VM_ACTIVE' });
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

it('only lets the current queue login mutate the native root while it has pending work', async () => {
  const f = await setup();
  try {
    const a = login(),
      b = login();
    const native = nativeFacts();
    const prompt = await f.admit(a, 'pending', native);
    await expect(f.updateQueue(b)).rejects.toMatchObject({ code: 'VM_ACTIVE' });
    expect(f.readRootWake).not.toHaveBeenCalled();
    native.insert();
    prompt.accepted();
    await expect(f.updateQueue(a)).resolves.toBeUndefined();
    await expect(f.updateQueue(b)).rejects.toMatchObject({ code: 'VM_ACTIVE' });
    expect(f.readRootWake).toHaveBeenCalledOnce();
    native.settle('discarded');
    await native.closed;
    await expect(f.updateQueue(b)).resolves.toBeUndefined();
  } finally {
    await f.close();
  }
});

it('checks for a new cross-login queue occupant after the native wake read', async () => {
  const f = await setup();
  const reading = deferredPromptFact<void>();
  const wake = deferredPromptFact<RootWake>();
  f.readRootWake.mockImplementationOnce(() => {
    reading.resolve();
    return wake.promise;
  });
  try {
    const update = f.updateQueue(login());
    await reading.promise;
    const other = await f.admit(login(), 'pending-during-read', nativeFacts());
    wake.resolve({ kind: 'clear' });
    await expect(update).rejects.toMatchObject({ code: 'VM_ACTIVE' });
    await other.undispatched();
  } finally {
    wake.resolve({ kind: 'clear' });
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
      original.insert('adopted-original');
      admitted.accepted();
      original.settle('ended');
      await Promise.resolve();

      f.readRootWake.mockResolvedValue({
        kind: 'delegated',
        turn: 2,
        prompts: [
          {
            sessionId: issue.root.nativeSessionId,
            scopeId: issue.scopeId,
            requestId: 'original',
            messageId: 'adopted-original',
            turn: 1,
          },
        ],
      });
      const otherSteer = nativeFacts();
      await expect(
        f.admit(b, 'foreign', otherSteer, 'steer'),
      ).rejects.toMatchObject({
        code: 'VM_ACTIVE',
      });
      expect(otherSteer.observation.close).toHaveBeenCalledOnce();
      await expect(f.updateQueue(b)).rejects.toMatchObject({
        code: 'VM_ACTIVE',
      });
      await expect(f.updateQueue(a)).resolves.toBeUndefined();
      await (
        await f.admit(a, 'same-login', nativeFacts(), 'steer')
      ).undispatched();
      expect(original.observation.assertClaimed).toHaveBeenCalledTimes(2);
      expect(original.observation.assertClaimed).toHaveBeenCalledWith(
        expect.any(AbortSignal),
        {
          sessionId: issue.root.nativeSessionId,
          scopeId: issue.scopeId,
          requestId: 'original',
          messageId: 'adopted-original',
          turn: 1,
        },
      );

      f.readRootWake.mockResolvedValue({ kind: 'unproven' });
      await expect(
        f.admit(b, 'unknown', nativeFacts(), 'steer'),
      ).rejects.toMatchObject({
        code: 'VM_ACTIVE',
      });
      await expect(f.updateQueue(b)).rejects.toMatchObject({
        code: 'VM_ACTIVE',
      });
      f.readRootWake.mockResolvedValue({ kind: 'clear' });
      await expect(f.updateQueue(b)).resolves.toBeUndefined();
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
