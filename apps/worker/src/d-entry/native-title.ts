import { z } from 'zod';

const titleControlFrame = z.union([
  z.object({
    type: z.literal('projection'),
    sessionId: z.string(),
    key: z.literal('title'),
    value: z.string().min(1),
  }),
  z.object({
    type: z.literal('baseline'),
    value: z.object({
      projections: z.record(
        z.string(),
        z.object({ values: z.record(z.string(), z.unknown()) }),
      ),
    }),
  }),
]);

/** Only a hint to re-read the exact pinned native root. Never a write payload. */
export function hasRootTitle(frame: unknown, root: string) {
  const parsed = titleControlFrame.safeParse(frame);
  if (!parsed.success) return false;
  const value = parsed.data;
  return value.type === 'projection'
    ? value.sessionId === root
    : typeof value.value.projections[root]?.values.title === 'string';
}
