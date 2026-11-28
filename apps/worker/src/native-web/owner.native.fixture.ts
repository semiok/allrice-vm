import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { on, once } from 'node:events';
import { watch } from 'node:fs';
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
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { expect, vi } from 'vitest';
import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
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
import {
  dEntryNativePublicUrl,
  prepareNativeWebLaunch,
  type NativeWebLaunch,
  type NativeWebLaunchPlan,
  type NativeWebModelAdapter,
} from './launch.js';
import { openNativeWebOwner } from './owner.js';

function launchOnTestHost({
  commandWithoutHost,
  ...staged
}: NativeWebLaunchPlan): NativeWebLaunch {
  return {
    ...staged,
    command: {
      ...commandWithoutHost,
      args: [...commandWithoutHost.args, '--host', '127.0.0.1'],
    },
  };
}

async function releaseNativeStartup(
  eventsPath: string,
  releasePath: string,
  authPath: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const file = watch(eventsPath);
  const changes = on(file, 'change', { signal });
  try {
    for (;;) {
      signal.throwIfAborted();
      const events = (await readFile(eventsPath, 'utf8')).split('\n');
      if (events.includes('before-app-ready')) {
        await expect(access(authPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        if (events.includes('reader-enoent')) {
          await writeFile(releasePath, '', { flag: 'wx' });
          return;
        }
      }
      await changes.next();
    }
  } finally {
    file.close();
    await changes.return?.();
  }
}

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
  // The guest principal imports only the public packages named by its sealed
  // build receipt. In the locked pnpm tree some live in the native hoist.
  const original = createRequire(installedCli);
  const principal = JSON.parse(
    await readFile(
      createRequire(import.meta.url).resolve(
        '@allrice/d-entry-principal/artifact',
      ),
      'utf8',
    ),
  ) as { modules: { specifier: string }[] };
  const dependencies = new Set(
    principal.modules.map(({ specifier }) =>
      specifier.split('/').slice(0, 2).join('/'),
    ),
  );
  dependencies.add('@deepseek-ai/dsh-llm');
  for (const dependency of dependencies) {
    expect(dependency).toMatch(/^@deepseek-ai\/[a-z0-9-]+$/);
    const destination = join(modules, dependency);
    try {
      await access(destination);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
      await symlink(
        dirname(original.resolve(dependency + '/package.json')),
        destination,
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
  isolated?: {
    resetProbe?: boolean;
    onPublicationDiagnostic?: (text: string) => void;
    nativeToolEvidenceProbe?: string;
    nativeMemoryEnabled?: boolean;
    identity?: Omit<DEntryIdentity, 'threadId'>;
    loginSessionId?: string;
    employeeInstructions?: string;
  },
  managedModel?: NativeWebModelAdapter,
  beforePrompt?: Parameters<typeof openNativeWebOwner>[0]['beforePrompt'],
) {
  const isolateProfile = isolated !== undefined;
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
  // Give the published CLI the same private runtime package root as the
  // sealed Guest. A workspace pnpm symlink can otherwise select the builder's
  // same-name AllRice profile before the fixture's sealed profile.
  const cliPath = await isolatedCli(root, await realpath(installedCli));
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
  const toolEvidenceProbe = join(
    dshHome,
    'native-web/fixture-tool-evidence.mjs',
  );
  await expect(access(dshHome)).rejects.toMatchObject({ code: 'ENOENT' });
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  const binding = {
    vmId: randomUUID(),
    instanceId: randomUUID(),
    personId: isolated?.identity?.personId ?? randomUUID(),
    organizationId: isolated?.identity?.organizationId ?? randomUUID(),
    leaseEpoch: 1,
  };
  // Test-owned endpoint facts; no production roster or authority is manufactured.
  const principalProfile = {
    workspaceId: isolated?.identity?.workspaceId ?? randomUUID(),
    employeeInstanceId: isolated?.identity?.employeeInstanceId ?? randomUUID(),
    employeeRevision: isolated?.identity?.employeeRevision ?? 1,
    employeeVersionId: isolated?.identity?.employeeVersionId ?? randomUUID(),
  };
  const configuration = {
    origin: `http://127.0.0.1:${port}/`,
    publicUrl: dEntryNativePublicUrl(
      `http://127.0.0.1:${port}`,
      principalProfile,
    ),
    guestPort: port,
    dshHome,
    agentsHome: join(root, 'agents'),
    workdir: root,
    cliPath,
    startupTimeoutMs: 10000,
    nativeMemoryEnabled: isolated?.nativeMemoryEnabled,
    principalProfile,
    employeeInstructions: isolated?.employeeInstructions,
  };
  const launch = launchOnTestHost(
    await prepareNativeWebLaunch(
      configuration,
      binding,
      profile,
      undefined,
      managedModel,
    ),
  );
  const bootGate = join(root, 'native-startup-gate.mjs');
  const eventPrefix = join(root, 'native-startup');
  const readerTrace = join(root, 'trace-native-reader.mjs');
  async function stage(ownerLaunch: NativeWebLaunch) {
    for (const file of ownerLaunch.files) {
      await mkdir(dirname(file.path), { recursive: true });
      let contents = file.contents;
      if (
        isolateProfile &&
        file.path === join(dshHome, 'native-web/owner.patch.json')
      ) {
        const patch = JSON.parse(contents);
        patch.push({
          insert: [
            {
              id: 'fixture-native-startup-gate',
              name: pathToFileURL(bootGate).href,
            },
          ],
        });
        if (isolated.nativeToolEvidenceProbe)
          patch.push({
            insert: [
              {
                id: 'fixture-tool-evidence',
                name: pathToFileURL(toolEvidenceProbe).href,
              },
            ],
          });
        contents = JSON.stringify(patch);
      }
      await writeFile(file.path, contents, { mode: file.mode });
    }
  }
  await stage(launch);
  if (isolated?.nativeToolEvidenceProbe)
    await writeFile(toolEvidenceProbe, isolated.nativeToolEvidenceProbe, {
      mode: 0o600,
    });
  const tracePath = join(root, 'profile-patch-reads');
  const profileDirectory = join(dshHome, 'profiles/allrice-web');
  const profilePatch = join(
    profileDirectory,
    'node_modules/@allrice/dsh-web-composition/cordis.patch.yml',
  );
  const tracer = join(root, 'trace-profile-patch.mjs');
  if (isolateProfile) {
    // The extra loader entry keeps the real launcher before appReady, after
    // its actual owner entry has applied. No native profile bytes are replaced.
    await writeFile(
      bootGate,
      `
      import { appendFileSync, existsSync, watch } from 'node:fs';
      export { inject } from ${JSON.stringify(pathToFileURL(join(dshHome, 'native-web/owner.mjs')).href)};
      export async function apply(ctx) {
        const { fiber: owner } = await new Promise(resolve => {
          const find = () => {
            const entry = [...ctx.loader.entries()].find(({ options }) =>
              options.id === 'allrice-native-web-owner');
            if (!entry?.fiber) return;
            off();
            resolve({ fiber: entry.fiber });
          };
          const off = ctx.on('internal/plugin', () => queueMicrotask(find));
          find();
        });
        await owner.await();
        if (owner.state !== 2) throw Error('Real owner did not reach Cordis ACTIVE before the startup gate');
        let ready = false;
        const off = ctx.appReady.onReady(() => { ready = true; });
        try {
          if (ready) throw Error('Expected gate before launcher appReady');
          const base = ${JSON.stringify(eventPrefix)} + '.' + process.pid;
          await new Promise(resolve => {
            const stop = () => {
              changes.close();
              process.off('SIGTERM', stop);
              resolve();
            };
            const changes = watch(${JSON.stringify(root)}, () => {
              if (existsSync(base + '.release')) stop();
            });
            process.once('SIGTERM', stop);
            appendFileSync(base + '.events', 'before-app-ready\\n');
          });
          if (ready) throw Error('Launcher notified appReady while its loader was pending');
        } finally {
          off();
        }
      }
    `,
    );
    await writeFile(
      readerTrace,
      `
      import fs from 'node:fs';
      const open = fs.openSync;
      fs.openSync = function (filename, ...args) {
        if (filename !== process.argv[1]) return open(filename, ...args);
        let fd;
        try {
          fd = open(filename, ...args);
        } catch (error) {
          if (error.code === 'ENOENT') fs.appendFileSync(process.argv[3], 'reader-enoent\\n');
          throw error;
        }
        fs.appendFileSync(process.argv[3], 'reader-open\\n');
        return fd;
      };
    `,
    );
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
      import { Server } from 'node:http';
      import { syncBuiltinESMExports } from 'node:module';
      const events = ${JSON.stringify(eventPrefix)} + '.' + process.pid + '.events';
      const mark = (event) => fs.appendFileSync(events, event + '\\n');
      const emit = Server.prototype.emit;
      Server.prototype.emit = function (event, ...args) {
        const [request, socket] = args;
        if (event === 'request' && request.method === 'GET') {
          const target = new URL(request.url, 'http://fixture');
          if (target.searchParams.has('token')) {
            if (target.pathname === '/connect') mark('api-login');
            if (target.pathname === '/') mark('index-login');
          }
        }
        if (event === 'upgrade' && request.url === '/api/remote.mux' &&
            !request.headers.cookie && !request.headers.authorization) {
          mark('mux-probe');
          if (${isolated.resetProbe === true}) { socket.destroy(); return true; }
        }
        return emit.call(this, event, ...args);
      };
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
  const startupTraces = new Map<
    ReturnType<typeof spawn>,
    {
      eventsPath: string;
      releasePath: string;
      reads: number;
      receipts: number;
    }
  >();
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
            PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(
              delimiter,
            ),
            HOME: root,
            ...command.env,
            DO_NOT_TRACK: '1',
            NPM_CONFIG_OFFLINE: 'true',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
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
      if (isolated?.onPublicationDiagnostic && child.stderr) {
        const report = isolated.onPublicationDiagnostic;
        const lines = createInterface({ input: child.stderr });
        lines.on('line', (line) => {
          const visible = stripVTControlCharacters(line);
          const start = visible.indexOf('Native web auth publication failed');
          if (start < 0) return;
          const message = visible.slice(start);
          const safe =
            !visible.includes(root) &&
            /^Native web auth publication failed \[(readiness|workspace|mux|artifact)\/(FAILED|E[A-Z]+)\]$/.test(
              message,
            );
          report(safe ? message : '<invalid auth diagnostic>');
        });
      }
      exited = new Promise<{ exitCode: number; timedOut: boolean }>(
        (done, reject) => {
          child.once('error', reject);
          child.once('close', (code) =>
            done({ exitCode: code ?? 137, timedOut: false }),
          );
        },
      );
      const processHandle = child,
        processExit = exited;
      async function wait(signal: AbortSignal) {
        waitSignal ??= signal; // Observe the public managed wait's actual abort.
        signal.throwIfAborted();
        let abort!: () => void;
        try {
          return await Promise.race([
            processExit,
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
          processHandle.kill(isolateProfile ? 'SIGTERM' : 'SIGKILL');
          return wait(signal);
        },
      };
      cleanup.push(async () => {
        processHandle.kill('SIGKILL');
        await processExit;
      });
      if (isolateProfile) {
        const evidence = `${eventPrefix}.${processHandle.pid}`;
        const trace = {
          eventsPath: `${evidence}.events`,
          releasePath: `${evidence}.release`,
          reads: 0,
          receipts: 0,
        };
        await writeFile(trace.eventsPath, '', { flag: 'a' });
        startupTraces.set(processHandle, trace);
      }
      return job;
    },
    async readNativeWebAuth(request, active = startup.signal) {
      const file = nativeWebAuthArtifact(request);
      const trace = startupTraces.get(child);
      if (isolateProfile && !trace)
        throw Error('Native startup trace is unavailable');
      if (trace) trace.reads++;
      const cancelGate = new AbortController();
      const signal = AbortSignal.any([
        startup.signal,
        active,
        AbortSignal.timeout(request.timeoutMs),
        cancelGate.signal,
      ]);
      const read = runCommand({
        executable: process.execPath,
        args: [
          ...(trace ? ['--import', readerTrace] : []),
          '-e',
          NATIVE_WEB_AUTH_READER,
          file.path,
          String(file.maxBytes),
          ...(trace ? [trace.eventsPath] : []),
        ],
        env: { PATH: dirname(process.execPath), HOME: root },
        signal,
      });
      const release =
        trace &&
        releaseNativeStartup(
          trace.eventsPath,
          trace.releasePath,
          file.path,
          signal,
        );
      try {
        const [text] = await Promise.all([read, release]);
        const auth = parseNativeWebAuth(text, request);
        authRead = true;
        if (trace) trace.receipts++;
        return auth;
      } finally {
        cancelGate.abort();
        await Promise.allSettled([read, release]);
      }
    },
  };
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: isolated?.loginSessionId ?? randomUUID(),
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
    beforePrompt,
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
  async function observeNativeStartup(processHandle: ReturnType<typeof spawn>) {
    const trace = startupTraces.get(processHandle);
    if (!trace) throw Error('Native startup trace is unavailable');
    return {
      reads: trace.reads,
      receipts: trace.receipts,
      events: (await readFile(trace.eventsPath, 'utf8')).trim().split('\n'),
    };
  }
  return {
    owner,
    scope,
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
    observeNativeStartup,
    async restartRetained(
      nextModel?: NativeWebModelAdapter,
      updated?: { employeeRevision: number; employeeInstructions: string },
    ) {
      if (child.exitCode === null && child.signalCode === null)
        throw Error('The original isolated Host must stop before restart');
      const next = launchOnTestHost(
        await prepareNativeWebLaunch(
          updated
            ? {
                ...configuration,
                employeeInstructions: updated.employeeInstructions,
                principalProfile: {
                  ...principalProfile,
                  employeeRevision: updated.employeeRevision,
                },
              }
            : configuration,
          binding,
          profile,
          undefined,
          nextModel,
        ),
      );
      await stage(next);
      const restarted = await openNativeWebOwner({
        scope,
        launch: next,
        context,
        vm: { assertCurrentBinding: current },
        lifetime: new AbortController().signal,
        cleanupTimeoutMs: 5000,
      });
      cleanup.push(() => restarted.close());
      return { owner: restarted, launch: next, child, exited };
    },
    current,
    context,
    exited,
    job,
    waitSignal: () => waitSignal!,
    kills: () => kills,
  };
}
