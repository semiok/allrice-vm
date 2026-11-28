import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { PersonVmError } from './contract.ts';
import {
  DSH_SANDBOX_ROOT,
  launchDshPublicProxy,
  launchDshSandbox,
  prepareDshSandbox,
  verifyDshRuntimeDisk,
} from './dsh-sandbox-bootstrap.ts';
import type {
  PersonVmBootstrapScope,
  PersonVmGuestCommand,
  PersonVmGuestLaunchDispatch,
  PersonVmGuestBootstrapPort,
  PersonVmJobExit,
  PersonVmManagedJob,
  PersonVmMemoryGuestPlan,
  PersonVmNativeWebGuestAddress,
  PersonVmStartingScope,
} from './guest-bootstrap.ts';
import type { PersonVmManagedProbeJob } from './native-command-observer.ts';
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

// Keep the sealed initializer's public CLI and its native exit code. The
// following disk proof only reads; neither result escapes a single exact wait.
const initializeAndVerifyDisk = String.raw`
node="$1"
"$node" "$2" "$3" || exit "$?"
shift 3
exec "$node" -e "$@"
`;

const readEthernetAddresses = String.raw`
const interfaces = require('node:os').networkInterfaces();
const ipv4 = (interfaces.eth0 ?? []).filter(({ family }) => family === 'IPv4');
process.stdout.write(JSON.stringify(ipv4.map(({ address, cidr, internal }) => ({ address, cidr, internal }))));
`;

export function isMicrosandboxGuestIpv4(address: unknown): address is string {
  if (typeof address !== 'string' || !isIPv4(address)) return false;
  const parts = address.split('.');
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  const privateAddress =
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
  // MSB v0.7.16 assigns offset 2 in the sandbox's /30 to eth0 and
  // offset 1 to its gateway (network.rs: guest_bootstrap_network, derive_guest_ipv4).
  return privateAddress && Number(parts[3]) % 4 === 2;
}

function parseNativeWebGuestAddress(
  text: string,
): PersonVmNativeWebGuestAddress {
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch (cause) {
    throw new PersonVmError('PROVIDER_FAILED', { cause });
  }
  if (!Array.isArray(result) || result.length !== 1)
    throw new PersonVmError('PROVIDER_FAILED');
  const [entry]: unknown[] = result;
  if (
    !entry ||
    typeof entry !== 'object' ||
    !('address' in entry) ||
    !isMicrosandboxGuestIpv4(entry.address) ||
    !('internal' in entry) ||
    entry.internal !== false ||
    !('cidr' in entry) ||
    entry.cidr !== `${entry.address}/30`
  )
    throw new PersonVmError('PROVIDER_FAILED');
  return entry.address as PersonVmNativeWebGuestAddress;
}

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
  lifetime: 'bootstrap-retained' | 'hot-retained' | 'probe-operation',
  dispatch?: PersonVmGuestLaunchDispatch,
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
  let acknowledgedJobId: string | undefined;
  const issue = async (active: AbortSignal) => {
    active.throwIfAborted();
    let id: string;
    try {
      id = (
        await command(
          [...args, '--', commandSpec.executable, ...commandSpec.args],
          active,
        )
      ).trim();
    } catch (cause) {
      // A bootstrap failure is owned by the service's stop/status path.
      if (lifetime === 'bootstrap-retained') throw cause;
      throw new PersonVmError('CLEANUP_INCOMPLETE', { cause });
    }
    if (!id || /[\s\0]/.test(id))
      throw new PersonVmError(
        lifetime === 'bootstrap-retained'
          ? 'PROVIDER_FAILED'
          : 'CLEANUP_INCOMPLETE',
      );
    // A successful CLI close with a valid ID is independent of the SQL
    // connection's later outcome. Retain it before leaving that transaction.
    acknowledgedJobId = id;
    return id;
  };
  // Cleanup uses only its independent owner budget, even after scope loss.
  async function nativeWait(
    jobId: string,
    signal: AbortSignal,
  ): Promise<PersonVmJobExit> {
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
  async function cancelAndWait(jobId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    try {
      await command(['kill', name, '--job', jobId], signal);
    } catch {
      /* A completed job can refuse kill; only wait can certify it. */
    }
    return nativeWait(jobId, signal);
  }
  let jobId: string;
  try {
    // Only dispatch and the exact receipt are pinned to schedule authority.
    jobId = dispatch
      ? await dispatch(scope.signal, issue)
      : await issue(scope.signal);
    if (acknowledgedJobId === undefined || jobId !== acknowledgedJobId)
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    scope.signal.throwIfAborted();
    await scope.assertCurrent();
    scope.signal.throwIfAborted();
  } catch (error) {
    if (acknowledgedJobId !== undefined) {
      try {
        await cancelAndWait(
          acknowledgedJobId,
          AbortSignal.timeout(input.cleanupTimeoutMs),
        );
      } catch (cleanup) {
        throw new PersonVmError('CLEANUP_INCOMPLETE', {
          cause: new AggregateError(
            [error, cleanup],
            'Native launch cleanup failed',
            { cause: error },
          ),
        });
      }
    }
    throw error;
  }
  const job: PersonVmManagedProbeJob = Object.freeze({
    binding: scope.binding,
    jobId,
    wait: (signal: AbortSignal) => nativeWait(jobId, signal),
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
    cancelAndWait: (signal: AbortSignal) => cancelAndWait(jobId, signal),
  });
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
  dshSandbox?: Readonly<{
    guestDirectory: string;
    sha256: string;
    cliSha256?: string;
  }>;
  command: NativeCommand;
  employee?: Parameters<PersonVmGuestBootstrapPort['bootstrap']>[2];
}): Promise<
  Pick<
    PersonVmBootstrapScope,
    'launch' | 'readNativeWebGuestAddress' | 'readNativeWebAuth'
  >
> {
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
  const employee = input.employee;
  const files = employee ? structuredClone(employee.files) : plan.files;
  if (employee) {
    const prefix = '/work/.allrice/employees/' + employee.employeeInstanceId;
    const staged = new Set<string>();
    for (const file of files) {
      guestPath(file.path);
      if (
        !file.path.startsWith(prefix + '/dsh/') ||
        paths.has(file.path) ||
        staged.has(file.path) ||
        file.mode !== 0o600 ||
        typeof file.contents !== 'string'
      )
        throw new PersonVmError('PROVIDER_FAILED');
      staged.add(file.path);
    }
  }
  commandInput(plan.initialize);
  commandInput({ executable: plan.launcher, args: [], env: plan.env });
  const controls = input.readonlyCommandMemoryDirectory;
  const sandbox = input.dshSandbox;
  if (
    sandbox &&
    (!/^\/opt\/allrice\/dsh\/[a-f0-9]{64}$/.test(sandbox.guestDirectory) ||
      !/^[a-f0-9]{64}$/.test(sandbox.sha256) ||
      (sandbox.cliSha256 !== undefined &&
        (!controls ||
          !/^[a-f0-9]{64}$/.test(sandbox.cliSha256) ||
          plan.files.some(
            ({ path }) =>
              path === sandbox.guestDirectory ||
              path.startsWith(sandbox.guestDirectory + '/') ||
              sandbox.guestDirectory.startsWith(path + '/'),
          ))))
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
    dispatch?: PersonVmGuestLaunchDispatch,
  ): Promise<PersonVmManagedJob> {
    const job = await spawnMicrosandboxJob(
      input,
      commandSpec,
      employee ? 'hot-retained' : 'bootstrap-retained',
      dispatch,
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
      try {
        await job.cancelAndWait(AbortSignal.timeout(input.cleanupTimeoutMs));
      } catch (cleanup) {
        if (!employee) throw cleanup;
        throw new PersonVmError('CLEANUP_INCOMPLETE', {
          cause: new AggregateError([error, cleanup]),
        });
      }
      throw error;
    }
    if (result.exitCode !== 0 || result.timedOut)
      throw new PersonVmError('PROVIDER_FAILED');
  }
  await scope.assertCurrent();
  const stage = await mkdtemp(join(input.stagingRoot, 'bootstrap-'));
  const removeStage = () => rm(stage, { recursive: true, force: true });
  try {
    // Each step has a live fence before its side effects. That fence also
    // closes the preceding joined step. The final step has its own closing
    // fence before it can hand the launcher back to the runtime.
    const diskProof =
      !employee && sandbox?.cliSha256 !== undefined
        ? [sandbox.guestDirectory, sandbox.sha256, sandbox.cliSha256]
        : undefined;
    if (controls && !employee)
      await run({
        executable: '/usr/local/bin/node',
        args: ['-e', prepareCommandMemoryState, COMMAND_MEMORY_STATE_ROOT],
      });
    // cp preserves Unix permissions but doesn't create missing file parents.
    const parents = new Set(files.map((file) => dirname(file.path)));
    // The state job has already created and verified its own directory.
    // Other parents still require a separate current check before mkdir.
    if (diskProof) parents.delete(COMMAND_MEMORY_STATE_ROOT);
    if (parents.size)
      await run({
        executable: '/bin/mkdir',
        args: ['-p', '--', ...parents],
      });
    for (const [index, file] of files.entries()) {
      await scope.assertCurrent();
      const hostFile = join(stage, String(index));
      await writeFile(hostFile, file.contents, { mode: file.mode, flag: 'wx' });
      await command(
        ['cp', hostFile, `${name}:${file.path}`, '--quiet'],
        scope.signal,
      );
    }
    if (diskProof)
      await run({
        executable: '/bin/sh',
        args: [
          '-c',
          initializeAndVerifyDisk,
          'allrice-initialize-dsh-disk',
          '/usr/local/bin/node',
          ...plan.initialize.args,
          verifyDshRuntimeDisk,
          ...diskProof,
        ],
      });
    else if (!employee)
      await run(
        controls
          ? { ...plan.initialize, executable: '/usr/local/bin/node' }
          : plan.initialize,
      );
    if (sandbox && !employee && !diskProof)
      await run({
        executable: '/usr/local/bin/node',
        args: ['-e', prepareDshSandbox, sandbox.guestDirectory, sandbox.sha256],
      });
    await scope.assertCurrent();
  } catch (error) {
    try {
      await removeStage();
    } catch (cleanup) {
      if (error instanceof PersonVmError && error.code === 'CLEANUP_INCOMPLETE')
        throw new PersonVmError('CLEANUP_INCOMPLETE', {
          cause: new AggregateError([error, cleanup]),
        });
      throw cleanup;
    }
    throw error;
  }
  await removeStage();
  return Object.freeze({
    readNativeWebGuestAddress: async (signal = scope.signal) => {
      const active = AbortSignal.any([scope.signal, signal]);
      const job = await spawnMicrosandboxManagedProbe(
        {
          scope: { ...scope, signal: active },
          name,
          command,
          cleanupTimeoutMs: input.cleanupTimeoutMs,
        },
        {
          executable: '/usr/local/bin/node',
          args: ['-e', readEthernetAddresses],
        },
      );
      let joined = false;
      try {
        const result = await job.wait(active);
        joined = true;
        if (result.exitCode !== 0 || result.timedOut)
          throw new PersonVmError('PROVIDER_FAILED');
        return parseNativeWebGuestAddress(await job.stdout(active));
      } catch (cause) {
        if (!joined) {
          try {
            await job.cancelAndWait(
              AbortSignal.timeout(input.cleanupTimeoutMs),
            );
          } catch (cleanup) {
            throw new PersonVmError('CLEANUP_INCOMPLETE', {
              cause: new AggregateError([cause, cleanup]),
            });
          }
        }
        throw cause;
      }
    },
    readNativeWebAuth: async (
      request: PersonVmNativeWebAuthRequest,
      signal = scope.signal,
    ) => {
      const { path, maxBytes } = nativeWebAuthArtifact(request);
      // exec accepts whole seconds; keep the host's exact millisecond budget.
      const active = AbortSignal.any([
        scope.signal,
        signal,
        AbortSignal.timeout(request.timeoutMs),
      ]);
      active.throwIfAborted();
      await scope.assertCurrent();
      active.throwIfAborted();
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
        active,
      ).catch((error: unknown) => {
        if (
          !active.aborted &&
          error instanceof PersonVmError &&
          error.code === 'PROVIDER_FAILED'
        )
          throw new PersonVmError('PROVIDER_FAILED', {
            cause: 'AUTH_ARTIFACT_READ_FAILED',
          });
        throw error;
      });
      await scope.assertCurrent();
      active.throwIfAborted();
      return parseNativeWebAuth(text, request);
    },
    launch: async (
      spec: PersonVmGuestCommand,
      dispatch?: PersonVmGuestLaunchDispatch,
    ) => {
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
          (sandbox.cliSha256
            ? posix.join(sandbox.guestDirectory, 'sandbox-bin')
            : posix.join(DSH_SANDBOX_ROOT, sandbox.sha256)) +
            ':' +
            BASE_IMAGE_PATH,
          '/usr/local/bin/node',
          ...spec.args,
        ];
      }
      if (plan.env.ALLRICE_PUBLIC_PROXY_CONFIG)
        argv = [
          '/bin/sh',
          '-c',
          launchDshPublicProxy,
          'allrice-public-proxy',
          ...argv,
        ];
      return spawn(
        {
          executable: plan.launcher,
          args: argv,
          env,
          ...(spec.workdir ? { workdir: spec.workdir } : {}),
        },
        dispatch,
      );
    },
  });
}
