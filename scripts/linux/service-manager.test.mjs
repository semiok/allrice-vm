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
import { resolveHostLayout } from './host-layout.mjs';
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
        [
          'apps/worker/dist/linux-service-manager.mjs',
          'worker',
          '// mount checker',
        ],
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
    expect(worker).toContain(
      'ALLRICE_DSH_RUNTIME_ROOT=/var/lib/allrice40/dsh-runtime',
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
    const checkSeal = await seal();
    await writeFile(
      join(root, 'apps/worker/dist/linux-service-manager.mjs'),
      '// changed checker',
    );
    await expect(readLinuxRelease(root, checkSeal)).rejects.toThrow(/changed/);
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

test('uses the sealed platform and rejects a missing, wrong, read-only or shadowed data mount', async () => {
  await fixture(async (root, seal) => {
    const selected = {
      ...config,
      dataUuid: '11111111-2222-3333-4444-555555555555',
    };
    const release = await readLinuxRelease(root, await seal(selected));
    expect(
      resolveHostLayout(release.config, { platform: 'linux', arch: 'arm64' })
        .socketRoot,
    ).toBe('/run/ar');
    expect(() =>
      resolveHostLayout(release.config, { platform: 'darwin', arch: 'arm64' }),
    ).toThrow(/does not match/);
    const match = {
      target: selected.dataMount,
      uuid: selected.dataUuid,
      options: 'rw,nosuid',
    };
    const other = { ...match, uuid: config.dataUuid };
    const verifyMount = (filesystems) =>
      assertDataMount(
        JSON.stringify({ filesystems }),
        release.config.dataMount,
        release.config.dataUuid,
      );
    verifyMount([match]);
    for (const bad of [
      [],
      [other],
      [{ ...match, options: 'ro' }],
      [match, other],
      [other, match],
    ])
      expect(() => verifyMount(bad)).toThrow(/single writable/);
  });
});

test('refuses an existing vendor or runtime unit and a systemd drop-in', async () => {
  await fixture(async (root) => {
    const own = join(root, 'etc'),
      vendor = join(root, 'vendor'),
      runtime = join(root, 'run');
    for (const directory of [own, vendor, runtime]) await mkdir(directory);
    const loadPaths = [own, runtime, vendor];
    const idle =
      'ActiveState=inactive\nMainPID=0\nControlPID=0\nJob=\nUpheldBy=\n';
    const missing = () =>
      idle + 'LoadState=not-found\nFragmentPath=\nDropInPaths=\n';
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
    const enabled = join(runtime, 'multi-user.target.wants');
    await mkdir(enabled);
    await symlink(
      join(own, 'allrice40-worker.service'),
      join(enabled, 'allrice40-worker.service'),
    );
    await expect(checkUnitPlacement(own, loadPaths, missing)).rejects.toThrow(
      /dependency link/,
    );
    await rm(enabled, { recursive: true });
    await expect(
      checkUnitPlacement(own, loadPaths, () =>
        missing()
          .replace('ActiveState=inactive', 'ActiveState=active')
          .replace('MainPID=0', 'MainPID=1234'),
      ),
    ).rejects.toThrow(/activity/);
    await expect(
      checkUnitPlacement(own, loadPaths, () =>
        missing().replace('UpheldBy=', 'UpheldBy=active-upstream.service'),
      ),
    ).rejects.toThrow(/activity/);
    await expect(
      checkUnitPlacement(
        own,
        loadPaths,
        () => idle + 'LoadState=masked\nFragmentPath=/dev/null\nDropInPaths=\n',
      ),
    ).rejects.toThrow(/mask/);
  });
});

test('holds installation across both writes and reload', async () => {
  await fixture(async (root, seal) => {
    const units = renderUnits(await readLinuxRelease(root, await seal()));
    const directory = join(root, 'units');
    await mkdir(directory);
    const { promise: inReload, resolve: entered } = Promise.withResolvers();
    const { promise: blocked, resolve: release } = Promise.withResolvers();
    const first = installUnitFiles(
      directory,
      units,
      () => {},
      async () => {
        entered(undefined);
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
      release(undefined);
      await first;
    }
    for (const [name, contents] of units)
      expect(await readFile(join(directory, name), 'utf8')).toBe(contents);
  });
});
