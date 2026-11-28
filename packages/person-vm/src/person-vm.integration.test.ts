import postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertRuntimeFixtureDatabase } from '../../database/src/runtime-fixture-database.ts';
import { PostgresPersonVmStore } from './store.ts';
import {
  PersonVmError,
  PERSON_VM_COLD_MS,
  type PersonVmBinding,
} from './contract.ts';
import { context, harness, running, signal } from './test-support.ts';
import { ApfsPersonVmDisk, FilePersonVmKeyStore } from './encrypted-disk.ts';
import type { CommandRunner } from './process.ts';
import { PersonVmService } from './person-vm.ts';
import { PersonVmDiskPool } from './disk-pool.ts';
import type { PersonVmStartingScope } from './guest-bootstrap.ts';
import type { PersonVmWebRoster } from './web-endpoints.ts';

// Actual adapter and filesystem renames, with a synthetic hdiutil protocol.
// These bytes are NOT encrypted and no VM, mount, or hdiutil process is started.
async function syntheticDisk(beforeCreate?: (image: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ar-vm-pg-')));
  const attachments = new Map<string, string>();
  const payload = 'synthetic-container-' + randomUUID();
  const runner: CommandRunner = async ({ executable, args, input }) => {
    if (executable === '/usr/bin/plutil') return Buffer.from(input!).toString();
    if (args[0] === 'info')
      return JSON.stringify({
        images: [...attachments].map(([image, mount]) => ({
          'image-path': image,
          'system-entities': [{ 'mount-point': mount }],
        })),
      });
    if (args[0] === 'create') {
      await beforeCreate?.(args.at(-1)!);
      await writeFile(args.at(-1)!, payload);
    } else if (args[0] === 'imageinfo') {
      if ((await readFile(args[1]!, 'utf8')) !== payload)
        throw new Error('synthetic corrupt image');
    } else if (args[0] === 'attach')
      attachments.set(args[1]!, args[args.indexOf('-mountpoint') + 1]!);
    else if (args[0] === 'detach') {
      for (const [image, mount] of attachments)
        if (mount === args[1]) attachments.delete(image);
    } else throw new Error('unexpected hdiutil protocol');
    return '';
  };
  const volume = join(root, 'volume');
  const disk = new ApfsPersonVmDisk({
    root: volume,
    keys: new FilePersonVmKeyStore(join(root, 'keys')),
    capacityGiB: 40,
    runner,
  });
  return { root, volume, disk, attachments };
}

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'person VM real PostgreSQL storage through public lifecycle entrypoints (no VM/model)',
  () => {
    const schema = 'person_vm_' + randomUUID().replaceAll('-', '');
    const appName = 'person-vm-test-' + randomUUID();
    const workerClosures: Promise<void>[] = [];
    const workerNames: string[] = [];
    let workerQueries = 0;
    let observeWorkerQuery: ((query: string) => void) | undefined;
    let admin: postgres.Sql, db: postgres.Sql, store: PostgresPersonVmStore;
    function openWorker() {
      let closed!: () => void;
      workerClosures.push(
        new Promise<void>((resolve) => {
          closed = resolve;
        }),
      );
      const name = appName + '-' + workerClosures.length;
      workerNames.push(name);
      return postgres(process.env.ALLRICE_TEST_DATABASE_URL!, {
        max: 1,
        onnotice: () => {},
        onclose: () => closed(),
        debug: (_connection, query) => {
          workerQueries += 1;
          observeWorkerQuery?.(query);
        },
        connection: { search_path: schema, application_name: name },
      });
    }
    beforeAll(async () => {
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      assertRuntimeFixtureDatabase(url);
      admin = postgres(url.toString(), { max: 2, onnotice: () => {} });
      await admin.unsafe(`create schema "${schema}"`);
      db = postgres(url.toString(), {
        max: 1,
        onnotice: () => {},
        // Fixture inspection/teardown must not borrow a lifecycle-owned client.
        connection: { search_path: schema },
      });
      for (const migration of [
        '0002_identity.sql',
        '0247_person_virtual_machines.sql',
        '0259_person_vm_verified_web_slot_capacity.sql',
      ]) {
        await db.unsafe(
          await readFile(
            new URL(`../../database/migrations/${migration}`, import.meta.url),
            'utf8',
          ),
        );
      }
      store = new PostgresPersonVmStore(openWorker);
    });
    afterEach(async () => {
      await db?.unsafe('truncate person_vm_audit, person_virtual_machines');
    });
    afterAll(async () => {
      await db?.end({ timeout: 2 });
      if (admin) {
        await admin.unsafe(`drop schema if exists "${schema}" cascade`);
        await admin.end({ timeout: 2 });
      }
    });
    it('does not publish stopped when the matching successful stop audit is rejected', async () => {
      const h = harness(store);
      const { rc, binding } = await running(h);
      h.states.set(binding.vmId, 'stopped');
      const attempt = { ...rc, requestId: randomUUID() };
      await db`alter table person_vm_audit
        add constraint fixture_reject_stop_success
        check (action <> 'stop' or result <> 'succeeded')`;
      try {
        await expect(h.service.stop(attempt, signal())).rejects.toMatchObject({
          code: '23514',
        });
        expect(await store.read(binding.personId)).toMatchObject({
          phase: 'running',
          instanceId: binding.instanceId,
          leaseEpoch: binding.leaseEpoch,
        });
        const rows = await db`select result from person_vm_audit
          where request_id=${attempt.requestId} and action='stop' order by id`;
        expect(rows).toEqual([{ result: 'started' }, { result: 'failed' }]);
      } finally {
        await db`alter table person_vm_audit drop constraint fixture_reject_stop_success`;
      }
      await expect(h.service.stop(attempt, signal())).resolves.toMatchObject({
        phase: 'stopped',
        diskRetained: true,
      });
      const [confirmed] = await db`select count(*)::int as count
        from person_virtual_machines vm join person_vm_audit a
          using (person_id, organization_id, vm_id, lease_epoch)
        where vm.phase='stopped' and vm.person_id=${binding.personId}
          and a.request_id=${attempt.requestId}
          and a.action='stop' and a.result='succeeded'`;
      expect(confirmed!.count).toBe(1);
    });

    it('serializes cross-person peak capacity and frees it only after a joined stop', async () => {
      const store = new PostgresPersonVmStore(openWorker, undefined, 1);
      const h = harness(store);
      const vm = new PersonVmService({
        ...h.options,
        nativeCapacityAccounting: true,
      });
      const people = [context(), context()];
      for (const rc of people) await vm.create(rc, signal());
      const attempts = await Promise.allSettled(
        people.map((rc) => vm.start(rc, signal())),
      );
      const winner = attempts.findIndex(
        (attempt) => attempt.status === 'fulfilled',
      );
      expect(winner).toBeGreaterThanOrEqual(0);
      expect(attempts[1 - winner]).toMatchObject({
        status: 'rejected',
        reason: { code: 'RUNTIME_NOT_READY' },
      });
      const active = people[winner]!;
      const queued = people[1 - winner]!;
      const binding = await vm.resolve(active, signal());
      expect(h.log.filter((entry) => entry === 'native:create')).toHaveLength(
        1,
      );
      h.states.set(binding.vmId, 'unknown');
      await expect(vm.stop(active, signal())).rejects.toMatchObject({
        code: 'ACTIVITY_UNKNOWN',
      });
      await expect(vm.start(queued, signal())).rejects.toMatchObject({
        code: 'RUNTIME_NOT_READY',
      });

      h.states.set(binding.vmId, 'stopped');
      await expect(vm.stop(active, signal())).resolves.toMatchObject({
        phase: 'stopped',
      });
      const release = await db`select request_id from person_vm_audit
        where vm_id=${binding.vmId} and lease_epoch=${binding.leaseEpoch}
          and action='capacity.release' and result='succeeded'`;
      expect(release.map((row) => row.request_id)).toEqual([active.requestId]);
      await expect(vm.start(queued, signal())).resolves.toMatchObject({
        ready: true,
      });
    });
    it('uses the exact completed stop for retained rows created before capacity was enabled', async () => {
      const old = harness(store);
      const people = [context(), context()];
      for (const rc of people) {
        await old.service.create(rc, signal());
        await old.service.start(rc, signal());
        const binding = await old.service.resolve(rc, signal());
        old.states.set(binding.vmId, 'stopped');
        await old.service.stop(rc, signal());
      }
      const capacity = new PersonVmService({
        ...old.options,
        store: new PostgresPersonVmStore(openWorker, undefined, 1),
        nativeCapacityAccounting: true,
      });
      await expect(capacity.start(people[0]!, signal())).resolves.toMatchObject(
        {
          ready: true,
        },
      );
      await expect(capacity.start(people[1]!, signal())).rejects.toMatchObject({
        code: 'RUNTIME_NOT_READY',
      });
    });

    it('returns a scheduled startup reservation denied before native dispatch', async () => {
      const store = new PostgresPersonVmStore(openWorker, undefined, 1);
      const h = harness(store);
      const { rc, binding } = await running(h);
      h.states.set(binding.vmId, 'stopped');
      await h.service.stop(rc, signal());
      const endpoint = {
        workspaceId: randomUUID(),
        employeeInstanceId: randomUUID(),
        employeeRevision: 1,
        employeeVersionId: randomUUID(),
      };
      const facts = {
        personId: binding.personId,
        organizationId: binding.organizationId,
        entries: [endpoint],
      };
      const roster = {
        ...facts,
        digest: `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`,
      };
      h.runtime.assertScheduledReady = async () => {};
      h.runtime.retireAfterNativeStop = async () => {};
      h.native.prepareWebEndpoints = async (current, expected) => ({
        binding: current,
        rosterDigest: expected.digest,
        endpoints: [{ ...endpoint, hostPort: 24444, guestPort: 24445 }],
      });
      h.native.assertWebEndpoints = async () => {};
      const scheduled = new PersonVmService({
        ...h.options,
        nativeWeb: { prepare: async () => roster },
        nativeCapacityAccounting: true,
      });
      const before = h.log.length;
      await expect(
        scheduled.startRetainedForSchedule(
          binding,
          randomUUID(),
          {
            readRoster: async () => roster,
            withCurrentAuthority: async () => {
              throw new PersonVmError('AUTHORIZATION_DENIED');
            },
          },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      expect(h.log.slice(before)).not.toContain('native:start');
      expect(h.log.slice(before)).not.toContain('native:stop');
      const released =
        await db`select lease_epoch from person_vm_audit where vm_id=${binding.vmId}
        and action='capacity.release' and result='succeeded'`;
      expect(released.map((entry) => Number(entry.lease_epoch))).toEqual([
        binding.leaseEpoch + 1,
      ]);
      const other = context();
      await h.service.create(other, signal());
      await expect(h.service.start(other, signal())).resolves.toMatchObject({
        ready: true,
      });
    });

    async function terminateWorker(name = workerNames.at(-1)!) {
      const rows =
        await admin`select pid from pg_stat_activity where application_name=${name}`;
      expect(rows).toHaveLength(1);
      const [killed] =
        await admin`select pg_terminate_backend(${rows[0]!.pid}) as killed`;
      expect(killed!.killed).toBe(true);
    }
    it('publishes the observed owner while the real lease still holds the exact orphan predecessor', async () => {
      const h = harness(store);
      const { rc, binding: predecessor } = await running(h);
      h.states.set(predecessor.vmId, 'stopped');
      await h.service.stop(rc, signal());
      await db`update person_virtual_machines set phase='starting'
        where person_id=${predecessor.personId}`;
      let release!: () => void, entered!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const originalStatus = h.native.status;
      h.native.status = async (binding, active) => {
        if (binding.instanceId === predecessor.instanceId) {
          entered();
          await barrier;
        }
        return originalStatus(binding, active);
      };
      let ownerToken: string | undefined;
      let newInstance: PersonVmBinding | undefined;
      const work = h.service.prewarm(
        rc,
        {
          trigger: 'page',
          target: {
            vmId: predecessor.vmId,
            instanceId: null,
            leaseEpoch: predecessor.leaseEpoch + 1,
            assertAuthority: async () => {},
            orphanedStart: {
              predecessor,
              observeLease(token) {
                ownerToken = token;
              },
              observeInstance(binding) {
                newInstance = binding;
              },
            },
          },
        },
        signal(),
      );
      try {
        await Promise.race([
          paused,
          work.then(() => {
            throw Error('orphan start did not pause under the lease');
          }),
        ]);
        expect(ownerToken).toEqual(expect.any(String));
        expect(newInstance).toBeUndefined();
        await expect(store.read(rc.actor.id)).resolves.toMatchObject({
          ...predecessor,
          phase: 'starting',
          leaseOwner: ownerToken,
        });
        await expect(
          store.withLease(
            rc.actor.id,
            { now: h.now, ttlMs: 5000 },
            async () => {},
          ),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
      } finally {
        release();
        await Promise.allSettled([work]);
      }
      await expect(work).resolves.toMatchObject({
        vmId: predecessor.vmId,
        ready: true,
      });
      expect(newInstance).toMatchObject({
        vmId: predecessor.vmId,
        leaseEpoch: predecessor.leaseEpoch + 1,
      });
      expect(newInstance?.instanceId).not.toBe(predecessor.instanceId);
      await expect(h.service.resolve(rc, signal())).resolves.toEqual(
        newInstance,
      );
    });
    it.each(['joined', 'unlock failed', 'rolled back'] as const)(
      'checks the PG release candidate before COMMIT, before its acknowledgement and through join (%s)',
      async (outcome) => {
        const h = harness(store);
        const { rc, binding } = await running(h);
        h.states.set(binding.vmId, 'stopped');
        await h.service.stop(rc, signal());
        function barrier() {
          let release!: () => void;
          const reached = new Promise<void>((resolve) => {
            release = resolve;
          });
          return { reached, release };
        }
        const returning = barrier();
        const letReturning = barrier();
        const committing = barrier();
        const letCommit = barrier();
        const committed = barrier();
        const letCommitAck = barrier();
        const unlock = barrier();
        const letUnlock = barrier();
        const end = barrier();
        const letEnd = barrier();
        const raw = openWorker();
        const delayed = new Proxy(raw, {
          apply(tag, receiver, args) {
            const first: unknown = args[0]?.[0];
            if (
              typeof first !== 'string' ||
              !first.includes('pg_advisory_unlock(')
            )
              return Reflect.apply(tag, receiver, args);
            unlock.release();
            return letUnlock.reached.then(() =>
              Reflect.apply(tag, receiver, args),
            );
          },
          get(tag, property, receiver) {
            if (property === 'begin')
              return (write: (tx: postgres.TransactionSql) => Promise<void>) =>
                tag
                  .begin(async (tx) => {
                    const delayedUpdate = new Proxy(tx, {
                      apply(query, instance, args) {
                        return Promise.resolve(
                          Reflect.apply(query, instance, args),
                        ).then(async (result) => {
                          returning.release();
                          await letReturning.reached;
                          return result;
                        });
                      },
                    });
                    await write(delayedUpdate);
                    committing.release();
                    await letCommit.reached;
                    if (outcome === 'rolled back')
                      throw Error('fixture release rollback');
                  })
                  .then(async (result) => {
                    committed.release();
                    await letCommitAck.reached;
                    return result;
                  });
            if (property !== 'end') return Reflect.get(tag, property, receiver);
            return async (...args: Parameters<postgres.Sql['end']>) => {
              end.release();
              await letEnd.reached;
              await tag.end(...args);
            };
          },
        });
        const held = new PostgresPersonVmStore(() => delayed);
        const fail = new PersonVmError('CLEANUP_INCOMPLETE');
        const release = {
          token: '',
          evidence: [] as { token: string; version: string; stage: string }[],
        };
        const work = held.withLease(
          binding.personId,
          {
            now: h.now,
            ttlMs: h.options.leaseTtlMs,
            observeRelease(token, version, stage) {
              release.evidence.push({ token, version, stage });
            },
          },
          async (lease) => {
            release.token = lease.ownerToken!;
            await lease.save({ ...lease.row!, phase: 'failed' });
            throw fail;
          },
        );
        const reached = (gate: ReturnType<typeof barrier>) =>
          Promise.race([
            gate.reached,
            work,
            end.reached.then(() => {
              throw Error(
                'session ended without reaching the expected release stage',
              );
            }),
          ]);
        async function stamp() {
          const [row] = await db<{ version: string; owner: string | null }[]>`
            select xmin::text as version, lease_owner as owner
            from person_virtual_machines
            where person_id=${binding.personId} and instance_id=${binding.instanceId}
              and lease_epoch=${binding.leaseEpoch} and phase='failed'`;
          return row!;
        }
        async function oldLockStillHeld() {
          await expect(
            store.withLease(
              binding.personId,
              { now: h.now, ttlMs: 5000 },
              async () => {},
            ),
          ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        }
        try {
          await reached(returning);
          const original = await stamp();
          expect(original.owner).toBe(release.token);
          expect(release.evidence).toEqual([]);

          letReturning.release();
          await reached(committing);
          const [candidate] = release.evidence;
          expect(candidate).toEqual({
            token: release.token,
            version: expect.any(String),
            stage: 'written',
          });
          expect(candidate?.version).not.toBe(original.version);
          expect(await stamp()).toEqual(original);
          await oldLockStillHeld();

          letCommit.release();
          if (outcome !== 'rolled back') {
            await reached(committed);
            expect(await stamp()).toEqual({
              owner: null,
              version: candidate!.version,
            });
            expect(release.evidence).toEqual([candidate]);
            await oldLockStillHeld();

            letCommitAck.release();
            await reached(unlock);
            if (outcome === 'unlock failed') {
              // This exact connection's next unlock now returns false from PG.
              const [unlocked] = await raw`
                select pg_advisory_unlock(hashtextextended(${'person-vm:' + binding.personId},0)) as unlocked`;
              expect(unlocked?.unlocked).toBe(true);
            }
            letUnlock.release();
          }
          await Promise.race([end.reached, work]);
          const finalStage = outcome === 'joined' ? 'joined' : 'unconfirmed';
          expect(release.evidence).toEqual([
            candidate,
            ...(outcome === 'joined'
              ? []
              : [{ ...candidate, stage: finalStage }]),
          ]);
          if (outcome === 'rolled back')
            expect(await stamp()).toEqual(original);
          letEnd.release();
          await expect(work).rejects.toBe(fail);
          expect(release.evidence).toEqual([
            candidate,
            { ...candidate, stage: finalStage },
          ]);
        } finally {
          letReturning.release();
          letCommit.release();
          letCommitAck.release();
          letUnlock.release();
          letEnd.release();
          await Promise.allSettled([work]);
        }
      },
    );

    it('returns the original lease release versions for two failed starts at one predecessor', async () => {
      const h = harness(store);
      const { rc, binding: predecessor } = await running(h);
      h.states.set(predecessor.vmId, 'stopped');
      await h.service.stop(rc, signal());
      await db`update person_virtual_machines set phase='starting'
        where person_id=${predecessor.personId}`;
      h.states.set(predecessor.vmId, 'unknown');
      const nextStore = new PostgresPersonVmStore(openWorker);
      const otherWorker = new PersonVmService({
        ...h.options,
        store: nextStore,
      });
      const releases: { token: string; rowVersion: string }[] = [];
      for (const worker of [h.service, otherWorker]) {
        let claimed: string | undefined;
        const failures: string[] = [];
        await expect(
          worker.prewarm(
            rc,
            {
              trigger: 'page',
              target: {
                vmId: predecessor.vmId,
                instanceId: null,
                leaseEpoch: predecessor.leaseEpoch + 1,
                assertAuthority: async () => {},
                orphanedStart: {
                  predecessor,
                  observeLease(token) {
                    claimed = token;
                  },
                  observeInstance() {
                    throw Error(
                      'unknown native state must not publish a generation',
                    );
                  },
                  observeFailure(token, phase) {
                    expect(token).toBe(claimed);
                    failures.push(phase);
                  },
                  observeRelease(token, rowVersion, stage) {
                    expect(token).toBe(claimed);
                    if (stage === 'joined')
                      releases.push({ token, rowVersion });
                  },
                },
              },
            },
            signal(),
          ),
        ).rejects.toMatchObject({ code: 'ACTIVITY_UNKNOWN' });
        expect(failures).toEqual(['starting']);
        const [current] = await db<{ rowVersion: string }[]>`
          select xmin::text as "rowVersion" from person_virtual_machines
          where person_id=${predecessor.personId}
            and lease_owner is null and lease_expires_at is null`;
        expect(releases.at(-1)).toEqual({
          token: claimed,
          rowVersion: current?.rowVersion,
        });
        expect(current?.rowVersion).toEqual(expect.any(String));
        await expect(store.read(predecessor.personId)).resolves.toMatchObject({
          ...predecessor,
          phase: 'starting',
          leaseOwner: null,
        });
      }
      expect(releases).toHaveLength(2);
      expect(releases[0]!.token).not.toBe(releases[1]!.token);
      expect(releases[0]!.rowVersion).not.toBe(releases[1]!.rowVersion);
    });

    it('reopens a running legacy employee and records the stopped conversion width only after readiness', async () => {
      const h = harness(store);
      const rc = context();
      const employees: PersonVmWebRoster['entries'][number][] = [];
      const addEmployee = () =>
        employees.push({
          workspaceId: randomUUID(),
          employeeInstanceId: randomUUID(),
          employeeRevision: 1,
          employeeVersionId: randomUUID(),
        });
      addEmployee();
      let legacy = true;
      const starts: string[] = [];
      const slots = Array.from({ length: 8 }, (_, index) => ({
        hostPort: 32180 + index,
        guestPort: 32180 + index,
      }));
      h.native.prepareWebEndpoints = async (binding, roster) => ({
        binding,
        rosterDigest: roster.digest,
        endpoints: roster.entries.map((entry, index) => ({
          ...entry,
          ...slots[index]!,
        })),
        ...(legacy ? {} : { slots }),
      });
      h.native.assertWebEndpoints = async (receipt) => {
        expect(await h.native.status(receipt.binding, signal())).toBe(
          'running',
        );
      };
      h.native.startWithWebEndpoints = async (receipt, active) => {
        expect(await h.native.status(receipt.binding, active)).toBe('stopped');
        expect(receipt.slots).toEqual(slots);
        starts.push(
          ...receipt.endpoints.map(
            ({ employeeInstanceId }) => employeeInstanceId,
          ),
        );
        await h.native.start(receipt.binding, active);
      };
      h.runtime.retireAfterNativeStop = async () => {};
      const service = new PersonVmService({
        ...h.options,
        nativeWeb: {
          async prepare() {
            const facts = {
              personId: rc.actor.id,
              organizationId: rc.organizationId,
              entries: [...employees].sort((a, b) =>
                a.employeeInstanceId.localeCompare(b.employeeInstanceId),
              ),
            };
            return {
              ...facts,
              digest: `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`,
            };
          },
        },
      });
      const prewarm = () => service.prewarm(rc, { trigger: 'page' }, signal());
      const person = () => store.read(rc.actor.id);
      const original = await prewarm();
      await expect(prewarm()).resolves.toMatchObject({
        vmId: original.vmId,
        ready: true,
      });
      await expect(person()).resolves.toMatchObject({
        verifiedWebSlotCapacity: null,
      });

      await expect(service.stop(rc, signal())).rejects.toMatchObject({
        code: 'ACTIVITY_UNKNOWN',
      });
      h.states.set(original.vmId, 'stopped');
      await service.stop(rc, signal());
      addEmployee();
      legacy = false;
      h.setReadiness({
        authenticated: true,
        editorReady: false,
        canSend: false,
      });
      await expect(prewarm()).rejects.toMatchObject({
        code: 'RUNTIME_NOT_READY',
      });
      await expect(person()).resolves.toMatchObject({
        phase: 'stopped',
        verifiedWebSlotCapacity: null,
      });
      h.setReadiness({ authenticated: true, editorReady: true, canSend: true });
      await expect(prewarm()).resolves.toMatchObject({
        vmId: original.vmId,
        ready: true,
      });
      expect(starts.slice(-2)).toEqual(
        expect.arrayContaining(
          employees.map(({ employeeInstanceId }) => employeeInstanceId),
        ),
      );
      const proof = { verifiedWebSlotCapacity: 8 };
      await expect(person()).resolves.toMatchObject({
        ...proof,
        phase: 'running',
      });

      h.states.set(original.vmId, 'stopped');
      await service.stop(rc, signal());
      await expect(person()).resolves.toMatchObject({
        ...proof,
        phase: 'stopped',
      });
      h.authorizeDiskDelete(true);
      await service.delete(rc, { deleteDisk: true }, signal());
      await expect(person()).resolves.toMatchObject({
        phase: 'deleted',
        verifiedWebSlotCapacity: null,
      });
    });
    it('bounds a blocked diagnostic insert on its own connection and leaves the VM lease usable', async () => {
      const h = harness(store);
      const rc = context();
      await h.service.create(rc, signal());
      await store.withLease(
        rc.actor.id,
        { now: () => new Date(), ttlMs: 5000 },
        async (lease) => {
          const leaseWorker = workerNames.at(-1);
          await db.begin(async (tx) => {
            await tx`lock table person_vm_audit in access exclusive mode`;
            const cancel = new AbortController();
            const writing = store.auditStartupFailure(
              lease.row!,
              {
                requestId: rc.requestId,
                action: 'start.native-web.authenticate',
                result: 'failed',
                errorCode: '{"httpStatus":401}',
              },
              cancel.signal,
            );
            const rejected = expect(writing).rejects.toBeDefined();
            const diagnosticWorker = workerNames.at(-1);
            const diagnosticClosed = workerClosures.at(-1);
            try {
              expect(diagnosticWorker).not.toBe(leaseWorker);
              await expect
                .poll(async () => {
                  const [activity] =
                    await admin`select wait_event_type from pg_stat_activity
                where application_name=${diagnosticWorker!}`;
                  return activity?.wait_event_type;
                })
                .toBe('Lock');
              await lease.guard();
              expect(lease.signal.aborted).toBe(false);
            } finally {
              cancel.abort();
              await rejected;
              await diagnosticClosed;
            }
          });
          await lease.guard();
        },
      );
      expect(
        await db`select action from person_vm_audit where action like 'start.native-web.%'`,
      ).toEqual([]);
    });

    it.each(['join', 'cancel'] as const)(
      'a first workbench can %s the exact offline preparation across dedicated PG sessions',
      async (scenario) => {
        const h = harness(store);
        const rc = context();
        const old = await h.service.create(rc, signal());
        const root = await realpath(
          await mkdtemp(join(tmpdir(), 'ar-pool-wait-')),
        );
        const diskPool = new PersonVmDiskPool(
          root,
          store.diskPoolLocks(root),
          () => {},
        );
        const foreground = new PersonVmService({ ...h.options, diskPool });
        const offlineWorker = new PostgresPersonVmStore(openWorker);
        let entered!: () => void, release!: () => void, observed!: () => void;
        const markerReady = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const gateSampled = new Promise<void>((resolve) => {
          observed = resolve;
        });
        const preparation = offlineWorker.withLease(
          rc.actor.id,
          {
            now: h.now,
            ttlMs: 90000,
            offlinePreparation: {
              mode: 'prepare',
              organizationId: rc.organizationId,
              signal: signal(),
            },
          },
          async (lease) => {
            await lease.guard();
            entered();
            await hold;
          },
        );
        const cancel = new AbortController();
        let opening: ReturnType<PersonVmService['prewarm']> | undefined;
        try {
          const ownerReady = await Promise.race([
            markerReady.then(() => 'marked'),
            preparation.then(() => 'ended'),
          ]);
          expect(ownerReady).toBe('marked');
          observeWorkerQuery = (query) => {
            if (query.includes('pg_try_advisory_lock_shared')) observed();
          };
          opening = foreground.prewarm(rc, { trigger: 'page' }, cancel.signal);
          // If the request returns early, report that original failure rather than waiting on an unobserved gate.
          const early = await Promise.race([
            gateSampled.then(() => 'gate'),
            opening.then(() => 'opening'),
          ]);
          expect(early).toBe('gate');
          expect((await store.read(rc.actor.id))?.leaseOwner).not.toBeNull();
          if (scenario === 'cancel') {
            cancel.abort('test caller closed');
            await expect(opening).rejects.toBe('test caller closed');
            expect((await store.read(rc.actor.id))?.leaseOwner).not.toBeNull();
            expect(h.log).not.toContain('native:start');
          }
        } finally {
          release();
          try {
            await preparation;
            if (scenario === 'join') await opening;
          } finally {
            observeWorkerQuery = undefined;
            await rm(root, { recursive: true, force: true });
          }
        }
        if (scenario === 'join')
          await expect(opening).resolves.toMatchObject({
            vmId: old.vmId,
            ready: true,
          });
        expect(await db`select vm_id from person_virtual_machines`).toEqual([
          { vm_id: old.vmId },
        ]);
      },
    );
    it('preserves cold and legacy disk ownership across a missing PostgreSQL row', async () => {
      const h = harness(store);
      const { root, volume, disk } = await syntheticDisk();
      try {
        const legacy = new PersonVmService({ ...h.options, disk });
        const guarded = new PersonVmService({
          ...h.options,
          disk,
          diskPool: new PersonVmDiskPool(
            volume,
            store.diskPoolLocks(volume),
            () => {},
          ),
        });
        const olderUser = context();
        const previous = await legacy.create(olderUser, signal());
        const coldUser = context();
        // The legacy disk is accounted for by its exact retained PG row.
        const cold = await guarded.create(coldUser, signal());
        await db`delete from person_virtual_machines where person_id=${coldUser.actor.id}`;
        await expect(guarded.create(coldUser, signal())).rejects.toMatchObject({
          code: 'CLEANUP_INCOMPLETE',
        });
        expect(await store.read(coldUser.actor.id)).toBeNull();
        // The missing PG row has a host receipt, so unrelated users can
        // still allocate while the known cold disk remains fenced to its owner.
        const currentUser = context();
        const current = await guarded.create(currentUser, signal());
        await db`delete from person_virtual_machines where person_id=${olderUser.actor.id}`;
        const denied = context();
        await expect(guarded.create(denied, signal())).rejects.toMatchObject({
          code: 'CLEANUP_INCOMPLETE',
        });
        expect(await store.read(denied.actor.id)).toBeNull();
        await expect(
          guarded.create(currentUser, signal()),
        ).resolves.toMatchObject({
          vmId: current.vmId,
        });
        expect(new Set(await disk.listFormalDiskIds(signal()))).toEqual(
          new Set([previous.vmId, cold.vmId, current.vmId]),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('真实PG物理owner持有至confirmed-stop runtime退役实际join，再释放并允许新代重试', async () => {
      const h = harness(store),
        rc = context();
      let entered!: () => void, release!: () => void;
      const inside = new Promise<void>((done) => {
        entered = done;
      });
      const joined = new Promise<void>((done) => {
        release = done;
      });
      let retired = false;
      h.runtime.retireAfterNativeStop = async (binding, current) => {
        expect(h.states.get(binding.vmId)).toBe('stopped');
        expect(current.aborted).toBe(false);
        entered();
        await joined;
        retired = true;
      };
      await h.service.create(rc, signal());
      h.setReadiness({
        authenticated: true,
        editorReady: false,
        canSend: false,
      });
      const starting = h.service
        .start(rc, signal())
        .catch((error: unknown) => error);
      try {
        await inside;
        const row = (await store.read(rc.actor.id))!;
        expect(row.leaseOwner).not.toBe(null);
        const external = harness(new PostgresPersonVmStore(openWorker));
        await expect(
          external.service.start(rc, signal()),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        expect(retired).toBe(false);
        expect(h.mounts.size).toBe(1);
        release();
        expect(await starting).toBeInstanceOf(PersonVmError);
        expect(retired).toBe(true);
        expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
        h.setReadiness({
          authenticated: true,
          editorReady: true,
          canSend: true,
        });
        expect((await h.service.start(rc, signal())).ready).toBe(true);
        expect((await h.service.resolve(rc, signal())).instanceId).not.toBe(
          row.instanceId,
        );
      } finally {
        release();
        await starting;
      }
    });
    it('starting scope使用实际PG owner guard：断线立即失效，bootstrap实际join前不释放/停机', async () => {
      const h = harness(store),
        rc = context();
      await h.service.create(rc, signal());
      let scope!: PersonVmStartingScope,
        entered!: () => void,
        release!: () => void,
        launched = false;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const joined = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.native.bootstrap = async (current) => {
        scope = current;
        await scope.assertCurrent();
        entered();
        await joined;
        await scope.assertCurrent();
        throw new Error('unreachable after real owner loss');
      };
      h.runtime.start = async () => {
        launched = true;
      };
      const opening = h.service.start(rc, signal());
      const failure = expect(opening).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
      try {
        await inside;
        const closed = workerClosures.at(-1)!;
        await terminateWorker();
        await closed;
        await expect(scope.assertCurrent()).rejects.toBe(scope.signal.reason);
        expect(scope.signal.reason).toMatchObject({
          code: 'CONNECTION_CLOSED',
        });
        expect(scope.signal.aborted).toBe(true);
        expect(h.log).not.toContain('native:stop');
        expect(h.mounts.size).toBe(1);
      } finally {
        release();
        await failure;
      }
      expect(launched).toBe(false);
      expect(h.log).toContain('native:stop');
      expect((await store.read(rc.actor.id))!.leaseOwner).not.toBe(null);
      await expect(scope.assertCurrent()).rejects.toMatchObject({
        code: 'LEASE_LOST',
      });
    });
    it('“进入员工页后可以输入”：入口落库本人唯一盘、精确binding、开停审计；返回不含ownerToken', async () => {
      const h = harness(store),
        rc = context();
      const first = await h.service.prewarm(rc, { trigger: 'page' }, signal());
      expect(
        (await h.service.prewarm(rc, { trigger: 'input' }, signal())).vmId,
      ).toBe(first.vmId);
      expect(first.ready).toBe(true);
      const [row] =
        await db`select * from person_virtual_machines where person_id=${rc.actor.id}`;
      expect(row!.phase).toBe('running');
      expect(row!.lease_owner).toBe(null);
      expect(Number(row!.lease_epoch)).toBe(1);
      const binding = await h.service.resolve(rc, signal());
      expect(row!.egress_receipt.binding).toEqual(binding);
      expect(JSON.stringify(first)).not.toMatch(
        /ownerToken|leaseOwner|bindingId|sparseimage/,
      );
      h.states.set(binding.vmId, 'stopped'); // Already off; ordinary running stop has no native gate yet.
      await h.service.stop(rc, signal());
      h.advance(PERSON_VM_COLD_MS + 1);
      expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('cold');
      expect((await h.service.start(rc, signal())).vmId).toBe(first.vmId);
      expect(h.log.filter((event) => event === 'native:create')).toHaveLength(
        1,
      );
      const audits =
        await db`select action,result from person_vm_audit order by id`;
      expect(audits).toEqual(
        expect.arrayContaining([
          { action: 'start', result: 'succeeded' },
          { action: 'stop', result: 'succeeded' },
          { action: 'cold', result: 'succeeded' },
        ]),
      );
    });
    it('两个worker并发争同一人，数据库lease拒绝第二次开停且不重复native create', async () => {
      // Every operation owns a fresh session, so admission reaches the DB lock.
      const first = harness(store),
        second = harness(new PostgresPersonVmStore(openWorker)),
        rc = context();
      await first.service.create(rc, signal());
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      first.runtime.start = async () => {
        entered();
        await gate;
      };
      const opening = first.service.start(rc, signal());
      try {
        await started;
        await expect(second.service.start(rc, signal())).rejects.toMatchObject({
          code: 'LEASE_CONFLICT',
        });
        await expect(second.service.stop(rc, signal())).rejects.toMatchObject({
          code: 'LEASE_CONFLICT',
        });
      } finally {
        release();
        await opening;
      }
      expect(await db`select vm_id from person_virtual_machines`).toHaveLength(
        1,
      );
      expect(second.log).not.toContain('native:create');
    });
    it('普通非domain异常也释放租约，不把所有unknown Error永久当数据库断线', async () => {
      const h = harness(store),
        rc = context();
      await h.service.create(rc, signal());
      await expect(
        store.withLease(rc.actor.id, { now: h.now, ttlMs: 90000 }, async () => {
          throw new Error('synthetic ordinary provider error');
        }),
      ).rejects.toThrow('synthetic ordinary provider error');
      expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
      expect((await h.service.start(rc, signal())).ready).toBe(true);
    });
    it('普通真实SQL错误释放owner，不因SQL错误一概永久封死租约', async () => {
      const h = harness(store),
        rc = context();
      await h.service.create(rc, signal());
      await expect(
        store.withLease(
          rc.actor.id,
          { now: h.now, ttlMs: 90000 },
          async (lease) => {
            await lease.audit(lease.row!, {
              requestId: 'synthetic-invalid-uuid',
              action: 'synthetic',
              result: 'failed',
            });
          },
        ),
      ).rejects.toMatchObject({ code: '22P02' });
      expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
      expect((await h.service.start(rc, signal())).ready).toBe(true);
    });
    it('两个真实独占连接：A断线不使B失效，B收尾后仍可重新领取', async () => {
      const a = harness(store),
        b = harness(store),
        rcA = context(),
        rcB = context();
      await a.service.create(rcA, signal());
      await b.service.create(rcB, signal());
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      b.runtime.start = async () => {
        entered();
        await gate;
      };
      const opening = b.service.start(rcB, signal());
      try {
        await started;
        await expect(
          store.withLease(
            rcA.actor.id,
            { now: a.now, ttlMs: 90000 },
            async (lease) => {
              await terminateWorker();
              await lease.guard();
            },
          ),
        ).rejects.toBeDefined();
      } finally {
        release();
        await opening;
      }
      expect((await store.read(rcB.actor.id))!.leaseOwner).toBe(null);
      await store.withLease(
        rcB.actor.id,
        { now: b.now, ttlMs: 90000 },
        async (lease) => {
          await lease.guard();
        },
      );
      expect((await b.service.resolve(rcB, signal())).personId).toBe(
        rcB.actor.id,
      );
      expect(b.log.filter((item) => item === 'native:create')).toHaveLength(1);
    });
    it('真实PG恢复活动探针重入同一lease；外部请求无权借恢复frame准入', async () => {
      const h = harness(store),
        { rc, binding } = await running(h);
      await expect(
        store.withLease(
          rc.actor.id,
          { now: h.now, ttlMs: 90000 },
          async (lease) => {
            await terminateWorker();
            await lease.guard();
          },
        ),
      ).rejects.toBeDefined();
      h.advance(90001);
      let probed = false;
      h.runtime.activity = async (current) => {
        await h.service.assertCurrentBinding(rc, current, signal());
        const external = context(rc.organizationId, rc.actor.id);
        await expect(
          h.service.assertCurrentBinding(external, current, signal()),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        probed = true;
        return {
          binding: current,
          observedAt: h.now().toISOString(),
          state: 'known',
          activeTurns: 0,
          activeJobs: 0,
          activeSubtasks: 0,
          pendingApprovals: 0,
        };
      };
      // Reentry succeeds, but no VM-wide freeze exists; zero still cannot stop running work.
      await expect(
        h.service.recoverExpired(rc, signal()),
      ).rejects.toMatchObject({ code: 'ACTIVITY_UNKNOWN' });
      expect(probed).toBe(true);
      expect(h.log).not.toContain('native:stop');
      h.states.set(binding.vmId, 'stopped');
      h.advance(90001); // The in-frame guard renewed the old owner's recovery lease.
      expect((await h.service.recoverExpired(rc, signal())).phase).toBe(
        'stopped',
      );
      expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
    });
    it.each(['query-race', 'closed-before-guard'] as const)(
      '真实pg_terminate_backend (%s) 后同进程settled fence恢复；新进程未知fence不能TTL偷租约',
      async (order) => {
        const h = harness(store),
          { rc, binding } = await running(h);
        await expect(
          store.withLease(
            rc.actor.id,
            { now: h.now, ttlMs: 90000 },
            async (lease) => {
              const closed = workerClosures.at(-1)!;
              await terminateWorker();
              if (order === 'closed-before-guard') await closed;
              let loss: unknown;
              try {
                await lease.guard();
              } catch (error) {
                loss = error;
              }
              expect(loss).toBeDefined();
              const issued = workerQueries;
              await expect(lease.guard()).rejects.toBe(loss);
              await expect(lease.save(lease.row!)).rejects.toBe(loss);
              await expect(
                lease.audit(lease.row!, {
                  requestId: rc.requestId,
                  action: 'synthetic',
                  result: 'failed',
                }),
              ).rejects.toBe(loss);
              expect(workerQueries).toBe(issued);
              throw loss;
            },
          ),
        ).rejects.toBeDefined();
        const orphan = await store.read(rc.actor.id);
        expect(orphan!.leaseOwner).not.toBe(null);
        h.advance(90001);
        const unknown = new PostgresPersonVmStore(openWorker);
        const unknownHost = harness(unknown);
        unknownHost.advance(90001);
        await expect(
          unknownHost.service.recoverExpired(rc, signal()),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        expect(unknownHost.log).not.toContain('egress:revoke');
        h.setActivity({ activeSubtasks: 1 });
        await expect(
          h.service.recoverExpired(rc, signal()),
        ).rejects.toMatchObject({ code: 'VM_ACTIVE' });
        expect(h.states.get(binding.vmId)).toBe('running');
        h.advance(90001); // A failed recovery owns its own renewed lease.
        h.setActivity({ activeSubtasks: 0 });
        await expect(
          h.service.recoverExpired(rc, signal()),
        ).rejects.toMatchObject({ code: 'ACTIVITY_UNKNOWN' });
        h.advance(90001);
        h.states.set(binding.vmId, 'stopped');
        expect((await h.service.recoverExpired(rc, signal())).phase).toBe(
          'stopped',
        );
        expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
        expect(h.states.get(binding.vmId)).toBe('stopped');
        expect(h.mounts.size).toBe(0);
        expect(h.active.size).toBe(0);
        expect((await h.service.start(rc, signal())).ready).toBe(true);
      },
    );
    it('恢复A物理provider未settle时再次断PG，B不能沿用原owner证明清理或开机', async () => {
      const h = harness(store),
        { rc, binding } = await running(h);
      await expect(
        store.withLease(
          rc.actor.id,
          { now: h.now, ttlMs: 90000 },
          async (lease) => {
            await terminateWorker();
            await lease.guard();
          },
        ),
      ).rejects.toBeDefined();
      const previous = (await store.read(rc.actor.id))!.leaseOwner!;
      h.states.set(binding.vmId, 'stopped');
      h.advance(90001);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const revoke = h.egress.revoke;
      let block = true;
      h.egress.revoke = async (...args) => {
        if (block) {
          entered();
          await gate;
        }
        await revoke(...args);
      };
      const recoveringA = h.service.recoverExpired(rc, signal()).then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error }),
      );
      const fenceTokens: string[] = [];
      const storeB = new PostgresPersonVmStore(openWorker, {
        confirmSettled: async (owner) => {
          fenceTokens.push(owner.ownerToken);
          if (owner.ownerToken !== previous)
            throw new PersonVmError('LEASE_CONFLICT');
        },
      });
      const b = new PersonVmService({ ...h.options, store: storeB });
      let ownerA = '';
      try {
        await started;
        const nameA = workerNames.at(-1)!;
        const closedA = workerClosures.at(-1)!;
        ownerA = (await store.read(rc.actor.id))!.leaseOwner!;
        expect(ownerA).not.toBe(previous);
        await terminateWorker(nameA);
        await closedA;
        h.advance(90001); // Expiry alone must not certify still-running recovery A.
        const before = h.log.length;
        await expect(
          h.service.recoverExpired(rc, signal()),
        ).rejects.toMatchObject({ code: 'LEASE_CONFLICT' });
        await expect(b.recoverExpired(rc, signal())).rejects.toMatchObject({
          code: 'LEASE_CONFLICT',
        });
        expect(fenceTokens).toEqual([ownerA]);
        await expect(b.start(rc, signal())).rejects.toMatchObject({
          code: 'LEASE_CONFLICT',
        });
        expect(
          h.log
            .slice(before)
            .filter((event) =>
              [
                'egress:revoke',
                'native:stop',
                'native:start',
                'native:create',
              ].includes(event),
            ),
        ).toEqual([]);
        expect((await store.read(rc.actor.id))!.leaseOwner).toBe(ownerA);
      } finally {
        block = false;
        release();
        await recoveringA;
      }
      expect((await recoveringA).ok).toBe(false);
      expect((await store.read(rc.actor.id))!.leaseOwner).toBe(ownerA);
      expect((await h.service.recoverExpired(rc, signal())).phase).toBe(
        'stopped',
      );
      expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
      expect((await h.service.start(rc, signal())).ready).toBe(true);
      expect(h.log.filter((event) => event === 'native:create')).toHaveLength(
        1,
      );
    });
    it('native create完成但host save的真实PG连接断开，恢复能认领已有原盘而不是永久false', async () => {
      const h = harness(store),
        rc = context();
      await h.service.create(rc, signal());
      h.native.create = async (binding) => {
        h.log.push('native:create');
        h.states.set(binding.vmId, 'running');
        await terminateWorker();
      };
      await expect(h.service.start(rc, signal())).rejects.toBeInstanceOf(
        PersonVmError,
      );
      const saved = await store.read(rc.actor.id);
      expect(saved!.leaseOwner).not.toBe(null);
      expect(saved!.nativeCreated).toBe(false);
      expect(h.states.get(saved!.vmId)).toBe('stopped');
      expect(h.mounts.size).toBe(0);
      expect(h.active.size).toBe(0);
      expect(h.log.indexOf('egress:revoke')).toBeLessThan(
        h.log.indexOf('native:stop'),
      );
      expect(h.log.indexOf('native:stop')).toBeLessThan(
        h.log.indexOf('disk:detach'),
      );
      h.advance(90001);
      expect((await h.service.recoverExpired(rc, signal())).phase).toBe(
        'stopped',
      );
      expect((await store.read(rc.actor.id))!.nativeCreated).toBe(true);
      expect((await h.service.start(rc, signal())).ready).toBe(true);
      expect(h.log.filter((event) => event === 'native:create')).toHaveLength(
        1,
      );
      expect(h.log).toContain('native:start');
    });
    it.each(['cold', 'warm'] as const)(
      '真实rename到%s后PG连接断开，恢复按完成凭据找回原盘字节',
      async (target) => {
        const fixture = await syntheticDisk();
        const h = harness(store),
          rc = context();
        for (const key of [
          'inspect',
          'create',
          'attach',
          'detach',
          'move',
          'delete',
        ] as const)
          Object.assign(h.disk, {
            [key]: fixture.disk[key].bind(fixture.disk),
          });
        try {
          const { binding } = await running(h, rc);
          const image = (tier: string) =>
            join(fixture.volume, tier, binding.vmId + '.sparseimage');
          const digest = (bytes: Buffer) =>
            createHash('sha256').update(bytes).digest('hex');
          const original = digest(await readFile(image('warm')));
          h.states.set(binding.vmId, 'stopped');
          await h.service.stop(rc, signal());
          h.advance(PERSON_VM_COLD_MS + 1);
          if (target === 'warm') await h.service.reconcileIdle(rc, signal());
          const move = h.disk.move;
          h.disk.move = async (...args) => {
            const actual = await move(...args);
            await terminateWorker();
            return actual;
          };
          await expect(
            target === 'cold'
              ? h.service.reconcileIdle(rc, signal())
              : h.service.start(rc, signal()),
          ).rejects.toBeDefined();
          expect(digest(await readFile(image(target)))).toBe(original);
          const stale = (await store.read(rc.actor.id))!;
          expect(stale.diskTier).toBe(target === 'cold' ? 'warm' : 'cold');
          expect(stale.leaseOwner).not.toBe(null);
          h.disk.move = move;
          h.advance(90001);
          await h.service.recoverExpired(rc, signal());
          expect((await store.read(rc.actor.id))!.diskTier).toBe(target);
          expect((await h.service.start(rc, signal())).ready).toBe(true);
          expect(digest(await readFile(image('warm')))).toBe(original);
          expect(h.log.filter((item) => item === 'native:create')).toHaveLength(
            1,
          );
        } finally {
          await rm(fixture.root, { recursive: true, force: true });
        }
      },
    );
    it.each(['previous warm receipt', 'fresh cold attach'] as const)(
      'settles %s after an actual cold rename and rejected PG tier write',
      async (mode) => {
        const fixture = await syntheticDisk();
        const h = harness(store);
        const rc = context();
        for (const part of [
          'inspect',
          'inspectMount',
          'create',
          'attach',
          'move',
          'delete',
        ] as const)
          Object.assign(h.disk, {
            [part]: fixture.disk[part].bind(fixture.disk),
          });
        let loseReceipt = false;
        const detaches: string[] = [];
        h.disk.detach = async (disk, active) => {
          await fixture.disk.detach(disk, active);
          detaches.push(disk.tier);
          if (loseReceipt) {
            loseReceipt = false;
            throw new PersonVmError('PROVIDER_FAILED');
          }
        };
        try {
          const { binding } = await running(h, rc);
          const image = (tier: string) =>
            join(fixture.volume, tier, binding.vmId + '.sparseimage');
          const original = await readFile(image('warm'));
          h.states.set(binding.vmId, 'stopped');
          await h.service.stop(rc, signal());
          detaches.length = 0;

          const proofs: string[] = [];
          const owner = new PersonVmService({
            ...h.options,
            native: {
              ...h.native,
              async assertRetainedStartup(target, mount) {
                expect(target).toEqual(binding);
                const tracked = [...fixture.attachments.entries()];
                expect(tracked).toHaveLength(1);
                expect(tracked[0]?.[1]).toBe(mount);
                proofs.push(tracked[0]![0]);
              },
            },
          });
          const preflight = () =>
            owner.reconcileStoppedEntryForPrewarm(rc, binding, signal(), true);
          if (mode === 'previous warm receipt') {
            loseReceipt = true;
            await expect(preflight()).rejects.toMatchObject({
              code: 'CLEANUP_INCOMPLETE',
            });
            expect(proofs).toEqual([image('warm')]);
            expect(detaches).toEqual(['warm']);
            expect(fixture.attachments.size).toBe(0);
          }

          h.advance(PERSON_VM_COLD_MS + 1);
          await db`alter table person_virtual_machines
            add constraint fixture_reject_cold_tier check (disk_tier <> 'cold')`;
          try {
            await expect(
              h.service.reconcileIdle(rc, signal()),
            ).rejects.toMatchObject({
              code: '23514',
            });
          } finally {
            await db`alter table person_virtual_machines
              drop constraint fixture_reject_cold_tier`;
          }
          await expect(readFile(image('warm'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(await readFile(image('cold'))).toEqual(original);
          const stale = await store.read(binding.personId);
          expect(stale).toMatchObject({
            ...binding,
            phase: 'stopped',
            diskTier: 'warm',
            leaseOwner: null,
          });
          const cold = { vmId: binding.vmId, tier: 'cold' as const };
          if (mode === 'previous warm receipt') {
            // An attachment on the other layer is a refusal, even when
            // this exact retained image was originally ours.
            await fixture.disk.attach(cold, signal());
            await expect(
              owner.settleRetainedStartupMounts(signal()),
            ).rejects.toMatchObject({
              code: 'CLEANUP_INCOMPLETE',
            });
            expect(fixture.attachments.has(image('cold'))).toBe(true);
            expect(detaches).toEqual(['warm']);
            await fixture.disk.detach(cold, signal());
          } else {
            await expect(preflight()).resolves.toBe(true);
            expect(proofs).toEqual([image('cold')]);
            expect(detaches).toEqual(['cold']);
          }
          await owner.settleRetainedStartupMounts(signal());
          await owner.settleRetainedStartupMounts(signal());
          expect(detaches).toEqual([
            mode === 'previous warm receipt' ? 'warm' : 'cold',
          ]);
          expect(fixture.attachments.size).toBe(0);
          expect(await store.read(binding.personId)).toEqual(stale);
          expect(await readFile(image('cold'))).toEqual(original);
        } finally {
          await rm(fixture.root, { recursive: true, force: true });
        }
      },
    );

    it('只create未start：rename后PG断线，无instance恢复实际cold位置并授权删除完整盘/key', async () => {
      const fixture = await syntheticDisk(),
        h = harness(store),
        rc = context();
      for (const key of [
        'inspect',
        'create',
        'attach',
        'detach',
        'move',
        'delete',
      ] as const)
        Object.assign(h.disk, { [key]: fixture.disk[key].bind(fixture.disk) });
      try {
        const created = await h.service.create(rc, signal());
        const warm = join(
          fixture.volume,
          'warm',
          created.vmId + '.sparseimage',
        );
        const cold = join(
          fixture.volume,
          'cold',
          created.vmId + '.sparseimage',
        );
        const original = await readFile(warm);
        const move = h.disk.move;
        h.disk.move = async (...args) => {
          const result = await move(...args);
          await terminateWorker();
          return result;
        };
        h.advance(PERSON_VM_COLD_MS + 1);
        await expect(
          h.service.reconcileIdle(rc, signal()),
        ).rejects.toBeDefined();
        const stale = (await store.read(rc.actor.id))!;
        expect(stale.instanceId).toBe(null);
        expect(stale.diskTier).toBe('warm');
        expect(await readFile(cold)).toEqual(original);
        h.disk.move = move;
        h.advance(90001);
        expect((await h.service.recoverExpired(rc, signal())).phase).toBe(
          'stopped',
        );
        expect((await store.read(rc.actor.id))!.diskTier).toBe('cold');
        expect(h.log).not.toContain('native:prepare');
        expect(h.log).not.toContain('native:stop');
        await expect(
          h.service.delete(rc, { deleteDisk: true }, signal()),
        ).rejects.toMatchObject({ code: 'DISK_DELETE_NOT_AUTHORIZED' });
        expect(await readFile(cold)).toEqual(original);
        h.authorizeDiskDelete(true);
        expect(
          (await h.service.delete(rc, { deleteDisk: true }, signal()))
            .diskRetained,
        ).toBe(false);
        for (const path of [
          warm,
          cold,
          join(fixture.volume, 'manifests', created.vmId + '.json'),
          join(fixture.root, 'keys', created.vmId + '.key'),
        ])
          await expect(readFile(path)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        const [audit] =
          await db`select result from person_vm_audit where vm_id=${created.vmId} and action='delete-disk' order by id desc limit 1`;
        expect(audit!.result).toBe('succeeded');
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
    it.each(['absent', 'partial'] as const)(
      '首次建盘%s失败且保存failed时PG断线，无instance恢复不伪造stopped',
      async (kind) => {
        let fail = true;
        const fixture = await syntheticDisk(async (image) => {
          if (fail) {
            fail = false;
            if (kind === 'partial') await writeFile(image, 'partial-container');
            await terminateWorker();
            throw new Error('synthetic pre-completion create failure');
          }
        });
        const h = harness(store),
          rc = context();
        for (const key of [
          'inspect',
          'create',
          'attach',
          'detach',
          'move',
          'delete',
        ] as const)
          Object.assign(h.disk, {
            [key]: fixture.disk[key].bind(fixture.disk),
          });
        try {
          await expect(h.service.create(rc, signal())).rejects.toBeDefined();
          const row = (await store.read(rc.actor.id))!;
          expect(row.phase).toBe('starting');
          expect(row.instanceId).toBe(null);
          expect(row.nativeCreated).toBe(false);
          const keyPath = join(fixture.root, 'keys', row.vmId + '.key');
          const originalKey = createHash('sha256')
            .update(await readFile(keyPath))
            .digest('hex');
          h.advance(90001);
          if (kind === 'partial') {
            await expect(
              h.service.recoverExpired(rc, signal()),
            ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
            expect((await store.read(rc.actor.id))!.phase).toBe('starting');
            await expect(
              h.disk.delete({ vmId: row.vmId, tier: 'warm' }, signal()),
            ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
            expect(
              await readFile(
                join(fixture.volume, 'warm', row.vmId + '.sparseimage'),
                'utf8',
              ),
            ).toBe('partial-container');
          } else {
            const recovered = await h.service.recoverExpired(rc, signal());
            expect(recovered.phase).toBe('failed');
            expect(recovered.ready).toBe(false);
            expect((await store.read(rc.actor.id))!.leaseOwner).toBe(null);
            await expect(h.service.start(rc, signal())).rejects.toMatchObject({
              code: 'PROVIDER_FAILED',
            });
            expect((await store.read(rc.actor.id))!.instanceId).toBe(null);
            expect((await h.service.create(rc, signal())).vmId).toBe(row.vmId);
            expect(
              (await h.service.prewarm(rc, { trigger: 'page' }, signal()))
                .ready,
            ).toBe(true);
            expect(
              h.log.filter((event) => event === 'native:create'),
            ).toHaveLength(1);
          }
          expect(
            createHash('sha256')
              .update(await readFile(keyPath))
              .digest('hex'),
          ).toBe(originalKey);
        } finally {
          await rm(fixture.root, { recursive: true, force: true });
        }
      },
    );
    it('个人盘无employee级联关系；删盘拒绝及最终显式删除审计真正落库', async () => {
      const h = harness(store),
        { rc, binding } = await running(h);
      const constraints =
        await db`select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='person_virtual_machines'::regclass`;
      expect(constraints.map((row) => row.definition).join('\n')).not.toMatch(
        /employee|ON DELETE CASCADE/i,
      );
      h.states.set(binding.vmId, 'stopped');
      await h.service.delete(rc, {}, signal());
      expect((await store.read(rc.actor.id))!.diskRetained).toBe(true);
      expect(h.disks.has(binding.vmId)).toBe(true);
      await expect(
        h.service.delete(rc, { deleteDisk: true }, signal()),
      ).rejects.toMatchObject({ code: 'DISK_DELETE_NOT_AUTHORIZED' });
      h.authorizeDiskDelete(true);
      await h.service.delete(rc, { deleteDisk: true }, signal());
      expect((await store.read(rc.actor.id))!.diskRetained).toBe(false);
      const rows =
        await db`select result,error_code from person_vm_audit where action='delete-disk' order by id`;
      expect(rows).toEqual(
        expect.arrayContaining([
          { result: 'denied', error_code: 'DISK_DELETE_NOT_AUTHORIZED' },
          { result: 'succeeded', error_code: null },
        ]),
      );
    });
  },
);
