import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from '@deepseek-ai/cordis';
import AttachmentStore, {
  ImageVariantId,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type ImageRequestTarget,
  type RequestImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment';
import { z } from 'zod';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import {
  ModelGatewayError,
  type ModelCallBinding,
  type DshGatewayStreamScope,
} from '@allrice/model-gateway';

export type ReadProductionModelImage = (
  binding: ModelCallBinding,
  ref: ImageAttachmentRef,
  target: ImageRequestTarget | null,
  signal: AbortSignal,
) => Promise<RequestImageAttachment | StoredImageAttachment>;

/** PiAi needs DSH's attachment service even with an authorized original
 * reference. Host resolves only this call's native session, never a path. */
export function createProductionModelImages(read: ReadProductionModelImage): {
  plugin: new (ctx: Context) => AttachmentStore;
  stream: DshGatewayStreamScope;
} {
  const operations = new AsyncLocalStorage<{
    binding: ModelCallBinding;
    signal: AbortSignal;
  }>();
  async function readCurrent(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget | null,
    caller?: AbortSignal,
  ) {
    const current = operations.getStore();
    if (!current) throw new ModelGatewayError('AUTHORIZATION_DENIED');
    const active = caller
      ? AbortSignal.any([caller, current.signal])
      : current.signal;
    active.throwIfAborted();
    const result = await read(current.binding, ref, target, active);
    active.throwIfAborted();
    return result;
  }
  class NativeModelImageStore extends AttachmentStore {
    readonly imageLimits: ImageAttachmentLimits = {
      maxImageBytes: 20 * 1024 * 1024,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 200 * 1024 * 1024,
      maxImagePixels: 64_000_000,
      maxImageDimension: 8192,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    };
    async validateImage(): Promise<void> {
      throw new ModelGatewayError('AUTHORIZATION_DENIED');
    }
    async saveImage(): Promise<ImageAttachmentRef> {
      throw new ModelGatewayError('AUTHORIZATION_DENIED');
    }
    async readImage(ref: ImageAttachmentRef, signal?: AbortSignal) {
      const result = await readCurrent(ref, null, signal);
      if (!('ref' in result)) throw new ModelGatewayError('PROVIDER_FAILED');
      return result;
    }
    override async readImageRequest(
      ref: ImageAttachmentRef,
      target: ImageRequestTarget,
      signal?: AbortSignal,
    ) {
      const result = await readCurrent(ref, target, signal);
      if (!('variantId' in result))
        throw new ModelGatewayError('PROVIDER_FAILED');
      return result;
    }
  }

  return {
    plugin: NativeModelImageStore,
    stream(
      binding: ModelCallBinding,
      signal: AbortSignal,
      operation: () => AsyncIterable<StreamChunk>,
    ): AsyncIterable<StreamChunk> {
      return {
        [Symbol.asyncIterator]() {
          const scope = { binding, signal };
          const iterator = operations.run(scope, () =>
            operation()[Symbol.asyncIterator](),
          );
          return {
            next: () => operations.run(scope, () => iterator.next()),
            return: () =>
              operations.run(scope, async () =>
                iterator.return
                  ? iterator.return()
                  : { done: true as const, value: undefined },
              ),
          };
        },
      };
    },
  };
}

const imageSize = z
  .number()
  .int()
  .positive()
  .max(20 * 1024 * 1024);
const dimension = z.number().int().positive().max(8192);
const imageWire = z.object({
  attachment: z.unknown(),
  data: z.string(),
  variantId: z.string().min(1).max(256),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: imageSize,
  width: dimension,
  height: dimension,
  depth: z.literal('uchar'),
  space: z.literal('srgb'),
  hasAlpha: z.boolean(),
});

function sameImage(actual: unknown, ref: ImageAttachmentRef) {
  if (!actual || typeof actual !== 'object') return false;
  const value = actual as Record<string, unknown>;
  return (
    ['attachmentId', 'bytes', 'mediaType', 'width', 'height'] as const
  ).every((key) => value[key] === ref[key]);
}

function decode(data: string, size: number) {
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length !== size || buffer.toString('base64') !== data)
    throw new ModelGatewayError('PROVIDER_FAILED');
  return buffer;
}

export function decodeProductionModelImage(
  text: string | null,
  ref: ImageAttachmentRef,
  target: ImageRequestTarget | null,
): StoredImageAttachment | RequestImageAttachment {
  if (!text) throw new ModelGatewayError('AUTHORIZATION_DENIED');
  const parsed: unknown = JSON.parse(text);
  if (!target) {
    const original = z
      .object({ ref: z.unknown(), data: z.string() })
      .parse(parsed);
    if (
      !sameImage(original.ref, ref) ||
      !imageSize.safeParse(ref.bytes).success
    )
      throw new ModelGatewayError('PROVIDER_FAILED');
    return { ref, data: decode(original.data, ref.bytes) };
  }
  const image = imageWire.parse(parsed);
  if (
    !sameImage(image.attachment, ref) ||
    image.bytes > target.maxBytes ||
    image.width > Math.min(target.width, ref.width) ||
    image.height > Math.min(target.height, ref.height)
  )
    throw new ModelGatewayError('PROVIDER_FAILED');
  return {
    ...image,
    attachment: ref,
    variantId: ImageVariantId(image.variantId),
    data: decode(image.data, image.bytes),
  };
}
