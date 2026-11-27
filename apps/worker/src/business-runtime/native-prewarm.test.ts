import { randomUUID } from 'node:crypto';
import type { CurrentSelectionPrewarm } from '../person-vm/production-prewarm.js';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { DataAccessError } from '@allrice/database';
import { PersonVmError } from '@allrice/person-vm';
import { harness } from '../../../../packages/person-vm/src/test-support.ts';
import {
  deferred,
  nativeEntryFixture,
  nativeEntryServer,
} from '../d-entry/native-entry.fixture.js';
import {
  dEntryNativePrewarmPort,
  installDEntryNativePrewarmPort,
} from '../d-entry/native-prewarm.js';
import { installDEntryNativeDataPort } from '../d-entry/native-data.js';
import {
  dEntryNativeOwnerPort,
  DEntryNativeUnavailable,
} from '../d-entry/native-owner.js';
import {
  createDEntryNativePrewarmPort,
  installAssignedDEntryNativeRuntime,
  installDEntryNativePrewarm,
} from './native-prewarm.js';

const authority = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  requireDEntryNativeIdentity: authority.identity,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
function fixture(coordinated = false) {
  // Actual lifecycle service with synthetic disk/native/runtime providers only.
  // No production installation, Host process, VM or performance claim.
  const base = nativeEntryFixture(),
    h = harness(),
    lifetime = new AbortController(),
    runPrewarm = h.service.prewarm.bind(h.service),
    runStart = h.runtime.start.bind(h.runtime),
    vm = vi.spyOn(h.service, 'prewarm'),
    start = vi.spyOn(h.runtime, 'start'),
    stop = vi.spyOn(h.native, 'stop');
  authority.identity.mockResolvedValue(base.identity);
  // Explicit fixture adapter; production must use the shared H1 authority owner.
  const prewarmCurrent: CurrentSelectionPrewarm = (...args) =>
    h.service.prewarm(args[0], args[2], args[3]);
  const readCoordination = vi.fn(async () => ({
    authorityRevision: 'release-1',
    vm: await h.store.read(base.identity.personId),
  }));
  const assembly = createDEntryNativePrewarmPort({
    prewarmCurrent,
    lifetime: lifetime.signal,
    ...(coordinated && { readCoordination }),
  });
  cleanups.push(assembly.close);
  return {
    base,
    h,
    lifetime,
    runPrewarm,
    runStart,
    vm,
    start,
    stop,
    assembly,
    prewarmCurrent,
    readCoordination,
  };
}
const signal = () => new AbortController().signal;

it('page then input uses each current RC and the same running VM without another runtime start', async () => {
  const f = fixture(),
    current = {
      ...f.base.context,
      requestId: randomUUID(),
      sessionId: randomUUID(),
    };
  await f.assembly.port.prewarm(
    f.base.context,
    f.base.identity,
    'page',
    signal(),
    f.lifetime.signal,
  );
  const first = await f.h.service.resolve(f.base.context, signal());
  await f.assembly.port.prewarm(
    current,
    f.base.identity,
    'input',
    signal(),
    f.lifetime.signal,
  );
  expect(await f.h.service.resolve(current, signal())).toEqual(first);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.h.log.filter((item) => item === 'native:create')).toHaveLength(1);
  expect(authority.identity.mock.calls.map(([context]) => context)).toEqual([
    f.base.context,
    f.base.context,
    current,
    current,
  ]);
  expect(f.vm.mock.calls.map(([, input]) => input)).toEqual([
    { trigger: 'page' },
    { trigger: 'input' },
  ]);
  expect(f.stop).not.toHaveBeenCalled();
});

it('requires proof for this employee before acknowledging prewarm on a running VM', async () => {
  const f = fixture();
  const assertEditorReady = vi.fn(async () => {
    throw new DEntryNativeUnavailable();
  });
  const inputs = [
    f.base.context,
    f.base.identity,
    'page',
    signal(),
    f.lifetime.signal,
  ] as const;
  await f.assembly.port.prewarm(...inputs);
  const uninstall = installDEntryNativeDataPort({
    ...f.base.data,
    assertEditorReady,
  });
  try {
    await expect(f.assembly.port.prewarm(...inputs)).rejects.toBeInstanceOf(
      DEntryNativeUnavailable,
    );
    expect(assertEditorReady).toHaveBeenCalledWith(
      f.base.context,
      f.base.identity,
      expect.any(AbortSignal),
    );
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.stop).not.toHaveBeenCalled();
  } finally {
    uninstall();
  }
});

it('production prewarm requires the data owner and establishes the running route before lifecycle reuse', async () => {
  const f = fixture();
  const route = new AbortController();
  const proof = vi.fn(async () => route.signal);
  const prewarmCurrent = vi.fn<CurrentSelectionPrewarm>((...args) => {
    expect(proof).toHaveBeenCalledTimes(1);
    return f.prewarmCurrent(...args);
  });
  const production = createDEntryNativePrewarmPort({
    prewarmCurrent,
    lifetime: f.lifetime.signal,
    requireEditorProof: true,
  });
  cleanups.push(production.close);
  const args = [
    f.base.context,
    f.base.identity,
    'page',
    signal(),
    f.lifetime.signal,
  ] as const;
  await expect(production.port.prewarm(...args)).rejects.toBeInstanceOf(
    DEntryNativeUnavailable,
  );
  expect(prewarmCurrent).not.toHaveBeenCalled();
  const uninstall = installDEntryNativeDataPort({
    ...f.base.data,
    assertEditorReady: proof,
  });
  try {
    await expect(production.port.prewarm(...args)).resolves.toBe(route.signal);
    expect(proof).toHaveBeenCalledTimes(2);
  } finally {
    uninstall();
  }
});

it('does not dispatch cold prewarm if the caller disconnects while verifying the current Host', async () => {
  const f = fixture();
  const caller = new AbortController();
  const entered = deferred<void>();
  const release = deferred<void>();
  const prewarmCurrent = vi.fn(f.prewarmCurrent);
  const production = createDEntryNativePrewarmPort({
    prewarmCurrent,
    lifetime: f.lifetime.signal,
    requireEditorProof: true,
  });
  cleanups.push(production.close);
  const uninstall = installDEntryNativeDataPort({
    ...f.base.data,
    async assertEditorReady() {
      entered.resolve();
      await release.promise;
      throw new PersonVmError('NOT_FOUND');
    },
  });
  try {
    const result = production.port
      .prewarm(
        f.base.context,
        f.base.identity,
        'page',
        caller.signal,
        f.lifetime.signal,
      )
      .catch((error: unknown) => error);
    await entered.promise;
    caller.abort();
    release.resolve();
    expect(await result).toBe(caller.signal.reason);
    expect(prewarmCurrent).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    uninstall();
  }
});

it('concurrent page/input cannot acquire a second lifecycle owner, and later valid input reuses the completed epoch', async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    f.assembly.port.prewarm(
      f.base.context,
      f.base.identity,
      'page',
      signal(),
      f.lifetime.signal,
    ),
    f.assembly.port.prewarm(
      f.base.context,
      f.base.identity,
      'input',
      signal(),
      f.lifetime.signal,
    ),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toEqual([
    expect.objectContaining({
      reason: expect.objectContaining({ code: 'LEASE_CONFLICT' }),
    }),
  ]);
  await f.assembly.port.prewarm(
    f.base.context,
    f.base.identity,
    'input',
    signal(),
    f.lifetime.signal,
  );
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.h.log.filter((item) => item === 'native:create')).toHaveLength(1);
  expect(f.stop).not.toHaveBeenCalled();
});

it.each(['completes', 'disconnects', 'loses authority'])(
  'joins the published starting epoch and proves each waiting request when the leader %s',
  async (leaderOutcome) => {
    const f = fixture(true);
    const entered = deferred<void>();
    const release = deferred<void>();
    const caller = new AbortController(),
      revoked = new AbortController();
    const cancelled = leaderOutcome === 'disconnects' ? caller : revoked;
    const follower = { ...f.base.context, requestId: randomUUID() };
    const prove = vi.fn(async (context: typeof f.base.context) => {
      expect(context.sessionId).toBe(f.base.context.sessionId);
      return signal();
    });
    cleanups.push(async () => release.resolve());
    const uninstall = installDEntryNativeDataPort({
      ...f.base.data,
      assertEditorReady: prove,
    });
    cleanups.push(async () => uninstall());
    f.start.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return f.runStart(...args);
    });
    const first = f.assembly.port.prewarm(
      f.base.context,
      f.base.identity,
      'page',
      caller.signal,
      revoked.signal,
    );
    const outcomes = Promise.allSettled([first]);
    await entered.promise;
    let second: Promise<AbortSignal | void> | undefined;
    try {
      expect(await f.h.store.read(f.base.identity.personId)).toMatchObject({
        phase: 'starting',
        leaseEpoch: 1,
      });
      second = f.assembly.port.prewarm(
        follower,
        f.base.identity,
        'input',
        signal(),
        signal(),
      );
      void second.catch(() => {});
      await vi.waitFor(() =>
        expect(f.readCoordination).toHaveBeenCalledTimes(2),
      );
      await f.readCoordination.mock.results[1]!.value;
      expect(f.vm).toHaveBeenCalledTimes(1);
      if (leaderOutcome !== 'completes') cancelled.abort(Error(leaderOutcome));
      expect(f.vm.mock.calls[0]![2].aborted).toBe(false);
    } finally {
      release.resolve();
      await outcomes;
      await second?.catch(() => {});
    }
    await expect(second).resolves.toBeInstanceOf(AbortSignal);
    if (leaderOutcome === 'completes') {
      expect(await first).toBeInstanceOf(AbortSignal);
      expect(await first).not.toBe(await second);
    } else await expect(first).rejects.toBe(cancelled.signal.reason);
    expect(f.vm).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
    const provedRequests = prove.mock.calls
      .map(([context]) => context.requestId)
      .sort();
    const expectedRequests =
      leaderOutcome === 'completes'
        ? [f.base.context.requestId, follower.requestId]
        : [follower.requestId];
    expect(provedRequests).toEqual(expectedRequests.sort());
    expect(f.stop).not.toHaveBeenCalled();
  },
);

it.each(['login', 'employee'])(
  'does not reuse completed prewarm work or share in-flight work across a different %s',
  async (difference) => {
    const f = fixture(true);
    const started = deferred<void>();
    const release = deferred<void>();
    f.vm.mockImplementationOnce(async (...args) => {
      started.resolve();
      await release.promise;
      return f.runPrewarm(...args);
    });
    authority.identity.mockImplementation(async (_context, selection) => ({
      ...f.base.identity,
      employeeInstanceId: selection.employeeInstanceId,
    }));
    const run = (context = f.base.context, identity = f.base.identity) =>
      f.assembly.port.prewarm(context, identity, 'page', signal(), signal());
    const first = run();
    void first.catch(() => {});
    await started.promise;
    try {
      const context = { ...f.base.context, requestId: randomUUID() };
      if (difference === 'login')
        await run({ ...context, sessionId: randomUUID() });
      else
        await run(context, {
          ...f.base.identity,
          employeeInstanceId: randomUUID(),
        });
      expect(f.vm).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await first;
    }
    await run();
    expect(f.vm).toHaveBeenCalledTimes(3);
    expect(f.start).toHaveBeenCalledTimes(1);
  },
);

it('requalifies a waiter through the existing lease after the shared authority version changes', async () => {
  const f = fixture(true);
  const entered = deferred<void>();
  const release = deferred<void>();
  let authorityRevision = 'grant-1';
  f.readCoordination.mockImplementation(async () => ({
    authorityRevision,
    vm: await f.h.store.read(f.base.identity.personId),
  }));
  f.vm.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return f.runPrewarm(...args);
  });
  const run = () =>
    f.assembly.port.prewarm(
      f.base.context,
      f.base.identity,
      'page',
      signal(),
      signal(),
    );
  const first = run();
  void first.catch(() => {});
  await entered.promise;
  const second = run();
  const outcomes = Promise.all([first, second]);
  void outcomes.catch(() => {});
  try {
    await vi.waitFor(() => expect(f.readCoordination).toHaveBeenCalledTimes(2));
    await f.readCoordination.mock.results[1]!.value;
    expect(f.vm).toHaveBeenCalledTimes(1);
    authorityRevision = 'grant-2';
  } finally {
    release.resolve();
    await expect(outcomes).resolves.toEqual([undefined, undefined]);
  }
  expect(f.vm).toHaveBeenCalledTimes(2);
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('lets the existing lease recover an orphaned starting epoch without sharing its stale binding', async () => {
  const f = fixture(true);
  const { context, identity } = f.base;
  await f.h.service.create(context, signal());
  const oldInstanceId = randomUUID();
  await f.h.store.withLease(
    identity.personId,
    { now: f.h.now, ttlMs: f.h.options.leaseTtlMs },
    async ({ row, save }) => {
      await save({
        ...row!,
        phase: 'starting',
        instanceId: oldInstanceId,
        leaseEpoch: 3,
      });
    },
  );
  await expect(
    f.assembly.port.prewarm(context, identity, 'page', signal(), signal()),
  ).resolves.toBeUndefined();
  const running = await f.h.store.read(identity.personId);
  expect(running).toMatchObject({ phase: 'running', leaseEpoch: 4 });
  expect(running?.instanceId).not.toBe(oldInstanceId);
  expect(f.readCoordination).toHaveBeenCalledTimes(1);
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('preserves a successful new epoch when the prior running epoch stops before dispatch', async () => {
  const f = fixture(true);
  const { context, identity } = f.base;
  await f.runPrewarm(context, { trigger: 'page' }, signal());
  const old = (await f.h.store.read(identity.personId))!;
  f.vm.mockImplementationOnce(async (...args) => {
    f.h.states.set(old.vmId, 'stopped');
    await f.h.service.stop(context, signal());
    return f.runPrewarm(...args);
  });
  await expect(
    f.assembly.port.prewarm(context, identity, 'page', signal(), signal()),
  ).resolves.toBeUndefined();
  expect(await f.h.store.read(identity.personId)).toMatchObject({
    phase: 'running',
    leaseEpoch: old.leaseEpoch + 1,
  });
  expect(f.start).toHaveBeenCalledTimes(2);
  expect(f.readCoordination).toHaveBeenCalledTimes(2);
});

it('falls back to the existing lease if a ready shared epoch changes during the caller proof', async () => {
  const f = fixture(true);
  const { context, identity } = f.base;
  await f.runPrewarm(context, { trigger: 'page' }, signal());
  const old = (await f.h.store.read(identity.personId))!;
  const proof = vi
    .fn(async () => signal())
    .mockImplementationOnce(async () => {
      f.h.states.set(old.vmId, 'stopped');
      await f.h.service.stop(context, signal());
      throw new PersonVmError('NOT_FOUND');
    });
  const uninstall = installDEntryNativeDataPort({
    ...f.base.data,
    assertEditorReady: proof,
  });
  try {
    const ready = await f.assembly.port.prewarm(
      context,
      identity,
      'page',
      signal(),
      signal(),
    );
    expect(ready).toBe(await proof.mock.results[1]!.value);
    expect(await f.h.store.read(identity.personId)).toMatchObject({
      phase: 'running',
      leaseEpoch: old.leaseEpoch + 1,
    });
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.vm).toHaveBeenCalledTimes(2);
  } finally {
    uninstall();
  }
});

it('current authority rejects before any VM call, and post-start denial does not stop shared running work', async () => {
  const f = fixture();
  authority.identity.mockRejectedValueOnce(
    new DataAccessError('authorization_denied'),
  );
  await expect(
    f.assembly.port.prewarm(
      f.base.context,
      f.base.identity,
      'page',
      signal(),
      f.lifetime.signal,
    ),
  ).rejects.toThrow();
  expect(f.vm).not.toHaveBeenCalled();
  const original = f.runPrewarm;
  f.vm.mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    authority.identity.mockResolvedValue({
      ...f.base.identity,
      employeeRevision: 2,
    });
    return result;
  });
  await expect(
    f.assembly.port.prewarm(
      f.base.context,
      f.base.identity,
      'page',
      signal(),
      f.lifetime.signal,
    ),
  ).rejects.toMatchObject({ code: 'authorization_denied' });
  expect(f.stop).not.toHaveBeenCalled();
  authority.identity.mockResolvedValue(f.base.identity);
  await f.assembly.port.prewarm(
    f.base.context,
    f.base.identity,
    'input',
    signal(),
    f.lifetime.signal,
  );
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('a cancelled request joins its actual prewarm and leaves a later valid request usable', async () => {
  const f = fixture(),
    caller = new AbortController(),
    started = deferred<void>(),
    finish = deferred<void>(),
    original = f.runPrewarm;
  f.vm.mockImplementationOnce(async (...args) => {
    started.resolve();
    await finish.promise;
    expect(args[2]).not.toBe(caller.signal);
    expect(args[2].aborted).toBe(false);
    return original(...args);
  });
  let ended = false;
  const cancelled = new Error('browser left');
  const work = f.assembly.port
    .prewarm(
      f.base.context,
      f.base.identity,
      'page',
      caller.signal,
      f.lifetime.signal,
    )
    .catch((error: unknown) => error)
    .finally(() => {
      ended = true;
    });
  await started.promise;
  try {
    caller.abort(cancelled);
    expect(ended).toBe(false);
  } finally {
    finish.resolve();
  }
  expect(await work).toBe(cancelled);
  await f.assembly.port.prewarm(
    f.base.context,
    f.base.identity,
    'input',
    signal(),
    f.lifetime.signal,
  );
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.stop).not.toHaveBeenCalled();
});

it('uninstallation closes admission immediately and joins actual work without aborting the VM lifetime', async () => {
  const f = fixture(),
    started = deferred<void>(),
    finish = deferred<void>(),
    original = f.runPrewarm;
  const installed = installDEntryNativePrewarm({
    prewarmCurrent: f.prewarmCurrent,
    lifetime: f.lifetime.signal,
  });
  cleanups.push(installed.close);
  f.vm.mockImplementationOnce(async (...args) => {
    started.resolve();
    await finish.promise;
    return original(...args);
  });
  const work = dEntryNativePrewarmPort
    .prewarm(
      f.base.context,
      f.base.identity,
      'page',
      signal(),
      f.lifetime.signal,
    )
    .catch((error: unknown) => error);
  await started.promise;
  let ended = false;
  const closing = installed.close().then(() => {
    ended = true;
  });
  try {
    expect(() =>
      dEntryNativePrewarmPort.prewarm(
        f.base.context,
        f.base.identity,
        'input',
        signal(),
        f.lifetime.signal,
      ),
    ).toThrow(DEntryNativeUnavailable);
    expect(ended).toBe(false);
    expect(f.lifetime.signal.aborted).toBe(false);
  } finally {
    finish.resolve();
  }
  expect(await work).toBeInstanceOf(DEntryNativeUnavailable);
  await closing;
  expect(f.stop).not.toHaveBeenCalled();
});

function prewarmStatus(
  server: Awaited<ReturnType<typeof nativeEntryServer>>,
  operationId: string,
  token = 'original_session_opaque_token',
) {
  const query = new URLSearchParams({
    ...server.body.selection,
    organizationId: server.body.organizationId,
    operationId,
  });
  return fetch(
    `${server.origin}/internal/d-entry/native-prewarm/status?${query}`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
}

it('the real Worker listener requires current release eligibility and the installed prewarm port, without resolving catalog/data', async () => {
  const f = fixture();
  const server = await nativeEntryServer(f.base, {
    ...f.base.deps,
    owners: dEntryNativeOwnerPort,
    data: () => undefined,
  });
  cleanups.push(server.close);
  const body = { ...f.base.body, trigger: 'page' };
  expect((await server.request('native-prewarm', body)).status).toBe(503);
  expect(f.vm).not.toHaveBeenCalled();
  const installed = installDEntryNativePrewarm({
    prewarmCurrent: f.prewarmCurrent,
    lifetime: f.lifetime.signal,
    readCoordination: f.readCoordination,
  });
  cleanups.push(installed.close);
  f.base.deps.identity.mockRejectedValueOnce(
    new DataAccessError('authorization_denied'),
  );
  expect((await server.request('native-prewarm', body)).status).toBe(404);
  expect(f.vm).not.toHaveBeenCalled();
  for (const invalid of [
    { ...body, personId: randomUUID() },
    { ...body, trigger: 'send' },
  ])
    expect((await server.request('native-prewarm', invalid)).status).toBe(400);
  const response = await server.request('native-prewarm', body);
  expect(response.status).toBe(202);
  const { ticket } = await response.json();
  await vi.waitFor(async () => {
    expect(
      await (await prewarmStatus(server, ticket.operationId)).json(),
    ).toEqual({ state: 'ready' });
  });
  expect(f.base.deps.owners.resolve).not.toHaveBeenCalled();
  expect(f.base.data.acquireRoot).not.toHaveBeenCalled();
  expect(f.base.data.acquireRpc).not.toHaveBeenCalled();
  expect((await server.request()).status).toBe(503);
  expect((await server.request('native-root')).status).toBe(503);
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('checks the accepted revision inside the lifecycle lease before creating a disk', async () => {
  const f = fixture(true);
  const { context, identity } = f.base;
  const active = signal();
  const plan = await f.assembly.port.prepare!(context, identity, active);
  const lease = f.h.store.withLease.bind(f.h.store);
  vi.spyOn(f.h.store, 'withLease').mockImplementationOnce((...args) => {
    f.readCoordination.mockResolvedValue({
      authorityRevision: 'new-grant',
      vm: null,
    });
    return lease(...args);
  });
  await expect(
    f.assembly.port.prewarm(context, identity, 'page', active, active, plan),
  ).rejects.toMatchObject({ code: 'authorization_denied' });
  expect(f.h.log).toEqual([]);
  expect(await f.h.store.read(identity.personId)).toBeNull();
});

it('returns Worker 200 on a verified hot path and refuses proof revoked during reply qualification', async () => {
  const f = fixture();
  const route = new AbortController();
  const entered = deferred<void>();
  const release = deferred<void>();
  const prewarm = vi.fn(async () => route.signal);
  const check = vi.fn(async () => true);
  const watch = f.base.deps.watch.getMockImplementation()!;
  f.base.deps.watch.mockImplementation(async () => ({
    ...(await watch()),
    assertTicketThread: async () => {},
  }));
  const server = await nativeEntryServer(f.base, {
    ...f.base.deps,
    prewarm: {
      isCurrent: check,
      prepare: async () => ({
        key: 'hot-exact',
        target: f.base.binding,
        running: true,
      }),
      prewarm,
    },
  });
  cleanups.push(server.close);
  const body = { ...f.base.body, trigger: 'page' };
  const hot = await server.request('native-prewarm', body);
  expect(hot.status).toBe(200);
  expect(await hot.json()).toEqual({
    identity: f.base.identity,
    trigger: 'page',
  });
  await vi.waitFor(() => expect(f.base.authorityClose).toHaveBeenCalledOnce());
  check.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return true;
  });
  const request = server.request('native-prewarm', body);
  await entered.promise;
  route.abort();
  release.resolve();
  expect((await request).status).toBe(202);
  expect(prewarm).toHaveBeenCalledTimes(2);
});

it('returns ready for an exact verified running editor without opening a prewarm job', async () => {
  const f = fixture(true);
  const { context, body, data } = f.base;
  await f.h.service.prewarm(context, { trigger: 'page' }, signal());
  const binding = await f.h.service.resolve(context, signal());
  const verified = new AbortController();
  const confirmVerifiedEditor = vi.fn(async () => ({
    binding,
    proof: verified.signal,
  }));
  const uninstall = installDEntryNativeDataPort({
    ...data,
    confirmVerifiedEditor,
    assertEditorReady: async () => signal(),
  });
  cleanups.push(async () => uninstall());
  const prewarmCurrent = vi.fn(f.prewarmCurrent);
  const installed = installDEntryNativePrewarm({
    prewarmCurrent,
    lifetime: f.lifetime.signal,
    requireEditorProof: true,
    readCoordination: f.readCoordination,
  });
  cleanups.push(installed.close);
  const server = await nativeEntryServer(f.base);
  cleanups.push(server.close);

  expect(
    (await server.request('native-prewarm', { ...body, trigger: 'page' }))
      .status,
  ).toBe(200);
  expect(confirmVerifiedEditor).toHaveBeenCalledOnce();
  expect(prewarmCurrent).not.toHaveBeenCalled();
  expect(f.start).toHaveBeenCalledOnce();

  verified.abort();
  expect(
    (await server.request('native-prewarm', { ...body, trigger: 'page' }))
      .status,
  ).toBe(200);
  expect(prewarmCurrent).toHaveBeenCalledOnce();
  expect(f.start).toHaveBeenCalledOnce();
});

it('uses both the selected editor proof and physical Host readiness on the real hot HTTP path', async () => {
  const f = fixture(true);
  const { context, body, data } = f.base;
  await f.h.service.prewarm(context, { trigger: 'page' }, signal());
  const route = new AbortController();
  const proof = vi.fn(async () => route.signal);
  const uninstall = installDEntryNativeDataPort({
    ...data,
    assertEditorReady: proof,
  });
  cleanups.push(async () => uninstall());
  const installed = installDEntryNativePrewarm({
    prewarmCurrent: f.prewarmCurrent,
    lifetime: f.lifetime.signal,
    requireEditorProof: true,
    readCoordination: f.readCoordination,
  });
  cleanups.push(installed.close);
  const server = await nativeEntryServer(f.base);
  cleanups.push(server.close);
  const ping = vi.spyOn(f.h.native, 'ping');
  expect(
    (await server.request('native-prewarm', { ...body, trigger: 'page' }))
      .status,
  ).toBe(200);
  expect(ping).toHaveBeenCalledTimes(1);
  // The selected owner still proves its editor, but an incomplete Host roster
  // is reported by the existing VM-wide readiness port.
  f.h.setReadiness({ authenticated: true, editorReady: false, canSend: false });
  const rejected = await server.request('native-prewarm', {
    ...body,
    trigger: 'page',
  });
  expect(rejected.status).toBe(202);
  const { ticket } = await rejected.json();
  const status = await prewarmStatus(server, ticket.operationId);
  expect(await status.json()).toEqual({
    state: 'failed',
    code: 'START_UNAVAILABLE',
  });
  expect(ping).toHaveBeenCalledTimes(2);
  expect(proof).toHaveBeenCalledTimes(2);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.stop).not.toHaveBeenCalled();
});

it.each([false, true])(
  'expires the old ticket and prewarms after deletion (purge=%s)',
  async (purge) => {
    const f = fixture(true);
    const { context, identity, body } = f.base;
    const installed = installDEntryNativePrewarm({
      prewarmCurrent: f.prewarmCurrent,
      lifetime: f.lifetime.signal,
      readCoordination: f.readCoordination,
    });
    cleanups.push(installed.close);
    const server = await nativeEntryServer(f.base);
    cleanups.push(server.close);
    const post = () =>
      server.request('native-prewarm', { ...body, trigger: 'page' });
    const first = await post();
    expect(first.status).toBe(202);
    const { ticket: old } = await first.json();
    await vi.waitFor(async () =>
      expect(
        await (await prewarmStatus(server, old.operationId)).json(),
      ).toEqual({ state: 'ready' }),
    );
    const binding = await f.h.service.resolve(context, signal());
    f.h.states.set(binding.vmId, 'stopped');
    f.h.authorizeDiskDelete(purge);
    await f.h.service.delete(context, { deleteDisk: purge }, signal());
    const before = f.h.log.slice();
    const expired = await prewarmStatus(server, old.operationId);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ state: 'expired' });
    expect(f.h.log).toEqual(before);
    expect(await f.h.store.read(identity.personId)).toMatchObject({
      phase: 'deleted',
      diskRetained: !purge,
    });
    const restored = await post();
    expect(restored.status).toBe(202);
    const { ticket } = await restored.json();
    expect(ticket.operationId).not.toBe(old.operationId);
    await vi.waitFor(async () =>
      expect(
        await (await prewarmStatus(server, ticket.operationId)).json(),
      ).toEqual({ state: 'ready' }),
    );
    expect(await f.h.service.resolve(context, signal())).toMatchObject({
      vmId: purge ? expect.not.stringContaining(binding.vmId) : binding.vmId,
      leaseEpoch: binding.leaseEpoch + 1,
    });
    expect(f.h.log.filter((event) => event === 'disk:create')).toHaveLength(
      purge ? 2 : 1,
    );
    expect(f.start).toHaveBeenCalledTimes(2);
    expect((await prewarmStatus(server, old.operationId)).status).toBe(410);
  },
);

it('returns a ticket for a running VM with slow editor proof and keeps just one owned job', async () => {
  const f = fixture(),
    proof = deferred<AbortSignal>();
  const prewarm = vi.fn(() => proof.promise);
  const server = await nativeEntryServer(f.base, {
    ...f.base.deps,
    prewarm: {
      isCurrent: async () => true,
      prepare: async () => ({
        key: 'same-boot',
        target: f.base.binding,
        running: true,
      }),
      prewarm,
    },
  });
  cleanups.push(server.close);
  try {
    const body = { ...f.base.body, trigger: 'page' };
    const replies = await Promise.all([
      server.request('native-prewarm', body),
      server.request('native-prewarm', body),
    ]);
    expect(replies.map((reply) => reply.status)).toEqual([202, 202]);
    const [{ ticket }, duplicate] = await Promise.all(
      replies.map((reply) => reply.json()),
    );
    expect(duplicate.ticket).toEqual(ticket);
    expect(prewarm).toHaveBeenCalledOnce();
    expect(
      await (await prewarmStatus(server, ticket.operationId)).json(),
    ).toEqual({ state: 'starting' });
    proof.resolve(signal());
    await vi.waitFor(async () =>
      expect(
        await (await prewarmStatus(server, ticket.operationId)).json(),
      ).toEqual({ state: 'ready' }),
    );
  } finally {
    proof.resolve(signal());
  }
});

it('keeps the ticket when the last hot readiness recheck is slow and joins that read on shutdown', async () => {
  const f = fixture(),
    finish = deferred<void>();
  let checking: AbortSignal | undefined;
  const prewarm = vi.fn(async () => signal());
  const server = await nativeEntryServer(f.base, {
    ...f.base.deps,
    prewarm: {
      isCurrent: async (_context, _identity, _plan, active, mode) => {
        if (mode === 'ready' && !checking) {
          checking = active;
          await finish.promise;
        }
        return true;
      },
      prepare: async () => ({
        key: 'same-boot',
        target: f.base.binding,
        running: true,
      }),
      prewarm,
    },
  });
  let closing: Promise<void> | undefined;
  try {
    const reply = await server.request('native-prewarm', {
      ...f.base.body,
      trigger: 'page',
    });
    expect(reply.status).toBe(202);
    const { ticket } = await reply.json();
    expect(checking?.aborted).toBe(true);
    expect(prewarm).toHaveBeenCalledOnce();
    expect(
      await (await prewarmStatus(server, ticket.operationId)).json(),
    ).toEqual({ state: 'ready' });
    let joined = false;
    closing = server.close().then(() => {
      joined = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(joined).toBe(false);
  } finally {
    finish.resolve();
    await (closing ?? server.close());
  }
});

it('serves short polls over a cold startup longer than 125 seconds and deduplicates POSTs', async () => {
  const f = fixture(true),
    started = deferred<void>(),
    finish = deferred<void>();
  const installed = installDEntryNativePrewarm({
    prewarmCurrent: f.prewarmCurrent,
    lifetime: f.lifetime.signal,
    readCoordination: f.readCoordination,
  });
  cleanups.push(installed.close);
  let physical: AbortSignal | undefined;
  f.vm.mockImplementationOnce(async (...args) => {
    physical = args[2];
    started.resolve();
    await finish.promise;
    return f.runPrewarm(...args);
  });
  const server = await nativeEntryServer(f.base);
  cleanups.push(server.close);
  const body = { ...f.base.body, trigger: 'page' };
  const now = Date.now();
  const time = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const replies = await Promise.all([
      server.request('native-prewarm', body),
      server.request('native-prewarm', { ...body, trigger: 'input' }),
    ]);
    expect(replies.map(({ status }) => status)).toEqual([202, 202]);
    const results = await Promise.all(replies.map((reply) => reply.json()));
    const { ticket } = results[0]!;
    expect(results[1]!.ticket).toEqual(ticket);
    await started.promise;
    expect(f.vm).toHaveBeenCalledTimes(1);
    // An accepted response has ended. Advancing time models a long cold start
    // while exercising real, independent short HTTP requests.
    time.mockReturnValue(now + 126_000);
    const status = await prewarmStatus(server, ticket.operationId);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ state: 'starting' });
    expect(physical?.aborted).toBe(false);
    // Only the duplicate watcher has closed so far.
    expect(f.base.authorityClose).toHaveBeenCalledTimes(1);
    f.readCoordination.mockImplementationOnce(async () => ({
      authorityRevision: 'new-release-same-business-identity',
      vm: await f.h.store.read(f.base.identity.personId),
    }));
    const stale = await prewarmStatus(server, ticket.operationId);
    expect(stale.status).toBe(410);
    expect(await stale.json()).toEqual({ state: 'expired' });
    finish.resolve();
    await vi.waitFor(async () => {
      const ready = await prewarmStatus(server, ticket.operationId);
      expect(await ready.json()).toEqual({ state: 'ready' });
    });
    expect(f.base.authorityClose).toHaveBeenCalledTimes(2);
    expect(f.start).toHaveBeenCalledTimes(1);
    f.readCoordination.mockImplementationOnce(async () => ({
      authorityRevision: 'release-1',
      vm: {
        ...(await f.h.store.read(f.base.identity.personId))!,
        leaseOwner: randomUUID(),
      },
    }));
    const busy = await prewarmStatus(server, ticket.operationId);
    expect(await busy.json()).toEqual({ state: 'expired' });
    expect(busy.status).toBe(410);
    time.mockReturnValue(now + 601_000);
    const expired = await prewarmStatus(server, ticket.operationId);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ state: 'expired' });
  } finally {
    finish.resolve();
    time.mockRestore();
  }
});

it.each([
  [new DataAccessError('authorization_denied'), 'AUTHORITY_REVOKED'],
  [Error('authority observer disconnected'), 'START_UNAVAILABLE'],
])(
  'owns cancellation and cleanup after admission (%s), and rejects another login and a restarted Worker',
  async (failure, code) => {
    const f = fixture(),
      started = deferred<void>(),
      finish = deferred<void>();
    let owned: AbortSignal | undefined;
    const changedLogin = { ...f.base.context, sessionId: randomUUID() };
    const authenticate: typeof Database.authenticateSession = async (token) =>
      token === 'other_valid_login_token' ? changedLogin : f.base.context;
    const prewarm = vi.fn(
      async (_context, _identity, _trigger, active: AbortSignal) => {
        owned = active;
        started.resolve();
        await finish.promise;
        active.throwIfAborted();
      },
    );
    const deps = {
      ...f.base.deps,
      authenticate,
      prewarm: {
        isCurrent: async () => true,
        prepare: async () => ({ key: 'cold-exact', target: f.base.binding }),
        prewarm,
      },
    };
    const server = await nativeEntryServer(f.base, deps);
    cleanups.push(server.close);
    const restarted = await nativeEntryServer(f.base, deps);
    cleanups.push(restarted.close);
    const reply = await server.request('native-prewarm', {
      ...f.base.body,
      trigger: 'page',
    });
    expect(reply.status).toBe(202);
    const { ticket } = await reply.json();
    await started.promise;
    try {
      expect(
        (
          await prewarmStatus(
            server,
            ticket.operationId,
            'other_valid_login_token',
          )
        ).status,
      ).toBe(404);
      const gone = await prewarmStatus(restarted, ticket.operationId);
      expect(gone.status).toBe(410);
      expect(await gone.json()).toEqual({ state: 'expired' });
      expect(prewarm).toHaveBeenCalledTimes(1);
      f.base.identityRevoked.abort(failure);
      expect(owned?.aborted).toBe(true);
      expect(f.base.authorityClose).not.toHaveBeenCalled();
      expect(
        await (await prewarmStatus(server, ticket.operationId)).json(),
      ).toEqual({ state: 'starting' });
    } finally {
      finish.resolve();
    }
    await vi.waitFor(async () => {
      expect(
        await (await prewarmStatus(server, ticket.operationId)).json(),
      ).toEqual({
        state: 'failed',
        code,
      });
    });
    expect(f.base.authorityClose).toHaveBeenCalledOnce();
  },
);

it('keeps the thread observer alive after readiness and expires the original ticket when the observer revokes it', async () => {
  const f = fixture();
  const observe = vi.fn(async (signal: AbortSignal) => {
    signal.throwIfAborted();
    f.base.identityRevoked.signal.throwIfAborted();
  });
  const watch = f.base.deps.watch.getMockImplementation()!;
  f.base.deps.watch.mockImplementationOnce(async () => ({
    ...(await watch()),
    assertTicketThread: observe,
  }));
  const server = await nativeEntryServer(f.base, {
    ...f.base.deps,
    prewarm: {
      isCurrent: async () => true,
      prepare: async () => ({ key: 'exact-thread', target: f.base.binding }),
      prewarm: async () => signal(),
    },
  });
  cleanups.push(server.close);
  const reply = await server.request('native-prewarm', {
    ...f.base.body,
    trigger: 'page',
  });
  expect(reply.status).toBe(202);
  const { ticket } = await reply.json();
  await vi.waitFor(async () =>
    expect(
      await (await prewarmStatus(server, ticket.operationId)).json(),
    ).toEqual({ state: 'ready' }),
  );
  expect(f.base.authorityClose).not.toHaveBeenCalled();
  expect(observe.mock.calls.length).toBeGreaterThan(1);
  f.base.identityRevoked.abort(new DataAccessError('authorization_denied'));
  const status = await prewarmStatus(server, ticket.operationId);
  expect(status.status).toBe(410);
  expect(await status.json()).toEqual({ state: 'expired' });
  expect(f.base.authorityClose).toHaveBeenCalledOnce();
});

it('reports a startup failure when the observer closes during an authenticated poll', async () => {
  const f = fixture(),
    finish = deferred<void>(),
    closeHeld = deferred<void>(),
    checked = deferred<void>(),
    resume = deferred<void>();
  f.base.authorityClose.mockImplementationOnce(() => closeHeld.promise);
  const watch = f.base.deps.watch.getMockImplementation()!;
  f.base.deps.watch.mockImplementationOnce(async () => ({
    ...(await watch()),
    async assertTicketThread() {
      if (f.base.authorityClose.mock.calls.length)
        throw new DataAccessError('authorization_denied');
    },
  }));
  const server = await nativeEntryServer(f.base, {
    ...f.base.deps,
    prewarm: {
      async isCurrent(_context, _identity, _plan, _signal, mode) {
        if (mode === 'operation') {
          checked.resolve();
          await resume.promise;
        }
        return true;
      },
      prepare: async () => ({ key: 'exact-thread', target: f.base.binding }),
      async prewarm() {
        await finish.promise;
        throw new Error('private native failure');
      },
    },
  });
  cleanups.push(server.close);
  try {
    const reply = await server.request('native-prewarm', {
      ...f.base.body,
      trigger: 'page',
    });
    expect(reply.status).toBe(202);
    const { ticket } = await reply.json();
    const status = prewarmStatus(server, ticket.operationId);
    await checked.promise;
    finish.resolve();
    await vi.waitFor(() =>
      expect(f.base.authorityClose).toHaveBeenCalledOnce(),
    );
    resume.resolve();
    const response = await status;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'starting' });
    closeHeld.resolve();
    await vi.waitFor(async () =>
      expect(
        await (await prewarmStatus(server, ticket.operationId)).json(),
      ).toEqual({ state: 'failed', code: 'START_UNAVAILABLE' }),
    );
  } finally {
    finish.resolve();
    closeHeld.resolve();
    resume.resolve();
  }
});

it('reports immediate startup failure without exposing native errors', async () => {
  const f = fixture();
  const server = await nativeEntryServer(f.base, {
    ...f.base.deps,
    prewarm: {
      isCurrent: async () => true,
      prepare: async () => ({ key: 'cold-exact', target: f.base.binding }),
      prewarm: async () => {
        throw Error('private provider internals');
      },
    },
  });
  cleanups.push(server.close);
  const reply = await server.request('native-prewarm', {
    ...f.base.body,
    trigger: 'page',
  });
  expect(reply.status).toBe(202);
  const { ticket } = await reply.json();
  await vi.waitFor(async () => {
    expect(
      await (await prewarmStatus(server, ticket.operationId)).json(),
    ).toEqual({
      state: 'failed',
      code: 'START_UNAVAILABLE',
    });
  });
});

it('genuine current-authority revocation still reaches physical prewarm without treating browser cancellation as authority', async () => {
  const f = fixture(),
    revoked = new AbortController(),
    started = deferred<void>(),
    finish = deferred<void>(),
    original = f.runPrewarm;
  let physical: AbortSignal | undefined;
  f.vm.mockImplementationOnce(async (...args) => {
    physical = args[2];
    started.resolve();
    await finish.promise;
    return original(...args);
  });
  const failure = new DataAccessError('authorization_denied');
  const work = f.assembly.port
    .prewarm(f.base.context, f.base.identity, 'page', signal(), revoked.signal)
    .catch((error: unknown) => error);
  await started.promise;
  try {
    revoked.abort(failure);
    expect(physical?.aborted).toBe(true);
  } finally {
    finish.resolve();
  }
  expect(await work).toBe(failure);
  expect(f.start).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
});

it('combined production API rolls back its new catalog registration when prewarm registration already has an owner', async () => {
  const f = fixture(),
    uninstall = installDEntryNativePrewarmPort(f.assembly.port);
  cleanups.push(async () => uninstall());
  expect(() =>
    installAssignedDEntryNativeRuntime({
      vm: f.h.service,
      prewarmCurrent: f.prewarmCurrent,
      lifetime: f.lifetime.signal,
      startup: {
        catalog: () => {
          throw new DEntryNativeUnavailable();
        },
      },
    }),
  ).toThrow(DEntryNativeUnavailable);
  expect(() =>
    dEntryNativeOwnerPort.resolve(f.base.context, f.base.identity, signal()),
  ).toThrow(DEntryNativeUnavailable);
  expect(f.vm).not.toHaveBeenCalled();
});

it('plans the next epoch before asking an old running binding for editor proof', async () => {
  const f = fixture();
  const { context, identity } = f.base;
  const vmId = randomUUID();
  const oldInstance = randomUUID();
  const nextInstance = randomUUID();
  let updated = false;
  let previousPhase: 'running' | 'failed' = 'running';
  const proof = vi.fn(async () => {
    expect(updated).toBe(true);
    return signal();
  });
  const uninstall = installDEntryNativeDataPort({
    ...f.base.data,
    assertEditorReady: proof,
  });
  const assembly = createDEntryNativePrewarmPort({
    lifetime: f.lifetime.signal,
    requireEditorProof: true,
    ownsRunningBinding: (binding) => binding.instanceId === nextInstance,
    readCoordination: async () => ({
      authorityRevision: 'release-1',
      vm: {
        vmId,
        instanceId: updated ? nextInstance : oldInstance,
        leaseEpoch: updated ? 6 : 5,
        phase: updated ? 'running' : previousPhase,
        leaseOwner: null,
        hasEgressReceipt: true,
      },
    }),
    async prewarmCurrent(_context, _identity, input) {
      expect(input.target).toMatchObject({
        vmId,
        instanceId: null,
        leaseEpoch: 6,
      });
      expect(proof).not.toHaveBeenCalled();
      updated = true;
      return {
        vmId,
        personId: identity.personId,
        organizationId: identity.organizationId,
        phase: 'running',
        ready: true,
        diskRetained: true,
        lastActivityAt: new Date().toISOString(),
      };
    },
  });
  try {
    const plan = await assembly.port.prepare!(context, identity, signal());
    expect(plan.running).toBe(false);
    await expect(
      assembly.port.isCurrent!(context, identity, plan, signal(), 'operation'),
    ).resolves.toBe(true);
    expect(plan.upgradeRestart).toBe(true);
    previousPhase = 'failed';
    const retryPlan = await assembly.port.prepare!(context, identity, signal());
    expect(retryPlan).toMatchObject({
      upgradeRestart: true,
      running: false,
      target: plan.target,
    });
    await expect(
      assembly.port.prewarm(
        context,
        identity,
        'page',
        signal(),
        signal(),
        plan,
      ),
    ).rejects.toMatchObject({ code: 'UPGRADE_OPEN_REQUIRED' });
    expect(updated).toBe(false);
    expect(proof).not.toHaveBeenCalled();
    await expect(
      assembly.port.prewarm(
        context,
        identity,
        'open',
        signal(),
        signal(),
        plan,
      ),
    ).resolves.toBeInstanceOf(AbortSignal);
    expect(proof).toHaveBeenCalledOnce();
    expect(plan.target.instanceId).toBe(nextInstance);
    await expect(
      assembly.port.isCurrent!(context, identity, plan, signal(), 'ready'),
    ).resolves.toBe(true);
  } finally {
    uninstall();
    await assembly.close();
  }
});
