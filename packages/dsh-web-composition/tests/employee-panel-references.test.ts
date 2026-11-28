import type { Context } from '@deepseek-ai/cordis';
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots';
import type * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  apply,
  employeePanelReferences,
} from '../src/employee-panel-references';
import { createEmployeePanelsDataPort } from '../src/employee-panels-data';
import type { EmployeePanelsSnapshot } from '../src/employee-panels-port';
import { syntheticPanelSnapshot } from './fixtures/employee-panels/presentation';
import {
  createSyntheticPanelsData,
  panelsEmployee,
  panelsViewer,
  panelsWorkspace,
  uid,
} from './fixtures/employee-panels/data';
import { unboundEmployeePanelDataClient } from '../../../apps/web/lib/chatflow/employee-panel-data';

vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useEffect: (callback: () => void) => callback(),
}));

const sessionId = 'native-panel-session' as SessionIdOf;
const scopeId = uid(8);
const organizationId = uid(4);
const threadId = uid(7);
const scopeKey = [organizationId, panelsViewer, panelsWorkspace, scopeId].join(
  '/',
);
const revision = createSyntheticPanelsData().references[0]!;
const ownerSnapshot = () => ({
  ...syntheticPanelSnapshot(scopeKey, 'list', () => undefined),
  publicationManagement: {
    organizationId,
    employeeInstanceId: panelsEmployee,
    threadId,
  },
});
const fixture = (deferred = false) => {
  const lifetime = new AbortController();
  const cleanup: (() => void)[] = [];
  const doc = {
    querySelector: () => ({
      ownerDocument: doc,
      dataset: {
        scopeId,
        organizationId,
        viewerId: panelsViewer,
        nativeSessionId: sessionId,
        employeeInstanceId: panelsEmployee,
        workspaceId: panelsWorkspace,
        threadId,
      },
    }),
  };
  const result = {
    ...createSyntheticPanelsData().selection(revision.revisionId),
    canReference: true,
  };
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify(result)),
  );
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('__ALLRICE_D_ENTRY_LIFETIME__', lifetime.signal);
  const insertReference = vi.fn(() => true);
  const binding = {
    ctx: {},
    session: { getSnapshot: () => ({ openState: 'open' }) },
  };
  const currentBinding = vi.fn(() => binding);
  const currentSession = vi.fn<() => string>(() => sessionId);
  const captureInsertion = vi.fn(() => ({ start: 1, end: 1, draftRev: 4 }));
  const registerSource = vi.fn<
    (source: {
      codec: { serialize(ref: string, signal: AbortSignal): Promise<string> };
    }) => () => void
  >(() => () => undefined);
  const registerSlot = vi.fn((_, render: (props: object) => void) => {
    render({ sessionId, inputActions: { captureInsertion } });
  });
  const native = {
    effect: (setup: () => () => void) => cleanup.push(setup()),
    sessions: { binding: currentBinding },
    sidebarRight: { mounted: { getSnapshot: currentSession } },
    conversation: { input: { for: () => ({ insertReference }) } },
    inputTriggers: { registerSource },
    slots: {
      inject: (_: string, register: () => void) => register(),
      register: registerSlot,
    },
  };
  let activate = () => {};
  apply({
    effect: native.effect,
    inject: (_, ready) => {
      activate = () => ready(native as never);
      if (!deferred) activate();
    },
  } as Context);
  const bindOwner = (
    signal: AbortSignal,
    read?: (id: SessionIdOf) => EmployeePanelsSnapshot | null,
  ) => {
    const snapshot = ownerSnapshot();
    return createEmployeePanelsDataPort(
      {
        getSnapshot: read ?? (() => snapshot),
        subscribe: () => () => undefined,
      },
      () => unboundEmployeePanelDataClient,
      signal,
    );
  };
  const port = !deferred ? bindOwner(lifetime.signal) : undefined;
  return {
    activate,
    fetch,
    result,
    lifetime,
    cleanup,
    get codec() {
      return registerSource.mock.calls[0]![0].codec;
    },
    reference: {
      insert: (
        request: Parameters<
          NonNullable<NonNullable<typeof port>['useReference']>
        >[0],
      ) => port?.useReference?.(request) ?? false,
    },
    bindOwner,
    mountEditor(id: SessionIdOf) {
      registerSlot.mock.calls[0]![1]({
        sessionId: id,
        inputActions: { captureInsertion },
      });
    },
    currentBinding,
    binding,
    currentSession,
    insertReference,
    captureInsertion,
    request: {
      sessionId,
      scopeKey,
      reference: result.selection,
      signal: lifetime.signal,
    },
  };
};

afterEach(() => vi.unstubAllGlobals());

it('binds the saved reference to the currently selected root after an in-place switch', async () => {
  const f = fixture();
  const nextId = 'another-native-panel-session' as SessionIdOf;
  const nextThread = uid(29);
  const first = ownerSnapshot();
  const next = {
    ...first,
    scopeKey: scopeId + '/' + nextThread,
    publicationManagement: {
      ...first.publicationManagement,
      threadId: nextThread,
    },
    materials: { ...first.materials, sessionId: nextThread },
    files: { ...first.files, sessionId: nextThread },
  };
  let nextView: EmployeePanelsSnapshot = next;
  const port = f.bindOwner(f.lifetime.signal, (id) =>
    id === sessionId ? first : id === nextId ? nextView : null,
  );
  expect(port.useReference?.(f.request)).toBe(true);
  const [[oldChip]] = f.insertReference.mock.calls as unknown as [
    [{ ref: string }],
  ];
  f.currentSession.mockReturnValue(nextId);
  f.mountEditor(nextId);
  expect(port.useReference?.(f.request)).toBe(false);
  await expect(
    f.codec.serialize(oldChip.ref, f.lifetime.signal),
  ).rejects.toThrow('引用已失效');
  expect(f.fetch).not.toHaveBeenCalled();
  expect(
    port.useReference?.({
      ...f.request,
      sessionId: nextId,
      scopeKey: next.scopeKey,
    }),
  ).toBe(true);
  const [, [nextChip]] = f.insertReference.mock.calls as unknown as [
    [{ ref: string }],
    [{ ref: string }],
  ];
  f.fetch.mockImplementationOnce(async () => {
    nextView = {
      ...next,
      filePreview: { objectId: uid(30), close() {} },
    };
    return new Response(JSON.stringify(f.result));
  });
  expect(await f.codec.serialize(nextChip.ref, f.lifetime.signal)).toContain(
    revision.checksum,
  );
  const request = new URL(String(f.fetch.mock.calls[0]?.[0]), 'http://fixture');
  expect(request.searchParams.get('threadId')).toBe(nextThread);
  f.cleanup.forEach((close) => close());
});

it('uses the captured native span and reselects the immutable authorized revision on submit', async () => {
  const f = fixture();
  expect(f.reference.insert(f.request)).toBe(true);
  const [chip, span] = f.insertReference.mock.calls[0] as unknown as [
    { ref: string; source: string; label: string },
    object,
  ];
  expect(chip).toMatchObject({
    source: 'allrice-panel-reference',
    label: revision.fileName,
  });
  expect(span).toEqual({ start: 1, end: 1, draftRev: 4 });
  expect(f.fetch).not.toHaveBeenCalled();
  const text = await f.codec.serialize(chip.ref, f.lifetime.signal);
  expect(text).toContain(revision.revisionId);
  expect(text).toContain(revision.checksum);
  expect(f.fetch).toHaveBeenCalledWith(
    expect.stringContaining(
      `/panels/${panelsEmployee}/materials/revisions/${revision.revisionId}/selection?`,
    ),
    expect.objectContaining({
      headers: expect.objectContaining({
        'x-allrice-expected-viewer-id': panelsViewer,
      }),
    }),
  );
  f.cleanup.forEach((close) => close());
  expect(employeePanelReferences()).toBeUndefined();
  await expect(
    f.codec.serialize(chip.ref, new AbortController().signal),
  ).rejects.toThrow('引用已失效');
});

it('projects an exact prepared deliverable without retaining unrelated response fields', async () => {
  const f = fixture();
  expect(
    f.reference.insert({
      ...f.request,
      reference: { ...revision, manifestDigest: f.result.selection.digest },
    }),
  ).toBe(true);
  const [{ ref }] = f.insertReference.mock.calls[0] as unknown as [
    { ref: string },
  ];
  expect(JSON.parse(ref)).not.toHaveProperty('ownership');
  expect(JSON.parse(ref)).not.toHaveProperty('publication');
  expect(JSON.parse(ref).digest).toBe(f.result.selection.digest);
  expect(await f.codec.serialize(ref, f.lifetime.signal)).toContain(
    revision.checksum,
  );
  f.result.selection.digest = 'sha256:' + 'f'.repeat(64);
  await expect(f.codec.serialize(ref, f.lifetime.signal)).rejects.toThrow(
    '引用已失效',
  );
  f.cleanup.forEach((close) => close());
});

it.each(['denied', 'checksum moved', 'scope changed', 'session changed'])(
  'blocks submission after %s',
  async (change) => {
    const f = fixture();
    expect(f.reference.insert(f.request)).toBe(true);
    const [{ ref }] = f.insertReference.mock.calls[0] as unknown as [
      { ref: string },
    ];
    if (change === 'denied')
      f.fetch.mockResolvedValueOnce(new Response('', { status: 403 }));
    else if (change === 'checksum moved')
      f.result.selection.checksum = 'sha256:' + 'b'.repeat(64);
    else if (change === 'scope changed')
      f.fetch.mockImplementationOnce(async () => {
        f.currentBinding.mockReturnValue({ ...f.binding, ctx: {} });
        return new Response(JSON.stringify(f.result));
      });
    else f.currentSession.mockReturnValue('another-session');
    await expect(
      f.codec.serialize(ref, f.lifetime.signal),
    ).rejects.toBeInstanceOf(Error);
    f.cleanup.forEach((close) => close());
  },
);

it('rejects an old draft reference after disposing and replacing its owner without changing the native session', async () => {
  const f = fixture();
  const owner = new AbortController();
  const old = f.bindOwner(owner.signal);
  expect(old.useReference?.(f.request)).toBe(true);
  const [[oldChip]] = f.insertReference.mock.calls as unknown as [
    [{ ref: string }],
  ];
  let release!: () => void;
  f.fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(new Response(JSON.stringify(f.result)));
      }),
  );
  const pending = f.codec.serialize(oldChip.ref, f.lifetime.signal);
  owner.abort();
  const replacement = f.bindOwner(f.lifetime.signal);
  expect(replacement.useReference?.(f.request)).toBe(true);
  release();
  await expect(pending).rejects.toBeInstanceOf(Error);
  await expect(
    f.codec.serialize(oldChip.ref, f.lifetime.signal),
  ).rejects.toThrow('引用已失效');
  expect(f.fetch).toHaveBeenCalledOnce();
  const [, [newChip]] = f.insertReference.mock.calls as unknown as [
    [{ ref: string }],
    [{ ref: string }],
  ];
  await expect(
    f.codec.serialize(newChip.ref, f.lifetime.signal),
  ).resolves.toContain(revision.revisionId);
  f.cleanup.forEach((close) => close());
});

it('restores a reference in a new authorized document for the same native session', async () => {
  const first = fixture();
  expect(first.reference.insert(first.request)).toBe(true);
  const [[chip]] = first.insertReference.mock.calls as unknown as [
    [{ ref: string }],
  ];
  first.cleanup.forEach((close) => close());

  const restored = fixture();
  await expect(
    restored.codec.serialize(chip.ref, restored.lifetime.signal),
  ).resolves.toContain(revision.revisionId);
  restored.bindOwner(restored.lifetime.signal);
  await expect(
    restored.codec.serialize(chip.ref, restored.lifetime.signal),
  ).rejects.toThrow('引用已失效');
  expect(restored.fetch).toHaveBeenCalledOnce();
  restored.cleanup.forEach((close) => close());
});

it('enables references only for the current production data port and respects native refusal', () => {
  const f = fixture(true);
  const source = syntheticPanelSnapshot(scopeKey, 'list', () => undefined);
  const snapshot = {
    ...source,
    publicationManagement: {
      organizationId,
      employeeInstanceId: panelsEmployee,
      threadId,
    },
    materials: { ...source.materials, readOnly: true },
    files: { ...source.files, readOnly: true },
  };
  const port = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  };
  const noOwner = createEmployeePanelsDataPort(
    port,
    () => null,
    f.lifetime.signal,
  );
  expect(noOwner.getSnapshot(sessionId)?.materials.readOnly).toBe(true);
  expect(noOwner.useReference?.(f.request)).toBe(false);
  const bound = createEmployeePanelsDataPort(
    port,
    () => unboundEmployeePanelDataClient,
    f.lifetime.signal,
  );
  const listener = vi.fn();
  const stop = bound.subscribe(sessionId, listener);
  expect(bound.getSnapshot(sessionId)?.materials.readOnly).toBe(true);
  expect(bound.useReference?.(f.request)).toBe(false);
  const data = bound.dataClient(sessionId);
  f.activate();
  expect(listener).toHaveBeenCalledOnce();
  expect(bound.dataClient(sessionId)).toBe(data);
  expect(bound.getSnapshot(sessionId)?.materials.readOnly).toBe(false);
  expect(bound.getSnapshot(sessionId)?.files.readOnly).toBe(false);
  expect(bound.useReference?.({ ...f.request, scopeKey: 'stale' })).toBe(false);
  expect(
    bound.useReference?.({ ...f.request, sessionId: 'stale' as SessionIdOf }),
  ).toBe(false);
  expect(f.insertReference).not.toHaveBeenCalled();
  f.insertReference.mockReturnValue(false);
  expect(bound.useReference?.(f.request)).toBe(false);
  expect(f.insertReference).toHaveBeenCalledOnce();
  stop();
  f.cleanup.forEach((close) => close());
});
