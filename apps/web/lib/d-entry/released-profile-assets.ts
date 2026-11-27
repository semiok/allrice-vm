import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const index = z.strictObject({
  stamp: sha,
  paths: z.array(z.string()),
  bundles: z.array(
    z.strictObject({
      reference: z.string(),
      revision: z.string(),
      sha256: sha,
    }),
  ),
});

/** The digest comes from the authorized Worker publication. Only a co-sealed
 * Web index for that exact digest may opt the page into public code delivery. */
export async function readReleasedProfileAssets(
  manifestSha256: string,
  entrypoint = process.argv[1],
) {
  if (
    !sha.safeParse(manifestSha256).success ||
    !entrypoint?.endsWith('/apps/web/server.mjs')
  )
    return undefined;
  try {
    const { stamp, paths, bundles } = index.parse(
      JSON.parse(
        await readFile(
          join(
            dirname(entrypoint),
            '.next/server/dsh-profile-' + manifestSha256 + '.json',
          ),
          'utf8',
        ),
      ),
    );
    if (stamp !== manifestSha256) return undefined;
    const root = '/_next/static/dsh-profile/' + stamp + '/';
    return { root, paths: new Set(paths), bundles };
  } catch {
    return undefined;
  }
}
