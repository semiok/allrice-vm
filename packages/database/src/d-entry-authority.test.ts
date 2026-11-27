import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import {
  createDEntryAuthorityFeed,
  DEntryTicketObserverClosed,
  watchDEntryNativeAuthority,
  watchDEntryNativeRosterAuthority,
  watchDEntryHistoryAuthority,
  watchDEntryIdentityAuthority,
  watchDEntryPrincipalAuthority,
} from './d-entry-authority.ts';

type ClientDouble = EventEmitter & {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};
const state = vi.hoisted(() => ({
  clients: [] as ClientDouble[],
  identity: vi.fn(),
  history: vi.fn(),
  read: vi.fn(),
}));
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Client: class extends EventEmitter {
      constructor() {
        super();
        state.clients.push(this);
      }
      connect = vi.fn(async () => {});
      query = vi.fn(async () => {});
      end = vi.fn(async () => {
        this.emit('end');
      });
    },
  };
});
vi.mock('./core/client.ts', () => ({
  getDatabase: () => state.read,
  registerDatabaseCloseHook: vi.fn(),
}));
vi.mock('./d-entry.ts', () => ({
  requireDEntryNativeIdentity: state.identity,
  resolveDEntryIdentity: state.history,
}));
vi.mock('./workspace/service.ts', () => ({
  getSessionExecutionGeneration: vi.fn(async () => '4.0'),
}));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const identity: DEntryIdentity = {
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  personId: randomUUID(),
  employeeInstanceId: randomUUID(),
  employeeRevision: 1,
  employeeVersionId: randomUUID(),
  threadId: randomUUID(),
};
const context: RequestContext = {
  requestId: randomUUID(),
  sessionId: randomUUID(),
  actor: { type: 'user', id: identity.personId },
  organizationId: identity.organizationId,
  workspaceId: identity.workspaceId,
  memberships: [],
  authenticatedAt: new Date().toISOString(),
};
const selection = {
  workspaceId: identity.workspaceId,
  employeeInstanceId: identity.employeeInstanceId,
  threadId: identity.threadId,
};
const feeds: ReturnType<typeof createDEntryAuthorityFeed>[] = [];
beforeEach(() => {
  state.clients = [];
  state.identity.mockReset().mockResolvedValue(identity);
  state.history.mockReset().mockResolvedValue(identity);
  state.read
    .mockReset()
    .mockResolvedValue([
      { schema: 'isolated', expires_at: new Date(Date.now() + 60_000) },
    ]);
});
afterEach(async () => {
  for (const feed of feeds.splice(0)) await feed.close();
});
const feed = () => {
  const value = createDEntryAuthorityFeed(
    'postgres://test.invalid/not-connected',
  );
  feeds.push(value);
  return value;
};

describe('authority subscription lifecycle (driver double; not PG commit proof)', () => {
  it('fences native page follow synchronously on matching authority and VM hints', async () => {
    const watcher = await watchDEntryNativeAuthority(
      context,
      selection,
      identity,
      new AbortController().signal,
      feed(),
    );
    try {
      const fenced = vi.fn();
      const detach = watcher.observation!.subscribe(fenced);
      const client = state.clients[0]!;
      const hint = (table: string, id: string) =>
        client.emit('notification', {
          channel: 'allrice_d_entry_authority',
          payload: JSON.stringify({
            schema: 'isolated',
            table,
            id,
            personId: identity.personId,
            organizationId: identity.organizationId,
            workspaceId: identity.workspaceId,
          }),
        });
      hint('allrice_sessions', randomUUID());
      expect(fenced).not.toHaveBeenCalled();
      const before = state.identity.mock.calls.length;
      hint('allrice_sessions', context.sessionId);
      expect(fenced).toHaveBeenCalledOnce();
      expect(state.identity).toHaveBeenCalledTimes(before);
      client.emit('notification', {
        channel: 'allrice_person_vm_admission',
        payload: identity.personId,
      });
      expect(fenced).toHaveBeenCalledTimes(2);
      detach();
      hint('allrice_sessions', context.sessionId);
      expect(fenced).toHaveBeenCalledTimes(2);
      client.emit('end');
      expect(watcher.revoked.aborted).toBe(true);
    } finally {
      await watcher.close();
    }
  });

  it('distinguishes the closed original ticket observer from revoked authority during a thread observation', async () => {
    const source = feed();
    const observed = deferred();
    const resume = deferred();
    vi.spyOn(source, 'observeThroughCommit').mockImplementationOnce(
      async () => {
        observed.resolve();
        await resume.promise;
      },
    );
    const signal = new AbortController().signal;
    const owner = await watchDEntryNativeAuthority(
      context,
      selection,
      identity,
      signal,
      source,
      async () => {},
    );
    const pending = owner.assertTicketThread!(signal);
    try {
      await Promise.race([observed.promise, pending]);
      await owner.close();
      expect(owner.revoked.aborted).toBe(false);
    } finally {
      resume.resolve();
      await Promise.allSettled([pending]);
      await owner.close();
    }
    await expect(pending).rejects.toBeInstanceOf(DEntryTicketObserverClosed);
    await expect(owner.assertTicketThread!(signal)).rejects.toMatchObject({
      code: 'authorization_denied',
    });
  });

  it('retires a stuck marker connection at the deadline and waits for the actual query to settle', async () => {
    const source = feed();
    const controller = new AbortController();
    const lost = vi.fn();
    const detach = await source.subscribe(
      { changed: vi.fn(), lost },
      controller.signal,
    );
    const client = state.clients[0]!;
    const query = deferred();
    client.query.mockImplementationOnce(() => query.promise);
    vi.useFakeTimers();
    try {
      let finished = false;
      const reading = source
        .observeThroughCommit(controller.signal)
        .finally(() => {
          finished = true;
        });
      const rejected = expect(reading).rejects.toThrow(
        'D_ENTRY_AUTHORITY_FENCE_TIMEOUT',
      );
      await vi.advanceTimersByTimeAsync(3000);
      expect(lost).toHaveBeenCalledOnce();
      expect(client.end).toHaveBeenCalledOnce();
      expect(finished).toBe(false);
      query.resolve();
      await rejected;
    } finally {
      query.resolve();
      vi.useRealTimers();
      detach();
    }
  });
  it('revokes an optional pinned grant revision even when the identity has been restored', async () => {
    const original = new AbortController().signal;
    const verify = vi.fn(async () => {});
    const watch = await watchDEntryNativeAuthority(
      context,
      selection,
      identity,
      original,
      feed(),
      verify,
    );
    try {
      expect(verify).toHaveBeenCalledOnce();
      const stale = Error('accepted authority revision changed');
      verify.mockRejectedValueOnce(stale);
      state.clients[0]!.emit('notification', {
        channel: 'allrice_d_entry_authority',
        payload: JSON.stringify({
          schema: 'isolated',
          table: 'allrice_memberships',
          id: randomUUID(),
          personId: identity.personId,
          organizationId: identity.organizationId,
          workspaceId: identity.workspaceId,
        }),
      });
      await vi.waitFor(() => expect(watch.revoked.reason).toBe(stale));
      expect(state.identity).toHaveBeenCalledTimes(2);
    } finally {
      await watch.close();
    }
  });
  it('settles whole-roster and VM hints before delivery without rereading on quiet frames', async () => {
    const signal = new AbortController().signal;
    const source = feed();
    const verify = vi.fn(async () => {});
    const binding = vi.fn(async () => {});
    const watch = await watchDEntryNativeRosterAuthority(
      context,
      selection,
      identity,
      signal,
      { verifyRoster: verify, verifyBinding: binding },
      source,
    );
    try {
      await watch.assertObserved(signal);
      await watch.assertObserved(signal);
      expect(verify).toHaveBeenCalledTimes(1);
      const client = state.clients[0]!;
      client.emit('notification', {
        channel: 'allrice_person_vm_admission',
        payload: identity.personId,
      });
      client.emit('notification', {
        channel: 'allrice_person_vm_admission',
        payload: identity.personId,
      });
      await watch.assertObserved(signal);
      expect(binding).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledTimes(1);
      verify.mockRejectedValueOnce(Error('published roster no longer current'));
      client.emit('notification', {
        channel: 'allrice_d_entry_authority',
        payload: JSON.stringify({
          schema: 'isolated',
          table: 'allrice_employee_instances',
          id: randomUUID(),
          organizationId: identity.organizationId,
          workspaceId: randomUUID(),
          personId: identity.personId,
        }),
      });
      await expect(watch.assertObserved(signal)).rejects.toThrow(
        'published roster no longer current',
      );
      expect(watch.revoked.aborted).toBe(true);
    } finally {
      await watch.close();
    }
  });

  it('fences in-flight delivery on an exact VM binding change', async () => {
    const signal = new AbortController().signal;
    const verifyBinding = vi.fn(async () => {
      throw Error('expected VM binding changed');
    });
    const watch = await watchDEntryNativeRosterAuthority(
      context,
      selection,
      identity,
      signal,
      { verifyRoster: vi.fn(async () => {}), verifyBinding },
      feed(),
    );
    try {
      state.clients[0]!.emit('notification', {
        channel: 'allrice_person_vm_admission',
        payload: randomUUID(),
      });
      await watch.assertObserved(signal);
      expect(verifyBinding).not.toHaveBeenCalled();
      state.clients[0]!.emit('notification', {
        channel: 'allrice_person_vm_admission',
        payload: identity.personId,
      });
      await expect(watch.assertObserved(signal)).rejects.toThrow(
        'expected VM binding changed',
      );
      expect(watch.revoked.aborted).toBe(true);
    } finally {
      await watch.close();
    }
  });

  it('coalesces genuine roster changes and scopes login, user and thread hints before taking roster locks', async () => {
    const signal = new AbortController().signal;
    const source = feed();
    const verifyRoster = vi.fn(async () => {});
    const verifyBinding = vi.fn(async () => {});
    const watch = await watchDEntryNativeRosterAuthority(
      context,
      selection,
      identity,
      signal,
      { verifyRoster, verifyBinding },
      source,
    );
    const client = state.clients[0]!;
    const change = (value: Record<string, string | null>) =>
      client.emit('notification', {
        channel: 'allrice_d_entry_authority',
        payload: JSON.stringify({
          schema: 'isolated',
          id: null,
          personId: null,
          organizationId: null,
          workspaceId: null,
          ...value,
        }),
      });
    try {
      change({ table: 'allrice_users', id: randomUUID() });
      change({ table: 'allrice_organizations', id: randomUUID() });
      change({
        table: 'allrice_employee_assignments',
        personId: randomUUID(),
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
      });
      change({
        table: 'allrice_employee_instances',
        id: identity.employeeInstanceId,
        personId: identity.personId,
        schema: 'other',
      });
      change({
        table: 'allrice_sessions',
        id: randomUUID(),
        personId: identity.personId,
      });
      change({
        table: 'allrice_chat_sessions',
        id: randomUUID(),
        personId: identity.personId,
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
      });
      await watch.assertObserved(signal);
      expect(state.identity).toHaveBeenCalledTimes(1);
      expect(verifyRoster).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 8; i++)
        change({
          table: 'allrice_sessions',
          id: context.sessionId,
          personId: identity.personId,
        });
      await watch.assertObserved(signal);
      expect(state.identity).toHaveBeenCalledTimes(2);
      expect(verifyRoster).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 8; i++)
        change({
          table: 'allrice_employee_instances',
          id: randomUUID(),
          personId: identity.personId,
          organizationId: identity.organizationId,
          workspaceId: randomUUID(),
        });
      await watch.assertObserved(signal);
      expect(state.identity).toHaveBeenCalledTimes(3);
      expect(verifyRoster).toHaveBeenCalledTimes(2);
      expect(verifyBinding).not.toHaveBeenCalled();

      verifyRoster.mockRejectedValueOnce(Error('sibling cohort withdrew'));
      change({ table: 'allrice_settings' });
      await expect(watch.assertObserved(signal)).rejects.toThrow(
        'sibling cohort withdrew',
      );
      expect(watch.revoked.reason).toMatchObject({
        message: 'sibling cohort withdrew',
      });
      expect(state.identity).toHaveBeenCalledTimes(4);
      expect(verifyRoster).toHaveBeenCalledTimes(3);
    } finally {
      await watch.close();
    }
  });

  it.each(['native', 'history'] as const)(
    'LISTENs before rechecking and joins an in-flight notification recheck when closing the subscription (%s)',
    async (access) => {
      const watchAuthority =
        access === 'history'
          ? watchDEntryHistoryAuthority
          : watchDEntryNativeAuthority;
      const currentIdentity =
        access === 'history' ? state.history : state.identity;
      const source = feed();
      const watch = await watchAuthority(
        context,
        selection,
        identity,
        new AbortController().signal,
        source,
      );
      if (access === 'history') {
        expect(state.history).toHaveBeenCalledWith(
          context,
          selection,
          'history',
        );
        expect(state.identity).not.toHaveBeenCalled();
      }
      const client = state.clients[0]!;
      expect(client.query).toHaveBeenCalledWith(
        'LISTEN allrice_d_entry_authority',
      );
      expect(client.query.mock.invocationCallOrder[0]).toBeLessThan(
        currentIdentity.mock.invocationCallOrder[0]!,
      );
      const entered = deferred(),
        settle = deferred();
      currentIdentity.mockImplementationOnce(async () => {
        entered.resolve();
        await settle.promise;
        return identity;
      });
      client.emit('notification', {
        channel: 'allrice_d_entry_authority',
        payload: JSON.stringify({
          schema: 'isolated',
          table: 'allrice_memberships',
          id: randomUUID(),
          organizationId: identity.organizationId,
          workspaceId: identity.workspaceId,
          personId: identity.personId,
        }),
      });
      await entered.promise;
      let joined = false;
      const closing = watch.close().then(() => {
        joined = true;
      });
      await Promise.resolve();
      expect(joined).toBe(false);
      settle.resolve();
      await closing;
      expect(watch.revoked.aborted).toBe(false); // A hint does not itself revoke.
      const before = currentIdentity.mock.calls.length;
      client.emit('notification', {
        channel: 'allrice_d_entry_authority',
        payload: '{}',
      });
      await Promise.resolve();
      expect(currentIdentity).toHaveBeenCalledTimes(before);
    },
  );

  it.each(['native', 'history'] as const)(
    'aborts idle subscribers immediately on driver error and awaits the actual connection end promise (%s)',
    async (access) => {
      const watchAuthority =
        access === 'history'
          ? watchDEntryHistoryAuthority
          : watchDEntryNativeAuthority;
      const source = feed(),
        watch = await watchAuthority(
          context,
          selection,
          identity,
          new AbortController().signal,
          source,
        );
      const client = state.clients[0]!,
        ended = deferred(),
        failure = Error('notification connection lost');
      client.end.mockImplementationOnce(async () => {
        await ended.promise;
        client.emit('end');
      });
      client.emit('error', failure);
      expect(watch.revoked.reason).toBe(failure);
      let closed = false;
      const closing = source.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      ended.resolve();
      await closing;
      await watch.close();
      expect(client.end).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['native', 'history'] as const)(
    'fails setup when current rights change after LISTEN and never caches permission from the notification payload (%s)',
    async (access) => {
      const watchAuthority =
        access === 'history'
          ? watchDEntryHistoryAuthority
          : watchDEntryNativeAuthority;
      const currentIdentity =
        access === 'history' ? state.history : state.identity;
      const source = feed(),
        denied = Error('current SQL authority denied');
      currentIdentity.mockRejectedValueOnce(denied);
      await expect(
        watchAuthority(
          context,
          selection,
          identity,
          new AbortController().signal,
          source,
        ),
      ).rejects.toBe(denied);
      expect(state.read).not.toHaveBeenCalled();
    },
  );
});

describe('named principal current guards (driver double; not PG commit proof)', () => {
  it('no-thread identity uses the original history identity source without native/execute or thread generation reads', async () => {
    const expected = { ...identity, threadId: null };
    state.history.mockResolvedValue(expected);
    const source = feed();
    const watch = await watchDEntryIdentityAuthority(
      context,
      {
        workspaceId: identity.workspaceId,
        employeeInstanceId: identity.employeeInstanceId,
      },
      expected,
      new AbortController().signal,
      source,
    );
    expect(state.identity).not.toHaveBeenCalled();
    expect(state.history).toHaveBeenCalledWith(
      context,
      {
        workspaceId: identity.workspaceId,
        employeeInstanceId: identity.employeeInstanceId,
      },
      'history',
    );
    await watch.assertCurrent(new AbortController().signal);
    expect(state.history).toHaveBeenCalledTimes(2);
    await watch.close();
    await expect(
      watch.assertCurrent(new AbortController().signal),
    ).rejects.toBeDefined();
  });

  it.each(['history', 'execute'] as const)(
    'uses only the existing authoritative reader for %s and rechecks on each call',
    async (access) => {
      const source = feed();
      const watch = await watchDEntryPrincipalAuthority(
        context,
        selection,
        identity,
        access,
        new AbortController().signal,
        source,
      );
      const reader = access === 'execute' ? state.identity : state.history;
      const unrelated = access === 'execute' ? state.history : state.identity;
      expect(reader).toHaveBeenCalledOnce();
      expect(unrelated).not.toHaveBeenCalled();
      await watch.assertCurrent(new AbortController().signal);
      expect(reader).toHaveBeenCalledTimes(2);
      expect(unrelated).not.toHaveBeenCalled();
      reader.mockRejectedValueOnce(Error('original membership revoked'));
      await expect(
        watch.assertCurrent(new AbortController().signal),
      ).rejects.toThrow('original membership revoked');
      expect(watch.revoked.aborted).toBe(true);
      await watch.close();
    },
  );

  it('joins a guard appended during an already pending notification read, and close joins its actual chain', async () => {
    const source = feed();
    const watch = await watchDEntryPrincipalAuthority(
      context,
      selection,
      identity,
      'execute',
      new AbortController().signal,
      source,
    );
    const firstEntered = deferred(),
      firstRelease = deferred(),
      secondEntered = deferred(),
      secondRelease = deferred();
    state.identity.mockImplementationOnce(async () => {
      firstEntered.resolve();
      await firstRelease.promise;
      return identity;
    });
    state.identity.mockImplementationOnce(async () => {
      secondEntered.resolve();
      await secondRelease.promise;
      return identity;
    });
    const checking = watch.assertCurrent(new AbortController().signal);
    void checking.catch(() => {});
    await firstEntered.promise;
    state.clients[0]!.emit('notification', {
      channel: 'allrice_d_entry_authority',
      payload: JSON.stringify({
        schema: 'isolated',
        table: 'allrice_memberships',
        id: null,
        organizationId: identity.organizationId,
        workspaceId: identity.workspaceId,
        personId: identity.personId,
      }),
    });
    firstRelease.resolve();
    await secondEntered.promise;
    let currentFinished = false,
      closeFinished = false;
    void checking.then(
      () => {
        currentFinished = true;
      },
      () => {
        currentFinished = true;
      },
    );
    const closing = watch.close().then(() => {
      closeFinished = true;
    });
    await Promise.resolve();
    expect(currentFinished).toBe(false);
    expect(closeFinished).toBe(false);
    secondRelease.resolve();
    await closing;
    await expect(checking).rejects.toBeDefined();
    expect(state.identity).toHaveBeenCalledTimes(3);
  });

  it('rejects a caller cancelled during a real current read after that read settles, without granting from stale output', async () => {
    const source = feed(),
      caller = new AbortController();
    const watch = await watchDEntryPrincipalAuthority(
      context,
      selection,
      identity,
      'history',
      new AbortController().signal,
      source,
    );
    const entered = deferred(),
      release = deferred();
    state.history.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return identity;
    });
    const check = watch.assertCurrent(caller.signal);
    void check.catch(() => {});
    await entered.promise;
    caller.abort(Error('request closed'));
    let settled = false;
    void check.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await expect(check).rejects.toThrow('request closed');
    expect(watch.revoked.aborted).toBe(false);
    await watch.close();
  });

  it('fences idle principal scopes synchronously on feed loss and refuses stale SQL identity output', async () => {
    const source = feed();
    const watch = await watchDEntryPrincipalAuthority(
      context,
      selection,
      identity,
      'execute',
      new AbortController().signal,
      source,
    );
    const entered = deferred(),
      release = deferred();
    state.identity.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return identity;
    });
    const check = watch.assertCurrent(new AbortController().signal);
    void check.catch(() => {});
    await entered.promise;
    state.clients[0]!.emit('error', Error('authority connection lost'));
    expect(watch.revoked.aborted).toBe(true);
    release.resolve();
    await expect(check).rejects.toThrow('authority connection lost');
    await watch.close();
  });

  it('uses the original session expiry rather than a cache TTL', async () => {
    vi.useFakeTimers();
    try {
      const source = feed();
      state.read.mockResolvedValueOnce([
        { schema: 'isolated', expires_at: new Date(Date.now() + 10) },
      ]);
      const watch = await watchDEntryPrincipalAuthority(
        context,
        selection,
        identity,
        'execute',
        new AbortController().signal,
        source,
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(watch.revoked.aborted).toBe(true);
      await expect(
        watch.assertCurrent(new AbortController().signal),
      ).rejects.toBeDefined();
      await watch.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
