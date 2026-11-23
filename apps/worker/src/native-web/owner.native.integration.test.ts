import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import { serverResponseSchema } from '@deepseek-ai/dsh-client-connection';
import { TYPERT_REMOTE as NATIVE_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import type { DEntryPrincipalIssue } from '@allrice/d-entry-principal/types';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
import { hostFixture } from '../../../../packages/d-entry-principal/test/host-fixture.js';
import * as PrincipalControl from '../d-entry/principal-control.js';
import {
  PersonVmError,
  nativeWebAuthArtifact,
  type PersonVmBootstrapScope,
  type PersonVmManagedJob,
  type PersonVmPort,
} from '@allrice/person-vm';
import {
  NATIVE_WEB_AUTH_READER,
  parseNativeWebAuth,
} from '../../../../packages/person-vm/src/native-web-auth.ts';
import { runCommand } from '../../../../packages/person-vm/src/process.ts';
import { prepareNativeWebLaunch } from './launch.js';
import { openNativeWebOwner } from './owner.js';
import * as NativeTransport from './transport.js';

// Actual published rc.2 entry, not a fixture protocol server. Its complete
// compatible-OS package tree must be provisioned separately and recorded.
const cli = process.env.ALLRICE_NATIVE_WEB_TEST_CLI;
const tag = 'manual:ALLRICE_NATIVE_WEB_TEST_CLI';
const roots: string[] = [],
  cleanup: (() => Promise<void>)[] = [];
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  const joined = await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  const failure = joined.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
});
async function setup(
  prepareScope?: (
    scope: PersonVmBootstrapScope,
    lifetime: AbortController,
  ) => void,
) {
  expect(
    createHash('sha256')
      .update(await readFile(cli!))
      .digest('hex'),
  ).toBe('80112efe368efb1a39720c7ada0af00442e5131fb2744edaaff8a3e8bb499e6f');
  const pkg = JSON.parse(
    await readFile(resolve(dirname(cli!), '../package.json'), 'utf8'),
  );
  expect(pkg).toMatchObject({
    name: '@deepseek-ai/dsh',
    version: '0.2.1-rc.2',
  });
  const root = await mkdtemp('/tmp/ar-native-web-');
  roots.push(root);
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  const binding = {
    vmId: randomUUID(),
    instanceId: randomUUID(),
    personId: randomUUID(),
    organizationId: randomUUID(),
    leaseEpoch: 1,
  };
  // Test-owned endpoint facts; no production roster or authority is manufactured.
  const principalProfile = {
    workspaceId: randomUUID(),
    employeeInstanceId: randomUUID(),
    employeeRevision: 1,
    employeeVersionId: randomUUID(),
  };
  const launch = await prepareNativeWebLaunch(
    {
      origin: `http://127.0.0.1:${port}/`,
      publicUrl: `http://127.0.0.1:${port}/`,
      guestAddress: '127.0.0.1',
      guestPort: port,
      dshHome: join(root, 'dsh'),
      agentsHome: join(root, 'agents'),
      workdir: root,
      cliPath: cli!,
      startupTimeoutMs: 10000,
      principalProfile,
    },
    binding,
  );
  for (const file of launch.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents, { mode: file.mode });
  }
  const startup = new AbortController(),
    lifetime = new AbortController();
  let kills = 0,
    waitSignal: AbortSignal | undefined,
    job!: PersonVmManagedJob,
    exited!: Promise<{ exitCode: number; timedOut: boolean }>,
    child!: ReturnType<typeof spawn>;
  const scope: PersonVmBootstrapScope = {
    binding,
    signal: startup.signal,
    assertCurrent: async () => {
      if (startup.signal.aborted) throw new PersonVmError('LEASE_LOST');
    },
    async launch(command) {
      child = spawn(process.execPath, [...command.args], {
        cwd: root,
        env: {
          PATH: dirname(process.execPath),
          HOME: root,
          ...command.env,
          DO_NOT_TRACK: '1',
          NPM_CONFIG_OFFLINE: 'true',
        },
        stdio: 'ignore',
      });
      exited = new Promise<{ exitCode: number; timedOut: boolean }>(
        (done, reject) => {
          child.once('error', reject);
          child.once('close', (code) =>
            done({ exitCode: code ?? 137, timedOut: false }),
          );
        },
      );
      async function wait(signal: AbortSignal) {
        waitSignal ??= signal; // Observe the public managed wait's actual abort.
        signal.throwIfAborted();
        let abort!: () => void;
        try {
          return await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener('abort', abort, { once: true });
            }),
          ]);
        } finally {
          signal.removeEventListener('abort', abort);
        }
      }
      job = {
        binding,
        jobId: randomUUID(),
        wait,
        cancelAndWait: async (signal) => {
          kills++;
          child.kill('SIGKILL');
          return wait(signal);
        },
      };
      cleanup.push(async () => {
        child.kill('SIGKILL');
        await exited;
      });
      return job;
    },
    async readNativeWebAuth(request) {
      const file = nativeWebAuthArtifact(request);
      const text = await runCommand({
        executable: process.execPath,
        args: ['-e', NATIVE_WEB_AUTH_READER, file.path, String(file.maxBytes)],
        env: { PATH: dirname(process.execPath), HOME: root },
        signal: AbortSignal.any([
          startup.signal,
          AbortSignal.timeout(request.timeoutMs),
        ]),
      });
      return parseNativeWebAuth(text, request);
    },
  };
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: binding.personId },
    organizationId: binding.organizationId,
    workspaceId: principalProfile.workspaceId,
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
  const current = vi.fn<PersonVmPort['assertCurrentBinding']>(async () => {});
  prepareScope?.(scope, lifetime);
  const owner = await openNativeWebOwner({
    scope,
    launch,
    context,
    vm: { assertCurrentBinding: current },
    lifetime: lifetime.signal,
    cleanupTimeoutMs: 5000,
  });
  let expectedCloseFailure: unknown;
  cleanup.push(async () => {
    if (expectedCloseFailure === undefined) await owner.close();
    else await expect(owner.close()).rejects.toBe(expectedCloseFailure);
  });
  return {
    owner,
    expectCloseFailure(error: unknown) {
      expectedCloseFailure = error;
    },
    principalProfile,
    startup,
    lifetime,
    child,
    current,
    context,
    exited,
    job,
    waitSignal: () => waitSignal!,
    kills: () => kills,
  };
}

it.skipIf(!cli)(
  '真实rc.2产物交换API Cookie→认证list/control baseline；scope结束不杀长期job，close实际join',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    expect(f.owner.controlReady()).toBe(true);
    f.startup.abort();
    expect((await f.owner.readSessions(new AbortController().signal)).ok).toBe(
      true,
    );
    expect(f.current).toHaveBeenCalledTimes(2);
    expect(f.child.exitCode).toBe(null);
    await Promise.all([f.owner.close(), f.owner.close()]);
    expect(f.owner.controlReady()).toBe(false);
    expect(f.kills()).toBe(1);
    expect(f.child.exitCode !== null || f.child.signalCode !== null).toBe(true);
  },
);

it.skipIf(!cli)(
  '真实rc.2旧exact kill失败memo不能冒join；确认child停止后实际host退役可重新收束',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    const cancel = vi
      .spyOn(f.job, 'cancelAndWait')
      .mockRejectedValueOnce(new PersonVmError('PROVIDER_FAILED'));
    await expect(f.owner.close()).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    expect(f.child.exitCode).toBe(null);
    await expect(
      f.owner.retireAfterNativeStop(
        { ...f.owner.binding, instanceId: randomUUID() },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(f.child.exitCode).toBe(null);
    f.child.kill('SIGKILL');
    await f.exited; // This leaf's actual Host process, not a VM stop/status proof.
    await f.owner.retireAfterNativeStop(
      f.owner.binding,
      new AbortController().signal,
    );
    await f.owner.close();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.owner.controlReady()).toBe(false);
  },
);
it.skipIf(!cli)(
  '真实rc.2停止后退役仍join阻塞read与HTTP/WS；host join失败保留，显式重新核实才成功',
  { tags: [tag], timeout: 30000 },
  async () => {
    const io = latch(),
      entered = latch(),
      release = latch(),
      create = NativeTransport.nativeWebTransport;
    let unconfirmed = false;
    vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
      (...args) => {
        const transport = create(...args);
        return {
          ...transport,
          close: async () => {
            await transport.close();
            io.resolve();
            if (unconfirmed)
              throw Error('synthetic host join acknowledgement failure');
          },
        };
      },
    );
    const f = await setup();
    cleanup.push(async () => {
      release.resolve();
      unconfirmed = false;
    });
    f.current.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const reading = f.owner
      .readSessions(new AbortController().signal)
      .catch((error: unknown) => error);
    await entered.promise;
    unconfirmed = true;
    f.child.kill('SIGKILL');
    await f.exited;
    let settled = false;
    const retiring = f.owner
      .retireAfterNativeStop(f.owner.binding, new AbortController().signal)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await io.promise;
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    release.resolve();
    expect(await reading).toBeInstanceOf(Error);
    expect(await retiring).toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
    await expect(
      f.owner.readSessions(new AbortController().signal),
    ).rejects.toBeDefined();
    unconfirmed = false;
    await f.owner.retireAfterNativeStop(
      f.owner.binding,
      new AbortController().signal,
    );
    await f.owner.close();
    expect(f.kills()).toBe(0); // Confirmed-stop path never queries an already-dead guest job.
  },
);

it.skipIf(!cli)(
  '真实retire先进入：wait abort重入lifetime/close不另发cancel，完整read与I/O实际join前不成功',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup(),
      entered = latch(),
      release = latch(),
      reentered = latch();
    cleanup.push(async () => {
      release.resolve();
    });
    f.current.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const reading = f.owner
      .readSessions(new AbortController().signal)
      .catch((error: unknown) => error);
    await entered.promise;
    f.child.kill('SIGKILL');
    await f.exited;
    const cancel = vi.spyOn(f.job, 'cancelAndWait');
    let closed = false,
      retired = false,
      reentrant: Promise<unknown> | undefined;
    f.waitSignal().addEventListener(
      'abort',
      () => {
        f.lifetime.abort();
        reentrant = f.owner.close().finally(() => {
          closed = true;
        });
        void reentrant.catch(() => {});
        reentered.resolve();
      },
      { once: true },
    );
    const retiring = f.owner
      .retireAfterNativeStop(f.owner.binding, new AbortController().signal)
      .finally(() => {
        retired = true;
      });
    void retiring.catch(() => {});
    cleanup.push(async () => {
      await Promise.allSettled([reading, retiring, reentrant]);
    });
    await reentered.promise; // Synchronous reentry from the actual host join.
    expect(cancel).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    expect(retired).toBe(false);
    expect(f.owner.controlReady()).toBe(false);
    release.resolve();
    expect(await reading).toBeInstanceOf(Error);
    await Promise.all([retiring, reentrant]);
    expect(cancel).not.toHaveBeenCalled();
    expect(f.kills()).toBe(0);
  },
);
it.skipIf(!cli)(
  '真实close先进入：retire必须join旧cancel的实际host子进程，guest已停不能提前覆盖',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup(),
      entered = latch();
    // A bounded, secret-free host I/O fixture, not an msb/guest executor.
    const io = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready');process.stdin.resume()"],
      {
        env: { PATH: dirname(process.execPath) },
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    const ioClosed = once(io, 'close');
    void ioClosed.catch(() => {});
    cleanup.push(async () => {
      io.stdin.end();
      if (io.exitCode === null && io.signalCode === null) io.kill('SIGKILL');
      await ioClosed;
    });
    await Promise.race([
      once(io.stdout, 'data'),
      ioClosed.then(() => {
        throw Error('host I/O fixture exited before its handshake');
      }),
    ]);
    const cancel = f.job.cancelAndWait;
    vi.spyOn(f.job, 'cancelAndWait').mockImplementation(async (signal) => {
      const exit = await cancel(signal); // Actual rc.2 Host child close.
      entered.resolve();
      await ioClosed; // Actual host operation still owns a live child/stdio.
      return exit;
    });
    let closed = false,
      retired = false;
    const closing = f.owner.close().finally(() => {
      closed = true;
    });
    expect(f.owner.controlReady()).toBe(false);
    void closing.catch(() => {});
    await Promise.race([
      entered.promise,
      closing.then(() => {
        throw Error('close settled before the host cancellation I/O joined');
      }),
    ]);
    const retiring = f.owner
      .retireAfterNativeStop(f.owner.binding, new AbortController().signal)
      .finally(() => {
        retired = true;
      });
    void retiring.catch(() => {});
    f.lifetime.abort();
    const concurrent = f.owner.close();
    void concurrent.catch(() => {});
    cleanup.push(async () => {
      await Promise.allSettled([closing, retiring, concurrent]);
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(closed).toBe(false);
    expect(retired).toBe(false);
    expect(io.exitCode).toBe(null);
    expect(f.child.exitCode !== null || f.child.signalCode !== null).toBe(true);
    expect(f.kills()).toBe(1);
    io.stdin.end();
    expect(await ioClosed).toEqual([0, null]);
    await Promise.all([closing, retiring, concurrent]);
    expect(f.kills()).toBe(1);
    await f.owner.close();
    expect(f.kills()).toBe(1);
  },
);

for (const method of [
  'readSessions',
  'readSessionsFor',
  'readModelCatalogFor',
] as const)
  for (const check of [1, 2])
    it.skipIf(!cli)(
      `真实${method}第${check}次现权检查阻塞时close等待完整operation，禁止新读`,
      { tags: [tag], timeout: 30000 },
      async () => {
        const ioClosed = latch();
        const createTransport = NativeTransport.nativeWebTransport;
        let fetches = 0;
        // Observe real public transport.close completion; no fake protocol/readiness.
        vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
          (...args) => {
            const transport = createTransport(...args);
            return {
              ...transport,
              fetch: (...call) => {
                fetches++;
                return transport.fetch(...call);
              },
              close: async () => {
                await transport.close();
                ioClosed.resolve();
              },
            };
          },
        );
        const f = await setup(),
          entered = latch(),
          release = latch();
        const read = (signal: AbortSignal) =>
          method === 'readSessions'
            ? f.owner.readSessions(signal)
            : f.owner[method](f.context, signal);
        cleanup.push(async () => {
          release.resolve();
        });
        if (check === 2) f.current.mockResolvedValueOnce(undefined);
        f.current.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise; // Deliberately join even after its signal is aborted.
        });
        const reading = read(new AbortController().signal).then(
          () => {
            throw Error('closed reader must not return data');
          },
          (error: unknown) => error,
        );
        await entered.promise;
        const atGuard = fetches;
        let settled = false;
        const closed = f.owner.close().then(() => {
          settled = true;
        });
        await Promise.all([ioClosed.promise, f.exited]); // Real network and exact child join.
        await new Promise<void>((done) => setImmediate(done)); // Drain their settled continuations.
        expect(settled).toBe(false);
        await expect(read(new AbortController().signal)).rejects.toBeDefined();
        expect(f.current).toHaveBeenCalledTimes(check);
        expect(fetches).toBe(atGuard);
        release.resolve();
        expect(await reading).toBeDefined();
        await closed;
        expect(f.current).toHaveBeenCalledTimes(check);
        expect(fetches).toBe(atGuard);
        expect(f.kills()).toBe(1);
      },
    );
it.skipIf(!cli)(
  '真实native control失联只撤可达资格，不重放；lifetime取消仍精确结束job并join',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    const revoked = once(f.owner.revoked, 'abort');
    f.child.kill('SIGKILL');
    await revoked;
    expect(f.owner.controlReady()).toBe(false);
    await expect(
      f.owner.readSessions(new AbortController().signal),
    ).rejects.toBeDefined();
    await f.owner.close();
    expect(f.kills()).toBe(1);
  },
);

function observeFetches() {
  const create = NativeTransport.nativeWebTransport;
  let calls = 0;
  vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
    (...args) => {
      const transport = create(...args);
      return {
        ...transport,
        fetch: (...request) => {
          calls++;
          return transport.fetch(...request);
        },
      };
    },
  );
  return () => calls;
}
it.skipIf(!cli)(
  '新当前RC前置拒绝零native I/O且不撤共享owner；随后有效RC可用，方法可脱离接收者调用',
  { tags: [tag], timeout: 30000 },
  async () => {
    const fetches = observeFetches(),
      f = await setup();
    const expired = {
      ...f.context,
      requestId: randomUUID(),
      sessionId: randomUUID(),
    };
    const current = {
      ...f.context,
      requestId: randomUUID(),
      sessionId: randomUUID(),
    };
    const denied = new PersonVmError('AUTHORIZATION_DENIED');
    f.current.mockImplementation(async (context) => {
      if (context.sessionId === expired.sessionId) throw denied;
    });
    const before = fetches(),
      read = f.owner.readSessionsFor;
    await expect(read(expired, new AbortController().signal)).rejects.toBe(
      denied,
    );
    expect(fetches()).toBe(before);
    expect(f.owner.revoked.aborted).toBe(false);
    expect(f.owner.controlReady()).toBe(true);
    expect(f.kills()).toBe(0);
    f.current.mockClear();
    expect((await read(current, new AbortController().signal)).ok).toBe(true);
    expect(fetches()).toBe(before + 1);
    expect(f.current.mock.calls.map(([context]) => context)).toEqual([
      current,
      current,
    ]);
    expect(f.child.exitCode).toBeNull();
  },
);
it.skipIf(!cli)(
  '新当前RC读中撤权：实际list完成后复核拒绝丢结果并真实settle，不误撤共享owner',
  { tags: [tag], timeout: 30000 },
  async () => {
    const fetches = observeFetches(),
      f = await setup(),
      entered = latch(),
      joined = latch();
    const current = {
      ...f.context,
      requestId: randomUUID(),
      sessionId: randomUUID(),
    };
    const denied = new PersonVmError('AUTHORIZATION_DENIED');
    f.current
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        entered.resolve();
        await joined.promise;
        throw denied;
      });
    cleanup.push(async () => {
      joined.resolve();
    });
    const before = fetches();
    let ended = false;
    const reading = f.owner
      .readSessionsFor(current, new AbortController().signal)
      .catch((error: unknown) => error)
      .finally(() => {
        ended = true;
      });
    await entered.promise;
    expect(fetches()).toBe(before + 1); // Post-guard failure is not zero I/O.
    expect(ended).toBe(false);
    expect(f.owner.controlReady()).toBe(true);
    joined.resolve();
    expect(await reading).toBe(denied);
    expect(f.owner.revoked.aborted).toBe(false);
    expect(f.kills()).toBe(0);
    expect(
      (
        await f.owner.readSessionsFor(
          { ...current, sessionId: randomUUID() },
          new AbortController().signal,
        )
      ).ok,
    ).toBe(true);
  },
);
it.skipIf(!cli)(
  '新当前RC单次取消等待已发guard真实结束；不废共享owner，随后有效请求仍可读',
  { tags: [tag], timeout: 30000 },
  async () => {
    const fetches = observeFetches(),
      f = await setup(),
      entered = latch(),
      joined = latch(),
      caller = new AbortController();
    const cancelled = Error('only this request cancelled');
    cleanup.push(async () => {
      joined.resolve();
    });
    f.current.mockImplementationOnce(async (_context, _binding, signal) => {
      entered.resolve();
      await joined.promise;
      signal.throwIfAborted();
    });
    const before = fetches();
    let ended = false;
    const reading = f.owner
      .readSessionsFor(f.context, caller.signal)
      .catch((error: unknown) => error)
      .finally(() => {
        ended = true;
      });
    await entered.promise;
    caller.abort(cancelled);
    await new Promise<void>((done) => setImmediate(done));
    expect(ended).toBe(false);
    expect(f.owner.revoked.aborted).toBe(false);
    joined.resolve();
    expect(await reading).toBe(cancelled);
    expect(fetches()).toBe(before);
    expect(
      (await f.owner.readSessionsFor(f.context, new AbortController().signal))
        .ok,
    ).toBe(true);
    expect(f.kills()).toBe(0);
  },
);
it.skipIf(!cli)(
  '真实transport失联仍撤共享owner但不冒guest终止；新请求拒绝，显式close才join原job',
  { tags: [tag], timeout: 30000 },
  async () => {
    const create = NativeTransport.nativeWebTransport,
      disconnect: (() => void)[] = [];
    vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
      (...args) => {
        const transport = create(...args);
        return {
          ...transport,
          createWebSocket(input) {
            const socket = transport.createWebSocket(input);
            disconnect.push(() => socket.close());
            return socket;
          },
        };
      },
    );
    const f = await setup(),
      revoked = once(f.owner.revoked, 'abort');
    disconnect.forEach((close) => close());
    await revoked;
    expect(f.owner.controlReady()).toBe(false);
    expect(f.child.exitCode).toBeNull();
    expect(f.kills()).toBe(0);
    await expect(
      f.owner.readSessionsFor(f.context, new AbortController().signal),
    ).rejects.toBeDefined();
    await f.owner.close();
    expect(f.kills()).toBe(1);
  },
);
it.skipIf(!cli)(
  '真实lifetime取消仍撤共享owner并join job，新当前RC不能恢复已失效控制',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    f.lifetime.abort();
    expect(f.owner.revoked.aborted).toBe(true);
    await f.owner.close();
    await f.exited;
    expect(f.owner.controlReady()).toBe(false);
    expect(f.kills()).toBe(1);
    await expect(
      f.owner.readSessionsFor(f.context, new AbortController().signal),
    ).rejects.toBeDefined();
  },
);

it.skipIf(!cli)(
  '已join的单次取消不废owner；真实现权失效撤旧epoch，仍由显式close确认guest终止',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    await expect(
      f.owner.readSessions(AbortSignal.abort()),
    ).rejects.toBeDefined();
    expect(f.owner.controlReady()).toBe(true);
    f.current.mockRejectedValueOnce(new PersonVmError('LEASE_LOST'));
    await expect(
      f.owner.readSessions(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(f.owner.revoked.aborted).toBe(true);
    expect(f.kills()).toBe(0);
    await f.owner.close();
    expect(f.kills()).toBe(1);
  },
);

it.skipIf(!cli)(
  '真实running raw modelCatalog使用零业务参数和原生结果；不赋予startup/send就绪',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    const result = await f.owner.readModelCatalogFor(
      f.context,
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error('actual native model catalog was unavailable');
    expect(
      NATIVE_REMOTE.methods['session/modelCatalog'].result
        .create()
        .parse(result.value),
    ).toEqual(result.value);
    expect(f.owner).not.toHaveProperty('editorReady');
    expect(f.owner).not.toHaveProperty('canSend');
    await f.owner.close();
    await expect(
      f.owner.readModelCatalogFor(f.context, new AbortController().signal),
    ).rejects.toBeDefined();
  },
);

it.skipIf(!cli).each([1, 2])(
  '真实raw catalog第%s个current拒绝仅影响本请求，原错误保留且共享owner可继续',
  { tags: [tag], timeout: 30000 },
  async (check) => {
    const fetches = observeFetches(),
      f = await setup();
    const denied = new PersonVmError('AUTHORIZATION_DENIED');
    if (check === 2) f.current.mockResolvedValueOnce(undefined);
    f.current.mockRejectedValueOnce(denied);
    const before = fetches();
    await expect(
      f.owner.readModelCatalogFor(f.context, new AbortController().signal),
    ).rejects.toBe(denied);
    expect(fetches()).toBe(before + check - 1);
    expect(f.owner.revoked.aborted).toBe(false);
    expect(f.owner.controlReady()).toBe(true);
    expect(f.kills()).toBe(0);
    expect(
      (
        await f.owner.readModelCatalogFor(
          { ...f.context, sessionId: randomUUID() },
          new AbortController().signal,
        )
      ).ok,
    ).toBe(true);
  },
);

it.skipIf(!cli).each(['caller-cancel', 'owner-close'] as const)(
  '真实raw零参Promise尚未返回时%s不代替join；只在原reply真实结清后拒绝结果',
  { tags: [tag], timeout: 30000 },
  async (mode) => {
    const create = NativeTransport.nativeWebTransport,
      entered = latch(),
      release = latch();
    let first = true;
    let actual:
      { body: unknown; signal: AbortSignal | null | undefined } | undefined;
    vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
      (...args) => {
        const transport = create(...args);
        return {
          ...transport,
          async fetch(...request) {
            const response = await transport.fetch(...request);
            if (
              first &&
              new URL(request[0], args[0]).pathname ===
                '/api/session/modelCatalog'
            ) {
              first = false;
              if (typeof request[1].body !== 'string')
                throw Error('actual native JSON request missing');
              actual = {
                body: JSON.parse(request[1].body),
                signal: request[1].signal,
              };
              entered.resolve();
              await release.promise; // Hold the original public carrier Promise, never replace its response.
            }
            return response;
          },
        };
      },
    );
    const f = await setup(),
      caller = new AbortController();
    cleanup.push(async () => {
      release.resolve();
    });
    let settled = false;
    const reading = f.owner
      .readModelCatalogFor(f.context, caller.signal)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    if (!actual) throw Error('actual raw request was not observed');
    expect(actual.body).toEqual({
      type: 'client-request',
      rpcId: expect.any(String),
      method: 'session/modelCatalog',
      payload: { args: {} },
    });
    const cancelled = Error('fixture-only single raw read cancelled');
    const closing =
      mode === 'owner-close' ? f.owner.close() : Promise.resolve();
    void closing.catch(() => {});
    if (mode === 'caller-cancel') caller.abort(cancelled);
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    // The zero-argument native descriptor has only its mount lifetime, no caller cancellation slot.
    expect(actual.signal?.aborted).toBe(false);
    if (mode === 'caller-cancel') {
      expect(f.owner.revoked.aborted).toBe(false);
      expect(f.owner.controlReady()).toBe(true);
    } else expect(f.owner.revoked.aborted).toBe(true);
    release.resolve();
    const outcome = await reading;
    if (mode === 'caller-cancel') expect(outcome).toBe(cancelled);
    else expect(outcome).toBeInstanceOf(Error);
    await closing;
    if (mode === 'caller-cancel') {
      expect(
        (
          await f.owner.readModelCatalogFor(
            f.context,
            new AbortController().signal,
          )
        ).ok,
      ).toBe(true);
      expect(f.kills()).toBe(0);
    } else expect(f.kills()).toBe(1);
  },
);

it.skipIf(!cli).each(['normal', 'lost-then-exact-stop'] as const)(
  '真实guest封存principal安装、同API Peer两页及技术ready；%s按各自ACK/unknown/退役出口join',
  { tags: [tag], timeout: 30000 },
  async (mode) => {
    const create = NativeTransport.nativeWebTransport;
    let selected:
      ReturnType<typeof NativeTransport.nativeWebTransport> | undefined;
    vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
      (...args) => {
        selected = create(...args);
        return selected;
      },
    );
    const f = await setup(),
      transport = selected;
    if (!transport) throw Error('actual authenticated owner transport missing');
    // Only this manual test creates a native Session through the original owner Peer.
    // The pin strings below are explicitly test-owned provenance, not SQL or production authorization.
    const args = NATIVE_REMOTE.methods['session/create']
      .input({ strict: true })
      .create()
      .parse({ request: {} });
    const response = await transport.fetch('api/session/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: 'session/create',
        payload: { args },
      }),
    });
    const envelope = serverResponseSchema.parse(await response.json());
    if (!envelope.result.ok)
      throw Error('actual native session/create refused the manual fixture');
    const created = NATIVE_REMOTE.methods['session/create'].result
      .create()
      .parse(envelope.result.value);
    const issue: DEntryPrincipalIssue = {
      scopeId: randomUUID(),
      access: 'history',
      identity: {
        ...f.principalProfile,
        organizationId: f.owner.binding.organizationId,
        personId: f.owner.binding.personId,
        threadId: randomUUID(),
      },
      root: {
        nativeSessionId: created.sessionId,
        rootOriginDigest: 'manual-test-native-create-only',
        rootBindingRef: 'manual-test-no-sql-permit',
      },
    };
    const first = f.owner.acquirePrincipal(issue, new AbortController().signal);
    const secondIssue = { ...issue, scopeId: randomUUID() };
    const second = f.owner.acquirePrincipal(
      secondIssue,
      new AbortController().signal,
    );
    const firstScope = await first.run(new AbortController().signal);
    const secondScope = await second.run(new AbortController().signal);
    expect(firstScope.opened.baseline.owner).toBe(false);
    expect(firstScope.opened.principal.kind).toBe('allrice-d-entry');
    expect(secondScope.opened.baseline.owner).toBe(false);
    const eventsSource = firstScope.stream(
      { kind: 'events', scopeId: issue.scopeId, payload: { args: {} } },
      new AbortController().signal,
    );
    const events = eventsSource[Symbol.asyncIterator]();
    expect(await events.next()).toMatchObject({
      value: {
        type: 'item',
        value: { type: 'ready', clientId: expect.any(String) },
      },
    });
    await first.close(); // Real close/closed/end and local join; it never cancels the shared job.
    await events.return?.(); // Join this test's paused consumer too.
    expect(firstScope.revoked.aborted).toBe(true);
    expect(secondScope.revoked.aborted).toBe(false);
    expect(f.kills()).toBe(0);
    expect(
      await secondScope.invoke(
        {
          scopeId: secondIssue.scopeId,
          endpoint: 'session/page',
          args: {
            request: {
              address: { kind: 'session', sessionId: created.sessionId },
              throughSeq: 0,
            },
          },
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ endpoint: 'session/page' });
    if (mode === 'normal') {
      const entered = latch();
      f.current.mockImplementationOnce(async (_context, _binding, checking) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(checking.reason);
          checking.addEventListener('abort', abort, { once: true });
          if (checking.aborted) {
            checking.removeEventListener('abort', abort);
            abort();
          }
        });
      });
      const reading = f.owner.readSessions(new AbortController().signal);
      void reading.catch(() => {});
      await entered.promise;
      // Normal stale abort rejects a real in-flight binding guard. It must not
      // enter lost and kill the carrier before the other page's close ACK.
      const closing = f.owner.close();
      await expect(reading).rejects.toBeDefined();
      await closing;
    } else {
      f.child.kill('SIGKILL');
      await f.exited;
      await expect(f.owner.close()).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
      // Actual child exit is the fixture's trusted exact-stop fact; it is not an ACK.
      await f.owner.retireAfterNativeStop(
        f.owner.binding,
        new AbortController().signal,
      );
      await f.owner.close();
    }
    expect(secondScope.revoked.aborted).toBe(true);
    expect(f.kills()).toBe(1);
  },
);

it.skipIf(!cli)(
  'R3最后baseline后setup current实际悬挂时，normal close不能在真guard join前完成',
  { tags: [tag], timeout: 30000 },
  async () => {
    const entered = latch(),
      release = latch();
    let abort: (() => void) | undefined;
    let cancel: MockInstance<PersonVmManagedJob['cancelAndWait']> | undefined;
    let checks = 0,
      settled = false;
    const opening = setup((scope, lifetime) => {
      abort = () => lifetime.abort();
      const current = scope.assertCurrent.bind(scope),
        launch = scope.launch.bind(scope);
      vi.spyOn(scope, 'assertCurrent').mockImplementation(async () => {
        await current();
        if (++checks === 3) {
          entered.resolve();
          await release.promise;
        }
      });
      vi.spyOn(scope, 'launch').mockImplementation(async (...args) => {
        const job = await launch(...args);
        cancel = vi.spyOn(job, 'cancelAndWait');
        return job;
      });
    })
      .then(
        () => {
          throw Error('a late successful owner must never be published');
        },
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    cleanup.push(async () => {
      release.resolve();
      await opening;
    });
    await entered.promise;
    if (!abort || !cancel) throw Error('actual setup guard/job not reached');
    abort();
    await new Promise<void>((done) => setImmediate(done));
    expect(checks).toBe(3);
    expect(settled).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    const cancelled = cancel.mock.results[0];
    if (!cancelled || cancelled.type !== 'return')
      throw Error('actual native cancellation did not start');
    await cancelled.value; // Actual Host/job has joined, but its last guard is still pending.
    expect(settled).toBe(false);
    release.resolve();
    expect(await opening).toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);

it.skipIf(!cli)(
  'owner close保留真实control的native错误链及并存cleanup原因，等待实际job收尾并复用失败memo',
  { tags: [tag], timeout: 30000 },
  async () => {
    // This boundary test routes the real control to the public S1 fixture so its
    // native catalog can deterministically fail. Other manual cases cover the
    // actual same-Host/Peer installation; the owner job and its cleanup stay real.
    const native = await hostFixture(),
      create = PrincipalControl.createDEntryPrincipalControl,
      cancelEntered = latch(),
      cancelRelease = latch(),
      cleanupFailure = Error('actual joined job cleanup diagnostic');
    vi.spyOn(
      PrincipalControl,
      'createDEntryPrincipalControl',
    ).mockImplementation((_root, input) => create(native.node, input));
    let cancel: MockInstance<PersonVmManagedJob['cancelAndWait']> | undefined;
    let closing: Promise<unknown> | undefined;
    let nativeClosed = false,
      holdCancel = false;
    cleanup.push(async () => {
      cancelRelease.resolve();
      await Promise.allSettled([closing]);
      if (!nativeClosed) await native.close();
    });
    const f = await setup((scope) => {
      const launch = scope.launch.bind(scope);
      vi.spyOn(scope, 'launch').mockImplementation(async (...args) => {
        const job = await launch(...args),
          actual = job.cancelAndWait.bind(job);
        cancel = vi
          .spyOn(job, 'cancelAndWait')
          .mockImplementation(async (...request) => {
            await actual(...request);
            if (!holdCancel) return;
            cancelEntered.resolve();
            await cancelRelease.promise;
            throw cleanupFailure;
          });
        return job;
      });
    });
    cleanup.push(async () => {
      cancelRelease.resolve();
      await Promise.allSettled([closing]);
    });
    const activity = f.owner.acquirePrincipal(
      native.selected,
      new AbortController().signal,
    );
    const scope = await activity.run(new AbortController().signal);
    const failure = new RemoteError(
      'subagent/catalog-diagnostic',
      'owner boundary native setup failure',
      { reason: 'unavailable' },
    );
    native.catalog.beforeFollow = async () => {
      throw failure;
    };
    const stream = scope
      .stream(
        {
          scopeId: native.selected.scopeId,
          endpoint: 'session/follow',
          args: {
            request: {
              address: { kind: 'session', sessionId: SessionId('root') },
            },
          },
        },
        new AbortController().signal,
      )
      [Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toMatchObject({
      code: failure.code,
      message: failure.message,
      details: failure.details,
    });
    let settled = false;
    holdCancel = true;
    closing = f.owner
      .close()
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await cancelEntered.promise;
      await f.exited;
      await new Promise<void>((done) => setImmediate(done));
      expect(settled).toBe(false);
      expect(f.kills()).toBe(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      cancelRelease.resolve();
    }
    const outcome = await closing;
    f.expectCloseFailure(outcome);
    expect(outcome).toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
      cause: expect.any(AggregateError),
    });
    const reasons: unknown[] = [];
    function collect(error: unknown) {
      if (reasons.includes(error)) return;
      reasons.push(error);
      if (error instanceof AggregateError) error.errors.forEach(collect);
      if (error instanceof Error && error.cause) collect(error.cause);
    }
    collect(outcome);
    expect(reasons).toContainEqual(
      expect.objectContaining({
        code: failure.code,
        message: failure.message,
        details: failure.details,
      }),
    );
    expect(reasons).toContain(cleanupFailure);
    await expect(f.owner.close()).rejects.toBe(outcome);
    expect(cancel).toHaveBeenCalledTimes(1);
    await native.close();
    nativeClosed = true;
  },
);
