import { setImmediate as turn } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  PersonVmError,
  type PersonVmDiskPreparationTarget,
} from '@allrice/person-vm';
import { startProductionDiskPreprovision } from './production-disk-preprovision.js';

type Input = Parameters<typeof startProductionDiskPreprovision>[0];
type Feed = ReturnType<Input['openFeed']>;
type Listener = Parameters<Feed['subscribe']>[0];
type Roster = Awaited<ReturnType<Input['readRoster']>>;
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
    platformRevisionId: null,
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
  const page = vi.fn<Roster['page']>(() => ({
    personIds: [first],
    nextOffset: null,
  }));
  const input = {
    lifetime: new AbortController().signal,
    openFeed: vi.fn(() => feed),
    readRoster: vi.fn<Input['readRoster']>(async () => ({ page })),
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
    page,
    subscribers,
    unsubscribed,
    start(register = true) {
      const owner = startProductionDiskPreprovision(input);
      if (register) started.push(owner);
      return owner;
    },
  };
}

it('subscribes before scanning, pages serially, and gives the foreground lease priority', async () => {
  const f = fixture();
  f.page
    .mockReturnValueOnce({ personIds: [first, second], nextOffset: 2 })
    .mockReturnValueOnce({ personIds: [third], nextOffset: null });
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
    expect(f.feed.subscribe).toHaveBeenCalledBefore(f.input.readRoster);
    expect(f.input.port.prepare.mock.calls[0]?.[0].personId).toBe(second);
    expect(f.page).toHaveBeenCalledTimes(1);
  } finally {
    gate.resolve();
  }
  await vi.waitFor(() => expect(f.input.port.prepare).toHaveBeenCalledTimes(2));
  expect(f.page.mock.calls[1]?.[0]).toBe(2);
  expect(f.input.readRoster).toHaveBeenCalledOnce();
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
  await vi.waitFor(() => expect(f.input.readRoster).toHaveBeenCalledTimes(2), {
    timeout: 2_500,
  });
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
    const reads = f.input.readTarget.mock.calls.length;
    f.subscribers[0]?.changed(hint('allrice_settings'));
    await vi.waitFor(() =>
      expect(f.input.readTarget.mock.calls).toHaveLength(reads + 1),
    );
    expect(guard.signal.aborted).toBe(false);

    f.input.readTarget.mockResolvedValue(null);
    f.subscribers[0]?.changed(hint('allrice_memberships', first));
    await vi.waitFor(() => expect(guard.signal.aborted).toBe(true));
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
  await vi.waitFor(() => expect(f.page.mock.calls[1]?.[0]).toBe(0));
  expect(f.feed.close).toHaveBeenCalled();
  await vi.waitFor(() => expect(f.input.port.prepare).toHaveBeenCalledTimes(2));
  expect(f.input.observe).toHaveBeenCalledWith('source-unavailable');
});

it.each(['close', 'disconnect'] as const)(
  'retains incomplete provider cleanup and never reconnects after %s',
  async (cause) => {
    const f = fixture();
    const gate = latch();
    const cleanupError = new PersonVmError('CLEANUP_INCOMPLETE');
    f.input.port.prepare.mockImplementationOnce(async () => {
      await gate.promise;
      throw cleanupError;
    });
    const owner = f.start(false);
    try {
      await vi.waitFor(() =>
        expect(f.input.port.prepare).toHaveBeenCalledOnce(),
      );
      if (cause === 'close') void owner.close();
      else f.subscribers[0]?.lost(Error('synthetic disconnect'));
      expect(f.input.port.prepare.mock.calls[0]?.[1].signal.aborted).toBe(true);
      expect(f.feed.close).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await vi.waitFor(() =>
        expect(f.input.observe).toHaveBeenCalledWith('cleanup-incomplete'),
      );
      await expect(owner.close()).rejects.toBe(cleanupError);
    }
    expect(f.input.openFeed).toHaveBeenCalledOnce();
    expect(f.feed.close).toHaveBeenCalledOnce();
  },
);

it.each(['readTarget', 'foregroundBusy'] as const)(
  'stops the entire pass and joins the feed after %s fails',
  async (source) => {
    const f = fixture();
    const gate = latch();
    f.page.mockReturnValueOnce({
      personIds: [first, second],
      nextOffset: null,
    });
    f.input[source].mockRejectedValueOnce(Error('synthetic database error'));
    f.feed.close.mockImplementationOnce(async () => gate.promise);
    f.start();
    try {
      await vi.waitFor(() => expect(f.feed.close).toHaveBeenCalledOnce());
      expect(f.input.readTarget.mock.calls.map(([person]) => person)).toEqual([
        first,
      ]);
      expect(f.input.port.prepare).not.toHaveBeenCalled();
      expect(f.input.openFeed).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
    }
    await vi.waitFor(
      () => expect(f.input.port.prepare).toHaveBeenCalledOnce(),
      { timeout: 2_500 },
    );
    expect(f.input.openFeed).toHaveBeenCalledTimes(2);
  },
);

it('reports ambiguous enterprise ownership without failing the whole roster', async () => {
  const f = fixture();
  f.page.mockReturnValueOnce({ personIds: [first, second], nextOffset: null });
  f.input.readTarget.mockRejectedValueOnce(
    new PersonVmError('ORGANIZATION_CONFLICT'),
  );
  f.start();
  await vi.waitFor(() => expect(f.input.port.prepare).toHaveBeenCalledOnce());
  expect(f.input.port.prepare.mock.calls[0]?.[0].personId).toBe(second);
  expect(f.input.observe).toHaveBeenCalledExactlyOnceWith(
    'organization-conflict',
  );
  expect(f.feed.close).not.toHaveBeenCalled();
});

it('coalesces repeated notifications without starving the foreground database', async () => {
  const f = fixture();
  const reads: number[] = [];
  f.input.readTarget.mockResolvedValue(null);
  f.input.readRoster.mockImplementation(async () => {
    reads.push(performance.now());
    for (let i = 0; i < 10; i += 1)
      f.subscribers[0]?.changed(hint('allrice_settings'));
    return { page: f.page };
  });
  f.start();
  await vi.waitFor(() => expect(reads).toHaveLength(2), { timeout: 2_500 });
  expect(reads[1]! - reads[0]!).toBeGreaterThan(900);
  expect(f.input.readTarget).toHaveBeenCalledTimes(2);
});

it('joins direct guard reads even if a parallel guard rejects first', async () => {
  const f = fixture();
  const gate = latch();
  f.input.readTarget
    .mockResolvedValueOnce(target(first))
    .mockResolvedValueOnce(target(first))
    .mockImplementationOnce(async () => {
      await gate.promise;
      return target(first);
    });
  f.input.availableBytes.mockResolvedValueOnce(100n).mockResolvedValueOnce(89n);
  f.input.port.prepare.mockImplementationOnce(async (_target, guard) => {
    await Promise.all([guard.assertCurrent(), guard.assertCapacity()]);
    return 'prepared';
  });
  const owner = f.start();
  try {
    await vi.waitFor(() =>
      expect(f.input.observe).toHaveBeenCalledWith('capacity-deferred'),
    );
    const close = owner.close();
    await turn();
    expect(f.feed.close).not.toHaveBeenCalled();
    gate.resolve();
    await close;
    expect(f.feed.close).toHaveBeenCalledOnce();
  } finally {
    gate.resolve();
  }
});

it('joins actual feed close even when the abandoned connect promise never settles', async () => {
  const f = fixture();
  const closed = latch();
  f.feed.subscribe.mockImplementationOnce(() => new Promise(() => {}));
  f.feed.close.mockImplementationOnce(() => closed.promise);
  const owner = f.start();
  try {
    await vi.waitFor(() => expect(f.feed.subscribe).toHaveBeenCalledOnce());
    const closing = owner.close();
    const finished = vi.fn();
    void closing.then(finished, finished);
    await vi.waitFor(() => expect(f.feed.close).toHaveBeenCalledOnce());
    expect(finished).not.toHaveBeenCalled();
    closed.resolve();
    await closing;
    expect(finished).toHaveBeenCalledOnce();
    expect(f.input.readRoster).not.toHaveBeenCalled();
  } finally {
    closed.resolve();
  }
});

it('invalidates the original platform release even when the version ID stays the same', async () => {
  const f = fixture();
  f.input.readTarget.mockResolvedValue({
    ...target(first),
    platformRevisionId: id(9),
  });
  const gate = latch();
  f.input.port.prepare.mockImplementationOnce(async () => {
    await gate.promise;
    return 'deferred';
  });
  f.start();
  try {
    await vi.waitFor(() => expect(f.input.port.prepare).toHaveBeenCalledOnce());
    const guard = f.input.port.prepare.mock.calls[0]![1];
    f.input.readTarget.mockResolvedValue(target(first));
    f.subscribers[0]?.changed(hint('allrice_employee_version_sources'));
    await vi.waitFor(() => expect(guard.signal.aborted).toBe(true));
    await expect(guard.assertCurrent()).rejects.toThrow('AUTHORITY_CHANGED');
  } finally {
    gate.resolve();
  }
});

it('reports unknown version provenance and skips disk work without stopping the roster', async () => {
  const f = fixture();
  f.page.mockReturnValueOnce({ personIds: [first, second], nextOffset: null });
  f.input.readTarget.mockResolvedValueOnce('version-source-unverified');
  f.start();
  await vi.waitFor(() => expect(f.input.port.prepare).toHaveBeenCalledOnce());
  expect(f.input.port.prepare.mock.calls[0]?.[0].personId).toBe(second);
  expect(f.input.foregroundBusy).not.toHaveBeenCalledWith(
    first,
    expect.anything(),
  );
  expect(f.input.observe).toHaveBeenCalledExactlyOnceWith(
    'version-source-unverified',
  );
});
