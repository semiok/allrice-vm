import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { on, once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, vi } from 'vitest';
import { WebSocket } from 'ws';
import type {
  registerDEntryPageNativeRoot,
  getDEntryPageNativeRoot,
} from '@allrice/database';
import {
  deferred,
  hostFixture,
  issue,
  summary,
} from '../../../../packages/d-entry-principal/test/host-fixture.js';
import { createDEntryNativeGateway } from '../../../web/server/d-entry-native.mjs';
import { nativeEntryFixture } from './native-entry.fixture.js';
import { createDEntryPrincipalControl } from './principal-control.js';
import { createDEntryPageRpc } from './principal-page-rpc.js';
import { createDEntryPageMux } from './principal-profile-mux.js';
import { createDEntryPageRequests } from './principal-requests.js';
import { createDEntryProfile } from './profile.js';
import {
  DEntryProfileGraphSchema,
  DEntrySelectionInputSchema,
} from '@allrice/contracts';

export const closes: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of closes.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  vi.unstubAllEnvs();
  if (failures.length)
    throw new AggregateError(failures, 'Fixture close failed');
});
export const sessionToken = 'original_session_token_for_page';
export const otherToken = 'different_session_of_same_person';

export type ProfileProof = {
  directory: string;
  graph: unknown;
  read(reference: string, signal: AbortSignal): Promise<Uint8Array>;
  beforeGraphRead?: (signal: AbortSignal) => Promise<void>;
};

export async function buildProfileFixture(): Promise<ProfileProof> {
  const parent = await mkdtemp(join(tmpdir(), 'allrice-profile-finite-'));
  closes.push(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, 'release');
  await promisify(execFile)(
    process.execPath,
    ['packages/dsh-web-composition/build-web-entry.mjs', directory],
    { timeout: 20_000 },
  );
  const raw = JSON.parse(
    await readFile(join(directory, 'artifact.json'), 'utf8'),
  );
  if (raw.source?.dirty !== false)
    throw Error('Profile fixture requires a clean release source checkout');
  return {
    directory,
    graph: DEntryProfileGraphSchema.parse(raw.profile.graph),
    read(reference, signal) {
      const file = raw.profile.files.find(
        (row: { reference: string }) => row.reference === reference,
      );
      if (!file) throw Error('Named release proof missing');
      return readFile(join(directory, file.path), { signal });
    },
  };
}

export async function fixture(
  release?: ProfileProof,
  newRoot = false,
  rootless = false,
  cleanupTimeoutMs = 3000,
) {
  const selected = issue('execute');
  const f = nativeEntryFixture();
  const host = await hostFixture({
    ...selected,
    identity: f.identity,
  });
  const roots = new Map([
    [f.selection.threadId, selected.root.nativeSessionId],
  ]);
  const otherEmployees = new Map<
    string,
    { identity: typeof f.identity; owner: typeof f.owner }
  >();
  const threadRevocations = new Map<string, AbortController>();
  const pageSelection = rootless
    ? {
        workspaceId: f.selection.workspaceId,
        employeeInstanceId: f.selection.employeeInstanceId,
      }
    : f.selection;
  const registerThread = (threadId: string) => {
    const id = 'root-' + threadId;
    roots.set(threadId, id);
    host.catalog.items.push(summary(id));
    const revoked = new AbortController();
    threadRevocations.set(threadId, revoked);
    return revoked;
  };
  const selectionIdentity = (value: unknown) => {
    const selection = DEntrySelectionInputSchema.parse(value);
    const threadId = selection.threadId;
    const other = threadId && otherEmployees.get(threadId);
    if (
      other &&
      other.identity.employeeInstanceId === selection.employeeInstanceId
    )
      return other.identity;
    return threadId && roots.has(threadId)
      ? { ...f.identity, threadId }
      : rootless
        ? { ...f.identity, threadId: null }
        : f.identity;
  };
  closes.push(() => host.close());
  const service = new AbortController();
  // Like native-web/owner, keep the guest cleanup transport alive when
  // Worker HTTP admission and its owned connections are stopped.
  const carrier = new AbortController();
  const control = createDEntryPrincipalControl(host.node, {
    carrier: carrier.signal,
    cleanupTimeoutMs,
  });
  let controlCloseChecked = false;
  closes.push(async () => {
    try {
      await (controlCloseChecked ? control.drainLocal() : control.close());
    } finally {
      carrier.abort();
    }
  });
  const profileObserved = vi.fn<(part: 'item' | 'terminal') => void>();
  vi.mocked(f.owner.acquirePrincipal).mockImplementation((_, input, active) => {
    const activity = control.acquire(input, active);
    return {
      ...activity,
      async run(signal) {
        const scope = await activity.run(signal);
        return {
          ...scope,
          stream(call, caller, observer) {
            return scope.stream(
              call,
              caller,
              observer && {
                item(frame) {
                  observer.item(frame);
                  profileObserved('item');
                },
                terminal() {
                  observer.terminal();
                  profileObserved('terminal');
                },
              },
            );
          },
        };
      },
    };
  });
  vi.mocked(f.owner.readSessions).mockImplementation(async () => ({
    ok: true,
    value: { items: host.catalog.items },
  }));
  f.root.mockImplementation(async () => ({
    identity: f.identity,
    rootNativeSessionId: selected.root.nativeSessionId,
    rootOriginDigest: selected.root.rootOriginDigest,
    rootBindingRef: selected.root.rootBindingRef,
    vmId: f.binding.vmId,
  }));
  const profileSource = new AbortController();
  if (release)
    f.deps.owners.resolve.mockResolvedValue({
      ...f.owner,
      fixedProfile: {
        revoked: profileSource.signal,
        async readImmutableGraph(signal) {
          await release.beforeGraphRead?.(signal);
          signal.throwIfAborted();
          return release.graph;
        },
        readImmutableBundle: (reference, _bytes, signal) =>
          release.read(reference, signal),
      },
    });
  async function registerOtherEmployee() {
    const identity = {
      ...f.identity,
      employeeInstanceId: randomUUID(),
      threadId: randomUUID(),
    };
    const root = selected.root.nativeSessionId;
    roots.set(identity.threadId, root);
    const other = await hostFixture({ ...selected, identity });
    other.catalog.items = other.catalog.items.map((row) =>
      String(row.sessionId) === root
        ? { ...row, blank: true, cwd: '/work' }
        : row,
    );
    closes.push(() => other.close());
    const otherControl = createDEntryPrincipalControl(other.node, {
      carrier: carrier.signal,
      cleanupTimeoutMs: 3000,
    });
    closes.push(() => otherControl.close());
    const endpoint = {
      ...f.owner.endpoint,
      employeeInstanceId: identity.employeeInstanceId,
    };
    const owner = {
      ...f.owner,
      endpoint,
      bindingRef: f.owner.bindingRef + '-other',
      receipt: { ...f.owner.receipt, endpoints: [endpoint] },
      acquirePrincipal: (
        _context: unknown,
        input: Parameters<typeof otherControl.acquire>[0],
        active: AbortSignal,
      ) => otherControl.acquire(input, active),
      async readSessions() {
        return { ok: true as const, value: { items: other.catalog.items } };
      },
      ...(release && {
        fixedProfile: {
          revoked: profileSource.signal,
          async readImmutableGraph() {
            return release.graph;
          },
          readImmutableBundle: (
            reference: string,
            _bytes: number,
            signal: AbortSignal,
          ) => release.read(reference, signal),
        },
      }),
    } satisfies typeof f.owner;
    otherEmployees.set(identity.threadId, { identity, owner });
    return { identity, bindingRef: owner.bindingRef };
  }
  const otherSession = { ...f.context, sessionId: randomUUID() };
  const authenticate = vi.fn(async (token: string) =>
    token === sessionToken
      ? f.context
      : token === otherToken
        ? otherSession
        : null,
  );
  const historyIdentity = vi.fn(async (_context: unknown, selection: unknown) =>
    selectionIdentity(selection),
  );
  const registeredRoots = new Map<
    string,
    Awaited<ReturnType<typeof registerDEntryPageNativeRoot>>
  >();
  const rememberRoot = (
    root: Awaited<ReturnType<typeof registerDEntryPageNativeRoot>>,
  ) => {
    roots.set(root.thread.id, root.rootNativeSessionId);
    registeredRoots.set(root.thread.id, root);
  };
  const selectedRoot = async (_context: unknown, selection: unknown) => {
    const root = await f.root();
    const identity = selectionIdentity(selection);
    return (
      registeredRoots.get(identity.threadId!) ?? {
        ...root,
        identity,
        rootNativeSessionId: roots.get(identity.threadId!)!,
      }
    );
  };
  let pinned = !newRoot;
  const prepareEditorRoot = vi.fn(async () => {
    pinned = true;
    return selectedRoot(f.context, f.selection);
  });
  const registerRoot = vi.fn<typeof registerDEntryPageNativeRoot>(
    async (_context, identity, receipt) => {
      const threadId = randomUUID();
      const timestamp = '2026-01-01T00:00:00.000Z';
      return {
        identity: { ...identity, threadId },
        rootNativeSessionId: receipt.nativeSessionId,
        rootOriginDigest: 'registered-root-origin',
        rootBindingRef: receipt.host.bindingRef,
        vmId: receipt.host.binding.vmId,
        thread: {
          id: threadId,
          ownerId: identity.personId,
          organizationId: identity.organizationId,
          workspaceId: identity.workspaceId,
          employeeInstanceId: identity.employeeInstanceId,
          employeeAssignmentId: randomUUID(),
          employeeVersionId: identity.employeeVersionId,
          visibility: 'private' as const,
          title: 'New native conversation',
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: null,
        },
      };
    },
  );
  const findRoot = vi.fn<typeof getDEntryPageNativeRoot>();
  const watchTerminal = vi.fn<
    NonNullable<Parameters<typeof createDEntryPageRequests>[0]['watchTerminal']>
  >(async (...args) => {
    await args[4].verifyRoster(args[3]);
    return f.deps.watch();
  });
  const pages = createDEntryPageRequests({
    ...f.deps,
    owners: {
      async resolve(_context, identity) {
        const other =
          identity.threadId && otherEmployees.get(identity.threadId);
        return other &&
          identity.employeeInstanceId === other.identity.employeeInstanceId
          ? other.owner
          : f.deps.owners.resolve();
      },
    },
    ...(newRoot && { data: () => ({ ...f.data, prepareEditorRoot }) }),
    authenticate,
    async watch(_context, selection) {
      const authority = await f.deps.watch();
      const { threadId } = DEntrySelectionInputSchema.parse(selection);
      const revoked = threadId && threadRevocations.get(threadId);
      return revoked
        ? {
            ...authority,
            revoked: AbortSignal.any([authority.revoked, revoked.signal]),
          }
        : authority;
    },
    async identity(_context, selection) {
      return selectionIdentity(selection);
    },
    root: selectedRoot,
    historyIdentity,
    registerRoot,
    findRoot,
    watchTerminal,
    historyRoot: (...args) =>
      pinned ? selectedRoot(...args) : Promise.resolve(null),
  });
  const pageSignals = new Map<string, AbortSignal>();
  const mux = createDEntryPageMux(
    {
      ...pages,
      own(token, selection, active, stop, opened, revoked, previous) {
        return pages.own(
          token,
          selection,
          active,
          stop,
          (page) => {
            pageSignals.set(page.scope.opened.scopeId, page.signal);
            return opened(page);
          },
          revoked,
          previous,
        );
      },
    },
    service.signal,
  );
  const rpc = createDEntryPageRpc(pages, authenticate, service.signal);
  const profileBorrows = vi.fn<(active: AbortSignal) => void>();
  const profileFailures = vi.fn<(error: unknown) => void>();
  const profilePages: typeof pages = {
    ...pages,
    borrow(token, selection, scopeId, caller, operation, failed) {
      return pages.borrow(
        token,
        selection,
        scopeId,
        caller,
        (page, active) => {
          profileBorrows(active);
          return operation(page, active);
        },
        failed &&
          ((error, active) => {
            profileFailures(error);
            return failed(error, active);
          }),
      );
    },
  };
  const profile = createDEntryProfile(
    profilePages,
    service.signal,
    release?.directory,
  );
  const profileCompletions = new WeakMap<
    ServerResponse,
    { done: boolean; promise: Promise<void>; resolve(): void }
  >();
  function profileCompletion(response: ServerResponse) {
    let completion = profileCompletions.get(response);
    if (!completion) {
      completion = { ...deferred(), done: false };
      profileCompletions.set(response, completion);
    }
    return completion;
  }
  const worker = createServer(async (request, response) => {
    if (request.url === '/fixture-before-profile') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('unrelated handler still running');
      return;
    }
    if (await profile.handle(request, response)) {
      const completion = profileCompletion(response);
      completion.done = true;
      completion.resolve();
      return;
    }
    if (!(await rpc.handle(request, response))) response.writeHead(404).end();
  });
  worker.on('upgrade', (request, socket, head) => {
    if (mux.matches(request)) void mux.upgrade(request, socket, head);
    else socket.destroy();
  });
  const workerOrigin = await listen(worker);
  vi.stubEnv('ALLRICE_WORKER_INTERNAL_URL', workerOrigin);
  closes.push(async () => {
    const handlers = [mux.close(), rpc.close(), profile.close()];
    service.abort();
    const stopped = new Promise<void>((resolve, reject) =>
      worker.close((error) => (error ? reject(error) : resolve())),
    );
    worker.closeAllConnections();
    const results = await Promise.allSettled([...handlers, stopped]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, 'Worker fixture shutdown failed');
  });
  const web = createServer();
  const origin = await listen(web);
  const probe = vi.fn<
    (target: string | URL, init: RequestInit) => Promise<Response>
  >(async (target) => {
    const requested = new URL(target);
    expect(requested.pathname).toBe('/api/v1/d-entry/identity');
    const selection = DEntrySelectionInputSchema.parse(
      Object.fromEntries(requested.searchParams),
    );
    return Response.json({
      identity: {
        ...selectionIdentity(selection),
        threadId: selection.threadId ?? null,
      },
    });
  });
  const gateway = createDEntryNativeGateway({
    port: (web.address() as AddressInfo).port,
    probe,
  });
  web.on(
    'upgrade',
    (request, socket, head) => void gateway.upgrade(request, socket, head),
  );
  const clients: WebSocket[] = [];
  closes.push(async () => {
    clients.forEach((client) => client.terminate());
    await gateway.close();
    await new Promise<void>((resolve) => web.close(() => resolve()));
  });
  const connect = (scopeId?: string, token = sessionToken, suffix = '') => {
    const query = new URLSearchParams({
      carrier: 'page',
      organizationId: f.identity.organizationId,
      ...pageSelection,
      ...(scopeId && { scopeId }),
    });
    const client = new WebSocket(
      origin.replace('http:', 'ws:') +
        '/api/v1/d-entry/native-mux?' +
        query +
        suffix,
      { headers: { origin, cookie: 'allrice_session=' + token } },
    );
    client.on('error', () => {});
    clients.push(client);
    return client;
  };
  const rpcBody = (scopeId: string, extra: object = {}) =>
    JSON.stringify({
      ...f.body,
      selection: pageSelection,
      scopeId,
      rpcId: '',
      endpoint: 'session/page',
      payload: {
        args: {
          request: {
            address: { kind: 'session', sessionId: 'root' },
            throughSeq: 0,
          },
        },
      },
      ...extra,
    });
  const invoke = (scopeId: string, token = sessionToken, extra: object = {}) =>
    fetch(workerOrigin + '/internal/d-entry/native-rpc?carrier=page', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: rpcBody(scopeId, extra),
    });
  const invokeThread = (scopeId: string, threadId: string) =>
    invoke(scopeId, sessionToken, {
      selection: { ...f.selection, threadId },
      payload: {
        args: {
          request: {
            address: { kind: 'session', sessionId: roots.get(threadId) },
            throughSeq: 0,
          },
        },
      },
    });
  function profileUrl(
    kind: 'bootstrap' | 'assets' | 'events' | 'switch',
    scopeId: string,
    selectors: Record<string, string> = {},
  ) {
    const url = new URL('/internal/d-entry/profile/' + kind, workerOrigin);
    url.search = new URLSearchParams({
      ...f.selection,
      organizationId: f.identity.organizationId,
      scopeId,
      ...selectors,
    }).toString();
    return url;
  }
  function publish(
    kind: 'bootstrap' | 'assets' | 'events',
    scopeId: string,
    selectors: Record<string, string> = {},
    mode?: 'document' | 'static',
    signal?: AbortSignal,
  ) {
    const url = profileUrl(kind, scopeId, selectors);
    return fetch(url, {
      signal,
      headers: {
        authorization: 'Bearer ' + sessionToken,
        ...(mode && { 'x-allrice-profile-request': mode }),
      },
    });
  }
  function proveSwitch(
    scopeId: string,
    targetThreadId: string,
    requestId: string,
    token = sessionToken,
    selection: Record<string, string> = {},
  ) {
    return fetch(
      profileUrl('switch', scopeId, {
        ...selection,
        targetThreadId,
        requestId,
      }),
      {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
      },
    );
  }
  return {
    ...f,
    proveSwitch,
    prepareEditorRoot,
    registerRoot,
    rememberRoot,
    findRoot,
    watchTerminal,
    host,
    connect,
    invoke,
    rpcBody,
    probe,
    publish,
    registerThread,
    registerOtherEmployee,
    selectionIdentity,
    invokeThread,
    profileBorrows,
    profileObserved,
    profileFailures,
    profileSource,
    profileUrl,
    authenticate,
    historyIdentity,
    pageSignals,
    profileCompletion,
    closeProfile: profile.close,
    closeControl: control.close,
    async checkUnknownControlClose() {
      controlCloseChecked = true;
      await expect(control.close()).rejects.toThrow('PRINCIPAL_JOIN_UNKNOWN');
    },
    worker,
    web,
    origin,
  };
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
}

export function send(peer: WebSocket, value: object) {
  peer.send(JSON.stringify(value));
}
export function messages(peer: WebSocket) {
  const events = on(peer, 'message', { close: ['close'] });
  return async (streamId?: string) => {
    while (true) {
      const next = await events.next();
      if (next.done)
        throw Error('Socket closed before the expected native frame');
      const frame = JSON.parse(String(next.value[0]));
      if (!streamId || frame.streamId === streamId) return frame;
    }
  };
}
export async function open(f: Awaited<ReturnType<typeof fixture>>) {
  const peer = f.connect();
  await once(peer, 'open');
  const receive = messages(peer);
  send(peer, {
    type: 'open',
    streamId: 'life',
    endpoint: '$d-entry/page',
    payload: { args: {} },
  });
  const frame = await receive();
  expect(frame).toMatchObject({
    type: 'item',
    streamId: 'life',
    value: { type: 'opened', bindingRef: f.owner.bindingRef },
  });
  expect(Object.keys(frame.value).sort()).toEqual([
    'bindingRef',
    'scopeReference',
    'type',
  ]);
  const scopeId = frame.value.scopeReference.scopeId as string;
  const revoked = f.pageSignals.get(scopeId);
  if (!revoked) throw Error('Worker page lifetime missing');
  return {
    peer,
    receive,
    scopeId,
    revoked,
  };
}
export async function status(peer: WebSocket) {
  const [request, response] = await once(peer, 'unexpected-response');
  response.resume();
  request.destroy();
  return response.statusCode;
}
export function closePage(peer: WebSocket) {
  send(peer, { type: 'item', streamId: 'life', value: 'close' });
  send(peer, { type: 'end', streamId: 'life' });
}
