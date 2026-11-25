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
    vm = vi.spyOn(h.service, 'prewarm'),
    start = vi.spyOn(h.runtime, 'start'),
    stop = vi.spyOn(h.native, 'stop');
  authority.identity.mockResolvedValue(base.identity);
  // Explicit fixture adapter; production must use the shared H1 authority owner.
  const prewarmCurrent: CurrentSelectionPrewarm = (...args) =>
    h.service.prewarm(args[0], args[2], args[3]);
  const readCoordination = vi.fn(async () => ({
    policyRevision: 'release-1',
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

it('joins a later request on the published starting epoch and proves readiness for each valid waiter', async () => {
  const f = fixture(true);
  const entered = deferred<void>();
  const release = deferred<void>();
  const original = f.start.getMockImplementation()!;
  const leader = new AbortController();
  const follower = { ...f.base.context, requestId: randomUUID() };
  const prove = vi.fn(async () => signal());
  cleanups.push(async () => {
    release.resolve();
  });
  const uninstall = installDEntryNativeDataPort({
    ...f.base.data,
    assertEditorReady: prove,
  });
  cleanups.push(async () => uninstall());
  f.start.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  const prewarm = (
    context: typeof f.base.context,
    trigger: 'page' | 'input',
    revoked: AbortSignal,
  ) =>
    f.assembly.port.prewarm(
      context,
      f.base.identity,
      trigger,
      signal(),
      revoked,
    );
  const first = prewarm(f.base.context, 'page', leader.signal);
  const outcomes = Promise.allSettled([first]);
  await entered.promise;
  let second: Promise<AbortSignal | void> | undefined;
  try {
    expect(await f.h.store.read(f.base.identity.personId)).toMatchObject({
      phase: 'starting',
      leaseEpoch: 1,
    });
    second = prewarm(follower, 'input', signal());
    void second.catch(() => {});
    await vi.waitFor(() => expect(f.readCoordination).toHaveBeenCalledTimes(2));
    expect(f.vm).toHaveBeenCalledTimes(1);
    leader.abort(new DataAccessError('authorization_denied'));
    expect(f.vm.mock.calls[0]![2].aborted).toBe(false);
  } finally {
    release.resolve();
    await outcomes;
    await second?.catch(() => {});
  }
  await expect(first).rejects.toBe(leader.signal.reason);
  await expect(second).resolves.toBeInstanceOf(AbortSignal);
  expect(f.vm).toHaveBeenCalledTimes(1);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(prove).toHaveBeenCalledExactlyOnceWith(
    follower,
    f.base.identity,
    expect.any(AbortSignal),
  );
  expect(f.stop).not.toHaveBeenCalled();
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

it('fails closed if the policy revision changes before confirming a shared result', async () => {
  const f = fixture(true);
  f.readCoordination.mockImplementationOnce(async () => ({
    policyRevision: 'pending',
    vm: null,
  }));
  const run = () =>
    f.assembly.port.prewarm(
      f.base.context,
      f.base.identity,
      'page',
      signal(),
      signal(),
    );
  await expect(run()).rejects.toMatchObject({ code: 'LEASE_LOST' });
  await expect(run()).resolves.toBeUndefined();
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
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    identity: f.base.identity,
    trigger: 'page',
  });
  expect(f.base.deps.owners.resolve).not.toHaveBeenCalled();
  expect(f.base.data.acquireRoot).not.toHaveBeenCalled();
  expect(f.base.data.acquireRpc).not.toHaveBeenCalled();
  expect((await server.request()).status).toBe(503);
  expect((await server.request('native-root')).status).toBe(503);
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('rejects the prewarm reply if the model route retires during final HTTP qualification', async () => {
  const f = fixture();
  const route = new AbortController();
  const entered = deferred<void>();
  const release = deferred<void>();
  const server = await nativeEntryServer(f.base, {
    ...f.base.deps,
    prewarm: { prewarm: async () => route.signal },
  });
  cleanups.push(server.close);
  f.base.deps.identity
    .mockResolvedValueOnce(f.base.identity)
    .mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return f.base.identity;
    });
  const request = server.request('native-prewarm', {
    ...f.base.body,
    trigger: 'page',
  });
  await entered.promise;
  route.abort();
  release.resolve();
  expect((await request).status).toBe(503);
});

it('browser disconnect through real HTTP does not cancel shared physical startup or close its authority watcher early', async () => {
  const f = fixture(),
    started = deferred<void>(),
    finish = deferred<void>(),
    disconnected = deferred<void>(),
    caller = new AbortController(),
    original = f.runPrewarm;
  const installed = installDEntryNativePrewarm({
    prewarmCurrent: f.prewarmCurrent,
    lifetime: f.lifetime.signal,
  });
  cleanups.push(installed.close);
  let physical: AbortSignal | undefined,
    completion: Promise<unknown> | undefined;
  const delegate = dEntryNativePrewarmPort.prewarm;
  vi.spyOn(dEntryNativePrewarmPort, 'prewarm').mockImplementation((...args) => {
    args[3].addEventListener('abort', () => disconnected.resolve(), {
      once: true,
    });
    const task = delegate(...args);
    completion = task.catch((error: unknown) => error);
    return task;
  });
  const watch = vi.fn<typeof Database.watchDEntryNativeAuthority>(
    async (...args) => {
      const subscription = await f.base.deps.watch();
      return {
        ...subscription,
        revoked: AbortSignal.any([subscription.revoked, args[3]]),
      };
    },
  );
  f.vm.mockImplementationOnce(async (...args) => {
    physical = args[2];
    started.resolve();
    await finish.promise;
    expect(args[2].aborted).toBe(false);
    return original(...args);
  });
  const server = await nativeEntryServer(f.base, { ...f.base.deps, watch });
  cleanups.push(server.close);
  const request = fetch(`${server.origin}/internal/d-entry/native-prewarm`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer original_session_opaque_token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...f.base.body, trigger: 'page' }),
    signal: caller.signal,
  }).catch((error: unknown) => error);
  await started.promise;
  try {
    caller.abort();
    expect(await request).toBeInstanceOf(Error);
    await disconnected.promise;
    expect(watch.mock.calls[0]![3].aborted).toBe(false);
    expect(physical?.aborted).toBe(false);
    expect(f.base.authorityClose).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
  }
  expect(completion).toBeDefined();
  expect(await completion).toBeInstanceOf(Error);
  await server.close();
  expect(f.base.authorityClose).toHaveBeenCalledTimes(1);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.stop).not.toHaveBeenCalled();
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
