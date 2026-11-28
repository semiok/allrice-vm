/* global AbortController */

import { describe, expect, it, vi } from 'vitest';

import { measureRestore } from './measure.mjs';
import { createRestoreProbe } from './restore-probe.mjs';

const hash = 'a'.repeat(64);
const seal = {
  enabled: true,
  mode: 'probe',
  platform: 'linux/arm64',
  engine: 'microsandbox',
  templateDirectory: '/templates/' + hash,
  manifestSha256: hash,
};
const manifest = {
  version: 1,
  engine: 'microsandbox',
  engineVersion: '0.7.16',
  restoreProtocol: 1,
  platform: 'linux/arm64',
  host: {
    kernel: 'fixture',
    cpuModel: 'fixture',
    cpuFeaturesSha256: hash,
    kvmApiVersion: 12,
    gic: 'v3',
    pageSize: 4096,
  },
  guest: {
    vcpus: 2,
    memoryMiB: 2048,
    pageSize: 4096,
    kernelSha256: hash,
    workMount: 'strict-external-directory',
    workPath: '/work',
  },
  inputs: Object.fromEntries(
    [
      'vmmSha256',
      'firmwareSha256',
      'agentdSha256',
      'imageSha256',
      'dshRuntimeDiskSha256',
      'dshProfileSha256',
      'commandMemorySha256',
      'isolationPolicySha256',
    ].map((name) => [name, hash]),
  ),
  files: ['state', 'memory', 'root-disk', 'dsh-runtime-disk', 'device-topology']
    .map((role) => ({
      role,
      path: 'checkpoint/state-files/' + role,
      sizeBytes: 1,
      sha256: hash,
    }))
    .concat({
      role: 'metadata',
      path: 'checkpoint/snapshot.json',
      sizeBytes: 1,
      sha256: hash,
    }),
};
const computeIdentity = { pid: 1040, startedAt: 'fixture-birth' };
const stopReceipt = (binding) => ({
  state: 'stopped',
  binding,
  nativeGone: true,
  operationsJoined: true,
  networkClosed: true,
});

function setup(options = {}) {
  const calls = [];
  const dimensions = { stopState: 'stopped' };
  const caller = new AbortController();
  const transport = new AbortController();
  const lease = {
    assertCurrent: vi.fn(async (signal) => signal.throwIfAborted()),
    release: vi.fn(async () => {
      calls.push('lease');
      return true;
    }),
  };
  let attempt = 0;
  let clock = 1000;
  let draw = 0;
  let previousReply;
  const native = {
    inspect: vi.fn(async () => dimensions.state ?? 'absent'),
    restoreStrict: vi.fn(async ({ binding, onNativeDispatch, signal }) => {
      if (!options.omitDispatch) onNativeDispatch();
      calls.push('restore');
      dimensions.state = 'running';
      await options.afterDispatch?.(signal);
      return {
        binding,
        templateDigest: hash,
        memoryMode: 'cow',
        computeIdentity,
        ...options.nativeReceipt,
      };
    }),
    stopAndJoin: vi.fn(async (binding, signal) => {
      signal.throwIfAborted();
      await options.stop?.();
      calls.push('stop');
      dimensions.state = dimensions.stopState;
      return { ...stopReceipt(binding), ...options.stopReceipt };
    }),
  };
  const scope = {
    prepare: vi.fn(async () => {
      calls.push('prepare');
      await options.prepare?.();
    }),
    readOwnedReceipts: vi.fn(async () => ({
      disk: scope.disk,
      egress: scope.egress,
      networkFenced: scope.networkFenced,
    })),
    connectGate: vi.fn(async (compute, signal) => ({
      binding: lease.binding,
      compute,
      endpoint: scope.control.socketPath,
      waitingVersion: 1,
      ...options.gatePeer,
      exchange: async (request) => {
        calls.push('reseed');
        await options.exchange?.(signal);
        if (options.badReseed) return Buffer.alloc(0);
        if (options.replayGuest && previousReply)
          return Buffer.from(previousReply);
        const reply = Buffer.concat([
          request.subarray(0, 33),
          Buffer.alloc(32, options.sameSample ? 200 : 200 + attempt),
        ]);
        if (options.replayGuest) previousReply = Buffer.from(reply);
        return reply;
      },
    })),
    confirmIsolation: vi.fn(async (compute) => ({
      binding: lease.binding,
      compute,
      endpoint: scope.control.socketPath,
      isolationId: scope.isolationId,
      egressBindingId: scope.egress.bindingId,
      blockedBusinessRoutes: true,
      priorNetworkStateGone: true,
      freshNetworkIdentity: true,
      freshControlIdentity: true,
      cgroupVerified: true,
      runtimeReset: true,
      ...options.isolation,
    })),
    verifyMountedWork: vi.fn(async (compute) => ({
      path: '/work',
      ownedDisk: scope.disk,
      verifiedAgainstOwnedDisk: true,
      compute,
      ...options.mount,
    })),
    probeSyntheticEditor: vi.fn(async () => ({
      binding: lease.binding,
      editorReady: true,
    })),
    confirmSyntheticReady: vi.fn(async () => true),
    fenceAndJoin: vi.fn(async () => {
      calls.push('fence');
      return options.fenced ?? true;
    }),
    release: vi.fn(async () => {
      calls.push('disk');
      dimensions.state = 'absent';
      return true;
    }),
  };
  const probe = createRestoreProbe({
    qualify: async (seal) => ({ seal, manifest: options.manifest ?? manifest }),
    gateTimeoutMs: options.gateTimeoutMs,
    reserve: async () => ({
      ...lease,
      binding: (lease.binding = {
        organizationId: 'org',
        personId: 'person-' + ++attempt,
        vmId: 'vm-' + attempt,
        instanceId: 'instance-' + attempt,
        leaseEpoch: attempt,
      }),
    }),
    openScope: (binding) =>
      Object.assign(scope, {
        disk: {
          binding,
          image: { device: 'dev-' + attempt, inode: 'inode-' + attempt },
          mountId: 'mount-' + attempt,
          workDirectory: options.workDirectory ?? '/private/work-' + attempt,
        },
        egress: { binding, bindingId: 'egress-' + attempt, gatewayPorts: [] },
        control: {
          socketPath: '/private/control-' + attempt + '.sock',
          port: 5200,
        },
        isolationId: 'net-' + attempt,
        networkFenced: true,
      }),
    native,
    now: () => (clock += 7),
    random: (size) =>
      Buffer.alloc(size, options.sameChallenge ? (draw++ % 2) + 1 : ++draw),
  });
  return {
    calls,
    scope,
    native,
    lease,
    dimensions,
    caller,
    transport,
    run(overrides = {}) {
      return probe({
        seal,
        signal: caller.signal,
        disconnected: transport.signal,
        ...overrides,
      });
    },
  };
}

describe('isolated Linux snapshot restore', () => {
  it('uses exact strict argv, proves the binding before the editor and measures seven spans', async () => {
    const fixture = setup();
    const result = await fixture.run();
    expect(result).toMatchObject({
      evidence: 'synthetic',
      failure: null,
      resourcesReleased: true,
      timeline: {
        stagesMs: {
          admission: 7,
          hostDiskAndNetwork: 7,
          resumeToGate: 7,
          freshness: 7,
          workMount: 7,
          nativeEditor: 7,
          readyCommit: 7,
        },
        dispatchGapMs: 7,
        totalMs: 56,
      },
    });
    const { argv } = fixture.native.restoreStrict.mock.calls[0][0];
    expect(argv).toEqual([
      'snap',
      'restore',
      seal.templateDirectory + '/checkpoint',
      '--name',
      expect.stringMatching(/^probe-[a-f0-9]{64}$/),
      '--cow-mem',
      '--external-mount-policy',
      'strict',
      '--volume',
      '/private/work-1:/work',
      '--vsock',
      '/private/control-1.sock:5200/stream',
      '--net-default',
      'deny',
    ]);
    expect(fixture.scope.probeSyntheticEditor.mock.calls[0][0]).toMatchObject({
      binding: fixture.lease.binding,
      guestWorkMount: {
        path: '/work',
        sourceMountId: 'mount-1',
        verifiedAgainstOwnedDisk: true,
      },
    });
    expect(fixture.calls).toEqual([
      'prepare',
      'restore',
      'reseed',
      'fence',
      'stop',
      'disk',
      'lease',
    ]);
  });

  it.each([
    [{ badReseed: true }, 'GATE_RESEED_UNCONFIRMED'],
    [
      {
        gatePeer: { compute: { ...computeIdentity, startedAt: 'other-birth' } },
      },
      'GATE_PEER_UNVERIFIED',
    ],
    [
      { isolation: { freshNetworkIdentity: false } },
      'FRESH_ISOLATION_UNPROVED',
    ],
    [
      { isolation: { blockedBusinessRoutes: false } },
      'FRESH_ISOLATION_UNPROVED',
    ],
    [
      { isolation: { freshControlIdentity: false } },
      'FRESH_ISOLATION_UNPROVED',
    ],
    [{ mount: { path: '/other' } }, 'WORK_MOUNT_UNPROVED'],
    [{ nativeReceipt: { memoryMode: 'disk' } }, 'NATIVE_RESTORE_UNPROVED'],
  ])(
    'refuses editor and ready on unconfirmed proofs %#',
    async (options, code) => {
      const fixture = setup(options);
      expect(await fixture.run()).toMatchObject({
        failure: { stage: 'restore', code },
        resourcesReleased: true,
        timeline: { totalMs: null },
      });
      expect(fixture.scope.probeSyntheticEditor).not.toHaveBeenCalled();
      expect(fixture.scope.confirmSyntheticReady).not.toHaveBeenCalled();
    },
  );

  it('rejects a wrong mount ID even with an otherwise identical receipt', async () => {
    const fixture = setup();
    fixture.scope.verifyMountedWork.mockImplementation(async (compute) => ({
      compute,
      path: '/work',
      ownedDisk: { ...fixture.scope.disk, mountId: 'wrong' },
      verifiedAgainstOwnedDisk: true,
    }));
    expect((await fixture.run()).failure.code).toBe('WORK_MOUNT_UNPROVED');
  });

  it.each([
    [{ sameChallenge: true }, 'CHALLENGE_REUSED'],
    [{ sameSample: true }, 'GUEST_RANDOM_REUSED'],
    [{ replayGuest: true }, 'GATE_RESEED_UNCONFIRMED'],
  ])('fails hard on a repeated cross-clone proof %#', async (options, code) => {
    const fixture = setup(options);
    expect((await fixture.run()).failure).toBeNull();
    const result = await fixture.run();
    expect(result).toMatchObject({
      failure: { code },
      resourcesReleased: true,
    });
    expect(fixture.scope.probeSyntheticEditor).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'requires a unique signed native descriptor %#',
    async (duplicate) => {
      const files = duplicate
        ? manifest.files.concat({
            role: 'metadata',
            path: 'other/snapshot.json',
            sizeBytes: 1,
            sha256: hash,
          })
        : manifest.files.filter(
            ({ path }) => path !== 'checkpoint/snapshot.json',
          );
      const fixture = setup({ manifest: { ...manifest, files } });
      expect((await fixture.run()).failure.code).toBe(
        'SNAPSHOT_DESCRIPTOR_UNPROVED',
      );
      expect(fixture.native.restoreStrict).not.toHaveBeenCalled();
    },
  );

  it.each([
    { gatePeer: { endpoint: '/private/control-old.sock' } },
    { gatePeer: { binding: { leaseEpoch: 2 } } },
  ])('rejects a retired endpoint or cross-epoch peer %#', async (options) => {
    const fixture = setup(options);
    expect((await fixture.run()).failure.code).toBe('GATE_PEER_UNVERIFIED');
    expect(fixture.calls).not.toContain('reseed');
  });

  it.each(['endpoint', 'isolation', 'disk'])(
    'rejects clone A’s %s in clone B and only stops B for the failure',
    async (kind) => {
      const fixture = setup();
      expect((await fixture.run()).failure).toBeNull();
      const scopeA = {
        disk: fixture.scope.disk,
        endpoint: fixture.scope.control.socketPath,
        isolationId: fixture.scope.isolationId,
      };
      let code;
      if (kind === 'endpoint') {
        const connect = fixture.scope.connectGate.getMockImplementation();
        fixture.scope.connectGate.mockImplementation(async (...args) => ({
          ...(await connect(...args)),
          endpoint: scopeA.endpoint,
        }));
        code = 'GATE_PEER_UNVERIFIED';
      } else if (kind === 'isolation') {
        const read = fixture.scope.confirmIsolation.getMockImplementation();
        fixture.scope.confirmIsolation.mockImplementation(async (...args) => ({
          ...(await read(...args)),
          isolationId: scopeA.isolationId,
        }));
        code = 'FRESH_ISOLATION_UNPROVED';
      } else {
        const read = fixture.scope.verifyMountedWork.getMockImplementation();
        fixture.scope.verifyMountedWork.mockImplementation(async (...args) => ({
          ...(await read(...args)),
          ownedDisk: scopeA.disk,
        }));
        code = 'WORK_MOUNT_UNPROVED';
      }

      fixture.native.stopAndJoin.mockClear();
      expect(await fixture.run()).toMatchObject({
        failure: { code },
        resourcesReleased: true,
      });
      expect(fixture.native.stopAndJoin).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ vmId: 'vm-2', leaseEpoch: 2 }),
        expect.anything(),
      );
      expect(fixture.scope.probeSyntheticEditor).toHaveBeenCalledTimes(1);
    },
  );

  it('expires a silent peer, joins it and only then stops and releases', async () => {
    let joined = false;
    const fixture = setup({
      gateTimeoutMs: 25,
      exchange: async (signal) => {
        await new Promise((resolve) =>
          signal.addEventListener('abort', resolve, { once: true }),
        );
        joined = true;
        signal.throwIfAborted();
      },
      stop: () => expect(joined).toBe(true),
    });
    expect(await fixture.run()).toMatchObject({
      failure: { code: 'GATE_DEADLINE_EXPIRED' },
      resourcesReleased: true,
    });
    expect(fixture.scope.probeSyntheticEditor).not.toHaveBeenCalled();
  });

  it('rejects an unsafe mount operand before dispatch', async () => {
    const fixture = setup({ workDirectory: '/private/work:/share' });
    expect((await fixture.run()).failure.code).toBe('UNSAFE_RESTORE_INPUT');
    expect(fixture.native.restoreStrict).not.toHaveBeenCalled();
    expect(fixture.native.stopAndJoin).not.toHaveBeenCalled();
  });

  it('does not normalize unknown to absent or stop a pre-existing destination', async () => {
    const fixture = setup();
    fixture.dimensions.state = 'unknown';
    const result = await fixture.run();
    expect(result.failure.code).toBe('DESTINATION_NOT_PROVEN_ABSENT');
    expect(fixture.native.restoreStrict).not.toHaveBeenCalled();
    expect(fixture.native.stopAndJoin).not.toHaveBeenCalled();
    expect(fixture.scope.prepare).not.toHaveBeenCalled();
    expect(result.resourcesReleased).toBe(false);
    expect(fixture.lease.release).not.toHaveBeenCalled();
  });

  it.each(['disk', 'egress'])(
    'rechecks the %s receipt before dispatch and return',
    async (kind) => {
      for (const beforeDispatch of [true, false]) {
        const fixture = setup();
        const read = fixture.scope.readOwnedReceipts.getMockImplementation();
        fixture.scope.readOwnedReceipts.mockImplementation(async () => {
          const receipt = await read();
          if (
            beforeDispatch
              ? fixture.scope.readOwnedReceipts.mock.calls.length > 1
              : fixture.scope.verifyMountedWork.mock.calls.length > 0
          ) {
            if (kind === 'disk')
              receipt.disk = { ...receipt.disk, mountId: 'moved' };
            else receipt.egress = { ...receipt.egress, bindingId: 'retired' };
          }
          return receipt;
        });
        expect(await fixture.run()).toMatchObject({
          failure: { code: 'OWNED_RESOURCES_CHANGED' },
          resourcesReleased: true,
        });
        expect(fixture.native.restoreStrict).toHaveBeenCalledTimes(
          beforeDispatch ? 0 : 1,
        );
        expect(fixture.scope.probeSyntheticEditor).not.toHaveBeenCalled();
      }
    },
  );

  it('rechecks the live lease before opening the synthetic editor', async () => {
    const fixture = setup();
    fixture.lease.assertCurrent.mockImplementation(async () => {
      if (fixture.scope.verifyMountedWork.mock.calls.length)
        throw Error('LEASE_LOST');
    });
    expect(await fixture.run()).toMatchObject({
      failure: { stage: 'restore' },
      resourcesReleased: true,
    });
    expect(fixture.scope.probeSyntheticEditor).not.toHaveBeenCalled();
  });

  it('keeps exact disk and lease pinned if a broken driver omits its dispatch receipt', async () => {
    const fixture = setup({ omitDispatch: true });
    expect(await fixture.run()).toMatchObject({
      failure: { code: 'DISPATCH_UNRECORDED' },
      resourcesReleased: false,
    });
    expect(fixture.scope.connectGate).not.toHaveBeenCalled();
    expect(fixture.scope.probeSyntheticEditor).not.toHaveBeenCalled();
    expect(fixture.scope.release).not.toHaveBeenCalled();
    expect(fixture.lease.release).not.toHaveBeenCalled();
  });

  it.each(['caller', 'transport'])(
    'joins restore before closing ownership on %s abort',
    async (source) => {
      const dispatched = Promise.withResolvers();
      const joined = Promise.withResolvers();
      const fixture = setup({
        afterDispatch: async () => {
          dispatched.resolve();
          await joined.promise;
        },
      });
      const run = fixture.run();
      await dispatched.promise;
      fixture[source].abort(new Error('private abort reason'));
      expect(fixture.native.stopAndJoin).not.toHaveBeenCalled();
      joined.resolve();
      const result = await run;
      expect(result).toMatchObject({
        failure: { code: 'INTERRUPTED' },
        resourcesReleased: true,
      });
      expect(JSON.stringify(result)).not.toContain('private abort reason');
      expect(fixture.calls.slice(-4)).toEqual([
        'fence',
        'stop',
        'disk',
        'lease',
      ]);
      expect(fixture.scope.connectGate).not.toHaveBeenCalled();
    },
  );

  it('fails during an in-flight gate exchange on revoke and never requests the editor', async () => {
    const fixture = setup({
      exchange: async () => {
        fixture.caller.abort();
      },
    });
    expect(await fixture.run()).toMatchObject({
      failure: { code: 'INTERRUPTED' },
      resourcesReleased: true,
    });
    expect(fixture.scope.probeSyntheticEditor).not.toHaveBeenCalled();
  });

  it('waits for asynchronous stop and exact inspection before disk release', async () => {
    const stopping = Promise.withResolvers();
    const stopped = Promise.withResolvers();
    const fixture = setup({
      stop: async () => {
        stopping.resolve();
        await stopped.promise;
      },
    });
    const run = fixture.run();
    await stopping.promise;
    expect(fixture.scope.release).not.toHaveBeenCalled();
    stopped.resolve();
    expect((await run).resourcesReleased).toBe(true);
    expect(fixture.native.inspect).toHaveBeenCalledTimes(2);
  });

  it.each([
    { stopReceipt: { state: 'unknown' } },
    { stopReceipt: { binding: { leaseEpoch: 2 } } },
    { stopReceipt: { operationsJoined: false } },
    { fenced: false },
  ])(
    'keeps disk and lease when cleanup cannot be proven %#',
    async (options) => {
      const fixture = setup(options);
      expect((await fixture.run()).resourcesReleased).toBe(false);
      expect(fixture.scope.release).not.toHaveBeenCalled();
      expect(fixture.lease.release).not.toHaveBeenCalled();
    },
  );

  it('keeps disk and lease when stop returns but inspect is unknown', async () => {
    const fixture = setup();
    fixture.dimensions.stopState = 'unknown';
    expect((await fixture.run()).resourcesReleased).toBe(false);
    expect(fixture.scope.release).not.toHaveBeenCalled();
    expect(fixture.lease.release).not.toHaveBeenCalled();
  });

  it('cleans a partly prepared disk even when prepare throws', async () => {
    const fixture = setup({
      prepare: async () => {
        throw Error('secret');
      },
    });
    const result = await fixture.run();
    expect(result).toMatchObject({
      failure: { stage: 'host_disk_and_network', code: 'PROBE_STEP_FAILED' },
      resourcesReleased: true,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(fixture.calls).toEqual(['prepare', 'fence', 'disk', 'lease']);
  });
});

describe('restore timings', () => {
  it('rejects repeated, out-of-order and non-monotonic observations', () => {
    let time = 10;
    const measure = measureRestore(() => time);
    expect(() => measure.mark('work_verified')).toThrow(
      'SNAPSHOT_TIMELINE_INVALID',
    );
    measure.mark('accepted');
    expect(() => measure.mark('accepted')).toThrow('SNAPSHOT_TIMELINE_INVALID');
    time = 9;
    expect(() => measure.mark('epoch_reserved')).toThrow(
      'SNAPSHOT_TIMELINE_INVALID',
    );
    expect(measure.read()).toMatchObject({
      offsetsMs: { accepted: 0 },
      dispatchGapMs: null,
      totalMs: null,
    });
  });
});
