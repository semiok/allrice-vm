import type { InputTriggerCandidate } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import {
  ChecksumSchema,
  ReferenceSelectionSchema,
  UuidSchema,
  type ReferenceRevision,
} from '@allrice/contracts';
import { z } from 'zod';
import type { createEmployeePanelsHttpClient } from '../../../apps/web/lib/chatflow/employee-panel-data-http';

export const materialFolder = '企业资料';
export const materialPath = materialFolder + '/';
export const filesSection = '文件与文件夹';
export const nativeReferenceSource = 'reference';
export const materialPin = ReferenceSelectionSchema.pick({
  sourceId: true,
  revisionId: true,
  revision: true,
  checksum: true,
  fileName: true,
})
  .strip()
  .extend({ digest: ReferenceSelectionSchema.shape.digest.optional() });
const mentionTarget = z.discriminatedUnion('kind', [
  materialPin.extend({ kind: z.literal('material') }).strict(),
  z
    .object({
      kind: z.literal('deliverable'),
      objectId: UuidSchema,
      fileName: z.string().min(1),
      checksum: ChecksumSchema,
      requestId: UuidSchema,
    })
    .strict(),
]);
export const mentionOccurrence = z
  .object({
    version: z.literal(2),
    target: mentionTarget,
    sessionId: z.string().min(1),
    documentId: z.uuid(),
    ownerEpoch: z.number().int().positive(),
  })
  .strict();
export type MentionTarget = z.infer<typeof mentionTarget>;
type DataClient = ReturnType<typeof createEmployeePanelsHttpClient>;

export function materialTarget(
  reference: ReferenceRevision,
): Extract<MentionTarget, { kind: 'material' }> {
  return {
    kind: 'material',
    sourceId: reference.sourceId,
    revisionId: reference.revisionId,
    revision: reference.revision,
    digest: reference.manifestDigest,
    checksum: reference.checksum,
    fileName: reference.fileName,
  };
}

export const conversationPick = z
  .object({ kind: z.literal('session'), mention: z.string().min(1) })
  .strict();

function conversationTitle(title: string | undefined, sessionId: string) {
  const trimmed = title?.trim();
  const lower = trimmed?.toLowerCase();
  const suffix = lower?.startsWith('session-') ? lower.slice(8) : lower;
  if (
    !trimmed ||
    lower === sessionId.toLowerCase() ||
    UuidSchema.safeParse(suffix).success
  )
    return '新建对话';
  return trimmed;
}

export function conversationCandidate(
  candidate: {
    sessionId: string;
    displayTitle?: string;
    label: string;
    mention: string;
  },
  title?: string,
): InputTriggerCandidate {
  const name = conversationTitle(
    title ?? candidate.displayTitle ?? candidate.label,
    candidate.sessionId,
  );
  // rc.2 returns a Markdown mention with a native URI. Retain the URI (the
  // runtime resolves it) and replace its visible label along with the chip.
  const link = candidate.mention.lastIndexOf('](');
  const mention =
    link < 0
      ? candidate.mention
      : '@[' +
        name
          .replaceAll('\\', '\\\\')
          .replaceAll('[', '\\[')
          .replaceAll(']', '\\]') +
        candidate.mention.slice(link);
  return {
    name,
    icon: 'session',
    section: '对话',
    value: JSON.stringify({ kind: 'session', mention }),
  };
}

const unavailable = () => new Error('这条引用已失效，请从工作台重新选择。');
const notReadable = () => new Error('暂时读不到文件正文，请保留引用后重试。');

function boundedText(text: string, more: boolean) {
  const limit = 8_000;
  const end = Math.min(text.length, limit);
  const next = text.charCodeAt(end);
  const excerpt = text.slice(
    0,
    next >= 0xdc00 && next <= 0xdfff ? end - 1 : end,
  );
  if (!excerpt.trim()) throw notReadable();
  return { text: excerpt, truncated: more || end < text.length };
}

export async function readMention(
  data: DataClient,
  workspaceId: string,
  viewerId: string,
  target: MentionTarget,
  signal: AbortSignal,
) {
  async function readMaterial(selection: z.infer<typeof materialPin>) {
    const result = await data.selectMaterial(
      { workspaceId, revisionId: selection.revisionId, includeExcerpt: true },
      signal,
    );
    const actual = result.selection;
    if (
      result.viewerId !== viewerId ||
      result.workspaceId !== workspaceId ||
      result.canReference !== true ||
      actual.sourceId !== selection.sourceId ||
      actual.revisionId !== selection.revisionId ||
      actual.revision !== selection.revision ||
      actual.checksum !== selection.checksum ||
      (selection.digest !== undefined && actual.digest !== selection.digest)
    )
      throw unavailable();
    if (result.excerpt)
      return boundedText(result.excerpt.text, result.excerpt.truncated);
    const preview = await data.previewMaterial(
      {
        workspaceId,
        revisionId: selection.revisionId,
        source: true,
        checksum: selection.checksum,
      },
      signal,
    );
    if (preview.kind !== 'text') throw notReadable();
    return boundedText(preview.text, !preview.eof);
  }

  if (target.kind === 'material') return readMaterial(target);

  const { objectId, checksum, requestId } = target;
  async function original() {
    const result = await data.listDeliverables(
      { workspaceId, objectId, category: 'artifact' },
      signal,
    );
    const file = result.files.find(
      (f) =>
        f.objectId === objectId &&
        f.checksum === checksum &&
        f.ownedByMe &&
        f.origin === 'business-deliverable',
    );
    if (result.viewerId !== viewerId || !file) throw unavailable();
    return file;
  }
  const file = await original();
  const preview = await data.previewDeliverable(
    {
      workspaceId,
      objectId: file.objectId,
      fileName: file.fileName,
      source: true,
      checksum: file.checksum,
    },
    signal,
  );
  if (preview.kind === 'text') return boundedText(preview.text, !preview.eof);

  // A binary deliverable uses the existing immutable reference processor.
  // Keep the request ID in the chip so another send checks the same copy.
  const reference =
    file.reference?.checksum === file.checksum
      ? file.reference
      : (
          await data.captureReference(
            { workspaceId, objectId: file.objectId, requestId },
            signal,
          )
        ).reference;
  if (reference.checksum !== file.checksum || reference.processing !== 'ready')
    throw notReadable();
  const result = await readMaterial(materialTarget(reference));
  await original();
  return result;
}
