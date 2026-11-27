import type * as ProductionConfig from './production-config.js';
/** Real inert constructors/installation; synthetic seal, SQL and required external sources only. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type * as Egress from '@allrice/egress-gateway';
import { EgressPrepareRollbackError } from '@allrice/egress-gateway';
import type * as Model from '@allrice/model-gateway';
import {
  ApfsPersonVmDisk,
  MicrosandboxPersonVm,
  PersonVmAdmissionHost,
  PersonVmError,
  PersonVmService,
  PostgresPersonVmStore,
  type PersonVmAuthority,
} from '@allrice/person-vm';
import type * as ProductionAuthority from './production-authority.js';
import type * as ProductionEgress from './production-egress.js';
import type * as ScheduledWake from './production-scheduled-wake.js';
import {
  DEntryNativeUnavailable,
  dEntryNativeOwnerPort,
} from '../d-entry/native-owner.js';
import { nativeEntryFixture } from '../d-entry/native-entry.fixture.js';
import { installDEntryNativePrewarmPort } from '../d-entry/native-prewarm.js';
import { productionInputsFixture } from './production-inputs.fixture.js';
import { personNativeWebRoster } from '../native-web/composition.js';
import {
  harness,
  MemoryStore,
} from '../../../../packages/person-vm/src/test-support.js';

const io = vi.hoisted(() => ({
  read: vi.fn(),
  database: vi.fn(),
  dedicated: vi.fn(),
  upgradeOperator: vi.fn<typeof Database.requireCurrentPlatformAdmin>(),
  upgradeWake:
    vi.fn<
      () =>
        | ReturnType<typeof ScheduledWake.createProductionScheduledWake>
        | undefined
    >(),
  diskPreprovision: vi.fn(),
  model:
    vi.fn<
      (
        options: Parameters<typeof Model.createModelGateway>[0],
      ) => Pick<
        Model.ModelGatewayPort,
        'handle' | 'revoke' | 'reconcileOwner' | 'close'
      >
    >(),
  authority: vi.fn<() => PersonVmAuthority | undefined>(),
  installation:
    vi.fn<
      (
        owner: ReturnType<
          typeof ProductionEgress.createProductionEgressInstallation
        >,
      ) =>
        | ReturnType<typeof ProductionEgress.createProductionEgressInstallation>
        | undefined
    >(),
  gateway:
    vi.fn<
      (
        options: Parameters<typeof Egress.createEgressGateway>[0],
        gateway: ReturnType<typeof Egress.createEgressGateway>,
      ) => void
    >(),
}));
vi.mock('./production-disk-preprovision.js', () => ({
  startProductionDiskPreprovision: io.diskPreprovision,
}));
vi.mock('./production-config.js', async (original) => ({
  ...(await original<typeof ProductionConfig>()),
  readProductionHostConfiguration: io.read,
}));
vi.mock('./production-authority.js', async (original) => {
  const actual = await original<typeof ProductionAuthority>();
  return {
    ...actual,
    createProductionPersonVmAuthority: (
      ...args: Parameters<typeof actual.createProductionPersonVmAuthority>
    ) => {
      const owner = actual.createProductionPersonVmAuthority(...args),
        authority = io.authority();
      // Explicit construction-time test source; never mutate the frozen owner.
      return authority ? Object.freeze({ ...owner, authority }) : owner;
    },
  };
});
vi.mock('./production-egress.js', async (original) => {
  const actual = await original<typeof ProductionEgress>();
  return {
    ...actual,
    createProductionEgressInstallation: (
      ...args: Parameters<typeof actual.createProductionEgressInstallation>
    ) => {
      const owner = actual.createProductionEgressInstallation(...args);
      return io.installation(owner) ?? owner;
    },
  };
});
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getDatabase: io.database,
  createDedicatedDatabase: io.dedicated,
  requireCurrentPlatformAdmin: io.upgradeOperator,
}));
vi.mock('./production-scheduled-wake.js', async (original) => {
  const actual = await original<typeof ScheduledWake>();
  return {
    ...actual,
    createProductionScheduledWake: (
      input: Parameters<typeof actual.createProductionScheduledWake>[0],
    ) => io.upgradeWake() ?? actual.createProductionScheduledWake(input),
  };
});
vi.mock('@allrice/model-gateway', async (original) => ({
  ...(await original<typeof Model>()),
  createModelGateway: io.model,
}));
vi.mock('@allrice/egress-gateway', async (original) => {
  const actual = await original<typeof Egress>();
  return {
    ...actual,
    createEgressGateway: (
      options: Parameters<typeof actual.createEgressGateway>[0],
    ) => {
      const gateway = actual.createEgressGateway(options);
      io.gateway(options, gateway);
      return gateway;
    },
  };
});
import {
  createProductionPersonVmHost,
  ProductionPersonVmHostUnavailable,
  type ProductionPersonVmHostSources,
} from './production-host.js';

type Bound = Awaited<ReturnType<ProductionPersonVmHostSources['bind']>>;
type BindInput = Parameters<ProductionPersonVmHostSources['bind']>[0];
let f: Awaited<ReturnType<typeof productionInputsFixture>>;
const cleanup: (() => Promise<unknown>)[] = [];
const signal = () => new AbortController().signal;
const trustedDatabase = Object.freeze({
  source: 'synthetic-trusted-connection-options-not-a-DSN',
});
function gate() {
  let release: () => void = () => {
    throw Error('fixture latch is not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function expectUninstalled() {
  const scope = nativeEntryFixture();
  expect(() =>
    dEntryNativeOwnerPort.resolve(scope.context, scope.identity, signal()),
  ).toThrowError(DEntryNativeUnavailable);
}
function fixture() {
  let input: BindInput | undefined;
  const bound: Bound = {
    runtime: {
      readiness: vi.fn(async () => {
        throw new PersonVmError('RUNTIME_NOT_READY');
      }),
      activity: vi.fn(async () => {
        throw new PersonVmError('ACTIVITY_UNKNOWN');
      }),
      close: vi.fn(async () => {}),
    },
    egress: {
      authority: {
        context: vi.fn(async () => {
          throw new PersonVmError('AUTHORIZATION_DENIED');
        }),
        allow: vi.fn(async () => {
          throw new PersonVmError('AUTHORIZATION_DENIED');
        }),
      },
      // No model/read route is exercised by this inert construction fixture.
      // This is not a production model-disabled adapter or send-ready proof.
      policy: { routes: [] },
      bindModelCall: vi.fn(),
      close: vi.fn(async () => {}),
    },
    model: {
      authority: {
        assertCall: vi.fn(async () => {
          throw Error('no model call in this fixture');
        }),
        authorizeUsage: vi.fn(async () => {
          throw Error('no model usage in this fixture');
        }),
        confirmOwnerStopped: vi.fn(async () => {
          throw Error('no model recovery in this fixture');
        }),
      },
      llm: {
        prepareCall: vi.fn(async () => {
          throw Error('no model dispatch in this fixture');
        }),
      },
      route: {
        provider: 'synthetic-provider',
        model: 'synthetic-model',
        transport: 'sse',
        classify: vi.fn(() => null),
      },
      resolveCall: vi.fn(async () => {
        throw Error('no model call in this fixture');
      }),
    },
  };
  const model = {
    handle: vi.fn<Model.ModelGatewayPort['handle']>(async () => {
      throw Error('no model dispatch in this fixture');
    }),
    revoke: vi.fn<Model.ModelGatewayPort['revoke']>(async () => {
      throw Error('no model should exist in this construction fixture');
    }),
    reconcileOwner: vi.fn<Model.ModelGatewayPort['reconcileOwner']>(
      async () => {
        throw Error('no model recovery in this fixture');
      },
    ),
    close: vi.fn(async () => {}),
  };
  io.model.mockReturnValue(model);
  const sources: ProductionPersonVmHostSources = {
    bind: vi.fn(async (value: BindInput) => {
      input = value;
      return bound;
    }),
  };
  return {
    sources,
    bound,
    model,
    input: () => {
      if (!input) throw Error('source was not bound');
      return input;
    },
  };
}
async function open(value = fixture(), lifetime = new AbortController()) {
  const host = await createProductionPersonVmHost({
    sources: value.sources,
    lifetime: lifetime.signal,
  });
  cleanup.push(() => host.close());
  return { ...value, host, lifetime };
}
/** Public service start/cleanup with synthetic physical/PG boundaries. The
 * actual Host, service receipt copies and gateway listener/revoke remain real. */
async function receiptFixture() {
  const memory = new MemoryStore(),
    physical = harness(memory),
    entry = nativeEntryFixture(),
    value = fixture();
  io.authority.mockReturnValue(physical.options.authority);
  value.model.revoke = vi.fn(async () => {});
  const opened = await open(value),
    input = opened.input(),
    gateway = io.gateway.mock.calls[0]?.[1];
  if (!gateway) throw Error('actual gateway was not constructed');
  vi.spyOn(PostgresPersonVmStore.prototype, 'withLease').mockImplementation(
    memory.withLease.bind(memory),
  );
  // Replace the external shared PG observation only, not the service callback.
  vi.spyOn(input.admission, 'trackOwner').mockImplementation(
    async (_personId, active, work) => {
      active.throwIfAborted();
      return work(active);
    },
  );
  vi.spyOn(input.providers.disk, 'create').mockImplementation(
    physical.disk.create,
  );
  vi.spyOn(input.providers.disk, 'inspect').mockImplementation(
    physical.disk.inspect,
  );
  vi.spyOn(input.providers.disk, 'attach').mockImplementation(
    physical.disk.attach,
  );
  vi.spyOn(input.providers.disk, 'detach').mockImplementation(
    physical.disk.detach,
  );
  vi.spyOn(input.providers.native, 'prepare').mockImplementation(
    physical.native.prepare,
  );
  vi.spyOn(input.providers.native, 'status').mockImplementation(
    physical.native.status,
  );
  vi.spyOn(input.providers.native, 'stop').mockImplementation(
    physical.native.stop,
  );
  const startFailure = new PersonVmError('RUNTIME_NOT_READY');
  const prepareWeb = vi
    .spyOn(input.providers.native, 'prepareWebEndpoints')
    .mockRejectedValue(startFailure);
  const facts = {
    personId: entry.context.actor.id,
    organizationId: entry.context.organizationId,
    entries: [
      {
        workspaceId: entry.identity.workspaceId,
        employeeInstanceId: entry.identity.employeeInstanceId,
        employeeRevision: entry.identity.employeeRevision,
        employeeVersionId: entry.identity.employeeVersionId,
      },
    ],
  };
  vi.spyOn(personNativeWebRoster, 'prepare').mockResolvedValue({
    ...facts,
    digest: `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`,
  });
  const provisioner = input.providers.egressInstallation.provisioner;
  vi.spyOn(provisioner, 'endpoint').mockImplementation(async (_vmId, ports) => {
    const port = ports[0] ?? 0;
    return { host: '127.0.0.1', port, guestOrigin: `http://127.0.0.1:${port}` };
  });
  vi.spyOn(provisioner, 'install').mockResolvedValue(undefined);
  vi.spyOn(provisioner, 'remove').mockResolvedValue(undefined);
  const prepareNormally = gateway.prepare.bind(gateway);
  const prepare = vi.spyOn(gateway, 'prepare'),
    revoke = vi.spyOn(gateway, 'revoke');
  await input.vm.create(entry.context, signal());
  return {
    ...opened,
    memory,
    entry,
    gateway,
    prepare,
    prepareNormally,
    revoke,
    prepareWeb,
    startFailure,
  };
}
beforeEach(async () => {
  vi.clearAllMocks();
  io.authority.mockReset();
  io.installation.mockReset();
  io.diskPreprovision.mockReset();
  f = await productionInputsFixture();
  io.read.mockResolvedValue(f.loaded);
  io.database.mockReturnValue(trustedDatabase);
  io.dedicated.mockImplementation(() => {
    throw Error('synthetic SQL boundary: no PostgreSQL is opened');
  });
});
afterEach(async () => {
  const joined = await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(f.root, { recursive: true, force: true });
  const errors = joined.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (errors.length) throw new AggregateError(errors, 'fixture cleanup');
});

it('missing required production sources leaves ports uninstalled before any provider/SQL construction', async () => {
  await expect(
    createProductionPersonVmHost({ lifetime: signal() }),
  ).rejects.toMatchObject({
    name: 'ProductionPersonVmHostUnavailable',
    code: 'HOST_SOURCES_UNAVAILABLE',
  });
  expect(io.read).not.toHaveBeenCalled();
  expect(io.database).not.toHaveBeenCalled();
  expect(io.gateway).not.toHaveBeenCalled();
  expectUninstalled();
});

function configureDiskPreprovision(enabled: boolean, sealedCache: boolean) {
  const native = f.loaded.configuration.native;
  if (sealedCache) {
    const hash = '1'.repeat(64);
    native.image = `docker.io/library/node@sha256:${hash}`;
    native.publicImageCache = {
      directory: `${f.root}/cache/${hash}`,
      manifestSha256: hash,
    };
  }
  f.loaded.configuration.disk.preprovision = enabled
    ? {
        enabled: true,
        platform: 'macos',
        minimumFreeBytes: 100,
        reserveBytes: 20,
      }
    : { enabled: false };
}

it('does not install disk preparation from a seal with the switch off', async () => {
  configureDiskPreprovision(false, true);
  const host = await createProductionPersonVmHost({
    lifetime: signal(),
    sources: fixture().sources,
  });
  cleanup.push(() => host.close());
  expect(io.diskPreprovision).not.toHaveBeenCalled();
});

it('creates and reopens the first private cold owner receipt through the default-off Host and system tmp path', async () => {
  const configuration = f.loaded.configuration.disk;
  configuration.root = join(f.root, 'volume', 'person-vms', 'disks');
  await mkdir(configuration.keyRoot, { mode: 0o700 });
  await expect(lstat(configuration.root)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const opened = await receiptFixture();
  const owner = (await opened.memory.read(opened.entry.context.actor.id))!;
  const physicalRoot = join(
    await realpath(f.root),
    'volume',
    'person-vms',
    'disks',
  );
  const ledger = join(physicalRoot, '.preprovision-ledger');
  const record = join(ledger, `owner.${owner.vmId}.json`);
  expect((await lstat(physicalRoot)).mode & 0o777).toBe(0o700);
  expect((await lstat(ledger)).mode & 0o777).toBe(0o700);
  expect((await lstat(record)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({
    version: 1,
    personId: owner.personId,
    organizationId: owner.organizationId,
    vmId: owner.vmId,
  });
  expect(io.diskPreprovision).not.toHaveBeenCalled();
  opened.memory.rows.delete(owner.personId);
  await expect(
    opened.input().vm.create(opened.entry.context, signal()),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  expect(await opened.memory.read(owner.personId)).toBeNull();
});

it('rejects an enabled Host with no sealed public cache', async () => {
  configureDiskPreprovision(true, false);
  await expect(
    createProductionPersonVmHost({
      lifetime: signal(),
      sources: fixture().sources,
    }),
  ).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_UNAVAILABLE' });
  expect(io.diskPreprovision).not.toHaveBeenCalled();
});

it('installs the actual service disk preparation and joins it before Host close settles', async () => {
  configureDiskPreprovision(true, true);
  const root = await realpath(f.root);
  f.loaded.configuration.disk.root = join(root, 'missing', 'child');
  f.loaded.configuration.disk.keyRoot = join(root, 'keys');
  vi.stubEnv('DATABASE_URL', 'postgres://synthetic.invalid/test');
  const draining = gate();
  const schedulerClose = vi.fn(() => draining.promise);
  io.diskPreprovision.mockReturnValue({ close: schedulerClose });
  const originalPlatform = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  )!;
  const host = await (async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      return await createProductionPersonVmHost({
        lifetime: signal(),
        sources: fixture().sources,
      });
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  })();
  cleanup.push(() => host.close());
  try {
    expect(io.diskPreprovision).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        port: { prepare: expect.any(Function) },
        refill: expect.any(Function),
        minimumFreeBytes: 100,
        reserveBytes: 20,
      }),
    );
    const installed = io.diskPreprovision.mock.calls[0]?.[0];
    expect((await installed.availableBytes(signal())) > 0n).toBe(true);
    let stopped = false;
    const closing = host.close().then(() => {
      stopped = true;
    });
    await turn();
    expect(schedulerClose).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    draining.release();
    await closing;
    expect(stopped).toBe(true);
  } finally {
    draining.release();
  }
});

it('an already cancelled lifetime returns the original reason without constructing sources', async () => {
  const value = fixture(),
    lifetime = new AbortController(),
    reason = Error('synthetic caller cancellation');
  lifetime.abort(reason);
  await expect(
    createProductionPersonVmHost({
      lifetime: lifetime.signal,
      sources: value.sources,
    }),
  ).rejects.toBe(reason);
  expect(io.read).not.toHaveBeenCalled();
  expect(value.sources.bind).not.toHaveBeenCalled();
  expect(value.bound.egress.close).not.toHaveBeenCalled();
});

it('refuses to prepare a scheduled stop without the production wake source', async () => {
  const { host } = await open();
  const { binding, context } = nativeEntryFixture();
  const assertStopCurrent = vi.fn(async () => {});
  await expect(
    host.prepareStopWithWake({ context, binding, assertStopCurrent }, signal()),
  ).resolves.toEqual({ blocked: true, reason: 'SCHEDULE_WAKE_UNAVAILABLE' });
  expect(assertStopCurrent).not.toHaveBeenCalled();
  expect(io.dedicated).not.toHaveBeenCalled();
});

it('resumes startup and wake if a drain recovery makes a wake eligible', async () => {
  const { context } = nativeEntryFixture();
  const memory = new MemoryStore();
  const physical = harness(memory);
  await physical.service.create(context, signal());
  await physical.service.start(context, signal());
  const row = await memory.read(context.actor.id);
  expect(row?.phase).toBe('running');
  const value = fixture();
  value.bound.scheduledWake = { start: vi.fn(), assertDeliverable: vi.fn() };
  io.upgradeOperator.mockResolvedValueOnce(context.actor.id);
  const nextWake = vi.fn().mockResolvedValue(null);
  const wake = {
    nextCommittedWakeAt: nextWake,
    start: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    assertScheduledIdleCurrent: vi.fn(),
    dispatchScheduledIdleStop: vi.fn(),
    dispatchUpgradeStop: vi.fn(),
    prepareStopWithWake: vi.fn(),
    prepareUpgradeStop: vi.fn(),
  };
  io.upgradeWake.mockReturnValueOnce(wake);
  const list = vi
    .spyOn(PostgresPersonVmStore.prototype, 'listUpgradeCandidates')
    .mockResolvedValueOnce([row!, { ...row!, vmId: randomUUID() }]);
  const recover = vi
    .spyOn(PersonVmService.prototype, 'stopRunningForUpgrade')
    .mockImplementationOnce(async () => {
      nextWake.mockResolvedValueOnce(new Date(Date.now() + 86_400_000));
    });
  const reopen = vi.fn();
  vi.spyOn(PersonVmService.prototype, 'fenceWorkerStartup').mockReturnValueOnce(
    reopen,
  );
  const { host } = await open(value);
  await expect(host.drainForUpgrade(context, signal())).rejects.toMatchObject({
    code: 'ACTIVITY_UNKNOWN',
  });
  expect(list).toHaveBeenCalledTimes(1);
  expect(recover).toHaveBeenCalledTimes(1);
  expect(nextWake).toHaveBeenCalledTimes(4);
  expect(reopen).toHaveBeenCalledTimes(1);
  expect(wake.resume).toHaveBeenCalledTimes(1);
  await expect(host.assertWorkerShutdownSafe(signal())).rejects.toMatchObject({
    code: 'RUNTIME_NOT_READY',
  });
});

it('requires an exact explicit shutdown claim and leaves every committed wake with the scheduler', async () => {
  const { context } = nativeEntryFixture();
  const value = fixture();
  value.bound.scheduledWake = { start: vi.fn(), assertDeliverable: vi.fn() };
  io.upgradeOperator.mockResolvedValue(context.actor.id);
  const future = new Date(Date.now() + 86_400_000);
  const nextCommittedWakeAt = vi.fn().mockResolvedValue(future);
  const wake = {
    nextCommittedWakeAt,
    start: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    assertScheduledIdleCurrent: vi.fn(),
    dispatchScheduledIdleStop: vi.fn(),
    dispatchUpgradeStop: vi.fn(),
    prepareStopWithWake: vi.fn(),
    prepareUpgradeStop: vi.fn(),
  };
  io.upgradeWake.mockReturnValueOnce(wake);
  const list = vi
    .spyOn(PostgresPersonVmStore.prototype, 'listUpgradeCandidates')
    .mockResolvedValue([]);
  const { host } = await open(value);
  await expect(host.drainForUpgrade(context, signal())).rejects.toMatchObject({
    code: 'ACTIVITY_UNKNOWN',
  });
  expect(wake.pause).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();

  nextCommittedWakeAt.mockResolvedValue(null);
  const receipt = await host.drainForUpgrade(context, signal());
  await expect(host.assertWorkerShutdownSafe(signal())).rejects.toMatchObject({
    code: 'RUNTIME_NOT_READY',
  });
  await expect(
    host.assertWorkerShutdownSafe(signal(), 'stale'),
  ).rejects.toMatchObject({
    code: 'RUNTIME_NOT_READY',
  });
  nextCommittedWakeAt.mockResolvedValue(future);
  await expect(
    host.assertWorkerShutdownSafe(signal(), receipt.expiresAt),
  ).rejects.toMatchObject({
    code: 'ACTIVITY_UNKNOWN',
  });
  nextCommittedWakeAt.mockResolvedValue(null);
  await host.assertWorkerShutdownSafe(signal(), receipt.expiresAt);
  await host.assertWorkerShutdownSafe(signal());
});

it('joins the claimed wake before fencing its next epoch on ordinary shutdown', async () => {
  const value = fixture();
  value.bound.scheduledWake = { start: vi.fn(), assertDeliverable: vi.fn() };
  const order: string[] = [];
  let finishWake!: () => void;
  const activeWake = new Promise<void>((resolve) => {
    finishWake = resolve;
  });
  io.upgradeWake.mockReturnValueOnce({
    nextCommittedWakeAt: vi.fn().mockResolvedValue(null),
    start: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(async () => {}),
    pause: vi.fn(async () => {
      order.push('pause');
      await activeWake;
      order.push('wake joined');
    }),
    assertScheduledIdleCurrent: vi.fn(),
    dispatchScheduledIdleStop: vi.fn(),
    dispatchUpgradeStop: vi.fn(),
    prepareStopWithWake: vi.fn(),
    prepareUpgradeStop: vi.fn(),
  });
  vi.spyOn(
    PersonVmService.prototype,
    'fenceWorkerStartup',
  ).mockImplementationOnce(() => {
    order.push('fence');
    return () => {};
  });
  const { host } = await open(value);
  const shutdown = host.assertWorkerShutdownSafe(signal());
  try {
    await vi.waitFor(() => expect(order).toEqual(['pause']));
  } finally {
    finishWake();
  }
  await shutdown;
  expect(order).toEqual(['pause', 'wake joined', 'fence']);
});

it('constructs the real store/service/admission/startup with one SQL factory and the same nondefault platform snapshot', async () => {
  const factory = vi.spyOn(
    PostgresPersonVmStore.prototype,
    'assertAdmissionFactory',
  );
  const admission = vi.spyOn(PersonVmService.prototype, 'createAdmissionHost');
  const platform = Object.freeze({
    ...f.loaded.platform,
    memoryMiB: 3072,
    idleMs: 3333,
  });
  io.read.mockResolvedValue({
    ...f.loaded,
    platform,
    configuration: {
      ...f.loaded.configuration,
      memory: {
        ...f.loaded.configuration.memory,
        policy: {
          ...f.loaded.configuration.memory.policy,
          physicalBytes: platform.memoryMiB * 1024 ** 2,
        },
      },
    },
  });
  const value = await open(),
    actual = value.input();
  expect(actual.vm).toBeInstanceOf(PersonVmService);
  expect(actual.admission).toBeInstanceOf(PersonVmAdmissionHost);
  expect(actual.providers.native).toBeInstanceOf(MicrosandboxPersonVm);
  expect(actual.providers.disk).toBeInstanceOf(ApfsPersonVmDisk);
  expect(actual.providers.platform).toBe(platform);
  expect(admission).toHaveBeenCalledExactlyOnceWith({
    openSql: expect.any(Function),
    idleMs: platform.idleMs,
    nativeActivity: expect.any(Object),
  });
  const options = admission.mock.calls[0]?.[0];
  if (!options) throw Error('real admission constructor was not called');
  expect(factory).toHaveBeenCalledExactlyOnceWith(options.openSql);
  expect(() => options.openSql()).toThrow('synthetic SQL boundary');
  expect(io.dedicated).toHaveBeenCalledExactlyOnceWith(trustedDatabase);
  expect(io.database).toHaveBeenCalledTimes(1);
  expect(io.read).toHaveBeenCalledTimes(1);
  await expect(stat(f.loaded.configuration.disk.root)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(value.bound.runtime.readiness).not.toHaveBeenCalled();
  expect(value.bound.runtime.activity).not.toHaveBeenCalled();
  expect(() =>
    actual.startup.owner(
      {
        vmId: randomUUID(),
        personId: randomUUID(),
        organizationId: randomUUID(),
        instanceId: randomUUID(),
        leaseEpoch: 1,
      },
      randomUUID(),
    ),
  ).toThrowError(PersonVmError);
});

it('gates idle stop at the Host and blocks when no wake owner is installed', async () => {
  const admission = vi.spyOn(PersonVmService.prototype, 'createAdmissionHost');
  io.read.mockResolvedValue({
    ...f.loaded,
    configuration: {
      ...f.loaded.configuration,
      lifecycle: {
        ...f.loaded.configuration.lifecycle,
        idleStopEnabled: true,
      },
    },
  });
  await open();
  const prepare = admission.mock.calls[0]?.[0].prepareIdleStop;
  expect(prepare).toBeTypeOf('function');
  const entry = nativeEntryFixture();
  const assertStopCurrent = vi.fn(async () => {});
  await expect(
    prepare!(
      {
        context: entry.context,
        binding: {
          vmId: randomUUID(),
          personId: entry.context.actor.id,
          organizationId: entry.context.organizationId,
          instanceId: randomUUID(),
          leaseEpoch: 1,
        },
        assertStopCurrent,
      },
      signal(),
    ),
  ).resolves.toEqual({ blocked: true });
  expect(assertStopCurrent).not.toHaveBeenCalled();
});

it('an egress source cannot substitute another VM or shared admission boundary', async () => {
  const value = fixture();
  Object.assign(value.bound.egress, {
    vm: { wrong: 'synthetic conflicting VM' },
    admission: { wrong: 'synthetic conflicting boundary' },
  });
  const actual = (await open(value)).input();
  expect(io.gateway).toHaveBeenCalledTimes(1);
  expect(io.model).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      authority: value.bound.model.authority,
      provider: expect.objectContaining({
        classify: value.bound.model.route.classify,
      }),
      store: expect.objectContaining({ claimCall: expect.any(Function) }),
      admission: {
        boundary: actual.admission,
        participant: expect.objectContaining({ participant: 'gateway' }),
        recoverStoppedPermit: expect.any(Function),
      },
    }),
  );
  expect(io.gateway.mock.calls[0]?.[0]).toMatchObject({
    vm: actual.vm,
    admission: actual.admission,
    authority: value.bound.egress.authority,
    revokeModel: expect.any(Function),
    services: [
      {
        id: 'model',
        path: '/v1/stream',
        method: 'POST',
        admissionOwner: 'service',
        resolve: expect.any(Function),
      },
    ],
    provisioner: actual.providers.egressInstallation.provisioner,
  });
});

it('dispatches only the trusted model-call resolution for the exact lease and approved route', async () => {
  const value = await open(),
    scope = nativeEntryFixture();
  const context = scope.context;
  const binding = {
    vmId: randomUUID(),
    personId: context.actor.id,
    organizationId: context.organizationId,
    instanceId: randomUUID(),
    leaseEpoch: 1,
  };
  const model = io.gateway.mock.calls[0]?.[0].services?.find(
    (service) => service.id === 'model',
  );
  if (!model?.resolve) throw Error('Missing registered model service');
  const headers = { 'x-synthetic-call': 'lookup-only' };
  const request = new IncomingMessage(new Socket());
  request.headers = headers;
  const response = new ServerResponse(request);
  const call: Model.ModelCallBinding = {
    context,
    vm: binding,
    execution: { runId: randomUUID(), executionId: randomUUID() },
    employeeInstanceId: scope.identity.employeeInstanceId,
    employeeRelease: scope.identity.employeeVersionId,
    allriceThreadRef: randomUUID(),
    native: {
      instanceId: randomUUID(),
      profile: 'sealed-test-profile',
      sessionId: 'root',
      rootSessionId: 'root',
      parentSessionId: null,
      callId: randomUUID(),
    },
    executionGeneration: '4.0',
    gatewayRelease: 'synthetic-gateway-release',
    provider: value.bound.model.route.provider,
    model: value.bound.model.route.model,
  };
  const resolveCall = vi.mocked(value.bound.model.resolveCall);
  const active = signal();
  for (const wrong of [
    { ...call, vm: { ...binding, leaseEpoch: 2 } },
    { ...call, context: { ...context, organizationId: randomUUID() } },
    { ...call, model: 'different-route' },
  ]) {
    resolveCall.mockResolvedValueOnce(wrong);
    await expect(model.resolve(request, binding, active)).rejects.toMatchObject(
      { code: 'DENIED' },
    );
  }
  expect(value.model.handle).not.toHaveBeenCalled();
  expect(value.bound.egress.bindModelCall).not.toHaveBeenCalled();

  const next = {
    ...call,
    context: { ...context, sessionId: randomUUID(), workspaceId: randomUUID() },
  };
  const expected = structuredClone(next);
  resolveCall.mockResolvedValueOnce(next);
  value.model.handle.mockResolvedValueOnce(undefined);
  const operation = await model.resolve(request, binding, active);
  expect(resolveCall).toHaveBeenLastCalledWith(headers, binding, active);
  expect(value.model.handle).not.toHaveBeenCalled();
  next.context.workspaceId = randomUUID();
  next.context.sessionId = randomUUID();
  next.execution.executionId = randomUUID();
  expect(operation.context).not.toBe(next.context);
  expect(operation.context).toEqual(expected.context);
  expect(value.bound.egress.bindModelCall).toHaveBeenCalledExactlyOnceWith(
    expected,
    active,
  );
  const policyBinding = vi.mocked(value.bound.egress.bindModelCall!).mock
    .calls[0]![0];
  expect(operation.context).toBe(policyBinding.context);
  expect(Object.isFrozen(operation.context.actor)).toBe(true);
  expect(Object.isFrozen(operation.context.memberships)).toBe(true);
  await operation.dispatch(response, active);
  expect(value.model.handle).toHaveBeenCalledExactlyOnceWith(
    request,
    response,
    expected,
    active,
  );
  expect(value.model.handle).toHaveBeenCalledTimes(1);
});

it('actual service cleanup revokes a copied receipt once and Host.close does not revoke it again', async () => {
  const value = await receiptFixture();
  await expect(
    value.input().vm.start(value.entry.context, signal()),
  ).rejects.toBe(value.startFailure);
  expect(value.prepareWeb).toHaveBeenCalledTimes(1);
  expect(value.prepare).toHaveBeenCalledTimes(1);
  expect(value.revoke).toHaveBeenCalledTimes(1);
  const original = await value.prepare.mock.results[0]!.value,
    copied = value.revoke.mock.calls[0]![0];
  expect(copied).toEqual(original);
  expect(copied).not.toBe(original);
  expect(copied.binding).not.toBe(original.binding);
  expect(copied.gatewayPorts).not.toBe(original.gatewayPorts);
  expect(
    (await value.memory.read(value.entry.context.actor.id))?.egressReceipt,
  ).toBeNull();
  await value.host.close();
  expect(value.revoke).toHaveBeenCalledTimes(1);
  expect(value.model.revoke).toHaveBeenCalledTimes(1);
});

it('passes a late cancelled egress receipt to service cleanup before detach', async () => {
  const value = await receiptFixture();
  const { vm, providers } = value.input();
  const context = value.entry.context;
  const controller = new AbortController();
  value.prepare.mockImplementationOnce(async (...args) => {
    const receipt = await value.prepareNormally(...args);
    controller.abort(new PersonVmError('RUNTIME_NOT_READY'));
    return receipt;
  });

  await expect(vm.start(context, controller.signal)).rejects.toMatchObject({
    code: 'RUNTIME_NOT_READY',
  });
  expect(value.prepareWeb).not.toHaveBeenCalled();
  expect(value.revoke).toHaveBeenCalledOnce();
  const prepared = await value.prepare.mock.results[0]!.value;
  expect(value.revoke.mock.calls[0]?.[0]).toEqual(prepared);
  const detach = vi.mocked(providers.disk.detach);
  expect(detach).toHaveBeenCalledOnce();
  expect(value.revoke.mock.invocationCallOrder[0]).toBeLessThan(
    detach.mock.invocationCallOrder[0]!,
  );
  expect((await value.memory.read(context.actor.id))?.egressReceipt).toBeNull();
  await value.host.close();
  expect(value.revoke).toHaveBeenCalledOnce();
});

it('a failed actual service revoke retains the receipt for the real Host.close retry', async () => {
  const value = await receiptFixture(),
    modelFailure = Error('synthetic first model drain failure');
  vi.mocked(value.model.revoke).mockRejectedValueOnce(modelFailure);
  await expect(
    value.input().vm.start(value.entry.context, signal()),
  ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
  expect(value.prepareWeb).toHaveBeenCalledTimes(1);
  expect(value.revoke).toHaveBeenCalledTimes(1);
  const persisted = await value.memory.read(value.entry.context.actor.id);
  expect(persisted?.egressReceipt).toEqual(value.revoke.mock.calls[0]![0]);
  expect(persisted?.phase).toBe('failed');
  await value.host.close();
  expect(value.revoke).toHaveBeenCalledTimes(2);
  expect(value.revoke.mock.calls[1]![0]).toEqual(
    value.revoke.mock.calls[0]![0],
  );
  expect(value.model.revoke).toHaveBeenCalledTimes(2);
});

it('retains maintenance after VM stop is unconfirmed even when model close succeeded', async () => {
  const value = await receiptFixture();
  const { vm, providers } = value.input();
  const context = value.entry.context;
  const stop = vi.mocked(providers.native.stop);
  const stopNormally = stop.getMockImplementation()!;
  const detach = vi.mocked(providers.disk.detach);
  stop.mockRejectedValue(Error('synthetic unconfirmed physical stop'));
  await expect(vm.start(context, signal())).rejects.toMatchObject({
    code: 'CLEANUP_INCOMPLETE',
  });
  const originalClose = value.host.close();
  await expect(originalClose).rejects.toMatchObject({
    errors: [expect.objectContaining({ code: 'CLEANUP_INCOMPLETE' })],
  });
  expect(value.model.close).toHaveBeenCalledOnce();
  expect(value.host.modelOwnerMaintenancePending()).toBe(true);
  expect(detach).not.toHaveBeenCalled();
  expect(value.bound.egress.close).not.toHaveBeenCalled();

  value.model.reconcileOwner.mockRejectedValueOnce(
    Error('no exact stop proof'),
  );
  await expect(value.host.recoverModelOwner(context, signal())).rejects.toThrow(
    'no exact stop proof',
  );
  expect(value.host.modelOwnerMaintenancePending()).toBe(true);

  stop.mockImplementation(stopNormally);
  value.model.reconcileOwner.mockResolvedValueOnce(0);
  await expect(value.host.recoverModelOwner(context, signal())).resolves.toBe(
    0,
  );
  expect(detach).toHaveBeenCalledOnce();
  expect(value.host.modelOwnerMaintenancePending()).toBe(false);
  await expect(value.host.close()).resolves.toBeUndefined();
});

it('tracks a start that fails at disk attach before egress preparation', async () => {
  const value = await receiptFixture();
  const { vm, providers } = value.input();
  const context = value.entry.context;
  const attach = vi.mocked(providers.disk.attach);
  const attachNormally = attach.getMockImplementation()!;
  attach.mockRejectedValue(Error('synthetic attach outcome unconfirmed'));
  await expect(vm.start(context, signal())).rejects.toMatchObject({
    code: 'CLEANUP_INCOMPLETE',
  });
  expect(value.prepare).not.toHaveBeenCalled();
  await expect(value.host.close()).rejects.toMatchObject({
    errors: [expect.objectContaining({ code: 'CLEANUP_INCOMPLETE' })],
  });
  expect(value.host.modelOwnerMaintenancePending()).toBe(true);
  expect(providers.disk.detach).not.toHaveBeenCalled();

  attach.mockImplementation(attachNormally);
  value.model.reconcileOwner.mockResolvedValueOnce(0);
  await expect(value.host.recoverModelOwner(context, signal())).resolves.toBe(
    0,
  );
  expect(providers.disk.detach).toHaveBeenCalledOnce();
  expect(value.host.modelOwnerMaintenancePending()).toBe(false);
  await expect(value.host.close()).resolves.toBeUndefined();
});

it('retains the mount of an older epoch without stopping its unowned native job', async () => {
  const value = await receiptFixture();
  const { vm, providers } = value.input();
  const context = value.entry.context;
  const row = await value.memory.read(context.actor.id);
  if (!row) throw Error('missing setup VM');
  value.memory.rows.set(context.actor.id, {
    ...row,
    phase: 'failed',
    instanceId: randomUUID(),
    nativeCreated: true,
    leaseEpoch: 3,
  });

  const status = vi.mocked(providers.native.status);
  status.mockRejectedValueOnce(Error('synthetic retained VM status failure'));
  await expect(vm.start(context, signal())).rejects.toThrow(
    'synthetic retained VM status failure',
  );
  expect(providers.disk.attach).toHaveBeenCalled();
  expect(value.prepare).not.toHaveBeenCalled();
  status.mockResolvedValue('running');
  await expect(value.host.close()).rejects.toMatchObject({
    errors: [expect.objectContaining({ code: 'CLEANUP_INCOMPLETE' })],
  });
  expect(value.host.modelOwnerMaintenancePending()).toBe(true);
  expect(providers.native.stop).not.toHaveBeenCalled();
  expect(providers.disk.detach).not.toHaveBeenCalled();

  status.mockResolvedValue('stopped');
  value.model.reconcileOwner.mockResolvedValueOnce(0);
  await expect(value.host.recoverModelOwner(context, signal())).resolves.toBe(
    0,
  );
  expect(providers.native.stop).not.toHaveBeenCalled();
  expect(providers.disk.detach).toHaveBeenCalledOnce();
  expect(value.host.modelOwnerMaintenancePending()).toBe(false);
});

it('preserves an older receipt when this process cannot prove its egress owner', async () => {
  const value = await receiptFixture();
  const { vm, providers } = value.input();
  const context = value.entry.context;
  const row = await value.memory.read(context.actor.id);
  if (!row) throw Error('missing setup VM');
  const binding = {
    vmId: row.vmId,
    personId: row.personId,
    organizationId: row.organizationId,
    instanceId: randomUUID(),
    leaseEpoch: 3,
  };
  const receipt = { binding, gatewayPorts: [41235], bindingId: randomUUID() };
  value.memory.rows.set(context.actor.id, {
    ...row,
    ...binding,
    phase: 'failed',
    nativeCreated: true,
    egressReceipt: receipt,
  });

  const status = vi.mocked(providers.native.status);
  status.mockRejectedValueOnce(Error('synthetic retained VM status failure'));
  await expect(vm.start(context, signal())).rejects.toThrow(
    'synthetic retained VM status failure',
  );
  status.mockResolvedValue('stopped');
  await expect(vm.start(context, signal())).rejects.toMatchObject({
    code: 'CLEANUP_INCOMPLETE',
  });
  const closeFixture = cleanup.pop()!;
  const original = value.host.close();
  cleanup.push(async () => {
    await closeFixture().catch(() => {});
  });
  await expect(original).rejects.toMatchObject({
    errors: [expect.objectContaining({ code: 'CLEANUP_INCOMPLETE' })],
  });
  expect(value.revoke).not.toHaveBeenCalled();
  expect(providers.native.stop).not.toHaveBeenCalled();
  expect(providers.disk.detach).not.toHaveBeenCalled();
  expect((await value.memory.read(context.actor.id))?.egressReceipt).toEqual(
    receipt,
  );
  expect(value.host.modelOwnerMaintenancePending()).toBe(true);
});

it.each(['original epoch', 'peer epoch'] as const)(
  'retires a real unpublished egress binding in maintenance with the %s',
  async (kind) => {
    const value = await receiptFixture();
    const { vm, providers } = value.input();
    const context = value.entry.context;
    const provisioner = providers.egressInstallation.provisioner;
    const retire = vi.spyOn(value.gateway, 'retireFailedPrepare');
    const install = Error('synthetic setup failure');
    vi.mocked(provisioner.install).mockRejectedValueOnce(install);
    vi.mocked(provisioner.remove).mockRejectedValue(
      Error('synthetic unjoined cleanup'),
    );
    await expect(vm.start(context, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    const failed = await value.prepare.mock.results[0]!.value.catch(
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(EgressPrepareRollbackError);
    const record = await value.memory.read(context.actor.id);
    expect(record).toMatchObject({ phase: 'failed', egressReceipt: null });
    expect(providers.native.stop).toHaveBeenCalled();
    expect(providers.disk.detach).not.toHaveBeenCalled();
    const peer = kind === 'peer epoch';
    if (peer) {
      await value.memory.withLease(
        context.actor.id,
        { now: () => new Date(), ttlMs: 5000 },
        async (lease) => {
          const next = lease.row!;
          next.instanceId = randomUUID();
          next.leaseEpoch++;
          next.phase = 'stopped';
          await lease.save(next);
        },
      );
      const attachCount = vi.mocked(providers.disk.attach).mock.calls.length;
      await expect(vm.start(context, signal())).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
      expect(providers.disk.attach).toHaveBeenCalledTimes(attachCount);
      expect(value.prepare).toHaveBeenCalledOnce();
    }
    const original = value.host.close();
    await expect(original).rejects.toMatchObject({
      errors: expect.arrayContaining([failed]),
    });
    expect(value.host.modelOwnerMaintenancePending()).toBe(true);

    const beforeRecovery = vi.mocked(providers.native.stop).mock.calls.length;
    value.model.reconcileOwner.mockResolvedValue(0);
    await expect(
      value.host.recoverModelOwner(context, signal()),
    ).rejects.toMatchObject({
      errors: expect.arrayContaining([failed]),
    });
    expect(providers.disk.detach).not.toHaveBeenCalled();
    expect(value.host.modelOwnerMaintenancePending()).toBe(true);

    expect(providers.native.stop).toHaveBeenCalledTimes(beforeRecovery);
    vi.mocked(provisioner.remove).mockResolvedValue(undefined);
    const before = await value.memory.read(context.actor.id);
    const statuses = vi.mocked(providers.native.status).mock.calls.length;
    await expect(value.host.recoverModelOwner(context, signal())).resolves.toBe(
      0,
    );
    expect(retire).toHaveBeenCalledTimes(2);
    expect(retire).toHaveBeenLastCalledWith(
      value.prepare.mock.calls[0]![0],
      expect.any(AbortSignal),
    );
    expect(providers.native.stop).toHaveBeenCalledTimes(beforeRecovery);
    expect(providers.disk.detach).toHaveBeenCalledTimes(peer ? 0 : 1);
    const after = await value.memory.read(context.actor.id);
    if (peer) {
      expect(after).toEqual(before);
      expect(providers.native.status).toHaveBeenCalledTimes(statuses);
    } else {
      expect(after?.phase).toBe('stopped');
    }
    expect(value.host.modelOwnerMaintenancePending()).toBe(false);
    await expect(value.host.close()).resolves.toBeUndefined();
  },
);

it('does not hold the mount or maintenance for an installation error whose rollback joined', async () => {
  const value = await receiptFixture();
  const { vm, providers } = value.input();
  const context = value.entry.context;
  vi.mocked(
    providers.egressInstallation.provisioner.install,
  ).mockRejectedValueOnce(
    new AggregateError(
      [Error('synthetic installation failure')],
      'EGRESS_INSTALL_FAILED',
    ),
  );
  await expect(vm.start(context, signal())).rejects.toMatchObject({
    code: 'PROVIDER_FAILED',
  });
  expect(providers.disk.detach).toHaveBeenCalledOnce();
  await expect(value.host.close()).resolves.toBeUndefined();
  expect(value.host.modelOwnerMaintenancePending()).toBe(false);
});

it('rolls back an unpublished egress listener with a live cleanup signal after start cancellation', async () => {
  const value = await receiptFixture();
  const { vm, providers } = value.input();
  const context = value.entry.context;
  const cancellation = new AbortController();
  const provisioner = providers.egressInstallation.provisioner;
  vi.mocked(provisioner.install).mockImplementationOnce(async () => {
    cancellation.abort(new PersonVmError('RUNTIME_NOT_READY'));
  });
  vi.mocked(provisioner.remove).mockImplementationOnce(
    async (_binding, cleanupSignal) => {
      cleanupSignal.throwIfAborted();
    },
  );

  await expect(vm.start(context, cancellation.signal)).rejects.toMatchObject({
    code: 'RUNTIME_NOT_READY',
  });
  expect(provisioner.remove).toHaveBeenCalledOnce();
  expect(providers.disk.detach).toHaveBeenCalledOnce();
  await expect(value.host.close()).resolves.toBeUndefined();
  expect(value.host.modelOwnerMaintenancePending()).toBe(false);
});

it.each(['later epoch', 'replacement VM', 'deleted'] as const)(
  'settles its old mount after a peer commits %s without touching the peer record or VM',
  async (kind) => {
    const value = await receiptFixture();
    const { vm, providers } = value.input();
    const context = value.entry.context;
    const row = await value.memory.read(context.actor.id);
    if (!row) throw Error('missing setup VM');
    value.memory.rows.set(context.actor.id, {
      ...row,
      phase: 'failed',
      instanceId: randomUUID(),
      nativeCreated: true,
      leaseEpoch: 3,
    });
    vi.mocked(providers.native.status).mockRejectedValueOnce(
      Error('synthetic mount readback failed'),
    );
    await expect(vm.start(context, signal())).rejects.toThrow(
      'synthetic mount readback failed',
    );
    expect(providers.disk.attach).toHaveBeenCalledOnce();
    await value.memory.withLease(
      context.actor.id,
      { now: () => new Date(), ttlMs: 5000 },
      async (lease) => {
        const previous = lease.row!;
        if (kind === 'deleted') {
          previous.phase = 'deleted';
        } else if (kind === 'replacement VM') {
          previous.vmId = randomUUID();
          previous.instanceId = null;
          previous.leaseEpoch = 0;
          previous.nativeCreated = false;
          previous.phase = 'starting';
        } else {
          previous.leaseEpoch++;
          previous.instanceId = randomUUID();
          previous.gatewayPorts = [41236];
          previous.egressReceipt = {
            binding: {
              vmId: previous.vmId,
              personId: previous.personId,
              organizationId: previous.organizationId,
              instanceId: previous.instanceId,
              leaseEpoch: previous.leaseEpoch,
            },
            bindingId: randomUUID(),
            gatewayPorts: [41236],
          };
          previous.phase = 'running';
        }
        await lease.save(previous);
      },
    );
    const peer = await value.memory.read(context.actor.id);
    await expect(value.host.close()).resolves.toBeUndefined();
    expect(await value.memory.read(context.actor.id)).toEqual(peer);
    expect(value.host.modelOwnerMaintenancePending()).toBe(false);
    expect(providers.native.stop).not.toHaveBeenCalled();
    expect(providers.native.status).toHaveBeenCalledOnce();
    expect(providers.disk.detach).not.toHaveBeenCalled();
  },
);

it('a stale persisted service receipt cannot remove a retained newer epoch from Host cleanup', async () => {
  const value = await receiptFixture(),
    vm = value.input().vm,
    context = value.entry.context;
  await expect(vm.start(context, signal())).rejects.toBe(value.startFailure);
  expect(value.prepareWeb).toHaveBeenCalledTimes(1);
  const old = await value.memory.read(context.actor.id);
  if (!old) throw Error('actual service did not persist its first epoch');
  const oldReceipt = await value.prepare.mock.results[0]!.value;
  let failNew = true;
  vi.mocked(value.model.revoke).mockImplementation(async (binding) => {
    if (binding.leaseEpoch > old.leaseEpoch && failNew)
      throw Error('synthetic new epoch drain failure');
  });
  await expect(vm.start(context, signal())).rejects.toMatchObject({
    code: 'CLEANUP_INCOMPLETE',
  });
  expect(value.prepareWeb).toHaveBeenCalledTimes(2);
  const current = await value.memory.read(context.actor.id);
  if (!current?.egressReceipt)
    throw Error('new epoch receipt was not retained');
  expect(current.leaseEpoch).toBeGreaterThan(old.leaseEpoch);
  // Explicit stale-store fixture: the actual service delivers another copied
  // old epoch to gateway.revoke, whose exact check leaves the new state alone.
  value.memory.rows.set(context.actor.id, {
    ...old,
    egressReceipt: structuredClone(oldReceipt),
  });
  await expect(vm.stop(context, signal())).resolves.toMatchObject({
    phase: 'stopped',
  });
  const stale = value.revoke.mock.calls.at(-1)![0];
  expect(stale).toEqual(oldReceipt);
  expect(stale).not.toBe(oldReceipt);
  await expect(
    value.gateway.assertActive(current.egressReceipt, signal()),
  ).rejects.toBeInstanceOf(Error); // Failed drain fenced the new state.
  failNew = false;
  const beforeClose = value.revoke.mock.calls.length;
  const native = value.input().providers.native;
  const beforeStop = vi.mocked(native.stop).mock.calls.length;
  const closeFixture = cleanup.pop()!;
  const error = await value.host.close().then(
    () => undefined,
    (error: unknown) => error,
  );
  cleanup.push(async () => {
    await closeFixture().catch((later: unknown) => {
      if (later !== error) throw later;
    });
  });
  expect(error).toMatchObject({
    errors: [expect.objectContaining({ code: 'LEASE_LOST' })],
  });
  expect(native.stop).toHaveBeenCalledTimes(beforeStop);
  expect(value.revoke).toHaveBeenCalledTimes(beforeClose + 1);
  expect(value.revoke.mock.calls.at(-1)![0]).toEqual(current.egressReceipt);
  expect(value.revoke.mock.calls.at(-1)![0].binding.leaseEpoch).toBe(
    current.leaseEpoch,
  );
});

it('missing native activity is unknown, and a real later observer is forwarded without synthesized counts', async () => {
  const admission = vi.spyOn(PersonVmService.prototype, 'createAdmissionHost');
  const value = await open(),
    observer = admission.mock.calls[0]?.[0].nativeActivity;
  if (!observer) throw Error('missing native observation forwarding');
  const binding = {
      vmId: randomUUID(),
      personId: randomUUID(),
      organizationId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
    },
    current = signal();
  await expect(observer.observe(binding, current)).rejects.toMatchObject({
    code: 'ACTIVITY_UNKNOWN',
  });
  await expect(observer.subscribe(binding, current)).rejects.toMatchObject({
    code: 'ACTIVITY_UNKNOWN',
  });
  const reason = Error('synthetic real source result');
  value.bound.nativeActivity = {
    observe: vi.fn(async () => {
      throw reason;
    }),
    subscribe: vi.fn(async () => {
      throw reason;
    }),
  };
  await expect(observer.observe(binding, current, 'stop-guard')).rejects.toBe(
    reason,
  );
  expect(value.bound.nativeActivity.observe).toHaveBeenCalledExactlyOnceWith(
    binding,
    expect.any(AbortSignal),
    'stop-guard',
  );
});

it('a missing verified artifact prevents source binding and any native installation', async () => {
  const value = fixture();
  await rm(f.loaded.configuration.native.binary);
  await expect(
    createProductionPersonVmHost({
      sources: value.sources,
      lifetime: signal(),
    }),
  ).rejects.toThrow('PERSON_VM_ARTIFACTS_UNAVAILABLE');
  expect(value.sources.bind).not.toHaveBeenCalled();
  expect(io.database).not.toHaveBeenCalled();
  expect(io.gateway).not.toHaveBeenCalled();
});

it('cancellation during source construction joins both late source publication and its actual close', async () => {
  const value = fixture(),
    entered = gate(),
    returned = gate(),
    closing = gate(),
    closed = gate(),
    lifetime = new AbortController(),
    reason = Error('synthetic final-construction cancellation');
  vi.mocked(value.sources.bind).mockImplementation(async () => {
    entered.release();
    await returned.promise;
    return value.bound;
  });
  vi.mocked(value.bound.egress.close).mockImplementation(async () => {
    closing.release();
    await closed.promise;
  });
  let settled = false;
  const outcome = createProductionPersonVmHost({
    sources: value.sources,
    lifetime: lifetime.signal,
  }).then(
    () => {
      settled = true;
      throw Error('cancelled constructor must not install');
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await entered.promise;
    lifetime.abort(reason);
    await turn();
    expect(settled).toBe(false);
    returned.release();
    await closing.promise;
    await turn();
    expect(settled).toBe(false);
    expect(io.gateway).not.toHaveBeenCalled();
    closed.release();
    expect(await outcome).toBe(reason);
    expect(value.bound.egress.close).toHaveBeenCalledTimes(1);
  } finally {
    returned.release();
    closed.release();
    await outcome;
  }
});

it('failed source construction joins actual provider rollback before returning the primary error', async () => {
  const value = fixture(),
    entered = gate(),
    released = gate(),
    reason = Error('synthetic source construction failed');
  let rolledBack = false;
  const providerClose = vi.fn();
  io.installation.mockImplementation((owner) => {
    expect(Object.isFrozen(owner)).toBe(true);
    return Object.freeze({
      ...owner,
      close: async () => {
        providerClose();
        entered.release();
        await released.promise;
        await owner.close();
        rolledBack = true;
      },
    });
  });
  vi.mocked(value.sources.bind).mockRejectedValue(reason);
  let settled = false;
  const outcome = createProductionPersonVmHost({
    sources: value.sources,
    lifetime: signal(),
  }).catch((error: unknown) => {
    settled = true;
    return error;
  });
  try {
    await entered.promise;
    await turn();
    expect(settled).toBe(false);
    expect(rolledBack).toBe(false);
    expect(io.gateway).not.toHaveBeenCalled();
    released.release();
    expect(await outcome).toBe(reason);
    expect(providerClose).toHaveBeenCalledTimes(1);
    expect(rolledBack).toBe(true);
    expect(value.bound.egress.close).not.toHaveBeenCalled();
  } finally {
    released.release();
    await outcome;
  }
});

it('close fences the native ports and joins source work; repeated close has one actual owner', async () => {
  const value = await open(),
    entered = gate(),
    released = gate();
  vi.mocked(value.bound.egress.close).mockImplementation(async () => {
    entered.release();
    await released.promise;
  });
  let settled = false;
  const closed = value.host.close();
  expect(value.host.close()).toBe(closed);
  const outcome = closed.then(() => {
    settled = true;
  });
  try {
    await entered.promise;
    await turn();
    expect(settled).toBe(false);
    expect(value.input().lifetime.aborted).toBe(true);
    expectUninstalled();
    released.release();
    await outcome;
    expect(value.bound.egress.close).toHaveBeenCalledTimes(1);
    expect(value.model.close).toHaveBeenCalledTimes(1);
    expect(value.model.close.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(value.bound.egress.close).mock.invocationCallOrder[0]!,
    );
    expect(value.model.revoke).not.toHaveBeenCalled();
  } finally {
    released.release();
    await outcome;
  }
});

it('retains the provider owner when the model gateway cannot prove its join', async () => {
  const value = fixture();
  const failure = Error('synthetic unknown model transport join');
  value.model.close.mockRejectedValue(failure);
  const host = await createProductionPersonVmHost({
    sources: value.sources,
    lifetime: signal(),
  });
  await expect(host.close()).rejects.toMatchObject({ errors: [failure] });
  expect(value.model.close).toHaveBeenCalledTimes(1);
  expect(value.bound.egress.close).not.toHaveBeenCalled();
  expectUninstalled();
});

it('authenticates recovery on the same closed owner and joins deferred provider cleanup', async () => {
  const value = fixture();
  const unknown = Error('unconfirmed model transport');
  const denied = Error('no exact owner stop proof');
  const context = nativeEntryFixture().context;
  const owner = new AbortController();
  const host = await createProductionPersonVmHost({
    sources: value.sources,
    lifetime: owner.signal,
  });
  const ownerId = io.model.mock.calls[0]![0].ownerId;
  await expect(host.recoverModelOwner(context, signal())).rejects.toMatchObject(
    {
      code: 'MODEL_RECOVERY_UNAVAILABLE',
    },
  );
  value.model.close.mockRejectedValueOnce(unknown);
  owner.abort();
  const first = host.close();
  await expect(first).rejects.toMatchObject({ errors: [unknown] });

  value.model.reconcileOwner.mockRejectedValueOnce(denied);
  await expect(host.recoverModelOwner(context, signal())).rejects.toBe(denied);
  expect(value.bound.egress.close).not.toHaveBeenCalled();

  const entered = gate(),
    join = gate(),
    recovery = new AbortController();
  value.model.reconcileOwner.mockImplementationOnce(async (_context, id) => {
    expect(id).toBe(ownerId);
    return 1;
  });
  vi.mocked(value.bound.egress.close).mockImplementationOnce(async () => {
    entered.release();
    await join.promise;
  });
  let recovered = false;
  const pending = host
    .recoverModelOwner(context, recovery.signal)
    .then((count) => {
      recovered = true;
      return count;
    });
  await entered.promise;
  recovery.abort();
  try {
    expect(recovered).toBe(false);
    expect(value.model.reconcileOwner).toHaveBeenLastCalledWith(
      context,
      ownerId,
      recovery.signal,
    );
    await expect(
      host.recoverModelOwner(context, signal()),
    ).rejects.toMatchObject({
      code: 'MODEL_RECOVERY_UNAVAILABLE',
    });
  } finally {
    join.release();
    await pending;
  }
  await expect(pending).resolves.toBe(1);
  await expect(host.close()).resolves.toBeUndefined();
  await expect(first).rejects.toMatchObject({ errors: [unknown] });
  expect(value.bound.egress.close).toHaveBeenCalledTimes(1);
  expectUninstalled();
});

it('model recovery does not clear unrelated Host close failures', async () => {
  const value = fixture();
  const transport = Error('unconfirmed model transport');
  const observation = Error('unconfirmed runtime observations');
  value.model.close.mockRejectedValueOnce(transport);
  vi.mocked(value.bound.runtime.close).mockRejectedValueOnce(observation);
  const host = await createProductionPersonVmHost({
    sources: value.sources,
    lifetime: signal(),
  });
  await expect(host.close()).rejects.toMatchObject({
    errors: [observation, transport],
  });
  value.model.reconcileOwner.mockResolvedValueOnce(1);
  await expect(
    host.recoverModelOwner(nativeEntryFixture().context, signal()),
  ).rejects.toMatchObject({ errors: [observation] });
  await expect(host.close()).rejects.toMatchObject({ errors: [observation] });
  expect(value.bound.egress.close).toHaveBeenCalledTimes(1);
  expectUninstalled();
});

it('rechecks authority when resuming provider cleanup after model recovery', async () => {
  const value = fixture();
  const transport = Error('unconfirmed model transport');
  const provider = Error('provider close failed');
  const denied = Error('later operator proof refused');
  const context = nativeEntryFixture().context;
  value.model.close.mockRejectedValueOnce(transport);
  vi.mocked(value.bound.egress.close).mockRejectedValueOnce(provider);
  const host = await createProductionPersonVmHost({
    sources: value.sources,
    lifetime: signal(),
  });
  const original = host.close();
  await expect(original).rejects.toMatchObject({ errors: [transport] });
  value.model.reconcileOwner.mockResolvedValueOnce(2);
  await expect(host.recoverModelOwner(context, signal())).rejects.toMatchObject(
    {
      errors: [provider],
    },
  );
  await expect(host.close()).rejects.toMatchObject({ errors: [provider] });
  value.model.reconcileOwner.mockRejectedValueOnce(denied);
  await expect(host.recoverModelOwner(context, signal())).rejects.toBe(denied);
  expect(value.bound.egress.close).toHaveBeenCalledTimes(1);

  value.model.reconcileOwner.mockResolvedValueOnce(0);
  await expect(host.recoverModelOwner(context, signal())).resolves.toBe(2);
  expect(value.bound.egress.close).toHaveBeenCalledTimes(2);
  await expect(host.close()).resolves.toBeUndefined();
  await expect(original).rejects.toMatchObject({ errors: [transport] });
});

it('runtime close drives cancellation of an outstanding native observation and the Host joins its real outcome', async () => {
  const admission = vi.spyOn(PersonVmService.prototype, 'createAdmissionHost');
  const value = await open(),
    reading = gate(),
    readReleased = gate(),
    closing = gate(),
    closeReleased = gate(),
    failedRead = Error('synthetic native observation failure');
  value.bound.nativeActivity = {
    observe: vi.fn(async () => {
      reading.release();
      await readReleased.promise;
      throw failedRead;
    }),
    subscribe: vi.fn(async () => {
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    }),
  };
  vi.mocked(value.bound.runtime.close).mockImplementation(async () => {
    closing.release();
    await closeReleased.promise;
    readReleased.release();
  });
  const observer = admission.mock.calls[0]?.[0].nativeActivity;
  if (!observer) throw Error('missing actual observer forwarding');
  const binding = nativeEntryFixture().binding;
  let readSettled = false,
    closeSettled = false;
  const read = observer.observe(binding, signal()).catch((error: unknown) => {
    readSettled = true;
    return error;
  });
  let closed: Promise<void> | undefined;
  try {
    await reading.promise;
    closed = value.host.close().then(() => {
      closeSettled = true;
    });
    await closing.promise;
    await turn();
    expect(readSettled).toBe(false);
    expect(closeSettled).toBe(false);
    closeReleased.release();
    const result = await read;
    expect(result).toBeInstanceOf(AggregateError);
    if (!(result instanceof AggregateError))
      throw Error('missing read outcome');
    expect(result.errors).toContain(failedRead);
    expect(result.errors).toContain(value.input().lifetime.reason);
    await closed;
    expect(readSettled).toBe(true);
  } finally {
    closeReleased.release();
    readReleased.release();
    await read;
    await closed;
  }
});

it('a native subscription published after cancellation is closed and really joined before either result settles', async () => {
  const admission = vi.spyOn(PersonVmService.prototype, 'createAdmissionHost');
  const value = await open(),
    entered = gate(),
    published = gate(),
    closing = gate(),
    released = gate();
  let closingTask: Promise<void> | undefined;
  const subscription = {
    wait: vi.fn(async () => {
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    }),
    close: vi.fn(() => {
      closingTask ??= (async () => {
        closing.release();
        await released.promise;
      })();
      return closingTask;
    }),
  };
  value.bound.nativeActivity = {
    observe: vi.fn(async () => {
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    }),
    subscribe: vi.fn(async () => {
      entered.release();
      await published.promise;
      return subscription;
    }),
  };
  const observer = admission.mock.calls[0]?.[0].nativeActivity;
  if (!observer) throw Error('missing actual subscription forwarding');
  let subscribed = false,
    closed = false;
  const reading = observer
    .subscribe(nativeEntryFixture().binding, signal())
    .then(
      () => {
        throw Error('cancelled subscription must not escape');
      },
      (error: unknown) => {
        subscribed = true;
        return error;
      },
    );
  let outcome: Promise<void> | undefined;
  try {
    await entered.promise;
    outcome = value.host.close().then(() => {
      closed = true;
    });
    published.release();
    await closing.promise;
    await turn();
    expect(subscribed).toBe(false);
    expect(closed).toBe(false);
    released.release();
    expect(await reading).toBe(value.input().lifetime.reason);
    await outcome;
    expect(subscription.close).toHaveBeenCalledTimes(1);
    expect(subscription.wait).not.toHaveBeenCalled();
  } finally {
    published.release();
    released.release();
    await reading;
    await outcome;
  }
});

it('rollback preserves both the construction error and an unknown source cleanup result', async () => {
  const value = fixture(),
    entered = gate(),
    returned = gate(),
    lifetime = new AbortController(),
    reason = Error('synthetic primary cancellation'),
    failedClose = Error('synthetic unconfirmed source close');
  vi.mocked(value.sources.bind).mockImplementation(async () => {
    entered.release();
    await returned.promise;
    return value.bound;
  });
  vi.mocked(value.bound.egress.close).mockRejectedValue(failedClose);
  const outcome = createProductionPersonVmHost({
    sources: value.sources,
    lifetime: lifetime.signal,
  }).catch((error: unknown) => error);
  try {
    await entered.promise;
    lifetime.abort(reason);
    returned.release();
    const result = await outcome;
    expect(result).toBeInstanceOf(AggregateError);
    if (!(result instanceof AggregateError)) throw Error('missing aggregate');
    expect(result.errors[0]).toBe(reason);
    expect(result.errors[1]).toBeInstanceOf(AggregateError);
    expect(result.errors[1].errors).toContain(failedClose);
    expect(io.gateway).not.toHaveBeenCalled();
  } finally {
    returned.release();
    await outcome;
  }
});

it('a real duplicate port registration failure rolls back without replacing the existing owner', async () => {
  const value = fixture(),
    existing = {
      prewarm: vi.fn(async () => {
        throw new ProductionPersonVmHostUnavailable('HOST_SOURCES_UNAVAILABLE');
      }),
    },
    uninstall = installDEntryNativePrewarmPort(existing);
  try {
    await expect(
      createProductionPersonVmHost({
        sources: value.sources,
        lifetime: signal(),
      }),
    ).rejects.toThrow();
    expect(value.bound.egress.close).toHaveBeenCalledTimes(1);
    expect(() => installDEntryNativePrewarmPort(existing)).toThrow();
    expect(existing.prewarm).not.toHaveBeenCalled();
  } finally {
    uninstall();
  }
});
