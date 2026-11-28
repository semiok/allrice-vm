import type { InputTriggerCandidate } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import {
  EmployeeFileMentionPinSchema,
  ReferenceSelectionSchema,
  UuidSchema,
  type ReferenceRevision,
} from '@allrice/contracts';
import { z } from 'zod';
type MentionPage<T, Cursor> = { choices: T[]; next: Cursor | null };
export async function mentionChoices<T, Cursor>(
  load: (cursor?: Cursor) => Promise<MentionPage<T, Cursor>>,
  signal: AbortSignal,
) {
  const choices: T[] = [];
  let cursor: Cursor | undefined;
  // Fill up to a native menu's useful working set, including paths where the
  // first authorized page contains rows that cannot be quoted.
  for (let page = 0; page < 4 && choices.length < 50; page++) {
    signal.throwIfAborted();
    const result = await load(cursor);
    choices.push(...result.choices);
    if (result.next === null) break;
    cursor = result.next;
  }
  return choices.slice(0, 50);
}

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
const mentionTarget = z
  .object({
    pin: EmployeeFileMentionPinSchema,
    fileName: z.string().min(1),
  })
  .strict();
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

export function materialTarget(reference: ReferenceRevision): MentionTarget {
  return {
    fileName: reference.fileName,
    pin: {
      kind: 'material',
      sourceId: reference.sourceId,
      revisionId: reference.revisionId,
      revision: reference.revision,
      digest: reference.manifestDigest,
      checksum: reference.checksum,
    },
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
