import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createRuntimeFixtureDatabase } from '../../database/src/runtime.fixture.ts';
import { createPostgresPersonVmScheduledWakeStore } from '../../database/src/capabilities/person-vm-scheduled-wake.ts';
import { PersonVmError, type PersonVmBinding } from './contract.ts';
import { PersonVmService } from './person-vm.ts';
import { PostgresPersonVmStore, type PersonVmSqlFactory } from './store.ts';
import { PERSON_VM_IDLE_MS } from './contract.ts';
import type { PersonVmAdmissionBindingPort } from './index.ts';
import type { PersonVmAdmissionPermit } from './admission-boundary.ts';
import {
  advanceIdleCandidate,
  type PersonVmAdmissionHost,
} from './admission-host.ts';
import type { AdmissionState } from './admission-store.ts';
import type {
  PersonVmAdmissionLease,
  PersonVmIdleCoverage,
} from './admission-contract.ts';
import { context, harness, running } from './test-support.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'shared PG admission through actual PersonVmService composition; synthetic native, no VM/model',
  () => {
    let schema: string;
    const prefix = 'vma-' + randomUUID(); // Keep exact PG application_name under 63 bytes, including role/counter.
    const clients = new Set<postgres.Sql>();
    const handles: [PersonVmAdmissionHost, PersonVmAdmissionPermit][] = [];
    const releases = new Set<() => void>();
    const work = new Set<Promise<unknown>>();
    let caller = new AbortController();
    const signal = () => caller.signal;
    function own<T>(promise: Promise<T>) {
      work.add(promise);
      void promise.finally(() => work.delete(promise)).catch(() => {});
      return promise;
    }
    let admin: postgres.Sql, db: postgres.Sql;
    let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    function latch() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      releases.add(resolve);
      return { promise, resolve };
    }
    function factory(
      role: string,
      afterCommit?: (name: string) => Promise<void>,
      afterClose?: (name: string) => void,
      unlistenFailure?: Error,
    ) {
      const names: string[] = [];
      const events: string[] = [];
      const open: PersonVmSqlFactory = () => {
        const name = prefix + '-' + role + '-' + names.length;
        names.push(name);
        const sql = postgres(process.env.ALLRICE_TEST_DATABASE_URL!, {
          max: 1,
          onnotice: () => {},
          onclose: () => {
            events.push(name + ':close');
            afterClose?.(name);
          },
          debug: (_id, query) => {
            events.push(
              name + ':' + query.trim().split(/\s/)[0]!.toLowerCase(),
            );
          },
          connection: { search_path: schema, application_name: name },
        });
        const end = sql.end.bind(sql);
        sql.end = (options) => {
          events.push(name + ':end');
          return end(options);
        };
        if (afterCommit) {
          const unsafe = sql.unsafe.bind(sql);
          sql.unsafe = ((text, ...args) => {
            const query = unsafe(text, ...args);
            return text === 'commit'
              ? query.then(async (rows) => {
                  await afterCommit(name);
                  return rows;
                })
              : query;
          }) as typeof sql.unsafe;
        }
        if (unlistenFailure) {
          const listen = sql.listen.bind(sql);
          sql.listen = ((...args: Parameters<typeof sql.listen>) =>
            listen(...args).then((metadata) => ({
              ...metadata,
              unlisten: async () => {
                await metadata.unlisten();
                throw unlistenFailure;
              },
            }))) as typeof sql.listen;
        }
        clients.add(sql);
        return sql;
      };
      return { open, names, events };
    }
    beforeAll(async () => {
      // Wake revocation is installed on the real tenant tables by 0258.
      database = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
      db = database.db;
      const [current] = await db<
        { schema: string }[]
      >`select current_schema() as schema`;
      schema = current!.schema;
      admin = postgres(process.env.ALLRICE_TEST_DATABASE_URL!, {
        max: 2,
        onnotice: () => {},
      });
    });
    beforeEach(() => {
      caller = new AbortController();
    });
    afterEach(async () => {
      caller.abort(new Error('test owner finally cancel/join'));
      for (const release of releases) release();
      releases.clear();
      await Promise.allSettled(
        handles.splice(0).map(([host, permit]) => host.finish(permit)),
      );
      await Promise.allSettled([...work]);
      await Promise.all([...clients].map((sql) => sql.end({ timeout: 0 })));
      clients.clear();
      await db.unsafe(
        'drop trigger if exists fixture_block_delete on person_vm_admission_permits',
      );
      await db.unsafe('drop function if exists fixture_block_delete()');
      await db.unsafe(
        'truncate person_vm_admission_permits,person_vm_audit,person_virtual_machines,person_vm_scheduled_wakes',
      );
    });
    afterAll(async () => {
      try {
        await database?.close();
      } finally {
        await admin?.end({ timeout: 2 });
      }
    });
    async function setup(sharedFactory?: PersonVmSqlFactory, idleMs?: number) {
      const physical = factory('physicalA'),
        remote = factory('physicalB');
      const open = sharedFactory ?? physical.open;
      const store = new PostgresPersonVmStore(open);
      const h = harness(store),
        { rc, binding } = await running(h);
      let mono = 0;
      const host = h.service.createAdmissionHost({
        openSql: open,
        idleMs,
        monotonic: () => mono,
      });
      const peerStore = new PostgresPersonVmStore(remote.open);
      const peerService = new PersonVmService({
        ...h.options,
        store: peerStore,
      });
      const peer = peerService.createAdmissionHost({
        openSql: remote.open,
        idleMs,
        monotonic: () => mono,
      });
      return {
        ...h,
        host,
        peer,
        peerStore,
        peerService,
        rc,
        binding,
        physical,
        advanceMono: (ms: number, advanceUtc = true) => {
          mono += ms;
          if (advanceUtc) h.advance(ms);
        },
      };
    }
    it('restarts an orphan only for the current foreground open and keeps the original disk', async () => {
      const h = await setup();
      const store = new PostgresPersonVmStore(h.physical.open);
      const seen: string[] = [];
      let currentEpoch = 0;
      let previousStillListening = true;
      let reconciled = false;
      let joinParallel = false;
      const entered = latch();
      const release = latch();
      const checkedLaterLogin = latch();
      const later = context(h.binding.organizationId, h.binding.personId);
      const vm = new PersonVmService({
        ...h.options,
        store,
        disk: {
          ...h.options.disk,
          async verifyAttachedMount({ vmId }) {
            return h.mounts.has(vmId) ? '/synthetic/' + vmId : null;
          },
        },
        native: {
          ...h.native,
          async readAttachedStatus(binding, mount, signal) {
            expect(mount).toBe('/synthetic/' + binding.vmId);
            return h.native.status(binding, signal);
          },
        },
        authority: {
          async authorize(request, action, signal) {
            const identity = await h.options.authority.authorize(
              request,
              action,
              signal,
            );
            if (request.sessionId === later.sessionId)
              checkedLaterLogin.resolve();
            return identity;
          },
        },
        ownsEgressReceipt: ({ binding }) => binding.leaseEpoch === currentEpoch,
        observeOwnedStart(binding) {
          currentEpoch = binding.leaseEpoch;
          seen.push('start');
        },
        async withPreviousGatewayFenced(binding, ports, _signal, stop) {
          expect(binding).toEqual(h.binding);
          expect(ports).toEqual([38990]);
          const row = await h.peerStore.read(binding.personId);
          expect(row?.leaseOwner).toBeTruthy();
          expect(row?.phase).toBe('running');
          if (previousStillListening) throw new PersonVmError('LEASE_CONFLICT');
          seen.push('fence');
          if (joinParallel) {
            entered.resolve();
            await release.promise;
          }
          const result = await stop();
          reconciled = true;
          expect(h.states.get(binding.vmId)).toBe('stopped');
          expect(h.mounts.has(binding.vmId)).toBe(false);
          const stopped = await h.peerStore.read(binding.personId);
          expect(stopped).toMatchObject({
            phase: 'stopped',
            diskRetained: true,
            leaseEpoch: 1,
          });
          seen.push('release');
          return result;
        },
      });
      vm.createAdmissionHost({ openSql: h.physical.open });
      const requestId = randomUUID();
      const events = h.log.length;
      const observed: [string, PersonVmBinding][] = [];
      const warm = (
        rc: typeof h.rc,
        trigger: 'page' | 'input' | 'open' = 'open',
      ) =>
        vm.prewarm(
          rc,
          {
            trigger,
            target: {
              vmId: h.binding.vmId,
              instanceId: null,
              leaseEpoch: 2,
              observeVmStart(binding) {
                observed.push([rc.sessionId, binding]);
              },
              assertAuthority: async () => {},
              dispatchUpgradeStop: (_binding, active, stop) => {
                active.throwIfAborted();
                return stop();
              },
            },
          },
          signal(),
        );
      for (const trigger of ['page', 'input'] as const)
        await expect(warm(h.rc, trigger)).rejects.toMatchObject({
          code: 'UPGRADE_OPEN_REQUIRED',
        });
      await expect(warm(h.rc)).rejects.toMatchObject({
        code: 'LEASE_CONFLICT',
      });
      expect(h.log.slice(events)).not.toContain('native:stop');
      expect(await store.read(h.binding.personId)).toMatchObject({
        phase: 'running',
        leaseEpoch: h.binding.leaseEpoch,
        leaseOwner: null,
      });
      previousStillListening = false;
      h.states.set(h.binding.vmId, 'unknown');
      await expect(warm(h.rc)).rejects.toMatchObject({
        code: 'ACTIVITY_UNKNOWN',
      });
      expect(h.log.slice(events)).not.toContain('native:stop');
      expect(h.log.slice(events)).not.toContain('native:prepare');
      expect(h.log.slice(events)).not.toContain('disk:attach');
      expect(reconciled).toBe(false);
      expect(await store.read(h.binding.personId)).toMatchObject({
        phase: 'running',
        leaseOwner: null,
      });
      h.states.set(h.binding.vmId, 'running');
      joinParallel = true;
      const first = own(warm({ ...h.rc, requestId }));
      let second: typeof first;
      try {
        await Promise.race([entered.promise, first]);
        second = own(warm(later));
        await Promise.race([checkedLaterLogin.promise, second]);
      } finally {
        release.resolve();
      }
      const expected = {
        phase: 'running',
        ready: true,
        vmId: h.binding.vmId,
      };
      await expect(first).resolves.toMatchObject(expected);
      await expect(second).resolves.toMatchObject(expected);
      const binding = await vm.resolve(h.rc, signal());
      expect(binding.leaseEpoch).toBe(2);
      expect(observed).toEqual([
        [h.rc.sessionId, binding],
        [later.sessionId, binding],
      ]);
      expect(seen).toEqual(['fence', 'fence', 'release', 'start']);
      expect(h.log.slice(events)).toContain('native:stop');
      expect(h.log.slice(events)).toContain('native:start');
      expect(h.log.slice(events)).not.toContain('native:create');
      const audit = await db`select phase, lease_epoch, disk_retained
        from person_virtual_machines where person_id=${h.binding.personId}`;
      expect(audit).toEqual([
        { phase: 'running', lease_epoch: '2', disk_retained: true },
      ]);
      const stops =
        await db`select result from person_vm_audit where request_id=${requestId}
        and action='stop.upgrade' order by id`;
      expect(stops).toEqual([{ result: 'started' }, { result: 'succeeded' }]);
    });

    it.each(['foreground', 'release'] as const)(
      'recovers a previous-worker stop after its terminal readback fails: %s',
      async (entry) => {
        const h = await setup();
        const store = new PostgresPersonVmStore(h.physical.open);
        let ownEpoch = 0;
        let fenced = false;
        let rejectRead = false;
        const joins: boolean[] = [];
        const vm = new PersonVmService({
          ...h.options,
          store,
          disk: {
            ...h.options.disk,
            async verifyAttachedMount({ vmId }) {
              return h.mounts.has(vmId) ? '/synthetic/' + vmId : null;
            },
          },
          native: {
            ...h.native,
            async readAttachedStatus(binding, _mount, active) {
              expect(fenced).toBe(true);
              expect(binding).toEqual(h.binding);
              return h.native.status(binding, active);
            },
            async stopIdle(...args) {
              expect(fenced).toBe(true);
              if (rejectRead) throw new PersonVmError('PROVIDER_FAILED');
              await h.native.stopIdle!(...args);
              throw new Error('synthetic failure after joined native stop');
            },
            async stop(binding, active, options) {
              joins.push(options?.requireStopped === true);
              expect(fenced).toBe(true);
              await h.native.stop(binding, active);
            },
          },
          ownsEgressReceipt: ({ binding }) => binding.leaseEpoch === ownEpoch,
          observeOwnedStart(binding) {
            ownEpoch = binding.leaseEpoch;
          },
          async withPreviousGatewayFenced(binding, ports, _signal, action) {
            expect(binding).toEqual(h.binding);
            expect(ports).toEqual([38990]);
            expect(
              (await store.read(binding.personId))?.leaseOwner,
            ).toBeTruthy();
            fenced = true;
            try {
              return await action();
            } finally {
              fenced = false;
            }
          },
        });
        vm.createAdmissionHost({ openSql: h.physical.open });
        const authorize = async (active: AbortSignal) =>
          active.throwIfAborted();
        const open = (trigger: 'page' | 'open') =>
          vm.prewarm(
            h.rc,
            {
              trigger,
              target: {
                vmId: h.binding.vmId,
                instanceId: null,
                leaseEpoch: 2,
                assertAuthority: authorize,
                dispatchUpgradeStop: (_binding, active, stop) => {
                  active.throwIfAborted();
                  return stop();
                },
              },
            },
            signal(),
          );
        await expect(open('open')).rejects.toMatchObject({
          code: 'CLEANUP_INCOMPLETE',
        });
        expect(h.states.get(h.binding.vmId)).toBe('stopped');
        expect(await store.read(h.binding.personId)).toMatchObject({
          phase: 'failed',
          leaseEpoch: 1,
          egressReceipt: expect.anything(),
        });
        await expect(open('page')).rejects.toMatchObject({
          code: 'UPGRADE_OPEN_REQUIRED',
        });
        h.states.set(h.binding.vmId, 'running');
        rejectRead = true;
        await expect(open('open')).rejects.toMatchObject({
          code: 'PROVIDER_FAILED',
        });
        rejectRead = false;
        h.states.set(h.binding.vmId, 'stopped');
        if (entry === 'foreground') {
          await expect(open('open')).resolves.toMatchObject({
            phase: 'running',
            vmId: h.binding.vmId,
          });
        } else {
          const reopen = vm.fenceWorkerStartup();
          try {
            const noWakePreparation = async () => {
              throw Error(
                'old Worker stop must be proven without adopting its runtime',
              );
            };
            h.states.set(h.binding.vmId, 'running');
            await expect(
              vm.stopRunningForUpgrade(
                h.binding,
                randomUUID(),
                signal(),
                authorize,
                noWakePreparation,
              ),
            ).rejects.toMatchObject({ code: 'ACTIVITY_UNKNOWN' });
            expect(joins).toEqual([]);
            h.states.set(h.binding.vmId, 'stopped');
            await vm.stopRunningForUpgrade(
              h.binding,
              randomUUID(),
              signal(),
              authorize,
              noWakePreparation,
            );
          } finally {
            reopen();
          }
        }
        expect(joins).toEqual([true]);
        expect(await store.read(h.binding.personId)).toMatchObject({
          diskRetained: true,
          phase: entry === 'foreground' ? 'running' : 'stopped',
          leaseEpoch: entry === 'foreground' ? 2 : 1,
        });
      },
    );

    it('retries upgrade drain from the joined stop receipt and preserves the exact wake plan', async () => {
      const h = await setup();
      const store = new PostgresPersonVmStore(h.physical.open);
      const cursor = { sourceId: 'upgrade-activity', revision: 'quiescent' };
      let rejectDetach = true;
      let nativeSchedule = 'later-native-read';
      const disconnected = new AbortController();
      const stopNative = h.native.stop;
      h.native.stop = async (binding, active) => {
        disconnected.abort(new Error('operator disconnected after dispatch'));
        active.throwIfAborted();
        return stopNative(binding, active);
      };
      const vm = new PersonVmService({
        ...h.options,
        store,
        disk: {
          ...h.options.disk,
          async detach(...args) {
            if (rejectDetach) throw new Error('fixture detach failed');
            return h.options.disk.detach(...args);
          },
        },
        upgradeActivity: {
          async observe(binding) {
            const observedAt = h.now().toISOString();
            return {
              activity: {
                binding,
                observedAt,
                state: 'known',
                activeTurns: 0,
                activeJobs: 0,
                activeSubtasks: 0,
                pendingApprovals: 0,
              },
              activeScheduleDeliveries: 0,
              scheduleFingerprints: [nativeSchedule],
              coverage: {
                state: 'sampled',
                cursor,
                from: observedAt,
                through: observedAt,
                idleSince: observedAt,
              },
            };
          },
          assertSampleCurrent(binding, sampled) {
            expect(binding).toEqual(h.binding);
            expect(sampled).toEqual(cursor);
          },
        },
      });
      vm.createAdmissionHost({ openSql: h.physical.open });
      const restore = vm.fenceWorkerStartup();
      const planId = randomUUID();
      const targetAt = new Date(h.now().getTime() + 3_600_000);
      const receipt = randomUUID();
      const prepare: Parameters<typeof vm.stopRunningForUpgrade>[4] = async (
        request,
        signal,
      ) => {
        expect(request.binding).toEqual(h.binding);
        expect(request.requestId).toBe(planId);
        await request.assertStopCurrent(signal);
        const { binding } = request;
        await db`insert into person_vm_scheduled_wakes
            (person_id,organization_id,vm_id,instance_id,lease_epoch,plan_id,receipt_ids,
            wake_at,target_at,state)
            values (${binding.personId},${binding.organizationId},${binding.vmId},
            ${binding.instanceId},${binding.leaseEpoch},${planId},
            array[${receipt}]::uuid[],${targetAt},${targetAt},'waiting')
            on conflict (plan_id) do nothing`;
        return {
          nextWakeAt: targetAt.toISOString(),
          scheduleFingerprints: ['test-schedule'],
          dispatch: (active, stop) => stop(active),
        };
      };
      const authorize = async (active: AbortSignal) => active.throwIfAborted();
      try {
        await expect(
          vm.stopRunningForUpgrade(
            h.binding,
            planId,
            signal(),
            authorize,
            prepare,
          ),
        ).rejects.toMatchObject({ code: 'ACTIVITY_UNKNOWN' });
        expect(h.log).not.toContain('native:stop');
        expect((await store.read(h.binding.personId))?.phase).toBe('running');
        nativeSchedule = 'test-schedule';
        await expect(
          vm.stopRunningForUpgrade(
            h.binding,
            planId,
            disconnected.signal,
            authorize,
            prepare,
          ),
        ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
        expect(h.states.get(h.binding.vmId)).toBe('stopped');
        expect(await store.idleStopReceipt(h.binding)).toEqual({
          requestId: planId,
          completed: false,
        });
        rejectDetach = false;
        await vm.stopRunningForUpgrade(
          h.binding,
          randomUUID(),
          signal(),
          authorize,
          prepare,
        );
        expect(h.log.filter((entry) => entry === 'native:stop')).toHaveLength(
          1,
        );
        expect(h.mounts.has(h.binding.vmId)).toBe(false);
        expect(await store.idleStopReceipt(h.binding)).toEqual({
          requestId: planId,
          completed: true,
        });
        expect(await store.read(h.binding.personId)).toMatchObject({
          phase: 'stopped',
          diskRetained: true,
          leaseOwner: null,
        });
      } finally {
        restore();
      }
    });

    it('takes a durable journal read lease only across idle admission and then releases it', async () => {
      const h = await setup();
      const store = new PostgresPersonVmStore(h.physical.open);
      const entered = latch(),
        finish = latch();
      const result = own(
        store.withRetainedReadLease(
          h.binding,
          signal(),
          async (scope, disk) => {
            expect(disk).toEqual({ vmId: h.binding.vmId, tier: 'warm' });
            expect(
              (await h.peerStore.read(h.binding.personId))?.leaseOwner,
            ).toBe(scope.leaseOwner);
            entered.resolve();
            await finish.promise;
            return 'physical-journal';
          },
        ),
      );
      await Promise.race([entered.promise, result]);
      const options = { now: h.now, ttlMs: 90_000 };
      await expect(
        h.peerStore.withLease(
          h.binding.personId,
          options,
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      finish.resolve();
      await expect(result).resolves.toBe('physical-journal');
      expect(
        (await h.peerStore.read(h.binding.personId))?.leaseOwner,
      ).toBeNull();
      const stale = { ...h.binding, leaseEpoch: h.binding.leaseEpoch + 1 };
      await expect(
        store.withRetainedReadLease(stale, signal(), async () => undefined),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    });
    it('keeps the physical fence after PG loss until the owned journal read has joined', async () => {
      const h = await setup();
      const store = new PostgresPersonVmStore(h.physical.open);
      const entered = latch(),
        observedLoss = latch(),
        finish = latch();
      let physicalError: unknown;
      const result = own(
        store.withRetainedReadLease(h.binding, signal(), async (scope) => {
          scope.signal.addEventListener(
            'abort',
            () => {
              physicalError = scope.signal.reason;
              observedLoss.resolve();
            },
            {
              once: true,
            },
          );
          entered.resolve();
          await finish.promise;
          scope.signal.throwIfAborted();
        }),
      );
      const rejected = result.catch((error: unknown) => error);
      await Promise.race([entered.promise, result]);
      const connection = h.physical.names.at(-1);
      const [backend] =
        await admin`select pid from pg_stat_activity where application_name=${connection!}`;
      expect(backend).toBeDefined();
      await admin`select pg_terminate_backend(${backend!.pid})`;
      await Promise.race([observedLoss.promise, result]);
      expect(
        (await h.peerStore.read(h.binding.personId))?.leaseOwner,
      ).toBeTruthy();
      await expect(
        h.peerStore.withLease(
          h.binding.personId,
          { now: h.now, ttlMs: 90_000 },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      finish.resolve();
      expect(await rejected).toBe(physicalError);
      expect(physicalError).toMatchObject({
        message: 'VM_STORE_CONNECTION_LOST',
      });
    });
    it('settles an old mount under the real PG lease without touching a peer-started VM', async () => {
      const h = await setup();
      const old = h.binding;
      const leaseOptions = { now: () => new Date(), ttlMs: 5000 };
      const settled: (typeof old)[] = [];
      const owner = new PersonVmService({
        ...h.options,
        async settleSupersededBinding(binding) {
          settled.push(binding);
          await expect(
            h.peerStore.withLease(old.personId, leaseOptions, async () => {}),
          ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        },
      });
      h.states.set(old.vmId, 'stopped');
      await h.peerService.stop(h.rc, signal());
      await h.peerService.start(h.rc, signal());
      const current = await h.peerStore.read(old.personId);
      expect(current).toMatchObject({
        phase: 'running',
        leaseEpoch: old.leaseEpoch + 1,
        egressReceipt: { binding: { leaseEpoch: old.leaseEpoch + 1 } },
      });
      const before = [...h.log];
      await owner.shutdownOwned(old, false);
      expect(settled).toEqual([old]);
      expect(await h.peerStore.read(old.personId)).toEqual(current);
      expect(h.log).toEqual(before);
    });

    async function permit(
      h: Awaited<ReturnType<typeof setup>>,
      participant: 'gateway' | 'entry',
      operationId = randomUUID(),
    ) {
      const value = await h.host.admit(
        h.rc,
        h.binding,
        { participant, operationId },
        signal(),
      );
      handles.push([h.host, value]);
      return value;
    }
    async function frozen(h: Awaited<ReturnType<typeof setup>>) {
      const lease = await h.host.issue(h.rc, h.binding, signal());
      await h.host.participant('gateway').freeze(lease, signal());
      await h.peer.participant('entry').freeze(lease, signal());
      return lease;
    }
    async function counts(personId: string) {
      return db`select disposition,count(*)::int as count from person_vm_admission_permits where person_id=${personId} group by disposition order by disposition`;
    }
    async function idleInputs(
      h: Awaited<ReturnType<typeof setup>>,
      mono: number,
    ) {
      const g = await h.host
        .participant('gateway')
        .observe(h.binding, signal());
      const e = await h.host.participant('entry').observe(h.binding, signal());
      const [record] =
        await db`select admission_state from person_virtual_machines where person_id=${h.rc.actor.id}`;
      const state = record!.admission_state as AdmissionState;
      const origin = '2026-11-21T10:00:00.000Z';
      // Only native coverage is synthetic. Accepted stamps/counts above are actual PG facts.
      const coverage: PersonVmIdleCoverage[] = [
        g.coverage,
        e.coverage,
        {
          state: 'continuous',
          cursor: { sourceId: 'synthetic-native', revision: '0' },
          from: origin,
          through: new Date(Date.parse(origin) + mono).toISOString(),
          idleSince: origin,
        },
      ];
      return [
        h.binding,
        coverage,
        [state.gateway.idleRevision, state.entry.idleRevision, '0'],
        await h.store.read(h.rc.actor.id),
        mono,
      ] as const;
    }
    async function settledOrphan(h: Awaited<ReturnType<typeof setup>>) {
      const entered = latch(),
        release = latch(),
        lost = latch();
      const owned = own(
        h.store.withLease(
          h.rc.actor.id,
          { now: h.now, ttlMs: 90000 },
          async (lease) => {
            lease.signal.addEventListener('abort', lost.resolve, {
              once: true,
            });
            entered.resolve();
            await release.promise;
            await lease.guard();
          },
        ),
      );
      const outcome = owned.catch((error: unknown) => error);
      try {
        await entered.promise;
        const owners =
          await admin`select a.pid from pg_stat_activity a join pg_locks l on a.pid=l.pid
          where a.application_name like ${prefix + '-physicalA-%'} and l.locktype='advisory' and l.granted`;
        expect(owners).toHaveLength(1);
        await admin`select pg_terminate_backend(${owners[0]!.pid})`;
        await lost.promise;
        release.resolve();
        expect(await outcome).toBeInstanceOf(Error);
        h.advanceMono(90001); // Expiry fixture; actual callback has also joined.
      } finally {
        release.resolve();
        await outcome;
      }
    }

    it('public qualifier passes a committed freeze while its real physical owner is still settling; old resolve refuses', async () => {
      const committed = latch(),
        release = latch();
      let block = false;
      const sql = factory('qualify', async () => {
        if (!block) return;
        const current = lease;
        const [row] =
          await db`select admission_state from person_virtual_machines
          where person_id=${current.binding.personId} and admission_version=${current.version}`;
        const round = (row?.admission_state as AdmissionState | undefined)
          ?.round;
        if (
          !round ||
          round.lease.freezeId !== current.freezeId ||
          round.lease.version !== current.version ||
          !round.frozen.includes('gateway') ||
          round.released.includes('gateway')
        )
          return;
        block = false;
        committed.resolve();
        await release.promise;
      });
      const h = await setup(sql.open);
      const lease: PersonVmAdmissionLease = await h.host.issue(
        h.rc,
        h.binding,
        signal(),
      );
      block = true;
      const freezing = own(
        h.host.participant('gateway').freeze(lease, signal()),
      );
      await Promise.race([
        committed.promise,
        freezing.then(() => {
          throw new Error(
            'freeze completed without its exact committed-ACK barrier',
          );
        }),
      ]);
      // Independent public PG read, before freeze audit/physical release.
      expect(
        await h.peer.participant('gateway').observe(h.binding, signal()),
      ).toMatchObject({ state: 'known', frozen: lease });
      expect((await h.store.read(h.rc.actor.id))!.leaseOwner).not.toBe(null);
      const port: PersonVmAdmissionBindingPort = h.service;
      await port.assertAdmissionBinding(h.rc, h.binding, signal());
      await expect(h.service.resolve(h.rc, signal())).rejects.toMatchObject({
        code: 'LEASE_CONFLICT',
      });
      const item = await permit(h, 'gateway');
      expect(item.disposition).toBe('deferred');
      await expect(
        h.host.activate(
          item,
          async () => {
            throw new Error('forbidden dispatch');
          },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'deferred', count: 1 },
      ]);
      release.resolve();
      await freezing;
    });
    it.each([
      ['membership', 'AUTHORIZATION_DENIED'],
      ['identity', 'AUTHORIZATION_DENIED'],
      ['actor', 'AUTHORIZATION_DENIED'],
      ['person', 'AUTHORIZATION_DENIED'],
      ['tenant', 'AUTHORIZATION_DENIED'],
      ['context-tenant', 'AUTHORIZATION_DENIED'],
      ['vm', 'LEASE_LOST'],
      ['instance', 'LEASE_LOST'],
      ['epoch', 'LEASE_LOST'],
      ['revoked', 'AUTHORIZATION_DENIED'],
      ['deleted', 'NOT_FOUND'],
      ['disk', 'NOT_FOUND'],
      ['missing-receipt', 'EGRESS_UNAVAILABLE'],
      ['receipt-binding', 'EGRESS_BINDING_INVALID'],
      ['receipt-ports', 'EGRESS_BINDING_INVALID'],
      ['inactive-receipt', 'EGRESS_UNAVAILABLE'],
    ] as const)(
      'public qualification rejects %s without admitting work',
      async (kind, code) => {
        const h = await setup();
        let binding = h.binding,
          rc = h.rc;
        const record = (await h.store.read(h.rc.actor.id))!;
        switch (kind) {
          case 'membership':
            h.authorize(false);
            break;
          case 'identity':
            h.options.authority.authorize = async () => ({
              personId: randomUUID(),
              organizationId: h.rc.organizationId,
            });
            break;
          case 'actor':
            rc = { ...rc, actor: { type: 'service', id: rc.actor.id } };
            break;
          case 'person':
            binding = { ...binding, personId: randomUUID() };
            break;
          case 'tenant':
            binding = { ...binding, organizationId: randomUUID() };
            break;
          case 'context-tenant':
            rc = { ...rc, organizationId: randomUUID() };
            break;
          case 'vm':
            binding = { ...binding, vmId: randomUUID() };
            break;
          case 'instance':
            binding = { ...binding, instanceId: randomUUID() };
            break;
          case 'epoch':
            binding = { ...binding, leaseEpoch: binding.leaseEpoch + 1 };
            break;
          case 'revoked':
            await db`update person_virtual_machines set admission_state=jsonb_set(admission_state,'{revoked}','"fixture-current-disable"'::jsonb),admission_revision=admission_revision+1 where person_id=${rc.actor.id}`;
            break;
          case 'deleted':
            await db`update person_virtual_machines set phase='deleted' where person_id=${rc.actor.id}`;
            break;
          case 'disk':
            await db`update person_virtual_machines set disk_retained=false where person_id=${rc.actor.id}`;
            break;
          case 'missing-receipt':
            await db`update person_virtual_machines set phase='starting',egress_receipt=null where person_id=${rc.actor.id}`;
            break;
          case 'receipt-binding':
          case 'receipt-ports': {
            const receipt = {
              ...record.egressReceipt!,
              ...(kind === 'receipt-binding'
                ? { binding: { ...binding, instanceId: randomUUID() } }
                : { gatewayPorts: [0] }),
            };
            await db`update person_virtual_machines set egress_receipt=${db.json(receipt as unknown as postgres.JSONValue)} where person_id=${rc.actor.id}`;
            break;
          }
          case 'inactive-receipt':
            h.active.clear();
            break;
        }
        await expect(
          h.service.assertAdmissionBinding(rc, binding, signal()),
        ).rejects.toMatchObject({ code });
        expect(await counts(h.rc.actor.id)).toEqual([]);
      },
    );
    it.each([
      null,
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '1200000',
    ])(
      'rejects invalid continuous idle milliseconds %s without publishing an admission host',
      (idleMs) => {
        const physical = factory('invalid-idle');
        const h = harness(new PostgresPersonVmStore(physical.open));
        expect(() =>
          Reflect.apply(h.service.createAdmissionHost, h.service, [
            { openSql: physical.open, idleMs },
          ]),
        ).toThrowError('PROVIDER_FAILED');
        expect(() =>
          h.service.createAdmissionHost({ openSql: physical.open }),
        ).not.toThrow();
      },
    );
    it('accepts an explicit platform idle threshold without bypassing the unknown native barrier', async () => {
      const h = await setup(undefined, 45_000);
      await h.host.reconcileIdle(h.rc, h.binding, signal());
      h.advanceMono(45_000);
      await h.host.reconcileIdle(h.rc, h.binding, signal());
      const lease = await frozen(h);
      try {
        await expect(
          h.host.stopFrozen(h.rc, lease, signal()),
        ).rejects.toMatchObject({ code: 'ACTIVITY_UNKNOWN' });
        expect(h.states.get(h.binding.vmId)).toBe('running');
        expect(h.log).not.toContain('native:stop');
      } finally {
        await h.host.participant('gateway').thaw(lease, signal());
        await h.peer.participant('entry').thaw(lease, signal());
      }
    });
    it.each([
      'off',
      'blocked',
      'active',
      'changed',
      'mount-change',
      'wake-plan-changed',
      'wake-plan-revoked-at-dispatch',
      'ok',
      'sampled-ok',
      'commit-rejected',
      'commit-ack-lost',
      'native-proof-rejected',
      'native-readback-failed',
      'relogin',
      'system-ok',
      'system-revoked',
      'system-late-revoked',
      'system-wake-window',
      'system-recovery',
      'system-unknown',
    ] as const)(
      'idle wake preparation and stop under one physical lease: %s',
      async (outcome) => {
        const physical = factory('idle-wake');
        let loseAcknowledgement = false;
        const open: PersonVmSqlFactory = () => {
          const sql = physical.open();
          const name = physical.names.at(-1)!;
          return new Proxy(sql, {
            apply(
              target,
              receiver,
              args: [TemplateStringsArray, ...unknown[]],
            ) {
              const query = Reflect.apply(
                target,
                receiver,
                args,
              ) as postgres.PendingQuery<postgres.Row[]>;
              if (
                !loseAcknowledgement ||
                !args[0][0]?.startsWith('with saved as (')
              )
                return query;
              return query.then(async () => {
                loseAcknowledgement = false;
                const [owner] =
                  await admin`select pid from pg_stat_activity where application_name=${name}`;
                expect(owner).toBeDefined();
                const [closed] =
                  await admin`select pg_terminate_backend(${owner!.pid}) as closed`;
                expect(closed?.closed).toBe(true);
                throw Object.assign(
                  new Error('Lost committed stop acknowledgement'),
                  {
                    code: 'CONNECTION_CLOSED',
                  },
                );
              });
            },
          });
        };
        const store = new PostgresPersonVmStore(open);
        const h = harness(store);
        let invalidSession: string | undefined;
        let authorized: ReturnType<typeof context> | undefined;
        const service = new PersonVmService({
          ...h.options,
          authority: {
            async authorize(request, action, signal) {
              if (request.sessionId === invalidSession)
                throw new PersonVmError('AUTHORIZATION_DENIED');
              return h.options.authority.authorize(request, action, signal);
            },
          },
          observeOwnedStart(_binding, request) {
            authorized = request;
          },
          observeOwnedAccess(_binding, request) {
            authorized = request;
          },
        });
        const { rc, binding } = await running({ ...h, service });
        let attempt = { ...rc, requestId: randomUUID() };
        const scheduled = outcome.startsWith('system-');
        const scheduledRoster = {
          ...binding,
          entries: [],
          digest: 'system-fixture',
        };
        let scheduledRequestId: string | undefined;
        let scheduledAuthority = true;
        if (scheduled) invalidSession = rc.sessionId;
        const since = h.now().toISOString();
        const wakeAt = new Date(h.now().getTime() + 60 * 60_000);
        const wake = createPostgresPersonVmScheduledWakeStore(db);
        const commitRejected =
          outcome === 'commit-rejected' || outcome === 'system-recovery';
        const recovering = commitRejected || outcome === 'commit-ack-lost';
        const nativeProofRejected = outcome === 'native-proof-rejected';
        const nativeReadbackFailed = outcome === 'native-readback-failed';
        if (nativeReadbackFailed) {
          const stopIdle = h.native.stopIdle!;
          h.native.stopIdle = async (...args) => {
            await stopIdle(...args);
            throw new PersonVmError('CLEANUP_INCOMPLETE');
          };
        }
        const samplePurposes: (string | undefined)[] = [];
        let mono = 0,
          runningJobs = 0,
          revision = 'first',
          prepared = 0;
        const mountNative = h.native.prepare;
        h.native.prepare = async (...args) => {
          await mountNative(...args);
          if (outcome === 'mount-change' && prepared > 0)
            revision = 'native-work-after-prepare';
        };
        const host = service.createAdmissionHost({
          openSql: open,
          idleMs: 5 * 60_000,
          monotonic: () => mono,
          scheduledIdleAuthority: {
            assertOwned(current, roster) {
              if (current.leaseEpoch !== binding.leaseEpoch)
                throw new PersonVmError('LEASE_LOST');
              expect(current).toEqual(binding);
              expect(roster).toBe(scheduledRoster);
            },
            async assertCurrent() {
              if (!scheduledAuthority)
                throw new PersonVmError('AUTHORIZATION_DENIED');
            },
            async dispatch(current, roster, requestId, active, stop) {
              this.assertOwned(current, roster);
              expect(requestId).toBe(scheduledRequestId);
              if (outcome === 'system-late-revoked')
                throw new PersonVmError('AUTHORIZATION_DENIED');
              if (outcome === 'system-wake-window')
                h.advance(wakeAt.getTime() - h.now().getTime());
              await stop(active);
            },
          },
          nativeActivity: {
            async observe(current, _signal, purpose) {
              if (outcome === 'sampled-ok') samplePurposes.push(purpose);
              const observedAt = h.now().toISOString();
              return {
                activity: {
                  binding: current,
                  observedAt,
                  state: outcome === 'system-unknown' ? 'unknown' : 'known',
                  activeTurns: 0,
                  activeJobs: runningJobs,
                  activeSubtasks: 0,
                  pendingApprovals: 0,
                },
                activeScheduleDeliveries: 0,
                coverage: {
                  cursor: { sourceId: 'native-fixture', revision },
                  from: since,
                  through: observedAt,
                  ...(outcome === 'sampled-ok'
                    ? { state: 'sampled', idleSince: since }
                    : {
                        state: 'continuous',
                        idleSince: runningJobs ? null : since,
                      }),
                },
              };
            },
            assertSampleCurrent(current, cursor, active) {
              active.throwIfAborted();
              expect(outcome).toBe('sampled-ok');
              expect(current).toEqual(binding);
              expect(cursor).toEqual({ sourceId: 'native-fixture', revision });
              samplePurposes.push('dispatch');
            },
            async subscribe() {
              throw new Error('unexpected subscription');
            },
          },
          prepareIdleStop:
            outcome === 'off'
              ? undefined
              : async (request, active) => {
                  prepared++;
                  if ('context' in request) {
                    expect(scheduled).toBe(false);
                    expect(request.context.requestId).toBe(attempt.requestId);
                  } else {
                    expect(scheduled).toBe(true);
                    expect(request.scheduledRoster).toBe(scheduledRoster);
                    scheduledRequestId ??= request.requestId;
                    expect(request.requestId).toBe(scheduledRequestId);
                  }
                  expect(request.binding).toEqual(binding);
                  expect(await store.read(binding.personId)).toMatchObject({
                    leaseOwner: expect.any(String),
                    phase: 'running',
                  });
                  await expect(
                    store.withLease(
                      binding.personId,
                      { now: h.now, ttlMs: 90_000 },
                      async () => {},
                    ),
                  ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
                  if (outcome === 'sampled-ok') {
                    const before = samplePurposes.length;
                    await Promise.all(
                      [active, active].map((signal) =>
                        request.assertStopCurrent(signal),
                      ),
                    );
                    expect(samplePurposes.slice(before)).toEqual([
                      'stop-guard',
                    ]);
                  } else await request.assertStopCurrent(active);
                  if (outcome === 'system-revoked') scheduledAuthority = false;
                  if (outcome === 'changed') revision = 'new-native-work';
                  if (
                    outcome === 'blocked' ||
                    (outcome === 'wake-plan-changed' && prepared > 1)
                  )
                    return { blocked: true };
                  if (
                    recovering ||
                    nativeProofRejected ||
                    nativeReadbackFailed
                  ) {
                    // Model the durable plan returned by the Workflow port.
                    await db`insert into person_vm_scheduled_wakes
                      (person_id,organization_id,vm_id,instance_id,lease_epoch,plan_id,receipt_ids,
                      wake_at,target_at,state)
                      values (${binding.personId},${binding.organizationId},${binding.vmId},
                      ${binding.instanceId},${binding.leaseEpoch},${scheduledRequestId ?? attempt.requestId},
                      array[${randomUUID()}]::uuid[],${wakeAt},${wakeAt},'waiting')
                      on conflict (plan_id) do nothing`;
                    return {
                      ok: true,
                      nextWakeAt: wakeAt.toISOString(),
                      ...(nativeReadbackFailed && {
                        dispatch: (
                          active: AbortSignal,
                          stop: (signal: AbortSignal) => Promise<void>,
                        ) => stop(active),
                      }),
                    };
                  }
                  if (outcome === 'wake-plan-revoked-at-dispatch')
                    return {
                      ok: true,
                      nextWakeAt: wakeAt.toISOString(),
                      async dispatch() {
                        expect(prepared).toBe(2);
                        throw new PersonVmError('AUTHORIZATION_DENIED');
                      },
                    };
                  return {
                    ok: true,
                    nextWakeAt:
                      outcome === 'system-wake-window'
                        ? wakeAt.toISOString()
                        : null,
                  };
                },
        });
        const reconcileOwned = () =>
          scheduled
            ? host.reconcileScheduledIdle(binding, scheduledRoster, signal())
            : host.reconcileIdle(attempt, binding, signal());
        if (scheduled)
          await expect(
            host.reconcileScheduledIdle(
              { ...binding, leaseEpoch: binding.leaseEpoch - 1 },
              scheduledRoster,
              signal(),
            ),
          ).rejects.toMatchObject({ code: 'LEASE_LOST' });
        await reconcileOwned();
        mono += 5 * 60_000 - 1;
        h.advance(mono);
        await reconcileOwned();
        expect(prepared).toBe(0);
        mono++;
        h.advance(1);
        if (outcome === 'active') runningJobs++;
        if (outcome === 'relogin') {
          invalidSession = rc.sessionId;
          await expect(
            host.reconcileIdle(attempt, binding, signal()),
          ).rejects.toMatchObject({
            code: 'AUTHORIZATION_DENIED',
          });
          const newLogin = context(binding.organizationId, binding.personId);
          expect(await service.resolve(newLogin, signal())).toEqual(binding);
          expect(authorized?.sessionId).toBe(newLogin.sessionId);
          attempt = { ...authorized!, requestId: randomUUID() };
        }
        if (commitRejected)
          await db`alter table person_vm_audit add constraint fixture_reject_stop_commit
            check (action<>'stop' or result<>'succeeded')`;
        if (nativeProofRejected)
          await db`alter table person_vm_audit add constraint fixture_reject_stop_commit
            check (action<>'stop.idle-dispatch' or result<>'succeeded')`;
        loseAcknowledgement = outcome === 'commit-ack-lost';
        try {
          const reconcile = reconcileOwned();
          if (
            [
              'changed',
              'mount-change',
              'wake-plan-changed',
              'system-wake-window',
            ].includes(outcome)
          )
            await expect(reconcile).rejects.toMatchObject({
              code: 'ACTIVITY_UNKNOWN',
            });
          else if (
            outcome === 'system-revoked' ||
            outcome === 'system-late-revoked' ||
            outcome === 'wake-plan-revoked-at-dispatch'
          )
            await expect(reconcile).rejects.toMatchObject({
              code: 'AUTHORIZATION_DENIED',
            });
          else if (recovering || nativeProofRejected || nativeReadbackFailed)
            await expect(reconcile).rejects.toBeInstanceOf(Error);
          else await reconcile;
        } finally {
          if (commitRejected || nativeProofRejected)
            await db`alter table person_vm_audit drop constraint fixture_reject_stop_commit`;
        }
        if (nativeProofRejected) {
          expect(h.states.get(binding.vmId)).toBe('stopped');
          expect(await store.read(binding.personId)).toMatchObject({
            phase: 'failed',
            diskRetained: true,
            leaseOwner: null,
          });
          expect(await store.idleStopReceipt(binding)).toBeUndefined();
          await expect(
            service.assertWorkerShutdownSafe(binding, signal()),
          ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
          await host.reconcileIdle(
            { ...attempt, requestId: randomUUID() },
            binding,
            signal(),
          );
          expect(h.log.filter((entry) => entry === 'native:stop')).toHaveLength(
            1,
          );
          expect(h.log).not.toContain('egress:revoke');
          await db`update person_vm_scheduled_wakes set wake_at=least(now()-interval '1 second', target_at)
            where plan_id=${attempt.requestId}`;
          const success = await db`select 1 from person_vm_audit
            where vm_id=${binding.vmId} and request_id=${attempt.requestId}
              and action='stop' and result='succeeded'`;
          expect(success).toEqual([]);
          expect(await wake.claim(90_000)).toBeNull();
          return;
        }
        if (nativeReadbackFailed) {
          expect(await store.idleStopReceipt(binding)).toEqual({
            requestId: attempt.requestId,
            completed: false,
          });
          await expect(
            service.assertWorkerShutdownSafe(binding, signal()),
          ).rejects.toMatchObject({
            code: 'CLEANUP_INCOMPLETE',
          });
          const restarted = new PersonVmService({
            ...h.options,
            store: new PostgresPersonVmStore(open),
          });
          expect(
            (await store.listJoinedIdleStopCandidates(signal())).map(
              ({ vmId }) => vmId,
            ),
          ).toContain(binding.vmId);
          await expect(
            restarted.recoverJoinedIdleStop(binding, signal()),
          ).resolves.toBe(true);
          expect(h.log.filter((entry) => entry === 'native:stop')).toHaveLength(
            1,
          );
          expect(await store.idleStopReceipt(binding)).toEqual({
            requestId: attempt.requestId,
            completed: true,
          });
          await db`update person_vm_scheduled_wakes set wake_at=least(now()-interval '1 second', target_at)
            where plan_id=${attempt.requestId}`;
          await expect(wake.claim(90_000)).resolves.toMatchObject({
            planId: attempt.requestId,
          });
          return;
        }
        if (outcome === 'system-recovery') {
          expect(await store.idleStopReceipt(binding)).toEqual({
            requestId: scheduledRequestId,
            completed: false,
          });
          scheduledAuthority = false;
          await reconcileOwned();
          expect(await store.idleStopReceipt(binding)).toEqual({
            requestId: scheduledRequestId,
            completed: true,
          });
        } else if (recovering) {
          expect(h.states.get(binding.vmId)).toBe('stopped');
          expect(await store.read(binding.personId)).toMatchObject(
            outcome === 'commit-rejected'
              ? { phase: 'running', leaseOwner: null }
              : { phase: 'stopped', leaseOwner: expect.any(String) },
          );
          const original = await store.idleStopReceipt(binding);
          expect(original).toEqual({
            requestId: attempt.requestId,
            completed: outcome === 'commit-ack-lost',
          });
          invalidSession = attempt.sessionId;
          await expect(
            host.reconcileIdle(attempt, binding, signal()),
          ).rejects.toMatchObject({
            code: 'AUTHORIZATION_DENIED',
          });
          const recoveryLogin = context(
            binding.organizationId,
            binding.personId,
          );
          await expect(
            service.resolve(recoveryLogin, signal()),
          ).rejects.toMatchObject({
            code:
              outcome === 'commit-ack-lost'
                ? 'LEASE_CONFLICT'
                : 'EGRESS_UNAVAILABLE',
          });
          expect(authorized?.sessionId).toBe(recoveryLogin.sessionId);
          h.advance(90_001);
          expect(
            (await store.listJoinedIdleStopCandidates(signal())).map(
              (candidate) => candidate.vmId,
            ),
          ).toContain(binding.vmId);
          if (outcome === 'commit-rejected') {
            h.states.set(binding.vmId, 'unknown');
            await expect(
              host.reconcileIdle(
                { ...authorized!, requestId: randomUUID() },
                binding,
                signal(),
              ),
            ).rejects.toMatchObject({ code: 'ACTIVITY_UNKNOWN' });
            expect(await store.idleStopReceipt(binding)).toEqual(original);
            expect(
              h.log.filter((entry) => entry === 'native:stop'),
            ).toHaveLength(1);
            h.states.set(binding.vmId, 'stopped');
          }
          const restarted = new PersonVmService({
            ...h.options,
            store: new PostgresPersonVmStore(open),
          });
          await expect(
            restarted.recoverJoinedIdleStop(binding, signal()),
          ).resolves.toBe(true);
          await db`update person_vm_scheduled_wakes set wake_at=least(now()-interval '1 second', target_at)
            where plan_id=${attempt.requestId}`;
          expect(await wake.claim(90_000)).toMatchObject({
            ...binding,
            planId: attempt.requestId,
          });
          expect(await wake.claim(90_000)).toBeNull();
        }
        const stopped =
          outcome === 'ok' ||
          outcome === 'sampled-ok' ||
          outcome === 'relogin' ||
          outcome === 'system-ok' ||
          recovering;
        const rechecked =
          stopped ||
          outcome === 'wake-plan-changed' ||
          outcome === 'wake-plan-revoked-at-dispatch' ||
          outcome === 'system-late-revoked' ||
          outcome === 'system-wake-window';
        const checkedOnce = [
          'blocked',
          'changed',
          'mount-change',
          'system-revoked',
        ].includes(outcome);
        expect(prepared).toBe(rechecked ? 2 : checkedOnce ? 1 : 0);
        expect(h.log.filter((entry) => entry === 'native:stop')).toHaveLength(
          stopped ? 1 : 0,
        );
        expect(h.log.includes('egress:revoke')).toBe(stopped);
        if (stopped)
          expect(h.log.indexOf('native:stop')).toBeLessThan(
            h.log.indexOf('egress:revoke'),
          );
        expect(await store.read(binding.personId)).toMatchObject({
          phase: stopped ? 'stopped' : 'running',
          diskRetained: true,
          leaseOwner: null,
        });
        const success =
          await db`select request_id, lease_epoch from person_vm_audit
          where vm_id=${binding.vmId} and action='stop' and result='succeeded'`;
        expect(success.map((row) => row.request_id)).toEqual(
          stopped ? [scheduled ? scheduledRequestId : attempt.requestId] : [],
        );
        if (stopped)
          expect(Number(success[0]!.lease_epoch)).toBe(binding.leaseEpoch);
        if (outcome === 'sampled-ok') {
          expect(samplePurposes.slice(0, 3)).toEqual([
            'inspection',
            'inspection',
            'inspection',
          ]);
          expect(samplePurposes.slice(3, -1)).toEqual(
            Array.from(
              { length: samplePurposes.length - 4 },
              () => 'stop-guard',
            ),
          );
          expect(samplePurposes.at(-1)).toBe('dispatch');
          expect(samplePurposes.length).toBeGreaterThan(4);
        }
        if (outcome === 'ok' || outcome === 'sampled-ok') {
          expect(await service.start(rc, signal())).toMatchObject({
            vmId: binding.vmId,
            diskRetained: true,
            ready: true,
          });
          expect(
            (await service.resolve(rc, signal())).leaseEpoch,
          ).toBeGreaterThan(binding.leaseEpoch);
        }
      },
    );
    it('qualifier requires the original shared host and cannot replace its factory', async () => {
      const h = await setup();
      const other = factory('wrong').open;
      expect(() =>
        h.service.createAdmissionHost({ openSql: other }),
      ).toThrowError('LEASE_CONFLICT');
      const fresh = new PersonVmService(h.options);
      expect(() => fresh.createAdmissionHost({ openSql: other })).toThrowError(
        'PROVIDER_FAILED',
      );
      await expect(
        fresh.assertAdmissionBinding(h.rc, h.binding, signal()),
      ).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
      await h.service.assertAdmissionBinding(h.rc, h.binding, signal());
      fresh.createAdmissionHost({ openSql: h.physical.open });
      await fresh.assertAdmissionBinding(h.rc, h.binding, signal());
    });
    it('starting qualification is not ordinary admission, dispatch or runtime readiness', async () => {
      const h = await setup();
      const before = [...h.log];
      await db`update person_virtual_machines set phase='starting' where person_id=${h.rc.actor.id}`;
      await h.service.assertAdmissionBinding(h.rc, h.binding, signal());
      await expect(
        h.host.admit(
          h.rc,
          h.binding,
          { participant: 'gateway', operationId: randomUUID() },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
      expect(await counts(h.rc.actor.id)).toEqual([]);
      expect(h.log).toEqual(before);
    });
    it('qualification preserves current authority errors and cancellation after local egress checking', async () => {
      const h = await setup();
      const original = h.options.authority.authorize;
      const failure = new Error('actual current identity source failed');
      h.options.authority.authorize = async () => {
        throw failure;
      };
      await expect(
        h.service.assertAdmissionBinding(h.rc, h.binding, signal()),
      ).rejects.toBe(failure);
      h.options.authority.authorize = original;
      const abort = new AbortController();
      h.egress.assertActive = async () => {
        abort.abort(failure);
      };
      await expect(
        h.service.assertAdmissionBinding(h.rc, h.binding, abort.signal),
      ).rejects.toBe(failure);
      expect(await counts(h.rc.actor.id)).toEqual([]);
    });

    it('pre-freeze memory/8-slot wait stays queued; finish waits for actual cancel/join', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway');
      const entered = latch(),
        release = latch();
      const waiting = own(
        h.host.queued(
          item,
          async (owned) => {
            entered.resolve();
            await release.promise;
            expect(owned.aborted).toBe(true);
          },
          signal(),
        ),
      );
      await entered.promise;
      const lease = await frozen(h);
      expect(
        await h.peer.participant('gateway').observe(h.binding, signal()),
      ).toMatchObject({ queued: 1, active: 0, deferred: 0 });
      const closing = own(h.host.finish(item));
      expect(h.host.finish(item)).toBe(closing);
      expect(item.signal.aborted).toBe(true);
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      h.states.set(h.binding.vmId, 'stopped');
      await expect(
        h.host.stopFrozen(h.rc, lease, signal()),
      ).rejects.toMatchObject({ code: 'VM_ACTIVE' });
      expect(h.log).not.toContain('native:stop');
      release.resolve();
      await waiting;
      await closing;
      expect(await counts(h.rc.actor.id)).toEqual([]);
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
    });

    it('an accepted old queue can activate behind freeze; active remains until real transport/transaction join', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway');
      const lease = await frozen(h),
        entered = latch(),
        release = latch();
      const transport = own(
        h.host.activate(
          item,
          async () => {
            entered.resolve();
            await release.promise;
            return 'actual-transport-closed';
          },
          signal(),
        ),
      );
      await entered.promise;
      expect(
        await h.peer.participant('gateway').observe(h.binding, signal()),
      ).toMatchObject({ active: 1, queued: 0 });
      const finish = own(h.host.finish(item));
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'active', count: 1 },
      ]);
      release.resolve();
      expect(await transport).toBe('actual-transport-closed');
      await finish;
      expect(await counts(h.rc.actor.id)).toEqual([]);
      await expect(
        h.host.activate(item, async () => 'forbidden', signal()),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
    });

    it('keeps public egress visible to a peer until its transfer joins and refuses new traffic during freeze', async () => {
      const h = await setup(),
        entered = latch(),
        release = latch();
      const transfer = own(
        h.host.withPublicEgress(h.binding, signal(), async () => {
          entered.resolve();
          await release.promise;
        }),
      );
      await entered.promise;
      const lease = await frozen(h);
      expect(
        await h.peer.participant('gateway').observe(h.binding, signal()),
      ).toMatchObject({ active: 1, queued: 0, deferred: 0 });
      const forbidden = vi.fn(async () => {});
      await expect(
        h.peer.withPublicEgress(h.binding, signal(), forbidden),
      ).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
      expect(forbidden).not.toHaveBeenCalled();
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'active', count: 1 },
      ]);
      h.states.set(h.binding.vmId, 'stopped');
      await expect(
        h.host.stopFrozen(h.rc, lease, signal()),
      ).rejects.toMatchObject({
        code: 'VM_ACTIVE',
      });
      expect(h.log).not.toContain('native:stop');
      release.resolve();
      await transfer;
      expect(await counts(h.rc.actor.id)).toEqual([]);
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
    });

    it('recovers the exact public permit after a committed admit loses its acknowledgement', async () => {
      let armed = false;
      const source = factory('proxy-lost-ack', async () => {
        if (!armed) return;
        armed = false;
        throw Object.assign(new Error('public admit COMMIT reply lost'), {
          code: 'ECONNRESET',
        });
      });
      const h = await setup(source.open);
      await h.host.participant('gateway').observe(h.binding, signal());
      const transfer = vi.fn(async () => {});
      armed = true;
      await expect(
        h.host.withPublicEgress(h.binding, signal(), transfer),
      ).rejects.toBeDefined();
      expect(transfer).not.toHaveBeenCalled();
      const active = [{ disposition: 'queued', count: 1 }];
      expect(await counts(h.rc.actor.id)).toEqual(active);
      await h.peer.recoverJoinedPublicEgress(h.binding.personId, signal());
      expect(await counts(h.rc.actor.id)).toEqual(active);
      await h.host.recoverJoinedPublicEgress(h.binding.personId, signal());
      expect(await counts(h.rc.actor.id)).toEqual([]);
    });

    it('releases a joined public transfer after a temporary finish write failure', async () => {
      const h = await setup();
      await db.unsafe(
        "create function fixture_block_delete() returns trigger language plpgsql as $$ begin raise exception 'fixture release rejected'; end; $$",
      );
      await db.unsafe(
        'create trigger fixture_block_delete before delete on person_vm_admission_permits for each row execute function fixture_block_delete()',
      );
      const transfer = vi.fn(async () => {});
      await expect(
        h.host.withPublicEgress(h.binding, signal(), transfer),
      ).rejects.toThrow('fixture release rejected');
      expect(transfer).toHaveBeenCalledOnce();
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'active', count: 1 },
      ]);
      await db.unsafe(
        'drop trigger fixture_block_delete on person_vm_admission_permits',
      );
      await h.host.recoverJoinedPublicEgress(h.binding.personId, signal());
      expect(await counts(h.rc.actor.id)).toEqual([]);
    });

    it('two independent clients linearize ordinary admission against freeze, never lose a queue to deferred', async () => {
      const h = await setup(),
        lease = await h.host.issue(h.rc, h.binding, signal());
      const [item] = await Promise.all([
        h.host.admit(
          h.rc,
          h.binding,
          { participant: 'gateway', operationId: randomUUID() },
          signal(),
        ),
        h.peer.participant('gateway').freeze(lease, signal()),
      ]);
      handles.push([h.host, item]);
      const observed = await h.peer
        .participant('gateway')
        .observe(h.binding, signal());
      expect(observed.state).toBe('known');
      if (observed.state !== 'known') throw new Error('unexpected unknown');
      expect(observed.queued + observed.deferred).toBe(1);
      expect(
        item.disposition === 'queued' ? observed.queued : observed.deferred,
      ).toBe(1);
      await h.host.finish(item);
      await h.peer.participant('gateway').thaw(lease, signal());
      await h.host.participant('entry').thaw(lease, signal());
    });

    it('same-epoch thaw resumes deferred demand without a freeze error or VM restart', async () => {
      const h = await setup(),
        lease = await frozen(h),
        item = await permit(h, 'gateway');
      expect(item.disposition).toBe('deferred');
      const forbidden = async () => {
        throw new Error('must never dispatch deferred');
      };
      await expect(
        h.host.activate(item, forbidden, signal()),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      await h.host.participant('gateway').thaw(lease, signal());
      const ready = own(h.host.waitUntilReady(h.rc, item, signal()));
      const [before] =
        await db`select lease_epoch from person_virtual_machines where person_id=${h.rc.actor.id}`;
      expect(Number(before!.lease_epoch)).toBe(h.binding.leaseEpoch);
      await h.peer.participant('entry').thaw(lease, signal());
      expect(await ready).toEqual(h.binding);
      expect(h.log.filter((value) => value === 'native:start')).toEqual([]);
      await h.host.finish(item);
      const fresh = await permit(h, 'gateway');
      expect(
        await h.host.activate(
          fresh,
          async () => 'same-epoch-dispatch',
          signal(),
        ),
      ).toBe('same-epoch-dispatch');
      await h.host.finish(fresh);
    });

    it.each(['gateway', 'entry'] as const)(
      'a %s subscriber latches the peer release even before wait registration',
      async (first) => {
        const h = await setup(),
          lease = await frozen(h),
          participant = h.host.participant(first);
        await participant.thaw(lease, signal());
        const subscription = await participant.subscribe(h.binding, signal());
        try {
          const before = await participant.observe(h.binding, signal());
          await h.peer
            .participant(first === 'gateway' ? 'entry' : 'gateway')
            .thaw(lease, signal());
          await subscription.wait(before.coverage.cursor, signal());
          expect(
            (await participant.observe(h.binding, signal())).coverage.cursor,
          ).not.toEqual(before.coverage.cursor);
        } finally {
          await subscription.close();
        }
      },
    );

    it('release after the exact predicate snapshot but before wait registration is not consumed as its baseline', async () => {
      const snapshot = latch(),
        release = latch();
      let armed = false,
        commits = 0;
      const source = factory('predicate-snapshot', async () => {
        // subscribe's initial read, then the exact predicate+cursor transaction.
        if (armed && ++commits === 2) {
          snapshot.resolve();
          await release.promise;
        }
      });
      const h = await setup(source.open),
        lease = await frozen(h),
        item = await permit(h, 'gateway');
      await h.host.participant('gateway').thaw(lease, signal());
      armed = true;
      const ready = own(h.host.waitUntilReady(h.rc, item, signal()));
      try {
        expect(
          await Promise.race([snapshot.promise, ready.then(() => 'premature')]),
        ).toBeUndefined();
        await h.peer.participant('entry').thaw(lease, signal());
        release.resolve();
        expect(await ready).toEqual(h.binding);
      } finally {
        release.resolve();
      }
    });

    it('A1 blocks ALL public epoch-changing entrances after only one release; two wake callers share one ready generation', async () => {
      const h = await setup(),
        lease = await frozen(h),
        demand = await permit(h, 'entry');
      h.states.set(h.binding.vmId, 'stopped'); // Synthetic provider fact, not real VM acceptance.
      expect((await h.host.stopFrozen(h.rc, lease, signal())).phase).toBe(
        'stopped',
      );
      expect((await h.store.read(h.rc.actor.id))!.leaseOwner).toBe(null); // no nested public stop lock
      await h.host.participant('gateway').thaw(lease, signal());
      for (const operation of [
        () => h.service.start(h.rc, signal()),
        () => h.service.create(h.rc, signal()),
        () => h.service.prewarm(h.rc, { trigger: 'input' }, signal()),
        () => h.service.delete(h.rc, {}, signal()),
        () => h.service.recoverExpired(h.rc, signal()),
      ])
        await expect(operation()).rejects.toBeDefined();
      const wakeA = own(h.host.wake(h.rc, h.binding, signal())),
        wakeB = own(h.peer.wake(h.rc, h.binding, signal()));
      expect(h.log.filter((value) => value === 'native:start')).toHaveLength(0);
      await h.peer.participant('entry').thaw(lease, signal());
      const [a, b] = await Promise.all([wakeA, wakeB]);
      expect(a).toEqual(b);
      expect(a.leaseEpoch).toBe(h.binding.leaseEpoch + 1);
      expect(h.log.filter((value) => value === 'native:start')).toHaveLength(1);
      expect(a.instanceId).not.toBe(h.binding.instanceId);
      await expect(
        h.host.activate(demand, async () => 'old-envelope', signal()),
      ).rejects.toBeDefined();
      await h.host.finish(demand);
      const next = await h.host.admit(
        h.rc,
        a,
        { participant: 'entry', operationId: randomUUID() },
        signal(),
      );
      handles.push([h.host, next]);
      expect(
        await h.host.activate(
          next,
          async () => 'newly-resolved-envelope-only',
          signal(),
        ),
      ).toBe('newly-resolved-envelope-only');
      await h.host.finish(next);
    });

    it('joined deferred cleanup still releases its exact permit after an authorized VM tombstone', async () => {
      const h = await setup(),
        lease = await frozen(h),
        pending = await permit(h, 'entry');
      h.states.set(h.binding.vmId, 'stopped');
      await h.host.stopFrozen(h.rc, lease, signal());
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
      expect((await h.service.delete(h.rc, {}, signal())).phase).toBe(
        'deleted',
      );
      await h.host.finish(pending);
      expect(await counts(h.rc.actor.id)).toEqual([]);
      expect(h.disks.has(h.binding.vmId)).toBe(true);
      await expect(
        h.peer.admit(
          h.rc,
          h.binding,
          { participant: 'entry', operationId: randomUUID() },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('partial ACK cannot stop; subscription close does not release; stale thaw cannot open the next freeze', async () => {
      const h = await setup(),
        lease = await h.host.issue(h.rc, h.binding, signal());
      await h.host.participant('gateway').freeze(lease, signal());
      const subscription = await h.peer
        .participant('gateway')
        .subscribe(h.binding, signal());
      const closing = own(subscription.close());
      expect(subscription.close()).toBe(closing);
      await closing;
      expect(
        (await h.peer.participant('gateway').observe(h.binding, signal()))
          .state,
      ).toBe('known');
      h.states.set(h.binding.vmId, 'stopped');
      await expect(
        h.host.stopFrozen(h.rc, lease, signal()),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' });
      expect(h.log).not.toContain('native:stop');
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
      const next = await h.host.issue(h.rc, h.binding, signal());
      await h.host.participant('gateway').freeze(next, signal());
      expect(await h.peer.participant('gateway').thaw(lease, signal())).toBe(
        'superseded',
      );
      expect(
        await h.peer.participant('gateway').observe(h.binding, signal()),
      ).toMatchObject({ frozen: next });
      await h.host.participant('gateway').thaw(next, signal());
      await h.peer.participant('entry').thaw(next, signal());
    });

    it('latched subscribe/read/wait sees a whole short start/end even when both counts are zero', async () => {
      const h = await setup(),
        participant = h.peer.participant('gateway');
      const subscription = await participant.subscribe(h.binding, signal());
      try {
        const before = await participant.observe(h.binding, signal());
        h.advanceMono(18 * 60_000);
        const item = await permit(h, 'gateway');
        await h.host.finish(item);
        h.advanceMono(2 * 60_000);
        await subscription.wait(before.coverage.cursor, signal());
        const after = await participant.observe(h.binding, signal());
        expect(after).toMatchObject({ state: 'known', active: 0, queued: 0 });
        expect(after.coverage.cursor).not.toEqual(before.coverage.cursor);
        if (after.coverage.state !== 'continuous')
          throw new Error('unexpected gap');
        expect(after.coverage.from).toBe(h.now().toISOString());
        expect(after.coverage.idleSince).toBe(after.coverage.from); // First new idle proof, not 20min old.
      } finally {
        await subscription.close();
      }
    });

    it('issue, peer freeze ACK and demand wake subscribers without resetting the accepted idle candidate', async () => {
      const h = await setup(),
        participant = h.peer.participant('gateway');
      const subscription = await participant.subscribe(h.binding, signal());
      const candidate = advanceIdleCandidate(
        undefined,
        ...(await idleInputs(h, 0)),
      );
      const cancel = new AbortController(),
        reason = new Error('join synthetic demand');
      let mono = 0,
        demand: Promise<unknown> | undefined;
      async function unchanged<T>(operation: () => Promise<T>) {
        const before = await participant.observe(h.binding, signal());
        const result = await operation();
        await subscription.wait(before.coverage.cursor, signal());
        expect(
          (await participant.observe(h.binding, signal())).coverage.cursor,
        ).not.toEqual(before.coverage.cursor);
        mono += 5 * 60_000;
        h.advanceMono(5 * 60_000, false);
        expect(
          advanceIdleCandidate(candidate, ...(await idleInputs(h, mono))),
        ).toEqual(candidate);
        return result;
      }
      try {
        const lease = await unchanged(() =>
          h.host.issue(h.rc, h.binding, signal()),
        );
        await unchanged(() =>
          h.peer.participant('entry').freeze(lease, signal()),
        );
        await unchanged(async () => {
          demand = own(
            h.host.wake(
              h.rc,
              h.binding,
              AbortSignal.any([signal(), cancel.signal]),
            ),
          ).catch((error: unknown) => error);
        });
        h.advanceMono(5 * 60_000, false);
        expect(
          advanceIdleCandidate(
            candidate,
            ...(await idleInputs(h, PERSON_VM_IDLE_MS)),
          )?.mono,
        ).toBe(0);
        expect(h.log).not.toContain('native:stop');
        cancel.abort(reason);
        expect(await demand).toBe(reason);
        await h.host.participant('gateway').thaw(lease, signal());
        await h.peer.participant('entry').thaw(lease, signal());
      } finally {
        cancel.abort(reason);
        await demand;
        await subscription.close();
      }
    });

    it.each(['gateway', 'entry'] as const)(
      'a short accepted %s start/end resets idle even at the same UTC millisecond',
      async (participant) => {
        const h = await setup(),
          before = await idleInputs(h, 0);
        const candidate = advanceIdleCandidate(undefined, ...before);
        h.advanceMono(18 * 60_000, false);
        const item = await permit(h, participant);
        await h.host.activate(
          item,
          async () => 'actual callback joined',
          signal(),
        );
        await h.host.finish(item);
        const after = await idleInputs(h, 18 * 60_000);
        expect(
          after[1].map(
            (coverage) => coverage.state === 'continuous' && coverage.idleSince,
          ),
        ).toEqual(
          before[1].map(
            (coverage) => coverage.state === 'continuous' && coverage.idleSince,
          ),
        );
        expect(after[2]).not.toEqual(before[2]);
        const reset = advanceIdleCandidate(candidate, ...after);
        expect(reset?.mono).toBe(18 * 60_000);
        h.advanceMono(2 * 60_000, false);
        expect(
          advanceIdleCandidate(
            reset,
            ...(await idleInputs(h, PERSON_VM_IDLE_MS)),
          )?.mono,
        ).toBe(18 * 60_000);
        expect(await counts(h.rc.actor.id)).toEqual([]);
      },
    );

    it('candidate continuity still resets on source/gap, monotonic rollback and real hold activity', async () => {
      const h = await setup();
      const candidate = advanceIdleCandidate(
        undefined,
        ...(await idleInputs(h, 0)),
      );
      h.advanceMono(18 * 60_000, false);
      const replaced = await idleInputs(h, 18 * 60_000);
      replaced[1][0] = (
        await h.peer.participant('gateway').observe(h.binding, signal())
      ).coverage;
      expect(advanceIdleCandidate(candidate, ...replaced)?.mono).toBe(
        18 * 60_000,
      );
      const gap = await idleInputs(h, 18 * 60_000);
      gap[1][2] = {
        state: 'unknown',
        cursor: null,
        reason: 'native source gap',
      };
      expect(advanceIdleCandidate(candidate, ...gap)).toBeUndefined();
      h.advanceMono(2 * 60_000, false);
      const fresh = advanceIdleCandidate(
        undefined,
        ...(await idleInputs(h, PERSON_VM_IDLE_MS)),
      );
      expect(fresh?.mono).toBe(PERSON_VM_IDLE_MS);
      h.advanceMono(-60_000, false);
      const rollback = advanceIdleCandidate(
        fresh,
        ...(await idleInputs(h, 19 * 60_000)),
      );
      expect(rollback?.mono).toBe(19 * 60_000);
      const hold = await h.service.acquireHold(
        h.rc,
        h.binding,
        { kind: 'host-operation', operationId: randomUUID() },
        signal(),
      );
      expect(
        advanceIdleCandidate(rollback, ...(await idleInputs(h, 19 * 60_000))),
      ).toBeUndefined();
      h.advanceMono(60_000, false);
      h.advance(1);
      await h.service.releaseHold(h.rc, h.binding, hold, signal());
      expect(
        advanceIdleCandidate(
          rollback,
          ...(await idleInputs(h, PERSON_VM_IDLE_MS)),
        )?.mono,
      ).toBe(PERSON_VM_IDLE_MS);
    });

    it('unknown native producer never gains automatic stop permission from PG/fixture zero or wall-clock time', async () => {
      const h = await setup();
      await h.service.reconcileIdle(h.rc, signal());
      h.advanceMono(7 * 24 * 60 * 60_000);
      expect((await h.service.reconcileIdle(h.rc, signal())).phase).toBe(
        'running',
      );
      const lease = await frozen(h);
      await expect(
        h.host.stopFrozen(h.rc, lease, signal()),
      ).rejects.toMatchObject({ code: 'ACTIVITY_UNKNOWN' });
      expect(h.states.get(h.binding.vmId)).toBe('running');
      expect(h.log).not.toContain('native:stop');
      // No physical stop was committed. Explicit operator reconciliation releases the exact round.
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
      expect(PERSON_VM_IDLE_MS).toBe(20 * 60_000); // Time above is a fixture, not a real wait.
    });

    it('foreign copied handles and wrong tenant authority cannot activate or finish someone else’s permit', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway');
      await expect(
        h.peer.activate(item, async () => 'forbidden', signal()),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' });
      expect(() => h.peer.finish(item)).toThrowError('LEASE_LOST');
      const other = context(randomUUID(), h.rc.actor.id);
      await expect(
        h.host.admit(
          other,
          h.binding,
          { participant: 'entry', operationId: randomUUID() },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      await h.host.finish(item);
      expect(await counts(h.rc.actor.id)).toEqual([]);
    });

    it('owner PG loss aborts but cannot release the physical fence before blocked provider settlement; explicit recovery uses a new owner', async () => {
      const h = await setup(),
        lease = await frozen(h),
        entered = latch(),
        release = latch();
      h.states.set(h.binding.vmId, 'stopped');
      const originalStop = h.native.stop,
        originalStatus = h.native.status;
      let ownerSignal: AbortSignal | undefined;
      h.native.status = async (binding, owned) => {
        ownerSignal ??= owned;
        return originalStatus(binding, owned);
      };
      h.native.stop = async (binding, owned) => {
        entered.resolve();
        await release.promise;
        await originalStop(binding, owned);
      };
      const stop = own(h.host.stopFrozen(h.rc, lease, signal()));
      const outcome = stop.catch((error: unknown) => error);
      try {
        await entered.promise;
        const [claimed] =
          await db`select lease_owner from person_virtual_machines where person_id=${h.rc.actor.id}`;
        const oldOwner = claimed!.lease_owner;
        const owners =
          await admin`select a.pid from pg_stat_activity a join pg_locks l on a.pid=l.pid
        where a.application_name like ${prefix + '-physicalA-%'} and l.locktype='advisory' and l.granted`;
        expect(owners).toHaveLength(1);
        await admin`select pg_terminate_backend(${owners[0]!.pid})`;
        await expect.poll(() => ownerSignal?.aborted).toBe(true);
        h.advanceMono(90001); // Expiry fixture never fences the pending callback.
        await expect(
          h.peerStore.withLease(
            h.rc.actor.id,
            { now: h.now, ttlMs: 90000 },
            async () => {
              throw new Error('foreign physical callback must never run');
            },
          ),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        await expect(
          h.peer.recoverStop(h.rc, lease, signal()),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        await expect(
          h.host.participant('gateway').thaw(lease, signal()),
        ).rejects.toBeDefined();
        const [stillOwned] =
          await db`select lease_owner,admission_state from person_virtual_machines where person_id=${h.rc.actor.id}`;
        expect(stillOwned!.lease_owner).toBe(oldOwner);
        expect(stillOwned!.admission_state.round.stop).toBe('pending');
        release.resolve();
        await outcome;
        h.native.stop = originalStop;
        expect((await h.host.recoverStop(h.rc, lease, signal())).phase).toBe(
          'stopped',
        );
        const [recovered] =
          await db`select lease_owner,admission_state from person_virtual_machines where person_id=${h.rc.actor.id}`;
        expect(recovered!.lease_owner).toBe(null);
        expect(recovered!.admission_state.round.stop).toBe('confirmed');
        await h.host.participant('gateway').thaw(lease, signal());
        await h.peer.participant('entry').thaw(lease, signal());
        expect((await h.host.wake(h.rc, h.binding, signal())).leaseEpoch).toBe(
          h.binding.leaseEpoch + 1,
        );
      } finally {
        release.resolve();
        await outcome;
        h.native.stop = originalStop;
        h.native.status = originalStatus;
      }
    });

    it('a settled read/freeze owner cannot be upgraded into stop recovery with partial ACKs and accepted work', async () => {
      const h = await setup(),
        item = await permit(h, 'entry');
      const lease = await h.host.issue(h.rc, h.binding, signal());
      await h.host.participant('gateway').freeze(lease, signal());
      h.states.set(h.binding.vmId, 'stopped');
      await settledOrphan(h);
      const before = [...h.log];
      await expect(
        h.host.recoverStop(h.rc, lease, signal()),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      expect(h.log).toEqual(before);
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      // Existing trusted host store API can explicitly fence/release a
      // non-stop owner without touching VM, independent work, or the gate.
      h.advanceMono(90001);
      await h.store.recover(
        h.rc.actor.id,
        { now: h.now, ttlMs: 90000, signal: signal() },
        async (owned) => {
          await owned.guard();
        },
      );
      expect((await h.store.read(h.rc.actor.id))!.leaseOwner).toBe(null);
      expect(h.log).toEqual(before);
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      await h.host.finish(item);
    });

    it('public recoverExpired cannot clean a native-off VM while an independent accepted host permit remains', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway');
      h.states.set(h.binding.vmId, 'stopped');
      await settledOrphan(h);
      const before = [...h.log];
      await expect(
        h.service.recoverExpired(h.rc, signal()),
      ).rejects.toMatchObject({ code: 'VM_ACTIVE' });
      expect(h.log).toEqual(before);
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      await h.host.finish(item);
      h.advanceMono(90001);
      expect((await h.service.recoverExpired(h.rc, signal())).phase).toBe(
        'stopped',
      );
    });

    it('even a persisted unknown-stop recovery must recheck accepted work under its new physical owner', async () => {
      const h = await setup(),
        item = await permit(h, 'entry'),
        lease = await frozen(h);
      // Negative storage-recovery matrix: a stop marker is not proof that a
      // separately durable accepted permit joined. No successful idle stop is claimed.
      await db`update person_virtual_machines set admission_state=jsonb_set(admission_state,'{round,stop}','"unknown"'::jsonb),admission_revision=admission_revision+1 where person_id=${h.rc.actor.id}`;
      h.states.set(h.binding.vmId, 'stopped');
      await settledOrphan(h);
      const before = [...h.log];
      await expect(
        h.host.recoverStop(h.rc, lease, signal()),
      ).rejects.toMatchObject({ code: 'VM_ACTIVE' });
      expect(h.log).toEqual(before);
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      await h.host.finish(item);
      h.advanceMono(90001);
      expect((await h.host.recoverStop(h.rc, lease, signal())).phase).toBe(
        'stopped',
      );
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
    });

    it('revoke failure still attempts stop; unknown physical cleanup cannot thaw or wake', async () => {
      const h = await setup(),
        lease = await frozen(h);
      h.states.set(h.binding.vmId, 'stopped');
      h.egress.revoke = async () => {
        h.log.push('synthetic-revoke-failure');
        throw new Error('synthetic revoke failure');
      };
      await expect(
        h.host.stopFrozen(h.rc, lease, signal()),
      ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
      expect(h.log).toContain('native:stop');
      expect(h.states.get(h.binding.vmId)).toBe('stopped');
      await expect(
        h.peer.participant('entry').thaw(lease, signal()),
      ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
      const caller = new AbortController();
      const wake = own(h.host.wake(h.rc, h.binding, caller.signal));
      const joined = wake.catch((error: unknown) => error);
      caller.abort(
        new Error('client cancelled while unknown cleanup remains closed'),
      );
      await joined;
      expect(h.log.filter((value) => value === 'native:start')).toHaveLength(0);
      const [row] =
        await db`select admission_state from person_virtual_machines where person_id=${h.rc.actor.id}`;
      expect(row!.admission_state.round.stop).toBe('unknown');
    });

    it.each([
      ['queued', 'operation-first'],
      ['queued', 'finish-first'],
      ['active', 'operation-first'],
      ['active', 'finish-first'],
    ] as const)(
      'an entered %s callback rejection retains its permit and rejects recovery: %s',
      async (disposition, order) => {
        const h = await setup(),
          item = await permit(h, 'gateway');
        const entered = latch(),
          release = latch(),
          failure = new Error('actual drain unknown');
        const operation = async () => {
          entered.resolve();
          await release.promise;
          throw failure;
        };
        const active = own(
          disposition === 'active'
            ? h.host.activate(item, operation, signal())
            : h.host.queued(item, operation, signal()),
        );
        const outcome = active.catch((error: unknown) => error);
        await entered.promise;
        if (order === 'operation-first') {
          release.resolve();
          expect(await outcome).toBe(failure); // pending has already settled before finish.
        }
        const closing = own(h.host.finish(item));
        const closed = closing.catch((error: unknown) => error);
        expect(await counts(h.rc.actor.id)).toEqual([
          { disposition, count: 1 },
        ]);
        release.resolve();
        expect(await outcome).toBe(failure);
        expect(await closed).toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
        expect(h.host.finish(item)).toBe(closing);
        await expect(
          h.host.recoverPermit(item, signal()),
        ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
        expect(await counts(h.rc.actor.id)).toEqual([
          { disposition, count: 1 },
        ]);
      },
    );

    it('an outer queued callback cannot clear an inner activation unknown join by catching its rejection', async () => {
      const h = await setup(),
        item = await permit(h, 'entry');
      const failure = new Error('inner iterator return failed');
      const outcome = await h.host.queued(
        item,
        async (queuedSignal) => {
          try {
            await h.host.activate(
              item,
              async () => {
                throw failure;
              },
              queuedSignal,
            );
            throw new Error('inner must reject');
          } catch (error) {
            return { ok: false as const, error };
          }
        },
        signal(),
      );
      expect(outcome.error).toBe(failure);
      await expect(h.host.finish(item)).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
      await expect(h.host.recoverPermit(item, signal())).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'active', count: 1 },
      ]);
    });

    it.each(['authorization', 'cancellation'] as const)(
      'a failure before callback entry releases after its own resources join: %s',
      async (kind) => {
        const h = await setup(),
          item = await permit(h, 'entry');
        const cancel = new AbortController(),
          reason = new Error('cancel before callback');
        let entered = 0;
        if (kind === 'authorization') h.authorize(false);
        else cancel.abort(reason);
        const outcome = await h.host
          .activate(
            item,
            async () => {
              entered += 1;
            },
            AbortSignal.any([signal(), cancel.signal]),
          )
          .catch((error: unknown) => error);
        expect(entered).toBe(0);
        if (kind === 'authorization')
          expect(outcome).toMatchObject({ code: 'AUTHORIZATION_DENIED' });
        else expect(outcome).toBe(reason);
        await h.host.finish(item);
        expect(await counts(h.rc.actor.id)).toEqual([]);
      },
    );

    it('a business error after actual child join fulfils nested callbacks and is rethrown unchanged outside them', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway');
      const entered = latch(),
        childJoined = latch(),
        failure = new Error('provider returned a normal business failure');
      const consumer = own(
        (async () => {
          const outcome = await h.host.queued(
            item,
            (queuedSignal) =>
              h.host.activate(
                item,
                async () => {
                  entered.resolve();
                  try {
                    throw failure;
                  } catch (error) {
                    await childJoined.promise;
                    return { ok: false as const, error };
                  }
                },
                queuedSignal,
              ),
            signal(),
          );
          await h.host.finish(item);
          if (!outcome.ok) throw outcome.error;
        })(),
      );
      const result = consumer.catch((error: unknown) => error);
      await entered.promise;
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'active', count: 1 },
      ]);
      childJoined.resolve();
      expect(await result).toBe(failure);
      expect(await counts(h.rc.actor.id)).toEqual([]);
    });

    it('cooperative cancellation stays active until its actual child joins, then returns a local outcome and preserves the original cancel', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway');
      const entered = latch(),
        aborted = latch(),
        childJoined = latch();
      const cancel = new AbortController(),
        reason = new Error('original caller cancellation');
      const active = own(
        h.host.activate(
          item,
          async (owned) => {
            entered.resolve();
            await new Promise<void>((resolve) => {
              const onAbort = () => {
                aborted.resolve();
                resolve();
              };
              if (owned.aborted) onAbort();
              else owned.addEventListener('abort', onAbort, { once: true });
            });
            await childJoined.promise;
            return { ok: false as const, error: owned.reason as unknown };
          },
          AbortSignal.any([signal(), cancel.signal]),
        ),
      );
      const consumer = own(
        (async () => {
          const outcome = await active;
          await h.host.finish(item);
          if (!outcome.ok) throw outcome.error;
        })(),
      );
      const result = consumer.catch((error: unknown) => error);
      await entered.promise;
      cancel.abort(reason);
      await aborted.promise;
      const closing = own(h.host.finish(item));
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'active', count: 1 },
      ]);
      childJoined.resolve();
      await closing;
      expect(await result).toBe(reason);
      expect(await counts(h.rc.actor.id)).toEqual([]);
    });

    it('failed finish write retains an actually joined permit, with explicit same-owner recovery rather than zeroing or TTL steal', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway');
      expect(await h.host.activate(item, async () => 42, signal())).toBe(42);
      const blocking = factory('blocker').open(),
        held = latch(),
        release = latch();
      const key = 817523;
      const owner = own(
        blocking.begin(async (sql) => {
          await sql`select pg_advisory_xact_lock(${key})`;
          held.resolve();
          await release.promise;
        }),
      );
      const ownerOutcome = owner.catch((error: unknown) => error);
      let outcome: Promise<unknown> = Promise.resolve();
      try {
        await Promise.race([held.promise, owner]);
        await db.unsafe(
          `create function fixture_block_delete() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(${key}); return old; end; $$`,
        );
        await db.unsafe(
          'create trigger fixture_block_delete before delete on person_vm_admission_permits for each row execute function fixture_block_delete()',
        );
        const finish = own(h.host.finish(item));
        outcome = finish.catch((error: unknown) => error);
        const pending = () =>
          admin`select pid from pg_stat_activity where application_name like ${prefix + '-physicalA-%'} and wait_event='advisory'`;
        await expect.poll(async () => (await pending()).length).toBe(1);
        const [backend] = await pending();
        await admin`select pg_terminate_backend(${backend!.pid})`;
        expect(await outcome).toBeInstanceOf(Error);
        expect(h.host.finish(item)).toBe(finish);
        expect(await counts(h.rc.actor.id)).toEqual([
          { disposition: 'active', count: 1 },
        ]);
        await expect(
          h.peer.recoverPermit(item, signal()),
        ).rejects.toMatchObject({ code: 'LEASE_LOST' });
        await db.unsafe(
          'drop trigger fixture_block_delete on person_vm_admission_permits',
        );
        release.resolve();
        await owner;
        await h.host.recoverPermit(item, signal());
        expect(await counts(h.rc.actor.id)).toEqual([]);
      } finally {
        release.resolve();
        await ownerOutcome;
        await outcome;
        await blocking.end({ timeout: 0 });
      }
    });

    it('lost admit ACK after a REAL PG commit has no callback; only its settled local issuer can retry that exact operation', async () => {
      let armed = false;
      const source = factory('lost-ack', async () => {
        if (armed) {
          armed = false;
          throw Object.assign(
            new Error('synthetic response lost AFTER actual COMMIT'),
            { code: 'ECONNRESET' },
          );
        }
      });
      const h = await setup(source.open),
        operationId = randomUUID();
      // Initialize the durable projection before injecting the response failure.
      await h.host.participant('gateway').observe(h.binding, signal());
      armed = true;
      await expect(
        h.host.admit(
          h.rc,
          h.binding,
          { participant: 'gateway', operationId },
          signal(),
        ),
      ).rejects.toBeDefined();
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      await expect(
        h.peer.admit(
          h.rc,
          h.binding,
          { participant: 'gateway', operationId },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      const retry = await h.host.admit(
        h.rc,
        h.binding,
        { participant: 'gateway', operationId },
        signal(),
      );
      handles.push([h.host, retry]);
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'queued', count: 1 },
      ]);
      expect(
        await h.host.activate(
          retry,
          async () => 'only-returned-handle-runs',
          signal(),
        ),
      ).toBe('only-returned-handle-runs');
      await h.host.finish(retry);
      expect(await counts(h.rc.actor.id)).toEqual([]);
    });

    it('a real COMMIT followed by PG loss joins its actual delivery before end and never issues a post-close rollback', async () => {
      const committed = latch(),
        closed = latch(),
        release = latch();
      let armed = false,
        name = '',
        delivered = false,
        settled = false;
      const source = factory(
        'commit-join',
        async (currentName) => {
          if (!armed) return;
          armed = false;
          name = currentName;
          committed.resolve();
          await release.promise;
          delivered = true;
        },
        (currentName) => {
          if (currentName === name) closed.resolve();
        },
      );
      const h = await setup(source.open),
        operationId = randomUUID();
      armed = true;
      const admission = own(
        h.host.admit(
          h.rc,
          h.binding,
          { participant: 'gateway', operationId },
          signal(),
        ),
      );
      const outcome = own(
        admission.then(
          (value) => {
            settled = true;
            return value;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        ),
      );
      try {
        await committed.promise;
        const [backend] =
          await admin`select pid from pg_stat_activity where application_name=${name}`;
        expect(backend).toBeDefined();
        await admin`select pg_terminate_backend(${backend!.pid})`;
        await closed.promise;
        await expect(
          h.peer.admit(
            h.rc,
            h.binding,
            { participant: 'gateway', operationId },
            signal(),
          ),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        expect(settled).toBe(false);
        expect(source.events).not.toContain(name + ':end');
        release.resolve();
        expect(await outcome).toBeInstanceOf(Error);
        expect(delivered).toBe(true);
        const tail = source.events
          .slice(source.events.indexOf(name + ':close') + 1)
          .filter((event) => event.startsWith(name + ':'));
        expect(tail).toEqual([name + ':end']);
        expect(await counts(h.rc.actor.id)).toEqual([
          { disposition: 'queued', count: 1 },
        ]);
        const retry = await h.host.admit(
          h.rc,
          h.binding,
          { participant: 'gateway', operationId },
          signal(),
        );
        handles.push([h.host, retry]);
        await h.host.finish(retry);
      } finally {
        release.resolve();
        await outcome;
      }
    });

    it('LISTEN close joins real UNLISTEN before end, preserves its first failure and closes the owner', async () => {
      const failure = new Error(
          'synthetic failure AFTER real UNLISTEN acknowledgement',
        ),
        closed = latch();
      let listenName = '';
      const source = factory(
        'listen-close',
        undefined,
        (name) => {
          if (name === listenName) closed.resolve();
        },
        failure,
      );
      const h = await setup(source.open);
      const subscription = await h.host
        .participant('gateway')
        .subscribe(h.binding, signal());
      listenName = source.events
        .find((event) => event.endsWith(':listen'))!
        .slice(0, -':listen'.length);
      const closing = own(subscription.close());
      expect(subscription.close()).toBe(closing);
      await expect(closing).rejects.toBe(failure);
      await closed.promise;
      expect(source.events.indexOf(listenName + ':unlisten')).toBeLessThan(
        source.events.indexOf(listenName + ':end'),
      );
      expect(
        source.events.filter((event) => event === listenName + ':end'),
      ).toHaveLength(1);
    });

    it('epoch/revocation invalidation cancels a tracked transport but finish still joins it before releasing durable activity', async () => {
      const h = await setup(),
        item = await permit(h, 'gateway'),
        entered = latch(),
        release = latch();
      let ownedSignal: AbortSignal | undefined;
      const active = own(
        h.host.activate(
          item,
          async (owned) => {
            ownedSignal = owned;
            entered.resolve();
            await release.promise;
          },
          signal(),
        ),
      );
      await entered.promise;
      // Simulate a trusted future revocation producer; no organization API is implemented here.
      await db`update person_virtual_machines set admission_version=${randomUUID()},
      admission_state=jsonb_set(admission_state,'{revoked}',${db.json('fixture-canonical-source')}::jsonb)
      where person_id=${h.rc.actor.id}`;
      await expect.poll(() => ownedSignal?.aborted).toBe(true);
      const finish = own(h.host.finish(item));
      expect(await counts(h.rc.actor.id)).toEqual([
        { disposition: 'active', count: 1 },
      ]);
      release.resolve();
      await active;
      await finish;
      await expect(h.service.start(h.rc, signal())).rejects.toMatchObject({
        code: 'LEASE_CONFLICT',
      });
      await expect(
        h.peer.admit(
          h.rc,
          h.binding,
          { participant: 'entry', operationId: randomUUID() },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    });

    it('the actual public start owner aborts on shared revocation; a late provider start cannot revive the VM', async () => {
      const h = await setup();
      h.states.set(h.binding.vmId, 'stopped');
      await h.service.stop(h.rc, signal());
      const entered = latch(),
        release = latch(),
        original = h.native.start;
      let ownerSignal: AbortSignal | undefined;
      const runtimeStarts = h.log.filter(
        (item) => item === 'runtime:start',
      ).length;
      h.native.start = async (binding, owned) => {
        ownerSignal = owned;
        entered.resolve();
        await release.promise;
        await original(binding, signal()); // Intentionally ignore abort to model late external completion.
      };
      const start = own(h.service.start(h.rc, signal())),
        outcome = start.catch((error: unknown) => error);
      try {
        await entered.promise;
        await db`update person_virtual_machines set admission_version=${randomUUID()},
        admission_state=jsonb_set(admission_state,'{revoked}',${db.json('fixture-canonical-disable')}::jsonb)
        where person_id=${h.rc.actor.id}`;
        await expect.poll(() => ownerSignal?.aborted).toBe(true);
        release.resolve();
        expect(await outcome).toBeInstanceOf(Error);
        expect(h.states.get(h.binding.vmId)).toBe('stopped');
        expect(h.log.filter((item) => item === 'runtime:start')).toHaveLength(
          runtimeStarts,
        );
        expect(h.disks.has(h.binding.vmId)).toBe(true);
        expect(h.log).not.toContain('disk:delete');
        await expect(
          h.peerService.prewarm(h.rc, { trigger: 'page' }, signal()),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      } finally {
        release.resolve();
        await outcome;
        h.native.start = original;
      }
    });

    it('phase-independent assertLease/read assertions can reenter an owned final callback; a nested same-person mutation cannot', async () => {
      const h = await setup(),
        lease = await frozen(h);
      await db`update person_virtual_machines set phase='starting' where person_id=${h.rc.actor.id}`;
      await h.host.withLease(
        lease,
        async (owned) => {
          await h.host.assertLease(lease, owned);
          await h.peer.participant('gateway').assertFrozen(lease, owned);
          await h.peer.participant('entry').assertFrozen(lease, owned);
          await expect(
            h.host.withLease(
              lease,
              async () => {
                throw new Error('must not enter');
              },
              owned,
            ),
          ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        },
        signal(),
      );
      await db`update person_virtual_machines set phase='running' where person_id=${h.rc.actor.id}`;
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
    });

    it('wake never returns an unauthenticated/401-like readiness fixture as ready', async () => {
      const h = await setup(),
        lease = await frozen(h);
      h.states.set(h.binding.vmId, 'stopped');
      await h.host.stopFrozen(h.rc, lease, signal());
      await h.host.participant('gateway').thaw(lease, signal());
      await h.peer.participant('entry').thaw(lease, signal());
      h.setReadiness({
        authenticated: false,
        editorReady: false,
        canSend: false,
      });
      await expect(
        h.host.wake(h.rc, h.binding, signal()),
      ).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
      expect(h.states.get(h.binding.vmId)).toBe('stopped');
    });

    it('a pending deferred request retains its exact old release receipt across another same-binding freeze and a later generation', async () => {
      const snapshot = latch(),
        release = latch();
      let armed = false,
        commits = 0;
      const source = factory('late-receipt', async () => {
        // Old binding subscribe rolls back; then old receipt and current gate commit.
        if (armed && ++commits === 2) {
          snapshot.resolve();
          await release.promise;
        }
      });
      const h = await setup(source.open),
        first = await frozen(h),
        pending = await permit(h, 'gateway');
      await h.host.participant('gateway').thaw(first, signal());
      await h.peer.participant('entry').thaw(first, signal());
      const second = await frozen(h);
      h.states.set(h.binding.vmId, 'stopped');
      await h.host.stopFrozen(h.rc, second, signal());
      await h.host.participant('gateway').thaw(second, signal());
      await h.peer.participant('entry').thaw(second, signal());
      const ready = await h.host.wake(h.rc, h.binding, signal());
      const current = await h.host.issue(h.rc, ready, signal());
      await h.host.participant('gateway').freeze(current, signal());
      await h.peer.participant('entry').freeze(current, signal());
      await h.host.participant('gateway').thaw(current, signal());
      armed = true;
      const resumed = own(h.host.waitUntilReady(h.rc, pending, signal()));
      try {
        expect(
          await Promise.race([
            snapshot.promise,
            resumed.then(() => 'premature'),
          ]),
        ).toBeUndefined();
        await h.peer.participant('entry').thaw(current, signal());
        release.resolve();
        expect(await resumed).toEqual(ready);
        expect(h.log.filter((value) => value === 'native:start')).toHaveLength(
          1,
        );
      } finally {
        release.resolve();
      }
      await h.host.finish(pending);
      expect(
        (await h.host.participant('gateway').observe(ready, signal())).state,
      ).toBe('known');
    });
  },
);
