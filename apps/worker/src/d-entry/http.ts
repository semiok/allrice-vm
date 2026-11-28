import { randomUUID } from 'node:crypto';
import { changeDEntrySession } from './session-change.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import {
  DEntryNativeOwnerRequestSchema,
  DEntrySessionChangeRequestSchema,
  DEntryNativePrewarmAcceptedSchema,
  DEntryNativePrewarmRequestSchema,
  DEntryNativePrewarmResultSchema,
  DEntryNativePrewarmStatusQuerySchema,
  DEntryNativeResourceRequestSchema,
  sameDEntryIdentity,
  type DEntryNativePrewarmStatus,
  type DEntryNativePrewarmTrigger,
} from '@allrice/contracts';
import {
  authenticateSession,
  DataAccessError,
  requireDEntryNativeIdentity,
  getDEntryNativeRootPin,
  runDEntryAdmittedActivity,
  watchDEntryNativeAuthority,
  ensureDEntryNativeRoot,
  type DEntryOwnedActivity,
  type DEntryNativeRootCreation,
} from '@allrice/database';
import {
  currentDEntryNativeOwner,
  dEntryNativeOwnerPort,
  DEntryNativeUnavailable,
  resolveDEntryNativeResource,
  type DEntryNativeOwnerPort,
  sameDEntryVmBinding,
} from './native-owner.js';
import {
  authorizeDEntryNativeInvocation,
  parseDEntryNativeInvocation,
} from './native-invocation.js';
import {
  currentDEntryNativeDataPort,
  observeDEntryFinish,
  ownDEntryCatalog,
} from './native-data.js';
import {
  createPrewarmOperations,
  dEntryNativePrewarmPort,
  type DEntryNativePrewarmPort,
} from './native-prewarm.js';

export const dEntryRpcRequestSchema = DEntryNativeResourceRequestSchema.omit({
  nativeSessionId: true,
}).extend({
  endpoint: z.string().min(1),
  payload: z.unknown(),
});
export type DEntryHttpDependencies = {
  authenticate: typeof authenticateSession;
  identity: typeof requireDEntryNativeIdentity;
  root: typeof getDEntryNativeRootPin;
  owners: DEntryNativeOwnerPort;
  data: typeof currentDEntryNativeDataPort;
  watch: typeof watchDEntryNativeAuthority;
  ensureRoot: typeof ensureDEntryNativeRoot;
  prewarm: DEntryNativePrewarmPort;
};
export const dEntryHttpDefaults: DEntryHttpDependencies = {
  authenticate: authenticateSession,
  identity: requireDEntryNativeIdentity,
  root: getDEntryNativeRootPin,
  owners: dEntryNativeOwnerPort,
  data: currentDEntryNativeDataPort,
  watch: watchDEntryNativeAuthority,
  ensureRoot: ensureDEntryNativeRoot,
  prewarm: dEntryNativePrewarmPort,
};
export function dEntryBearer(request: IncomingMessage) {
  const value = request.headers.authorization;
  // Same opaque session-token grammar as the existing diagnostics listener.
  if (!value || !/^Bearer [A-Za-z0-9_-]{16,4096}$/.test(value))
    throw new DataAccessError('authentication_required');
  return value.slice(7);
}

/** Authenticates the original session, never a RequestContext from JSON. */
export async function currentDEntryRequest(
  deps: DEntryHttpDependencies,
  token: string,
  input: z.infer<typeof DEntryNativeOwnerRequestSchema>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const context = await deps.authenticate(token, {
    organizationId: input.organizationId,
    workspaceId: input.selection.workspaceId,
  });
  if (!context) throw new DataAccessError('authentication_required');
  const identity = await deps.identity(context, input.selection);
  signal.throwIfAborted();
  return { context, identity };
}

export function dEntryHttpProblem(error: unknown) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  if (code === 'authentication_required')
    return { status: 401, code: 'AUTHENTICATION_REQUIRED' as const };
  if (
    [
      'authorization_denied',
      'not_found',
      'tenant_context_invalid',
      'execution_generation_mismatch',
    ].includes(String(code))
  )
    return { status: 404, code: 'RESOURCE_NOT_FOUND' as const };
  if (error instanceof SyntaxError || error instanceof z.ZodError)
    return { status: 400, code: 'VALIDATION_FAILED' as const };
  return { status: 503, code: 'DEPENDENCY_UNAVAILABLE' as const };
}
export function sendDEntryHttpProblem(
  response: ServerResponse,
  error: unknown,
) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const problem = dEntryHttpProblem(error);
  response.writeHead(problem.status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(
    JSON.stringify({
      error: {
        code: problem.code,
        message: 'The selected entry is not available',
        requestId: randomUUID(),
        retryable: false,
      },
    }),
  );
}

function sendPrewarmAccepted(
  response: ServerResponse,
  value: z.infer<typeof DEntryNativePrewarmAcceptedSchema>,
) {
  response
    .writeHead(202, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    .end(JSON.stringify(DEntryNativePrewarmAcceptedSchema.parse(value)));
}

function sendPrewarmReady(
  response: ServerResponse,
  value: z.infer<typeof DEntryNativePrewarmResultSchema>,
) {
  response
    .writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    .end(JSON.stringify(DEntryNativePrewarmResultSchema.parse(value)));
}

function sendPrewarmStatus(
  response: ServerResponse,
  value: DEntryNativePrewarmStatus,
) {
  response
    .writeHead(value.state === 'expired' ? 410 : 200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    .end(JSON.stringify(value));
}

export function createDEntryHttpHandler(
  deps = dEntryHttpDefaults,
  serviceSignal?: AbortSignal,
) {
  const lifetime = new AbortController();
  const workerLifetime = serviceSignal
    ? AbortSignal.any([lifetime.signal, serviceSignal])
    : lifetime.signal;
  const pending = new Set<Promise<unknown>>();
  function track<T>(work: Promise<T>) {
    pending.add(work);
    const settled = () => pending.delete(work);
    void work.then(settled, settled);
    return work;
  }
  const cleanupErrors: unknown[] = [];
  const prewarm = createPrewarmOperations(workerLifetime, (error) =>
    cleanupErrors.push(error),
  );
  const statusPath = '/internal/d-entry/native-prewarm/status';
  let closing: Promise<void> | undefined;
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
    stopping = false,
  ) => {
    const statusRequest =
      request.url === statusPath || request.url?.startsWith(statusPath + '?');
    const path = statusRequest ? statusPath : request.url;
    if (
      ![
        '/internal/d-entry/native-owner',
        '/internal/d-entry/native-resource',
        '/internal/d-entry/native-rpc',
        '/internal/d-entry/native-root',
        '/internal/d-entry/session-change',
        '/internal/d-entry/native-prewarm',
        statusPath,
      ].includes(path ?? '')
    )
      return false;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, workerLifetime]);
    const disconnect = () => {
      if (!response.writableEnded) abort.abort();
    };
    const responseError = (error: Error) => abort.abort(error);
    const cancelBody = () => {
      if (!request.complete) request.destroy();
    };
    response.once('close', disconnect);
    response.once('error', responseError);
    signal.addEventListener('abort', cancelBody, { once: true });
    let parsedInput = false;
    let authority:
      Awaited<ReturnType<typeof watchDEntryNativeAuthority>> | undefined;
    let transferred = false;
    let finishPrewarmReply: (() => void) | undefined;
    const revoke = () => abort.abort(authority?.revoked.reason);
    try {
      signal.throwIfAborted();
      if (
        (statusRequest
          ? request.method !== 'GET' && request.method !== 'DELETE'
          : request.method !== 'POST') ||
        request.headers.origin
      )
        throw new DataAccessError('not_found');
      if (stopping) throw new DEntryNativeUnavailable();
      const token = dEntryBearer(request);
      // Authenticate before buffering a native RPC's potentially large body.
      // The context used for authorization is resolved AGAIN with the parsed
      // tenant/selection; this first result never establishes that scope.
      if (!(await deps.authenticate(token)))
        throw new DataAccessError('authentication_required');
      signal.throwIfAborted();
      if (statusRequest) {
        const query = new URL(request.url!, 'http://worker.invalid')
          .searchParams;
        if ([...query.keys()].some((key) => query.getAll(key).length !== 1))
          throw new SyntaxError('Invalid entry status request');
        const { organizationId, ...selectors } = Object.fromEntries(query);
        const { operationId, ...selection } =
          DEntryNativePrewarmStatusQuerySchema.parse(selectors);
        const input = DEntryNativeOwnerRequestSchema.parse({
          organizationId,
          selection,
        });
        const { context, identity } = await currentDEntryRequest(
          deps,
          token,
          input,
          signal,
        );
        const method = request.method === 'DELETE' ? 'cancel' : 'read';
        const result = await prewarm[method](
          operationId,
          context,
          identity,
          signal,
          (plan, mode) => {
            if (!deps.prewarm.isCurrent) throw new DEntryNativeUnavailable();
            return deps.prewarm.isCurrent(
              context,
              identity,
              plan,
              signal,
              mode,
            );
          },
        );
        signal.throwIfAborted();
        sendPrewarmStatus(response, result);
        return true;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        signal.throwIfAborted();
        size += chunk.length;
        // Reuse the existing narrow Worker identity-request body budget.
        if (path !== '/internal/d-entry/native-rpc' && size > 4096)
          throw new SyntaxError('Invalid entry request');
        chunks.push(Buffer.from(chunk));
      }
      const decoded: unknown = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      );
      if (path === '/internal/d-entry/session-change') {
        const input = DEntrySessionChangeRequestSchema.parse(decoded);
        parsedInput = true;
        signal.throwIfAborted();
        const result = await changeDEntrySession(
          deps,
          token,
          input,
          // Once the full mutation has been accepted, the Worker owns its
          // checked native write and PostgreSQL projection even if the tab exits.
          // Exact authorization and Worker shutdown can still cancel it.
          AbortSignal.any([workerLifetime, AbortSignal.timeout(60_000)]),
          (error) => cleanupErrors.push(error),
        );
        signal.throwIfAborted();
        response
          .writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'private, no-store',
          })
          .end(JSON.stringify(result));
        return true;
      }
      const rpc =
        path === '/internal/d-entry/native-rpc'
          ? dEntryRpcRequestSchema.parse(decoded)
          : undefined;
      const resourceRequest =
        path === '/internal/d-entry/native-resource'
          ? DEntryNativeResourceRequestSchema.parse(decoded)
          : undefined;
      const prewarmRequest =
        path === '/internal/d-entry/native-prewarm'
          ? DEntryNativePrewarmRequestSchema.parse(decoded)
          : undefined;
      const input =
        prewarmRequest ??
        rpc ??
        resourceRequest ??
        DEntryNativeOwnerRequestSchema.parse(decoded);
      const creatingRoot = path === '/internal/d-entry/native-root';
      if (creatingRoot && !input.selection.threadId)
        throw new DataAccessError('authorization_denied');
      const parsedRpc = rpc
        ? parseDEntryNativeInvocation(rpc.endpoint, rpc.payload, 'http', signal)
        : undefined;
      parsedInput = true;
      const auth = await currentDEntryRequest(deps, token, input, signal);
      const plan =
        prewarmRequest &&
        (await deps.prewarm.prepare?.(auth.context, auth.identity, signal));
      const check = deps.prewarm.isCurrent?.bind(deps.prewarm);
      if (prewarmRequest && (!plan || !check))
        throw new DEntryNativeUnavailable();
      async function publishExistingPrewarm(
        existing: ReturnType<typeof prewarm.reuse>['existing'],
        trigger: DEntryNativePrewarmTrigger,
        verify: NonNullable<DEntryNativePrewarmPort['isCurrent']>,
        preferReady = false,
      ) {
        if (!existing) {
          sendPrewarmStatus(response, { state: 'expired' });
          return;
        }
        finishPrewarmReply = existing.finishReply;
        async function verifyExisting(
          ticket: NonNullable<typeof existing>,
          active: AbortSignal,
          pendingReply = false,
        ) {
          let threadCurrent = await ticket.observeThread(active, pendingReply);
          const { context, identity } = await currentDEntryRequest(
            deps,
            token,
            input,
            active,
          );
          const ticketCurrent =
            threadCurrent &&
            (await ticket.recheck(context, identity, async (mode) => {
              // The original observer can close while the starting ticket's
              // coordination read is in flight. Verify the terminal thread
              // and the exact failed ticket in the same final check.
              if (mode === 'failed' && threadCurrent && !threadCurrent()) {
                threadCurrent = await ticket.observeThread(
                  active,
                  pendingReply,
                );
                if (!threadCurrent) return false;
              }
              // A waiting reply checks the exact binding without repeating the
              // immediate-ready probe that has already used its time budget.
              if (pendingReply && plan && mode === 'ready')
                return verify(
                  context,
                  identity,
                  plan,
                  active,
                  'waiting',
                  'publish',
                );
              return verify(
                context,
                identity,
                ticket.plan,
                active,
                mode,
                'publish',
              );
            }));
          active.throwIfAborted();
          if (!threadCurrent) ticket.assertNotRevoked();
          const finalThread = threadCurrent;
          if (finalThread && ticketCurrent)
            return {
              identity,
              current: () => finalThread() && ticketCurrent(),
            };
        }
        if (preferReady) {
          const budget = new AbortController();
          const probe = AbortSignal.any([signal, budget.signal]);
          const ready = track(
            (async () => {
              await existing.settled;
              probe.throwIfAborted();
              // Only an elapsed budget or an unsettled readiness result can
              // take the waiting path. A completed negative check expires.
              if (existing.ready())
                return (await verifyExisting(existing, probe)) ?? false;
            })(),
          );
          let qualified: Awaited<typeof ready>;
          try {
            qualified = await Promise.race([
              ready,
              delay(1000, undefined, { signal: probe, ref: false }),
            ]);
          } finally {
            budget.abort();
            signal.throwIfAborted();
          }
          if (qualified !== undefined) {
            if (qualified && qualified.current() && existing.ready()) {
              sendPrewarmReady(response, {
                identity: qualified.identity,
                trigger,
              });
            } else sendPrewarmStatus(response, { state: 'expired' });
            return;
          }
        }
        const waiting = await verifyExisting(existing, signal, preferReady);
        if (waiting?.current()) {
          existing.publish();
          sendPrewarmAccepted(response, {
            identity: waiting.identity,
            trigger,
            ticket: existing.ticket,
          });
        } else sendPrewarmStatus(response, { state: 'expired' });
      }
      if (prewarmRequest && plan && plan.reuse && check) {
        await publishExistingPrewarm(
          prewarm.reuse(
            auth.context,
            auth.identity,
            plan,
            false,
            prewarmRequest.trigger,
          ).existing,
          prewarmRequest.trigger,
          check,
        );
        return true;
      }
      // The job takes ownership of its subscription on acceptance. LISTEN
      // rechecks the captured revision even after a revoke/regrant.
      authority =
        plan && check
          ? await deps.watch(
              auth.context,
              input.selection,
              auth.identity,
              workerLifetime,
              undefined,
              async (current) => {
                if (
                  !(await check(
                    auth.context,
                    auth.identity,
                    plan,
                    current,
                    'authority',
                  ))
                )
                  throw new DataAccessError('authorization_denied');
              },
            )
          : await deps.watch(
              auth.context,
              input.selection,
              auth.identity,
              signal,
            );
      authority.revoked.addEventListener('abort', revoke, { once: true });
      if (authority.revoked.aborted) revoke();
      if (prewarmRequest && plan && check) {
        const next = await currentDEntryRequest(deps, token, input, signal);
        if (
          auth.context.sessionId !== next.context.sessionId ||
          !sameDEntryIdentity(auth.identity, next.identity)
        )
          throw new DataAccessError('authorization_denied');
        signal.throwIfAborted();
        const { context, identity } = next;
        plan.assertTicketThread = authority.assertTicketThread;
        await plan.assertTicketThread?.(signal);
        const { trigger } = prewarmRequest;
        const receipt = { identity, trigger };
        let confirmRunning = plan.running
          ? deps.prewarm.confirmRunning?.bind(deps.prewarm)
          : undefined;
        while (true) {
          let canIssue = await check(context, identity, plan, signal, 'issue');
          signal.throwIfAborted();
          let match = prewarm.reuse(context, identity, plan, canIssue, trigger);
          if (canIssue && !match.existing && match.publishedInstance) {
            // A compatible-looking instance can have appeared after this MVCC
            // read. Recheck before creating a ticket from the earlier cold plan.
            canIssue = await check(context, identity, plan, signal, 'issue');
            signal.throwIfAborted();
            match = prewarm.reuse(context, identity, plan, canIssue, trigger);
          }
          if (match.existing || !canIssue) {
            await publishExistingPrewarm(
              match.existing,
              trigger,
              check,
              canIssue && plan.running === true,
            );
            return true;
          }
          if (!confirmRunning) break;
          const budget = new AbortController();
          const probe = AbortSignal.any([signal, budget.signal]);
          try {
            const verify = track(
              confirmRunning(context, identity, plan, probe),
            );
            const verified = await Promise.race([
              verify,
              delay(2000, undefined, { signal: probe, ref: false }),
            ]);
            signal.throwIfAborted();
            if (verified && !verified.aborted) {
              sendPrewarmReady(response, receipt);
              return true;
            }
          } finally {
            budget.abort();
          }
          // The probe can overlap another POST's ticket or a change of target.
          // Recheck both before falling back to ticket admission.
          confirmRunning = undefined;
        }
        const accepted = prewarm.accept(
          context,
          identity,
          plan,
          authority,
          (active, reportCapacity) =>
            deps.prewarm.prewarm(
              context,
              identity,
              trigger,
              active,
              active,
              plan,
              reportCapacity,
            ),
          trigger,
        );
        transferred = true;
        finishPrewarmReply = accepted.finishReply;
        let hot = false;
        // An already running VM only gets a short window for immediate proof.
        // If proof is slow, keep that same Worker-owned task and return its ID.
        if (plan.running) {
          const budget = new AbortController();
          const probe = AbortSignal.any([signal, budget.signal]);
          try {
            const verify = track(
              (async () => {
                await accepted.settled;
                probe.throwIfAborted();
                if (!accepted.ready()) return false;
                await accepted.assertTicketThread?.(probe);
                return (
                  (await check(context, identity, plan, probe, 'ready')) &&
                  accepted.ready()
                );
              })().catch(() => false),
            );
            hot = await Promise.race([
              verify,
              delay(1000, false, { signal: probe, ref: false }),
            ]);
          } finally {
            budget.abort();
          }
          signal.throwIfAborted();
        }
        if (!hot) {
          if (
            plan.running &&
            !(await check(context, identity, plan, signal, 'issue'))
          ) {
            signal.throwIfAborted();
            sendPrewarmStatus(response, { state: 'expired' });
            return true;
          }
          signal.throwIfAborted();
          accepted.publish();
          sendPrewarmAccepted(response, {
            ...receipt,
            ticket: accepted.ticket,
          });
          return true;
        }
        sendPrewarmReady(response, receipt);
        return true;
      }
      const current = await currentDEntryNativeOwner(
        deps.owners,
        auth.context,
        auth.identity,
        signal,
      );
      const assertCurrent = async (active: AbortSignal) => {
        const next = await currentDEntryRequest(deps, token, input, active);
        if (!sameDEntryIdentity(auth.identity, next.identity))
          throw new DataAccessError('authorization_denied');
        await current.owner.assertCurrent(next.context, active);
        if (current.owner.bindingRef !== current.view.bindingRef)
          throw new DataAccessError('authorization_denied');
        if (
          (rpc || resourceRequest || creatingRoot) &&
          !current.owner.controlReady()
        )
          throw new DEntryNativeUnavailable();
        active.throwIfAborted();
      };
      if (rpc || resourceRequest || creatingRoot) {
        const data = deps.data();
        // Control readiness is only a necessary transport prerequisite. It
        // never grants editor/send readiness or substitutes for the real
        // complete-envelope resolver/admission owner below.
        const acquireRpc = data?.acquireRpc?.bind(data);
        if (!data || !current.owner.controlReady() || (rpc && !acquireRpc))
          throw new DEntryNativeUnavailable();
        const parsed = parsedRpc;
        const pin = creatingRoot
          ? undefined
          : await deps.root(auth.context, input.selection);
        if (pin && pin.vmId !== current.view.receipt.binding.vmId)
          throw new DataAccessError('authorization_denied');
        const assertPinned = async (active: AbortSignal) => {
          await assertCurrent(active);
          if (!pin) return;
          const next = await deps.root(auth.context, input.selection);
          if (
            next.rootNativeSessionId !== pin.rootNativeSessionId ||
            next.rootOriginDigest !== pin.rootOriginDigest ||
            next.rootBindingRef !== pin.rootBindingRef ||
            next.vmId !== pin.vmId ||
            !sameDEntryIdentity(next.identity, auth.identity)
          )
            throw new DataAccessError('authorization_denied');
          active.throwIfAborted();
        };
        const operationId = randomUUID();
        const owner = await data.resolveAdmissionOwner({
          ...auth,
          owner: current.owner,
          operationId,
          signal: current.signal,
        });
        if (
          owner.operationId !== operationId ||
          owner.context.sessionId !== auth.context.sessionId ||
          owner.context.workspaceId !== auth.context.workspaceId ||
          !sameDEntryVmBinding(owner.binding, current.view.receipt.binding)
        )
          throw new DataAccessError('authorization_denied');
        let value: unknown;
        await runDEntryAdmittedActivity(
          {
            ports: observeDEntryFinish(data.admission, (error) =>
              cleanupErrors.push(error),
            ),
            signal: current.signal,
            owner: {
              ...owner,
              async assertCurrent(active) {
                await assertPinned(active);
                await owner.assertCurrent(active);
              },
            },
          },
          (active) => {
            const catalog = ownDEntryCatalog(current.owner, active);
            let activity: DEntryOwnedActivity<void> | undefined;
            let bodyClose: Promise<void> | undefined;
            if (creatingRoot) {
              const method = TYPERT_REMOTE.methods['session/create'];
              const args = method
                .input({ strict: true })
                .create()
                .parse({ request: {} });
              // A real owned handle exists before any native initialization.
              // Failure to acquire it continues to reject the entered callback.
              let native: ReturnType<typeof data.acquireRoot>;
              try {
                native = data.acquireRoot(
                  { owner: current.owner, request: args.request },
                  active,
                );
              } catch (error) {
                void catalog.close().catch(() => {});
                cleanupErrors.push(error);
                throw error;
              }
              let nativeTask: Promise<void> | undefined;
              let nativeClosing: Promise<void> | undefined;
              const closeNative = () =>
                (nativeClosing ??= Promise.resolve().then(() =>
                  native.close(),
                ));
              activity = {
                run(running) {
                  return (nativeTask = (async () => {
                    const bound = await deps.ensureRoot(
                      auth.context,
                      input.selection,
                      auth.identity,
                      {
                        operationId,
                        host: {
                          binding: { ...current.view.receipt.binding },
                          bindingRef: current.view.bindingRef,
                          rosterDigest: current.view.receipt.rosterDigest,
                        },
                        signal: running,
                        async create(creating) {
                          const cancel = () => {
                            void closeNative().catch(() => {});
                          };
                          creating.addEventListener('abort', cancel, {
                            once: true,
                          });
                          if (creating.aborted) cancel();
                          let failed = false,
                            failure: unknown;
                          let created: DEntryNativeRootCreation | undefined;
                          try {
                            await assertCurrent(creating);
                            creating.throwIfAborted();
                            const result = await native.run(creating);
                            if (!result.ok)
                              throw new RemoteError(
                                result.error.code,
                                result.error.message,
                                result.error.details,
                              );
                            const receipt = method.result
                              .create()
                              .parse(result.value);
                            await assertCurrent(creating);
                            creating.throwIfAborted();
                            created = {
                              nativeSessionId: String(receipt.sessionId),
                              host: {
                                binding: { ...current.view.receipt.binding },
                                bindingRef: current.view.bindingRef,
                                rosterDigest: current.view.receipt.rosterDigest,
                              },
                            };
                          } catch (error) {
                            failed = true;
                            failure = error;
                          }
                          creating.removeEventListener('abort', cancel);
                          try {
                            await closeNative();
                          } catch (error) {
                            if (failed)
                              throw new AggregateError(
                                [failure, error],
                                'Root creation cleanup is unknown',
                                { cause: failure },
                              );
                            throw error;
                          }
                          if (failed) throw failure;
                          return created!;
                        },
                      },
                    );
                    if (bound.vmId !== current.view.receipt.binding.vmId)
                      throw new DataAccessError('authorization_denied');
                    value = {
                      organizationId: auth.identity.organizationId,
                      personId: auth.identity.personId,
                      employeeInstanceId: auth.identity.employeeInstanceId,
                      threadId: auth.identity.threadId,
                      nativeSessionId: bound.rootNativeSessionId,
                      rootNativeSessionId: bound.rootNativeSessionId,
                      parentNativeSessionId: null,
                      bindingRef: current.view.bindingRef,
                    };
                  })());
                },
                async close() {
                  const settled = await Promise.allSettled([
                    closeNative(),
                    nativeTask?.catch(() => {}),
                  ]);
                  const errors = settled.flatMap((r) =>
                    r.status === 'rejected' ? [r.reason] : [],
                  );
                  if (errors.length)
                    throw new AggregateError(
                      errors,
                      'Native root creation close is unknown',
                      { cause: errors[0] },
                    );
                },
              };
            } else if (parsed && acquireRpc) {
              try {
                activity = acquireRpc(
                  {
                    owner: current.owner,
                    invocation: parsed,
                    async consume(upstream, reading) {
                      if (upstream.status >= 300 && upstream.status < 400)
                        throw new DEntryNativeUnavailable();
                      await assertPinned(reading);
                      // Only body/content-type cross this boundary, never native auth.
                      response.writeHead(upstream.status, {
                        'content-type':
                          upstream.headers.get('content-type') ??
                          'application/json',
                        'cache-control': 'no-store',
                      });
                      if (upstream.body) {
                        const reader = upstream.body.getReader();
                        const closeBody = () =>
                          (bodyClose ??= Promise.resolve().then(() =>
                            reader.cancel(reading.reason),
                          ));
                        const cancel = () => {
                          void closeBody().catch(() => {});
                        };
                        reading.addEventListener('abort', cancel, {
                          once: true,
                        });
                        let failed = false;
                        let failure: unknown;
                        try {
                          while (true) {
                            const part = await reader.read();
                            if (part.done) break;
                            await assertPinned(reading);
                            if (!response.write(part.value))
                              await once(response, 'drain', {
                                signal: reading,
                              });
                          }
                        } catch (error) {
                          failed = true;
                          failure = error;
                        }
                        reading.removeEventListener('abort', cancel);
                        try {
                          await closeBody();
                        } catch (error) {
                          if (failed || reading.aborted)
                            throw new AggregateError(
                              [failed ? failure : reading.reason, error],
                              'Native response body cleanup is unknown',
                              { cause: failed ? failure : reading.reason },
                            );
                          throw error;
                        } finally {
                          reader.releaseLock();
                        }
                        if (failed) throw failure;
                      }
                    },
                  },
                  active,
                );
              } catch (error) {
                void catalog.close().catch(() => {});
                cleanupErrors.push(error);
                throw error;
              }
            }
            let closing: Promise<void> | undefined;
            let task: Promise<void> | undefined;
            return {
              run(running: AbortSignal) {
                return (task = (async () => {
                  const authorize = async (
                    nativeSessionId: string,
                    effect: 'read' | 'write',
                    checking: AbortSignal,
                  ) => {
                    await assertPinned(checking);
                    const resource = await resolveDEntryNativeResource({
                      ...auth,
                      owner: catalog.owner,
                      nativeSessionId,
                      signal: checking,
                      root: deps.root,
                    });
                    if (
                      resource.rootNativeSessionId !==
                        pin!.rootNativeSessionId ||
                      (effect === 'write' &&
                        (resource.nativeSessionId !==
                          pin!.rootNativeSessionId ||
                          resource.parentNativeSessionId !== null))
                    )
                      throw new DataAccessError('authorization_denied');
                    return resource;
                  };
                  if (creatingRoot) await activity!.run(running);
                  else if (parsed && rpc) {
                    await authorizeDEntryNativeInvocation(
                      authorize,
                      rpc.endpoint,
                      rpc.payload,
                      'http',
                      running,
                    );
                    running.throwIfAborted();
                    await activity!.run(running); // First native write/dispatch, after real resource authorization.
                  } else if (resourceRequest)
                    value = await authorize(
                      resourceRequest.nativeSessionId,
                      'read',
                      running,
                    );
                })());
              },
              close() {
                return (closing ??= (async () => {
                  const results = await Promise.allSettled([
                    activity
                      ? Promise.resolve().then(() => activity!.close())
                      : undefined,
                    catalog.close(),
                    task?.catch(() => {}), // Join the controlled run; close failures stay rejected below.
                  ]);
                  // Native close/run may register the FIRST body cancellation.
                  // Read it only after those real children can no longer add it.
                  results.push(...(await Promise.allSettled([bodyClose])));
                  const errors = results.flatMap((result) =>
                    result.status === 'rejected' ? [result.reason] : [],
                  );
                  if (errors.length) {
                    const error = new AggregateError(
                      errors,
                      'D entry request close is unknown',
                      { cause: errors[0] },
                    );
                    cleanupErrors.push(error);
                    throw error;
                  }
                })());
              },
            };
          },
        );
        await assertPinned(current.signal);
        if (rpc) response.end();
        else
          response
            .writeHead(200, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            })
            .end(JSON.stringify(value));
      } else {
        await assertCurrent(current.signal);
        response.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        response.end(
          JSON.stringify({ identity: auth.identity, ...current.view }),
        );
      }
    } catch (error) {
      sendDEntryHttpProblem(
        response,
        parsedInput && error instanceof z.ZodError
          ? new DEntryNativeUnavailable()
          : error,
      );
    } finally {
      finishPrewarmReply?.();
      authority?.revoked.removeEventListener('abort', revoke);
      try {
        if (!transferred) await authority?.close();
      } catch (error) {
        cleanupErrors.push(error);
        sendDEntryHttpProblem(response, error);
      }
      response.off('close', disconnect);
      response.off('error', responseError);
      signal.removeEventListener('abort', cancelBody);
    }
    return true;
  };
  return Object.assign(
    (request: IncomingMessage, response: ServerResponse, stopping = false) => {
      return track(handle(request, response, stopping));
    },
    {
      close() {
        if (closing) return closing;
        lifetime.abort();
        closing = (async () => {
          while (pending.size) await Promise.allSettled([...pending]);
          await prewarm.close();
          if (cleanupErrors.length)
            throw new AggregateError(
              cleanupErrors,
              'D entry HTTP cleanup is unknown',
            );
        })();
        return closing;
      },
    },
  );
}
