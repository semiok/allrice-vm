import {
  isRemoteJsonValue,
  RemoteError,
  type InvocationDescriptor,
  type TypertLocalRegistry,
} from '@deepseek-ai/dsh-typert-protocol';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import {
  isRetainedPageRestriction,
  sensitivePageCapability,
} from './page-capability-policy.js';

type Registry = Pick<TypertLocalRegistry, 'get'>;

export function pageEndpoint(method: InvocationDescriptor) {
  return `${method.namespace}/${method.method}` as const;
}

/** Resolve from the running guest's generated DSH registry. The registry also
 * contains internal AllRice methods, which are not part of the DSH page API. */
export function requirePageNativeMethod(
  registry: Registry,
  endpoint: string,
  mode: 'unary' | 'stream',
  args: Readonly<Record<string, unknown>>,
  providerSettings: ReadonlySet<string> | undefined,
  pluginSettings?: ReadonlySet<string>,
): InvocationDescriptor {
  const method = registry.get(endpoint);
  if (
    !method ||
    (method.mode ?? 'unary') !== mode ||
    isRetainedPageRestriction(method) ||
    !/^@deepseek-ai\/dsh(?:-[a-z0-9-]+)?#/u.test(method.id) ||
    !method.id.endsWith(`#${endpoint}`) ||
    pageEndpoint(method) !== endpoint
  ) {
    throw new RemoteError('remote-access/denied', 'DSH method unavailable', {
      action: endpoint,
      reason: 'method-unavailable',
    });
  }
  const category = sensitivePageCapability(method, {
    args,
    providerSettings,
    pluginSettings,
  });
  if (category) {
    throw new RemoteError(
      'remote-access/denied',
      'DSH method is platform managed',
      {
        action: endpoint,
        reason: category,
      },
    );
  }
  return method;
}

/** Attach binary results with their original generated field paths. The
 * Worker can forward the native RPC envelope without carrying endpoint codecs. */
export function encodePageNativeResult(
  descriptor: InvocationDescriptor,
  raw: unknown,
) {
  const codec = descriptor.result;
  if (codec.mode !== 'strict') throw Error('PRINCIPAL_REMOTE_RESULT_INVALID');
  const value = codec.create().parse(raw);
  const attachments: {
    path: readonly (string | number)[];
    bytes: Uint8Array;
  }[] = [];
  const encoded =
    value === undefined || !codec.encode
      ? value
      : codec.encode(value, (bytes, path) => {
          attachments.push({ path: [...path], bytes: new Uint8Array(bytes) });
          return null;
        });
  if (encoded !== undefined && !isRemoteJsonValue(encoded))
    throw Error('PRINCIPAL_REMOTE_RESULT_INVALID');
  return { value: encoded as JsonValue | undefined, attachments };
}
