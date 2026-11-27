import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import type * as Database from '@allrice/database';
import { DataAccessError } from '@allrice/database';
import type { NativeWebOwner } from '../native-web/owner.js';
import { SessionId } from '@deepseek-ai/dsh-session';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import {
  hostFixture,
  issue as principalIssue,
} from '../../../../packages/d-entry-principal/test/host-fixture.js';
import { createDEntryPrincipalControl } from '../d-entry/principal-control.js';
import { ownDEntryCatalog } from '../d-entry/native-data.js';
import {
  DEntryNativeUnavailable,
  dEntryNativeOwnerPort,
} from '../d-entry/native-owner.js';
import {
  deferred,
  nativeEntryFixture,
  nativeEntryServer,
} from '../d-entry/native-entry.fixture.js';
import {
  createDEntryNativeCatalogPort,
  installAssignedDEntryNativeCatalog,
  type PublishedNativeCatalog,
} from './native-catalog.js';

const authority = vi.hoisted(() => ({ identity: vi.fn(), roster: vi.fn() }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  requireDEntryNativeIdentity: authority.identity,
  readPersonNativeWebRoster: authority.roster,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.resetAllMocks();
});
function fixture() {
  // Consumer doubles only; no real Session, VM, startup or production installation.
  const base = nativeEntryFixture(),
    lifetime = new AbortController();
  const native = {
    binding: base.binding,
    revoked: base.revoked.signal,
    controlReady: vi.fn(() => true),
    acquirePrincipal: vi.fn<NativeWebOwner['acquirePrincipal']>(() => {
      throw new DEntryNativeUnavailable();
    }),
    readSessions: vi.fn<NativeWebOwner['readSessions']>(async () => ({
      ok: true as const,
      value: base.catalog,
    })),
    readSessionsFor: vi.fn<NativeWebOwner['readSessionsFor']>(async () => ({
      ok: true as const,
      value: base.catalog,
    })),
    readImmutableGraphFor: vi.fn<NativeWebOwner['readImmutableGraphFor']>(
      async () => {
        throw new DEntryNativeUnavailable();
      },
    ),
    readImmutableBundleFor: vi.fn<NativeWebOwner['readImmutableBundleFor']>(
      async () => {
        throw new DEntryNativeUnavailable();
      },
    ),
    readModelCatalogFor: vi.fn<NativeWebOwner['readModelCatalogFor']>(
      async () => {
        throw new DEntryNativeUnavailable();
      },
    ),
    retireAfterJobExit: vi.fn(() => undefined),
    retireAfterNativeStop: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const group = new AbortController();
  let publication: PublishedNativeCatalog = Object.freeze({
    receipt: base.owner.receipt,
    endpoint: base.endpoint,
    bindingRef: base.owner.bindingRef,
    revoked: group.signal,
    owner: native,
  });
  const vm = {
    resolve: vi.fn(async () => base.binding),
    assertCurrentBinding: vi.fn(async () => {}),
  };
  const host = {
    vm,
    catalog: vi.fn(() => publication),
  };
  authority.identity.mockResolvedValue(base.identity);
  const assembly = createDEntryNativeCatalogPort({
    host,
    lifetime: lifetime.signal,
  });
  cleanups.push(assembly.close);
  return {
    base,
    native,
    vm,
    host,
    assembly,
    lifetime,
    group,
    publication: () => publication,
    replace(next: PublishedNativeCatalog) {
      publication = next;
    },
    resolve: () =>
      assembly.port.resolve(
        base.context,
        base.identity,
        new AbortController().signal,
      ),
  };
}

it('uses each current Session RC, selected employee authority and exact original publication before and after Session/list', async () => {
  const f = fixture(),
    owner = await f.resolve();
  expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  expect(f.vm.resolve).toHaveBeenCalledWith(
    f.base.context,
    expect.any(AbortSignal),
  );
  const current: RequestContext = {
    ...f.base.context,
    requestId: randomUUID(),
    sessionId: randomUUID(),
  };
  authority.identity.mockClear();
  await owner.assertCurrent(current, new AbortController().signal);
  expect(await owner.readSessions(new AbortController().signal)).toEqual({
    ok: true,
    value: f.base.catalog,
  });
  expect(f.native.readSessionsFor).toHaveBeenCalledExactlyOnceWith(
    current,
    expect.any(AbortSignal),
    undefined,
  );
  expect(f.native.readSessions).not.toHaveBeenCalled();
  expect(
    authority.identity.mock.calls.every(([context]) => context === current),
  ).toBe(true);
  expect(f.vm.assertCurrentBinding).toHaveBeenLastCalledWith(
    current,
    f.base.binding,
    expect.any(AbortSignal),
  );
  expect(f.native.close).not.toHaveBeenCalled();
  expect(owner).not.toHaveProperty('rpc');
  expect(owner).not.toHaveProperty('history');
});

it('denies a stale request before I/O and permits a later valid current RC without revoking the shared owner', async () => {
  const f = fixture(),
    owner = await f.resolve();
  authority.identity.mockRejectedValueOnce(
    new DataAccessError('authorization_denied'),
  );
  await expect(
    owner.readSessions(new AbortController().signal),
  ).rejects.toMatchObject({ code: 'authorization_denied' });
  expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  expect(owner.revoked.aborted).toBe(false);
  await expect(
    owner.readSessions(new AbortController().signal),
  ).resolves.toMatchObject({ ok: true });
  expect(f.native.readSessionsFor).toHaveBeenCalledTimes(1);
  expect(f.native.close).not.toHaveBeenCalled();
});

it('keeps the established owner when another employee is added', async () => {
  const f = fixture();
  const owner = await f.resolve();
  authority.roster.mockRejectedValue(
    Error('unrelated assignment not yet materialized'),
  );
  await expect(
    owner.readSessions(new AbortController().signal),
  ).resolves.toMatchObject({ ok: true });
  expect(owner.revoked.aborted).toBe(false);
  expect(f.native.close).not.toHaveBeenCalled();
});

it.each([
  'person',
  'organization',
  'missing-entry',
  'binding',
  'endpoint',
] as const)(
  'rejects current %s drift before any native read',
  async (change) => {
    const f = fixture(),
      owner = await f.resolve();
    if (change === 'person')
      authority.identity.mockResolvedValue({
        ...f.base.identity,
        personId: randomUUID(),
      });
    if (change === 'organization')
      authority.identity.mockResolvedValue({
        ...f.base.identity,
        organizationId: randomUUID(),
      });
    if (change === 'missing-entry')
      authority.identity.mockRejectedValue(
        new DataAccessError('authorization_denied'),
      );
    if (change === 'binding')
      f.replace({
        ...f.publication(),
        receipt: {
          ...f.publication().receipt,
          binding: { ...f.base.binding, leaseEpoch: 2 },
        },
      });
    if (change === 'endpoint')
      f.replace({
        ...f.publication(),
        endpoint: { ...f.base.endpoint, hostPort: 54321 },
      });
    await expect(
      owner.readSessions(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  },
);

it.each(['receipt', 'endpoint', 'ref', 'owner'] as const)(
  'does not rebind a resolved handle to a replacement %s',
  async (change) => {
    const f = fixture(),
      owner = await f.resolve(),
      original = f.publication();
    f.replace({
      ...original,
      ...(change === 'receipt' ? { receipt: { ...original.receipt } } : {}),
      ...(change === 'endpoint' ? { endpoint: { ...original.endpoint } } : {}),
      ...(change === 'ref' ? { bindingRef: 'new-host-group-ref' } : {}),
      ...(change === 'owner' ? { owner: { ...f.native } } : {}),
    });
    await expect(
      owner.readSessions(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  },
);

it('drops a result when current authority changes during I/O, after its actual read settles', async () => {
  const f = fixture(),
    owner = await f.resolve(),
    entered = deferred<void>(),
    joined = deferred<void>();
  f.native.readSessionsFor.mockImplementationOnce(async () => {
    entered.resolve();
    await joined.promise;
    return { ok: true, value: f.base.catalog };
  });
  let ended = false;
  const reading = owner
    .readSessions(new AbortController().signal)
    .catch((error: unknown) => error)
    .finally(() => {
      ended = true;
    });
  try {
    await entered.promise;
    authority.identity.mockResolvedValue({
      ...f.base.identity,
      employeeRevision: 2,
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(ended).toBe(false);
  } finally {
    joined.resolve();
  }
  expect(await reading).toMatchObject({ code: 'authorization_denied' });
  expect(f.native.readSessionsFor).toHaveBeenCalledTimes(1);
  expect(f.native.close).not.toHaveBeenCalled();
});

it('close cancels new admission but waits for the actual readonly SQL guard', async () => {
  const f = fixture(),
    entered = deferred<void>(),
    joined = deferred<void>(),
    caller = new AbortController();
  authority.identity.mockImplementationOnce(async () => {
    entered.resolve();
    await joined.promise;
    return f.base.identity;
  });
  const resolving = f.assembly.port
    .resolve(f.base.context, f.base.identity, caller.signal)
    .catch((error: unknown) => error);
  await entered.promise;
  caller.abort();
  let ended = false;
  const closing = f.assembly.close().then(() => {
    ended = true;
  });
  try {
    await new Promise<void>((done) => setImmediate(done));
    expect(ended).toBe(false);
    await expect(f.resolve()).rejects.toBeInstanceOf(DEntryNativeUnavailable);
    expect(f.host.catalog).not.toHaveBeenCalled();
  } finally {
    joined.resolve();
  }
  expect(await resolving).toBeDefined();
  await closing;
  expect(f.native.readSessionsFor).not.toHaveBeenCalled();
});

it('close joins a native read that ignores cancellation, without closing the shared native owner', async () => {
  const f = fixture(),
    owner = await f.resolve(),
    entered = deferred<void>(),
    joined = deferred<void>();
  f.native.readSessionsFor.mockImplementationOnce(async () => {
    entered.resolve();
    await joined.promise;
    return { ok: true, value: f.base.catalog };
  });
  const reading = owner
    .readSessions(new AbortController().signal)
    .catch((error: unknown) => error);
  await entered.promise;
  let ended = false;
  const closing = f.assembly.close().then(() => {
    ended = true;
  });
  try {
    await new Promise<void>((done) => setImmediate(done));
    expect(owner.revoked.aborted).toBe(true);
    expect(ended).toBe(false);
    expect(f.native.close).not.toHaveBeenCalled();
  } finally {
    joined.resolve();
  }
  expect(await reading).toBeInstanceOf(DEntryNativeUnavailable);
  await closing;
});

it.each(['group', 'native'] as const)(
  'actual %s revocation invalidates the issued handle before I/O',
  async (source) => {
    const f = fixture(),
      owner = await f.resolve();
    (source === 'group' ? f.group : f.base.revoked).abort();
    expect(owner.revoked.aborted).toBe(true);
    expect(owner.controlReady()).toBe(false);
    await expect(
      owner.readSessions(new AbortController().signal),
    ).rejects.toBeDefined();
    expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  },
);

it('joins an interrupted current employee read without marking an undispatched catalog request unknown', async () => {
  const f = fixture();
  const owner = await f.resolve();
  const controller = new AbortController();
  const catalog = ownDEntryCatalog(owner, controller.signal);
  const entered = deferred<void>();
  const release = deferred<void>();
  authority.identity.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return f.base.identity;
  });
  const read = catalog.owner.readSessions(new AbortController().signal);
  const result = read.catch((error: unknown) => error);
  await entered.promise;
  controller.abort();
  const closing = catalog.close();
  release.resolve();
  expect(await result).toBe(controller.signal.reason);
  await expect(closing).resolves.toBeUndefined();
  expect(f.native.readSessionsFor).not.toHaveBeenCalled();
});

it('the concrete installer binds real readonly producer calls; catalog installation still leaves root/RPC/resource closed', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  expect(() =>
    dEntryNativeOwnerPort.resolve(f.base.context, f.base.identity, signal),
  ).toThrow(DEntryNativeUnavailable);
  const startup = {
    catalog: vi.fn(() => ({ ...f.publication(), owner: f.native })),
  };
  const installed = installAssignedDEntryNativeCatalog({
    vm: f.vm,
    startup,
    lifetime: f.lifetime.signal,
  });
  cleanups.push(installed.close);
  const server = await nativeEntryServer(f.base, {
    ...f.base.deps,
    owners: dEntryNativeOwnerPort,
    data: () => undefined,
  });
  cleanups.push(server.close);
  expect((await server.request()).status).toBe(200);
  expect(authority.roster).not.toHaveBeenCalled();
  expect(startup.catalog).toHaveBeenCalledWith(
    f.base.binding,
    f.base.identity.employeeInstanceId,
  );
  expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  const prompt = {
    ...f.base.body,
    endpoint: 'session/prompt',
    payload: {
      args: {
        request: {
          requestId: 'catalog-cannot-send',
          sessionId: 'dsh-root',
          mode: 'queue',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    },
  };
  for (const [path, body] of [
    ['native-root', f.base.body],
    ['native-rpc', prompt],
    ['native-resource', { ...f.base.body, nativeSessionId: 'dsh-child' }],
  ] as const)
    expect((await server.request(path, body)).status).toBe(503);
  expect(f.base.data.acquireRoot).not.toHaveBeenCalled();
  expect(f.base.data.acquireRpc).not.toHaveBeenCalled();
  expect(f.base.owner.readSessions).not.toHaveBeenCalled();
  expect(f.native.readSessionsFor).not.toHaveBeenCalled();
  await installed.close();
  expect(() =>
    dEntryNativeOwnerPort.resolve(f.base.context, f.base.identity, signal),
  ).toThrow(DEntryNativeUnavailable);
});

it('lifetime abort uninstalls synchronously and revokes previously issued discovery without substituting another Host', async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  const installed = installAssignedDEntryNativeCatalog({
    vm: f.vm,
    startup: { catalog: () => ({ ...f.publication(), owner: f.native }) },
    lifetime: f.lifetime.signal,
  });
  cleanups.push(installed.close);
  const owner = await dEntryNativeOwnerPort.resolve(
    f.base.context,
    f.base.identity,
    signal,
  );
  f.lifetime.abort();
  expect(owner.revoked.aborted).toBe(true);
  expect(() =>
    dEntryNativeOwnerPort.resolve(f.base.context, f.base.identity, signal),
  ).toThrow(DEntryNativeUnavailable);
  expect(f.native.close).not.toHaveBeenCalled();
});

it('the installed lifetime observes a real control child unknown without changing the explicit close rejection', async () => {
  const f = fixture(),
    selected = { ...principalIssue(), identity: f.base.identity },
    native = await hostFixture(selected),
    control = createDEntryPrincipalControl(native.node, {
      carrier: new AbortController().signal,
      cleanupTimeoutMs: 1000,
    });
  f.native.acquirePrincipal.mockImplementation((issue, signal) =>
    control.acquire(issue, signal),
  );
  const installed = installAssignedDEntryNativeCatalog({
    vm: f.vm,
    startup: { catalog: () => ({ ...f.publication(), owner: f.native }) },
    lifetime: f.lifetime.signal,
  });
  cleanups.push(async () => {
    try {
      // The explicit unknown is asserted below; teardown still drains the real resources.
      await Promise.allSettled([installed.close(), control.drainLocal()]);
    } finally {
      await native.close();
    }
  });
  const owner = await dEntryNativeOwnerPort.resolve(
    f.base.context,
    f.base.identity,
    new AbortController().signal,
  );
  const activity = owner.acquirePrincipal(
    f.base.context,
    selected,
    new AbortController().signal,
  );
  const scope = await activity.run(new AbortController().signal);
  const failure = new RemoteError(
    'subagent/catalog-diagnostic',
    'installed lifetime native follow failure',
    {
      parentSessionId: SessionId('root'),
      childSessionId: SessionId('child'),
      reason: 'unavailable',
    },
  );
  native.catalog.beforeFollow = async () => {
    throw failure;
  };
  const follow = scope.stream(
    {
      scopeId: selected.scopeId,
      endpoint: 'session/follow',
      args: {
        request: {
          address: { kind: 'session', sessionId: SessionId('root') },
        },
      },
    },
    new AbortController().signal,
  );
  const stream = follow[Symbol.asyncIterator]();
  await expect(stream.next()).rejects.toMatchObject({
    code: failure.code,
    message: failure.message,
    details: failure.details,
  });
  const unhandled: unknown[] = [];
  const observe = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', observe);
  try {
    f.lifetime.abort(); // Exercise the installer callback, with no close handler attached by this test yet.
    expect(owner.revoked.aborted).toBe(true);
    expect(() =>
      dEntryNativeOwnerPort.resolve(
        f.base.context,
        f.base.identity,
        new AbortController().signal,
      ),
    ).toThrow(DEntryNativeUnavailable);
    await new Promise<void>((done) => setImmediate(done));
    expect(unhandled).toEqual([]);
    const closing = installed.close();
    expect(installed.close()).toBe(closing);
    await expect(closing).rejects.toThrow('PRINCIPAL_CHILD_JOIN_UNKNOWN');
    const original = await closing.catch((error: unknown) => error);
    await expect(installed.close()).rejects.toBe(original);
    expect(f.native.close).not.toHaveBeenCalled();
  } finally {
    process.removeListener('unhandledRejection', observe);
    await Promise.allSettled([installed.close(), control.drainLocal()]);
  }
});

async function actualPrincipal(f: ReturnType<typeof fixture>) {
  // Use the formal public rc.2 Host/Peer/codec/control fixture, never a resolved helper scope.
  const selected = { ...principalIssue(), identity: f.base.identity };
  const native = await hostFixture(selected);
  cleanups.push(native.close);
  const control = createDEntryPrincipalControl(native.node, {
    carrier: new AbortController().signal,
    cleanupTimeoutMs: 1000,
  });
  cleanups.push(() => control.close());
  f.native.acquirePrincipal.mockImplementation((issue, signal) =>
    control.acquire(issue, signal),
  );
  return { selected, native, control };
}

it('真实catalog+request两层先登记惰性child，同原现权前后复核；request close只join本页，另一页仍可读', async () => {
  const f = fixture(),
    real = await actualPrincipal(f),
    owner = await f.resolve();
  const first = ownDEntryCatalog(owner, new AbortController().signal);
  const second = ownDEntryCatalog(owner, new AbortController().signal);
  cleanups.push(second.close, first.close);
  const otherIssue = { ...real.selected, scopeId: randomUUID() };
  const one = first.owner.acquirePrincipal(
    f.base.context,
    real.selected,
    new AbortController().signal,
  );
  const two = second.owner.acquirePrincipal(
    f.base.context,
    otherIssue,
    new AbortController().signal,
  );
  const list = vi.spyOn(real.native.catalog, 'list');
  expect(list).not.toHaveBeenCalled();
  const oneScope = await one.run(new AbortController().signal),
    twoScope = await two.run(new AbortController().signal);
  expect(oneScope.opened.baseline.owner).toBe(false);
  expect(twoScope.opened.baseline.owner).toBe(false);
  await first.close();
  expect(oneScope.revoked.aborted).toBe(true);
  expect(twoScope.revoked.aborted).toBe(false);
  await expect(one.run(new AbortController().signal)).rejects.toThrow(
    'PRINCIPAL_SCOPE_CLOSED',
  );
  expect(
    await twoScope.invoke(
      {
        scopeId: otherIssue.scopeId,
        endpoint: 'session/page',
        args: {
          request: {
            address: { kind: 'session', sessionId: SessionId('root') },
            throughSeq: 0,
          },
        },
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ endpoint: 'session/page' });
  expect(f.native.close).not.toHaveBeenCalled();
  expect(f.native.retireAfterNativeStop).not.toHaveBeenCalled();
  await second.close();
});

it('两层消费正式I1：request close等待真实session/follow setup read，禁止late follow/item且不毒另一页', async () => {
  const f = fixture(),
    real = await actualPrincipal(f),
    owner = await f.resolve();
  const first = ownDEntryCatalog(owner, new AbortController().signal),
    second = ownDEntryCatalog(owner, new AbortController().signal);
  cleanups.push(second.close, first.close);
  const otherIssue = { ...real.selected, scopeId: randomUUID() };
  const one = first.owner.acquirePrincipal(
    f.base.context,
    real.selected,
    new AbortController().signal,
  );
  const two = second.owner.acquirePrincipal(
    f.base.context,
    otherIssue,
    new AbortController().signal,
  );
  const oneScope = await one.run(new AbortController().signal),
    twoScope = await two.run(new AbortController().signal);
  const entered = deferred<void>(),
    release = deferred<void>();
  cleanups.push(async () => {
    release.resolve();
  });
  let readJoined = false;
  real.native.catalog.beforeList = async () => {
    entered.resolve();
    await release.promise;
    readJoined = true;
  };
  const streamSource = oneScope.stream(
    {
      scopeId: real.selected.scopeId,
      endpoint: 'session/follow',
      args: {
        request: {
          address: { kind: 'session', sessionId: SessionId('root') },
        },
      },
    },
    new AbortController().signal,
  );
  const stream = streamSource[Symbol.asyncIterator]();
  const pending = stream.next();
  void pending.catch(() => {});
  await entered.promise;
  let closed = false;
  const closing = first.close().then(() => {
    closed = true;
  });
  void closing.catch(() => {});
  await new Promise<void>((done) => setImmediate(done));
  expect(readJoined).toBe(false);
  expect(closed).toBe(false);
  expect(real.native.catalog.follows).toHaveLength(0);
  release.resolve();
  await closing;
  await expect(pending).rejects.toBeDefined();
  expect(readJoined).toBe(true);
  expect(real.native.catalog.follows).toHaveLength(0);
  real.native.catalog.beforeList = undefined;
  expect(twoScope.revoked.aborted).toBe(false);
  expect(
    await twoScope.invoke(
      {
        scopeId: otherIssue.scopeId,
        endpoint: 'session/page',
        args: {
          request: {
            address: { kind: 'session', sessionId: SessionId('root') },
            throughSeq: 0,
          },
        },
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ endpoint: 'session/page' });
  expect(f.native.close).not.toHaveBeenCalled();
});

it('两层消费正式I3：post-open原现权自拒绝主动关闭真实child，保原错误，另一活动可继续且无shared close', async () => {
  const f = fixture(),
    real = await actualPrincipal(f),
    owner = await f.resolve();
  const first = ownDEntryCatalog(owner, new AbortController().signal),
    second = ownDEntryCatalog(owner, new AbortController().signal);
  cleanups.push(second.close, first.close);
  const otherIssue = { ...real.selected, scopeId: randomUUID() };
  const other = second.owner.acquirePrincipal(
    f.base.context,
    otherIssue,
    new AbortController().signal,
  );
  const otherScope = await other.run(new AbortController().signal);
  const denied = new DataAccessError('authorization_denied');
  let checks = 0;
  authority.identity.mockImplementation(async () => {
    if (++checks === 3) throw denied; // request-pre, catalog-pre, then catalog-post after actual opened.
    return f.base.identity;
  });
  const original = f.native.acquirePrincipal.getMockImplementation();
  if (!original)
    throw Error('actual principal acquisition not installed in test');
  let joined: Promise<void> | undefined;
  f.native.acquirePrincipal.mockImplementation((issue, signal) => {
    const child = original(issue, signal),
      run = child.run.bind(child),
      close = child.close.bind(child);
    vi.spyOn(child, 'run').mockImplementation(async (active) => {
      const scope = await run(active);
      await scope.invoke(
        {
          scopeId: issue.scopeId,
          endpoint: 'session/page',
          args: {
            request: {
              address: { kind: 'session', sessionId: SessionId('root') },
              throughSeq: 0,
            },
          },
        },
        active,
      );
      return scope;
    });
    vi.spyOn(child, 'close').mockImplementation(() => (joined = close()));
    return child;
  });
  const activity = first.owner.acquirePrincipal(
    f.base.context,
    real.selected,
    new AbortController().signal,
  );
  await expect(activity.run(new AbortController().signal)).rejects.toBe(denied);
  await first.close();
  expect(joined).toBeDefined();
  await joined;
  expect(real.native.catalog.pages[0]?.signal.aborted).toBe(true);
  expect(f.native.close).not.toHaveBeenCalled();
  expect(otherScope.revoked.aborted).toBe(false);
  expect(
    await otherScope.invoke(
      {
        scopeId: otherIssue.scopeId,
        endpoint: 'session/page',
        args: {
          request: {
            address: { kind: 'session', sessionId: SessionId('root') },
            throughSeq: 0,
          },
        },
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ endpoint: 'session/page' });
});
