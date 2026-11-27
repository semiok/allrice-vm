import { randomUUID } from 'node:crypto';
import type { CurrentSelectionPrewarm } from '../person-vm/production-prewarm.js';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { DataAccessError, DEntryTicketObserverClosed } from '@allrice/database';
import { PersonVmError, PersonVmService } from '@allrice/person-vm';
import {
  harness,
  MemoryStore,
} from '../../../../packages/person-vm/src/test-support.ts';
import {
  deferred,
  nativeEntryFixture,
  nativeEntryServer,
} from '../d-entry/native-entry.fixture.js';
import {
  dEntryNativePrewarmPort,
  installDEntryNativePrewarmPort,
  type DEntryNativePrewarmPort,
} from '../d-entry/native-prewarm.js';
import {
  installDEntryNativeDataPort,
  type DEntryNativeDataPort,
} from '../d-entry/native-data.js';
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
function fixture(coordinated = false, withThread = true) {
  // Actual lifecycle service with synthetic disk/native/runtime providers only.
  // No production installation, Host process, VM or performance claim.
  const initial = nativeEntryFixture();
  const base = withThread
    ? initial
    : nativeEntryFixture({
        context: initial.context,
        identity: { ...initial.identity, threadId: null },
      });
  const store = new MemoryStore(),
    h = harness(store),
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
    vm: store.readWithVersion(base.identity.personId),
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
    const prove = vi.fn<NonNullable<DEntryNativeDataPort['assertEditorReady']>>(
      async (context) => {
        expect(context.sessionId).toBe(f.base.context.sessionId);
        return signal();
      },
    );
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
    const current = await f.h.service.resolve(f.base.context, signal());
    expect(prove.mock.calls.map(([, , , binding]) => binding)).toEqual(
      expectedRequests.map(() => current),
    );
    expect(f.stop).not.toHaveBeenCalled();
  },
);

it('does not join a published instance observed for a different physical start', async () => {
  const f = fixture(true);
  const entered = deferred<void>();
  const release = deferred<void>();
  const { context, identity } = f.base;
  f.start.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return f.runStart(...args);
  });
  const first = f.assembly.port.prewarm(
    context,
    identity,
    'page',
    signal(),
    signal(),
  );
  void first.catch(() => {});
  try {
    await entered.promise;
    const owned = await f.h.store.read(identity.personId);
    expect(owned).toMatchObject({
      phase: 'starting',
      instanceId: expect.any(String),
    });
    f.readCoordination.mockResolvedValueOnce({
      authorityRevision: 'release-1',
      vm: { ...owned!, instanceId: randomUUID() },
    });
    await expect(
      f.assembly.port.prewarm(
        { ...context, requestId: randomUUID() },
        identity,
        'input',
        signal(),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
    expect(f.vm).toHaveBeenCalledTimes(2);
    expect(f.start).toHaveBeenCalledOnce();
    expect(await f.h.store.read(identity.personId)).toEqual(owned);
  } finally {
    release.resolve();
    await first;
  }
});

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
  method: 'GET' | 'DELETE' = 'GET',
) {
  const { threadId, ...selection } = server.body.selection;
  const query = new URLSearchParams({
    ...selection,
    ...(threadId && { threadId }),
    organizationId: server.body.organizationId,
    operationId,
  });
  return fetch(
    `${server.origin}/internal/d-entry/native-prewarm/status?${query}`,
    {
      method,
      headers: { authorization: `Bearer ${token}` },
    },
  );
}

async function seedOrphanedStart(f: ReturnType<typeof fixture>) {
  const { context, identity } = f.base;
  await f.runPrewarm(context, { trigger: 'page' }, signal());
  const predecessor = await f.h.service.resolve(context, signal());
  f.h.states.set(predecessor.vmId, 'stopped');
  await f.h.service.stop(context, signal());
  await f.h.store.withLease(
    identity.personId,
    { now: f.h.now, ttlMs: f.h.options.leaseTtlMs },
    async ({ row, save }) => {
      await save({ ...row!, phase: 'starting' });
    },
  );
  f.start.mockClear();
  f.stop.mockClear();
  return predecessor;
}

it.each(['exact start', 'wrong VM', 'wrong epoch'] as const)(
  'qualifies an accepted orphan-start HTTP ticket using %s',
  async (mode) => {
    const f = fixture(true);
    const { context, identity, body, data } = f.base;
    const original = await seedOrphanedStart(f);
    const takeoverEntered = deferred<void>();
    const allowTakeover = deferred<void>();
    const oldStopped = deferred<void>();
    const allowNewInstance = deferred<void>();
    if (mode === 'exact start') {
      const withLease = f.h.store.withLease.bind(f.h.store);
      vi.spyOn(f.h.store, 'withLease').mockImplementationOnce(
        (person, options, run) =>
          withLease(person, options, (lease) =>
            run({
              ...lease,
              async save(row) {
                await lease.save(row);
                if (
                  row.phase === 'stopped' &&
                  row.leaseEpoch === original.leaseEpoch
                ) {
                  oldStopped.resolve();
                  await allowNewInstance.promise;
                }
              },
            }),
          ),
      );
    }
    const physicalStatus = f.h.native.status;
    const statusProbe = vi
      .spyOn(f.h.native, 'status')
      .mockImplementationOnce(async (...args) => {
        takeoverEntered.resolve();
        await allowTakeover.promise;
        return physicalStatus(...args);
      });
    const assertEditorReady = vi.fn(async () => signal());
    const uninstall = installDEntryNativeDataPort({
      ...data,
      assertEditorReady,
    });
    cleanups.push(async () => uninstall());
    if (mode !== 'exact start')
      f.vm.mockImplementationOnce(async (...args) => {
        const actual = await f.runPrewarm(...args);
        if (mode === 'wrong VM') return { ...actual, vmId: randomUUID() };
        await f.h.store.withLease(
          identity.personId,
          { now: f.h.now, ttlMs: f.h.options.leaseTtlMs },
          async ({ row, save }) => {
            await save({ ...row!, leaseEpoch: original.leaseEpoch + 2 });
          },
        );
        return actual;
      });
    const reconcile = vi.fn(async () => {
      throw new PersonVmError('LEASE_CONFLICT');
    });
    const installed = installDEntryNativePrewarm({
      prewarmCurrent: f.prewarmCurrent,
      lifetime: f.lifetime.signal,
      readCoordination: f.readCoordination,
      requireEditorProof: true,
      reconcileStoppedEntry: reconcile,
    });
    cleanups.push(installed.close);
    const server = await nativeEntryServer(f.base);
    cleanups.push(server.close);
    let operationId: string;
    const post = () =>
      server.request('native-prewarm', { ...body, trigger: 'page' });
    const watchEntered = deferred<void>();
    const allowIssue = deferred<void>();
    let delayed: Promise<Response> | undefined;
    try {
      if (mode === 'exact start') {
        const watch = f.base.deps.watch.getMockImplementation()!;
        f.base.deps.watch.mockImplementationOnce(async () => {
          const subscription = await watch();
          watchEntered.resolve();
          await allowIssue.promise;
          return subscription;
        });
        delayed = post();
        await Promise.race([
          watchEntered.promise,
          delayed.then((response) => {
            throw Error(
              'POST ended before its watch barrier: ' + response.status,
            );
          }),
        ]);
      }
      const response = await post();
      expect(response.status).toBe(202);
      operationId = (await response.json()).ticket.operationId;
      await takeoverEntered.promise;
      const predecessor = (await f.h.store.read(identity.personId))!;
      expect(predecessor).toMatchObject({
        vmId: original.vmId,
        instanceId: original.instanceId,
        phase: 'starting',
        leaseEpoch: original.leaseEpoch,
        leaseOwner: expect.any(String),
      });
      if (delayed) {
        allowIssue.resolve();
        const resumed = await delayed;
        expect(resumed.status).toBe(202);
        expect((await resumed.json()).ticket.operationId).toBe(operationId);
        expect(f.vm).toHaveBeenCalledOnce();
      }
      const beforePoll = f.h.log.slice();
      const poll = () => prewarmStatus(server, operationId);
      const starting = await poll();
      expect(starting.status).toBe(200);
      expect(await starting.json()).toEqual({ state: 'starting' });
      for (const changed of [
        { leaseOwner: randomUUID() },
        { vmId: randomUUID() },
        { instanceId: randomUUID() },
        { leaseEpoch: original.leaseEpoch + 2 },
      ]) {
        f.readCoordination.mockResolvedValueOnce({
          authorityRevision: 'release-1',
          vm: { ...predecessor, ...changed },
        });
        const expired = await poll();
        expect(expired.status).toBe(410);
        expect(await expired.json()).toEqual({ state: 'expired' });
      }
      const stillStarting = await poll();
      expect(stillStarting.status).toBe(200);
      expect(await stillStarting.json()).toEqual({ state: 'starting' });
      expect(f.h.log).toEqual(beforePoll);
      expect(statusProbe).toHaveBeenCalledOnce();
      expect(f.vm).toHaveBeenCalledOnce();
      expect(f.start).not.toHaveBeenCalled();
      expect(assertEditorReady).not.toHaveBeenCalled();
      if (mode === 'exact start') {
        const repeat = async () => {
          const response = await post();
          expect(response.status).toBe(202);
          expect((await response.json()).ticket.operationId).toBe(operationId);
          expect(f.base.deps.watch).toHaveBeenCalledTimes(2);
          expect(f.vm).toHaveBeenCalledOnce();
          expect(reconcile).not.toHaveBeenCalled();
        };
        await repeat();
        allowTakeover.resolve();
        await Promise.race([
          oldStopped.promise,
          Promise.resolve(f.vm.mock.results[0]!.value).then(() => {
            throw Error('prewarm ended before its stopped predecessor barrier');
          }),
        ]);
        const stopped = (await f.h.store.read(identity.personId))!;
        expect(stopped).toMatchObject({
          phase: 'stopped',
          instanceId: original.instanceId,
          leaseOwner: predecessor.leaseOwner,
        });
        await repeat();
        const waiting = await poll();
        expect(waiting.status).toBe(200);
        expect(await waiting.json()).toEqual({ state: 'starting' });
        f.readCoordination.mockResolvedValueOnce({
          authorityRevision: 'release-1',
          vm: { ...stopped, leaseOwner: randomUUID() },
        });
        expect((await post()).status).toBe(503);
        const alternate = { ...context, sessionId: randomUUID() };
        f.base.deps.authenticate
          .mockResolvedValueOnce(alternate)
          .mockResolvedValueOnce(alternate);
        const otherLogin = await server.request(
          'native-prewarm',
          { ...body, trigger: 'page' },
          { authorization: 'Bearer another_valid_login_token' },
        );
        expect(otherLogin.status).toBe(503);
        const otherThread = randomUUID();
        f.base.deps.identity.mockResolvedValueOnce({
          ...identity,
          threadId: otherThread,
        });
        expect(
          (
            await server.request('native-prewarm', {
              ...body,
              selection: { ...body.selection, threadId: otherThread },
              trigger: 'page',
            })
          ).status,
        ).toBe(503);
        expect(reconcile).toHaveBeenCalledTimes(3);
        expect(f.vm).toHaveBeenCalledOnce();
      }
    } finally {
      allowIssue.resolve();
      allowTakeover.resolve();
      allowNewInstance.resolve();
      await delayed?.catch(() => {});
    }
    const observed: number[] = [];
    await vi.waitFor(async () => {
      const status = await prewarmStatus(server, operationId);
      observed.push(status.status);
      if (mode === 'wrong epoch') expect(status.status).toBe(410);
      else if (mode === 'wrong VM')
        expect(await status.json()).toEqual({
          state: 'failed',
          code: 'START_UNAVAILABLE',
        });
      else expect(await status.json()).toEqual({ state: 'ready' });
    });
    if (mode !== 'wrong epoch')
      expect(new Set(observed)).toEqual(new Set([200]));
    // Join the real Worker task before asserting the negative side effects.
    await server.close();
    const running = await f.h.store.read(identity.personId);
    expect(running).toMatchObject({
      phase: 'running',
      vmId: original.vmId,
      leaseEpoch: original.leaseEpoch + (mode === 'wrong epoch' ? 2 : 1),
    });
    expect(running?.instanceId).not.toBe(original.instanceId);
    expect(f.vm).toHaveBeenCalledOnce();
    expect(f.start).toHaveBeenCalledOnce();
    if (mode === 'exact start')
      expect(assertEditorReady).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        identity,
        expect.any(AbortSignal),
        await f.h.service.resolve(context, signal()),
        expect.any(Function),
      );
    else expect(assertEditorReady).not.toHaveBeenCalled();
  },
);

it.each([
  ['provider unknown', 'joined'],
  ['cleanup failed', 'joined'],
  ['cleanup failed', 'unconfirmed'],
  ['cleanup failed', 'rolled back'],
] as const)(
  'keeps the same failed orphan ticket current during release after %s (%s)',
  async (mode, join) => {
    const f = fixture(true);
    const { body, data, identity } = f.base;
    const original = await seedOrphanedStart(f);
    const entered = deferred<void>();
    const release = deferred<void>();
    const releaseWritten = deferred<void>();
    const allowUnlock = deferred<void>();
    const ending = deferred<void>();
    const allowEnd = deferred<void>();
    if (mode === 'provider unknown') {
      vi.spyOn(f.h.native, 'status').mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return 'unknown';
      });
    } else {
      vi.spyOn(f.h.disk, 'detach').mockRejectedValueOnce(
        new PersonVmError('PROVIDER_FAILED'),
      );
    }
    const withLease = f.h.store.withLease.bind(f.h.store);
    vi.spyOn(f.h.store, 'withLease').mockImplementationOnce(
      async (person, options, run) => {
        let own: { token: string; version: string } | undefined;
        try {
          return await withLease(
            person,
            {
              ...options,
              observeRelease(token, version, stage) {
                if (stage === 'written') {
                  own = { token, version };
                  options.observeRelease?.(token, version, stage);
                }
              },
            },
            (lease) =>
              run({
                ...lease,
                async save(row) {
                  await lease.save(row);
                  if (mode === 'cleanup failed' && row.phase === 'failed') {
                    entered.resolve();
                    await release.promise;
                  }
                },
              }),
          );
        } finally {
          if (own) {
            releaseWritten.resolve();
            await allowUnlock.promise;
            if (join !== 'joined')
              options.observeRelease?.(own.token, own.version, 'unconfirmed');
            ending.resolve();
            await allowEnd.promise;
            if (join === 'joined')
              options.observeRelease?.(own.token, own.version, 'joined');
          }
        }
      },
    );
    const proof = vi.fn(async () => signal());
    const uninstall = installDEntryNativeDataPort({
      ...data,
      assertEditorReady: proof,
    });
    cleanups.push(async () => uninstall());
    const installed = installDEntryNativePrewarm({
      prewarmCurrent: f.prewarmCurrent,
      lifetime: f.lifetime.signal,
      readCoordination: f.readCoordination,
      requireEditorProof: true,
    });
    cleanups.push(installed.close);
    const verifyThread = vi.fn(async (active: AbortSignal) => {
      active.throwIfAborted();
      f.base.identityRevoked.signal.throwIfAborted();
    });
    const watch = f.base.deps.watch.getMockImplementation()!;
    f.base.deps.watch.mockImplementation(async () => ({
      ...(await watch()),
      assertTicketThread: verifyThread,
    }));
    const joined = deferred<void>();
    const server = await nativeEntryServer(f.base, {
      ...f.base.deps,
      prewarm: {
        ...dEntryNativePrewarmPort,
        async prewarm(...args) {
          try {
            return await dEntryNativePrewarmPort.prewarm(...args);
          } finally {
            joined.resolve();
          }
        },
      },
    });
    cleanups.push(server.close);
    const phase = mode === 'provider unknown' ? 'starting' : 'failed';
    let operationId: string;
    try {
      const accepted = await server.request('native-prewarm', {
        ...body,
        trigger: 'page',
      });
      expect(accepted.status).toBe(202);
      operationId = (await accepted.json()).ticket.operationId;
      await Promise.race([
        entered.promise,
        joined.promise.then(() => {
          throw Error('prewarm ended before its failure barrier');
        }),
      ]);
      const held = await f.readCoordination();
      expect(held.vm).toMatchObject({
        ...original,
        phase,
        leaseOwner: expect.any(String),
      });
      const poll = () => prewarmStatus(server, operationId);
      const pending = async () => {
        const current = await poll();
        expect(current.status).toBe(200);
        expect(await current.json()).toEqual({ state: 'starting' });
      };
      await pending();
      release.resolve();
      await Promise.race([
        releaseWritten.promise,
        joined.promise.then(() => {
          throw Error('prewarm joined before observing its release write');
        }),
      ]);
      const written = await f.readCoordination();
      // The handler has RETURNING's candidate. An independent PG snapshot
      // still sees the old exact owner until COMMIT becomes visible.
      f.readCoordination
        .mockResolvedValueOnce(held)
        .mockResolvedValueOnce(held);
      await pending();
      expect(written.vm).toMatchObject({
        ...original,
        phase,
        leaseOwner: null,
        rowVersion: expect.any(String),
      });
      await pending();
      for (const stale of [
        { rowVersion: randomUUID() },
        { leaseOwner: randomUUID() },
      ]) {
        f.readCoordination.mockResolvedValueOnce({
          ...written,
          vm: { ...written.vm!, ...stale },
        });
        expect((await poll()).status).toBe(410);
      }
      allowUnlock.resolve();
      await ending.promise;
      if (join === 'joined') await pending();
      else {
        if (join === 'rolled back')
          f.readCoordination.mockResolvedValueOnce(held);
        expect((await poll()).status).toBe(410);
      }
    } finally {
      release.resolve();
      allowUnlock.resolve();
      allowEnd.resolve();
    }
    await joined.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const failed = await prewarmStatus(server, operationId);
    if (join !== 'joined') {
      expect(failed.status).toBe(410);
      expect(await failed.json()).toEqual({ state: 'expired' });
      expect(f.vm).toHaveBeenCalledOnce();
      expect(proof).not.toHaveBeenCalled();
      return;
    }
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({
      state: 'failed',
      code: 'START_UNAVAILABLE',
    });
    const row = (await f.h.store.read(identity.personId))!;
    expect(row).toMatchObject({ ...original, phase, leaseOwner: null });
    expect(f.base.authorityClose).not.toHaveBeenCalled();
    expect(verifyThread).toHaveBeenCalled();
    for (const facts of [
      { leaseOwner: randomUUID() },
      { leaseEpoch: original.leaseEpoch + 1 },
    ]) {
      f.readCoordination.mockResolvedValueOnce({
        authorityRevision: 'release-1',
        vm: { ...row, ...facts },
      });
      expect((await prewarmStatus(server, operationId)).status).toBe(410);
    }
    f.base.identityRevoked.abort(new DataAccessError('authorization_denied'));
    expect((await prewarmStatus(server, operationId)).status).toBe(410);
    expect(f.vm).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
    expect(proof).not.toHaveBeenCalled();
  },
);

it('expires a failed orphan ticket when another Worker claims and releases the same predecessor', async () => {
  const f = fixture(true);
  const { body, context } = f.base;
  const original = await seedOrphanedStart(f);
  const native = vi.spyOn(f.h.native, 'status').mockResolvedValue('unknown');
  const secondService = new PersonVmService(f.h.options);
  const secondPrewarm = vi.spyOn(secondService, 'prewarm');
  const secondWorker = createDEntryNativePrewarmPort({
    prewarmCurrent: (rc, _identity, input, active) =>
      secondService.prewarm(rc, input, active),
    lifetime: f.lifetime.signal,
    readCoordination: f.readCoordination,
  });
  cleanups.push(secondWorker.close);
  const a = await nativeEntryServer(f.base, {
    ...f.base.deps,
    prewarm: f.assembly.port,
  });
  cleanups.push(a.close);
  const b = await nativeEntryServer(f.base, {
    ...f.base.deps,
    prewarm: secondWorker.port,
  });
  cleanups.push(b.close);
  async function fail(server: typeof a) {
    const accepted = await server.request('native-prewarm', {
      ...body,
      trigger: 'page',
    });
    expect(accepted.status).toBe(202);
    const operationId = (await accepted.json()).ticket.operationId;
    await vi.waitFor(async () => {
      const status = await prewarmStatus(server, operationId);
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({
        state: 'failed',
        code: 'START_UNAVAILABLE',
      });
    });
    return operationId;
  }
  const first = await fail(a);
  const firstRelease = await f.h.store.read(context.actor.id);
  expect(firstRelease).toMatchObject({
    ...original,
    phase: 'starting',
    leaseOwner: null,
  });
  // Worker A never polls during B's claim. A must see the changed durable
  // release even if B returns the row to the same visible phase and binding.
  const second = await fail(b);
  expect(second).not.toBe(first);
  expect(await f.h.store.read(context.actor.id)).toMatchObject(firstRelease!);
  const old = await prewarmStatus(a, first);
  expect(old.status).toBe(410);
  expect(await old.json()).toEqual({ state: 'expired' });
  const latest = await prewarmStatus(b, second);
  expect(latest.status).toBe(200);
  expect(await latest.json()).toEqual({
    state: 'failed',
    code: 'START_UNAVAILABLE',
  });
  expect(native).toHaveBeenCalledTimes(2);
  expect(f.vm).toHaveBeenCalledOnce();
  expect(secondPrewarm).toHaveBeenCalledOnce();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
});

it.each([
  ['thread', 'later generation'],
  ['no thread', 'expiry'],
  ['thread', 'original ready'],
  ['thread', 'original failed'],
  ['thread', 'expiry closes observer'],
  ['thread', 'probe failed at expiry'],
  ['thread', 'genuine revocation'],
] as const)(
  'rechecks a duplicate POST at reply time with %s and %s',
  async (selectionKind, outcome) => {
    const withThread = selectionKind === 'thread';
    const f = fixture(true, withThread);
    const { context, identity } = f.base;
    const predecessor = await seedOrphanedStart(f);
    const startEntered = deferred<void>();
    const releaseStart = deferred<void>();
    const replyEntered = deferred<void>();
    const releaseReply = deferred<void>();
    const oldStatus = f.h.native.status.bind(f.h.native);
    let stopAtReply = false;
    let observerClosed = false;
    const observerClosing = deferred<void>();
    const finishObserverClose = deferred<void>();
    const deadline =
      outcome === 'expiry closes observer' ||
      outcome === 'probe failed at expiry'
        ? new AbortController()
        : undefined;
    if (deadline) {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
        ms === 10 * 60_000 ? deadline.signal : timeout(ms),
      );
      f.base.authorityClose.mockImplementationOnce(async () => {
        observerClosed = true;
        observerClosing.resolve();
        await finishObserverClose.promise;
      });
    }
    vi.spyOn(f.h.native, 'status').mockImplementationOnce(
      async (binding, active) => {
        startEntered.resolve();
        await releaseStart.promise;
        return outcome === 'original failed'
          ? 'unknown'
          : oldStatus(binding, active);
      },
    );
    async function waitBeforeReply() {
      replyEntered.resolve();
      await releaseReply.promise;
    }
    if (withThread) {
      const watch = f.base.deps.watch.getMockImplementation()!;
      f.base.deps.watch.mockImplementation(async () => ({
        ...(await watch()),
        async assertTicketThread(active: AbortSignal) {
          if (stopAtReply) {
            stopAtReply = false;
            await waitBeforeReply();
            if (outcome === 'probe failed at expiry')
              throw Error('fixture authority marker failed');
          }
          active.throwIfAborted();
          f.base.identityRevoked.signal.throwIfAborted();
          if (observerClosed) throw new DEntryTicketObserverClosed();
        },
      }));
    }
    const server = await nativeEntryServer(f.base, {
      ...f.base.deps,
      prewarm: f.assembly.port,
    });
    cleanups.push(server.close);
    const { threadId, ...selection } = f.base.body.selection;
    const post = () =>
      server.request('native-prewarm', {
        organizationId: identity.organizationId,
        selection: { ...selection, ...(threadId && { threadId }) },
        trigger: 'page',
      });
    const accepted = await post();
    expect(accepted.status).toBe(202);
    const ticket = (await accepted.json()).ticket;
    let duplicate: Promise<Response> | undefined;
    try {
      await startEntered.promise;
      expect(await f.h.store.read(identity.personId)).toMatchObject({
        ...predecessor,
        phase: 'starting',
        leaseOwner: expect.any(String),
      });
      if (withThread) stopAtReply = true;
      else {
        // The first authentication/selection passes. Hold the same late
        // current identity read that threadless requests use before writing.
        f.base.deps.identity
          .mockResolvedValueOnce(identity)
          .mockImplementationOnce(async () => {
            await waitBeforeReply();
            return identity;
          });
      }
      duplicate = post();
      await Promise.race([
        replyEntered.promise,
        duplicate.then(() => {
          throw Error('duplicate replied before its final-check barrier');
        }),
      ]);
      expect(f.vm).toHaveBeenCalledOnce();
      expect(f.base.deps.watch).toHaveBeenCalledOnce();
      const poll = () => prewarmStatus(server, ticket.operationId);
      if (outcome !== 'expiry') {
        releaseStart.resolve();
        await vi.waitFor(async () => {
          const status = await poll();
          expect(status.status).toBe(200);
          expect(await status.json()).toEqual(
            outcome === 'original failed'
              ? { state: 'failed', code: 'START_UNAVAILABLE' }
              : { state: 'ready' },
          );
        });
      }
      if (outcome === 'later generation') {
        f.h.states.set(predecessor.vmId, 'stopped');
        await f.h.service.stop(context, signal());
        await f.h.service.start(context, signal());
        expect(await f.h.service.resolve(context, signal())).toMatchObject({
          vmId: predecessor.vmId,
          leaseEpoch: predecessor.leaseEpoch + 2,
        });
      }
      if (deadline) {
        deadline.abort(
          new DOMException('fixture timer elapsed', 'TimeoutError'),
        );
        await observerClosing.promise;
        expect(f.base.authorityClose).toHaveBeenCalledOnce();
      }
      if (outcome === 'genuine revocation')
        f.base.identityRevoked.abort(
          new DataAccessError('authorization_denied'),
        );
      const clock =
        outcome === 'expiry'
          ? vi
              .spyOn(Date, 'now')
              .mockReturnValue(Date.parse(ticket.expiresAt) + 1)
          : undefined;
      try {
        releaseReply.resolve();
        const response = await duplicate;
        if (
          outcome === 'later generation' ||
          outcome === 'expiry' ||
          outcome === 'expiry closes observer'
        ) {
          expect(response.status).toBe(410);
          expect(await response.json()).toEqual({ state: 'expired' });
          expect((await poll()).status).toBe(410);
        } else if (outcome === 'genuine revocation') {
          expect(response.status).toBe(404);
        } else if (outcome === 'probe failed at expiry') {
          expect(response.status).toBe(503);
        } else {
          expect(response.status).toBe(202);
          expect((await response.json()).ticket).toEqual(ticket);
        }
      } finally {
        clock?.mockRestore();
      }
      expect(f.vm).toHaveBeenCalledOnce();
      expect(f.base.deps.watch).toHaveBeenCalledOnce();
      expect(f.start).toHaveBeenCalledTimes(
        outcome === 'later generation'
          ? 2
          : outcome === 'original failed' || outcome === 'expiry'
            ? 0
            : 1,
      );
    } finally {
      releaseStart.resolve();
      releaseReply.resolve();
      finishObserverClose.resolve();
      await duplicate;
    }
  },
);

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

it('shares one hot ticket when concurrent running-editor probes both fall back', async () => {
  const f = fixture();
  const pageProbe = deferred<void>();
  const inputProbe = deferred<void>();
  const allowPageFallback = deferred<void>();
  const allowInputFallback = deferred<void>();
  const started = deferred<void>();
  const ready = deferred<AbortSignal>();
  const confirmRunning = vi
    .fn<NonNullable<DEntryNativePrewarmPort['confirmRunning']>>()
    .mockImplementationOnce(async () => {
      pageProbe.resolve();
      await allowPageFallback.promise;
      return undefined;
    })
    .mockImplementationOnce(async () => {
      inputProbe.resolve();
      await allowInputFallback.promise;
      return undefined;
    });
  const prewarm = vi.fn(() => {
    started.resolve();
    return ready.promise;
  });
  const server = await nativeEntryServer(f.base, {
    ...f.base.deps,
    prewarm: {
      confirmRunning,
      isCurrent: async () => true,
      prepare: async () => ({
        key: 'same-running-editor',
        target: f.base.binding,
        running: true,
      }),
      prewarm,
    },
  });
  cleanups.push(server.close);
  const post = (trigger: 'page' | 'input') =>
    server.request('native-prewarm', { ...f.base.body, trigger });
  try {
    const page = post('page');
    await pageProbe.promise;
    const input = post('input');
    await inputProbe.promise;
    allowPageFallback.resolve();
    await started.promise;
    allowInputFallback.resolve();
    const [pageReply, inputReply] = await Promise.all([page, input]);
    expect(pageReply.status).toBe(202);
    expect(inputReply.status).toBe(202);
    const accepted = await pageReply.json();
    expect(await inputReply.json()).toMatchObject({ ticket: accepted.ticket });
    expect(prewarm).toHaveBeenCalledOnce();
  } finally {
    allowPageFallback.resolve();
    allowInputFallback.resolve();
    ready.resolve(signal());
  }
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

it('keeps a live slot ticket failed when local editor proof has no physical receipt', async () => {
  const f = fixture(true);
  const { context, body, data, binding } = f.base;
  await f.h.service.prewarm(context, { trigger: 'page' }, signal());
  f.h.setReadiness({ authenticated: true, editorReady: false, canSend: false });
  const proof = vi.fn(async () => new AbortController().signal);
  const uninstall = installDEntryNativeDataPort({
    ...data,
    assertEditorReady: proof,
  });
  cleanups.push(async () => uninstall());
  const slotted = vi.fn(() => true);
  const prewarm = vi.fn(f.prewarmCurrent);
  const installed = installDEntryNativePrewarm({
    prewarmCurrent: prewarm,
    lifetime: f.lifetime.signal,
    requireEditorProof: true,
    readCoordination: f.readCoordination,
    isLiveSlottedBinding: slotted,
  });
  cleanups.push(installed.close);
  const server = await nativeEntryServer(f.base);
  cleanups.push(server.close);
  const ping = vi.spyOn(f.h.native, 'ping');
  const response = await server.request('native-prewarm', {
    ...body,
    trigger: 'page',
  });
  expect(response.status).toBe(202);
  const { ticket } = await response.json();
  expect(
    await (await prewarmStatus(server, ticket.operationId)).json(),
  ).toEqual({
    state: 'failed',
    code: 'START_UNAVAILABLE',
  });
  expect(slotted).toHaveBeenCalledWith(
    expect.objectContaining({
      personId: binding.personId,
      organizationId: binding.organizationId,
    }),
  );
  expect(proof).toHaveBeenCalledOnce();
  expect(ping).not.toHaveBeenCalled();
  expect(prewarm).not.toHaveBeenCalled();
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
      reconcileStoppedEntry: (context, _identity, binding, signal, retained) =>
        f.h.service.reconcileStoppedEntryForPrewarm(
          context,
          binding,
          signal,
          retained,
        ),
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

it.each([false, true])(
  'checks the current target after the hot reply budget and joins a slow readiness read on shutdown (target changed: %s)',
  async (changed) => {
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
          if (mode === 'issue' && checking && changed) return false;
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
      expect(checking?.aborted).toBe(true);
      expect(prewarm).toHaveBeenCalledOnce();
      if (changed) {
        expect(reply.status).toBe(410);
        expect(await reply.json()).toEqual({ state: 'expired' });
      } else {
        expect(reply.status).toBe(202);
        const { ticket } = await reply.json();
        expect(
          await (await prewarmStatus(server, ticket.operationId)).json(),
        ).toEqual({ state: 'ready' });
      }
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
  },
);

it.each([
  ['ready read', false],
  ['ready read', true],
  ['thread observer', false],
] as const)(
  'bounds a duplicate hot POST with a slow %s and joins the probe (target changed: %s)',
  async (slow, changed) => {
    const f = fixture();
    const proof = deferred<AbortSignal>();
    const secondIssue = deferred<void>();
    const probing = deferred<AbortSignal>();
    const finishProbe = deferred<void>();
    const prewarm = vi.fn(() => proof.promise);
    const watch = f.base.deps.watch.getMockImplementation()!;
    let duplicate = false;
    const originalThread = vi.fn(async (active: AbortSignal) => {
      if (duplicate && slow === 'thread observer') {
        probing.resolve(active);
        await finishProbe.promise;
      }
    });
    const currentThread = vi.fn(async (active: AbortSignal) => {
      active.throwIfAborted();
    });
    f.base.deps.watch
      .mockImplementationOnce(async () => ({
        ...(await watch()),
        assertTicketThread: originalThread,
      }))
      .mockImplementationOnce(async () => ({
        ...(await watch()),
        assertTicketThread: currentThread,
      }));
    const check = vi.fn<NonNullable<DEntryNativePrewarmPort['isCurrent']>>(
      async (_context, _identity, _plan, active, mode, purpose) => {
        if (duplicate && mode === 'issue' && purpose === undefined)
          secondIssue.resolve();
        if (
          mode === 'ready' &&
          purpose === 'publish' &&
          slow === 'ready read'
        ) {
          probing.resolve(active);
          await finishProbe.promise; // Simulate a read that has not joined on abort.
        }
        return !(mode === 'waiting' && purpose === 'publish' && changed);
      },
    );
    const server = await nativeEntryServer(f.base, {
      ...f.base.deps,
      prewarm: {
        prepare: async () => ({
          key: 'same-running-vm',
          target: f.base.binding,
          running: true,
        }),
        isCurrent: check,
        prewarm,
      },
    });
    let closing: Promise<void> | undefined;
    try {
      const body = { ...f.base.body, trigger: 'page' };
      const first = await server.request('native-prewarm', body);
      expect(first.status).toBe(202);
      const { ticket } = await first.json();
      duplicate = true;
      const responding = server.request('native-prewarm', body);
      await secondIssue.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      proof.resolve(signal());
      const active = await probing.promise;
      const response = await responding;
      expect(active.aborted).toBe(true);
      if (changed) {
        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({ state: 'expired' });
      } else {
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({ ticket });
      }
      expect(prewarm).toHaveBeenCalledOnce();
      expect(currentThread).toHaveBeenCalledTimes(2);
      expect(
        check.mock.calls.filter(
          (call) => call[4] === 'waiting' && call[5] === 'publish',
        ),
      ).toHaveLength(1);
      expect(
        check.mock.calls.filter(
          (call) => call[4] === 'ready' && call[5] === 'publish',
        ),
      ).toHaveLength(slow === 'ready read' ? 1 : 0);
      expect(originalThread).toHaveBeenCalledTimes(2);

      let joined = false;
      closing = server.close().then(() => {
        joined = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(joined).toBe(false);
    } finally {
      proof.resolve(signal());
      finishProbe.resolve();
      await (closing ?? server.close());
    }
  },
);

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

it.each(['cancel', 'dispatch', 'cleanup failure'] as const)(
  'exposes the owned capacity wait and only cancels before dispatch (%s)',
  async (outcome) => {
    const f = fixture();
    const queued = deferred<void>();
    const advance = deferred<void>();
    const dispatched = deferred<void>();
    const aborted = deferred<void>();
    const joined = deferred<void>();
    let owned: AbortSignal | undefined;
    let waitingCurrent = true;
    const otherToken = 'other_valid_login_token';
    const otherLogin = { ...f.base.context, sessionId: randomUUID() };
    const prewarm: DEntryNativePrewarmPort['prewarm'] = async (
      _context,
      _identity,
      _trigger,
      active,
      _revoked,
      _plan,
      reportCapacity,
    ) => {
      owned = active;
      active.addEventListener('abort', () => aborted.resolve(), { once: true });
      reportCapacity?.(4);
      queued.resolve();
      await Promise.race([advance.promise, aborted.promise]);
      if (!active.aborted) {
        reportCapacity?.(undefined);
        dispatched.resolve();
      }
      await joined.promise;
      if (outcome === 'cleanup failure') throw Error('Join unconfirmed');
      active.throwIfAborted();
    };
    const server = await nativeEntryServer(f.base, {
      ...f.base.deps,
      authenticate: async (token) =>
        token === otherToken ? otherLogin : f.base.context,
      prewarm: {
        isCurrent: async (_context, _identity, _plan, _signal, mode) =>
          mode !== 'waiting' || waitingCurrent,
        prepare: async () => ({ key: 'exact-wait', target: f.base.binding }),
        prewarm,
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
      const id = ticket.operationId;
      await queued.promise;
      const status = await prewarmStatus(server, id);
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({
        state: 'waiting_for_capacity',
        activeLimit: 4,
      });
      for (const method of ['GET', 'DELETE'] as const) {
        const foreign = await prewarmStatus(server, id, otherToken, method);
        expect(foreign.status).toBe(410);
        expect(await foreign.json()).toEqual({ state: 'expired' });
      }
      waitingCurrent = false;
      for (const method of ['GET', 'DELETE'] as const) {
        const guarded = await prewarmStatus(server, id, undefined, method);
        expect(guarded.status).toBe(200);
        expect(await guarded.json()).toEqual({ state: 'starting' });
      }
      waitingCurrent = true;
      expect(owned?.aborted).toBe(false);
      if (outcome === 'dispatch') {
        advance.resolve();
        await dispatched.promise;
        const ignored = await prewarmStatus(server, id, undefined, 'DELETE');
        expect(await ignored.json()).toEqual({ state: 'starting' });
        expect(owned?.aborted).toBe(false);
      } else {
        let answered = false;
        const cancelling = prewarmStatus(server, id, undefined, 'DELETE').then(
          (response) => {
            answered = true;
            return response;
          },
        );
        await aborted.promise;
        expect(answered).toBe(false);
        expect(f.base.authorityClose).not.toHaveBeenCalled();
        joined.resolve();
        const cancelled = await cancelling;
        if (outcome === 'cleanup failure') {
          expect(cancelled.status).toBe(503);
          expect(
            (
              await server.request(
                'native-prewarm',
                {
                  ...f.base.body,
                  trigger: 'page',
                },
                { authorization: `Bearer ${otherToken}` },
              )
            ).status,
          ).toBe(202);
          expect(
            (await prewarmStatus(server, id, undefined, 'DELETE')).status,
          ).toBe(503);
        } else {
          expect(cancelled.status).toBe(410);
          expect(await cancelled.json()).toEqual({ state: 'expired' });
        }
        expect(f.base.authorityClose).toHaveBeenCalled();
        expect((await prewarmStatus(server, id)).status).toBe(410);
      }
    } finally {
      advance.resolve();
      joined.resolve();
    }
  },
);

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
      ).toBe(410);
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
