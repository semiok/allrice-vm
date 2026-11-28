import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { publicProfileStartupPath } from './public-profile-warmup';
import { publicProfileBundles } from './public-profile-bundles';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const index = z.strictObject({
  stamp: sha,
  paths: z.array(z.string()),
  startup: z.array(z.string()),
  bundles: publicProfileBundles,
});

export async function readLocalProfileAssets(entrypoint = process.argv[1]) {
  if (!entrypoint?.endsWith('/apps/web/server.mjs')) return undefined;
  try {
    const { stamp, paths, bundles, startup } = index.parse(
      JSON.parse(
        await readFile(
          join(dirname(entrypoint), '.next/server/dsh-profile.json'),
          'utf8',
        ),
      ),
    );
    const root = '/_next/static/dsh-profile/' + stamp + '/';
    return { stamp, root, paths: new Set(paths), bundles, startup };
  } catch {
    return undefined;
  }
}

/** Warming only gets a list of code already staged in the public release. */
export async function readStartupProfileAssetUrls(entrypoint?: string) {
  const release = await readLocalProfileAssets(entrypoint);
  if (!release) return [];
  return release.startup
    .filter((path) => release.paths.has(path))
    .map((path) => release.root + path)
    .filter((url) => publicProfileStartupPath.test(url));
}
