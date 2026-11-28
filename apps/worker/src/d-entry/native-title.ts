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

/** Only hints to resolve registered native roots. Never write payloads. */
export function controlTitleTargets(frame: unknown): string[] {
  const parsed = titleControlFrame.safeParse(frame);
  if (!parsed.success) return [];
  const value = parsed.data;
  return value.type === 'projection'
    ? [value.sessionId]
    : Object.entries(value.value.projections).flatMap(([id, projection]) =>
        typeof projection.values.title === 'string' && projection.values.title
          ? [id]
          : [],
      );
}

const rootSnapshot = z.object({
  type: z.literal('snapshot'),
  header: z.object({ id: z.string() }),
  projections: z.object({ values: z.object({ title: z.string().min(1) }) }),
});

/** An existing title can arrive when follow loads a previously cold session. */
export function snapshotTitleTarget(frame: unknown) {
  const parsed = rootSnapshot.safeParse(frame);
  return parsed.success ? parsed.data.header.id : undefined;
}
