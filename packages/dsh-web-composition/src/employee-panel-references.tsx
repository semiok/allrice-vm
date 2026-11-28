import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {
  PropsRuntime,
  SessionIdOf,
} from '@deepseek-ai/dsh-client-ui-slots';
import { ReferenceSelectionSchema } from '@allrice/contracts';
import { useEffect } from 'react';
import { z } from 'zod';
import { createEmployeePanelsHttpClient } from '../../../apps/web/lib/chatflow/employee-panel-data-http';
import { readEmployeeDocument } from '../../../apps/web/lib/d-entry/profile-browser';
import type {
  EmployeePanelsPort,
  EmployeePanelsSnapshot,
} from './employee-panels-port';

const source = 'allrice-panel-reference';
const pin = ReferenceSelectionSchema.pick({
  sourceId: true,
  revisionId: true,
  revision: true,
  checksum: true,
  fileName: true,
})
  .strip()
  .extend({ digest: ReferenceSelectionSchema.shape.digest.optional() });
const selectionPin = pin.extend({
  manifestDigest: ReferenceSelectionSchema.shape.digest.optional(),
});
const occurrence = pin
  .extend({
    version: z.literal(1),
    sessionId: z.string().min(1),
    documentId: z.uuid(),
    ownerEpoch: z.number().int().positive(),
  })
  .strict();
const unavailable = () => new Error('这条引用已失效，请从工作台重新选择。');
type InputDock = PropsRuntime<'conversation.input.dock'>;
type ReferenceRequest = Parameters<
  NonNullable<EmployeePanelsPort['useReference']>
>[0];

interface DocumentReferences {
  matches(sessionId: SessionIdOf, snapshot: EmployeePanelsSnapshot): boolean;
  insert(request: ReferenceRequest, ownerEpoch: number): boolean;
}

// The sealed document and Cordis owner share this lifetime. Existing business
// binders keep their own independent snapshots, without relying on a new
// global auth source or a port added to the memory/capability owners.
interface ReferenceSource {
  readonly current: DocumentReferences | undefined;
  subscribe(listener: () => void): () => void;
  bindOwner(
    signal: AbortSignal,
    read: (id: SessionIdOf) => EmployeePanelsSnapshot | null,
  ): number;
}

const documents = new WeakMap<Document, ReferenceSource>();
export function employeePanelReferences() {
  return typeof document === 'undefined' ? undefined : documents.get(document);
}

export function apply(ctx: Context) {
  const lifetime = (
    globalThis as typeof globalThis & {
      __ALLRICE_D_ENTRY_LIFETIME__?: AbortSignal;
    }
  ).__ALLRICE_D_ENTRY_LIFETIME__;
  if (!lifetime || lifetime.aborted) return;
  const page = document.querySelector<HTMLElement>('#app');
  if (!page || documents.has(document)) return;
  const { organizationId, viewerId, nativeSessionId, selection } =
    readEmployeeDocument(page.dataset);
  const { threadId, workspaceId, employeeInstanceId } = selection;
  if (!threadId || !nativeSessionId) return;
  const documentId = crypto.randomUUID();

  // Publish the document slot before the panels owner starts. Cordis may
  // activate the input services later than the existing business binder.
  let currentReferences: DocumentReferences | undefined;
  let ownerEpoch = 0;
  let panelOwner:
    | {
        epoch: number;
        signal: AbortSignal;
        replace: AbortController;
        read: (id: SessionIdOf) => EmployeePanelsSnapshot | null;
      }
    | undefined;
  const listeners = new Set<() => void>();
  const referenceSource: ReferenceSource = {
    get current() {
      return currentReferences;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bindOwner(signal, read) {
      if (signal.aborted || lifetime.aborted) return 0;
      panelOwner?.replace.abort();
      const replace = new AbortController();
      const next = {
        epoch: ++ownerEpoch,
        signal: AbortSignal.any([signal, lifetime, replace.signal]),
        replace,
        read,
      };
      panelOwner = next;
      next.signal.addEventListener(
        'abort',
        () => {
          if (panelOwner === next) panelOwner = undefined;
        },
        { once: true },
      );
      return next.epoch;
    },
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const publish = (bridge: DocumentReferences | undefined) => {
    if (currentReferences === bridge) return;
    currentReferences = bridge;
    notify();
  };
  const clear = () => publish(undefined);
  documents.set(page.ownerDocument, referenceSource);
  lifetime.addEventListener('abort', clear, { once: true });
  ctx.effect(() => () => {
    lifetime.removeEventListener('abort', clear);
    if (documents.get(page.ownerDocument) === referenceSource)
      documents.delete(page.ownerDocument);
    panelOwner?.replace.abort();
    clear();
    listeners.clear();
  });

  ctx.inject(
    ['slots', 'sessions', 'conversation', 'sidebarRight', 'inputTriggers'],
    (native) => {
      if (lifetime.aborted) return;
      const owner = new AbortController();
      const active = AbortSignal.any([lifetime, owner.signal]);
      const editors = new Map<SessionIdOf, InputDock['inputActions']>();
      function Capture({ sessionId, inputActions }: InputDock) {
        useEffect(() => {
          editors.set(sessionId, inputActions);
          notify();
          return () => {
            if (editors.get(sessionId) === inputActions) {
              editors.delete(sessionId);
              notify();
            }
          };
        }, [sessionId, inputActions]);
        return null;
      }
      const current = (id: string) => {
        const mounted = native.sidebarRight.mounted.getSnapshot();
        if (active.aborted || mounted === undefined || mounted !== id) return;
        const binding = native.sessions.binding(mounted);
        return binding?.session.getSnapshot().openState === 'open'
          ? binding
          : undefined;
      };
      const parse = (raw: string) => {
        const value = occurrence.parse(JSON.parse(raw));
        if (value.sessionId !== native.sidebarRight.mounted.getSnapshot())
          throw unavailable();
        return value;
      };
      const currentPanelOwner = (id: SessionIdOf) => {
        const bound = panelOwner;
        const snapshot = bound?.read(id);
        return bound &&
          bound === panelOwner &&
          !bound.signal.aborted &&
          snapshot &&
          referenceSource.current?.matches(id, snapshot)
          ? { bound, snapshot }
          : undefined;
      };

      native.effect(() =>
        native.inputTriggers.registerSource({
          trigger: '@',
          name: source,
          showGroupTitle: false,
          candidates: async () => [],
          onPick: () => undefined,
          codec: {
            clipboardText: (raw) => `@${parse(raw).fileName}`,
            async serialize(raw, signal) {
              const selected = parse(raw);
              const id = native.sidebarRight.mounted.getSnapshot();
              if (id === undefined || id !== selected.sessionId)
                throw unavailable();
              const binding = current(id);
              const target = currentPanelOwner(id);
              const threadId = target?.snapshot.publicationManagement?.threadId;
              // A restored draft belongs to the initial owner of this
              // document. Replacing that owner must also fence restored chips.
              const expectedEpoch =
                selected.documentId === documentId ? selected.ownerEpoch : 1;
              if (
                !binding ||
                !target ||
                !threadId ||
                expectedEpoch !== target.bound.epoch
              )
                throw unavailable();
              const { bound, snapshot } = target;
              const attempt = AbortSignal.any([signal, active, bound.signal]);
              attempt.throwIfAborted();
              const data = createEmployeePanelsHttpClient(
                { ...selection, threadId },
                { expectedViewerId: viewerId, lifetimeSignal: lifetime },
              );
              const result = await data.selectMaterial(
                {
                  workspaceId,
                  revisionId: selected.revisionId,
                },
                attempt,
              );
              attempt.throwIfAborted();
              const actual = result.selection;
              const rechecked = currentPanelOwner(id);
              if (
                current(selected.sessionId) !== binding ||
                rechecked?.bound !== bound ||
                rechecked.snapshot.scopeKey !== snapshot.scopeKey ||
                rechecked.snapshot.publicationManagement !==
                  snapshot.publicationManagement ||
                result.viewerId !== viewerId ||
                result.workspaceId !== workspaceId ||
                result.canReference !== true ||
                actual.sourceId !== selected.sourceId ||
                actual.revisionId !== selected.revisionId ||
                actual.revision !== selected.revision ||
                actual.checksum !== selected.checksum ||
                (selected.digest !== undefined &&
                  actual.digest !== selected.digest)
              )
                throw unavailable();
              // The native composer submits the verified reference metadata as
              // text. It never embeds file bytes or supplies an attachment receipt.
              const {
                sourceId,
                revisionId,
                revision,
                digest,
                checksum,
                fileName,
              } = actual;
              return `\n引用资料 ${JSON.stringify({
                sourceId,
                revisionId,
                revision,
                digest,
                checksum,
                fileName,
              })}\n`;
            },
          },
        }),
      );
      native.slots.inject('conversation.input.dock', () =>
        native.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'allrice-employee-panels.reference-input',
          },
          Capture,
        ),
      );
      const bridge: DocumentReferences = {
        matches(id, snapshot) {
          const scope = snapshot.publicationManagement;
          return (
            !active.aborted &&
            native.sidebarRight.mounted.getSnapshot() === id &&
            editors.has(id) &&
            scope?.organizationId === organizationId &&
            scope.employeeInstanceId === employeeInstanceId &&
            scope.threadId === snapshot.materials.sessionId &&
            scope.threadId === snapshot.files.sessionId &&
            snapshot.materials.workspaceId === workspaceId &&
            snapshot.files.workspaceId === workspaceId &&
            snapshot.materials.viewerId === viewerId &&
            snapshot.files.viewerId === viewerId
          );
        },
        insert(request, epoch) {
          const binding = current(request.sessionId);
          const target = currentPanelOwner(request.sessionId);
          const actions = editors.get(request.sessionId);
          if (
            !binding ||
            !target ||
            target.bound.epoch !== epoch ||
            !actions ||
            request.signal.aborted ||
            request.scopeKey !== target.snapshot.scopeKey
          )
            return false;
          const reference = selectionPin.safeParse(request.reference);
          if (!reference.success) return false;
          const { manifestDigest, digest, ...exact } = reference.data;
          if (manifestDigest && digest && manifestDigest !== digest)
            return false;
          const span = actions.captureInsertion();
          const rechecked = currentPanelOwner(request.sessionId);
          if (
            request.signal.aborted ||
            current(request.sessionId) !== binding ||
            rechecked?.bound !== target.bound ||
            rechecked.snapshot.scopeKey !== target.snapshot.scopeKey ||
            rechecked.snapshot.publicationManagement !==
              target.snapshot.publicationManagement
          )
            return false;
          return native.conversation.input.for(binding.ctx).insertReference(
            {
              source,
              ref: JSON.stringify({
                ...exact,
                digest: digest ?? manifestDigest,
                version: 1,
                sessionId: request.sessionId,
                documentId,
                ownerEpoch: target.bound.epoch,
              }),
              label: reference.data.fileName,
              appearance: 'file',
              clipboardText: `@${reference.data.fileName}`,
            },
            span,
          );
        },
      };
      native.effect(() => () => {
        owner.abort();
        if (referenceSource.current === bridge) clear();
      });
      publish(bridge);
    },
  );
}
