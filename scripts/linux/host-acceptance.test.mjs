import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { probeHost } from './host-acceptance.mjs';
import { renderUnits } from './service-manager.mjs';

const config = JSON.parse(
  readFileSync(
    new URL('./host-acceptance.example.json', import.meta.url),
    'utf8',
  ),
);
const identity = config.current;
const previous = {
  release: 'e'.repeat(40),
  tree: 'f'.repeat(40),
  manifestDigest: 'sha256:' + '1'.repeat(64),
};
const release = {
  sourceSha: identity.release,
  sourceTree: identity.tree,
  root: '/opt/allrice40/releases/' + identity.release,
  config: {
    dataMount: '/var/lib/allrice40',
    dataUuid: config.dataUuid,
    node: '/opt/allrice40/node/bin/node',
    webPort: 3000,
    workerPort: 3101,
  },
};

/** @param {{changedUnit?: string, serial?: string, scratchDevice?: string, worker?: string, webPid?: number, scratchSerial?: string, rootSerial?: string, extraDevice?: boolean, rollbackCheck?: string}} [options] */
function fixture(options = {}) {
  const files = renderUnits(release);
  const calls = [];
  return {
    calls,
    inputs: {
      load: async (root, seal) => ({
        ...release,
        root,
        sourceSha:
          seal === previous.manifestDigest
            ? previous.release
            : release.sourceSha,
        sourceTree:
          seal === previous.manifestDigest ? previous.tree : release.sourceTree,
      }),
      readUnit: async (path) =>
        options.changedUnit ?? files.get(path.split('/').at(-1)),
      readBoot: async () => '8741f90a-bbbb-cccc-dddd-eeeeeeeeeeee\n',
      run: (program, args) => {
        calls.push([program, args]);
        if (program === '/usr/bin/systemctl')
          return [
            'ActiveState=active',
            'SubState=running',
            'NeedDaemonReload=no',
            'DropInPaths=',
            'FragmentPath=/etc/systemd/system/' + args[1],
            'MainPID=' + (args[1].includes('worker') ? 315 : 316),
          ].join('\n');
        const mount = args[args.indexOf('--mountpoint') + 1];
        const sources = {
          '/': '/dev/nvme0n1p1',
          [config.scratchMount]: '/dev/dm-1',
          [release.config.dataMount]: '/dev/dm-0',
        };
        const serials = {
          '/dev/nvme0n1p1': options.rootSerial ?? 'vol' + '2'.repeat(17),
          '/dev/dm-1': options.scratchSerial ?? 'vol' + '3'.repeat(17),
          '/dev/dm-0': options.serial ?? config.dataVolume.replace('-', ''),
        };
        if (
          program === '/usr/sbin/runuser' &&
          args.includes('--input-type=module')
        )
          return options.rollbackCheck ?? 'verified';
        const web = args.at(-1).endsWith('/api/health/ready');
        const scratch = {
          scratchUuid: config.scratchUuid,
          scratchLuksUuid: config.scratchLuksUuid,
        };
        const replies = {
          '/usr/bin/findmnt': {
            filesystems: [
              {
                target: mount,
                uuid:
                  mount === config.scratchMount
                    ? config.scratchUuid
                    : config.dataUuid,
                options: 'rw',
                source: sources[mount],
              },
            ],
          },
          '/usr/bin/lsblk': {
            blockdevices: [
              {
                type: 'crypt',
                children: [
                  {
                    type: 'disk',
                    serial: serials[args.at(-1)],
                  },
                  ...(options.extraDevice ? [{ type: 'loop' }] : []),
                ],
              },
            ],
          },
          '/usr/bin/python3': { luks2: true, device: '253:1', ...scratch },
          '/usr/sbin/runuser': {
            ...scratch,
            scratchDevice: options.scratchDevice ?? '253:1',
            dataUuid: config.dataUuid,
            kvmApi: 12,
            reflink: true,
          },
          '/usr/bin/curl': {
            status: 'ready',
            identity: {
              service: web ? 'web' : 'worker',
              pid: web ? (options.webPid ?? 316) : 315,
              bootId: '12345678-aaaa-bbbb-cccc-eeeeeeeeeeee',
              environment: 'dev',
              mode: 'production',
              repository: 'semiok/allrice-vm',
              repositoryId: 1469490636,
              sourceSha: options.worker ?? identity.release,
              sourceTree: identity.tree,
              manifestDigest: identity.manifestDigest,
            },
          },
        };
        return JSON.stringify(replies[program]);
      },
    },
  };
}

test('uses sealed units, exact backing EBS and one scratch identity for root and Worker', async () => {
  const { inputs, calls } = fixture();
  const receipt = await probeHost(config, inputs);
  expect(receipt).toMatchObject({
    workerReady: true,
    kvmApi: 12,
    luks2: true,
    reflink: true,
    dataVolume: config.dataVolume,
    systemd: ['allrice40-worker.service', 'allrice40-web.service'],
  });
  expect(
    calls.find(([file]) => file === '/usr/sbin/runuser')[1].slice(0, 3),
  ).toEqual(['-u', 'allrice', '--']);
  expect(calls.filter(([file]) => file === '/usr/bin/systemctl')).toHaveLength(
    2,
  );
  expect(calls.slice(-2).map(([, args]) => args.at(-1))).toEqual([
    'http://127.0.0.1:3101/health/ready',
    'http://127.0.0.1:3000/api/health/ready',
  ]);
});

test('rejects EBS swaps, unsealed systemd bytes, scratch swaps and wrong Worker identity', async () => {
  for (const { options, message } of [
    { options: { serial: 'vol' + '0'.repeat(17) }, message: /approved EBS/ },
    {
      options: { scratchSerial: config.dataVolume.replace('-', '') },
      message: /physically separate/,
    },
    {
      options: { scratchSerial: 'vol' + '2'.repeat(17) },
      message: /physically separate/,
    },
    {
      options: { rootSerial: config.dataVolume.replace('-', '') },
      message: /physically separate from root/,
    },
    { options: { extraDevice: true }, message: /unresolved device/ },
    { options: { changedUnit: 'different' }, message: /systemd unit/ },
    { options: { scratchDevice: '253:2' }, message: /evidence differs/ },
    { options: { worker: 'different' }, message: /worker is not ready/ },
    { options: { webPid: 999 }, message: /web is not ready/ },
  ])
    await expect(probeHost(config, fixture(options).inputs)).rejects.toThrow(
      message,
    );
});

test('fully verifies rollback files using the active verifier as allrice', async () => {
  const { inputs, calls } = fixture();
  const selected = { ...config, rollback: previous };
  await expect(probeHost(selected, inputs)).resolves.toMatchObject({
    rollback: previous,
  });
  const invocation = calls.find(
    ([file, args]) =>
      file === '/usr/sbin/runuser' && args.includes('--input-type=module'),
  )[1];
  expect(invocation.slice(0, 3)).toEqual(['-u', 'allrice', '--']);
  expect(invocation.slice(-5)).toEqual([
    release.root + '/packages/database/dist/service-build-identity.js',
    '/opt/allrice40/releases/' + previous.release + '/apps/web/server.mjs',
    previous.release,
    previous.tree,
    previous.manifestDigest,
  ]);
  await expect(
    probeHost(selected, fixture({ rollbackCheck: 'damaged old file' }).inputs),
  ).rejects.toThrow(/Full rollback release verification failed/);
});

test('host dry-run skips reading host configuration and never runs commands', () => {
  const cli = fileURLToPath(new URL('./host-acceptance.mjs', import.meta.url));
  expect(
    JSON.parse(
      execFileSync(process.execPath, [cli, '--dry-run'], {
        encoding: 'utf8',
        timeout: 3000,
      }),
    ),
  ).toMatchObject({
    mode: 'dry-run',
    checks: expect.arrayContaining(['LUKS2/XFS', 'boot identity']),
  });
});
