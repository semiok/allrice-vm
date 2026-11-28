import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import {
  clientRequestSchema,
  serverResponseSchema,
} from '@deepseek-ai/dsh-client-connection';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import * as GatewayClient from '@deepseek-ai/dsh-api-gateway/client';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import { TYPERT_REMOTE as JOB_REMOTE } from '@deepseek-ai/dsh-api-job-controller/remote';
import { TYPERT_REMOTE as GOAL_REMOTE } from '@deepseek-ai/dsh-goal/remote';
import { TYPERT_REMOTE as SCHEDULE_REMOTE } from '@deepseek-ai/dsh-schedule/remote';
import { TYPERT_REMOTE as PRINCIPAL_REMOTE } from '@allrice/d-entry-principal/remote';
import { nativeSessionRoot } from '@allrice/d-entry-principal/policy';
import {
  createDEntryPrincipalControl,
  type PrincipalInvocationObservation,
} from '../d-entry/principal-control.js';
import type {
  DEntryPrincipalIssue,
  DEntryScopeIssue,
} from '@allrice/d-entry-principal/types';
import { UuidSchema, type RequestContext } from '@allrice/contracts';
import {
  DEntryNativeTurnEndSchema,
  type DEntryNativeDeliveryClaim,
  getDEntryPageNativeRoot,
} from '@allrice/database';
import type {
  ModelCatalog,
  SessionFollowFrame,
  SessionAddress,
  SessionCreateRequest,
} from '@deepseek-ai/dsh-api-session-controller/types';
import {
  NativeWebGuestLaunchUnacknowledged,
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
import type { GuestSearchRequest } from '../person-vm/production-web-search.js';
import {
  isNativeActivityProjection,
  readNativeProfileActivity,
} from './activity.js';
import { nativeWebTransport, type NativeOwnedUnary } from './transport.js';
import { nativeSetupError, nativeSetupTarget } from './startup-diagnostic.js';
import {
  deferredPromptFact,
  NativePromptOccurrenceSchema,
  NativeRequestObservationSchema,
  observeNativePrompt,
  waitForPromptFact,
  type NativePromptObservation,
  type NativeToolObservation,
  type PublishNativeMemoryCall,
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

const nativePrompts = z
  .array(NativePromptOccurrenceSchema)
  .max(64)
  .refine(
    (prompts) =>
      new Set(
        prompts.map(({ sessionId, messageId }) =>
          JSON.stringify([sessionId, messageId]),
        ),
      ).size === prompts.length,
  );
const nativeRootWake = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('clear') }).strict(),
  z.object({ kind: z.literal('unproven') }).strict(),
  z
    .object({
      kind: z.literal('delegated'),
      turn: z.number().int().positive(),
      prompts: nativePrompts,
    })
    .strict(),
]);

const searchCallProof = z
  .object({
    callId: z.string().min(1).max(256),
    sessionId: z.string().min(1).max(256),
    rootSessionId: z.string().min(1).max(256),
    claims: nativePrompts.refine((claims) => claims.length > 0),
    turn: z.number().int().positive(),
  })
  .strict();

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
  dispatchLaunch?: Parameters<PersonVmBootstrapScope['launch']>[1];
  launch: NativeWebLaunch;
  context?: RequestContext;
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
          endpoint: 'session/prompt' | 'subagents/prompt';
          requestId: string;
          mode: 'queue' | 'steer';
          child?: { sessionId: string; parentSessionId: string };
          observe(
            signal: AbortSignal,
            onTool?: (fact: NativeToolObservation) => void,
            onMemoryCall?: PublishNativeMemoryCall,
          ): NativePromptObservation;
        }
      | {
          endpoint: 'session/updateQueue';
          child?: { sessionId: string; parentSessionId: string };
          itemId: string;
          action: 'edit' | 'remove' | 'steer';
        }
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
        requestId: UuidSchema.safeParse(input.context?.requestId).data,
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
    waitAbort = new AbortController(),
    jobExited = new AbortController();
  // Business cancellation fences calls; the separate carrier survives to carry
  // typed close/closed/end until normal cleanup, actual loss or exact stop.
  const signal = AbortSignal.any([input.lifetime, stale.signal]);
  let installedModelAdapter: string | undefined;
  let activityRevision = 0;
  // job/list is a visibility filter, with unowned Jobs visible to every
  // selector. This fresh selector creates no native Session.
  const unownedJobSelector = SessionId(randomUUID());
  let ready = false,
    closing: Promise<void> | undefined,
    hostClosing: Promise<void> | undefined;
  let job: Awaited<ReturnType<PersonVmBootstrapScope['launch']>> | undefined;
  let starting: Promise<NonNullable<typeof job>> | undefined;
  let unacknowledgedLaunch: PersonVmError | undefined;
  let nativeWait: Promise<unknown> | undefined;
  let nativeJobExited = false;
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
    };
    const audit = startupFailureAudit;
    // Publish before abort callbacks can reenter. Local drain is not remote ACK.
    disconnected = Promise.resolve().then(async () => {
      if (audit) {
        await audit;
        abortCarrier();
      }
      // A lost Web connection is not a guest exit. Keep the exact native
      // waiter owned until it observes completion or final Host cleanup.
      await Promise.allSettled([starting]);
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
          if (job && !nativeStopConfirmed && !nativeJobExited) {
            await job.cancelAndWait(
              AbortSignal.timeout(input.cleanupTimeoutMs),
            );
            nativeJobExited = true;
          }
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
    // Both authority paths describe the same withdrawal. The page carrier
    // can then match the admitted operation's terminal to this exact reason.
    const reason = new PersonVmError('LEASE_LOST');
    principals.fence(reason);
    stale.abort(reason);
    return closing;
  }
  function retireExitedOwner() {
    const previous = closing;
    // Join the exact exited owner locally. Only a confirmed VM stop can
    // resolve an otherwise unconfirmed native PTY exit.
    closing = Promise.resolve().then(async () => {
      await Promise.allSettled([previous, hostClosing, disconnected]);
      hostClosing = undefined;
      await joinHost();
      if (nativeStopConfirmed) await principals.retireAfterNativeStop();
      else await principals.retireAfterJobExit();
      input.lifetime.removeEventListener('abort', aborted);
    });
    ready = false;
    const reason = new PersonVmError('LEASE_LOST');
    principals.fence(reason);
    stale.abort(reason);
    carrier.abort();
    waitAbort.abort();
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
  async function readChildPromptTarget(
    context: RequestContext,
    sessionId: string,
    active: AbortSignal,
    expectedParent?: string,
  ) {
    const result = await readCurrentSessions(active, (current) =>
      input.vm.assertCurrentBinding(context, binding, current),
    );
    if (!result.ok) throw result.error;
    const rows = result.value.items;
    const entries = new Map(
      rows.map((entry) => [String(entry.sessionId), entry]),
    );
    const target = entries.get(sessionId);
    const rootEntry = nativeSessionRoot(entries, sessionId);
    const parent =
      target?.parentSessionId && entries.get(target.parentSessionId);
    if (
      entries.size !== rows.length ||
      target?.origin !== 'subagent' ||
      !rootEntry ||
      !parent?.agentAvailable ||
      (expectedParent !== undefined && expectedParent !== parent.sessionId)
    )
      throw new PersonVmError('AUTHORIZATION_DENIED');
    return {
      rootSessionId: rootEntry.sessionId,
      child: {
        sessionId: target.sessionId,
        parentSessionId: parent.sessionId,
      },
    };
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
  async function readUnaryReply(
    method: NativeOwnedUnary,
    args: object,
    signal: AbortSignal,
  ) {
    const rpcId = randomUUID();
    const body = JSON.stringify(
      clientRequestSchema.parse({
        type: 'client-request',
        method,
        rpcId,
        payload: { args },
      }),
    );
    const wire = await transport.readUnaryReply(method, body, signal);
    const reply = serverResponseSchema.parse(JSON.parse(wire));
    if (reply.rpcId !== rpcId) throw new PersonVmError('PROVIDER_FAILED');
    return reply.result;
  }
  function replyValue(result: Awaited<ReturnType<typeof readUnaryReply>>) {
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
              const result = await readUnaryReply(
                'session/modelCatalog',
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
      try {
        const dispatch = input.dispatchLaunch;
        job = await input.scope.launch(
          input.launch.command,
          dispatch
            ? (active, issue) =>
                dispatch(AbortSignal.any([active, signal]), issue)
            : undefined,
          (launched) => {
            if (!sameVmBinding(launched.binding, binding))
              throw new PersonVmError('LEASE_LOST');
            job = launched;
          },
        );
        return job;
      } catch (error) {
        if (
          error instanceof PersonVmError &&
          error.code === 'CLEANUP_INCOMPLETE'
        )
          unacknowledgedLaunch = error;
        throw error;
      }
    });
    const started = await starting;
    if (!sameVmBinding(started.binding, binding))
      throw new PersonVmError('LEASE_LOST');
    signal.throwIfAborted();
    nativeWait = Promise.resolve().then(() => started.wait(waitAbort.signal));
    void nativeWait.then(
      () => {
        if (waitAbort.signal.aborted) return;
        nativeJobExited = true;
        lost('NATIVE_JOB_EXITED');
        jobExited.abort();
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
    stage('mount-job');
    await setup(() => root.remote.$mount(JOB_REMOTE));
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
          for (
            let next = await iterator.next();
            !next.done;
            next = await iterator.next()
          ) {
            signal.throwIfAborted();
            const frame = next.value;
            if (
              frame.type === 'projection' &&
              isNativeActivityProjection(frame.key, frame.value)
            )
              activityRevision++;
          }
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
      /** Positive exact managed wait. Transport loss cannot signal job exit. */
      jobExited: jobExited.signal,
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
          async (active) => {
            const path = input.launch.command.workdir;
            if (!path) throw new PersonVmError('PROVIDER_FAILED');
            // Native create is idempotent for the current real directory.
            // Resolve it from this authenticated Host rather than retaining a
            // workspace ID that may have been removed by the native UI.
            const registration = await readUnaryReply(
              'workspace/create',
              { request: { path } },
              AbortSignal.any([
                active,
                AbortSignal.timeout(input.cleanupTimeoutMs),
              ]),
            );
            const { workspace } = z
              .object({
                workspace: z.object({ workspaceId: UuidSchema }),
              })
              .parse(replyValue(registration));
            await input.vm.assertCurrentBinding(context, binding, active);
            active.throwIfAborted();
            const method = TYPERT_REMOTE.methods['session/create'];
            const args = method
              .input({ strict: true })
              .create()
              .parse({
                request: {
                  ...request,
                  workspaceId: WorkspaceId(workspace.workspaceId),
                  agentPreset: 'standard',
                },
              });
            // rc.2 create has no native cancellation slot. Let a dispatched
            // create settle independently of page cancellation. The scoped
            // transport confirms the matching reply AND physical HTTP close.
            const result = await readUnaryReply(
              'session/create',
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
        issue: DEntryScopeIssue,
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
              call.endpoint !== 'session/prompt' &&
              call.endpoint !== 'subagents/prompt' &&
              call.endpoint !== 'session/updateQueue'
            )
              return;
            if (!input.beforePrompt) {
              if (issue.access === 'page')
                throw new PersonVmError('RUNTIME_NOT_READY');
              return;
            }
            if (!context || !installedModelAdapter)
              throw new PersonVmError('AUTHORIZATION_DENIED');
            const readPagePin = (sessionId: string) =>
              getDEntryPageNativeRoot(
                context,
                issue.identity,
                binding.vmId,
                sessionId,
              );
            let authorized: DEntryPrincipalIssue;
            let child:
              { sessionId: string; parentSessionId: string } | undefined;
            let pin: Awaited<ReturnType<typeof readPagePin>>;
            let rootSessionId: string;
            if (call.endpoint === 'subagents/prompt') {
              if (issue.access !== 'page')
                throw new PersonVmError('AUTHORIZATION_DENIED');
              const { childSessionId, parentSessionId } = call.args.request;
              ({ rootSessionId, child } = await readChildPromptTarget(
                context,
                childSessionId,
                active,
                parentSessionId,
              ));
            } else {
              rootSessionId = call.args.request.sessionId;
              if (
                issue.access === 'page' &&
                call.endpoint === 'session/updateQueue'
              ) {
                pin = await readPagePin(rootSessionId);
                if (!pin)
                  ({ rootSessionId, child } = await readChildPromptTarget(
                    context,
                    rootSessionId,
                    active,
                  ));
              }
            }
            if (issue.access === 'page') {
              pin ??= await readPagePin(rootSessionId);
              if (
                !pin ||
                pin.vmId !== binding.vmId ||
                pin.rootNativeSessionId !== rootSessionId
              )
                throw new PersonVmError('AUTHORIZATION_DENIED');
              authorized = {
                scopeId: issue.scopeId,
                identity: pin.identity,
                access: 'execute',
                root: {
                  nativeSessionId: pin.rootNativeSessionId,
                  rootBindingRef: pin.rootBindingRef,
                  rootOriginDigest: pin.rootOriginDigest,
                  ...(pin.forkedFromNativeSessionId && {
                    forkedFromNativeSessionId: pin.forkedFromNativeSessionId,
                  }),
                },
              };
            } else {
              if (rootSessionId !== issue.root.nativeSessionId)
                throw new PersonVmError('AUTHORIZATION_DENIED');
              authorized = issue;
            }
            await input.vm.assertCurrentBinding(context, binding, active);
            active.throwIfAborted();
            const adapterId = installedModelAdapter;
            const write = { binding, adapterId, context, issue: authorized };
            if (call.endpoint === 'session/updateQueue')
              return input.beforePrompt(
                {
                  ...write,
                  endpoint: call.endpoint,
                  child,
                  itemId: call.args.request.itemId,
                  action: call.args.request.action.kind,
                },
                active,
              );
            const requestId = call.args.request.requestId;
            let observed: NativePromptObservation | undefined;
            const admission = await input.beforePrompt(
              {
                ...write,
                endpoint: call.endpoint,
                requestId,
                mode:
                  call.endpoint === 'subagents/prompt'
                    ? call.args.request.delivery
                    : call.args.request.mode,
                child,
                observe(current, onTool, onMemoryCall) {
                  observed = observeNativePrompt(
                    transport,
                    {
                      adapterId,
                      sessionId: child?.sessionId ?? rootSessionId,
                      ...(child && { parentSessionId: child.parentSessionId }),
                      scopeId: issue.scopeId,
                      requestId,
                    },
                    AbortSignal.any([signal, current]),
                    input.launch.auth.timeoutMs,
                    onTool,
                    onMemoryCall,
                  );
                  own(observed.settled);
                  return observed;
                },
              },
              active,
            );
            if (!child || !admission) return admission;
            return {
              ...admission,
              assertInserted(messageId, signal) {
                if (!observed) throw new PersonVmError('PROVIDER_FAILED');
                return observed.assertInserted(messageId, signal);
              },
            };
          },
        );
      },
      readSessions(requestSignal: AbortSignal) {
        const context = input.context;
        if (!context)
          return Promise.reject(new PersonVmError('AUTHORIZATION_DENIED'));
        const assertCurrent = async (current: AbortSignal) => {
          try {
            await input.vm.assertCurrentBinding(context, binding, current);
          } catch (error) {
            // Normal closing/retirement owns this business abort; keep ACK carrier.
            if (!closing && !requestSignal.aborted) lost();
            throw error;
          }
        };
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
      nativeActivityRevision: () => activityRevision,
      /** Activity samples from this authenticated, exact Host. None of
       * these public queries activates or waits for a Session's runtime. */
      readNativeActivity(
        assertCurrent: (signal: AbortSignal) => Promise<void>,
        caller: AbortSignal,
      ) {
        const current = AbortSignal.any([
          caller,
          AbortSignal.timeout(input.launch.auth.timeoutMs),
        ]);
        return readCurrent(current, assertCurrent, (active) =>
          readNativeProfileActivity(
            {
              sessions: async (signal) => {
                const method = TYPERT_REMOTE.methods['session/list'];
                const args = method
                  .input({ strict: true })
                  .create()
                  .parse({ _request: {} });
                const result = await readUnaryReply(
                  'session/list',
                  args,
                  signal,
                );
                return method.result.create().parse(replyValue(result)).items;
              },
              jobs: async (sessionId, signal) => {
                const stream = root.remote.job.list(
                  { sessionId: sessionId ?? unownedJobSelector },
                  signal,
                );
                const rows = stream[Symbol.asyncIterator]();
                try {
                  const first = await rows.next();
                  if (first.done) throw new PersonVmError('RUNTIME_NOT_READY');
                  return JOB_REMOTE.methods['job/list'].result
                    .create()
                    .parse(first.value);
                } finally {
                  stream.dispose();
                  await rows.return?.();
                }
              },
              projections: async (sessionId, signal) => {
                const method = TYPERT_REMOTE.methods['session/projections'];
                const args = method
                  .input({ strict: true })
                  .create()
                  .parse({ request: { sessionId } });
                const result = await readUnaryReply(
                  'session/projections',
                  args,
                  signal,
                );
                return method.result.create().parse(replyValue(result));
              },
              goal: async (agentId, signal) => {
                const method = GOAL_REMOTE.methods['goals/get'];
                const args = method
                  .input({ strict: true })
                  .create()
                  .parse({ agentId });
                const result = await readUnaryReply('goals/get', args, signal);
                return method.result.create().parse(replyValue(result));
              },
            },
            active,
          ),
        );
      },
      /** The host supplies its guard under the current physical lease. */
      readScheduleCatalog(
        assertCurrent: (signal: AbortSignal) => Promise<void>,
        caller: AbortSignal,
      ) {
        const method = SCHEDULE_REMOTE.methods['schedule/catalog'];
        const current = AbortSignal.any([
          caller,
          AbortSignal.timeout(input.launch.auth.timeoutMs),
        ]);
        return readCurrent(current, assertCurrent, async (active) => {
          const args = method.input({ strict: true }).create().parse({});
          const result = await readUnaryReply('schedule/catalog', args, active);
          const value = replyValue(result);
          const parsed = method.result.create().parse(value);
          // Reject protocol normalization before the observer hashes rows.
          if (!isDeepStrictEqual(value, parsed))
            throw new PersonVmError('PROVIDER_FAILED');
          return parsed;
        });
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
            if (
              wake.data.kind === 'delegated' &&
              (!wake.data.prompts.length ||
                wake.data.prompts.some(
                  (prompt) =>
                    (prompt.sessionId === sessionId) ===
                    !!prompt.parentSessionId,
                ))
            )
              throw new PersonVmError('PROVIDER_FAILED');
            return wake.data;
          },
        );
      },
      async observeNativeSearchCallFor(
        context: RequestContext,
        wanted: GuestSearchRequest,
        caller: AbortSignal,
      ) {
        const stop = new AbortController();
        const ended = new AbortController();
        const observed = deferredPromptFact<z.infer<typeof searchCallProof>>();
        const failure = () => new PersonVmError('AUTHORIZATION_DENIED');
        let settled: Promise<unknown> | undefined;
        let proofSeen = false;
        let tail = Buffer.alloc(0);
        const current = AbortSignal.any([signal, caller, stop.signal]);
        const setup = AbortSignal.any([
          current,
          AbortSignal.timeout(input.launch.auth.timeoutMs),
        ]);
        const close = async () => {
          stop.abort();
          await settled?.catch(() => {});
        };
        try {
          const proof = await readCurrent(
            setup,
            (active) => input.vm.assertCurrentBinding(context, binding, active),
            async (active) => {
              if (installedModelAdapter !== wanted.adapterId) throw failure();
              settled = own(
                transport.readManagedModelProof(
                  JSON.stringify({ ...wanted, action: 'observe-search-call' }),
                  current,
                  false,
                  (chunk) => {
                    tail = Buffer.concat([tail, chunk]);
                    for (
                      let split = tail.indexOf(10);
                      split >= 0;
                      split = tail.indexOf(10)
                    ) {
                      const line = tail.subarray(0, split).toString('utf8');
                      tail = tail.subarray(split + 1);
                      if (ended.signal.aborted) throw failure();
                      if (!proofSeen) {
                        const parsed = searchCallProof.parse(JSON.parse(line));
                        if (parsed.sessionId !== wanted.sessionId)
                          throw failure();
                        proofSeen = true;
                        observed.resolve(parsed);
                      } else if (line === 'ended') ended.abort(failure());
                      else throw failure();
                    }
                  },
                ),
              );
              void settled.then(
                () => {
                  ended.abort(failure());
                  observed.reject(failure());
                },
                () => {
                  ended.abort(failure());
                  observed.reject(failure());
                },
              );
              return waitForPromptFact(observed.promise, active);
            },
          );
          ended.signal.throwIfAborted();
          return { proof, signal: ended.signal, close };
        } catch (error) {
          await close();
          throw error;
        }
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
                  prompts: [],
                  sourceTurn: null,
                  rootSessionId: null,
                  delegated: false,
                  inheritedPromptIndexes: [] as number[],
                  observation: null,
                };
              const proof = await transport.readManagedModelProof(
                JSON.stringify({
                  adapterId: installedModelAdapter,
                  sessionId:
                    address.kind === 'session'
                      ? address.sessionId
                      : address.childSessionId,
                  purpose: kind,
                  ...(kind === 'assistant' && { nativeAttemptId: attempt.id }),
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
                prompts?: unknown;
                rootSessionId?: unknown;
                delegated?: unknown;
                inheritedPromptIndexes?: unknown;
                observation?: unknown;
              };
              const id = UuidSchema.safeParse(value?.id);
              const prompts = nativePrompts.safeParse(value?.prompts);
              const inherited = z
                .array(z.number().int().nonnegative())
                .max(64)
                .safeParse(value?.inheritedPromptIndexes);
              if (
                !id.success ||
                typeof value.recipient !== 'string' ||
                !/^[A-Za-z0-9_-]{43}$/.test(value.recipient) ||
                Object.keys(value).length !==
                  (Object.hasOwn(value, 'observation') ? 8 : 7) ||
                !Number.isSafeInteger(value.sourceTurn) ||
                (attempt.turn !== null && value.sourceTurn !== attempt.turn) ||
                typeof value.rootSessionId !== 'string' ||
                !value.rootSessionId ||
                value.rootSessionId.length > 256 ||
                (address.kind === 'session' &&
                  value.rootSessionId !== address.sessionId) ||
                typeof value.delegated !== 'boolean' ||
                (address.kind === 'subagent' && !value.delegated) ||
                !prompts.success ||
                !prompts.data.length ||
                !inherited.success ||
                (value.delegated &&
                  address.kind === 'session' &&
                  !inherited.data.length)
              )
                throw new PersonVmError('PROVIDER_FAILED');
              const observation =
                NativeRequestObservationSchema.nullable().safeParse(
                  value.observation ?? null,
                );
              const references = new Set(inherited.data);
              if (
                references.size !== inherited.data.length ||
                inherited.data.some((index) => index >= prompts.data.length) ||
                prompts.data.some((prompt, index) => {
                  if (references.has(index))
                    return (
                      (prompt.sessionId === value.rootSessionId) ===
                      !!prompt.parentSessionId
                    );
                  return address.kind === 'session'
                    ? prompt.sessionId !== address.sessionId ||
                        prompt.parentSessionId !== undefined
                    : prompt.sessionId !== address.childSessionId ||
                        prompt.parentSessionId !== address.parentSessionId;
                })
              )
                throw new PersonVmError('PROVIDER_FAILED');
              return {
                ...attempt,
                id: kind === 'assistant' ? attempt.id : id.data,
                recipient: value.recipient,
                sourceTurn: value.sourceTurn as number,
                rootSessionId: value.rootSessionId,
                delegated: value.delegated,
                inheritedPromptIndexes: inherited.data,
                observation: observation.success ? observation.data : null,
                promptIds: prompts.data.map(({ requestId }) => requestId),
                prompts: prompts.data,
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
      exchangeNativeDeliveryFor(
        request:
          | { action: 'delivery-pending' }
          | (DEntryNativeDeliveryClaim & {
              action: 'delivery-read' | 'delivery-live' | 'delivery-ack';
            }),
        caller: AbortSignal,
      ) {
        const active = AbortSignal.any([caller, AbortSignal.timeout(5_000)]);
        return readCurrent(
          active,
          async () => {},
          async (signal) => {
            if (!installedModelAdapter)
              throw new PersonVmError('RUNTIME_NOT_READY');
            const wire = await transport.readManagedModelProof(
              JSON.stringify({ ...request, adapterId: installedModelAdapter }),
              signal,
              false,
              undefined,
              request.action === 'delivery-read' ? 22_000_000 : undefined,
            );
            return wire ? (JSON.parse(wire) as unknown) : null;
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
          forkedFromNativeSessionId?: string;
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
      /** The retained managed job itself supplies the successful wait. */
      retireAfterJobExit(current: PersonVmBinding) {
        if (!sameVmBinding(binding, current))
          throw new PersonVmError('LEASE_LOST');
        if (nativeJobExited && !principals.hasUnconfirmedTerminalExit())
          return retireExitedOwner();
      },
      /** Only the trusted runtime's confirmed-native-stop hook may use this. */
      async retireAfterNativeStop(
        current: PersonVmBinding,
        cleanup: AbortSignal,
      ) {
        if (!sameVmBinding(binding, current))
          throw new PersonVmError('LEASE_LOST');
        cleanup.throwIfAborted();
        // Trusted exact-stop fact only; it does not certify any local I/O join.
        nativeStopConfirmed = true;
        await retireExitedOwner();
        cleanup.throwIfAborted();
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
    if (unacknowledgedLaunch && error === unacknowledgedLaunch)
      throw new NativeWebGuestLaunchUnacknowledged(
        binding,
        unacknowledgedLaunch,
      );
    if (error instanceof PersonVmError && error.code === 'CLEANUP_INCOMPLETE')
      throw error;
    throw new PersonVmError('PROVIDER_FAILED');
  } finally {
    clearTimeout(startupTimer);
    input.scope.signal.removeEventListener('abort', aborted);
  }
}

export type NativeWebOwner = Awaited<ReturnType<typeof openNativeWebOwner>>;
