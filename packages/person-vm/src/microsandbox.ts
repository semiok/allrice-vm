import { UuidSchema } from '@allrice/contracts';
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
  commitWebUpgrade,
  prepareWebEndpoints,
  readWebUpgrade,
  type PersonVmWebEndpointReceipt,
  type PersonVmWebRoster,
} from './web-endpoints.ts';

// v0.7.16 client/ipc.rs uses 12 SHA-256 bytes (24 hex chars) for the
// canonical directory; Darwin sys/un.h has sun_path[104], including NUL.
const CANONICAL_SOCKET_HASH_BYTES = 12;
const DARWIN_SOCKET_PATH_CAPACITY = 104;
const VM_ID_PATH_BYTES = 36; // Host-generated canonical UUID, kept in full.
const GUEST_WORK_DIRECTORY = '/work';
type NativePaths = {
  home: string;
  config: string;
  userHome: string;
  upgrade?: PersonVmWebEndpointReceipt['upgrade'];
};

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
  /** Observe the original compute in an attached, retained disk without
   * preparing its config, changing its manifest or installing an owner. */
  assertRetainedStartup?(
    binding: PersonVmBinding,
    mount: string,
    signal: AbortSignal,
  ): Promise<void>;
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
    options?: { runningOnly?: true; retained?: true },
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
  start(binding: PersonVmBinding, signal: AbortSignal): Promise<void>;
  /** Optional retained-start operation. It must verify both the artifact and
   * Web endpoints against the same fresh, post-start native inspection. */
  startWithWebEndpoints?(
    receipt: PersonVmWebEndpointReceipt,
    signal: AbortSignal,
    egress?: PersonVmEgressReceipt,
  ): Promise<void>;
  stop(binding: PersonVmBinding, signal: AbortSignal): Promise<void>;
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
      employeePortSlots?: number;
      runner?: CommandRunner;
      jobCleanupTimeoutMs?: number;
    },
  ) {
    this.options = {
      ...options,
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
  private legacyName(binding: PersonVmBinding) {
    return `allrice-${binding.vmId}`;
  }
  private name(binding: PersonVmBinding, paths = this.homes.get(binding.vmId)) {
    return this.legacyName(binding) + (paths?.upgrade ? '-web' : '');
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
    const c = this.options.readonlyDshDirectory;
    if (!c && !web) return;
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
    return artifact.value;
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
  private async hasSocketAlias(home: string, target: string) {
    try {
      const directory = await lstat(this.options.socketRoot);
      if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700)
        throw new PersonVmError('PROVIDER_FAILED');
      const alias = await lstat(home);
      if (!alias.isSymbolicLink() || (await readlink(home)) !== target)
        throw new PersonVmError('PROVIDER_FAILED');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return false;
    }
  }
  private async ensureSocketAlias(home: string, target: string) {
    await privateDirectory(this.options.socketRoot);
    if (!(await this.hasSocketAlias(home, target)))
      await symlink(target, home, 'dir');
  }
  async prepare(binding: PersonVmBinding, mount: string, signal: AbortSignal) {
    const home = join(this.options.socketRoot, binding.vmId);
    assertSocketHome(home);
    const target = join(mount, 'microsandbox');
    await privateDirectory(target);
    // Rejoin an elected cache cutover before the CLI can open its cache path.
    await this.options.refreshBoundPublicCache?.(binding, mount, signal, true);
    const userHome = join(mount, 'host-home');
    await privateDirectory(userHome);
    await this.ensureSocketAlias(home, target);
    const config = join(mount, 'msb-config.json');
    await writeFile(config, this.configurationBytes(home, target), {
      mode: 0o600,
    });
    this.homes.set(binding.vmId, {
      home,
      config,
      userHome,
      upgrade: await readWebUpgrade(home, binding),
    });
    const version = await this.command(binding, ['--version'], signal);
    if (!/\b0\.7\.16\b/.test(version))
      throw new PersonVmError('PROVIDER_FAILED');
  }
  private async readAttachedPaths(
    binding: PersonVmBinding,
    mount: string,
    restoreSocketAlias = false,
  ) {
    const home = join(this.options.socketRoot, binding.vmId);
    const target = join(mount, 'microsandbox');
    const paths: NativePaths = {
      home,
      userHome: join(mount, 'host-home'),
      config: join(mount, 'msb-config.json'),
    };
    assertSocketHome(home);
    for (const directory of [target, paths.userHome]) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700)
        throw new PersonVmError('PROVIDER_FAILED');
    }
    const hasAlias = await this.hasSocketAlias(home, target);
    if (!hasAlias && !restoreSocketAlias)
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
    paths.upgrade = await readWebUpgrade(target, binding, !hasAlias);
    // On guarded retained startup only, recreate the normal short Host alias
    // after verifying the on-disk configuration and manifest. Use the same
    // public list path against the original MSB_HOME.
    if (!hasAlias) await this.ensureSocketAlias(home, target);
    return paths;
  }
  /** For a fixed Host-authored read command, inside a physical lease that has
   * independently verified this already attached disk. Reopen the original
   * configuration without populating launch ownership or preparing the disk. */
  async readAttachedProbe(
    scope: PersonVmStartingScope,
    mount: string,
    commandSpec: PersonVmGuestCommand,
  ) {
    const { binding, signal } = scope;
    await scope.assertCurrent();
    signal.throwIfAborted();
    const paths = await this.readAttachedPaths(binding, mount);
    const directory = this.options.readonlyDshDirectory;
    const artifact = await this.artifact(binding, signal, false, paths.home);
    if (!directory || !artifact) throw new PersonVmError('PROVIDER_FAILED');
    const command = (args: string[], active: AbortSignal, nonzero?: boolean) =>
      this.runWithPaths(paths, args, active, nonzero);
    if (paths.upgrade === 'pending')
      throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
    const name = this.name(binding, paths);
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
  async status(binding: PersonVmBinding, signal: AbortSignal) {
    return this.namedStatus(binding, this.name(binding), signal);
  }
  private async namedStatus(
    binding: PersonVmBinding,
    name: string,
    signal: AbortSignal,
    paths = this.homes.get(binding.vmId),
  ) {
    if (!paths) throw new PersonVmError('PROVIDER_FAILED');
    const rows: unknown = JSON.parse(
      await this.runWithPaths(paths, ['list', '--format', 'json'], signal),
    );
    if (!Array.isArray(rows)) throw new PersonVmError('PROVIDER_FAILED');
    const matches = rows.filter(
      (value: unknown) =>
        value &&
        typeof value === 'object' &&
        'name' in value &&
        value.name === name,
    );
    if (matches.length === 0) return 'absent' as const;
    if (matches.length !== 1) throw new PersonVmError('PROVIDER_FAILED');
    const status = (matches[0] as { status?: string }).status;
    if (status === 'Running') return 'running' as const;
    if (status === 'Stopped' || status === 'Created' || status === 'Crashed')
      return 'stopped' as const;
    return 'unknown' as const;
  }
  private async assertRetainedState(
    binding: PersonVmBinding,
    paths: NativePaths,
    state: Awaited<ReturnType<MicrosandboxPersonVm['status']>>,
    signal: AbortSignal,
  ) {
    if (paths.upgrade === 'pending') {
      if (
        (state !== 'absent' && state !== 'stopped') ||
        (await this.namedStatus(
          binding,
          this.legacyName(binding),
          signal,
          paths,
        )) !== 'stopped'
      )
        throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
    } else if (state !== 'stopped') {
      throw new PersonVmError('PROVIDER_FAILED');
    }
  }
  async assertRetainedStartup(
    binding: PersonVmBinding,
    mount: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const paths = await this.readAttachedPaths(binding, mount, true);
    if (
      !/\b0\.7\.16\b/.test(
        await this.runWithPaths(paths, ['--version'], signal),
      )
    )
      throw new PersonVmError('PROVIDER_FAILED');
    const state = await this.namedStatus(
      binding,
      this.name(binding, paths),
      signal,
      paths,
    );
    await this.assertRetainedState(binding, paths, state, signal);
    signal.throwIfAborted();
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
    args.push(
      ...this.mountArguments(artifact, '--mount-dir'),
      ...this.networkArguments(receipt, web),
    );
    // No native idle-timeout: detached DSH jobs may be active without touching it.
    await this.command(binding, args, signal);
    await this.assertArtifact(binding, signal);
  }
  private mountArguments(
    artifact: Awaited<ReturnType<MicrosandboxPersonVm['artifact']>>,
    directoryOption: '--mount-dir' | '--volume',
  ) {
    const args: string[] = [];
    const directory = this.options.readonlyDshDirectory;
    if (directory) {
      if (artifact?.disk)
        args.push(
          '--mount-disk',
          `${artifact.disk.diskPath}:${directory.guestDirectory}:format=raw,fstype=ext4,ro`,
        );
      else
        args.push(
          directoryOption,
          `${directory.hostDirectory}:${directory.guestDirectory}:ro`,
        );
    }
    const controls = this.options.readonlyCommandMemoryDirectory;
    if (controls)
      args.push(
        directoryOption,
        `${controls.hostDirectory}:${controls.guestDirectory}:ro`,
      );
    return args;
  }
  private networkArguments(
    receipt: PersonVmEgressReceipt,
    web?: PersonVmWebEndpointReceipt,
  ) {
    const args: string[] = [];
    for (const port of receipt.gatewayPorts)
      args.push('--net-rule', `allow:egress@host:tcp:${port}`);
    if (web) {
      for (const endpoint of web.slots ?? web.endpoints)
        args.push(
          '--net-rule',
          `allow:ingress@127.0.0.1/32:tcp:${endpoint.guestPort}`,
          '-p',
          `127.0.0.1:${endpoint.hostPort}:${endpoint.guestPort}`,
        );
    }
    return args;
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
    options?: { runningOnly?: true; retained?: true },
  ) {
    const paths = this.homes.get(binding.vmId);
    if (!paths) throw new PersonVmError('PROVIDER_FAILED');
    const state = await this.status(binding, signal);
    if (options?.runningOnly && state !== 'running')
      throw new PersonVmError('RUNTIME_NOT_READY');
    if (
      options?.retained ||
      paths.upgrade === 'pending' ||
      (paths.upgrade === 'complete' && state === 'absent')
    )
      await this.assertRetainedState(binding, paths, state, signal);
    const receipt = await prepareWebEndpoints({
      directory: paths.home,
      binding,
      roster,
      employeePortSlots: this.options.employeePortSlots,
      state:
        state === 'absent' && paths.upgrade === 'pending' ? 'stopped' : state,
      signal,
    });
    if (receipt.upgrade === 'pending') {
      paths.upgrade = receipt.upgrade;
      return receipt;
    }
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
  private async startNative(binding: PersonVmBinding, signal: AbortSignal) {
    await this.assertArtifact(binding, signal, false);
    await this.command(binding, ['start', this.name(binding)], signal);
  }
  async start(binding: PersonVmBinding, signal: AbortSignal) {
    await this.startNative(binding, signal);
    await this.assertArtifact(binding, signal);
  }
  async startWithWebEndpoints(
    receipt: PersonVmWebEndpointReceipt,
    signal: AbortSignal,
    egress?: PersonVmEgressReceipt,
  ) {
    if (receipt.upgrade === 'pending') {
      if (!egress) throw new PersonVmError('EGRESS_UNAVAILABLE');
      return this.restoreWebUpgrade(receipt, egress, signal);
    }
    await this.startNative(receipt.binding, signal);
    await this.assertArtifact(receipt.binding, signal, true, receipt);
  }
  private async restoreWebUpgrade(
    web: PersonVmWebEndpointReceipt,
    egress: PersonVmEgressReceipt,
    signal: AbortSignal,
  ) {
    const { binding } = web;
    const paths = this.homes.get(binding.vmId);
    if (!paths || paths.upgrade !== 'pending' || !web.slots)
      throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
    const source = this.legacyName(binding);
    const target = this.name(binding);
    if ((await this.namedStatus(binding, source, signal)) !== 'stopped')
      throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
    await assertPreparedWebEndpoints(paths.home, binding, web);
    const state = await this.namedStatus(binding, target, signal);
    if (state === 'absent') {
      const name = 'before-web-slots';
      const reference = `${source}:${name}`;
      const entries: unknown = JSON.parse(
        await this.command(
          binding,
          ['snap', 'ls', '--group', source, '--format', 'json'],
          signal,
        ),
      );
      if (!Array.isArray(entries)) throw new PersonVmError('PROVIDER_FAILED');
      if (
        !entries.some(
          (entry) => entry?.name === name && entry?.group === source,
        )
      )
        await this.command(
          binding,
          ['snap', 'create', name, '--sandbox', source, '--integrity'],
          signal,
        );
      await this.command(binding, ['snap', 'verify', reference], signal);
      const artifact = await this.artifact(binding, signal, false);
      await this.command(
        binding,
        [
          'restore',
          reference,
          '--name',
          target,
          '--cpus',
          '2',
          '--memory',
          `${this.memoryMiB}M`,
          '--net-default',
          'deny',
          ...this.mountArguments(artifact, '--volume'),
          ...this.networkArguments(egress, web),
        ],
        signal,
      );
    } else if (state === 'stopped') {
      const inspection: unknown = JSON.parse(
        await this.command(
          binding,
          ['inspect', target, '--format', 'json'],
          signal,
        ),
      );
      assertWebEndpointInspection(inspection, target, web, false);
      await this.startNative(binding, signal);
    } else throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
    await this.assertArtifact(binding, signal, true, web);
    signal.throwIfAborted();
    await commitWebUpgrade(paths.home, web);
    paths.upgrade = 'complete';
  }
  async stop(binding: PersonVmBinding, signal: AbortSignal) {
    const state = await this.status(binding, signal);
    if (state === 'absent' || state === 'stopped') return;
    await this.command(binding, ['stop', this.name(binding)], signal);
    const after = await this.status(binding, signal);
    if (after !== 'stopped' && after !== 'absent')
      throw new PersonVmError('CLEANUP_INCOMPLETE');
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
  async bootstrap(
    scope: PersonVmStartingScope,
    plan: PersonVmMemoryGuestPlan,
    employee?: Parameters<PersonVmGuestBootstrapPort['bootstrap']>[2],
  ) {
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
    if (employee) UuidSchema.parse(employee.employeeInstanceId);
    else await this.ensureWorkDirectory(scope);
    return bootstrapMicrosandbox({
      scope,
      plan,
      ...(employee && { employee }),
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
