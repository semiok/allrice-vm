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
}).extend({ digest: ReferenceSelectionSchema.shape.digest.optional() });
const occurrence = pin
  .extend({ version: z.literal(1), sessionId: z.string().min(1) })
  .strict();
const unavailable = () => new Error('这条引用已失效，请从工作台重新选择。');
type Header = PropsRuntime<'conversation.session.header.actions'>;

interface DocumentReferences {
  matches(sessionId: SessionIdOf, snapshot: EmployeePanelsSnapshot): boolean;
  insert: NonNullable<EmployeePanelsPort['useReference']>;
}

// The sealed document and Cordis owner share this lifetime. Existing business
// binders keep their own independent snapshots, without relying on a new
// global auth source or a port added to the memory/capability owners.
const documents = new WeakMap<Document, DocumentReferences>();
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
  const data = createEmployeePanelsHttpClient(selection, {
    expectedViewerId: viewerId,
    lifetimeSignal: lifetime,
  });

  ctx.inject(
    ['slots', 'sessions', 'conversation', 'sidebarRight', 'inputTriggers'],
    (native) => {
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
              const binding = current(selected.sessionId);
              if (!binding) throw unavailable();
              const attempt = AbortSignal.any([signal, active]);
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
        insert(request) {
          const binding = current(request.sessionId);
          if (
            !binding ||
            !actions ||
            request.signal.aborted ||
            request.scopeKey !== scopeKey
          )
            return false;
          const reference = pin.safeParse(request.reference);
          if (!reference.success) return false;
          const span = actions.captureInsertion();
          if (request.signal.aborted || current(request.sessionId) !== binding)
            return false;
          return native.conversation.input.for(binding.ctx).insertReference(
            {
              source,
              ref: JSON.stringify({
                ...reference.data,
                version: 1,
                sessionId: request.sessionId,
              }),
              label: reference.data.fileName,
              appearance: 'file',
              clipboardText: `@${reference.data.fileName}`,
            },
            span,
          );
        },
      };
      documents.set(page.ownerDocument, bridge);
      native.effect(() => () => {
        owner.abort();
        if (documents.get(page.ownerDocument) === bridge)
          documents.delete(page.ownerDocument);
      });
    },
  );
}
