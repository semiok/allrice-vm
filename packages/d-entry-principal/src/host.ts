import type { Context } from '@deepseek-ai/cordis';
import {
  Remote,
  TypertRemoteService,
  isTypertRemoteMethod,
  isRemoteJsonValue,
  remoteErrorOf,
  type PeerScope,
  type RemoteStream,
  type TypertDisposer,
  type TypertRemoteMethod,
} from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-api-gateway';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { TYPERT_REMOTE as Native } from '@deepseek-ai/dsh-api-session-controller/remote';
import { TYPERT_REMOTE as Access } from '@deepseek-ai/dsh-api-remote-access/remote';
import {
  REMOTE_EVENT_STREAM_ENDPOINT,
  REMOTE_EVENT_STREAM_PAYLOAD,
  isRemoteEventClientId,
  type RemoteEventClientId,
} from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { z } from 'zod';
import { TYPERT, TYPERT_REMOTE } from '#principal-artifacts';
import { DEntryPageLocaleSchema, UuidSchema } from '@allrice/contracts';
import { parseLocaleInvocation, projectLocaleResult } from './page-locale.js';
import {
  issueSchema,
  principalPolicy,
  projectSessions,
  writeEndpoints,
  type Projection,
} from './policy.js';
import type {
  CloseCommand,
  DEntryPrincipal,
  DEntryPrincipalIssue,
  DEntryScopedUnaryCall,
  DEntryScopedUnaryResult,
  DEntryScopedStreamCall,
  DEntryScopedStreamFrame,
  ScopeFrame,
} from './types.js';

const object = z.record(z.string(), z.unknown());
const configSchema = z
  .object({
    profile: z
      .object({
        workspaceId: UuidSchema,
        employeeInstanceId: UuidSchema,
        employeeRevision: z.number().int().positive(),
        employeeVersionId: UuidSchema,
      })
      .strict(),
    binding: z
      .object({
        organizationId: UuidSchema,
        personId: UuidSchema,
        vmId: z.string().min(1),
        instanceId: z.string().min(1),
        leaseEpoch: z.number().int().positive(),
      })
      .strict(),
    moduleBase: z.string().min(1),
  })
  .strict();
type HostConfig = z.infer<typeof configSchema>;
const endpoints = [
  'allricePrincipal/openScope',
  'allricePrincipal/invokeScoped',
  'allricePrincipal/streamScoped',
] as const;
type Reader =
  | TypertRemoteMethod<object, unknown>
  | TypertRemoteMethod<object, unknown, 'stream', unknown>;
const closed = () => Error('PRINCIPAL_SCOPE_CLOSED');
const empty = { async *[Symbol.asyncIterator]() {} };
function signalGate(signal: AbortSignal) {
  let release!: () => void;
  const done = new Promise<void>((yes) => {
    release = yes;
  });
  const abort = new AbortController();
  const stop = () => {
    abort.abort(closed());
    release();
  };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  return {
    abort,
    done,
    stop,
    detach: () => signal.removeEventListener('abort', stop),
  };
}
async function commands(input: AsyncIterator<CloseCommand>, stop: () => void) {
  const next = await input.next();
  if (!next.done && next.value !== 'close')
    throw Error('PRINCIPAL_CLOSE_INVALID');
  stop();
}
type ReadCompletion = { ok: true } | { ok: false; error: unknown };
type ReadWait = {
  outcome?: ReadCompletion;
  waiters: Set<(outcome: ReadCompletion) => void>;
};
const sharedReads = new WeakMap<Promise<void>, ReadWait>();
async function waitForRead(task: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let state = sharedReads.get(task);
  if (!state) {
    const next: ReadWait = { waiters: new Set() };
    sharedReads.set(task, next);
    const finish = (outcome: ReadCompletion) => {
      next.outcome = outcome;
      for (const listener of next.waiters) listener(outcome);
      next.waiters.clear();
    };
    void task.then(
      () => finish({ ok: true }),
      (error) => finish({ ok: false, error }),
    );
    state = next;
  }
  const holding = state;
  const outcome =
    holding.outcome ??
    (await new Promise<ReadCompletion>((resolve, reject) => {
      const receive = (result: ReadCompletion) => {
        signal.removeEventListener('abort', cancel);
        resolve(result);
      };
      const cancel = () => {
        holding.waiters.delete(receive);
        signal.removeEventListener('abort', cancel);
        reject(signal.reason);
      };
      holding.waiters.add(receive);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    }));
  if (!outcome.ok) throw outcome.error;
  signal.throwIfAborted();
}
function assertContribution(
  value: unknown,
): asserts value is TypertContribution {
  // Registry.register performs its own complete atomic validation next. Never
  // invent a descriptor or use source discovery if this artifact is absent.
  const header = z
    .object({
      package: z.literal('@allrice/d-entry-principal'),
      face: z.literal('host'),
      schemas: z.array(z.unknown()),
      model: object,
      invocations: z.array(object),
    })
    .parse(value);
  if (
    header.invocations.length !== 3 ||
    header.invocations.some(
      (row) =>
        !new Set<string>(endpoints).has(
          `${String(row.namespace)}/${String(row.method)}`,
        ),
    )
  )
    throw Error('PRINCIPAL_METADATA_INVALID');
}
class Scope implements Projection {
  active = false;
  bindings: Projection['bindings'] = [];
  peer?: PeerScope;
  readonly abort = new AbortController();
  readonly jobs = new Set<Promise<unknown>>();
  readonly children = new Set<{ close(): Promise<void> }>();
  readonly ready: Promise<void>;
  private closing?: Promise<void>;
  private detach = () => {};
  private unregister?: TypertDisposer;
  private readonly catalogQueue = new Set<() => void>();
  private catalogReading?: Promise<void>;
  private refreshQueue = Promise.resolve();
  private refreshGeneration = 0;
  constructor(
    readonly host: PrincipalService,
    private readonly ctx: Context,
    readonly parent: PeerScope,
    readonly issue: DEntryPrincipalIssue,
  ) {
    // Public Host services use the constructor's owning Context. The Peer
    // Context below continues to own every scope registration and its join.
    // Registration precedes any async setup. Child Peer belongs to the exact
    // parent Context, never its own disposer or the global plugin Context.
    this.unregister = parent.ctx.effect(
      () => () => this.close(),
      'allrice principal scope',
    );
    const lost = () => {
      void this.close().catch(() => {});
    };
    parent.signal.addEventListener('abort', lost, { once: true });
    const hint = () => {
      if (this.abort.signal.aborted) return;
      void this.refresh().catch(lost);
    };
    const added = parent.ctx.on('api-session/added', hint);
    const removed = parent.ctx.on('api-session/removed', hint);
    this.detach = () => {
      parent.signal.removeEventListener('abort', lost);
      added();
      removed();
    };
    this.ready = Promise.resolve().then(async () => {
      this.abort.signal.throwIfAborted();
      const principal: DEntryPrincipal = Object.freeze({
        kind: 'allrice-d-entry',
        scopeId: issue.scopeId,
        identity: Object.freeze({ ...issue.identity }),
      });
      this.peer = parent.ctx.connection.createPeer({
        principal,
        interactions: 'answer',
      });
      await this.refresh();
    });
    void this.ready.catch(() => {});
    if (parent.signal.aborted) lost();
  }
  own<T>(work: () => Promise<T>): Promise<T> {
    if (this.abort.signal.aborted)
      return Promise.reject(this.abort.signal.reason);
    return this.track(
      Promise.resolve().then(() => {
        this.abort.signal.throwIfAborted();
        return work();
      }),
    );
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.jobs.add(task);
    void task.then(
      () => this.jobs.delete(task),
      () => this.jobs.delete(task),
    );
    return task;
  }
  currentPeer() {
    const peer = this.peer;
    if (!peer || this.abort.signal.aborted) throw closed();
    return peer;
  }
  private readInOrder(signal: AbortSignal, read: () => Promise<void>) {
    return new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const cancel = () => {
        signal.removeEventListener('abort', cancel);
        this.catalogQueue.delete(start);
        reject(signal.reason);
      };
      const start = () => {
        this.catalogQueue.delete(start);
        signal.removeEventListener('abort', cancel);
        const work = Promise.resolve().then(read);
        this.catalogReading = work;
        void work.then(resolve, reject).finally(() => {
          this.catalogReading = undefined;
          this.catalogQueue.values().next().value?.();
        });
      };
      if (this.catalogReading) {
        this.catalogQueue.add(start);
        signal.addEventListener('abort', cancel, { once: true });
      } else start();
    });
  }
  joinActiveRead() {
    return this.catalogReading;
  }
  refresh(signal = this.abort.signal) {
    const pageRefresh = signal === this.abort.signal;
    if (pageRefresh) {
      this.refreshGeneration++;
      this.publish([]);
    }
    const generation = this.refreshGeneration;
    const task = this.readInOrder(signal, async () => {
      signal.throwIfAborted();
      try {
        const catalog = await this.ctx.sessionController.list({}, signal);
        signal.throwIfAborted();
        const bindings = projectSessions(this.issue, catalog.items);
        // A newer page-level read or hint owns the projection once it fences
        // this generation. A cancelled follower owns only its catalog read.
        if (generation === this.refreshGeneration) {
          this.refreshQueue = task;
          this.publish(bindings);
        }
      } catch (error) {
        if (!signal.aborted && generation === this.refreshGeneration) {
          this.refreshQueue = task;
          this.publish([]);
        }
        throw error;
      }
    });
    if (pageRefresh) this.refreshQueue = task;
    return this.track(task);
  }
  private publish(bindings: Projection['bindings']) {
    this.bindings = bindings;
    this.active = bindings.length > 0;
    this.ctx.remoteAccess.invalidate();
  }
  async current<T>(
    dispatch: () => Promise<T>,
    signal = this.abort.signal,
  ): Promise<T> {
    await waitForRead(this.ready, signal);
    while (true) {
      const pending = this.refreshQueue;
      await waitForRead(pending, signal);
      if (pending !== this.refreshQueue) continue;
      if (!this.active) throw closed();
      // No await between the stable projection and the native guard/dispatch.
      // Hints extend the same owned read chain; they never grant from payload.
      return dispatch();
    }
  }
  async readCatalog<T>(read: () => Promise<T>, signal: AbortSignal) {
    await this.refresh(signal);
    while (true) {
      const { cut, value } = await this.current(async () => {
        const cut = this.refreshQueue;
        return { cut, value: await read() };
      }, signal);
      signal.throwIfAborted();
      // The native list filters after I/O. A concurrent hint can temporarily
      // remove permissions mid-read and return an incomplete, successful list.
      if (cut === this.refreshQueue) return value;
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      await Promise.allSettled([this.ready]);
      const children = await Promise.allSettled(
        [...this.children].map((child) => child.close()),
      );
      while (this.jobs.size) await Promise.allSettled([...this.jobs]);
      const peer = await Promise.allSettled([this.peer?.dispose()]);
      if ([...children, ...peer].some((result) => result.status === 'rejected'))
        throw Error('PRINCIPAL_JOIN_UNKNOWN');
      this.detach();
      this.host.scopes.delete(this.issue.scopeId);
      // The registration waits this very close; withdrawing it must not await
      // itself. It owns no additional I/O beyond the resources joined above.
      void this.unregister?.().catch(() => {});
    });
    this.active = false;
    this.bindings = [];
    this.abort.abort(closed());
    this.ctx.remoteAccess.invalidate();
    return this.closing;
  }
}

/** Actual guest service; only the trusted Node API Peer can issue a scope.
 * The public Host face is the Cordis plugin, not a constructor for consumers. */
class PrincipalService extends TypertRemoteService {
  static inject = [
    'connection',
    'remoteAccess',
    'typertGateway',
    'typert',
    'sessionController',
  ];
  readonly scopes = new Map<string, Scope>();
  private readonly scopeControls = new Set<Promise<void>>();
  private stopped = false;
  private graphObserver?: {
    ready: boolean;
    current(): boolean;
    close(): Promise<void>;
  };
  private graphRetirement = Promise.resolve();
  constructor(
    private readonly hostContext: Context,
    private readonly config: HostConfig & {
      readers: ReadonlyMap<string, Reader>;
    },
  ) {
    super(hostContext, 'allricePrincipal');
    hostContext.remoteAccess.registerPolicy(
      'allrice-d-entry',
      principalPolicy(this.scopes),
    );
    hostContext.effect(() => async () => {
      this.stopped = true;
      if (this.graphObserver) await this.graphObserver.close();
      else await this.graphRetirement;
    });
  }
  private closeScopes() {
    return Promise.allSettled([
      ...this.scopeControls,
      ...[...this.scopes.values()].map((scope) => scope.close()),
    ]).then((results) => {
      const failures = new Set(
        results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        ),
      );
      if (failures.size === 1) throw failures.values().next().value;
      if (failures.size)
        throw new AggregateError(failures, 'PRINCIPAL_JOIN_UNKNOWN');
    });
  }
  /** Internal Cordis consumer of the installed native graph revision. The
   * existing private stream reports withdrawal before any scope join. */
  observeProfileGraph(
    source: {
      graph(): { rev: string };
      onGraphChanged(listener: () => void): () => void;
    },
    owner?: {
      current(): boolean;
      publish(): Promise<void>;
      retire(): Promise<void>;
    },
  ) {
    if (this.stopped || this.graphObserver) throw closed();
    let retiring: Promise<void> | undefined;
    const graphClosures = new Set<Promise<void>>();
    const observer = {
      ready: false,
      current: () => owner?.current() ?? true,
      close: () => {
        if (retiring) return retiring;
        observer.ready = false;
        this.graphObserver = undefined;
        const previous = this.graphRetirement;
        const closingGraph = [...graphClosures];
        retiring = this.graphRetirement = Promise.resolve().then(async () => {
          const results = await Promise.allSettled([
            previous,
            ...closingGraph,
            closedScopes,
            Promise.resolve().then(() => unsubscribe()),
            Promise.resolve().then(() => owner?.retire()),
          ]);
          const failures = new Set(
            results.flatMap((result) =>
              result.status === 'rejected' ? [result.reason] : [],
            ),
          );
          if (failures.size === 1) throw failures.values().next().value;
          if (failures.size)
            throw new AggregateError(failures, 'PRINCIPAL_JOIN_UNKNOWN');
        });
        // Fence each scope now, including scopes still performing their
        // initial lookup. The retired owner's effect joins the actual reads.
        const closedScopes = this.closeScopes();
        return retiring;
      },
    };
    const unsubscribe = source.onGraphChanged(() => {
      if (this.graphObserver !== observer || !observer.ready) return;
      if (!observer.current()) {
        void observer.close().catch(() => {});
        return;
      }
      const fenced = this.closeScopes();
      graphClosures.add(fenced);
      void fenced.then(
        () => graphClosures.delete(fenced),
        () => {
          void observer.close().catch(() => {});
          graphClosures.delete(fenced);
        },
      );
    });
    this.graphObserver = observer;
    const assertObserver = () => {
      if (
        this.stopped ||
        this.graphObserver !== observer ||
        !observer.current() ||
        !source.graph().rev
      )
        throw closed();
    };
    const ready = this.graphRetirement.then(async () => {
      // The subscription is already listening; the snapshot taken here sees
      // changes between the previous unsubscribe and this registration.
      assertObserver();
      await owner?.publish();
      assertObserver();
      observer.ready = true;
    });
    return { ready, close: observer.close };
  }
  private raw(endpoint: (typeof endpoints)[number]) {
    if (this.stopped) throw closed();
    const invocation = this.ctx.invocation;
    if (
      !invocation ||
      invocation.peer.principal.kind !== 'owner' ||
      invocation.peer.interactions !== 'none' ||
      invocation.peer.signal.aborted
    )
      throw Error('PRINCIPAL_PARENT_INVALID');
    const reader = this.config.readers.get(endpoint);
    if (!reader) throw Error('PRINCIPAL_METADATA_INVALID');
    return {
      args: object.parse(
        reader.input({ strict: true }).create().parse(invocation.request.args),
      ),
      invocation,
    };
  }
  private scope(id: string, parent: PeerScope) {
    const scope = this.scopes.get(UuidSchema.parse(id));
    if (!scope || scope.parent !== parent || scope.abort.signal.aborted)
      throw closed();
    return scope;
  }
  @Remote({ mode: 'stream' })
  async *openScope(
    issue: DEntryPrincipalIssue,
    signal: AbortSignal,
  ): RemoteStream<ScopeFrame, CloseCommand> {
    const { args, invocation } = this.raw('allricePrincipal/openScope');
    issue = issueSchema.parse(args.issue);
    const { profile, binding } = this.config;
    if (
      !issue.identity.threadId ||
      issue.identity.organizationId !== binding.organizationId ||
      issue.identity.personId !== binding.personId ||
      Object.keys(profile).some(
        (key) => Reflect.get(issue.identity, key) !== Reflect.get(profile, key),
      ) ||
      this.scopes.has(issue.scopeId)
    )
      throw Error('PRINCIPAL_ISSUE_INVALID');
    const observer = this.graphObserver;
    const observerCurrent = observer?.current();
    if (!observer?.ready || !observerCurrent) {
      if (observer && !observerCurrent) void observer.close().catch(() => {});
      // The authenticated issue has not created a scope or opened a native
      // reader. Close its private stream with the ordinary pre-open terminal.
      yield { type: 'closed', scopeId: issue.scopeId };
      return;
    }
    const scope = new Scope(
      this,
      this.hostContext,
      invocation.peer,
      Object.freeze({
        ...issue,
        identity: Object.freeze({ ...issue.identity }),
        root: Object.freeze({ ...issue.root }),
      }),
    );
    this.scopes.set(issue.scopeId, scope);
    let confirmTerminal!: () => void;
    let failTerminal!: (error: unknown) => void;
    const terminal = new Promise<void>((resolve, reject) => {
      confirmTerminal = resolve;
      failTerminal = reject;
    });
    this.scopeControls.add(terminal);
    void terminal.catch(() => {});
    const gate = signalGate(signal);
    let withdrawn = false;
    let opened = false;
    const withdraw = () => {
      withdrawn = !gate.abort.signal.aborted;
      gate.stop();
    };
    scope.abort.signal.addEventListener('abort', withdraw, { once: true });
    if (scope.abort.signal.aborted) withdraw();
    const input = invocation.uplink<CloseCommand>()[Symbol.asyncIterator]();
    const pump = commands(input, gate.stop).catch((error) => {
      gate.stop();
      throw error;
    });
    void pump.catch(() => {});
    void gate.done.then(() => scope.close()).catch(() => {});
    let cleanup: Promise<void> | undefined;
    const join = () =>
      (cleanup ??= Promise.resolve().then(async () => {
        gate.stop();
        try {
          const results = await Promise.allSettled([
            scope.close(),
            Promise.resolve().then(() => input.return?.()),
          ]);
          const commands = await Promise.allSettled([pump]);
          const failures = [...results, ...commands].flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          );
          if (failures.length === 1) throw failures[0];
          if (failures.length)
            throw new AggregateError(failures, 'PRINCIPAL_JOIN_UNKNOWN');
        } finally {
          gate.detach();
          scope.abort.signal.removeEventListener('abort', withdraw);
        }
      }));
    let failed = false;
    let failureReason: unknown;
    let closedDelivered = false;
    try {
      try {
        await scope.ready;
      } catch (error) {
        const failure = remoteErrorOf(error);
        if (
          !scope.abort.signal.aborted ||
          (error !== scope.abort.signal.reason &&
            (failure?.code !== 'gateway/cancelled' ||
              failure.cause !== scope.abort.signal.reason))
        )
          throw error;
      }
      if (!gate.abort.signal.aborted) {
        const peer = scope.peer;
        if (!peer || peer.principal.kind !== 'allrice-d-entry') throw closed();
        const baseline = this.ctx.remoteAccess.snapshotFor(peer.principal);
        if (baseline.owner) throw Error('PRINCIPAL_OWNER_BASELINE');
        opened = true;
        yield {
          type: 'opened',
          scopeId: issue.scopeId,
          principal: peer.principal,
          baseline,
        };
      }
      await gate.done;
      if (opened && withdrawn && !signal.aborted)
        yield { type: 'revoked', scopeId: issue.scopeId };
      await join();
      yield { type: 'closed', scopeId: issue.scopeId };
      // The native mux pulls again only after writing this closed item.
      // Awaiting the control here would make the generator join itself.
      closedDelivered = true;
    } catch (error) {
      failed = true;
      failureReason = error;
      throw error;
    } finally {
      await (failed ? join().catch(() => {}) : join())
        .then(
          () => {
            if (failed) failTerminal(failureReason);
            else if (closedDelivered && !signal.aborted) confirmTerminal();
            else failTerminal(signal.reason ?? Error('PRINCIPAL_JOIN_UNKNOWN'));
          },
          (error) => {
            failTerminal(error);
            throw error;
          },
        )
        .finally(() => this.scopeControls.delete(terminal));
    }
  }
  private async native<T>(
    scope: Scope,
    endpoint: string,
    args: Record<string, unknown>,
    dispatch: () => Promise<T>,
    signal = scope.abort.signal,
  ) {
    await scope.refresh(signal);
    const request = object.parse(args.request);
    const address =
      request.address === undefined ? undefined : object.parse(request.address);
    const sessionId = z
      .string()
      .min(1)
      .parse(
        address
          ? address.kind === 'session'
            ? address.sessionId
            : address.childSessionId
          : request.sessionId,
      );
    const catalog = await this.ctx.sessionController.list({}, signal);
    return scope.current(() => {
      const item = catalog.items.find(
        (row) => String(row.sessionId) === sessionId,
      );
      if (
        !item ||
        !scope.bindings.some(
          (row) =>
            row.resource.kind === 'session' &&
            String(row.resource.id) === sessionId,
        )
      )
        throw Error('PRINCIPAL_RESOURCE_DENIED');
      if (
        address?.kind === 'subagent' &&
        String(item.parentSessionId) !== address.parentSessionId
      )
        throw Error('PRINCIPAL_PARENT_DENIED');
      if (
        writeEndpoints.some((key) => key === endpoint) &&
        (scope.issue.access !== 'execute' ||
          sessionId !== scope.issue.root.nativeSessionId ||
          item.parentSessionId)
      )
        throw Error('PRINCIPAL_WRITE_DENIED');
      return dispatch();
    }, signal);
  }
  @Remote
  async invokeScoped(
    call: DEntryScopedUnaryCall,
    signal: AbortSignal,
  ): Promise<DEntryScopedUnaryResult> {
    const { args: input, invocation } = this.raw(
      'allricePrincipal/invokeScoped',
    );
    const raw = object.parse(input.call);
    const locale = DEntryPageLocaleSchema.safeParse(raw.endpoint);
    if (locale.success) {
      const scope = this.scope(z.string().parse(raw.scopeId), invocation.peer);
      const method =
        locale.data === 'settings/describe' ? 'describe' : 'mutate';
      if (method === 'mutate' && scope.issue.access !== 'execute')
        throw Error('PRINCIPAL_WRITE_DENIED');
      const args = parseLocaleInvocation(method, raw.args);
      return scope.own(async () => {
        const active = AbortSignal.any([signal, scope.abort.signal]);
        return scope.current(async () => {
          active.throwIfAborted();
          const descriptor = this.ctx.typert.local.get(locale.data);
          if (
            descriptor?.id !==
              `@deepseek-ai/dsh-api-settings-controller#${locale.data}` ||
            descriptor.result.mode !== 'strict'
          )
            throw Error('PRINCIPAL_ENDPOINT_DENIED');
          const output = await this.ctx.typertGateway.invoke({
            namespace: 'settings',
            method,
            args,
            peer: scope.parent,
            signal: active,
          });
          active.throwIfAborted();
          return {
            endpoint: locale.data,
            value: projectLocaleResult(
              method,
              descriptor.result.create().parse(output),
            ),
          };
        }, active);
      });
    }
    const key = z
      .enum([
        'session/list',
        'session/attachment',
        'session/page',
        'session/projections',
        'skills/list',
        ...writeEndpoints,
      ])
      .parse(raw.endpoint);
    const args = object.parse(
      Native.methods[key].input({ strict: true }).create().parse(raw.args),
    );
    const scope = this.scope(z.string().parse(raw.scopeId), invocation.peer);
    return scope.own(async () => {
      const active = AbortSignal.any([signal, scope.abort.signal]);
      active.throwIfAborted();
      const dispatch = () => {
        active.throwIfAborted();
        const slash = key.indexOf('/');
        return this.ctx.typertGateway.invoke({
          namespace: key.slice(0, slash),
          method: key.slice(slash + 1),
          args,
          peer: scope.currentPeer(),
          signal: active,
        });
      };
      // rc.2 filters the catalog through RemoteAccess for this non-owner peer.
      const value = await (key === 'session/list'
        ? scope.readCatalog(dispatch, active)
        : this.native(scope, key, args, dispatch));
      active.throwIfAborted();
      // Literal branches retain the source descriptor/result relationship.
      switch (key) {
        case 'session/list':
          return {
            endpoint: key,
            value: Native.methods[key].result.create().parse(value),
          };
        case 'session/attachment':
          return {
            endpoint: key,
            value: Native.methods[key].result.create().parse(value),
          };
        case 'session/page':
          return {
            endpoint: key,
            value: Native.methods[key].result.create().parse(value),
          };
        case 'session/projections':
          return {
            endpoint: key,
            value: Native.methods[key].result.create().parse(value),
          };
        case 'skills/list':
          return {
            endpoint: key,
            value: Native.methods[key].result.create().parse(value),
          };
        case 'session/prompt':
          return {
            endpoint: key,
            value: Native.methods[key].result.create().parse(value),
          };
        case 'session/updateQueue':
          return {
            endpoint: key,
            value: Native.methods[key].result.create().parse(value),
          };
        case 'session/cancel':
          return {
            endpoint: key,
            value: Native.methods[key].result.create().parse(value),
          };
        case 'session/rename':
          return {
            endpoint: key,
            value: Native.methods[key].result.create().parse(value),
          };
        case 'session/selectModel':
          return {
            endpoint: key,
            value: Native.methods[key].result.create().parse(value),
          };
      }
    });
  }
  @Remote({ mode: 'stream' })
  async *streamScoped(
    call: DEntryScopedStreamCall,
    signal: AbortSignal,
  ): RemoteStream<DEntryScopedStreamFrame, CloseCommand> {
    const { args, invocation } = this.raw('allricePrincipal/streamScoped');
    const raw = object.parse(args.call);
    const scope = this.scope(z.string().parse(raw.scopeId), invocation.peer);
    const gate = signalGate(signal);
    const input = invocation.uplink<CloseCommand>()[Symbol.asyncIterator]();
    const pump = commands(input, gate.stop);
    void pump.catch(() => gate.stop());
    let iterator: AsyncIterator<unknown> | undefined,
      pending: Promise<IteratorResult<unknown>> | undefined;
    let closing: Promise<void> | undefined;
    let eventReady = false;
    const events = raw.kind === 'events';
    const active = AbortSignal.any([scope.abort.signal, gate.abort.signal]);
    const setup = scope.own(async () => {
      active.throwIfAborted();
      let nativeArgs: Record<string, unknown> | undefined;
      if (events)
        z.object({ args: z.object({}).strict() })
          .strict()
          .parse(raw.payload);
      else if (raw.endpoint === 'remoteAccess/follow')
        Access.methods['remoteAccess/follow']
          .input({ strict: true })
          .create()
          .parse(raw.args);
      else if (raw.endpoint === 'session/control')
        Native.methods['session/control']
          .input({ strict: true })
          .create()
          .parse(raw.args);
      else {
        if (raw.endpoint !== 'session/follow')
          throw Error('PRINCIPAL_ENDPOINT_DENIED');
        nativeArgs = object.parse(
          Native.methods['session/follow']
            .input({ strict: true })
            .create()
            .parse(raw.args),
        );
      }
      const endpoint = events
        ? REMOTE_EVENT_STREAM_ENDPOINT
        : z.string().parse(raw.endpoint);
      if (
        endpoint === 'remoteAccess/follow' ||
        endpoint === 'session/control'
      ) {
        // The new stream's baseline is a current catalog read even when the
        // native change hint for a withdrawn child has not arrived yet.
        await scope.refresh(active);
      }
      const payload = events ? REMOTE_EVENT_STREAM_PAYLOAD : { args: raw.args };
      const open = () => {
        active.throwIfAborted();
        return this.ctx.typertGateway.wireStream.open(
          endpoint,
          payload,
          empty,
          scope.currentPeer(),
          active,
        );
      };
      const values = nativeArgs
        ? await this.native(scope, 'session/follow', nativeArgs, open, active)
        : await scope.current(open, active);
      iterator = values[Symbol.asyncIterator]();
    });
    const child = {
      close: () => {
        if (closing) return closing;
        closing = Promise.resolve().then(async () => {
          await Promise.allSettled([
            setup,
            pending,
            scope.abort.signal.aborted ? scope.joinActiveRead() : undefined,
          ]);
          const returns = await Promise.allSettled([
            Promise.resolve().then(async () => {
              await iterator?.return?.();
            }),
            Promise.resolve().then(async () => {
              await input.return?.();
            }),
          ]);
          const pumped = await Promise.allSettled([pump]);
          const failures = [...returns, ...pumped].flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          );
          if (failures.length)
            throw new AggregateError(failures, 'PRINCIPAL_JOIN_UNKNOWN');
          scope.children.delete(child);
        });
        gate.stop();
        return closing;
      },
    };
    scope.children.add(child);
    let failed = false;
    try {
      try {
        await setup;
      } catch (error) {
        const failure = remoteErrorOf(error);
        const ownAbort =
          (gate.abort.signal.aborted && error === gate.abort.signal.reason) ||
          (scope.abort.signal.aborted && error === scope.abort.signal.reason);
        const nativeCancel =
          failure?.code === 'gateway/cancelled' &&
          failure.cause === active.reason;
        // Setup still joins the actual read. Only this child/page's exact
        // mechanical cancellation may continue to the same close memo/ACK.
        if (signal.aborted || !active.aborted || (!ownAbort && !nativeCancel))
          throw error;
      }
      while (!active.aborted) {
        if (!iterator) throw closed();
        pending = Promise.resolve(iterator.next());
        let next: IteratorResult<unknown>;
        try {
          next = await pending;
        } catch (error) {
          const failure = remoteErrorOf(error);
          // Only the native Gateway cancellation caused by our own close is
          // mechanical. Its in-process cause is the exact signal reason.
          if (
            (gate.abort.signal.aborted || scope.abort.signal.aborted) &&
            !signal.aborted &&
            failure?.code === 'gateway/cancelled' &&
            failure.cause === active.reason
          )
            break;
          throw error;
        }
        if (next.done) break;
        if (gate.abort.signal.aborted || scope.abort.signal.aborted) break;
        let value: Extract<DEntryScopedStreamFrame, { type: 'item' }>['value'];
        if (events) {
          const ready = z
            .object({
              type: z.literal('ready'),
              clientId: z.custom<RemoteEventClientId>(isRemoteEventClientId),
              host: z.object({ home: z.string() }).strict(),
            })
            .strict();
          const frame = z
            .union([
              ready,
              z
                .object({
                  type: z.literal('emit'),
                  event: z.string().min(1),
                  args: z.custom<readonly JsonValue[]>(
                    (value) => Array.isArray(value) && isRemoteJsonValue(value),
                  ),
                })
                .strict(),
            ])
            .parse(next.value);
          if (eventReady ? frame.type === 'ready' : frame.type !== 'ready')
            throw Error('PRINCIPAL_EVENT_GENERATION_INVALID');
          eventReady = true;
          if (
            frame.type === 'emit' &&
            frame.event === 'settings/document-updated' &&
            frame.args[0] !== 'locale'
          )
            continue;
          value = frame;
        } else if (raw.endpoint === 'remoteAccess/follow')
          value = Access.methods['remoteAccess/follow'].result
            .create()
            .parse(next.value);
        else if (raw.endpoint === 'session/control')
          value = Native.methods['session/control'].result
            .create()
            .parse(next.value);
        else
          value = Native.methods['session/follow'].result
            .create()
            .parse(next.value);
        yield { type: 'item', scopeId: scope.issue.scopeId, value };
      }
      await child.close();
      yield { type: 'closed', scopeId: scope.issue.scopeId };
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await (failed ? child.close().catch(() => {}) : child.close());
      } finally {
        gate.detach();
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    allricePrincipal: PrincipalService;
  }
}
export const name = 'allrice-current-principal';
export const inject = PrincipalService.inject;
export async function apply(ctx: Context, raw: unknown): Promise<void> {
  const config = configSchema.parse(raw);
  const contribution = TYPERT;
  assertContribution(contribution);
  const readers = new Map<string, Reader>();
  for (const endpoint of endpoints) {
    const method = TYPERT_REMOTE.methods[endpoint];
    if (!method || !isTypertRemoteMethod(method))
      throw Error('PRINCIPAL_METADATA_INVALID');
    readers.set(endpoint, method);
  }
  let metadata: TypertDisposer | undefined;
  let fiber: ReturnType<Context['plugin']> | undefined;
  try {
    metadata = ctx.typert.register(contribution);
    fiber = ctx.plugin(PrincipalService, { ...config, readers });
    await fiber;
    for (const endpoint of endpoints) {
      const local = ctx.typert.local.get(endpoint);
      if (
        !local ||
        local.parameters.some((p) => p.codec.mode !== 'strict') ||
        (endpoint !== 'allricePrincipal/invokeScoped' && !local.uplink)
      )
        throw Error('PRINCIPAL_METADATA_INVALID');
    }
  } catch (error) {
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => fiber?.dispose()),
    ]);
    const withdrawn = await Promise.allSettled([
      Promise.resolve().then(() => metadata?.()),
    ]);
    const failures = [...stopped, ...withdrawn].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        'PRINCIPAL_INSTALL_JOIN_UNKNOWN',
      );
    throw error;
  }
}
