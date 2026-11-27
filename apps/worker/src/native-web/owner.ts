import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import {
  clientRequestSchema,
  serverResponseSchema,
} from '@deepseek-ai/dsh-client-connection';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import * as GatewayClient from '@deepseek-ai/dsh-api-gateway/client';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import { TYPERT_REMOTE as PRINCIPAL_REMOTE } from '@allrice/d-entry-principal/remote';
import {
  createDEntryPrincipalControl,
  type PrincipalInvocationObservation,
} from '../d-entry/principal-control.js';
import type { DEntryPrincipalIssue } from '@allrice/d-entry-principal/types';
import { UuidSchema, type RequestContext } from '@allrice/contracts';
import { DEntryNativeTurnEndSchema } from '@allrice/database';
import type {
  ModelCatalog,
  SessionFollowFrame,
  SessionAddress,
  SessionCreateRequest,
} from '@deepseek-ai/dsh-api-session-controller/types';
import {
  PersonVmError,
  sameVmBinding,
  type PersonVmBinding,
  type PersonVmBootstrapScope,
  type PersonVmPort,
  type NativeWebSetupFailure,
} from '@allrice/person-vm';
import type {
  ImageAttachmentRef,
  ImageRequestTarget,
} from '@deepseek-ai/dsh-attachment';
import { decodeProductionModelImage } from '../person-vm/production-model-images.js';
import type { NativeWebLaunch } from './launch.js';
import { nativeWebTransport } from './transport.js';
import { nativeSetupError, nativeSetupTarget } from './startup-diagnostic.js';
import {
  observeNativePrompt,
  type NativePromptObservation,
} from './prompt-observation.js';
import type { DEntryFixedProfileSource } from '../d-entry/released-profile.js';
import { DEntryNativeRootRejected } from '../d-entry/native-owner.js';

export class NativeRootJoinUnknown extends Error {
  constructor(cause: unknown) {
    super('NATIVE_ROOT_JOIN_UNKNOWN', { cause });
  }
}

type EditorEvidence<T> = (
  profile: DEntryFixedProfileSource,
  models: () => Promise<{ ok: true; value: ModelCatalog }>,
  signal: AbortSignal,
  modelAdapterId?: string,
) => Promise<T>;

export type NativeModelAttemptKind =
  'assistant' | 'compaction' | 'session-title';

const nativeRootWake = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clear') }).strict(),
  z.object({ kind: z.literal('unproven') }).strict(),
  z
    .object({
      kind: z.literal('delegated'),
      turn: z.number().int().positive(),
      promptIds: z
        .array(z.string().min(1).max(256))
        .min(1)
        .max(64)
        .refine((ids) => new Set(ids).size === ids.length),
    })
    .strict(),
]);

export function readNativeModelAttempt(
  snapshot: Pick<
    Extract<SessionFollowFrame, { type: 'snapshot' }>,
    'records' | 'assistantStream'
  >,
  kind: NativeModelAttemptKind,
) {
  if (kind === 'assistant') {
    const attempt = snapshot.assistantStream?.activeAttempt;
    return attempt
      ? {
          kind,
          id: attempt.attemptId,
          turn: attempt.turn,
          cursor: attempt.startedAfterSeq,
        }
      : null;
  }
  if (kind === 'session-title') {
    for (const { event } of [...snapshot.records].reverse()) {
      if (event.type === 'session/end-seed') break;
      if (event.type === 'session/title-llm-request')
        return { kind, id: String(event.seq), turn: null, cursor: event.seq };
    }
    return null;
  }
  // Native automatic and manual compaction own a real journal bracket before
  // their summarizer enters Llm. A seed cut closes a prior lifecycle.
  for (const { event } of [...snapshot.records].reverse()) {
    if (event.type === 'session/end-seed' || event.type === 'compaction/end')
      break;
    if (event.type !== 'compaction/start') continue;
    const data = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const { compactionId, turn } = data;
    if (
      typeof compactionId !== 'string' ||
      !compactionId ||
      !(
        turn === null ||
        (typeof turn === 'number' && Number.isSafeInteger(turn))
      )
    )
      return null;
    return { kind, id: compactionId, turn, cursor: event.seq };
  }
  return null;
}

/** Real public Node control owner for one already published native Web job.
 * This is not Runtime.ready, editor readiness, or a VM-wide activity producer. */
export async function openNativeWebOwner(input: {
  scope: PersonVmBootstrapScope;
  launch: NativeWebLaunch;
  context: RequestContext;
  vm: Pick<PersonVmPort, 'assertCurrentBinding'>;
  lifetime: AbortSignal;
  cleanupTimeoutMs: number;
  startupPending?(): boolean;
  recordStartupFailure?(
    failure: NativeWebSetupFailure,
    signal: AbortSignal,
  ): Promise<void>;
  beforePrompt?(
    input: {
      binding: PersonVmBinding;
      adapterId: string;
      context: RequestContext;
      issue: DEntryPrincipalIssue;
    } & (
      | {
          endpoint: 'session/prompt';
          requestId: string;
          mode: 'queue' | 'steer';
          observe(signal: AbortSignal): NativePromptObservation;
        }
      | { endpoint: 'session/updateQueue' }
    ),
    signal: AbortSignal,
  ): Promise<PrincipalInvocationObservation | undefined>;
}) {
  let step = 'validate-setup';
  let transportStatus: number | undefined;
  let controlHandshakeStatus: number | undefined;
  let startupFailureAudit: Promise<void> | undefined;
  let startupComplete = false;
  function stage(next: string) {
    step = next;
    transportStatus = undefined;
  }
  function recordingStartup() {
    return !startupComplete || input.startupPending?.() === true;
  }
  function recordFailure(reason: unknown, failedStep = step) {
    if (!recordingStartup() || startupFailureAudit) return;
    startupFailureAudit = Promise.resolve();
    const diagnostic: NativeWebSetupFailure = {
      step: failedStep,
      ...nativeSetupError(
        reason,
        (failedStep === step ? transportStatus : undefined) ??
          (failedStep === 'control-first-frame'
            ? controlHandshakeStatus
            : undefined),
      ),
      target: nativeSetupTarget(input.launch.auth.origin),
    };
    try {
      console.warn('[MET-273] native Web startup failed', {
        requestId: UuidSchema.safeParse(input.context.requestId).data,
        vmId: UuidSchema.safeParse(input.scope.binding.vmId).data,
        leaseEpoch: input.scope.binding.leaseEpoch,
        ...diagnostic,
      });
    } catch {
      // Logging cannot change the failure or its cleanup.
    }
    if (input.recordStartupFailure) {
      // A stalled diagnostic writer must not delay the cause or cleanup.
      const budget = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<void>((done) => {
        timer = setTimeout(() => {
          budget.abort();
          done();
        }, 250);
      });
      const audit = Promise.resolve().then(() =>
        input.recordStartupFailure!(diagnostic, budget.signal),
      );
      startupFailureAudit = Promise.race([
        audit.catch(() => {}),
        deadline,
      ]).finally(() => clearTimeout(timer));
    }
  }
  if (
    !input.scope.readNativeWebAuth ||
    !Number.isSafeInteger(input.cleanupTimeoutMs) ||
    input.cleanupTimeoutMs <= 0
  ) {
    const error = new PersonVmError('PROVIDER_FAILED');
    recordFailure(error);
    await startupFailureAudit;
    throw error;
  }
  const binding = Object.freeze({ ...input.scope.binding });
  if (!sameVmBinding(input.launch.binding, binding)) {
    const error = new PersonVmError('LEASE_LOST');
    recordFailure(error);
    await startupFailureAudit;
    throw error;
  }
  stage('startup-authority');
  const stale = new AbortController(),
    carrier = new AbortController(),
    waitAbort = new AbortController();
  // Business cancellation fences calls; the separate carrier survives to carry
  // typed close/closed/end until normal cleanup, actual loss or exact stop.
  const signal = AbortSignal.any([input.lifetime, stale.signal]);
  let installedModelAdapter: string | undefined;
  let ready = false,
    closing: Promise<void> | undefined,
    hostClosing: Promise<void> | undefined;
  let job: Awaited<ReturnType<PersonVmBootstrapScope['launch']>> | undefined;
  let starting: Promise<NonNullable<typeof job>> | undefined;
  let nativeWait: Promise<unknown> | undefined;
  let nativeStopConfirmed = false;
  const root = new Context();
  const principals = createDEntryPrincipalControl(root, {
    carrier: carrier.signal,
    cleanupTimeoutMs: input.cleanupTimeoutMs,
  });
  const operations = new Set<Promise<unknown>>();
  function own<T>(operation: Promise<T>): Promise<T> {
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  }
  function setup<T>(work: () => PromiseLike<T>): Promise<T> {
    signal.throwIfAborted();
    return own(
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return work();
      }),
    );
  }
  async function joinOperations() {
    while (operations.size) await Promise.allSettled([...operations]);
  }
  let disconnected: Promise<void> | undefined;
  const lost = (reason: unknown = new PersonVmError('PROVIDER_FAILED')) => {
    if (disconnected) return;
    recordFailure(reason);
    const abortCarrier = () => {
      carrier.abort(new PersonVmError('PROVIDER_FAILED'));
      waitAbort.abort();
    };
    const audit = startupFailureAudit;
    // Publish before abort callbacks can reenter. Local drain is not remote ACK.
    disconnected = Promise.resolve().then(async () => {
      if (audit) {
        await audit;
        abortCarrier();
      }
      await Promise.allSettled([starting, nativeWait]);
      const results = await Promise.allSettled([
        principals.drainLocal(),
        transport.close(),
      ]);
      await joinOperations();
      const [fiber] = await Promise.allSettled([root.fiber.dispose()]);
      if (
        fiber.status === 'rejected' ||
        results.some((r) => r.status === 'rejected')
      )
        throw new PersonVmError('CLEANUP_INCOMPLETE');
    });
    ready = false;
    principals.fence(new PersonVmError('PROVIDER_FAILED'));
    stale.abort(new PersonVmError('PROVIDER_FAILED'));
    if (!audit) abortCarrier();
    void disconnected.catch(() => {});
  };
  const transport = nativeWebTransport(
    input.launch.auth.origin,
    carrier.signal,
    lost,
    (error, status, failed, source) => {
      if (!recordingStartup()) return;
      if (startupFailureAudit) return failed ? startupFailureAudit : undefined;
      if (source === 'websocket') {
        if (!failed) {
          controlHandshakeStatus = status;
          return;
        }
        if (step !== 'control-first-frame') stage('control-websocket');
      }
      transportStatus = status;
      if (failed) {
        recordFailure(error);
        return startupFailureAudit;
      }
    },
  );
  function joinHost() {
    if (hostClosing) return hostClosing;
    ready = false;
    hostClosing = Promise.resolve().then(async () => {
      // This function proves LOCAL join only. Normal close separately requires
      // the scope stream ACK; exact-stop retirement must not ask a dead Host.
      stale.abort();
      carrier.abort();
      waitAbort.abort();
      await Promise.allSettled([starting, nativeWait, disconnected]);
      const results = await Promise.allSettled([
        principals.drainLocal(),
        transport.close(),
      ]);
      await joinOperations();
      const [fiber] = await Promise.allSettled([root.fiber.dispose()]);
      if (
        fiber.status === 'rejected' ||
        results.some((r) => r.status === 'rejected')
      )
        throw new PersonVmError('CLEANUP_INCOMPLETE');
    });
    const attempt = hostClosing;
    void attempt.catch(() => {
      if (hostClosing === attempt) hostClosing = undefined;
    });
    return attempt;
  }
  function close() {
    if (closing) return closing;
    // Publish before fence/abort: nested close must join this exact attempt.
    closing = Promise.resolve().then(async () => {
      if (startupFailureAudit) await startupFailureAudit;
      const [scopes] = await Promise.allSettled([principals.close()]);
      // Even an unknown remote scope must get a real local drain. Only this
      // shared owner's close owns job cancellation; page scopes never do.
      const results = await Promise.allSettled([
        joinHost(),
        (async () => {
          await Promise.allSettled([starting]);
          // No await between this private stop-fact check and first dispatch.
          if (job && !nativeStopConfirmed)
            await job.cancelAndWait(
              AbortSignal.timeout(input.cleanupTimeoutMs),
            );
        })(),
      ]);
      const failures = [scopes, ...results].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length)
        throw new PersonVmError('CLEANUP_INCOMPLETE', {
          cause: new AggregateError(failures, 'Native owner cleanup failed'),
        });
    });
    ready = false;
    principals.fence(new PersonVmError('LEASE_LOST'));
    stale.abort(new PersonVmError('LEASE_LOST'));
    return closing;
  }
  const aborted = () => {
    recordFailure(
      input.scope.signal.aborted
        ? input.scope.signal.reason
        : input.lifetime.reason,
    );
    void close().catch(() => {});
  };
  input.lifetime.addEventListener('abort', aborted, { once: true });
  input.scope.signal.addEventListener('abort', aborted, { once: true });
  if (input.lifetime.aborted || input.scope.signal.aborted) aborted();
  const startupTimer = setTimeout(
    () =>
      lost(new DOMException('Native Web startup timed out', 'TimeoutError')),
    input.launch.auth.timeoutMs,
  );
  function readCurrentSessions(
    requestSignal: AbortSignal,
    assertCurrent: (signal: AbortSignal) => Promise<void>,
    notDispatched?: () => void,
  ) {
    const current = AbortSignal.any([signal, requestSignal]);
    if (current.aborted) {
      notDispatched?.();
      return Promise.reject(current.reason);
    }
    // Register before entering either asynchronous guard, including reentrant close.
    return own(
      Promise.resolve().then(async () => {
        try {
          current.throwIfAborted();
          await assertCurrent(current);
          current.throwIfAborted();
        } catch (error) {
          notDispatched?.();
          throw error;
        }
        const result = await root.remote.session.list({}, current);
        await assertCurrent(current);
        current.throwIfAborted();
        return result;
      }),
    );
  }
  function readGraph(current: AbortSignal) {
    return transport.readIndex(current).then((html): unknown => {
      const rows = [
        ...html.matchAll(
          /<script>globalThis\["__DSH_BOOT__"\] = ([^<]+)<\/script>/g,
        ),
      ];
      if (rows.length !== 1) throw new PersonVmError('RUNTIME_NOT_READY');
      return JSON.parse(rows[0]![1]!);
    });
  }
  function readBundle(
    reference: string,
    expectedBytes: number,
    current: AbortSignal,
  ) {
    if (
      !/^plugins\/\?\?(?:[@a-z\d._/-]+(?:,[@a-z\d._/-]+)*)&rev=[a-f\d]+$/i.test(
        reference,
      )
    )
      throw new PersonVmError('RUNTIME_NOT_READY');
    const url = new URL(reference, input.launch.auth.origin);
    if (url.pathname !== '/plugins/' || url.hash)
      throw new PersonVmError('RUNTIME_NOT_READY');
    return transport.readExact(url, expectedBytes, current);
  }
  function readCurrent<T>(
    requestSignal: AbortSignal,
    assertCurrent: (active: AbortSignal) => Promise<void>,
    read: (active: AbortSignal) => Promise<T>,
  ) {
    const current = AbortSignal.any([signal, requestSignal]);
    return own(
      Promise.resolve().then(async () => {
        current.throwIfAborted();
        if (!ready || closing) throw new PersonVmError('RUNTIME_NOT_READY');
        await assertCurrent(current);
        current.throwIfAborted();
        const result = await read(current);
        await assertCurrent(current);
        current.throwIfAborted();
        return result;
      }),
    );
  }
  async function readSessionReply(
    endpoint: 'create' | 'modelCatalog',
    args: object,
    signal: AbortSignal,
  ) {
    const method = 'session/' + endpoint;
    const rpcId = randomUUID();
    const body = JSON.stringify(
      clientRequestSchema.parse({
        type: 'client-request',
        method,
        rpcId,
        payload: { args },
      }),
    );
    const wire = await transport.readSessionReply(endpoint, body, signal);
    const reply = serverResponseSchema.parse(JSON.parse(wire));
    if (reply.rpcId !== rpcId) throw new PersonVmError('PROVIDER_FAILED');
    return reply.result;
  }
  function replyValue(result: Awaited<ReturnType<typeof readSessionReply>>) {
    if (result.ok) return result.value;
    throw new PersonVmError('PROVIDER_FAILED');
  }
  // The same exported object is used by startup proof and admitted page reads.
  // It is replaced with the actual native owner at every new VM epoch.
  const profileVerificationOwner = {};
  function verifyEditor<T>(
    caller: AbortSignal,
    guard: (signal: AbortSignal) => Promise<void>,
    verify: EditorEvidence<T>,
    duringStartup = false,
  ) {
    function editorRead<R>(name: string, read: () => Promise<R>) {
      if (!duringStartup) return read();
      stage(name);
      return read().then(
        (value) => {
          stage('editor-proof');
          return value;
        },
        (error: unknown) => {
          recordFailure(error, name);
          throw error;
        },
      );
    }
    const current = AbortSignal.any([
      caller,
      AbortSignal.timeout(input.launch.auth.timeoutMs),
    ]);
    return readCurrent(current, guard, (active) =>
      verify(
        {
          revoked: active,
          verificationOwner: profileVerificationOwner,
          readImmutableGraph: (signal) =>
            editorRead('editor-index', () =>
              readCurrent(signal, guard, readGraph),
            ),
          readImmutableBundle: (reference, bytes, signal) =>
            editorRead('editor-bundle', () =>
              readCurrent(signal, guard, (reading) =>
                readBundle(reference, bytes, reading),
              ),
            ),
        },
        () =>
          editorRead('editor-model-catalog', () =>
            readCurrent(active, guard, async (signal) => {
              const method = TYPERT_REMOTE.methods['session/modelCatalog'];
              const args = method.input({ strict: true }).create().parse({});
              const result = await readSessionReply(
                'modelCatalog',
                args,
                signal,
              );
              return {
                ok: true as const,
                value: method.result.create().parse(replyValue(result)),
              };
            }),
          ),
        active,
        installedModelAdapter,
      ),
    );
  }
  try {
    signal.throwIfAborted();
    await setup(() => input.scope.assertCurrent());
    stage('launch');
    starting = setup(async () => {
      const opened = await input.scope.launch(input.launch.command);
      job = opened;
      return opened;
    });
    const started = await starting;
    if (!sameVmBinding(started.binding, binding))
      throw new PersonVmError('LEASE_LOST');
    signal.throwIfAborted();
    nativeWait = Promise.resolve().then(() => started.wait(waitAbort.signal));
    void nativeWait.then(
      () => {
        if (!waitAbort.signal.aborted) lost('NATIVE_JOB_EXITED');
      },
      (error: unknown) => {
        if (!waitAbort.signal.aborted) lost(error);
      },
    );
    stage('auth-artifact');
    // Loss of this exact CLI job aborts the attached artifact read. Keep it
    // tracked in setup so close still waits for the native reader to join.
    const auth = await setup(() =>
      input.scope.readNativeWebAuth!(input.launch.auth, signal),
    );
    stage('auth-authority');
    signal.throwIfAborted();
    await setup(() => input.scope.assertCurrent());
    stage('auth-adapter-proof');
    if (auth.modelAdapterId !== input.launch.auth.modelAdapterId)
      throw new PersonVmError('RUNTIME_NOT_READY');
    installedModelAdapter = auth.modelAdapterId;
    stage('authenticate');
    await setup(() => transport.authenticate(auth.authenticatedUrl));
    stage('authenticate-index');
    await setup(() => transport.authenticateIndex(auth.authenticatedUrl));
    stage('install-registry');
    await setup(() => root.plugin(TypertRegistry));
    stage('install-connection');
    signal.throwIfAborted();
    installConnection(root, {
      interactions: 'none',
      transport: {
        fetch: transport.fetch,
        createWebSocket: transport.createWebSocket,
        streamBaseUrl: input.launch.auth.origin,
      },
    });
    stage('install-gateway');
    await setup(() => root.plugin(GatewayClient));
    stage('mount-session');
    await setup(() => root.remote.$mount(TYPERT_REMOTE));
    stage('mount-principal');
    await setup(() => root.remote.$mount(PRINCIPAL_REMOTE));
    stage('session-list');
    const list = await own(root.remote.session.list({}, signal));
    if (!list.ok) throw new PersonVmError('PROVIDER_FAILED');
    stage('control-first-frame');
    const stream = root.remote.session.control(signal);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await own(iterator.next());
    if (first.done || first.value.type !== 'baseline')
      throw new PersonVmError('PROVIDER_FAILED');
    stage('final-authority');
    await setup(() => input.scope.assertCurrent());
    signal.throwIfAborted();
    stage('awaiting-group-ready');
    startupComplete = true;
    ready = true;
    own(
      (async () => {
        try {
          while (!(await iterator.next()).done) signal.throwIfAborted();
        } finally {
          // Expected business cancellation must leave cleanup carrier alive.
          if (!closing) lost();
          await iterator.return?.();
        }
      })(),
    ).catch(() => {});
    // The bootstrap capability expires normally after the enclosing start
    // callback. The adopted native job belongs to the Host lifetime from here.
    input.scope.signal.removeEventListener('abort', aborted);
    return Object.freeze({
      binding,
      revoked: signal,
      modelAdapterId: installedModelAdapter,
      profileVerificationOwner,
      nativeInstanceId: job!.jobId,
      /** Connectivity only; never conveys current execution authorization. */
      controlReady: () => ready && !signal.aborted,
      async verifyStartingEditor<T>(
        startingScope: PersonVmBootstrapScope,
        caller: AbortSignal,
        verify: EditorEvidence<T>,
      ) {
        if (startingScope !== input.scope)
          throw new PersonVmError('LEASE_LOST');
        startupComplete = false;
        stage('editor-proof');
        try {
          return await verifyEditor(
            AbortSignal.any([caller, startingScope.signal]),
            () => startingScope.assertCurrent(),
            verify,
            true,
          );
        } catch (error) {
          recordFailure(error);
          await startupFailureAudit;
          throw error;
        } finally {
          stage('awaiting-group-ready');
          startupComplete = true;
        }
      },
      verifyRunningEditor<T>(
        context: RequestContext,
        caller: AbortSignal,
        verify: EditorEvidence<T>,
      ) {
        return verifyEditor(
          caller,
          (active) => input.vm.assertCurrentBinding(context, binding, active),
          verify,
        );
      },
      createRootFor(
        context: RequestContext,
        request: SessionCreateRequest,
        caller: AbortSignal,
      ) {
        return readCurrent(
          caller,
          (active) => input.vm.assertCurrentBinding(context, binding, active),
          async () => {
            const method = TYPERT_REMOTE.methods['session/create'];
            const args = method
              .input({ strict: true })
              .create()
              .parse({ request });
            // rc.2 create has no native cancellation slot. Let a dispatched
            // create settle independently of page cancellation. The scoped
            // transport confirms the matching reply AND physical HTTP close.
            const result = await readSessionReply(
              'create',
              args,
              AbortSignal.timeout(input.cleanupTimeoutMs),
            ).catch((error: unknown) => {
              throw new NativeRootJoinUnknown(error);
            });
            if (!result.ok) throw new DEntryNativeRootRejected();
            try {
              return {
                ok: true as const,
                value: method.result.create().parse(result.value),
              };
            } catch (error) {
              throw new NativeRootJoinUnknown(error);
            }
          },
        );
      },
      acquirePrincipal(
        issue: DEntryPrincipalIssue,
        requestSignal: AbortSignal,
        context?: RequestContext,
      ) {
        if (!ready || closing || signal.aborted)
          throw new PersonVmError('RUNTIME_NOT_READY');
        return principals.acquire(
          issue,
          AbortSignal.any([requestSignal, signal]),
          async (call, active) => {
            if (
              !input.beforePrompt ||
              (call.endpoint !== 'session/prompt' &&
                call.endpoint !== 'session/updateQueue')
            )
              return;
            if (
              !context ||
              !installedModelAdapter ||
              call.args.request.sessionId !== issue.root.nativeSessionId
            )
              throw new PersonVmError('AUTHORIZATION_DENIED');
            const adapterId = installedModelAdapter;
            const write = { binding, adapterId, context, issue };
            if (call.endpoint === 'session/updateQueue')
              return input.beforePrompt(
                { ...write, endpoint: call.endpoint },
                active,
              );
            const requestId = call.args.request.requestId;
            return input.beforePrompt(
              {
                ...write,
                endpoint: call.endpoint,
                requestId,
                mode: call.args.request.mode,
                observe(current) {
                  const observed = observeNativePrompt(
                    transport,
                    {
                      adapterId,
                      sessionId: issue.root.nativeSessionId,
                      scopeId: issue.scopeId,
                      requestId,
                    },
                    AbortSignal.any([signal, current]),
                    input.launch.auth.timeoutMs,
                  );
                  own(observed.settled);
                  return observed;
                },
              },
              active,
            );
          },
        );
      },
      readSessions(requestSignal: AbortSignal) {
        async function assertCurrent(current: AbortSignal) {
          try {
            await input.vm.assertCurrentBinding(
              input.context,
              binding,
              current,
            );
          } catch (error) {
            // Normal closing/retirement owns this business abort; keep ACK carrier.
            if (!closing && !requestSignal.aborted) lost();
            throw error;
          }
        }
        return readCurrentSessions(requestSignal, assertCurrent);
      },
      /** Request denial does not certify loss of this shared native owner. */
      readSessionsFor(
        context: RequestContext,
        requestSignal: AbortSignal,
        notDispatched?: () => void,
      ) {
        return readCurrentSessions(
          requestSignal,
          (current) => input.vm.assertCurrentBinding(context, binding, current),
          notDispatched,
        );
      },
      /** The existing native index supplies the running Host's own graph.
       * The release publisher independently verifies its complete code graph and
       * new document bytes. The native index is never forwarded or executed. */
      readImmutableGraphFor(
        context: RequestContext,
        requestSignal: AbortSignal,
      ) {
        const current = AbortSignal.any([signal, requestSignal]);
        return own(
          Promise.resolve().then(async () => {
            current.throwIfAborted();
            if (!ready || closing) throw new PersonVmError('RUNTIME_NOT_READY');
            await input.vm.assertCurrentBinding(context, binding, current);
            const graph = await readGraph(current);
            await input.vm.assertCurrentBinding(context, binding, current);
            current.throwIfAborted();
            return graph;
          }),
        );
      },
      /** Exact rc.2 static plugin combo roots. This never forwards a guest
       * URL, filesystem path, normal API request or browser authority. */
      readImmutableBundleFor(
        context: RequestContext,
        reference: string,
        expectedBytes: number,
        requestSignal: AbortSignal,
      ) {
        const current = AbortSignal.any([signal, requestSignal]);
        return own(
          Promise.resolve().then(async () => {
            current.throwIfAborted();
            if (!ready || closing) throw new PersonVmError('RUNTIME_NOT_READY');
            await input.vm.assertCurrentBinding(context, binding, current);
            const data = await readBundle(reference, expectedBytes, current);
            await input.vm.assertCurrentBinding(context, binding, current);
            current.throwIfAborted();
            return data;
          }),
        );
      },
      readNativeRootWakeFor(
        context: RequestContext,
        sessionId: string,
        caller: AbortSignal,
      ) {
        const current = AbortSignal.any([
          caller,
          AbortSignal.timeout(input.launch.auth.timeoutMs),
        ]);
        return readCurrent(
          current,
          (active) => input.vm.assertCurrentBinding(context, binding, active),
          async (active) => {
            if (!installedModelAdapter)
              throw new PersonVmError('RUNTIME_NOT_READY');
            const proof = await transport.readManagedModelProof(
              JSON.stringify({
                action: 'read-root-wake',
                adapterId: installedModelAdapter,
                sessionId,
              }),
              active,
            );
            if (!proof) throw new PersonVmError('PROVIDER_FAILED');
            const wake = nativeRootWake.safeParse(JSON.parse(proof));
            if (!wake.success) throw new PersonVmError('PROVIDER_FAILED');
            return wake.data;
          },
        );
      },
      readNativeAttemptFor(
        context: RequestContext,
        address: SessionAddress,
        caller: AbortSignal,
        kind: NativeModelAttemptKind = 'assistant',
      ) {
        const current = AbortSignal.any([
          caller,
          AbortSignal.timeout(input.launch.auth.timeoutMs),
        ]);
        return readCurrent(
          current,
          (active) => input.vm.assertCurrentBinding(context, binding, active),
          async (active) => {
            const protocol = TYPERT_REMOTE.methods['session/follow'];
            const { request } = protocol
              .input({ strict: true })
              .create()
              .parse({
                request: {
                  address,
                  maxMessages: 32,
                  turnWindow: { minMessages: 1, minTurns: 1 },
                  assistantStream: true,
                },
              });
            const follow = root.remote.session.follow(request, active);
            const frames = follow[Symbol.asyncIterator]();
            try {
              const first = await frames.next();
              active.throwIfAborted();
              if (first.done) throw new PersonVmError('RUNTIME_NOT_READY');
              const snapshot = protocol.result.create().parse(first.value);
              if (snapshot.type !== 'snapshot')
                throw new PersonVmError('RUNTIME_NOT_READY');
              const attempt = readNativeModelAttempt(snapshot, kind);
              if (!attempt) return null;
              if (!installedModelAdapter)
                return {
                  ...attempt,
                  recipient: undefined,
                  promptIds: [] as string[],
                  sourceTurn: null,
                  rootSessionId: null,
                  delegated: false,
                  delegatedPromptIds: [] as string[],
                };
              const proof = await transport.readManagedModelProof(
                JSON.stringify({
                  adapterId: installedModelAdapter,
                  sessionId:
                    address.kind === 'session'
                      ? address.sessionId
                      : address.childSessionId,
                  purpose: kind,
                  cursor: attempt.cursor,
                  turn: attempt.turn,
                }),
                active,
              );
              if (!proof) return null;
              const value = JSON.parse(proof) as {
                id?: unknown;
                recipient?: unknown;
                sourceTurn?: unknown;
                promptIds?: unknown;
                rootSessionId?: unknown;
                delegated?: unknown;
                delegatedPromptIds?: unknown;
              };
              const id = UuidSchema.safeParse(value?.id);
              const { promptIds, delegatedPromptIds } = value ?? {};
              if (
                !id.success ||
                typeof value.recipient !== 'string' ||
                !/^[A-Za-z0-9_-]{43}$/.test(value.recipient) ||
                Object.keys(value).length !== 7 ||
                !Number.isSafeInteger(value.sourceTurn) ||
                (attempt.turn !== null && value.sourceTurn !== attempt.turn) ||
                typeof value.rootSessionId !== 'string' ||
                !value.rootSessionId ||
                value.rootSessionId.length > 256 ||
                (address.kind === 'session' &&
                  value.rootSessionId !== address.sessionId) ||
                typeof value.delegated !== 'boolean' ||
                (address.kind === 'subagent' && !value.delegated) ||
                !Array.isArray(promptIds) ||
                promptIds.length === 0 ||
                promptIds.length > 64 ||
                promptIds.some(
                  (id) => typeof id !== 'string' || !id || id.length > 256,
                ) ||
                new Set(promptIds).size !== promptIds.length ||
                !Array.isArray(delegatedPromptIds) ||
                delegatedPromptIds.length > promptIds.length ||
                delegatedPromptIds.some((id) => !promptIds.includes(id)) ||
                new Set(delegatedPromptIds).size !==
                  delegatedPromptIds.length ||
                (value.delegated && delegatedPromptIds.length === 0)
              )
                throw new PersonVmError('PROVIDER_FAILED');
              return {
                ...attempt,
                id: kind === 'assistant' ? attempt.id : id.data,
                recipient: value.recipient,
                sourceTurn: value.sourceTurn as number,
                rootSessionId: value.rootSessionId,
                delegated: value.delegated,
                delegatedPromptIds: delegatedPromptIds as string[],
                promptIds: promptIds as string[],
              };
            } finally {
              // Dispose this logical read on its original carrier. The
              // shared owner still owns actual socket close at retirement.
              follow.dispose();
              await frames.return?.();
            }
          },
        );
      },
      waitNativeTurnEnd(
        context: RequestContext,
        address: SessionAddress,
        turn: number,
        caller: AbortSignal,
      ) {
        return readCurrent(
          caller,
          (active) => input.vm.assertCurrentBinding(context, binding, active),
          async (active) => {
            const protocol = TYPERT_REMOTE.methods['session/follow'];
            const { request } = protocol
              .input({ strict: true })
              .create()
              .parse({
                request: {
                  address,
                  maxMessages: 32,
                  turnWindow: { minMessages: 1, minTurns: 1 },
                },
              });
            const follow = root.remote.session.follow(request, active);
            const frames = follow[Symbol.asyncIterator]();
            try {
              for (;;) {
                const next = await frames.next();
                active.throwIfAborted();
                if (next.done) throw new PersonVmError('RUNTIME_NOT_READY');
                const frame = protocol.result.create().parse(next.value);
                const events =
                  frame.type === 'snapshot'
                    ? frame.records.map(({ event }) => event)
                    : frame.type === 'event'
                      ? [frame.event]
                      : [];
                for (const event of events) {
                  if (event.type !== 'turn/end') continue;
                  const data = event.data as {
                    turn?: unknown;
                    reason?: { kind?: unknown };
                  } | null;
                  if (
                    data?.turn !== turn ||
                    typeof data.reason?.kind !== 'string'
                  )
                    continue;
                  return { sequence: event.seq, reason: data.reason.kind };
                }
              }
            } finally {
              follow.dispose();
              await frames.return?.();
            }
          },
        );
      },
      readPersistedRunTerminalFor(
        selection: {
          sessionId: string;
          nativeRequestId: string;
          purpose: NativeModelAttemptKind;
          cursor: number;
          turn: number | null;
          delegated?: boolean;
          parentSessionId?: string | null;
        },
        assertCurrent: (active: AbortSignal) => Promise<void>,
        caller: AbortSignal,
      ) {
        const current = AbortSignal.any([
          caller,
          AbortSignal.timeout(input.launch.auth.timeoutMs),
        ]);
        return readCurrent(current, assertCurrent, async (active) => {
          if (!installedModelAdapter)
            throw new PersonVmError('RUNTIME_NOT_READY');
          const wire = await transport.readManagedModelProof(
            JSON.stringify({
              ...selection,
              action: 'read-run-terminal',
              adapterId: installedModelAdapter,
            }),
            active,
          );
          if (!wire) return null;
          const end = DEntryNativeTurnEndSchema.parse(JSON.parse(wire));
          if (end.sessionId !== selection.sessionId)
            throw new PersonVmError('PROVIDER_FAILED');
          return end;
        });
      },
      readManagedModelImageFor(
        context: RequestContext,
        attempt: {
          sessionId: string;
          kind: NativeModelAttemptKind;
          id: string;
        },
        ref: ImageAttachmentRef,
        target: ImageRequestTarget | null,
        caller: AbortSignal,
      ) {
        const current = AbortSignal.any([
          caller,
          AbortSignal.timeout(input.launch.auth.timeoutMs),
        ]);
        return readCurrent(
          current,
          (active) => input.vm.assertCurrentBinding(context, binding, active),
          async (active) => {
            if (!installedModelAdapter)
              throw new PersonVmError('RUNTIME_NOT_READY');
            const result = await transport.readManagedModelProof(
              JSON.stringify({
                action: 'read-image',
                adapterId: installedModelAdapter,
                sessionId: attempt.sessionId,
                purpose: attempt.kind,
                attemptId: attempt.id,
                ref,
                target,
              }),
              active,
              true,
            );
            active.throwIfAborted();
            return decodeProductionModelImage(result, ref, target);
          },
        );
      },
      /** Running Host catalog only; never startup readiness or a browser grant.
       * Native modelCatalog has zero arguments and no wire cancellation slot. */
      readModelCatalogFor(context: RequestContext, requestSignal: AbortSignal) {
        const current = AbortSignal.any([signal, requestSignal]);
        if (current.aborted) return Promise.reject(current.reason);
        if (!ready || closing)
          return Promise.reject(new PersonVmError('RUNTIME_NOT_READY'));
        // Register synchronously before either current guard or native dispatch.
        return own(
          Promise.resolve().then(async () => {
            current.throwIfAborted();
            if (!ready || closing) throw new PersonVmError('RUNTIME_NOT_READY');
            await input.vm.assertCurrentBinding(context, binding, current);
            current.throwIfAborted();
            const result = await root.remote.session.modelCatalog();
            // Join the actual zero-argument Promise before withholding cancelled output.
            current.throwIfAborted();
            await input.vm.assertCurrentBinding(context, binding, current);
            current.throwIfAborted();
            return result;
          }),
        );
      },
      /** Only the trusted runtime's confirmed-native-stop hook may use this.
       * This does not manufacture a job exit or replace normal exact close. */
      async retireAfterNativeStop(
        current: PersonVmBinding,
        cleanup: AbortSignal,
      ) {
        if (!sameVmBinding(binding, current))
          throw new PersonVmError('LEASE_LOST');
        cleanup.throwIfAborted();
        // Trusted exact-stop fact only; it does not certify any local I/O join.
        nativeStopConfirmed = true;
        const previous = closing;
        // Publish before abort/disposer reentry; no further job cancellation.
        closing = Promise.resolve().then(async () => {
          await Promise.allSettled([previous, hostClosing, disconnected]);
          hostClosing = undefined; // Fresh actual join; old rejection is no veto.
          await joinHost();
          await principals.retireAfterNativeStop(); // Local join + exact stop, no ACK.
          input.lifetime.removeEventListener('abort', aborted);
          cleanup.throwIfAborted();
        });
        ready = false;
        principals.fence(new PersonVmError('LEASE_LOST'));
        stale.abort();
        carrier.abort(); // Unblocks a pending normal ACK wait for this dead Host.
        waitAbort.abort();
        await closing;
      },
      async close() {
        try {
          await close();
        } finally {
          input.lifetime.removeEventListener('abort', aborted);
        }
      },
    });
  } catch (error) {
    recordFailure(error);
    try {
      await close();
    } finally {
      input.lifetime.removeEventListener('abort', aborted);
    }
    throw new PersonVmError('PROVIDER_FAILED');
  } finally {
    clearTimeout(startupTimer);
    input.scope.signal.removeEventListener('abort', aborted);
  }
}

export type NativeWebOwner = Awaited<ReturnType<typeof openNativeWebOwner>>;
