import { setImmediate as turn } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { PersonVmDiskPreparationTarget } from '@allrice/person-vm';
import { startProductionDiskPreprovision } from './production-disk-preprovision.js';

type Input = Parameters<typeof startProductionDiskPreprovision>[0];
type Feed = ReturnType<Input['openFeed']>;
type Listener = Parameters<Feed['subscribe']>[0];
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const first = id(1);
const second = id(2);
const third = id(3);

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function target(personId: string): PersonVmDiskPreparationTarget {
  return {
    personId,
    organizationId: id(4),
    workspaceId: id(5),
    employeeInstanceId: id(6),
    employeeRevision: 1,
    employeeVersionId: id(7),
    policyRevision: 'committed-1',
  };
}

function hint(table: string, personId: string | null = null) {
  return {
    table,
    personId,
    schema: 'public',
    id: null,
    organizationId: null,
    workspaceId: null,
  };
}

const started: ReturnType<typeof startProductionDiskPreprovision>[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((owner) => owner.close()));
});

function fixture() {
  const subscribers: Listener[] = [];
  const unsubscribed = vi.fn();
  const feed = {
    subscribe: vi.fn<Feed['subscribe']>(async (listener) => {
      subscribers.push(listener);
      return unsubscribed;
    }),
    close: vi.fn<Feed['close']>(async () => {}),
  };
  const input = {
    lifetime: new AbortController().signal,
    openFeed: vi.fn(() => feed),
    listPeople: vi.fn<Input['listPeople']>(async () => ({
      personIds: [first],
      nextAfter: null,
    })),
    readTarget: vi.fn<Input['readTarget']>(async (personId) =>
      target(personId),
    ),
    foregroundBusy: vi.fn<Input['foregroundBusy']>(async () => false),
    availableBytes: vi.fn<Input['availableBytes']>(async () => 100n),
    minimumFreeBytes: 70,
    reserveBytes: 20,
    port: {
      prepare: vi.fn<Input['port']['prepare']>(async (_target, guard) => {
        await guard.assertCurrent();
        await guard.assertCapacity();
        return 'prepared';
      }),
    },
    observe: vi.fn<Input['observe']>(),
  };
  return {
    input,
    feed,
    subscribers,
    unsubscribed,
    start() {
      const owner = startProductionDiskPreprovision(input);
      started.push(owner);
      return owner;
    },
  };
}

it('subscribes before scanning, pages serially, and gives the foreground lease priority', async () => {
  const f = fixture();
  f.input.listPeople
    .mockResolvedValueOnce({ personIds: [first, second], nextAfter: second })
    .mockResolvedValueOnce({ personIds: [third], nextAfter: null });
  f.input.foregroundBusy.mockImplementation(
    async (personId) => personId === first,
  );
  const gate = latch();
  f.input.port.prepare.mockImplementationOnce(async () => {
    await gate.promise;
    return 'prepared';
  });
  f.start();
  try {
    await vi.waitFor(() =>
      expect(f.input.port.prepare).toHaveBeenCalledTimes(1),
    );
    expect(f.feed.subscribe).toHaveBeenCalledBefore(f.input.listPeople);
    expect(f.input.port.prepare.mock.calls[0]?.[0].personId).toBe(second);
    expect(f.input.listPeople).toHaveBeenCalledTimes(1);
  } finally {
    gate.resolve();
  }
  await vi.waitFor(() => expect(f.input.port.prepare).toHaveBeenCalledTimes(2));
  expect(f.input.listPeople.mock.calls[1]?.[0]).toBe(second);
  expect(f.input.port.prepare.mock.calls[1]?.[0].personId).toBe(third);
});

it('reserves bytes above the floor and defers rather than calling the port at low space', async () => {
  const f = fixture();
  f.input.availableBytes.mockResolvedValue(89n);
  f.start();
  await vi.waitFor(() =>
    expect(f.input.observe).toHaveBeenCalledExactlyOnceWith(
      'capacity-deferred',
    ),
  );
  expect(f.input.port.prepare).not.toHaveBeenCalled();
  f.subscribers[0]?.changed(hint('allrice_settings'));
  await vi.waitFor(() => expect(f.input.listPeople).toHaveBeenCalledTimes(2));
  expect(f.input.availableBytes).toHaveBeenCalledOnce(); // respects retry backoff
});

it('rejects a changed revision before dispatch and never treats notification data as a grant', async () => {
  const f = fixture();
  f.input.readTarget
    .mockResolvedValueOnce(target(first))
    .mockResolvedValue({ ...target(first), policyRevision: 'committed-2' });
  f.start();
  await vi.waitFor(() => expect(f.input.readTarget).toHaveBeenCalledTimes(2));
  expect(f.input.port.prepare).not.toHaveBeenCalled();
});

it('fences revoked work, ignores its own lease hints, and joins before closing the feed', async () => {
  const f = fixture();
  const gate = latch();
  f.input.port.prepare.mockImplementation(async () => {
    await gate.promise;
    return 'deferred';
  });
  const owner = f.start();
  try {
    await vi.waitFor(() => expect(f.input.port.prepare).toHaveBeenCalledOnce());
    const guard = f.input.port.prepare.mock.calls[0]![1];
    f.subscribers[0]?.changed(hint('person_virtual_machines', first));
    f.subscribers[0]?.changed(hint('allrice_memberships', second));
    expect(guard.signal.aborted).toBe(false);
    f.subscribers[0]?.changed(hint('allrice_memberships', first));
    expect(guard.signal.aborted).toBe(true);
    await expect(guard.assertCurrent()).rejects.toThrow('AUTHORITY_CHANGED');
    const close = owner.close();
    expect(owner.close()).toBe(close);
    await turn();
    expect(f.feed.close).not.toHaveBeenCalled();
    gate.resolve();
    await close;
    expect(f.unsubscribed).toHaveBeenCalledOnce();
    expect(f.feed.close).toHaveBeenCalledOnce();
    await expect(guard.assertCapacity()).rejects.toThrow('AUTHORITY_CHANGED');
  } finally {
    gate.resolve();
  }
});

it('rechecks capacity for the storage owner and invalidates guards after return', async () => {
  const f = fixture();
  f.input.port.prepare.mockImplementation(async (_target, guard) => {
    f.input.availableBytes.mockResolvedValue(89n);
    await guard.assertCapacity();
    return 'prepared';
  });
  f.start();
  await vi.waitFor(() =>
    expect(f.input.observe).toHaveBeenCalledExactlyOnceWith(
      'capacity-deferred',
    ),
  );
  const guard = f.input.port.prepare.mock.calls[0]![1];
  expect(guard.signal.aborted).toBe(true);
  await expect(guard.assertCurrent()).rejects.toBeDefined();
});

it('fences disconnected work, waits for join, then reconnects and starts a fresh scan', async () => {
  const f = fixture();
  const gate = latch();
  f.input.port.prepare.mockImplementationOnce(async () => {
    await gate.promise;
    return 'deferred';
  });
  f.start();
  try {
    await vi.waitFor(() => expect(f.input.port.prepare).toHaveBeenCalledOnce());
    f.subscribers[0]?.lost(Error('synthetic feed disconnect'));
    expect(f.input.port.prepare.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(f.input.openFeed).toHaveBeenCalledOnce();
    expect(f.feed.close).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
  }
  await vi.waitFor(() => expect(f.subscribers).toHaveLength(2), {
    timeout: 2_500,
  });
  await vi.waitFor(() =>
    expect(f.input.listPeople.mock.calls[1]?.[0]).toBeNull(),
  );
  expect(f.feed.close).toHaveBeenCalled();
  await vi.waitFor(() => expect(f.input.port.prepare).toHaveBeenCalledTimes(2));
  expect(f.input.observe).toHaveBeenCalledWith('source-unavailable');
});
