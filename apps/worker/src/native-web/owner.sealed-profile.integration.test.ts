import { spawnSync } from 'node:child_process';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DEntryProfileGraphSchema } from '@allrice/contracts';
import { nativeWebAuthArtifact } from '@allrice/person-vm';
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

function releasedCli() {
  const install = createRequire(
    new URL(
      '../../../../packages/dsh-web-composition/package.json',
      import.meta.url,
    ),
  );
  return join(
    dirname(install.resolve('@deepseek-ai/dsh/package.json')),
    'lib/bin.js',
  );
}

function assertOneNativeLogin(startup: {
  reads: number;
  receipts: number;
  events: string[];
}) {
  expect(startup.reads).toBe(1);
  expect(startup.receipts).toBe(1);
  expect(startup.events.indexOf('reader-enoent')).toBeGreaterThanOrEqual(0);
  expect(startup.events.indexOf('reader-enoent')).toBeLessThan(
    startup.events.indexOf('mux-probe'),
  );
  expect(startup.events.filter((event) => event !== 'reader-enoent')).toEqual([
    'before-app-ready',
    'mux-probe',
    'reader-open',
    'api-login',
    'index-login',
  ]);
}

it(
  'boots the Worker-sealed AllRice web profile in an initially absent employee DSH_HOME',
  {
    timeout: 30_000,
  },
  async () => {
    const f = await setupNativeWebFixture(
      releasedCli(),
      roots,
      cleanup,
      undefined,
      {},
    );
    const active = new AbortController().signal;
    const command = f.launch.command;
    expect(command.args.slice(1, 3)).toEqual(['--profile', 'allrice-web']);
    const urlIndex = command.args.indexOf('--public-url') + 1;
    const origin = new URL(f.launch.auth.origin).origin;
    const { workspaceId, employeeInstanceId } = f.principalProfile;
    const advertised = `${origin}/chatflow/4.0/${workspaceId}/${employeeInstanceId}/`;
    expect(command.args[urlIndex]).toBe(advertised);
    const patchPath = command.args[command.args.indexOf('--patch') + 1]!;
    const entries = JSON.parse(await readFile(patchPath, 'utf8'));
    expect(entries[0]).toMatchObject({
      id: 'web-runtime',
      config: { publicUrl: advertised },
    });
    expect(f.owner.controlReady()).toBe(true);
    expect((await f.owner.readSessions(active)).ok).toBe(true);
    const revoked = Error('fixture revoked catalogue caller');
    await expect(
      f.owner.readScheduleCatalog(async () => {
        throw revoked;
      }, active),
    ).rejects.toBe(revoked);
    const guard = (signal: AbortSignal) =>
      f.current(f.context, f.launch.binding, signal);
    await expect(f.owner.readScheduleCatalog(guard, active)).resolves.toEqual(
      [],
    );
    await expect(f.owner.readNativeActivity(guard, active)).resolves.toEqual({
      work: new Set(),
      complete: true,
    });
    await f.owner.createRootFor(f.context, {}, active);
    await expect(f.owner.readNativeActivity(guard, active)).resolves.toEqual({
      work: new Set(),
      complete: true,
    });
    assertOneNativeLogin(await f.observeNativeStartup(f.child));
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
    const pickerIds = (entries: string[]) =>
      entries.filter((id) =>
        id.startsWith('@deepseek-ai/dsh-client-ui-directory-picker-'),
      );
    expect(pickerIds(ids)).toEqual([
      '@deepseek-ai/dsh-client-ui-directory-picker-browse',
    ]);
    expect(pickerIds(sealedIds)).toEqual(pickerIds(ids));
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
    const firstNonce = nativeWebAuthArtifact(f.launch.auth).path;
    await access(firstNonce);
    await f.owner.close();
    expect(await f.exited).toEqual({ exitCode: 0, timedOut: false });
    await expect(access(firstNonce)).rejects.toMatchObject({ code: 'ENOENT' });
    const second = await f.restartRetained();
    expect(second.launch.auth.dshHome).toBe(f.launch.auth.dshHome);
    expect(second.launch.auth.nonce).not.toBe(f.launch.auth.nonce);
    expect(second.child.pid).not.toBe(f.child.pid);
    expect(second.owner.controlReady()).toBe(true);
    expect((await second.owner.readSessions(active)).ok).toBe(true);
    await expect(
      second.owner.readScheduleCatalog(guard, active),
    ).resolves.toEqual([]);
    assertOneNativeLogin(await f.observeNativeStartup(second.child));
    const secondNonce = nativeWebAuthArtifact(second.launch.auth).path;
    await access(secondNonce);
    await second.owner.close();
    expect(await second.exited).toEqual({ exitCode: 0, timedOut: false });
    await expect(access(secondNonce)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.kills()).toBe(2);

    const rejectedArgs = [...command.args];
    rejectedArgs[urlIndex] =
      `${origin}/chatflow/4.0?${new URLSearchParams({ workspaceId, employeeInstanceId })}`;
    const rejected = spawnSync(process.execPath, rejectedArgs, {
      cwd: command.workdir,
      env: {
        PATH: dirname(process.execPath),
        HOME: command.workdir,
        ...command.env,
        DO_NOT_TRACK: '1',
        NPM_CONFIG_OFFLINE: 'true',
      },
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    expect(rejected.error).toBeUndefined();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      '--public-url must not include a query or fragment (? or #)',
    );

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
  },
);

it(
  'runs native bash without prompting after loading a persisted ask policy',
  { timeout: 45_000 },
  async () => {
    const f = await setupNativeWebFixture(
      releasedCli(),
      roots,
      cleanup,
      undefined,
      {
        nativeToolEvidenceProbe: `
          import { randomUUID } from 'node:crypto';
          import { mkdir, writeFile } from 'node:fs/promises';
          import { resolve } from 'node:path';
          import { fileURLToPath } from 'node:url';

          export const inject = ['agents', 'agentPresets', 'sessions', 'permissionPresets',
            'sandboxPolicy', 'approval', 'appReady'];
          export function apply(ctx) {
            const root = fileURLToPath(new URL('../../', import.meta.url));
            const workspace = resolve(root, 'workspace');
            const outside = resolve(root, 'outside');
            const receipt = resolve(root, 'permissions.json');
            let prompts = 0;
            ctx.on('approval/request', () => { prompts++; return 'rejected'; });
            const effective = session => ({
              mode: ctx.sandboxPolicy.resolve({ session }).mode,
              approval: ctx.approval.effectivePolicy(session),
            });
            const take = (session, kind) =>
              Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq))
                .filter(event => event?.type === kind)
                .map(event => event.data);
            async function prove() {
              await mkdir(workspace);
              await writeFile(outside, 'unchanged');
              const id = randomUUID();
              const { id: preset } = await ctx.agentPresets.resolve();
              const setup = async agentCtx => {
                await ctx.agentPresets.mount(agentCtx, preset);
              };
              const fresh = await ctx.agents.create({
                sessionId: id, meta: { cwd: workspace, agentPreset: preset }, setup,
              });
              const initial = effective(fresh.agent.session);
              fresh.agent.session.append('approval/policy', { policy: 'ask' });
              if (!await ctx.sessions.flush(fresh.agent.session))
                throw Error('Missing native session persistence');
              await fresh.dispose();
              const resumed = await ctx.agents.resume({ resumeSessionId: id, setup });
              try {
                const agent = resumed.agent;
                const session = agent.session;
                const restored = effective(session);
                const invoke = args => agent.ctx.tools.execute({
                  name: 'bash', arguments: { description: 'Check managed workspace permissions', ...args }, agent,
                  callId: randomUUID(), signal: AbortSignal.timeout(10_000),
                });
                session.append('turn/start', { turn: 1 });
                const normal = await invoke({ command: "printf '%s' ok > inside" });
                const normalAsks = take(session, 'approval/asked').length;
                const outsideWrite = await invoke({
                  command: "printf '%s' forbidden > '" + outside + "'",
                });
                const escalated = await invoke({
                  command: "printf '%s' forbidden > '" + outside + "'",
                  sandbox_permissions: 'danger-full-access',
                  justification: 'Exercise the isolated rejection path.',
                });
                session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
                return {
                  initial, restored, normalAsks, prompts,
                  options: ctx.permissionPresets.catalog().options.map(o => o.value),
                  history: take(session, 'approval/policy').map(event => event.policy),
                  decisions: take(session, 'approval/decided').map(event => event.outcome),
                  normal: normal.isError ? normal.error : {
                    exitCode: normal.value.exitCode, sandbox: normal.value.sandbox,
                  },
                  outsideWrite: outsideWrite.isError ? outsideWrite.error : {
                    exitCode: outsideWrite.value.exitCode, sandbox: outsideWrite.value.sandbox,
                  },
                  escalated: escalated.isError,
                };
              } finally {
                await resumed.dispose();
              }
            }
            ctx.appReady.onReady(() => {
              void prove().then(
                result => writeFile(receipt, JSON.stringify(result)),
                error => writeFile(receipt, JSON.stringify({ error: error.stack ?? String(error) })),
              );
            });
          }
        `,
      },
    );
    const root = f.launch.command.workdir;
    const read = (path: string) => readFile(join(root, path), 'utf8');
    const receipt = await vi.waitFor(
      async () => JSON.parse(await read('permissions.json')),
      { timeout: 15_000 },
    );
    expect(receipt).toEqual({
      initial: { mode: 'workspace-write', approval: 'never' },
      restored: { mode: 'workspace-write', approval: 'never' },
      options: ['read-only', 'workspace-write'],
      history: ['never', 'ask', 'never'],
      normalAsks: 0,
      prompts: 0,
      decisions: ['rejected'],
      normal: {
        exitCode: 0,
        sandbox: expect.objectContaining({
          mode: 'workspace-write',
          denied: false,
        }),
      },
      outsideWrite: {
        exitCode: expect.any(Number),
        sandbox: expect.objectContaining({ mode: 'workspace-write' }),
      },
      escalated: true,
    });
    expect(receipt.outsideWrite.exitCode).not.toBe(0);
    expect(await read('workspace/inside')).toBe('ok');
    expect(await read('outside')).toBe('unchanged');
  },
);

it(
  'reports exactly one safe native mux startup diagnostic through the released DSH CLI',
  { timeout: 30_000 },
  async () => {
    const diagnostics: string[] = [];
    await expect(
      setupNativeWebFixture(releasedCli(), roots, cleanup, undefined, {
        resetProbe: true,
        onPublicationDiagnostic: (message) => diagnostics.push(message),
      }),
    ).rejects.toMatchObject({ cause: { code: 'PROVIDER_FAILED' } });
    expect(diagnostics).toEqual([
      'Native web auth publication failed [mux/ECONNRESET]',
    ]);
  },
);
