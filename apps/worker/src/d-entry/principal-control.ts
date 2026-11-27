import { dEntryStartupTiming } from './startup-timing.js';
import { sameDEntryIdentity } from '@allrice/contracts';
import type { Context } from '@deepseek-ai/cordis';
import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types';
import { TYPERT_REMOTE as Native } from '@deepseek-ai/dsh-api-session-controller/remote';
import { TYPERT_REMOTE as Subagents } from '@deepseek-ai/dsh-subagent/remote';
import {
  RemoteError,
  type RemoteStreamHandle,
  type TypertSchema,
} from '@deepseek-ai/dsh-typert-protocol';
import { TYPERT_REMOTE } from '@allrice/d-entry-principal/remote';
import {
  DEntryScopeIssueSchema,
  type DEntryPageInput,
  type DEntryPageNativeCall,
  type DEntryPageNativeEnd,
  type DEntryPageNativeError,
  type DEntryPageNativeItem,
  type DEntryPrincipalActivity,
  type DEntryPrincipalControlScope,
  type DEntryScopeIssue,
  type DEntryScopedStreamCall,
  type DEntryScopedStreamFrame,
  type DEntryScopedUnaryCall,
  type InputOf,
  type ScopeFrame,
} from '@allrice/d-entry-principal/types';

type StreamFrame =
  | DEntryScopedStreamFrame
  | DEntryPageNativeItem
  | DEntryPageNativeError
  | DEntryPageNativeEnd;

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const unknown = (cause?: unknown) => Error('PRINCIPAL_JOIN_UNKNOWN', { cause });

export type PrincipalInvocationObservation = Readonly<{
  undispatched(): Promise<void>;
  accepted(): void;
  unknown(): void;
  assertInserted?(messageId: string, signal: AbortSignal): Promise<void>;
}>;
type PrincipalInvocationCall =
  | DEntryScopedUnaryCall
  | Readonly<{
      scopeId: string;
      endpoint: 'subagents/prompt';
      args: InputOf<(typeof Subagents.methods)['subagents/prompt']>;
    }>;

export function isCertainNativePromptRejection(
  call: PrincipalInvocationCall,
  code: string,
) {
  if (call.endpoint === 'subagents/prompt')
    return [
      'subagent/invalid-time-zone',
      'subagent/parent-unavailable',
      'subagent/attachment-invalid',
      'subagent/unauthorized',
      'subagent/not-resumable',
      'subagent/delivery-unavailable',
    ].includes(code);
  if (call.endpoint !== 'session/prompt') return false;
  if (code === 'gateway/bad-request') {
    // rc.2's prompt rejects this exact shape before resolving an Agent or
    // checking duplicates. This gateway code alone proves nothing.
    return call.args.request.content.every(
      (part: PromptContentPart) =>
        part.type === 'text' && part.text.trim().length === 0,
    );
  }
  return [
    'session/invalid-time-zone',
    'session/attachment-invalid',
    'session/model-unavailable',
    'session/not-found',
    'session/writer-held',
  ].includes(code);
}

function pageModelInput(
  call: DEntryPageNativeCall,
): PrincipalInvocationCall | undefined {
  const { scopeId, endpoint } = call;
  if (endpoint === 'session/prompt')
    return {
      scopeId,
      endpoint,
      args: Native.methods[endpoint]
        .input({ strict: true })
        .create()
        .parse(call.args),
    };
  if (endpoint === 'session/updateQueue')
    return {
      scopeId,
      endpoint,
      args: Native.methods[endpoint]
        .input({ strict: true })
        .create()
        .parse(call.args),
    };
  if (endpoint === 'subagents/prompt')
    return {
      scopeId,
      endpoint,
      args: Subagents.methods[endpoint]
        .input({ strict: true })
        .create()
        .parse(call.args),
    };
}
/** One reader for a native duplex handle. One-item handoff applies backpressure;
 * close discards business delivery but keeps consuming exact closed/end. */
class Relay<T extends ScopeFrame | StreamFrame> {
  private item?: T;
  private changed = deferred<void>();
  private consumed = deferred<void>();
  private ended = false;
  private closing = false;
  private joined?: Promise<void>;
  private closed = false;
  private withdrawn = false;
  private failure: unknown;
  readonly done: Promise<void>;
  constructor(
    private readonly handle: RemoteStreamHandle<T, 'close'>,
    private readonly scopeId: string,
    private readonly timeoutMs: number,
    parser: TypertSchema<T>,
    receive: (frame: T) => boolean,
    fence?: (reason: unknown) => void,
    private readonly shutdown?: AbortSignal,
  ) {
    this.done = (async () => {
      try {
        for await (const raw of handle) {
          const frame = parser.parse(raw);
          if (frame.scopeId !== scopeId || this.closed) throw unknown();
          if (frame.type === 'closed') {
            this.closed = true;
            fence?.(Error('PRINCIPAL_SCOPE_CLOSED'));
            continue;
          }
          if (this.withdrawn) throw unknown();
          if (frame.type === 'revoked') this.withdrawn = true;
          if (!receive(frame) || this.closing) continue;
          this.item = frame;
          this.changed.resolve();
          await this.consumed.promise;
          this.consumed = deferred<void>();
        }
        if (!this.closed) throw unknown();
      } catch (error) {
        this.failure = error;
        fence?.(error);
        throw error;
      } finally {
        this.ended = true;
        this.changed.resolve();
      }
    })();
    void this.done.catch(() => {});
  }
  async next(): Promise<IteratorResult<T>> {
    while (true) {
      if (this.item) {
        const value = this.item;
        this.item = undefined;
        this.consumed.resolve();
        return { done: false, value };
      }
      if (this.ended) {
        if (this.failure) throw this.failure;
        return { done: true, value: undefined };
      }
      await this.changed.promise;
      this.changed = deferred<void>();
    }
  }
  close(): Promise<void> {
    if (this.joined) return this.joined;
    this.joined = Promise.resolve().then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let startDeadline: (() => void) | undefined;
      const deliveryErrors: unknown[] = [];
      try {
        if (!this.ended && !this.closed && !this.withdrawn) {
          try {
            this.handle.send('close');
            this.handle.end();
          } catch (error) {
            // The native carrier may already have delivered closed/end while
            // our relay still owns a buffered item. Only the downlink can
            // establish the remote terminal outcome.
            deliveryErrors.push(error);
          }
        }
        await Promise.race([
          this.done,
          new Promise<never>((_, reject) => {
            startDeadline = () => {
              timer = setTimeout(() => reject(unknown()), this.timeoutMs);
            };
            if (this.shutdown && !this.shutdown.aborted)
              this.shutdown.addEventListener('abort', startDeadline, {
                once: true,
              });
            else startDeadline();
          }),
        ]);
        if (!this.closed) throw unknown();
      } catch (error) {
        const local = await Promise.allSettled([
          Promise.resolve().then(() => this.local()),
        ]);
        const failures = [
          ...deliveryErrors,
          ...local.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          ),
        ];
        throw unknown(
          failures.length
            ? new AggregateError(
                [error, ...failures],
                'PRINCIPAL_LOCAL_JOIN_FAILED',
              )
            : error,
        );
      } finally {
        if (timer) clearTimeout(timer);
        if (startDeadline)
          this.shutdown?.removeEventListener('abort', startDeadline);
      }
    });
    this.closing = true;
    this.item = undefined;
    this.consumed.resolve();
    this.changed.resolve();
    return this.joined;
  }
  async local() {
    this.closing = true;
    this.item = undefined;
    this.consumed.resolve();
    this.changed.resolve();
    this.handle.dispose();
    await Promise.allSettled([this.done]);
  }
}

/** Owned Node client of the generated guest issuer; no snapshot/permission
 * callback is accepted. The shared owner supplies a separate cleanup carrier. */
export function createDEntryPrincipalControl(
  root: Context,
  input: { carrier: AbortSignal; cleanupTimeoutMs: number },
) {
  if (
    !Number.isSafeInteger(input.cleanupTimeoutMs) ||
    input.cleanupTimeoutMs <= 0
  )
    throw Error('PRINCIPAL_TIMEOUT_INVALID');
  const activities = new Set<
    DEntryPrincipalActivity & {
      local(): Promise<void>;
      fence(reason?: unknown): void;
    }
  >();
  const shutdown = new AbortController();
  let stopped = false,
    closing: Promise<void> | undefined;
  const control = {
    acquire(
      value: DEntryScopeIssue,
      caller: AbortSignal,
      beforeInvoke?: (
        call: PrincipalInvocationCall,
        signal: AbortSignal,
      ) => Promise<PrincipalInvocationObservation | undefined>,
    ): DEntryPrincipalActivity {
      if (stopped) throw Error('PRINCIPAL_CONTROL_CLOSED');
      caller.throwIfAborted();
      input.carrier.throwIfAborted();
      const issue = DEntryScopeIssueSchema.parse(value);
      const revoked = new AbortController();
      let started = false;
      let relay: Relay<ScopeFrame> | undefined;
      let running: Promise<DEntryPrincipalControlScope> | undefined,
        joined: Promise<void> | undefined;
      const children = new Set<Relay<StreamFrame>>();
      const operations = new Set<Promise<unknown>>();
      const follows = new Map<string, AbortController>();
      let detachRun = () => {};
      let published = false;
      const opened = deferred<Extract<ScopeFrame, { type: 'opened' }>>();
      const activity = {
        fence(reason?: unknown) {
          revoked.abort(reason);
        },
        run(signal: AbortSignal) {
          if (joined || revoked.signal.aborted)
            return Promise.reject(Error('PRINCIPAL_SCOPE_CLOSED'));
          if (running) return running;
          const business = AbortSignal.any([caller, signal, revoked.signal]);
          const cancelled = () => {
            void activity.close().catch(() => {});
          };
          business.addEventListener('abort', cancelled, { once: true });
          detachRun = () => business.removeEventListener('abort', cancelled);
          running = Promise.resolve().then(async () => {
            business.throwIfAborted();
            if (stopped) throw Error('PRINCIPAL_CONTROL_CLOSED');
            started = true;
            const timing = dEntryStartupTiming('principal-wire');
            const handle = TYPERT_REMOTE.methods[
              'allricePrincipal/openScope'
            ].invoke(root.remote, { issue }, input.carrier);
            relay = new Relay(
              handle,
              issue.scopeId,
              input.cleanupTimeoutMs,
              TYPERT_REMOTE.methods[
                'allricePrincipal/openScope'
              ].result.create(),
              (frame) => {
                if (frame.type === 'follow-revoked' && published) {
                  follows.get(frame.followId)?.abort(
                    new RemoteError(
                      'remote-access/denied',
                      'Native session follow unavailable',
                      {
                        action: 'session/follow',
                        reason: 'session-changed',
                      },
                    ),
                  );
                  return false;
                }
                if (frame.type === 'revoked' && published) {
                  revoked.abort(Error('PRINCIPAL_SCOPE_REVOKED'));
                  return false;
                }
                if (
                  frame.type !== 'opened' ||
                  frame.baseline.owner ||
                  frame.principal.scopeId !== issue.scopeId ||
                  !sameDEntryIdentity(
                    frame.principal.identity,
                    issue.identity,
                  ) ||
                  published
                )
                  throw Error('PRINCIPAL_OPEN_INVALID');
                published = true;
                opened.resolve(frame);
                return false;
              },
              (reason) => {
                if (published) revoked.abort(reason);
                else opened.reject(reason);
              },
              // The terminal login owner is already fenced on revocation.
              // A healthy guest may take longer than a page close to prove
              // process exit. Bound the join once the shared Host retires.
              issue.access === 'page' && issue.terminalOwner
                ? shutdown.signal
                : undefined,
            );
            if (business.aborted || joined) void relay.close().catch(() => {});
            const first = await timing.run(
              'openScope-first-frame',
              async () => {
                const first = await opened.promise;
                business.throwIfAborted();
                return first;
              },
            );
            timing.ready();
            function invoke(
              call: DEntryScopedUnaryCall | DEntryPageNativeCall,
              active: AbortSignal,
            ) {
              business.throwIfAborted();
              active.throwIfAborted();
              if (call.scopeId !== issue.scopeId)
                throw Error('PRINCIPAL_SCOPE_MISMATCH');
              const task = Promise.resolve().then(async () => {
                business.throwIfAborted();
                active.throwIfAborted();
                const protectedCall =
                  'kind' in call ? pageModelInput(call) : call;
                const observation =
                  protectedCall &&
                  (await beforeInvoke?.(
                    protectedCall,
                    AbortSignal.any([active, business]),
                  ));
                try {
                  business.throwIfAborted();
                  active.throwIfAborted();
                } catch (error) {
                  await observation?.undispatched();
                  throw error;
                }
                let known = false;
                try {
                  const result = await TYPERT_REMOTE.methods[
                    'allricePrincipal/invokeScoped'
                  ].invoke(
                    root.remote,
                    { call },
                    AbortSignal.any([active, business]),
                  );
                  if (!result.ok) {
                    // These rc.2 prompt-specific failures precede inbox
                    // admission. Generic gateway failures prove no outcome.
                    if (
                      protectedCall &&
                      isCertainNativePromptRejection(
                        protectedCall,
                        String(result.error?.code),
                      )
                    ) {
                      known = true;
                      await observation?.undispatched();
                    }
                    throw result.error;
                  }
                  const value = TYPERT_REMOTE.methods[
                    'allricePrincipal/invokeScoped'
                  ].result
                    .create()
                    .parse(result.value);
                  if (value.endpoint !== call.endpoint)
                    throw Error('PRINCIPAL_REMOTE_RESULT_INVALID');
                  if (protectedCall?.endpoint === 'subagents/prompt') {
                    if (!('kind' in value) || !observation?.assertInserted)
                      throw Error('PRINCIPAL_REMOTE_RESULT_INVALID');
                    const receipt = Subagents.methods['subagents/prompt'].result
                      .create()
                      .parse(value.value);
                    await observation.assertInserted(
                      receipt.messageId,
                      AbortSignal.any([active, business]),
                    );
                  }
                  known = true;
                  observation?.accepted();
                  business.throwIfAborted();
                  active.throwIfAborted();
                  return value;
                } finally {
                  if (!known) observation?.unknown();
                }
              });
              operations.add(task);
              void task.then(
                () => operations.delete(task),
                () => operations.delete(task),
              );
              return task;
            }
            function stream(
              call: DEntryScopedStreamCall | DEntryPageNativeCall,
              active: AbortSignal,
              observed?: Parameters<DEntryPrincipalControlScope['stream']>[2],
            ) {
              business.throwIfAborted();
              active.throwIfAborted();
              if (call.scopeId !== issue.scopeId)
                throw Error('PRINCIPAL_SCOPE_MISMATCH');
              const handle = TYPERT_REMOTE.methods[
                'allricePrincipal/streamScoped'
              ].invoke(root.remote, { call }, input.carrier);
              const current = AbortSignal.any([business, active]);
              const child = new Relay(
                handle,
                issue.scopeId,
                input.cleanupTimeoutMs,
                TYPERT_REMOTE.methods[
                  'allricePrincipal/streamScoped'
                ].result.create(),
                (frame) => {
                  if (!current.aborted && frame.type === 'item')
                    observed?.item(frame);
                  return true;
                },
                () => observed?.terminal(),
              );
              children.add(child);
              const cancelled = () => {
                void child.close().catch(() => {});
              };
              current.addEventListener('abort', cancelled, { once: true });
              void child.done.then(
                () => {
                  children.delete(child);
                  current.removeEventListener('abort', cancelled);
                },
                () => {
                  current.removeEventListener('abort', cancelled);
                },
              );
              if (current.aborted) cancelled();
              let taken = false;
              return {
                close: () => child.close(),
                send(command: DEntryPageInput) {
                  current.throwIfAborted();
                  handle.send(command);
                },
                async *[Symbol.asyncIterator]() {
                  if (taken) throw Error('PRINCIPAL_STREAM_ALREADY_CONSUMED');
                  taken = true;
                  let failed = false;
                  try {
                    while (true) {
                      current.throwIfAborted();
                      const next = await child.next();
                      current.throwIfAborted();
                      if (next.done) return;
                      if (next.value.type !== 'closed') yield next.value;
                    }
                  } catch (error) {
                    failed = true;
                    throw error;
                  } finally {
                    try {
                      await (failed
                        ? child.close().catch(() => {})
                        : child.close());
                    } finally {
                      current.removeEventListener('abort', cancelled);
                    }
                  }
                },
              };
            }
            return {
              opened: first,
              revoked: business,
              async invoke(call, active) {
                const value = await invoke(call, active);
                if ('kind' in value) throw unknown();
                return value;
              },
              async invokePage(call, active) {
                const value = await invoke(call, active);
                if (!('kind' in value) || value.kind !== 'page')
                  throw unknown();
                return value;
              },
              stream(call, active, observed) {
                const child = stream(call, active, observed);
                return {
                  close: child.close,
                  async *[Symbol.asyncIterator]() {
                    for await (const frame of child) {
                      if (frame.type !== 'item') throw unknown();
                      yield frame;
                    }
                  },
                };
              },
              streamPage(call, active) {
                const followId = call.followId;
                const follow = followId ? new AbortController() : undefined;
                const child = stream(
                  call,
                  follow ? AbortSignal.any([active, follow.signal]) : active,
                );
                if (followId && follow) follows.set(followId, follow);
                return {
                  revoked: follow?.signal,
                  send: child.send,
                  async *[Symbol.asyncIterator]() {
                    try {
                      let failure: DEntryPageNativeError['error'] | undefined;
                      for await (const frame of child) {
                        if (failure || frame.type === 'item') throw unknown();
                        if (frame.type === 'page-end') {
                          if (!follow) throw unknown();
                          break;
                        }
                        if (frame.type === 'page-error') {
                          failure = frame.error;
                          if (follow) break;
                        } else yield frame;
                      }
                      if (failure) throw failure;
                    } finally {
                      if (followId) follows.delete(followId);
                    }
                  },
                };
              },
              close: activity.close,
            } satisfies DEntryPrincipalControlScope;
          });
          void running.catch(() => {});
          void running.then(
            () => {},
            () => {
              business.removeEventListener('abort', cancelled);
            },
          );
          return running;
        },
        close(): Promise<void> {
          if (joined) return joined;
          joined = Promise.resolve().then(async () => {
            // A run queued but not dispatched sees revoked before opening.
            if (!started) {
              await Promise.allSettled([running]);
              activities.delete(activity);
              return;
            }
            if (!relay) throw unknown();
            const results = await Promise.allSettled(
              [...children]
                .map((child) => child.close())
                .concat([relay.close()]),
            );
            while (operations.size) await Promise.allSettled([...operations]);
            await Promise.allSettled([running]);
            detachRun();
            const failures = results.flatMap((result) =>
              result.status === 'rejected' ? [result.reason] : [],
            );
            if (failures.length)
              throw unknown(
                new AggregateError(failures, 'PRINCIPAL_CHILD_JOIN_FAILED'),
              );
            activities.delete(activity);
          });
          revoked.abort();
          return joined;
        },
        async local() {
          revoked.abort();
          const results = await Promise.allSettled([
            ...[...children].map((child) => child.local()),
            relay?.local(),
          ]);
          while (operations.size) await Promise.allSettled([...operations]);
          await Promise.allSettled([running, joined]);
          detachRun();
          if (results.some((result) => result.status === 'rejected'))
            throw unknown();
        },
      };
      activities.add(activity);
      return activity;
    },
    fence(reason?: unknown) {
      stopped = true;
      shutdown.abort(reason);
      for (const activity of activities) activity.fence(reason);
    },
    close() {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled(
          [...activities].map((activity) => activity.close()),
        );
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length)
          throw unknown(
            new AggregateError(failures, 'PRINCIPAL_ACTIVITY_JOIN_FAILED'),
          );
      });
      control.fence();
      return closing;
    },
    async drainLocal() {
      control.fence();
      const results = await Promise.allSettled(
        [...activities].map((activity) => activity.local()),
      );
      if (results.some((result) => result.status === 'rejected'))
        throw unknown();
    },
    async retireAfterNativeStop() {
      await control.drainLocal();
      activities.clear();
    },
  };
  return control;
}
