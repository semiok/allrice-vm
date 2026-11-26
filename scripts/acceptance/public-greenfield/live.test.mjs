import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runBrowser } from './browser.mjs';
import {
  paths,
  publicOrigin,
  repo,
  repoId,
  requireFact,
} from './contracts.mjs';
import { publicDriver } from './live-driver.mjs';
import { createHelloProbe } from './live-native.mjs';
import { credentials, runLive } from './live.mjs';

const seal = 'sha256:' + 'c'.repeat(64);
const release = { sha: 'a'.repeat(40), tree: 'b'.repeat(40) };
const identity = {
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  personId: randomUUID(),
};
const account = {
  username: 'acceptance',
  password: 'fixture password must not appear',
};
const operationId = randomUUID();
const binding = {
  organizationId: identity.organizationId,
  personId: identity.personId,
  vmId: randomUUID(),
  instanceId: randomUUID(),
  leaseEpoch: 3,
};

async function withCredentials(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'greenfield-live-'));
  try {
    const path = join(directory, 'credentials.json');
    await writeFile(path, JSON.stringify({ ...identity, ...account }), {
      mode: 0o600,
    });
    await fn(path, directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function managedFixture() {
  function health(service) {
    const id = randomUUID();
    return () => ({
      status: 200,
      body: {
        status: 'ready',
        identity: {
          repository: repo,
          repositoryId: repoId,
          environment: 'dev',
          mode: 'production',
          service,
          bootId: id,
          sourceSha: release.sha,
          sourceTree: release.tree,
          manifestDigest: seal,
        },
      },
    });
  }
  const owner = {
    prepare: vi.fn(async () => ({
      role: '验收员',
      username: account.username,
      identity,
      state: 'zero-employee-no-vm',
      personScopedRelease: true,
    })),
    workerHealth: vi.fn(health('worker')),
    operationResult: vi.fn(async () => ({
      operationId,
      state: 'allocated',
      binding,
      carrierJoined: true,
    })),
    exactVm: vi.fn(async () => ({
      ...binding,
      state: 'stopped',
      diskRetained: true,
      unmounted: true,
      leaseReleased: true,
      portReleased: true,
    })),
    stopExact: vi.fn(async () => ({
      ...binding,
      state: 'stopped',
      diskRetained: true,
      accountRetained: true,
      unmounted: true,
      leaseReleased: true,
      portReleased: true,
    })),
    close: vi.fn(async () => {}),
  };
  return {
    owner,
    publicHealth: vi.fn(health('web')),
    ownerSource: vi.fn(async () => owner),
    preflight: () => ({
      mode: 'live',
      blockers: [],
      requestedRelease: release,
    }),
    browser: vi.fn(async (input) => {
      input.onColdTicket(operationId);
      input.receipt.browser.cold.prewarmRequests = 1;
      input.receipt.browser.cold.prewarmReady = true;
      input.receipt.browser.closed = true;
      input.receipt.browser.carrierJoined = true;
      input.receipt.stages.coldEditor = 'passed';
    }),
  };
}

it('reads only a private owned regular credential file', async () => {
  await withCredentials(async (path, directory) => {
    expect(credentials(path)).toEqual({ identity, account });
    const publicFile = join(directory, 'public.json');
    await writeFile(publicFile, '{}', { mode: 0o644 });
    expect(() => credentials(publicFile)).toThrow('private-file-mode');
    await symlink(path, join(directory, 'link.json'));
    expect(() => credentials(join(directory, 'link.json'))).toThrow();
  });
});

it('checks the managed owner before reading credentials or calling the public origin', async () => {
  const fixture = managedFixture();
  fixture.ownerSource.mockRejectedValue(new Error('owner private error'));
  const receipt = await runLive(
    { ownerPath: '/test.mjs', credentialPath: '/unreadable', seal },
    fixture,
  );
  expect(receipt).toMatchObject({
    status: 'blocked',
    firstFailure: { stage: 'managedOwner' },
  });
  expect(fixture.publicHealth).not.toHaveBeenCalled();
  expect(JSON.stringify(receipt)).not.toContain('owner private error');
});

it('rejects changed bytes in a private owner module before executing it', async () => {
  await withCredentials(async (credentialPath, directory) => {
    const fixture = managedFixture();
    const ownerPath = join(directory, 'owner.mjs');
    await writeFile(
      ownerPath,
      'throw new Error("unapproved module executed");',
      { mode: 0o600 },
    );
    const receipt = await runLive(
      { ownerPath, ownerDigest: '0'.repeat(64), credentialPath, seal },
      { ...fixture, ownerSource: undefined },
    );
    expect(receipt).toMatchObject({
      status: 'blocked',
      firstFailure: {
        stage: 'managedOwner',
        code: 'managed-owner-digest-mismatch',
      },
    });
    expect(fixture.publicHealth).not.toHaveBeenCalled();
  });
});

it('joins only the VM tied to the observed ticket and retains its disk and account', async () => {
  await withCredentials(async (credentialPath) => {
    const fixture = managedFixture();
    const receipt = await runLive(
      { ownerPath: '/test.mjs', credentialPath, seal },
      fixture,
    );
    expect(receipt).toMatchObject({
      status: 'passed',
      firstFailure: null,
      cleanup: { status: 'stopped', diskRetained: true, accountRetained: true },
    });
    expect(fixture.owner.operationResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ operationId, identity }),
    );
    expect(fixture.owner.stopExact).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ binding }),
    );
    expect(fixture.owner.close).toHaveBeenCalledOnce();
    const evidence = JSON.stringify(receipt);
    for (const secret of [
      binding.instanceId,
      account.password,
      account.username,
      operationId,
    ]) {
      expect(evidence).not.toContain(secret);
    }
  });
});

it('keeps the browser first failure and refuses to stop a replacement VM', async () => {
  await withCredentials(async (credentialPath) => {
    const fixture = managedFixture();
    fixture.owner.exactVm.mockResolvedValue({ ...binding, leaseEpoch: 4 });
    fixture.browser.mockImplementation(
      async ({ onColdTicket, receipt, fail }) => {
        receipt.browser.closed = true;
        receipt.browser.cold.prewarmRequests = 1;
        onColdTicket(operationId);
        fail('coldEditor', new Error('browser detail must not appear'));
        throw new Error('raw browser diagnostic');
      },
    );
    const receipt = await runLive(
      { ownerPath: '/test.mjs', credentialPath, seal },
      fixture,
    );
    expect(receipt).toMatchObject({
      status: 'failed',
      firstFailure: { stage: 'coldEditor' },
      cleanup: {
        status: 'failed',
        failure: { code: 'cleanup-target-changed' },
      },
    });
    expect(fixture.owner.stopExact).not.toHaveBeenCalled();
    expect(fixture.owner.close).toHaveBeenCalledOnce();
  });
});

it('records the send intent after rechecking the assigned running instance', async () => {
  await withCredentials(async (credentialPath) => {
    const fixture = managedFixture();
    fixture.owner.exactVm.mockResolvedValueOnce({
      ...binding,
      state: 'running',
    });
    const recordHelloIntent = vi.fn();
    const coldBrowser = fixture.browser.getMockImplementation();
    fixture.browser.mockImplementation(async (input) => {
      await coldBrowser(input);
      await input.beforeHello();
      expect(recordHelloIntent).toHaveBeenCalledOnce();
      input.receipt.stages.hello = 'passed';
    });
    const receipt = await runLive(
      { ownerPath: '/test.mjs', credentialPath, seal, sendHello: true },
      { ...fixture, recordHelloIntent },
    );
    expect(receipt.status).toBe('passed');
    expect(fixture.owner.workerHealth).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(recordHelloIntent.mock.calls)).not.toContain(
      operationId,
    );
  });
});

it('retains the interruption and attempts only the corresponding joined cleanup', async () => {
  await withCredentials(async (credentialPath) => {
    const fixture = managedFixture();
    const cancellation = new globalThis.AbortController();
    const coldBrowser = fixture.browser.getMockImplementation();
    fixture.browser.mockImplementation(async (input) => {
      await coldBrowser(input);
      cancellation.abort();
    });
    const receipt = await runLive(
      {
        ownerPath: '/test.mjs',
        credentialPath,
        seal,
        signal: cancellation.signal,
      },
      fixture,
    );
    expect(receipt).toMatchObject({
      status: 'failed',
      firstFailure: { code: 'acceptance-interrupted' },
      cleanup: { status: 'stopped' },
    });
    expect(fixture.owner.stopExact).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ binding }),
    );
    expect(fixture.owner.close).toHaveBeenCalledOnce();
  });
});

it('gives the live CLI exclusive ownership of Chromium interrupt signals', async () => {
  const launch = vi.fn(async () => {
    throw new Error('test before Chromium starts');
  });
  await expect(
    runBrowser({ launch, onColdTicket: () => {}, driver: {} }),
  ).rejects.toThrow('test before Chromium starts');
  expect(launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      handleSIGINT: false,
      handleSIGTERM: false,
    }),
  );
});

it('the public transport forwards only inspected traffic, with no redirects or retries', async () => {
  let handle;
  const fail = vi.fn();
  await publicDriver().install(
    {
      route: async (_url, callback) => {
        handle = callback;
      },
      routeWebSocket: async () => {},
    },
    {
      inspect: async ({ url }, dispatch) => {
        requireFact(url.origin === publicOrigin, 'origin-blocked');
        return dispatch();
      },
      fail,
    },
  );
  const response = {
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => ({ private: 'body' }),
    dispose: vi.fn(async () => {}),
  };
  const route = {
    request: () => ({
      method: () => 'GET',
      url: () => publicOrigin + paths.identity,
      headerValue: async () => null,
    }),
    fetch: vi.fn(async () => response),
    fulfill: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  await handle(route);
  expect(route.fetch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ maxRedirects: 0, maxRetries: 0 }),
  );
  expect(route.fulfill).toHaveBeenCalledExactlyOnceWith({ response });
  await handle({
    ...route,
    request: () => ({
      ...route.request(),
      url: () => 'https://example.invalid/',
    }),
  });
  expect(route.fetch).toHaveBeenCalledOnce();
  expect(route.abort).toHaveBeenCalledOnce();
  expect(fail).toHaveBeenCalledOnce();
});

it('forwards admitted native read streams and blocks unexpected uplink mutations', async () => {
  let connect;
  const fail = vi.fn();
  const observeFollow = vi.fn();
  await publicDriver().install(
    {
      route: async () => {},
      routeWebSocket: async (_url, callback) => {
        connect = callback;
      },
    },
    { muxRole: () => 'streams', observeFollow, fail },
  );
  let clientMessage;
  let serverMessage;
  const server = {
    onMessage: (callback) => {
      serverMessage = callback;
    },
    send: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const socket = {
    url: () => 'wss://allricevm.bplabs.xyz' + paths.mux,
    connectToServer: () => server,
    onMessage: (callback) => {
      clientMessage = callback;
    },
    send: vi.fn(),
    close: vi.fn(async () => {}),
  };
  connect(socket);
  const streamId = randomUUID();
  const open = JSON.stringify({
    type: 'open',
    endpoint: 'session/follow',
    streamId,
    payload: {
      args: {
        request: { address: { kind: 'session', sessionId: 'bound-root' } },
      },
    },
  });
  clientMessage(open);
  expect(server.send).toHaveBeenCalledExactlyOnceWith(open);
  const reply = JSON.stringify({
    type: 'item',
    streamId,
    value: { type: 'event' },
  });
  serverMessage(reply);
  expect(observeFollow).toHaveBeenCalledExactlyOnceWith('bound-root', {
    type: 'event',
  });
  expect(socket.send).toHaveBeenCalledExactlyOnceWith(reply);
  clientMessage(JSON.stringify({ type: 'item', streamId, value: 'write' }));
  expect(server.send).toHaveBeenCalledOnce();
  expect(fail).toHaveBeenCalledOnce();
  expect(socket.close).toHaveBeenCalledOnce();
});

it('allows one exact 你好 prompt and attributes reply timing only to its native turn', async () => {
  const receipt = { timings: {} };
  const probe = createHelloProbe(receipt);
  const root = 'native-session';
  const requestId = randomUUID();
  const body = (text) => ({
    rpcId: 'rpc-once',
    payload: {
      args: {
        request: {
          sessionId: root,
          requestId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
      },
    },
  });
  expect(() => probe.dispatch(body('你好'))).toThrow('hello-prompt-blocked');
  probe.arm(root);
  expect(() => probe.dispatch(body('再见'))).toThrow('hello-prompt-blocked');
  const rpc = probe.dispatch(body('你好'));
  expect(() => probe.dispatch(body('你好'))).toThrow('hello-prompt-blocked');
  const event = (type, data) => ({ type: 'event', event: { type, data } });
  probe.follow(
    'other-session',
    event('assistant/message', {
      turn: 1,
      message: { content: [{ type: 'text', text: 'ignore' }] },
    }),
  );
  probe.accept(rpc, {
    status: 200,
    json: {
      type: 'server-response',
      rpcId: rpc,
      result: { ok: true, value: { accepted: true } },
    },
  });
  probe.follow(root, event('turn/start', { turn: 2 }));
  probe.follow(
    root,
    event('user/message', { source: { kind: 'user', rpcId: requestId } }),
  );
  probe.follow(
    root,
    event('assistant/message', {
      turn: 2,
      message: { content: [{ type: 'text', text: 'private reply' }] },
    }),
  );
  probe.follow(
    root,
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
  );
  expect(await probe.boundTurn).toBe(2);
  await probe.complete;
  expect(receipt).toMatchObject({
    hello: { dispatched: true, accepted: true, replyObserved: true },
    timings: {
      helloToNativeTurnEndMs: expect.any(Number),
    },
  });
  expect(JSON.stringify(receipt)).not.toContain('private reply');
});
