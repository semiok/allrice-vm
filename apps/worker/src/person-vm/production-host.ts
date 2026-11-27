import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { RequestContext } from '@allrice/contracts';
import {
  createDedicatedDatabase,
  createDEntryAuthorityFeed,
  getDatabase,
  readPersonVmDiskPreparationForegroundBusy,
  readPersonVmDiskPreparationRoster,
  readPersonVmDiskPreparationTarget,
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
  type PlatformVmDeletionRequest,
  type PlatformVmDeletionResult,
} from '@allrice/person-vm';
import { installAssignedDEntryNativeRuntime } from '../business-runtime/native-prewarm.js';
import {
  primeWorkerEmployeeWebRelease,
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
import { createProductionPersonVmProviders } from './production-providers.js';
import { ProductionHostConfigurationUnavailable } from './production-config.js';
import { ProductionPersonVmArtifactsUnavailable } from './production-artifacts.js';

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
      selectProvider?(binding: ModelCallBinding): GatewayProvider;
      closeTransport?(): Promise<void>;
      confirmTransportStopped?(
        ownerId: string,
        signal: AbortSignal,
      ): Promise<string>;
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

export interface ProductionPersonVmHost {
  deletePersonVm(
    context: RequestContext,
    request: PlatformVmDeletionRequest,
    signal: AbortSignal,
  ): Promise<PlatformVmDeletionResult>;
  assertWorkerShutdownSafe(signal: AbortSignal): Promise<void>;
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
    { binding: PersonVmBinding; stopNative: boolean }
  >();
  let personVm: PersonVmService | undefined;
  let diskPreprovision:
    ReturnType<typeof startProductionDiskPreprovision> | undefined;
  let gracefulStop = false;
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
      const closeTransport =
        sourceOwner?.model.closeTransport ??
        sourceOwner?.model.transport?.close;
      if (closeTransport) await settle([closeTransport]);
      if (closeTransport && modelOwner?.reconcileClosedOwner && providers) {
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
      providers = await createProductionPersonVmProviders(lifetime);
      await primeWorkerEmployeeWebRelease(lifetime);
      lifetime.throwIfAborted();
      current = createProductionPersonVmAuthority(lifetime);
      // The shared client supplies trusted connection options only. Every
      // actual store/admission operation opens its own dedicated SQL client.
      const trustedDatabase = getDatabase();
      const openSql = () => createDedicatedDatabase(trustedDatabase);
      const storeModel = createPostgresModelGatewayStore(trustedDatabase);
      const store = new PostgresPersonVmStore(openSql);
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
        readiness: (binding, signal) =>
          own(() =>
            currentWork(signal, async (active) => {
              const native = requireStartup();
              native.assertAuthenticatedGroup(binding, active);
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
        disk: providers.disk,
        diskPool,
        nativeWeb: personNativeWebRoster,
        runtime,
        egress,
        observeOwnedStart(binding) {
          ownedVms.set(binding.personId, {
            binding: Object.freeze({ ...binding }),
            stopNative: true,
          });
        },
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
      const admission = vm.createAdmissionHost({
        openSql,
        idleMs: providers.platform.idleMs,
        nativeActivity: {
          observe(binding, signal) {
            return own(() =>
              currentWork(signal, async (active) => {
                if (!bound?.nativeActivity)
                  throw new PersonVmError('ACTIVITY_UNKNOWN');
                return bound.nativeActivity.observe(binding, active);
              }),
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
        provider:
          modelSource.selectProvider ??
          createDshGatewayProvider(
            modelSource.llm,
            modelRoute,
            modelSource.transport?.fetchOwned,
            modelSource.transport?.beforeDispatch,
            modelSource.scopeStream,
          ),
        store: storeModel,
        confirmTransportStopped:
          modelSource.confirmTransportStopped ??
          modelSource.transport?.stoppedEvidence,
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
            (!modelSource.selectProvider &&
              (call.provider !== modelRoute.provider ||
                call.model !== modelRoute.model)) ||
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
      });
      lifetime.throwIfAborted();
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
        async assertWorkerShutdownSafe(signal: AbortSignal) {
          if (gracefulStop) return;
          const reopen = vm.fenceWorkerStartup();
          try {
            for (const { binding } of ownedVms.values())
              await vm.assertWorkerShutdownSafe(binding, signal);
            gracefulStop = true;
          } catch (error) {
            reopen();
            throw error;
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
