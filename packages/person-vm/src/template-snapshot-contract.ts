import { posix } from 'node:path';
import { z } from 'zod';
import type { PersonVmBinding, PersonVmEgressReceipt } from './contract.ts';
import type { PersonVmDiskIdentity } from './encrypted-disk.ts';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const hostPath = z
  .string()
  .max(4096)
  .refine(
    (path) =>
      posix.isAbsolute(path) &&
      posix.normalize(path) === path &&
      !path.endsWith('/') &&
      !path.includes('\0') &&
      !path.includes(':'),
  );
const relativeFile = z
  .string()
  .max(1024)
  .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9._/-]*$/)
  .refine(
    (path) =>
      !path.endsWith('/') &&
      !['manifest.json', 'manifest.sig'].some(
        (name) => path === name || path.startsWith(name + '/'),
      ) &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
  );

export const LinuxSnapshotConfigurationSchema = z
  .discriminatedUnion('enabled', [
    z.strictObject({ enabled: z.literal(false) }),
    z
      .strictObject({
        enabled: z.literal(true),
        mode: z.literal('probe'),
        platform: z.literal('linux/arm64'),
        engine: z.literal('microsandbox'),
        templateDirectory: hostPath,
        manifestSha256: sha256,
      })
      .refine(
        ({ templateDirectory, manifestSha256 }) =>
          posix.basename(templateDirectory) === manifestSha256,
      ),
  ])
  .default({ enabled: false });

export type TemplateSeal = Extract<
  z.output<typeof LinuxSnapshotConfigurationSchema>,
  { enabled: true }
>;

const machineLabel = z
  .string()
  .min(1)
  .max(128)
  .refine((label) => label.trim() === label);
const pageSize = z.literal([4096, 16384, 65536]);
const requiredFileRoles = [
  'state',
  'memory',
  'root-disk',
  'dsh-runtime-disk',
  'device-topology',
] as const;

/** This checks manifest structure. Qualification must check all actual bytes
 * and the signed release identity before a manifest can authorize a restore. */
export const PersonVmTemplateManifestSchema = z
  .strictObject({
    version: z.literal(1),
    engine: z.literal('microsandbox'),
    engineVersion: z.literal('0.7.16'),
    restoreProtocol: z.literal(1),
    platform: z.literal('linux/arm64'),
    host: z.strictObject({
      kernel: machineLabel,
      cpuModel: machineLabel,
      cpuFeaturesSha256: sha256,
      kvmApiVersion: z.literal(12),
      gic: z.literal('v3'),
      pageSize,
    }),
    guest: z.strictObject({
      vcpus: z.literal(2),
      memoryMiB: z.literal(2048),
      pageSize,
      kernelSha256: sha256,
      workMount: z.literal('strict-external-directory'),
      workPath: z.literal('/work'),
    }),
    inputs: z.strictObject({
      vmmSha256: sha256,
      firmwareSha256: sha256,
      agentdSha256: sha256,
      imageSha256: sha256,
      dshRuntimeDiskSha256: sha256,
      dshProfileSha256: sha256,
      commandMemorySha256: sha256,
      isolationPolicySha256: sha256,
    }),
    files: z
      .array(
        z.strictObject({
          role: z.enum([...requiredFileRoles, 'metadata']),
          path: relativeFile,
          sizeBytes: z.number().int().positive().safe(),
          sha256,
        }),
      )
      .min(requiredFileRoles.length)
      .max(32)
      .refine(
        (files) =>
          requiredFileRoles.every(
            (role) => files.filter((file) => file.role === role).length === 1,
          ) &&
          files.every(({ path }, index) =>
            files.every(
              (file, other) =>
                index === other ||
                (file.path !== path && !file.path.startsWith(path + '/')),
            ),
          ),
        'Expected distinct files with exactly one entry for each required role',
      ),
  })
  .refine(
    ({ files, inputs }) =>
      files.some(
        (file) =>
          file.role === 'dsh-runtime-disk' &&
          file.sha256 === inputs.dshRuntimeDiskSha256,
      ),
    'Expected the DSH runtime disk to match the locked digest',
  );

export type PersonVmTemplateManifest = z.output<
  typeof PersonVmTemplateManifestSchema
>;

export type VerifiedTemplate = Readonly<{
  seal: TemplateSeal;
  manifest: PersonVmTemplateManifest;
}>;

/** Constructed by the trusted disk provider under the current physical lease. */
export type OwnedWorkDiskReceipt = Readonly<{
  binding: PersonVmBinding;
  image: PersonVmDiskIdentity;
  mountId: string;
  workDirectory: string;
}>;

export type TemplateRestoreRequest = Readonly<{
  template: VerifiedTemplate;
  binding: PersonVmBinding;
  disk: OwnedWorkDiskReceipt;
  egress: PersonVmEgressReceipt;
  /** Recheck authorization and both receipts before dispatch and before return. */
  assertCurrent(signal: AbortSignal): Promise<void>;
  /** Before any dispatch that might create native compute, even if it times out. */
  onNativeDispatch(): void;
  signal: AbortSignal;
}>;

/** The provider verifies /work inside the guest against the owned host mount.
 * It authenticates the restored compute and consumes a fresh challenge on a
 * new private endpoint for this binding. Only after all freshness and mount
 * proofs pass may the caller start the employee owner, inject credentials,
 * expose sessions or open ingress. Business readiness uses the existing path. */
export type RestoredCompute = Readonly<{
  binding: PersonVmBinding;
  templateDigest: string;
  computeIdentity: Readonly<{ pid: number; startedAt: string }>;
  controlEndpoint: string;
  mountIdentity: OwnedWorkDiskReceipt;
  guestWorkMount: Readonly<{
    path: '/work';
    sourceMountId: string;
    verifiedAgainstOwnedDisk: true;
  }>;
  networkIdentity: Readonly<{ isolationId: string; egressBindingId: string }>;
  freshness: Readonly<{
    kernelEntropyReseeded: true;
    userRuntimeReinitialized: true;
    networkIdentityRefreshed: true;
    cgroupVerified: true;
    controlEndpointFresh: true;
    controlPeerVerified: true;
    controlChallengeConsumed: true;
  }>;
}>;

export type TemplateStopReceipt =
  | Readonly<{
      state: 'stopped';
      binding: PersonVmBinding;
      nativeGone: true;
      operationsJoined: true;
      networkClosed: true;
    }>
  | Readonly<{ state: 'unknown'; binding: PersonVmBinding }>;

export interface PersonVmTemplatePort {
  qualify(seal: TemplateSeal, signal: AbortSignal): Promise<VerifiedTemplate>;
  restore(request: TemplateRestoreRequest): Promise<RestoredCompute>;
  inspect(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<'absent' | 'stopped' | 'restoring' | 'running' | 'unknown'>;
  /** #59 may proceed to disk detach only with an exact stopped receipt. */
  stopAndJoin(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<TemplateStopReceipt>;
}
