import type { Context } from '@deepseek-ai/cordis';
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots';
import { afterEach, expect, it, vi } from 'vitest';
import {
  apply,
  employeePanelReferences,
} from '../src/employee-panel-references';
import { createEmployeePanelsDataPort } from '../src/employee-panels-data';
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
  ...(await original<typeof import('react')>()),
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
const fixture = () => {
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
  const fetch = vi.fn(async () => new Response(JSON.stringify(result)));
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
  const registerSource = vi.fn(() => () => undefined);
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
  apply({ inject: (_, ready) => ready(native as never) } as Context);
  const reference = employeePanelReferences()!;
  const codec = (
    registerSource.mock.calls[0] as unknown as [
      {
        codec: { serialize(ref: string, signal: AbortSignal): Promise<string> };
      },
    ]
  )[0].codec;
  return {
    fetch,
    result,
    lifetime,
    cleanup,
    codec,
    reference,
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
  expect(f.reference.insert({ ...f.request, reference: revision })).toBe(true);
  const [{ ref }] = f.insertReference.mock.calls[0] as unknown as [
    { ref: string },
  ];
  expect(JSON.parse(ref)).not.toHaveProperty('ownership');
  expect(JSON.parse(ref)).not.toHaveProperty('publication');
  expect(await f.codec.serialize(ref, f.lifetime.signal)).toContain(
    revision.checksum,
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

it('enables references only for the current production data port and respects native refusal', () => {
  const f = fixture();
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
  f.cleanup.forEach((close) => close());
});
