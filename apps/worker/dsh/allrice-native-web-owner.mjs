import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'allrice-native-web-owner';
export const inject = [
  'connection',
  'webServer',
  'clientModules',
  'allricePrincipal',
];

/** Native local login only. This file never establishes an AllRice principal. */
export async function apply(ctx, config) {
  const { artifactPath, nonce, baseUrl } = config;
  const temporary = `${artifactPath}.${randomUUID()}.tmp`;
  let publishing;
  let published = false;
  let retiring = false;
  const observed = ctx.allricePrincipal.observeProfileGraph(
    ctx.clientModules,
    async () => {
      retiring = true;
      await publishing?.catch(() => {});
      if (published) await rm(artifactPath, { force: true });
    },
  );
  ctx.effect(
    () => () => {
      retiring = true;
      return observed.close();
    },
    'allrice native profile and local auth lifetime',
  );
  await observed.ready;
  if (retiring) return;
  publishing = publish();
  await publishing;

  async function publish() {
    await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          v: 1,
          nonce,
          authenticatedUrl: ctx.connection.authenticatedUrl(baseUrl),
        }),
        { flag: 'wx', mode: 0o600 },
      );
      await rename(temporary, artifactPath);
      published = true;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
