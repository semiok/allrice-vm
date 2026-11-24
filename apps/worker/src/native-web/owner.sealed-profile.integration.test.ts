import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DEntryProfileGraphSchema } from '@allrice/contracts';
import {
  holdReleasedProfile,
  readReleasedGuestProfile,
} from '../d-entry/released-profile.js';
import { setupNativeWebFixture } from './owner.native.fixture.js';

const roots: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  for (const result of results)
    if (result.status === 'rejected') throw result.reason;
});

it(
  'boots the Worker-sealed AllRice web profile in an initially absent employee DSH_HOME',
  {
    timeout: 30_000,
  },
  async () => {
    const install = createRequire(
      new URL(
        '../../../../packages/dsh-web-composition/package.json',
        import.meta.url,
      ),
    );
    const installed = dirname(install.resolve('@deepseek-ai/dsh/package.json'));
    const f = await setupNativeWebFixture(
      join(installed, 'lib/bin.js'),
      roots,
      cleanup,
      undefined,
      true,
    );
    const active = new AbortController().signal;
    expect(f.launch.command.args.slice(1, 3)).toEqual([
      '--profile',
      'allrice-web',
    ]);
    expect(f.owner.controlReady()).toBe(true);
    const patch = await f.observedProfilePatch();
    expect(patch.actual).toEqual([patch.expected]);
    const built = JSON.parse(
      await readFile(join(f.seal.directory, 'artifact.json'), 'utf8'),
    );
    const expected = DEntryProfileGraphSchema.parse(built.profile.graph);
    const native = DEntryProfileGraphSchema.parse(
      await f.owner.readImmutableGraphFor(f.context, active),
    );
    const ids = native.entries.map(({ id }) => id);
    const sealedIds = expected.entries.map(({ id }) => id);
    expect({
      missing: sealedIds.filter((id) => !ids.includes(id)),
      extra: ids.filter((id) => !sealedIds.includes(id)),
      release: native.release,
    }).toEqual({ missing: [], extra: [], release: expected.release });
    const proof = await holdReleasedProfile(
      f.seal.directory,
      {
        revoked: f.owner.revoked,
        readImmutableGraph: (signal) =>
          f.owner.readImmutableGraphFor(f.context, signal),
        readImmutableBundle: (reference, bytes, signal) =>
          f.owner.readImmutableBundleFor(f.context, reference, bytes, signal),
      },
      active,
      f.seal.manifestSha256,
    );
    expect(
      proof.graph.entries.some(
        ({ id }) => id === '@allrice/dsh-web-composition',
      ),
    ).toBe(true);
    expect(
      proof.graph.entries.some(
        ({ id }) => id === '@deepseek-ai/dsh-client-hmr',
      ),
    ).toBe(false);
    expect(proof.graph).toEqual(native);
    const guestManifest = f.launch.files.find(({ path }) =>
      path.endsWith('/profiles/allrice-web/package.json'),
    );
    expect(JSON.parse(guestManifest!.contents).dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@allrice/dsh-web-composition',
    ]);
    const producer = await import(
      new URL(
        '../../../../packages/dsh-web-composition/build-web-entry.mjs',
        import.meta.url,
      ).href
    );
    const prepareAgain = () =>
      producer.prepareEmployeeWebServiceArtifact(
        f.seal.directory,
        built.source.head,
      );
    expect(await prepareAgain()).toEqual(built);
    const patchFile = join(f.seal.directory, 'guest/cordis.patch.yml');
    const exactBytes = await readFile(patchFile);
    await rm(patchFile);
    await expect(prepareAgain()).rejects.toThrow(
      'Missing Employee Web artifact file: guest/cordis.patch.yml',
    );
    await expect(access(patchFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const changed = Buffer.from(exactBytes);
    changed[0] = changed[0]! ^ 1;
    await writeFile(patchFile, changed);
    await expect(prepareAgain()).rejects.toThrow(
      'Employee Web artifact bytes changed: guest/cordis.patch.yml',
    );
    await expect(readReleasedGuestProfile(f.seal, active)).rejects.toThrow(
      'D entry native owner is not bound',
    );
    await writeFile(patchFile, exactBytes);
    const manifestPath = join(f.seal.directory, 'artifact.json');
    built.files = built.files.filter(
      ({ path }: { path: string }) => path !== 'guest/cordis.patch.yml',
    );
    await writeFile(manifestPath, JSON.stringify(built));
    await expect(prepareAgain()).rejects.toThrow(
      'Missing Employee Web artifact file: guest/cordis.patch.yml',
    );
    await f.owner.close();
    expect(f.kills()).toBe(1);
  },
);
