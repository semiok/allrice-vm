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
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types';
import type { ProductionNativeModelExecution } from './production-sources.js';

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
    adapterId: string;
    root: string;
    assertObserved(signal: AbortSignal): Promise<void>;
  }>;

const promptKey = (adapterId: string, root: string, requestId: string) =>
  JSON.stringify([adapterId, root, requestId]);

async function persistExecution(
  call: ModelCallBinding,
  prompt: PromptOwner,
  contributingRequestIds: readonly string[],
  signal: AbortSignal,
) {
  const { context, vm, native, execution } = call;
  const identity = prompt.identity;
  const pin = await getDEntryNativeRootPin(context, {
    workspaceId: identity.workspaceId,
    employeeInstanceId: identity.employeeInstanceId,
    threadId: call.allriceThreadRef,
  });
  if (pin.vmId !== vm.vmId || pin.rootNativeSessionId !== native.rootSessionId)
    return reject();
  const runSource = {
    generation: '4.0',
    source: 'dsh-native-prompt',
    threadId: call.allriceThreadRef,
    employeeInstanceId: call.employeeInstanceId,
    employeeRelease: call.employeeRelease,
    personId: vm.personId,
    vmId: vm.vmId,
    rootSessionId: native.rootSessionId,
    adapterId: prompt.adapterId,
    loginSessionId: context.sessionId,
    nativeRequestId: prompt.requestId,
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

async function publishObservedRunEnd(
  prompt: PromptOwner,
  turn: number,
  end: { sequence: number; reason: string },
) {
  const state =
    end.reason === 'completed'
      ? 'succeeded'
      : ['aborted', 'interrupted'].includes(end.reason)
        ? 'canceled'
        : ['blocked', 'error', 'max-tokens'].includes(end.reason)
          ? 'failed'
          : null;
  if (!state) return;
  const kind =
    state === 'succeeded'
      ? 'run.succeeded'
      : state === 'canceled'
        ? 'run.canceled'
        : 'run.failed';
  const { context, identity, runId } = prompt;
  await getDatabase().begin(async (tx) => {
    const [row] =
      await tx`update allrice_runs set state=${state},completed_at=clock_timestamp(),updated_at=clock_timestamp()
      where id=${runId} and organization_id=${identity.organizationId}
        and workspace_id=${identity.workspaceId} and owner_id=${identity.personId}
        and execution_spec->>'source'='dsh-native-prompt'
        and execution_spec->>'loginSessionId'=${context.sessionId}
        and state='running' returning id`;
    if (!row) return;
    await tx`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      select ${identity.organizationId},${identity.workspaceId},${runId},coalesce(max(sequence)+1,0),${kind},
        ${tx.json({ source: 'dsh-native-turn-end', sessionId: prompt.root, turn, nativeSequence: end.sequence, reason: end.reason })}
      from allrice_run_events where run_id=${runId}`;
  });
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
          join(): Promise<void>;
        }
      >();
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
        }
      >();
      const operations = new Set<Promise<unknown>>();
      const executions = new WeakMap<PromptOwner, Map<string, string>>();
      const trackedTurns = new WeakMap<PromptOwner, Set<PromptOwner>>();
      const endedPrompts = new WeakSet<PromptOwner>();
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
          const end = await owner.waitNativeTurnEnd(
            prompt.context,
            address,
            turn,
            active,
          );
          await publishObservedRunEnd(prompt, turn, end);
          for (const member of members) endedPrompts.add(member);
          endedPrompts.add(prompt);
          notifyPromptChange();
          await releaseFinishedPrompts(prompt.adapterId, prompt.root);
        }).catch(() => {
          // A lost observation is not a fabricated Run terminal.
          trackedTurns.delete(prompt);
        });
      }
      const uninstall = host.startup.installModelAdapter(
        async (binding, signal) => {
          const active = AbortSignal.any([live, signal]);
          const modelInfo = await input.readModelInfo(active);
          const access = await host.providers.egressInstallation.readAccess(
            binding,
            active,
          );
          active.throwIfAborted();
          return {
            ...access,
            provider: input.route.provider,
            model: input.route.model,
            modelInfo,
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
      async function releaseFinishedPrompts(adapterId: string, root: string) {
        const scopes = [...selected].filter(
          ([, entry]) =>
            entry.scope.adapterId === adapterId && entry.scope.root === root,
        );
        const latest = scopes.at(-1)?.[0];
        await Promise.all(
          scopes.map(([key, { scope }]) =>
            key !== latest &&
            endedPrompts.has(scope) &&
            !Array.from(calls.values()).some((entry) => entry.scope === scope)
              ? forgetPrompt(key)
              : undefined,
          ),
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
        ({ binding, adapterId, context, issue, requestId, mode }, signal) =>
          run(signal, async (active) => {
            active.throwIfAborted();
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
              root.rootOriginDigest !== issue.root.rootOriginDigest
            )
              return reject();
            const key = promptKey(
              adapterId,
              root.rootNativeSessionId,
              requestId,
            );
            if (selected.has(key)) return reject();
            await waitForLoginOwner(
              adapterId,
              root.rootNativeSessionId,
              context,
              mode,
              active,
            );
            const route = await input.assertRouteCurrent(active);
            const close = new AbortController();
            const watching = AbortSignal.any([
              live,
              route,
              profile.revoked,
              close.signal,
            ]);
            const watch = await watchDEntryNativeRosterAuthority(
              context,
              {
                workspaceId: identity.workspaceId,
                employeeInstanceId: identity.employeeInstanceId,
                threadId: identity.threadId,
              },
              identity,
              watching,
              async (current) => {
                const observed = await currentDEntryNativeOwner(
                  dEntryNativeOwnerPort,
                  context,
                  identity,
                  current,
                );
                if (
                  !sameVmBinding(observed.view.receipt.binding, binding) ||
                  observed.view.bindingRef !== profile.bindingRef ||
                  observed.view.receipt.rosterDigest !==
                    profile.receipt.rosterDigest
                )
                  return reject();
              },
            );
            const scope: PromptOwner = Object.freeze({
              context: structuredClone(context),
              identity,
              binding,
              adapterId,
              root: root.rootNativeSessionId,
              revoked: AbortSignal.any([watch.revoked, watching]),
              requestId,
              assertObserved: watch.assertObserved,
              runId: randomUUID(),
            });
            if (active.aborted || scope.revoked.aborted || selected.has(key)) {
              close.abort();
              await watch.close();
              return reject();
            }
            try {
              while (
                conflictingLogin(adapterId, root.rootNativeSessionId, context)
              )
                await waitForLoginOwner(
                  adapterId,
                  root.rootNativeSessionId,
                  context,
                  mode,
                  AbortSignal.any([active, scope.revoked]),
                );
              active.throwIfAborted();
              scope.revoked.throwIfAborted();
              if (selected.has(key)) return reject();
              const retire = () => {
                void forgetPrompt(key).catch(() => {});
              };
              const join = async () => {
                scope.revoked.removeEventListener('abort', retire);
                await watch.close();
              };
              selected.set(key, { scope, stop: close, join });
              scope.revoked.addEventListener('abort', retire, { once: true });
              await releaseFinishedPrompts(adapterId, root.rootNativeSessionId);
              active.throwIfAborted();
              scope.revoked.throwIfAborted();
              return () => forgetPrompt(key);
            } catch (error) {
              if (selected.get(key)?.scope === scope) await forgetPrompt(key);
              else {
                close.abort();
                await watch.close();
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
                  order: number;
                  sourceTurn: number | null;
                }
              | undefined;
            const coalesced: PromptOwner[] = [];
            for (const [key, { scope }] of selected) {
              if (
                scope.adapterId !== wanted.adapterId ||
                !sameVmBinding(scope.binding, binding)
              )
                continue;
              if (scope.revoked.aborted) {
                await forgetPrompt(key);
                continue;
              }
              const resolved = await resolveSession(
                scope,
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
                    workspaceId: scope.identity.workspaceId,
                    employeeInstanceId: scope.identity.employeeInstanceId,
                    threadId: scope.identity.threadId,
                  };
                  try {
                    await requireDEntryNativeIdentity(
                      scope.context,
                      keySelection,
                    );
                  } catch (identityError) {
                    if (
                      identityError instanceof DataAccessError &&
                      identityError.code === 'not_found'
                    )
                      await forgetPrompt(key);
                    else if (!scope.revoked.aborted) throw identityError;
                  }
                  return null;
                }
                if (
                  scope.revoked.aborted ||
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
                resource.rootNativeSessionId !== scope.root ||
                !attempt.promptIds.includes(scope.requestId) ||
                !attempt.recipient ||
                !timingSafeEqual(
                  Buffer.from(attempt.recipient),
                  Buffer.from(wanted.recipient),
                )
              )
                continue;
              let scopeExecutions = executions.get(scope);
              if (!scopeExecutions) {
                scopeExecutions = new Map();
                executions.set(scope, scopeExecutions);
              }
              const executionKey = JSON.stringify([
                resource.nativeSessionId,
                kind,
                attempt.id,
              ]);
              const executionId =
                scopeExecutions.get(executionKey) ?? randomUUID();
              scopeExecutions.set(executionKey, executionId);
              const order = attempt.promptIds.indexOf(scope.requestId);
              if (
                matched &&
                matched.scope.context.sessionId !== scope.context.sessionId
              )
                return reject();
              coalesced.push(scope);
              if (matched && matched.order < order) continue;
              matched = {
                scope,
                owner: profile.owner,
                address: resource.nativeAddress!,
                order,
                sourceTurn: attempt.sourceTurn,
                call: {
                  context: structuredClone(scope.context),
                  vm: binding,
                  execution: {
                    runId: scope.runId,
                    executionId,
                  },
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
            }
            if (!matched) return reject();
            const {
              scope,
              call,
              owner: profileOwner,
              address,
              sourceTurn,
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
              void releaseFinishedPrompts(scope.adapterId, scope.root).catch(
                () => {},
              );
            };
            const entry: NonNullable<ReturnType<typeof calls.get>> = {
              scope,
              call,
              revokedAt: effective,
              revoke,
              redeemed: false,
              route,
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
                        await persistExecution(
                          call,
                          scope,
                          coalesced.map((member) => member.requestId).sort(),
                          admitted,
                        );
                        entry.persisted = true;
                        await assertPersistedExecution(call, admitted);
                        if (
                          sourceTurn !== null &&
                          call.native.parentSessionId === null
                        )
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
      return owner;
    },
  };
}
