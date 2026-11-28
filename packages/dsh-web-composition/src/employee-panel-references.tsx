import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { InputTriggerCandidate } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type {} from '@deepseek-ai/dsh-session-reference/remote';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {
  PropsRuntime,
  SessionIdOf,
} from '@deepseek-ai/dsh-client-ui-slots';
import {
  type ReferencePublicationQuerySchema,
  decodeEmployeeFileMention,
  employeeFileMentionPrefix,
  supportsEmployeeFileMentionText,
  encodeEmployeeFileMention,
  ReferenceSelectionSchema,
} from '@allrice/contracts';
import {
  conversationCandidate,
  conversationPick,
  filesSection,
  materialFolder,
  materialPath,
  materialPin as pin,
  materialTarget,
  mentionOccurrence,
  mentionChoices,
  nativeReferenceSource,
  type MentionTarget,
} from './employee-mention-source';
import { useEffect } from 'react';
import { z } from 'zod';
import { createEmployeePanelsHttpClient } from '../../../apps/web/lib/chatflow/employee-panel-data-http';
import { readEmployeeDocument } from '../../../apps/web/lib/d-entry/profile-browser';
import type {
  EmployeePanelsPort,
  EmployeePanelsSnapshot,
} from './employee-panels-port';

const source = 'allrice-panel-reference';
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

  ctx.inject(['uiConversation'], (native) => {
    if (!native.uiConversation) return;
    native.effect(() =>
      native.uiConversation.userText.register({
        id: 'allrice-file-mention',
        order: 20,
        match(text, from) {
          let start = text.indexOf(employeeFileMentionPrefix, from);
          while (start >= 0) {
            const end = text.indexOf(']', start) + 1;
            if (end > start) {
              const raw = text.slice(start, end);
              try {
                const mention = decodeEmployeeFileMention(raw);
                if (mention)
                  return {
                    id: 'text',
                    start,
                    end,
                    data: { text: raw, display: '@' + mention.label },
                  };
              } catch {
                // Ordinary user text that is not a valid fixed locator stays literal.
              }
            }
            start = text.indexOf(
              employeeFileMentionPrefix,
              start + employeeFileMentionPrefix.length,
            );
          }
        },
      }),
    );
  });
  let lookupConversations:
    Context['remote']['sessionReferenceResolver']['candidates'] | undefined;
  ctx.inject(['remote', 'remote.sessionReferenceResolver'], (native) => {
    const resolver = native.remote?.sessionReferenceResolver;
    if (!resolver) return;
    const lookup: NonNullable<typeof lookupConversations> = (
      id,
      query,
      signal,
    ) => resolver.candidates(id, query, signal);
    native.effect(() => {
      lookupConversations = lookup;
      return () => {
        if (lookupConversations === lookup) lookupConversations = undefined;
      };
    });
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
          if (currentReferences) notify();
          return () => {
            if (editors.get(sessionId) === inputActions) {
              editors.delete(sessionId);
              if (currentReferences) notify();
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
        const decoded: unknown = JSON.parse(raw);
        const menu = mentionOccurrence.safeParse(decoded);
        const value = menu.success ? menu.data : occurrence.parse(decoded);
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

      const dataClient = (threadId: string) =>
        createEmployeePanelsHttpClient(
          { ...selection, threadId },
          { expectedViewerId: viewerId, lifetimeSignal: lifetime },
        );
      const sameOwner = (
        id: SessionIdOf,
        target: NonNullable<ReturnType<typeof currentPanelOwner>>,
      ) => {
        const live = currentPanelOwner(id);
        return (
          live?.bound === target.bound &&
          live.snapshot.scopeKey === target.snapshot.scopeKey &&
          live.snapshot.publicationManagement ===
            target.snapshot.publicationManagement
        );
      };
      const rootCrumb = 'root';
      const quotedRootCrumb = 'root-quoted';
      const folderCrumb = 'materials';
      const quotedFolderCrumb = 'materials-quoted';
      native.effect(() =>
        native.inputTriggers.registerSource({
          trigger: '@',
          name: source,
          showGroupTitle: false,
          header: (_, { query, quoted }) =>
            query.startsWith(materialPath)
              ? [
                  {
                    label: filesSection,
                    value: quoted ? quotedRootCrumb : rootCrumb,
                  },
                  { label: materialFolder, value: folderCrumb, current: true },
                ]
              : undefined,
          async candidates(session, { query, quoted, signal }) {
            const id = session.sessionId;
            const binding = current(id);
            if (!binding) return [];
            const target = currentPanelOwner(id);
            const threadId = target?.snapshot.publicationManagement?.threadId;
            const inFolder = query.startsWith(materialPath);
            const candidates: InputTriggerCandidate[] = [];
            const attempt = AbortSignal.any(
              target ? [signal, active, target.bound.signal] : [signal, active],
            );
            const catalog =
              target && threadId ? dataClient(threadId) : undefined;
            const encode = (value: MentionTarget) =>
              JSON.stringify({
                version: 2,
                target: value,
                sessionId: id,
                documentId,
                ownerEpoch: target?.bound.epoch,
              });
            if (inFolder) {
              if (!catalog || !target) return [];
              const choices = await mentionChoices<
                InputTriggerCandidate,
                NonNullable<
                  z.input<typeof ReferencePublicationQuerySchema>['cursor']
                >
              >(async (cursor) => {
                const result = await catalog.queryMaterials(
                  {
                    workspaceId,
                    query: {
                      category: 'all',
                      query: query.slice(
                        materialPath.length,
                        materialPath.length + 200,
                      ),
                      limit: 50,
                      cursor,
                    },
                  },
                  attempt,
                );
                if (
                  attempt.aborted ||
                  current(id) !== binding ||
                  !sameOwner(id, target) ||
                  result.viewerId !== viewerId ||
                  result.options.workspaceId !== workspaceId
                )
                  return { choices: [], next: null };
                return {
                  choices: result.references
                    .filter(
                      (row) =>
                        row.status === 'active' &&
                        row.processing !== 'uploading' &&
                        (row.readCapabilities?.archive ||
                          supportsEmployeeFileMentionText(row)),
                    )
                    .map((row) => ({
                      name: row.fileName,
                      icon: 'file',
                      value: encode(materialTarget(row)),
                    })),
                  next: result.nextCursor,
                };
              }, attempt);
              return current(id) === binding &&
                sameOwner(id, target) &&
                !attempt.aborted
                ? choices
                : [];
            }
            const [files, sessions] = await Promise.allSettled([
              catalog && target
                ? mentionChoices<InputTriggerCandidate, string>(
                    async (cursor) => {
                      const result = await catalog.listDeliverables(
                        {
                          workspaceId,
                          category: 'artifact',
                          mention: true,
                          query: query.slice(0, 200),
                          cursor,
                        },
                        attempt,
                      );
                      if (
                        !sameOwner(id, target) ||
                        result.viewerId !== viewerId
                      )
                        return { choices: [], next: null };
                      const quotable = new Set(result.quotableFileIds);
                      return {
                        choices: result.files
                          .filter(
                            (file) =>
                              file.ownedByMe &&
                              file.origin === 'business-deliverable' &&
                              quotable.has(file.objectId),
                          )
                          .map((file) => ({
                            name: file.fileName,
                            icon: 'file',
                            section: filesSection,
                            value: encode({
                              fileName: file.fileName,
                              pin: {
                                kind: 'deliverable',
                                objectId: file.objectId,
                                checksum: file.checksum,
                              },
                            }),
                          })),
                        next: result.nextCursor,
                      };
                    },
                    attempt,
                  )
                : undefined,
              quoted ? undefined : lookupConversations?.(id, query, attempt),
            ]);
            if (attempt.aborted || current(id) !== binding) return [];
            if (target && sameOwner(id, target)) {
              if (!query || materialFolder.includes(query))
                candidates.push({
                  name: materialFolder,
                  icon: 'folder',
                  section: filesSection,
                  drill: true,
                  value: quoted ? quotedFolderCrumb : folderCrumb,
                });
              if (files.status === 'fulfilled' && files.value)
                candidates.push(...files.value);
            }
            if (sessions.status === 'fulfilled' && sessions.value?.ok) {
              const listed = native.sessions.list.getSnapshot().byId;
              candidates.push(
                ...sessions.value.value.map((row) =>
                  conversationCandidate(row, listed[row.sessionId]?.title),
                ),
              );
            }
            return candidates;
          },
          onPick({ session, candidate }) {
            if (!current(session.sessionId) || !candidate.value) return;
            if (
              candidate.value === rootCrumb ||
              candidate.value === quotedRootCrumb
            )
              return {
                text: candidate.value === quotedRootCrumb ? '@"' : '@',
                continue: true,
              };
            if (
              candidate.value === folderCrumb ||
              candidate.value === quotedFolderCrumb
            ) {
              if (currentPanelOwner(session.sessionId))
                return {
                  text:
                    (candidate.value === quotedFolderCrumb ? '@"' : '@') +
                    materialPath,
                  continue: true,
                };
              return;
            }
            const value: unknown = JSON.parse(candidate.value);
            const conversation = conversationPick.safeParse(value);
            if (conversation.success)
              return {
                insert: {
                  source: nativeReferenceSource,
                  ref: conversation.data.mention,
                  appearance: 'session',
                  label: candidate.name,
                  clipboardText: conversation.data.mention,
                },
              };
            const menu = mentionOccurrence.safeParse(value);
            const target = currentPanelOwner(session.sessionId);
            if (
              !target ||
              !menu.success ||
              menu.data.sessionId !== session.sessionId ||
              menu.data.ownerEpoch !== target.bound.epoch ||
              menu.data.documentId !== documentId
            )
              return;
            return {
              insert: {
                source,
                ref: candidate.value,
                appearance: 'file',
                label: menu.data.target.fileName,
                clipboardText: '@' + menu.data.target.fileName,
              },
            };
          },
          codec: {
            clipboardText: (raw) => {
              const selected = parse(raw);
              return (
                '@' +
                (selected.version === 2
                  ? selected.target.fileName
                  : selected.fileName)
              );
            },
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
              const data = dataClient(threadId);
              if (selected.version === 2) {
                // The native journal and drafts retain a stable locator only.
                return `\n${encodeEmployeeFileMention({ threadId, label: selected.target.fileName.slice(0, 160), pin: selected.target.pin })}\n`;
              }
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
      // Keep serialization for restored native chips. The profile no longer
      // registers the native source that discovers arbitrary guest files.
      native.effect(() =>
        native.inputTriggers.registerSource({
          trigger: '@',
          name: nativeReferenceSource,
          showGroupTitle: false,
          candidates: async () => [],
          onPick: () => undefined,
          codec: {
            clipboardText: (ref) => ref,
            serialize: async (ref) => ref,
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
