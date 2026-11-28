import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

export const EmployeeFileMentionPinSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('material'),
      sourceId: UuidSchema,
      revisionId: UuidSchema,
      revision: z.number().int().positive(),
      digest: ChecksumSchema.optional(),
      checksum: ChecksumSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('deliverable'),
      objectId: UuidSchema,
      checksum: ChecksumSchema,
    })
    .strict(),
]);
export type EmployeeFileMentionPin = z.infer<
  typeof EmployeeFileMentionPinSchema
>;

/** Only a locator. The ModelCallBinding supplies the identity and current
 * authorization. There is no bearer grant, original text or storage key. */
export const EmployeeFileMentionSchema = z
  .object({
    threadId: UuidSchema,
    label: z.string().min(1).max(160),
    pin: EmployeeFileMentionPinSchema,
    pdfPage: z.number().int().positive().max(10_000).optional(),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(20 * 1024 * 1024)
      .optional(),
  })
  .strict();
export type EmployeeFileMention = z.infer<typeof EmployeeFileMentionSchema>;

export const employeeFileMentionPrefix = '[allrice-file:v1:';
export function encodeEmployeeFileMention(input: EmployeeFileMention) {
  return (
    employeeFileMentionPrefix +
    encodeURIComponent(JSON.stringify(EmployeeFileMentionSchema.parse(input))) +
    ']'
  );
}
export function decodeEmployeeFileMention(line: string) {
  if (!line.startsWith(employeeFileMentionPrefix)) return undefined;
  if (!line.endsWith(']') || line.length > 2_048)
    throw Error('Invalid employee file reference');
  return EmployeeFileMentionSchema.parse(
    JSON.parse(
      decodeURIComponent(line.slice(employeeFileMentionPrefix.length, -1)),
    ),
  );
}
