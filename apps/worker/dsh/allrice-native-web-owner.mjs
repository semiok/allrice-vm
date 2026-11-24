import { renameSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'allrice-native-web-owner';
export const inject = [
  'connection',
  'webServer',
  'clientModules',
  'allricePrincipal',
];
const activeOwners = new WeakMap();
const cordisOriginal = Symbol.for('cordis.original');
const original = (value) => value?.[cordisOriginal] ?? value;

/** An explicit local unloader also receives the actual profile retirement. */
export async function unloadNativeWebOwner(fiber) {
  const retire = activeOwners.get(fiber.dispose);
  if (!retire) throw Error('Native web owner retirement is unavailable');
  const results = await Promise.allSettled([retire(), fiber.dispose()]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, 'Native web owner retirement failed');
}

/** Native local login only. This file never establishes an AllRice principal. */
export async function apply(ctx, config) {
  const { artifactPath, nonce, baseUrl } = config;
  const { fiber } = ctx;
  const providers = Object.entries(fiber.store ?? {}).map(
    ([name, provider]) => [name, provider.fiber, original(provider.value)],
  );
  const temporary = `${artifactPath}.${randomUUID()}.tmp`;
  let publishing;
  let published = false;
  let retiring = false;
  const current = () =>
    !retiring &&
    fiber.uid !== null &&
    providers.every(([name, provider, value]) => {
      const live = ctx.get(name);
      return provider.uid !== null && live != null && original(live) === value;
    });
  const observed = ctx.allricePrincipal.observeProfileGraph(ctx.clientModules, {
    current,
    publish() {
      return (publishing = publish());
    },
    async retire() {
      retiring = true;
      await publishing?.catch(() => {});
      if (published) await rm(artifactPath, { force: true });
    },
  });
  const retire = () => {
    retiring = true;
    return observed.close();
  };
  // Cordis exposes an awaitable facade over the same actual disposer.
  activeOwners.set(fiber.dispose, retire);
  const retireMissingOwner = () => {
    if (!current()) void retire().catch(() => {});
  };
  // Cordis clears the actual uid or injection before its loading effect can
  // reach a disposer. That notification also fences existing scopes now.
  ctx.on('internal/plugin', retireMissingOwner);
  ctx.on('internal/service', retireMissingOwner);
  ctx.effect(() => retire, 'allrice native profile and local auth lifetime');
  try {
    await observed.ready;
  } catch (error) {
    if (current()) {
      await retire().catch(() => {});
      throw error;
    }
  }

  async function publish() {
    await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
    if (!current()) return;
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
      // The last generation check and same-directory publication have one
      // ordering with Cordis disposal, even if staging the nonce took time.
      if (current()) {
        renameSync(temporary, artifactPath);
        published = true;
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
