import { randomUUID } from 'node:crypto';
import type {
  PersonVmBinding,
  PersonVmBootstrapScope,
  PersonVmPort,
  PersonVmRuntimePort,
  PersonVmWebEndpointReceipt,
  PersonVmWebStartup,
  PersonVmWebRosterPort,
  ReadonlyCommandMemoryDirectory,
} from '@allrice/person-vm';
import { PersonVmError, sameVmBinding } from '@allrice/person-vm';
import { preparePersonNativeWebRoster } from '@allrice/database';
import type { RequestContext } from '@allrice/contracts';
import { createPersonVmDshCommandMemoryPatch } from '@allrice/vm-memory/guest-plan';
import {
  nativeWebLaunchOnGuest,
  prepareNativeWebLaunch,
  type NativeWebConfiguration,
  type NativeWebGuestProfile,
  type NativeWebLaunchPlan,
  type NativeWebModelAdapter,
} from './launch.js';
import { openNativeWebOwner, type NativeWebOwner } from './owner.js';

type Endpoint = PersonVmWebEndpointReceipt['endpoints'][number];
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
  const prepared = new WeakMap<
    PersonVmWebStartup,
    readonly NativeWebLaunchPlan[]
  >();
  const running = new Map<
    string,
    {
      binding: PersonVmBinding;
      receipt: PersonVmWebEndpointReceipt;
      bindingRef: string;
      revoked: AbortController;
      ready: boolean;
      verifiedBy?: StartingEditorProof;
      verifiedEmployees: Map<string, AbortSignal>;
      owners: Map<string, NativeWebOwner>;
      starting: Promise<void>;
      retiring?: Promise<void>;
      unjoinedOpen: boolean;
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
  async function close() {
    if (closing) return closing;
    stopped.abort(new PersonVmError('LEASE_LOST'));
    closing = (async () => {
      await Promise.allSettled([...pending]);
      const results = await Promise.allSettled(
        [...running.values()].flatMap((group) =>
          [...group.owners.values()].map((owner) => owner.close()),
        ),
      );
      if (
        [...running.values()].some((group) => group.unjoinedOpen) ||
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
        const memory = await input.memoryGuestPlan(binding, signal);
        const commandMemory = input.commandMemory
          ? createPersonVmDshCommandMemoryPatch(memory, {
              ...input.commandMemory,
              cliPath: input.configuration.cliPath,
              cleanupTimeoutMs: input.cleanupTimeoutMs,
            })
          : undefined;
        const profile = await input.readEmployeeProfile(signal);
        const model = await modelAdapter?.(binding, signal);
        current(binding, web);
        signal.throwIfAborted();
        const launches = await Promise.all(
          web.receipt.endpoints.map((endpoint) => {
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
              commandMemory,
              model,
            );
          }),
        );
        current(binding, web);
        signal.throwIfAborted();
        prepared.set(web, launches);
        // The existing native bootstrap stages all files, initializes person
        // memory once, and only then exposes its launcher to start below.
        return {
          ...memory,
          files: [
            ...memory.files,
            ...launches.flatMap((launch) => launch.files),
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
          launches = prepared.get(web);
        if (!sameVmBinding(scope.binding, binding))
          throw new PersonVmError('LEASE_LOST');
        signal = AbortSignal.any([signal, scope.signal, lifetime]);
        if (!launches || running.has(binding.vmId))
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
        const group: NonNullable<ReturnType<typeof running.get>> = {
          binding,
          receipt,
          bindingRef: randomUUID(),
          revoked: new AbortController(),
          ready: false,
          verifiedEmployees: new Map(),
          owners: new Map<string, NativeWebOwner>(),
          starting: operation,
          retiring: undefined as Promise<void> | undefined,
          unjoinedOpen: false,
        };
        running.set(binding.vmId, group);
        let attemptedOwnerOpen = false;
        let awaitingGroupSetup = true;
        try {
          const prove = editorProof;
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
          for (const [index, launch] of launches.entries()) {
            if (group.retiring) throw new PersonVmError('LEASE_LOST');
            current(binding, web);
            signal.throwIfAborted();
            await scope.assertCurrent();
            if (group.retiring) throw new PersonVmError('LEASE_LOST');
            const boundLaunch = nativeWebLaunchOnGuest(launch, guestAddress);
            attemptedOwnerOpen = true;
            const owner = await openNativeWebOwner({
              scope,
              launch: boundLaunch,
              context: web.context,
              vm: input.vm,
              lifetime,
              cleanupTimeoutMs: input.cleanupTimeoutMs,
              recordStartupFailure: web.recordNativeFailure,
              startupPending: () => awaitingGroupSetup,
              ...(modelAdapter
                ? {
                    async beforePrompt(
                      request: Parameters<NonNullable<typeof beforePrompt>>[0],
                      active: AbortSignal,
                    ) {
                      if (!beforePrompt)
                        throw new PersonVmError('RUNTIME_NOT_READY');
                      return beforePrompt(request, active);
                    },
                  }
                : {}),
            });
            const endpoint = receipt.endpoints[index]!;
            group.owners.set(endpoint.employeeInstanceId, owner);
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
                group.verifiedEmployees.set(endpoint.employeeInstanceId, proof);
              }
            }
            current(binding, web);
            signal.throwIfAborted();
            if (group.retiring) throw new PersonVmError('LEASE_LOST');
          }
          await scope.assertCurrent();
          signal.throwIfAborted();
          if (
            group.retiring ||
            editorProof !== prove ||
            (prove && !group.verifiedEmployees.size) ||
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
          // The startup scope and native stop own address-probe cleanup.
          // Only an attempted DSH owner open can retain a Host resource here.
          group.unjoinedOpen =
            attemptedOwnerOpen &&
            error instanceof PersonVmError &&
            error.code === 'CLEANUP_INCOMPLETE';
          const joined = await Promise.allSettled(
            [...group.owners.values()].map((owner) => owner.close()),
          );
          if (joined.some((result) => result.status === 'rejected'))
            throw new PersonVmError('CLEANUP_INCOMPLETE', { cause: error });
          // An open that could not join its own resources cannot be certified
          // by the successfully returned owners. Keep that unknown group.
          if (!group.unjoinedOpen && !group.retiring)
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
        await Promise.allSettled([group.starting]);
        const joined = await Promise.allSettled(
          [...group.owners.values()].map((owner) =>
            owner.retireAfterNativeStop(binding, signal),
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
        [...group.owners.values()].some((owner) => !owner.controlReady())
      )
        throw new PersonVmError('RUNTIME_NOT_READY');
      return proof;
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
        if (enrolled && !enrolled.aborted && !modelAdapter) return enrolled;
        // Production rechecks the route even on a sealed profile cache hit.
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
      if (!group.ready) throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
      const owner = group.owners.get(employeeInstanceId);
      const endpoint = group.receipt.endpoints.find(
        (entry) => entry.employeeInstanceId === employeeInstanceId,
      );
      if (!owner || !endpoint || !owner.controlReady())
        throw new PersonVmError('RUNTIME_NOT_READY');
      return Object.freeze({
        receipt: group.receipt,
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
        return group.receipt.endpoints.flatMap((endpoint) => {
          const owner = group.owners.get(endpoint.employeeInstanceId);
          if (!owner?.modelAdapterId || !owner.controlReady()) return [];
          return [this.catalog(group.binding, endpoint.employeeInstanceId)];
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
