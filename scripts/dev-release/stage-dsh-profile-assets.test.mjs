import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { readReleasedProfileAssets } from '../../apps/web/lib/d-entry/released-profile-assets.ts';
import { stageDshProfileAssets } from './stage-dsh-profile-assets.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const head = '1'.repeat(40);
const application = 'plugins/' + '2'.repeat(64) + '.js';
const artifact = 'apps/worker/dist/d-entry-web';
const next = 'apps/web/.next';
const reference = 'plugins/??application/client.js&rev=build';
const paths = {
  'managed/employee-web-entry.js': 'export const runtime = 1;',
  'managed/employee-web-entry.css': '.entry {color: black}',
  'managed/entry.js.map': '{"privateSource":true}',
  'native/index.html': '<div>Do not publish HTML</div>',
  'native/assets/vendor-aaaaaaaa.css':
    "@font-face {src:url('./fonts/native-AbCd.woff2')}",
  'native/assets/fonts/native-AbCd.woff2': 'test font payload',
  'guest/worker.js': '/* not a browser artifact */',
};

async function fixture(op) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'dsh-profile-assets-')),
  );
  try {
    await mkdir(join(root, next, 'static'), { recursive: true });
    await mkdir(join(root, next, 'server'), { recursive: true });
    const build = async (body) => {
      const files = [];
      for (const [path, contents] of Object.entries({
        ...paths,
        [application]: body,
      })) {
        const filename = join(root, artifact, path);
        await mkdir(dirname(filename), { recursive: true });
        await writeFile(filename, contents);
        files.push({
          path,
          bytes: Buffer.byteLength(contents),
          sha256: digest(contents),
        });
      }
      const manifest = JSON.stringify({
        status: 'code-artifacts-only',
        source: { head, dirty: false },
        nativeRelease: { name: '@deepseek-ai/dsh-web-frontend' },
        files,
        profile: {
          graph: {
            batches: [{ url: reference, rev: 'build', phase: 'application' }],
          },
          files: [
            { ...files.find((item) => item.path === application), reference },
          ],
        },
      });
      await writeFile(join(root, artifact, 'artifact.json'), manifest);
      return digest(manifest);
    };
    await op(root, build);
  } finally {
    await rm(root, { recursive: true });
  }
}

test('stages sealed JS and CSS under immutable paths and changes the URL on new bytes', async () => {
  await fixture(async (root, build) => {
    const body = 'globalThis.application = 1;';
    const first = await build(body);
    await stageDshProfileAssets(root, head);
    await stageDshProfileAssets(root, head);
    const directory = join(root, next, 'static/dsh-profile', first);
    expect(await readdir(directory)).toEqual(['bundles', 'managed', 'native']);
    expect(await readdir(join(directory, 'native'))).toEqual(['assets']);
    expect(
      await readFile(
        join(directory, 'native/assets/fonts/native-AbCd.woff2'),
        'utf8',
      ),
    ).toBe('test font payload');
    expect(await readdir(join(directory, 'managed'))).toEqual([
      'employee-web-entry.css',
      'employee-web-entry.js',
    ]);
    const bundle = 'bundles/' + digest(body) + '.js';
    expect(await readFile(join(directory, bundle), 'utf8')).toBe(body);
    expect(
      JSON.parse(
        await readFile(
          join(root, next, 'server/dsh-profile-' + first + '.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      stamp: first,
      paths: expect.arrayContaining([bundle]),
      bundles: [{ reference, revision: 'build', sha256: digest(body) }],
    });
    const entrypoint = join(root, 'apps/web/server.mjs');
    const released = await readReleasedProfileAssets(first, entrypoint);
    expect(released.root).toBe('/_next/static/dsh-profile/' + first + '/');
    await expect(
      readReleasedProfileAssets('0'.repeat(64), entrypoint),
    ).resolves.toBeUndefined();
    await fixture(async (newRoot, newBuild) => {
      const second = await newBuild('globalThis.application = 2;');
      await stageDshProfileAssets(newRoot, head);
      const upgraded = await readReleasedProfileAssets(
        second,
        join(newRoot, 'apps/web/server.mjs'),
      );
      expect(upgraded.root).not.toBe(released.root);
    });
    expect(await readFile(join(directory, bundle), 'utf8')).toBe(body);
  });
});

test('does not publish an existing stamped directory with extra files', async () => {
  await fixture(async (root, build) => {
    const stamp = await build('trusted');
    await stageDshProfileAssets(root, head);
    await writeFile(
      join(root, next, 'static/dsh-profile', stamp, 'unexpected.html'),
      'private',
    );
    await expect(stageDshProfileAssets(root, head)).rejects.toThrow(
      /untrusted.*inventory/i,
    );
  });
});

test('refuses symlinks and mismatched bytes before publishing', async () => {
  await fixture(async (root, build) => {
    const path = join(root, artifact, application);
    await build('trusted');
    await writeFile(path, 'untrusted');
    await expect(stageDshProfileAssets(root, head)).rejects.toThrow(
      /differs from the seal/,
    );
    expect(await readdir(join(root, next, 'static/dsh-profile'))).toEqual([]);
    await rm(path);
    const alias = join(root, 'other.js');
    await writeFile(alias, 'trusted');
    await symlink(alias, path);
    await expect(stageDshProfileAssets(root, head)).rejects.toThrow(
      /Untrusted/,
    );
    expect(await readdir(join(root, next, 'server'))).toEqual([]);
  });
});
