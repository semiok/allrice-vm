import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import type { NativeHistoryCut } from '@allrice/dsh-native-history-source/types';
import type { HostHistoryBinding } from '@allrice/contracts';
import {
  HostHistoryStore,
  hostHistoryDigest,
  HostHistoryIntegrityError,
} from '@allrice/storage';
import { HostHistorySourceStore } from '@allrice/storage';
import { checkpointNativeHistory } from './history-checkpoint.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const signal = () => new AbortController().signal;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'history-checkpoint-'));
  roots.push(root);
  const snapshots = new HostHistoryStore(root),
    sources = new HostHistorySourceStore(root, snapshots);
  const binding: HostHistoryBinding = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    personId: randomUUID(),
    employeeInstanceId: randomUUID(),
    threadId: randomUUID(),
    nativeInstanceRef: 'actual-original-host-receipt',
    nativeProfileRef: 'actual-original-profile-receipt',
    nativeSessionId: 'root',
    rootNativeSessionId: 'root',
    parentNativeSessionId: null,
    configurationRef: 'original-configuration-release',
    configurationDigest: hostHistoryDigest({ original: 'configuration' }),
    executionGeneration: '4.0',
  };
  const cut: NativeHistoryCut = {
    rootSessionId: 'root',
    sessions: [
      {
        meta: {
          id: SessionId('root'),
          version: 4,
          createdAt: 1,
          isSeeded: false,
        },
        inheritedEventCount: 0,
        events: [
          {
            type: 'subagent/catalog',
            seq: SessionSeq(0),
            time: 2,
            data: {
              version: 0,
              childId: SessionId('child'),
              childCreatedAt: 2,
              mode: 'one-shot',
            },
          },
        ],
        catalog: [{ id: SessionId('child'), createdAt: 2, mode: 'one-shot' }],
      },
      {
        meta: {
          id: SessionId('child'),
          version: 4,
          createdAt: 2,
          isSeeded: false,
        },
        inheritedEventCount: 0,
        events: [],
        catalog: [],
      },
    ],
  };
  const key = {
    organizationId: binding.organizationId,
    workspaceId: binding.workspaceId,
    personId: binding.personId,
    employeeInstanceId: binding.employeeInstanceId,
    threadId: binding.threadId,
    rootNativeSessionId: 'root',
    rootOriginDigest: hostHistoryDigest('actual-sql-root-pin'),
    rootBindingRef: 'actual-root-create-operation',
    vmId: randomUUID(),
  };
  // Synthetic native cuts contain no attachments. Production requires the real
  // attachment owner even when its eventual result is empty.
  const input = {
    key,
    originalBindings: [
      binding,
      { ...binding, nativeSessionId: 'child', parentNativeSessionId: 'root' },
    ],
    native: {
      binding: {
        vmId: key.vmId,
        instanceId: 'actual-original-host-receipt',
        organizationId: key.organizationId,
        personId: key.personId,
        leaseEpoch: 1,
      },
      endpoint: {
        workspaceId: key.workspaceId,
        employeeInstanceId: key.employeeInstanceId,
      },
      profile: {
        nativeProfileRef: 'actual-original-profile-receipt',
        configurationRef: 'original-configuration-release',
        configurationDigest: hostHistoryDigest({ original: 'configuration' }),
      },
      revoked: signal(),
      assertCurrent: vi.fn(async () => {}),
      readCut: vi.fn(async () => JSON.stringify(cut)),
    },
    authorize: vi.fn<
      Parameters<typeof checkpointNativeHistory>[0]['authorize']
    >(async (binding) => ({ binding, revoked: signal() })),
    attachments: vi.fn<
      Parameters<typeof checkpointNativeHistory>[0]['attachments']
    >(async () => []),
    snapshots,
    sources,
    signal: signal(),
  };
  return { input, cut, binding, key, root };
}

describe('native history checkpoint', () => {
  it('captures real safe snapshots then atomically commits the original source vector', async () => {
    const f = await fixture();
    const result = await checkpointNativeHistory(f.input);
    expect((await f.input.sources.read(f.key, signal()))!.digest).toBe(
      result.digest,
    );
    expect(
      result.manifest.sessions.map((row) => row.binding.nativeSessionId),
    ).toEqual(['root', 'child']);
    expect(result.manifest.edges[0]!.parentEvent).toEqual(
      f.cut.sessions[0]!.events[0],
    );
    for (const row of result.manifest.sessions) {
      const snapshot = await f.input.snapshots.read(
        row.binding,
        signal(),
        row.snapshotDigest,
      );
      expect(snapshot!.snapshot.binding.configurationDigest).toBe(
        f.binding.configurationDigest,
      );
      expect(snapshot!.snapshot.source.headerHash).toBe(
        hostHistoryDigest(row.header),
      );
      const original = f.cut.sessions.find(
        (cut) => cut.meta.id === row.binding.nativeSessionId,
      )!;
      expect(snapshot!.snapshot.source.throughSeq).toBe(
        original.events.length - 1,
      );
      expect(snapshot!.snapshot.source.eventHashes).toEqual(
        original.events.map(hostHistoryDigest),
      );
    }
    expect(f.input.native.readCut).toHaveBeenCalledTimes(1);
    expect(f.input.native.assertCurrent).toHaveBeenCalledTimes(3);
  });
  it('rejects valid cuts from a different actual VM, host, employee endpoint or profile before reading', async () => {
    const f = await fixture();
    for (const native of [
      {
        ...f.input.native,
        binding: { ...f.input.native.binding, vmId: randomUUID() },
      },
      {
        ...f.input.native,
        binding: { ...f.input.native.binding, instanceId: randomUUID() },
      },
      {
        ...f.input.native,
        binding: { ...f.input.native.binding, personId: randomUUID() },
      },
      {
        ...f.input.native,
        endpoint: {
          ...f.input.native.endpoint,
          employeeInstanceId: randomUUID(),
        },
      },
      {
        ...f.input.native,
        profile: {
          ...f.input.native.profile,
          nativeProfileRef: 'wrong-profile',
        },
      },
      {
        ...f.input.native,
        profile: {
          ...f.input.native.profile,
          configurationDigest: hostHistoryDigest('wrong-configuration'),
        },
      },
    ]) {
      await expect(
        checkpointNativeHistory({ ...f.input, native }),
      ).rejects.toBeInstanceOf(HostHistoryIntegrityError);
    }
    expect(f.input.native.readCut).not.toHaveBeenCalled();
    expect(f.input.attachments).not.toHaveBeenCalled();
  });
  it('rechecks the actual owner after awaiting the native cut and refuses late bytes', async () => {
    const f = await fixture();
    const revoked = Error('native owner replaced');
    f.input.native.assertCurrent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(revoked);
    await expect(checkpointNativeHistory(f.input)).rejects.toBe(revoked);
    expect(f.input.native.readCut).toHaveBeenCalledTimes(1);
    expect(f.input.attachments).not.toHaveBeenCalled();
    expect(await f.input.sources.read(f.key, signal())).toBeNull();
  });
  it('uses a verified birth cut for the same VM and employee after restart without rewriting birth provenance', async () => {
    const f = await fixture();
    const original = await checkpointNativeHistory(f.input);
    const native = {
      ...f.input.native,
      binding: {
        ...f.input.native.binding,
        instanceId: randomUUID(),
        leaseEpoch: 2,
      },
    };
    const result = await checkpointNativeHistory({ ...f.input, native });
    expect(result).toEqual(original);
    expect(result.manifest.sessions[0]!.binding.nativeInstanceRef).toBe(
      f.input.native.binding.instanceId,
    );
    expect(native.readCut).toHaveBeenCalledTimes(2);

    await expect(
      checkpointNativeHistory({
        ...f.input,
        native,
        key: { ...f.key, rootBindingRef: randomUUID() },
      }),
    ).rejects.toBeInstanceOf(HostHistoryIntegrityError);
    await expect(
      checkpointNativeHistory({
        ...f.input,
        native: {
          ...native,
          endpoint: { ...native.endpoint, employeeInstanceId: randomUUID() },
        },
      }),
    ).rejects.toBeInstanceOf(HostHistoryIntegrityError);
    expect(native.readCut).toHaveBeenCalledTimes(2);

    const unrelated = structuredClone(f.cut);
    Object.assign(unrelated.sessions[0]!.meta, { createdAt: 9 });
    f.input.attachments.mockClear();
    await expect(
      checkpointNativeHistory({
        ...f.input,
        native: { ...native, readCut: async () => JSON.stringify(unrelated) },
      }),
    ).rejects.toBeInstanceOf(HostHistoryIntegrityError);
    expect(f.input.attachments).not.toHaveBeenCalled();
    expect(await f.input.sources.read(f.key, signal())).toEqual({
      digest: original.digest,
      manifest: original.manifest,
    });
  });
  it('does not reconstruct missing original facts or dispatch a read without them', async () => {
    const f = await fixture();
    await expect(
      checkpointNativeHistory({ ...f.input, originalBindings: [] }),
    ).rejects.toBeInstanceOf(HostHistoryIntegrityError);
    expect(f.input.native.readCut).not.toHaveBeenCalled();
    const wrong = {
      ...f.binding,
      configurationDigest: 'not-a-recorded-digest',
    };
    await expect(
      checkpointNativeHistory({ ...f.input, originalBindings: [wrong] }),
    ).rejects.toBeDefined();
    expect(f.input.native.readCut).not.toHaveBeenCalled();
  });
  it('refuses extra/missing sessions, fork-only ancestry and inherited catalog proof', async () => {
    const f = await fixture();
    for (const mutate of [
      (c: NativeHistoryCut) => {
        (c.sessions as unknown[]).pop();
      },
      (c: NativeHistoryCut) => {
        (c.sessions[0]!.events as unknown[]).splice(0);
      },
      (c: NativeHistoryCut) => {
        Object.assign(c.sessions[0]!, { inheritedEventCount: 1 });
      },
      (c: NativeHistoryCut) => {
        Object.assign(c.sessions[1]!.meta, { createdAt: 3 });
      },
    ]) {
      const bad = structuredClone(f.cut);
      mutate(bad);
      await expect(
        checkpointNativeHistory({
          ...f.input,
          native: {
            ...f.input.native,
            readCut: async () => JSON.stringify(bad),
          },
        }),
      ).rejects.toBeDefined();
      expect(await f.input.sources.read(f.key, signal())).toBeNull();
    }
  });
  it('leaves published snapshots uncommitted if the real manifest publication fails', async () => {
    const f = await fixture();
    vi.spyOn(f.input.sources, 'publish').mockRejectedValue(
      new Error('fixture-manifest-failed'),
    );
    await expect(checkpointNativeHistory(f.input)).rejects.toThrow(
      'fixture-manifest-failed',
    );
    expect(await f.input.snapshots.read(f.binding, signal())).not.toBeNull();
    expect(await f.input.sources.read(f.key, signal())).toBeNull();
  });
  it('waits for cancelled native I/O to actually settle and never commits a late reply', async () => {
    const f = await fixture(),
      entered = gate(),
      finish = gate(),
      controller = new AbortController();
    const readCut = vi.fn(async () => {
      entered.release();
      await finish.promise;
      return JSON.stringify(f.cut);
    });
    const work = checkpointNativeHistory({
      ...f.input,
      native: { ...f.input.native, readCut },
      signal: controller.signal,
    });
    let settled = false;
    void work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await entered.promise;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.input.attachments).not.toHaveBeenCalled();
    finish.release();
    await expect(work).rejects.toBeDefined();
    expect(await f.input.sources.read(f.key, signal())).toBeNull();
  });
  it('validates the serialized header/log through native restoration before publication', async () => {
    const f = await fixture();
    const malformed = structuredClone(f.cut);
    Object.assign(malformed.sessions[0]!.meta, {
      isSeeded: 'not-a-native-boolean',
    });
    await expect(
      checkpointNativeHistory({
        ...f.input,
        native: {
          ...f.input.native,
          readCut: async () => JSON.stringify(malformed),
        },
      }),
    ).rejects.toThrow();
    expect(await f.input.sources.read(f.key, signal())).toBeNull();
    expect(f.input.attachments).not.toHaveBeenCalled();
  });
  it('cancels on an earlier session grant revocation during a later attachment export', async () => {
    const f = await fixture(),
      revoked = new AbortController(),
      entered = gate(),
      finish = gate();
    f.input.authorize.mockImplementation(async (binding) => ({
      binding,
      revoked: revoked.signal,
    }));
    f.input.attachments.mockImplementation(async () => {
      entered.release();
      await finish.promise;
      return [];
    });
    const work = checkpointNativeHistory(f.input);
    await entered.promise;
    revoked.abort();
    finish.release();
    await expect(work).rejects.toBeDefined();
    expect(await f.input.sources.read(f.key, signal())).toBeNull();
  });
  it('immediately aborts and joins the next authorization when the first grant is revoked', async () => {
    const f = await fixture();
    const first = new AbortController();
    const entered = gate(),
      finish = gate();
    let laterSignal: AbortSignal | undefined;
    f.input.authorize
      .mockImplementationOnce(async (binding) => ({
        binding,
        revoked: first.signal,
      }))
      .mockImplementationOnce(async (binding, active) => {
        laterSignal = active;
        entered.release();
        await finish.promise;
        return { binding, revoked: signal() };
      });
    const work = checkpointNativeHistory(f.input);
    const done = vi.fn();
    void work.then(done, done);
    await entered.promise;
    const reason = Error('original grant revoked');
    try {
      first.abort(reason);
      expect(laterSignal?.reason).toBe(reason);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(done).not.toHaveBeenCalled();
      expect(f.input.native.readCut).not.toHaveBeenCalled();
    } finally {
      finish.release();
      await expect(work).rejects.toBe(reason);
    }
  });
  it('propagates a later root grant revocation to an independently authorized child and joins its attachment I/O', async () => {
    const f = await fixture();
    const late = new AbortController();
    const entered = gate(),
      finish = gate();
    let rootReads = 0;
    let attachmentSignal: AbortSignal | undefined;
    f.input.authorize.mockImplementation(async (binding) => ({
      binding,
      revoked:
        binding.nativeSessionId === 'root' && ++rootReads === 2
          ? late.signal
          : signal(),
    }));
    f.input.attachments.mockImplementation(async (binding, active) => {
      if (binding.nativeSessionId === 'child') {
        attachmentSignal = active;
        entered.release();
        await finish.promise;
      }
      return [];
    });
    const work = checkpointNativeHistory(f.input);
    const done = vi.fn();
    void work.then(done, done);
    await entered.promise;
    const reason = Error('renewed root grant revoked');
    try {
      late.abort(reason);
      expect(attachmentSignal?.reason).toBe(reason);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(done).not.toHaveBeenCalled();
    } finally {
      finish.release();
      await expect(work).rejects.toBe(reason);
    }
    expect(await f.input.sources.read(f.key, signal())).toBeNull();
  });
});
