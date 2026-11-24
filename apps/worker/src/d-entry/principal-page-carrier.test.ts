import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getEventListeners, once } from 'node:events';
import { get, type ServerResponse } from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { DataAccessError } from '@allrice/database';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import {
  deferred,
  summary,
} from '../../../../packages/d-entry-principal/test/host-fixture.js';
import { PendingPublication } from './profile.js';
import { holdReleasedProfile } from './released-profile.js';
import {
  DEntryProfileBootstrapSchema,
  DEntryProfileGraphSchema,
  DEntrySelectionInputSchema,
} from '@allrice/contracts';
import {
  fixture,
  buildProfileFixture,
  closes,
  sessionToken,
  otherToken,
  send,
  messages,
  open,
  status,
  closePage,
  type ProfileProof,
} from './principal-page-carrier.fixture.js';

it('issues only once, borrows the same actual native Peer for unary and stream and joins before closed/end', async () => {
  const f = await fixture();
  const life = await open(f);
  const business = f.connect(life.scopeId);
  await once(business, 'open');
  const next = messages(business);
  send(business, {
    type: 'open',
    streamId: 'self',
    endpoint: 'remoteAccess/follow',
    payload: { args: {} },
  });
  expect(await next()).toMatchObject({
    type: 'item',
    value: { type: 'baseline', owner: false },
  });
  send(business, {
    type: 'open',
    streamId: 'events',
    endpoint: '$events',
    payload: { args: {} },
  });
  expect(await next('events')).toMatchObject({
    type: 'item',
    streamId: 'events',
    value: { type: 'ready', host: { home: '/home/native-fixture' } },
  });

  const finishNative = deferred(),
    finishingNative = deferred();
  closes.push(async () => finishNative.resolve());
  f.host.catalog.afterFollow = async () => {
    finishingNative.resolve();
    await finishNative.promise;
  };
  send(business, {
    type: 'open',
    streamId: 'root',
    endpoint: 'session/follow',
    payload: {
      args: {
        request: { address: { kind: 'session', sessionId: 'root' } },
      },
    },
  });
  expect(await next('root')).toMatchObject({
    type: 'item',
    streamId: 'root',
    value: { type: 'snapshot' },
  });
  const response = await f.invoke(life.scopeId);
  expect(await response.json()).toEqual({
    type: 'server-response',
    rpcId: '',
    result: { ok: true, value: { records: [], hasMore: false } },
  });
  expect(f.host.catalog.pages[0]).toBe(f.host.catalog.follows[0]);
  expect(f.owner.acquirePrincipal).toHaveBeenCalledTimes(1);
  expect(f.probe.mock.calls[0]?.[1].method).toBe('GET');

  let ack: unknown;
  const closed = life.receive().then((frame) => (ack = frame));
  const cleanTransport = once(life.peer, 'close');
  closePage(life.peer);
  try {
    await finishingNative.promise;
    expect(ack).toBeUndefined();
    expect((await f.invoke(life.scopeId)).status).toBe(404);
  } finally {
    finishNative.resolve();
  }
  expect(await closed).toEqual({
    type: 'item',
    streamId: 'life',
    value: { type: 'closed', scopeId: life.scopeId },
  });
  expect(await life.receive()).toEqual({ type: 'end', streamId: 'life' });
  expect((await cleanTransport)[0]).toBe(1000);
});

it('refuses duplicate selectors, unauthorized login and cross-session borrow without disturbing the page', async () => {
  const f = await fixture();
  expect(
    await status(f.connect(undefined, sessionToken, '&carrier=page')),
  ).toBe(400);
  expect(await status(f.connect(undefined, 'unknown_original_session'))).toBe(
    401,
  );
  const life = await open(f);
  expect(await status(f.connect(life.scopeId, otherToken))).toBe(404);
  expect((await f.invoke(life.scopeId, otherToken)).status).toBe(404);
  expect(
    (await f.invoke(life.scopeId, sessionToken, { endpoint: 'session/list' }))
      .status,
  ).toBe(400);
  expect((await f.invoke(life.scopeId)).status).toBe(200);
  expect(f.owner.acquirePrincipal).toHaveBeenCalledTimes(1);
  closePage(life.peer);
  expect(await life.receive()).toMatchObject({ value: { type: 'closed' } });
  expect(await life.receive()).toEqual({ type: 'end', streamId: 'life' });
});

it.each(['child grant', 'D qualification'] as const)(
  'checks %s after a real bootstrap baseline and a blocked native close',
  { timeout: 30_000 },
  async (change) => {
    const f = await fixture(await buildProfileFixture());
    const page = await open(f);
    const observed = deferred<unknown>();
    const joining = deferred();
    const allowJoin = deferred();
    closes.push(async () => allowJoin.resolve());
    const gateway = f.host.host.typertGateway.wireStream;
    const nativeOpen = gateway.open.bind(gateway);
    const peerIds: string[] = [];
    vi.spyOn(gateway, 'open').mockImplementation(async (...args) => {
      const source = await nativeOpen(...args);
      if (args[0] !== 'remoteAccess/follow') return source;
      const principal = args[3]?.principal;
      if (principal?.kind !== 'allrice-d-entry') return source;
      peerIds.push(principal.scopeId);
      if (peerIds.length !== 1) return source;
      return {
        [Symbol.asyncIterator]() {
          const underlying = source[Symbol.asyncIterator]();
          return {
            async next() {
              const item = await underlying.next();
              if (!item.done) observed.resolve(item.value);
              return item;
            },
            async return() {
              joining.resolve();
              await allowJoin.promise;
              return (
                (await underlying.return?.()) ?? {
                  done: true,
                  value: undefined,
                }
              );
            },
          };
        },
      };
    });
    const pendingResponse = deferred<ServerResponse>();
    f.worker.once('request', (_request, response) =>
      pendingResponse.resolve(response),
    );
    const result = f.publish('bootstrap', page.scopeId);
    void result.catch(() => {});
    try {
      const first = await observed.promise;
      expect(first).toMatchObject({ type: 'baseline', owner: false });
      expect(JSON.stringify(first)).toContain('"id":"child"');
      await joining.promise;
      expect((await pendingResponse.promise).headersSent).toBe(false);
      // No change hint has reached the guest and no SQL watcher has fired.
      if (change === 'child grant') {
        f.host.catalog.items = f.host.catalog.items.filter(
          (row) => String(row.sessionId) !== 'child',
        );
      } else {
        vi.mocked(f.owner.assertCurrent).mockRejectedValueOnce(
          new DataAccessError('authorization_denied'),
        );
      }
    } finally {
      allowJoin.resolve();
    }
    const response = await result;
    if (change === 'child grant') {
      expect(response.status).toBe(200);
      const bootstrap = DEntryProfileBootstrapSchema.parse(
        await response.json(),
      );
      const baseline = bootstrap.injections.at(-1);
      expect(JSON.stringify(baseline)).toContain('"id":"root"');
      expect(JSON.stringify(baseline)).not.toContain('"id":"child"');
      expect(peerIds).toEqual([page.scopeId, page.scopeId]);
    } else {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    }
  },
);

it.each(['HTTP disconnect', 'profile shutdown'] as const)(
  'cancels and joins the actual guest list on %s without revoking the page or its neighbor',
  { timeout: 30_000 },
  async (change) => {
    const f = await fixture(await buildProfileFixture());
    const page = await open(f);
    const neighbor = await open(f);
    const entered = deferred<AbortSignal>();
    const sawAbort = deferred();
    const joined = deferred();
    const allowJoin = deferred();
    closes.push(async () => allowJoin.resolve());
    let reads = 0;
    f.host.catalog.beforeList = async (signal) => {
      if (++reads !== 1) return;
      entered.resolve(signal);
      if (!signal.aborted) await once(signal, 'abort');
      sawAbort.resolve();
      await allowJoin.promise;
      joined.resolve();
      signal.throwIfAborted();
    };
    const pendingResponse = deferred<ServerResponse>();
    f.worker.once('request', (_request, response) =>
      pendingResponse.resolve(response),
    );
    const client = get(f.profileUrl('bootstrap', page.scopeId), {
      headers: { authorization: 'Bearer ' + sessionToken },
    });
    client.on('error', () => {});
    client.on('response', (response) => response.resume());
    closes.push(async () => client.destroy());
    let shutdown: Promise<void> | undefined;
    let stopped = false;
    try {
      const actualCatalogSignal = await entered.promise;
      expect(actualCatalogSignal.aborted).toBe(false);
      if (change === 'HTTP disconnect') client.destroy();
      else
        shutdown = f.closeProfile().then(() => {
          stopped = true;
        });
      await sawAbort.promise;
      expect(actualCatalogSignal.aborted).toBe(true);
      const response = await pendingResponse.promise;
      expect(f.completedProfiles.has(response)).toBe(false);
      expect(stopped).toBe(false);
      expect((await f.invoke(neighbor.scopeId)).status).toBe(200);
      expect(f.completedProfiles.has(response)).toBe(false);
    } finally {
      allowJoin.resolve();
    }
    await joined.promise;
    await shutdown;
    const response = await pendingResponse.promise;
    await expect.poll(() => f.completedProfiles.has(response)).toBe(true);
    expect((await f.invoke(page.scopeId)).status).toBe(200);
    if (change === 'HTTP disconnect') {
      const retry = await f.publish('bootstrap', page.scopeId);
      expect(retry.status).toBe(200);
      await retry.arrayBuffer();
    }
  },
);

it.each([
  'native update',
  'catalog drift before any update',
  'true terminal',
] as const)(
  'rejects the second baseline when final verification sees %s',
  { timeout: 30_000 },
  async (mode) => {
    const release = await buildProfileFixture();
    const f = await fixture(release);
    const page = await open(f);
    const terminal = deferred<ServerResponse>();
    const checking = deferred();
    const allowCheck = deferred();
    const finishReader = deferred();
    closes.push(async () => allowCheck.resolve());
    closes.push(async () => finishReader.resolve());
    const wire = f.host.host.typertGateway.wireStream;
    const openNative = wire.open.bind(wire);
    let access = 0;
    vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
      const source = await openNative(...args);
      if (args[0] !== 'remoteAccess/follow' || ++access !== 2) return source;
      return {
        async *[Symbol.asyncIterator]() {
          let first = true;
          for await (const item of source) {
            if (first) {
              expect(item).toMatchObject({ type: 'baseline', owner: false });
              expect(JSON.stringify(item)).toContain('"id":"child"');
              release.beforeGraphRead = async () => {
                release.beforeGraphRead = undefined;
                checking.resolve();
                await allowCheck.promise;
              };
              first = false;
            }
            yield item;
            if (mode === 'true terminal') {
              await finishReader.promise;
              return;
            }
          }
        },
      };
    });
    f.worker.once('request', (_request, response) =>
      terminal.resolve(response),
    );
    const result = f.publish('bootstrap', page.scopeId);
    void result.catch(() => {});
    try {
      await checking.promise;
      if (mode === 'true terminal') {
        finishReader.resolve();
        await expect
          .poll(() => f.profileObserved.mock.calls)
          .toContainEqual(['terminal']);
      } else {
        const nativeChild = summary('child', 'root');
        f.host.catalog.items = f.host.catalog.items.filter(
          (row) => row.sessionId !== nativeChild.sessionId,
        );
        if (mode === 'native update') {
          f.host.host.emit('api-session/removed', nativeChild.sessionId);
          await expect
            .poll(() => f.profileObserved.mock.calls.length)
            .toBeGreaterThan(1);
        } else expect(f.profileObserved.mock.calls).toEqual([['item']]);
      }
      expect((await terminal.promise).headersSent).toBe(false);
      expect(access).toBe(2);
    } finally {
      allowCheck.resolve();
      finishReader.resolve();
    }
    const refused = await result;
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain('"id":"child"');
    const retry = await f.publish('bootstrap', page.scopeId);
    expect(retry.status).toBe(200);
    const refreshed = await retry.text();
    if (mode === 'true terminal') expect(refreshed).toContain('"id":"child"');
    else expect(refreshed).not.toContain('"id":"child"');
  },
);

it.each(['waiting to read', 'waiting for a newer projection'] as const)(
  'joins the finite request while it is %s and unrelated catalog I/O remains held',
  { timeout: 30_000 },
  async (mode) => {
    const f = await fixture(await buildProfileFixture());
    const page = await open(f);
    const reading = deferred<AbortSignal>();
    const finish = deferred();
    closes.push(async () => finish.resolve());
    let calls = 0;
    f.host.catalog.beforeList = async (signal) => {
      const call = ++calls;
      if (mode === 'waiting for a newer projection' && call === 1) {
        // Fence this follower with a newer page-owned refresh while its own
        // read is still the only one in progress.
        f.host.host.emit('api-session/added', summary('child', 'root'));
      }
      if (call !== (mode === 'waiting to read' ? 1 : 2)) return;
      reading.resolve(signal);
      await finish.promise;
    };
    const predecessor =
      mode === 'waiting to read' ? f.invoke(page.scopeId) : undefined;
    void predecessor?.catch(() => {});
    if (predecessor) await reading.promise;
    const responseReady = deferred<ServerResponse>();
    f.worker.once('request', (_request, response) =>
      responseReady.resolve(response),
    );
    const client = get(f.profileUrl('bootstrap', page.scopeId), {
      headers: { authorization: 'Bearer ' + sessionToken },
    });
    client.on('error', () => {});
    closes.push(async () => client.destroy());
    try {
      const nativeSignal = await reading.promise;
      const scope = f.host.host.allricePrincipal.scopes.get(page.scopeId);
      await expect.poll(() => scope?.children.size).toBe(1);
      const callsBeforeCancel = calls;
      client.destroy();
      const response = await responseReady.promise;
      await expect.poll(() => f.completedProfiles.has(response)).toBe(true);
      expect(nativeSignal.aborted).toBe(false);
      expect(calls).toBe(callsBeforeCancel);
      expect(scope?.children.size).toBe(0);
    } finally {
      finish.resolve();
    }
    if (predecessor) expect((await predecessor).status).toBe(200);
    const retry = await f.publish('bootstrap', page.scopeId);
    expect(retry.status).toBe(200);
    await retry.arrayBuffer();
  },
);

it.each(['with baseline', 'with independent baseline failure'] as const)(
  'fences bootstrap and later borrows when the initial native follow cannot confirm its close %s',
  { timeout: 30_000 },
  async (mode) => {
    const f = await fixture(await buildProfileFixture());
    const page = await open(f);
    const neighbor = await open(f);
    const initial = deferred();
    const failed = deferred<unknown>();
    const failure = Error('initial native follow return failed');
    const businessError = new RemoteError(
      'gateway/service-unavailable',
      'original native access business error',
      { source: 'initial follow' },
    );
    const wire = f.host.host.typertGateway.wireStream;
    const openNative = wire.open.bind(wire);
    let access = 0;
    vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
      const source = await openNative(...args);
      if (args[0] !== 'remoteAccess/follow' || ++access !== 1) return source;
      return {
        [Symbol.asyncIterator]() {
          const underlying = source[Symbol.asyncIterator]();
          return {
            async next() {
              const item = await underlying.next();
              if (!item.done) initial.resolve();
              if (mode === 'with independent baseline failure')
                throw businessError;
              return item;
            },
            async return() {
              await underlying.return?.();
              failed.resolve(failure);
              throw failure;
            },
          };
        },
      };
    });
    const result = f.publish('bootstrap', page.scopeId);
    await initial.promise;
    expect(await failed.promise).toBe(failure);
    const denied = await result;
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe('');
    expect((await f.publish('bootstrap', page.scopeId)).status).toBe(404);
    expect((await f.invoke(page.scopeId)).status).toBe(404);
    expect((await f.invoke(neighbor.scopeId)).status).toBe(200);
    expect(access).toBe(1);
    if (mode === 'with independent baseline failure')
      expect(f.profileFailures.mock.calls[0]?.[0]).toMatchObject({
        message: businessError.message,
      });
    await f.checkUnknownControlClose();
  },
);

it(
  'unregisters one of two actual waiters while keeping their shared page proof alive',
  { timeout: 30_000 },
  async () => {
    const release = await buildProfileFixture();
    const shared = deferred<AbortSignal>();
    const finish = deferred();
    closes.push(async () => finish.resolve());
    let reads = 0;
    release.beforeGraphRead = async (signal) => {
      if (++reads !== 1) return;
      shared.resolve(signal);
      await finish.promise;
    };
    const f = await fixture(release);
    const page = await open(f);
    const pendingPublications = vi.spyOn(PendingPublication.prototype, 'wait');
    const cancel = new AbortController();
    const first = f.publish(
      'bootstrap',
      page.scopeId,
      {},
      'document',
      cancel.signal,
    );
    void first.catch(() => {});
    const sharedSignal = await shared.promise;
    const other = f.publish('bootstrap', page.scopeId, {}, 'document');
    void other.catch(() => {});
    try {
      await expect.poll(() => f.profileBorrows.mock.calls.length).toBe(2);
      const [one, two] = f.profileBorrows.mock.calls.map(([signal]) => signal);
      await expect.poll(() => getEventListeners(one!, 'abort').length).toBe(1);
      await expect.poll(() => getEventListeners(two!, 'abort').length).toBe(1);
      const proof = pendingPublications.mock.contexts[0] as PendingPublication;
      expect(pendingPublications.mock.contexts).toEqual([proof, proof]);
      const [firstWaiter, secondWaiter] = [...proof['waiters']];
      expect(firstWaiter).toBeTypeOf('function');
      expect(secondWaiter).toBeTypeOf('function');
      cancel.abort(Error('the first wire left'));
      await expect(first).rejects.toThrow('the first wire left');
      await expect.poll(() => getEventListeners(one!, 'abort').length).toBe(0);
      expect(getEventListeners(two!, 'abort')).toHaveLength(1);
      expect([...proof['waiters']]).toEqual([secondWaiter]);
      expect(sharedSignal.aborted).toBe(false);
      expect(reads).toBe(1);
    } finally {
      finish.resolve();
      pendingPublications.mockRestore();
    }
    const result = await other;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ nativeSessionId: 'root' });
    expect(
      getEventListeners(f.profileBorrows.mock.calls[1]![0], 'abort'),
    ).toHaveLength(0);
  },
);

it(
  'publishes the released graph and bytes, and waits for all queued HTTP writers to settle',
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-profile-release-'));
    closes.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, 'release');
    await promisify(execFile)(
      process.execPath,
      ['packages/dsh-web-composition/build-web-entry.mjs', directory],
      { timeout: 20_000 },
    );
    const raw = JSON.parse(
      await readFile(join(directory, 'artifact.json'), 'utf8'),
    );
    const largeAsset = 'managed/transfer-ownership-test.js';
    const largeBytes = Buffer.alloc(12 * 1024 * 1024, 32);
    await writeFile(join(directory, largeAsset), largeBytes);
    raw.files.push({
      path: largeAsset,
      bytes: largeBytes.length,
      sha256: createHash('sha256').update(largeBytes).digest('hex'),
    });
    await writeFile(join(directory, 'artifact.json'), JSON.stringify(raw));
    const graph = DEntryProfileGraphSchema.parse(raw.profile.graph);
    const read = (reference: string, signal: AbortSignal) => {
      const file = raw.profile.files.find(
        (row: { reference: string }) => row.reference === reference,
      );
      if (!file) throw Error('Named release proof missing');
      return readFile(join(directory, file.path), { signal });
    };
    const source = new AbortController().signal;
    await holdReleasedProfile(
      directory,
      {
        revoked: source,
        async readImmutableGraph() {
          return graph;
        },
        readImmutableBundle: (reference, _bytes, signal) =>
          read(reference, signal),
      },
      source,
    );
    // This runs the released app profile builder and actual non-owner Cordis
    // Peer. Only the VM receipt/current PostgreSQL lease is fixture-owned.
    const ownerProof: ProfileProof = { directory, graph, read };
    const f = await fixture(ownerProof);
    const { peer, receive, scopeId } = await open(f);
    const address = await f.publish('bootstrap', scopeId, {}, 'document');
    expect(address.status).toBe(200);
    const target = await address.json();
    expect(target).toMatchObject({
      bindingRef: f.owner.bindingRef,
      graphRev: graph.rev,
      nativeSessionId: 'root',
    });
    const initial = await f.publish('bootstrap', scopeId);
    expect(initial.status).toBe(200);
    const boot = DEntryProfileBootstrapSchema.parse(await initial.json());
    expect(boot.graph).toEqual(graph);
    expect(boot.injections.at(-1)).toMatchObject({
      kind: 'global',
      name: '__DSH_REMOTE_ACCESS__',
      value: { owner: false, grants: expect.any(Array) },
    });
    const duplicate = await f.publish('bootstrap', scopeId);
    expect(duplicate.status).toBe(409);
    await duplicate.body?.cancel();
    const { url, rev } = graph.batches[0]!;
    const asset = await f.publish('assets', scopeId, {
      bindingRef: f.owner.bindingRef,
      reference: url,
      revision: rev,
    });
    expect(asset.status).toBe(200);
    const proof = raw.profile.files.find(
      (row: { reference: string }) => row.reference === url,
    );
    const data = Buffer.from(await asset.arrayBuffer());
    expect(data).toEqual(await readFile(join(directory, proof.path)));
    expect(asset.headers.get('content-length')).toBe(String(data.byteLength));
    const bad = await f.publish('assets', scopeId, {
      bindingRef: f.owner.bindingRef,
      reference: url,
      revision: 'wrong',
    });
    expect(bad.status).toBe(404);
    await bad.body?.cancel();

    async function blockedAsset() {
      const serverResponse = deferred<ServerResponse>();
      f.worker.once('request', (_request, response) =>
        serverResponse.resolve(response),
      );
      const url = f.profileUrl('assets', scopeId, {
        bindingRef: f.owner.bindingRef,
        graphRev: target.graphRev,
        manifestSha256: target.manifestSha256,
        path: largeAsset,
      });
      const request = get(url, {
        headers: {
          authorization: 'Bearer ' + sessionToken,
          'x-allrice-profile-request': 'static',
        },
      });
      request.on('error', () => {});
      closes.push(async () => request.destroy());
      const [paused] = await once(request, 'response');
      paused.on('error', () => {});
      paused.pause();
      expect(paused.statusCode).toBe(200);
      const response = await serverResponse.promise;
      expect(response.writableFinished).toBe(false);
      return { request, closed: once(response, 'close') };
    }
    const cancelled = await blockedAsset();
    cancelled.request.destroy();
    await cancelled.closed;
    expect((await f.invoke(scopeId)).status).toBe(200);

    const keep = new AbortController();
    closes.push(async () => keep.abort());
    const events = await f.publish(
      'events',
      scopeId,
      { bindingRef: f.owner.bindingRef },
      undefined,
      keep.signal,
    );
    const reader = events.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(
      `data: ${JSON.stringify({ type: 'graph', graph })}\n\n`,
    );
    const clash = await f.publish('events', scopeId, {
      bindingRef: f.owner.bindingRef,
    });
    expect(clash.status).toBe(409);
    await clash.body?.cancel();
    const pending = reader.read().then(
      () => false,
      () => true,
    );
    const foreground = await open(f);
    const waiting = await open(f);
    const pipeline = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: waiting.scopeId,
    });
    const [active, queuedAsset, queuedDenial, next] = pipeline.responses;
    for (const item of [queuedAsset!, queuedDenial!, next!]) {
      expect(item.socket).toBeNull();
      expect(item.headersSent).toBe(false);
      expect(item.writableEnded).toBe(false);
    }
    closePage(waiting.peer);
    expect(await waiting.receive()).toMatchObject({
      value: { type: 'closed' },
    });
    expect(await waiting.receive()).toEqual({ type: 'end', streamId: 'life' });
    expect((await f.invoke(waiting.scopeId)).status).toBe(404);
    expect((await f.invoke(foreground.scopeId)).status).toBe(200);
    expect(active!.destroyed).toBe(false);
    expect(active!.writableEnded).toBe(false);
    expect(queuedAsset!.statusCode).toBe(404);
    expect(queuedDenial!.statusCode).toBe(404);
    expect(next!.headersSent).toBe(false);
    active!.end();
    await expect
      .poll(() => pipeline.raw().match(/HTTP\/1\.1 (200|404)/g))
      .toEqual([
        'HTTP/1.1 200',
        'HTTP/1.1 404',
        'HTTP/1.1 404',
        'HTTP/1.1 200',
      ]);
    await expect
      .poll(() => pipeline.raw().includes(target.manifestSha256))
      .toBe(true);
    expect(pipeline.raw()).not.toContain(
      'content-length: ' + largeBytes.length,
    );
    pipeline.client.destroy();

    const noNotification = await open(f);
    const afterRoleChange = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: noNotification.scopeId,
      onlyAsset: true,
    });
    const [roleHead, roleAsset, roleNext] = afterRoleChange.responses;
    expect(roleAsset!.socket).toBeNull();
    // The authoritative lookup now denies B. Its watcher has not sent any
    // cancellation signal. The HTTP writer must read again after its turn.
    vi.mocked(f.owner.assertCurrent).mockRejectedValueOnce(
      new DataAccessError('authorization_denied'),
    );
    roleHead!.end();
    await expect
      .poll(() => afterRoleChange.raw().match(/HTTP\/1\.1 (200|404)/g))
      .toEqual(['HTTP/1.1 200', 'HTTP/1.1 404', 'HTTP/1.1 200']);
    expectEmptyDenial(afterRoleChange.raw());
    expect(roleNext!.writableFinished).toBe(true);
    expect((await f.invoke(noNotification.scopeId)).status).toBe(404);
    expect((await f.invoke(foreground.scopeId)).status).toBe(200);
    afterRoleChange.client.destroy();

    const beforeHeaders = await open(f);
    const assigned = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: beforeHeaders.scopeId,
      onlyAsset: true,
    });
    const [assignHead, assignedAsset, assignedNext] = assigned.responses;
    const checking = deferred();
    const finishCheck = deferred();
    closes.push(async () => finishCheck.resolve());
    vi.mocked(f.owner.assertCurrent).mockImplementationOnce(async () => {
      checking.resolve();
      await finishCheck.promise;
    });
    assignHead!.end();
    await checking.promise;
    expect(assignedAsset!.socket).not.toBeNull();
    expect(assignedAsset!.headersSent).toBe(false);
    const rejected = beforeHeaders.receive();
    closePage(beforeHeaders.peer);
    await expect
      .poll(async () => (await f.invoke(beforeHeaders.scopeId)).status)
      .toBe(404);
    expect(assignedAsset!.headersSent).toBe(false);
    expect(assignedNext!.headersSent).toBe(false);
    finishCheck.resolve();
    expect(await rejected).toMatchObject({ value: { type: 'closed' } });
    await expect
      .poll(() => assigned.raw().match(/HTTP\/1\.1 (200|404)/g))
      .toEqual(['HTTP/1.1 200', 'HTTP/1.1 404', 'HTTP/1.1 200']);
    expectEmptyDenial(assigned.raw());
    expect(assignedNext!.writableFinished).toBe(true);
    assigned.client.destroy();

    const reading = await open(f);
    const readingGraph = deferred();
    const finishRead = deferred();
    closes.push(async () => finishRead.resolve());
    const preRead = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: reading.scopeId,
      onlyAsset: true,
      beforeQueued: () => {
        ownerProof.beforeGraphRead = async () => {
          ownerProof.beforeGraphRead = undefined;
          readingGraph.resolve();
          await finishRead.promise;
        };
      },
      beforeNext: () => readingGraph.promise,
    });
    const [readHead, preReadAsset, preReadNext] = preRead.responses;
    await readingGraph.promise;
    expect(preReadAsset!.listenerCount('socket')).toBe(0);
    closePage(reading.peer);
    await expect
      .poll(async () => (await f.invoke(reading.scopeId)).status)
      .toBe(404);
    finishRead.resolve();
    expect(await reading.receive()).toMatchObject({
      value: { type: 'closed' },
    });
    expect(preReadAsset!.statusCode).toBe(404);
    expect(preReadAsset!.writableEnded).toBe(true);
    expect(readHead!.writableEnded).toBe(false);
    expect(preReadNext!.headersSent).toBe(false);
    readHead!.end();
    await expect
      .poll(() => preRead.raw().match(/HTTP\/1\.1 (200|404)/g))
      .toEqual(['HTTP/1.1 200', 'HTTP/1.1 404', 'HTTP/1.1 200']);
    expectEmptyDenial(preRead.raw());
    preRead.client.destroy();

    const borrowing = await open(f);
    const authorizing = deferred();
    const finishHistory = deferred();
    closes.push(async () => finishHistory.resolve());
    const early = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: borrowing.scopeId,
      onlyAsset: true,
      beforeQueued: () => {
        f.historyIdentity.mockImplementationOnce(
          async (_context, selection) => {
            authorizing.resolve();
            await finishHistory.promise;
            return {
              ...f.identity,
              threadId:
                DEntrySelectionInputSchema.parse(selection).threadId ?? null,
            };
          },
        );
      },
      beforeNext: () => authorizing.promise,
    });
    const [earlyHead, earlyAsset] = early.responses;
    expect(earlyAsset!.listenerCount('socket')).toBe(0);
    closePage(borrowing.peer);
    await expect
      .poll(async () => (await f.invoke(borrowing.scopeId)).status)
      .toBe(404);
    finishHistory.resolve();
    expect(await borrowing.receive()).toMatchObject({
      value: { type: 'closed' },
    });
    expect(earlyHead!.writableEnded).toBe(false);
    earlyHead!.end();
    await expect
      .poll(() => early.raw().match(/HTTP\/1\.1 (200|404)/g))
      .toEqual(['HTTP/1.1 200', 'HTTP/1.1 404', 'HTTP/1.1 200']);
    expectEmptyDenial(early.raw());
    early.client.destroy();

    const warm = await open(f);
    const warming = await f.publish('bootstrap', warm.scopeId, {}, 'document');
    expect(warming.status).toBe(200);
    await warming.json();
    const readingAsset = deferred();
    const cancelledAsset = deferred();
    const fallbackAsset = deferred();
    closes.push(async () => fallbackAsset.resolve());
    const disconnected = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: warm.scopeId,
      onlyAsset: true,
      beforeQueued: () => {
        ownerProof.beforeGraphRead = async (signal) => {
          ownerProof.beforeGraphRead = undefined;
          readingAsset.resolve();
          const stop = () => cancelledAsset.resolve();
          signal.addEventListener('abort', stop, { once: true });
          try {
            if (signal.aborted) stop();
            await Promise.race([cancelledAsset.promise, fallbackAsset.promise]);
          } finally {
            signal.removeEventListener('abort', stop);
          }
        };
      },
      beforeNext: () => readingAsset.promise,
    });
    const disconnectedAsset = disconnected.responses[1]!;
    expect(disconnectedAsset.socket).toBeNull();
    disconnected.client.destroy();
    await expect
      .poll(() => f.completedProfiles.has(disconnectedAsset))
      .toBe(true);
    await cancelledAsset.promise;
    expect((await f.invoke(warm.scopeId)).status).toBe(200);
    expect((await f.invoke(foreground.scopeId)).status).toBe(200);

    expect(JSON.stringify(boot.injections.at(-1))).toContain('"id":"child"');
    const waitingGrants = await open(f);
    const grantPipeline = await pipelineAfterEvents(foreground.scopeId, {
      awaitingId: waitingGrants.scopeId,
      bootstrap: true,
    });
    const [grantHead, grantResponse] = grantPipeline.responses;
    expect(grantResponse!.socket).toBeNull();
    const oldCatalog = f.host.catalog.items;
    try {
      f.host.catalog.items = oldCatalog.filter(
        (row) => row.sessionId !== 'child',
      );
      grantHead!.end();
      await expect
        .poll(() => grantPipeline.raw())
        .toContain('__DSH_REMOTE_ACCESS__');
      expect(grantPipeline.raw()).toContain('"id":"root"');
      expect(grantPipeline.raw()).not.toContain('"id":"child"');
      expect((await f.invoke(waitingGrants.scopeId)).status).toBe(200);
    } finally {
      f.host.catalog.items = oldCatalog;
      grantPipeline.client.destroy();
    }

    const draining = await pipelineAfterEvents(foreground.scopeId);
    const held = holdSocket(draining.responses[0]!);
    let terminal: Awaited<ReturnType<typeof receive>> | undefined;
    const terminalPromise = foreground
      .receive()
      .then((frame) => (terminal = frame));
    closePage(foreground.peer);
    await expect.poll(() => held.fenced()).toBe(true);
    expect((await f.invoke(foreground.scopeId)).status).toBe(404);
    expect((await f.invoke(scopeId)).status).toBe(200);
    expect(terminal).toBeUndefined();
    held.release.resolve();
    await held.closed;
    expect(await terminalPromise).toMatchObject({ value: { type: 'closed' } });
    expect(await foreground.receive()).toEqual({
      type: 'end',
      streamId: 'life',
    });

    const second = await open(f);
    const firstResponse = await f.publish('bootstrap', second.scopeId);
    expect(firstResponse.status).toBe(200);
    await firstResponse.json();
    const errors = await pipelineAfterEvents(second.scopeId, { errors: true });
    expect(
      errors.responses
        .slice(1)
        .every((r) => r.socket === null && !r.headersSent),
    ).toBe(true);
    const heldErrors = holdSocket(errors.responses[0]!);
    let joined = false;
    const stopping = f.closeProfile().then(() => {
      joined = true;
    });
    await expect.poll(() => heldErrors.fenced()).toBe(true);
    expect(joined).toBe(false);
    heldErrors.release.resolve();
    await heldErrors.closed;
    await stopping;
    expect(await pending).toBe(true);

    const wireOnly = await fixture({ directory, graph, read });
    const unrelated = await pipelineAfterEvents(
      scopeId,
      { unrelated: true },
      wireOnly,
    );
    const [unrelatedHead, unrelatedDenial] = unrelated.responses;
    const unrelatedFinish = once(unrelatedDenial!, 'finish');
    expect(unrelatedDenial!.socket).toBeNull();
    expect(unrelatedDenial!.headersSent).toBe(false);
    let wireJoined = false;
    const stoppingWire = wireOnly.closeProfile().then(() => {
      wireJoined = true;
    });
    await expect
      .poll(() => wireOnly.completedProfiles.has(unrelatedDenial!))
      .toBe(true);
    expect(unrelatedDenial!.statusCode).toBe(404);
    expect(unrelatedDenial!.writableFinished).toBe(false);
    expect(unrelatedHead!.writableEnded).toBe(false);
    expect(wireJoined).toBe(false);
    unrelatedHead!.end();
    await unrelatedFinish;
    await stoppingWire;
    expect(unrelated.raw()).toContain('unrelated handler still running');
    await expect
      .poll(() => unrelated.raw().match(/HTTP\/1\.1 (200|404)/g))
      .toEqual(['HTTP/1.1 200', 'HTTP/1.1 404']);
    unrelated.client.destroy();
    closePage(peer);
    expect(await receive()).toMatchObject({ value: { type: 'closed' } });
    closePage(second.peer);
    expect(await second.receive()).toMatchObject({ value: { type: 'closed' } });

    const firstProof = deferred<AbortSignal>();
    const finishFirstProof = deferred();
    closes.push(async () => finishFirstProof.resolve());
    const sharedProof: ProfileProof = {
      directory,
      graph,
      read,
      async beforeGraphRead(signal) {
        sharedProof.beforeGraphRead = undefined;
        firstProof.resolve(signal);
        await finishFirstProof.promise;
      },
    };
    const shared = await fixture(sharedProof);
    const sharedPage = await open(shared);
    const caller = new AbortController();
    const firstResponseOnWire = deferred<ServerResponse>();
    shared.worker.once('request', (_request, response) =>
      firstResponseOnWire.resolve(response),
    );
    const canceledRequest = shared.publish(
      'bootstrap',
      sharedPage.scopeId,
      {},
      'document',
      caller.signal,
    );
    const firstWire = await firstResponseOnWire.promise;
    const sharedSignal = await firstProof.promise;
    const secondBorrow = deferred();
    vi.mocked(shared.owner.assertCurrent).mockImplementationOnce(async () => {
      secondBorrow.resolve();
    });
    const secondRequest = shared.publish(
      'bootstrap',
      sharedPage.scopeId,
      {},
      'document',
    );
    await secondBorrow.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    caller.abort();
    await expect(canceledRequest).rejects.toMatchObject({ name: 'AbortError' });
    await expect.poll(() => shared.completedProfiles.has(firstWire)).toBe(true);
    expect(sharedSignal.aborted).toBe(false);
    finishFirstProof.resolve();
    const responseWithSharedProof = await secondRequest;
    expect(responseWithSharedProof.status).toBe(200);
    await responseWithSharedProof.json();

    const shutdownPage = await open(shared);
    const readBeforeShutdown = deferred<AbortSignal>();
    const finishShutdown = deferred();
    closes.push(async () => finishShutdown.resolve());
    sharedProof.beforeGraphRead = async (signal) => {
      sharedProof.beforeGraphRead = undefined;
      readBeforeShutdown.resolve(signal);
      await finishShutdown.promise;
    };
    const shutdownRequest = shared.publish(
      'bootstrap',
      shutdownPage.scopeId,
      {},
      'document',
    );
    const shutdownSignal = await readBeforeShutdown.promise;
    let joinedProof = false;
    const shutdown = shared.closeProfile().then(() => {
      joinedProof = true;
    });
    const refused = await shutdownRequest;
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe('');
    expect(shutdownSignal.aborted).toBe(true);
    expect(joinedProof).toBe(false);
    expect((await shared.invoke(sharedPage.scopeId)).status).toBe(200);
    finishShutdown.resolve();
    await shutdown;
    expect(joinedProof).toBe(true);
    expect((await shared.invoke(shutdownPage.scopeId)).status).toBe(200);

    const withdrawn = await fixture({ directory, graph, read });
    const live = await open(withdrawn);
    const watching = await withdrawn.publish('events', live.scopeId, {
      bindingRef: withdrawn.owner.bindingRef,
    });
    const updates = watching.body!.getReader();
    expect((await updates.read()).done).toBe(false);
    const withdrew = updates.read().then(
      () => false,
      () => true,
    );
    withdrawn.profileSource.abort(
      Error('The native profile source was retired'),
    );
    expect(await live.receive()).toMatchObject({
      type: 'error',
      streamId: 'life',
    });
    expect(await withdrew).toBe(true);
    expect((await withdrawn.invoke(live.scopeId)).status).toBe(404);

    function expectEmptyDenial(output: string) {
      const denial = output
        .split(/\r\n(?=HTTP\/1\.1 )/)
        .find((response) => response.startsWith('HTTP/1.1 404'));
      expect(denial).toMatch(/\r\ncontent-length: 0\r\n/i);
      expect(denial?.split('\r\n\r\n')[1] ?? '').toBe('');
    }
    async function pipelineAfterEvents(
      id: string,
      {
        awaitingId,
        errors = false,
        unrelated = false,
        onlyAsset = false,
        bootstrap = false,
        beforeQueued,
        beforeNext,
      }: {
        awaitingId?: string;
        errors?: boolean;
        unrelated?: boolean;
        onlyAsset?: boolean;
        bootstrap?: boolean;
        beforeQueued?: () => void;
        beforeNext?: () => Promise<void>;
      } = {},
      subject = f,
    ) {
      const worker = subject.worker.address() as AddressInfo;
      const client = createConnection({ host: '127.0.0.1', port: worker.port });
      client.on('error', () => {});
      closes.push(async () => client.destroy());
      await once(client, 'connect', { signal: AbortSignal.timeout(5000) });
      const responses: ServerResponse[] = [];
      const observed = (_request: unknown, response: ServerResponse) =>
        responses.push(response);
      subject.worker.on('request', observed);
      let body = '';
      client.on('data', (data) => {
        body += data.toString();
      });
      const bindingRef = subject.owner.bindingRef;
      const events = subject.profileUrl('events', id, { bindingRef });
      const serialize = (url: URL, headers = '') =>
        `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${sessionToken}\r\n${headers}\r\n`;
      try {
        const head = unrelated
          ? new URL('/fixture-before-profile', events)
          : events;
        client.write(serialize(head));
        await expect.poll(() => body.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
        await expect
          .poll(() =>
            body.includes(
              unrelated
                ? 'unrelated handler still running'
                : 'text/event-stream',
            ),
          )
          .toBe(true);
        if (unrelated || errors) {
          const invalid = new URL(events);
          invalid.searchParams.append('scopeId', id);
          client.write(
            (unrelated ? '' : serialize(events)) + serialize(invalid),
          );
          await expect.poll(() => responses.length).toBe(unrelated ? 2 : 3);
        } else if (awaitingId) {
          const asset = subject.profileUrl('assets', awaitingId, {
            bindingRef,
            graphRev: target.graphRev,
            manifestSha256: target.manifestSha256,
            path: largeAsset,
          });
          const invalid = new URL(asset);
          invalid.searchParams.set('path', 'managed/absent.js');
          const document = subject.profileUrl('bootstrap', id);
          beforeQueued?.();
          client.write(
            (bootstrap
              ? serialize(subject.profileUrl('bootstrap', awaitingId))
              : serialize(asset, 'x-allrice-profile-request: static\r\n')) +
              (onlyAsset || bootstrap
                ? ''
                : serialize(invalid, 'x-allrice-profile-request: static\r\n')),
          );
          await beforeNext?.();
          client.write(
            serialize(document, 'x-allrice-profile-request: document\r\n'),
          );
          await expect
            .poll(() => responses.length)
            .toBe(onlyAsset || bootstrap ? 3 : 4);
        }
        for (const queued of responses.slice(beforeNext ? 2 : 1))
          await expect.poll(() => queued.listenerCount('socket')).toBe(1);
      } finally {
        subject.worker.off('request', observed);
      }
      return { responses, client, raw: () => body };
    }
    function holdSocket(response: ServerResponse) {
      const socket = response.socket!;
      const close = socket.destroy.bind(socket);
      let entered = false;
      const release = deferred();
      const hold = vi.spyOn(socket, 'destroy').mockImplementation((error) => {
        entered = true;
        void release.promise.then(() => close(error));
        return socket;
      });
      closes.push(async () => {
        hold.mockRestore();
        release.resolve();
      });
      return { fenced: () => entered, release, closed: once(socket, 'close') };
    }
  },
);
