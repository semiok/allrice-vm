import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { RequestContext } from '@allrice/contracts';
import {
  createDedicatedDatabase,
  createDEntryAuthorityFeed,
  createPostgresPersonVmScheduledWakeStore,
  getDatabase,
  readContentPrincipal,
  readPersonNativeWebRoster,
  readPersonVmDiskPreparationForegroundBusy,
  readPersonVmDiskPreparationRoster,
  readPersonVmDiskPreparationTarget,
  readPersonVmWakeRoster,
  requireCurrentPlatformAdmin,
} from '@allrice/database';
import {
  createModelGateway,
  createDshGatewayProvider,
  createPostgresModelGatewayStore,
  type ModelCallBinding,
  type ModelGatewayAuthority,
  type ModelGatewayPort,
  type GatewayProvider,
  type DshGatewayStreamScope,
} from '@allrice/model-gateway';
import {
  createEgressGateway,
  createPublicHttpsTransport,
  type EgressAuthority,
  EgressError,
  EgressPrepareRollbackError,
  type EgressPolicy,
  type ManagedHostService,
} from '@allrice/egress-gateway';
import {
  PersonVmError,
  PersonVmDiskPool,
  PersonVmService,
  PostgresPersonVmStore,
  sameVmBinding,
  type PersonVmBinding,
  type PersonVmEgressPort,
  type PersonVmEgressReceipt,
  type PersonVmNativeActivityPort,
  type PersonVmAdmissionSubscription,
  type PersonVmRuntimePort,
  type PersonVmScheduledIdleAuthority,
  type PersonVmWebRoster,
  type PlatformVmDeletionRequest,
  type PlatformVmDeletionResult,
} from '@allrice/person-vm';
import { totalmem } from 'node:os';
import { installAssignedDEntryNativeRuntime } from '../business-runtime/native-prewarm.js';
import {
  readReleasedGuestProfile,
  readWorkerEmployeeWebSeal,
} from '../d-entry/released-profile.js';
import {
  createAssignedNativeWebStartup,
  personNativeWebRoster,
} from '../native-web/composition.js';
import { dEntryNativePublicUrl } from '../native-web/launch.js';
import {
  authorizeProductionPersonVmDeletion,
  createProductionPersonVmAuthority,
} from './production-authority.js';
import { startProductionDiskPreprovision } from './production-disk-preprovision.js';
import { createProductionCurrentPrewarm } from './production-prewarm.js';
import {
  assertNoPreviousWorker,
  withPreviousGatewayFenced,
} from './production-upgrade-fence.js';
import { createProductionPersonVmProviders } from './production-providers.js';
import { ProductionHostConfigurationUnavailable } from './production-config.js';
import { ProductionPersonVmArtifactsUnavailable } from './production-artifacts.js';
import {
  createProductionScheduledWake,
  type PersonVmWakePreparation,
  type ProductionScheduledWakeSource,
} from './production-scheduled-wake.js';
import {
  DEFAULT_IDLE_SAMPLE_INTERVAL_MS,
  getIdleScheduleGuardMs,
  IDLE_RECONCILE_TIMEOUT_MS,
} from './production-native-activity.js';
import type { PrepareStopWithWakeResult } from './scheduled-wake.js';

type Providers = Awaited<ReturnType<typeof createProductionPersonVmProviders>>;
type Startup = ReturnType<typeof createAssignedNativeWebStartup>;
type Admission = ReturnType<PersonVmService['createAdmissionHost']>;
type Current = ReturnType<typeof createProductionPersonVmAuthority>;

export class ProductionPersonVmHostUnavailable extends Error {
  constructor(
    readonly code:
      | 'HOST_SOURCES_UNAVAILABLE'
      | 'HOST_CONFIGURATION_UNAVAILABLE'
      | 'PERSON_VM_ARTIFACTS_UNAVAILABLE'
      | 'HOST_CLOSED'
      | 'MODEL_RECOVERY_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'ProductionPersonVmHostUnavailable';
  }
}

/** Internal production owners, never a parsed DTO or browser-installed port.
 * bind is inert: it must not create/start a VM or enter a business operation,
 * and must roll back its own failed construction. On success this composition
 * owns each close, including actual model/observation transports and callbacks.
 * First-start facts must come from the valid native bootstrap scope, never
 * running-only resolve/assertCurrentBinding self-certification during readiness.
 * No producer is implemented by accepting an object of this shape. */
export type ProductionPersonVmHostSources = Readonly<{
  bind(input: {
    vm: PersonVmService;
    startup: Startup;
    admission: Admission;
    providers: Providers;
    current: Current;
    lifetime: AbortSignal;
    modelOwnerId: string;
    reserveNativeModelCall(call: ModelCallBinding): Promise<void>;
    issueReference<T>(
      call: ModelCallBinding,
      signal: AbortSignal,
      issue: (active: AbortSignal) => Promise<T>,
    ): Promise<T>;
  }): Promise<{
    runtime: Pick<PersonVmRuntimePort, 'readiness' | 'activity'> & {
      /** Fence observations and join their actual work/subscriptions. */
      close(): Promise<void>;
    };
    nativeActivity?: PersonVmNativeActivityPort;
    scheduledWake?: ProductionScheduledWakeSource;
    egress: {
      authority: EgressAuthority;
      policy: EgressPolicy;
      services?: readonly ManagedHostService[];
      /** Register the exact private request context used by the model route
       * before EgressAuthority.allow receives it with the same signal. */
      bindModelCall?(call: ModelCallBinding, signal: AbortSignal): void;
      /** Host upstream transport/credentials stay owned by sources. */
      close(): Promise<void>;
    };
    model: {
      authority: ModelGatewayAuthority;
      llm: Parameters<typeof createDshGatewayProvider>[0];
      route: Parameters<typeof createDshGatewayProvider>[1];
      scopeStream?: DshGatewayStreamScope;
      transport?: Readonly<{
        fetchOwned: NonNullable<GatewayProvider['fetchOwned']>;
        beforeDispatch?: GatewayProvider['assertDispatchCurrent'];
        close(): Promise<void>;
        stoppedEvidence(ownerId: string, signal: AbortSignal): Promise<string>;
      }>;
      /** Resolve the current trusted native call. Host request metadata may
       * be used to find a registration; it cannot authorize that registration. */
      resolveCall(
        headers: Readonly<IncomingHttpHeaders>,
        binding: PersonVmBinding,
        signal: AbortSignal,
      ): Promise<ModelCallBinding>;
    };
  }>;
}>;
type BoundSources = Awaited<ReturnType<ProductionPersonVmHostSources['bind']>>;

const UPGRADE_HANDOFF_MS = 30_000;
const UPGRADE_WAIT_MS = 120_000;
type UpgradeDrainReceipt = Readonly<{ stopped: number; expiresAt: string }>;

export interface ProductionPersonVmHost {
  prepareStopWithWake(
    request: PersonVmWakePreparation,
    signal: AbortSignal,
  ): Promise<PrepareStopWithWakeResult>;
  deletePersonVm(
    context: RequestContext,
    request: PlatformVmDeletionRequest,
    signal: AbortSignal,
  ): Promise<PlatformVmDeletionResult>;
  assertWorkerShutdownSafe(
    signal: AbortSignal,
    drainExpiresAt?: string,
  ): Promise<void>;
  drainForUpgrade(
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<UpgradeDrainReceipt>;
  close(): Promise<void>;
  modelOwnerMaintenancePending(): boolean;
  /** Trusted in-process maintenance only. The model authority verifies the
   * operator and independent proof of stopping this exact owner. */
  recoverModelOwner(
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<number>;
}

/** Real inert construction and narrow-port installation. Required authorities
 * must already have formal producers; missing ones leave ALL ports uninstalled.
 * This does not start a VM, create an execution or acquire a business permit. */
export function createProductionPersonVmHost(input: {
  lifetime: AbortSignal;
  sources?: ProductionPersonVmHostSources;
}): Promise<ProductionPersonVmHost> {
  if (!input.sources)
    return Promise.reject(
      new ProductionPersonVmHostUnavailable('HOST_SOURCES_UNAVAILABLE'),
    );
  const sources = input.sources;
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([input.lifetime, stopped.signal]);
  let finishConstruction: () => void = () => {
    throw Error('PERSON_VM_HOST_CONSTRUCTION_NOT_INITIALIZED');
  };
  const prepared = new Promise<void>((resolve) => {
    finishConstruction = resolve;
  });
  const pending = new Set<Promise<unknown>>();
  const receipts = new Set<PersonVmEgressReceipt>();
  const retiredReceipts = new Map<string, PersonVmEgressReceipt>();
  const ownedVms = new Map<
    string,
    {
      binding: PersonVmBinding;
      stopNative: boolean;
      idleContext?: RequestContext;
      scheduledIdleRoster?: PersonVmWebRoster;
      idleAccessOrder?: number;
    }
  >();
  let personVm: PersonVmService | undefined;
  let diskPreprovision:
    ReturnType<typeof startProductionDiskPreprovision> | undefined;
  let gracefulStop = false;
  let pauseIdle = false;
  const inspectingIdle = new Set<string>();
  let upgradeDraining = false;
  let shutdownChecking = false;
  let upgradeDrained: UpgradeDrainReceipt | undefined;
  let upgradeDrainRequested = false;
  let upgradeHandoff: ReturnType<typeof setTimeout> | undefined;
  const nativeSubscriptions = new Set<PersonVmAdmissionSubscription>();
  const uncertainPreparation = new Map<
    PersonVmBinding,
    EgressPrepareRollbackError
  >();
  const independentCloseFailures: unknown[] = [];
  const modelOwnerId = randomUUID();
  let modelRecovery:
    { providerJoined: boolean; releasedAttempts: number } | undefined;
  let recovering = false;
  let recoveredClose: { error: AggregateError | null } | undefined;
  let providers: Providers | undefined,
    current: Current | undefined,
    startup: Startup | undefined,
    bound: BoundSources | undefined,
    gateway: ReturnType<typeof createEgressGateway> | undefined,
    model: ModelGatewayPort | undefined,
    scheduledWake: ReturnType<typeof createProductionScheduledWake> | undefined,
    installed:
      ReturnType<typeof installAssignedDEntryNativeRuntime> | undefined,
    closing: Promise<void> | undefined;
  function requireGateway() {
    if (!gateway) throw new PersonVmError('EGRESS_UNAVAILABLE');
    return gateway;
  }
  function requireStartup() {
    if (!startup) throw new PersonVmError('RUNTIME_NOT_READY');
    return startup;
  }
  function requireRuntime() {
    if (!bound) throw new PersonVmError('RUNTIME_NOT_READY');
    return bound.runtime;
  }
  function own<T>(work: () => Promise<T>) {
    const operation = Promise.resolve().then(work);
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  }
  async function currentWork<T>(
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    const active = AbortSignal.any([signal, lifetime]);
    active.throwIfAborted();
    const result = await Promise.resolve()
      .then(() => {
        active.throwIfAborted();
        return work(active);
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    if ('error' in result) {
      if (active.aborted && !Object.is(result.error, active.reason))
        throw new AggregateError(
          [result.error, active.reason],
          'PERSON_VM_HOST_OPERATION_FAILED',
        );
      throw result.error;
    }
    active.throwIfAborted();
    return result.value;
  }
  function ownsRunningBinding(binding: PersonVmBinding) {
    const retired = retiredReceipts.get(binding.personId);
    return (
      Boolean(retired && sameVmBinding(retired.binding, binding)) ||
      [...receipts].some((receipt) => sameVmBinding(receipt.binding, binding))
    );
  }
  function sameReceipt(
    left: PersonVmEgressReceipt,
    right: PersonVmEgressReceipt,
  ) {
    return (
      left.bindingId === right.bindingId &&
      sameVmBinding(left.binding, right.binding) &&
      left.gatewayPorts.length === right.gatewayPorts.length &&
      left.gatewayPorts.every(
        (port, index) => port === right.gatewayPorts[index],
      )
    );
  }
  const egress: PersonVmEgressPort = {
    prepare(binding, preparation, signal) {
      return own(async () => {
        const active = AbortSignal.any([signal, lifetime]);
        active.throwIfAborted();
        const gateway = requireGateway();
        const receipt = await gateway
          .prepare(binding, preparation, active)
          .catch((error: unknown) => {
            if (error instanceof EgressPrepareRollbackError)
              uncertainPreparation.set(binding, error);
            throw error;
          });
        // A late receipt still belongs to the service cleanup. Hand it back
        // so the service can join egress before detaching its exact mount.
        receipts.add(receipt);
        return receipt;
      });
    },
    assertActive(receipt, signal) {
      return own(async () => {
        const active = AbortSignal.any([signal, lifetime]);
        active.throwIfAborted();
        await requireGateway().assertActive(receipt, active);
        active.throwIfAborted();
      });
    },
    revoke(receipt, reason, signal) {
      // Genuine service failure cleanup has its own non-aborted cleanup scope.
      // Host shutdown must not make that existing cleanup impossible.
      return own(async () => {
        await requireGateway().revoke(receipt, reason, signal);
        // The service freezes fresh copies before saving and cleanup. Remove
        // only this exact value after actual revoke succeeds, never a new epoch.
        for (const retained of receipts) {
          if (!sameReceipt(retained, receipt)) continue;
          receipts.delete(retained);
          retiredReceipts.set(retained.binding.personId, retained);
        }
      });
    },
  };
  async function collectFailures(tasks: (() => Promise<unknown>)[]) {
    const results = await Promise.allSettled(
      tasks.map((task) => Promise.resolve().then(task)),
    );
    return results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
  }
  function retireReceipts() {
    if (!gateway || !providers) return Promise.resolve([]);
    const cleanup = AbortSignal.timeout(
      providers.configuration.lifecycle.cleanupTimeoutMs,
    );
    return collectFailures(
      [...receipts].map(
        (receipt) => () => egress.revoke(receipt, 'failure', cleanup),
      ),
    );
  }
  function hasUnconfirmedPreparation(binding: PersonVmBinding) {
    return [...uncertainPreparation.keys()].some((pending) =>
      sameVmBinding(pending, binding),
    );
  }
  async function retireFailedPreparations() {
    if (!uncertainPreparation.size || !providers) return [];
    const signal = AbortSignal.timeout(
      providers.configuration.lifecycle.cleanupTimeoutMs,
    );
    return collectFailures(
      [...uncertainPreparation.keys()].map((binding) => async () => {
        await requireGateway().retireFailedPrepare(binding, signal);
        uncertainPreparation.delete(binding);
        // The unpublished prepare never reached native create/start. Retain
        // only the obligation to reconcile its mount and exact local owners.
        const vm = ownedVms.get(binding.personId);
        if (vm && sameVmBinding(vm.binding, binding)) vm.stopNative = false;
      }),
    );
  }
  async function settleSupersededBinding(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ) {
    for (const receipt of receipts)
      if (sameVmBinding(receipt.binding, binding))
        await egress.revoke(receipt, 'failure', signal);
    signal.throwIfAborted();
    if (
      hasUnconfirmedPreparation(binding) ||
      requireStartup().hasLocalOwner(binding)
    )
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    const retired = retiredReceipts.get(binding.personId);
    if (retired && sameVmBinding(retired.binding, binding))
      retiredReceipts.delete(binding.personId);
  }
  function stopOwnedVms({ deferUnconfirmedEgress = false } = {}) {
    const vm = personVm;
    if (!vm) return Promise.resolve([]);
    const targets = [...ownedVms.values()].filter(
      ({ binding }) =>
        !deferUnconfirmedEgress || !hasUnconfirmedPreparation(binding),
    );
    return collectFailures(
      targets.map(({ binding, stopNative }) => async () => {
        await vm.shutdownOwned(binding, gracefulStop ? false : stopNative);
        ownedVms.delete(binding.personId);
      }),
    );
  }
  function close(): Promise<void> {
    clearTimeout(upgradeHandoff);
    if (recoveredClose)
      return recoveredClose.error
        ? Promise.reject(recoveredClose.error)
        : Promise.resolve();
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      // Construction may be held in real I/O. Join it before taking the owner
      // snapshot; a late returned source must never escape rollback.
      await prepared;
      async function settle(tasks: (() => Promise<unknown>)[]) {
        independentCloseFailures.push(...(await collectFailures(tasks)));
      }
      // Each close fences its own ingress synchronously and joins owned work.
      const installation = installed,
        preparation = diskPreprovision,
        authorityOwner = current,
        startupOwner = startup,
        sourceOwner = bound;
      if (scheduledWake) await settle([scheduledWake.close]);
      await settle([
        ...(installation ? [() => installation.close()] : []),
        ...(preparation ? [() => preparation.close()] : []),
        ...(authorityOwner ? [() => authorityOwner.close()] : []),
        ...(sourceOwner ? [() => sourceOwner.runtime.close()] : []),
        ...[...nativeSubscriptions].map(
          (subscription) => () => subscription.close(),
        ),
      ]);
      while (pending.size) await Promise.allSettled([...pending]);
      await settle(
        [...nativeSubscriptions].map(
          (subscription) => () => subscription.close(),
        ),
      );
      let vmFailures = await stopOwnedVms();
      if (startupOwner) await settle([() => startupOwner.close()]);
      let receiptFailures = await retireReceipts();
      // Guest stop cannot prove upstream HTTP closure. Keep the ledger
      // fence until the exact dedicated dispatcher supplies its own proof.
      const modelOwner = model;
      let modelFailures = modelOwner
        ? await collectFailures([() => modelOwner.close()])
        : [];
      const transport = sourceOwner?.model.transport;
      if (transport) await settle([transport.close]);
      if (transport && modelOwner?.reconcileClosedOwner && providers) {
        const cleanup = AbortSignal.timeout(
          providers.configuration.lifecycle.cleanupTimeoutMs,
        );
        const failures = await collectFailures([
          () => modelOwner.reconcileClosedOwner!(cleanup),
        ]);
        if (failures.length) modelFailures.push(...failures);
        else {
          modelFailures = [];
          if (vmFailures.length || receiptFailures.length) {
            // A proven stopped dispatcher can release a receipt that was
            // blocked by the previously unresolved ledger.
            vmFailures = await stopOwnedVms();
            receiptFailures = await retireReceipts();
          }
        }
      }
      const providerOwner = providers;
      const installationFailures = providerOwner
        ? await collectFailures([
            () => providerOwner.egressInstallation.close(),
          ])
        : [];
      // The original pool owns both the model ledger and the physical VM
      // lease. Keep that maintenance path available when either is unresolved.
      if (
        modelFailures.length ||
        vmFailures.length ||
        receiptFailures.length ||
        installationFailures.length ||
        uncertainPreparation.size
      )
        modelRecovery = { providerJoined: false, releasedAttempts: 0 };
      if (sourceOwner && !modelRecovery)
        await settle([() => sourceOwner.egress.close()]);
      input.lifetime.removeEventListener('abort', aborted);
      const errors = [
        ...independentCloseFailures,
        ...uncertainPreparation.values(),
        ...vmFailures,
        ...receiptFailures,
        ...installationFailures,
        ...modelFailures,
      ];
      if (errors.length)
        throw new AggregateError(errors, 'PERSON_VM_HOST_CLOSE_INCOMPLETE');
    });
    stopped.abort(new ProductionPersonVmHostUnavailable('HOST_CLOSED'));
    return closing;
  }
  const aborted = () => {
    void close().catch(() => {});
  };
  async function recoverModelOwner(
    context: RequestContext,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const originalClose = closing;
    const modelOwner = model;
    const sourceOwner = bound;
    if (!originalClose || !modelOwner || !sourceOwner || recovering)
      throw new ProductionPersonVmHostUnavailable('MODEL_RECOVERY_UNAVAILABLE');
    // Set synchronously: a concurrent request cannot borrow this operator's
    // credential check or trigger a second provider close.
    recovering = true;
    try {
      await originalClose.catch(() => {});
      signal.throwIfAborted();
      const recovery = modelRecovery;
      if (!recovery)
        throw new ProductionPersonVmHostUnavailable(
          'MODEL_RECOVERY_UNAVAILABLE',
        );
      recovery.releasedAttempts += await modelOwner.reconcileOwner(
        context,
        modelOwnerId,
        signal,
      );
      await modelOwner.close();
      // Once the stop proof has been accepted, join cleanup even if the
      // maintenance request disconnects or the Worker lifetime has ended.
      const prepareFailures = await retireFailedPreparations();
      const vmFailures = await stopOwnedVms({ deferUnconfirmedEgress: true });
      const receiptFailures = await retireReceipts();
      const providerOwner = providers;
      const installationFailures = providerOwner
        ? await collectFailures([
            () => providerOwner.egressInstallation.close(),
          ])
        : [];
      const sourceFailures = recovery.providerJoined
        ? []
        : await collectFailures([
            async () => {
              await sourceOwner.egress.close();
              recovery.providerJoined = true;
            },
          ]);
      const errors = [
        ...independentCloseFailures,
        ...uncertainPreparation.values(),
        ...prepareFailures,
        ...vmFailures,
        ...receiptFailures,
        ...installationFailures,
        ...sourceFailures,
      ];
      if (
        !uncertainPreparation.size &&
        !prepareFailures.length &&
        !vmFailures.length &&
        !receiptFailures.length &&
        !installationFailures.length &&
        !sourceFailures.length
      )
        modelRecovery = undefined;
      const error = errors.length
        ? new AggregateError(errors, 'PERSON_VM_HOST_CLOSE_INCOMPLETE')
        : null;
      recoveredClose = { error };
      if (error) throw error;
      return recovery.releasedAttempts;
    } finally {
      recovering = false;
    }
  }
  input.lifetime.addEventListener('abort', aborted, { once: true });
  const construction = (async () => {
    try {
      lifetime.throwIfAborted();
      let capacityStore: PostgresPersonVmStore | undefined;
      providers = await createProductionPersonVmProviders(
        lifetime,
        async ({ binding, memoryMiB }, signal) => {
          const store = capacityStore;
          if (!store || providers?.platform.memoryMiB !== memoryMiB)
            throw new PersonVmError('RUNTIME_NOT_READY');
          const assertCurrent = async (
            request: { binding: PersonVmBinding; memoryMiB: number },
            active: AbortSignal,
          ) => {
            if (
              request.memoryMiB !== memoryMiB ||
              !sameVmBinding(request.binding, binding)
            )
              throw new PersonVmError('LEASE_LOST');
            active.throwIfAborted();
            const row = await store.read(binding.personId);
            active.throwIfAborted();
            if (
              !row?.leaseOwner ||
              row.phase !== 'starting' ||
              !sameVmBinding(
                {
                  vmId: row.vmId,
                  personId: row.personId,
                  organizationId: row.organizationId,
                  instanceId: row.instanceId!,
                  leaseEpoch: row.leaseEpoch,
                },
                binding,
              )
            )
              throw new PersonVmError('LEASE_LOST');
          };
          await assertCurrent({ binding, memoryMiB }, signal);
          // The durable starting row is already charged. This exact guard is
          // the transfer to running: neither AbortSignal nor TTL frees the row.
          return {
            signal: lifetime,
            assertCurrent,
            commitRunning: assertCurrent,
          };
        },
      );
      lifetime.throwIfAborted();
      current = createProductionPersonVmAuthority(lifetime);
      // The shared client supplies trusted connection options only. Every
      // actual store/admission operation opens its own dedicated SQL client.
      const trustedDatabase = getDatabase();
      const wakeStore =
        createPostgresPersonVmScheduledWakeStore(trustedDatabase);
      const assertNoCommittedWake = async (signal: AbortSignal) => {
        const wakeAt = await (scheduledWake ?? wakeStore).nextCommittedWakeAt(
          signal,
        );
        signal.throwIfAborted();
        // Snapshot, migration and restarting a release have no hard bound.
        // Keep the current scheduler responsible for any committed wake.
        if (wakeAt !== null) throw new PersonVmError('ACTIVITY_UNKNOWN');
      };
      const openSql = () => createDedicatedDatabase(trustedDatabase);
      const storeModel = createPostgresModelGatewayStore(trustedDatabase);
      const budget = providers.configuration.lifecycle.hostVmBudgetMiB;
      if (budget !== undefined && budget * 1024 ** 2 > totalmem())
        throw new PersonVmError('PROVIDER_FAILED');
      // Existing VM rows do not record their launch cap. Charge the maximum
      // supported guest size plus overhead through confirmed physical release.
      const store =
        budget === undefined
          ? new PostgresPersonVmStore(openSql)
          : new PostgresPersonVmStore(
              openSql,
              undefined,
              Math.floor(budget / (4096 + 512)),
            );
      if (budget !== undefined) capacityStore = store;
      const diskRoot = providers.configuration.disk.root;
      const diskPool = new PersonVmDiskPool(
        diskRoot,
        store.diskPoolLocks(diskRoot),
        (event) => console.warn('[person-vm.disk-pool]', event),
        providers.diskPool,
      );
      const runtime: PersonVmRuntimePort = {
        memoryGuestPlan: (...args) => requireStartup().memoryGuestPlan(...args),
        start: (...args) => requireStartup().start(...args),
        retireAfterNativeStop: (...args) =>
          requireStartup().retireAfterNativeStop(...args),
        assertScheduledReady: async (binding, signal) => {
          requireStartup().assertAuthenticatedGroup(binding, signal);
        },
        readiness: (binding, signal, context) =>
          own(() =>
            currentWork(signal, async (active) => {
              const native = requireStartup();
              native.assertAuthenticatedGroup(binding, active);
              if (context)
                await native.prepareForegroundEditor(binding, context, active);
              const readiness = await requireRuntime().readiness(
                binding,
                active,
              );
              native.assertAuthenticatedGroup(binding, active);
              return readiness;
            }),
          ),
        activity: (binding, signal) =>
          own(() =>
            currentWork(signal, (active) =>
              requireRuntime().activity(binding, active),
            ),
          ),
      };
      const vm = new PersonVmService({
        authorizePlatformDeletion: authorizeProductionPersonVmDeletion,
        store,
        authority: current.authority,
        native: providers.native,
        ...(budget !== undefined && { nativeCapacityAccounting: true }),
        disk: providers.disk,
        diskPool,
        nativeWeb: personNativeWebRoster,
        runtime,
        egress,
        observeOwnedStart(binding, context) {
          ownedVms.set(binding.personId, {
            binding: Object.freeze({ ...binding }),
            stopNative: true,
            ...(context &&
              providers!.configuration.lifecycle.idleStopEnabled === true && {
                idleContext: structuredClone(context),
              }),
          });
        },
        ...(providers.configuration.lifecycle.idleStopEnabled === true && {
          observeScheduledStart(
            binding: PersonVmBinding,
            roster: PersonVmWebRoster,
          ) {
            const entry = ownedVms.get(binding.personId);
            if (entry?.stopNative && sameVmBinding(entry.binding, binding))
              entry.scheduledIdleRoster = structuredClone(roster);
          },
          observeOwnedAccess(
            binding: PersonVmBinding,
            context: RequestContext,
            order: number,
          ) {
            const entry = ownedVms.get(binding.personId);
            if (
              entry?.stopNative &&
              sameVmBinding(entry.binding, binding) &&
              order > (entry.idleAccessOrder ?? 0)
            ) {
              entry.idleContext = structuredClone(context);
              entry.idleAccessOrder = order;
            }
          },
        }),
        observeOwnedMount(binding) {
          const existing = ownedVms.get(binding.personId);
          if (
            existing?.binding.vmId === binding.vmId &&
            existing.binding.leaseEpoch >= binding.leaseEpoch
          )
            return;
          ownedVms.set(binding.personId, {
            binding: Object.freeze({ ...binding }),
            stopNative: false,
          });
        },
        observeOwnedStop(binding) {
          const entry = ownedVms.get(binding.personId);
          if (entry && sameVmBinding(entry.binding, binding))
            ownedVms.delete(binding.personId);
          const retired = retiredReceipts.get(binding.personId);
          if (retired && sameVmBinding(retired.binding, binding))
            retiredReceipts.delete(binding.personId);
        },
        ownsEgressReceipt(receipt) {
          const retired = retiredReceipts.get(receipt.binding.personId);
          if (retired && sameReceipt(retired, receipt)) return true;
          for (const retained of receipts)
            if (sameReceipt(retained, receipt)) return true;
          return false;
        },
        hasUnconfirmedEgress(binding) {
          return [...uncertainPreparation.keys()].some(
            (pending) =>
              pending.vmId === binding.vmId &&
              pending.personId === binding.personId &&
              pending.organizationId === binding.organizationId,
          );
        },
        settleSupersededBinding,
        upgradeActivity: {
          observe(binding, signal, purpose) {
            return currentWork(signal, (active) => {
              if (!bound?.nativeActivity)
                throw new PersonVmError('ACTIVITY_UNKNOWN');
              return bound.nativeActivity.observe(binding, active, purpose);
            });
          },
          assertSampleCurrent(binding, cursor, active) {
            if (!bound?.nativeActivity?.assertSampleCurrent)
              throw new PersonVmError('ACTIVITY_UNKNOWN');
            bound.nativeActivity.assertSampleCurrent(binding, cursor, active);
          },
        },
        async withPreviousGatewayFenced(binding, ports, signal, stop) {
          if (
            ownsRunningBinding(binding) ||
            requireStartup().hasLocalOwner(binding)
          )
            throw new PersonVmError('LEASE_CONFLICT');
          const address = providers!.configuration.egress?.listenAddress;
          if (!address) throw new PersonVmError('EGRESS_UNAVAILABLE');
          await assertNoPreviousWorker(diskRoot, signal);
          return withPreviousGatewayFenced(address, ports, signal, async () => {
            if (
              ownsRunningBinding(binding) ||
              requireStartup().hasLocalOwner(binding)
            )
              throw new PersonVmError('LEASE_CONFLICT');
            await assertNoPreviousWorker(diskRoot, signal);
            return stop();
          });
        },
        ...providers.configuration.lifecycle,
      });
      personVm = vm;
      const { native, web } = providers.configuration;
      startup = createAssignedNativeWebStartup({
        vm,
        memoryGuestPlan: providers.memoryGuestPlan,
        commandMemory: {
          controls: native.readonlyCommandMemoryDirectory,
          readonlyDshDirectory: native.readonlyDshDirectory.guestDirectory,
        },
        async readEmployeeProfile(active) {
          if (
            !web.cliPath.startsWith(
              native.readonlyDshDirectory.guestDirectory + '/',
            )
          )
            throw new PersonVmError('PROVIDER_FAILED');
          return readReleasedGuestProfile(
            await readWorkerEmployeeWebSeal(active),
            active,
          );
        },
        configuration: {
          ...providers.configuration.web,
          publicUrl: (endpoint) =>
            dEntryNativePublicUrl(web.publicOrigin, endpoint),
        },
        lifetime,
        cleanupTimeoutMs: providers.configuration.lifecycle.cleanupTimeoutMs,
      });
      const scheduledIdleAuthority: PersonVmScheduledIdleAuthority = {
        assertOwned(binding, roster) {
          const owner = ownedVms.get(binding.personId);
          if (
            !owner?.stopNative ||
            !sameVmBinding(owner.binding, binding) ||
            owner.scheduledIdleRoster !== roster
          )
            throw new PersonVmError('AUTHORIZATION_DENIED');
          lifetime.throwIfAborted();
        },
        async assertCurrent(binding, roster, signal) {
          if (!scheduledWake) throw new PersonVmError('RUNTIME_NOT_READY');
          await scheduledWake.assertScheduledIdleCurrent(
            binding,
            roster,
            signal,
          );
        },
        async dispatch(binding, roster, requestId, signal, stop) {
          this.assertOwned(binding, roster);
          if (!scheduledWake) throw new PersonVmError('RUNTIME_NOT_READY');
          await scheduledWake.dispatchScheduledIdleStop(
            binding,
            roster,
            requestId,
            signal,
            (active) => {
              this.assertOwned(binding, roster);
              return stop(active);
            },
          );
        },
      };
      const admission = vm.createAdmissionHost({
        openSql,
        idleMs: providers.platform.idleMs,
        ...(providers.configuration.lifecycle.idleStopEnabled === true && {
          scheduledIdleAuthority,
          async prepareIdleStop(request, signal) {
            const wake = scheduledWake;
            if (!wake) return { blocked: true };
            if (!('context' in request))
              return wake.prepareStopWithWake(request, signal);

            const { binding, context } = request;
            const roster = await readPersonNativeWebRoster(
              context,
              trustedDatabase,
            );
            signal.throwIfAborted();
            const plan = await wake.prepareStopWithWake(request, signal);
            if ('blocked' in plan) return plan;
            return {
              ...plan,
              dispatch: (active, stop) =>
                wake.dispatchScheduledIdleStop(
                  binding,
                  roster,
                  context.requestId,
                  active,
                  stop,
                  async (tx, checking) => {
                    if (
                      !context.sessionId ||
                      !(await readContentPrincipal(context, tx, true))
                    )
                      throw new PersonVmError('AUTHORIZATION_DENIED');
                    checking.throwIfAborted();
                  },
                ),
            };
          },
        }),
        nativeActivity: {
          observe(binding, signal, purpose) {
            return own(() =>
              currentWork(signal, async (active) => {
                if (!bound?.nativeActivity)
                  throw new PersonVmError('ACTIVITY_UNKNOWN');
                return bound.nativeActivity.observe(binding, active, purpose);
              }),
            );
          },
          assertSampleCurrent(binding, cursor, signal) {
            if (!bound?.nativeActivity?.assertSampleCurrent)
              throw new PersonVmError('ACTIVITY_UNKNOWN');
            bound.nativeActivity.assertSampleCurrent(
              binding,
              cursor,
              AbortSignal.any([signal, lifetime]),
            );
          },
          subscribe(binding, signal) {
            return own(async () => {
              const active = AbortSignal.any([signal, lifetime]);
              active.throwIfAborted();
              if (!bound?.nativeActivity)
                throw new PersonVmError('ACTIVITY_UNKNOWN');
              const subscription = await bound.nativeActivity.subscribe(
                binding,
                active,
              );
              nativeSubscriptions.add(subscription);
              if (active.aborted) {
                try {
                  await subscription.close();
                } catch (cleanup) {
                  throw new AggregateError(
                    [active.reason, cleanup],
                    'PERSON_VM_HOST_SUBSCRIPTION_CLOSE_FAILED',
                  );
                }
                nativeSubscriptions.delete(subscription);
                active.throwIfAborted();
              }
              return subscription;
            });
          },
        },
      });
      bound = await sources.bind({
        vm,
        admission,
        startup,
        current,
        providers,
        lifetime,
        modelOwnerId,
        async issueReference(call, signal, issue) {
          if (!model?.issueReference)
            throw new ProductionPersonVmHostUnavailable(
              'HOST_SOURCES_UNAVAILABLE',
            );
          return model.issueReference(call, signal, issue);
        },
        async reserveNativeModelCall(call) {
          if (!storeModel.reserveNativeCall)
            throw new Error('MODEL_CALL_AUTHORIZATION_STORE_UNAVAILABLE');
          await storeModel.reserveNativeCall(call);
        },
      });
      lifetime.throwIfAborted();
      const modelSource = bound.model;
      const egressSource = bound.egress;
      const modelRoute = Object.freeze({ ...modelSource.route });
      const modelOwner = createModelGateway({
        ownerId: modelOwnerId,
        authority: modelSource.authority,
        provider: createDshGatewayProvider(
          modelSource.llm,
          modelRoute,
          modelSource.transport?.fetchOwned,
          modelSource.transport?.beforeDispatch,
          modelSource.scopeStream,
        ),
        store: storeModel,
        confirmTransportStopped: modelSource.transport?.stoppedEvidence,
        admission: {
          boundary: admission,
          participant: admission.participant('gateway'),
          recoverStoppedPermit: (permit, signal) =>
            admission.recoverStoppedGatewayPermit(permit, signal),
        },
      });
      model = modelOwner;
      const modelService: ManagedHostService = {
        id: 'model',
        path: '/v1/stream',
        method: 'POST',
        admissionOwner: 'service',
        async resolve(request, binding, signal) {
          signal.throwIfAborted();
          const call = structuredClone(
            await modelSource.resolveCall(request.headers, binding, signal),
          );
          signal.throwIfAborted();
          if (
            !sameVmBinding(call.vm, binding) ||
            call.provider !== modelRoute.provider ||
            call.model !== modelRoute.model ||
            call.context.actor.type !== 'user' ||
            call.context.actor.id !== binding.personId ||
            call.context.organizationId !== binding.organizationId
          )
            throw new EgressError('DENIED');
          // Egress checks this call's actual current context before dispatch.
          // Freeze the shared context across policy and the actual dispatch.
          Object.freeze(call.context.actor);
          for (const membership of call.context.memberships)
            Object.freeze(membership);
          Object.freeze(call.context.memberships);
          Object.freeze(call.context);
          Object.freeze(call.vm);
          Object.freeze(call.execution);
          Object.freeze(call.native);
          egressSource.bindModelCall?.(Object.freeze(call), signal);
          return {
            context: call.context,
            dispatch: (response, active) =>
              modelOwner.handle(request, response, call, active),
          };
        },
      };
      // The same shared boundary owns all egress calls. Sources may never
      // replace it or supply a different VM/store/connection factory.
      const vmCleanupTimeoutMs =
        providers.configuration.lifecycle.cleanupTimeoutMs;
      gateway = createEgressGateway({
        vm,
        prepareRollbackSignal: () => AbortSignal.timeout(vmCleanupTimeoutMs),
        admission,
        authority: egressSource.authority,
        policy: egressSource.policy,
        transport: createPublicHttpsTransport(),
        lifetime,
        async revokeModel(binding, active) {
          await modelOwner.revoke(binding);
          active.throwIfAborted();
        },
        services: [...(egressSource.services ?? []), modelService],
        provisioner: providers.egressInstallation.provisioner,
      });
      lifetime.throwIfAborted();
      installed = installAssignedDEntryNativeRuntime({
        vm,
        startup,
        lifetime,
        prewarmCurrent: createProductionCurrentPrewarm({ vm, current }),
        ownsRunningBinding,
      });
      lifetime.throwIfAborted();
      if (bound.scheduledWake) {
        const wake = createProductionScheduledWake({
          startup,
          database: trustedDatabase,
          source: bound.scheduledWake,
          minimumLeadMs: getIdleScheduleGuardMs(
            providers.configuration.lifecycle,
          ),
          lifetime,
        });
        scheduledWake = wake;
        wake.start();
      }
      if (
        providers.configuration.lifecycle.idleStopEnabled === true &&
        bound.nativeActivity &&
        scheduledWake
      ) {
        const period =
          providers.configuration.lifecycle.idleSampleIntervalMs ??
          DEFAULT_IDLE_SAMPLE_INTERVAL_MS;
        void own(async () => {
          let slot = Math.floor(performance.now() / period);
          while (!lifetime.aborted) {
            const delay = Math.max(
              1,
              Math.ceil((slot + 1) * period - performance.now()),
            );
            await sleep(delay, undefined, { signal: lifetime, ref: false });
            const current = Math.floor(performance.now() / period);
            if (current <= slot) continue;
            slot = current;
            if (pauseIdle) continue;
            // Each VM owns its own in-flight inspection. A stalled read
            // leaves a gap for that VM without delaying the other clocks.
            for (const {
              binding,
              idleContext,
              scheduledIdleRoster,
            } of ownedVms.values()) {
              if (inspectingIdle.has(binding.personId)) continue;
              inspectingIdle.add(binding.personId);
              void own(async () => {
                try {
                  if (pauseIdle || lifetime.aborted) return;
                  const active = AbortSignal.any([
                    lifetime,
                    AbortSignal.timeout(IDLE_RECONCILE_TIMEOUT_MS),
                  ]);
                  if (scheduledIdleRoster)
                    await admission.reconcileScheduledIdle(
                      binding,
                      scheduledIdleRoster,
                      active,
                    );
                  else if (idleContext)
                    await admission.reconcileIdle(
                      { ...idleContext, requestId: randomUUID() },
                      binding,
                      active,
                    );
                } catch (error) {
                  if (!lifetime.aborted && !(error instanceof PersonVmError))
                    console.error('[person-vm] idle reconciliation failed');
                } finally {
                  inspectingIdle.delete(binding.personId);
                }
              });
            }
          }
        }).catch((error: unknown) => {
          if (!lifetime.aborted)
            console.error('[person-vm] idle owner failed', error);
        });
      }
      void own(async () => {
        const reported = new Set<string>();
        while (!lifetime.aborted) {
          await sleep(60_000, undefined, { signal: lifetime, ref: false });
          try {
            const active = AbortSignal.any([
              lifetime,
              AbortSignal.timeout(3000),
            ]);
            const running = await store.listUpgradeCandidates(active);
            const unknown = new Set<string>();
            for (const row of running) {
              if (
                row.phase !== 'running' ||
                !row.instanceId ||
                ownsRunningBinding({
                  personId: row.personId,
                  organizationId: row.organizationId,
                  vmId: row.vmId,
                  instanceId: row.instanceId,
                  leaseEpoch: row.leaseEpoch,
                })
              )
                continue;
              const key = row.vmId + ':' + row.leaseEpoch;
              unknown.add(key);
              if (!reported.has(key))
                console.warn(
                  '[person-vm] previous VM activity unconfirmed; awaiting employee open',
                  {
                    vmId: row.vmId,
                    leaseEpoch: row.leaseEpoch,
                  },
                );
              reported.add(key);
            }
            for (const key of reported)
              if (!unknown.has(key)) reported.delete(key);
          } catch {
            if (!lifetime.aborted)
              console.warn('[person-vm] previous VM inventory unavailable');
          }
        }
      }).catch(() => {}); // Host close aborts and joins the inventory loop.
      const { disk } = providers.configuration;
      if (disk.preprovision?.enabled) {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) throw Error('DATABASE_URL is required');
        diskPreprovision = startProductionDiskPreprovision({
          lifetime,
          openFeed: () => createDEntryAuthorityFeed(databaseUrl),
          readRoster: readPersonVmDiskPreparationRoster,
          readTarget: readPersonVmDiskPreparationTarget,
          foregroundBusy: readPersonVmDiskPreparationForegroundBusy,
          refill: (signal) => diskPool.refill(signal),
          availableBytes: (signal) => diskPool.availableBytes(signal),
          minimumFreeBytes: disk.preprovision.minimumFreeBytes,
          reserveBytes: disk.preprovision.reserveBytes,
          port: vm.diskPreparationPort(),
          observe: (event) =>
            console.warn('[person-vm.disk-preprovision]', event),
        });
      }
      return Object.freeze({
        async prepareStopWithWake(
          request: PersonVmWakePreparation,
          signal: AbortSignal,
        ) {
          const active = AbortSignal.any([signal, lifetime]);
          active.throwIfAborted();
          if (!scheduledWake)
            return {
              blocked: true,
              reason: 'SCHEDULE_WAKE_UNAVAILABLE',
            } as const;
          return scheduledWake.prepareStopWithWake(request, active);
        },
        async drainForUpgrade(context: RequestContext, signal: AbortSignal) {
          const active = AbortSignal.any([signal, lifetime]);
          active.throwIfAborted();
          const authorize = async (current: AbortSignal) => {
            current.throwIfAborted();
            await requireCurrentPlatformAdmin(context, trustedDatabase, false);
            current.throwIfAborted();
          };
          await authorize(active);
          if (upgradeDraining || shutdownChecking || gracefulStop)
            throw new PersonVmError('LEASE_CONFLICT');
          if (upgradeDrained) {
            const receipt = upgradeDrained;
            await assertNoCommittedWake(active);
            if ((await store.listUpgradeCandidates(active)).length)
              throw new PersonVmError('CLEANUP_INCOMPLETE');
            if (
              upgradeDrained !== receipt ||
              Date.now() >= Date.parse(receipt.expiresAt)
            )
              throw new PersonVmError('RUNTIME_NOT_READY');
            return receipt;
          }
          upgradeDraining = true;
          upgradeDrainRequested = true;
          pauseIdle = true;
          let reopen: (() => void) | undefined;
          const resume = () => {
            upgradeDrained = undefined;
            pauseIdle = false;
            reopen?.();
            scheduledWake?.resume();
          };
          try {
            // An older idle inspection can still publish its wake after
            // dispatch. Let it finish with the scheduler running.
            if (inspectingIdle.size)
              throw new PersonVmError('ACTIVITY_UNKNOWN');
            await assertNoCommittedWake(active);
            await scheduledWake?.pause(active);
            // Join an already claimed wake before fencing the next startup.
            // The new gate must not strand a claim staged in the next epoch.
            reopen = vm.fenceWorkerStartup();
            await assertNoCommittedWake(active);
            const deadline = AbortSignal.any([
              active,
              AbortSignal.timeout(UPGRADE_WAIT_MS),
            ]);
            let candidates = await store.listUpgradeCandidates(deadline);
            while (
              candidates.some(
                (row) => row.phase === 'starting' || !row.instanceId,
              )
            ) {
              await assertNoCommittedWake(deadline);
              await sleep(1000, undefined, { signal: deadline, ref: false });
              candidates = await store.listUpgradeCandidates(deadline);
            }
            for (const row of candidates) {
              if (!row.instanceId) throw new PersonVmError('LEASE_LOST');
              const binding = {
                vmId: row.vmId,
                personId: row.personId,
                organizationId: row.organizationId,
                instanceId: row.instanceId,
                leaseEpoch: row.leaseEpoch,
              };
              const drain = () =>
                vm.stopRunningForUpgrade(
                  binding,
                  randomUUID(),
                  deadline,
                  authorize,
                  async (request, reading) => {
                    const wake = scheduledWake;
                    if (!wake) throw new PersonVmError('ACTIVITY_UNKNOWN');
                    await request.assertStopCurrent(reading);
                    const catalogs = requireStartup().activityCatalogs(
                      request.binding,
                      reading,
                    );
                    const roster = await trustedDatabase.begin(
                      'isolation level repeatable read read only',
                      (tx) =>
                        readPersonVmWakeRoster(
                          tx,
                          request.binding,
                          catalogs.map(({ endpoint }) => endpoint),
                        ),
                    );
                    reading.throwIfAborted();
                    if (!roster)
                      throw new PersonVmError('AUTHORIZATION_DENIED');
                    const plan = await wake.prepareUpgradeStop(
                      { ...request, scheduledRoster: roster },
                      reading,
                    );
                    if (!('ok' in plan))
                      throw new PersonVmError('ACTIVITY_UNKNOWN');
                    if (plan.nextWakeAt !== null)
                      throw new PersonVmError('RUNTIME_NOT_READY');
                    return {
                      nextWakeAt: plan.nextWakeAt,
                      scheduleFingerprints: plan.scheduleFingerprints,
                      dispatch: (checking, stop) =>
                        wake.dispatchUpgradeStop(
                          request.binding,
                          roster,
                          request.requestId,
                          checking,
                          stop,
                          async (tx, fenced) => {
                            await requireCurrentPlatformAdmin(context, tx);
                            fenced.throwIfAborted();
                          },
                        ),
                    };
                  },
                );
              for (;;) {
                deadline.throwIfAborted();
                await authorize(deadline);
                await assertNoCommittedWake(deadline);
                try {
                  await drain();
                  break;
                } catch (error) {
                  if (
                    !(error instanceof PersonVmError) ||
                    ![
                      'VM_ACTIVE',
                      'ACTIVITY_UNKNOWN',
                      'LEASE_CONFLICT',
                    ].includes(error.code) ||
                    deadline.aborted
                  )
                    throw error;
                  await assertNoCommittedWake(deadline);
                  await sleep(1000, undefined, {
                    signal: deadline,
                    ref: false,
                  });
                }
              }
              // A joined stop can publish a wake while it is recovered.
              await assertNoCommittedWake(deadline);
            }
            if ((await store.listUpgradeCandidates(active)).length)
              throw new PersonVmError('CLEANUP_INCOMPLETE');
            // Recovery of a joined stop can publish a previously invisible
            // wake without preparing a plan during this drain attempt.
            await assertNoCommittedWake(active);
            const receipt = Object.freeze({
              stopped: candidates.length,
              expiresAt: new Date(
                Date.now() + UPGRADE_HANDOFF_MS,
              ).toISOString(),
            });
            upgradeHandoff = setTimeout(resume, UPGRADE_HANDOFF_MS).unref();
            return (upgradeDrained = receipt);
          } finally {
            upgradeDraining = false;
            if (!upgradeDrained) resume();
          }
        },
        deletePersonVm(
          context: RequestContext,
          request: PlatformVmDeletionRequest,
          signal: AbortSignal,
        ) {
          return own(() =>
            vm.deleteForPlatform(
              context,
              request,
              AbortSignal.any([signal, lifetime]),
            ),
          );
        },
        async assertWorkerShutdownSafe(
          signal: AbortSignal,
          drainExpiresAt?: string,
        ) {
          signal.throwIfAborted();
          if (
            drainExpiresAt !== undefined &&
            upgradeDrained?.expiresAt !== drainExpiresAt
          )
            throw new PersonVmError('RUNTIME_NOT_READY');
          if (gracefulStop) return;
          if (upgradeDraining || shutdownChecking)
            throw new PersonVmError('LEASE_CONFLICT');
          if (upgradeDrained) {
            // A signal may complete an already claimed shutdown. It cannot
            // consume a release receipt before the launcher records its intent.
            if (drainExpiresAt === undefined)
              throw new PersonVmError('RUNTIME_NOT_READY');
            shutdownChecking = true;
            const receipt = upgradeDrained;
            try {
              if ((await store.listUpgradeCandidates(signal)).length)
                throw new PersonVmError('CLEANUP_INCOMPLETE');
              await assertNoCommittedWake(signal);
              if (
                upgradeDrained !== receipt ||
                Date.now() >= Date.parse(receipt.expiresAt)
              )
                throw new PersonVmError('RUNTIME_NOT_READY');
              clearTimeout(upgradeHandoff);
              gracefulStop = true;
              return;
            } finally {
              shutdownChecking = false;
            }
          }
          // An expired or failed release attempt cannot be treated as an
          // ordinary process shutdown and bypass the whole-host drain.
          if (upgradeDrainRequested)
            throw new PersonVmError('RUNTIME_NOT_READY');
          shutdownChecking = true;
          pauseIdle = true;
          const reopen = vm.fenceWorkerStartup();
          try {
            if (inspectingIdle.size)
              throw new PersonVmError('ACTIVITY_UNKNOWN');
            await assertNoCommittedWake(signal);
            await scheduledWake?.pause(signal);
            signal.throwIfAborted();
            for (const { binding } of ownedVms.values())
              await vm.assertWorkerShutdownSafe(binding, signal);
            await assertNoCommittedWake(signal);
            gracefulStop = true;
          } catch (error) {
            pauseIdle = false;
            reopen();
            scheduledWake?.resume();
            throw error;
          } finally {
            shutdownChecking = false;
          }
        },
        close,
        recoverModelOwner,
        modelOwnerMaintenancePending: () =>
          modelRecovery !== undefined || uncertainPreparation.size > 0,
      });
    } finally {
      finishConstruction();
    }
  })();
  return construction.catch(async (primary: unknown) => {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [primary, cleanup],
        'PERSON_VM_HOST_CONSTRUCTION_FAILED',
      );
    }
    if (primary instanceof ProductionHostConfigurationUnavailable)
      throw new ProductionPersonVmHostUnavailable(
        'HOST_CONFIGURATION_UNAVAILABLE',
      );
    if (primary instanceof ProductionPersonVmArtifactsUnavailable)
      throw new ProductionPersonVmHostUnavailable(
        'PERSON_VM_ARTIFACTS_UNAVAILABLE',
      );
    throw primary;
  });
}
