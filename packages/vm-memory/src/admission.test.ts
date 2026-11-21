import { describe, expect, it } from 'vitest';
import type { PersonVmBinding } from '@allrice/person-vm';
import { createVmMemoryAdmission } from './admission.ts';
import { VmMemoryError } from './contract.ts';
import { FixtureMemorySource, memoryObservation } from './memory.fixture.ts';

const binding: PersonVmBinding = {
  vmId: 'synthetic-vm',
  personId: 'synthetic-person',
  organizationId: 'synthetic-org',
  instanceId: 'synthetic-instance',
  leaseEpoch: 1,
};
describe.sequential('external VM memory admission', () => {
  it('压力排队只认host事实；guest自报空闲不能放行，host正常也不由guest诊断改判', async () => {
    const source = new FixtureMemorySource(binding, 'pressure');
    const controller = new AbortController();
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      controller.signal,
    );
    try {
      expect(watch.read()).toBe('queued');
      const wait = watch.wait();
      source.publish(memoryObservation(binding));
      await wait;
      expect(watch.read()).toBe('ready');
      source.publish({
        ...memoryObservation(binding),
        guest: {
          ramBytes: 1,
          availableBytes: 0,
          swapTotalBytes: 1,
          swapFreeBytes: 0,
          commandRamBytes: 1,
          commandSwapBytes: 1,
          dshRamBytes: 1,
          dshSwapBytes: 1,
          commandOomKills: 99,
          parentLocalOoms: 99,
          globalOomKills: 99,
        },
      });
      expect(watch.read()).toBe('ready');
    } finally {
      await watch.close();
    }
    expect(source.subscribers.size).toBe(0);
  });

  it.each([
    'vmId',
    'personId',
    'organizationId',
    'instanceId',
    'leaseEpoch',
  ] as const)('拒绝其他%s的观察，不能从guest或旧epoch获得放行', async (key) => {
    const source = new FixtureMemorySource(binding);
    source.publish({
      ...memoryObservation(binding),
      binding: {
        ...binding,
        [key]: key === 'leaseEpoch' ? 2 : 'other',
      },
    });
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      new AbortController().signal,
    );
    try {
      expect(() => watch.read()).toThrow('内存观察与当前会话实例不一致');
    } finally {
      await watch.close();
    }
  });

  it('物理cap需provider实读；配置值或guest MemTotal不能代替enforced readback', async () => {
    const source = new FixtureMemorySource(binding);
    const observation = memoryObservation(binding);
    source.publish({
      ...observation,
      physical: { ...observation.physical, enforcedBytes: 4 * 1024 ** 3 },
    });
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      new AbortController().signal,
    );
    try {
      expect(() => watch.read()).toThrow('虚拟机内存配置未通过核实');
    } finally {
      await watch.close();
    }
  });

  it('host计量未知用显式null；漏字段不能冒称完整观察', async () => {
    const source = new FixtureMemorySource(binding);
    source.publish({
      ...memoryObservation(binding),
      host: {
        vmRssBytes: null,
        helperRssBytes: null,
        swapBytes: null,
      },
    });
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      new AbortController().signal,
    );
    try {
      expect(watch.read()).toBe('ready');
      source.publish({
        ...memoryObservation(binding),
        host: {},
      } as unknown as ReturnType<typeof memoryObservation>);
      expect(() => watch.read()).toThrow(VmMemoryError);
    } finally {
      await watch.close();
    }
  });

  it.each([null, 'unavailable'] as const)(
    '观察缺失/失效%s不默认放行',
    async (value) => {
      const source = new FixtureMemorySource(binding);
      source.publish(value === null ? null : memoryObservation(binding, value));
      const watch = await createVmMemoryAdmission(source).watch(
        binding,
        new AbortController().signal,
      );
      try {
        expect(() => watch.read()).toThrow(VmMemoryError);
      } finally {
        await watch.close();
      }
    },
  );

  it('先订阅再读，wait前的通知不丢；取消关闭等真实detach且close幂等', async () => {
    const source = new FixtureMemorySource(binding, 'pressure');
    const controller = new AbortController();
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      controller.signal,
    );
    source.publish(memoryObservation(binding));
    await watch.wait();
    expect(watch.read()).toBe('ready');
    const pending = watch.wait().catch((error: unknown) => error);
    controller.abort(new Error('synthetic-cancel'));
    expect(await pending).toMatchObject({ message: 'synthetic-cancel' });
    await watch.close();
    await watch.close();
    expect(source.subscribers.size).toBe(0);
  });
});
