import { once } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { DEntryAuthorityObservation } from '@allrice/database';
import { openFollowAuthority } from './follow-authority.js';
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types';
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand';
import {
  deferred,
  summary,
} from '../../../../packages/d-entry-principal/test/host-fixture.js';
import {
  closes,
  fixture,
  messages,
  open,
  send,
} from './principal-page-carrier.fixture.js';

function observe(f: Awaited<ReturnType<typeof fixture>>) {
  const listeners = new Set<() => void>();
  const marker = vi.fn<DEntryAuthorityObservation['observeThroughCommit']>(
    async (signal) => signal.throwIfAborted(),
  );
  const original = f.deps.watch.getMockImplementation()!;
  f.deps.watch.mockImplementation(async () => ({
    ...(await original()),
    observation: {
      subscribe(invalidate) {
        listeners.add(invalidate);
        return () => listeners.delete(invalidate);
      },
      observeThroughCommit: marker,
    },
  }));
  return {
    marker,
    invalidate: () => listeners.forEach((listener) => listener()),
  };
}

function chunk(index: number): SessionFollowFrame {
  return {
    type: 'assistant-stream',
    frame: {
      type: 'chunk',
      attemptId: LlmAttemptId('finite-fixture-attempt'),
      revision: 1,
      index,
      time: 1,
      chunk: String(index),
    },
  };
}

async function connect(f: Awaited<ReturnType<typeof fixture>>) {
  const life = await open(f);
  const peer = f.connect(life.scopeId);
  const next = messages(peer);
  await once(peer, 'open');
  return {
    peer,
    next,
    async follow(sessionId: string, parentSessionId?: string) {
      send(peer, {
        type: 'open',
        streamId: sessionId,
        endpoint: 'session/follow',
        payload: {
          args: {
            request: {
              address: parentSessionId
                ? {
                    kind: 'subagent',
                    childSessionId: sessionId,
                    parentSessionId,
                    mode: 'unknown',
                  }
                : { kind: 'session', sessionId },
            },
          },
        },
      });
      expect(await next(sessionId)).toMatchObject({
        type: 'item',
        value: { type: 'snapshot' },
      });
    },
  };
}

it('removes the serial authorization cost from a long rc.2 WebSocket follow and preserves ordered frames', async () => {
  const records = [];
  for (const observed of [false, true]) {
    const f = await fixture();
    if (observed) observe(f);
    vi.mocked(f.owner.assertCurrent).mockImplementation(async () => {
      await delay(4);
    });
    const ready = deferred();
    f.host.catalog.followFrames = async function* () {
      await ready.promise;
      for (let index = 0; index < 96; index++) yield chunk(index);
    };
    closes.push(async () => ready.resolve());
    const channel = await connect(f);
    await channel.follow('root');
    const reads = vi.mocked(f.owner.assertCurrent).mock.calls.length;
    const start = performance.now();
    ready.resolve();
    for (let index = 0; index < 96; index++) {
      expect(await channel.next('root')).toMatchObject({
        type: 'item',
        value: chunk(index),
      });
    }
    records.push({
      observed,
      elapsedMs: Math.round(performance.now() - start),
      ownerReads: vi.mocked(f.owner.assertCurrent).mock.calls.length - reads,
    });
    channel.peer.close();
    await once(channel.peer, 'close');
  }
  expect(records.map(({ ownerReads }) => ownerReads)).toEqual([96, 0]);
  expect(records[1]!.elapsedMs).toBeLessThan(records[0]!.elapsedMs);
  console.info('session/follow 96 frames with 4ms owner proof', records);
});

it.each(['login revoked', 'lease replaced', 'marker lost'] as const)(
  'joins the exact native follow without forwarding a queued frame on %s',
  async (scenario) => {
    const f = await fixture();
    const observation = observe(f);
    const release = deferred();
    const joined = deferred();
    const rechecking = deferred();
    f.host.catalog.followFrames = async function* () {
      await release.promise;
      yield chunk(0);
    };
    f.host.catalog.afterFollow = async () => joined.resolve();
    closes.push(async () => release.resolve());
    const channel = await connect(f);
    await channel.follow('root');
    const traffic = vi.fn();
    channel.peer.on('message', traffic);
    if (scenario === 'login revoked') {
      f.identityRevoked.abort();
    } else {
      if (scenario === 'lease replaced') {
        f.binding.leaseEpoch++;
        vi.mocked(f.owner.assertCurrent).mockImplementation(async () => {
          rechecking.resolve();
        });
      } else {
        observation.marker.mockImplementation(async () => {
          rechecking.resolve();
          throw Error('fence marker was lost');
        });
      }
      observation.invalidate();
      await rechecking.promise;
    }
    release.resolve();
    await joined.promise;
    await vi.waitFor(() => {
      expect(
        channel.peer.readyState === channel.peer.CLOSED ||
          traffic.mock.calls.some(
            ([raw]) => JSON.parse(String(raw)).type === 'error',
          ),
      ).toBe(true);
    });
    expect(
      traffic.mock.calls.map(([raw]) => JSON.parse(String(raw)).type),
    ).not.toContain('item');
  },
);

it('does not release a queued frame until a harmless hint is verified through the commit marker', async () => {
  const f = await fixture();
  const observation = observe(f);
  const release = deferred();
  f.host.catalog.followFrames = async function* () {
    await release.promise;
    yield chunk(0);
  };
  closes.push(async () => release.resolve());
  const channel = await connect(f);
  await channel.follow('root');
  const atMarker = deferred();
  const committed = deferred();
  closes.push(async () => committed.resolve());
  observation.marker.mockImplementationOnce(async () => {
    atMarker.resolve();
    await committed.promise;
  });
  observation.invalidate();
  await atMarker.promise;
  const traffic = vi.fn();
  channel.peer.on('message', traffic);
  release.resolve();
  await delay(35);
  expect(traffic).not.toHaveBeenCalled();
  committed.resolve();
  expect(await channel.next('root')).toMatchObject({
    type: 'item',
    value: chunk(0),
  });
});

it('fences a removed child before native join and leaves another approved root streaming', async () => {
  const f = await fixture();
  observe(f);
  const release = deferred();
  f.host.catalog.followFrames = async function* () {
    await release.promise;
    yield chunk(0);
  };
  closes.push(async () => release.resolve());
  const channel = await connect(f);
  await channel.follow('child', 'root');
  await channel.follow('other');
  const childId = summary('child', 'root').sessionId;
  f.host.catalog.items = f.host.catalog.items.filter(
    ({ sessionId }) => sessionId !== childId,
  );
  f.host.host.emit('api-session/removed', childId);
  release.resolve();
  const observed = [await channel.next(), await channel.next()];
  expect(observed).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'error', streamId: 'child' }),
      expect.objectContaining({
        type: 'item',
        streamId: 'other',
        value: chunk(0),
      }),
    ]),
  );
});

it('pauses for periodic verification and fails closed on a missed change hint', async () => {
  vi.useFakeTimers();
  const release = deferred();
  const caller = new AbortController();
  const stale = Error('current binding changed without a hint');
  const verify = vi.fn(async () => {});
  let follow: Awaited<ReturnType<typeof openFollowAuthority>> | undefined;
  try {
    follow = await openFollowAuthority(
      { subscribe: () => () => {}, observeThroughCommit: async () => {} },
      caller.signal,
      verify,
    );
    expect(follow.pending()).toBeUndefined();
    verify.mockImplementationOnce(async () => {
      await release.promise;
      throw stale;
    });
    await vi.advanceTimersByTimeAsync(5000);
    const checking = follow.pending();
    expect(checking).toBeInstanceOf(Promise);
    expect(follow.signal.aborted).toBe(false);
    const rejected = expect(checking).rejects.toBe(stale);
    release.resolve();
    await rejected;
    expect(follow.signal.reason).toBe(stale);
    expect(verify).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    await follow?.close();
    vi.useRealTimers();
  }
});

function watchChild(f: Awaited<ReturnType<typeof fixture>>) {
  const pulled = deferred();
  const revoked = deferred();
  const mock = vi.mocked(f.owner.acquirePrincipal);
  const acquire = mock.getMockImplementation()!;
  mock.mockImplementation((...args) => {
    const activity = acquire(...args);
    return {
      ...activity,
      async run(signal) {
        const scope = await activity.run(signal);
        return {
          ...scope,
          streamPage(call, caller) {
            const stream = scope.streamPage(call, caller);
            if (
              call.endpoint !== 'session/follow' ||
              !JSON.stringify(call.args).includes('"childSessionId":"child"')
            )
              return stream;
            stream.revoked?.addEventListener('abort', () => revoked.resolve(), {
              once: true,
            });
            return {
              ...stream,
              async *[Symbol.asyncIterator]() {
                for await (const frame of stream) {
                  if (JSON.stringify(frame.value).includes('"type":"chunk"'))
                    pulled.resolve();
                  yield frame;
                }
              },
            };
          },
        };
      },
    };
  });
  return { pulled, revoked };
}

it.each([true, false])(
  'withdraws an already-buffered child while the DB marker is held (native hint: %s)',
  async (nativeHint) => {
    const f = await fixture();
    const observation = observe(f);
    const watch = watchChild(f);
    const releaseChunk = deferred();
    const atMarker = deferred();
    const releaseMarker = deferred();
    closes.push(async () => {
      releaseChunk.resolve();
      releaseMarker.resolve();
    });
    f.host.catalog.followFrames = async function* (id) {
      if (id !== 'child') return;
      await releaseChunk.promise;
      yield chunk(0);
    };
    const channel = await connect(f);
    await channel.follow('child', 'root');
    await channel.follow('other');
    observation.marker.mockImplementation(async () => {
      atMarker.resolve();
      await releaseMarker.promise;
    });
    observation.invalidate();
    await atMarker.promise;
    releaseChunk.resolve();
    await watch.pulled.promise;
    const child = summary('child', 'root').sessionId;
    f.host.catalog.items = f.host.catalog.items.filter(
      (row) => row.sessionId !== child,
    );
    if (nativeHint) f.host.host.emit('api-session/removed', child);
    await watch.revoked.promise;
    releaseMarker.resolve();
    expect(await channel.next('child')).toMatchObject({
      type: 'error',
      error: { code: 'remote-access/denied' },
    });
    expect(channel.peer.readyState).toBe(channel.peer.OPEN);
  },
  12_000,
);

it('honors browser backpressure and suppresses a child withdrawn before the next send', async () => {
  const f = await fixture();
  observe(f);
  const watch = watchChild(f);
  const firstSend = deferred();
  const finishSend = deferred();
  const releaseChunks = deferred();
  const secondProduced = deferred();
  const sendFrame = WebSocket.prototype.send;
  const spy = vi
    .spyOn(WebSocket.prototype, 'send')
    .mockImplementation(function (this: WebSocket, ...args) {
      const [data, callback] = args;
      if (
        typeof data === 'string' &&
        typeof callback === 'function' &&
        data.includes('"streamId":"child"') &&
        data.includes('"type":"chunk"') &&
        data.includes('"index":0')
      ) {
        Reflect.apply(sendFrame, this, [
          data,
          (error?: Error) => {
            firstSend.resolve();
            void finishSend.promise.then(() =>
              Reflect.apply(callback, undefined, [error]),
            );
          },
        ]);
        return;
      }
      Reflect.apply(sendFrame, this, args);
    });
  closes.push(async () => {
    releaseChunks.resolve();
    finishSend.resolve();
    spy.mockRestore();
  });
  f.host.catalog.followFrames = async function* () {
    await releaseChunks.promise;
    yield chunk(0);
    secondProduced.resolve();
    yield chunk(1);
  };
  const channel = await connect(f);
  await channel.follow('child', 'root');
  releaseChunks.resolve();
  await firstSend.promise;
  expect(await channel.next('child')).toMatchObject({
    type: 'item',
    value: chunk(0),
  });
  await secondProduced.promise;
  const child = summary('child', 'root').sessionId;
  f.host.catalog.items = f.host.catalog.items.filter(
    (row) => row.sessionId !== child,
  );
  f.host.host.emit('api-session/removed', child);
  await watch.revoked.promise;
  finishSend.resolve();
  expect(await channel.next('child')).toMatchObject({
    type: 'error',
    error: { code: 'remote-access/denied' },
  });
});

it.each(['error', 'end'] as const)(
  'keeps watching a finished native child while its final queued frame awaits authority (%s)',
  async (terminal) => {
    const f = await fixture();
    const observation = observe(f);
    const watch = watchChild(f);
    const release = deferred();
    const atMarker = deferred();
    const releaseMarker = deferred();
    const nativeFinished = deferred();
    const nativeClosed = vi.fn();
    closes.push(async () => {
      release.resolve();
      releaseMarker.resolve();
    });
    const wire = f.host.host.typertGateway.wireStream;
    const open = wire.open.bind(wire);
    vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
      const source = await open(...args);
      if (
        args[0] !== 'allricePrincipal/streamScoped' ||
        !JSON.stringify(args[1]).includes('"childSessionId":"child"')
      )
        return source;
      // Like the remote carrier, buffer guest output independently of the
      // Worker's current browser write or database check.
      const buffered = Readable.from(
        (async function* () {
          for await (const frame of source) {
            if (frame && typeof frame === 'object' && 'type' in frame) {
              if (frame.type === `page-${terminal}`) nativeFinished.resolve();
              if (frame.type === 'closed') nativeClosed();
            }
            yield frame;
          }
        })(),
        { highWaterMark: 8 },
      );
      return buffered;
    });
    const child = summary('child', 'root').sessionId;
    if (terminal === 'end') f.host.catalog.finishFollow = child;
    f.host.catalog.followFrames = async function* (id) {
      if (id !== child) return;
      await release.promise;
      yield chunk(0);
      if (terminal === 'error') throw Error('fixture native sequence gap');
    };
    const channel = await connect(f);
    await channel.follow('child', 'root');
    await channel.follow('other');
    observation.marker.mockImplementation(async () => {
      atMarker.resolve();
      await releaseMarker.promise;
    });
    observation.invalidate();
    await atMarker.promise;
    release.resolve();
    await Promise.all([watch.pulled.promise, nativeFinished.promise]);
    expect(nativeClosed).not.toHaveBeenCalled();
    f.host.catalog.items = f.host.catalog.items.filter(
      (row) => row.sessionId !== child,
    );
    f.host.host.emit('api-session/removed', child);
    await watch.revoked.promise;
    releaseMarker.resolve();
    expect(await channel.next('child')).toMatchObject({
      type: 'error',
      error: { code: 'remote-access/denied' },
    });
    await vi.waitFor(() => expect(nativeClosed).toHaveBeenCalledTimes(1));
    expect(channel.peer.readyState).toBe(channel.peer.OPEN);
  },
);

it('drains a normally completed follow and joins its close before reporting end', async () => {
  const f = await fixture();
  observe(f);
  const release = deferred();
  const joined = vi.fn();
  closes.push(async () => release.resolve());
  f.host.catalog.finishFollow = summary('root').sessionId;
  f.host.catalog.followFrames = async function* () {
    await release.promise;
    yield chunk(0);
  };
  f.host.catalog.afterFollow = async () => joined();
  const channel = await connect(f);
  await channel.follow('root');
  release.resolve();
  expect(await channel.next('root')).toMatchObject({
    type: 'item',
    value: chunk(0),
  });
  expect(await channel.next('root')).toMatchObject({ type: 'end' });
  expect(joined).toHaveBeenCalledTimes(1);
});

it('refuses to follow on an owner that cannot report native child withdrawal', async () => {
  const f = await fixture();
  observe(f);
  const mock = vi.mocked(f.owner.acquirePrincipal);
  const acquire = mock.getMockImplementation()!;
  mock.mockImplementation((...args) => {
    const activity = acquire(...args);
    return {
      ...activity,
      async run(signal) {
        const scope = await activity.run(signal);
        return {
          ...scope,
          opened: { ...scope.opened, followWithdrawals: undefined },
        };
      },
    };
  });
  const channel = await connect(f);
  send(channel.peer, {
    type: 'open',
    streamId: 'root',
    endpoint: 'session/follow',
    payload: {
      args: { request: { address: { kind: 'session', sessionId: 'root' } } },
    },
  });
  expect(await channel.next('root')).toMatchObject({
    type: 'error',
    error: {
      code: 'remote-access/denied',
      details: { reason: 'continuity-unavailable' },
    },
  });
  expect(f.host.catalog.follows).toHaveLength(0);
});
