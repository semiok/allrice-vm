import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import {
  createCommandMemoryCleanup,
  createCommandMemoryPresentation,
  protectCommandMemorySandbox,
} from './dsh-command-memory.mjs';

function observation(cleanupTimeoutMs = 500, mark = () => {}) {
  const done = Promise.withResolvers();
  const quiescent = Promise.withResolvers();
  const reported = Promise.withResolvers();
  const report = vi.fn(reported.resolve);
  const cleanup = createCommandMemoryCleanup(cleanupTimeoutMs, report);
  const native = {
    done: done.promise,
    waitForExit: vi.fn(() => quiescent.promise),
    terminate: vi.fn(),
  };
  const owner = {
    observe: vi.fn(() => ({
      receipt: { baseline: { oomKill: '0' } },
      after: { oomKill: '1' },
    })),
    release: vi.fn(() => ({
      released: true,
      evidence: { childReleased: true },
    })),
  };
  const onOom = vi.fn(mark);
  const attempt = {
    handle: native,
    owner,
    ref: 'owned-ref',
    jobId: 'native-job',
  };
  const outcome = { exitCode: 0, signal: null };
  cleanup.track(attempt, onOom);
  return {
    native,
    owner,
    onOom,
    outcome,
    cleanup,
    done,
    quiescent,
    report,
    reported,
  };
}

it('follows the native descendant range through natural exit after a direct command has returned', async () => {
  const f = observation(10);
  f.done.resolve(f.outcome);
  await vi.waitFor(() =>
    expect(f.native.waitForExit).toHaveBeenCalledExactlyOnceWith(undefined),
  );
  expect(f.onOom).toHaveBeenCalledOnce();
  await delay(20);
  expect(f.owner.release).not.toHaveBeenCalled();
  f.quiescent.resolve(true);
  expect(await f.reported.promise).toMatchObject({
    outcome: f.outcome,
    released: true,
  });
  await f.cleanup.close();
  expect(f.native.terminate).not.toHaveBeenCalled();
  expect(f.owner.release).toHaveBeenCalledOnce();
});

it('bounds disposal without losing the same in-flight join and receipt owner', async () => {
  const f = observation(20);
  f.done.resolve(f.outcome);
  await vi.waitFor(() => expect(f.native.waitForExit).toHaveBeenCalledOnce());
  await expect(f.cleanup.close()).rejects.toThrow(
    'COMMAND_MEMORY_CLEANUP_INCOMPLETE',
  );
  expect(f.native.terminate).toHaveBeenCalledOnce();
  expect(f.owner.release).not.toHaveBeenCalled();
  f.quiescent.resolve(true);
  expect(await f.reported.promise).toMatchObject({ released: true });
  expect(f.native.waitForExit).toHaveBeenCalledOnce();
  expect(f.owner.release).toHaveBeenCalledOnce();
});

it('retries an unsuccessful release on disposal using the joined ownership once', async () => {
  const f = observation();
  f.owner.release.mockImplementationOnce(() => {
    throw new Error('receipt not released');
  });
  f.done.resolve(f.outcome);
  f.quiescent.resolve(true);
  expect(await f.reported.promise).toMatchObject({ released: false });
  await f.cleanup.close();
  expect(f.native.waitForExit).toHaveBeenCalledOnce();
  expect(f.owner.release).toHaveBeenCalledTimes(2);
  expect(f.report.mock.calls.map(([proof]) => proof.released)).toEqual([
    false,
    true,
  ]);
});

it('shares memcg observation after native join with disposal and releases it once', async () => {
  const f = observation();
  const empty = Promise.withResolvers();
  f.owner.release.mockImplementation(() => empty.promise);
  f.done.resolve(f.outcome);
  await vi.waitFor(() => expect(f.native.waitForExit).toHaveBeenCalledOnce());
  expect(f.owner.release).not.toHaveBeenCalled();
  f.quiescent.resolve(true);
  await vi.waitFor(() =>
    expect(f.owner.release).toHaveBeenCalledExactlyOnceWith(
      expect.any(globalThis.AbortSignal),
      true,
    ),
  );
  const closing = f.cleanup.close();
  await Promise.resolve();
  expect(f.native.terminate).not.toHaveBeenCalled();
  expect(f.owner.release).toHaveBeenCalledOnce();
  empty.resolve({ released: true, evidence: { childReleased: true } });
  await closing;
  expect(f.report).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ outcome: f.outcome, released: true }),
  );
  expect(f.native.waitForExit).toHaveBeenCalledOnce();
  expect(f.owner.release).toHaveBeenCalledOnce();
});

it('releases a reservation without certifying join when no native handle was created', async () => {
  const reported = Promise.withResolvers();
  const cleanup = createCommandMemoryCleanup(500, reported.resolve);
  const release = vi.fn(() => ({ released: true }));
  cleanup.track({ owner: { release }, ref: 'reservation' }, vi.fn());
  expect(await reported.promise).toMatchObject({
    outcome: null,
    released: true,
  });
  expect(release).toHaveBeenCalledExactlyOnceWith(
    expect.any(globalThis.AbortSignal),
    false,
  );
  await cleanup.close();
});

it('closes a pending memcg observation at the disposal deadline without certifying release', async () => {
  const f = observation(20);
  const watcherClosed = vi.fn();
  f.owner.release.mockImplementation(
    (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            watcherClosed();
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  f.done.resolve(f.outcome);
  f.quiescent.resolve(true);
  await vi.waitFor(() => expect(f.owner.release).toHaveBeenCalledOnce());
  await expect(f.cleanup.close()).rejects.toThrow(
    'COMMAND_MEMORY_CLEANUP_INCOMPLETE',
  );
  expect(watcherClosed).toHaveBeenCalledOnce();
  expect(await f.reported.promise).toMatchObject({
    released: false,
    evidence: { error: 'command-memory-cleanup-unconfirmed' },
  });
  expect(f.native.terminate).not.toHaveBeenCalled();
  expect(f.owner.release).toHaveBeenCalledOnce();
});

it('preserves an explicit 137 without presenting OOM when the observed group count is unchanged', async () => {
  const f = observation();
  const outcome = { exitCode: 137, signal: null };
  f.owner.observe.mockReturnValue({
    receipt: { baseline: { oomKill: '5' } },
    after: { oomKill: '5' },
  });
  f.done.resolve(outcome);
  f.quiescent.resolve(true);
  expect(await f.reported.promise).toMatchObject({ outcome, released: true });
  expect(f.onOom).not.toHaveBeenCalled();
  await f.cleanup.close();
});

function presentation() {
  const session = { header: { id: 'session-one' } };
  const exec = { token: Symbol('exact tool invocation'), agent: { session } };
  const job = {
    id: 'bash-native-job',
    kind: 'bash',
    owner: session.header.id,
    status: 'completed',
  };
  let post, event, dispose;
  const registry = {
    get: vi.fn(() => job),
    events: {
      subscribe: (_filter, cb) => {
        event = cb;
      },
    },
  };
  const ctx = {
    inject: (_deps, cb) =>
      cb({
        jobs: registry,
        effect: (effect) => {
          dispose = effect();
        },
      }),
    on: (_label, cb) => {
      post = cb;
    },
    get: () => registry,
  };
  const mark = createCommandMemoryPresentation(ctx);
  const accept = async () => ({ kind: 'accept' });
  return {
    exec,
    job,
    mark: () => mark({ exec, session }, { jobId: job.id }),
    present: (input, result, next = accept) => post(input, result, next),
    remove: () => event({ type: 'removed', job }),
    dispose: () => dispose(),
  };
}

it('preserves a single native terminal text block, trailing status and canonical spill output', async () => {
  const f = presentation();
  const stderr = Object.freeze({
    text: 'native tail',
    truncated: true,
    spillPath: '/same-native-spill',
  });
  const value = Object.freeze({
    kind: 'foreground',
    exitCode: 137,
    signal: null,
    stderr,
  });
  const native =
    'native tail\n[output truncated; full output: /same-native-spill]\n[exit code: 137]';
  const result = {
    isError: false,
    value,
    content: [{ type: 'text', text: native }],
  };
  const input = { ...f.exec, name: 'bash' };
  expect(await f.present(input, result)).toEqual({ kind: 'accept' });
  f.mark();
  const shown = await f.present(input, result);
  expect(shown.content).toHaveLength(1);
  expect(shown.content[0].text).toMatch(/^命令组记录到 OOM[^\n]*\n/);
  expect(shown.content[0].text.endsWith(native)).toBe(true);
  expect(shown).not.toHaveProperty('value');
  expect(result.value.stderr).toBe(stderr);
  expect(result.content[0].text).toBe(native);
  expect(
    await f.present({ ...input, token: Symbol('other call') }, result),
  ).toEqual({ kind: 'accept' });
});

it.each(['remove', 'dispose'])(
  'shows a background OOM only to the exact owner until native %s',
  async (end) => {
    const f = presentation();
    f.mark();
    const input = { ...f.exec, name: 'job_output' };
    const block = {
      type: 'text',
      text: 'raw native job output\n[completed] [full output: /same-native-spill]',
    };
    const result = {
      isError: false,
      value: { job: f.job, text: block.text },
      content: [block],
    };
    expect(
      (await f.present(input, result)).content[0].text.endsWith(block.text),
    ).toBe(true);
    expect((await f.present(input, result)).content[0].text).toContain(
      '命令组记录到 OOM',
    );
    expect(
      await f.present({ ...input, agent: { session: {} } }, result),
    ).toEqual({ kind: 'accept' });
    f[end]();
    expect(await f.present(input, result)).toEqual({ kind: 'accept' });
  },
);

it('presents a late joined descendant OOM in the retained job without changing the direct exit', async () => {
  const view = presentation();
  const f = observation(500, view.mark);
  const counters = (oomKill) => ({
    receipt: { baseline: { oomKill: '0' } },
    after: { oomKill },
  });
  const output = {
    isError: false,
    value: { job: view.job },
    content: [{ type: 'text', text: 'native status: completed' }],
  };
  const read = () => view.present({ ...view.exec, name: 'job_output' }, output);
  f.owner.observe.mockReturnValue(counters('0'));
  f.owner.release.mockReturnValue({ released: true, evidence: counters('1') });
  f.done.resolve(f.outcome);
  await vi.waitFor(() => expect(f.native.waitForExit).toHaveBeenCalledOnce());
  expect(await read()).toEqual({ kind: 'accept' });
  f.quiescent.resolve(true);
  expect(await f.reported.promise).toMatchObject({
    outcome: f.outcome,
    released: true,
  });
  expect((await read()).content[0].text).toMatch(
    /OOM[^\n]*\nnative status: completed/,
  );
  expect(f.onOom).toHaveBeenCalledOnce();
  await f.cleanup.close();
});

it.each([
  ['workspace-write', 'read-only', true],
  ['read-only', 'workspace-write', false],
])(
  'guards the %s native policy independently of a later session change to %s',
  async (mode, later, rejected) => {
    const raw = vi.fn();
    const Provider = protectCommandMemorySandbox(
      class {
        confine(...args) {
          return raw(...args);
        }
      },
      () => true,
    );
    const provider = new Provider();
    const session = { policy: { mode, workspaceRoot: '/' } };
    const nativeSnapshot = session.policy;
    const ready = Promise.withResolvers();
    const pending = ready.promise.then(() =>
      provider.confine(['/bin/true'], nativeSnapshot),
    );
    session.policy = { ...session.policy, mode: later };
    ready.resolve();
    if (rejected) {
      await expect(pending).rejects.toThrow('COMMAND_MEMORY_TRUST_UNCONFIRMED');
      expect(raw).not.toHaveBeenCalled();
    } else {
      await pending;
      expect(raw).toHaveBeenCalledExactlyOnceWith(
        ['/bin/true'],
        nativeSnapshot,
        undefined,
      );
    }
  },
);

it('leaves other native confinement consumers on the original provider semantics', () => {
  const raw = vi.fn();
  const Provider = protectCommandMemorySandbox(
    class {
      confine(...args) {
        return raw(...args);
      }
    },
    () => false,
  );
  const policy = { mode: 'workspace-write', workspaceRoot: '/' };
  new Provider().confine(['/bin/true'], policy);
  expect(raw).toHaveBeenCalledExactlyOnceWith(['/bin/true'], policy, undefined);
});
