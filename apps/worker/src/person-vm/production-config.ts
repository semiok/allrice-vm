import { isIP } from 'node:net';
import { arch, platform } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  posix,
  sep,
} from 'node:path';
import {
  readServiceBuildIdentity,
  readSealedPersonVmHostConfiguration,
} from '@allrice/database';
import {
  PlatformPersonVmPolicySchema,
  readPlatformPersonVmConfiguration,
} from '@allrice/contracts';
import {
  checkedReadonlyCommandMemoryDirectory,
  LinuxSnapshotConfigurationSchema,
} from '@allrice/person-vm';
import { z } from 'zod';
import { resolveProductionEmployeeRuntimeSettings } from './production-employee-runtime.js';

const platformDefaults = readPlatformPersonVmConfiguration();
const bytesPerMiB = 1024 ** 2;

function platformSetting(field: 'memoryMiB' | 'idleMs', value: unknown) {
  const fallback = platformDefaults[field];
  if (value === undefined) return fallback;
  const parsed = PlatformPersonVmPolicySchema.shape[field].safeParse(value);
  if (parsed.success) return parsed.data;
  console.warn('PERSON_VM_PLATFORM_SETTING_INVALID', { field, fallback });
  return fallback;
}

const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const bareHash = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z
  .string()
  .refine(
    (path) =>
      isAbsolute(path) &&
      normalize(path) === path &&
      path !== '/' &&
      !path.includes('\0'),
  );
const guestPath = z
  .string()
  .refine(
    (path) =>
      posix.isAbsolute(path) &&
      posix.normalize(path) === path &&
      path !== '/' &&
      !path.includes('\0'),
  );
const positive = z.number().int().positive().safe();
const bytes = z.number().int().nonnegative().safe();
const score = z.number().int().min(-1000).max(1000);
const destinationIp = z.string().refine((value) => {
  const family = isIP(value);
  if (family === 4) return value !== '0.0.0.0';
  if (family !== 6) return false;
  // A zone identifies an interface, not a different underlying IPv6 address.
  const address = value.split('%', 1)[0] ?? value;
  try {
    return new URL(`http://[${address}]/`).hostname !== '[::]';
  } catch {
    return false;
  }
});
const configuration = z
  .object({
    version: z.literal(1),
    linuxSnapshot: LinuxSnapshotConfigurationSchema,
    native: z
      .object({
        binary: absolute,
        libkrunfw: absolute,
        agentd: absolute,
        artifactChecksums: z
          .object({ binary: checksum, libkrunfw: checksum, agentd: checksum })
          .strict(),
        image: z.string().regex(/^\S+@sha256:[a-f0-9]{64}$/),
        readonlyDshDirectory: z
          .object({
            descriptorPath: absolute,
            hostDirectory: absolute,
            guestDirectory: guestPath,
            artifactSha256: bareHash,
            manifestSha256: bareHash,
            sealedManifestSha256: bareHash,
            treeSha256: bareHash,
          })
          .strict(),
        readonlyDshRuntimeDisk: z
          .object({
            diskPath: absolute,
            diskSha256: bareHash,
            candidatePath: absolute,
            candidateSha256: bareHash,
            provision: z.enum(['disk', 'directory']),
          })
          .strict()
          .refine(
            ({ diskPath, diskSha256, candidatePath }) =>
              !diskPath.includes(':') &&
              basename(diskPath) === 'runtime.ext4' &&
              basename(dirname(diskPath)) === diskSha256 &&
              candidatePath === join(dirname(diskPath), 'candidate.json'),
          )
          .optional(),
        readonlyCommandMemoryDirectory: z
          .object({
            hostDirectory: z.string(),
            guestDirectory: z.string(),
            sha256: z.string(),
          })
          .strict()
          .transform(checkedReadonlyCommandMemoryDirectory),
        publicImageCache: z
          .object({ directory: absolute, manifestSha256: bareHash })
          .strict()
          .refine(
            ({ directory, manifestSha256 }) =>
              basename(directory) === manifestSha256,
          )
          .optional(),
        rootDiskGiB: positive,
        socketRoot: absolute,
        jobCleanupTimeoutMs: positive,
      })
      .strict()
      .refine(
        ({ image, publicImageCache }) =>
          !publicImageCache ||
          /^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/.test(image),
      ),
    disk: z
      .object({
        root: absolute,
        keyRoot: absolute,
        capacityGiB: positive,
        preprovision: z
          .discriminatedUnion('enabled', [
            z.object({ enabled: z.literal(false) }).strict(),
            z
              .object({
                enabled: z.literal(true),
                platform: z.literal('macos'),
                minimumFreeBytes: positive,
                reserveBytes: positive,
              })
              .strict(),
          ])
          .optional(),
      })
      .strict(),
    memory: z
      .object({
        persistentDirectory: guestPath,
        policyRef: z.string().trim().min(1),
        policy: z
          .object({
            physicalBytes: z
              .unknown()
              .optional()
              .transform(
                (value) =>
                  platformSetting(
                    'memoryMiB',
                    typeof value === 'number' ? value / bytesPerMiB : value,
                  ) * bytesPerMiB,
              ),
            swapBytes: positive,
            dshLowBytes: bytes,
            dshSwapMaxBytes: bytes,
            commandHighBytes: bytes,
            commandMaxBytes: bytes,
            commandSwapMaxBytes: bytes,
            commandOomGroup: z.literal(0),
            dshOomScoreAdj: score,
            commandOomScoreAdj: score,
          })
          .strict()
          .refine(
            (policy) => policy.commandHighBytes <= policy.commandMaxBytes,
          ),
      })
      .strict(),
    web: z
      .object({
        cliPath: guestPath,
        startupTimeoutMs: positive,
        terminalEnabled: z.boolean().default(true),
        publicOrigin: z.string().refine((value) => {
          try {
            const url = new URL(value);
            return (
              ['http:', 'https:'].includes(url.protocol) &&
              url.origin === value &&
              !url.username &&
              !url.password
            );
          } catch {
            return false;
          }
        }),
      })
      .strict(),
    // Optional for existing H1 reads; required by the real egress constructor.
    egress: z
      .object({
        listenAddress: destinationIp,
        // The guest origin uses WHATWG URL, which has no zone carrier.
        guestGatewayAddress: destinationIp.refine(
          (value) => !value.includes('%'),
        ),
      })
      .strict()
      .optional(),
    lifecycle: z
      .object({
        leaseTtlMs: positive,
        activityMaxAgeMs: positive,
        cleanupTimeoutMs: positive,
        idleStopEnabled: z.boolean().optional(),
        idleMs: z
          .unknown()
          .transform((value) => platformSetting('idleMs', value))
          .optional(),
        idleSampleIntervalMs: z
          .number()
          .int()
          .min(1_000)
          .max(60_000)
          .optional(),
        idleScheduleSafetyMarginMs: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .optional(),
        // Omitting the reserved VM budget disables the capacity policy.
        hostVmBudgetMiB: z
          .number()
          .int()
          .min(4096 + 512)
          .optional(),
        employeeMaxRunning: z.number().optional(),
        employeeIdleMs: z.number().optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      !value.disk.preprovision?.enabled ||
      Boolean(value.native.publicImageCache),
  )
  .refine((value) => {
    const policy = value.memory.policy;
    return (
      policy.commandHighBytes === platformDefaults.commandHighBytes &&
      policy.commandMaxBytes === platformDefaults.commandMaxBytes &&
      policy.commandSwapMaxBytes === platformDefaults.commandSwapMaxBytes
    );
  })
  .refine((value) => {
    const roots = [
      value.disk.root,
      value.disk.keyRoot,
      value.native.socketRoot,
      ...(value.native.publicImageCache
        ? [value.native.publicImageCache.directory]
        : []),
      ...(value.native.readonlyDshRuntimeDisk
        ? [dirname(value.native.readonlyDshRuntimeDisk.diskPath)]
        : []),
    ];
    if (
      value.native.readonlyDshRuntimeDisk &&
      value.web.cliPath !==
        value.native.readonlyDshDirectory.guestDirectory +
          '/node_modules/@deepseek-ai/dsh/lib/bin.js'
    )
      return false;
    const snapshot = value.linuxSnapshot;
    if (
      snapshot.enabled &&
      [
        ...roots,
        value.native.readonlyDshDirectory.hostDirectory,
        value.native.readonlyCommandMemoryDirectory.hostDirectory,
      ].some((path) => {
        const root = path.endsWith(sep) ? path.slice(0, -1) : path;
        return (
          root === snapshot.templateDirectory ||
          root.startsWith(snapshot.templateDirectory + sep) ||
          snapshot.templateDirectory.startsWith(root + sep)
        );
      })
    )
      return false;
    return roots.every((root, i) =>
      roots.every(
        (other, j) =>
          i === j || (root !== other && !root.startsWith(other + sep)),
      ),
    );
  });

export type ProductionHostConfiguration = z.infer<typeof configuration>;
export class ProductionHostConfigurationUnavailable extends Error {
  constructor() {
    super('PERSON_VM_HOST_CONFIGURATION_UNAVAILABLE');
  }
}
function unavailable(): never {
  throw new ProductionHostConfigurationUnavailable();
}

/** Fixed private release file, authenticated by the existing service seal.
 * This returns configuration, not an artifact/readiness/permission receipt.
 * No env/RC/request override, phase4 policy, path or Linux hash fallback exists. */
export async function readProductionHostConfiguration(signal: AbortSignal) {
  signal.throwIfAborted();
  const build = await readServiceBuildIdentity('worker');
  signal.throwIfAborted();
  if (!build || build.service !== 'worker' || build.mode !== 'production')
    unavailable();
  try {
    const sealed = await readSealedPersonVmHostConfiguration(build, signal);
    if (!sealed) unavailable();
    const value = configuration.parse(sealed.configuration);
    if (
      value.linuxSnapshot.enabled &&
      (platform() !== 'linux' || arch() !== 'arm64')
    )
      unavailable();
    const defaults = readPlatformPersonVmConfiguration();
    signal.throwIfAborted();
    const memoryMiB = value.memory.policy.physicalBytes / bytesPerMiB;
    const idleMs = value.lifecycle.idleMs ?? platformDefaults.idleMs;
    return Object.freeze({
      configuration: value,
      employeeRuntimeSettings: resolveProductionEmployeeRuntimeSettings(
        value.lifecycle,
        sealed.employeePortSlots,
      ),
      platform:
        memoryMiB === defaults.memoryMiB &&
        idleMs === defaults.idleMs &&
        sealed.employeePortSlots === defaults.employeePortSlots
          ? defaults
          : Object.freeze({
              ...defaults,
              memoryMiB,
              idleMs,
              employeePortSlots: sealed.employeePortSlots,
            }),
      applicationBuild: Object.freeze({
        sourceSha: build.sourceSha,
        sourceTree: build.sourceTree,
        manifestDigest: sealed.manifestDigest,
      }),
    });
  } catch {
    signal.throwIfAborted();
    unavailable();
  }
}
