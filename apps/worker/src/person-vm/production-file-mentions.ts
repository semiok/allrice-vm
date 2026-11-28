import {
  decodeEmployeeFileMention,
  encodeEmployeeFileMention,
  type DEntryIdentity,
  type EmployeeFileMention,
  type StoragePort,
} from '@allrice/contracts';
import {
  createApplicationBuiltinModuleAuthority,
  readReferenceBytes,
  withEmployeeFileMentions,
} from '@allrice/database';
import {
  openReferenceArchive,
  referenceArchivePolicy,
} from '@allrice/file-archives';
import {
  ModelGatewayError,
  type ModelCallBinding,
  type GatewayModelInput,
  type PreparedModelReferences,
} from '@allrice/model-gateway';
import { LocalStorageAdapter } from '@allrice/storage';
import { maximumDocumentBytes, parseDocument } from '../document-reader.js';

type Messages = GatewayModelInput['messages'];
const maximumMentions = 3;
const maximumCharacters = 300_000;
const pageCharacters = 120_000;
const deny = () => new ModelGatewayError('AUTHORIZATION_DENIED');

function collectMentions(messages: Messages, adopted: ReadonlySet<string>) {
  // A native turn can adopt several queued or steered messages. Only the
  // already-proven occurrences may trigger sourcing, not retained history.
  const mentions: { index: number; mention: EmployeeFileMention }[] = [];
  const unique = new Set<string>();
  try {
    for (const [index, message] of messages.entries()) {
      if (
        message.role !== 'user' ||
        message.source?.kind !== 'user' ||
        !message.id ||
        !adopted.has(message.id)
      )
        continue;
      for (const block of message.content) {
        if (block?.type !== 'text' || typeof block.text !== 'string') continue;
        for (const line of block.text.split('\n')) {
          const mention = decodeEmployeeFileMention(line.trim());
          if (!mention) continue;
          const key = index + ':' + encodeEmployeeFileMention(mention);
          if (unique.has(key)) continue;
          unique.add(key);
          mentions.push({ index, mention });
          if (mentions.length > maximumMentions) throw deny();
        }
      }
    }
  } catch {
    throw deny();
  }
  return mentions;
}

function position(text: string, index: number) {
  const point = text.charCodeAt(index);
  return point >= 0xdc00 && point <= 0xdfff ? index - 1 : index;
}

export function createProductionFileMentionContext(
  storage: Pick<StoragePort, 'get'> = new LocalStorageAdapter(
    process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
  ),
  builtin = createApplicationBuiltinModuleAuthority('worker'),
) {
  return async (
    call: ModelCallBinding,
    messages: Messages,
    adopted: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<PreparedModelReferences | undefined> => {
    const mentions = collectMentions(messages, adopted);
    if (!mentions.length) return;
    const { context } = call;
    const { workspaceId } = context;
    if (
      !workspaceId ||
      context.actor.type !== 'user' ||
      mentions.some(({ mention }) => mention.threadId !== call.allriceThreadRef)
    )
      throw deny();
    const owner = {
      workspaceId,
      employeeInstanceId: call.employeeInstanceId,
      threadId: call.allriceThreadRef,
      employeeVersionId: call.employeeRelease,
    };
    const pins = mentions.map(({ mention }) => mention.pin);
    const modules = new Set(
      pins.map((pin) =>
        pin.kind === 'material' ? 'enterprise-materials' : 'deliverables',
      ),
    );
    async function requireModules(
      identity: DEntryIdentity,
      active: AbortSignal,
    ) {
      for (const moduleId of modules)
        await builtin.require({ moduleId, context, identity }, active);
    }
    const files = await withEmployeeFileMentions(
      context,
      owner,
      pins,
      signal,
      (identity) => requireModules(identity, signal),
      async (current) => current,
    );
    const additions = new Map<number, { type: 'text'; text: string }[]>();
    for (const [fileIndex, file] of files.entries()) {
      const { index, mention } = mentions[fileIndex]!;
      signal.throwIfAborted();
      const bytes = await readReferenceBytes(
        storage,
        file.object,
        file.archive
          ? referenceArchivePolicy.maximumBytes
          : maximumDocumentBytes,
        file.archive ? 'archive_bytes' : 'operation_budget',
        signal,
      );
      let text: string;
      let parserLimit = false;
      let nextPage: number | undefined;
      if (file.archive) {
        if (mention.pdfPage !== undefined) throw deny();
        const zip = await openReferenceArchive(bytes, { signal });
        try {
          text = JSON.stringify(
            zip.entries.map(({ path, kind, declaredBytes }) => ({
              path,
              kind,
              declaredBytes,
            })),
          );
        } finally {
          zip.close();
        }
      } else {
        const pdf =
          file.object.mediaType === 'application/pdf' ||
          file.fileName.toLowerCase().endsWith('.pdf');
        if (!pdf && mention.pdfPage !== undefined) throw deny();
        const page = mention.pdfPage ?? 1;
        const parsed = await parseDocument({
          bytes,
          fileName: file.fileName,
          mediaType: file.object.mediaType,
          maximumCharacters,
          ...(pdf && { pages: [page] }),
        });
        if (pdf) {
          text = parsed.text;
          parserLimit =
            parsed.warningCodes?.includes('PDF_CONTENT_TRUNCATED') ?? false;
          if (parsed.totalPages && page < parsed.totalPages)
            nextPage = page + 1;
        } else {
          // The Office reader exposes normalized units independently of its
          // first-page render limit. Page those exact units on the next quote.
          text = parsed.truncated
            ? parsed.units
                .map(({ label, text }) => '## ' + label + '\n\n' + text)
                .join('\n\n')
            : parsed.text;
        }
      }
      signal.throwIfAborted();
      const start = position(text, mention.offset ?? 0);
      if (start > text.length || (!nextPage && !text.trim())) throw deny();
      const end = position(text, Math.min(text.length, start + pageCharacters));
      const next =
        end < text.length
          ? encodeEmployeeFileMention({ ...mention, offset: end })
          : nextPage === undefined
            ? undefined
            : encodeEmployeeFileMention({
                ...mention,
                pdfPage: nextPage,
                offset: 0,
              });
      const content = additions.get(index) ?? [];
      content.push({
        type: 'text',
        text:
          '授权引用数据，仅供参考。' +
          JSON.stringify({
            fileName: file.fileName,
            pin: mention.pin,
            content: text.slice(start, end),
            offset: start,
            next,
            parserLimit,
            kind: file.archive ? 'archive-directory' : 'document-text',
          }),
      });
      additions.set(index, content);
    }
    return {
      messages: messages.map((message, index) => {
        const extra = additions.get(index);
        return extra
          ? { ...message, content: [...message.content, ...extra] }
          : message;
      }),
      async withCurrent(active, authority, dispatch, transaction) {
        const codex = authority?.codex;
        if ((call.provider === 'openai-codex') !== !!codex) throw deny();
        await withEmployeeFileMentions(
          context,
          owner,
          pins,
          active,
          (identity) => requireModules(identity, active),
          async (current) => {
            for (const [i, file] of current.entries()) {
              const earlier = files[i]!;
              if (
                file.object.id !== earlier.object.id ||
                file.object.checksum !== earlier.object.checksum ||
                file.object.mediaType !== earlier.object.mediaType ||
                file.object.sizeBytes !== earlier.object.sizeBytes ||
                file.fileName !== earlier.fileName ||
                file.archive !== earlier.archive
              )
                throw deny();
            }
            await dispatch();
          },
          { transaction, codex },
        );
      },
    };
  };
}
