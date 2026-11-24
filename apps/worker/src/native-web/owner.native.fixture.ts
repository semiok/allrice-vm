import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import { readReleasedGuestProfile } from '../d-entry/released-profile.js';
import {
  PersonVmError,
  nativeWebAuthArtifact,
  type PersonVmBootstrapScope,
  type PersonVmManagedJob,
  type PersonVmPort,
} from '@allrice/person-vm';
import {
  NATIVE_WEB_AUTH_READER,
  parseNativeWebAuth,
} from '../../../../packages/person-vm/src/native-web-auth.ts';
import { runCommand } from '../../../../packages/person-vm/src/process.ts';
import { prepareNativeWebLaunch } from './launch.js';
import { openNativeWebOwner } from './owner.js';

async function isolatedCli(root: string, installedCli: string) {
  const originalPackage = resolve(dirname(installedCli), '..');
  const sourceModules = resolve(originalPackage, '../..');
  const modules = join(root, 'runtime/node_modules');
  await mkdir(modules, { recursive: true });
  for (const name of await readdir(sourceModules)) {
    if (name.startsWith('.') || name === '@allrice') continue;
    if (!name.startsWith('@')) {
      await symlink(
        await realpath(join(sourceModules, name)),
        join(modules, name),
      );
      continue;
    }
    await mkdir(join(modules, name));
    for (const dependency of await readdir(join(sourceModules, name))) {
      if (name === '@deepseek-ai' && dependency === 'dsh') continue;
      const path = join(name, dependency);
      await symlink(
        await realpath(join(sourceModules, path)),
        join(modules, path),
      );
    }
  }
  const pkg = join(modules, '@deepseek-ai/dsh');
  await cp(originalPackage, pkg, { recursive: true });
  return join(pkg, 'lib/bin.js');
}

export async function setupNativeWebFixture(
  installedCli: string | undefined,
  roots: string[],
  cleanup: (() => Promise<void>)[],
  prepareScope?: (
    scope: PersonVmBootstrapScope,
    lifetime: AbortController,
  ) => void,
  isolateProfile = false,
) {
  if (!installedCli) throw Error('The exact rc.2 CLI is required');
  expect(
    createHash('sha256')
      .update(await readFile(installedCli))
      .digest('hex'),
  ).toBe('80112efe368efb1a39720c7ada0af00442e5131fb2744edaaff8a3e8bb499e6f');
  const pkg = JSON.parse(
    await readFile(resolve(dirname(installedCli), '../package.json'), 'utf8'),
  );
  expect(pkg).toMatchObject({
    name: '@deepseek-ai/dsh',
    version: '0.2.1-rc.2',
  });
  const root = await mkdtemp('/tmp/ar-native-web-');
  roots.push(root);
  const cliPath = isolateProfile
    ? await isolatedCli(root, installedCli)
    : installedCli;
  const release = join(root, 'sealed-worker-profile');
  const producer = await import(
    new URL(
      '../../../../packages/dsh-web-composition/build-web-entry.mjs',
      import.meta.url,
    ).href
  );
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  await producer.prepareEmployeeWebServiceArtifact(release, head);
  const artifact = await readFile(join(release, 'artifact.json'));
  const seal = Object.freeze({
    directory: release,
    manifestSha256: createHash('sha256').update(artifact).digest('hex'),
  });
  const releaseSignal = new AbortController().signal;
  const profile = await readReleasedGuestProfile(seal, releaseSignal);
  const dshHome = join(root, 'dsh');
  await expect(access(dshHome)).rejects.toMatchObject({ code: 'ENOENT' });
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  const binding = {
    vmId: randomUUID(),
    instanceId: randomUUID(),
    personId: randomUUID(),
    organizationId: randomUUID(),
    leaseEpoch: 1,
  };
  // Test-owned endpoint facts; no production roster or authority is manufactured.
  const principalProfile = {
    workspaceId: randomUUID(),
    employeeInstanceId: randomUUID(),
    employeeRevision: 1,
    employeeVersionId: randomUUID(),
  };
  const launch = await prepareNativeWebLaunch(
    {
      origin: `http://127.0.0.1:${port}/`,
      publicUrl: `http://127.0.0.1:${port}/`,
      guestAddress: '127.0.0.1',
      guestPort: port,
      dshHome,
      agentsHome: join(root, 'agents'),
      workdir: root,
      cliPath,
      startupTimeoutMs: 10000,
      principalProfile,
    },
    binding,
    profile,
  );
  for (const file of launch.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents, { mode: file.mode });
  }
  const tracePath = join(root, 'profile-patch-reads');
  const profileDirectory = join(dshHome, 'profiles/allrice-web');
  const profilePatch = join(
    profileDirectory,
    'node_modules/@allrice/dsh-web-composition/cordis.patch.yml',
  );
  const tracer = join(root, 'trace-profile-patch.mjs');
  if (isolateProfile) {
    const appBoot = pathToFileURL(
      createRequire(cliPath).resolve('@deepseek-ai/dsh-app-boot'),
    ).href;
    const anchor = resolve(dirname(cliPath), '../package.json');
    const removed = profilePatch + '.test-hidden';
    await rename(profilePatch, removed);
    try {
      const probe = await runCommand({
        executable: process.execPath,
        args: [
          '--input-type=module',
          '-e',
          `import { loadProfileDirectory } from ${JSON.stringify(appBoot)};
           const layer = loadProfileDirectory('dsh', ...process.argv.slice(1))
             .layers.find(({ packageName }) => packageName === '@allrice/dsh-web-composition');
           process.stdout.write(JSON.stringify(layer?.patchPaths ?? []));`,
          profileDirectory,
          anchor,
        ],
        env: {
          PATH: dirname(process.execPath),
          HOME: root,
          ...launch.command.env,
        },
        signal: AbortSignal.timeout(5000),
      });
      expect(JSON.parse(probe)).toEqual([]);
    } finally {
      await rename(removed, profilePatch);
    }
    await writeFile(
      tracer,
      `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const read = fs.readFileSync;
      fs.readFileSync = function (file, ...args) {
        const value = read(file, ...args);
        if (typeof file === 'string' &&
            file.endsWith('/@allrice/dsh-web-composition/cordis.patch.yml')) {
          fs.appendFileSync(${JSON.stringify(tracePath)}, fs.realpathSync(file) + '\\n');
        }
        return value;
      };
      syncBuiltinESMExports();
    `,
    );
  }
  const startup = new AbortController(),
    lifetime = new AbortController();
  const diagnostics = new Set<string>();
  let authRead = false;
  let kills = 0,
    waitSignal: AbortSignal | undefined,
    job!: PersonVmManagedJob,
    exited!: Promise<{ exitCode: number; timedOut: boolean }>,
    child!: ReturnType<typeof spawn>;
  const scope: PersonVmBootstrapScope = {
    binding,
    signal: startup.signal,
    assertCurrent: async () => {
      if (startup.signal.aborted) throw new PersonVmError('LEASE_LOST');
    },
    async launch(command) {
      child = spawn(
        process.execPath,
        [...(isolateProfile ? ['--import', tracer] : []), ...command.args],
        {
          cwd: root,
          env: {
            PATH: dirname(process.execPath),
            HOME: root,
            ...command.env,
            DO_NOT_TRACK: '1',
            NPM_CONFIG_OFFLINE: 'true',
          },
          stdio: isolateProfile ? ['ignore', 'ignore', 'pipe'] : 'ignore',
        },
      );
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (text: string) => {
        for (const code of text.matchAll(/\bERR_[A-Z_]+\b/g))
          diagnostics.add(code[0]);
        for (const missing of text.matchAll(
          /Cannot find (?:package|module) ['"]([@\w./-]+)['"]/g,
        ))
          diagnostics.add('missing ' + missing[1]);
      });
      exited = new Promise<{ exitCode: number; timedOut: boolean }>(
        (done, reject) => {
          child.once('error', reject);
          child.once('close', (code) =>
            done({ exitCode: code ?? 137, timedOut: false }),
          );
        },
      );
      async function wait(signal: AbortSignal) {
        waitSignal ??= signal; // Observe the public managed wait's actual abort.
        signal.throwIfAborted();
        let abort!: () => void;
        try {
          return await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener('abort', abort, { once: true });
            }),
          ]);
        } finally {
          signal.removeEventListener('abort', abort);
        }
      }
      job = {
        binding,
        jobId: randomUUID(),
        wait,
        cancelAndWait: async (signal) => {
          kills++;
          child.kill('SIGKILL');
          return wait(signal);
        },
      };
      cleanup.push(async () => {
        child.kill('SIGKILL');
        await exited;
      });
      return job;
    },
    async readNativeWebAuth(request) {
      const file = nativeWebAuthArtifact(request);
      const text = await runCommand({
        executable: process.execPath,
        args: ['-e', NATIVE_WEB_AUTH_READER, file.path, String(file.maxBytes)],
        env: { PATH: dirname(process.execPath), HOME: root },
        signal: AbortSignal.any([
          startup.signal,
          AbortSignal.timeout(request.timeoutMs),
        ]),
      });
      const auth = parseNativeWebAuth(text, request);
      authRead = true;
      return auth;
    },
  };
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: binding.personId },
    organizationId: binding.organizationId,
    workspaceId: principalProfile.workspaceId,
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
  const current = vi.fn<PersonVmPort['assertCurrentBinding']>(async () => {});
  prepareScope?.(scope, lifetime);
  const owner = await openNativeWebOwner({
    scope,
    launch,
    context,
    vm: { assertCurrentBinding: current },
    lifetime: lifetime.signal,
    cleanupTimeoutMs: 5000,
  }).catch(async (error: unknown) => {
    if (!isolateProfile) throw error;
    const patchRead = await access(tracePath).then(
      () => true,
      () => false,
    );
    throw new Error(
      `Isolated CLI startup failed (auth: ${authRead}, patch: ${patchRead}, exit: ${child?.exitCode}, signals: ${[...diagnostics].join(', ')})`,
      { cause: error },
    );
  });
  let expectedCloseFailure: unknown;
  cleanup.push(async () => {
    if (expectedCloseFailure === undefined) await owner.close();
    else await expect(owner.close()).rejects.toBe(expectedCloseFailure);
  });
  return {
    owner,
    seal,
    launch,
    async observedProfilePatch() {
      return {
        expected: await realpath(profilePatch),
        actual: [
          ...new Set((await readFile(tracePath, 'utf8')).trim().split('\n')),
        ],
      };
    },
    expectCloseFailure(error: unknown) {
      expectedCloseFailure = error;
    },
    principalProfile,
    startup,
    lifetime,
    child,
    current,
    context,
    exited,
    job,
    waitSignal: () => waitSignal!,
    kills: () => kills,
  };
}
