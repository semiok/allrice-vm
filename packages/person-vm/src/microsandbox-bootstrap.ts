import type { PersonVmManagedProbeJob } from './native-command-observer.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { PersonVmError } from './contract.ts';
import {
  DSH_SANDBOX_ROOT,
  launchDshSandbox,
  prepareDshSandbox,
} from './dsh-sandbox-bootstrap.ts';
import type {
  PersonVmBootstrapScope,
  PersonVmGuestCommand,
  PersonVmJobExit,
  PersonVmManagedJob,
  PersonVmMemoryGuestPlan,
  PersonVmStartingScope,
} from './guest-bootstrap.ts';
import {
  nativeWebAuthArtifact,
  NATIVE_WEB_AUTH_READER,
  parseNativeWebAuth,
  type PersonVmNativeWebAuthRequest,
} from './native-web-auth.ts';
import { COMMAND_MEMORY_STATE_ROOT } from './readonly-artifact.ts';

const BASE_IMAGE_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const DSH_CLI = 'node_modules/@deepseek-ai/dsh/lib/bin.js';

const prepareCommandMemoryState = String.raw`
const fs = require('node:fs');
const state = process.argv[1];
function directory(path, mode) {
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== 0 || fs.realpathSync(path) !== path ||
      (mode === undefined ? (stat.mode & 0o022) !== 0 : (stat.mode & 0o777) !== mode))
    throw new Error('untrusted-command-memory-state');
}
directory('/run');
try { fs.mkdirSync(state, { mode: 0o700 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
directory(state, 0o700);
try {
  const file = fs.lstatSync(state + '/config.json');
  if (!file.isFile() || file.uid !== 0 || (file.mode & 0o777) !== 0o600 || file.nlink !== 1)
    throw new Error('untrusted-command-memory-config');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
`;

type NativeCommand = (
  args: string[],
  signal: AbortSignal,
  readNonzeroExit?: boolean,
) => Promise<string>;
function guestPath(path: string) {
  if (
    !isAbsolute(path) ||
    path === '/' ||
    path.includes('\0') ||
    posix.normalize(path) !== path
  )
    throw new PersonVmError('PROVIDER_FAILED');
}
function commandInput(command: PersonVmGuestCommand) {
  if (
    !command.executable ||
    [
      command.executable,
      ...command.args,
      ...Object.values(command.env ?? {}),
    ].some((v) => typeof v !== 'string' || v.includes('\0')) ||
    Object.keys(command.env ?? {}).some(
      (key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
    )
  )
    throw new PersonVmError('PROVIDER_FAILED');
  if (command.workdir) guestPath(command.workdir);
}

/** The existing managed-job executor, extracted for the same owner to reuse.
 * Scope must be a live operation fence, never a fabricated/expired start scope. */
export async function spawnMicrosandboxManagedProbe(
  input: {
    scope: PersonVmStartingScope;
    name: string;
    cleanupTimeoutMs: number;
    executionTimeoutSeconds?: number;
    command: NativeCommand;
  },
  commandSpec: PersonVmGuestCommand,
): Promise<PersonVmManagedProbeJob> {
  return spawnMicrosandboxJob(input, commandSpec, 'probe-operation');
}

function operationScopedProbe(
  scope: PersonVmStartingScope,
  job: PersonVmManagedProbeJob,
): PersonVmManagedProbeJob {
  async function ordinary<T>(
    signal: AbortSignal,
    operation: (running: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const running = AbortSignal.any([scope.signal, signal]);
    running.throwIfAborted();
    await scope.assertCurrent();
    running.throwIfAborted();
    const result = await operation(running);
    running.throwIfAborted();
    await scope.assertCurrent();
    running.throwIfAborted();
    return result;
  }
  return Object.freeze({
    ...job,
    wait: (signal: AbortSignal) => ordinary(signal, job.wait),
    stdout: (signal: AbortSignal) => ordinary(signal, job.stdout),
  });
}

/** One exact native exec/wait/logs/cleanup kernel. Only the probe view binds
 * ordinary reads to an operation scope; bootstrap transfers the retained job
 * to its runtime owner, whose caller signal controls the long-lived wait. */
async function spawnMicrosandboxJob(
  input: Parameters<typeof spawnMicrosandboxManagedProbe>[0],
  commandSpec: PersonVmGuestCommand,
  lifetime: 'bootstrap-retained' | 'probe-operation',
): Promise<PersonVmManagedProbeJob> {
  const { scope, name, command } = input;
  commandInput(commandSpec);
  scope.signal.throwIfAborted();
  await scope.assertCurrent();
  scope.signal.throwIfAborted();
  const args = ['exec', name, '--detach', '--no-stdin', '--no-tty'];
  if (input.executionTimeoutSeconds !== undefined) {
    if (
      !Number.isSafeInteger(input.executionTimeoutSeconds) ||
      input.executionTimeoutSeconds < 1
    )
      throw new PersonVmError('PROVIDER_FAILED');
    args.push('--timeout', `${input.executionTimeoutSeconds}s`);
  }
  for (const [key, value] of Object.entries(commandSpec.env ?? {}))
    args.push('--env', `${key}=${value}`);
  if (commandSpec.workdir) args.push('--workdir', commandSpec.workdir);
  let jobId: string;
  try {
    jobId = (
      await command(
        [...args, '--', commandSpec.executable, ...commandSpec.args],
        scope.signal,
      )
    ).trim();
  } catch (cause) {
    // Bootstrap retains its existing service-owned stop/status classification.
    // Probe dispatch without a retained ID must report owner cleanup failure.
    if (lifetime === 'bootstrap-retained') throw cause;
    throw new PersonVmError('CLEANUP_INCOMPLETE', { cause });
  }
  if (!jobId || /[\s\0]/.test(jobId))
    throw new PersonVmError(
      lifetime === 'bootstrap-retained'
        ? 'PROVIDER_FAILED'
        : 'CLEANUP_INCOMPLETE',
    );
  // Cleanup uses only its independent owner budget, even after scope loss.
  async function nativeWait(signal: AbortSignal): Promise<PersonVmJobExit> {
    signal.throwIfAborted();
    const result: unknown = JSON.parse(
      await command(
        ['wait', name, '--job', jobId, '--format', 'json'],
        signal,
        true,
      ),
    );
    if (
      !result ||
      typeof result !== 'object' ||
      !('code' in result) ||
      typeof result.code !== 'number' ||
      !Number.isInteger(result.code) ||
      !('success' in result) ||
      result.success !== (result.code === 0) ||
      !('timed_out' in result) ||
      typeof result.timed_out !== 'boolean'
    )
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    signal.throwIfAborted();
    return Object.freeze({
      exitCode: result.code,
      timedOut: result.timed_out,
    });
  }
  const job: PersonVmManagedProbeJob = Object.freeze({
    binding: scope.binding,
    jobId,
    wait: nativeWait,
    stdout: async (signal: AbortSignal) => {
      signal.throwIfAborted();
      const records = await command(
        ['logs', name, '--job', jobId, '--source', 'stdout', '--json'],
        signal,
      );
      signal.throwIfAborted();
      return records
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => {
          const entry: unknown = JSON.parse(line);
          if (
            !entry ||
            typeof entry !== 'object' ||
            !('id' in entry) ||
            entry.id !== jobId ||
            !('s' in entry) ||
            entry.s !== 'stdout' ||
            !('e' in entry) ||
            entry.e !== null ||
            !('d' in entry) ||
            typeof entry.d !== 'string'
          )
            throw new PersonVmError('PROVIDER_FAILED');
          return entry.d;
        })
        .join('');
    },
    cancelAndWait: async (signal: AbortSignal) => {
      signal.throwIfAborted();
      try {
        await command(['kill', name, '--job', jobId], signal);
      } catch {
        /* A completed job can refuse kill; only wait can certify it. */
      }
      return nativeWait(signal);
    },
  });
  try {
    scope.signal.throwIfAborted();
    await scope.assertCurrent();
    scope.signal.throwIfAborted();
  } catch (error) {
    try {
      await job.cancelAndWait(AbortSignal.timeout(input.cleanupTimeoutMs));
    } catch (cleanup) {
      if (lifetime === 'bootstrap-retained') throw cleanup;
      throw new PersonVmError('CLEANUP_INCOMPLETE', {
        cause: new AggregateError([error, cleanup]),
      });
    }
    throw error;
  }
  return lifetime === 'probe-operation'
    ? operationScopedProbe(scope, job)
    : job;
}

/** Pinned public cp/managed-job protocol. No DSH executor, shell interpolation,
 * private runtime DB, or assumption that terminating msb terminates its guest. */
export async function bootstrapMicrosandbox(input: {
  scope: PersonVmStartingScope;
  plan: PersonVmMemoryGuestPlan;
  stagingRoot: string;
  name: string;
  cleanupTimeoutMs: number;
  readonlyCommandMemoryDirectory?: string;
  dshSandbox?: Readonly<{ guestDirectory: string; sha256: string }>;
  command: NativeCommand;
}): Promise<Pick<PersonVmBootstrapScope, 'launch' | 'readNativeWebAuth'>> {
  const { scope, name, command } = input;
  const plan = structuredClone(input.plan); // Trusted configuration snapshot, not guest authority.
  const paths = new Set<string>();
  for (const file of plan.files) {
    guestPath(file.path);
    if (
      paths.has(file.path) ||
      ![0o600, 0o700].includes(file.mode) ||
      typeof file.contents !== 'string'
    )
      throw new PersonVmError('PROVIDER_FAILED');
    paths.add(file.path);
  }
  guestPath(plan.launcher);
  commandInput(plan.initialize);
  commandInput({ executable: plan.launcher, args: [], env: plan.env });
  const controls = input.readonlyCommandMemoryDirectory;
  const sandbox = input.dshSandbox;
  if (
    sandbox &&
    (!/^\/opt\/allrice\/dsh\/[a-f0-9]{64}$/.test(sandbox.guestDirectory) ||
      !/^[a-f0-9]{64}$/.test(sandbox.sha256))
  )
    throw new PersonVmError('PROVIDER_FAILED');
  if (
    plan.initialize.executable !== 'node' ||
    (controls
      ? plan.initialize.args.length !== 2 ||
        plan.initialize.args[0] !== posix.join(controls, 'initialize.cjs') ||
        plan.initialize.args[1] !==
          posix.join(COMMAND_MEMORY_STATE_ROOT, 'config.json') ||
        plan.launcher !== posix.join(controls, 'launch-dsh.sh') ||
        plan.env.BASH_ENV !== posix.join(controls, 'bash-env.sh') ||
        plan.env.ALLRICE_MEMORY_RECEIPT_WRITER !==
          posix.join(controls, 'command-observer.cjs') ||
        plan.env.ALLRICE_MEMORY_RECEIPT_DIRECTORY !==
          posix.join(COMMAND_MEMORY_STATE_ROOT, 'receipts') ||
        plan.env.ALLRICE_MEMORY_RECEIPT_NODE !== '/usr/local/bin/node' ||
        !plan.files.some(
          (file) =>
            file.path === plan.initialize.args[1] && file.mode === 0o600,
        ) ||
        plan.files.some(
          (file) =>
            file.path === controls || file.path.startsWith(controls + '/'),
        ) ||
        plan.files.some(
          (file) =>
            file.path === COMMAND_MEMORY_STATE_ROOT ||
            (file.path.startsWith(COMMAND_MEMORY_STATE_ROOT + '/') &&
              file.path !== plan.initialize.args[1]),
        )
      : !paths.has(plan.initialize.args[0]!) ||
        !plan.files.some(
          (file) => file.path === plan.launcher && file.mode === 0o700,
        ))
  )
    throw new PersonVmError('PROVIDER_FAILED');

  async function spawn(
    commandSpec: PersonVmGuestCommand,
  ): Promise<PersonVmManagedJob> {
    const job = await spawnMicrosandboxJob(
      input,
      commandSpec,
      'bootstrap-retained',
    );
    return Object.freeze({
      binding: job.binding,
      jobId: job.jobId,
      wait: job.wait,
      cancelAndWait: job.cancelAndWait,
    });
  }
  async function run(commandSpec: PersonVmGuestCommand) {
    const job = await spawn(commandSpec);
    let result: PersonVmJobExit;
    try {
      result = await job.wait(scope.signal);
    } catch (error) {
      await job.cancelAndWait(AbortSignal.timeout(input.cleanupTimeoutMs));
      throw error;
    }
    if (result.exitCode !== 0 || result.timedOut)
      throw new PersonVmError('PROVIDER_FAILED');
    await scope.assertCurrent();
  }
  await scope.assertCurrent();
  const stage = await mkdtemp(join(input.stagingRoot, 'bootstrap-'));
  try {
    if (controls)
      await run({
        executable: '/usr/local/bin/node',
        args: ['-e', prepareCommandMemoryState, COMMAND_MEMORY_STATE_ROOT],
      });
    // cp preserves Unix permissions but doesn't create missing file parents.
    await run({
      executable: '/bin/mkdir',
      args: [
        '-p',
        '--',
        ...new Set(plan.files.map((file) => dirname(file.path))),
      ],
    });
    for (const [index, file] of plan.files.entries()) {
      await scope.assertCurrent();
      const hostFile = join(stage, String(index));
      await writeFile(hostFile, file.contents, { mode: file.mode, flag: 'wx' });
      await command(
        ['cp', hostFile, `${name}:${file.path}`, '--quiet'],
        scope.signal,
      );
      await scope.assertCurrent();
    }
    await run(
      controls
        ? { ...plan.initialize, executable: '/usr/local/bin/node' }
        : plan.initialize,
    );
    if (sandbox)
      await run({
        executable: '/usr/local/bin/node',
        args: ['-e', prepareDshSandbox, sandbox.guestDirectory, sandbox.sha256],
      });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return Object.freeze({
    readNativeWebAuth: async (request: PersonVmNativeWebAuthRequest) => {
      const { path, maxBytes } = nativeWebAuthArtifact(request);
      await scope.assertCurrent();
      const text = await command(
        [
          'exec',
          name,
          '--no-stdin',
          '--no-tty',
          '--timeout',
          `${Math.ceil(request.timeoutMs / 1000)}s`,
          '--',
          'node',
          '-e',
          NATIVE_WEB_AUTH_READER,
          path,
          String(maxBytes),
        ],
        // exec accepts whole seconds; keep the host's exact millisecond budget.
        AbortSignal.any([scope.signal, AbortSignal.timeout(request.timeoutMs)]),
      );
      await scope.assertCurrent();
      return parseNativeWebAuth(text, request);
    },
    launch: async (spec: PersonVmGuestCommand) => {
      commandInput(spec);
      if (
        Object.entries(plan.env).some(
          ([key, value]) => key in (spec.env ?? {}) && spec.env![key] !== value,
        )
      )
        throw new PersonVmError('PROVIDER_FAILED');
      const env = { ...spec.env, ...plan.env };
      let argv = [spec.executable, ...spec.args];
      if (
        sandbox &&
        spec.executable === 'node' &&
        spec.args[0] === posix.join(sandbox.guestDirectory, DSH_CLI)
      ) {
        env.PATH = BASE_IMAGE_PATH;
        argv = [
          '/bin/sh',
          '-c',
          launchDshSandbox,
          'allrice-dsh',
          posix.join(DSH_SANDBOX_ROOT, sandbox.sha256) + ':' + BASE_IMAGE_PATH,
          '/usr/local/bin/node',
          ...spec.args,
        ];
      }
      return spawn({
        executable: plan.launcher,
        args: argv,
        env,
        ...(spec.workdir ? { workdir: spec.workdir } : {}),
      });
    },
  });
}
