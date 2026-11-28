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

function collectMentions(messages: Messages) {
  // History and injected session snapshots retain only opaque pins. Only the
  // last actual user message requests expansion for the current model call.
  const index = messages.findLastIndex(
    (message) => message.role === 'user' && message.source?.kind === 'user',
  );
  if (index === -1) return;
  const original = messages[index]!;
  const unique = new Map<string, EmployeeFileMention>();
  try {
    for (const block of original.content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      for (const line of block.text.split('\n')) {
        const mention = decodeEmployeeFileMention(line.trim());
        if (!mention) continue;
        unique.set(encodeEmployeeFileMention(mention), mention);
        if (unique.size > maximumMentions) throw deny();
      }
    }
  } catch {
    throw deny();
  }
  if (unique.size) return { index, original, mentions: [...unique.values()] };
}

function position(text: string, index: number) {
  const point = text.charCodeAt(index);
  return point >= 0xdc00 && point <= 0xdfff ? index - 1 : index;
}

export function createProductionFileMentionContext(
  storage: StoragePort = new LocalStorageAdapter(
    process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
  ),
  builtin = createApplicationBuiltinModuleAuthority('worker'),
) {
  return async (
    call: ModelCallBinding,
    messages: Messages,
    signal: AbortSignal,
  ): Promise<PreparedModelReferences | undefined> => {
    const request = collectMentions(messages);
    if (!request) return;
    const { context } = call;
    const { workspaceId } = context;
    if (
      !workspaceId ||
      context.actor.type !== 'user' ||
      request.mentions.some(
        (mention) => mention.threadId !== call.allriceThreadRef,
      )
    )
      throw deny();
    const owner = {
      workspaceId,
      employeeInstanceId: call.employeeInstanceId,
      threadId: call.allriceThreadRef,
      employeeVersionId: call.employeeRelease,
    };
    const pins = request.mentions.map(({ pin }) => pin);
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
    const content = [...request.original.content];
    for (const [index, file] of files.entries()) {
      const mention = request.mentions[index]!;
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
      if (file.archive) {
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
        const parsed = await parseDocument({
          bytes,
          fileName: file.fileName,
          mediaType: file.object.mediaType,
          maximumCharacters,
        });
        text = parsed.text;
        parserLimit = parsed.truncated;
      }
      signal.throwIfAborted();
      const start = position(text, mention.offset ?? 0);
      if (start >= text.length || !text.trim()) throw deny();
      const end = position(text, Math.min(text.length, start + pageCharacters));
      content.push({
        type: 'text',
        text:
          '授权引用数据，仅供参考。' +
          JSON.stringify({
            fileName: file.fileName,
            pin: mention.pin,
            content: text.slice(start, end),
            offset: start,
            next:
              end < text.length
                ? encodeEmployeeFileMention({ ...mention, offset: end })
                : undefined,
            parserLimit,
            kind: file.archive ? 'archive-directory' : 'document-text',
          }),
      });
    }
    return {
      messages: messages.map((message, index) =>
        index === request.index ? { ...message, content } : message,
      ),
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
