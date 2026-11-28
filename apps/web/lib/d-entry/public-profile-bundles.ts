import { z } from 'zod';

const publicRoot = /^\/_next\/static\/dsh-profile\/[a-f0-9]{64}\/$/;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const slice = z.strictObject({
  id: z.string().min(1),
  offset: z.int().nonnegative(),
  length: z.int().positive(),
});
export const publicProfileBundles = z.array(
  z.strictObject({
    reference: z.string(),
    revision: z.string(),
    sha256: digest,
    layout: z
      .strictObject({
        phase: z.enum(['bootstrap', 'application']),
        byteLength: z.int().positive(),
        entries: z.array(slice).min(1),
      })
      .optional(),
  }),
);

type Bundle = {
  url: string;
  rev: string;
  phase?: string;
  entries?: readonly string[];
};
type PublicBundle = {
  url: string;
  assemble?(bytes: ArrayBuffer): Promise<ArrayBuffer>;
};

/** A relocated batch can only use registrations from the authorized seal.
 * The caller supplies the Worker-attested graph, including its execution order. */
export function findPublicProfileBundle(
  release: { root: string; bundles: z.infer<typeof publicProfileBundles> },
  batch: Bundle,
): PublicBundle | undefined {
  if (!publicRoot.test(release.root)) return;
  const bundleUrl = (hash: string) => release.root + 'bundles/' + hash + '.js';
  const exact = release.bundles.find(
    ({ reference, revision }) =>
      reference === batch.url && revision === batch.rev,
  );
  if (exact) return { url: bundleUrl(exact.sha256) };

  const { entries, phase, rev } = batch;
  if (
    !entries?.length ||
    new Set(entries).size !== entries.length ||
    !/^[a-f0-9]{12}$/.test(rev) ||
    entries.some(
      (id) => !/^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/i.test(id),
    ) ||
    batch.url !==
      'plugins/??' +
        entries.map((id) => id + '/client.js').join(',') +
        '&rev=' +
        rev
  )
    return;

  for (const { sha256, layout } of release.bundles) {
    if (!layout || layout.phase !== phase) continue;
    const registrations = new Map(
      layout.entries.map((entry) => [entry.id, entry]),
    );
    const spans = entries.map((id) => registrations.get(id));
    if (!spans.every((span) => span !== undefined)) continue;
    const trailer = new TextEncoder().encode(
      '//# sourceMappingURL=??' +
        entries.map((id) => id + '/client.js.map').join(',') +
        '&rev=' +
        rev +
        '\n',
    );
    return {
      url: bundleUrl(sha256),
      async assemble(bytes) {
        if (
          bytes.byteLength !== layout.byteLength ||
          spans.some(({ offset, length }) => offset + length > bytes.byteLength)
        )
          throw Error('Invalid public profile packet length');
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        const hex = Array.from(new Uint8Array(hash), (value) =>
          value.toString(16).padStart(2, '0'),
        ).join('');
        if (hex !== sha256) throw Error('Invalid public profile packet digest');
        const result = new Uint8Array(
          spans.reduce((size, entry) => size + entry.length, trailer.length),
        );
        let cursor = 0;
        for (const { offset, length } of spans) {
          result.set(new Uint8Array(bytes, offset, length), cursor);
          cursor += length;
        }
        result.set(trailer, cursor);
        return result.buffer;
      },
    };
  }
}
