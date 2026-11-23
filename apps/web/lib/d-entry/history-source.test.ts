import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HostHistoryBinding,
  HostHistorySnapshot,
  HostHistoryStorePort,
  RequestContext,
} from '@allrice/contracts';
import { DataAccessError, type DEntryHistoryRootPin } from '@allrice/database';
import {
  HostHistoryStore,
  hostHistoryDigest,
  HostHistoryIntegrityError,
  HostHistorySourceStore,
  type HostHistorySource,
} from '@allrice/storage';
import { createColdHistorySource } from './history-source';

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
  const root = await mkdtemp(join(tmpdir(), 'cold-history-'));
  roots.push(root);
  const raw = new HostHistoryStore(root),
    sources = new HostHistorySourceStore(root, raw);
  const b: HostHistoryBinding = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    personId: randomUUID(),
    employeeInstanceId: randomUUID(),
    threadId: randomUUID(),
    nativeInstanceRef: 'original-instance',
    nativeProfileRef: 'original-profile',
    nativeSessionId: 'root',
    rootNativeSessionId: 'root',
    parentNativeSessionId: null,
    configurationRef: 'original-release',
    configurationDigest: hostHistoryDigest('original-config'),
    executionGeneration: '4.0',
  };
  const pin: DEntryHistoryRootPin = {
    identity: {
      organizationId: b.organizationId,
      workspaceId: b.workspaceId,
      personId: b.personId,
      employeeInstanceId: b.employeeInstanceId,
      employeeRevision: 4,
      employeeVersionId: randomUUID(),
      threadId: b.threadId,
    },
    rootNativeSessionId: 'root',
    rootOriginDigest: hostHistoryDigest('original-sql-root'),
    rootBindingRef: 'original-root-binding',
    vmId: randomUUID(),
  };
  const context = {
    organizationId: b.organizationId,
    workspaceId: b.workspaceId,
    sessionId: randomUUID(),
    actor: { id: b.personId, type: 'user' },
  } as RequestContext;
  const header = {
    id: 'root',
    version: 4 as const,
    createdAt: 1,
    isSeeded: false,
  };
  const snapshot = (count: number): HostHistorySnapshot => ({
    schemaVersion: 1,
    binding: b,
    source: {
      dshVersion: '0.2.1-rc.2',
      sessionFormatVersion: 4,
      headerHash: hostHistoryDigest(header),
      inheritedEventCount: 0,
      throughSeq: count - 1,
      eventHashes: Array.from({ length: count }, (_, index) =>
        hostHistoryDigest({ index }),
      ),
    },
    entries: [],
    attachments: [],
    lastTurn: { startSeq: null, endSeq: null, reason: null },
  });
  const firstDigest = await raw.publish(snapshot(0), signal());
  const key = {
    organizationId: b.organizationId,
    workspaceId: b.workspaceId,
    personId: b.personId,
    employeeInstanceId: b.employeeInstanceId,
    threadId: b.threadId,
    rootNativeSessionId: pin.rootNativeSessionId,
    rootOriginDigest: pin.rootOriginDigest,
    rootBindingRef: pin.rootBindingRef,
    vmId: pin.vmId,
  };
  const manifest: HostHistorySource = {
    schemaVersion: 1,
    key,
    sessions: [{ binding: b, snapshotDigest: firstDigest, header }],
    edges: [],
  };
  return {
    root,
    raw,
    sources,
    b,
    pin,
    context,
    snapshot,
    key,
    manifest,
    firstDigest,
  };
}

describe('request-owned cold history composition', () => {
  it('reads a stopped/absent VM entirely from committed host files and original config', async () => {
    const f = await fixture();
    await f.sources.publish(f.manifest, signal());
    // No VM/native/lease/prewarm/Agent/credential port exists in this composition.
    const scope = createColdHistorySource({
      sources: f.sources,
      signal: signal(),
    });
    const resource = await scope.resolveColdResource(
      f.context,
      f.pin,
      'root',
      signal(),
    );
    expect(resource.parentNativeSessionId).toBeNull();
    expect(resource.bindingRef).toBe(f.pin.rootBindingRef);
    const binding = await scope.binding(resource, signal());
    expect(binding).toEqual(f.b);
    expect((await scope.store.read(binding, signal()))!.digest).toBe(
      f.firstDigest,
    );
    await scope.close();
    await expect(scope.binding(resource, signal())).rejects.toBeDefined();
  });
  it('freezes resource, binding and all explicit page/download digests to one manifest', async () => {
    const f = await fixture();
    await f.sources.publish(f.manifest, signal());
    const scope = createColdHistorySource({
      sources: f.sources,
      signal: signal(),
    });
    const resource = await scope.resolveColdResource(
      f.context,
      f.pin,
      'root',
      signal(),
    );
    const nextDigest = await f.raw.publish(f.snapshot(1), signal());
    const next = structuredClone(f.manifest);
    next.sessions[0]!.snapshotDigest = nextDigest;
    await f.sources.publish(next, signal());
    expect(
      (await scope.store.read(
        await scope.binding(resource, signal()),
        signal(),
      ))!.digest,
    ).toBe(f.firstDigest);
    await expect(
      scope.store.read(f.b, signal(), nextDigest),
    ).rejects.toBeInstanceOf(HostHistoryIntegrityError);
    const repeat = await scope.resolveColdResource(
      f.context,
      f.pin,
      'root',
      signal(),
    );
    expect(repeat.bindingRef).toBe(resource.bindingRef);
    expect(await scope.binding(repeat, signal())).toEqual(f.b);
    const fresh = createColdHistorySource({
      sources: f.sources,
      signal: signal(),
    });
    await fresh.resolveColdResource(f.context, f.pin, 'root', signal());
    expect((await fresh.store.read(f.b, signal()))!.digest).toBe(nextDigest);
    await Promise.all([scope.close(), fresh.close()]);
  });
  it('does not turn raw publish success into a cold source', async () => {
    const f = await fixture();
    const scope = createColdHistorySource({
      sources: f.sources,
      signal: signal(),
    });
    await expect(
      scope.resolveColdResource(f.context, f.pin, 'root', signal()),
    ).rejects.toThrow();
    await expect(
      scope.store.read(f.b, signal(), f.firstDigest),
    ).rejects.toBeDefined();
    await scope.close();
  });
  it('authorizes a stored child only through the same committed parent catalog proof', async () => {
    const f = await fixture();
    const event = {
      type: 'subagent/catalog' as const,
      seq: 0,
      time: 2,
      data: {
        version: 0 as const,
        childId: 'child',
        childCreatedAt: 2,
        mode: 'one-shot' as const,
      },
    };
    const parent = f.snapshot(1);
    parent.source.eventHashes = [hostHistoryDigest(event)];
    const childHeader = {
      id: 'child',
      version: 4 as const,
      createdAt: 2,
      isSeeded: false,
    };
    const child: HostHistorySnapshot = {
      ...f.snapshot(0),
      binding: {
        ...f.b,
        nativeSessionId: 'child',
        parentNativeSessionId: 'root',
      },
    };
    child.source.headerHash = hostHistoryDigest(childHeader);
    f.manifest.sessions[0]!.snapshotDigest = await f.raw.publish(
      parent,
      signal(),
    );
    f.manifest.sessions.push({
      binding: child.binding,
      snapshotDigest: await f.raw.publish(child, signal()),
      header: childHeader,
    });
    f.manifest.edges.push({
      parentNativeSessionId: 'root',
      childNativeSessionId: 'child',
      parentEvent: event,
    });
    const sourceDigest = await f.sources.publish(f.manifest, signal());
    const scope = createColdHistorySource({
      sources: f.sources,
      signal: signal(),
    });
    const resource = await scope.resolveColdResource(
      f.context,
      f.pin,
      'child',
      signal(),
    );
    expect(resource.parentNativeSessionId).toBe('root');
    expect(resource.bindingRef).toBe(
      hostHistoryDigest({ sourceDigest, binding: child.binding }),
    );
    expect(await scope.binding(resource, signal())).toEqual(child.binding);
    expect(
      (await scope.store.read(child.binding, signal()))!.snapshot.binding,
    ).toEqual(child.binding);
    await expect(
      scope.binding({ ...resource, parentNativeSessionId: null }, signal()),
    ).rejects.toBeDefined();
    await scope.close();
  });
  it('rejects a changed current root/birth/config binding or another request', async () => {
    const f = await fixture();
    await f.sources.publish(f.manifest, signal());
    const scope = createColdHistorySource({
      sources: f.sources,
      signal: signal(),
    });
    const resource = await scope.resolveColdResource(
      f.context,
      f.pin,
      'root',
      signal(),
    );
    for (const field of [
      'rootNativeSessionId',
      'rootOriginDigest',
      'rootBindingRef',
      'vmId',
    ] as const) {
      await expect(
        scope.resolveColdResource(
          f.context,
          { ...f.pin, [field]: 'changed' },
          'root',
          signal(),
        ),
      ).rejects.toBeInstanceOf(DataAccessError);
    }
    await expect(
      scope.resolveColdResource(
        { ...f.context, sessionId: randomUUID() },
        f.pin,
        'root',
        signal(),
      ),
    ).rejects.toBeDefined();
    await expect(
      scope.resolveColdResource(f.context, f.pin, 'missing-child', signal()),
    ).rejects.toBeDefined();
    await expect(
      scope.binding({ ...resource, bindingRef: 'current-epoch' }, signal()),
    ).rejects.toBeDefined();
    await expect(
      scope.store.read(
        { ...f.b, configurationRef: 'current-release' },
        signal(),
      ),
    ).rejects.toBeDefined();
    await scope.close();
  });
  it('uses existing request revocation and joins source read on close, without a live lease/watch', async () => {
    const f = await fixture();
    await f.sources.publish(f.manifest, signal());
    const entered = gate(),
      finish = gate(),
      controller = new AbortController();
    const read = f.sources.read.bind(f.sources);
    vi.spyOn(f.sources, 'read').mockImplementation(async (key, active) => {
      entered.release();
      await finish.promise;
      return read(key, active);
    });
    const scope = createColdHistorySource({
      sources: f.sources,
      signal: controller.signal,
    });
    const work = scope.resolveColdResource(
      f.context,
      f.pin,
      'root',
      controller.signal,
    );
    await entered.promise;
    controller.abort();
    let joined = false;
    const closing = scope.close().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    finish.release();
    await expect(work).rejects.toBeDefined();
    await closing;
    expect(joined).toBe(true);
  });
  it('joins a cancelled raw snapshot read through the same pinned committed adapter', async () => {
    const f = await fixture(),
      entered = gate(),
      finish = gate();
    const originalRead = f.raw.read.bind(f.raw);
    let hold = false;
    const wrapped: HostHistoryStorePort = {
      publish: f.raw.publish.bind(f.raw),
      async read(...args) {
        if (hold) {
          entered.release();
          await finish.promise;
        }
        return originalRead(...args);
      },
    };
    const sources = new HostHistorySourceStore(f.root, wrapped);
    await sources.publish(f.manifest, signal());
    const controller = new AbortController(),
      scope = createColdHistorySource({ sources, signal: controller.signal });
    await scope.resolveColdResource(f.context, f.pin, 'root', signal());
    hold = true;
    const work = scope.store.read(f.b, signal());
    await entered.promise;
    const closing = scope.close();
    let done = false;
    void closing.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    finish.release();
    await expect(work).rejects.toBeDefined();
    await closing;
    expect(done).toBe(true);
  });
});
