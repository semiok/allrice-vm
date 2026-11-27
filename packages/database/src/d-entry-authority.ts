import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DEntrySelectionInputSchema,
  UuidSchema,
  sameDEntryIdentity,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase, registerDatabaseCloseHook } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  requireDEntryNativeIdentity,
  resolveDEntryIdentity,
} from './d-entry.ts';
import { getSessionExecutionGeneration } from './workspace/service.ts';

export const dEntryAuthorityChannel = 'allrice_d_entry_authority';
const personVmAdmissionChannel = 'allrice_person_vm_admission';
const ticketFenceChannel = 'allrice_d_entry_ticket_fence';
const changeSchema = z.object({
  schema: z.string(),
  table: z.string(),
  id: z.string().nullable(),
  organizationId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  personId: z.string().nullable(),
});
type Change = z.infer<typeof changeSchema>;
type Subscription = {
  changed(change: Change): void;
  lost(error: unknown): void;
};

/** One process-owned notification connection, not a permission cache. The
 * public pg error/end events fence subscribers at disconnect, before reconnect
 * could hide a missed notification. A new request opens a new connection. */
export function createDEntryAuthorityFeed(databaseUrl: string) {
  const listeners = new Set<Subscription>();
  const fences = new Map<string, () => void>();
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'allrice-d-entry-authority',
    connectionTimeoutMillis: 5000, // Same database connect budget as the pool.
    query_timeout: 5000,
  });
  let unavailable: unknown;
  let failed = false;
  let closing: Promise<void> | undefined;
  const closeConnection = () => (closing ??= client.end());
  const lost = (error: unknown) => {
    if (failed) return;
    failed = true;
    unavailable = error;
    for (const listener of listeners) listener.lost(error);
    listeners.clear();
    void closeConnection().catch(() => {}); // The process close hook joins this promise.
  };
  client.on('error', lost);
  client.on('end', () => lost(Error('D_ENTRY_AUTHORITY_DISCONNECTED')));
  client.on('notification', (message) => {
    if (message.channel === ticketFenceChannel) {
      fences.get(message.payload ?? '')?.();
      return;
    }
    if (
      message.channel !== dEntryAuthorityChannel &&
      message.channel !== personVmAdmissionChannel
    )
      return;
    try {
      const change =
        message.channel === dEntryAuthorityChannel
          ? changeSchema.parse(JSON.parse(message.payload ?? ''))
          : {
              schema: '*',
              table: 'person_virtual_machines',
              id: null,
              organizationId: null,
              workspaceId: null,
              personId: UuidSchema.parse(message.payload),
            };
      for (const listener of listeners) listener.changed(change);
    } catch (error) {
      lost(error); // An unparseable authority announcement is not safe to ignore.
    }
  });
  const ready = (async () => {
    await client.connect();
    await client.query(`LISTEN ${dEntryAuthorityChannel}`);
    await client.query(`LISTEN ${personVmAdmissionChannel}`);
    await client.query(`LISTEN ${ticketFenceChannel}`);
    if (failed) throw unavailable;
  })();
  void ready.catch(lost);
  return {
    async observeThroughCommit(signal: AbortSignal) {
      signal.throwIfAborted();
      if (failed) throw unavailable;
      const marker = randomUUID();
      let cancel!: () => void;
      let timedOut!: () => void;
      const seen = new Promise<void>((resolve, reject) => {
        cancel = () => reject(signal.reason);
        timedOut = () => {
          const failure = new Error('D_ENTRY_AUTHORITY_FENCE_TIMEOUT');
          reject(failure);
          // A stuck marker means the shared connection cannot prove it has
          // observed commits. Retire this connection and release queued work.
          lost(failure);
        };
        signal.addEventListener('abort', cancel, { once: true });
        fences.set(marker, resolve);
      });
      void seen.catch(() => {});
      const timer = setTimeout(timedOut, 3000);
      timer.unref();
      try {
        // The same listener receives its own committed marker after all
        // earlier committed authority changes, even across channels.
        await client.query('select pg_notify($1,$2)', [
          ticketFenceChannel,
          marker,
        ]);
        await seen;
        signal.throwIfAborted();
      } finally {
        clearTimeout(timer);
        fences.delete(marker);
        signal.removeEventListener('abort', cancel);
      }
    },
    async subscribe(listener: Subscription, signal: AbortSignal) {
      const cancel = () => listener.lost(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        // Cancellation does not abandon a pending database connect/LISTEN.
        // Its actual promise still settles before the caller leaves setup.
        await ready;
        signal.throwIfAborted();
        if (failed) throw unavailable;
        listeners.add(listener);
        return () => listeners.delete(listener);
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },
    get available() {
      return !failed;
    },
    close() {
      lost(Error('D_ENTRY_AUTHORITY_CLOSED'));
      return closeConnection();
    },
  };
}
type Feed = ReturnType<typeof createDEntryAuthorityFeed>;
const feeds = new Set<Feed>(); // Only connections to join at process shutdown.
let currentFeed: Feed | undefined;
function defaultFeed() {
  if (!currentFeed?.available) {
    const url = process.env.DATABASE_URL;
    if (!url) throw Error('DATABASE_URL is required');
    currentFeed = createDEntryAuthorityFeed(url);
    feeds.add(currentFeed);
  }
  return currentFeed;
}
export async function closeDEntryAuthorityFeeds() {
  const results = await Promise.allSettled(
    [...feeds].map((feed) => feed.close()),
  );
  feeds.clear();
  currentFeed = undefined;
  const errors = results.flatMap((r) =>
    r.status === 'rejected' ? [r.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(errors, 'Authority connection close is unknown');
}
registerDatabaseCloseHook(closeDEntryAuthorityFeeds);

/** Host-only notification hint. The receiver still proves a committed archive
 * for its precise employee before taking any action on a native owner. */
export async function subscribeDEntryEmployeeArchive(
  scope: Pick<DEntryIdentity, 'organizationId' | 'personId'>,
  changed: (employeeInstanceId: string | null) => Promise<void>,
  signal: AbortSignal,
) {
  const pending = new Set<Promise<void>>();
  let unsubscribe: (() => void) | undefined;
  let retry: NodeJS.Timeout | undefined;
  let closing = false;
  const stopped = () => closing || signal.aborted;
  function tracked(run: () => Promise<void>) {
    const operation = Promise.resolve().then(run);
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => {
        pending.delete(operation);
        recover();
      },
    );
  }
  function recover() {
    if (retry || stopped()) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (!stopped())
        tracked(async () => {
          await attach();
          if (!stopped()) await changed(null); // Reconcile commits missed on the old feed.
        });
    }, 2000);
    retry.unref();
  }
  async function attach() {
    const stop = await defaultFeed().subscribe(
      {
        changed(change) {
          if (
            !stopped() &&
            change.table === 'allrice_employee_instances' &&
            change.organizationId === scope.organizationId &&
            change.personId === scope.personId &&
            change.id
          ) {
            const id = change.id;
            tracked(() => changed(id));
          }
        },
        lost: recover,
      },
      signal,
    );
    unsubscribe?.();
    if (stopped()) stop();
    else unsubscribe = stop;
  }
  await attach();
  return async () => {
    closing = true;
    clearTimeout(retry);
    unsubscribe?.();
    await Promise.allSettled([...pending]);
  };
}

export async function confirmDEntryEmployeeArchive(
  identity: Omit<DEntryIdentity, 'threadId' | 'employeeVersionId'>,
) {
  const [row] = await getDatabase()<{ archived: boolean }[]>`
    select exists (
      select 1 from allrice_employee_instances i
      join allrice_employee_instance_revisions r on r.instance_id=i.id
      where i.id=${identity.employeeInstanceId}
        and i.organization_id=${identity.organizationId}
        and i.workspace_id=${identity.workspaceId}
        and i.owner_id=${identity.personId}
        and r.revision > ${identity.employeeRevision}
        and r.operation='archive'
    ) as archived`;
  return row?.archived === true;
}

function affects(
  change: Change,
  context: RequestContext,
  identity: DEntryIdentity,
) {
  if (change.table === 'allrice_settings') return true; // Trigger selects this exact policy only.
  if (change.table === 'allrice_users') return change.id === identity.personId;
  if (change.table === 'allrice_sessions')
    return change.id === context.sessionId;
  if (change.table === 'allrice_organizations')
    return change.id === identity.organizationId;
  if (change.table === 'allrice_workspaces')
    return change.id === identity.workspaceId;
  if (
    change.organizationId &&
    change.organizationId !== identity.organizationId
  )
    return false;
  if (change.workspaceId && change.workspaceId !== identity.workspaceId)
    return false;
  if (change.personId && change.personId !== identity.personId) return false;
  if (change.table === 'allrice_employee_instances')
    return change.id === identity.employeeInstanceId;
  if (change.table === 'allrice_chat_sessions')
    return change.id === identity.threadId;
  return true;
}

function affectsRoster(change: Change, identity: DEntryIdentity) {
  const { table, id, organizationId, personId } = change;
  switch (table) {
    case 'allrice_settings': // The trigger publishes only d_entry_rollout_policy.
      return true;
    case 'allrice_users':
      return id === identity.personId;
    case 'allrice_organizations':
      return id === identity.organizationId;
    case 'allrice_workspaces':
    case 'allrice_platform_employee_tenant_assignments':
    case 'allrice_employee_version_sources':
    case 'allrice_employees':
      return organizationId === identity.organizationId;
    case 'allrice_memberships':
    case 'allrice_employee_assignments':
    case 'allrice_employee_instances':
      // Whole VM rosters cover eligible sibling workspaces. Older writers may
      // publish only the workspace during a deployment overlap.
      return (
        organizationId === identity.organizationId &&
        (!personId || personId === identity.personId)
      );
    case 'allrice_platform_employee_revisions':
      // These rows are platform-wide. Their current sources are rechecked
      // with each affected roster because the change has no tenant column.
      return true;
    default:
      return false;
  }
}

export type DEntryAuthorityObservation = Readonly<{
  // A hint fences delivery synchronously. Only the caller's full check can
  // qualify the same subscription again.
  subscribe(invalidate: () => void): () => void;
  observeThroughCommit(signal: AbortSignal): Promise<void>;
}>;

/** The original ticket observer was closed, independent of current authority. */
export class DEntryTicketObserverClosed extends DataAccessError {
  constructor() {
    super('authorization_denied');
  }
}

export type DEntryAuthoritySubscription = Readonly<{
  revoked: AbortSignal;
  readonly expiresAt: string;
  readonly observation?: DEntryAuthorityObservation;
  close(): Promise<void>;
}>;

export type DEntryPrincipalAuthoritySubscription = DEntryAuthoritySubscription &
  Readonly<{ assertCurrent(signal: AbortSignal): Promise<void> }>;

type ObservedAuthority = DEntryPrincipalAuthoritySubscription &
  Readonly<{
    assertObserved(signal: AbortSignal): Promise<void>;
    assertTicketThread?: (signal: AbortSignal) => Promise<void>;
  }>;
type NativeRosterChecks = Readonly<{
  verifyRoster(signal: AbortSignal): Promise<void>;
  verifyBinding(signal: AbortSignal): Promise<void>;
}>;

/** LISTEN is ready and the callback registered BEFORE this authoritative read.
 * A commit during setup either aborts the registered subscription or is seen
 * by the recheck. Never uses RequestContext's old membership/createdAt as TTL. */
async function watchDEntryAuthority(
  context: RequestContext,
  input: unknown,
  expected: DEntryIdentity,
  signal: AbortSignal,
  access: 'native' | 'history' | 'identity',
  feed?: Feed,
  nativeChecks?: NativeRosterChecks,
  verifyRevision?: (signal: AbortSignal) => Promise<void>,
): Promise<ObservedAuthority> {
  const selection = (
    access === 'history'
      ? DEntrySelectionInputSchema.extend({ threadId: UuidSchema })
      : DEntrySelectionInputSchema
  ).parse(input);
  signal.throwIfAborted();
  const source = feed ?? defaultFeed();
  const abort = new AbortController();
  const revoked = AbortSignal.any([signal, abort.signal]);
  let schema: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach: (() => unknown) | undefined;
  let stopped = false;
  let expiresAt = '';
  let checks = Promise.resolve();
  const observers = new Set<() => void>();
  const ticketThread = verifyRevision && expected.threadId;
  const invalidate = (error: unknown) => abort.abort(error);
  const recheck = async (roster: boolean) => {
    if (stopped) return;
    revoked.throwIfAborted();
    const identity =
      access === 'native'
        ? await requireDEntryNativeIdentity(context, selection)
        : await resolveDEntryIdentity(context, selection, 'history');
    if (
      access === 'history' &&
      (!identity.threadId ||
        (await getSessionExecutionGeneration(
          context,
          identity.workspaceId,
          identity.threadId,
        )) !== '4.0')
    )
      throw new DataAccessError('authorization_denied');
    const [session] = await getDatabase()<
      {
        schema: string;
        expires_at: Date;
      }[]
    >`select current_schema() as schema,s.expires_at
      from allrice_sessions s where s.id=${context.sessionId} and s.user_id=${identity.personId}
        and s.revoked_at is null and s.expires_at>clock_timestamp()`;
    if (!session || !sameDEntryIdentity(identity, expected))
      throw new DataAccessError('authorization_denied');
    schema = session.schema;
    await verifyRevision?.(revoked);
    if (roster) await nativeChecks?.verifyRoster(revoked);
    revoked.throwIfAborted();
    expiresAt = session.expires_at.toISOString();
    if (timer) clearTimeout(timer);
    // Actual session deadline, never session.created_at or an invented TTL.
    const deadline = session.expires_at.getTime();
    const expire = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        invalidate(new DataAccessError('authentication_required'));
      else {
        timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
        timer.unref();
      }
    };
    expire();
  };
  let authorityPending = false;
  let rosterPending = false;
  const enqueue = (roster: boolean) => {
    if (stopped) return;
    rosterPending ||= roster;
    if (authorityPending) return;
    authorityPending = true;
    checks = checks
      .then(async () => {
        authorityPending = false;
        const recheckRoster = rosterPending;
        rosterPending = false;
        await recheck(recheckRoster);
      })
      .catch(invalidate);
  };
  let bindingPending = false;
  const enqueueBinding = () => {
    if (!nativeChecks || stopped || bindingPending) return;
    bindingPending = true;
    checks = checks
      .then(async () => {
        bindingPending = false;
        if (stopped) return;
        revoked.throwIfAborted();
        await nativeChecks.verifyBinding(revoked);
        revoked.throwIfAborted();
      })
      .catch(invalidate);
  };
  const joinChecks = async () => {
    // A notification can append another real read while the preceding read is
    // settling. Join the whole chain, not only its first captured Promise.
    while (true) {
      const pending = checks;
      await pending;
      if (pending === checks) return;
    }
  };
  const close = async () => {
    stopped = true;
    detach?.();
    detach = undefined;
    observers.clear();
    if (timer) clearTimeout(timer);
    await joinChecks();
    if (timer) clearTimeout(timer); // A read already in flight may have armed it.
  };
  try {
    detach = await source.subscribe(
      {
        changed(change) {
          if (change.table === 'person_virtual_machines') {
            if (change.personId === expected.personId) {
              for (const observer of observers) observer();
              enqueueBinding();
            }
            return;
          }
          // NOTIFY is only a hint. Never grants/revokes authority from payload;
          // current SQL decides, including a permission change during setup.
          if (schema && change.schema !== schema) return;
          if (
            ticketThread &&
            change.table === 'allrice_chat_sessions' &&
            change.id === ticketThread &&
            affects(change, context, expected)
          ) {
            // This trigger names only authority fields, not title, pin or
            // native-root metadata. A restored thread needs a new ticket.
            invalidate(new DataAccessError('authorization_denied'));
            return;
          }
          const roster = !!nativeChecks && affectsRoster(change, expected);
          if (roster || affects(change, context, expected)) {
            for (const observer of observers) observer();
            enqueue(roster);
          }
        },
        lost: invalidate,
      },
      revoked,
    );
    enqueue(!!nativeChecks);
    await joinChecks();
    revoked.throwIfAborted();
    return {
      revoked,
      observation: {
        subscribe(invalidate) {
          revoked.throwIfAborted();
          if (stopped) throw new DataAccessError('authorization_denied');
          observers.add(invalidate);
          return () => observers.delete(invalidate);
        },
        observeThroughCommit(active) {
          return source.observeThroughCommit(
            AbortSignal.any([active, revoked]),
          );
        },
      },
      ...(ticketThread && {
        async assertTicketThread(active: AbortSignal) {
          if (stopped) throw new DEntryTicketObserverClosed();
          await source.observeThroughCommit(AbortSignal.any([active, revoked]));
          if (stopped) throw new DEntryTicketObserverClosed();
        },
      }),
      get expiresAt() {
        return expiresAt;
      },
      async assertObserved(active: AbortSignal) {
        active.throwIfAborted();
        await joinChecks();
        active.throwIfAborted();
        revoked.throwIfAborted();
        if (stopped) throw new DataAccessError('authorization_denied');
      },
      async assertCurrent(active: AbortSignal) {
        active.throwIfAborted();
        revoked.throwIfAborted();
        if (stopped) throw new DataAccessError('authorization_denied');
        enqueue(!!nativeChecks);
        await joinChecks();
        active.throwIfAborted();
        revoked.throwIfAborted();
        if (stopped) throw new DataAccessError('authorization_denied');
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** VM-live eligibility retains the execute and published-4.0 verifier. */
export function watchDEntryNativeAuthority(
  context: RequestContext,
  input: unknown,
  expected: DEntryIdentity,
  signal: AbortSignal,
  feed?: Feed,
  verifyRevision?: (signal: AbortSignal) => Promise<void>,
): Promise<
  DEntryAuthoritySubscription & Pick<ObservedAuthority, 'assertTicketThread'>
> {
  return watchDEntryAuthority(
    context,
    input,
    expected,
    signal,
    'native',
    feed,
    undefined,
    verifyRevision,
  );
}

/** Whole VM roster joins the same current-login observation. Notification
 * coverage includes sibling employees/workspaces, not other chat threads. */
export function watchDEntryNativeRosterAuthority(
  context: RequestContext,
  input: unknown,
  expected: DEntryIdentity,
  signal: AbortSignal,
  nativeChecks: NativeRosterChecks,
  feed?: Feed,
) {
  return watchDEntryAuthority(
    context,
    input,
    expected,
    signal,
    'native',
    feed,
    nativeChecks,
  );
}

/** History-only current identity; close joins this subscription's reads, not
 * the shared feed, attachment ACL owner or any long-lived native job. */
export function watchDEntryHistoryAuthority(
  context: RequestContext,
  input: unknown,
  expected: DEntryIdentity,
  signal: AbortSignal,
  feed?: Feed,
): Promise<DEntryAuthoritySubscription> {
  return watchDEntryAuthority(
    context,
    input,
    expected,
    signal,
    'history',
    feed,
  );
}

/** Selected business identity only; no thread/4.0, resource or execute grant. */
export function watchDEntryIdentityAuthority(
  context: RequestContext,
  input: unknown,
  expected: DEntryIdentity,
  signal: AbortSignal,
  feed?: Feed,
): Promise<DEntryPrincipalAuthoritySubscription> {
  return watchDEntryAuthority(
    context,
    input,
    expected,
    signal,
    'identity',
    feed,
  );
}

/** Same original readers and notification queue; no added authorization source.
 * The trusted server caller fixes access, never a browser-supplied permission. */
export function watchDEntryPrincipalAuthority(
  context: RequestContext,
  input: unknown,
  expected: DEntryIdentity,
  access: 'history' | 'execute',
  signal: AbortSignal,
  feed?: Feed,
): Promise<DEntryPrincipalAuthoritySubscription> {
  return watchDEntryAuthority(
    context,
    input,
    expected,
    signal,
    access === 'execute' ? 'native' : 'history',
    feed,
  );
}
