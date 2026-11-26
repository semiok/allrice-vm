import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  installUnitFiles,
  readLinuxRelease,
  renderUnits,
} from './service-manager.mjs';

const digest = (text) =>
  'sha256:' + createHash('sha256').update(text).digest('hex');
const configPath = 'apps/worker/dist/linux-service-config.json';
const config = {
  platform: 'linux/arm64',
  socketRoot: '/run/ar',
  dataMount: '/var/lib/allrice40',
  dataUuid: 'a3da07e9-2b46-4c95-ac44-2d2bae86aaca',
  node: '/opt/node/bin/node',
  webPort: 3000,
  workerPort: 3101,
};

async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'linux-units-')));
  try {
    const seal = async (selection = config, extra = []) => {
      const originals = [
        [configPath, 'worker', JSON.stringify(selection, null, 2)],
        ['apps/worker/dist/index.js', 'worker', '// worker'],
        ['apps/web/server.mjs', 'web', '// web'],
      ];
      const files = [];
      for (const [path, scope, content] of originals) {
        await mkdir(join(root, path, '..'), { recursive: true });
        await writeFile(join(root, path), content);
        files.push({
          path,
          scope,
          bytes: Buffer.byteLength(content),
          checksum: digest(content),
        });
      }
      const body = {
        version: 1,
        environment: 'dev',
        repository: 'semiok/allrice-vm',
        repositoryId: 1469490636,
        sourceSha: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
        files: files.concat(extra),
      };
      await mkdir(join(root, '.local'), { recursive: true });
      const manifestDigest = digest(JSON.stringify(body));
      await writeFile(
        join(root, '.local/dev-build-identity.json'),
        JSON.stringify({ ...body, manifestDigest }),
      );
      return manifestDigest;
    };
    await run(root, seal);
  } finally {
    await rm(root, { recursive: true });
  }
}

test('renders sealed Linux units with mount, loopback and graceful-stop constraints', async () => {
  await fixture(async (root, seal) => {
    const units = renderUnits(await readLinuxRelease(root, await seal()));
    const worker = units.get('allrice40-worker.service');
    const web = units.get('allrice40-web.service');
    expect(worker).toContain(
      'RuntimeDirectory=ar\nRuntimeDirectoryMode=0700\nRuntimeDirectoryPreserve=yes',
    );
    expect(worker).toContain(
      'ALLRICE_WORKER_HOST=127.0.0.1 ALLRICE_WORKER_PORT=3101',
    );
    expect(worker).toContain(
      'KillMode=mixed\nSendSIGKILL=no\nTimeoutStopSec=infinity',
    );
    expect(worker).toContain(
      '--mountpoint /var/lib/allrice40 --source UUID=' + config.dataUuid,
    );
    expect(worker).toContain('SupplementaryGroups=kvm');
    expect(web).toContain('--hostname 127.0.0.1 --port 3000');
    expect(web).toContain('After=allrice40-worker.service');
    expect(web).not.toContain('SupplementaryGroups=kvm');
  });
});

test('refuses stale digests, modified bytes, path aliases and wrong platform', async () => {
  await fixture(async (root, seal) => {
    const expected = await seal();
    await expect(readLinuxRelease(root, digest('other'))).rejects.toThrow(
      /seal/,
    );
    await writeFile(
      join(root, configPath),
      JSON.stringify({ ...config, webPort: 5555 }),
    );
    await expect(readLinuxRelease(root, expected)).rejects.toThrow(/changed/);
    const macSeal = await seal({ ...config, platform: 'darwin/arm64' });
    await expect(readLinuxRelease(root, macSeal)).rejects.toThrow(
      /Linux service/,
    );
    const pathSeal = await seal({ ...config, node: '/opt/%n/node' });
    await expect(readLinuxRelease(root, pathSeal)).rejects.toThrow(
      /Linux service/,
    );
    const duplicate = await seal(config, [
      { path: configPath, scope: 'worker' },
    ]);
    await expect(readLinuxRelease(root, duplicate)).rejects.toThrow(
      /ambiguous/,
    );
    const resealed = await seal();
    await symlink(root, join(root, 'alias'));
    await expect(
      readLinuxRelease(join(root, 'alias'), resealed),
    ).rejects.toThrow(/root/);
  });
});

test('installs idempotently, refuses replacement, and rolls back its own files on reload error', async () => {
  await fixture(async (root, seal) => {
    const units = renderUnits(await readLinuxRelease(root, await seal()));
    const directory = join(root, 'units');
    await mkdir(directory);
    const web = join(directory, 'allrice40-web.service');
    const worker = join(directory, 'allrice40-worker.service');
    await expect(
      installUnitFiles(directory, units, () => {
        throw new Error('reload');
      }),
    ).rejects.toThrow('reload');
    await expect(readFile(worker)).rejects.toMatchObject({ code: 'ENOENT' });
    await installUnitFiles(directory, units, () => {});
    await installUnitFiles(directory, units, () => {});
    expect(await readFile(worker, 'utf8')).toBe(
      units.get('allrice40-worker.service'),
    );
    await writeFile(web, 'existing');
    await expect(installUnitFiles(directory, units, () => {})).rejects.toThrow(
      /differs/,
    );
    expect(await readFile(web, 'utf8')).toBe('existing');
  });
});
