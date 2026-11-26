import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PersonVmError } from './contract.ts';
import {
  bootstrapPersonVm,
  type PersonVmMemoryGuestPlan,
  type PersonVmStartingScope,
} from './guest-bootstrap.ts';
import { bootstrapMicrosandbox } from './microsandbox-bootstrap.ts';
import { harness } from './test-support.ts';

const probeId = 'job_ethernet';
const plan = {
  files: [
    { path: '/work/init.cjs', contents: '', mode: 0o600 },
    { path: '/work/launcher', contents: '', mode: 0o700 },
  ],
  initialize: { executable: 'node', args: ['/work/init.cjs'] },
  launcher: '/work/launcher',
  env: {},
} satisfies PersonVmMemoryGuestPlan;
function row(address: string, prefix = 30, internal = false) {
  return { address, cidr: address + '/' + prefix, internal };
}
const finished = JSON.stringify({ code: 0, success: true, timed_out: false });
const stopped = JSON.stringify({ code: -1, success: false, timed_out: false });
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'microsandbox-bootstrap-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fixture(data: string = JSON.stringify([row('172.16.0.6')])) {
  const binding = {
    vmId: randomUUID(),
    instanceId: randomUUID(),
    personId: randomUUID(),
    organizationId: randomUUID(),
    leaseEpoch: 1,
  };
  const name = `allrice-${binding.vmId}`;
  const scope = {
    binding,
    signal: new AbortController().signal,
    assertCurrent: vi.fn(async () => {}),
  };
  const waitProbe = vi.fn(async (signal: AbortSignal) => {
    signal.throwIfAborted();
    return finished;
  });
  const readProbe = vi.fn(async () =>
    JSON.stringify({ id: probeId, d: data, s: 'stdout', e: null }),
  );
  const command = vi.fn(async (args: string[], signal: AbortSignal) => {
    if (args[0] === 'cp') {
      expect(args[2]).toContain(name + ':/work/');
      return '';
    }
    expect(args[1]).toBe(name);
    if (args[0] === 'exec') {
      if (!args.at(-1)?.includes('networkInterfaces()')) return 'job_init';
      expect(args.slice(0, -1)).toEqual([
        'exec',
        name,
        '--detach',
        '--no-stdin',
        '--no-tty',
        '--',
        '/usr/local/bin/node',
        '-e',
      ]);
      expect(args.at(-1)).toContain('interfaces.eth0');
      return probeId;
    }
    if (args[0] === 'wait')
      return args[3] === probeId ? waitProbe(signal) : finished;
    if (args[0] === 'logs') {
      expect(args.slice(2)).toEqual([
        '--job',
        probeId,
        '--source',
        'stdout',
        '--json',
      ]);
      return readProbe();
    }
    if (args[0] === 'kill') {
      expect(args.slice(2)).toEqual(['--job', probeId]);
      expect(signal.aborted).toBe(false);
      return '';
    }
    throw Error('unexpected native verb');
  });
  const bootstrap = (starting: PersonVmStartingScope = scope) =>
    bootstrapMicrosandbox({
      scope: starting,
      plan,
      stagingRoot: root,
      name,
      cleanupTimeoutMs: 2000,
      command,
    });
  return { bootstrap, binding, scope, command, waitProbe, readProbe };
}

it('labels a failed auth artifact read without retaining guest command output', async () => {
  const f = fixture();
  const native = await f.bootstrap();
  f.command.mockRejectedValueOnce(
    new PersonVmError('PROVIDER_FAILED', {
      cause: Error('synthetic private native command output'),
    }),
  );
  await expect(
    native.readNativeWebAuth!({
      dshHome: '/work/dsh',
      origin: 'http://127.0.0.1:32179/',
      nonce: randomUUID(),
      timeoutMs: 3000,
    }),
  ).rejects.toMatchObject({
    code: 'PROVIDER_FAILED',
    message: 'PROVIDER_FAILED',
    cause: 'AUTH_ARTIFACT_READ_FAILED',
  });
});

it.each(['10.4.1.10', '172.16.0.6', '192.168.4.2'])(
  'returns exactly one current private assigned guest IPv4 %s after native wait and logs',
  async (address) => {
    const f = fixture(JSON.stringify([row(address)]));
    const native = await f.bootstrap();
    expect(f.waitProbe).not.toHaveBeenCalled();
    await expect(native.readNativeWebGuestAddress!()).resolves.toBe(address);
    expect(f.waitProbe).toHaveBeenCalledTimes(1);
    expect(f.readProbe).toHaveBeenCalledTimes(1);
    expect(f.command.mock.calls.slice(-3).map(([args]) => args[0])).toEqual([
      'exec',
      'wait',
      'logs',
    ]);
  },
);

it.each([
  ['no eth0 address', '[]'],
  ['malformed reply', 'bad-json'],
  [
    'multiple eth0 addresses',
    JSON.stringify([row('10.0.0.2'), row('10.0.0.6')]),
  ],
  ['gateway', JSON.stringify([row('172.16.0.5')])],
  ['wrong subnet', JSON.stringify([row('172.16.0.6', 24)])],
  ['wildcard', JSON.stringify([row('0.0.0.0')])],
  ['loopback', JSON.stringify([row('127.0.0.2')])],
  ['internal flag', JSON.stringify([row('172.16.0.6', 30, true)])],
  ['nonprivate IPv4', JSON.stringify([row('100.64.0.2')])],
  ['IPv6', JSON.stringify([row('fd00::2')])],
])('fails closed for %s', async (_label, data) => {
  const native = await fixture(data).bootstrap();
  await expect(native.readNativeWebGuestAddress!()).rejects.toMatchObject({
    code: 'PROVIDER_FAILED',
  });
});

it('withholds the address when the binding changes during the native read', async () => {
  const f = fixture();
  const native = await f.bootstrap();
  const originalRead = f.readProbe.getMockImplementation()!;
  f.readProbe.mockImplementationOnce(async () => {
    f.scope.assertCurrent.mockRejectedValue(new PersonVmError('LEASE_LOST'));
    return originalRead();
  });
  await expect(native.readNativeWebGuestAddress!()).rejects.toMatchObject({
    code: 'LEASE_LOST',
  });
  expect(f.waitProbe).toHaveBeenCalledTimes(1);
  expect(f.command.mock.calls.some(([args]) => args[0] === 'kill')).toBe(false);
});

it('joins the exact probe on scope retirement before the startup lease can close', async () => {
  const f = fixture(),
    entered = latch(),
    cleanupEntered = latch(),
    releaseCleanup = latch();
  f.waitProbe
    .mockImplementationOnce(
      (active) =>
        new Promise((_resolve, reject) => {
          active.addEventListener('abort', () => reject(active.reason), {
            once: true,
          });
          entered.release();
        }),
    )
    .mockImplementationOnce(async (active) => {
      expect(active.aborted).toBe(false);
      cleanupEntered.release();
      await releaseCleanup.promise;
      return stopped;
    });
  let settled = false;
  const outcome = bootstrapPersonVm({
    binding: f.binding,
    signal: f.scope.signal,
    assertCurrent: f.scope.assertCurrent,
    native: { bootstrap: f.bootstrap },
    runtime: {
      ...harness().runtime,
      memoryGuestPlan: async () => plan,
      async start(_binding, _signal, scope) {
        void scope.readNativeWebGuestAddress!().catch(() => {});
        await entered.promise;
      },
    },
  }).finally(() => {
    settled = true;
  });
  const error = expect(outcome).rejects.toMatchObject({
    code: 'CLEANUP_INCOMPLETE',
  });
  try {
    await cleanupEntered.promise;
    expect(settled).toBe(false);
    expect(f.readProbe).not.toHaveBeenCalled();
    expect(f.command.mock.calls.slice(-2).map(([args]) => args[0])).toEqual([
      'kill',
      'wait',
    ]);
  } finally {
    releaseCleanup.release();
  }
  await error;
});
