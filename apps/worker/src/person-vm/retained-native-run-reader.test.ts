import { randomUUID } from 'node:crypto';
import type * as fs from 'node:fs/promises';
import type {
  DEntryNativeRunCandidate,
  DEntryNativeRunJournalOwner,
  DEntryNativeTurnEnd,
} from '@allrice/database';
import { beforeEach, expect, it, vi } from 'vitest';
import { createRetainedNativeRunReader } from './retained-native-run-reader.js';

const io = vi.hoisted(() => ({
  artifact: vi.fn(),
  current: vi.fn(),
  publish: vi.fn(),
}));

const workerArtifact = new URL(
  '../../dist/allrice-native-run-journal.mjs',
  import.meta.url,
);
const readerSource = new URL(
  '../../dsh/allrice-native-run-journal.mjs',
  import.meta.url,
);
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  const artifact = new URL(
    '../../dist/allrice-native-run-journal.mjs',
    import.meta.url,
  );
  const source = new URL(
    '../../dsh/allrice-native-run-journal.mjs',
    import.meta.url,
  );
  return {
    ...actual,
    readFile(...args: Parameters<typeof actual.readFile>) {
      if (args[0] instanceof URL && args[0].href === artifact.href) {
        io.artifact(...args);
        return actual.readFile(source, 'utf8');
      }
      return actual.readFile(...args);
    },
  };
});
vi.mock(import('@allrice/database'), async (original) => ({
  ...(await original()),
  isDEntryNativeRunJournalCurrent: io.current,
  publishDEntryNativeRunTerminal: io.publish,
}));

type Inputs = Parameters<typeof createRetainedNativeRunReader>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(options?: {
  cliPath?: string;
  hasLocalOwner?: () => boolean;
}) {
  const owner: DEntryNativeRunJournalOwner = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    personId: randomUUID(),
    vmId: randomUUID(),
    vmInstanceId: randomUUID(),
    leaseEpoch: 5,
    employeeInstanceId: randomUUID(),
    employeeRelease: randomUUID(),
  };
  const binding = {
    organizationId: owner.organizationId,
    personId: owner.personId,
    vmId: owner.vmId,
    instanceId: owner.vmInstanceId,
    leaseEpoch: owner.leaseEpoch,
  };
  const diskId = { vmId: owner.vmId, tier: 'warm' as const };
  const leaseOwner = randomUUID();
  const sessionId = 'session-' + randomUUID();
  const nativeRequestId = randomUUID();
  const candidate: DEntryNativeRunCandidate = {
    runId: randomUUID(),
    executionId: randomUUID(),
    organizationId: owner.organizationId,
    workspaceId: owner.workspaceId,
    ownerId: owner.personId,
    prompt: {
      generation: '4.0',
      source: 'dsh-native-prompt',
      threadId: randomUUID(),
      employeeInstanceId: owner.employeeInstanceId,
      employeeRelease: owner.employeeRelease,
      personId: owner.personId,
      vmId: owner.vmId,
      rootSessionId: sessionId,
      adapterId: 'old-adapter',
      loginSessionId: randomUUID(),
      nativeRequestId,
    },
    attempt: {
      source: 'dsh-native-attempt',
      profile: 'old-adapter',
      sessionId,
      parentSessionId: null,
      nativeInstanceId: 'old-guest-job',
      vmInstanceId: randomUUID(),
      leaseEpoch: 3,
      attemptId: sessionId + ':1',
      kind: 'assistant',
      cursor: 11,
      turn: 1,
      contributingRequestIds: [nativeRequestId],
    },
  };
  const end: DEntryNativeTurnEnd = {
    sessionId,
    turn: 1,
    sequence: 23,
    reason: 'completed',
    occurredAt: '2026-11-25T15:00:00.000Z',
  };
  const caller = new AbortController();
  const leased = new AbortController();
  const active = AbortSignal.any([caller.signal, leased.signal]);
  const mount = '/test/retained-disk';
  const readonlyGuestDirectory = '/opt/sealed-dsh';
  const cliPath =
    options?.cliPath ??
    readonlyGuestDirectory + '/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const log: string[] = [];
  let holding = false;
  let diskReads = 0;

  const store: Inputs['store'] = {
    async withRetainedReadLease(bound, signal, work, mayClaim) {
      expect(bound).toEqual(binding);
      expect(signal).toBe(caller.signal);
      expect(holding).toBe(false);
      if (!mayClaim?.()) throw new Error('existing VM owner');
      holding = true;
      log.push('lease');
      try {
        return await work(
          {
            binding: bound,
            leaseOwner,
            signal: active,
            async assertCurrent() {
              expect(holding).toBe(true);
              active.throwIfAborted();
            },
          },
          diskId,
        );
      } finally {
        holding = false;
        leased.abort();
        log.push('release');
      }
    },
  };
  const disk = {
    verifyAttachedMount: vi.fn<Inputs['disk']['verifyAttachedMount']>(
      async (disk, signal) => {
        expect(holding).toBe(true);
        expect(disk).toEqual(diskId);
        expect(signal).toBe(active);
        log.push(++diskReads === 1 ? 'disk-before' : 'disk-after');
        return mount;
      },
    ),
  };
  const native = {
    readAttachedProbe: vi.fn<Inputs['native']['readAttachedProbe']>(
      async (scope, attached) => {
        expect(holding).toBe(true);
        expect(scope.binding).toEqual(binding);
        expect(scope.signal).toBe(active);
        expect(attached).toBe(mount);
        log.push('probe');
        return JSON.stringify(end);
      },
    ),
  };
  io.current.mockImplementation(async (run, scope, signal, token) => {
    expect(holding).toBe(true);
    expect(run).toBe(candidate);
    expect(scope).toBe(owner);
    expect(signal).toBe(active);
    expect(token).toBe(leaseOwner);
    log.push('scope');
    return true;
  });
  const project = createRetainedNativeRunReader({
    store,
    disk,
    native,
    hasLocalOwner: options?.hasLocalOwner ?? (() => false),
    cliPath,
    readonlyGuestDirectory,
  });
  return {
    candidate,
    owner,
    end,
    mount,
    cliPath,
    readonlyGuestDirectory,
    disk,
    native,
    log,
    active,
    leaseOwner,
    holding: () => holding,
    run: () => project(candidate, owner, caller.signal),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

it('uses the fixed artifact and returns an observation without writing the Run', async () => {
  const f = fixture();
  const resume = deferred<void>();
  const entered = deferred<void>();
  const read = f.native.readAttachedProbe.getMockImplementation()!;
  f.native.readAttachedProbe.mockImplementationOnce(async (...args) => {
    const value = await read(...args);
    entered.resolve();
    await resume.promise;
    expect(f.holding()).toBe(true);
    return value;
  });
  const outcome = f.run();
  try {
    await Promise.race([entered.promise, outcome]);
    expect(f.holding()).toBe(true);
    expect(f.active.aborted).toBe(false);
    expect(f.log).toEqual(['lease', 'scope', 'disk-before', 'scope', 'probe']);
    expect(io.current).toHaveBeenLastCalledWith(
      f.candidate,
      f.owner,
      f.active,
      f.leaseOwner,
    );
    expect(io.artifact).toHaveBeenCalledExactlyOnceWith(workerArtifact, 'utf8');
    const actualFs = await vi.importActual<typeof fs>('node:fs/promises');
    const program = await actualFs.readFile(readerSource, 'utf8');
    expect(f.native.readAttachedProbe).toHaveBeenCalledOnce();
    expect(f.native.readAttachedProbe.mock.calls[0]![2]).toEqual({
      executable: 'node',
      args: [
        '--input-type=module',
        '--eval',
        program + '\nawait printRetainedRunTerminal(process.argv.slice(1));',
        '--',
        f.cliPath,
        f.readonlyGuestDirectory,
        f.owner.employeeInstanceId,
        JSON.stringify({
          sessionId: f.candidate.attempt.sessionId,
          nativeRequestId: f.candidate.prompt.nativeRequestId,
          purpose: 'assistant',
          cursor: 11,
          turn: 1,
          delegated: false,
          parentSessionId: null,
        }),
      ],
    });
  } finally {
    resume.resolve();
    await outcome;
  }
  expect(await outcome).toEqual({ observedTerminal: f.end });
  expect(io.publish).not.toHaveBeenCalled();
  expect(f.log.slice(-3)).toEqual(['disk-after', 'scope', 'release']);
  expect(f.active.aborted).toBe(true);
  expect(f.holding()).toBe(false);
});

it('preserves a missing terminal and lets the exact physical scope retire', async () => {
  const f = fixture();
  f.native.readAttachedProbe.mockResolvedValueOnce('null');
  await expect(f.run()).resolves.toBeNull();
  expect(f.disk.verifyAttachedMount).toHaveBeenCalledTimes(2);
  expect(io.publish).not.toHaveBeenCalled();
  expect(f.log.at(-1)).toBe('release');
});

it('requires an existing mount and refuses to launch on an absent disk', async () => {
  const f = fixture();
  f.disk.verifyAttachedMount.mockResolvedValueOnce(null);
  await expect(f.run()).resolves.toBeNull();
  expect(f.native.readAttachedProbe).not.toHaveBeenCalled();
  expect(io.publish).not.toHaveBeenCalled();
  expect(f.holding()).toBe(false);
});

it('discards terminal bytes after the mount changes', async () => {
  const f = fixture();
  f.disk.verifyAttachedMount
    .mockResolvedValueOnce(f.mount)
    .mockResolvedValueOnce('/test/another-disk');
  await expect(f.run()).rejects.toMatchObject({ code: 'LEASE_LOST' });
  expect(f.native.readAttachedProbe).toHaveBeenCalledOnce();
  expect(f.disk.verifyAttachedMount).toHaveBeenCalledTimes(2);
  expect(io.publish).not.toHaveBeenCalled();
  expect(f.holding()).toBe(false);
});

it.each([0, 2])(
  'requires the exact root scope at check %i',
  async (checksBeforeLoss) => {
    const f = fixture();
    for (let i = 0; i < checksBeforeLoss; ++i)
      io.current.mockResolvedValueOnce(true);
    io.current.mockResolvedValueOnce(false);
    await expect(f.run()).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(f.native.readAttachedProbe).toHaveBeenCalledTimes(
      checksBeforeLoss ? 1 : 0,
    );
    expect(io.current).toHaveBeenLastCalledWith(
      f.candidate,
      f.owner,
      f.active,
      f.leaseOwner,
    );
    expect(io.publish).not.toHaveBeenCalled();
    expect(f.holding()).toBe(false);
  },
);

it('enforces the terminal byte limit before decoding a multibyte reply', async () => {
  const f = fixture();
  const wide = JSON.stringify({ ...f.end, sessionId: '界'.repeat(350) });
  expect(wide.length).toBeLessThan(1024);
  expect(Buffer.byteLength(wide)).toBeGreaterThan(1024);
  f.native.readAttachedProbe.mockResolvedValueOnce(wide);
  await expect(f.run()).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  expect(io.publish).not.toHaveBeenCalled();
  expect(f.log.at(-1)).toBe('release');
});

it('rejects a CLI outside the verified DSH directory before a lease or artifact read', async () => {
  const f = fixture({ cliPath: '/tmp/another-dsh/bin.js' });
  await expect(f.run()).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  expect(f.log).toEqual([]);
  expect(io.artifact).not.toHaveBeenCalled();
  expect(io.publish).not.toHaveBeenCalled();
});

it('does not take a read lease if another profile on the physical VM is owned', async () => {
  const existing = fixture({ hasLocalOwner: () => true });
  await expect(existing.run()).resolves.toBeNull();
  expect(existing.log).toEqual([]);
  expect(io.artifact).not.toHaveBeenCalled();

  const duringClaim = fixture({
    hasLocalOwner: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
  });
  await expect(duringClaim.run()).rejects.toThrow('existing VM owner');
  expect(duringClaim.log).toEqual([]);
  expect(io.publish).not.toHaveBeenCalled();
});
