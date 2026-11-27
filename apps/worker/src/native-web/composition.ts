import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type {
  PersonVmBinding,
  PersonVmBootstrapScope,
  PersonVmGuestBootstrapPort,
  PersonVmPort,
  PersonVmRuntimePort,
  PersonVmWebEndpointReceipt,
  PersonVmWebStartup,
  PersonVmWebRosterPort,
  ReadonlyCommandMemoryDirectory,
} from '@allrice/person-vm';
import {
  NativeWebGuestLaunchUnacknowledged,
  PersonVmError,
  sameVmBinding,
} from '@allrice/person-vm';
import {
  preparePersonNativeWebRoster,
  readPersonNativeWebRoster,
  type confirmDEntryEmployeeArchive,
  type subscribeDEntryEmployeeArchive,
} from '@allrice/database';
import {
  MAX_PERSON_VM_EMPLOYEE_PORT_SLOTS,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import { createPersonVmDshCommandMemoryPatch } from '@allrice/vm-memory/guest-plan';
import {
  nativeWebLaunchOnGuest,
  prepareNativeWebLaunch,
  type NativeWebConfiguration,
  type NativeWebGuestProfile,
  type NativeWebLaunch,
  type NativeWebLaunchPlan,
  type NativeWebModelAdapter,
} from './launch.js';
import { openNativeWebOwner, type NativeWebOwner } from './owner.js';

type Endpoint = PersonVmWebEndpointReceipt['endpoints'][number];
type EmployeeProfile = Omit<DEntryIdentity, 'threadId'>;
type ColdEmployeeSelection = Readonly<{
  selected: EmployeeProfile;
  neverStarted: readonly EmployeeProfile[];
}>;
function sameEmployee(
  a: Pick<
    Endpoint,
    | 'employeeInstanceId'
    | 'workspaceId'
    | 'employeeRevision'
    | 'employeeVersionId'
  >,
  b: typeof a,
) {
  return (
    a.employeeInstanceId === b.employeeInstanceId &&
    a.workspaceId === b.workspaceId &&
    a.employeeRevision === b.employeeRevision &&
    a.employeeVersionId === b.employeeVersionId
  );
}
type StartingEditorProof = (
  input: Readonly<{
    binding: PersonVmBinding;
    endpoint: Endpoint;
    context: RequestContext;
    modelAdapterId?: string;
    profile: Parameters<
      Parameters<NativeWebOwner['verifyStartingEditor']>[2]
    >[0];
    readModels: Parameters<
      Parameters<NativeWebOwner['verifyStartingEditor']>[2]
    >[1];
  }>,
  signal: AbortSignal,
) => Promise<AbortSignal | null>;
export type AssignedNativeWebCatalog = Readonly<{
  receipt: PersonVmWebEndpointReceipt;
  endpoint: Endpoint;
  bindingRef: string;
  revoked: AbortSignal;
  owner: NativeWebOwner;
}>;
/** Bind the real database producer; cancellation still joins its SQL operation. */
export const personNativeWebRoster: PersonVmWebRosterPort = {
  async prepare(context, signal) {
    signal.throwIfAborted();
    const roster = await preparePersonNativeWebRoster(context);
    signal.throwIfAborted();
    return roster;
  },
};
/** Actual startup component, not editor readiness or a new HTTP listener.
 * The production composition must supply the public MET267 plan and trusted
 * ingress configuration; no missing dependency is replaced by a dummy plan. */
export function createAssignedNativeWebStartup(input: {
  vm: Pick<PersonVmPort, 'assertCurrentBinding'>;
  memoryGuestPlan: PersonVmRuntimePort['memoryGuestPlan'];
  hotGuest?: {
    bootstrap: PersonVmGuestBootstrapPort['bootstrap'];
    assertWebEndpoints(
      receipt: PersonVmWebEndpointReceipt,
      signal: AbortSignal,
    ): Promise<void>;
  };
  readRoster?: typeof readPersonNativeWebRoster;
  archive?: {
    subscribe: typeof subscribeDEntryEmployeeArchive;
    confirm: typeof confirmDEntryEmployeeArchive;
  };
  employeeRuntime?: Readonly<{
    maxRunning?: number;
    /** Host proof for this startup and exact employee profiles. Absence keeps
     * the existing eager plan. A roster row alone cannot prove never started. */
    readColdSelection?(
      startup: PersonVmWebStartup,
      signal: AbortSignal,
    ): Promise<ColdEmployeeSelection | null>;
  }>;
  commandMemory?: Readonly<{
    controls: ReadonlyCommandMemoryDirectory;
    readonlyDshDirectory: string;
  }>;
  readEmployeeProfile(signal: AbortSignal): Promise<NativeWebGuestProfile>;
  configuration: Pick<
    NativeWebConfiguration,
    'cliPath' | 'startupTimeoutMs'
  > & {
    publicUrl(endpoint: Endpoint, binding: PersonVmBinding): string;
  };
  lifetime: AbortSignal;
  cleanupTimeoutMs: number;
}) {
  const runtimeLimit = input.employeeRuntime?.maxRunning ?? 4;
  if (
    input.employeeRuntime &&
    (!Number.isSafeInteger(runtimeLimit) ||
      runtimeLimit < 1 ||
      runtimeLimit > MAX_PERSON_VM_EMPLOYEE_PORT_SLOTS ||
      (input.employeeRuntime.readColdSelection && !input.hotGuest))
  )
    throw new PersonVmError('RUNTIME_NOT_READY');
  const prepared = new WeakMap<
    PersonVmWebStartup,
    {
      selectedId?: string;
      runtimeLimit?: number;
      launches: readonly {
        endpoint: Endpoint;
        launch: NativeWebLaunchPlan;
      }[];
    }
  >();
  const running = new Map<
    string,
    {
      binding: PersonVmBinding;
      receipt: PersonVmWebEndpointReceipt;
      slots?: PersonVmWebEndpointReceipt['slots'];
      runtimeLimit?: number;
      bindingRef: string;
      revoked: AbortController;
      ready: boolean;
      verifiedBy?: StartingEditorProof;
      verifiedEmployees: Map<string, AbortSignal>;
      owners: Map<string, NativeWebOwner>;
      added: Map<string, PersonVmWebEndpointReceipt>;
      startingEmployees: Set<string>;
      blockedEmployees: Map<string, number>;
      unpublished: Map<number, NativeWebOwner>;
      capacityChanged: AbortController;
      updating?: Promise<unknown>;
      stopArchive?: () => Promise<void>;
      starting: Promise<void>;
      retiring?: Promise<void>;
      unjoinedOpen: boolean;
      unjoinedGuest: boolean;
    }
  >();
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([input.lifetime, stopped.signal]);
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  let editorProof: StartingEditorProof | undefined;
  let beforePrompt: Parameters<typeof openNativeWebOwner>[0]['beforePrompt'];
  let modelAdapter:
    | ((
        binding: PersonVmBinding,
        signal: AbortSignal,
      ) => Promise<NativeWebModelAdapter>)
    | undefined;
  function track<T>(work: () => Promise<T>) {
    const operation = Promise.resolve().then(work);
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  }
  type RunningGroup = NonNullable<ReturnType<typeof running.get>>;
  function update<T>(group: RunningGroup, work: () => Promise<T>) {
    const previous = group.updating;
    const operation = track(async () => {
      await previous?.catch(() => {});
      return work();
    });
    group.updating = operation;
    const settle = () => {
      if (group.updating === operation) group.updating = undefined;
    };
    void operation.then(settle, settle);
    return operation;
  }
  function employeeCapacityFull(group: RunningGroup) {
    return (
      group.runtimeLimit !== undefined &&
      new Set([
        ...group.owners.keys(),
        ...group.startingEmployees,
        ...group.blockedEmployees.keys(),
      ]).size >= group.runtimeLimit
    );
  }
  function withEmployeeCapacity(
    group: RunningGroup,
    signal: AbortSignal,
    work: () => Promise<void | 'wait-for-capacity'>,
  ) {
    return track(async () => {
      for (;;) {
        signal.throwIfAborted();
        // Capture before the attempt so a joined owner cannot release capacity
        // between the attempt completing and the waiter attaching.
        const changed = group.capacityChanged.signal;
        if ((await update(group, work)) !== 'wait-for-capacity') return;
        const exits = [...group.owners].flatMap(([id, owner]) =>
          group.blockedEmployees.has(id) ? [] : [owner.jobExited],
        );
        const wake = AbortSignal.any([signal, changed, ...exits]);
        if (!wake.aborted) await once(wake, 'abort');
      }
    });
  }
  async function retireEmployee(
    group: RunningGroup,
    endpoint: Endpoint,
    owner: NativeWebOwner,
    join: () => Promise<void>,
  ) {
    const id = endpoint.employeeInstanceId;
    const assertOwner = () => {
      if (
        running.get(group.binding.vmId) !== group ||
        group.owners.get(id) !== owner
      )
        throw new PersonVmError('LEASE_LOST');
    };
    assertOwner();
    // Keep both the employee home and the slot reserved until its owner joins.
    group.blockedEmployees.set(id, endpoint.hostPort);
    group.verifiedEmployees.delete(id);
    try {
      await join();
    } catch (cause) {
      throw new PersonVmError('CLEANUP_INCOMPLETE', { cause });
    }
    assertOwner();
    group.owners.delete(id);
    group.added.delete(id);
    group.blockedEmployees.delete(id);
    const changed = group.capacityChanged;
    group.capacityChanged = new AbortController();
    changed.abort();
  }
  function ownerEndpoint(group: RunningGroup, employeeInstanceId: string) {
    return (
      group.added.get(employeeInstanceId) ?? group.receipt
    ).endpoints.find(
      (entry) => entry.employeeInstanceId === employeeInstanceId,
    );
  }
  async function retireOneExitedEmployee(group: RunningGroup) {
    for (const [id, owner] of group.owners) {
      if (!owner.jobExited.aborted || group.blockedEmployees.has(id)) continue;
      const endpoint = ownerEndpoint(group, id);
      if (!endpoint) throw new PersonVmError('CLEANUP_INCOMPLETE');
      try {
        await retireEmployee(group, endpoint, owner, async () => {
          const joined = owner.retireAfterJobExit(group.binding);
          if (!joined) throw new PersonVmError('CLEANUP_INCOMPLETE');
          await joined;
        });
        return true;
      } catch (error) {
        if (
          !(error instanceof PersonVmError) ||
          error.code !== 'CLEANUP_INCOMPLETE'
        )
          throw error;
        // Keep this owner quarantined. Its exit signal must not spin a waiter
        // or allow a different startup to borrow its still-unjoined slot.
      }
    }
    return false;
  }
  function confirmArchive(group: RunningGroup, endpoint: Endpoint) {
    return input.archive?.confirm({
      ...endpoint,
      organizationId: group.binding.organizationId,
      personId: group.binding.personId,
    });
  }
  async function joinArchivedOwner(group: RunningGroup, owner: NativeWebOwner) {
    const exited = owner.retireAfterJobExit(group.binding);
    if (exited) return exited;
    try {
      await owner.close();
    } catch (error) {
      // A real job wait can arrive during normal close. It replaces the
      // remote ACK only once local Host cleanup actually joins.
      const exitedDuringClose = owner.retireAfterJobExit(group.binding);
      if (!exitedDuringClose) throw error;
      await exitedDuringClose;
    }
  }
  function watchArchive(group: RunningGroup) {
    const archive = input.archive;
    if (!archive || !group.slots) return;
    const signal = AbortSignal.any([lifetime, group.revoked.signal]);
    return archive.subscribe(
      group.binding,
      async (id) => {
        if (!group.ready || signal.aborted) return;
        await update(group, async () => {
          for (const [employeeId, owner] of group.owners) {
            if (id !== null && id !== employeeId) continue;
            if (!group.ready || signal.aborted) return;
            const endpoint = ownerEndpoint(group, employeeId);
            if (!endpoint || group.blockedEmployees.has(employeeId)) continue;
            if (await confirmArchive(group, endpoint)) {
              if (!group.ready || signal.aborted) return;
              await retireEmployee(group, endpoint, owner, () =>
                joinArchivedOwner(group, owner),
              );
            }
          }
        });
      },
      signal,
    );
  }
  async function prepareEmployee(
    binding: PersonVmBinding,
    endpoint: Endpoint,
    profile: NativeWebGuestProfile,
    memory: Awaited<ReturnType<PersonVmRuntimePort['memoryGuestPlan']>>,
    model?: NativeWebModelAdapter,
  ) {
    const home = `/work/.allrice/employees/${endpoint.employeeInstanceId}`;
    return prepareNativeWebLaunch(
      {
        ...input.configuration,
        principalProfile: {
          workspaceId: endpoint.workspaceId,
          employeeInstanceId: endpoint.employeeInstanceId,
          employeeRevision: endpoint.employeeRevision,
          employeeVersionId: endpoint.employeeVersionId,
        },
        origin: `http://127.0.0.1:${endpoint.hostPort}/`,
        publicUrl: input.configuration.publicUrl(endpoint, binding),
        guestPort: endpoint.guestPort,
        dshHome: `${home}/dsh`,
        agentsHome: `${home}/agents`,
        workdir: '/work',
      },
      binding,
      profile,
      input.commandMemory
        ? createPersonVmDshCommandMemoryPatch(memory, {
            ...input.commandMemory,
            cliPath: input.configuration.cliPath,
            cleanupTimeoutMs: input.cleanupTimeoutMs,
          })
        : undefined,
      model,
    );
  }
  function openEmployee(
    scope: PersonVmBootstrapScope,
    launch: NativeWebLaunch,
    context: RequestContext,
    startup?: Pick<
      Parameters<typeof openNativeWebOwner>[0],
      'recordStartupFailure' | 'startupPending'
    >,
  ) {
    return openNativeWebOwner({
      scope,
      launch,
      context,
      vm: input.vm,
      lifetime,
      cleanupTimeoutMs: input.cleanupTimeoutMs,
      ...startup,
      ...(modelAdapter && {
        async beforePrompt(
          request: Parameters<NonNullable<typeof beforePrompt>>[0],
          active: AbortSignal,
        ) {
          if (!beforePrompt) throw new PersonVmError('RUNTIME_NOT_READY');
          return beforePrompt(request, active);
        },
      }),
    });
  }
  function current(binding: PersonVmBinding, web?: PersonVmWebStartup) {
    lifetime.throwIfAborted();
    if (
      closing ||
      !web ||
      !sameVmBinding(web.receipt.binding, binding) ||
      web.context.actor.type !== 'user' ||
      web.context.actor.id !== binding.personId ||
      web.context.organizationId !== binding.organizationId
    )
      throw new PersonVmError('LEASE_LOST');
    return web;
  }
  async function coldEmployees(web: PersonVmWebStartup, signal: AbortSignal) {
    const { binding, endpoints, slots } = web.receipt;
    if (!slots || !input.employeeRuntime) return { endpoints };
    const selection = await input.employeeRuntime.readColdSelection?.(
      web,
      signal,
    );
    signal.throwIfAborted();
    const selectedId = selection?.selected.employeeInstanceId;
    const deferred = new Set<string>();
    if (selection) {
      const requireExactProfile = (profile: EmployeeProfile) => {
        if (
          profile.personId !== binding.personId ||
          profile.organizationId !== binding.organizationId ||
          !endpoints.some((employee) => sameEmployee(employee, profile))
        )
          throw new PersonVmError('AUTHORIZATION_DENIED');
      };
      requireExactProfile(selection.selected);
      for (const profile of selection.neverStarted) {
        requireExactProfile(profile);
        deferred.add(profile.employeeInstanceId);
      }
    }
    const launches = endpoints.filter(
      ({ employeeInstanceId }) =>
        employeeInstanceId === selectedId || !deferred.has(employeeInstanceId),
    );
    // A retained roster can have more mandatory profiles than the new limit.
    // Keep this generation on the established eager path until its owners can
    // be safely deferred. Only a plan that fits may enable the running limit.
    return launches.length > runtimeLimit
      ? { endpoints, selectedId }
      : { endpoints: launches, selectedId, runtimeLimit };
  }
  async function close() {
    if (closing) return closing;
    stopped.abort(new PersonVmError('LEASE_LOST'));
    closing = (async () => {
      await Promise.allSettled(
        [...running.values()].map((group) => group.stopArchive?.()),
      );
      await Promise.allSettled([...pending]);
      const results = await Promise.allSettled(
        [...running.values()].flatMap((group) =>
          [...group.owners.values(), ...group.unpublished.values()].map(
            (owner) => owner.close(),
          ),
        ),
      );
      if (
        [...running.values()].some(
          (group) => group.unjoinedOpen || group.unjoinedGuest,
        ) ||
        results.some((result) => result.status === 'rejected')
      )
        throw new PersonVmError('CLEANUP_INCOMPLETE');
      running.clear();
    })();
    return closing;
  }
  const abort = () => {
    void close().catch(() => {});
  };
  input.lifetime.addEventListener('abort', abort, { once: true });
  if (input.lifetime.aborted) abort();
  return {
    installModelPromptObserver(observe: NonNullable<typeof beforePrompt>) {
      lifetime.throwIfAborted();
      if (closing || beforePrompt) throw new PersonVmError('RUNTIME_NOT_READY');
      beforePrompt = observe;
      return () => {
        if (beforePrompt === observe) beforePrompt = undefined;
      };
    },
    installModelAdapter(resolve: NonNullable<typeof modelAdapter>) {
      lifetime.throwIfAborted();
      if (closing || modelAdapter) throw new PersonVmError('RUNTIME_NOT_READY');
      modelAdapter = resolve;
      return () => {
        if (modelAdapter === resolve) modelAdapter = undefined;
      };
    },
    installStartingEditorProof(proof: StartingEditorProof) {
      lifetime.throwIfAborted();
      if (closing || editorProof) throw new PersonVmError('RUNTIME_NOT_READY');
      editorProof = proof;
      return () => {
        if (editorProof === proof) editorProof = undefined;
      };
    },
    memoryGuestPlan(
      binding: PersonVmBinding,
      signal: AbortSignal,
      startup?: PersonVmWebStartup,
    ) {
      return track(async () => {
        const web = current(binding, startup);
        signal = AbortSignal.any([signal, lifetime]);
        signal.throwIfAborted();
        const cold = await coldEmployees(web, signal);
        signal.throwIfAborted();
        const memory = await input.memoryGuestPlan(binding, signal);
        const profile = await input.readEmployeeProfile(signal);
        const model = await modelAdapter?.(binding, signal);
        current(binding, web);
        signal.throwIfAborted();
        const launches = await Promise.all(
          cold.endpoints.map(async (endpoint) => ({
            endpoint,
            launch: await prepareEmployee(
              binding,
              endpoint,
              profile,
              memory,
              model,
            ),
          })),
        );
        current(binding, web);
        signal.throwIfAborted();
        prepared.set(web, {
          launches,
          selectedId: cold.selectedId,
          runtimeLimit: cold.runtimeLimit,
        });
        // The existing native bootstrap stages all files, initializes person
        // memory once, and only then exposes its launcher to start below.
        return {
          ...memory,
          files: [
            ...memory.files,
            ...launches.flatMap(({ launch }) => launch.files),
          ],
        };
      });
    },
    start(
      binding: PersonVmBinding,
      signal: AbortSignal,
      scope: PersonVmBootstrapScope,
      startup?: PersonVmWebStartup,
    ) {
      const operation: Promise<void> = track(async () => {
        const web = current(binding, startup),
          plan = prepared.get(web);
        if (!sameVmBinding(scope.binding, binding))
          throw new PersonVmError('LEASE_LOST');
        signal = AbortSignal.any([signal, scope.signal, lifetime]);
        if (!plan || running.has(binding.vmId))
          throw new PersonVmError('LEASE_CONFLICT');
        prepared.delete(web);
        const receipt = Object.freeze({
          binding: Object.freeze({ ...web.receipt.binding }),
          rosterDigest: web.receipt.rosterDigest,
          endpoints: Object.freeze(
            web.receipt.endpoints.map((endpoint) =>
              Object.freeze({ ...endpoint }),
            ),
          ),
        });
        const group: RunningGroup = {
          binding,
          receipt,
          slots: web.receipt.slots,
          runtimeLimit: plan.runtimeLimit,
          bindingRef: randomUUID(),
          revoked: new AbortController(),
          ready: false,
          verifiedEmployees: new Map(),
          owners: new Map<string, NativeWebOwner>(),
          added: new Map(),
          startingEmployees: new Set(),
          blockedEmployees: new Map(),
          unpublished: new Map(),
          capacityChanged: new AbortController(),
          starting: operation,
          retiring: undefined as Promise<void> | undefined,
          unjoinedOpen: false,
          unjoinedGuest: false,
        };
        running.set(binding.vmId, group);
        let attemptedOwnerOpen = false;
        let awaitingGroupSetup = true;
        try {
          const prove = editorProof;
          group.stopArchive = await watchArchive(group);
          signal.throwIfAborted();
          await scope.assertCurrent();
          if (!scope.readNativeWebGuestAddress)
            throw new PersonVmError('PROVIDER_FAILED');
          const guestAddress = await scope.readNativeWebGuestAddress(
            AbortSignal.any([
              signal,
              AbortSignal.timeout(input.configuration.startupTimeoutMs),
            ]),
          );
          for (const { endpoint: planned, launch } of plan.launches) {
            if (group.retiring) throw new PersonVmError('LEASE_LOST');
            current(binding, web);
            const endpoint = receipt.endpoints.find(
              (entry) =>
                sameEmployee(entry, planned) &&
                entry.hostPort === planned.hostPort &&
                entry.guestPort === planned.guestPort,
            );
            if (!endpoint) throw new PersonVmError('LEASE_LOST');
            signal.throwIfAborted();
            await scope.assertCurrent();
            if (group.retiring) throw new PersonVmError('LEASE_LOST');
            const boundLaunch = nativeWebLaunchOnGuest(launch, guestAddress);
            const employeeId = endpoint.employeeInstanceId;
            group.startingEmployees.add(employeeId);
            attemptedOwnerOpen = true;
            const owner = await openEmployee(scope, boundLaunch, web.context, {
              recordStartupFailure: web.recordNativeFailure,
              startupPending: () => awaitingGroupSetup,
            });
            group.owners.set(employeeId, owner);
            group.startingEmployees.delete(employeeId);
            if (prove) {
              const proof = await owner.verifyStartingEditor(
                scope,
                signal,
                (profile, readModels, active, modelAdapterId) =>
                  prove(
                    {
                      binding: receipt.binding,
                      endpoint,
                      context: web.context,
                      modelAdapterId,
                      profile,
                      readModels,
                    },
                    active,
                  ),
              );
              if (proof) {
                proof.throwIfAborted();
                group.verifiedEmployees.set(employeeId, proof);
              }
            }
            current(binding, web);
            signal.throwIfAborted();
            if (group.retiring) throw new PersonVmError('LEASE_LOST');
          }
          await scope.assertCurrent();
          signal.throwIfAborted();
          const provedSelected = plan.selectedId
            ? group.verifiedEmployees.get(plan.selectedId)
            : undefined;
          if (
            group.retiring ||
            editorProof !== prove ||
            (prove && !group.verifiedEmployees.size) ||
            (prove &&
              plan.selectedId &&
              (!provedSelected || provedSelected.aborted)) ||
            [...group.owners.values()].some(
              (owner) => owner.revoked.aborted || !owner.controlReady(),
            )
          )
            throw new PersonVmError('RUNTIME_NOT_READY');
          group.verifiedBy = prove;
          group.ready = true;
          awaitingGroupSetup = false;
        } catch (error) {
          awaitingGroupSetup = false;
          group.ready = false;
          group.revoked.abort(error);
          await group.stopArchive?.();
          // The startup scope and native stop own address-probe cleanup.
          // Only an attempted DSH owner open can retain a Host resource here.
          group.unjoinedGuest =
            error instanceof NativeWebGuestLaunchUnacknowledged;
          group.unjoinedOpen =
            attemptedOwnerOpen &&
            !group.unjoinedGuest &&
            error instanceof PersonVmError &&
            error.code === 'CLEANUP_INCOMPLETE';
          const joined = await Promise.allSettled(
            [...group.owners.values()].map((owner) => owner.close()),
          );
          if (joined.some((result) => result.status === 'rejected'))
            throw new PersonVmError('CLEANUP_INCOMPLETE', { cause: error });
          // An open that could not join its own resources cannot be certified
          // by the successfully returned owners. Keep that unknown group.
          if (!group.unjoinedOpen && !group.unjoinedGuest && !group.retiring)
            running.delete(binding.vmId);
          throw error;
        }
      });
      return operation;
    },
    retireAfterNativeStop(binding: PersonVmBinding, signal: AbortSignal) {
      const group = running.get(binding.vmId);
      if (!group) return Promise.resolve();
      if (!sameVmBinding(group.binding, binding))
        return Promise.reject(new PersonVmError('LEASE_LOST'));
      if (group.retiring) return group.retiring;
      const operation = (async () => {
        signal.throwIfAborted();
        await Promise.allSettled([
          group.starting,
          group.updating,
          group.stopArchive?.(),
        ]);
        const joined = await Promise.allSettled(
          [...group.owners.values(), ...group.unpublished.values()].map(
            (owner) => owner.retireAfterNativeStop(binding, signal),
          ),
        );
        if (
          group.unjoinedOpen ||
          joined.some((result) => result.status === 'rejected')
        )
          throw new PersonVmError('CLEANUP_INCOMPLETE');
        signal.throwIfAborted();
        if (running.get(binding.vmId) !== group)
          throw new PersonVmError('LEASE_LOST');
        running.delete(binding.vmId);
      })();
      group.retiring = operation;
      group.ready = false;
      group.revoked.abort(new PersonVmError('LEASE_LOST'));
      void operation.catch(() => {
        if (group.retiring === operation) group.retiring = undefined;
      });
      return operation;
    },
    /** Authenticated native control for the exact lease, including while the
     * service is still starting. Editor and send require separate evidence. */
    assertAuthenticatedGroup(binding: PersonVmBinding, signal: AbortSignal) {
      lifetime.throwIfAborted();
      signal.throwIfAborted();
      const group = running.get(binding.vmId);
      if (
        closing ||
        !group?.ready ||
        group.retiring ||
        group.revoked.signal.aborted ||
        !sameVmBinding(group.binding, binding) ||
        !group.owners.size ||
        [...group.owners.values()].some(
          (owner) => owner.revoked.aborted || !owner.controlReady(),
        )
      )
        throw new PersonVmError('RUNTIME_NOT_READY');
      return AbortSignal.any([
        lifetime,
        group.revoked.signal,
        ...[...group.owners.values()].map((owner) => owner.revoked),
      ]);
    },
    assertAuthenticatedEntry(
      binding: PersonVmBinding,
      employeeInstanceId: string,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      if (!running.get(binding.vmId)?.slots)
        return this.assertAuthenticatedGroup(binding, signal);
      const { revoked } = this.catalog(binding, employeeInstanceId);
      revoked.throwIfAborted();
      return revoked;
    },
    isLiveSlottedBinding(binding: PersonVmBinding) {
      const group = running.get(binding.vmId);
      return (
        !!group?.slots &&
        group.ready &&
        !group.retiring &&
        !group.revoked.signal.aborted &&
        sameVmBinding(group.binding, binding)
      );
    },
    assertVerifiedEditor(
      binding: PersonVmBinding,
      signal: AbortSignal,
      employeeInstanceId?: string,
    ) {
      const group = running.get(binding.vmId);
      signal.throwIfAborted();
      const proof = employeeInstanceId
        ? group?.verifiedEmployees.get(employeeInstanceId)
        : [...(group?.verifiedEmployees.values() ?? [])].find(
            (candidate) => !candidate.aborted,
          );
      if (
        !editorProof ||
        group?.verifiedBy !== editorProof ||
        !group.ready ||
        !sameVmBinding(binding, group.binding) ||
        group.retiring ||
        group.revoked.signal.aborted ||
        closing ||
        lifetime.aborted ||
        !proof ||
        proof.aborted ||
        !group.owners.size ||
        (employeeInstanceId !== undefined &&
          !group.owners.get(employeeInstanceId)?.controlReady())
      )
        throw new PersonVmError('RUNTIME_NOT_READY');
      return proof;
    },
    needsEmployee(
      context: RequestContext,
      binding: PersonVmBinding,
      identity: DEntryIdentity,
    ) {
      const group = running.get(binding.vmId);
      if (
        !input.hotGuest ||
        !group?.slots ||
        !group.ready ||
        group.retiring ||
        !sameVmBinding(group.binding, binding) ||
        context.actor.type !== 'user' ||
        context.actor.id !== binding.personId ||
        context.organizationId !== binding.organizationId
      )
        return false;
      const receipt =
        group.added.get(identity.employeeInstanceId) ?? group.receipt;
      return (
        group.blockedEmployees.has(identity.employeeInstanceId) ||
        !group.owners.get(identity.employeeInstanceId)?.controlReady() ||
        !receipt.endpoints.some((endpoint) => sameEmployee(endpoint, identity))
      );
    },
    synchronizeEmployee(
      context: RequestContext,
      binding: PersonVmBinding,
      identity: DEntryIdentity,
      check: (signal: AbortSignal) => Promise<void>,
      caller: AbortSignal,
    ) {
      const group = running.get(binding.vmId);
      const slots = group?.slots;
      const guest = input.hotGuest;
      if (
        !group ||
        !slots ||
        !guest ||
        !this.needsEmployee(context, binding, identity)
      )
        return Promise.resolve();
      const signal = AbortSignal.any([caller, lifetime, group.revoked.signal]);
      return withEmployeeCapacity(group, signal, async () => {
        const rosterFor = input.readRoster ?? readPersonNativeWebRoster;
        const scope = {
          binding,
          signal,
          async assertCurrent() {
            signal.throwIfAborted();
            if (
              running.get(binding.vmId) !== group ||
              !group.ready ||
              group.retiring ||
              !sameVmBinding(group.binding, binding)
            )
              throw new PersonVmError('LEASE_LOST');
            await check(signal);
            signal.throwIfAborted();
          },
        };
        await scope.assertCurrent();
        const employeeId = identity.employeeInstanceId;
        if (group.blockedEmployees.has(employeeId))
          throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
        const roster = await rosterFor(context);
        const selected = roster.entries.find((entry) =>
          sameEmployee(entry, identity),
        );
        if (
          !selected ||
          roster.personId !== binding.personId ||
          roster.organizationId !== binding.organizationId ||
          identity.personId !== binding.personId ||
          identity.organizationId !== binding.organizationId
        )
          throw new PersonVmError('AUTHORIZATION_DENIED');
        await guest.assertWebEndpoints({ ...group.receipt, slots }, signal);
        await scope.assertCurrent();
        const physicalSlot = (endpoint: Endpoint) =>
          slots.find(
            (slot) =>
              slot.hostPort === endpoint.hostPort &&
              slot.guestPort === endpoint.guestPort,
          );
        const existing = group.owners.get(employeeId);
        let slot: (typeof slots)[number] | undefined;
        if (existing) {
          const prior = ownerEndpoint(group, employeeId);
          if (!prior) throw new PersonVmError('CLEANUP_INCOMPLETE');
          const sameRevision = sameEmployee(selected, prior);
          if (sameRevision && existing.controlReady()) return;
          slot = physicalSlot(prior);
          if (!slot) throw new PersonVmError('CLEANUP_INCOMPLETE');
          const joined = existing.retireAfterJobExit(binding);
          if (!joined)
            throw new PersonVmError(
              sameRevision ? 'RUNTIME_NOT_READY' : 'WEB_ENDPOINTS_PREPARING',
            );
          await retireEmployee(group, prior, existing, () => joined);
          await scope.assertCurrent();
        }
        if (
          employeeCapacityFull(group) &&
          (await retireOneExitedEmployee(group))
        )
          await scope.assertCurrent();
        // A roster can omit an occupied sibling. Only an exact committed
        // archive can retire a different employee under this allocation lock.
        const occupied = new Set(group.blockedEmployees.values());
        for (const id of group.owners.keys()) {
          const endpoint = ownerEndpoint(group, id);
          if (!endpoint) throw new PersonVmError('CLEANUP_INCOMPLETE');
          occupied.add(endpoint.hostPort);
        }
        slot ??= slots.find((slot) => !occupied.has(slot.hostPort));
        if (!slot && input.archive) {
          for (const [id, owner] of group.owners) {
            if (group.blockedEmployees.has(id)) continue;
            const prior = ownerEndpoint(group, id);
            if (!prior) throw new PersonVmError('CLEANUP_INCOMPLETE');
            const candidate = physicalSlot(prior);
            if (!candidate || !(await confirmArchive(group, prior))) continue;
            await scope.assertCurrent();
            try {
              await retireEmployee(group, prior, owner, () =>
                joinArchivedOwner(group, owner),
              );
            } catch {
              // The archived owner's quarantine retains this slot. B has not
              // dispatched work and does not own A's unknown cleanup.
              continue;
            }
            slot = candidate;
            await scope.assertCurrent();
            break;
          }
        }
        // Preserve exact archived physical-slot reclaim before a capacity
        // wait. Capacity alone grants no right to close another live owner.
        if (employeeCapacityFull(group)) return 'wait-for-capacity';
        if (!slot) throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
        const endpoint = Object.freeze({ ...selected, ...slot });
        const profile = await input.readEmployeeProfile(signal);
        const memory = await input.memoryGuestPlan(binding, signal);
        const model = await modelAdapter?.(binding, signal);
        const launch = await prepareEmployee(
          binding,
          endpoint,
          profile,
          memory,
          model,
        );
        await scope.assertCurrent();
        let owner: NativeWebOwner | undefined;
        let openingOwner = false;
        group.startingEmployees.add(employeeId);
        try {
          const launcher = await guest.bootstrap(scope, memory, {
            employeeInstanceId: endpoint.employeeInstanceId,
            files: launch.files,
          });
          if (!launcher.readNativeWebGuestAddress)
            throw new PersonVmError('PROVIDER_FAILED');
          const guestAddress = await launcher.readNativeWebGuestAddress(
            AbortSignal.any([
              signal,
              AbortSignal.timeout(input.configuration.startupTimeoutMs),
            ]),
          );
          openingOwner = true;
          owner = await openEmployee(
            { ...scope, ...launcher },
            nativeWebLaunchOnGuest(launch, guestAddress),
            context,
          );
          await scope.assertCurrent();
          const current = await rosterFor(context);
          if (
            current.personId !== binding.personId ||
            current.organizationId !== binding.organizationId ||
            !current.entries.some((entry) => sameEmployee(entry, endpoint))
          )
            throw new PersonVmError('AUTHORIZATION_DENIED');
          await scope.assertCurrent();
          group.added.set(
            endpoint.employeeInstanceId,
            Object.freeze({
              binding: group.binding,
              rosterDigest: roster.digest,
              endpoints: Object.freeze([endpoint]),
            }),
          );
          group.owners.set(endpoint.employeeInstanceId, owner);
        } catch (error) {
          try {
            await owner?.close();
          } catch (cause) {
            group.blockedEmployees.set(employeeId, slot.hostPort);
            if (owner) group.unpublished.set(slot.hostPort, owner);
            throw new PersonVmError('CLEANUP_INCOMPLETE', { cause });
          }
          if (
            error instanceof PersonVmError &&
            error.code === 'CLEANUP_INCOMPLETE'
          ) {
            group.blockedEmployees.set(employeeId, slot.hostPort);
            // A physical stop proves guest work exited, but cannot join local
            // transport resources from an owner open that returned no handle.
            if (
              !openingOwner ||
              error instanceof NativeWebGuestLaunchUnacknowledged
            )
              group.unjoinedGuest = true;
            else if (!owner) group.unjoinedOpen = true;
          }
          throw error;
        } finally {
          group.startingEmployees.delete(employeeId);
        }
      });
    },
    ensureVerifiedEditor(
      context: RequestContext,
      binding: PersonVmBinding,
      employeeInstanceId: string,
      caller: AbortSignal,
    ) {
      return track(async () => {
        const group = running.get(binding.vmId);
        const prove = editorProof;
        if (
          !group ||
          !prove ||
          group.verifiedBy !== prove ||
          context.actor.type !== 'user' ||
          context.actor.id !== binding.personId ||
          context.organizationId !== binding.organizationId
        )
          throw new PersonVmError('RUNTIME_NOT_READY');
        const selected = this.catalog(binding, employeeInstanceId);
        const active = AbortSignal.any([caller, selected.revoked]);
        active.throwIfAborted();
        const previous = group.verifiedEmployees.get(employeeInstanceId);
        if (previous && !previous.aborted && !modelAdapter) return previous;

        const proof = await selected.owner.verifyRunningEditor(
          context,
          active,
          (profile, readModels, signal, modelAdapterId) =>
            prove(
              {
                binding: selected.receipt.binding,
                endpoint: selected.endpoint,
                context,
                modelAdapterId,
                profile,
                readModels,
              },
              signal,
            ),
        );
        active.throwIfAborted();
        if (
          !proof ||
          running.get(binding.vmId) !== group ||
          editorProof !== prove
        )
          throw new PersonVmError('RUNTIME_NOT_READY');
        proof.throwIfAborted();
        const enrolled = group.verifiedEmployees.get(employeeInstanceId);
        if (enrolled && !enrolled.aborted) return enrolled;
        group.verifiedEmployees.set(employeeInstanceId, proof);
        return proof;
      });
    },
    /** Publish only a completely started, exact group; this never starts a VM. */
    catalog(
      binding: PersonVmBinding,
      employeeInstanceId: string,
    ): AssignedNativeWebCatalog {
      lifetime.throwIfAborted();
      const group = running.get(binding.vmId);
      if (
        closing ||
        !group ||
        group.retiring ||
        group.revoked.signal.aborted ||
        !sameVmBinding(group.binding, binding)
      )
        throw new PersonVmError('LEASE_LOST');
      if (!group.ready || group.blockedEmployees.has(employeeInstanceId))
        throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
      const owner = group.owners.get(employeeInstanceId);
      const receipt = group.added.get(employeeInstanceId) ?? group.receipt;
      const endpoint = receipt.endpoints.find(
        (entry) => entry.employeeInstanceId === employeeInstanceId,
      );
      if (!owner || !endpoint || !owner.controlReady())
        throw new PersonVmError('RUNTIME_NOT_READY');
      return Object.freeze({
        receipt,
        endpoint,
        bindingRef: group.bindingRef,
        revoked: AbortSignal.any([
          lifetime,
          group.revoked.signal,
          owner.revoked,
        ]),
        owner,
      });
    },
    /** Authenticated owners already present in this Worker. Ledger reads
     * separately verify the durable scope and never start a profile. */
    runJournalOwners(): AssignedNativeWebCatalog[] {
      if (closing || lifetime.aborted) return [];
      return [...running.values()].flatMap((group) => {
        if (!group.ready || group.retiring || group.revoked.signal.aborted)
          return [];
        return [...group.owners].flatMap(([employeeInstanceId, owner]) => {
          if (
            group.blockedEmployees.has(employeeInstanceId) ||
            !owner.modelAdapterId ||
            !owner.controlReady()
          )
            return [];
          return [this.catalog(group.binding, employeeInstanceId)];
        });
      });
    },
    hasLocalOwner(binding: PersonVmBinding) {
      const group = running.get(binding.vmId);
      return group !== undefined && sameVmBinding(group.binding, binding);
    },
    /** Host catalog resource only. Its read method still rechecks VM authority.
     * It supplies no editor/send proof, native ancestry pin or browser credential. */
    owner(binding: PersonVmBinding, employeeInstanceId: string) {
      lifetime.throwIfAborted();
      if (closing) throw new PersonVmError('LEASE_LOST');
      const group = running.get(binding.vmId);
      if (
        !group ||
        group.retiring ||
        !group.ready ||
        group.revoked.signal.aborted ||
        !sameVmBinding(group.binding, binding)
      )
        throw new PersonVmError('LEASE_LOST');
      if (group.blockedEmployees.has(employeeInstanceId)) return undefined;
      return group.owners.get(employeeInstanceId);
    },
    async close() {
      try {
        await close();
      } finally {
        input.lifetime.removeEventListener('abort', abort);
      }
    },
  } satisfies Pick<
    PersonVmRuntimePort,
    'memoryGuestPlan' | 'start' | 'retireAfterNativeStop'
  > & {
    installModelAdapter(resolve: NonNullable<typeof modelAdapter>): () => void;
    installModelPromptObserver(
      observe: NonNullable<typeof beforePrompt>,
    ): () => void;
    installStartingEditorProof(proof: StartingEditorProof): () => void;
    assertVerifiedEditor(
      binding: PersonVmBinding,
      signal: AbortSignal,
      employeeInstanceId?: string,
    ): AbortSignal;
    needsEmployee(
      context: RequestContext,
      binding: PersonVmBinding,
      identity: DEntryIdentity,
    ): boolean;
    synchronizeEmployee(
      context: RequestContext,
      binding: PersonVmBinding,
      identity: DEntryIdentity,
      check: (signal: AbortSignal) => Promise<void>,
      caller: AbortSignal,
    ): Promise<void>;
    ensureVerifiedEditor(
      context: RequestContext,
      binding: PersonVmBinding,
      employeeInstanceId: string,
      signal: AbortSignal,
    ): Promise<AbortSignal>;
    assertAuthenticatedGroup(
      binding: PersonVmBinding,
      signal: AbortSignal,
    ): AbortSignal;
    assertAuthenticatedEntry(
      binding: PersonVmBinding,
      employeeInstanceId: string,
      signal: AbortSignal,
    ): AbortSignal;
    isLiveSlottedBinding(binding: PersonVmBinding): boolean;
    catalog(
      binding: PersonVmBinding,
      employeeInstanceId: string,
    ): AssignedNativeWebCatalog;
    runJournalOwners(): AssignedNativeWebCatalog[];
    hasLocalOwner(binding: PersonVmBinding): boolean;
    owner(
      binding: PersonVmBinding,
      employeeInstanceId: string,
    ): NativeWebOwner | undefined;
    close(): Promise<void>;
  };
}
