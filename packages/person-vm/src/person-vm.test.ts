import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  PersonVmError,
  PERSON_VM_COLD_MS,
  PERSON_VM_IDLE_MS,
} from './contract.ts';
import { PersonVmService } from './person-vm.ts';
import { MicrosandboxPersonVm } from './microsandbox.ts';
import { runCommand } from './process.ts';
import type {
  PersonVmBootstrapScope,
  PersonVmStartingScope,
} from './guest-bootstrap.ts';
import {
  context,
  harness,
  idleFor,
  MemoryStore,
  running,
  signal,
} from './test-support.ts';

describe('host lifecycle service entrypoints (synthetic runtime; not real VM acceptance)', () => {
  it.each([
    'fresh disk and attach',
    'previous disk',
    'idempotent create',
    'borrowed attachment',
    'image changes before probe',
    'image changes during probe',
    'existing home',
    'unjoined probe',
  ] as const)(
    'limits the first HOME receipt to an exact fresh start: %s',
    async (state) => {
      const h = harness();
      const rc = context();
      const employee = {
        workspaceId: rc.workspaceId ?? randomUUID(),
        employeeInstanceId: randomUUID(),
        employeeRevision: 1,
        employeeVersionId: randomUUID(),
      };
      const roster = {
        personId: rc.actor.id,
        organizationId: rc.organizationId,
        entries: [employee],
      };
      const selectedEmployee = {
        personId: roster.personId,
        organizationId: roster.organizationId,
        ...employee,
      };
      const port = { hostPort: 32171, guestPort: 32171 };
      const { create, attach, inspectMount } = h.disk;
      vi.spyOn(h.disk, 'create').mockImplementation(async (ref, scoped) => {
        await create(ref, scoped);
        if (state !== 'idempotent create')
          return { device: 'synthetic', inode: ref.vmId };
      });
      if (state === 'borrowed attachment')
        vi.spyOn(h.disk, 'attach').mockImplementation((disk, scoped) =>
          attach(disk, scoped),
        );
      let probed = false;
      if (
        state === 'image changes before probe' ||
        state === 'image changes during probe'
      )
        vi.spyOn(h.disk, 'inspectMount').mockImplementation(
          (disk, active, expected) => {
            if (state === 'image changes before probe' || probed)
              return Promise.resolve({ state: 'unknown' });
            return inspectMount!(disk, active, expected);
          },
        );
      const observeHomes = vi.fn(
        async (scope: PersonVmStartingScope, mount: string) => {
          await scope.assertCurrent();
          const during = await h.store.read(rc.actor.id);
          expect(during?.instanceId).toBe(scope.binding.instanceId);
          expect(during?.leaseOwner).toBeTruthy();
          expect(during?.phase).toBe('starting');
          expect(mount).toBe('/synthetic/' + scope.binding.vmId);
          probed = true;
          if (state === 'unjoined probe')
            throw new PersonVmError('CLEANUP_INCOMPLETE');
          return state !== 'existing home';
        },
      );
      h.native.prepareWebEndpoints = vi.fn<
        NonNullable<typeof h.native.prepareWebEndpoints>
      >(async (binding, roster) => ({
        binding,
        rosterDigest: roster.digest,
        slots: [port],
        endpoints: roster.entries.map((entry) => ({ ...entry, ...port })),
      }));
      h.native.assertWebEndpoints = vi.fn(async () => {});
      h.runtime.retireAfterNativeStop = vi.fn(async () => {});
      const stage = vi.spyOn(h.runtime, 'memoryGuestPlan');
      const service = new PersonVmService({
        ...h.options,
        nativeWeb: {
          async prepare() {
            return {
              ...roster,
              digest: `sha256:${createHash('sha256').update(JSON.stringify(roster)).digest('hex')}`,
            };
          },
        },
        readUnusedEmployeeHomes: observeHomes,
      });
      const previous =
        state === 'previous disk' ? await service.create(rc, signal()) : null;
      const starting = service.prewarm(
        rc,
        {
          trigger: 'page',
          selectedEmployee,
          target: {
            vmId: previous?.vmId ?? null,
            instanceId: null,
            leaseEpoch: 1,
            assertAuthority: async () => {},
          },
        },
        signal(),
      );
      if (state === 'unjoined probe') {
        await expect(starting).rejects.toMatchObject({
          code: 'CLEANUP_INCOMPLETE',
        });
        expect(observeHomes).toHaveBeenCalledOnce();
        expect(stage).not.toHaveBeenCalled();
        expect(h.log).toContain('native:stop');
        return;
      }
      await expect(starting).resolves.toMatchObject({ ready: true });
      const startup = stage.mock.calls[0]?.[2];
      expect(startup?.selectedEmployee).toEqual(selectedEmployee);
      expect(startup?.unusedEmployeeHomes).toBe(
        state === 'fresh disk and attach' ? true : undefined,
      );
      expect(observeHomes).toHaveBeenCalledTimes(
        [
          'fresh disk and attach',
          'existing home',
          'image changes during probe',
        ].includes(state)
          ? 1
          : 0,
      );
    },
  );
  it('rejects a changed prewarm epoch under the lease before any disk or native side effect', async () => {
    const store = new MemoryStore(),
      h = harness(store),
      rc = context();
    await h.service.create(rc, signal());
    const previous = store.rows.get(rc.actor.id)!;
    const target = {
      vmId: previous.vmId,
      instanceId: null,
      leaseEpoch: previous.leaseEpoch + 1,
      assertAuthority: async () => {},
    };
    const withLease = store.withLease.bind(store);
    vi.spyOn(store, 'withLease').mockImplementationOnce((...args) => {
      store.rows.set(rc.actor.id, {
        ...previous,
        leaseEpoch: target.leaseEpoch,
      });
      return withLease(...args);
    });
    h.log.length = 0;
    await expect(
      h.service.prewarm(rc, { trigger: 'page', target }, signal()),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(h.log).toEqual([]);
    expect(store.rows.get(rc.actor.id)?.leaseEpoch).toBe(target.leaseEpoch);
    expect(store.rows.get(rc.actor.id)?.leaseOwner).toBeNull();
  });
  it.each(['create', 'start'])(
    'checks the accepted authority while owning the %s lease',
    async (phase) => {
      const store = new MemoryStore(),
        h = harness(store),
        rc = context();
      if (phase === 'start') await h.service.create(rc, signal());
      h.log.length = 0;
      let acquisitions = 0;
      const withLease = store.withLease.bind(store);
      vi.spyOn(store, 'withLease').mockImplementation((...args) => {
        acquisitions++;
        return withLease(...args);
      });
      const denied = new PersonVmError('AUTHORIZATION_DENIED');
      const target = {
        vmId: store.rows.get(rc.actor.id)?.vmId ?? null,
        instanceId: null,
        leaseEpoch: 1,
        async assertAuthority() {
          if (acquisitions === (phase === 'create' ? 1 : 2)) throw denied;
        },
      };
      await expect(
        h.service.prewarm(rc, { trigger: 'page', target }, signal()),
      ).rejects.toBe(denied);
      expect(h.log).toEqual([]);
      expect(store.rows.get(rc.actor.id)?.phase ?? 'missing').toBe(
        phase === 'start' ? 'stopped' : 'missing',
      );
      await expect(
        store.withLease(
          rc.actor.id,
          { now: () => new Date(), ttlMs: 1000 },
          async () => 'released',
        ),
      ).resolves.toBe('released');
    },
  );
  it('rechecks admitted authority after inspecting a cold disk without a pool', async () => {
    const h = harness();
    const rc = context();
    let current = true;
    const inspect = h.disk.inspect.bind(h.disk);
    vi.spyOn(h.disk, 'inspect').mockImplementationOnce(async (...args) => {
      const inspection = await inspect(...args);
      current = false;
      return inspection;
    });
    const revoked = Object.assign(Error('ticket grant changed'), {
      code: 'authorization_denied',
    });
    await expect(
      h.service.prewarm(
        rc,
        {
          trigger: 'page',
          target: {
            vmId: null,
            instanceId: null,
            leaseEpoch: 1,
            async assertAuthority() {
              if (!current) throw revoked;
            },
          },
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED', cause: revoked });
    expect(h.log).toEqual([]);
    expect(h.disks.size).toBe(0);
  });
  it.each(['native create', 'readiness'] as const)(
    'rechecks the admitted revision after %s before proceeding and joins startup cleanup',
    async (boundary) => {
      const h = harness(),
        rc = context();
      let valid = true;
      const create = h.native.create.bind(h.native);
      const readiness = h.runtime.readiness.bind(h.runtime);
      if (boundary === 'native create')
        vi.spyOn(h.native, 'create').mockImplementationOnce(async (...args) => {
          await create(...args);
          valid = false;
        });
      else
        vi.spyOn(h.runtime, 'readiness').mockImplementationOnce(
          async (...args) => {
            const result = await readiness(...args);
            valid = false;
            return result;
          },
        );

      const target = {
        vmId: null,
        instanceId: null,
        leaseEpoch: 1,
        async assertAuthority() {
          if (!valid) throw new PersonVmError('AUTHORIZATION_DENIED');
        },
      };
      await expect(
        h.service.prewarm(rc, { trigger: 'page', target }, signal()),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      const saved = (await h.store.read(rc.actor.id))!;
      expect(saved).toMatchObject({
        phase: 'stopped',
        diskRetained: true,
        egressReceipt: null,
        leaseOwner: null,
      });
      expect(h.log.includes('native:bootstrap')).toBe(boundary === 'readiness');
      expect(h.log.includes('runtime:start')).toBe(boundary === 'readiness');
      expect(h.states.get(saved.vmId)).toBe('stopped');
      expect(h.mounts.size).toBe(0);
      expect(h.active.size).toBe(0);
    },
  );
  it('cleans up a running row if the admitted grant changes while saving it under the lease', async () => {
    const store = new MemoryStore(),
      h = harness(store),
      rc = context();
    let valid = true,
      sawOwnedPublication = false;
    const withLease = store.withLease.bind(store);
    vi.spyOn(store, 'withLease').mockImplementation((id, options, work) =>
      withLease(id, options, (lease) =>
        work({
          ...lease,
          async save(row) {
            await lease.save(row);
            if (row.phase === 'running') {
              sawOwnedPublication = !!(await store.read(id))?.leaseOwner;
              valid = false;
            }
          },
        }),
      ),
    );
    await expect(
      h.service.prewarm(
        rc,
        {
          trigger: 'page',
          target: {
            vmId: null,
            instanceId: null,
            leaseEpoch: 1,
            async assertAuthority() {
              if (!valid) throw new PersonVmError('AUTHORIZATION_DENIED');
            },
          },
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(sawOwnedPublication).toBe(true);
    const saved = (await store.read(rc.actor.id))!;
    expect(saved).toMatchObject({
      phase: 'stopped',
      leaseOwner: null,
      egressReceipt: null,
    });
    expect(h.states.get(saved.vmId)).toBe('stopped');
    expect(h.mounts.size).toBe(0);
    expect(h.active.size).toBe(0);
  });
  it('checks the admitted authority before taking responsibility for an interrupted generation', async () => {
    const store = new MemoryStore(),
      h = harness(store);
    const { rc, binding } = await running(h);
    const previous = store.rows.get(rc.actor.id)!;
    store.rows.set(rc.actor.id, { ...previous, phase: 'failed' });
    h.states.set(binding.vmId, 'stopped');
    const before = h.log.slice();
    let checks = 0;
    await expect(
      h.service.prewarm(
        rc,
        {
          trigger: 'page',
          target: {
            vmId: binding.vmId,
            instanceId: null,
            leaseEpoch: binding.leaseEpoch + 1,
            async assertAuthority() {
              // Create and initial start checks finish before the revision changes.
              if (++checks > 2) throw new PersonVmError('AUTHORIZATION_DENIED');
            },
          },
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(h.log).toEqual(before);
    expect(await store.read(rc.actor.id)).toMatchObject({
      phase: 'failed',
      leaseOwner: null,
      egressReceipt: previous.egressReceipt,
    });
    expect(h.active.size).toBe(1);
  });
  it('never restores a retained disk when a prewarm planned before deletion reaches the lease', async () => {
    const h = harness(),
      rc = context();
    const created = await h.service.create(rc, signal());
    const lease = h.store.withLease.bind(h.store);
    const original = (await h.store.read(rc.actor.id))!;
    vi.spyOn(h.store, 'withLease').mockImplementationOnce(async (...args) => {
      await lease(rc.actor.id, args[1], async (deleteLease) => {
        await deleteLease.save({ ...original, phase: 'deleted' });
      });
      return lease(...args);
    });
    const before = h.log.slice();
    await expect(
      h.service.prewarm(
        rc,
        {
          trigger: 'page',
          target: {
            vmId: created.vmId,
            instanceId: null,
            leaseEpoch: 1,
            assertAuthority: async () => {},
          },
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(h.log).toEqual(before);
    expect(await h.store.read(rc.actor.id)).toMatchObject({
      phase: 'deleted',
      diskRetained: true,
      leaseOwner: null,
    });
  });

  async function scheduledFixture() {
    const store = new MemoryStore();
    const h = harness(store);
    const { rc, binding } = await running(h);
    // The other module owns proof of a safe physical stop. Seed its native
    // outcome and let the real service persist and clean up the retained VM.
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
    const interactiveRoster = vi.fn(async () => roster);
    const verified = vi.fn(async () => {});
    h.runtime.assertScheduledReady = verified;
    h.runtime.retireAfterNativeStop = vi.fn(async () => {});
    h.native.prepareWebEndpoints = vi.fn(async (current, expected) => ({
      binding: current,
      rosterDigest: expected.digest,
      endpoints: [{ ...endpoint, hostPort: 24444, guestPort: 24445 }],
    }));
    h.native.assertWebEndpoints = vi.fn(async () => {});
    const idleOwner = vi.fn();
    const service = new PersonVmService({
      ...h.options,
      nativeWeb: { prepare: interactiveRoster },
      observeScheduledStart: idleOwner,
    });
    h.authorize(false);
    return {
      h,
      store,
      binding,
      roster,
      service,
      interactiveRoster,
      verified,
      idleOwner,
    };
  }

  it('resumes only the retained native VM with no user and no interactive readiness grant', async () => {
    const f = await scheduledFixture();
    const requestId = randomUUID();
    const startup = vi.spyOn(f.h.runtime, 'start');
    const browserProof = vi.spyOn(f.h.runtime, 'readiness');
    const roster = vi.fn(async () => {
      expect((await f.store.read(f.binding.personId))?.leaseOwner).toBeTruthy();
      return f.roster;
    });
    const fenced: string[] = [];
    const nativeStart = f.h.native.start;
    const commitRunning = vi.fn(async () => {
      expect(fenced).toHaveLength(2);
      expect((await f.store.read(f.binding.personId))?.phase).toBe('starting');
    });
    const assertCapacityCurrent = vi.fn(async () => {});
    f.h.native.start = async (binding, active) => {
      expect(fenced).toHaveLength(1);
      await nativeStart(binding, active);
      return {
        signal: active,
        assertCurrent: assertCapacityCurrent,
        commitRunning,
      };
    };
    const authority: Parameters<
      PersonVmService['startRetainedForSchedule']
    >[2] = {
      readRoster: roster,
      async withCurrentAuthority(digest, active, start) {
        fenced.push(digest);
        expect(digest).toBe(f.roster.digest);
        expect(
          (await f.store.read(f.binding.personId))?.leaseOwner,
        ).toBeTruthy();
        return start(active);
      },
    };
    const view = await f.service.startRetainedForSchedule(
      f.binding,
      requestId,
      authority,
      signal(),
    );
    expect(view).toMatchObject({ phase: 'running', ready: false });
    expect(f.idleOwner).toHaveBeenCalledExactlyOnceWith(
      {
        ...f.binding,
        instanceId: expect.any(String),
        leaseEpoch: f.binding.leaseEpoch + 1,
      },
      f.roster,
    );
    expect(f.h.log.filter((item) => item === 'native:create')).toHaveLength(1);
    expect(f.h.log.filter((item) => item === 'native:start')).toHaveLength(1);
    expect(startup.mock.lastCall?.[3]).toMatchObject({
      purpose: 'scheduled-wake',
    });
    expect(startup.mock.lastCall?.[3]).not.toHaveProperty('context');
    expect(f.verified).toHaveBeenCalledOnce();
    expect(fenced).toEqual([f.roster.digest, f.roster.digest]);
    expect(assertCapacityCurrent).toHaveBeenCalled();
    expect(commitRunning).toHaveBeenCalledOnce();
    expect(f.interactiveRoster).not.toHaveBeenCalled();
    expect(browserProof).not.toHaveBeenCalled();
    expect(
      f.store.audits
        .filter((audit) => audit.requestId === requestId)
        .map(({ action, result }) => [action, result]),
    ).toEqual([
      ['scheduled-wake.start', 'started'],
      ['scheduled-wake.start', 'succeeded'],
    ]);
    await expect(
      f.service.startRetainedForSchedule(
        f.binding,
        requestId,
        authority,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(f.h.log.filter((item) => item === 'native:start')).toHaveLength(1);
  });

  it('does not launch or issue an unowned native stop when authority is lost before retained resume', async () => {
    const f = await scheduledFixture();
    const before = f.h.log.length;
    await expect(
      f.service.startRetainedForSchedule(
        f.binding,
        randomUUID(),
        {
          readRoster: async () => f.roster,
          withCurrentAuthority: async () => {
            throw new PersonVmError('AUTHORIZATION_DENIED');
          },
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(f.h.log.slice(before)).not.toContain('native:start');
    expect(f.h.log.slice(before)).not.toContain('native:stop');
    expect(f.verified).not.toHaveBeenCalled();
    expect(f.idleOwner).not.toHaveBeenCalled();
    expect(f.h.mounts.size).toBe(0);
  });

  it('retires a dispatched VM if scheduled authority is lost at running publication', async () => {
    const f = await scheduledFixture();
    const requestId = randomUUID();
    const before = f.h.log.length;
    let fenced = 0;
    await expect(
      f.service.startRetainedForSchedule(
        f.binding,
        requestId,
        {
          readRoster: async () => f.roster,
          async withCurrentAuthority(_digest, active, work) {
            if (++fenced === 2) throw new PersonVmError('AUTHORIZATION_DENIED');
            return work(active);
          },
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(
      f.h.log.slice(before).filter((item) => item.startsWith('native:')),
    ).toEqual(expect.arrayContaining(['native:start', 'native:stop']));
    expect(f.h.states.get(f.binding.vmId)).toBe('stopped');
    expect(f.h.mounts.size).toBe(0);
    expect(
      f.store.audits
        .filter((event) => event.requestId === requestId)
        .map((event) => event.result),
    ).toEqual(['started', 'failed']);
  });

  it('isolated command environment needs no NODE_ENV and never inherits the host', async () => {
    vi.stubEnv('ALLRICE_PROCESS_HOST_SENTINEL', 'synthetic-host-only');
    vi.stubEnv('NODE_ENV', 'test');
    try {
      const output = await runCommand({
        executable: process.execPath,
        args: [
          '-e',
          // Darwin CoreFoundation may initialize this key after exec. Every
          // other unexpected key still fails, including the host sentinel.
          'process.stdout.write(JSON.stringify({allowed:process.env.ALLRICE_PROCESS_ALLOWED,onlyAllowed:Object.keys(process.env).every(key=>key==="ALLRICE_PROCESS_ALLOWED"||(process.platform==="darwin"&&key==="__CF_USER_TEXT_ENCODING")),hostSentinelPresent:Object.hasOwn(process.env,"ALLRICE_PROCESS_HOST_SENTINEL"),nodeEnvPresent:Object.hasOwn(process.env,"NODE_ENV")}))',
        ],
        env: { ALLRICE_PROCESS_ALLOWED: 'synthetic' },
        signal: signal(),
      });
      expect(JSON.parse(output)).toEqual({
        allowed: 'synthetic',
        onlyAllowed: true,
        hostSentinelPresent: false,
        nodeEnvPresent: false,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('nativeWeb必须事前具备confirmed-stop退役口；无副作用且旧无Web runtime仍可用', async () => {
    const h = harness(),
      rc = context(),
      prepare = vi.fn();
    h.native.prepareWebEndpoints = vi.fn();
    h.native.assertWebEndpoints = vi.fn();
    const web = new PersonVmService({ ...h.options, nativeWeb: { prepare } });
    await web.create(rc, signal());
    const before = h.log.length;
    await expect(web.start(rc, signal())).rejects.toMatchObject({
      code: 'RUNTIME_NOT_READY',
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(h.log.slice(before)).toEqual([]);
    expect((await h.service.start(rc, signal())).ready).toBe(true);
  });
  it.each([
    'mount conflict',
    'pre-dispatch failure',
    'borrowed mount',
  ] as const)(
    'a retained preflight does not own resources for %s',
    async (mode) => {
      const h = harness();
      const { rc, binding } = await running(h);
      h.states.set(binding.vmId, 'stopped');
      await h.service.stop(rc, signal());
      if (mode === 'borrowed mount')
        await h.disk.attach({ vmId: binding.vmId, tier: 'warm' }, signal());
      const attach = vi.spyOn(h.disk, 'attach');
      const detach = vi.spyOn(h.disk, 'detach');
      const proof = vi.fn(async () => {});
      const observeOwnedMount = vi.fn();
      if (mode === 'mount conflict')
        vi.spyOn(h.disk, 'inspectMount').mockResolvedValue({
          state: 'unknown',
        });
      if (mode === 'pre-dispatch failure')
        attach.mockRejectedValueOnce(new PersonVmError('PROVIDER_FAILED'));
      const vm = new PersonVmService({
        ...h.options,
        observeOwnedMount,
        native: { ...h.native, assertRetainedStartup: proof },
      });
      const preflight = vm.reconcileStoppedEntryForPrewarm(
        rc,
        binding,
        signal(),
        true,
      );
      if (mode === 'borrowed mount') {
        await expect(preflight).resolves.toBe(true);
        expect(proof).toHaveBeenCalledOnce();
        expect(h.mounts.has(binding.vmId)).toBe(true);
      } else {
        await expect(preflight).rejects.toMatchObject({
          code: 'PROVIDER_FAILED',
        });
        expect(proof).not.toHaveBeenCalled();
      }
      await vm.settleRetainedStartupMounts(signal());
      expect(attach).toHaveBeenCalledTimes(
        mode === 'pre-dispatch failure' ? 1 : 0,
      );
      expect(detach).not.toHaveBeenCalled();
      expect(observeOwnedMount).not.toHaveBeenCalled();
      if (mode === 'borrowed mount')
        await h.disk.detach({ vmId: binding.vmId, tier: 'warm' }, signal());
    },
  );
  it.each(['next request', 'Worker shutdown', 'attach receipt lost'] as const)(
    'joins a dispatched retained attachment through %s without a native owner cache',
    async (mode) => {
      const h = harness();
      const { rc, binding } = await running(h);
      h.states.set(binding.vmId, 'stopped');
      await h.service.stop(rc, signal());
      const physicalStatus = vi.fn(async () => {
        throw Error('native homes has not been prepared');
      });
      const observeOwnedMount = vi.fn();
      const proof = vi.fn(async () => {
        h.log.push('native:proof');
      });
      const detach = vi.spyOn(h.disk, 'detach');
      const failure = new PersonVmError('PROVIDER_FAILED');
      if (mode === 'attach receipt lost') {
        const attach = h.disk.attach;
        vi.spyOn(h.disk, 'attach').mockImplementationOnce(async (...args) => {
          await attach(...args);
          throw failure;
        });
      } else detach.mockRejectedValueOnce(failure);
      const vm = new PersonVmService({
        ...h.options,
        observeOwnedMount,
        native: {
          ...h.native,
          status: physicalStatus,
          assertRetainedStartup: proof,
        },
      });
      const preflight = () =>
        vm.reconcileStoppedEntryForPrewarm(rc, binding, signal(), true);
      if (mode === 'attach receipt lost') {
        await expect(preflight()).rejects.toBe(failure);
        await vm.settleRetainedStartupMounts(signal());
        expect(detach).toHaveBeenCalledOnce();
        expect(proof).not.toHaveBeenCalled();
      } else {
        await expect(preflight()).rejects.toMatchObject({
          code: 'CLEANUP_INCOMPLETE',
        });
        expect(h.mounts.has(binding.vmId)).toBe(true);
        const checkpoint = h.log.length;
        if (mode === 'next request') {
          await expect(preflight()).resolves.toBe(true);
          expect(h.log.slice(checkpoint)).toEqual([
            'disk:detach',
            'disk:attach',
            'native:proof',
            'disk:detach',
          ]);
        } else {
          vm.fenceWorkerStartup();
          vi.spyOn(h.disk, 'inspectMount').mockResolvedValueOnce({
            state: 'unknown',
          });
          await expect(
            vm.settleRetainedStartupMounts(signal()),
          ).rejects.toMatchObject({
            code: 'CLEANUP_INCOMPLETE',
          });
          expect(detach).toHaveBeenCalledOnce();
          expect(h.mounts.has(binding.vmId)).toBe(true);
          await vm.settleRetainedStartupMounts(signal());
          expect(h.log.slice(checkpoint)).toEqual(['disk:detach']);
        }
      }
      expect(h.mounts.size).toBe(0);
      expect(physicalStatus).not.toHaveBeenCalled();
      expect(observeOwnedMount).not.toHaveBeenCalled();
      expect(await h.store.read(binding.personId)).toMatchObject({
        vmId: binding.vmId,
        instanceId: binding.instanceId,
        leaseEpoch: binding.leaseEpoch,
        phase: 'stopped',
      });
    },
  );
  it.each([
    ['lifecycle reentry', 'warm', 'stopped', 'later generation'],
    ['shutdown', 'warm', 'stopped', 'later generation'],
    ['lifecycle reentry', 'cold', 'stopped', 'later generation'],
    ['shutdown', 'cold', 'stopped', 'later generation'],
    ['shutdown', 'cold', 'retained delete', 'later generation'],
    ['shutdown', 'cold', 'erased delete', 'later generation'],
    ['lifecycle reentry', 'cold', 'stopped', 'same generation'],
    ['shutdown', 'cold', 'retained delete', 'same generation'],
    ['shutdown', 'cold', 'erased delete', 'same generation'],
  ] as const)(
    'retires only a proved absent detach receipt on %s (%s tier, %s, %s)',
    async (mode, tier, end, generation) => {
      const h = harness();
      const { rc, binding } = await running(h);
      h.states.set(binding.vmId, 'stopped');
      await h.service.stop(rc, signal());
      const physicalDetach = h.disk.detach;
      const detach = vi
        .spyOn(h.disk, 'detach')
        .mockImplementationOnce(async (...args) => {
          await physicalDetach(...args);
          throw new PersonVmError('PROVIDER_FAILED');
        });
      const proof = vi.fn(async () => {});
      const first = new PersonVmService({
        ...h.options,
        native: { ...h.native, assertRetainedStartup: proof },
      });
      const second = new PersonVmService(h.options);
      await expect(
        first.reconcileStoppedEntryForPrewarm(rc, binding, signal(), true),
      ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
      expect(h.mounts.size).toBe(0);
      expect(detach).toHaveBeenCalledOnce();

      const settle = () =>
        mode === 'shutdown'
          ? first.settleRetainedStartupMounts(signal())
          : first.stop(rc, signal());
      let next = binding;
      if (generation === 'later generation') {
        // A's missing detach receipt does not prevent another lifecycle
        // owner obtaining its own, later exact binding.
        await expect(second.start(rc, signal())).resolves.toMatchObject({
          vmId: binding.vmId,
          ready: true,
        });
        next = await second.resolve(rc, signal());
        expect(next.leaseEpoch).toBe(binding.leaseEpoch + 1);
        expect(next.instanceId).not.toBe(binding.instanceId);
        await expect(settle()).rejects.toMatchObject({
          code: 'CLEANUP_INCOMPLETE',
        });
        expect(detach).toHaveBeenCalledOnce();
        expect(h.mounts.has(binding.vmId)).toBe(true);
        await expect(second.resolve(rc, signal())).resolves.toEqual(next);

        h.states.set(binding.vmId, 'stopped');
        await second.stop(rc, signal());
        expect(detach).toHaveBeenCalledTimes(2);
      }
      if (tier === 'cold') {
        h.advance(PERSON_VM_COLD_MS + 1);
        await expect(second.reconcileIdle(rc, signal())).resolves.toMatchObject(
          {
            phase: 'cold',
          },
        );
      }
      if (end !== 'stopped') {
        h.authorizeDiskDelete(true);
        await second.delete(
          rc,
          { deleteDisk: end === 'erased delete' },
          signal(),
        );
      }
      const final = (await h.store.read(binding.personId))!;
      const detached = detach.mock.calls.length;
      const disk = { vmId: binding.vmId, tier };
      expect(final).toMatchObject({
        instanceId: next.instanceId,
        leaseEpoch: next.leaseEpoch,
      });
      if (end === 'erased delete') {
        expect(final).toMatchObject({ phase: 'deleted', diskRetained: false });
        expect(h.disks.has(binding.vmId)).toBe(false);
        const inspect = vi.spyOn(h.disk, 'inspectMount');
        await expect(settle()).rejects.toMatchObject({
          code: 'CLEANUP_INCOMPLETE',
        });
        expect(inspect).not.toHaveBeenCalled();
        expect(detach).toHaveBeenCalledTimes(detached);
        expect(await h.store.read(binding.personId)).toEqual(final);
        return;
      }
      await h.disk.attach(disk, signal());
      await expect(settle()).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
      expect(h.mounts.has(binding.vmId)).toBe(true);
      expect(detach).toHaveBeenCalledTimes(detached);
      await physicalDetach(disk, signal());

      const inspect = vi.spyOn(h.disk, 'inspectMount');
      inspect.mockResolvedValueOnce({ state: 'unknown' });
      if (generation === 'same generation')
        inspect.mockResolvedValueOnce({ state: 'unknown' });
      await expect(settle()).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
      expect(detach).toHaveBeenCalledTimes(detached);
      const beforeSettlement = h.log.length;
      await settle();
      expect(h.log.slice(beforeSettlement)).toEqual([]);
      expect(inspect).toHaveBeenCalledTimes(
        generation === 'same generation' ? 4 : 2,
      );
      expect(inspect).toHaveBeenLastCalledWith(
        { vmId: binding.vmId, tier: 'warm' },
        expect.any(AbortSignal),
        expect.objectContaining({ acrossTier: true }),
      );
      expect(detach).toHaveBeenCalledTimes(detached);
      await first.settleRetainedStartupMounts(signal());
      expect(inspect).toHaveBeenCalledTimes(
        generation === 'same generation' ? 4 : 2,
      );
      expect(proof).toHaveBeenCalledOnce();
      expect(h.mounts.size).toBe(0);
      expect(h.disks.has(binding.vmId)).toBe(true);
      expect(final).toMatchObject({
        instanceId: next.instanceId,
        leaseEpoch: next.leaseEpoch,
        phase:
          end === 'retained delete'
            ? 'deleted'
            : tier === 'cold'
              ? 'cold'
              : 'stopped',
        diskTier: tier,
        diskRetained: true,
      });
      expect(await h.store.read(binding.personId)).toEqual(final);
    },
  );
  it.each(['stopped', 'absent', 'unknown'] as const)(
    'failure cleanup native=%s才可退役；未知不调用/不detach',
    async (state) => {
      const h = harness(),
        rc = context(),
        retire = vi.fn(async () => {});
      h.runtime.retireAfterNativeStop = retire;
      h.setReadiness({
        authenticated: true,
        editorReady: false,
        canSend: false,
      });
      h.native.stop = async (binding) => {
        h.log.push('native:stop');
        h.states.set(binding.vmId, state);
      };
      await h.service.create(rc, signal());
      await expect(h.service.start(rc, signal())).rejects.toBeInstanceOf(
        PersonVmError,
      );
      if (state === 'unknown') {
        expect(retire).not.toHaveBeenCalled();
        expect(h.mounts.size).toBe(1);
        expect(h.log).not.toContain('disk:detach');
      } else {
        expect(retire).toHaveBeenCalledTimes(1);
        expect(h.mounts.size).toBe(0);
      }
    },
  );
  it('confirmed-stop退役拒绝不detach，failed仍释放既有lease；显式start重核join后可恢复', async () => {
    const h = harness(),
      rc = context(),
      retire = vi
        .fn()
        .mockRejectedValueOnce(new PersonVmError('CLEANUP_INCOMPLETE'))
        .mockResolvedValue(undefined);
    h.runtime.retireAfterNativeStop = retire;
    h.setReadiness({ authenticated: true, editorReady: false, canSend: false });
    await h.service.create(rc, signal());
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    const failed = (await h.store.read(rc.actor.id))!;
    expect(failed.phase).toBe('failed');
    expect(failed.diskRetained).toBe(true);
    expect(failed.leaseOwner).toBe(null); // Existing store release policy is unchanged.
    expect(h.states.get(failed.vmId)).toBe('stopped');
    expect(h.mounts.has(failed.vmId)).toBe(true);
    expect(h.log).not.toContain('disk:detach');
    expect(retire).toHaveBeenCalledTimes(1);
    h.setReadiness({ authenticated: true, editorReady: true, canSend: true });
    const restored = await h.service.start(rc, signal());
    expect(restored.ready).toBe(true);
    expect(restored.vmId).toBe(failed.vmId);
    expect(restored.diskRetained).toBe(true);
    expect(retire).toHaveBeenCalledTimes(2);
    expect(retire.mock.calls[1]![0]).toEqual(retire.mock.calls[0]![0]);
    expect(h.log.filter((entry) => entry === 'disk:detach')).toHaveLength(1);
    expect((await h.store.read(rc.actor.id))!.leaseOwner).toBe(null);
    const current = await h.service.resolve(rc, signal());
    expect(current.instanceId).not.toBe(failed.instanceId);
    expect(current.leaseEpoch).toBeGreaterThan(failed.leaseEpoch);
    expect(h.log.filter((entry) => entry === 'disk:create')).toHaveLength(1);
    expect(h.log).not.toContain('disk:delete');
  });
  it('admission qualification fails closed without a formally composed shared host', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    await expect(
      h.service.assertAdmissionBinding(rc, binding, signal()),
    ).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
    await expect(h.service.resolve(rc, signal())).resolves.toEqual(binding);
  });
  it('callback fulfil即关scope：最终egress检查阻塞期间late launch零派发，已移交job不误kill', async () => {
    const h = harness(),
      rc = context();
    let scope!: PersonVmBootstrapScope,
      callbackSettled = false,
      blockNext = true;
    let entered!: () => void, release!: () => void;
    const finalCheck = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn(async () => ({ exitCode: 137, timedOut: false }));
    const dispatch = vi.fn(async () => ({
      binding: scope.binding,
      jobId: 'synthetic-runtime-owned-job',
      wait: async () => ({ exitCode: 0, timedOut: false }),
      cancelAndWait: cancel,
    }));
    h.native.bootstrap = async () => ({ launch: dispatch });
    h.runtime.start = async (_binding, _signal, current) => {
      scope = current;
      await scope.launch({
        executable: 'node',
        args: ['synthetic-owned-runtime'],
      });
      callbackSettled = true;
    };
    const assertActive = h.egress.assertActive;
    h.egress.assertActive = async (...args) => {
      await assertActive(...args);
      if (callbackSettled && blockNext) {
        blockNext = false;
        entered();
        await resume;
      }
    };
    const opening = h.service.prewarm(rc, { trigger: 'page' }, signal());
    const completion = opening.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let result: Awaited<typeof completion>;
    try {
      await finalCheck;
      expect(callbackSettled).toBe(true);
      expect(scope.signal.aborted).toBe(true);
      await expect(
        scope.launch({ executable: 'node', args: ['late-dispatch'] }),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(cancel).not.toHaveBeenCalled();
      expect(h.mounts.size).toBe(1);
    } finally {
      release();
      result = await completion;
    }
    expect(result).toMatchObject({ value: { ready: true } });
    expect(cancel).not.toHaveBeenCalled();
  });
  it('starting scope核现权/出口；callback完结后失效，running重复入口不重init', async () => {
    const h = harness(),
      rc = context();
    let scope!: PersonVmBootstrapScope;
    h.runtime.start = async (_binding, _signal, current) => {
      scope = current;
      expect(h.log.indexOf('native:bootstrap')).toBeGreaterThan(
        h.log.indexOf('native:create'),
      );
      await scope.assertCurrent();
      h.authorize(false);
      await expect(scope.assertCurrent()).rejects.toMatchObject({
        code: 'AUTHORIZATION_DENIED',
      });
      h.authorize(true);
      h.active.clear();
      await expect(scope.assertCurrent()).rejects.toMatchObject({
        code: 'EGRESS_UNAVAILABLE',
      });
      // Restore the exact current receipt, not a second binding.
      const row = await h.store.read(rc.actor.id);
      h.active.add(row!.egressReceipt!.bindingId);
    };
    await h.service.prewarm(rc, { trigger: 'page' }, signal());
    expect(Object.keys(scope).sort()).toEqual([
      'assertCurrent',
      'binding',
      'launch',
      'signal',
    ]);
    expect(Object.keys(scope.binding).sort()).toEqual([
      'instanceId',
      'leaseEpoch',
      'organizationId',
      'personId',
      'vmId',
    ]);
    expect(scope.signal.aborted).toBe(true);
    await expect(scope.assertCurrent()).rejects.toMatchObject({
      code: 'LEASE_LOST',
    });
    await expect(
      scope.launch({ executable: 'node', args: [] }),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await h.service.start(rc, signal());
    expect(h.log.filter((item) => item === 'native:bootstrap')).toHaveLength(1);
  });
  it('revocation at the end of plan preparation prevents native bootstrap', async () => {
    const h = harness(),
      rc = context();
    const plan = h.runtime.memoryGuestPlan;
    h.runtime.memoryGuestPlan = async (...args) => {
      const value = await plan(...args);
      h.authorize(false);
      return value;
    };
    await expect(
      h.service.prewarm(rc, { trigger: 'page' }, signal()),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(h.log).not.toContain('native:bootstrap');
    expect(h.log).not.toContain('runtime:start');
    expect(h.mounts.size).toBe(0);
  });

  it.each(['guest plan', 'readiness', 'capacity commit'] as const)(
    'losing retained-start capacity during %s prevents activation',
    async (stage) => {
      const store = new MemoryStore();
      const h = harness(store);
      const { rc, binding } = await running(h);
      h.states.set(binding.vmId, 'stopped');
      await h.service.stop(rc, signal());

      const owner = new AbortController();
      const lost = new PersonVmError('LEASE_LOST');
      const assertCurrent = vi.fn(async () => owner.signal.throwIfAborted());
      const commitRunning = vi.fn(async () => {
        if (stage === 'capacity commit') owner.abort(lost);
        owner.signal.throwIfAborted();
      });
      const startNative = h.native.start;
      h.native.start = async (...args) => {
        await startNative(...args);
        return { signal: owner.signal, assertCurrent, commitRunning };
      };
      const plan = h.runtime.memoryGuestPlan;
      const readiness = h.runtime.readiness;
      const cancel = (active: AbortSignal) => {
        expect(active.aborted).toBe(false);
        owner.abort(lost);
        expect(active.reason).toBe(lost);
      };
      h.runtime.memoryGuestPlan = async (...args) => {
        if (stage === 'guest plan') cancel(args[1]);
        return plan(...args);
      };
      h.runtime.readiness = async (...args) => {
        if (stage === 'readiness') cancel(args[1]);
        return readiness(...args);
      };
      const before = h.log.length;
      const auditStart = store.audits.length;
      await expect(h.service.start(rc, signal())).rejects.toBe(lost);

      expect(assertCurrent).toHaveBeenCalled();
      expect(commitRunning).toHaveBeenCalledTimes(
        stage === 'capacity commit' ? 1 : 0,
      );
      const effects = h.log.slice(before);
      expect(effects).toContain('native:start');
      if (stage === 'guest plan')
        expect(effects).not.toContain('native:bootstrap');
      expect(effects).toContain('native:stop');
      expect(effects).toContain('disk:detach');
      expect(await store.read(binding.personId)).toMatchObject({
        phase: 'stopped',
        diskRetained: true,
      });
      expect(
        store.audits
          .slice(auditStart)
          .filter(({ action }) => action === 'start')
          .map(({ result }) => result),
      ).toEqual(['started', 'failed']);
    },
  );
  it.each(['publish', 'release'] as const)(
    'keeps the post-commit running charge when the reservation expires during %s',
    async (stage) => {
      const owner = new AbortController();
      let charged = false;
      const expire = () => {
        expect(charged).toBe(true);
        owner.abort(new PersonVmError('LEASE_LOST'));
      };
      const store = new (class extends MemoryStore {
        override withLease<T>(...args: Parameters<MemoryStore['withLease']>) {
          const [person, options, work] = args;
          return super.withLease<T>(person, options, async (lease) => {
            const result = await work({
              ...lease,
              save: async (row, details) => {
                const event =
                  details && 'audit' in details ? details.audit : undefined;
                if (
                  charged &&
                  stage === 'publish' &&
                  event?.action === 'start' &&
                  event.result === 'succeeded'
                )
                  expire();
                await lease.save(row, details);
              },
            });
            if (charged && stage === 'release') expire();
            return result;
          });
        }
      })();
      const h = harness(store);
      const { rc, binding } = await running(h);
      h.states.set(binding.vmId, 'stopped');
      await h.service.stop(rc, signal());

      const startNative = h.native.start;
      const commitRunning = vi.fn(async () => {
        owner.signal.throwIfAborted();
        expect(await store.read(binding.personId)).toMatchObject({
          phase: 'starting',
        });
        owner.signal.throwIfAborted();
        charged = true;
      });
      h.native.start = async (...args) => {
        await startNative(...args);
        return {
          signal: owner.signal,
          assertCurrent: async () => owner.signal.throwIfAborted(),
          commitRunning,
        };
      };
      const auditStart = store.audits.length;
      await expect(h.service.start(rc, signal())).resolves.toMatchObject({
        phase: 'running',
        ready: true,
      });
      expect(commitRunning).toHaveBeenCalledOnce();
      expect(owner.signal.aborted).toBe(true);
      expect(charged).toBe(true);
      expect(await store.read(binding.personId)).toMatchObject({
        phase: 'running',
        leaseOwner: null,
      });
      expect(
        store.audits.slice(auditStart).map(({ result }) => result),
      ).toEqual(['started', 'succeeded']);
    },
  );
  it('retains the disk and leaves a failed binding when retained start and cleanup are unconfirmed', async () => {
    const h = harness();
    const { rc, binding } = await running(h);
    h.states.set(binding.vmId, 'stopped');
    await h.service.stop(rc, signal());
    h.native.start = async (current) => {
      h.states.set(current.vmId, 'unknown');
      throw new PersonVmError('PROVIDER_FAILED');
    };
    h.native.stop = async () => {};
    const before = h.log.length;
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    expect(h.log.slice(before)).not.toContain('disk:detach');
    expect(h.mounts.has(binding.vmId)).toBe(true);
    expect(await h.store.read(binding.personId)).toMatchObject({
      phase: 'failed',
      diskRetained: true,
      leaseEpoch: binding.leaseEpoch + 1,
    });
  });
  it.each(['authority', 'egress'] as const)(
    'starting失去%s后launch零派发，callback捕获拒绝也不得ready',
    async (lost) => {
      const h = harness(),
        rc = context();
      const bootstrap = h.native.bootstrap;
      const dispatch = vi.fn(async () => {
        throw new Error('revoked starting scope must not dispatch');
      });
      const readiness = vi.spyOn(h.runtime, 'readiness');
      h.native.bootstrap = async (...args) => ({
        ...(await bootstrap(...args)),
        launch: dispatch,
      });
      h.runtime.start = async (_binding, _signal, scope) => {
        if (lost === 'authority') h.authorize(false);
        else h.active.clear();
        await expect(
          scope.launch({ executable: 'node', args: ['must-not-dispatch'] }),
        ).rejects.toMatchObject({
          code:
            lost === 'authority'
              ? 'AUTHORIZATION_DENIED'
              : 'EGRESS_UNAVAILABLE',
        });
      };
      await expect(
        h.service.prewarm(rc, { trigger: 'page' }, signal()),
      ).rejects.toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
      expect(dispatch).not.toHaveBeenCalled();
      expect(readiness).not.toHaveBeenCalled();
      expect(h.log.slice(-2)).toEqual(['native:stop', 'disk:detach']);
      expect(h.mounts.size).toBe(0);
      expect((await h.store.read(rc.actor.id))!.diskRetained).toBe(true);
    },
  );
  it('callback不await的launch仍abort并join后才允许stop/detach；不把父callback退出作收尾', async () => {
    const h = harness(),
      rc = context();
    let entered!: () => void,
      release!: () => void,
      joined = false;
    const inLaunch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.native.bootstrap = async (scope) => ({
      launch: async () => {
        entered();
        await new Promise<void>((resolve) =>
          scope.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        await completed;
        joined = true;
        throw new PersonVmError('PROVIDER_FAILED');
      },
    });
    h.runtime.start = async (_binding, _signal, scope) => {
      void scope.launch({ executable: 'node', args: [] });
      await inLaunch;
    };
    const start = h.service.prewarm(rc, { trigger: 'page' }, signal());
    const failure = expect(start).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    await inLaunch;
    expect(h.log).not.toContain('native:stop');
    expect(h.mounts.size).toBe(1);
    release();
    await failure;
    expect(joined).toBe(true);
    expect(h.log.slice(-2)).toEqual(['native:stop', 'disk:detach']);
  });
  it('未await的auth读取仍join；callback结束后不再泄露资格，也不能先stop/detach', async () => {
    const h = harness(),
      rc = context();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((done) => {
      enter = done;
    });
    const joined = new Promise<void>((done) => {
      release = done;
    });
    const bootstrap = h.native.bootstrap;
    h.native.bootstrap = async (scope) => ({
      ...(await bootstrap(
        scope,
        await h.runtime.memoryGuestPlan(scope.binding, scope.signal),
      )),
      readNativeWebAuth: async () => {
        enter();
        await joined;
        return { authenticatedUrl: 'must not escape' };
      },
    });
    let reading!: Promise<unknown>;
    h.runtime.start = async (_binding, _signal, scope) => {
      reading = scope.readNativeWebAuth!({
        dshHome: '/work/person',
        nonce: randomUUID(),
        origin: 'http://127.0.0.1:32179/',
        timeoutMs: 3000,
      });
      void reading.catch(() => {});
      await entered;
    };
    const start = h.service.prewarm(rc, { trigger: 'page' }, signal());
    const failed = expect(start).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    await entered;
    expect(h.log).not.toContain('native:stop');
    release();
    await failed;
    await expect(reading).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(h.log.slice(-2)).toEqual(['native:stop', 'disk:detach']);
  });
  it('缺实际bootstrap依赖在egress/attach/create前拒绝', async () => {
    const h = harness(),
      rc = context();
    await h.service.create(rc, signal());
    h.log.length = 0;
    const runtime = { ...h.runtime, memoryGuestPlan: undefined };
    // JS host composition can omit the required provider despite TS's contract.
    await expect(
      new PersonVmService({
        ...h.options,
        runtime: runtime as unknown as typeof h.runtime,
      }).start(rc, signal()),
    ).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
    expect(h.log).toEqual([]);
  });
  it.each(['warm', 'cold'] as const)(
    '已建%s盘的host装配→start入口：长socketRoot在egress/move/attach/create前拒绝',
    async (tier) => {
      const store = new MemoryStore(),
        h = harness(store),
        rc = context();
      await h.service.create(rc, signal());
      if (tier === 'cold') {
        h.advance(PERSON_VM_COLD_MS + 1); // Clock fixture, not seven days waited.
        await h.service.reconcileIdle(rc, signal());
      }
      const before = structuredClone(store.rows.get(rc.actor.id)),
        auditsBefore = structuredClone(store.audits);
      h.log.length = 0;
      const runner = vi.fn(async () => 'microsandbox 0.7.16');
      const startFromHostConfiguration = async () => {
        const native = new MicrosandboxPersonVm({
          binary: '/b',
          libkrunfw: '/fw',
          agentd: '/a',
          image: 'registry/node@sha256:' + 'a'.repeat(64),
          rootDiskGiB: 20,
          socketRoot: '/tmp/ar266-12345678',
          runner,
        });
        return new PersonVmService({ ...h.options, native }).start(
          rc,
          signal(),
        );
      };
      await expect(startFromHostConfiguration()).rejects.toMatchObject({
        code: 'PROVIDER_FAILED',
      });
      expect(h.log).toEqual([]);
      expect(runner).not.toHaveBeenCalled();
      expect(h.mounts.size).toBe(0);
      expect(h.active.size).toBe(0);
      expect(h.states.size).toBe(0);
      expect(store.rows.get(rc.actor.id)).toEqual(before);
      expect(store.audits).toEqual(auditsBefore);
    },
  );
  it('建盘前失败后同vmId重试；部分盘不覆写、不以空盘替换', async () => {
    const h = harness(),
      rc = context();
    const create = h.disk.create;
    let fail = true;
    h.disk.create = async (...args) => {
      if (fail) {
        fail = false;
        throw new PersonVmError('PROVIDER_FAILED');
      }
      return create(...args);
    };
    await expect(h.service.create(rc, signal())).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    const first = (await h.service.read(rc, signal()))!;
    expect(h.disks.size).toBe(0);
    expect(
      (await h.service.prewarm(rc, { trigger: 'page' }, signal())).vmId,
    ).toBe(first.vmId);
    const other = harness(),
      otherRc = context();
    let partialAttempts = 0;
    other.disk.create = async (ref) => {
      partialAttempts += 1;
      other.partialDisks.add(ref.vmId);
      throw new PersonVmError('PROVIDER_FAILED');
    };
    await expect(other.service.create(otherRc, signal())).rejects.toMatchObject(
      { code: 'PROVIDER_FAILED' },
    );
    const partial = (await other.service.read(otherRc, signal()))!;
    await expect(other.service.create(otherRc, signal())).rejects.toMatchObject(
      { code: 'PROVIDER_FAILED' },
    );
    expect((await other.service.read(otherRc, signal()))!.vmId).toBe(
      partial.vmId,
    );
    expect(other.partialDisks.has(partial.vmId)).toBe(true);
    expect(partialAttempts).toBe(1);
    expect(other.log).not.toContain('disk:delete');
  });
  it('采样间短job完全结束也不能把瞬时0累积为连续20min空闲', async () => {
    const h = harness(),
      { rc } = await running(h);
    for (let elapsed = 0; elapsed < PERSON_VM_IDLE_MS; elapsed += 5000) {
      h.advance(2000);
      h.setActivity({ activeJobs: 1 });
      h.advance(1000);
      h.setActivity({ activeJobs: 0 });
      h.advance(2000);
      expect((await h.service.reconcileIdle(rc, signal())).phase).toBe(
        'running',
      );
    }
    expect(h.log).not.toContain('native:stop');
    expect(h.log).not.toContain('egress:revoke');
  });
  it('最终0快照之后原生工作开始，普通stop/delete/takeover仍拒绝', async () => {
    const store = new MemoryStore(),
      h = harness(store),
      { rc } = await running(h);
    const observe = h.runtime.activity;
    h.runtime.activity = async (...args) => {
      const snapshot = await observe(...args);
      h.setActivity({ activeJobs: 1 });
      return snapshot;
    };
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'ACTIVITY_UNKNOWN',
    });
    h.setActivity({ activeJobs: 0 });
    await expect(h.service.delete(rc, {}, signal())).rejects.toMatchObject({
      code: 'ACTIVITY_UNKNOWN',
    });
    h.setActivity({ activeJobs: 0 });
    store.rows.get(rc.actor.id)!.phase = 'failed';
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'ACTIVITY_UNKNOWN',
    });
    expect(h.log).not.toContain('native:stop');
    expect(h.log).not.toContain('egress:revoke');
  });
  it('running page prewarm rechecks readiness without publishing a physical lease', async () => {
    const h = harness();
    const { rc, binding } = await running(h);
    const lease = vi.spyOn(h.store, 'withLease');
    const ready = await h.service.prewarm(rc, { trigger: 'page' }, signal());
    expect(ready.ready).toBe(true);
    expect(lease).not.toHaveBeenCalled();
    await expect(h.service.resolve(rc, signal())).resolves.toEqual(binding);
  });

  it('Worker shutdown checks holds and preserves a running owner when coverage is unknown', async () => {
    const store = new MemoryStore();
    const h = harness(store);
    const { rc, binding } = await running(h);
    const row = store.rows.get(rc.actor.id)!;
    row.holds.push({
      id: randomUUID(),
      operationId: 'approval-1',
      kind: 'approval',
    });
    await expect(
      h.service.assertWorkerShutdownSafe(binding, signal()),
    ).rejects.toMatchObject({ code: 'VM_ACTIVE' });
    row.holds.splice(0);
    await expect(
      h.service.assertWorkerShutdownSafe(binding, signal()),
    ).rejects.toMatchObject({ code: 'ACTIVITY_UNKNOWN' });
    expect(h.log).not.toContain('native:stop');
    expect(h.log).not.toContain('egress:revoke');
    expect(h.log).not.toContain('disk:detach');
    h.states.set(binding.vmId, 'stopped');
    await expect(
      h.service.assertWorkerShutdownSafe(binding, signal()),
    ).resolves.toBeUndefined();
  });

  it('进入员工页和首次输入共用本人的盘/VM，read不会把persisted running冒称ready', async () => {
    const h = harness(),
      rc = context();
    const prepareEgress = vi.spyOn(h.egress, 'prepare');
    const first = await h.service.prewarm(rc, { trigger: 'page' }, signal());
    const second = await h.service.prewarm(rc, { trigger: 'input' }, signal());
    expect(first.ready).toBe(true);
    expect(second.vmId).toBe(first.vmId);
    expect(h.log.filter((item) => item === 'native:create')).toHaveLength(1);
    expect((await h.service.read(rc, signal()))?.ready).toBe(false);
    expect(JSON.stringify(first)).not.toMatch(
      /ownerToken|leaseOwner|mount|key|bindingId/,
    );
    expect(h.log.indexOf('egress:prepare')).toBeLessThan(
      h.log.indexOf('native:create'),
    );
    expect(prepareEgress).toHaveBeenCalledTimes(1);
    expect(prepareEgress.mock.calls[0]?.[1]).toEqual({
      gatewayPorts: [],
      mount: '/synthetic/' + first.vmId,
    });
    expect(h.log.indexOf('disk:attach')).toBeLessThan(
      h.log.indexOf('egress:prepare'),
    );
    expect(h.log.indexOf('native:prepare')).toBeLessThan(
      h.log.indexOf('egress:prepare'),
    );
  });
  it('global person uniqueness拒绝跨企业冲突，不暗建每企业VM', async () => {
    const h = harness(),
      rc = context();
    await h.service.create(rc, signal());
    await expect(
      h.service.create(context(randomUUID(), rc.actor.id), signal()),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_CONFLICT' });
    expect(h.disks.size).toBe(1);
  });
  it('每次入口重查当前权限，伪membership不复活已撤销资格', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    h.authorize(false);
    await expect(
      h.service.assertCurrentBinding(rc, binding, signal()),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
  });
  it('出口/runtime缺失fail closed，不开机', async () => {
    const h = harness(),
      rc = context();
    await h.service.create(rc, signal());
    await expect(
      new PersonVmService({ ...h.options, egress: undefined }).start(
        rc,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'EGRESS_UNAVAILABLE' });
    await expect(
      new PersonVmService({ ...h.options, runtime: undefined }).start(
        rc,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
    expect(h.log).not.toContain('native:create');
    expect(h.mounts.size).toBe(0);
  });
  it('401/未认证/编辑器不可发送不算ready，失败实际stop+detach', async () => {
    const h = harness(),
      rc = context();
    h.setReadiness({
      authenticated: false,
      editorReady: false,
      canSend: false,
    });
    await h.service.create(rc, signal());
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'RUNTIME_NOT_READY',
    });
    expect(h.log).toContain('native:stop');
    expect(h.mounts.size).toBe(0);
    expect(h.active.size).toBe(0);
    h.setReadiness({ authenticated: true, editorReady: true, canSend: true });
    expect((await h.service.start(rc, signal())).ready).toBe(true);
    expect(h.log.filter((item) => item === 'native:create')).toHaveLength(1);
  });
  it('prepare返回他人/旧epoch的receipt不能开机或撤销他人的binding', async () => {
    const h = harness(),
      rc = context();
    h.egress.prepare = async (binding) => ({
      binding: { ...binding, leaseEpoch: 0 },
      bindingId: randomUUID(),
      gatewayPorts: [38990],
    });
    await h.service.create(rc, signal());
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'EGRESS_BINDING_INVALID',
    });
    expect(h.log).not.toContain('native:create');
    expect(h.log).not.toContain('egress:revoke');
  });
  it('已存原生配置只接受每VM固定host端口，资格epoch轮换', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    h.states.set((await h.service.resolve(rc, signal())).vmId, 'stopped');
    await h.service.stop(rc, signal());
    h.setPorts([38991]);
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'EGRESS_BINDING_INVALID',
    });
    expect(h.active.size).toBe(0);
    expect(h.log).not.toContain('native:start');
    h.setPorts([38990]);
    await h.service.start(rc, signal());
    await expect(
      h.service.assertCurrentBinding(rc, binding, signal()),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
  it.each([
    'activeTurns',
    'activeJobs',
    'activeSubtasks',
    'pendingApprovals',
  ] as const)('%s活跃跨过20分钟仍不回收（时间夹具，未实等）', async (kind) => {
    const h = harness(),
      { rc } = await running(h);
    h.setActivity({ [kind]: 1 });
    h.advance(PERSON_VM_IDLE_MS + 1);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    expect(h.log).not.toContain('native:stop');
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'VM_ACTIVE',
    });
  });
  it.each(['unknown', 'stale', 'wrong-epoch', 'disconnected'] as const)(
    '%s活动不是0（时间夹具，未实等）',
    async (kind) => {
      const h = harness(),
        { rc, binding } = await running(h);
      if (kind === 'unknown') h.setActivity({ state: 'unknown' });
      if (kind === 'stale')
        h.setActivity({ observedAt: h.now().toISOString() });
      if (kind === 'wrong-epoch')
        h.setActivity({ binding: { ...binding, leaseEpoch: 0 } });
      if (kind === 'disconnected')
        h.runtime.activity = async () => {
          throw new PersonVmError('ACTIVITY_UNKNOWN');
        };
      h.advance(PERSON_VM_IDLE_MS + 1);
      expect((await h.service.reconcileIdle(rc, signal())).phase).toBe(
        'running',
      );
      expect(h.log).not.toContain('native:stop');
    },
  );
  it('host hold与原生事实并用，释放不把累计旧空闲立刻当可回收', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    const id = await h.service.acquireHold(
      rc,
      binding,
      { kind: 'host-operation', operationId: 'synthetic-op' },
      signal(),
    );
    expect(
      await h.service.acquireHold(
        rc,
        binding,
        { kind: 'host-operation', operationId: 'synthetic-op' },
        signal(),
      ),
    ).toBe(id);
    h.advance(PERSON_VM_IDLE_MS + 1);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    await h.service.releaseHold(rc, binding, id, signal());
    expect((await idleFor(h, rc, PERSON_VM_IDLE_MS - 1)).phase).toBe('running');
    h.advance(2);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    expect(h.log).not.toContain('native:stop');
  });
  it('停满7天才冷；旧活动7天也不能让刚停VM立刻冷（时间夹具，未实等）', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    h.advance(PERSON_VM_COLD_MS + 1);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    expect((await idleFor(h, rc, PERSON_VM_IDLE_MS)).phase).toBe('running');
    // No native idle gate exists. Model an already physically stopped VM here.
    h.states.set(binding.vmId, 'stopped');
    await h.service.stop(rc, signal());
    expect(h.log).not.toContain('disk:cold');
    h.advance(PERSON_VM_COLD_MS - 1);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('stopped');
    h.advance(2);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('cold');
    expect((await h.service.stop(rc, signal())).phase).toBe('cold');
    expect(h.mounts.size).toBe(0);
    expect(h.disks.has(binding.vmId)).toBe(true);
    const restored = await h.service.start(rc, signal());
    expect(restored.ready).toBe(true);
    expect(restored.vmId).toBe(binding.vmId);
    expect(h.log).toContain('disk:warm');
    expect(h.log.filter((item) => item === 'native:create')).toHaveLength(1);
  });
  it('stop先撤资格；revoke失败仍执行stop，停止不明不detach', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    const revoke = h.egress.revoke;
    h.egress.revoke = async () => {
      h.log.push('egress:revoke-failed');
      throw new PersonVmError('EGRESS_UNAVAILABLE');
    };
    h.states.set(binding.vmId, 'stopped');
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    expect(h.log.indexOf('egress:revoke-failed')).toBeLessThan(
      h.log.indexOf('native:stop'),
    );
    expect(h.states.get(binding.vmId)).toBe('stopped');
    expect(h.mounts.has(binding.vmId)).toBe(true);
    expect(h.log).not.toContain('disk:detach');
    h.egress.revoke = revoke;
    await expect(h.service.stop(rc, signal())).resolves.toMatchObject({
      phase: 'stopped',
    });
    expect(h.mounts.has(binding.vmId)).toBe(false);
    const h2 = harness(),
      running2 = await running(h2);
    h2.states.set(running2.binding.vmId, 'stopped');
    h2.native.stop = async () => {
      throw new PersonVmError('PROVIDER_FAILED');
    };
    await expect(h2.service.stop(running2.rc, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    expect(h2.mounts.has(running2.binding.vmId)).toBe(true);
    expect(h2.log).not.toContain('disk:detach');
  });
  it('取消调用不跳过独立清理，create已真实完成但ack失败也可恢复原盘', async () => {
    const h = harness(),
      rc = context();
    await h.service.create(rc, signal());
    const controller = new AbortController();
    h.native.create = async (binding) => {
      h.log.push('native:create');
      h.states.set(binding.vmId, 'running');
      controller.abort();
      throw new PersonVmError('PROVIDER_FAILED');
    };
    await expect(h.service.start(rc, controller.signal)).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    expect(h.mounts.size).toBe(0);
    expect(h.active.size).toBe(0);
    h.native.start = async (binding) => {
      h.log.push('native:start');
      h.states.set(binding.vmId, 'running');
    };
    expect((await h.service.start(rc, signal())).ready).toBe(true);
    expect(h.log).toContain('native:start');
    expect(h.log.filter((item) => item === 'native:create')).toHaveLength(1);
  });
  it('并行开机/关机返回明确lease conflict，不产生第二native实例', async () => {
    const h = harness(),
      rc = context();
    await h.service.create(rc, signal());
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.runtime.start = async () => {
      entered();
      await gate;
    };
    const first = h.service.start(rc, signal());
    await started;
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'LEASE_CONFLICT',
    });
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'LEASE_CONFLICT',
    });
    await expect(h.service.resolve(rc, signal())).rejects.toMatchObject({
      code: 'LEASE_CONFLICT',
    });
    release();
    await first;
    expect(h.log.filter((item) => item === 'native:create')).toHaveLength(1);
  });
  it('删除本人计算实例默认留盘；删盘单独授权并保留拒绝/成功审计', async () => {
    const store = new MemoryStore(),
      h = harness(store),
      { rc, binding } = await running(h);
    h.states.set(binding.vmId, 'stopped');
    expect((await h.service.delete(rc, {}, signal())).diskRetained).toBe(true);
    expect(h.disks.has(binding.vmId)).toBe(true);
    expect((await h.service.create(rc, signal())).vmId).toBe(binding.vmId);
    await expect(
      h.service.delete(rc, { deleteDisk: true }, signal()),
    ).rejects.toMatchObject({ code: 'DISK_DELETE_NOT_AUTHORIZED' });
    expect(
      store.audits.some(
        (event) => event.action === 'delete-disk' && event.result === 'denied',
      ),
    ).toBe(true);
    h.authorizeDiskDelete(true);
    expect(
      (await h.service.delete(rc, { deleteDisk: true }, signal())).diskRetained,
    ).toBe(false);
    expect(h.disks.size).toBe(0);
    expect(
      store.audits.some(
        (event) =>
          event.action === 'delete-disk' && event.result === 'succeeded',
      ),
    ).toBe(true);
    expect((await h.service.create(rc, signal())).vmId).not.toBe(binding.vmId);
  });
  it('真实停止后重复stop不重置停机7天时钟', async () => {
    const h = harness(),
      { rc } = await running(h);
    h.states.set((await h.service.resolve(rc, signal())).vmId, 'stopped');
    await h.service.stop(rc, signal());
    h.advance(PERSON_VM_COLD_MS - 1);
    await h.service.stop(rc, signal());
    h.advance(2);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('cold');
  });
  it('18min活跃、20min首次0及后续轮询均不能证明连续空闲', async () => {
    const h = harness(),
      { rc } = await running(h);
    h.setActivity({ activeTurns: 1 });
    h.advance(18 * 60000);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    h.setActivity({ activeTurns: 0 });
    h.advance(2 * 60000);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    h.advance(PERSON_VM_IDLE_MS);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    expect((await idleFor(h, rc, PERSON_VM_IDLE_MS)).phase).toBe('running');
    expect(h.log).not.toContain('native:stop');
  });
  it('native readiness异常不会被read或stale binding放行', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    vi.spyOn(h.egress, 'assertActive').mockRejectedValue(
      new PersonVmError('EGRESS_UNAVAILABLE'),
    );
    await expect(
      h.service.assertCurrentBinding(rc, binding, signal()),
    ).rejects.toMatchObject({ code: 'EGRESS_UNAVAILABLE' });
  });
  it('活动探针可重入当前binding；瞬时0仍无原子停机保证而拒绝', async () => {
    const h = harness(),
      { rc } = await running(h);
    h.runtime.activity = async (binding) => {
      await h.service.assertCurrentBinding(rc, binding, signal());
      return {
        binding,
        observedAt: h.now().toISOString(),
        state: 'known',
        activeTurns: 0,
        activeJobs: 0,
        activeSubtasks: 0,
        pendingApprovals: 0,
      };
    };
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'ACTIVITY_UNKNOWN',
    });
    expect(h.log).not.toContain('native:stop');
  });
  it('撤销耗尽单步budget后仍使用新信号尝试物理stop', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    h.states.set(binding.vmId, 'stopped');
    h.options.cleanupTimeoutMs = 5;
    h.egress.revoke = async (_receipt, _reason, revokeSignal) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      revokeSignal.throwIfAborted();
    };
    h.native.stop = async (binding, stopSignal) => {
      expect(stopSignal.aborted).toBe(false);
      h.log.push('native:stop');
      h.states.set(binding.vmId, 'stopped');
    };
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    expect(h.log).toContain('native:stop');
  });
  it('启动回调派生的异步资源在原租约settled后重新读取当前epoch', async () => {
    const h = harness(),
      rc = context();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late: ReturnType<typeof h.service.resolve> | undefined;
    h.runtime.start = async () => {
      late ??= gate.then(() => h.service.resolve(rc, signal()));
    };
    await h.service.prewarm(rc, { trigger: 'page' }, signal());
    const first = await h.service.resolve(rc, signal());
    h.states.set((await h.service.resolve(rc, signal())).vmId, 'stopped');
    await h.service.stop(rc, signal());
    await h.service.start(rc, signal());
    release();
    expect((await late)!.leaseEpoch).toBeGreaterThan(first.leaseEpoch);
  });
  it('失败VM的接管仍检查真实活动；活跃/未知不能借重开机误回收', async () => {
    const store = new MemoryStore(),
      h = harness(store),
      { rc } = await running(h);
    store.rows.get(rc.actor.id)!.phase = 'failed';
    h.setActivity({ activeJobs: 1 });
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'VM_ACTIVE',
    });
    h.setActivity({ state: 'unknown', activeJobs: 0 });
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'ACTIVITY_UNKNOWN',
    });
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'ACTIVITY_UNKNOWN',
    });
    expect(h.log).not.toContain('native:stop');
  });
});
