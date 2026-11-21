import { afterEach, describe, expect, it } from 'vitest';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import { createVmMemoryAdmission } from '@allrice/vm-memory';
import {
  FixtureMemorySource,
  memoryObservation,
} from '../../vm-memory/src/memory.fixture.ts';
import {
  FixtureStore,
  deferred,
  gatewayFixture,
  modelBinding,
  nativeProviderFixture,
  upstreamFixture,
} from './gateway.fixture.ts';
import { responsesFixture } from './revision.fixture.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(
  pressure: 'normal' | 'pressure' = 'pressure',
  store = new FixtureStore(),
) {
  const binding = modelBinding();
  const source = new FixtureMemorySource(binding.vm, pressure);
  const upstream = await upstreamFixture();
  cleanup.push(() => upstream.close());
  const native = await nativeProviderFixture(upstream.url);
  cleanup.push(() => native.close());
  const fixture = await gatewayFixture({
    provider: native.provider,
    binding,
    store,
    memoryAdmission: createVmMemoryAdmission(source),
  });
  cleanup.push(() => fixture.close());
  return { ...fixture, source, upstream };
}
const finish = (chunks: StreamChunk[]) =>
  chunks.findLast((chunk) => chunk.type === 'finish');
const slots = (f: Awaited<ReturnType<typeof setup>>) =>
  f.store.slots.get(f.binding.vm.personId)?.size ?? 0;

describe.sequential(
  'native provider → original gateway HTTP: memory admission',
  () => {
    it('首次内存拒绝后原生Codex retry成功，保留真实成功和usage', async () => {
      const upstream = await responsesFixture({
        codex: true,
        nativeCodexRetries: 1,
      });
      cleanup.push(() => upstream.close());
      const source = new FixtureMemorySource(upstream.binding.vm, 'normal');
      source.publish(memoryObservation(upstream.binding.vm, 'unavailable'));
      const f = await gatewayFixture({
        provider: upstream.provider,
        binding: upstream.binding,
        memoryAdmission: createVmMemoryAdmission(source),
      });
      cleanup.push(() => f.close());
      const pending = f.collect();
      await source.detached.promise;
      expect(upstream.requests).toHaveLength(0);
      source.publish(memoryObservation(f.binding.vm));
      expect(finish(await pending)).toMatchObject({ reason: { kind: 'stop' } });
      expect(upstream.requests).toHaveLength(1);
      expect([...f.store.rows.values()]).toMatchObject([
        { dispatchObserved: true, terminal: 'completed' },
      ]);
      expect(
        await f.store.usage(f.binding.vm.personId, f.binding.vm.organizationId),
      ).toMatchObject({ attemptCount: 1, inputTokens: 12, outputTokens: 3 });
      expect(source.subscribers.size).toBe(0);
    });

    it('先发送HTTP再被内存门卫拒绝原生retry，错误不声称整调用未发送', async () => {
      const upstream = await responsesFixture({
        codex: true,
        nativeCodexRetries: 1,
        firstRequestStatus: 503,
        onRequest() {
          source.publish(memoryObservation(upstream.binding.vm, 'unavailable'));
        },
      });
      cleanup.push(() => upstream.close());
      const source = new FixtureMemorySource(upstream.binding.vm, 'normal');
      const f = await gatewayFixture({
        provider: upstream.provider,
        binding: upstream.binding,
        memoryAdmission: createVmMemoryAdmission(source),
      });
      cleanup.push(() => f.close());
      const terminal = finish(await f.collect());
      expect(terminal).toMatchObject({
        reason: {
          kind: 'error',
          failure: { code: 'MEMORY_OBSERVATION_UNAVAILABLE' },
        },
      });
      expect(JSON.stringify(terminal)).not.toContain('本次请求未发送');
      expect(upstream.requests).toHaveLength(1);
      expect([...f.store.rows.values()]).toMatchObject([
        { dispatchObserved: true, httpStatus: 503 },
      ]);
      expect(
        (
          await f.store.usage(
            f.binding.vm.personId,
            f.binding.vm.organizationId,
          )
        ).attemptCount,
      ).toBe(1);
      expect(source.subscribers.size).toBe(0);
    });

    it('用户“请查一下大米价格”在压力中排队不占实际模型流，恢复后只发送一次并正常落账', async () => {
      const f = await setup();
      const pending = f.collect();
      await f.source.waiting.promise;
      expect(f.upstream.requests).toHaveLength(0);
      expect(f.store.rows.size).toBe(0);
      expect(slots(f)).toBe(0);
      f.source.publish(memoryObservation(f.binding.vm));
      expect(finish(await pending)).toMatchObject({ reason: { kind: 'stop' } });
      expect(f.upstream.requests).toHaveLength(1);
      expect([...f.store.rows.values()]).toMatchObject([
        { dispatchObserved: true, terminal: 'completed' },
      ]);
      expect(
        (
          await f.store.usage(
            f.binding.vm.personId,
            f.binding.vm.organizationId,
          )
        ).attemptCount,
      ).toBe(1);
      expect(f.source.subscribers.size).toBe(0);
    });

    it('slot提交期间压力变化先结算未发intent并释放，再排队；恢复没有静默重放HTTP', async () => {
      const f = await setup('normal');
      let first = true;
      f.store.beforeStart = async () => {
        if (!first) return;
        first = false;
        f.source.publish(memoryObservation(f.binding.vm, 'pressure'));
      };
      const pending = f.collect();
      await f.source.waiting.promise;
      expect(slots(f)).toBe(0);
      expect(f.upstream.requests).toHaveLength(0);
      expect([...f.store.rows.values()]).toMatchObject([
        { dispatchObserved: false, outcome: 'canceled' },
      ]);
      f.source.publish(memoryObservation(f.binding.vm));
      expect(finish(await pending)).toMatchObject({ reason: { kind: 'stop' } });
      expect(f.upstream.requests).toHaveLength(1);
      expect(f.store.rows.size).toBe(2);
      expect(
        (
          await f.store.usage(
            f.binding.vm.personId,
            f.binding.vm.organizationId,
          )
        ).attemptCount,
      ).toBe(1);
    });

    it('未派发intent结算失败保留slot，不二次申请、不发送HTTP', async () => {
      const f = await setup('normal');
      f.store.failFinish = true;
      f.store.beforeStart = async () => {
        f.source.publish(memoryObservation(f.binding.vm, 'pressure'));
      };
      expect(finish(await f.collect())).toMatchObject({
        reason: { kind: 'error', failure: { code: 'LEDGER_UNAVAILABLE' } },
      });
      expect(slots(f)).toBe(1);
      expect(f.upstream.requests).toHaveLength(0);
      expect([...f.store.rows.values()]).toMatchObject([
        { dispatchObserved: null, outcome: 'unknown' },
      ]);
      expect(f.source.subscribers.size).toBe(0);
    });

    it.each(['revoke', 'close', 'client'] as const)(
      '内存等待可由%s取消且真实收尾，不占slot/HTTP',
      async (action) => {
        const f = await setup();
        const controller = new AbortController();
        const pending = f.collect(f.input(controller.signal));
        const completion = pending.catch((error: unknown) => {
          if (action !== 'client') throw error;
          return error;
        });
        await f.source.waiting.promise;
        if (action === 'client')
          controller.abort(new Error('synthetic-user-stop'));
        else if (action === 'revoke') await f.gateway.revoke(f.binding.vm);
        else await f.gateway.close();
        const result = await completion;
        if (action === 'client')
          expect(result).toMatchObject({ message: 'synthetic-user-stop' });
        await f.source.detached.promise;
        expect(f.source.subscribers.size).toBe(0);
        expect(slots(f)).toBe(0);
        expect(f.store.rows.size).toBe(0);
        expect(f.upstream.requests).toHaveLength(0);
      },
    );

    it('排队恢复后现权/代际失效不能绕过原assertCall', async () => {
      const f = await setup();
      const pending = f.collect();
      await f.source.waiting.promise;
      f.deny();
      f.source.publish(memoryObservation(f.binding.vm));
      expect(finish(await pending)).toMatchObject({
        reason: { kind: 'error', failure: { code: 'AUTHORIZATION_DENIED' } },
      });
      expect(f.upstream.requests).toHaveLength(0);
      expect(f.store.rows.size).toBe(0);
    });

    it.each(['epoch', 'unavailable', 'missing', 'cap'] as const)(
      '排队后%s观察不放行且给原生可读错误',
      async (kind) => {
        const f = await setup();
        const pending = f.collect();
        await f.source.waiting.promise;
        const observation = memoryObservation(f.binding.vm);
        f.source.publish(
          kind === 'missing'
            ? null
            : kind === 'epoch'
              ? {
                  ...observation,
                  binding: {
                    ...f.binding.vm,
                    leaseEpoch: f.binding.vm.leaseEpoch + 1,
                  },
                }
              : kind === 'cap'
                ? {
                    ...observation,
                    physical: {
                      ...observation.physical,
                      enforcedBytes: 4096 * 1024 ** 2,
                    },
                  }
                : { ...observation, pressure: 'unavailable' },
        );
        const chunks = await pending;
        expect(finish(chunks)).toMatchObject({
          reason: {
            kind: 'error',
            failure: {
              message: expect.stringContaining('会话保留'),
              code:
                kind === 'epoch'
                  ? 'MEMORY_BINDING_INVALID'
                  : kind === 'cap'
                    ? 'VM_MEMORY_CAP_INVALID'
                    : 'MEMORY_OBSERVATION_UNAVAILABLE',
            },
          },
        });
        expect(f.upstream.requests).toHaveLength(0);
        expect(slots(f)).toBe(0);
      },
    );

    it('8路容量通知之后再核压力，不在容量队列恢复时偷跑模型', async () => {
      const f = await setup('normal');
      const occupied = new Set(
        Array.from({ length: 8 }, (_, n) => `synthetic-slot-${n}`),
      );
      f.store.slots.set(f.binding.vm.personId, occupied);
      const pending = f.collect();
      await f.store.queued.promise;
      f.source.publish(memoryObservation(f.binding.vm, 'pressure'));
      occupied.clear();
      for (const listener of f.store.listeners.get(f.binding.vm.personId) ?? [])
        listener();
      await f.source.waiting.promise;
      expect(f.upstream.requests).toHaveLength(0);
      expect(slots(f)).toBe(0);
      f.source.publish(memoryObservation(f.binding.vm));
      expect(finish(await pending)).toMatchObject({ reason: { kind: 'stop' } });
      expect(f.upstream.requests).toHaveLength(1);
    });

    it('观察source安装过程中撤权也会取消并释放所有订阅', async () => {
      const binding = modelBinding();
      const entered = deferred();
      const canceled = deferred();
      const upstream = await upstreamFixture();
      cleanup.push(() => upstream.close());
      const native = await nativeProviderFixture(upstream.url);
      cleanup.push(() => native.close());
      const f = await gatewayFixture({
        provider: native.provider,
        binding,
        memoryAdmission: {
          async watch(_binding, signal) {
            entered.resolve();
            await new Promise<void>((resolve) =>
              signal.addEventListener(
                'abort',
                () => {
                  canceled.resolve();
                  resolve();
                },
                { once: true },
              ),
            );
            signal.throwIfAborted();
            throw Error('unreachable');
          },
        },
      });
      cleanup.push(() => f.close());
      const pending = f.collect();
      await entered.promise;
      await f.gateway.revoke(binding.vm);
      await pending;
      await canceled.promise;
      expect(upstream.requests).toHaveLength(0);
      expect(f.store.rows.size).toBe(0);
    });
  },
);
