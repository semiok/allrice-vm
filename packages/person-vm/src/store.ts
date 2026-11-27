import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type postgres from 'postgres';
import {
  PersonVmError,
  type PersonVmBinding,
  type PersonVmEgressReceipt,
  type PersonVmView,
  type PersonVmHoldKind,
} from './contract.ts';
import type { PersonDisk } from './encrypted-disk.ts';
import type { DiskPoolLocks, DiskPoolOwner } from './disk-pool-platform.ts';
import type { PersonVmStartingScope } from './guest-bootstrap.ts';
import {
  recordPlatformVmDeletion,
  type PlatformVmDeletionAudit,
  type PlatformVmDeletionAuthorization,
  type PlatformVmDeletionRequest,
  type PlatformVmErasingDisk,
} from './platform-deletion.ts';

export type VmHold = {
  id: string;
  kind: PersonVmHoldKind;
  operationId: string;
};
export type VmRecord = {
  vmId: string;
  personId: string;
  organizationId: string;
  phase: PersonVmView['phase'];
  diskTier: 'warm' | 'cold';
  diskRetained: boolean;
  nativeCreated: boolean;
  instanceId: string | null;
  leaseEpoch: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  egressReceipt: PersonVmEgressReceipt | null;
  gatewayPorts: number[];
  holds: VmHold[];
  lastActivityAt: string;
  stoppedAt: string | null;
  idleSince: string | null;
  activityObservedAt: string | null;
};
export type VmAudit = {
  requestId: string;
  action: string;
  result: 'started' | 'succeeded' | 'failed' | 'denied';
  errorCode?: string;
};
export interface VmLease {
  row: VmRecord | null;
  joinedOfflinePreparation?: boolean;
  /** Loss cancels owned work; the holder still MUST join before releasing. */
  signal: AbortSignal;
  assertAdmissionOpen(generationChange?: boolean): Promise<void>;
  save(
    row: VmRecord,
    details?:
      | { audit?: VmAudit; capacityReleased?: boolean }
      | {
          deletionAudit: PlatformVmDeletionAudit;
          authorizeDeletion?: PlatformVmDeletionAuthorization;
        },
  ): Promise<void>;
  /** Returns whether the replaced generation had already released capacity. */
  reserveStartup?(row: VmRecord): Promise<boolean>;
  guard(expected?: DiskPoolOwner): Promise<void>;
  assertPhysicalOwner?(): Promise<void>;
  idleStopReceipt?(
    binding: PersonVmBinding,
  ): ReturnType<typeof readIdleStopReceipt>;
  hasPreviousUpgradeStop?(binding: PersonVmBinding): Promise<boolean>;
  hasUnjoinedIdleStop?(binding: PersonVmBinding): Promise<boolean>;
  hasCompletedDiskDeletion?(owner: DiskPoolOwner): Promise<boolean>;
  hasRetainedDiskRows?(vmIds: readonly string[]): Promise<boolean>;
  audit(row: VmRecord, event: VmAudit): Promise<void>;
  auditPlatformDeletion?(
    event: PlatformVmDeletionAudit,
    authorize?: PlatformVmDeletionAuthorization,
  ): Promise<void>;
  readPlatformErasingDisk?(): Promise<PlatformVmErasingDisk | undefined>;
  confirmRetainedDeletion?(): Promise<boolean>;
  claimDeletionCleanup?(): Promise<void>;
}
type VmLeaseOptions = {
  now: () => Date;
  ttlMs: number;
  deletionAction?: PlatformVmDeletionRequest['action'];
  offlinePreparation?: Readonly<{
    mode: 'prepare' | 'join';
    organizationId: string;
    signal: AbortSignal;
  }>;
};
export interface PersonVmStore {
  read(personId: string): Promise<VmRecord | null>;
  auditStartupFailure?(
    row: VmRecord,
    event: VmAudit,
    signal: AbortSignal,
  ): Promise<void>;
  withLease<T>(
    personId: string,
    options: VmLeaseOptions,
    work: (lease: VmLease) => Promise<T>,
  ): Promise<T>;
  recover<T>(
    personId: string,
    options: { now: () => Date; ttlMs: number; signal: AbortSignal },
    work: (lease: VmLease) => Promise<T>,
  ): Promise<T>;
}

function stateWithAudit(
  sql: postgres.Sql | postgres.TransactionSql,
  save: postgres.PendingQuery<postgres.Row[]>,
  event?: VmAudit,
  capacityReleased = false,
) {
  if (!event && !capacityReleased) return save;
  const result = event
    ? sql`insert into person_vm_audit
      (vm_id,person_id,organization_id,request_id,action,result,error_code,lease_epoch)
    select vm_id,person_id,organization_id,${event.requestId},${event.action},
      ${event.result},${event.errorCode ?? null},lease_epoch
    from saved returning vm_id`
    : sql`select vm_id from saved`;
  // Publish lifecycle state, any wake audit and confirmed capacity release
  // together. A metadata-only stop must leave its previous charge intact.
  return sql`with saved as (${save})
    ${
      capacityReleased
        ? sql`, released as (
      insert into person_vm_audit
        (vm_id,person_id,organization_id,request_id,action,result,lease_epoch)
      select vm_id,person_id,organization_id,${event?.requestId ?? randomUUID()},
        'capacity.release','succeeded',lease_epoch from saved
    )`
        : sql``
    }
    ${result}`;
}

function releasedVmCapacity(sql: postgres.ISql) {
  return sql`exists (
    select 1 from person_vm_audit a
    where a.vm_id=vm.vm_id and a.person_id=vm.person_id
      and a.organization_id=vm.organization_id and a.lease_epoch=vm.lease_epoch
      and a.result='succeeded'
      and (a.action='capacity.release' or (
        a.action='stop' and vm.phase in ('stopped','cold','deleted')
        and vm.stopped_at is not null and vm.egress_receipt is null
      ))
  )`;
}

async function physicalLeaseHolder(
  session: VmSqlSession,
  physical: string,
  marker: string,
) {
  const sql = session.client;
  const [row] = await session.query(
    () => sql`
    with keys as (select hashtextextended(${physical},0) as physical_key,
      hashtextextended(${marker},0) as marker_key),
    held as materialized (
      select pid, classid::bigint as hi, objid::bigint as lo from pg_locks
      where locktype='advisory' and objsubid=1 and granted and mode='ExclusiveLock'
        and database=(select oid from pg_database where datname=current_database())
    )
    select case when p.pid is null then 'none'
      when a.pid is null then 'other' else 'preparation' end as holder
    from keys
    left join held p on p.hi=((physical_key >> 32) & 4294967295) and p.lo=(physical_key & 4294967295)
    left join held a on a.pid=p.pid and a.hi=((marker_key >> 32) & 4294967295) and a.lo=(marker_key & 4294967295)`,
  );
  return row?.holder;
}

export type PersonVmLeaseOwner = Readonly<{
  personId: string;
  vmId: string;
  ownerToken: string;
  leaseEpoch: number;
}>;
/** MET-274 extension. Resolve only after old callbacks/commands cannot execute again. */
export interface PersonVmLeaseFencePort {
  confirmSettled(owner: PersonVmLeaseOwner, signal: AbortSignal): Promise<void>;
}

function isConnectionFailure(error: unknown): boolean {
  const code = String((error as { code?: string } | null)?.code ?? '');
  return (
    code.startsWith('CONNECTION_') ||
    code.startsWith('08') ||
    ['57P01', '57P02', '57P03', 'ECONNRESET', 'EPIPE'].includes(code) ||
    Boolean(
      error instanceof Error &&
      error.cause &&
      error.cause !== error &&
      isConnectionFailure(error.cause),
    )
  );
}

/** Return a NEW, unopened, exclusive max:1 client on every call. The store owns end(). */
export type PersonVmSqlFactory = () => postgres.Sql;

const usedClients = new WeakSet<postgres.Sql>();
function lostConnection() {
  return Object.assign(new Error('VM_STORE_CONNECTION_LOST'), {
    code: 'CONNECTION_CLOSED',
  });
}

// postgres.js 3.4.9 release() unconditionally reopens a reservation, and a fatal
// close can retain query/errorResponse until the next ReadyForQuery. Never reuse
// that client. A fresh dedicated client also makes onclose identify this session.
export class VmSqlSession {
  private readonly abort = new AbortController();
  get signal() {
    return this.abort.signal;
  }
  private failure: unknown;
  private disposing = false;
  private ending?: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly closed: Promise<void>;
  constructor(readonly client: postgres.Sql) {
    if (usedClients.has(client) || client.options.max !== 1)
      throw new Error('VM_STORE_REQUIRES_NEW_SINGLE_CONNECTION_CLIENT');
    usedClients.add(client);
    let notifyClosed!: () => void;
    this.closed = new Promise((resolve) => {
      notifyClosed = resolve;
    });
    this.invalidate = (error) => {
      this.failure ??= error;
      this.abort.abort(error);
      notifyClosed();
    };
    const previous = client.options.onclose;
    client.options.onclose = (id) => {
      if (!this.disposing) this.invalidate(lostConnection());
      previous?.(id);
    };
  }
  private readonly invalidate: (error: unknown) => void;
  get connectionFailure() {
    return this.failure;
  }
  async query<T>(operation: () => PromiseLike<T>): Promise<T> {
    if (this.failure) throw this.failure;
    if (this.disposing) throw lostConnection();
    const pending = Promise.resolve().then(() => {
      if (this.failure) throw this.failure;
      if (this.disposing) throw lostConnection();
      return operation();
    });
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    try {
      return await Promise.race([
        pending,
        this.closed.then(() => {
          throw this.failure;
        }),
      ]);
    } catch (error) {
      // FATAL can reject before onclose. Prevent failure audit/save from issuing
      // another query in that interval; physical VM cleanup can still proceed.
      if (isConnectionFailure(error)) this.invalidate(error);
      throw error;
    }
  }
  async end() {
    if (this.ending) return this.ending;
    this.disposing = true;
    // Close stops new steps, then joins the ACTUAL queries, not just their
    // connection-loss race. No transaction-library scope may outlive this owner.
    return (this.ending = (async () => {
      await Promise.allSettled([...this.pending]);
      await this.client.end({ timeout: 0 });
    })());
  }
}

async function readIdleStopReceipt(
  session: VmSqlSession,
  binding: PersonVmBinding,
) {
  const [record] = await session.query(
    () => session.client`
    select intent.request_id, completed.request_id is not null as completed
    from person_virtual_machines vm
    cross join lateral (
      select id, request_id, result from person_vm_audit
      where person_id=vm.person_id and organization_id=vm.organization_id
        and vm_id=vm.vm_id and lease_epoch=vm.lease_epoch
        and action='stop.idle-dispatch'
      order by id desc limit 1
    ) intent
    left join lateral (
      select request_id from person_vm_audit
      where person_id=vm.person_id and organization_id=vm.organization_id
        and vm_id=vm.vm_id and lease_epoch=vm.lease_epoch
        and id>intent.id and action='stop' and result='succeeded'
      order by id desc limit 1
    ) completed on true
    where vm.person_id=${binding.personId} and vm.organization_id=${binding.organizationId}
      and vm.vm_id=${binding.vmId} and vm.instance_id=${binding.instanceId}
      and vm.lease_epoch=${binding.leaseEpoch} and vm.phase<>'deleted'
          and vm.disk_retained and vm.native_created and intent.result='succeeded'
      and (completed.request_id is null or completed.request_id=intent.request_id)
  `,
  );
  return record
    ? {
        requestId: String(record.request_id),
        completed: record.completed === true,
      }
    : undefined;
}

async function hasUnjoinedIdleStop(
  session: VmSqlSession,
  binding: PersonVmBinding,
) {
  const [attempt] = await session.query(
    () => session.client`
    select a.result from person_virtual_machines vm
    join person_vm_audit a using (person_id, organization_id, vm_id, lease_epoch)
    where vm.person_id=${binding.personId} and vm.organization_id=${binding.organizationId}
      and vm.vm_id=${binding.vmId} and vm.instance_id=${binding.instanceId}
      and vm.lease_epoch=${binding.leaseEpoch} and a.action='stop.idle-dispatch'
    order by a.id desc limit 1`,
  );
  return attempt?.result === 'started';
}

async function hasPreviousUpgradeStop(
  session: VmSqlSession,
  binding: PersonVmBinding,
) {
  const [attempt] = await session.query(
    () => session.client`
    select a.result
    from person_virtual_machines vm
    join person_vm_audit a using (person_id, organization_id, vm_id, lease_epoch)
    where vm.person_id=${binding.personId} and vm.organization_id=${binding.organizationId}
      and vm.vm_id=${binding.vmId} and vm.instance_id=${binding.instanceId}
      and vm.lease_epoch=${binding.leaseEpoch} and vm.phase='failed'
      and a.action='stop.upgrade-dispatch' and a.result in ('started','succeeded')
      and (a.result='succeeded' or (
        select later.result from person_vm_audit later
        where later.vm_id=a.vm_id and later.person_id=a.person_id
          and later.organization_id=a.organization_id and later.lease_epoch=a.lease_epoch
          and later.action=a.action and later.request_id=a.request_id and later.id>a.id
        order by later.id limit 1
      ) is distinct from 'denied')
    order by a.id desc limit 1`,
  );
  // A denial cancels only the immediately preceding attempt, even when an
  // idempotent retry reuses the caller's request ID.
  return attempt?.result === 'started' || attempt?.result === 'succeeded';
}

function fromRow(row: Record<string, unknown>): VmRecord {
  const date = (value: unknown) => new Date(value as string).toISOString();
  return {
    vmId: String(row.vm_id),
    personId: String(row.person_id),
    organizationId: String(row.organization_id),
    phase: row.phase as VmRecord['phase'],
    diskTier: row.disk_tier as VmRecord['diskTier'],
    diskRetained: Boolean(row.disk_retained),
    nativeCreated: Boolean(row.native_created),
    instanceId: row.instance_id === null ? null : String(row.instance_id),
    leaseEpoch: Number(row.lease_epoch),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt:
      row.lease_expires_at === null ? null : date(row.lease_expires_at),
    egressReceipt: row.egress_receipt as VmRecord['egressReceipt'],
    gatewayPorts: row.gateway_ports as number[],
    holds: row.holds as VmHold[],
    lastActivityAt: date(row.last_activity_at),
    stoppedAt: row.stopped_at === null ? null : date(row.stopped_at),
    idleSince: row.idle_since === null ? null : date(row.idle_since),
    activityObservedAt:
      row.activity_observed_at === null ? null : date(row.activity_observed_at),
  };
}
export function bindingOf(row: VmRecord): PersonVmBinding {
  if (!row.instanceId) throw new PersonVmError('LEASE_LOST');
  return Object.freeze({
    vmId: row.vmId,
    personId: row.personId,
    organizationId: row.organizationId,
    instanceId: row.instanceId,
    leaseEpoch: row.leaseEpoch,
  });
}

function assertAdmissionStateOpen(row?: postgres.Row) {
  // Existing 0247 fixtures remain usable; admission composition requires 0250.
  const state = row?.admission_state as
    | {
        sourceId?: string;
        revoked?: string;
        round?: { released: string[]; stop: string };
      }
    | undefined;
  if (row?.admission_version && !state?.sourceId)
    throw new PersonVmError('LEASE_CONFLICT');
  if (
    state?.revoked ||
    (state?.round &&
      (state.round.released.length !== 2 ||
        !['none', 'confirmed'].includes(state.round.stop)))
  )
    throw new PersonVmError('LEASE_CONFLICT');
}

async function assertAdmissionOpen(
  session: VmSqlSession,
  personId: string,
  generationChange = false,
) {
  const [row] = await session.query(
    () => session.client`
    select * from person_virtual_machines where person_id=${personId}`,
  );
  assertAdmissionStateOpen(row);
  if (generationChange && row && 'admission_state' in row) {
    const [accepted] = await session.query(
      () => session.client`
      select count(*)::int as count from person_vm_admission_permits where person_id=${personId} and disposition<>'deferred'`,
    );
    if (Number(accepted?.count)) throw new PersonVmError('VM_ACTIVE');
  }
}

function insertVmAudit(
  sql: postgres.Sql | postgres.TransactionSql,
  row: VmRecord,
  event: VmAudit,
) {
  return sql`insert into person_vm_audit(vm_id,person_id,organization_id,request_id,action,result,error_code,lease_epoch)
    values(${row.vmId},${row.personId},${row.organizationId},${event.requestId},${event.action},${event.result},${event.errorCode ?? null},${row.leaseEpoch})`;
}

export class PostgresPersonVmStore implements PersonVmStore {
  // ownerToken -> personId. A claim whose COMMIT acknowledgement was lost may
  // leave either token durable; neither can authorize physical work until its
  // own callback/commands have settled.
  private readonly settledOrphans = new Map<string, string>();
  private readonly activeRecoveries = new Map<string, string>();
  constructor(
    private readonly openSql: PersonVmSqlFactory,
    private readonly fence?: PersonVmLeaseFencePort,
    private readonly maxResidentVms?: number,
  ) {
    if (
      maxResidentVms !== undefined &&
      (!Number.isSafeInteger(maxResidentVms) || maxResidentVms < 1)
    )
      throw new PersonVmError('PROVIDER_FAILED');
  }
  /** Admission and physical ownership must use the SAME trusted factory/DB.
   * Factories must not change database/schema between calls. No DSN is exposed. */
  assertAdmissionFactory(factory: PersonVmSqlFactory) {
    if (factory !== this.openSql) throw new PersonVmError('PROVIDER_FAILED');
  }
  async auditStartupFailure(
    row: VmRecord,
    event: VmAudit,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    // This insert must never sit ahead of teardown on the advisory-lock
    // connection. The diagnostic owns and closes its own short-lived client.
    const sql = this.openSql();
    let ending: Promise<void> | undefined;
    const end = () => (ending ??= sql.end({ timeout: 0 }));
    const abort = () => {
      void end().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await sql.begin(async (tx) => {
        signal.throwIfAborted();
        // A sent PostgreSQL statement can outlive local client shutdown.
        // Give the server its own deadline before dispatching the insert.
        await tx`set local statement_timeout = '200ms'`;
        signal.throwIfAborted();
        await insertVmAudit(tx, row, event);
      });
    } finally {
      signal.removeEventListener('abort', abort);
      await end();
    }
  }
  diskPoolLocks(namespace: string): DiskPoolLocks {
    return {
      withLock: async (kind, signal, work) => {
        signal.throwIfAborted();
        const session = new VmSqlSession(this.openSql());
        const sql = session.client;
        const active = AbortSignal.any([signal, session.signal]);
        const key = `person-vm:disk-pool:${kind}:${namespace}`;
        let locked = false;
        try {
          do {
            active.throwIfAborted();
            const [row] = await session.query(
              () =>
                sql`select pg_try_advisory_lock(hashtextextended(${key},0)) as locked`,
            );
            locked = row?.locked === true;
            if (!locked) {
              if (kind === 'fill') return undefined;
              await sleep(15, undefined, { signal: active });
            }
          } while (!locked);
          active.throwIfAborted();
          const result = await work({
            signal: active,
            ownerSignal: session.signal,
            assertOwned: async () => {
              await session.query(() => sql`select 1`);
            },
            async foregroundStarting() {
              // A recent start is a scheduling hint only. Physical ownership
              // and settlement never depend on this clock comparison.
              const [row] = await session.query(
                () => sql`
                select exists (select 1 from person_virtual_machines
                  where phase='starting' and lease_owner is not null
                    and lease_expires_at > statement_timestamp()) as busy`,
              );
              return row?.busy === true;
            },
          });
          active.throwIfAborted();
          return result;
        } finally {
          try {
            if (locked && !session.connectionFailure)
              await session.query(
                () =>
                  sql`select pg_advisory_unlock(hashtextextended(${key},0))`,
              );
          } finally {
            await session.end();
          }
        }
      },
    };
  }
  async read(personId: string) {
    const session = new VmSqlSession(this.openSql());
    try {
      const [row] = await session.query(
        () =>
          session.client`select * from person_virtual_machines where person_id=${personId}`,
      );
      return row ? fromRow(row) : null;
    } finally {
      await session.end();
    }
  }

  listUpgradeCandidates(signal: AbortSignal) {
    return this.lifecycleCandidates(signal, 'upgrade');
  }

  listJoinedIdleStopCandidates(signal: AbortSignal) {
    return this.lifecycleCandidates(signal, 'idle-recovery');
  }

  private async lifecycleCandidates(
    signal: AbortSignal,
    kind: 'upgrade' | 'idle-recovery',
  ) {
    signal.throwIfAborted();
    const sql = this.openSql();
    let ending: Promise<void> | undefined;
    const end = () => (ending ??= sql.end({ timeout: 0 }));
    const abort = () => {
      void end().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const rows = await sql.begin(async (tx) => {
        signal.throwIfAborted();
        await tx`set local statement_timeout = '2000ms'`;
        if (kind === 'upgrade')
          return tx`select * from person_virtual_machines
            where phase in ('running','starting') or lease_owner is not null
              or (phase='failed' and (native_created or egress_receipt is not null))
            order by person_id`;
        return tx`select vm.* from person_virtual_machines vm
          cross join lateral (
            select a.result from person_vm_audit a
            where a.vm_id=vm.vm_id and a.person_id=vm.person_id
              and a.organization_id=vm.organization_id and a.lease_epoch=vm.lease_epoch
              and a.action='stop.idle-dispatch'
            order by a.id desc limit 1
          ) idle
          where (vm.phase in ('running','failed')
              or (vm.phase in ('stopped','cold') and vm.lease_owner is not null))
            and vm.native_created and vm.disk_retained
            and vm.instance_id is not null and idle.result='succeeded'
            and (vm.lease_owner is null or vm.lease_expires_at<=now())
          order by vm.person_id`;
      });
      signal.throwIfAborted();
      return rows.map(fromRow);
    } finally {
      signal.removeEventListener('abort', abort);
      await end();
    }
  }

  async idleStopReceipt(binding: PersonVmBinding) {
    const session = new VmSqlSession(this.openSql());
    try {
      return await readIdleStopReceipt(session, binding);
    } finally {
      await session.end();
    }
  }

  async hasUnjoinedIdleStop(binding: PersonVmBinding) {
    const session = new VmSqlSession(this.openSql());
    try {
      return await hasUnjoinedIdleStop(session, binding);
    } finally {
      await session.end();
    }
  }

  /** Claim the existing physical lease, without admitting a business
   * operation or replacing the previous holder. The token remains a fence if
   * the PG connection closes before the exact guest probe has joined. */
  async withRetainedReadLease<T>(
    binding: PersonVmBinding,
    signal: AbortSignal,
    work: (
      scope: PersonVmStartingScope & Readonly<{ leaseOwner: string }>,
      disk: PersonDisk,
    ) => Promise<T>,
    mayClaim: () => boolean = () => true,
  ): Promise<T> {
    signal.throwIfAborted();
    const exact = Object.freeze({
      ...binding,
      personId: binding.personId.toLowerCase(),
    });
    const session = new VmSqlSession(this.openSql());
    const sql = session.client;
    const leaseOwner = randomUUID();
    const scopeEnded = new AbortController();
    const active = AbortSignal.any([signal, session.signal, scopeEnded.signal]);
    let lockHeld = false;
    let cleanupUnknown = false;
    const select = (
      db: postgres.Sql | postgres.TransactionSql,
      lock: boolean,
    ) => db`select *
      from person_virtual_machines where person_id=${exact.personId}
        and organization_id=${exact.organizationId} and vm_id=${exact.vmId}
        and instance_id=${exact.instanceId} and lease_epoch=${exact.leaseEpoch}
      ${lock ? db`for update` : db``}`;
    function readTier(
      row: postgres.Row | undefined,
      owner: string | null,
    ): PersonDisk['tier'] {
      if (
        !row ||
        row.phase !== 'running' ||
        !row.disk_retained ||
        !row.native_created ||
        row.lease_owner !== owner ||
        (row.disk_tier !== 'warm' && row.disk_tier !== 'cold')
      )
        throw new PersonVmError('LEASE_LOST');
      return row.disk_tier;
    }
    try {
      const [lock] = await session.query(
        () =>
          sql`select pg_try_advisory_lock(hashtextextended(${'person-vm:' + exact.personId},0)) as locked`,
      );
      if (!lock?.locked) throw new PersonVmError('LEASE_CONFLICT');
      lockHeld = true;
      const tier = await session.query(() =>
        sql.begin(async (tx) => {
          active.throwIfAborted();
          const [row] = await select(tx, true);
          const diskTier = readTier(row, null);
          if (!row || !('admission_state' in row))
            throw new PersonVmError('PROVIDER_FAILED');
          assertAdmissionStateOpen(row);
          if (!Array.isArray(row.holds) || row.holds.length)
            throw new PersonVmError('VM_ACTIVE');
          const [permits] = await tx`select exists (
          select 1 from person_vm_admission_permits
          where person_id=${exact.personId} and disposition<>'deferred'
        ) as busy`;
          if (permits?.busy !== false) throw new PersonVmError('VM_ACTIVE');
          active.throwIfAborted();
          if (!mayClaim()) throw new PersonVmError('VM_ACTIVE');
          await tx`update person_virtual_machines
          set lease_owner=${leaseOwner}, lease_expires_at=clock_timestamp() + interval '30 seconds'
          where person_id=${exact.personId}`;
          return diskTier;
        }),
      );
      const scope = Object.freeze({
        binding: exact,
        leaseOwner,
        signal: active,
        async assertCurrent() {
          active.throwIfAborted();
          const [row] = await session.query(() => select(sql, false));
          active.throwIfAborted();
          if (readTier(row, leaseOwner) !== tier)
            throw new PersonVmError('LEASE_LOST');
        },
      });
      await scope.assertCurrent();
      const result = await work(
        scope,
        Object.freeze({ vmId: exact.vmId, tier }),
      );
      await scope.assertCurrent();
      return result;
    } catch (error) {
      cleanupUnknown =
        error instanceof PersonVmError && error.code === 'CLEANUP_INCOMPLETE';
      throw error;
    } finally {
      scopeEnded.abort();
      try {
        if (lockHeld && !cleanupUnknown && !session.connectionFailure)
          await session.query(
            () => sql`update person_virtual_machines
            set lease_owner=null, lease_expires_at=null
            where person_id=${exact.personId} and lease_owner=${leaseOwner}`,
          );
      } finally {
        if (lockHeld && !cleanupUnknown && session.connectionFailure)
          this.settledOrphans.set(leaseOwner, exact.personId);
        await session.end();
      }
    }
  }
  async withLease<T>(
    requestedPersonId: string,
    options: VmLeaseOptions,
    work: (lease: VmLease) => Promise<T>,
  ) {
    const personId = requestedPersonId.toLowerCase();
    const preparation = options.offlinePreparation;
    preparation?.signal.throwIfAborted();
    const session = new VmSqlSession(this.openSql());
    const sql = session.client;
    const physical = 'person-vm:' + personId;
    const marker =
      preparation &&
      `person-vm:offline-preparation:${personId}:${preparation.organizationId}`;
    const active =
      preparation && AbortSignal.any([preparation.signal, session.signal]);
    const token = randomUUID();
    let locked = false;
    let joinedOfflinePreparation = false;
    const reviewOnly = options.deletionAction === 'review';
    let ownsDurable = !options.deletionAction;
    let bodyError: unknown;
    let result!: T;
    const expires = () =>
      new Date(options.now().getTime() + options.ttlMs).toISOString();
    const tryPhysical = async () => {
      const [row] = await session.query(
        () =>
          sql`select pg_try_advisory_lock(hashtextextended(${physical},0)) as locked`,
      );
      return row?.locked === true;
    };
    try {
      if (preparation?.mode === 'prepare') {
        // Publish the exact lane before attempting the ordinary lease. The
        // session holds it through actual settlement and closes it on every exit.
        const [row] = await session.query(
          () =>
            sql`select pg_try_advisory_lock(hashtextextended(${marker!},0)) as marked`,
        );
        if (!row?.marked) throw new PersonVmError('LEASE_CONFLICT');
      }
      active?.throwIfAborted();
      locked = await tryPhysical();
      active?.throwIfAborted();
      if (!locked && preparation?.mode === 'join') {
        const holder = await physicalLeaseHolder(session, physical, marker!);
        if (holder === 'preparation') {
          // Only the identified offline lane can make us wait. Once its gate
          // is shared, a new preparation cannot win it ahead of this attempt.
          for (;;) {
            active!.throwIfAborted();
            const [row] = await session.query(
              () =>
                sql`select pg_try_advisory_lock_shared(hashtextextended(${marker!},0)) as joined`,
            );
            if (row?.joined) break;
            try {
              await sleep(25, undefined, { signal: active });
            } catch (error) {
              active!.throwIfAborted();
              throw error;
            }
          }
        }
        active!.throwIfAborted();
        // An empty observation means the original holder just released. Any
        // unrelated operation encountered at reacquisition still fails fast.
        if (holder === 'preparation' || holder === 'none') {
          joinedOfflinePreparation = true;
          locked = await tryPhysical();
        }
      }
      active?.throwIfAborted();
      if (!locked) throw new PersonVmError('LEASE_CONFLICT');
      const [stored] = await session.query(
        () =>
          sql`select * from person_virtual_machines where person_id=${personId}`,
      );
      const row = stored ? fromRow(stored) : null;
      // Expiry is NOT proof the previous owner/operation is fenced. Never steal on TTL alone.
      if (row?.leaseOwner) {
        const oldOwner = row.leaseOwner;
        if (
          !options.deletionAction ||
          this.settledOrphans.get(oldOwner) !== personId
        )
          throw new PersonVmError('LEASE_CONFLICT');
        const [settled] = await session.query(
          () => sql`update person_virtual_machines
          set lease_owner=null,lease_expires_at=null
          where person_id=${personId} and lease_owner=${oldOwner} returning vm_id`,
        );
        if (!settled) throw new PersonVmError('LEASE_LOST');
        row.leaseOwner = null;
        row.leaseExpiresAt = null;
        this.settledOrphans.delete(oldOwner);
      }
      const readPlatformErasingDisk = async (): Promise<
        PlatformVmErasingDisk | undefined
      > => {
        if (
          !row ||
          row.phase !== 'deleted' ||
          !row.diskRetained ||
          row.instanceId ||
          row.nativeCreated ||
          row.egressReceipt
        )
          return;
        const [saved] = await session.query(
          () => sql`select metadata
          from allrice_audit_events where organization_id=${row.organizationId}
            and resource_type='person_vm' and resource_id=${row.vmId}
            and action='person_vm.platform.purge-disk.erasing'
            and metadata @> ${sql.json({ personId: row.personId, leaseEpoch: row.leaseEpoch })}
          order by occurred_at desc limit 1`,
        );
        const identity = saved?.metadata?.diskIdentitySha256;
        const tier = saved?.metadata?.diskTier;
        if (!saved) return;
        if (
          (identity !== null &&
            (typeof identity !== 'string' ||
              !/^[a-f0-9]{64}$/.test(identity))) ||
          (tier !== 'warm' && tier !== 'cold')
        )
          throw new PersonVmError('CLEANUP_INCOMPLETE');
        return { diskIdentitySha256: identity, diskTier: tier };
      };
      const pendingErasure = await readPlatformErasingDisk();
      if (pendingErasure) {
        ownsDurable = false;
        if (!reviewOnly && options.deletionAction !== 'purge-disk')
          throw new PersonVmError('CLEANUP_INCOMPLETE');
      }
      let erasing = Boolean(pendingErasure);
      async function claim() {
        if (!row || reviewOnly || erasing)
          throw new PersonVmError('LEASE_LOST');
        ownsDurable = true;
        const [claimed] = await session.query(
          () => sql`update person_virtual_machines
          set lease_owner=${token},lease_expires_at=${expires()}
          where person_id=${personId} and lease_owner is null and vm_id=${row.vmId}
            and lease_epoch=${row.leaseEpoch} returning vm_id`,
        );
        if (!claimed) throw new PersonVmError('LEASE_CONFLICT');
      }
      if (row && ownsDurable) await claim();
      const guard = async (
        requireAdmission = true,
        expected?: DiskPoolOwner,
      ) => {
        if (reviewOnly) throw new PersonVmError('LEASE_LOST');
        const [current] = await session.query(() =>
          !ownsDurable
            ? sql`select * from person_virtual_machines
              where person_id=${personId} and vm_id=${row!.vmId} and lease_epoch=${row!.leaseEpoch}
                and lease_owner is null and phase='deleted' and disk_retained`
            : sql`update person_virtual_machines set lease_expires_at=${expires()}
              where person_id=${personId} and lease_owner=${token} returning *`,
        );
        if (!current) throw new PersonVmError('LEASE_LOST');
        if (
          expected &&
          (current.person_id !== expected.personId ||
            current.organization_id !== expected.organizationId ||
            current.vm_id !== expected.vmId ||
            current.disk_retained !== true)
        )
          throw new PersonVmError('LEASE_LOST');
        if (requireAdmission && current.admission_state?.revoked)
          throw new PersonVmError('AUTHORIZATION_DENIED');
      };
      const saveRecord = async (
        record: VmRecord,
        db: postgres.Sql | postgres.TransactionSql,
        audit?: VmAudit,
        capacityReleased?: boolean,
      ) => {
        if (record.personId !== personId) throw new PersonVmError('LEASE_LOST');
        const values = {
          person_id: record.personId,
          vm_id: record.vmId,
          organization_id: record.organizationId,
          phase: record.phase,
          disk_tier: record.diskTier,
          disk_retained: record.diskRetained,
          native_created: record.nativeCreated,
          instance_id: record.instanceId,
          lease_epoch: record.leaseEpoch,
          lease_owner: token,
          lease_expires_at: expires(),
          egress_receipt: record.egressReceipt
            ? db.json(record.egressReceipt as postgres.JSONValue)
            : null,
          gateway_ports: db.json(record.gatewayPorts),
          holds: db.json(record.holds),
          last_activity_at: record.lastActivityAt,
          stopped_at: record.stoppedAt,
          idle_since: record.idleSince,
          activity_observed_at: record.activityObservedAt,
        };
        const rows = await stateWithAudit(
          db,
          db`insert into person_virtual_machines ${db(values)}
            on conflict (person_id) do update set
              vm_id=excluded.vm_id,phase=excluded.phase,disk_tier=excluded.disk_tier,disk_retained=excluded.disk_retained,
              native_created=excluded.native_created,instance_id=excluded.instance_id,lease_epoch=excluded.lease_epoch,
              egress_receipt=excluded.egress_receipt,gateway_ports=excluded.gateway_ports,holds=excluded.holds,
              last_activity_at=excluded.last_activity_at,stopped_at=excluded.stopped_at,idle_since=excluded.idle_since,
              activity_observed_at=excluded.activity_observed_at,lease_expires_at=excluded.lease_expires_at,updated_at=now()
            where person_virtual_machines.lease_owner=${token}
            returning vm_id,person_id,organization_id,lease_epoch`,
          audit,
          capacityReleased,
        );
        if (rows.length !== 1) throw new PersonVmError('LEASE_LOST');
      };
      async function withCurrentOperator<T>(
        authorize: PlatformVmDeletionAuthorization | undefined,
        apply: () => Promise<T>,
      ) {
        await session.query(() => sql.unsafe('begin'));
        try {
          if (authorize) await session.query(() => authorize(sql));
          const result = await apply();
          await session.query(() => sql.unsafe('commit'));
          return result;
        } catch (error) {
          if (!session.connectionFailure)
            await session.query(() => sql.unsafe('rollback'));
          throw error;
        }
      }
      const lease: VmLease = {
        row,
        joinedOfflinePreparation,
        signal: session.signal,
        assertAdmissionOpen: (change) =>
          assertAdmissionOpen(session, personId, change),
        guard: (expected) => guard(true, expected),
        assertPhysicalOwner: () => guard(false),
        ...(this.maxResidentVms === undefined
          ? {}
          : {
              reserveStartup: (record: VmRecord) =>
                session.query(() =>
                  sql.begin('isolation level read committed', async (tx) => {
                    if (reviewOnly || erasing || !ownsDurable)
                      throw new PersonVmError('LEASE_LOST');
                    await tx`select pg_advisory_xact_lock(hashtextextended('person-vm:host-peak-capacity',0))`;
                    const [used] = await tx`select count(*)::int as count
                from person_virtual_machines vm
                where vm.person_id<>${personId} and vm.instance_id is not null
                  and not ${releasedVmCapacity(tx)}`;
                    if (
                      typeof used?.count !== 'number' ||
                      used.count >= this.maxResidentVms!
                    )
                      throw new PersonVmError('RUNTIME_NOT_READY');
                    const [previous] =
                      await tx`select ${releasedVmCapacity(tx)} as released
                      from person_virtual_machines vm
                      where vm.person_id=${personId} and vm.lease_owner=${token}`;
                    await saveRecord(record, tx);
                    return previous?.released === true;
                  }),
                ),
            }),
        idleStopReceipt: (binding) => readIdleStopReceipt(session, binding),
        hasUnjoinedIdleStop: (binding) => hasUnjoinedIdleStop(session, binding),
        hasPreviousUpgradeStop: (binding) =>
          hasPreviousUpgradeStop(session, binding),
        hasCompletedDiskDeletion: async (owner) => {
          if (owner.personId !== personId)
            throw new PersonVmError('LEASE_LOST');
          const [record] = await session.query(
            () => sql`
            select exists (
              select 1 from person_vm_audit where vm_id=${owner.vmId}
                and person_id=${owner.personId} and organization_id=${owner.organizationId}
                and action='delete-disk' and result='succeeded'
              union all
              select 1 from allrice_audit_events where resource_type='person_vm'
                and action='person_vm.platform.purge-disk.succeeded'
                and organization_id=${owner.organizationId} and resource_id=${owner.vmId}
                and metadata @> ${sql.json({ personId: owner.personId })}
            ) as deleted`,
          );
          return record?.deleted === true;
        },
        hasRetainedDiskRows: async (vmIds) => {
          const [record] = await session.query(
            () => sql`
            select count(*)::int as retained from person_virtual_machines
              where disk_retained and vm_id = any(${sql.array([...vmIds])}::uuid[])`,
          );
          return record?.retained === vmIds.length;
        },
        save: async (record, details) => {
          const deletion =
            details && 'deletionAudit' in details ? details : undefined;
          const lifecycle =
            details && !('deletionAudit' in details) ? details : undefined;
          const { deletionAudit, authorizeDeletion } = deletion ?? {};
          if (reviewOnly || record.personId !== personId)
            throw new PersonVmError('LEASE_LOST');
          const erasureCheckpoint = deletionAudit?.result === 'erasing';
          const retained =
            deletionAudit?.action === 'retain-disk' &&
            deletionAudit.result === 'succeeded';
          if (
            (erasureCheckpoint || deletionAudit?.action === 'retain-disk') &&
            !authorizeDeletion
          )
            throw new PersonVmError('AUTHORIZATION_DENIED');
          if (
            (erasureCheckpoint || erasing) &&
            (!row ||
              record.vmId !== row.vmId ||
              record.leaseEpoch !== row.leaseEpoch ||
              record.phase !== 'deleted' ||
              record.instanceId ||
              record.nativeCreated ||
              record.egressReceipt ||
              deletionAudit?.action !== 'purge-disk' ||
              (erasing
                ? record.diskRetained || deletionAudit.result !== 'succeeded'
                : !record.diskRetained))
          )
            throw new PersonVmError('LEASE_LOST');
          const save = async () => {
            if (erasing) {
              const [erased] = await sql`update person_virtual_machines
                set disk_retained=false,updated_at=now()
                where person_id=${personId} and vm_id=${record.vmId} and lease_epoch=${record.leaseEpoch}
                  and lease_owner is null and phase='deleted' and disk_retained and instance_id is null
                returning vm_id`;
              if (!erased) throw new PersonVmError('LEASE_LOST');
              return;
            }
            if (!ownsDurable) {
              if (!erasureCheckpoint) throw new PersonVmError('LEASE_LOST');
              const [detached] = await sql`update person_virtual_machines
                set instance_id=null, native_created=false, disk_tier=${record.diskTier}, gateway_ports='[]'::jsonb, updated_at=now()
                where person_id=${personId} and vm_id=${record.vmId} and lease_epoch=${record.leaseEpoch}
                  and lease_owner is null and phase='deleted' and disk_retained and egress_receipt is null
                returning vm_id`;
              if (!detached) throw new PersonVmError('LEASE_LOST');
              return;
            }
            await saveRecord(
              record,
              sql,
              lifecycle?.audit,
              lifecycle?.capacityReleased,
            );
          };
          if (!deletionAudit) return session.query(save);
          await withCurrentOperator(authorizeDeletion, async () => {
            await session.query(save);
            await session.query(() =>
              recordPlatformVmDeletion(sql, deletionAudit),
            );
            if ((erasureCheckpoint || retained) && ownsDurable) {
              // The exact runtime and mount already joined. Publish the
              // detached tombstone and release the physical owner together.
              // An erasure still holds the advisory lock for scoped unlinks.
              const [released] = await session.query(
                () =>
                  sql`update person_virtual_machines set lease_owner=null,lease_expires_at=null
                  where person_id=${personId} and lease_owner=${token} returning vm_id`,
              );
              if (!released) throw new PersonVmError('LEASE_LOST');
            }
          });
          if (erasureCheckpoint || retained) ownsDurable = false;
          if (erasureCheckpoint) erasing = true;
        },
        audit: async (record, event) => {
          await session.query(() => insertVmAudit(sql, record, event));
        },
        auditPlatformDeletion: async (event, authorize) => {
          if (reviewOnly && event.result !== 'reviewed')
            throw new PersonVmError('LEASE_LOST');
          if (
            (event.result === 'erasing' ||
              (event.action === 'retain-disk' &&
                event.result === 'succeeded')) &&
            !authorize
          )
            throw new PersonVmError('AUTHORIZATION_DENIED');
          const record = () =>
            session.query(() => recordPlatformVmDeletion(sql, event));
          if (authorize) await withCurrentOperator(authorize, record);
          else await record();
        },
        readPlatformErasingDisk: async () => pendingErasure,
        claimDeletionCleanup: claim,
        async confirmRetainedDeletion() {
          if (
            !row ||
            ownsDurable ||
            row.phase !== 'deleted' ||
            !row.diskRetained ||
            row.egressReceipt ||
            row.holds.length
          )
            return false;
          const [clean] = await session.query(
            () => sql`select exists(
            select 1 from allrice_audit_events where resource_type='person_vm' and action='person_vm.platform.retain-disk.succeeded'
              and organization_id=${row.organizationId} and resource_id=${row.vmId}
              and metadata @> ${sql.json({ personId: row.personId, leaseEpoch: row.leaseEpoch, instanceId: row.instanceId })}
            union all
            select 1 from person_vm_audit where ${options.deletionAction === 'purge-disk'}
              and person_id=${row.personId} and vm_id=${row.vmId}
              and organization_id=${row.organizationId} and lease_epoch=${row.leaseEpoch}
              and action='delete' and result='succeeded'
          ) as ok`,
          );
          return clean?.ok === true;
        },
      };
      result = await work(lease);
    } catch (error) {
      bodyError = error;
    } finally {
      try {
        // A broken session leaves a durable orphan for explicit fenced recovery.
        if (locked && !session.connectionFailure) {
          if (ownsDurable)
            await session.query(
              () =>
                sql`update person_virtual_machines set lease_owner=null,lease_expires_at=null where person_id=${personId} and lease_owner=${token}`,
            );
          await session.query(
            () =>
              sql`select pg_advisory_unlock(hashtextextended(${physical},0))`,
          );
        }
      } catch (error) {
        bodyError ??= error;
      } finally {
        // work() and physical cleanup have settled before this local fence exists.
        if (locked && ownsDurable && session.connectionFailure)
          this.settledOrphans.set(token, personId);
        bodyError ??= session.connectionFailure;
        await session.end();
      }
    }
    if (bodyError) throw bodyError;
    return result;
  }
  async recover<T>(
    requestedPersonId: string,
    options: {
      now: () => Date;
      ttlMs: number;
      signal: AbortSignal;
      joinedIdleStop?: { binding: PersonVmBinding; requestId: string };
    },
    work: (lease: VmLease) => Promise<T>,
  ) {
    const personId = requestedPersonId.toLowerCase();
    options.signal.throwIfAborted();
    if (this.activeRecoveries.has(personId))
      throw new PersonVmError('LEASE_CONFLICT');
    const session = new VmSqlSession(this.openSql());
    const sql = session.client;
    let locked = false;
    let recoveryToken: string | undefined;
    let released = false;
    try {
      const [lock] = await session.query(
        () =>
          sql`select pg_try_advisory_lock(hashtextextended(${'person-vm:' + personId},0)) as locked`,
      );
      if (!lock?.locked) throw new PersonVmError('LEASE_CONFLICT');
      locked = true;
      const [stored] = await session.query(
        () =>
          sql`select * from person_virtual_machines where person_id=${personId}`,
      );
      if (!stored) throw new PersonVmError('NOT_FOUND');
      const row = fromRow(stored);
      const previousToken = row.leaseOwner;
      if (
        !previousToken ||
        !row.leaseExpiresAt ||
        Date.parse(row.leaseExpiresAt) > options.now().getTime()
      )
        throw new PersonVmError('LEASE_CONFLICT');
      let joined = false;
      if (options.joinedIdleStop) {
        const { binding, requestId } = options.joinedIdleStop;
        // The final stop publishes the stopped row and its success audit in
        // one statement, after the native command and cleanup have joined.
        // A subsequent lease claim (even in the same epoch) rewrites this
        // tuple and invalidates that proof. Expiry alone is never sufficient.
        const [proof] = await session.query(
          () => sql`select 1 from person_virtual_machines vm
            join person_vm_audit a on a.vm_id=vm.vm_id
              and a.person_id=vm.person_id and a.organization_id=vm.organization_id
              and a.lease_epoch=vm.lease_epoch and a.xmin=vm.xmin
            where vm.person_id=${personId} and vm.organization_id=${binding.organizationId}
              and vm.vm_id=${binding.vmId} and vm.instance_id=${binding.instanceId}
              and vm.lease_epoch=${binding.leaseEpoch} and vm.lease_owner=${previousToken}
              and vm.phase in ('stopped','cold') and vm.disk_retained and vm.egress_receipt is null
              and a.request_id=${requestId} and a.action='stop' and a.result='succeeded'`,
        );
        joined = proof !== undefined;
      }
      if (!joined && this.settledOrphans.get(previousToken) !== personId) {
        if (!this.fence) throw new PersonVmError('LEASE_CONFLICT');
        await this.fence.confirmSettled(
          {
            personId,
            vmId: row.vmId,
            ownerToken: previousToken,
            leaseEpoch: row.leaseEpoch,
          },
          options.signal,
        );
      }
      // The proof covers the previous operation, never this recovery. Persist
      // a unique owner before work can reach any physical provider. Other hosts
      // must now fence this new token, even if our PG connection is lost.
      const token = randomUUID();
      recoveryToken = token;
      this.activeRecoveries.set(personId, token);
      const expires = new Date(
        options.now().getTime() + options.ttlMs,
      ).toISOString();
      const [claimed] = await session.query(
        () => sql`update person_virtual_machines set lease_owner=${token},lease_expires_at=${expires}
          where person_id=${personId} and lease_owner=${previousToken} and lease_epoch=${row.leaseEpoch} returning vm_id`,
      );
      if (!claimed) throw new PersonVmError('LEASE_LOST');
      this.settledOrphans.delete(previousToken);
      row.leaseOwner = token;
      row.leaseExpiresAt = expires;
      const guard = async (expected?: DiskPoolOwner) => {
        const [found] = await session.query(
          () =>
            sql`update person_virtual_machines set lease_expires_at=${new Date(options.now().getTime() + options.ttlMs)} where person_id=${personId} and lease_owner=${token} returning *`,
        );
        if (!found) throw new PersonVmError('LEASE_LOST');
        if (
          expected &&
          (found.person_id !== expected.personId ||
            found.organization_id !== expected.organizationId ||
            found.vm_id !== expected.vmId ||
            found.disk_retained !== true)
        )
          throw new PersonVmError('LEASE_LOST');
        if (found.admission_state?.revoked)
          throw new PersonVmError('AUTHORIZATION_DENIED');
      };
      const result = await work({
        row,
        signal: session.signal,
        assertAdmissionOpen: (change) =>
          assertAdmissionOpen(session, personId, change),
        guard,
        save: async (value, details) => {
          if (details && 'deletionAudit' in details)
            throw new PersonVmError('AUTHORIZATION_DENIED');
          if (
            value.vmId !== row.vmId ||
            value.personId !== personId ||
            value.leaseEpoch !== row.leaseEpoch
          )
            throw new PersonVmError('LEASE_LOST');
          const [found] = await session.query(() =>
            stateWithAudit(
              sql,
              sql`update person_virtual_machines set phase=${value.phase},disk_tier=${value.diskTier},native_created=${value.nativeCreated},stopped_at=${value.stoppedAt},egress_receipt=${value.egressReceipt ? sql.json(value.egressReceipt as postgres.JSONValue) : null},updated_at=now()
            where person_id=${personId} and lease_owner=${token} and lease_epoch=${row.leaseEpoch}
            returning vm_id,person_id,organization_id,lease_epoch`,
              details?.audit,
              details?.capacityReleased,
            ),
          );
          if (!found) throw new PersonVmError('LEASE_LOST');
        },
        idleStopReceipt: (binding) => readIdleStopReceipt(session, binding),
        hasUnjoinedIdleStop: (binding) => hasUnjoinedIdleStop(session, binding),
        hasPreviousUpgradeStop: (binding) =>
          hasPreviousUpgradeStop(session, binding),
        audit: async (value, event) => {
          await session.query(() => insertVmAudit(sql, value, event));
        },
      });
      const [cleared] = await session.query(
        () =>
          sql`update person_virtual_machines set lease_owner=null,lease_expires_at=null where person_id=${personId} and lease_owner=${token} returning vm_id`,
      );
      if (!cleared) throw new PersonVmError('LEASE_LOST');
      released = true;
      return result;
    } finally {
      try {
        if (locked && !session.connectionFailure)
          await session.query(
            () =>
              sql`select pg_advisory_unlock(hashtextextended(${'person-vm:' + personId},0))`,
          );
      } finally {
        try {
          await session.end();
        } finally {
          // Await work(), its failure cleanup, and SQL disposal before exposing
          // a new local proof. onclose alone never establishes settlement.
          if (recoveryToken) {
            if (!released) this.settledOrphans.set(recoveryToken, personId);
            if (this.activeRecoveries.get(personId) === recoveryToken)
              this.activeRecoveries.delete(personId);
          }
        }
      }
    }
  }
}
