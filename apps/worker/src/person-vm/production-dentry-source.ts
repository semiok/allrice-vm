import { randomUUID } from 'node:crypto';
import {
  sameDEntryIdentity,
  selectDEntryGeneration,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import {
  DataAccessError,
  ensureDEntryNativeRoot,
  readDEntryReleasePolicy,
  requireDEntryNativeIdentity,
  runDEntryAdmittedActivity,
} from '@allrice/database';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import {
  PersonVmError,
  sameVmBinding,
  type PersonVmBinding,
  type PersonVmPort,
  type PersonVmRuntimePort,
  type PersonVmService,
} from '@allrice/person-vm';
import type { createAssignedNativeWebStartup } from '../native-web/composition.js';
import { NativeRootJoinUnknown } from '../native-web/owner.js';
import {
  installDEntryNativeDataPort,
  type DEntryNativeDataPort,
} from '../d-entry/native-data.js';
import {
  currentDEntryNativeOwner,
  DEntryNativeUnavailable,
  dEntryNativeOwnerPort,
  type ResolvedDEntryNativeOwner,
} from '../d-entry/native-owner.js';
import {
  holdReleasedProfile,
  readWorkerEmployeeWebSeal,
} from '../d-entry/released-profile.js';

import { dEntryStartupTiming } from '../d-entry/startup-timing.js';

type Startup = Pick<
  ReturnType<typeof createAssignedNativeWebStartup>,
  | 'catalog'
  | 'installStartingEditorProof'
  | 'assertVerifiedEditor'
  | 'ensureVerifiedEditor'
  | 'assertAuthenticatedGroup'
>;

/** The managed model owner checks the configured route and its same-generation
 * guest adapter installation without dispatching a model call. */
export type ResolveProductionDEntrySendRoute = (
  input: Readonly<{
    context: RequestContext;
    identity: DEntryIdentity;
    binding: PersonVmBinding;
    modelAdapterId?: string;
  }>,
  signal: AbortSignal,
) => Promise<
  Readonly<{ provider: string; model: string; revoked: AbortSignal }>
>;

function denied(): never {
  throw new DataAccessError('authorization_denied');
}

function sameSession(a: RequestContext, b: RequestContext) {
  return (
    a.sessionId === b.sessionId &&
    a.actor.type === b.actor.type &&
    a.actor.id === b.actor.id &&
    a.organizationId === b.organizationId &&
    a.workspaceId === b.workspaceId
  );
}

/**
 * Bind data and startup evidence to the same actual native startup and entry
 * participant used by the Worker Host. The installed page routes continue to
 * send only generated operations on the admitted non-owner principal.
 */
export function installProductionDEntrySource(input: {
  startup: Startup &
    Partial<
      Pick<
        ReturnType<typeof createAssignedNativeWebStartup>,
        'needsEmployee' | 'synchronizeEmployee' | 'assertAuthenticatedEntry'
      >
    >;
  vm?: Pick<PersonVmPort, 'resolve' | 'assertCurrentBinding'>;
  admission: ReturnType<PersonVmService['createAdmissionHost']>;
  lifetime: AbortSignal;
  confirmPhysical?(
    context: RequestContext,
    identity: DEntryIdentity,
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<void>;
  resolveSendRoute: ResolveProductionDEntrySendRoute;
}) {
  input.lifetime.throwIfAborted();
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([input.lifetime, stopped.signal]);
  const pending = new Set<Promise<unknown>>();
  const owners = new WeakMap<
    ResolvedDEntryNativeOwner,
    { context: RequestContext; identity: DEntryIdentity }
  >();
  let closing: Promise<void> | undefined;

  function own<T>(
    signal: AbortSignal,
    run: (active: AbortSignal) => Promise<T>,
  ) {
    const active = AbortSignal.any([signal, lifetime]);
    active.throwIfAborted();
    const task = Promise.resolve().then(() => {
      active.throwIfAborted();
      return run(active);
    });
    pending.add(task);
    const release = () => pending.delete(task);
    void task.then(release, release);
    return task;
  }

  function sameHost(
    owner: ResolvedDEntryNativeOwner,
    identity: DEntryIdentity,
  ) {
    const binding = owner.receipt.binding;
    const catalog = input.startup.catalog(binding, identity.employeeInstanceId);
    if (
      !sameVmBinding(catalog.receipt.binding, binding) ||
      catalog.bindingRef !== owner.bindingRef ||
      catalog.receipt.rosterDigest !== owner.receipt.rosterDigest ||
      catalog.endpoint.workspaceId !== identity.workspaceId ||
      catalog.endpoint.employeeInstanceId !== identity.employeeInstanceId ||
      catalog.endpoint.employeeRevision !== identity.employeeRevision ||
      catalog.endpoint.employeeVersionId !== identity.employeeVersionId ||
      catalog.endpoint.guestPort !== owner.endpoint.guestPort ||
      catalog.endpoint.hostPort !== owner.endpoint.hostPort
    )
      denied();
    catalog.revoked.throwIfAborted();
    return catalog.owner;
  }

  async function proveSelectedEmployee(
    context: RequestContext,
    identity: DEntryIdentity,
    signal: AbortSignal,
    expectedBinding?: PersonVmBinding,
  ) {
    async function readyProof(active: AbortSignal, expected?: PersonVmBinding) {
      const current = await currentDEntryNativeOwner(
        dEntryNativeOwnerPort,
        context,
        identity,
        active,
      );
      const binding = current.view.receipt.binding;
      if (expected && !sameVmBinding(binding, expected))
        throw new PersonVmError('LEASE_LOST');
      const proof = await input.startup.ensureVerifiedEditor(
        context,
        binding,
        identity.employeeInstanceId,
        current.signal,
      );
      const authenticated = input.startup.assertAuthenticatedEntry
        ? input.startup.assertAuthenticatedEntry(
            binding,
            identity.employeeInstanceId,
            current.signal,
          )
        : input.startup.assertAuthenticatedGroup(binding, current.signal);
      // The read has finished. This observation follows the caller and exact
      // owner, not the temporary permit used to perform it.
      return AbortSignal.any([
        signal,
        current.owner.revoked,
        proof,
        authenticated,
      ]);
    }
    const vm = input.vm;
    if (!vm) return readyProof(signal, expectedBinding);
    const binding = await vm.resolve(context, signal);
    if (expectedBinding && !sameVmBinding(binding, expectedBinding))
      throw new PersonVmError('LEASE_LOST');
    const selection = {
      workspaceId: identity.workspaceId,
      employeeInstanceId: identity.employeeInstanceId,
      ...(identity.threadId && { threadId: identity.threadId }),
    };
    const check = async (active: AbortSignal) => {
      const current = await requireDEntryNativeIdentity(context, selection);
      if (!sameDEntryIdentity(current, identity)) denied();
      await vm.assertCurrentBinding(context, binding, active);
      active.throwIfAborted();
    };
    return runDEntryAdmittedActivity(
      {
        ports: port.admission,
        signal,
        owner: {
          binding,
          context,
          operationId: randomUUID(),
          revoked: lifetime,
          assertCurrent: check,
          assertUndispatched: check,
        },
      },
      () => {
        const stop = new AbortController();
        let work: Promise<AbortSignal> | undefined;
        return {
          run(active) {
            const running = AbortSignal.any([active, stop.signal]);
            work = (async () => {
              if (input.startup.needsEmployee?.(context, binding, identity))
                await input.startup.synchronizeEmployee?.(
                  context,
                  binding,
                  identity,
                  check,
                  running,
                );
              return readyProof(running, binding);
            })();
            return work;
          },
          async close() {
            stop.abort();
            const [joined] = await Promise.allSettled([work]);
            if (
              joined.status === 'rejected' &&
              joined.reason instanceof PersonVmError &&
              joined.reason.code === 'CLEANUP_INCOMPLETE'
            )
              throw joined.reason;
          },
        };
      },
    );
  }

  const port: DEntryNativeDataPort = {
    admission: {
      boundary: input.admission,
      participant: input.admission.participant('entry'),
    },
    assertEditorReady(context, identity, signal, expectedBinding) {
      return own(signal, (active) =>
        proveSelectedEmployee(context, identity, active, expectedBinding),
      );
    },
    confirmVerifiedEditor(context, identity, signal) {
      return own(signal, async (active) => {
        if (!input.confirmPhysical) return;
        try {
          const current = await currentDEntryNativeOwner(
            dEntryNativeOwnerPort,
            context,
            identity,
            active,
          );
          const { binding } = current.view.receipt;
          const employee = identity.employeeInstanceId;
          // Gate on the existing proof for this exact local owner/employee.
          // The refresh uses its actual authenticated graph and current route.
          input.startup.assertVerifiedEditor(binding, current.signal, employee);
          const proof = await input.startup.ensureVerifiedEditor(
            context,
            binding,
            employee,
            current.signal,
          );
          const group = input.startup.assertAuthenticatedGroup(
            binding,
            current.signal,
          );
          const confirmed = AbortSignal.any([current.signal, proof, group]);
          await input.confirmPhysical(context, identity, binding, confirmed);
          await current.owner.assertCurrent(context, confirmed);
          sameHost(current.owner, identity);
          confirmed.throwIfAborted();
          return { binding, proof: confirmed };
        } catch (error) {
          active.throwIfAborted();
          if (
            error instanceof DEntryNativeUnavailable ||
            (error instanceof PersonVmError &&
              [
                'NOT_FOUND',
                'LEASE_CONFLICT',
                'LEASE_LOST',
                'RUNTIME_NOT_READY',
                'WEB_ENDPOINTS_PREPARING',
              ].includes(error.code))
          )
            return;
          throw error;
        }
      });
    },
    resolveAdmissionOwner({
      context,
      identity,
      owner,
      operationId,
      signal,
      access,
    }) {
      return own(signal, async (active) => {
        const binding = owner.receipt.binding;
        if (
          context.actor.type !== 'user' ||
          context.actor.id !== binding.personId ||
          identity.personId !== binding.personId ||
          identity.organizationId !== binding.organizationId ||
          context.organizationId !== binding.organizationId ||
          context.workspaceId !== identity.workspaceId ||
          (!identity.threadId && access !== 'page')
        )
          denied();
        const scope = structuredClone(context);
        const expected = Object.freeze({ ...identity });
        const route = await input.startup.ensureVerifiedEditor(
          scope,
          binding,
          expected.employeeInstanceId,
          active,
        );
        const revoked = AbortSignal.any([lifetime, owner.revoked, route]);
        const assertCurrent = (caller: AbortSignal) =>
          own(AbortSignal.any([revoked, caller]), async (signal) => {
            await owner.assertCurrent(scope, signal);
            input.startup.assertVerifiedEditor(
              binding,
              signal,
              expected.employeeInstanceId,
            );
            sameHost(owner, expected);
            signal.throwIfAborted();
          });
        await assertCurrent(active);
        const previous = owners.get(owner);
        if (
          previous &&
          (!sameSession(previous.context, scope) ||
            !sameDEntryIdentity(previous.identity, expected))
        )
          denied();
        owners.set(owner, { context: scope, identity: expected });
        return {
          context: scope,
          binding,
          operationId,
          revoked,
          assertCurrent,
          // Only consulted before the admitted callback can acquire any
          // native handle. There is no dispatch or retained request to replay.
          assertUndispatched: assertCurrent,
        };
      });
    },
    async prepareEditorRoot({
      context,
      identity,
      owner,
      assertCurrent,
      signal,
    }) {
      const operationId = randomUUID();
      const admitted = await port.resolveAdmissionOwner({
        context,
        identity,
        owner,
        operationId,
        signal,
      });
      const selection = {
        workspaceId: identity.workspaceId,
        employeeInstanceId: identity.employeeInstanceId,
        threadId: identity.threadId,
      };
      const host = {
        binding: admitted.binding,
        bindingRef: owner.bindingRef,
        rosterDigest: owner.receipt.rosterDigest,
      };
      return runDEntryAdmittedActivity(
        {
          ports: port.admission,
          signal,
          owner: {
            ...admitted,
            async assertCurrent(active) {
              await assertCurrent(active);
              await admitted.assertCurrent(active);
            },
          },
        },
        (active) => {
          const native = port.acquireRoot({ owner, request: {} }, active);
          let pin: ReturnType<typeof ensureDEntryNativeRoot> | undefined;
          return {
            run(running) {
              pin = ensureDEntryNativeRoot(context, selection, identity, {
                operationId,
                host,
                signal: running,
                async create(creating) {
                  await assertCurrent(creating);
                  const result = await native.run(creating);
                  if (!result.ok) throw result.error;
                  await assertCurrent(creating);
                  return { nativeSessionId: result.value.sessionId, host };
                },
              });
              return pin;
            },
            async close() {
              const [joined] = await Promise.allSettled([native.close(), pin]);
              if (joined.status === 'rejected') throw joined.reason;
            },
          };
        },
      );
    },
    acquireRoot({ owner, request }, signal) {
      const stop = new AbortController();
      const scope = AbortSignal.any([owner.revoked, signal, stop.signal]);
      let task:
        | ReturnType<ReturnType<Startup['catalog']>['owner']['createRootFor']>
        | undefined;
      return {
        run(caller) {
          if (task) throw new PersonVmError('LEASE_CONFLICT');
          task = own(AbortSignal.any([scope, caller]), async (active) => {
            const found = owners.get(owner);
            if (!found) return denied();
            // The root route owns the reservation and durable root pin. Its
            // authorized native create accepts only the empty generated args.
            const args = TYPERT_REMOTE.methods['session/create']
              .input({ strict: true })
              .create()
              .parse({ request });
            if (Object.keys(args.request).length) return denied();
            await owner.assertCurrent(found.context, active);
            input.startup.assertVerifiedEditor(
              owner.receipt.binding,
              active,
              found.identity.employeeInstanceId,
            );
            return sameHost(owner, found.identity).createRootFor(
              found.context,
              args.request,
              active,
            );
          });
          return task;
        },
        async close() {
          stop.abort();
          await task?.catch((error: unknown) => {
            if (error instanceof NativeRootJoinUnknown) throw error;
          });
        },
      };
    },
  };
  const modelProofs = new WeakMap<
    object,
    {
      adapterId: string;
      seal: string;
      provider: string;
      model: string;
      revoked: AbortSignal;
    }
  >();
  const uninstallProof = input.startup.installStartingEditorProof(
    (
      { binding, endpoint, context, modelAdapterId, profile, readModels },
      signal,
    ) =>
      own(signal, async (active) => {
        const timing = dEntryStartupTiming('editor-proof');
        const expected: DEntryIdentity = {
          organizationId: binding.organizationId,
          personId: binding.personId,
          workspaceId: endpoint.workspaceId,
          employeeInstanceId: endpoint.employeeInstanceId,
          employeeRevision: endpoint.employeeRevision,
          employeeVersionId: endpoint.employeeVersionId,
          threadId: null,
        };
        const release = await timing.run('rollout', readDEntryReleasePolicy);
        active.throwIfAborted();
        if (selectDEntryGeneration(release, expected) !== '4.0') return null;
        // The native startup roster spans the real current workspaces of this
        // original login. The identity reader rechecks each exact workspace.
        const scope = { ...context, workspaceId: endpoint.workspaceId };
        async function current() {
          const identity = await requireDEntryNativeIdentity(scope, {
            workspaceId: endpoint.workspaceId,
            employeeInstanceId: endpoint.employeeInstanceId,
          });
          active.throwIfAborted();
          if (!sameDEntryIdentity(identity, expected)) denied();
          return identity;
        }
        const identity = await timing.run('current-authority', current);
        const seal = await timing.run('release-seal', () =>
          readWorkerEmployeeWebSeal(active),
        );
        const editor = await timing.run('profile-attestation', () =>
          holdReleasedProfile(
            seal.directory,
            profile,
            active,
            seal.manifestSha256,
          ),
        );
        // Route truth remains current even when the immutable profile and the
        // installed adapter's catalog have already been proved for this epoch.
        const resolveRoute = () =>
          timing.run('send-route', () =>
            input.resolveSendRoute(
              { context: scope, identity, binding, modelAdapterId },
              active,
            ),
          );
        const owner = profile.verificationOwner;
        const old = owner && modelProofs.get(owner);
        const existing =
          old &&
          !old.revoked.aborted &&
          old.adapterId === modelAdapterId &&
          old.seal === seal.manifestSha256
            ? await resolveRoute()
            : undefined;
        const route =
          old &&
          existing &&
          !old.revoked.aborted &&
          existing.provider === old.provider &&
          existing.model === old.model
            ? existing
            : await (async () => {
                const models = await timing.run('model-catalog', readModels);
                // Route revocation may only be observed on a current read.
                const currentRoute = await resolveRoute();
                if (
                  models.value.default.provider !== currentRoute.provider ||
                  models.value.default.model !== currentRoute.model ||
                  !models.value.routableProviders.includes(
                    currentRoute.provider,
                  ) ||
                  !models.value.groups.some(
                    ({ id, models }) =>
                      id === currentRoute.provider &&
                      models.some(({ id }) => id === currentRoute.model),
                  ) ||
                  models.value.failures.some(
                    ({ id }) => id === currentRoute.provider,
                  )
                )
                  throw new PersonVmError('RUNTIME_NOT_READY');
                return currentRoute;
              })();
        await timing.run('final-authority', async () => {
          await editor.assertCurrent(active);
          if (!sameDEntryIdentity(identity, await current())) denied();
          route.revoked.throwIfAborted();
        });
        if (owner && modelAdapterId)
          modelProofs.set(owner, {
            adapterId: modelAdapterId,
            seal: seal.manifestSha256,
            provider: route.provider,
            model: route.model,
            revoked: route.revoked,
          });
        timing.ready();
        return route.revoked;
      }),
  );
  let uninstallData: () => void;
  try {
    uninstallData = installDEntryNativeDataPort(port);
  } catch (error) {
    uninstallProof();
    throw error;
  }
  function abort() {
    void close();
  }
  function close() {
    if (closing) return closing;
    uninstallData();
    uninstallProof();
    input.lifetime.removeEventListener('abort', abort);
    closing = Promise.allSettled([...pending]).then(() => {});
    stopped.abort(new PersonVmError('RUNTIME_NOT_READY'));
    return closing;
  }
  input.lifetime.addEventListener('abort', abort, { once: true });
  if (input.lifetime.aborted) abort();
  const readiness: PersonVmRuntimePort['readiness'] = async (
    binding,
    signal,
  ) => {
    lifetime.throwIfAborted();
    input.startup.assertVerifiedEditor(binding, signal);
    return { binding, authenticated: true, editorReady: true, canSend: true };
  };
  return Object.freeze({ readiness, close });
}
