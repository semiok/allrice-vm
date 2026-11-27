import { constants } from 'node:fs';
import {
  lstat,
  open,
  readlink,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  PersonVmError,
  PERSON_VM_MEMORY_MIB,
  type PersonVmBinding,
  type PersonVmEgressReceipt,
} from './contract.ts';
import type { PersonVmIdleStopDispatch } from './admission-contract.ts';
import { privateDirectory } from './encrypted-disk.ts';
import {
  checkedPublicImageCache,
  seedPublicImageCache,
  verifySeededPublicImageCache,
  type PublicImageCache,
} from './image-cache.ts';
import { hostEnvironment, runCommand, type CommandRunner } from './process.ts';
import {
  bootstrapMicrosandbox,
  spawnMicrosandboxManagedProbe,
} from './microsandbox-bootstrap.ts';
import {
  createPersonVmCommandMemoryObserver,
  type PersonVmManagedProbePort,
} from './native-command-observer.ts';
import { createPersonVmGuestMemoryReader } from './native-resource.ts';
import {
  assertReadonlyArtifactInspection,
  checkedReadonlyCommandMemoryDirectory,
  checkedReadonlyDshDirectory,
  checkedReadonlyDshRuntimeDisk,
  createReadonlyDshDiskVerifier,
  readonlyArtifactReference,
  selectedReadonlyRuntimeDisk,
  verifyReadonlyCommandMemoryDirectory,
  verifyReadonlyDshDirectory,
  type ReadonlyCommandMemoryDirectory,
  type ReadonlyDshDirectory,
  type ReadonlyDshRuntimeDisk,
} from './readonly-artifact.ts';
import type {
  PersonVmGuestBootstrapPort,
  PersonVmGuestCommand,
  PersonVmMemoryGuestPlan,
  PersonVmStartingScope,
} from './guest-bootstrap.ts';
import {
  assertWebEndpointInspection,
  assertPreparedWebEndpoints,
  prepareWebEndpoints,
  type PersonVmWebEndpointReceipt,
  type PersonVmWebRoster,
} from './web-endpoints.ts';

// v0.7.16 client/ipc.rs uses 12 SHA-256 bytes (24 hex chars) for the
// canonical directory; Darwin sys/un.h has sun_path[104], including NUL.
const CANONICAL_SOCKET_HASH_BYTES = 12;
const DARWIN_SOCKET_PATH_CAPACITY = 104;
const VM_ID_PATH_BYTES = 36; // Host-generated canonical UUID, kept in full.
const GUEST_WORK_DIRECTORY = '/work';
type NativePaths = { home: string; config: string; userHome: string };
type RestartMemoryRequest = Readonly<{
  binding: PersonVmBinding;
  memoryMiB: number;
}>;
type RestartMemoryReservation = Readonly<{
  signal: AbortSignal;
  assertCurrent(
    request: RestartMemoryRequest,
    signal: AbortSignal,
  ): Promise<void>;
  /** The capacity owner atomically rejects a revoked reservation or converts
   * it into a running charge for this exact binding. A committed charge
   * survives reservation expiry and cancellation until physical release. */
  commitRunning(
    request: RestartMemoryRequest,
    signal: AbortSignal,
  ): Promise<void>;
}>;
type NativeStartFence = Readonly<{
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
  commitRunning(): Promise<void>;
}>;
type NativeMemoryInspection = {
  name?: unknown;
  status?: unknown;
  config?: unknown;
  active_config?: unknown;
};

function matchesNativeMemory(config: unknown, memoryMiB: number) {
  const { memory_mib: memory, max_memory_mib: max } =
    (
      config as {
        resources?: { memory_mib?: unknown; max_memory_mib?: unknown };
      } | null
    )?.resources ?? {};
  if (
    typeof memory !== 'number' ||
    typeof max !== 'number' ||
    !Number.isInteger(memory) ||
    !Number.isInteger(max) ||
    memory <= 0 ||
    memory > max ||
    max > 0xffffffff
  )
    throw new PersonVmError('PROVIDER_FAILED');
  return memory === memoryMiB && max === memoryMiB;
}

function assertSocketHome(home: string) {
  const controlSocket = join(
    home,
    'run',
    'sandboxes',
    '0'.repeat(CANONICAL_SOCKET_HASH_BYTES * 2),
    'control.sock',
  );
  if (Buffer.byteLength(controlSocket) >= DARWIN_SOCKET_PATH_CAPACITY)
    throw new PersonVmError('PROVIDER_FAILED');
}

export interface PersonVmNativePort extends PersonVmGuestBootstrapPort {
  prepare(
    binding: PersonVmBinding,
    mount: string,
    signal: AbortSignal,
  ): Promise<void>;
  status(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<'absent' | 'stopped' | 'running' | 'unknown'>;
  readAttachedStatus?(
    binding: PersonVmBinding,
    mount: string,
    signal: AbortSignal,
  ): ReturnType<PersonVmNativePort['status']>;
  create(
    binding: PersonVmBinding,
    receipt: PersonVmEgressReceipt,
    signal: AbortSignal,
    web?: PersonVmWebEndpointReceipt,
  ): Promise<void>;
  prepareWebEndpoints?(
    binding: PersonVmBinding,
    roster: PersonVmWebRoster,
    signal: AbortSignal,
    options?: { runningOnly: true },
  ): Promise<PersonVmWebEndpointReceipt>;
  assertWebEndpoints?(
    receipt: PersonVmWebEndpointReceipt,
    signal: AbortSignal,
  ): Promise<void>;
  /** Guest cgroup controls only, not MSB physical RAM evidence. */
  memoryGuestReader?(
    scope: PersonVmStartingScope,
    configuration: Omit<
      Parameters<typeof createPersonVmGuestMemoryReader>[0],
      'binding' | 'probes' | 'cleanupSignal'
    >,
  ): ReturnType<typeof createPersonVmGuestMemoryReader>;
  memoryCommandObserver?(
    scope: PersonVmStartingScope,
    configuration: Omit<
      Parameters<typeof createPersonVmCommandMemoryObserver>[0],
      'binding' | 'probes' | 'native' | 'cleanupSignal'
    >,
  ): ReturnType<typeof createPersonVmCommandMemoryObserver>;
  start(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<NativeStartFence | void>;
  /** Optional retained-start operation. It must verify both the artifact and
   * Web endpoints against the same fresh, post-start native inspection. */
  startWithWebEndpoints?(
    receipt: PersonVmWebEndpointReceipt,
    signal: AbortSignal,
  ): Promise<NativeStartFence | void>;
  stop(
    binding: PersonVmBinding,
    signal: AbortSignal,
    options?: Readonly<{ requireStopped: true }>,
  ): Promise<void>;
  /** Optional Host-only retirement operations. */
  stopIdle?(
    binding: PersonVmBinding,
    signal: AbortSignal,
    assertCurrent: () => Promise<void>,
    dispatch?: PersonVmIdleStopDispatch,
  ): Promise<void>;
  assertStopped?(binding: PersonVmBinding, signal: AbortSignal): Promise<void>;
  releaseDiskHome?(
    vmId: string,
    mount: string,
    signal: AbortSignal,
  ): Promise<void>;
  ping(binding: PersonVmBinding, signal: AbortSignal): Promise<void>;
}

/** Uses only the pinned public CLI. Does not edit Microsandbox's private DB. */
export class MicrosandboxPersonVm implements PersonVmNativePort {
  private readonly run: CommandRunner;
  private readonly memoryMiB: number;
  private readonly homes = new Map<string, NativePaths>();
  private readonly verifyRuntimeDisk = createReadonlyDshDiskVerifier();
  constructor(
    private readonly options: {
      binary: string;
      libkrunfw: string;
      agentd: string;
      image: string;
      readonlyDshDirectory?: ReadonlyDshDirectory;
      readonlyDshRuntimeDisk?: ReadonlyDshRuntimeDisk;
      readonlyCommandMemoryDirectory?: ReadonlyCommandMemoryDirectory;
      publicImageCache?: PublicImageCache;
      seededPublicCache?(vmId: string, signal: AbortSignal): Promise<boolean>;
      refreshBoundPublicCache?(
        binding: PersonVmBinding,
        mount: string,
        signal: AbortSignal,
        resumeOnly?: boolean,
      ): Promise<boolean>;
      rootDiskGiB: number;
      socketRoot: string;
      /** Host-only platform configuration snapshot, never guest/request input. */
      memoryMiB?: number;
      /** Reserve against the physical binding. The capacity owner must keep
       * charging until it can confirm that binding is stopped or absent,
       * even if the signal aborts or the native start fails without an ACK. */
      restartMemory?: Readonly<{
        memoryMiB: number;
        reserve?(
          request: RestartMemoryRequest,
          signal: AbortSignal,
        ): Promise<RestartMemoryReservation>;
      }>;
      runner?: CommandRunner;
      jobCleanupTimeoutMs?: number;
    },
  ) {
    this.options = {
      ...options,
      ...(options.restartMemory
        ? { restartMemory: Object.freeze({ ...options.restartMemory }) }
        : {}),
      ...(options.readonlyDshDirectory
        ? {
            readonlyDshDirectory: checkedReadonlyDshDirectory(
              options.readonlyDshDirectory,
            ),
          }
        : {}),
      ...(options.readonlyDshRuntimeDisk
        ? {
            readonlyDshRuntimeDisk: checkedReadonlyDshRuntimeDisk(
              options.readonlyDshRuntimeDisk,
            ),
          }
        : {}),
      ...(options.readonlyCommandMemoryDirectory
        ? {
            readonlyCommandMemoryDirectory:
              checkedReadonlyCommandMemoryDirectory(
                options.readonlyCommandMemoryDirectory,
              ),
          }
        : {}),
      ...(options.publicImageCache
        ? {
            publicImageCache: checkedPublicImageCache(
              options.publicImageCache,
              options.image,
            ),
          }
        : {}),
    };
    this.run = options.runner ?? runCommand;
    this.memoryMiB =
      options.memoryMiB === undefined
        ? PERSON_VM_MEMORY_MIB
        : options.memoryMiB;
    if (
      ![
        options.binary,
        options.libkrunfw,
        options.agentd,
        options.socketRoot,
      ].every(isAbsolute) ||
      !/^.+@sha256:[a-f0-9]{64}$/.test(options.image) ||
      (options.readonlyCommandMemoryDirectory &&
        !options.readonlyDshDirectory) ||
      (options.readonlyDshRuntimeDisk &&
        !options.readonlyCommandMemoryDirectory) ||
      !Number.isSafeInteger(this.memoryMiB) ||
      this.memoryMiB <= 0 ||
      !Number.isSafeInteger(this.memoryMiB * 1024 ** 2) ||
      !Number.isInteger(options.rootDiskGiB) ||
      options.rootDiskGiB <= 0 ||
      !Number.isFinite(options.jobCleanupTimeoutMs ?? 10000) ||
      (options.jobCleanupTimeoutMs ?? 10000) <= 0
    )
      throw new PersonVmError('PROVIDER_FAILED');
    assertSocketHome(
      join(this.options.socketRoot, '0'.repeat(VM_ID_PATH_BYTES)),
    );
  }
  private name(binding: PersonVmBinding) {
    return `allrice-${binding.vmId}`;
  }
  private async command(
    binding: PersonVmBinding,
    args: string[],
    signal: AbortSignal,
    readNonzeroExit = false,
  ) {
    const paths = this.homes.get(binding.vmId);
    if (!paths) throw new PersonVmError('PROVIDER_FAILED');
    return this.runWithPaths(paths, args, signal, readNonzeroExit);
  }
  private runWithPaths(
    paths: NativePaths,
    args: string[],
    signal: AbortSignal,
    readNonzeroExit = false,
  ) {
    if (args[0] === 'exec') {
      const separator = args.indexOf('--', 2);
      if (separator !== -1 && !args.slice(2, separator).includes('--workdir')) {
        args = [
          ...args.slice(0, separator),
          '--workdir',
          GUEST_WORK_DIRECTORY,
          ...args.slice(separator),
        ];
      }
    }
    return this.run({
      executable: this.options.binary,
      args,
      signal,
      readNonzeroExit,
      env: {
        ...hostEnvironment(paths.userHome),
        MSB_HOME: paths.home,
        MSB_CONFIG_PATH: paths.config,
      },
    });
  }
  /** Requires a live operation fence; never retain an expired startup scope. */
  private managedMemoryProbes(
    scope: PersonVmStartingScope,
    cleanupTimeoutMs: number,
  ): PersonVmManagedProbePort {
    const binding = Object.freeze({ ...scope.binding });
    return {
      launch: (spec, signal) =>
        spawnMicrosandboxManagedProbe(
          {
            scope: {
              ...scope,
              binding,
              signal: AbortSignal.any([scope.signal, signal]),
            },
            name: this.name(binding),
            cleanupTimeoutMs,
            command: (args, running, nonzero) =>
              this.command(binding, args, running, nonzero),
          },
          spec,
        ),
    };
  }
  memoryGuestReader(
    scope: PersonVmStartingScope,
    configuration: Omit<
      Parameters<typeof createPersonVmGuestMemoryReader>[0],
      'binding' | 'probes' | 'cleanupSignal'
    >,
  ): ReturnType<typeof createPersonVmGuestMemoryReader> {
    const cleanupTimeoutMs = this.options.jobCleanupTimeoutMs;
    if (cleanupTimeoutMs === undefined)
      throw new PersonVmError('PROVIDER_FAILED');
    return createPersonVmGuestMemoryReader({
      ...configuration,
      binding: Object.freeze({ ...scope.binding }),
      probes: this.managedMemoryProbes(scope, cleanupTimeoutMs),
      cleanupSignal: () => AbortSignal.timeout(cleanupTimeoutMs),
    });
  }
  memoryCommandObserver(
    scope: PersonVmStartingScope,
    configuration: Omit<
      Parameters<typeof createPersonVmCommandMemoryObserver>[0],
      'binding' | 'probes' | 'native' | 'cleanupSignal'
    >,
  ): ReturnType<typeof createPersonVmCommandMemoryObserver> {
    const cleanupTimeoutMs = this.options.jobCleanupTimeoutMs;
    if (cleanupTimeoutMs === undefined)
      throw new PersonVmError('PROVIDER_FAILED');
    const binding = Object.freeze({ ...scope.binding });
    const observer = createPersonVmCommandMemoryObserver({
      ...configuration,
      binding,
      probes: this.managedMemoryProbes(scope, cleanupTimeoutMs),
      native: {
        name: this.name(binding),
        command: async (args, signal, nonzero) => {
          const running = AbortSignal.any([scope.signal, signal]);
          running.throwIfAborted();
          await scope.assertCurrent();
          running.throwIfAborted();
          const result = await this.command(binding, args, running, nonzero);
          running.throwIfAborted();
          await scope.assertCurrent();
          running.throwIfAborted();
          return result;
        },
      },
      cleanupSignal: () => AbortSignal.timeout(cleanupTimeoutMs),
    });
    return {
      observeCompletion: async (bindingInput, execution, signal) => {
        const running = AbortSignal.any([scope.signal, signal]);
        running.throwIfAborted();
        await scope.assertCurrent();
        running.throwIfAborted();
        const result = await observer.observeCompletion(
          bindingInput,
          execution,
          running,
        );
        running.throwIfAborted();
        await scope.assertCurrent();
        running.throwIfAborted();
        return result;
      },
    };
  }
  private async artifact(
    binding: PersonVmBinding,
    signal: AbortSignal,
    create = false,
    home = this.homes.get(binding.vmId)?.home,
  ) {
    const c = this.options.readonlyDshDirectory;
    if (!c) return;
    if (!home) throw new PersonVmError('PROVIDER_FAILED');
    const selectedDisk = await selectedReadonlyRuntimeDisk(
      home,
      this.options.readonlyDshRuntimeDisk,
      create,
      signal,
    );
    const replaceAbsentDisk =
      create && selectedDisk?.provision === 'directory'
        ? selectedDisk
        : undefined;
    const disk = replaceAbsentDisk ? undefined : selectedDisk;
    const artifact = disk
      ? await this.verifyRuntimeDisk(disk, c, this.options.image, signal)
      : {
          ...(await verifyReadonlyDshDirectory(c, this.options.image, signal)),
          cliSha256: undefined,
        };
    const controls = this.options.readonlyCommandMemoryDirectory;
    if (controls) await verifyReadonlyCommandMemoryDirectory(controls, signal);
    await readonlyArtifactReference(
      home,
      binding,
      c,
      create,
      signal,
      artifact.descriptorSha256,
      controls,
      disk,
      replaceAbsentDisk,
    );
    return { ...artifact, disk };
  }
  private async assertArtifact(
    binding: PersonVmBinding,
    signal: AbortSignal,
    running = true,
    web?: PersonVmWebEndpointReceipt,
  ) {
    if (!this.options.readonlyDshDirectory && !web) return;
    const [artifact] = await this.inspectAndAssertArtifact(
      binding,
      signal,
      running,
      web,
    );
    return artifact;
  }
  private async inspectAndAssertArtifact(
    binding: PersonVmBinding,
    signal: AbortSignal,
    running: boolean,
    web?: PersonVmWebEndpointReceipt,
  ) {
    const c = this.options.readonlyDshDirectory;
    const [artifact, inspection] = await this.inspectWithArtifact(
      binding,
      signal,
    );
    if (artifact.status === 'rejected') throw artifact.reason;
    if (inspection.status === 'rejected') throw inspection.reason;
    signal.throwIfAborted();
    if (c)
      assertReadonlyArtifactInspection(
        inspection.value,
        this.name(binding),
        c,
        running,
        this.options.readonlyCommandMemoryDirectory,
        artifact.value?.disk,
      );
    if (web)
      assertWebEndpointInspection(
        inspection.value,
        this.name(binding),
        web,
        true,
      );
    return [artifact.value, inspection.value] as const;
  }
  private inspectWithArtifact(binding: PersonVmBinding, signal: AbortSignal) {
    // Both reads can overlap under the same owner. Join the native CLI even
    // when the sealed reference fails before the caller can touch the VM.
    return Promise.allSettled([
      this.artifact(binding, signal),
      this.command(
        binding,
        ['inspect', this.name(binding), '--format', 'json'],
        signal,
      ).then((output): unknown => JSON.parse(output)),
    ]);
  }
  private configurationBytes(home: string, target: string) {
    return JSON.stringify({
      version: 1,
      home,
      allowed_backends: ['local'],
      paths: {
        msb: this.options.binary,
        libkrunfw: this.options.libkrunfw,
        agentd: this.options.agentd,
        ...Object.fromEntries(
          ['cache', 'sandboxes', 'volumes', 'snapshots', 'logs', 'secrets'].map(
            (name) => [name, join(name === 'sandboxes' ? target : home, name)],
          ),
        ),
      },
      sandbox_defaults: {
        cpus: 2,
        memory_mib: this.memoryMiB,
        oci: {
          root_disk: {
            kind: 'flat',
            size_mib: this.options.rootDiskGiB * 1024,
            clone: 'auto',
          },
        },
      },
    });
  }
  async prepare(binding: PersonVmBinding, mount: string, signal: AbortSignal) {
    const home = join(this.options.socketRoot, binding.vmId);
    assertSocketHome(home);
    await privateDirectory(this.options.socketRoot);
    const target = join(mount, 'microsandbox');
    await privateDirectory(target);
    // Rejoin an elected cache cutover before the CLI can open its cache path.
    await this.options.refreshBoundPublicCache?.(binding, mount, signal, true);
    const userHome = join(mount, 'host-home');
    await privateDirectory(userHome);
    try {
      const stat = await lstat(home);
      if (!stat.isSymbolicLink() || (await readlink(home)) !== target)
        throw new PersonVmError('PROVIDER_FAILED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await symlink(target, home, 'dir');
    }
    const config = join(mount, 'msb-config.json');
    await writeFile(config, this.configurationBytes(home, target), {
      mode: 0o600,
    });
    this.homes.set(binding.vmId, { home, config, userHome });
    const version = await this.command(binding, ['--version'], signal);
    if (!/\b0\.7\.16\b/.test(version))
      throw new PersonVmError('PROVIDER_FAILED');
  }
  /** Read the verified attached disk without changing the saved CLI config. */
  private async readAttachedPaths(
    binding: PersonVmBinding,
    mount: string,
    signal: AbortSignal,
  ) {
    const home = join(this.options.socketRoot, binding.vmId);
    const target = join(mount, 'microsandbox');
    const paths = {
      home,
      userHome: join(mount, 'host-home'),
      config: join(mount, 'msb-config.json'),
    };
    assertSocketHome(home);
    signal.throwIfAborted();
    for (const directory of [this.options.socketRoot, target, paths.userHome]) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700)
        throw new PersonVmError('PROVIDER_FAILED');
    }
    if (
      !(await lstat(home)).isSymbolicLink() ||
      (await readlink(home)) !== target
    )
      throw new PersonVmError('PROVIDER_FAILED');
    const config = await open(
      paths.config,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const expected = this.configurationBytes(home, target);
      const stat = await config.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size !== Buffer.byteLength(expected) ||
        (await config.readFile('utf8')) !== expected
      )
        throw new PersonVmError('PROVIDER_FAILED');
    } finally {
      await config.close();
    }
    signal.throwIfAborted();
    return paths;
  }
  async readAttachedStatus(
    binding: PersonVmBinding,
    mount: string,
    signal: AbortSignal,
  ) {
    const paths = await this.readAttachedPaths(binding, mount, signal);
    const output = await this.runWithPaths(
      paths,
      ['list', '--format', 'json'],
      signal,
    );
    return this.lifecycleState(this.parseStatus(binding, output));
  }
  /** Fixed Host-authored read inside an independently verified physical lease. */
  async readAttachedProbe(
    scope: PersonVmStartingScope,
    mount: string,
    commandSpec: PersonVmGuestCommand,
  ) {
    const { binding, signal } = scope;
    await scope.assertCurrent();
    const paths = await this.readAttachedPaths(binding, mount, signal);
    const directory = this.options.readonlyDshDirectory;
    const artifact = await this.artifact(binding, signal, false, paths.home);
    if (!directory || !artifact) throw new PersonVmError('PROVIDER_FAILED');
    const command = (args: string[], active: AbortSignal, nonzero?: boolean) =>
      this.runWithPaths(paths, args, active, nonzero);
    const name = this.name(binding);
    if (!/\b0\.7\.16\b/.test(await command(['--version'], signal)))
      throw new PersonVmError('PROVIDER_FAILED');
    const inspect = JSON.parse(
      await command(['inspect', name, '--format', 'json'], signal),
    );
    assertReadonlyArtifactInspection(
      inspect,
      name,
      directory,
      true,
      this.options.readonlyCommandMemoryDirectory,
      artifact.disk,
    );
    const cleanupTimeoutMs = this.options.jobCleanupTimeoutMs ?? 10_000;
    const job = await spawnMicrosandboxManagedProbe(
      { scope, name, cleanupTimeoutMs, executionTimeoutSeconds: 10, command },
      commandSpec,
    );
    let ended = false;
    try {
      const result = await job.wait(signal);
      ended = true;
      if (result.exitCode || result.timedOut)
        throw new PersonVmError('PROVIDER_FAILED');
      return await job.stdout(signal);
    } catch (error) {
      if (!ended) {
        try {
          await job.cancelAndWait(AbortSignal.timeout(cleanupTimeoutMs));
        } catch (cleanup) {
          throw new PersonVmError('CLEANUP_INCOMPLETE', {
            cause: new AggregateError([error, cleanup]),
          });
        }
      }
      throw error;
    }
  }
  private async rawStatus(binding: PersonVmBinding, signal: AbortSignal) {
    return this.parseStatus(
      binding,
      await this.command(binding, ['list', '--format', 'json'], signal),
    );
  }
  private parseStatus(binding: PersonVmBinding, output: string) {
    const rows: unknown = JSON.parse(output);
    if (!Array.isArray(rows)) throw new PersonVmError('PROVIDER_FAILED');
    const matches = rows.filter(
      (value: unknown) =>
        value &&
        typeof value === 'object' &&
        'name' in value &&
        value.name === this.name(binding),
    );
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) throw new PersonVmError('PROVIDER_FAILED');
    return (matches[0] as { status?: string }).status ?? 'Unknown';
  }
  async status(binding: PersonVmBinding, signal: AbortSignal) {
    return this.lifecycleState(await this.rawStatus(binding, signal));
  }
  private lifecycleState(status: string | undefined) {
    if (status === undefined) return 'absent' as const;
    if (status === 'Running') return 'running' as const;
    if (status === 'Stopped' || status === 'Created' || status === 'Crashed')
      return 'stopped' as const;
    return 'unknown' as const;
  }
  async create(
    binding: PersonVmBinding,
    receipt: PersonVmEgressReceipt,
    signal: AbortSignal,
    web?: PersonVmWebEndpointReceipt,
  ) {
    const paths = this.homes.get(binding.vmId);
    if (!paths) throw new PersonVmError('PROVIDER_FAILED');
    if (web) await assertPreparedWebEndpoints(paths.home, binding, web);
    if ((await this.status(binding, signal)) !== 'absent')
      throw new PersonVmError('PROVIDER_FAILED');
    const artifact = await this.artifact(binding, signal, true);
    if (this.options.publicImageCache) {
      const hasSeed = await this.options.seededPublicCache?.(
        binding.vmId,
        signal,
      );
      const mount = dirname(paths.config);
      const nativeRoot = join(mount, 'microsandbox');
      if (hasSeed)
        await verifySeededPublicImageCache(
          this.options.publicImageCache,
          this.options.image,
          nativeRoot,
          signal,
        );
      else if (
        !(await this.options.refreshBoundPublicCache?.(binding, mount, signal))
      )
        await seedPublicImageCache(
          this.options.publicImageCache,
          this.options.image,
          nativeRoot,
          signal,
        );
    } else
      await this.command(
        binding,
        ['pull', this.options.image, '--materialize', 'flat', '--quiet'],
        signal,
      );
    const args = [
      'create',
      this.options.image,
      '--name',
      this.name(binding),
      '--pull',
      'never',
      '--cpus',
      '2',
      '--max-cpus',
      '2',
      '--memory',
      `${this.memoryMiB}M`,
      '--max-memory',
      `${this.memoryMiB}M`,
      '--root-disk',
      `flat:${this.options.rootDiskGiB}G,clone=reflink`,
      '--net-default',
      'deny',
      // v0.7.16 treats --mkdir as a rootfs patch, rebuilding all OCI layers.
      // The unpatched image must boot from a directory that already exists.
      '--workdir',
      '/',
    ];
    const directory = this.options.readonlyDshDirectory;
    if (directory) {
      if (artifact?.disk)
        args.push(
          '--mount-disk',
          `${artifact.disk.diskPath}:${directory.guestDirectory}:format=raw,fstype=ext4,ro`,
        );
      else
        args.push(
          '--mount-dir',
          `${directory.hostDirectory}:${directory.guestDirectory}:ro`,
        );
    }
    const controls = this.options.readonlyCommandMemoryDirectory;
    if (controls)
      args.push(
        '--mount-dir',
        `${controls.hostDirectory}:${controls.guestDirectory}:ro`,
      );
    for (const port of receipt.gatewayPorts)
      args.push('--net-rule', `allow:egress@host:tcp:${port}`);
    if (web) {
      for (const endpoint of web.endpoints)
        args.push(
          '--net-rule',
          `allow:ingress@127.0.0.1/32:tcp:${endpoint.guestPort}`,
          '-p',
          `127.0.0.1:${endpoint.hostPort}:${endpoint.guestPort}`,
        );
    }
    // No native idle-timeout: detached DSH jobs may be active without touching it.
    await this.command(binding, args, signal);
    await this.assertArtifact(binding, signal);
  }

  private async ensureWorkDirectory(scope: PersonVmStartingScope) {
    const { binding, signal } = scope;
    const cleanupTimeoutMs = this.options.jobCleanupTimeoutMs ?? 10_000;
    let awaitingJobId = false;
    const job = await spawnMicrosandboxManagedProbe(
      {
        scope,
        name: this.name(binding),
        cleanupTimeoutMs,
        executionTimeoutSeconds: 10,
        command: (args, active, nonzero) => {
          awaitingJobId = args[0] === 'exec';
          return this.command(binding, args, active, nonzero);
        },
      },
      {
        executable: '/bin/mkdir',
        args: ['-p', '--', GUEST_WORK_DIRECTORY],
        workdir: '/bin',
      },
    ).catch((error: unknown) => {
      // Before an exact job ID is available, the startup owner still owns
      // rollback of the entire VM. Preserve any later exact-job cleanup error.
      if (
        awaitingJobId &&
        error instanceof PersonVmError &&
        error.code === 'CLEANUP_INCOMPLETE'
      )
        throw (
          error.cause ?? new PersonVmError('PROVIDER_FAILED', { cause: error })
        );
      throw error;
    });
    const result = await job.wait(signal).catch(async (error) => {
      try {
        await job.cancelAndWait(AbortSignal.timeout(cleanupTimeoutMs));
      } catch (cleanup) {
        throw new PersonVmError('CLEANUP_INCOMPLETE', {
          cause: new AggregateError([error, cleanup]),
        });
      }
      throw error;
    });
    if (result.exitCode !== 0 || result.timedOut)
      throw new PersonVmError('PROVIDER_FAILED');
  }
  async prepareWebEndpoints(
    binding: PersonVmBinding,
    roster: PersonVmWebRoster,
    signal: AbortSignal,
    options?: { runningOnly: true },
  ) {
    const paths = this.homes.get(binding.vmId);
    if (!paths) throw new PersonVmError('PROVIDER_FAILED');
    const state = await this.status(binding, signal);
    if (options?.runningOnly && state !== 'running')
      throw new PersonVmError('RUNTIME_NOT_READY');
    const receipt = await prepareWebEndpoints({
      directory: paths.home,
      binding,
      roster,
      state,
      signal,
    });
    if (state !== 'absent') {
      const inspection: unknown = JSON.parse(
        await this.command(
          binding,
          ['inspect', this.name(binding), '--format', 'json'],
          signal,
        ),
      );
      assertWebEndpointInspection(
        inspection,
        this.name(binding),
        receipt,
        state === 'running',
      );
    }
    return receipt;
  }
  async assertWebEndpoints(
    receipt: PersonVmWebEndpointReceipt,
    signal: AbortSignal,
  ) {
    const [artifact, inspection] = await this.inspectWithArtifact(
      receipt.binding,
      signal,
    );
    if (inspection.status === 'rejected') throw inspection.reason;
    if (artifact.status === 'rejected') throw artifact.reason;
    signal.throwIfAborted();
    if (this.options.readonlyDshDirectory)
      assertReadonlyArtifactInspection(
        inspection.value,
        this.name(receipt.binding),
        this.options.readonlyDshDirectory,
        true,
        this.options.readonlyCommandMemoryDirectory,
        artifact.value?.disk,
      );
    assertWebEndpointInspection(
      inspection.value,
      this.name(receipt.binding),
      receipt,
      true,
    );
  }
  private async startNative(
    binding: PersonVmBinding,
    signal: AbortSignal,
    web?: PersonVmWebEndpointReceipt,
  ): Promise<NativeStartFence | void> {
    const policy = this.options.restartMemory;
    if (policy === undefined) {
      // The default cap is also a cap: a cancelled modify may have persisted
      // a higher setting that only a start with new capacity may consume.
      const [, raw] = await this.inspectAndAssertArtifact(
        binding,
        signal,
        false,
      );
      const saved = raw as NativeMemoryInspection | null;
      if (
        saved?.name !== this.name(binding) ||
        typeof saved.status !== 'string' ||
        !['Stopped', 'Created', 'Crashed'].includes(saved.status) ||
        saved.active_config !== null ||
        !matchesNativeMemory(saved.config, this.memoryMiB)
      )
        throw new PersonVmError('PROVIDER_FAILED');
      await this.command(binding, ['start', this.name(binding)], signal);
      await this.assertArtifact(binding, signal, true, web);
      return;
    }

    const { memoryMiB, reserve } = policy;
    if (
      !Number.isInteger(memoryMiB) ||
      memoryMiB < 1024 ||
      memoryMiB > 4096 ||
      typeof reserve !== 'function'
    )
      throw new PersonVmError('PROVIDER_FAILED');

    const request = Object.freeze({
      binding: Object.freeze({ ...binding }),
      memoryMiB,
    });
    const name = this.name(request.binding);
    const inspect = async (active: AbortSignal, running: boolean) => {
      active.throwIfAborted();
      const [, raw] = await this.inspectAndAssertArtifact(
        request.binding,
        active,
        running,
        running ? web : undefined,
      );
      const value = raw as NativeMemoryInspection | null;
      const currentStatus = value?.status;
      if (
        value?.name !== name ||
        (running
          ? currentStatus !== 'Running'
          : (currentStatus !== 'Stopped' && currentStatus !== 'Crashed') ||
            value.active_config !== null)
      )
        throw new PersonVmError('PROVIDER_FAILED');
      return value;
    };
    await inspect(signal, false);
    const reservation = await reserve(request, signal);
    if (typeof reservation.commitRunning !== 'function')
      throw new PersonVmError('PROVIDER_FAILED');
    const active = AbortSignal.any([signal, reservation.signal]);
    const assertCapacity = async () => {
      active.throwIfAborted();
      await reservation.assertCurrent(request, active);
      active.throwIfAborted();
    };

    await assertCapacity();
    const stopped = await inspect(active, false);
    if (!matchesNativeMemory(stopped.config, memoryMiB)) {
      await assertCapacity();
      const result = await this.command(
        request.binding,
        [
          'modify',
          name,
          '--memory',
          `${memoryMiB}M`,
          '--max-memory',
          `${memoryMiB}M`,
          '--next-start',
          '--format',
          'json',
        ],
        active,
      );
      active.throwIfAborted();
      const plan: {
        sandbox?: unknown;
        status?: unknown;
        policy?: unknown;
        applied?: unknown;
        conflicts?: unknown;
      } | null = JSON.parse(result);
      if (
        plan?.sandbox !== name ||
        plan.status !==
          (stopped.status === 'Crashed' ? 'crashed' : 'stopped') ||
        plan.policy !== 'next_start' ||
        plan.applied !== true ||
        !Array.isArray(plan.conflicts) ||
        plan.conflicts.length !== 0
      )
        throw new PersonVmError('PROVIDER_FAILED');
      await assertCapacity();
      const saved = await inspect(active, false);
      if (!matchesNativeMemory(saved.config, memoryMiB))
        throw new PersonVmError('PROVIDER_FAILED');
    }
    await assertCapacity();
    await this.command(request.binding, ['start', name], active);
    await assertCapacity();
    const started = await inspect(active, true);
    if (
      !matchesNativeMemory(started.config, memoryMiB) ||
      !matchesNativeMemory(started.active_config, memoryMiB)
    )
      throw new PersonVmError('PROVIDER_FAILED');
    await assertCapacity();
    return Object.freeze({
      signal: active,
      assertCurrent: assertCapacity,
      commitRunning: async () => {
        active.throwIfAborted();
        await reservation.commitRunning(request, active);
      },
    });
  }
  async start(binding: PersonVmBinding, signal: AbortSignal) {
    return this.startNative(binding, signal);
  }
  async startWithWebEndpoints(
    receipt: PersonVmWebEndpointReceipt,
    signal: AbortSignal,
  ) {
    return this.startNative(receipt.binding, signal, receipt);
  }
  async stop(
    binding: PersonVmBinding,
    signal: AbortSignal,
    options?: Readonly<{ requireStopped: true }>,
  ) {
    const state = await this.status(binding, signal);
    if (state === 'absent') return;
    if (options?.requireStopped && state !== 'stopped')
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    // An exiting runtime can publish Stopped before releasing ownership.
    // The native stop operation joins the known runtime before we detach.
    await this.command(binding, ['stop', this.name(binding)], signal);
    const after = await this.status(binding, signal);
    if (after !== 'stopped' && after !== 'absent')
      throw new PersonVmError('CLEANUP_INCOMPLETE');
  }
  async stopIdle(
    binding: PersonVmBinding,
    signal: AbortSignal,
    assertCurrent: () => Promise<void>,
    dispatch?: PersonVmIdleStopDispatch,
  ) {
    if ((await this.rawStatus(binding, signal)) !== 'Running')
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    await assertCurrent();
    signal.throwIfAborted();
    let commandJoined = false;
    const stop = async (active: AbortSignal) => {
      await this.command(binding, ['stop', this.name(binding)], active);
      commandJoined = true;
    };
    if (dispatch) {
      try {
        await dispatch(signal, stop);
      } catch (error) {
        // Closing the read-only authority transaction may fail after the
        // command joined. The physical lease still owns terminal readback.
        if (!commandJoined) throw error;
      }
      if (!commandJoined) throw new PersonVmError('ACTIVITY_UNKNOWN');
    } else await stop(signal);
    if ((await this.rawStatus(binding, signal)) !== 'Stopped')
      throw new PersonVmError('CLEANUP_INCOMPLETE');
  }
  async assertStopped(binding: PersonVmBinding, signal: AbortSignal) {
    // Caller must already have proof that the native stop joined. This read
    // only verifies that the same stopped instance is still current.
    if ((await this.rawStatus(binding, signal)) !== 'Stopped')
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    signal.throwIfAborted();
  }
  async releaseDiskHome(vmId: string, mount: string, signal: AbortSignal) {
    const home = join(this.options.socketRoot, vmId);
    assertSocketHome(home);
    signal.throwIfAborted();
    try {
      if ((await readlink(home)) !== join(mount, 'microsandbox'))
        throw new PersonVmError('CLEANUP_INCOMPLETE');
      signal.throwIfAborted();
      await unlink(home);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    signal.throwIfAborted();
    this.homes.delete(vmId);
  }
  async ping(binding: PersonVmBinding, signal: AbortSignal) {
    await this.command(binding, ['ping', this.name(binding)], signal);
    await this.assertArtifact(binding, signal);
  }
  async bootstrap(scope: PersonVmStartingScope, plan: PersonVmMemoryGuestPlan) {
    const paths = this.homes.get(scope.binding.vmId);
    if (!paths) throw new PersonVmError('PROVIDER_FAILED');
    const readonly = this.options.readonlyDshDirectory;
    const controls = this.options.readonlyCommandMemoryDirectory;
    // Earlier artifacts need no added native inspection. An enabled backend
    // must come from the exact active read-only mount for this binding.
    let artifact: Awaited<ReturnType<MicrosandboxPersonVm['assertArtifact']>>;
    if (controls) {
      artifact = await this.assertArtifact(scope.binding, scope.signal);
    } else if (
      readonly &&
      (
        await verifyReadonlyDshDirectory(
          readonly,
          this.options.image,
          scope.signal,
        )
      ).sandboxSha256
    ) {
      artifact = await this.assertArtifact(scope.binding, scope.signal);
    }
    await this.ensureWorkDirectory(scope);
    return bootstrapMicrosandbox({
      scope,
      plan,
      name: this.name(scope.binding),
      stagingRoot: paths.userHome,
      readonlyCommandMemoryDirectory: controls?.guestDirectory,
      ...(readonly &&
        artifact?.sandboxSha256 && {
          dshSandbox: {
            guestDirectory: readonly.guestDirectory,
            sha256: artifact.sandboxSha256,
            cliSha256: artifact.cliSha256,
          },
        }),
      cleanupTimeoutMs: this.options.jobCleanupTimeoutMs ?? 10000,
      command: async (args, signal, readNonzeroExit) => {
        // Local file staging happens before this dispatch boundary.
        if (args[0] === 'cp') await scope.assertCurrent();
        return this.command(scope.binding, args, signal, readNonzeroExit);
      },
    });
  }
  /** Trusted diagnostics only. CLI abort is not proof of guest cancellation. */
  async exec(
    binding: PersonVmBinding,
    args: readonly string[],
    signal: AbortSignal,
  ) {
    return this.command(
      binding,
      ['exec', this.name(binding), '--', ...args],
      signal,
    );
  }
}
