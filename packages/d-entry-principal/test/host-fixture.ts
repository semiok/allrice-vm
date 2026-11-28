import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  CredentialProvider,
  type CredentialKey,
  type CredentialRecord,
} from '@deepseek-ai/dsh-credentials';
import * as HostConnection from '@deepseek-ai/dsh-client-connection';
import {
  installConnection,
  type ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client';
import TypertRegistry, {
  type TypertContribution,
} from '@deepseek-ai/dsh-typert-registry';
import RemoteAccess, {
  type RemoteAccessService,
} from '@deepseek-ai/dsh-api-remote-access';
import { TYPERT as AccessMetadata } from '@deepseek-ai/dsh-api-remote-access/typert';
import Gateway, {
  type TypertRemoteEventDispatch,
} from '@deepseek-ai/dsh-api-gateway';
import * as GatewayClient from '@deepseek-ai/dsh-api-gateway/client';
import * as NativeRemoteEvents from '@deepseek-ai/dsh-api-remotes';
import {
  Remote,
  RemoteError,
  TypertRemoteService,
  type PeerScope,
} from '@deepseek-ai/dsh-typert-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {
  SessionFollowFrame,
  SessionFollowRequest,
  SessionControlFrame,
  SessionProjectionsRequest,
  SessionProjectionsValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionPage,
  SessionPageRequest,
  SessionPromptRequest,
  SessionCreateRequest,
  SessionForkRequest,
  SessionSearchRequest,
  SessionSelectModelRequest,
  SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/types';
import { TYPERT as NativeMetadata } from '@deepseek-ai/dsh-api-session-controller/typert';
import * as PrincipalHost from '@allrice/d-entry-principal/host';
import { TYPERT_REMOTE } from '@allrice/d-entry-principal/remote';
import type { DEntryPrincipalIssue } from '../src/types.js';

export function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function issue(
  access: 'history' | 'execute' = 'history',
): DEntryPrincipalIssue {
  return {
    scopeId: randomUUID(),
    access,
    identity: {
      organizationId: randomUUID(),
      personId: randomUUID(),
      workspaceId: randomUUID(),
      employeeInstanceId: randomUUID(),
      employeeRevision: 1,
      employeeVersionId: randomUUID(),
      threadId: randomUUID(),
    },
    root: {
      nativeSessionId: 'root',
      rootBindingRef: 'actual-sql-root-binding-fixture',
      rootOriginDigest: 'actual-sql-origin-fixture',
    },
  };
}
export function summary(id: string, parent?: string): SessionSummary {
  return {
    sessionId: SessionId(id),
    agentAvailable: false,
    updatedAt: 1,
    running: false,
    blank: false,
    ...(parent
      ? ({ parentSessionId: SessionId(parent), origin: 'subagent' } as const)
      : {}),
  };
}
function contribution(value: unknown): asserts value is TypertContribution {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof Reflect.get(value, 'package') !== 'string' ||
    Reflect.get(value, 'face') !== 'host' ||
    !Array.isArray(Reflect.get(value, 'schemas')) ||
    !Array.isArray(Reflect.get(value, 'invocations'))
  )
    throw Error('fixture generated metadata missing');
}
class Credentials extends CredentialProvider {
  private readonly records = new Map<CredentialKey, CredentialRecord>();
  override resolve() {
    return Promise.resolve(undefined);
  }
  override describe() {
    return Promise.resolve({ configured: false, writable: false });
  }
  override set(): Promise<void> {
    return Promise.reject(Error('fixture reference is read only'));
  }
  override unset(): Promise<void> {
    return Promise.reject(Error('fixture reference is read only'));
  }
  override readRecord(key: CredentialKey) {
    return Promise.resolve(this.records.get(key));
  }
  override describeRecord(key: CredentialKey) {
    const row = this.records.get(key);
    return Promise.resolve({
      configured: !!row,
      writable: true,
      ...(row ? { kind: row.kind } : {}),
    });
  }
  override listRecords() {
    return Promise.resolve(
      [...this.records].map(([key, row]) => ({ key, kind: row.kind })),
    );
  }
  override async modifyRecord(
    key: CredentialKey,
    mutate: (
      row: CredentialRecord | undefined,
    ) => Promise<CredentialRecord | undefined>,
  ) {
    const row = await mutate(this.records.get(key));
    if (row) this.records.set(key, row);
    return this.records.get(key);
  }
  override deleteRecord(key: CredentialKey) {
    this.records.delete(key);
    return Promise.resolve();
  }
}
/** Native catalog content is an explicit fixture. Peers, invocation scopes,
 * RemoteAccess snapshots/follow, event ready, codecs and carriers are real rc.2. */
class Catalog extends TypertRemoteService {
  static inject = ['remoteAccess'];
  items = [summary('root'), summary('child', 'root'), summary('other')];
  beforeList?: (signal: AbortSignal, scoped: boolean) => Promise<void>;
  beforeFollow?: () => Promise<void>;
  beforeCreate?: () => Promise<void>;
  allocateSessionId?: () => SessionId;
  onPrompt?: (request: SessionPromptRequest) => void;
  snapshotRecords?: (sessionId: SessionId) => SessionPage['records'];
  afterFollowSnapshot?: () => Promise<void>;
  followFrames?: (sessionId: SessionId) => AsyncIterable<SessionFollowFrame>;
  controlFrames?: (signal: AbortSignal) => AsyncIterable<SessionControlFrame>;
  readProjections?: (sessionId: SessionId) => SessionProjectionsValue;
  onRename?: (request: SessionRenameRequest) => SessionRenameValue;
  finishFollow?: SessionId;
  afterFollow?: () => Promise<void>;
  pageRecords: SessionPage['records'] = [];
  readonly pages: PeerScope[] = [];
  readonly follows: PeerScope[] = [];
  readonly creationRequests: SessionCreateRequest[] = [];
  constructor(ctx: Context) {
    super(ctx, 'sessionController', { namespace: 'session' });
  }
  private allows({ sessionId }: SessionSummary) {
    // This fixture runs the Host service even when typechecked in the Web
    // workspace, whose Cordis augmentation names the Client service instead.
    const access = this.ctx.remoteAccess as unknown as RemoteAccessService;
    return access.allows({ kind: 'session', id: sessionId });
  }
  @Remote('list')
  async list(_request: object, signal: AbortSignal) {
    await this.beforeList?.(
      signal,
      this.ctx.invocation?.peer.principal.kind === 'allrice-d-entry',
    );
    signal.throwIfAborted();
    return { items: this.items.filter((row) => this.allows(row)) };
  }
  @Remote('fixtureBytes')
  fixtureBytes() {
    return { result: [new Uint8Array([0, 128, 255])] };
  }
  @Remote('search')
  search(request: SessionSearchRequest) {
    return {
      items: this.items
        .filter((item) => item.sessionId.includes(request.query))
        .map((item) => ({
          sessionId: item.sessionId,
          snippet: 'matching session',
        })),
      hasMore: false,
    };
  }
  @Remote('create')
  async create(request: SessionCreateRequest) {
    this.creationRequests.push(request);
    await this.beforeCreate?.();
    const sessionId =
      request.sessionId ??
      this.allocateSessionId?.() ??
      SessionId('native-created');
    this.items.push(summary(sessionId));
    return { sessionId };
  }
  @Remote({
    name: 'prompt',
    resources: {
      session: (request: SessionPromptRequest) => request.sessionId,
    },
  })
  prompt(request: SessionPromptRequest) {
    if (!this.onPrompt)
      throw new RemoteError('session/not-found', 'No fixture agent', {
        sessionId: request.sessionId,
      });
    this.onPrompt(request);
    return { accepted: true as const };
  }
  @Remote('fork')
  fork(request: SessionForkRequest) {
    const sessionId = SessionId('native-forked');
    this.items.push({
      ...summary(sessionId),
      parentSessionId: request.sessionId,
    });
    return { sessionId };
  }
  @Remote('selectModel')
  selectModel({ sessionId, ...selected }: SessionSelectModelRequest) {
    if (
      !this.items.some((row) => row.sessionId === sessionId) ||
      selected.provider !== 'openai-codex' ||
      selected.model !== 'fixture-codex'
    )
      throw new RemoteError(
        'session/model-unavailable',
        'Unknown fixture model',
        selected,
      );
    return { selected };
  }
  @Remote({ mode: 'stream' })
  async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    signal.throwIfAborted();
    const projections = Object.fromEntries(
      this.items
        .filter((row) => this.allows(row))
        .map(({ sessionId }) => [sessionId, { asOfSeq: 0, values: {} }]),
    );
    yield { type: 'baseline', value: { projections } };
    if (this.controlFrames) {
      yield* this.controlFrames(signal);
      return;
    }
    await new Promise<void>((resolve) => {
      const stop = () => {
        signal.removeEventListener('abort', stop);
        resolve();
      };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    });
  }
  @Remote({
    name: 'projections',
    resources: {
      session: (request: SessionProjectionsRequest) => request.sessionId,
    },
  })
  projections({
    sessionId,
  }: SessionProjectionsRequest): SessionProjectionsValue {
    return this.readProjections?.(sessionId) ?? null;
  }
  @Remote({
    name: 'rename',
    resources: {
      session: (request: SessionRenameRequest) => request.sessionId,
    },
  })
  rename(request: SessionRenameRequest): SessionRenameValue {
    if (!this.onRename) throw Error('No fixture title writer');
    return this.onRename(request);
  }
  @Remote({
    name: 'page',
    resources: {
      session: (request: SessionPageRequest) =>
        request.address.kind === 'session'
          ? request.address.sessionId
          : request.address.childSessionId,
    },
  })
  page(request: SessionPageRequest): SessionPage {
    void request;
    const invocation = this.ctx.invocation;
    if (!invocation) throw Error('fixture native invocation missing');
    this.pages.push(invocation.peer);
    return { records: this.pageRecords, hasMore: false };
  }
  @Remote({
    mode: 'stream',
    resources: {
      session: (request: SessionFollowRequest) =>
        request.address.kind === 'session'
          ? request.address.sessionId
          : request.address.childSessionId,
    },
  })
  async *follow(
    request: SessionFollowRequest,
    signal: AbortSignal,
  ): AsyncIterable<SessionFollowFrame> {
    const invocation = this.ctx.invocation;
    if (!invocation) throw Error('fixture native invocation missing');
    this.follows.push(invocation.peer);
    const sessionId =
      request.address.kind === 'session'
        ? request.address.sessionId
        : request.address.childSessionId;
    try {
      await this.beforeFollow?.();
      signal.throwIfAborted();
      // Session content is fixture data; the descriptor, resource guard,
      // cancellableStream and codec are the actual public native path.
      const records = this.snapshotRecords?.(sessionId) ?? [];
      const cursor = records.at(-1)?.event.seq ?? -1;
      yield {
        type: 'snapshot',
        header: { version: 1, id: sessionId, createdAt: 1, isSeeded: false },
        cursor,
        records,
        hasMore: false,
        projections: {
          asOfSeq: cursor,
          values: this.readProjections?.(sessionId)?.values ?? {},
        },
        ...(request.assistantStream && { assistantStream: { revision: 0 } }),
      };
      await this.afterFollowSnapshot?.();
      if (this.followFrames) yield* this.followFrames(sessionId);
      if (sessionId === this.finishFollow) return;
      await new Promise<void>((resolve) => {
        const stop = () => {
          signal.removeEventListener('abort', stop);
          resolve();
        };
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      });
    } finally {
      await this.afterFollow?.();
    }
  }
}
const fixtureGraph = {
  graph: () => ({ rev: 'fixed-principal-test-graph' }),
  onGraphChanged: () => () => {},
};
export async function hostFixture(
  selected = issue(),
  install = true,
  profileGraph:
    | Parameters<Context['allricePrincipal']['observeProfileGraph']>[0]
    | null = fixtureGraph,
) {
  const host = new Context();
  await host.plugin(Credentials);
  await host.plugin(HostConnection);
  await host.plugin(TypertRegistry);
  contribution(AccessMetadata);
  contribution(NativeMetadata);
  host.typert.register(AccessMetadata);
  host.typert.register(NativeMetadata);
  host.typert.resources.register('session', { field: 'sessionId' });
  await host.plugin(RemoteAccess);
  await host.plugin(Gateway);
  await host.plugin(Catalog);
  const catalog = host.get('sessionController') as unknown as Catalog;
  const dispatched: TypertRemoteEventDispatch[] = [];
  let wake = () => {};
  const source = (
    signal: AbortSignal,
  ): AsyncIterable<TypertRemoteEventDispatch> => ({
    async *[Symbol.asyncIterator]() {
      const abort = () => wake();
      signal.addEventListener('abort', abort, { once: true });
      try {
        while (!signal.aborted) {
          const row = dispatched.shift();
          if (row) yield row;
          else
            await new Promise<void>((yes) => {
              wake = yes;
            });
        }
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  });
  const fixtureEvents = host.effect(() =>
    host.typertGateway.registerRemoteEvents(source, {
      home: '/home/native-fixture',
    }),
  );
  const config = {
    profile: {
      workspaceId: selected.identity.workspaceId,
      employeeInstanceId: selected.identity.employeeInstanceId,
      employeeRevision: selected.identity.employeeRevision,
      employeeVersionId: selected.identity.employeeVersionId,
    },
    binding: {
      organizationId: selected.identity.organizationId,
      personId: selected.identity.personId,
      vmId: 'vm-fixture',
      instanceId: 'instance-fixture',
      leaseEpoch: 1,
    },
    moduleBase: createRequire(import.meta.url).resolve(
      '@allrice/d-entry-principal/host',
    ),
  };
  if (install) {
    await host.plugin(PrincipalHost, config);
    if (profileGraph) {
      const observer = host.allricePrincipal.observeProfileGraph(profileGraph);
      host.effect(() => observer.close);
      await observer.ready;
    }
  }
  const parent = host.connection.createPeer({
    principal: { kind: 'owner' },
    interactions: 'none',
  });
  const node = new Context();
  await node.plugin(TypertRegistry);
  const fetch = host.connection.createSharedFetchHandler('/api');
  installConnection(node, {
    interactions: 'none',
    transport: {
      fetch(input, init) {
        return fetch.fetch(
          new Request(new URL(input, 'http://127.0.0.1'), init),
          parent,
        );
      },
      openStream(endpoint, payload, signal, uplink) {
        return {
          async *[Symbol.asyncIterator]() {
            yield* await host.typertGateway.wireStream.open(
              endpoint,
              payload,
              uplink ?? { async *[Symbol.asyncIterator]() {} },
              parent,
              signal,
            );
          },
        };
      },
    },
  });
  const wire = (node.connection as unknown as ConnectionHandle).rpc;
  await node.plugin(GatewayClient);
  await node.remote.$mount(TYPERT_REMOTE);
  return {
    host,
    node,
    parent,
    catalog,
    selected,
    config,
    wire,
    async useNativeEvents() {
      await fixtureEvents();
      await host.plugin(NativeRemoteEvents);
    },
    emit(row: TypertRemoteEventDispatch) {
      dispatched.push(row);
      wake();
    },
    async close() {
      await node.fiber.dispose();
      await host.fiber.dispose();
    },
  };
}

/** Observe real native next/return; never manufacture a baseline or terminal. */
export function observeNativeFollow(
  host: Context,
  endpoint: 'remoteAccess/follow' | 'session/follow',
) {
  const errors: unknown[] = [];
  const observed = {
    pending: deferred(),
    returned: deferred(),
    pendingSettled: false,
    returnJoined: false,
    errors,
  };
  const open = host.typertGateway.wireStream.open.bind(
    host.typertGateway.wireStream,
  );
  vi.spyOn(host.typertGateway.wireStream, 'open').mockImplementation(
    async (...args) => {
      const source = await open(...args);
      if (args[0] !== endpoint) return source;
      return {
        [Symbol.asyncIterator]() {
          const iterator = source[Symbol.asyncIterator]();
          let reads = 0;
          return {
            async next() {
              const read = ++reads,
                next = iterator.next();
              if (read === 2) observed.pending.resolve();
              try {
                return await next;
              } catch (error) {
                errors.push(error);
                throw error;
              } finally {
                if (read === 2) observed.pendingSettled = true;
              }
            },
            async return(): Promise<IteratorResult<unknown>> {
              const result = await iterator.return?.();
              observed.returnJoined = true;
              observed.returned.resolve();
              return result ?? { done: true, value: undefined };
            },
          };
        },
      };
    },
  );
  return observed;
}
