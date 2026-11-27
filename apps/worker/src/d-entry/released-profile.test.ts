import { createHash, randomUUID } from 'node:crypto';
import type * as NativeFs from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Agent, ClientRequest, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  deferred,
  hostFixture,
  issue,
} from '../../../../packages/d-entry-principal/test/host-fixture.js';
import { createDEntryPrincipalControl } from './principal-control.js';
import { DEntryProfileGraphSchema } from '@allrice/contracts';
import { expect, it, vi } from 'vitest';
import { holdReleasedProfile } from './released-profile.js';

const authStage = vi.hoisted(() => ({
  afterWrite: undefined as ((filename: string) => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (load) => {
  const fs = await load<typeof NativeFs>();
  return {
    ...fs,
    async writeFile(...args: Parameters<typeof fs.writeFile>) {
      await fs.writeFile(...args);
      if (typeof args[0] === 'string') await authStage.afterWrite?.(args[0]);
    },
  };
});

async function waitForAuthNonce(path: string, nonce: string) {
  await expect
    .poll(async () => {
      const value = await readFile(path, 'utf8').catch(() => undefined);
      return value === undefined ? undefined : JSON.parse(value).nonce;
    })
    .toBe(nonce);
}

type ObserverWebServer = {
  readonly host: string;
  readonly port: number | undefined;
  getOrigin(): string;
  registerUpgrade(route: {
    path: string;
    handler(
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ): void | Promise<void>;
  }): () => void;
};

async function installObserverWeb(
  host: Context,
  source: NodeRequire,
  manual = false,
  listenHost = '127.0.0.1',
) {
  let committed = false;
  const listeners = new Set<() => void>();
  host.provide('appReady', {
    onReady(listener: () => void) {
      if (committed) listener();
      else listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const resolve = createRequire(source.resolve('@deepseek-ai/dsh-web-app'));
  const { WebServer } = await import(
    pathToFileURL(resolve.resolve('@deepseek-ai/dsh-host-webserver')).href
  );
  await host.plugin(WebServer, { host: listenHost, port: 0 });
  function commit(reverse = false) {
    committed = true;
    const pending = [...listeners];
    for (const listener of reverse ? pending.reverse() : pending) listener();
    listeners.clear();
  }
  if (!manual) commit();
  const server = host.get('webServer') as ObserverWebServer | undefined;
  if (!server?.port) throw Error('DSH did not bind the web server');
  return {
    commit,
    pendingReady: () => listeners.size,
    server,
    baseUrl: `http://127.0.0.1:${server.port}/`,
  };
}

async function observerFixture(options?: {
  loader?: boolean;
  graphEvents?: boolean;
  manualReady?: boolean;
  beforeLoader?: () => Promise<void>;
  listenHost?: string;
  storedWorkSessions?: boolean;
  commandMemory?: {
    subprocess: 'missing' | 'stock' | 'managed';
    sandbox: 'missing' | 'owned' | 'unrelated';
  };
}) {
  const directory = await mkdtemp(join(tmpdir(), 'allrice-observer-'));
  const local = await hostFixture(issue('execute'), true, null);
  const nativeWorkspaceId = randomUUID();
  const workspaceSessions = ['already-attached'];
  const attachSession = vi.fn(async (id: string) => {
    workspaceSessions.push(id);
  });
  local.host.provide('workspaceRegistry', {
    async create(path: string) {
      return {
        id: nativeWorkspaceId,
        path,
        sessionIds: workspaceSessions,
        attachSession,
      };
    },
  });
  local.host.provide('sessionPersistence', {
    async list() {
      return options?.storedWorkSessions
        ? [
            { header: { id: 'already-attached', cwd: directory } },
            { header: { id: 'retained', cwd: directory } },
            {
              header: { id: 'other-workspace', cwd: join(directory, 'other') },
            },
          ]
        : [];
    },
  });
  const lifetime = new AbortController().signal;
  const control = createDEntryPrincipalControl(local.node, {
    carrier: lifetime,
    cleanupTimeoutMs: 3000,
  });
  const owner = await import(
    new URL('../../dsh/allrice-native-web-owner.mjs', import.meta.url).href
  );
  const artifacts = join(directory, 'guest-auth.json');
  const install = createRequire(
    new URL(
      '../../../../packages/dsh-web-composition/package.json',
      import.meta.url,
    ),
  );
  const native = await import(
    pathToFileURL(install.resolve('@deepseek-ai/dsh-client-modules')).href
  );
  let loader;
  if (options?.loader) {
    const fromBoot = createRequire(
      install.resolve('@deepseek-ai/dsh-app-boot'),
    );
    const plugin = await import(
      pathToFileURL(fromBoot.resolve('@deepseek-ai/cordis-plugin-loader')).href
    );
    await local.host.plugin(plugin.default);
    loader = local.host.get('loader');
  } else
    local.host.provide('loader', {
      entries: () => [],
      async await() {
        await options?.beforeLoader?.();
      },
    });
  const web = await installObserverWeb(
    local.host,
    install,
    options?.manualReady,
    options?.listenHost,
  );
  const commandMemory = options?.commandMemory;
  const commandMemoryPlugin =
    'file:///opt/allrice/command-memory/fixture/dsh-command-memory.mjs';
  const commands =
    commandMemory &&
    local.host.plugin(async (ctx: Context) => {
      Object.defineProperty(ctx.fiber, 'entry', {
        value: { options: { name: commandMemoryPlugin } },
      });
      if (commandMemory.subprocess !== 'missing')
        ctx.provide('subprocess', {
          [Symbol.for('allrice.person-vm-command-memory.ready')]:
            commandMemory.subprocess === 'managed',
        });
      if (commandMemory.sandbox === 'owned')
        await ctx.plugin((scoped: Context) => {
          scoped.provide('sandbox', { confine() {} });
        });
    });
  if (commandMemory?.sandbox === 'unrelated')
    local.host.provide('sandbox', { confine() {} });
  if (commands) await commands;
  const callbacks = new Set<() => void>();
  if (options?.graphEvents) {
    local.host.provide('clientModules', {
      graph: () => ({ rev: 'fixture-current-graph' }),
      onGraphChanged(listener: () => void) {
        callbacks.add(listener);
        return () => {
          callbacks.delete(listener);
        };
      },
    });
  } else await local.host.plugin(native.ClientModuleRegistry);
  const mount = (nonce: string, entered?: () => void) =>
    local.host.plugin({
      inject: owner.inject,
      apply(ctx: Context) {
        const applying = owner.apply(ctx, {
          artifactPath: artifacts,
          nonce,
          baseUrl: web.baseUrl,
          workdir: directory,
          ...(commandMemory ? { commandMemoryPlugin } : {}),
        });
        entered?.();
        return applying;
      },
    });
  return {
    directory,
    local,
    owner,
    artifacts,
    attachSession,
    commands,
    mount,
    loader,
    web,
    graphChanged() {
      for (const callback of callbacks) callback();
    },
    async open(scopeId = randomUUID()) {
      return control
        .acquire({ ...local.selected, scopeId }, lifetime)
        .run(lifetime);
    },
    async close() {
      await Promise.allSettled([control.close()]);
      await local.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('repairs only previously unattached sessions in the employee work directory before auth', async () => {
  const f = await observerFixture({ storedWorkSessions: true });
  try {
    await f.mount('retained-workspace');
    await waitForAuthNonce(f.artifacts, 'retained-workspace');
    expect(f.attachSession.mock.calls).toEqual([['retained']]);
  } finally {
    await f.close();
  }
});

it('keeps the nonce private through appReady dispatch, loader settlement and actual mux registration', async () => {
  const entered = deferred(),
    settle = deferred();
  const f = await observerFixture({
    manualReady: true,
    async beforeLoader() {
      entered.resolve();
      await settle.promise;
    },
  });
  const register = vi.spyOn(f.web.server, 'registerUpgrade');
  try {
    const discarded = f.mount('stop-before-ready');
    await discarded; // Cordis apply settles without boot's readiness callback.
    await expect.poll(f.web.pendingReady).toBe(2);
    await f.owner.unloadNativeWebOwner(discarded);
    expect(f.web.pendingReady()).toBe(1);
    expect(register).not.toHaveBeenCalled();
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const incumbent = f.mount('current-startup');
    await incumbent;
    await expect.poll(f.web.pendingReady).toBe(2);
    f.web.commit(true); // Even if this owner's listener ran before the mux listener.
    await entered.promise;
    expect(register).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ path: '/api/remote.mux' }),
    );
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(f.open()).rejects.toBeDefined();
    settle.resolve();
    await waitForAuthNonce(f.artifacts, 'current-startup');
    expect((await f.open()).opened.baseline.owner).toBe(false);
    await f.owner.unloadNativeWebOwner(incumbent);

    const remounted = f.mount('already-committed-app');
    await waitForAuthNonce(f.artifacts, 'already-committed-app');
    expect((await f.open()).opened.baseline.owner).toBe(false);
    await f.owner.unloadNativeWebOwner(remounted);
    expect(register).toHaveBeenCalledTimes(1);
  } finally {
    settle.resolve();
    register.mockRestore();
    await f.close();
  }
});

it.each(['missing', 'stock', 'no-sandbox', 'unrelated-sandbox'] as const)(
  'withholds native auth when the required command memory providers are %s',
  async (missing) => {
    const f = await observerFixture({
      commandMemory: {
        subprocess:
          missing === 'missing' || missing === 'stock' ? missing : 'managed',
        sandbox:
          missing === 'no-sandbox'
            ? 'missing'
            : missing === 'unrelated-sandbox'
              ? 'unrelated'
              : 'owned',
      },
    });
    try {
      const active = f.mount('incomplete-command-memory');
      await active;
      await expect
        .poll(() => Reflect.get(f.local.host.allricePrincipal, 'graphObserver'))
        .toBeUndefined();
      await expect(f.owner.unloadNativeWebOwner(active)).rejects.toThrow(
        'Native command memory controls are unavailable',
      );
      await expect(readFile(f.artifacts)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(f.open()).rejects.toBeDefined();
    } finally {
      await f.close();
    }
  },
);

it('retires published native auth if the required command memory providers disappear', async () => {
  const f = await observerFixture({
    commandMemory: { subprocess: 'managed', sandbox: 'owned' },
  });
  try {
    const active = f.mount('managed-command-memory');
    await waitForAuthNonce(f.artifacts, 'managed-command-memory');
    expect((await f.open()).opened.baseline.owner).toBe(false);
    if (!f.commands) throw Error('Command memory fixture was not mounted');
    await f.commands.dispose();
    await expect
      .poll(() => readFile(f.artifacts).catch((error) => error.code))
      .toBe('ENOENT');
    await expect(f.open()).rejects.toBeDefined();
    await f.owner.unloadNativeWebOwner(active);
  } finally {
    await f.close();
  }
});

it('reports the real startup transport fault without publishing when the mux was not installed', async () => {
  const f = await observerFixture({ manualReady: true });
  const register = vi
    .spyOn(f.web.server, 'registerUpgrade')
    .mockReturnValue(() => {});
  try {
    const active = f.mount('unregistered-mux');
    await active;
    await expect.poll(f.web.pendingReady).toBe(2);
    f.web.commit();
    await expect
      .poll(() => Reflect.get(f.local.host.allricePrincipal, 'graphObserver'))
      .toBeUndefined();
    expect(register).toHaveBeenCalledTimes(1);
    await expect(f.owner.unloadNativeWebOwner(active)).rejects.toMatchObject({
      code: 'ECONNRESET',
    });
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(f.open()).rejects.toBeDefined();
  } finally {
    register.mockRestore();
    await f.close();
  }
});

it('addresses the actual IPv6-bound mux with its unmodified interface zone', async () => {
  const internal = Object.entries(networkInterfaces()).flatMap(
    ([name, interfaces]) =>
      (interfaces ?? [])
        .filter((address) => address.family === 'IPv6' && address.internal)
        .map(({ address }) => ({ name, address: address.split('%')[0] })),
  );
  const linkLocal = internal.find(({ address }) =>
    address?.startsWith('fe80:'),
  );
  const scoped = linkLocal ?? internal.find(({ address }) => address === '::1');
  if (!scoped) throw Error('The test host has no IPv6 loopback interface');
  const listenHost = `${scoped.address}%${scoped.name}`;
  const f = await observerFixture({ listenHost });
  const connect = vi.spyOn(Agent.prototype, 'createConnection');
  try {
    expect(f.web.server.host).toBe(listenHost);
    if (linkLocal)
      expect(() => f.web.server.getOrigin()).toThrow('interface zone id');
    const active = f.mount('scoped-listener');
    await waitForAuthNonce(f.artifacts, 'scoped-listener');
    expect(connect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        hostname: listenHost,
        port: f.web.server.port,
      }),
      expect.any(Function),
    );
    expect((await f.open()).opened.baseline.owner).toBe(false);
    await f.owner.unloadNativeWebOwner(active);
  } finally {
    connect.mockRestore();
    await f.close();
  }
});

it('joins the single anonymous Upgrade on retirement before permitting new publication', async () => {
  const f = await observerFixture({ manualReady: true });
  const arrived = deferred<IncomingMessage>();
  const disconnected = deferred();
  const requestClose = deferred();
  const physicalClose = deferred();
  const acknowledge = deferred();
  let probeSocket: Duplex | undefined;
  const emit = ClientRequest.prototype.emit;
  const requestEvents = vi
    .spyOn(ClientRequest.prototype, 'emit')
    .mockImplementation(function (this: ClientRequest, ...args) {
      const result = emit.apply(this, args);
      if (args[0] === 'close' && this.socket === probeSocket)
        requestClose.resolve();
      return result;
    });
  const connect = Agent.prototype.createConnection;
  const capture = vi
    .spyOn(Agent.prototype, 'createConnection')
    .mockImplementation(function (this: Agent, ...args) {
      const socket = connect.apply(this, args);
      if (!socket) throw Error('The real probe socket was not allocated');
      probeSocket = socket;
      capture.mockRestore();
      const once = socket.once.bind(socket);
      const confirm = vi
        .spyOn(socket, 'once')
        .mockImplementation((event, listener) => {
          if (event !== 'close') return once(event, listener);
          confirm.mockRestore();
          return once('close', (...args: unknown[]) => {
            physicalClose.resolve();
            void acknowledge.promise.then(() => listener(...args));
          });
        });
      return socket;
    });
  const registerUpgrade = f.web.server.registerUpgrade.bind(f.web.server);
  let probes = 0;
  const register = vi
    .spyOn(f.web.server, 'registerUpgrade')
    .mockImplementation((route: Parameters<typeof registerUpgrade>[0]) => {
      return registerUpgrade({
        ...route,
        handler(req: IncomingMessage, socket: Duplex, head: Buffer) {
          if (++probes !== 1) return route.handler(req, socket, head);
          socket.once('close', () => disconnected.resolve());
          socket.once('end', () => socket.end());
          socket.resume();
          arrived.resolve(req);
          // Leave the actual accepted Upgrade in flight until the owner cancels.
        },
      });
    });
  try {
    const active = f.mount('obsolete-probe');
    await active;
    f.web.commit();
    const request = await arrived.promise;
    expect(request.method).toBe('GET');
    expect(request.url).toBe('/api/remote.mux');
    expect(request.headers.upgrade).toBe('websocket');
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const retiring: Promise<void> = f.owner.unloadNativeWebOwner(active);
    let retired = false;
    void retiring.then(
      () => (retired = true),
      () => (retired = true),
    );
    // Real socket close was dispatched. Only the owner's acknowledgement is
    // held, so a return based solely on ClientRequest.close can settle now.
    await Promise.all([requestClose.promise, physicalClose.promise]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(retired).toBe(false);
    acknowledge.resolve();
    await retiring;
    await disconnected.promise;
    expect(probes).toBe(1);
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const restored = f.mount('current-probe');
    await waitForAuthNonce(f.artifacts, 'current-probe');
    expect((await f.open()).opened.baseline.owner).toBe(false);
    await f.owner.unloadNativeWebOwner(restored);
    expect(probes).toBe(2);
  } finally {
    acknowledge.resolve();
    requestEvents.mockRestore();
    capture.mockRestore();
    register.mockRestore();
    await f.close();
  }
});

it('reports an atomic publication failure, cleans staging and lets a new owner start on the same Host', async () => {
  const f = await observerFixture();
  const staged = deferred<string>();
  try {
    // A file cannot be atomically renamed over this directory. The temporary
    // file itself is written normally, so its observed removal proves cleanup.
    await mkdir(f.artifacts);
    authStage.afterWrite = async (filename) => {
      if (filename.startsWith(`${f.artifacts}.`)) staged.resolve(filename);
    };
    const failed = f.mount('failed-publication');
    const temporary = await staged.promise;
    await expect
      .poll(() => Reflect.get(f.local.host.allricePrincipal, 'graphObserver'))
      .toBeUndefined();
    await expect(f.owner.unloadNativeWebOwner(failed)).rejects.toMatchObject({
      code: 'EISDIR',
      syscall: 'rename',
      path: temporary,
      dest: f.artifacts,
    });
    await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(f.artifacts)).isDirectory()).toBe(true);
    await expect(f.open()).rejects.toBeDefined();

    authStage.afterWrite = undefined;
    await rm(f.artifacts, { recursive: true });
    const successor = f.mount('publication-recovered');
    await waitForAuthNonce(f.artifacts, 'publication-recovered');
    expect((await f.open()).opened.baseline.owner).toBe(false);
    await f.owner.unloadNativeWebOwner(successor);
  } finally {
    authStage.afterWrite = undefined;
    await f.close();
  }
});

it('keeps the first graph withdrawal terminal failure after its scope leaves the Host', async () => {
  const f = await observerFixture({ graphEvents: true });
  const writingClosed = deferred();
  const finishWrite = deferred();
  const broken = Error('old control downlink refused the terminal item');
  try {
    const previous = f.mount('graph-owner');
    await waitForAuthNonce(f.artifacts, 'graph-owner');
    const wire = f.local.host.typertGateway.wireStream;
    const open = wire.open.bind(wire);
    let first = true;
    vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
      const source = await open(...args);
      if (args[0] !== 'allricePrincipal/openScope' || !first) return source;
      first = false;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const row of source) {
            if (Reflect.get(row as object, 'type') === 'closed') {
              writingClosed.resolve();
              await finishWrite.promise;
              throw broken;
            }
            yield row;
          }
        },
      };
    });
    const scopeId = randomUUID();
    const page = await f.open(scopeId);
    const service = f.local.host.allricePrincipal;
    const terminal = [...service['scopeControls']][0]!;
    const rightFailure = terminal.catch((error: unknown) => error);
    f.graphChanged();
    await writingClosed.promise;
    expect(page.revoked.aborted).toBe(true);
    expect(service.scopes.has(scopeId)).toBe(false);
    finishWrite.resolve();
    const original = await rightFailure;
    expect(original).toBeInstanceOf(Error);
    expect(service['scopeControls'].size).toBe(0);
    await expect(f.owner.unloadNativeWebOwner(previous)).rejects.toBe(original);
    const successor = f.mount('cannot-overtake-failed-control');
    await successor;
    await expect(f.owner.unloadNativeWebOwner(successor)).rejects.toBe(
      original,
    );
    await expect(f.open()).rejects.toBeDefined();
  } finally {
    finishWrite.resolve();
    await f.close();
  }
});

it('retains the real staging removal failure even when disposal canceled publication', async () => {
  const f = await observerFixture();
  const staging = deferred<string>();
  const release = deferred();
  try {
    authStage.afterWrite = async (filename) => {
      if (!filename.startsWith(f.artifacts + '.')) return;
      staging.resolve(filename);
      await release.promise;
    };
    const owner = f.mount('staging-cleanup-failure');
    const temporary = await staging.promise;
    await rm(temporary);
    await mkdir(temporary);
    const stopped = f.owner.unloadNativeWebOwner(owner);
    void stopped.catch(() => {});
    await expect(f.open()).rejects.toBeDefined();
    release.resolve();
    const error = await stopped.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'ERR_FS_EISDIR', path: temporary });
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const successor = f.mount('staged-owner-failure-successor');
    await successor;
    await expect(f.owner.unloadNativeWebOwner(successor)).rejects.toBe(error);
    await expect(f.open()).rejects.toBeDefined();
  } finally {
    release.resolve();
    authStage.afterWrite = undefined;
    await f.close();
  }
});

it('replaces a real Cordis loader entry updated during auth staging without publishing its old nonce', async () => {
  const f = await observerFixture({ loader: true });
  const neighbor = await hostFixture();
  const signal = new AbortController().signal;
  const control = createDEntryPrincipalControl(neighbor.node, {
    carrier: signal,
    cleanupTimeoutMs: 3000,
  });
  const staging = deferred();
  const release = deferred();
  const newArtifact = join(f.directory, 'replacement-auth.json');
  try {
    const other = await control.acquire(neighbor.selected, signal).run(signal);
    const loader = f.loader!;
    loader.builtins['observer-test-owner'] = {
      inject: f.owner.inject,
      apply: f.owner.apply,
    };
    authStage.afterWrite = async (filename) => {
      if (!filename.startsWith(f.artifacts + '.')) return;
      staging.resolve();
      await release.promise;
    };
    const baseUrl = f.web.baseUrl;
    const id = await loader.create({
      name: 'cordis:observer-test-owner',
      config: {
        artifactPath: f.artifacts,
        nonce: 'old',
        baseUrl,
        workdir: f.directory,
      },
    });
    const entry = loader.resolve(id)!;
    const exactFiber = entry.fiber!;
    await staging.promise;
    await entry.update({
      config: {
        artifactPath: newArtifact,
        nonce: 'new',
        baseUrl,
        workdir: f.directory,
      },
    });
    expect(entry.fiber).toBe(exactFiber);
    await expect(f.open()).rejects.toBeDefined();
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(other.revoked.aborted).toBe(false);
    release.resolve();
    await waitForAuthNonce(newArtifact, 'new');
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(entry.fiber).toBe(exactFiber);
    expect((await f.open()).opened.baseline.owner).toBe(false);
    expect(other.revoked.aborted).toBe(false);
    await f.owner.unloadNativeWebOwner(exactFiber);
  } finally {
    release.resolve();
    authStage.afterWrite = undefined;
    await Promise.allSettled([f.close(), control.close()]);
    await neighbor.close();
  }
});

it('retirement waits for the real old control downlink and a disposed waiter cannot publish', async () => {
  const f = await observerFixture();
  const neighbor = await hostFixture();
  const signal = new AbortController().signal;
  const other = createDEntryPrincipalControl(neighbor.node, {
    carrier: signal,
    cleanupTimeoutMs: 3000,
  });
  const firstDelivery = deferred();
  const finishDelivery = deferred();
  const finalDelivery = deferred();
  const finishFinal = deferred();
  try {
    const previous = f.mount('first-owner');
    await waitForAuthNonce(f.artifacts, 'first-owner');
    const scopeId = randomUUID();
    const wire = f.local.host.typertGateway.wireStream;
    const open = wire.open.bind(wire);
    let watched = false;
    vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
      const source = await open(...args);
      if (args[0] !== 'allricePrincipal/openScope' || watched) return source;
      watched = true;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const row of source) {
            if (Reflect.get(row as object, 'type') === 'revoked') {
              firstDelivery.resolve();
              await finishDelivery.promise;
            }
            if (Reflect.get(row as object, 'type') === 'closed') {
              finalDelivery.resolve();
              await finishFinal.promise;
            }
            yield row;
          }
        },
      };
    });
    const opened = await f.open(scopeId);
    const unaffected = await other
      .acquire(neighbor.selected, signal)
      .run(signal);
    let retired = false;
    const stopping = f.owner.unloadNativeWebOwner(previous).then(() => {
      retired = true;
    });
    void stopping.catch(() => {});
    await firstDelivery.promise;
    await expect
      .poll(() => f.local.host.allricePrincipal.scopes.has(scopeId))
      .toBe(false);
    expect(opened.revoked.aborted).toBe(false);
    expect(retired).toBe(false);

    const loading = deferred();
    const canceled = f.mount('canceled-owner', loading.resolve);
    await loading.promise;
    const disposedWhileLoading = canceled.dispose();
    await expect(f.open()).rejects.toBeDefined();
    const ready = deferred();
    const successor = f.mount('successor', ready.resolve);
    await ready.promise;
    let restarted = false;
    const published = waitForAuthNonce(f.artifacts, 'successor').then(() => {
      restarted = true;
    });
    void published.catch(() => {});
    expect(restarted).toBe(false);
    expect(unaffected.revoked.aborted).toBe(false);

    finishDelivery.resolve();
    await finalDelivery.promise;
    await expect.poll(() => opened.revoked.aborted).toBe(true);
    expect(retired).toBe(false);
    expect(restarted).toBe(false);
    await expect(f.open()).rejects.toBeDefined();
    finishFinal.resolve();
    await stopping;
    await disposedWhileLoading;
    await published;
    expect(JSON.parse(await readFile(f.artifacts, 'utf8')).nonce).toBe(
      'successor',
    );
    expect((await f.open()).opened.baseline.owner).toBe(false);
    expect(unaffected.revoked.aborted).toBe(false);
    await f.owner.unloadNativeWebOwner(successor);
  } finally {
    finishDelivery.resolve();
    finishFinal.resolve();
    await Promise.allSettled([other.close(), f.close()]);
    await neighbor.close();
  }
});

it('a Cordis owner disposed during actual local auth staging issues no scope and commits no nonce', async () => {
  const f = await observerFixture();
  const staging = deferred();
  const finish = deferred();
  try {
    authStage.afterWrite = async (filename) => {
      if (!filename.startsWith(f.artifacts + '.')) return;
      staging.resolve();
      await finish.promise;
    };
    const loading = f.mount('staged-but-disposed');
    await staging.promise;
    // The actual staging write returned from the filesystem while the rename
    // and enablement remain governed by this Cordis activation.
    const disposing = loading.dispose();
    await expect(f.open()).rejects.toBeDefined();
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    finish.resolve();
    await disposing;
    await expect(readFile(f.artifacts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(f.open()).rejects.toBeDefined();
    const fresh = f.mount('next-owner');
    await waitForAuthNonce(f.artifacts, 'next-owner');
    expect(JSON.parse(await readFile(f.artifacts, 'utf8')).nonce).toBe(
      'next-owner',
    );
    expect((await f.open()).opened.baseline.owner).toBe(false);
    await f.owner.unloadNativeWebOwner(fresh);
  } finally {
    finish.resolve();
    authStage.afterWrite = undefined;
    await f.close();
  }
});

it('returns the real local retirement failure to an explicit unloader and keeps the same Host closed', async () => {
  const f = await observerFixture();
  try {
    const previous = f.mount('owner-with-failing-cleanup');
    await waitForAuthNonce(f.artifacts, 'owner-with-failing-cleanup');
    await rm(f.artifacts);
    await mkdir(f.artifacts);
    await expect(f.owner.unloadNativeWebOwner(previous)).rejects.toMatchObject({
      code: 'ERR_FS_EISDIR',
      path: f.artifacts,
    });
    const successor = f.mount('must-not-issue');
    await successor;
    await expect(f.owner.unloadNativeWebOwner(successor)).rejects.toMatchObject(
      {
        code: 'ERR_FS_EISDIR',
        path: f.artifacts,
      },
    );
    await expect(f.open()).rejects.toBeDefined();
  } finally {
    await f.close();
  }
});

it('attests each exact resource in independent rc.2 graph orders and rejects a modified bundle, map or URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allrice-native-profile-copies-'));
  const install = createRequire(
    new URL(
      '../../../../packages/dsh-web-composition/package.json',
      import.meta.url,
    ),
  );
  const api = await import(
    pathToFileURL(install.resolve('@deepseek-ai/dsh-client-modules')).href
  );
  const names = [
    '@deepseek-ai/dsh-client-modules',
    '@allrice/dsh-web-composition',
    '@allrice/independent-profile-module',
    '@allrice/dependent-profile-module',
    ...Array.from(
      { length: 22 },
      (_, index) => '@allrice/probe-' + index + '-' + 'q'.repeat(233),
    ),
  ];
  type Registry = {
    graph(): ReturnType<typeof DEntryProfileGraphSchema.parse>;
    fetchBundle(request: Request): Promise<Response>;
    onGraphChanged(listener: () => void): () => void;
    rebuilt(id: string): string | undefined;
  };
  const contexts: Context[] = [];
  async function installed(name: string, mtime: number, reorder = false) {
    const directory = join(root, name);
    const entries = await Promise.all(
      names.map(async (name, index) => {
        const pkg = join(directory, name);
        await mkdir(pkg, { recursive: true });
        const entry = join(pkg, 'host.js');
        await writeFile(entry, 'export function apply() {}\n');
        await writeFile(
          join(pkg, 'client.js'),
          ('globalThis.nativeTestBundle = ' + index + ';\n').repeat(index + 1),
        );
        const { utimes } = await import('node:fs/promises');
        await utimes(join(pkg, 'client.js'), mtime, mtime);
        await writeFile(
          join(pkg, 'package.json'),
          JSON.stringify({
            name,
            type: 'module',
            exports: { '.': './host.js', './client': './client.js' },
            dsh: {
              client: {
                platform: 'web',
                immediately: index === 0,
                ...(index === 3 && { external: [names[1]] }),
              },
            },
          }),
        );
        return {
          options: { name: pathToFileURL(entry).href },
          fiber: {},
          disabled: false,
          parent: { tree: { ctx: { baseUrl: pathToFileURL(entry).href } } },
        };
      }),
    );
    const context = new Context();
    contexts.push(context);
    context.provide('loader', {
      entries: () =>
        reorder
          ? [
              entries[0],
              entries[2],
              ...entries.slice(4, 16),
              entries[1],
              entries[3],
              ...entries.slice(16),
            ]
          : entries,
    } as unknown as Context['loader']);
    await context.plugin(api.ClientModuleRegistry);
    const registry = context.get('clientModules') as Registry;
    return { directory, registry };
  }
  async function bundle(registry: Registry, reference: string) {
    const reply = await registry.fetchBundle(
      new Request('http://localhost/' + reference),
    );
    expect(reply.ok).toBe(true);
    return Buffer.from(await reply.arrayBuffer());
  }
  const lifetime = new AbortController().signal;
  try {
    const one = await installed('authoritative-release', 1_000_000);
    const two = await installed('native-guest-install', 2_000_000, true);
    const nativeFile = (directory: string) =>
      join(directory, names[0]!, 'client.js');
    const a = await stat(nativeFile(one.directory));
    const b = await stat(nativeFile(two.directory));
    expect(a.ino).not.toBe(b.ino);
    expect(a.ctimeMs).not.toBe(b.ctimeMs);
    expect(await readFile(nativeFile(one.directory))).toEqual(
      await readFile(nativeFile(two.directory)),
    );
    const graph = DEntryProfileGraphSchema.parse(one.registry.graph());
    const native = DEntryProfileGraphSchema.parse(two.registry.graph());
    expect(native.rev).not.toBe(graph.rev);
    expect(native.entries.map(({ id }) => id)).not.toEqual(
      graph.entries.map(({ id }) => id),
    );
    expect(native.batches[1]!.entries).not.toEqual(graph.batches[1]!.entries);
    expect(native.batches).toHaveLength(3);
    expect(graph.batches).toHaveLength(4);
    const directory = join(root, 'sealed');
    const files: Array<{ path: string; bytes: number; sha256: string }> = [];
    async function seal(path: string, data: Buffer) {
      const descriptor = {
        path,
        bytes: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
      };
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), data);
      files.push(descriptor);
      return descriptor;
    }
    for (const name of [
      'managed/employee-web-entry.js',
      'managed/employee-web-entry.css',
      'native/assets/index-CN7NIWNw.js',
      'native/assets/vendor-DcuzkuQH.js',
      'native/assets/vendor-DV2921Zo.css',
      'native/assets/index-BxpfOGf3.css',
    ])
      await seal(name, Buffer.from('/* fixture static resource */'));
    const proofs = [];
    for (const resource of [...graph.entries, ...graph.batches]) {
      for (const reference of [
        resource.url,
        resource.url.replaceAll('/client.js', '/client.js.map'),
      ])
        proofs.push({
          reference,
          ...(await seal(
            'plugins/' +
              createHash('sha256').update(reference).digest('hex') +
              (reference === resource.url ? '.js' : '.map'),
            await bundle(one.registry, reference),
          )),
        });
    }
    await writeFile(
      join(directory, 'artifact.json'),
      JSON.stringify({
        format: 1,
        status: 'code-artifacts-only',
        source: { dirty: false },
        nativeRelease: {
          name: '@deepseek-ai/dsh-web-frontend',
          version: '0.2.1-rc.2',
        },
        closure: {
          publicNativeDist: true,
          sourceBuiltContribution: true,
          profileScripts: true,
          managedEntry: true,
        },
        managedEntry: 'managed/employee-web-entry.js',
        files,
        profile: {
          graph,
          bootInjections: api.bootInjections(graph),
          files: proofs,
          sourceBuiltClient: true,
        },
      }),
    );
    const current = {
      revoked: lifetime,
      async readImmutableGraph() {
        return native;
      },
      async readImmutableBundle(reference: string, bytes: number) {
        const value = await bundle(two.registry, reference);
        expect(bytes).toBe(value.byteLength);
        return value;
      },
    };
    const source = {
      ...current,
      verificationOwner: {},
      readImmutableBundle: vi.fn(current.readImmutableBundle),
    };
    const manifestSha256 = createHash('sha256')
      .update(await readFile(join(directory, 'artifact.json')))
      .digest('hex');
    const serving = await holdReleasedProfile(
      directory,
      source,
      lifetime,
      manifestSha256,
    );
    const nativeReferences = [...native.entries, ...native.batches]
      .flatMap(({ url }) => [
        url,
        url.replaceAll('/client.js', '/client.js.map'),
      ])
      .sort();
    const nativeReads = nativeReferences.length;
    expect(
      source.readImmutableBundle.mock.calls
        .map(([reference]) => reference)
        .sort(),
    ).toEqual(nativeReferences);
    const sameOwner = await holdReleasedProfile(
      directory,
      { ...source },
      lifetime,
      manifestSha256,
    );
    expect(source.readImmutableBundle).toHaveBeenCalledTimes(nativeReads);
    const staticPath = 'managed/employee-web-entry.js';
    const bytes = (await sameOwner.readStatic(staticPath, lifetime)).data;
    bytes.fill(0);
    expect((await serving.readStatic(staticPath, lifetime)).data).toEqual(
      Buffer.from('/* fixture static resource */'),
    );
    const nextEpoch = { ...source, verificationOwner: {} };
    await holdReleasedProfile(directory, nextEpoch, lifetime, manifestSha256);
    expect(source.readImmutableBundle).toHaveBeenCalledTimes(nativeReads * 2);

    const transientOwner = {};
    const firstStarted = deferred();
    const denyFirst = deferred();
    const first = holdReleasedProfile(
      directory,
      {
        ...current,
        verificationOwner: transientOwner,
        async readImmutableBundle() {
          firstStarted.resolve();
          await denyFirst.promise;
          throw Error('the first page lost its authority');
        },
      },
      lifetime,
      manifestSha256,
    );
    const denied = expect(first).rejects.toThrow('lost its authority');
    await firstStarted.promise;
    function otherScope(signal: AbortSignal) {
      const graph = deferred();
      return {
        graph: graph.promise,
        proof: holdReleasedProfile(
          directory,
          {
            ...current,
            verificationOwner: transientOwner,
            async readImmutableGraph() {
              graph.resolve();
              return native;
            },
          },
          signal,
          manifestSha256,
        ),
      };
    }
    const canceled = new AbortController();
    const waiting = otherScope(canceled.signal);
    const interrupted = expect(waiting.proof).rejects.toHaveProperty(
      'name',
      'AbortError',
    );
    await waiting.graph;
    canceled.abort();
    await interrupted;
    const independent = otherScope(lifetime);
    await independent.graph;
    denyFirst.resolve();
    await denied;
    await expect(independent.proof).resolves.toHaveProperty(
      'manifestSha256',
      manifestSha256,
    );

    expect(serving.graph).toEqual(native);
    for (const { url, rev } of [...native.entries, ...native.batches]) {
      expect((await serving.readReference(url, rev, lifetime)).data).toEqual(
        await bundle(two.registry, url),
      );
    }
    const superseded = graph.entries[0]!;
    await expect(
      serving.readReference(superseded.url, superseded.rev, lifetime),
    ).rejects.toThrow('not_found');
    const target = native.entries[0]!;
    for (const corrupt of [
      target.url,
      target.url.replaceAll('/client.js', '/client.js.map'),
    ]) {
      const requested: string[] = [];
      await expect(
        holdReleasedProfile(
          directory,
          {
            ...current,
            async readImmutableBundle(reference, bytes) {
              requested.push(reference);
              const value = await current.readImmutableBundle(reference, bytes);
              if (reference !== corrupt) return value;
              const changed = Buffer.from(value);
              changed[0] = changed[0]! ^ 1;
              expect(changed.byteLength).toBe(bytes);
              return changed;
            },
          },
          lifetime,
        ),
      ).rejects.toThrow('D entry native owner is not bound');
      if (corrupt === target.url) {
        expect(requested).toContain(target.url);
        expect(requested).not.toContain(
          target.url.replaceAll('/client.js', '/client.js.map'),
        );
        expect(requested).not.toContain(graph.batches[0]!.url);
      }
    }
    await expect(
      holdReleasedProfile(
        directory,
        {
          ...current,
          async readImmutableGraph() {
            return {
              ...native,
              entries: native.entries.map((row, index) =>
                index === 0 ? { ...row, url: row.url + '&extra=1' } : row,
              ),
            };
          },
        },
        lifetime,
      ),
    ).rejects.toHaveProperty('graphRule', 'entries[0].url/rev/topology');

    const local = await hostFixture(issue('execute'), true, null);
    const neighbor = await hostFixture(issue('execute'));
    const control = createDEntryPrincipalControl(local.node, {
      carrier: lifetime,
      cleanupTimeoutMs: 3000,
    });
    const otherControl = createDEntryPrincipalControl(neighbor.node, {
      carrier: lifetime,
      cleanupTimeoutMs: 3000,
    });
    const owner = await import(
      new URL('../../dsh/allrice-native-web-owner.mjs', import.meta.url).href
    );
    const artifactPath = join(root, 'guest-auth.json');
    const nativeWorkspaceId = randomUUID();
    local.host.provide('workspaceRegistry', {
      async create(path: string) {
        return { id: nativeWorkspaceId, path, sessionIds: [] };
      },
    });
    local.host.provide('sessionPersistence', {
      async list() {
        return [];
      },
    });
    local.host.provide('loader', { entries: () => [], async await() {} });
    const web = await installObserverWeb(local.host, install);
    local.host.provide('clientModules', {
      graph: () => two.registry.graph(),
      onGraphChanged: (listener: () => void) =>
        two.registry.onGraphChanged(listener),
    });
    const installOwner = (nonce: string, started?: () => void) =>
      local.host.plugin({
        inject: owner.inject,
        apply(ctx: Context) {
          const loading = owner.apply(ctx, {
            artifactPath,
            nonce,
            baseUrl: web.baseUrl,
            workdir: root,
          });
          started?.();
          return loading;
        },
      });
    const firstOwner = installOwner('original-graph-owner');
    const release = deferred();
    let nextOwner: ReturnType<typeof installOwner> | undefined;
    try {
      await waitForAuthNonce(artifactPath, 'original-graph-owner');
      const original = control.acquire(local.selected, lifetime);
      const page = await original.run(lifetime);
      const other = await otherControl
        .acquire(neighbor.selected, lifetime)
        .run(lifetime);
      const held = deferred();
      local.catalog.beforeList = async () => {
        held.resolve();
        await release.promise;
      };
      const call = {
        scopeId: local.selected.scopeId,
        endpoint: 'session/page' as const,
        args: {
          request: {
            address: { kind: 'session' as const, sessionId: SessionId('root') },
            throughSeq: 0,
          },
        },
      };
      const reading = page.invoke(call, lifetime).then(
        () => false,
        () => true,
      );
      await held.promise;
      let ownerUnloaded = false;
      const unloading = owner.unloadNativeWebOwner(firstOwner).then(() => {
        ownerUnloaded = true;
      });
      await expect.poll(() => page.revoked.aborted).toBe(true);
      expect(ownerUnloaded).toBe(false);
      const nextIssue = () => ({ ...local.selected, scopeId: randomUUID() });
      await expect(
        control.acquire(nextIssue(), lifetime).run(lifetime),
      ).rejects.toBeDefined();
      await writeFile(
        nativeFile(two.directory),
        '/* a different native source generation */',
      );
      two.registry.rebuilt(names[0]!);
      expect(two.registry.graph().rev).not.toBe(native.rev);
      const replacing = deferred();
      nextOwner = installOwner('replacement-graph-owner', replacing.resolve);
      await replacing.promise;
      let replacementReady = false;
      const published = waitForAuthNonce(
        artifactPath,
        'replacement-graph-owner',
      ).then(() => {
        replacementReady = true;
      });
      void published.catch(() => {});
      await expect(
        control.acquire(nextIssue(), lifetime).run(lifetime),
      ).rejects.toBeDefined();
      expect(replacementReady).toBe(false);
      let joined = false;
      const closed = original.close().then(() => {
        joined = true;
      });
      expect(other.revoked.aborted).toBe(false);
      expect(local.catalog.pages).toHaveLength(0);
      expect(joined).toBe(false);
      release.resolve();
      expect(await reading).toBe(true);
      await closed;
      await unloading;
      await published;
      expect(joined).toBe(true);
      expect(ownerUnloaded).toBe(true);
      expect(replacementReady).toBe(true);
      expect(
        JSON.parse(await readFile(artifactPath, 'utf8')).nonce,
      ).toBeTruthy();
      local.catalog.beforeList = undefined;
      const fresh = nextIssue();
      const activity = control.acquire(fresh, lifetime);
      const reopened = await activity.run(lifetime);
      expect(
        (await reopened.invoke({ ...call, scopeId: fresh.scopeId }, lifetime))
          .value,
      ).toEqual({ records: [], hasMore: false });
      await writeFile(
        nativeFile(two.directory),
        '/* the registered owner observes this next source change */',
      );
      two.registry.rebuilt(names[0]!);
      await expect.poll(() => reopened.revoked.aborted).toBe(true);
      await activity.close();
      expect(
        (
          await other.invoke(
            { ...call, scopeId: neighbor.selected.scopeId },
            lifetime,
          )
        ).value,
      ).toEqual({ records: [], hasMore: false });
    } finally {
      release.resolve();
      await nextOwner?.dispose();
      await firstOwner.dispose();
      await Promise.all([control.close(), otherControl.close()]);
      await Promise.all([local.close(), neighbor.close()]);
    }
  } finally {
    for (const context of contexts.reverse()) await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
