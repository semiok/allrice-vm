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
  assertDataMount,
  checkUnitPlacement,
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
  workerPort: 3312,
};

async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'linux-units-')));
  try {
    const seal = async (selection = config, extra = []) => {
      const originals = [
        [configPath, 'worker', JSON.stringify(selection, null, 2)],
        ['apps/worker/dist/index.js', 'worker', '// worker'],
        ['apps/web/server.mjs', 'web', '// web'],
        ['apps/web/.next/BUILD_ID', 'web', 'fixture-build'],
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
        webBuildId: 'fixture-build',
        protocols: {
          identity: 1,
          ordinaryConsumer: 1,
          releaseAdmission: 'disabled',
        },
        workspaceEdges: [],
        nextExternalAliases: [],
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
      'ALLRICE_WORKER_HOST=127.0.0.1 ALLRICE_WORKER_PORT=3312',
    );
    expect(worker).toContain(
      'KillMode=mixed\nSendSIGKILL=no\nTimeoutStopSec=infinity',
    );
    expect(worker).toContain(
      'check-mount /var/lib/allrice40 ' + config.dataUuid,
    );
    expect(worker).toContain('SupplementaryGroups=kvm');
    expect(web).toContain('--hostname 127.0.0.1 --port 3000');
    expect(web).toContain('After=allrice40-worker.service');
    expect(web).toContain('ALLRICE_WORKER_INTERNAL_URL=http://127.0.0.1:3312');
    expect(worker).toContain(
      'ALLRICE_EXECUTION_ROOT=/var/lib/allrice40/executions',
    );
    for (const unit of [worker, web])
      expect(unit).toContain('ALLRICE_STORAGE_ROOT=/var/lib/allrice40/storage');
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
    const original = await seal();
    await writeFile(
      join(root, 'apps/worker/dist/index.js'),
      '// changed entry',
    );
    await expect(readLinuxRelease(root, original)).rejects.toThrow(/changed/);
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
      installUnitFiles(
        directory,
        units,
        () => {},
        () => {
          throw new Error('reload');
        },
      ),
    ).rejects.toThrow('reload');
    await expect(readFile(worker)).rejects.toMatchObject({ code: 'ENOENT' });
    await installUnitFiles(
      directory,
      units,
      () => {},
      () => {},
    );
    await installUnitFiles(
      directory,
      units,
      () => {},
      () => {},
    );
    expect(await readFile(worker, 'utf8')).toBe(
      units.get('allrice40-worker.service'),
    );
    await writeFile(web, 'existing');
    await expect(
      installUnitFiles(
        directory,
        units,
        () => {},
        () => {},
      ),
    ).rejects.toThrow(/differs/);
    expect(await readFile(web, 'utf8')).toBe('existing');
  });
});

test('rejects an absent, wrong, read-only or shadowed data mount', () => {
  const match = {
    target: config.dataMount,
    uuid: config.dataUuid,
    options: 'rw,nosuid',
  };
  const other = { ...match, uuid: 'other' };
  assertDataMount(
    JSON.stringify({ filesystems: [match] }),
    config.dataMount,
    config.dataUuid,
  );
  for (const bad of [
    [],
    [other],
    [{ ...match, options: 'ro' }],
    [match, other],
    [other, match],
  ])
    expect(() =>
      assertDataMount(
        JSON.stringify({ filesystems: bad }),
        config.dataMount,
        config.dataUuid,
      ),
    ).toThrow(/single writable/);
});

test('refuses an existing vendor or runtime unit and a systemd drop-in', async () => {
  await fixture(async (root) => {
    const own = join(root, 'etc'),
      vendor = join(root, 'vendor'),
      runtime = join(root, 'run');
    for (const directory of [own, vendor, runtime]) await mkdir(directory);
    const loadPaths = [own, runtime, vendor];
    const missing = () => 'LoadState=not-found\nFragmentPath=\nDropInPaths=\n';
    await checkUnitPlacement(own, loadPaths, missing);
    const fragment = join(vendor, 'allrice40-worker.service');
    await writeFile(fragment, 'vendor');
    await expect(checkUnitPlacement(own, loadPaths, missing)).rejects.toThrow(
      /search path/,
    );
    await rm(fragment);
    const dropin = join(runtime, 'allrice40-.service.d');
    await mkdir(dropin);
    await expect(checkUnitPlacement(own, loadPaths, missing)).rejects.toThrow(
      /drop-in/,
    );
    await rm(dropin, { recursive: true });
    await expect(
      checkUnitPlacement(
        own,
        loadPaths,
        () => 'LoadState=masked\nFragmentPath=/dev/null\nDropInPaths=\n',
      ),
    ).rejects.toThrow(/mask/);
  });
});

test('holds installation across both writes and reload', async () => {
  await fixture(async (root, seal) => {
    const units = renderUnits(await readLinuxRelease(root, await seal()));
    const directory = join(root, 'units');
    await mkdir(directory);
    let entered, release;
    const inReload = new Promise((done) => {
      entered = done;
    });
    const blocked = new Promise((done) => {
      release = done;
    });
    const first = installUnitFiles(
      directory,
      units,
      () => {},
      async () => {
        entered();
        await blocked;
      },
    );
    await inReload;
    try {
      await expect(
        installUnitFiles(
          directory,
          units,
          () => {},
          () => {},
        ),
      ).rejects.toMatchObject({ code: 'EEXIST' });
    } finally {
      release();
      await first;
    }
    for (const [name, contents] of units)
      expect(await readFile(join(directory, name), 'utf8')).toBe(contents);
  });
});
