import {
  ApfsPersonVmDisk,
  FilePersonVmKeyStore,
  MacosPersonVmDiskPool,
  MicrosandboxPersonVm,
  PersonVmError,
  type PersonVmDiskPoolOptions,
} from '@allrice/person-vm';
import { readVerifiedProductionPersonVmInputs } from './production-artifacts.js';
import { createProductionEgressInstallation } from './production-egress.js';
import { ProductionHostConfigurationUnavailable } from './production-config.js';

/** Real inert provider construction only, not an installed Host or runtime.
 * Nothing boots or allocates a disk here. The final single-service composition
 * must pass this same platform snapshot to its shared admission host. */
export async function createProductionPersonVmProviders(
  signal: AbortSignal,
  reserve?: NonNullable<
    ConstructorParameters<typeof MicrosandboxPersonVm>[0]['restartMemory']
  >['reserve'],
) {
  const loaded = await readVerifiedProductionPersonVmInputs(signal);
  signal.throwIfAborted();
  const capacityEnabled =
    loaded.configuration.lifecycle.hostVmBudgetMiB !== undefined;
  if (capacityEnabled && !reserve) throw new PersonVmError('RUNTIME_NOT_READY');
  const {
    disk: configuration,
    native: nativeConfiguration,
    lifecycle,
  } = loaded.configuration;
  const { root, keyRoot, capacityGiB, preprovision } = configuration;
  const keys = new FilePersonVmKeyStore(keyRoot);
  const disk = new ApfsPersonVmDisk({ root, keys, capacityGiB });
  let diskPool: PersonVmDiskPoolOptions | undefined;
  // The ordinary production disk provider already selects APFS. Bound cache
  // proof stays available on that platform even after disabling refill/claim.
  const poolPlatform =
    process.platform === 'darwin' && nativeConfiguration.publicImageCache
      ? new MacosPersonVmDiskPool({
          root,
          keyRoot,
          capacityGiB,
          disk,
          keys,
          image: nativeConfiguration.image,
          imageCache: nativeConfiguration.publicImageCache,
        })
      : undefined;
  if (preprovision?.enabled) {
    if (preprovision.platform !== 'macos' || !poolPlatform)
      throw new ProductionHostConfigurationUnavailable();
    diskPool = Object.freeze({
      platform: poolPlatform,
      source: poolPlatform.source,
      minimumFreeBytes: BigInt(preprovision.minimumFreeBytes),
      reserveBytes: BigInt(preprovision.reserveBytes),
      cleanupTimeoutMs: lifecycle.cleanupTimeoutMs,
    });
  }
  const native = new MicrosandboxPersonVm({
    ...nativeConfiguration,
    memoryMiB: loaded.platform.memoryMiB,
    ...(capacityEnabled && {
      restartMemory: { memoryMiB: loaded.platform.memoryMiB, reserve },
    }),
    seededPublicCache: poolPlatform?.hasSeededPublicCache.bind(poolPlatform),
    refreshBoundPublicCache:
      poolPlatform?.refreshBoundPublicCache.bind(poolPlatform),
  });
  signal.throwIfAborted();
  const egressInstallation = createProductionEgressInstallation(loaded, signal);
  return Object.freeze({
    ...loaded,
    native,
    disk,
    diskPool,
    egressInstallation,
    memoryGuestPlan: egressInstallation.memoryGuestPlan,
  });
}
