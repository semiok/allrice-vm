import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import {
  createAssistantMessage,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { ModelGatewayError } from './contract.ts';
import type { GatewayProvider } from './contract.ts';
import { withGatewayAuthTransaction } from './transport.ts';
import {
  closeServer,
  deferred,
  FixtureStore,
  FixtureAdmission,
  freshCall,
  gatewayFixture,
  modelBinding,
  nativeProviderFixture,
  nativeFailure,
  upstreamFixture,
} from './gateway.fixture.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(
  options: Parameters<typeof upstreamFixture>[0] = {},
  store?: FixtureStore,
) {
  const upstream = await upstreamFixture(options);
  cleanup.push(() => upstream.close());
  const native = await nativeProviderFixture(upstream.url);
  cleanup.push(() => native.close());
  const gateway = await gatewayFixture({ provider: native.provider, store });
  cleanup.push(() => gateway.close());
  return { upstream, native, ...gateway };
}
it('hashes the same trusted context that reaches the provider, and refuses stale context before claiming', async () => {
  const sent = vi.fn();
  const store = new FixtureStore();
  const context = vi.fn(async () => 'sealed memory index');
  const f = await gatewayFixture({
    store,
    readTrustedContext: context,
    provider: {
      classify: () => null,
      async *stream(_binding, input) {
        sent(input);
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  });
  cleanup.push(() => f.close());
  await f.collect({ ...f.input(), system: 'original prompt' });
  expect(sent).toHaveBeenCalledTimes(1);
  const finalInput: unknown = sent.mock.calls[0]![0];
  expect(finalInput).toMatchObject({
    system: 'original prompt\n\nsealed memory index',
  });
  expect([...store.calls.values()][0]?.digest).toBe(
    'sha256:' +
      createHash('sha256').update(JSON.stringify(finalInput)).digest('hex'),
  );
  context.mockRejectedValueOnce(new ModelGatewayError('AUTHORIZATION_DENIED'));
  await f.collect();
  expect(context).toHaveBeenCalledTimes(2);
  expect(sent).toHaveBeenCalledTimes(1);
  expect(store.calls.size).toBe(1);
});
it.each([
  ['capacity', 'sealed memory index'],
  ['route', 'sealed memory index'],
  ['route', ''],
])(
  'checks a sealed context after %s changes authority, even with an empty index (%j)',
  async (gate, index) => {
    const upstream = await upstreamFixture();
    cleanup.push(() => upstream.close());
    const native = await nativeProviderFixture(upstream.url);
    cleanup.push(() => native.close());
    const store = new FixtureStore();
    const routeEntered = deferred();
    const routeReleased = deferred();
    let archived = false;
    store.beforeStart = async () => {
      if (gate === 'capacity') archived = true;
    };
    const phases: string[] = [];
    const f = await gatewayFixture({
      provider: {
        ...native.provider,
        async assertDispatchCurrent() {
          if (gate === 'route') {
            routeEntered.resolve();
            await routeReleased.promise;
          }
        },
      },
      store,
      async readTrustedContext(_binding, _signal, phase) {
        phases.push(phase);
        return index;
      },
      async withTrustedContext(_binding, _signal, _route, dispatch) {
        phases.push('dispatch');
        if (archived) throw new ModelGatewayError('AUTHORIZATION_DENIED');
        dispatch(index);
      },
    });
    cleanup.push(() => f.close());
    const result = f.collect();
    if (gate === 'route') {
      try {
        await routeEntered.promise;
        archived = true;
      } finally {
        routeReleased.resolve();
      }
    }
    await result;
    expect(phases).toEqual(['seal', 'dispatch']);
    expect(store.calls.size).toBe(1);
    expect(upstream.requests).toHaveLength(0);
    expect([...store.rows.values()]).toMatchObject([
      { dispatchObserved: false, outcome: 'failed', httpStatus: null },
    ]);
  },
);
it('does not send the sealed index if the selected route is revoked while waiting on recovery', async () => {
  const upstream = await upstreamFixture();
  cleanup.push(() => upstream.close());
  const native = await nativeProviderFixture(upstream.url);
  cleanup.push(() => native.close());
  const entered = deferred();
  const released = deferred();
  const index = 'confirmed memory only';
  let ready = true;
  const store = new FixtureStore();
  const f = await gatewayFixture({
    store,
    provider: {
      ...native.provider,
      async assertDispatchCurrent() {
        expect(ready).toBe(true);
        return {
          assertCurrent() {
            if (!ready) throw new ModelGatewayError('AUTHORIZATION_DENIED');
          },
        };
      },
    },
    async readTrustedContext() {
      return index;
    },
    async withTrustedContext(_binding, _signal, _route, dispatch) {
      entered.resolve();
      await released.promise;
      dispatch(index);
    },
  });
  cleanup.push(() => f.close());
  const result = f.collect();
  try {
    await entered.promise;
    ready = false;
  } finally {
    released.resolve();
  }
  await result;
  expect(upstream.requests).toHaveLength(0);
  expect([...store.rows.values()]).toMatchObject([
    { dispatchObserved: false, outcome: 'failed', httpStatus: null },
  ]);
  expect(store.slots.get(f.binding.vm.personId)?.size).toBe(0);
});
it('rejects a chunked oversized request without waiting for EOF or dispatching upstream', async () => {
  const f = await setup();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = request(
      f.url + '/v1/stream',
      {
        method: 'POST',
        headers: {
          'x-allrice-model-contract': '1',
          'transfer-encoding': 'chunked',
        },
      },
      (response) => {
        response.once('error', reject);
        response.resume();
        response.once('end', () => {
          resolve(response.statusCode);
          outgoing.destroy();
        });
      },
    );
    outgoing.once('error', reject);
    // Keep the upload open and send only one byte past the cap. Queuing a
    // whole extra MiB races the required early response against client EPIPE.
    const chunk = Buffer.alloc(1024 * 1024, 32);
    let remaining = 8;
    const write = () => {
      if (remaining === 0) {
        outgoing.write(' ');
        return;
      }
      remaining -= 1;
      outgoing.write(chunk, (error) => {
        if (error) reject(error);
        else write();
      });
    };
    write();
  });
  expect(status).toBe(413);
  expect(f.upstream.requests).toHaveLength(0);
  expect(f.store.rows.size).toBe(0);
});
it('frozen gateway grants no reference and durable issuance waits for real activation', async () => {
  const f = await setup();
  const admission = new FixtureAdmission();
  const g = await gatewayFixture({ provider: f.native.provider, admission });
  cleanup.push(() => g.close());
  const fence = { binding: g.binding.vm, freezeId: 'synthetic', version: '1' };
  await admission.participant.freeze(fence, new AbortController().signal);
  const caller = new AbortController();
  const issue = vi.fn(async () => 'synthetic-reference');
  const reference = g.gateway.issueReference!(g.binding, caller.signal, issue);
  void reference.catch(() => {});
  await admission.deferred.promise;
  expect(issue).not.toHaveBeenCalled();
  caller.abort();
  await expect(reference).rejects.toBeDefined();
  expect(issue).not.toHaveBeenCalled();
  expect(admission.records.size).toBe(0);
});

const finish = (chunks: StreamChunk[]) =>
  chunks.findLast((chunk) => chunk.type === 'finish');

describe.sequential(
  'host model gateway: actual HTTP + native public DSH provider',
  () => {
    it('用户“请查一下大米价格”获得原生文本/工具增量，工具结果经同入口往返，逐实际请求落账', async () => {
      const f = await setup({ tools: true });
      const chunks = await f.collect();
      expect(
        chunks
          .filter((c) => c.type === 'text-delta')
          .map((c) => c.text)
          .join(''),
      ).toBe('Hello world');
      const calls = chunks.filter((c) => c.type === 'tool-call-delta');
      expect(calls.map((c) => c.argumentsDelta).join('')).toBe('{"q":"rice"}');
      expect(finish(chunks)).toMatchObject({ reason: { kind: 'tool-calls' } });
      const toolId = calls[0]!.id;
      const next: GenerateOptions = {
        ...f.input(),
        messages: [
          ...f.input().messages,
          createAssistantMessage({
            content: [
              {
                type: 'tool-call',
                id: toolId,
                name: 'lookup',
                arguments: '{"q":"rice"}',
              },
            ],
            source: { provider: 'host-gateway', model: 'fixture-model' },
          }),
          createToolResultMessage({
            callId: toolId,
            content: [{ type: 'text', text: '合成价格 6 元' }],
            isError: false,
          }),
        ],
      };
      await f.collect(next);
      expect(f.upstream.requests[1]!.body.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'tool', content: '合成价格 6 元' }),
        ]),
      );
      expect(
        await f.gateway.ledger.summarize(
          f.binding.context,
          new AbortController().signal,
        ),
      ).toMatchObject({
        inputTokens: 24,
        outputTokens: 6,
        totalTokens: 30,
        cachedInputTokens: 8,
        attemptCount: 2,
        receiptCount: 2,
        usageComplete: true,
      });
      expect([...f.store.rows.values()]).toHaveLength(2);
      expect(f.errors).toEqual([]);
    });

    it.each([401, 429, 503])(
      '上游%s失败照实记独立attempt，缺usage保持null',
      async (status) => {
        const f = await setup({ status });
        const chunks = await f.collect();
        expect(finish(chunks)).toMatchObject({ reason: { kind: 'error' } });
        const rows = [...f.store.rows.values()];
        expect(rows.length).toBeGreaterThan(0);
        expect(rows).toHaveLength(f.upstream.requests.length);
        expect(
          rows.every(
            (r) =>
              r.httpStatus === status &&
              r.usage.totalTokens === null &&
              !r.usage.usageComplete,
          ),
        ).toBe(true);
        expect(
          (
            await f.store.usage(
              f.binding.vm.personId,
              f.binding.vm.organizationId,
            )
          ).totalTokens,
        ).toBeNull();
        // A business refusal with confirmed real HTTP shutdown is finished,
        // rather than being mislabeled as unknown admission activity.
        expect(f.admission.records.size).toBe(0);
        expect(f.admission.finished).toHaveLength(1);
      },
    );

    it('原生SDK maxRetries=0的421不在单个fetch内隐藏重发，下次显式调用独立记200', async () => {
      const f = await setup({ firstRequestStatus: 421 });
      const chunks = await f.collect();
      const observed = {
        requests: f.upstream.requests.length,
        statuses: [...f.store.rows.values()].map((r) => r.httpStatus),
      };
      expect(observed, JSON.stringify(observed)).toEqual({
        requests: 1,
        statuses: [421],
      });
      expect(finish(chunks)).toMatchObject({ reason: { kind: 'error' } });
      expect([...f.store.rows.values()][0]).toMatchObject({
        dispatchObserved: true,
        usage: { totalTokens: null, usageComplete: false },
      });
      expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(0);
      expect(finish(await f.collect())).toMatchObject({
        reason: { kind: 'stop' },
      });
      expect(f.upstream.requests).toHaveLength(2);
      expect(f.upstream.requests[1]!.body).toEqual(
        f.upstream.requests[0]!.body,
      );
      expect([...f.store.rows.values()].map((r) => r.httpStatus)).toEqual([
        421, 200,
      ]);
      expect(
        (
          await f.store.usage(
            f.binding.vm.personId,
            f.binding.vm.organizationId,
          )
        ).totalTokens,
      ).toBeNull();
    });

    it('无body的auth-refresh也不隐藏重放421，仍属于原call且usage未知', async () => {
      const upstream = await upstreamFixture({ firstRequestStatus: 421 });
      cleanup.push(() => upstream.close());
      const provider: GatewayProvider = {
        classify() {
          return { kind: 'auth-refresh', protocol: 'opaque' };
        },
        async *stream() {
          const status = await withGatewayAuthTransaction(async () => {
            const response = await fetch(upstream.url + '/refresh', {
              method: 'POST',
              signal: AbortSignal.timeout(15_000),
            });
            await response.text();
            return response.status;
          });
          yield nativeFailure('HTTP_' + status);
        },
      };
      const f = await gatewayFixture({ provider });
      cleanup.push(() => f.close());
      expect(finish(await f.collect())).toMatchObject({
        reason: { kind: 'error', failure: { code: 'HTTP_421' } },
      });
      expect(upstream.requests).toHaveLength(1);
      expect([...f.store.rows.values()]).toMatchObject([
        {
          callId: [...f.store.calls.keys()][0],
          kind: 'auth-refresh',
          httpStatus: 421,
          usage: { totalTokens: null },
        },
      ]);
      expect(f.store.slots.get(f.binding.vm.personId)?.size ?? 0).toBe(0);
    });

    it.each(['GET', 'HEAD'])(
      '%s无法禁用隐藏421重放，在实际上游外发前拒绝',
      async (method) => {
        const upstream = await upstreamFixture();
        cleanup.push(() => upstream.close());
        const f = await gatewayFixture({
          provider: {
            classify() {
              return { kind: 'model', protocol: 'opaque' };
            },
            async *stream(_binding, _input, signal) {
              await fetch(upstream.url + '/v1', { method, signal });
              yield nativeFailure('UNREACHABLE');
            },
          },
        });
        cleanup.push(() => f.close());
        expect(finish(await f.collect())).toMatchObject({
          reason: { kind: 'error', failure: { code: 'UNSUPPORTED_UPSTREAM' } },
        });
        expect(upstream.requests).toHaveLength(0);
        expect(f.store.rows.size).toBe(0);
      },
    );

    it('EOF缺明确终止不能伪造成功；有usage也不等同完整完成', async () => {
      const f = await setup({ missingTerminal: true });
      const chunks = await f.collect();
      // The native adapter may diagnose STREAM_CLOSED before the gateway guard;
      // both preserve the real failure rather than manufacturing completion.
      expect(finish(chunks)).toMatchObject({ reason: { kind: 'error' } });
      expect([...f.store.rows.values()][0]).toMatchObject({
        terminal: null,
        usage: { inputTokens: 12 },
      });
      expect(
        (
          await f.store.usage(
            f.binding.vm.personId,
            f.binding.vm.organizationId,
          )
        ).usageComplete,
      ).toBe(false);
    });

    it('上游未返回usage时忽略原生适配器合成0，账本和响应均不伪报0', async () => {
      const f = await setup({ missingUsage: true });
      const chunks = await f.collect();
      expect(finish(chunks)).toMatchObject({ reason: { kind: 'stop' } });
      expect(chunks.some((c) => c.type === 'usage')).toBe(false);
      expect([...f.store.rows.values()][0]!.usage).toMatchObject({
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        usageComplete: false,
      });
    });

    it('主动取消/浏览器断开传到实际上游，取消真实收尾后释放租约', async () => {
      const f = await setup({ hold: true });
      const controller = new AbortController();
      const collecting = f
        .collect(f.input(controller.signal))
        .catch((error) => error);
      await f.upstream.whenCount(1);
      controller.abort(new Error('synthetic browser refreshed'));
      await collecting;
      await f.upstream.closed;
      await f.gateway.revoke(f.binding.vm);
      expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(0);
      expect([...f.store.rows.values()][0]).toMatchObject({
        outcome: 'canceled',
        usage: { totalTokens: null },
      });
    });

    it('已dispatch但headers前真实socket关闭：保留失败事实，独立close确认后正常finish', async () => {
      const f = await setup({ disconnectBeforeHeaders: true });
      expect(finish(await f.collect())).toMatchObject({
        reason: { kind: 'error' },
      });
      expect(f.upstream.requests).toHaveLength(1);
      expect([...f.store.rows.values()]).toMatchObject([
        {
          dispatchObserved: true,
          httpStatus: null,
          outcome: 'failed',
          usage: { totalTokens: null, usageComplete: false },
        },
      ]);
      expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(0);
      expect(f.admission.records.size).toBe(0);
      expect(f.admission.finished).toHaveLength(1);
    });

    it('第九路排队，另一人仍可执行；结束第1路才让第9路实际派发', async () => {
      const f = await setup({ hold: true });
      const requests = Array.from({ length: 9 }, () => f.collect());
      await f.store.queued.promise;
      await f.upstream.whenCount(8);
      expect(f.upstream.requests).toHaveLength(8);
      const signal = new AbortController().signal;
      const lease = {
        binding: f.binding.vm,
        freezeId: 'freeze-with-queued',
        version: 'exact-1',
      };
      expect(f.gateway.admission).toBe(f.admission.participant);
      const frozen = await f.gateway.admission.freeze(lease, signal);
      expect(frozen).toMatchObject({ active: 8, queued: 1, deferred: 0 });
      await f.gateway.admission.thaw(lease, signal);
      f.admission.entryReleased = true;
      f.admission.release();
      const other = await gatewayFixture({
        provider: f.native.provider,
        store: f.store,
        binding: modelBinding(),
      });
      cleanup.push(() => other.close());
      const otherRequest = other.collect();
      await f.upstream.whenCount(9);
      expect(f.store.slots.get(other.binding.vm.personId)?.size).toBe(1);
      f.upstream.complete(0);
      await f.upstream.whenCount(10);
      for (let index = 1; index < 10; index++) f.upstream.complete(index);
      await Promise.all([...requests, otherRequest]);
      expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(0);
      expect(f.store.slots.get(other.binding.vm.personId)?.size).toBe(0);
      expect(
        [...f.store.rows.values()].filter(
          (r) => r.personId === other.binding.vm.personId,
        ),
      ).toHaveLength(1);
      expect(
        [...f.store.rows.values()].filter(
          (r) => r.personId === f.binding.vm.personId,
        ),
      ).toHaveLength(9);
    });

    it.each(['ready', 'client-cancel'] as const)(
      '冻结后的真实请求%s：门外等待、双release之前无provider/claim/HTTP且不重放旧执行',
      async (outcome) => {
        const f = await setup();
        let providerStarts = 0;
        const second = await gatewayFixture({
          provider: {
            ...f.native.provider,
            stream(...args) {
              providerStarts++;
              return f.native.provider.stream(...args);
            },
          },
          store: f.store,
          binding: f.binding,
          admission: f.admission,
        });
        cleanup.push(() => second.close());
        const signal = new AbortController().signal;
        const lease = {
          binding: f.binding.vm,
          freezeId: 'exact-old-freeze',
          version: 'exact-old-version',
        };
        await f.gateway.admission.freeze(lease, signal);
        const caller = new AbortController();
        const result = fetch(second.url + '/v1/stream', {
          method: 'POST',
          signal: caller.signal,
          headers: { 'x-allrice-model-contract': '1' },
          body: JSON.stringify({ messages: second.input().messages }),
        })
          .then(async (response) => ({
            status: response.status,
            body: await response.text(),
          }))
          .catch((error: unknown) => ({ error }));
        await f.admission.waiting.promise;
        expect(f.admission.observe(f.binding.vm)).toMatchObject({
          active: 0,
          queued: 0,
          deferred: 1,
        });
        expect(f.store.calls.size).toBe(0);
        expect(f.store.rows.size).toBe(0);
        expect(providerStarts).toBe(0);
        await f.gateway.admission.thaw(lease, signal);
        expect(f.admission.wakeCount).toBe(0);
        if (outcome === 'client-cancel') {
          caller.abort(new Error('caller no longer wants this request'));
          await result;
          await second.gateway.revoke(f.binding.vm);
        }
        f.admission.entryReleased = true;
        f.admission.release();
        const response = await result;
        if (outcome === 'ready') {
          expect(response).toMatchObject({ status: 200 });
          if ('body' in response)
            expect(JSON.parse(response.body)).toMatchObject({
              type: 'finish',
              reason: {
                kind: 'aborted',
                failure: { code: 'EXECUTION_REBIND_REQUIRED' },
              },
            });
        }
        expect(f.admission.wakeCount).toBe(outcome === 'ready' ? 1 : 0);
        expect(providerStarts).toBe(0);
        expect(f.upstream.requests).toHaveLength(0);
        expect(f.admission.records.size).toBe(0);
      },
    );

    it('不同gateway/企业中的同person仍共用8路；撤销取消活动和排队请求', async () => {
      const f = await setup({ hold: true });
      const otherBinding = modelBinding(f.binding.vm.personId, randomUUID());
      const second = await gatewayFixture({
        provider: f.native.provider,
        store: f.store,
        binding: otherBinding,
      });
      cleanup.push(() => second.close());
      const active = Array.from({ length: 8 }, () => f.collect());
      await f.upstream.whenCount(8);
      const ninth = second.collect();
      await f.store.queued.promise;
      expect(f.upstream.requests).toHaveLength(8);
      await second.gateway.revoke(otherBinding.vm);
      await ninth;
      expect(f.upstream.requests).toHaveLength(8);
      await f.gateway.revoke(f.binding.vm);
      await Promise.all(active);
      expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(0);
    });

    it('跨await和原生child映射绑定同一可信owner，guest头和输入不能改person/tenant', async () => {
      const f = await setup();
      const child = {
        ...freshCall(f.binding),
        native: {
          ...f.binding.native,
          sessionId: 'child',
          parentSessionId: 'root',
          callId: randomUUID(),
        },
      };
      const second = await gatewayFixture({
        provider: f.native.provider,
        store: f.store,
        binding: child,
        nextBinding: () => child,
      });
      cleanup.push(() => second.close());
      const response = await fetch(second.url + '/v1/stream', {
        method: 'POST',
        headers: {
          'x-allrice-model-contract': '1',
          'x-person-id': randomUUID(),
          'x-tenant-id': randomUUID(),
          'x-vm-epoch': '999',
        },
        body: JSON.stringify({ messages: f.input().messages }),
      });
      await response.text();
      const call = [...f.store.calls.values()][0]!.binding;
      expect(call).toMatchObject({
        vm: f.binding.vm,
        native: {
          sessionId: 'child',
          rootSessionId: 'root',
          parentSessionId: 'root',
        },
      });
      expect(second.checked.length).toBeGreaterThan(3);
      const denied = await fetch(f.url + '/v1/stream', {
        method: 'POST',
        headers: { 'x-allrice-model-contract': '1' },
        body: JSON.stringify({
          messages: f.input().messages,
          personId: randomUUID(),
        }),
      });
      expect(denied.status).toBe(400);
      await denied.text();
      expect(f.upstream.requests).toHaveLength(1);
    });

    it('刷新/重连同一native call持久去重，不产生第二次上游请求', async () => {
      const f = await setup();
      const binding = freshCall(f.binding);
      const second = await gatewayFixture({
        provider: f.native.provider,
        store: f.store,
        nextBinding: () => binding,
      });
      cleanup.push(() => second.close());
      await second.collect();
      const chunks = await second.collect();
      expect(finish(chunks)).toMatchObject({
        reason: { kind: 'error', failure: { code: 'DUPLICATE_CALL' } },
      });
      expect(f.upstream.requests).toHaveLength(1);
    });

    it('每次实际retry和auth-refresh独立落账，不把最终usage套到先前失败', async () => {
      const f = await setup({ firstAttemptStatus: 429 });
      const provider: GatewayProvider = {
        ...f.native.provider,
        async *stream(binding, input, signal) {
          await withGatewayAuthTransaction(async () =>
            (
              await fetch(f.upstream.url + '/refresh', {
                method: 'POST',
                signal: AbortSignal.timeout(15_000),
                body: '{}',
              })
            ).text(),
          );
          await (
            await fetch(f.upstream.url + '/v1/first-attempt', {
              method: 'POST',
              signal,
              body: '{}',
            })
          ).text();
          await Promise.resolve();
          yield* f.native.provider.stream(binding, input, signal);
        },
      };
      const second = await gatewayFixture({
        provider,
        store: f.store,
        binding: f.binding,
      });
      cleanup.push(() => second.close());
      await second.collect();
      const rows = [...f.store.rows.values()];
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        kind: 'auth-refresh',
        usage: { totalTokens: null },
      });
      expect(rows[1]).toMatchObject({
        kind: 'model',
        httpStatus: 429,
        usage: { totalTokens: null },
      });
      expect(rows[2]).toMatchObject({
        kind: 'model',
        httpStatus: 200,
        usage: { totalTokens: 15 },
      });
      expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    });

    it('redirect不自动追随，不泄露凭据也不漏记隐藏HTTP尝试', async () => {
      const f = await setup();
      f.upstream.setRedirect();
      const chunks = await f.collect();
      expect(finish(chunks)).toMatchObject({ reason: { kind: 'error' } });
      expect(f.upstream.redirectHits).toBe(0);
      expect(
        [...f.store.rows.values()].every((r) => r.httpStatus === 307),
      ).toBe(true);
    });

    it('撤权信号主动取消真实流，旧epoch延迟revoke不影响新epoch', async () => {
      const f = await setup({ hold: true });
      const active = f.collect();
      await f.upstream.whenCount(1);
      await f.gateway.revoke({ ...f.binding.vm, leaseEpoch: 99 });
      expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(1);
      f.deny();
      await f.gateway.revoke(f.binding.vm);
      await active;
      await f.upstream.closed;
      expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(0);
      expect(f.upstream.active).toBe(0);
    });

    it('retains an unconfirmed native join for the exact epoch after its handler finishes', async () => {
      const entered = deferred();
      const joinError = new Error('native iterator release unconfirmed');
      const ownerId = randomUUID();
      const caller = new AbortController().signal;
      const originalFetch = globalThis.fetch;
      let actualIteratorStopped = false;
      const f = await gatewayFixture({
        ownerId,
        authority: {
          async assertCall(_binding, signal) {
            signal.throwIfAborted();
          },
          async authorizeUsage(context) {
            return {
              personId: context.actor.id,
              organizationId: context.organizationId,
            };
          },
          async confirmOwnerStopped(_context, owner) {
            if (owner !== ownerId || !actualIteratorStopped)
              throw new ModelGatewayError('AUTHORIZATION_DENIED');
            return { evidenceRef: 'fixture-observed-iterator-stopped' };
          },
        },
        provider: {
          classify: () => null,
          stream(_binding, _input, signal) {
            return {
              [Symbol.asyncIterator]() {
                return {
                  next() {
                    return new Promise<IteratorResult<StreamChunk>>(
                      (_resolve, reject) => {
                        const abort = () => reject(signal.reason);
                        signal.addEventListener('abort', abort, { once: true });
                        if (signal.aborted) abort();
                        entered.resolve();
                      },
                    );
                  },
                  async return() {
                    actualIteratorStopped = true;
                    throw joinError;
                  },
                };
              },
            };
          },
        },
      });
      const meteredFetch = globalThis.fetch;
      const collecting = f.collect();
      try {
        await entered.promise;
        const revoke = f.gateway.revoke(f.binding.vm);
        await expect(revoke).rejects.toMatchObject({
          code: 'LEDGER_UNAVAILABLE',
        });
        expect(finish(await collecting)).toMatchObject({
          reason: { kind: 'error' },
        });
        await expect(f.gateway.revoke(f.binding.vm)).rejects.toMatchObject({
          code: 'LEDGER_UNAVAILABLE',
          binding: f.binding.vm,
        });
        await expect(
          f.gateway.revoke({ ...f.binding.vm, leaseEpoch: 99 }),
        ).resolves.toBeUndefined();
        await expect(f.gateway.close()).rejects.toBeInstanceOf(AggregateError);
        expect(globalThis.fetch).toBe(meteredFetch);
        const callId = f.store.calls.keys().next().value;
        if (!callId) throw new Error('fixture call was not recorded');
        await expect(
          f.store.tryStartAttempt({
            id: randomUUID(),
            callId,
            ownerId,
            personId: f.binding.vm.personId,
            kind: 'model',
            protocol: 'openai-responses',
          }),
        ).resolves.toBe(true);
        const maintenance = new AbortController();
        const persisted = f.store.reconcileOwner.bind(f.store);
        const persisting = deferred();
        const settleLedger = deferred();
        vi.spyOn(f.store, 'reconcileOwner').mockImplementationOnce(
          async (id, evidence) => {
            persisting.resolve();
            await settleLedger.promise;
            return persisted(id, evidence);
          },
        );
        const recovery = f.gateway.reconcileOwner(
          f.binding.context,
          ownerId,
          maintenance.signal,
        );
        await persisting.promise;
        maintenance.abort();
        try {
          expect(globalThis.fetch).toBe(meteredFetch);
          await expect(f.gateway.close()).rejects.toBeInstanceOf(
            AggregateError,
          );
        } finally {
          settleLedger.resolve();
          await expect(recovery).resolves.toBe(1);
        }
        expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(0);
        await expect(f.gateway.close()).resolves.toBeUndefined();
        expect(globalThis.fetch).toBe(originalFetch);
      } finally {
        await f.gateway
          .close()
          .catch((error: unknown) => {
            if (!(error instanceof AggregateError)) throw error;
          })
          .finally(async () => {
            await closeServer(f.server);
            await Promise.allSettled([collecting]);
            if (actualIteratorStopped)
              await f.gateway.reconcileOwner(
                f.binding.context,
                ownerId,
                caller,
              );
          });
      }
    });

    it('ledger提交失败拒绝成功，未知slot保留，guest不能调用恢复释放', async () => {
      const store = new FixtureStore();
      store.failFinish = true;
      const f = await setup({}, store);
      const chunks = await f.collect();
      expect(finish(chunks)).toMatchObject({
        reason: { kind: 'error', failure: { code: 'LEDGER_UNAVAILABLE' } },
      });
      expect(store.slots.get(f.binding.vm.personId)?.size).toBe(1);
      // The receipt remains unknown in its original ledger, while the
      // independently confirmed transport/transaction join can finish admission.
      expect(f.admission.records.size).toBe(0);
      expect(f.admission.finished).toHaveLength(1);
      const row = [...store.rows.values()][0]!;
      expect(row).toMatchObject({
        outcome: 'unknown',
        usage: { totalTokens: null },
      });
      await expect(
        f.gateway.reconcileOwner(
          f.binding.context,
          row.ownerId,
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(ModelGatewayError);
      expect(store.slots.get(f.binding.vm.personId)?.size).toBe(1);
    });

    it('排队后重新核现权；抢在wait前发生的容量通知不会丢失', async () => {
      const f = await setup({ hold: true });
      const calls = Array.from({ length: 8 }, () => f.collect());
      await f.upstream.whenCount(8);
      const blocked = deferred();
      f.store.beforeStart = async () => {
        f.store.beforeStart = undefined;
        blocked.resolve();
        f.upstream.complete(0);
      };
      const ninth = f.collect();
      await blocked.promise;
      await f.upstream.whenCount(9);
      for (let index = 1; index < 9; index++) f.upstream.complete(index);
      await Promise.all([...calls, ninth]);
      expect(f.store.slots.get(f.binding.vm.personId)?.size).toBe(0);
    });
  },
);
