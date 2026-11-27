import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MicrosandboxPersonVm } from '../../packages/person-vm/dist/microsandbox.js';
import {
  runCommand,
  hostEnvironment,
} from '../../packages/person-vm/dist/process.js';
import { stageEmployeeProfileNativeInputs } from './verify.mjs';

const guestRoot = '/tmp/allrice-profile-build';
const guestHome = guestRoot + '/dsh';
const guestPackage =
  guestHome + '/profiles/allrice-web/node_modules/@allrice/dsh-web-composition';
const collectorPath = fileURLToPath(
  new URL(
    '../../packages/dsh-web-composition/collect-profile-artifacts.mjs',
    import.meta.url,
  ),
);

const guestProgram = String.raw`
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { collectProfileArtifacts } from './collect-profile-artifacts.mjs';
const [root, packageRoot, installAnchor, terminalEnabled] = process.argv.slice(2);
const addresses = (networkInterfaces().eth0 ?? []).filter(row => row.family === 'IPv4');
const [entry] = addresses;
const fields = entry?.address.split('.').map(Number);
if (process.platform !== 'linux' || process.arch !== 'arm64' ||
    process.version !== 'v22.23.2' || addresses.length !== 1 || entry.internal ||
    entry.cidr !== entry.address + '/30' || fields[3] % 4 !== 2 ||
    !(fields[0] === 10 || (fields[0] === 172 && fields[1] >= 16 && fields[1] <= 31) ||
      (fields[0] === 192 && fields[1] === 168)))
  throw new Error('Employee profile requires the current Linux guest eth0 address');
await collectProfileArtifacts({
  outputDirectory: join(root, 'output'),
  dshHome: join(root, 'dsh'),
  packageRoot,
  installAnchor,
  host: entry.address,
  terminalEnabled: terminalEnabled !== 'false',
});
`;

async function checkedProfile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
    throw Error('Invalid Employee Web guest profile inventory');
  const profile = JSON.parse(await readFile(file, 'utf8'));
  if (
    !Array.isArray(profile.files) ||
    !profile.files.length ||
    profile.files.length > 512
  )
    throw Error('Invalid Employee Web guest profile inventory');
  const seen = new Set();
  let size = 0;
  for (const row of profile.files) {
    size += row.bytes;
    if (
      !/^plugins\/[a-f0-9]{64}\.(?:js|map)$/.test(row.path) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes <= 0 ||
      row.bytes > 16 * 1024 * 1024 ||
      size > 128 * 1024 * 1024 ||
      seen.has(row.path)
    )
      throw Error('Invalid Employee Web guest profile resource');
    seen.add(row.path);
  }
  return profile;
}

async function stopCapture(provider, binding, remove) {
  const signal = globalThis.AbortSignal.timeout(60000);
  await provider.stop(binding, signal);
  if ((await provider.status(binding, signal)) === 'stopped')
    await remove(signal);
  if ((await provider.status(binding, signal)) !== 'absent')
    throw Error('Employee Web capture sandbox cleanup incomplete');
}

export function createEmployeeLinuxCapture(native, identity) {
  return {
    identity,
    async collect(output, inputs) {
      const cancelled = new globalThis.AbortController();
      const abort = () => cancelled.abort();
      for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, abort);
      const signal = globalThis.AbortSignal.any([
        cancelled.signal,
        globalThis.AbortSignal.timeout(180000),
      ]);
      let scratch;
      let keep = false;
      try {
        scratch = await mkdtemp('/tmp/dw');
        const mount = await realpath(scratch);
        const binaries = await stageEmployeeProfileNativeInputs(
          native,
          mount,
          signal,
        );
        const binding = Object.freeze({
          vmId: randomUUID(),
          instanceId: randomUUID(),
          personId: randomUUID(),
          organizationId: randomUUID(),
          leaseEpoch: 1,
        });
        const name = 'allrice-' + binding.vmId;
        const provider = new MicrosandboxPersonVm({
          ...native,
          ...binaries,
          socketRoot: scratch,
          memoryMiB: 2048,
        });
        const env = {
          ...hostEnvironment(join(mount, 'host-home')),
          MSB_HOME: join(scratch, binding.vmId),
          MSB_CONFIG_PATH: join(mount, 'msb-config.json'),
        };
        const msb = (args, active = signal) =>
          runCommand({
            executable: binaries.binary,
            args,
            env,
            signal: active,
          });
        const exec = (...args) =>
          msb([
            'exec',
            name,
            '--no-stdin',
            '--no-tty',
            '--workdir',
            '/',
            '--',
            ...args,
          ]);
        const push = (from, to) =>
          msb(['cp', from, name + ':' + to, '--quiet']);
        const pull = (from, to) =>
          msb(['cp', name + ':' + from, to, '--quiet']);
        let createAttempted = false;
        let phase = 'native-prepare';
        let failure;
        try {
          await provider.prepare(binding, mount, signal);
          phase = 'offline-vm-create';
          createAttempted = true;
          await provider.create(binding, { binding, gatewayPorts: [] }, signal);
          if ((await provider.status(binding, signal)) !== 'running')
            throw Error('Employee Web capture sandbox did not start');
          phase = 'stage-profile';
          const copied = [
            ...inputs.map((path) => [
              join(output, 'guest', path),
              guestPackage + '/' + path,
            ]),
            [
              join(output, 'allrice/client.js'),
              guestPackage + '/dist/client.js',
            ],
            [collectorPath, guestRoot + '/collect-profile-artifacts.mjs'],
            [join(scratch, 'capture.mjs'), guestRoot + '/capture.mjs'],
          ];
          await writeFile(join(scratch, 'capture.mjs'), guestProgram, {
            mode: 0o600,
            flag: 'wx',
          });
          await exec(
            '/bin/mkdir',
            '-p',
            '--',
            ...new Set([
              ...copied.map(([, to]) => posix.dirname(to)),
              guestRoot + '/home',
              guestRoot + '/agents',
              guestRoot + '/output/plugins',
            ]),
          );
          for (const [from, to] of copied) await push(from, to);
          phase = 'collect-profile';
          await exec(
            '/usr/bin/env',
            'HOME=' + guestRoot + '/home',
            'DSH_HOME=' + guestHome,
            'DSH_AGENTS_HOME=' + guestRoot + '/agents',
            'DSH_TELEMETRY_DISABLED=1',
            'DO_NOT_TRACK=1',
            '/usr/local/bin/node',
            guestRoot + '/capture.mjs',
            guestRoot,
            guestPackage,
            native.readonlyDshDirectory.guestDirectory +
              '/node_modules/@deepseek-ai/dsh/package.json',
            String(identity.terminalEnabled ?? true),
          );
          phase = 'read-profile-bundles';
          const profileFile = join(output, 'profile-code.json');
          await pull(guestRoot + '/output/profile-code.json', profileFile);
          const profile = await checkedProfile(profileFile);
          for (const { path } of profile.files)
            await pull(guestRoot + '/output/' + path, join(output, path));
          await writeFile(
            join(output, 'profile-startup.log'),
            'Employee Web profile collected on the sealed Linux guest.\n',
            { flag: 'wx' },
          );
        } catch (error) {
          failure = Error('Employee Web Linux capture failed at ' + phase, {
            cause: error,
          });
        }
        if (createAttempted) {
          keep = true;
          try {
            await stopCapture(provider, binding, (signal) =>
              msb(['rm', name, '--quiet'], signal),
            );
            keep = false;
          } catch (error) {
            throw Error(
              'Employee Web capture sandbox cleanup incomplete: ' + scratch,
              {
                cause: failure ? new AggregateError([failure, error]) : error,
              },
            );
          }
        }
        if (failure) throw failure;
      } finally {
        try {
          if (scratch && !keep) await rm(scratch, { recursive: true });
        } finally {
          for (const signal of ['SIGTERM', 'SIGINT'])
            process.removeListener(signal, abort);
        }
      }
      cancelled.signal.throwIfAborted();
    },
  };
}
