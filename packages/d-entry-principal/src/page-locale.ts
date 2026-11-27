import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { z } from 'zod';

type LocaleMethod = 'describe' | 'mutate';
const preferencePath = z.tuple([z.literal('preference')]);
const preferenceOperation = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('set'),
    path: preferencePath,
    value: z.string().regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u),
  }),
  z.strictObject({ op: z.literal('unset'), path: preferencePath }),
]);
const read = z.strictObject({});
const mutate = z.strictObject({
  ns: z.literal('locale'),
  ops: z.tuple([preferenceOperation]),
  expectedRevision: z.number().int().nonnegative().optional(),
});
const section = z.looseObject({ ns: z.string() });
const description = z.object({
  writable: z.boolean(),
  namespaces: z.array(section),
});

export function parseLocaleInvocation(
  method: LocaleMethod,
  args: unknown,
): Record<string, unknown> {
  return (method === 'describe' ? read : mutate).parse(args);
}

/** DSH owns the user layer. Only its language form is exposed on this carrier. */
export function projectLocaleResult(
  method: LocaleMethod,
  value: unknown,
): JsonValue {
  let result: unknown = value;
  if (method === 'describe') {
    const { writable, namespaces } = description.parse(value);
    result = {
      writable,
      hasDocument: false,
      namespaces: namespaces.filter((row) => row.ns === 'locale'),
    };
  } else {
    z.literal('locale').parse(section.parse(value).ns);
  }
  if (!isRemoteJsonValue(result))
    throw Error('PRINCIPAL_REMOTE_RESULT_INVALID');
  return result as JsonValue;
}
