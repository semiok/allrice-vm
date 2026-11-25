import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import {
  DataAccessError,
  IdentityError,
  getDEntryHistoryRootPin,
  requireCurrentPlatformAdmin,
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
import type { ProductionNativeModelExecution } from './production-sources.js';

export type NativeModelSelection = Readonly<{
  context: RequestContext;
  identity: DEntryIdentity;
  binding: PersonVmBinding;
  revoked: AbortSignal;
}>;

const wireSelection = z
  .object({
    sessionId: z.string().min(1).max(256),
    provider: z.literal('openai-codex'),
    model: z.string().min(1).max(128),
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
          scope: NativeModelSelection;
          unlink(): void;
        }
      >();
      const calls = new Map<
        string,
        {
          call: ModelCallBinding;
          scope: NativeModelSelection;
          revoke(): void;
          revokedAt: AbortSignal;
          redeemed: boolean;
        }
      >();
      const operations = new Set<Promise<unknown>>();
      const executions = new WeakMap<
        object,
        Map<
          string,
          {
            turn: number;
            runId: string;
            executionId: string;
          }
        >
      >();
      const uninstall = host.startup.installModelAdapter(
        async (binding, signal) => {
          const active = AbortSignal.any([live, signal]);
          await input.assertRouteCurrent(active);
          const access = await host.providers.egressInstallation.readAccess(
            binding,
            active,
          );
          active.throwIfAborted();
          return {
            ...access,
            provider: input.route.provider,
            model: input.route.model,
            modelInfo: input.modelInfo,
          };
        },
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
          requireRunning: true,
          signal: active,
        });
        const attempt = await profile.owner.readNativeAttemptFor(
          context,
          sessionId,
          active,
        );
        profile.revoked.throwIfAborted();
        active.throwIfAborted();
        if (!attempt) return reject();
        return { resource, profile, attempt };
      }
      async function assertCall(call: ModelCallBinding, signal: AbortSignal) {
        return run(signal, async (active) => {
          const owned = calls.get(call.native.callId);
          if (
            !owned ||
            owned.scope.revoked.aborted ||
            JSON.stringify(call) !== JSON.stringify(owned.call)
          )
            return reject();
          await input.assertRouteCurrent(active);
          const { resource, profile, attempt } = await resolveSession(
            owned.scope,
            call.native.sessionId,
            active,
          );
          if (
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
        });
      }

      const references: ManagedHostService = {
        id: 'model-reference',
        path: '/v1/reference',
        method: 'POST',
        admissionOwner: 'service',
        async resolve(request, binding, signal) {
          return run(signal, async (active) => {
            await input.assertRouteCurrent(active);
            const wanted = await readSelection(request, active);
            if (
              wanted.provider !== input.route.provider ||
              wanted.model !== input.route.model
            )
              return reject();
            let matched:
              | { scope: NativeModelSelection; call: ModelCallBinding }
              | undefined;
            for (const { scope } of selected.values()) {
              if (
                scope.revoked.aborted ||
                !sameVmBinding(scope.binding, binding)
              )
                continue;
              const resolved = await resolveSession(
                scope,
                wanted.sessionId,
                active,
              ).catch((error: unknown) => {
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
              let bySession = executions.get(profile.owner);
              if (!bySession) {
                bySession = new Map();
                executions.set(profile.owner, bySession);
              }
              let execution = bySession.get(resource.nativeSessionId);
              if (execution?.turn !== attempt.turn) {
                execution = {
                  turn: attempt.turn,
                  runId: randomUUID(),
                  executionId: randomUUID(),
                };
                bySession.set(resource.nativeSessionId, execution);
              }
              if (matched) return reject();
              matched = {
                scope,
                call: {
                  context: structuredClone(scope.context),
                  vm: binding,
                  execution: {
                    runId: execution.runId,
                    executionId: execution.executionId,
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
            const { scope, call } = matched;
            const callId = call.native.callId;
            const deadline = AbortSignal.timeout(30_000);
            const effective = AbortSignal.any([live, scope.revoked, deadline]);
            const revoke = () => {
              calls.delete(callId);
            };
            const entry = {
              scope,
              call,
              revokedAt: effective,
              revoke,
              redeemed: false,
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
                    await assertCall(call, authorization);
                    await host.reserveNativeModelCall(call);
                    authorization.throwIfAborted();
                    const reference = await input.issueCall(call, effective);
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
      };
      let closing: Promise<void> | undefined;
      const owner: Installed = {
        assertCall,
        confirmStopped: input.confirmTransportStopped,
        references,
        async observeModelSelection(scope, signal) {
          if (!scope.identity.threadId) return;
          const active = AbortSignal.any([live, signal, scope.revoked]);
          active.throwIfAborted();
          const pin = await getDEntryHistoryRootPin(scope.context, {
            workspaceId: scope.identity.workspaceId,
            employeeInstanceId: scope.identity.employeeInstanceId,
            threadId: scope.identity.threadId,
          });
          active.throwIfAborted();
          // Editor-root creation also uses the normal admission hook. It may
          // register a model scope only after a real committed root exists.
          if (!pin || pin.vmId !== scope.binding.vmId) return;
          const key = JSON.stringify([
            scope.binding.vmId,
            scope.binding.leaseEpoch,
            scope.identity.workspaceId,
            scope.identity.employeeInstanceId,
            scope.identity.threadId,
          ]);
          const remove = () => {
            if (selected.get(key)?.scope === scope) selected.delete(key);
          };
          selected.get(key)?.unlink();
          selected.set(key, {
            scope,
            unlink: () => scope.revoked.removeEventListener('abort', remove),
          });
          scope.revoked.addEventListener('abort', remove, { once: true });
        },
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
          const active = AbortSignal.any([live, entry.scope.revoked, signal]);
          active.throwIfAborted();
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
          return (closing = Promise.allSettled([...operations]).then(() => {
            for (const selection of selected.values()) selection.unlink();
            selected.clear();
          }));
        },
      };
      installed = owner;
      return owner;
    },
  };
}
