import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import {
  DataAccessError,
  IdentityError,
  getDEntryNativeRootPin,
  getDatabase,
  watchDEntryNativeRosterAuthority,
  requireCurrentPlatformAdmin,
  requireDEntryNativeIdentity,
  readDEntryNativeExecution,
  requireCurrentWorkspaceWriteAuthority,
} from '@allrice/database';
import { EgressError, type ManagedHostService } from '@allrice/egress-gateway';
import {
  ModelGatewayError,
  type ModelCallBinding,
} from '@allrice/model-gateway';
import {
  PersonVmError,
  sameVmBinding,
  type PersonVmBinding,
} from '@allrice/person-vm';
import {
  currentDEntryNativeOwner,
  dEntryNativeOwnerPort,
  resolveDEntryNativeResource,
} from '../d-entry/native-owner.js';
import type { NativeModelAttemptKind } from '../native-web/owner.js';
import {
  deferredPromptFact,
  waitForPromptFact,
  type NativePromptObservation,
  type NativePromptOccurrence,
} from '../native-web/prompt-observation.js';
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types';
import type { ProductionNativeModelExecution } from './production-sources.js';
import { reconcileNativeRunTerminals } from './production-native-run-reconciliation.js';

type NativeModelSelection = Readonly<{
  context: RequestContext;
  identity: DEntryIdentity;
  binding: PersonVmBinding;
  revoked: AbortSignal;
}>;

type PromptOwner = NativeModelSelection &
  Readonly<{
    runId: string;
    requestId: string;
    scopeId: string;
    adapterId: string;
    root: string;
    sessionId: string;
    parentSessionId?: string;
    forkedFromNativeSessionId?: string;
    authorityKey: string;
    assertObserved(signal: AbortSignal): Promise<void>;
    assertClaimed(
      signal: AbortSignal,
      occurrence: NativePromptOccurrence,
    ): Promise<void>;
  }>;

const promptKey = (adapterId: string, sessionId: string, requestId: string) =>
  JSON.stringify([adapterId, sessionId, requestId]);

export function readNativePromptContributors<
  Id,
  T extends Pick<PromptOwner, 'authorityKey' | 'revoked'>,
>(ids: readonly Id[], read: (id: Id) => T | undefined) {
  const first = read(ids[0]!);
  if (!first || first.revoked.aborted) return null;
  const contributors = [first];
  for (const id of ids.slice(1)) {
    const next = read(id);
    if (
      !next ||
      next.revoked.aborted ||
      next.authorityKey !== first.authorityKey
    )
      return null;
    contributors.push(next);
  }
  return { first, contributors };
}

export function nativeRunExecutionIds(
  executions: Map<string, string>,
  originalRunId: string,
  attempt: {
    sessionId: string;
    sourceTurn: number;
    delegated: boolean;
    kind: NativeModelAttemptKind;
    id: string;
  },
) {
  const { sessionId, sourceTurn, delegated, kind, id } = attempt;
  const runKey = JSON.stringify(['turn', sessionId, sourceTurn]);
  const runId = delegated
    ? (executions.get(runKey) ?? randomUUID())
    : originalRunId;
  if (delegated) executions.set(runKey, runId);
  const executionKey = JSON.stringify([runId, kind, id]);
  const executionId = executions.get(executionKey) ?? randomUUID();
  executions.set(executionKey, executionId);
  return { runId, executionId };
}

async function persistExecution(
  call: ModelCallBinding,
  prompt: PromptOwner,
  contributingRequestIds: readonly string[],
  directRequestIds: readonly string[],
  delegated: boolean,
  signal: AbortSignal,
) {
  const { context, vm, native, execution } = call;
  const identity = prompt.identity;
  const pin = await getDEntryNativeRootPin(context, {
    workspaceId: identity.workspaceId,
    employeeInstanceId: identity.employeeInstanceId,
    threadId: call.allriceThreadRef,
  });
  if (
    pin.vmId !== vm.vmId ||
    pin.rootNativeSessionId !== native.rootSessionId ||
    pin.forkedFromNativeSessionId !== prompt.forkedFromNativeSessionId
  )
    return reject();
  const runSource = {
    generation: '4.0',
    source: delegated ? 'dsh-native-delegation' : 'dsh-native-prompt',
    threadId: call.allriceThreadRef,
    employeeInstanceId: call.employeeInstanceId,
    employeeRelease: call.employeeRelease,
    personId: vm.personId,
    vmId: vm.vmId,
    rootSessionId: native.rootSessionId,
    adapterId: prompt.adapterId,
    loginSessionId: context.sessionId,
    nativeRequestId: prompt.requestId,
    ...(pin.forkedFromNativeSessionId && {
      forkedFromNativeSessionId: pin.forkedFromNativeSessionId,
    }),
  };
  const invocation = {
    source: 'dsh-native-attempt',
    profile: native.profile,
    sessionId: native.sessionId,
    parentSessionId: native.parentSessionId,
    nativeInstanceId: native.instanceId,
    vmInstanceId: vm.instanceId,
    leaseEpoch: vm.leaseEpoch,
    attemptId: native.attemptId!,
    kind: native.attemptKind!,
    cursor: native.attemptCursor!,
    turn: native.attemptTurn ?? null,
    contributingRequestIds,
    ...(delegated && directRequestIds.length ? { directRequestIds } : {}),
  };
  signal.throwIfAborted();
  await getDatabase().begin(async (tx) => {
    signal.throwIfAborted();
    await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,started_at)
      values (${execution.runId},${vm.organizationId},${identity.workspaceId},${vm.personId},'running',${tx.json(runSource)},clock_timestamp())
      on conflict (id) do nothing`;
    const [run] =
      await tx`select id from allrice_runs where id=${execution.runId}
      and organization_id=${vm.organizationId} and workspace_id=${identity.workspaceId} and owner_id=${vm.personId}
      and execution_spec=${tx.json(runSource)} for update`;
    if (!run) return reject();
    const [event] =
      await tx`select id from allrice_run_events where id=${execution.executionId}
      and run_id=${execution.runId} and event_type='step.started' and payload=${tx.json(invocation)}`;
    if (!event) {
      await tx`insert into allrice_run_events(id,organization_id,workspace_id,run_id,sequence,event_type,payload)
        select ${execution.executionId},${vm.organizationId},${identity.workspaceId},${execution.runId},
          coalesce(max(sequence)+1,0),'step.started',${tx.json(invocation)}
        from allrice_run_events where run_id=${execution.runId}`;
    }
    signal.throwIfAborted();
  });
  signal.throwIfAborted();
}

async function assertPersistedExecution(
  call: ModelCallBinding,
  signal: AbortSignal,
) {
  const { state, prompt, attempt } = await readDEntryNativeExecution(
    call.context,
    call.execution,
    signal,
  );
  if (
    prompt.loginSessionId !== call.context.sessionId ||
    prompt.threadId !== call.allriceThreadRef ||
    prompt.employeeRelease !== call.employeeRelease ||
    prompt.vmId !== call.vm.vmId ||
    attempt.vmInstanceId !== call.vm.instanceId ||
    attempt.leaseEpoch !== call.vm.leaseEpoch ||
    attempt.nativeInstanceId !== call.native.instanceId ||
    attempt.profile !== call.native.profile ||
    attempt.sessionId !== call.native.sessionId ||
    attempt.attemptId !== call.native.attemptId ||
    (state !== 'running' && call.native.attemptKind !== 'session-title')
  )
    return reject();
}

const wireSelection = z
  .object({
    sessionId: z.string().min(1).max(256),
    provider: z.literal('openai-codex'),
    model: z.string().min(1).max(128),
    adapterId: z.string().regex(/^[a-f0-9]{64}$/),
    recipient: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

async function readSelection(request: IncomingMessage, signal: AbortSignal) {
  const limit = 1024;
  const length = request.headers['content-length'];
  if (
    request.headers['content-type'] !== 'application/json' ||
    request.headers['transfer-encoding'] ||
    typeof length !== 'string' ||
    !/^[1-9][0-9]{0,3}$/.test(length) ||
    Number(length) > limit
  )
    throw new EgressError('DENIED');

  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => request.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of request) {
      signal.throwIfAborted();
      size += Buffer.byteLength(chunk);
      if (size > limit) throw new EgressError('DENIED');
      chunks.push(Buffer.from(chunk));
    }
    signal.throwIfAborted();
    if (size !== Number(length)) throw new EgressError('DENIED');
    try {
      return wireSelection.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
    } catch {
      throw new EgressError('DENIED');
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

type Installed = Awaited<
  ReturnType<ProductionNativeModelExecution['attach']>
> & {
  assertCall(call: ModelCallBinding, signal: AbortSignal): Promise<void>;
  deliverySignal(call: ModelCallBinding): AbortSignal;
  assertDeliveryObserved(
    call: ModelCallBinding,
    signal: AbortSignal,
  ): Promise<void>;
  confirmStopped(ownerId: string, signal: AbortSignal): Promise<string>;
};

const reject = (): never => {
  throw new ModelGatewayError('AUTHORIZATION_DENIED');
};

export function createProductionNativeModelExecution(): ProductionNativeModelExecution {
  let installed: Installed | undefined;

  return {
    authority: {
      async assertCall(call, signal) {
        if (!installed) return reject();
        await installed.assertCall(call, signal);
      },
      deliverySignal(call) {
        if (!installed) return reject();
        return installed.deliverySignal(call);
      },
      async assertDeliveryObserved(call, signal) {
        if (!installed) return reject();
        await installed.assertDeliveryObserved(call, signal);
      },
      async authorizeUsage(context, signal) {
        signal.throwIfAborted();
        if (context.actor.type !== 'user' || !context.workspaceId)
          return reject();
        await requireCurrentWorkspaceWriteAuthority(
          context,
          context.workspaceId,
        );
        signal.throwIfAborted();
        return {
          personId: context.actor.id,
          organizationId: context.organizationId,
        };
      },
      async confirmOwnerStopped(context, ownerId, signal) {
        signal.throwIfAborted();
        await requireCurrentPlatformAdmin(context, undefined, false);
        signal.throwIfAborted();
        if (!installed) return reject();
        return { evidenceRef: await installed.confirmStopped(ownerId, signal) };
      },
    },
    async attach(host, input) {
      if (installed) return reject();
      const stopped = new AbortController();
      const live = AbortSignal.any([
        host.lifetime,
        stopped.signal,
        input.routeRevoked,
      ]);
      const selected = new Map<
        string,
        {
          scope: PromptOwner;
          stop: AbortController;
          observation: NativePromptObservation;
          unknown: boolean;
          join(): Promise<void>;
        }
      >();
      const promptDispatches = new Map<string, Promise<void>>();
      const calls = new Map<
        string,
        {
          call: ModelCallBinding;
          scope: PromptOwner;
          revoke(): void;
          revokedAt: AbortSignal;
          redeemed: boolean;
          route: AbortSignal;
          delivery?: AbortSignal;
          persisted?: boolean;
          delegated: boolean;
          prompts: readonly NativePromptOccurrence[];
          inheritedPromptIndexes: readonly number[];
        }
      >();
      const operations = new Set<Promise<unknown>>();
      const executions = new WeakMap<PromptOwner, Map<string, string>>();
      const sourceExecutions = new WeakMap<
        PromptOwner,
        ModelCallBinding['execution']
      >();
      const trackedTurns = new WeakMap<PromptOwner, Set<PromptOwner>>();
      const endedPrompts = new WeakSet<PromptOwner>();
      const promptWatches = new Map<
        string,
        {
          stop: AbortController;
          ready: ReturnType<typeof watchDEntryNativeRosterAuthority>;
          count: number;
        }
      >();
      function acquirePromptWatch(
        key: string,
        create: (
          signal: AbortSignal,
        ) => ReturnType<typeof watchDEntryNativeRosterAuthority>,
      ) {
        let entry = promptWatches.get(key);
        if (!entry) {
          const stop = new AbortController();
          entry = { stop, ready: create(stop.signal), count: 0 };
          promptWatches.set(key, entry);
        }
        entry.count++;
        const watch = entry;
        let released = false;
        return {
          ready: watch.ready,
          async release() {
            if (released) return;
            released = true;
            if (--watch.count !== 0) return;
            promptWatches.delete(key);
            watch.stop.abort();
            await watch.ready.then(
              (ready) => ready.close(),
              () => {},
            );
          },
        };
      }
      let promptChange = new AbortController();
      function notifyPromptChange() {
        const was = promptChange;
        promptChange = new AbortController();
        was.abort();
      }
      function trackTurn(
        prompt: PromptOwner,
        owner: ReturnType<typeof host.startup.catalog>['owner'],
        address: SessionAddress,
        turn: number,
        coalesced: readonly PromptOwner[],
      ) {
        const existing = trackedTurns.get(prompt);
        if (existing) {
          for (const member of coalesced) existing.add(member);
          return;
        }
        const members = new Set(coalesced);
        trackedTurns.set(prompt, members);
        void run(live, async (active) => {
          await owner.waitNativeTurnEnd(prompt.context, address, turn, active);
          for (const member of members) endedPrompts.add(member);
          endedPrompts.add(prompt);
          notifyPromptChange();
        }).catch(() => {
          // A lost observation is not a fabricated Run terminal.
          trackedTurns.delete(prompt);
        });
      }
      const uninstall = host.startup.installModelAdapter(
        async (binding, signal) => {
          const active = AbortSignal.any([live, signal]);
          const modelMetadata = await input.readModelMetadata(active);
          const access = await host.providers.egressInstallation.readAccess(
            binding,
            active,
          );
          active.throwIfAborted();
          return {
            ...access,
            provider: input.route.provider,
            model: input.route.model,
            ...modelMetadata,
          };
        },
      );
      async function forgetPrompt(key: string) {
        const prompt = selected.get(key);
        if (!prompt) return;
        selected.delete(key);
        notifyPromptChange();
        prompt.stop.abort();
        const joined = prompt.join();
        operations.add(joined);
        try {
          await joined;
        } finally {
          operations.delete(joined);
        }
      }
      async function readPromptInsertions(
        adapterId: string,
        root: string,
        binding: PersonVmBinding,
        includes: (scope: PromptOwner) => boolean,
        signal: AbortSignal,
      ) {
        const candidates = [...selected.values()].filter(
          ({ scope }) =>
            scope.root === root &&
            scope.adapterId === adapterId &&
            sameVmBinding(scope.binding, binding) &&
            !scope.revoked.aborted &&
            includes(scope),
        );
        const insertions = await Promise.all(
          candidates.map(async ({ scope, observation }) => {
            try {
              const messageId = await observation.readInsertedMessageId(
                AbortSignal.any([signal, scope.revoked]),
              );
              if (messageId && !scope.revoked.aborted)
                return { scope, messageId };
            } catch {
              signal.throwIfAborted();
            }
          }),
        );
        return insertions.filter((entry) => entry !== undefined);
      }
      async function findPromptContributors(
        adapterId: string,
        root: string,
        binding: PersonVmBinding,
        prompts: readonly NativePromptOccurrence[],
        signal: AbortSignal,
      ) {
        const sourceKey = (
          source: Pick<
            PromptOwner,
            'sessionId' | 'parentSessionId' | 'scopeId' | 'requestId'
          >,
        ) =>
          JSON.stringify([
            source.sessionId,
            source.parentSessionId,
            source.scopeId,
            source.requestId,
          ]);
        const sources = new Set(prompts.map(sourceKey));
        const insertions = await readPromptInsertions(
          adapterId,
          root,
          binding,
          (scope) => sources.has(sourceKey(scope)),
          signal,
        );
        const matches = new Map<string, PromptOwner | undefined>();
        const key = (
          source: Parameters<typeof sourceKey>[0],
          messageId: string,
        ) => JSON.stringify([sourceKey(source), messageId]);
        for (const { scope, messageId } of insertions) {
          const id = key(scope, messageId);
          matches.set(id, matches.has(id) ? undefined : scope);
        }
        return readNativePromptContributors(prompts, (prompt) =>
          matches.get(key(prompt, prompt.messageId)),
        );
      }
      function conflictingLogin(
        adapterId: string,
        root: string,
        context: RequestContext,
      ) {
        return [...selected.values()].some(
          ({ scope: previous }) =>
            previous.adapterId === adapterId &&
            previous.root === root &&
            !previous.revoked.aborted &&
            !endedPrompts.has(previous) &&
            previous.context.sessionId !== context.sessionId,
        );
      }
      async function waitForLoginOwner(
        adapterId: string,
        root: string,
        context: RequestContext,
        mode: 'queue' | 'steer',
        active: AbortSignal,
      ) {
        // Keep native queued sends ordered by admitted login. A different login
        // cannot steer the open turn owned by another response scope.
        while (conflictingLogin(adapterId, root, context)) {
          if (mode === 'steer') throw new PersonVmError('VM_ACTIVE');
          const wake = AbortSignal.any([active, promptChange.signal]);
          if (!wake.aborted)
            await new Promise<void>((resolve) =>
              wake.addEventListener('abort', () => resolve(), { once: true }),
            );
          active.throwIfAborted();
        }
      }
      const uninstallPrompt = host.startup.installModelPromptObserver(
        (request, signal) =>
          run(signal, async (active) => {
            active.throwIfAborted();
            const { binding, adapterId, context, issue } = request;
            const { identity } = issue;
            if (issue.access !== 'execute' || !identity.threadId)
              return reject();
            const profile = host.startup.catalog(
              binding,
              identity.employeeInstanceId,
            );
            if (profile.owner.modelAdapterId !== adapterId) return reject();
            const root = await getDEntryNativeRootPin(context, {
              workspaceId: identity.workspaceId,
              employeeInstanceId: identity.employeeInstanceId,
              threadId: identity.threadId,
            });
            if (
              root.vmId !== binding.vmId ||
              root.rootNativeSessionId !== issue.root.nativeSessionId ||
              root.rootBindingRef !== issue.root.rootBindingRef ||
              root.rootOriginDigest !== issue.root.rootOriginDigest ||
              root.forkedFromNativeSessionId !==
                issue.root.forkedFromNativeSessionId
            )
              return reject();
            const authorityKey = JSON.stringify([
              adapterId,
              profile.owner.nativeInstanceId,
              profile.bindingRef,
              profile.receipt.rosterDigest,
              binding.vmId,
              binding.instanceId,
              binding.leaseEpoch,
              binding.organizationId,
              binding.personId,
              identity.organizationId,
              identity.workspaceId,
              identity.personId,
              identity.employeeInstanceId,
              identity.employeeRevision,
              identity.employeeVersionId,
              identity.threadId,
              root.rootNativeSessionId,
              root.rootBindingRef,
              root.rootOriginDigest,
              context.sessionId,
            ]);
            async function assertWakeOwner(current: AbortSignal) {
              const wake = await profile.owner.readNativeRootWakeFor(
                context,
                root.rootNativeSessionId,
                current,
              );
              if (wake.kind === 'clear') return;
              if (wake.kind !== 'delegated')
                throw new PersonVmError('VM_ACTIVE');
              const claimed = await findPromptContributors(
                adapterId,
                root.rootNativeSessionId,
                binding,
                wake.prompts,
                current,
              );
              if (!claimed || claimed.first.authorityKey !== authorityKey)
                throw new PersonVmError('VM_ACTIVE');
              await Promise.all(
                claimed.contributors.map((member, index) =>
                  member.assertClaimed(current, wake.prompts[index]!),
                ),
              );
            }
            if (request.endpoint === 'session/updateQueue') {
              const current = AbortSignal.any([active, profile.revoked]);
              current.throwIfAborted();
              if (
                conflictingLogin(adapterId, root.rootNativeSessionId, context)
              )
                throw new PersonVmError('VM_ACTIVE');
              if (request.child && request.action === 'steer') {
                const { sessionId, parentSessionId } = request.child;
                const insertions = await readPromptInsertions(
                  adapterId,
                  root.rootNativeSessionId,
                  binding,
                  (scope) =>
                    scope.authorityKey === authorityKey &&
                    scope.sessionId === sessionId &&
                    scope.parentSessionId === parentSessionId,
                  current,
                );
                if (
                  insertions.filter(
                    ({ messageId }) => messageId === request.itemId,
                  ).length !== 1
                )
                  throw new PersonVmError('VM_ACTIVE');
              }
              await assertWakeOwner(current);
              current.throwIfAborted();
              if (
                conflictingLogin(adapterId, root.rootNativeSessionId, context)
              )
                throw new PersonVmError('VM_ACTIVE');
              return;
            }
            const { requestId, mode, observe, child } = request;
            const sessionId = child?.sessionId ?? root.rootNativeSessionId;
            const requestKey = promptKey(adapterId, sessionId, requestId);
            for (
              let previous = promptDispatches.get(requestKey);
              previous;
              previous = promptDispatches.get(requestKey)
            ) {
              await waitForPromptFact(previous, active);
            }
            const dispatch = deferredPromptFact<void>();
            promptDispatches.set(requestKey, dispatch.promise);
            const dispatched = () => {
              if (promptDispatches.get(requestKey) === dispatch.promise) {
                promptDispatches.delete(requestKey);
                dispatch.resolve();
              }
            };
            const close = new AbortController();
            let retireUndispatched = async () => {
              close.abort();
            };
            try {
              if (
                [...selected.values()].some(
                  ({ scope, observation, unknown }) =>
                    unknown &&
                    !observation.inserted() &&
                    !scope.revoked.aborted &&
                    promptKey(
                      scope.adapterId,
                      scope.sessionId,
                      scope.requestId,
                    ) === requestKey,
                )
              )
                return reject();
              await waitForLoginOwner(
                adapterId,
                root.rootNativeSessionId,
                context,
                mode,
                active,
              );
              const route = await input.assertRouteCurrent(active);
              const authority = acquirePromptWatch(authorityKey, (watching) =>
                watchDEntryNativeRosterAuthority(
                  context,
                  {
                    workspaceId: identity.workspaceId,
                    employeeInstanceId: identity.employeeInstanceId,
                    threadId: identity.threadId,
                  },
                  identity,
                  AbortSignal.any([live, route, profile.revoked, watching]),
                  {
                    verifyBinding: (current) =>
                      host.vm.assertCurrentBinding(context, binding, current),
                    async verifyRoster(current) {
                      const observed = await currentDEntryNativeOwner(
                        dEntryNativeOwnerPort,
                        context,
                        identity,
                        current,
                      );
                      if (
                        !sameVmBinding(
                          observed.view.receipt.binding,
                          binding,
                        ) ||
                        observed.view.bindingRef !== profile.bindingRef ||
                        observed.view.receipt.rosterDigest !==
                          profile.receipt.rosterDigest
                      )
                        return reject();
                    },
                  },
                ),
              );
              retireUndispatched = async () => {
                close.abort();
                await authority.release();
              };
              const watch = await authority.ready;
              const revoked = AbortSignal.any([
                watch.revoked,
                route,
                profile.revoked,
                close.signal,
              ]);
              const admission = AbortSignal.any([active, revoked]);
              while (
                conflictingLogin(adapterId, root.rootNativeSessionId, context)
              )
                await waitForLoginOwner(
                  adapterId,
                  root.rootNativeSessionId,
                  context,
                  mode,
                  admission,
                );
              admission.throwIfAborted();
              const observation = observe(revoked);
              const scope: PromptOwner = Object.freeze({
                context: structuredClone(context),
                identity,
                binding,
                adapterId,
                root: root.rootNativeSessionId,
                sessionId,
                ...(child && { parentSessionId: child.parentSessionId }),
                ...(root.forkedFromNativeSessionId && {
                  forkedFromNativeSessionId: root.forkedFromNativeSessionId,
                }),
                authorityKey,
                revoked,
                requestId,
                scopeId: issue.scopeId,
                assertObserved: watch.assertObserved,
                assertClaimed: observation.assertClaimed,
                runId: randomUUID(),
              });
              const key = scope.runId;
              const retire = () => {
                void forgetPrompt(key).catch(() => {});
              };
              const entry = {
                scope,
                stop: close,
                observation,
                unknown: false,
                async join() {
                  revoked.removeEventListener('abort', retire);
                  await Promise.all([observation.close(), authority.release()]);
                },
              };
              selected.set(key, entry);
              retireUndispatched = () => forgetPrompt(key);
              revoked.addEventListener('abort', retire, { once: true });
              void observation.settled
                .then(async (outcome) => {
                  if (selected.get(key) !== entry) return;
                  if (outcome === 'discarded') return forgetPrompt(key);
                  // An ended prompt loses its queue occupancy. Keep its exact
                  // claimed source under the shared authority for native descendants.
                  endedPrompts.add(scope);
                  notifyPromptChange();
                })
                .catch(() => {
                  // Loss of the carrier proves neither discard nor turn end.
                });
              await waitForPromptFact(observation.ready, admission);
              if (mode === 'steer') await assertWakeOwner(admission);
              admission.throwIfAborted();
              return {
                async undispatched() {
                  try {
                    await forgetPrompt(key);
                  } finally {
                    dispatched();
                  }
                },
                accepted() {
                  dispatched();
                  if (revoked.aborted || observation.inserted()) return;
                  void run(revoked, async () => {
                    if (await observation.confirmedReplay())
                      await forgetPrompt(key);
                  }).catch(() => {
                    // A missing exact replay proof cannot release this scope.
                  });
                },
                unknown() {
                  entry.unknown = true;
                  dispatched();
                },
              };
            } catch (error) {
              try {
                await retireUndispatched();
              } finally {
                dispatched();
              }
              throw error;
            }
          }),
      );
      function run<T>(
        signal: AbortSignal,
        work: (active: AbortSignal) => Promise<T>,
      ) {
        const active = AbortSignal.any([live, signal]);
        active.throwIfAborted();
        const task = Promise.resolve().then(() => work(active));
        operations.add(task);
        const settle = () => operations.delete(task);
        void task.then(settle, settle);
        return task;
      }
      async function resolveSession(
        scope: NativeModelSelection,
        sessionId: string,
        kind: NativeModelAttemptKind,
        signal: AbortSignal,
      ) {
        const active = AbortSignal.any([signal, scope.revoked]);
        active.throwIfAborted();
        const { context, identity, binding } = scope;
        const current = await currentDEntryNativeOwner(
          dEntryNativeOwnerPort,
          context,
          identity,
          active,
        );
        const profile = host.startup.catalog(
          binding,
          identity.employeeInstanceId,
        );
        if (
          !sameVmBinding(binding, current.view.receipt.binding) ||
          current.view.bindingRef !== profile.bindingRef ||
          !profile.owner.modelAdapterId ||
          profile.endpoint.employeeVersionId !== identity.employeeVersionId ||
          profile.endpoint.employeeRevision !== identity.employeeRevision
        )
          return reject();
        profile.revoked.throwIfAborted();
        const resource = await resolveDEntryNativeResource({
          context,
          identity,
          owner: current.owner,
          nativeSessionId: sessionId,
          requireLiveAgent: true,
          signal: active,
        });
        if (!('nativeAddress' in resource) || !resource.nativeAddress)
          return reject();
        const attempt = await profile.owner.readNativeAttemptFor(
          context,
          resource.nativeAddress,
          active,
          kind,
        );
        profile.revoked.throwIfAborted();
        active.throwIfAborted();
        if (!attempt) return reject();
        return { resource, profile, attempt };
      }
      async function assertDelegatedOrigins(
        scope: PromptOwner,
        contributing: readonly PromptOwner[],
        call: ModelCallBinding,
        signal: AbortSignal,
      ) {
        const checked = new Map<
          string,
          Awaited<ReturnType<typeof readDEntryNativeExecution>>
        >();
        for (const member of contributing) {
          const ids = sourceExecutions.get(member);
          if (!ids) return reject();
          let original = checked.get(ids.executionId);
          if (!original) {
            original = await readDEntryNativeExecution(
              scope.context,
              ids,
              signal,
            );
            checked.set(ids.executionId, original);
          }
          const { prompt, attempt } = original;
          if (
            (prompt.source !== 'dsh-native-prompt' &&
              !(
                'directRequestIds' in attempt &&
                Array.isArray(attempt.directRequestIds) &&
                attempt.directRequestIds.includes(member.requestId)
              )) ||
            prompt.rootSessionId !== scope.root ||
            prompt.loginSessionId !== scope.context.sessionId ||
            prompt.threadId !== call.allriceThreadRef ||
            prompt.employeeInstanceId !== scope.identity.employeeInstanceId ||
            prompt.employeeRelease !== scope.identity.employeeVersionId ||
            prompt.vmId !== call.vm.vmId ||
            prompt.adapterId !== scope.adapterId ||
            attempt.nativeInstanceId !== call.native.instanceId ||
            attempt.vmInstanceId !== call.vm.instanceId ||
            attempt.leaseEpoch !== call.vm.leaseEpoch ||
            attempt.sessionId !== member.sessionId ||
            attempt.parentSessionId !== (member.parentSessionId ?? null) ||
            attempt.kind !== 'assistant' ||
            !attempt.contributingRequestIds.includes(member.requestId)
          )
            return reject();
        }
      }
      async function readAuthorizedCall(
        call: ModelCallBinding,
        signal: AbortSignal,
      ) {
        return run(signal, async (active) => {
          const owned = calls.get(call.native.callId);
          if (
            !owned ||
            owned.scope.revoked.aborted ||
            JSON.stringify(call) !== JSON.stringify(owned.call)
          )
            return reject();
          await input.assertRouteCurrent(active);
          if (owned.persisted) await assertPersistedExecution(call, active);
          const { resource, profile, attempt } = await resolveSession(
            owned.scope,
            call.native.sessionId,
            call.native.attemptKind ?? 'assistant',
            active,
          );
          if (
            attempt.kind !== call.native.attemptKind ||
            attempt.id !== call.native.attemptId ||
            attempt.turn !== call.native.attemptTurn ||
            attempt.cursor !== call.native.attemptCursor ||
            attempt.rootSessionId !== call.native.rootSessionId ||
            attempt.delegated !== owned.delegated ||
            JSON.stringify(attempt.prompts) !== JSON.stringify(owned.prompts) ||
            JSON.stringify(attempt.inheritedPromptIndexes) !==
              JSON.stringify(owned.inheritedPromptIndexes) ||
            resource.rootNativeSessionId !== call.native.rootSessionId ||
            resource.parentNativeSessionId !== call.native.parentSessionId ||
            resource.threadId !== call.allriceThreadRef ||
            resource.bindingRef !== profile.bindingRef ||
            profile.owner.nativeInstanceId !== call.native.instanceId ||
            profile.owner.modelAdapterId !== call.native.profile
          )
            return reject();
          await input.assertRouteCurrent(active);
          return { owner: profile.owner, attempt };
        });
      }
      async function assertCall(call: ModelCallBinding, signal: AbortSignal) {
        await readAuthorizedCall(call, signal);
      }

      const paths = [
        ['assistant', '/v1/reference'],
        ['compaction', '/v1/reference/compaction'],
        ['session-title', '/v1/reference/session-title'],
      ] as const;
      const references = paths.map<ManagedHostService>(([kind, path]) => ({
        id: 'model-reference',
        path,
        method: 'POST',
        admissionOwner: 'service',
        async resolve(request, binding, signal) {
          return run(signal, async (active) => {
            const route = await input.assertRouteCurrent(active);
            const wanted = await readSelection(request, active);
            if (
              wanted.provider !== input.route.provider ||
              wanted.model !== input.route.model
            )
              return reject();
            let matched:
              | {
                  scope: PromptOwner;
                  call: ModelCallBinding;
                  owner: ReturnType<typeof host.startup.catalog>['owner'];
                  address: SessionAddress;
                  sourceTurn: number;
                  coalesced: readonly PromptOwner[];
                  delegated: boolean;
                  prompts: readonly NativePromptOccurrence[];
                  inheritedPromptIndexes: readonly number[];
                }
              | undefined;
            const checked = new Set<string>();
            for (const [key, { scope: probe }] of selected) {
              if (
                probe.adapterId !== wanted.adapterId ||
                !sameVmBinding(probe.binding, binding)
              )
                continue;
              if (probe.revoked.aborted) {
                await forgetPrompt(key);
                continue;
              }
              // Every admitted prompt in this authority scope shares the same
              // current subject and exact owner. Only native proof selects IDs.
              if (checked.has(probe.authorityKey)) continue;
              checked.add(probe.authorityKey);
              const resolved = await resolveSession(
                probe,
                wanted.sessionId,
                kind,
                active,
              ).catch(async (error: unknown) => {
                if (
                  error instanceof DataAccessError &&
                  error.code === 'not_found'
                ) {
                  // Resource absence can mean the requested session belongs to
                  // another root. Recheck this candidate's own selector before
                  // removing its prompt authority.
                  const keySelection = {
                    workspaceId: probe.identity.workspaceId,
                    employeeInstanceId: probe.identity.employeeInstanceId,
                    threadId: probe.identity.threadId,
                  };
                  try {
                    await requireDEntryNativeIdentity(
                      probe.context,
                      keySelection,
                    );
                  } catch (identityError) {
                    if (
                      identityError instanceof DataAccessError &&
                      identityError.code === 'not_found'
                    )
                      await forgetPrompt(key);
                    else if (!probe.revoked.aborted) throw identityError;
                  }
                  return null;
                }
                if (
                  probe.revoked.aborted ||
                  (error instanceof DataAccessError &&
                    error.code === 'authorization_denied') ||
                  (error instanceof IdentityError &&
                    error.code === 'authorization_denied')
                )
                  return null;
                throw error;
              });
              if (!resolved) continue;
              const { resource, profile, attempt } = resolved;
              if (
                profile.owner.modelAdapterId !== wanted.adapterId ||
                resource.rootNativeSessionId !== probe.root ||
                attempt.rootSessionId !== probe.root ||
                attempt.sourceTurn === null ||
                !attempt.recipient ||
                !timingSafeEqual(
                  Buffer.from(attempt.recipient),
                  Buffer.from(wanted.recipient),
                )
              )
                continue;
              const proven = await findPromptContributors(
                wanted.adapterId,
                probe.root,
                binding,
                attempt.prompts,
                active,
              );
              if (!proven) return reject();
              const { first: scope, contributors: coalesced } = proven;
              if (scope.authorityKey !== probe.authorityKey) continue;
              await Promise.all(
                coalesced.map((member, index) =>
                  member.assertClaimed(active, attempt.prompts[index]!),
                ),
              );
              let scopeExecutions = executions.get(scope);
              if (!scopeExecutions) {
                scopeExecutions = new Map();
                executions.set(scope, scopeExecutions);
              }
              const execution = nativeRunExecutionIds(
                scopeExecutions,
                scope.runId,
                {
                  ...attempt,
                  sessionId: resource.nativeSessionId,
                  sourceTurn: attempt.sourceTurn,
                },
              );
              matched = {
                scope,
                owner: profile.owner,
                address: resource.nativeAddress!,
                sourceTurn: attempt.sourceTurn,
                coalesced,
                prompts: attempt.prompts,
                delegated: attempt.delegated,
                inheritedPromptIndexes: attempt.inheritedPromptIndexes,
                call: {
                  context: structuredClone(scope.context),
                  vm: binding,
                  execution,
                  employeeInstanceId: scope.identity.employeeInstanceId,
                  employeeRelease: scope.identity.employeeVersionId,
                  allriceThreadRef: resource.threadId,
                  native: {
                    instanceId: profile.owner.nativeInstanceId,
                    profile: profile.owner.modelAdapterId!,
                    sessionId: resource.nativeSessionId,
                    rootSessionId: resource.rootNativeSessionId,
                    parentSessionId: resource.parentNativeSessionId,
                    callId: randomUUID(),
                    attemptKind: attempt.kind,
                    attemptId: attempt.id,
                    attemptTurn: attempt.turn,
                    attemptCursor: attempt.cursor,
                  },
                  executionGeneration: '4.0',
                  gatewayRelease:
                    host.providers.applicationBuild.manifestDigest,
                  provider: wanted.provider,
                  model: wanted.model,
                },
              };
              break;
            }
            if (!matched) return reject();
            const {
              scope,
              call,
              owner: profileOwner,
              address,
              sourceTurn,
              coalesced,
              prompts,
              delegated,
              inheritedPromptIndexes,
            } = matched;
            const callId = call.native.callId;
            const deadline = AbortSignal.timeout(30_000);
            const effective = AbortSignal.any([
              live,
              scope.revoked,
              route,
              deadline,
            ]);
            const revoke = () => {
              calls.delete(callId);
            };
            const entry: NonNullable<ReturnType<typeof calls.get>> = {
              scope,
              call,
              revokedAt: effective,
              revoke,
              redeemed: false,
              route,
              delegated,
              prompts,
              inheritedPromptIndexes,
            };
            calls.set(callId, entry);
            effective.addEventListener('abort', revoke, { once: true });
            try {
              // Denial at egress removes the pending context before it can issue a ticket.
              const abort = () => {
                if (!issued) revoke();
              };
              let issued = false;
              signal.addEventListener('abort', abort, { once: true });
              effective.throwIfAborted();
              input.bindReference(call, signal);
              return {
                context: call.context,
                async dispatch(response, current) {
                  current.throwIfAborted();
                  try {
                    const authorization = AbortSignal.any([current, effective]);
                    const reference = await host.issueReference(
                      call,
                      authorization,
                      async (admitted) => {
                        const inherited = new Set(inheritedPromptIndexes);
                        const direct = coalesced.filter(
                          (_, index) => !inherited.has(index),
                        );
                        await assertDelegatedOrigins(
                          scope,
                          coalesced.filter((_, index) => inherited.has(index)),
                          call,
                          admitted,
                        );
                        await persistExecution(
                          call,
                          scope,
                          coalesced.map((member) => member.requestId).sort(),
                          direct.map((member) => member.requestId).sort(),
                          delegated,
                          admitted,
                        );
                        entry.persisted = true;
                        await assertPersistedExecution(call, admitted);
                        if (kind === 'assistant')
                          for (const member of direct)
                            sourceExecutions.set(member, call.execution);
                        if (!delegated)
                          trackTurn(
                            scope,
                            profileOwner,
                            address,
                            sourceTurn,
                            coalesced,
                          );
                        await host.reserveNativeModelCall(call);
                        admitted.throwIfAborted();
                        return input.issueCall(
                          call,
                          effective,
                          wanted.recipient,
                        );
                      },
                    );
                    current.throwIfAborted();
                    issued = true;
                    response.writeHead(200, {
                      'content-type': 'application/json',
                      'cache-control': 'no-store',
                    });
                    response.end(JSON.stringify({ reference }));
                  } catch (error) {
                    revoke();
                    throw error;
                  } finally {
                    signal.removeEventListener('abort', abort);
                  }
                },
              };
            } catch (error) {
              revoke();
              throw error;
            }
          });
        },
      }));
      let closing: Promise<void> | undefined;
      const owner: Installed = {
        assertCall,
        confirmStopped: input.confirmTransportStopped,
        deliverySignal(call) {
          const entry = calls.get(call.native.callId);
          if (
            !entry?.delivery ||
            JSON.stringify(call) !== JSON.stringify(entry.call)
          )
            return reject();
          return entry.delivery;
        },
        async assertDeliveryObserved(call, signal) {
          const entry = calls.get(call.native.callId);
          if (
            !entry?.delivery ||
            JSON.stringify(call) !== JSON.stringify(entry.call)
          )
            return reject();
          entry.delivery.throwIfAborted();
          await entry.scope.assertObserved(signal);
          entry.delivery.throwIfAborted();
        },
        readModelImage(call, ref, target, signal) {
          return run(signal, async (active) => {
            const { owner, attempt } = await readAuthorizedCall(call, active);
            const image = await owner.readManagedModelImageFor(
              call.context,
              {
                sessionId: call.native.sessionId,
                kind: attempt.kind,
                id: attempt.id,
              },
              ref,
              target,
              active,
            );
            await readAuthorizedCall(call, active);
            active.throwIfAborted();
            return image;
          });
        },
        references,
        redeem(call, signal) {
          const entry = calls.get(call.native.callId);
          if (
            !entry ||
            entry.redeemed ||
            JSON.stringify(entry.call) !== JSON.stringify(call)
          )
            return reject();
          signal.throwIfAborted();
          entry.redeemed = true;
          entry.revokedAt.removeEventListener('abort', entry.revoke);
          const active = AbortSignal.any([
            live,
            entry.scope.revoked,
            entry.route,
            signal,
          ]);
          active.throwIfAborted();
          entry.delivery = active;
          active.addEventListener('abort', entry.revoke, { once: true });
        },
        async resolveSendRoute({ modelAdapterId }, signal) {
          const active = AbortSignal.any([signal, live]);
          await input.assertRouteCurrent(active);
          if (!modelAdapterId) throw new PersonVmError('RUNTIME_NOT_READY');
          active.throwIfAborted();
          return {
            provider: input.route.provider,
            model: input.route.model,
            revoked: live,
          };
        },
        async activity(binding, signal) {
          signal.throwIfAborted();
          let activeTurns = 0;
          for (const entry of calls.values())
            if (entry.redeemed && sameVmBinding(entry.call.vm, binding))
              activeTurns++;
          // Model streams alone cannot prove that the autonomous VM is idle.
          return {
            binding,
            observedAt: new Date().toISOString(),
            state: 'unknown',
            activeTurns,
            activeJobs: 0,
            activeSubtasks: 0,
            pendingApprovals: 0,
          };
        },
        close() {
          if (closing) return closing;
          stopped.abort();
          uninstall();
          uninstallPrompt();
          return (closing = (async () => {
            while (operations.size) await Promise.allSettled([...operations]);
            await Promise.all([...selected.keys()].map(forgetPrompt));
          })());
        },
      };
      installed = owner;
      void run(live, (active) =>
        reconcileNativeRunTerminals(host.startup, active),
      ).catch(() => {});
      return owner;
    },
  };
}
