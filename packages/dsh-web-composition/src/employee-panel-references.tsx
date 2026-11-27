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
type Header = PropsRuntime<'conversation.session.header.actions'>;
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
  const { organizationId, viewerId, scopeId, nativeSessionId, selection } =
    readEmployeeDocument(page.dataset);
  const { threadId, workspaceId, employeeInstanceId } = selection;
  if (!threadId || !nativeSessionId) return;
  const scopeKey = [organizationId, viewerId, workspaceId, scopeId].join('/');
  const documentId = crypto.randomUUID();
  const data = createEmployeePanelsHttpClient(selection, {
    expectedViewerId: viewerId,
    lifetimeSignal: lifetime,
  });

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
  const publish = (bridge: DocumentReferences | undefined) => {
    if (currentReferences === bridge) return;
    currentReferences = bridge;
    for (const listener of listeners) listener();
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
      let actions: Header['inputActions'] | undefined;
      let mounted: SessionIdOf | undefined;
      function Capture({ sessionId, inputActions }: Header) {
        useEffect(() => {
          if (sessionId !== nativeSessionId) return;
          mounted = sessionId;
          actions = inputActions;
          return () => {
            if (actions === inputActions) {
              actions = undefined;
              mounted = undefined;
            }
          };
        }, [sessionId, inputActions]);
        return null;
      }
      const current = (id: string) => {
        if (
          active.aborted ||
          id !== nativeSessionId ||
          mounted !== nativeSessionId ||
          native.sidebarRight.mounted.getSnapshot() !== mounted
        )
          return;
        const binding = native.sessions.binding(mounted);
        return binding?.session.getSnapshot().openState === 'open'
          ? binding
          : undefined;
      };
      const parse = (raw: string) => {
        const value = occurrence.parse(JSON.parse(raw));
        if (value.sessionId !== nativeSessionId) throw unavailable();
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
          ? bound
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
              const binding = current(nativeSessionId);
              const bound = currentPanelOwner(nativeSessionId as SessionIdOf);
              if (
                !binding ||
                !bound ||
                (selected.documentId === documentId &&
                  selected.ownerEpoch !== bound.epoch)
              )
                throw unavailable();
              // A reloaded draft may requalify in its scoped document. A live
              // document must continue under the exact owner that inserted it.
              const attempt = AbortSignal.any([signal, active, bound.signal]);
              attempt.throwIfAborted();
              const result = await data.selectMaterial(
                {
                  workspaceId,
                  revisionId: selected.revisionId,
                },
                attempt,
              );
              attempt.throwIfAborted();
              const actual = result.selection;
              if (
                current(selected.sessionId) !== binding ||
                currentPanelOwner(nativeSessionId as SessionIdOf) !== bound ||
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
      native.slots.inject('conversation.session.header.actions', () =>
        native.slots.register(
          {
            name: 'conversation.session.header.actions',
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
            id === nativeSessionId &&
            snapshot.scopeKey === scopeKey &&
            scope?.organizationId === organizationId &&
            scope.employeeInstanceId === employeeInstanceId &&
            scope.threadId === threadId &&
            snapshot.materials.workspaceId === workspaceId &&
            snapshot.files.workspaceId === workspaceId &&
            snapshot.materials.viewerId === viewerId &&
            snapshot.files.viewerId === viewerId
          );
        },
        insert(request, epoch) {
          const binding = current(request.sessionId);
          const bound = currentPanelOwner(request.sessionId);
          if (
            !binding ||
            !bound ||
            bound.epoch !== epoch ||
            !actions ||
            request.signal.aborted ||
            request.scopeKey !== scopeKey
          )
            return false;
          const reference = selectionPin.safeParse(request.reference);
          if (!reference.success) return false;
          const { manifestDigest, digest, ...exact } = reference.data;
          if (manifestDigest && digest && manifestDigest !== digest)
            return false;
          const span = actions.captureInsertion();
          if (
            request.signal.aborted ||
            current(request.sessionId) !== binding ||
            currentPanelOwner(request.sessionId) !== bound
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
                ownerEpoch: bound.epoch,
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
