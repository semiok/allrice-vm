import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { addAbortListener } from 'node:events';
import {
  RequestContextSchema,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import {
  PersonVmError,
  PERSON_VM_COLD_MS,
  type PersonVmAction,
  type PersonVmAdmissionBindingPort,
  type PersonVmActivity,
  type PersonVmAuthority,
  type PersonVmBinding,
  type PersonVmDiskPreparationPort,
  type PersonVmEmployeeSelection,
  type PersonVmEgressPort,
  type PersonVmEgressReceipt,
  type PersonVmHostPort,
  type PersonVmPrewarmFence,
  type PersonVmPrewarmInput,
  type PersonVmPrewarmObserver,
  type PersonVmRuntimePort,
  type PersonVmView,
} from './contract.ts';
import { PersonVmAdmissionHost } from './admission-host.ts';
import {
  checkAdmissionBinding,
  rowBinding,
  PostgresPersonVmAdmissionStore,
} from './admission-store.ts';
import type {
  PersonVmActivityCursor,
  PersonVmIdleStopDispatch,
  PersonVmIdleStopRequest,
  PersonVmNativeActivityPort,
  PersonVmPrepareIdleStop,
  PersonVmScheduledIdleAuthority,
} from './admission-contract.ts';
import type { PersonVmSqlFactory } from './store.ts';
import type {
  PersonDisk,
  PersonVmDiskIdentity,
  PersonVmDiskPort,
} from './encrypted-disk.ts';
import type { PersonVmDiskPool } from './disk-pool.ts';
import type { DiskPoolOwner } from './disk-pool-platform.ts';
import type { PersonVmNativePort } from './microsandbox.ts';
import {
  bootstrapPersonVm,
  type PersonVmStartingScope,
} from './guest-bootstrap.ts';
import type {
  PlatformVmDeletionAuthorization,
  PlatformVmDeletionRequest,
  PlatformVmDeletionResult,
} from './platform-deletion.ts';
import {
  checkedWebRoster,
  type PersonVmWebRoster,
  type PersonVmWebEndpointReceipt,
  type PersonVmWebRosterPort,
  type PersonVmWebStartup,
  type NativeWebSetupFailure,
} from './web-endpoints.ts';
import {
  bindingOf,
  PostgresPersonVmStore,
  type PersonVmStore,
  type VmAudit,
  type VmHold,
  type VmLease,
  type VmRecord,
} from './store.ts';

export function sameVmBinding(left: PersonVmBinding, right: PersonVmBinding) {
  return (
    Boolean(left && right) &&
    left.vmId === right.vmId &&
    left.personId === right.personId &&
    left.organizationId === right.organizationId &&
    left.instanceId === right.instanceId &&
    left.leaseEpoch === right.leaseEpoch
  );
}
function view(row: VmRecord, ready = false): PersonVmView {
  return {
    vmId: row.vmId,
    personId: row.personId,
    organizationId: row.organizationId,
    phase: row.phase,
    ready,
    diskRetained: row.diskRetained,
    lastActivityAt: row.lastActivityAt,
  };
}
function safeError(error: unknown) {
  return error instanceof PersonVmError
    ? error
    : new PersonVmError('PROVIDER_FAILED', { cause: error });
}
type IdleStopGuard = Readonly<{
  auditAction?: 'stop.upgrade-dispatch';
  dispatch?: PersonVmIdleStopDispatch;
  requestId: string;
  signal: AbortSignal;
  assertCurrent(signal: AbortSignal): Promise<void>;
}>;

type PrepareUpgradeWake = (
  request: Pick<PersonVmIdleStopRequest, 'binding' | 'assertStopCurrent'> & {
    requestId: string;
  },
  signal: AbortSignal,
) => Promise<{
  nextWakeAt: string | null;
  scheduleFingerprints: readonly string[];
  dispatch: PersonVmIdleStopDispatch;
}>;

type ScheduledStart = Readonly<{
  purpose: 'scheduled-wake';
  requestId: string;
  readRoster(signal: AbortSignal): Promise<PersonVmWebRoster>;
  withCurrentAuthority<T>(
    rosterDigest: string,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}>;

function isAuthorizationFailure(error: unknown) {
  return (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    [
      'authentication_required',
      'authorization_denied',
      'tenant_context_invalid',
    ].includes(String(error.code))
  );
}

async function assertPrewarmAuthority(
  target: PersonVmPrewarmFence,
  signal: AbortSignal,
) {
  try {
    signal.throwIfAborted();
    await target.assertAuthority(signal);
    signal.throwIfAborted();
  } catch (error) {
    if (isAuthorizationFailure(error))
      throw new PersonVmError('AUTHORIZATION_DENIED', { cause: error });
    throw error;
  }
}

type RetainedStartupMount = Readonly<{
  binding: PersonVmBinding;
  disk: PersonDisk;
  image: PersonVmDiskIdentity;
}>;
type FirstPrewarmDisk = Readonly<{
  vmId: string;
  image: PersonVmDiskIdentity;
}>;
type SelectedStartup = Readonly<{
  employee: PersonVmEmployeeSelection;
  firstDisk?: FirstPrewarmDisk;
}>;
type UpgradePrewarm = {
  work: Promise<PersonVmView>;
  receipt: { binding?: PersonVmBinding };
  signal: AbortSignal;
};

export class PersonVmService
  implements PersonVmHostPort, PersonVmAdmissionBindingPort
{
  private admissionHost?: PersonVmAdmissionHost;
  private workerDrain = false;
  private readonly upgradePrewarms = new Map<string, UpgradePrewarm>();
  private idleAccessOrder = 0;
  private readonly retainedStartupMounts = new Map<
    string,
    RetainedStartupMount
  >();
  private admissionShared?: PostgresPersonVmAdmissionStore;
  private readonly now: () => Date;
  private readonly currentLease = new AsyncLocalStorage<{
    active: boolean;
    requestId: string;
    personId: string;
    lease: VmLease;
  }>();
  constructor(
    private readonly options: {
      store: PersonVmStore;
      authority: PersonVmAuthority;
      readUnusedEmployeeHomes?(
        scope: PersonVmStartingScope,
        mount: string,
      ): Promise<boolean>;
      authorizePlatformDeletion?: (
        context: RequestContext,
        signal: AbortSignal,
        sql?: Parameters<PlatformVmDeletionAuthorization>[0],
      ) => Promise<void>;
      disk: PersonVmDiskPort;
      diskPool?: PersonVmDiskPool;
      native: PersonVmNativePort;
      egress?: PersonVmEgressPort;
      runtime?: PersonVmRuntimePort;
      nativeWeb?: PersonVmWebRosterPort;
      nativeCapacityAccounting?: boolean;
      /** Register the exact saved epoch before a start can touch its disk. */
      observeOwnedStart?: (
        binding: PersonVmBinding,
        context?: RequestContext,
      ) => void;
      observeScheduledStart?: (
        binding: PersonVmBinding,
        roster: PersonVmWebRoster,
      ) => void;
      observeOwnedAccess?: (
        binding: PersonVmBinding,
        context: RequestContext,
        order: number,
      ) => void;
      /** A retained epoch may acquire a mount without owning its native job. */
      observeOwnedMount?: (binding: PersonVmBinding) => void;
      observeOwnedStop?: (binding: PersonVmBinding) => void;
      ownsEgressReceipt?: (receipt: PersonVmEgressReceipt) => boolean;
      /** Prove that no previous host can still accept traffic on this epoch.
       * The proof is held through the joined native stop and durable write. */
      withPreviousGatewayFenced?: <T>(
        binding: PersonVmBinding,
        ports: readonly number[],
        signal: AbortSignal,
        work: () => Promise<T>,
      ) => Promise<T>;
      /** An unresolved local egress epoch keeps its shared mount reserved. */
      hasUnconfirmedEgress?: (binding: PersonVmBinding) => boolean;
      upgradeActivity?: Pick<
        PersonVmNativeActivityPort,
        'observe' | 'assertSampleCurrent'
      >;
      settleSupersededBinding?: (
        binding: PersonVmBinding,
        signal: AbortSignal,
      ) => Promise<void>;
      leaseTtlMs: number;
      activityMaxAgeMs: number;
      cleanupTimeoutMs: number;
      now?: () => Date;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    if (
      ![
        options.leaseTtlMs,
        options.activityMaxAgeMs,
        options.cleanupTimeoutMs,
      ].every((value) => Number.isFinite(value) && value > 0)
    )
      throw new PersonVmError('PROVIDER_FAILED');
  }
  /** Trusted production composition. Reuses this service's actual authority,
   * providers and physical store; the callbacks below never reacquire a lock. */
  createAdmissionHost(input: {
    openSql: PersonVmSqlFactory;
    idleMs?: number;
    nativeActivity?: PersonVmNativeActivityPort;
    prepareIdleStop?: PersonVmPrepareIdleStop;
    scheduledIdleAuthority?: PersonVmScheduledIdleAuthority;
    monotonic?: () => number;
  }) {
    if (this.admissionHost) throw new PersonVmError('LEASE_CONFLICT');
    if (!(this.options.store instanceof PostgresPersonVmStore))
      throw new PersonVmError('PROVIDER_FAILED');
    this.options.store.assertAdmissionFactory(input.openSql);
    const shared = new PostgresPersonVmAdmissionStore(input.openSql);
    const host = new PersonVmAdmissionHost({
      ...input,
      shared,
      store: this.options.store,
      authority: this.options.authority,
      leaseTtlMs: this.options.leaseTtlMs,
      activityMaxAgeMs: this.options.activityMaxAgeMs,
      now: this.now,
      recoverIdleStop: (binding, assertAuthority, signal) =>
        this.recoverIdleStop(binding, assertAuthority, signal),
      idleStopped: (binding) => this.options.observeOwnedStop?.(binding),
      startOwned: async (context, lease, signal) => {
        await this.identity(context, 'start', signal);
        if (!lease.row) throw new PersonVmError('NOT_FOUND');
        this.checkOrganization(lease.row, context.organizationId);
        await this.inLeaseFrame(context, lease.row.personId, lease, () =>
          this.startOwned(context, lease, signal),
        );
        return bindingOf(lease.row);
      },
      assertStopSafe: async (lease, signal) => {
        const row = this.required(lease.row);
        if (row.holds.length) throw new PersonVmError('VM_ACTIVE');
        const status = await this.options.native.status(bindingOf(row), signal);
        // No public autonomous native-admission fence has been wired. Even
        // complete-looking fixture projections cannot permit a running stop.
        if (status !== 'stopped' && status !== 'absent')
          throw new PersonVmError('ACTIVITY_UNKNOWN');
      },
      stopOwned: async (context, lease, signal) => {
        await this.identity(context, 'stop', signal);
        return this.inLeaseFrame(context, context.actor.id, lease, () =>
          this.stopOwned(context, lease, signal, true),
        );
      },
      stopIdleOwned: async (
        requestId,
        lease,
        signal,
        assertStopCurrent,
        dispatch,
      ) => {
        const row = this.required(lease.row);
        if (row.phase !== 'running' || row.holds.length)
          throw new PersonVmError('ACTIVITY_UNKNOWN');
        await lease.guard();
        signal.throwIfAborted();
        return this.commitStop(requestId, lease, row, {
          requestId,
          signal,
          assertCurrent: assertStopCurrent,
          dispatch,
        });
      },
    });
    // Publish together only after factory validation and host construction. This
    // is the SAME authority, never a replacement or another caller's factory.
    this.admissionShared = shared;
    return (this.admissionHost = host);
  }
  private async identity(
    context: RequestContext,
    action: PersonVmAction,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    RequestContextSchema.parse(context); // Shape only; authority below supplies current trust.
    const identity = await this.options.authority.authorize(
      context,
      action,
      signal,
    );
    if (this.workerDrain && (action === 'create' || action === 'start'))
      throw new PersonVmError('RUNTIME_NOT_READY');
    if (
      !UuidSchema.safeParse(identity.personId).success ||
      identity.organizationId !== context.organizationId ||
      (context.actor.type === 'user' && identity.personId !== context.actor.id)
    )
      throw new PersonVmError('AUTHORIZATION_DENIED');
    return identity;
  }
  private checkOrganization(row: VmRecord, organizationId: string) {
    if (row.organizationId !== organizationId)
      throw new PersonVmError('ORGANIZATION_CONFLICT');
  }
  private async leased<T>(
    context: RequestContext,
    action: PersonVmAction,
    signal: AbortSignal,
    work: (
      lease: VmLease,
      identity: { personId: string; organizationId: string },
      signal: AbortSignal,
    ) => Promise<T>,
    options: {
      allowClosed?: boolean;
      joinOfflinePreparation?: boolean;
      beforeClaim?: Parameters<PersonVmStore['withLease']>[1]['beforeClaim'];
      observeRelease?: Parameters<
        PersonVmStore['withLease']
      >[1]['observeRelease'];
    } = {},
  ) {
    const identity = await this.identity(context, action, signal);
    const foreground =
      this.options.diskPool && (action === 'create' || action === 'start');
    const workWithLease = () =>
      this.options.store.withLease(
        identity.personId,
        {
          now: this.now,
          ttlMs: this.options.leaseTtlMs,
          ...(options.beforeClaim && { beforeClaim: options.beforeClaim }),
          ...(options.observeRelease && {
            observeRelease: options.observeRelease,
          }),
          ...(foreground &&
            options.joinOfflinePreparation && {
              offlinePreparation: {
                mode: 'join',
                organizationId: identity.organizationId,
                signal,
              },
            }),
        },
        async (lease) => {
          if (!options.allowClosed) await lease.assertAdmissionOpen();
          const current = AbortSignal.any([signal, lease.signal]);
          current.throwIfAborted();
          if (lease.joinedOfflinePreparation) {
            const latest = await this.identity(context, action, current);
            if (
              latest.personId !== identity.personId ||
              latest.organizationId !== identity.organizationId
            )
              throw new PersonVmError('AUTHORIZATION_DENIED');
          }
          if (lease.row)
            this.checkOrganization(lease.row, identity.organizationId);
          const operation = (ownedSignal: AbortSignal) =>
            this.inLeaseFrame(context, identity.personId, lease, () =>
              work(lease, identity, ownedSignal),
            );
          return this.admissionHost
            ? this.admissionHost.trackOwner(
                identity.personId,
                current,
                operation,
              )
            : operation(current);
        },
      );
    return foreground && this.options.diskPool
      ? this.options.diskPool.inForeground(workWithLease)
      : workWithLease();
  }
  private inLeaseFrame<T>(
    context: Pick<RequestContext, 'requestId'>,
    personId: string,
    lease: VmLease,
    work: () => Promise<T>,
  ) {
    const frame = {
      active: true,
      requestId: context.requestId,
      personId,
      lease,
    };
    return this.currentLease.run(frame, async () => {
      try {
        const pending = this.retainedStartupMounts.get(personId);
        if (pending)
          await this.joinRetainedStartupMount(
            pending,
            lease,
            AbortSignal.timeout(this.options.cleanupTimeoutMs),
          );
        return await work();
      } finally {
        frame.active = false;
      }
    });
  }
  private required(row: VmRecord | null) {
    if (!row || row.phase === 'deleted' || !row.diskRetained)
      throw new PersonVmError('NOT_FOUND');
    return row;
  }
  async read(context: RequestContext, signal: AbortSignal) {
    const identity = await this.identity(context, 'read', signal);
    const row = await this.options.store.read(identity.personId);
    if (!row) return null;
    this.checkOrganization(row, identity.organizationId);
    return view(row); // A persisted running flag is not a readiness assertion.
  }
  private needsUpgradeStop(row: VmRecord) {
    if (
      !row.instanceId ||
      !row.egressReceipt ||
      !this.options.ownsEgressReceipt ||
      !this.options.withPreviousGatewayFenced
    )
      return false;
    return !this.options.ownsEgressReceipt(
      this.receipt(bindingOf(row), row.egressReceipt),
    );
  }
  private async canStopPreviousWorkerVm(lease: VmLease, row: VmRecord) {
    if (
      (row.phase !== 'running' && row.phase !== 'failed') ||
      !this.needsUpgradeStop(row)
    )
      return false;
    return (
      row.phase === 'running' ||
      (await lease.hasPreviousUpgradeStop?.(bindingOf(row))) === true
    );
  }
  private assertPrewarmTarget(
    row: Readonly<VmRecord> | null,
    target?: PersonVmPrewarmFence,
    allowRetainedRestore = false,
  ) {
    if (!target) return;
    if (
      target.deletionFence !== undefined &&
      (row?.prewarmDeletionFence ?? null) !== target.deletionFence
    )
      throw new PersonVmError('LEASE_LOST');
    const running = row?.phase === 'running' && !this.needsUpgradeStop(row);
    const epoch = (row?.leaseEpoch ?? 0) + (running ? 0 : 1);
    const purged =
      row?.phase === 'deleted' &&
      !row.diskRetained &&
      target.replacesVmId === row.vmId &&
      target.vmId === null &&
      target.instanceId === null;
    if (
      (row?.phase === 'deleted' &&
        (!allowRetainedRestore ||
          (!purged &&
            (!target.restoreRetained ||
              !row.diskRetained ||
              target.vmId !== row.vmId)))) ||
      (target.replacesVmId &&
        row?.phase !== 'deleted' &&
        target.vmId === null) ||
      (running && (target.vmId === null || target.instanceId === null)) ||
      epoch !== target.leaseEpoch ||
      (target.vmId !== null && target.vmId !== row?.vmId) ||
      (target.instanceId !== null &&
        (!running || target.instanceId !== row?.instanceId))
    )
      throw new PersonVmError('LEASE_LOST');
  }
  create(
    context: RequestContext,
    signal: AbortSignal,
    target?: PersonVmPrewarmFence,
    observer: PersonVmPrewarmObserver | undefined = target,
  ) {
    return this.createForStartup(context, signal, target, observer);
  }
  private createForStartup(
    context: RequestContext,
    signal: AbortSignal,
    target?: PersonVmPrewarmFence,
    observer: PersonVmPrewarmObserver | undefined = target,
    observeFirstDisk?: (proof: FirstPrewarmDisk) => void,
  ) {
    return this.leased(
      context,
      'create',
      signal,
      async (lease, identity, signal) => {
        this.assertPrewarmTarget(lease.row, target, true);
        if (target) {
          await target.assertAuthority(signal);
          signal.throwIfAborted();
        }
        const retry = this.unfinishedCreate(lease.row);
        if (lease.row && lease.row.phase !== 'deleted' && !retry) {
          const catalog = await this.creationCatalog(lease.row, lease, signal);
          if (
            catalog === 'pending' ||
            (catalog === 'bound' && !lease.row.diskRetained)
          )
            throw new PersonVmError('CLEANUP_INCOMPLETE');
          if (target && this.options.diskPool) {
            await target.assertAuthority(signal);
            signal.throwIfAborted();
          }
          observer?.observeVmReservation?.(lease.row.vmId);
          return view(lease.row);
        }
        if (lease.row?.diskRetained && !retry) {
          if (
            (await this.creationCatalog(lease.row, lease, signal)) === 'pending'
          )
            throw new PersonVmError('CLEANUP_INCOMPLETE');
          if (target && this.options.diskPool) {
            await target.assertAuthority(signal);
            signal.throwIfAborted();
          }
          lease.row.phase = lease.row.diskTier === 'cold' ? 'cold' : 'stopped';
          await lease.save(lease.row);
          await lease.audit(lease.row, {
            requestId: context.requestId,
            action: 'create-retained',
            result: 'succeeded',
          });
          return view(lease.row);
        }
        const row = retry
          ? lease.row!
          : this.newVmRecord(identity, lease.row?.leaseEpoch);
        const assertTicket =
          target &&
          ((active: AbortSignal) => assertPrewarmAuthority(target, active));
        await this.createDiskOwned(row, lease, signal, {
          action: 'create',
          requestId: context.requestId,
          lane: 'foreground',
          assertCurrent: async () => {
            const current = await this.identity(context, 'create', signal);
            if (
              current.personId !== row.personId ||
              current.organizationId !== row.organizationId
            )
              throw new PersonVmError('AUTHORIZATION_DENIED');
          },
          assertPrewarmAuthority: assertTicket,
          observeVmReservation: observer?.observeVmReservation,
          observeFirstDisk:
            !lease.row && !lease.joinedOfflinePreparation
              ? observeFirstDisk
              : undefined,
        });
        return view(row);
      },
      {
        joinOfflinePreparation: true,
        ...(target && {
          beforeClaim: (row, _owner, active) => {
            active.throwIfAborted();
            signal.throwIfAborted();
            if (row) this.checkOrganization(row, context.organizationId);
            this.assertPrewarmTarget(row, target, true);
          },
        }),
      },
    );
  }

  private unfinishedCreate(row: VmRecord | null) {
    return (
      row &&
      !row.instanceId &&
      !row.nativeCreated &&
      row.diskRetained &&
      (row.phase === 'failed' || row.phase === 'starting')
    );
  }

  private newVmRecord(
    identity: Pick<DiskPoolOwner, 'personId' | 'organizationId'>,
    leaseEpoch = 0,
  ): VmRecord {
    return {
      vmId: randomUUID(),
      personId: identity.personId,
      organizationId: identity.organizationId,
      phase: 'starting',
      diskTier: 'warm',
      diskRetained: true,
      nativeCreated: false,
      verifiedWebSlotCapacity: null,
      instanceId: null,
      leaseEpoch,
      leaseOwner: null,
      leaseExpiresAt: null,
      egressReceipt: null,
      gatewayPorts: [],
      holds: [],
      lastActivityAt: this.now().toISOString(),
      stoppedAt: null,
      idleSince: null,
      activityObservedAt: null,
    };
  }

  private async assertNoPendingDisk(row: VmRecord, signal: AbortSignal) {
    if ((await this.options.diskPool?.status(row, signal)) === 'pending')
      throw new PersonVmError('CLEANUP_INCOMPLETE');
  }

  private creationCatalog(
    row: VmRecord,
    lease: VmLease,
    signal: AbortSignal,
    allocating = false,
  ) {
    return this.options.diskPool?.status(
      row,
      signal,
      async (previous) => {
        // Both the exact delete audit and independent disk/key absence must
        // agree before a durable owner can be replaced with a different VM.
        if (!(await lease.hasCompletedDiskDeletion?.(previous))) return false;
        signal.throwIfAborted();
        return (
          (await this.options.disk.confirmAbsence?.(previous.vmId, signal)) ===
          true
        );
      },
      allocating,
    );
  }

  private async assertAccountedFormalDisks(
    lease: VmLease,
    signal: AbortSignal,
  ) {
    const { disk, diskPool } = this.options;
    if (!diskPool) return;
    const list = disk.listFormalDiskIds?.bind(disk);
    if (!list) throw new PersonVmError('CLEANUP_INCOMPLETE');
    const accounted = async () => {
      const unknown = await diskPool.unaccountedFormalDisks(
        await list(signal),
        signal,
      );
      const valid =
        unknown.length === 0 ||
        (await lease.hasRetainedDiskRows?.(unknown)) === true;
      signal.throwIfAborted();
      return valid;
    };
    // Reobserve on a mismatch in case an authorized deletion just retired
    // a legacy reference in between the physical and SQL observations.
    if (!(await accounted()) && !(await accounted()))
      throw new PersonVmError('CLEANUP_INCOMPLETE');
  }

  private async createDiskOwned(
    row: VmRecord,
    lease: VmLease,
    signal: AbortSignal,
    input: {
      action: 'create' | 'disk-preprovision';
      requestId: string;
      lane: 'foreground' | 'admin';
      assertCurrent(): Promise<void>;
      assertPrewarmAuthority?: PersonVmPrewarmFence['assertAuthority'];
      observeVmReservation?: PersonVmPrewarmObserver['observeVmReservation'];
      observeFirstDisk?: (proof: FirstPrewarmDisk) => void;
    },
  ) {
    const pool = this.options.diskPool;
    const assertTicket = input.assertPrewarmAuthority;
    const catalog = await this.creationCatalog(row, lease, signal, true);
    const audit = { requestId: input.requestId, action: input.action };
    const newIdentity = lease.row?.vmId !== row.vmId;
    const needsCandidate = input.lane === 'admin' && !lease.row;
    if (catalog === 'pending' && !pool?.enabled)
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    if (newIdentity) await this.assertAccountedFormalDisks(lease, signal);
    if (pool?.enabled) {
      await input.assertCurrent();
      await lease.assertAdmissionOpen();
      signal.throwIfAborted();
    }
    if (assertTicket) await assertTicket(signal);
    let committed = false;
    const commitOwner = async (current: AbortSignal) => {
      current.throwIfAborted();
      row.phase = 'starting';
      await lease.save(row);
      committed = true;
      input.observeVmReservation?.(row.vmId);
      await lease.audit(row, { ...audit, result: 'started' });
    };
    if (!needsCandidate) await commitOwner(signal);
    const ownerGuard = {
      signal,
      assertCurrent: input.assertCurrent,
      assertOwner: () => lease.guard(row),
      assertTicket,
    };
    const claim = () =>
      pool?.claim(row, input.requestId, input.lane, {
        ...ownerGuard,
        ...(needsCandidate && { commitOwner }),
      });
    let createdImage: PersonVmDiskIdentity | void = undefined;
    try {
      signal.throwIfAborted();
      if (committed) await lease.guard();
      if (catalog === 'pending' && !(await claim()))
        throw new PersonVmError('CLEANUP_INCOMPLETE');
      let inspected = await this.options.disk.inspect(row.vmId, signal);
      if (inspected.state === 'unknown')
        throw new PersonVmError('PROVIDER_FAILED');
      if (inspected.state === 'absent') {
        if (catalog === 'bound' || catalog === 'pending')
          throw new PersonVmError('CLEANUP_INCOMPLETE');
        if (!newIdentity && catalog !== 'ordinary')
          await this.assertAccountedFormalDisks(lease, signal);
        if (!(pool?.enabled && catalog !== 'ordinary' && (await claim()))) {
          if (input.lane === 'admin') {
            if (!committed) return 'deferred' as const;
            row.phase = 'failed';
            await lease.save(row);
            await lease.audit(row, {
              ...audit,
              result: 'failed',
              errorCode: 'DISK_POOL_EMPTY',
            });
            return 'deferred' as const;
          }
          if (pool) {
            if (catalog !== 'ordinary')
              await pool.recordOrdinaryOwner(row, ownerGuard);
            await input.assertCurrent();
            await ownerGuard.assertOwner();
            signal.throwIfAborted();
          }
          if (assertTicket) await assertTicket(signal);
          createdImage = await this.options.disk.create(
            { vmId: row.vmId, tier: row.diskTier },
            signal,
          );
        }
        inspected = await this.options.disk.inspect(row.vmId, signal);
      }
      if (inspected.state !== 'ready')
        throw new PersonVmError('PROVIDER_FAILED');
      if (!committed) throw new PersonVmError('CLEANUP_INCOMPLETE');
      if (pool?.enabled) {
        await input.assertCurrent();
        await lease.guard(row);
        signal.throwIfAborted();
      }
      if (pool && assertTicket) await assertTicket(signal);
      row.diskTier = inspected.disk.tier;
      row.phase = row.diskTier === 'cold' ? 'cold' : 'stopped';
      row.stoppedAt = this.now().toISOString();
      await lease.save(row);
      await lease.audit(row, { ...audit, result: 'succeeded' });
      if (createdImage && !signal.aborted)
        input.observeFirstDisk?.({ vmId: row.vmId, image: createdImage });
      return 'prepared' as const;
    } catch (error) {
      const failure = safeError(error);
      if (!committed) throw failure;
      row.phase = 'failed';
      try {
        await lease.save(row);
        await lease.audit(row, {
          ...audit,
          result: 'failed',
          errorCode: failure.code,
        });
      } catch (cleanup) {
        throw new PersonVmError(failure.code, {
          cause: new AggregateError([failure, cleanup]),
        });
      }
      throw failure;
    }
  }

  /** Host composition for the committed roster scanner. This port can only
   * claim offline storage and does not create or extend user authority. */
  diskPreparationPort(): PersonVmDiskPreparationPort {
    return {
      prepare: async (target, guard) => {
        const pool = this.options.diskPool;
        if (!pool?.enabled || this.workerDrain) return 'deferred';
        guard.signal.throwIfAborted();
        try {
          return await this.options.store.withLease(
            target.personId,
            {
              now: this.now,
              ttlMs: this.options.leaseTtlMs,
              offlinePreparation: {
                mode: 'prepare',
                organizationId: target.organizationId,
                signal: guard.signal,
              },
            },
            async (lease) => {
              const signal = AbortSignal.any([guard.signal, lease.signal]);
              const assertCurrent = async () => {
                signal.throwIfAborted();
                if (this.workerDrain)
                  throw new PersonVmError('RUNTIME_NOT_READY');
                await guard.assertCurrent();
                signal.throwIfAborted();
              };
              signal.throwIfAborted();
              await lease.assertAdmissionOpen();
              const row = lease.row;
              if (row) this.checkOrganization(row, target.organizationId);
              if (row && !this.unfinishedCreate(row)) {
                await this.assertNoPendingDisk(row, signal);
                return 'already-prepared';
              }
              if (!(await pool.canPrepare(target.personId, signal)))
                return 'deferred';
              await guard.assertCapacity();
              return this.createDiskOwned(
                row ?? this.newVmRecord(target),
                lease,
                signal,
                {
                  action: 'disk-preprovision',
                  requestId: randomUUID(),
                  lane: 'admin',
                  assertCurrent,
                },
              );
            },
          );
        } catch (error) {
          if (error instanceof PersonVmError && error.code === 'LEASE_CONFLICT')
            return 'deferred';
          throw error;
        }
      },
    };
  }
  private validateReceipt(
    binding: PersonVmBinding,
    receipt: PersonVmEgressReceipt,
  ) {
    if (
      !receipt ||
      !receipt.binding ||
      !sameVmBinding(binding, receipt.binding) ||
      typeof receipt.bindingId !== 'string' ||
      !receipt.bindingId ||
      !Array.isArray(receipt.gatewayPorts) ||
      receipt.gatewayPorts.length === 0 ||
      receipt.gatewayPorts.some(
        (port) => !Number.isInteger(port) || port < 1 || port > 65535,
      ) ||
      new Set(receipt.gatewayPorts).size !== receipt.gatewayPorts.length
    )
      throw new PersonVmError('EGRESS_BINDING_INVALID');
  }
  private receipt(
    binding: PersonVmBinding,
    value: PersonVmEgressReceipt,
  ): PersonVmEgressReceipt {
    this.validateReceipt(binding, value);
    return Object.freeze({
      binding: Object.freeze({ ...binding }),
      bindingId: value.bindingId,
      gatewayPorts: Object.freeze([...value.gatewayPorts]),
    });
  }
  private async reconcileDisk(
    row: VmRecord,
    signal: AbortSignal,
    lease: VmLease,
  ) {
    await this.assertNoPendingDisk(row, signal);
    const inspected = await this.options.disk.inspect(row.vmId, signal);
    if (inspected.state !== 'ready') {
      if (
        inspected.state !== 'absent' ||
        row.instanceId ||
        row.nativeCreated ||
        (row.phase !== 'starting' && row.phase !== 'failed')
      )
        throw new PersonVmError('PROVIDER_FAILED');
      return { state: 'absent' } as const;
    }
    if (row.diskTier !== inspected.disk.tier) {
      row.diskTier = inspected.disk.tier;
      if (row.phase === 'cold' || row.phase === 'stopped')
        row.phase = row.diskTier === 'cold' ? 'cold' : 'stopped';
      await lease.save(row);
    }
    return inspected;
  }
  private async mounted(
    row: VmRecord,
    signal: AbortSignal,
    lease: VmLease,
    beforeAttach?: () => void,
  ) {
    if ((await this.reconcileDisk(row, signal, lease)).state !== 'ready')
      throw new PersonVmError('PROVIDER_FAILED');
    const binding = bindingOf(row);
    this.options.observeOwnedMount?.(binding);
    const mount = await this.options.disk.attach(
      { vmId: row.vmId, tier: row.diskTier },
      signal,
      beforeAttach,
    );
    await this.options.native.prepare(binding, mount, signal);
    return mount;
  }
  private async pingRunning(row: VmRecord, signal: AbortSignal) {
    if (!this.options.egress || !row.egressReceipt)
      throw new PersonVmError('RUNTIME_NOT_READY');
    const binding = bindingOf(row);
    row.egressReceipt = this.receipt(binding, row.egressReceipt);
    await this.options.egress.assertActive(row.egressReceipt, signal);
    await this.options.native.ping(binding, signal);
    return binding;
  }
  private async ready(
    row: VmRecord,
    signal: AbortSignal,
    context?: RequestContext,
    scheduled = false,
  ) {
    if (!this.options.runtime) throw new PersonVmError('RUNTIME_NOT_READY');
    const binding = await this.pingRunning(row, signal);
    if (scheduled) {
      if (!this.options.runtime.assertScheduledReady)
        throw new PersonVmError('RUNTIME_NOT_READY');
      return this.options.runtime.assertScheduledReady(binding, signal);
    }
    const result = context
      ? await this.options.runtime.readiness(binding, signal, context)
      : await this.options.runtime.readiness(binding, signal);
    if (
      !result ||
      !sameVmBinding(result.binding, binding) ||
      result.authenticated !== true ||
      result.editorReady !== true ||
      result.canSend !== true
    )
      throw new PersonVmError('RUNTIME_NOT_READY');
  }
  start(
    context: RequestContext,
    signal: AbortSignal,
    target?: PersonVmPrewarmFence,
    observer: PersonVmPrewarmObserver | undefined = target,
  ) {
    return this.startForSelection(context, signal, target, observer);
  }
  private startForSelection(
    context: RequestContext,
    signal: AbortSignal,
    target?: PersonVmPrewarmFence,
    observer: PersonVmPrewarmObserver | undefined = target,
    selectedStartup?: SelectedStartup,
    foregroundOpen = false,
  ) {
    const startup = target?.orphanedStart;
    return this.leased(
      context,
      'start',
      signal,
      async (lease, _identity, current) => {
        this.assertPrewarmTarget(lease.row, target);
        if (target) await target.assertAuthority(current);
        try {
          return await this.startOwned(
            context,
            lease,
            current,
            target,
            observer,
            selectedStartup,
            foregroundOpen ? target?.dispatchUpgradeStop : undefined,
          );
        } catch (error) {
          const row = lease.row;
          if (
            startup &&
            lease.ownerToken &&
            !current.aborted &&
            row?.instanceId &&
            (row.phase === 'starting' ||
              row.phase === 'stopped' ||
              row.phase === 'failed') &&
            sameVmBinding(bindingOf(row), startup.predecessor) &&
            error instanceof PersonVmError &&
            [
              'ACTIVITY_UNKNOWN',
              'CLEANUP_INCOMPLETE',
              'PROVIDER_FAILED',
              'RUNTIME_NOT_READY',
              'VM_ACTIVE',
              'EGRESS_UNAVAILABLE',
              'WEB_ENDPOINTS_PREPARING',
            ].includes(error.code)
          )
            startup.observeFailure?.(lease.ownerToken, row.phase);
          throw error;
        }
      },
      {
        joinOfflinePreparation: true,
        ...(target && {
          beforeClaim: (row, ownerToken, active) => {
            signal.throwIfAborted();
            active.throwIfAborted();
            if (row) this.checkOrganization(row, context.organizationId);
            this.assertPrewarmTarget(row, target);
            if (!startup) return;
            if (
              row?.phase !== 'starting' ||
              !row.instanceId ||
              !row.diskRetained ||
              target?.vmId !== row.vmId ||
              target.instanceId !== null ||
              target.leaseEpoch !== row.leaseEpoch + 1 ||
              !sameVmBinding(bindingOf(row), startup.predecessor)
            )
              throw new PersonVmError('LEASE_LOST');
            startup.observeLease(ownerToken, active);
          },
        }),
        ...(startup && {
          observeRelease(ownerToken, rowVersion, stage) {
            startup.observeRelease?.(ownerToken, rowVersion, stage);
          },
        }),
      },
    );
  }
  /** Host-only retained resume. The claim and the sessionless authority read
   * are rechecked by readRoster while this exact physical lease is owned. */
  async startRetainedForSchedule(
    previous: PersonVmBinding,
    requestId: string,
    authority: Pick<ScheduledStart, 'readRoster' | 'withCurrentAuthority'>,
    signal: AbortSignal,
  ) {
    UuidSchema.parse(requestId);
    const intent: ScheduledStart = {
      purpose: 'scheduled-wake',
      requestId,
      readRoster: authority.readRoster,
      withCurrentAuthority: authority.withCurrentAuthority,
    };
    return this.options.store.withLease(
      previous.personId,
      { now: this.now, ttlMs: this.options.leaseTtlMs },
      async (lease) => {
        const active = AbortSignal.any([signal, lease.signal]);
        active.throwIfAborted();
        const row = lease.row;
        if (
          !row?.instanceId ||
          !row.diskRetained ||
          !row.nativeCreated ||
          !sameVmBinding(bindingOf(row), previous) ||
          (row.phase !== 'stopped' && row.phase !== 'cold') ||
          row.egressReceipt
        )
          throw new PersonVmError('LEASE_LOST');
        await lease.assertAdmissionOpen(true);
        const work = (current: AbortSignal) =>
          this.inLeaseFrame(intent, row.personId, lease, () =>
            this.startOwned(intent, lease, current),
          );
        return this.admissionHost
          ? this.admissionHost.trackOwner(row.personId, active, work)
          : work(active);
      },
    );
  }
  private async webRoster(context: RequestContext, signal: AbortSignal) {
    if (!this.options.nativeWeb) return undefined;
    try {
      signal.throwIfAborted();
      const roster = checkedWebRoster(
        await this.options.nativeWeb.prepare(context, signal),
      );
      signal.throwIfAborted();
      return roster;
    } catch (error) {
      if (isAuthorizationFailure(error))
        throw new PersonVmError('AUTHORIZATION_DENIED', { cause: error });
      throw safeError(error);
    }
  }
  private async startOwned(
    intent: RequestContext | ScheduledStart,
    lease: VmLease,
    signal: AbortSignal,
    target?: PersonVmPrewarmFence,
    observer?: PersonVmPrewarmObserver,
    selectedStartup?: SelectedStartup,
    dispatchUpgradeStop?: PersonVmPrewarmFence['dispatchUpgradeStop'],
  ) {
    const scheduled = 'purpose' in intent ? intent : undefined;
    const context = 'actor' in intent ? intent : undefined;
    const action = scheduled ? 'scheduled-wake.start' : 'start';
    const assertAuthority =
      target &&
      ((active: AbortSignal) => assertPrewarmAuthority(target, active));
    if (this.workerDrain) throw new PersonVmError('RUNTIME_NOT_READY');
    const accessOrder = ++this.idleAccessOrder;
    const row = this.required(lease.row);
    const firstDisk =
      row.phase === 'stopped' &&
      row.diskTier === 'warm' &&
      !row.instanceId &&
      !row.nativeCreated &&
      !row.egressReceipt &&
      row.leaseEpoch === 0 &&
      !lease.joinedOfflinePreparation &&
      selectedStartup?.firstDisk?.vmId === row.vmId
        ? selectedStartup.firstDisk
        : undefined;
    await this.assertNoPendingDisk(row, signal);
    if (row.instanceId && this.options.hasUnconfirmedEgress?.(bindingOf(row)))
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    if (!this.options.egress) throw new PersonVmError('EGRESS_UNAVAILABLE');
    if (!this.options.runtime) throw new PersonVmError('RUNTIME_NOT_READY');
    if (
      typeof this.options.runtime.memoryGuestPlan !== 'function' ||
      typeof this.options.native.bootstrap !== 'function'
    )
      throw new PersonVmError('RUNTIME_NOT_READY');
    if (
      this.options.nativeWeb &&
      (!this.options.native.prepareWebEndpoints ||
        !this.options.native.assertWebEndpoints ||
        !this.options.runtime.retireAfterNativeStop)
    )
      throw new PersonVmError('RUNTIME_NOT_READY');
    if (row.phase !== 'running')
      await this.admissionHost?.recoverStoppedEntryPermits(lease, signal);
    const readRoster = (active: AbortSignal) =>
      scheduled
        ? scheduled.readRoster(active).then(checkedWebRoster)
        : this.webRoster(context!, active);
    if (
      scheduled &&
      (!this.options.nativeWeb || !this.options.runtime.assertScheduledReady)
    )
      throw new PersonVmError('RUNTIME_NOT_READY');
    const roster = await readRoster(signal);
    if (
      roster &&
      (roster.personId !== row.personId ||
        roster.organizationId !== row.organizationId)
    )
      throw new PersonVmError('AUTHORIZATION_DENIED');
    const selectedEmployee = selectedStartup?.employee;
    if (
      roster &&
      selectedEmployee &&
      !roster.entries.some(
        (employee) =>
          selectedEmployee.workspaceId === employee.workspaceId &&
          selectedEmployee.employeeInstanceId === employee.employeeInstanceId &&
          selectedEmployee.employeeRevision === employee.employeeRevision &&
          selectedEmployee.employeeVersionId === employee.employeeVersionId,
      )
    )
      throw new PersonVmError('AUTHORIZATION_DENIED');
    if (await this.canStopPreviousWorkerVm(lease, row)) {
      if (!context) throw new PersonVmError('AUTHORIZATION_DENIED');
      if (
        !dispatchUpgradeStop ||
        context.actor.type !== 'user' ||
        !assertAuthority
      )
        throw new PersonVmError('UPGRADE_OPEN_REQUIRED');
      await assertAuthority(signal);
      await this.stopForUpgrade(
        lease,
        row,
        intent.requestId,
        signal,
        true,
        assertAuthority,
        undefined,
        dispatchUpgradeStop,
      );
      await assertAuthority(signal);
    }
    if (row.phase === 'running') {
      if (!context) throw new PersonVmError('AUTHORIZATION_DENIED');
      if (this.options.diskPool && assertAuthority)
        await assertAuthority(signal);
      await this.mounted(row, signal, lease);
      if (roster) {
        await lease.guard();
        await this.options.native.prepareWebEndpoints!(
          bindingOf(row),
          roster,
          signal,
          { runningOnly: true },
        );
        await lease.guard();
      }
      await this.ready(row, signal, context);
      if (roster && (await readRoster(signal))?.digest !== roster.digest)
        throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
      if (this.options.diskPool && assertAuthority)
        await assertAuthority(signal);
      await this.observeCurrentAccess(context, row, accessOrder, signal);
      return view(row, true);
    }
    if (row.holds.length > 0) throw new PersonVmError('VM_ACTIVE');
    if (
      row.phase === 'failed' ||
      row.phase === 'starting' ||
      row.egressReceipt
    ) {
      // Confirm the ticket before taking responsibility for the prior
      // generation. Once reconciliation starts its owned cleanup must finish.
      if (assertAuthority) await assertAuthority(signal);
      if ((await this.takeoverSafe(row, signal, lease)).state !== 'ready')
        throw new PersonVmError('PROVIDER_FAILED');
      if (
        row.egressReceipt &&
        this.options.ownsEgressReceipt &&
        !this.options.ownsEgressReceipt(
          this.receipt(bindingOf(row), row.egressReceipt),
        )
      )
        throw new PersonVmError('CLEANUP_INCOMPLETE');
      await this.cleanup(row, lease, 'takeover');
    }
    await lease.assertAdmissionOpen(true);
    if (assertAuthority) await assertAuthority(signal);
    if (this.workerDrain) throw new PersonVmError('RUNTIME_NOT_READY');
    const previousBinding = row.instanceId ? bindingOf(row) : undefined;
    row.leaseEpoch += 1;
    row.instanceId = randomUUID();
    row.phase = 'starting';
    row.stoppedAt = null;
    row.idleSince = null;
    row.activityObservedAt = null;
    row.lastActivityAt = this.now().toISOString();
    target?.orphanedStart?.observeInstance(bindingOf(row));
    let previousCapacityReleased = false;
    if (lease.reserveStartup)
      previousCapacityReleased = await lease.reserveStartup(row);
    else await lease.save(row);
    observer?.observeVmStart?.(bindingOf(row));
    if (previousBinding)
      this.admissionHost?.forgetStoppedEntryRecovery(previousBinding);
    await lease.audit(row, {
      requestId: intent.requestId,
      action,
      result: 'started',
    });
    let nativeStartAttempted = false;
    try {
      const binding = bindingOf(row);
      this.options.observeOwnedStart?.(binding, context);
      signal.throwIfAborted();
      await lease.guard();
      if (assertAuthority) await assertAuthority(signal);
      if (row.diskTier === 'cold') {
        await this.options.disk.move(
          { vmId: row.vmId, tier: 'cold' },
          'warm',
          signal,
        );
        row.diskTier = 'warm';
        await lease.save(row);
      }
      let attachedHere = false;
      const mount = await this.mounted(
        row,
        signal,
        lease,
        firstDisk
          ? () => {
              attachedHere = true;
            }
          : undefined,
      );
      await lease.guard();
      if (
        row.nativeCreated &&
        roster &&
        !this.options.native.assertRetainedStartup &&
        (await this.options.native.status(binding, signal)) !== 'stopped'
      )
        throw new PersonVmError('PROVIDER_FAILED');
      const receipt = this.receipt(
        binding,
        await this.options.egress.prepare(
          binding,
          { gatewayPorts: Object.freeze([...row.gatewayPorts]), mount },
          signal,
        ),
      );
      row.egressReceipt = receipt;
      await lease.save(row);
      signal.throwIfAborted();
      if (
        row.nativeCreated &&
        JSON.stringify([...receipt.gatewayPorts].sort((a, b) => a - b)) !==
          JSON.stringify([...row.gatewayPorts].sort((a, b) => a - b))
      )
        throw new PersonVmError('EGRESS_BINDING_INVALID');
      if (!row.nativeCreated) row.gatewayPorts = [...receipt.gatewayPorts];
      await lease.save(row);
      await lease.guard();
      await this.options.egress.assertActive(receipt, signal);
      let web: PersonVmWebStartup | undefined;
      if (roster) {
        const endpoints = await this.options.native.prepareWebEndpoints!(
          binding,
          roster,
          signal,
          row.nativeCreated ? { retained: true } : undefined,
        );
        if (
          !sameVmBinding(endpoints.binding, binding) ||
          endpoints.rosterDigest !== roster.digest
        )
          throw new PersonVmError('LEASE_LOST');
        checkedWebRoster({
          ...roster,
          entries: endpoints.endpoints,
          digest: endpoints.rosterDigest,
        });
        for (const key of ['hostPort', 'guestPort'] as const) {
          if (
            new Set(endpoints.endpoints.map((entry) => entry[key])).size !==
              endpoints.endpoints.length ||
            endpoints.endpoints.some(
              (entry) =>
                !Number.isInteger(entry[key]) ||
                entry[key] < 1 ||
                entry[key] > 65535,
            )
          )
            throw new PersonVmError('PROVIDER_FAILED');
        }
        web = Object.freeze({
          ...(scheduled
            ? { purpose: 'scheduled-wake' as const }
            : { context: context! }),
          receipt: endpoints,
          recordNativeFailure: (
            failure: NativeWebSetupFailure,
            signal: AbortSignal,
          ) => {
            const event = {
              requestId: intent.requestId,
              action: 'start.native-web.' + failure.step,
              result: 'failed' as const,
              errorCode: JSON.stringify(failure),
            };
            const store = this.options.store;
            return store.auditStartupFailure
              ? store.auditStartupFailure(row, event, signal)
              : lease.audit(row, event);
          },
        });
        await lease.guard();
      }
      const native = this.options.native;
      const state = await native.status(binding, signal);
      if (assertAuthority) await assertAuthority(signal);
      if (this.workerDrain) throw new PersonVmError('RUNTIME_NOT_READY');
      let checkedWebAfterStart = false;
      let capacity: Awaited<ReturnType<PersonVmNativePort['start']>>;
      let createdNative = false;
      if (!scheduled && state === 'absent' && !row.nativeCreated) {
        capacity = undefined;
        if (web) await native.create(binding, receipt, signal, web.receipt);
        else await native.create(binding, receipt, signal);
        createdNative = true;
        row.nativeCreated = true;
        await lease.save(row);
      } else if (
        row.nativeCreated &&
        (state === 'stopped' ||
          (state === 'absent' && web?.receipt.upgrade === 'pending'))
      ) {
        const start = async (active: AbortSignal) => {
          await lease.guard();
          active.throwIfAborted();
          nativeStartAttempted = true;
          if (web && native.startWithWebEndpoints) {
            const fence = await native.startWithWebEndpoints(
              web.receipt,
              active,
              receipt,
            );
            checkedWebAfterStart = true;
            return fence;
          }
          return native.start(binding, active);
        };
        if (scheduled) {
          if (!roster) throw new PersonVmError('AUTHORIZATION_DENIED');
          capacity = await scheduled.withCurrentAuthority(
            roster.digest,
            signal,
            start,
          );
        } else capacity = await start(signal);
      } else throw new PersonVmError('PROVIDER_FAILED');
      const startingSignal = capacity
        ? AbortSignal.any([signal, capacity.signal])
        : signal;
      startingSignal.throwIfAborted();
      if (web && !checkedWebAfterStart)
        await native.assertWebEndpoints!(web.receipt, startingSignal);
      await lease.guard();
      const frame = this.currentLease.getStore();
      const assertStartupAuthority = async (active: AbortSignal) => {
        if (!frame?.active || frame.lease !== lease)
          throw new PersonVmError('LEASE_LOST');
        await lease.guard();
        if (context) {
          const identity = await this.identity(context, 'start', active);
          if (
            identity.personId !== binding.personId ||
            identity.organizationId !== binding.organizationId
          )
            throw new PersonVmError('AUTHORIZATION_DENIED');
        }
        if (row.phase !== 'starting' || !sameVmBinding(bindingOf(row), binding))
          throw new PersonVmError('LEASE_LOST');
        await lease.assertAdmissionOpen(true);
        await this.options.egress!.assertActive(receipt, active);
        if (roster) {
          const current = (await readRoster(active))!;
          if (
            current.personId !== binding.personId ||
            current.organizationId !== binding.organizationId ||
            current.digest !== roster.digest
          )
            throw new PersonVmError('AUTHORIZATION_DENIED');
        }
        await lease.guard();
        if (assertAuthority) await assertAuthority(active);
        active.throwIfAborted();
      };
      const assertStarting = async () => {
        await assertStartupAuthority(startingSignal);
        await capacity?.assertCurrent();
        startingSignal.throwIfAborted();
      };
      if (web && selectedEmployee) {
        const read = this.options.readUnusedEmployeeHomes;
        let unusedEmployeeHomes = false;
        if (firstDisk && attachedHere && createdNative && read) {
          const hasExactMount = async () => {
            await assertStarting();
            const attached = await this.options.disk.inspectMount?.(
              { vmId: row.vmId, tier: 'warm' },
              startingSignal,
              { image: firstDisk.image },
            );
            startingSignal.throwIfAborted();
            return attached?.state === 'attached' && attached.mount === mount;
          };
          if (await hasExactMount()) {
            await assertStarting();
            unusedEmployeeHomes =
              (await read(
                {
                  binding,
                  signal: startingSignal,
                  assertCurrent: assertStarting,
                },
                mount,
              )) && (await hasExactMount());
          }
        }
        web = Object.freeze({
          ...web,
          selectedEmployee,
          ...(unusedEmployeeHomes && { unusedEmployeeHomes: true as const }),
        });
      }
      await bootstrapPersonVm({
        binding,
        signal: startingSignal,
        native: this.options.native,
        runtime: this.options.runtime,
        assertCurrent: assertStarting,
        web,
      });
      await assertStarting();
      await this.ready(row, startingSignal, context, !!scheduled);
      await assertStarting();
      const publish = async (active: AbortSignal) => {
        await assertStartupAuthority(active);
        if (capacity) {
          // Transfer the native pre-reservation before publishing running.
          // It is now charged until physical stop even if a signal expires.
          await capacity.commitRunning();
          await assertStartupAuthority(active);
        }
        active.throwIfAborted();
        row.phase = 'running';
        row.verifiedWebSlotCapacity =
          web?.receipt.slots?.length ?? row.verifiedWebSlotCapacity;
        await lease.save(row, {
          audit: {
            requestId: intent.requestId,
            action,
            result: 'succeeded',
          },
        });
        // The row remains owned by this lease until the accepted prewarm
        // authority is confirmed after saving it.
        if (assertAuthority) await assertAuthority(active);
        active.throwIfAborted();
      };
      if (scheduled) {
        if (!roster) throw new PersonVmError('AUTHORIZATION_DENIED');
        await scheduled.withCurrentAuthority(roster.digest, signal, publish);
        this.options.observeScheduledStart?.(binding, roster);
      } else await publish(signal);
      return view(row, !scheduled);
    } catch (error) {
      const failure = safeError(error);
      try {
        await lease.audit(row, {
          requestId: intent.requestId,
          action,
          result: 'failed',
          errorCode: failure.code,
        });
      } catch {
        /* Failure audit cannot prevent physical cleanup after a lost DB connection. */
      }
      try {
        await this.cleanup(
          row,
          lease,
          'failure',
          !scheduled || nativeStartAttempted,
          {
            unstartedCapacity:
              scheduled && !nativeStartAttempted && previousCapacityReleased,
          },
        );
      } catch {
        throw new PersonVmError('CLEANUP_INCOMPLETE', { cause: failure });
      }
      throw failure;
    }
  }
  private async confirmRunning(
    row: VmRecord,
    context: RequestContext,
    signal: AbortSignal,
    target?: PersonVmPrewarmFence,
    prepareEditor = false,
  ) {
    await this.assertNoPendingDisk(row, signal);
    if (target) await target.assertAuthority(signal);
    const binding = bindingOf(row);
    if (row.leaseOwner) throw new PersonVmError('LEASE_CONFLICT');
    const roster = await this.webRoster(context, signal);
    if (roster) {
      if (
        roster.personId !== row.personId ||
        roster.organizationId !== row.organizationId
      )
        throw new PersonVmError('AUTHORIZATION_DENIED');
      if (!this.options.native.prepareWebEndpoints)
        throw new PersonVmError('RUNTIME_NOT_READY');
      if (target && this.options.diskPool) await target.assertAuthority(signal);
      const endpoints = await this.options.native.prepareWebEndpoints(
        binding,
        roster,
        signal,
        { runningOnly: true },
      );
      if (
        !sameVmBinding(endpoints.binding, binding) ||
        endpoints.rosterDigest !== roster.digest
      )
        throw new PersonVmError('LEASE_LOST');
    }
    await this.ready(row, signal, prepareEditor ? context : undefined);
    if (
      roster &&
      (await this.webRoster(context, signal))?.digest !== roster.digest
    )
      throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
    const confirmed = await this.identity(context, 'start', signal);
    if (
      confirmed.personId !== row.personId ||
      confirmed.organizationId !== row.organizationId
    )
      throw new PersonVmError('AUTHORIZATION_DENIED');
    if (target && this.options.diskPool) await target.assertAuthority(signal);
    await this.assertCurrentBinding(context, binding, signal);
    signal.throwIfAborted();
  }
  /** Observe the same running proof without a cold create/start fallback. */
  async assertRunningReadiness(
    context: RequestContext,
    binding: PersonVmBinding,
    signal: AbortSignal,
    webSlots?: PersonVmWebEndpointReceipt,
  ) {
    const identity = await this.identity(context, 'start', signal);
    const row = this.required(await this.options.store.read(identity.personId));
    this.checkOrganization(row, identity.organizationId);
    if (
      row.phase !== 'running' ||
      row.leaseOwner ||
      !sameVmBinding(bindingOf(row), binding)
    )
      throw new PersonVmError('LEASE_CONFLICT');
    if (!webSlots) return this.confirmRunning(row, context, signal);
    // A running v2 pool has fixed physical ports even as other employees are
    // added or removed. The caller pins the selected authenticated editor.
    if (!webSlots.slots || !sameVmBinding(webSlots.binding, binding))
      throw new PersonVmError('LEASE_LOST');
    if (!this.options.native.assertWebEndpoints)
      throw new PersonVmError('RUNTIME_NOT_READY');
    await this.assertNoPendingDisk(row, signal);
    await this.options.native.assertWebEndpoints(webSlots, signal);
    await this.pingRunning(row, signal);
    await this.assertCurrentBinding(context, binding, signal);
    signal.throwIfAborted();
  }
  async prewarm(
    context: RequestContext,
    input: PersonVmPrewarmInput,
    signal: AbortSignal,
  ) {
    if (this.workerDrain) throw new PersonVmError('RUNTIME_NOT_READY');
    if (!['page', 'input', 'open'].includes(input.trigger))
      throw new PersonVmError('AUTHORIZATION_DENIED');
    const work = () =>
      this.prewarmCurrent(
        context,
        signal,
        input.target,
        input.observer,
        input.selectedEmployee,
        input.trigger === 'open',
      );
    return this.options.diskPool
      ? this.options.diskPool.inForeground(work)
      : work();
  }
  private async prewarmCurrent(
    context: RequestContext,
    signal: AbortSignal,
    target?: PersonVmPrewarmFence,
    observer?: PersonVmPrewarmObserver,
    selectedEmployee?: PersonVmEmployeeSelection,
    foregroundOpen = false,
  ): Promise<PersonVmView> {
    const identity = await this.identity(context, 'start', signal);
    if (
      selectedEmployee &&
      (selectedEmployee.personId !== identity.personId ||
        selectedEmployee.organizationId !== identity.organizationId ||
        (context.workspaceId !== null &&
          context.workspaceId !== selectedEmployee.workspaceId))
    )
      throw new PersonVmError('AUTHORIZATION_DENIED');
    const start = (
      nextTarget?: PersonVmPrewarmFence,
      firstDisk?: FirstPrewarmDisk,
      startupObserver = observer ?? nextTarget,
    ) =>
      this.startForSelection(
        context,
        signal,
        nextTarget,
        startupObserver,
        selectedEmployee && { employee: selectedEmployee, firstDisk },
        foregroundOpen,
      );
    const row = await this.options.store.read(identity.personId);
    if (row) this.checkOrganization(row, identity.organizationId);
    const takeover = this.upgradePrewarms.get(identity.personId);
    if (takeover) {
      // Another employee or login on this same physical VM must still prove
      // its own current authority and editor readiness after the transition.
      const joined = Promise.allSettled([takeover.work]);
      const [outcome] = await new Promise<Awaited<typeof joined>>(
        (resolve, reject) => {
          const listener = addAbortListener(signal, () =>
            reject(signal.reason),
          );
          void joined.then((result) => {
            listener[Symbol.dispose]();
            resolve(result);
          });
        },
      );
      signal.throwIfAborted();
      const exact = takeover.receipt.binding;
      // Only the joined local start can complete an open ticket's partial
      // target. The new login still rechecks its own authority and readiness.
      if (
        outcome.status === 'fulfilled' &&
        foregroundOpen &&
        target?.dispatchUpgradeStop &&
        target.instanceId === null &&
        exact?.vmId === target.vmId &&
        exact.leaseEpoch === target.leaseEpoch
      ) {
        const current = await this.options.store.read(identity.personId);
        const joinedTarget = { ...target, instanceId: exact.instanceId };
        this.assertPrewarmTarget(current, joinedTarget);
        if (
          current?.phase !== 'running' ||
          !sameVmBinding(bindingOf(current), exact)
        )
          throw new PersonVmError('LEASE_LOST');
        await this.confirmRunning(current, context, signal, joinedTarget, true);
        takeover.signal.throwIfAborted();
        (observer ?? target).observeVmStart?.(exact);
        return view(current, true);
      }
      return this.prewarmCurrent(
        context,
        signal,
        target,
        observer,
        selectedEmployee,
        foregroundOpen,
      );
    }
    this.assertPrewarmTarget(row, target, true);
    if (
      (row?.phase === 'running' || row?.phase === 'failed') &&
      this.needsUpgradeStop(row)
    ) {
      if (
        !foregroundOpen ||
        !target?.dispatchUpgradeStop ||
        context.actor.type !== 'user'
      )
        throw new PersonVmError('UPGRADE_OPEN_REQUIRED');
      const receipt: UpgradePrewarm['receipt'] = {};
      const startupObserver = observer ?? target;
      const opening = start(target, undefined, {
        ...startupObserver,
        observeVmStart(binding) {
          receipt.binding = binding;
          startupObserver.observeVmStart?.(binding);
        },
      })
        .then(async (result) => {
          // The persisted start can outlive the original ticket while its
          // physical lease is releasing. Recheck before sharing the receipt.
          signal.throwIfAborted();
          await target.assertAuthority(signal);
          signal.throwIfAborted();
          return result;
        })
        .finally(() => {
          this.upgradePrewarms.delete(identity.personId);
        });
      this.upgradePrewarms.set(identity.personId, {
        work: opening,
        receipt,
        signal,
      });
      return opening;
    }
    // An exact orphan already has its retained disk and predecessor. Claim
    // the start directly so a no-op create does not acquire a separate lease.
    if (target?.orphanedStart) return start(target);
    if (row?.phase === 'running') {
      await this.confirmRunning(row, context, signal, target, true);
      return view(row, true);
    }

    let firstDisk: FirstPrewarmDisk | undefined;
    const canProveFirstDisk =
      selectedEmployee &&
      this.options.readUnusedEmployeeHomes &&
      target?.vmId === null &&
      target.instanceId === null &&
      target.leaseEpoch === 1 &&
      !target.replacesVmId &&
      !target.restoreRetained;
    const created = canProveFirstDisk
      ? await this.createForStartup(
          context,
          signal,
          target,
          observer,
          (proof) => {
            firstDisk = proof;
          },
        )
      : await this.create(context, signal, target, observer);
    return start(
      target && { ...target, vmId: target.vmId ?? created.vmId },
      firstDisk,
    );
  }
  private async inactive(
    row: VmRecord,
    signal: AbortSignal,
  ): Promise<PersonVmActivity> {
    if (row.holds.length > 0) throw new PersonVmError('VM_ACTIVE');
    if (!this.options.runtime) throw new PersonVmError('ACTIVITY_UNKNOWN');
    let snapshot: PersonVmActivity;
    try {
      snapshot = await this.options.runtime.activity(bindingOf(row), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new PersonVmError('ACTIVITY_UNKNOWN', { cause: error });
    }
    if (!snapshot) throw new PersonVmError('ACTIVITY_UNKNOWN');
    const age = this.now().getTime() - Date.parse(snapshot.observedAt);
    if (
      !sameVmBinding(snapshot.binding, bindingOf(row)) ||
      snapshot.state !== 'known' ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > this.options.activityMaxAgeMs
    )
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    const counts = [
      snapshot.activeTurns,
      snapshot.activeJobs,
      snapshot.activeSubtasks,
      snapshot.pendingApprovals,
    ];
    if (!counts.every((value) => Number.isInteger(value) && value >= 0))
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    if (counts.some((value) => value > 0)) throw new PersonVmError('VM_ACTIVE');
    return snapshot;
  }
  private async takeoverSafe(
    row: VmRecord,
    signal: AbortSignal,
    lease: VmLease,
  ) {
    if (row.holds.length > 0) throw new PersonVmError('VM_ACTIVE');
    const inspected = await this.reconcileDisk(row, signal, lease);
    if (!row.instanceId) {
      if (row.nativeCreated) throw new PersonVmError('PROVIDER_FAILED');
      return inspected;
    }
    await this.mounted(row, signal, lease);
    const state = await this.options.native.status(bindingOf(row), signal);
    if (state === 'unknown') throw new PersonVmError('ACTIVITY_UNKNOWN');
    if (state === 'running') {
      await this.inactive(row, signal);
      // Instantaneous zero counts neither cover the intervening window nor
      // freeze native admission. No public VM-wide primitive is wired yet.
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    }
    return inspected;
  }
  private async cleanup(
    row: VmRecord,
    lease: VmLease,
    reason: 'stop' | 'failure' | 'takeover' | 'delete',
    stopNative = true,
    completion?: {
      audit?: VmAudit;
      idle?: IdleStopGuard;
      nativeAlreadyJoined?: boolean;
      requireNativeStopped?: boolean;
      /** This attempt never dispatched, and the prior epoch already released. */
      unstartedCapacity?: boolean;
      onDetached?: (mount: string, signal: AbortSignal) => Promise<void>;
    },
  ) {
    const { idle, onDetached } = completion ?? {};
    const retainedDeletion = reason === 'delete' && row.phase === 'deleted';
    const platformDetach = reason === 'delete' && onDetached !== undefined;
    let failed = false;
    let egressJoined = true;
    let stopped: 'stopped' | 'absent' | undefined;
    const stopAndConfirm = async (signal: AbortSignal) => {
      const binding = bindingOf(row);
      if (stopNative && !completion?.nativeAlreadyJoined) {
        if (platformDetach || completion?.requireNativeStopped)
          await this.options.native.stop(binding, signal, {
            requireStopped: true,
          });
        else await this.options.native.stop(binding, signal);
      }
      const state = await this.options.native.status(binding, signal);
      if (state === 'stopped') row.nativeCreated = true; // Native create may have committed before a failed host save/ack.
      return state === 'stopped' || state === 'absent' ? state : undefined;
    };
    if (idle) {
      const signal = AbortSignal.any([
        idle.signal,
        AbortSignal.timeout(this.options.cleanupTimeoutMs),
      ]);
      await this.mounted(row, signal, lease);
      if (!this.options.native.stopIdle)
        throw new PersonVmError('ACTIVITY_UNKNOWN');
      // A denied recheck must leave egress and the running VM intact. Keep
      // slow retirement work on the confirmed side of the native stop.
      const runDispatch = idle.dispatch;
      const dispatch = {
        requestId: idle.requestId,
        action: idle.auditAction ?? 'stop.idle-dispatch',
      };
      await lease.audit(row, { ...dispatch, result: 'started' });
      let dispatchApproved = false;
      let joinedRecorded = false;
      const recordJoin = async () => {
        await lease.audit(row, { ...dispatch, result: 'succeeded' });
        joinedRecorded = true;
      };
      try {
        await this.options.native.stopIdle(
          bindingOf(row),
          signal,
          async () => {
            await idle.assertCurrent(signal);
            signal.throwIfAborted();
            if (!runDispatch) dispatchApproved = true;
          },
          runDispatch &&
            ((active, stop) =>
              runDispatch(active, async (fenced) => {
                fenced.throwIfAborted();
                dispatchApproved = true;
                await stop(fenced);
                // Persist the physical command's join before its separate
                // final status read. A failed readback can then be recovered
                // with the original plan and request.
                if (!idle.auditAction) await recordJoin();
              })),
        );
        if (!dispatchApproved) throw new PersonVmError('ACTIVITY_UNKNOWN');
        // Record the provider's completed, joined stop before any egress or
        // disk cleanup. A prior intent alone cannot activate its wake plan.
        if (!joinedRecorded) await recordJoin();
        stopped = 'stopped';
      } catch (error) {
        if (!dispatchApproved) {
          await lease.audit(row, { ...dispatch, result: 'denied' });
          throw error;
        }
        row.phase = 'failed';
        await lease.save(row);
        throw new PersonVmError('CLEANUP_INCOMPLETE', { cause: error });
      }
    }
    if (completion?.requireNativeStopped) {
      const signal = AbortSignal.timeout(this.options.cleanupTimeoutMs);
      // Keep the previous ownership receipt until the exact stopped native
      // runtime has joined. A failed readback can be retried under its fence.
      await this.mounted(row, signal, lease);
      await lease.guard();
      stopped = await stopAndConfirm(signal);
      if (!stopped) throw new PersonVmError('CLEANUP_INCOMPLETE');
    }
    if (row.egressReceipt) {
      try {
        if (!this.options.egress) throw new PersonVmError('EGRESS_UNAVAILABLE');
        await this.options.egress.revoke(
          this.receipt(bindingOf(row), row.egressReceipt),
          reason,
          AbortSignal.timeout(this.options.cleanupTimeoutMs),
        );
        row.egressReceipt = null;
      } catch {
        failed = true;
        egressJoined = false;
      }
    }
    if (row.instanceId && this.options.hasUnconfirmedEgress?.(bindingOf(row))) {
      failed = true;
      egressJoined = false;
    }
    // Revocation exhausting its budget must not pre-abort the physical stop attempt.
    if (!idle && !stopped) {
      const signal = AbortSignal.timeout(this.options.cleanupTimeoutMs);
      try {
        if (row.instanceId) {
          await this.mounted(row, signal, lease);
          stopped = await stopAndConfirm(signal);
        } else {
          const inspected = await this.reconcileDisk(row, signal, lease);
          if (!row.nativeCreated && inspected.state === 'ready')
            stopped = 'absent';
        }
      } catch {
        failed = true;
      }
    }
    if (stopped) {
      row.stoppedAt ??= this.now().toISOString();
      try {
        if (row.instanceId) {
          if (
            this.options.nativeWeb &&
            !this.options.runtime?.retireAfterNativeStop
          )
            throw new PersonVmError('RUNTIME_NOT_READY');
          await this.options.runtime?.retireAfterNativeStop?.(
            bindingOf(row),
            AbortSignal.timeout(this.options.cleanupTimeoutMs),
          );
        }
        // Keep the exact mount available to finish staged egress cleanup.
        if (egressJoined) {
          const detaching = AbortSignal.timeout(this.options.cleanupTimeoutMs);
          await this.options.disk.detach(
            { vmId: row.vmId, tier: row.diskTier },
            detaching,
            onDetached ? (mount) => onDetached(mount, detaching) : undefined,
          );
        }
      } catch {
        failed = true;
      }
    } else failed = true;
    row.phase = failed ? 'failed' : retainedDeletion ? 'deleted' : 'stopped';
    await lease.save(row, {
      audit: failed ? undefined : completion?.audit,
      capacityReleased:
        (platformDetach || this.options.nativeCapacityAccounting === true) &&
        !failed &&
        (stopNative || completion?.unstartedCapacity === true) &&
        Boolean(row.instanceId),
    });
    if (failed) throw new PersonVmError('CLEANUP_INCOMPLETE');
    if (row.instanceId) {
      const binding = bindingOf(row);
      this.admissionHost?.forgetStoppedEntryRecovery(binding);
      if (!idle && !completion?.nativeAlreadyJoined)
        this.options.observeOwnedStop?.(binding);
    }
    return stopped;
  }
  fenceWorkerStartup() {
    this.workerDrain = true;
    return () => {
      this.workerDrain = false;
    };
  }
  /** Host maintenance can settle its own retained entry work before the
   * read-only shutdown probe; the existing lifecycle lease rechecks the stop. */
  async recoverStoppedEntryWork(binding: PersonVmBinding, signal: AbortSignal) {
    const host = this.admissionHost;
    if (!host?.hasStoppedEntryRecovery(binding)) return;
    const state = await this.options.native.status(binding, signal);
    if (state !== 'stopped' && state !== 'absent') return;
    await this.options.store.withLease(
      binding.personId,
      { now: this.now, ttlMs: this.options.leaseTtlMs },
      (lease) => host.recoverStoppedEntryPermits(lease, signal, binding),
    );
  }
  private async joinRetainedStartupMount(
    owned: RetainedStartupMount,
    lease: VmLease,
    signal: AbortSignal,
  ) {
    const { binding, disk } = owned;
    if (this.retainedStartupMounts.get(binding.personId) !== owned) return;
    const row = lease.row;
    if (
      !row?.instanceId ||
      !row.diskRetained ||
      row.egressReceipt ||
      row.holds.length ||
      row.personId !== binding.personId ||
      row.organizationId !== binding.organizationId ||
      row.vmId !== binding.vmId ||
      !['stopped', 'cold', 'deleted'].includes(row.phase)
    )
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    const exact = sameVmBinding(bindingOf(row), binding);
    if (!exact && row.leaseEpoch <= binding.leaseEpoch)
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    const active = AbortSignal.any([signal, lease.signal]);
    const disks = this.options.disk;
    // A completed rename may be ahead of the stored tier. Only the exact
    // binding's recorded image and actual original layer can prove a detach.
    const original = exact
      ? await disks.inspectMount?.(disk, active, { image: owned.image })
      : undefined;
    if (original?.state !== 'attached' && original?.state !== 'absent') {
      const across = await disks.inspectMount?.(disk, active, {
        image: owned.image,
        acrossTier: true,
      });
      if (across?.state !== 'absent')
        throw new PersonVmError('CLEANUP_INCOMPLETE');
    }
    await (lease.assertPhysicalOwner?.() ?? lease.guard());
    active.throwIfAborted();
    if (original?.state === 'attached') await disks.detach(disk, active);
    this.retainedStartupMounts.delete(binding.personId);
  }

  /** The Worker joins its own temporary mount receipts before going away.
   * The disk provider proves attachment identity without the VM runtime. */
  async settleRetainedStartupMounts(signal: AbortSignal) {
    const failures: unknown[] = [];
    for (const owned of [...this.retainedStartupMounts.values()]) {
      try {
        signal.throwIfAborted();
        await this.options.store.withLease(
          owned.binding.personId,
          { now: this.now, ttlMs: this.options.leaseTtlMs },
          (lease) => this.joinRetainedStartupMount(owned, lease, signal),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new PersonVmError('CLEANUP_INCOMPLETE', {
        cause: new AggregateError(failures),
      });
  }

  /** Verify the retained compute before fresh prewarm can reserve another
   * epoch. Borrow an exact attachment, or join our own attach dispatch. */
  private async assertRetainedStartup(
    binding: PersonVmBinding,
    lease: VmLease,
    signal: AbortSignal,
  ) {
    const { native, disk } = this.options;
    if (!native.assertRetainedStartup) {
      if ((await native.status(binding, signal)) !== 'stopped')
        throw new PersonVmError('PROVIDER_FAILED');
      return;
    }
    const inspected = await disk.inspect(binding.vmId, signal);
    if (inspected.state !== 'ready' || !disk.inspectMount)
      throw new PersonVmError('PROVIDER_FAILED');
    const attached = await disk.inspectMount(inspected.disk, signal);
    if (attached.state === 'unknown')
      throw new PersonVmError('PROVIDER_FAILED');
    await lease.guard();
    signal.throwIfAborted();
    if (attached.state === 'attached') {
      await native.assertRetainedStartup(binding, attached.mount, signal);
      return;
    }
    const owned = Object.freeze({
      binding: Object.freeze({ ...binding }),
      disk: Object.freeze({ ...inspected.disk }),
      image: attached.image,
    });
    let failure: { cause: unknown } | undefined;
    try {
      const mount = await disk.attach(owned.disk, signal, () => {
        if (this.workerDrain) throw new PersonVmError('RUNTIME_NOT_READY');
        this.retainedStartupMounts.set(binding.personId, owned);
      });
      await native.assertRetainedStartup(binding, mount, signal);
    } catch (cause) {
      failure = { cause };
    }
    try {
      await this.joinRetainedStartupMount(
        owned,
        lease,
        AbortSignal.timeout(this.options.cleanupTimeoutMs),
      );
    } catch (error) {
      throw new PersonVmError('CLEANUP_INCOMPLETE', {
        cause: failure ? new AggregateError([failure.cause, error]) : error,
      });
    }
    if (failure) throw failure.cause;
  }

  /** A current user may prepare a new ticket after verifying the retained
   * compute or reconciling their own old entry. No native start or stop. */
  async reconcileStoppedEntryForPrewarm(
    context: RequestContext,
    binding: PersonVmBinding,
    signal: AbortSignal,
    retained = false,
  ) {
    if (this.workerDrain) throw new PersonVmError('RUNTIME_NOT_READY');
    const host = this.admissionHost;
    if (!retained && !host?.hasStoppedEntryRecovery(binding)) return false;
    const identity = await this.identity(context, 'start', signal);
    if (
      identity.personId !== binding.personId ||
      identity.organizationId !== binding.organizationId
    )
      throw new PersonVmError('AUTHORIZATION_DENIED');
    if (!retained) {
      const state = await this.options.native.status(binding, signal);
      if (state !== 'stopped' && state !== 'absent') return false;
    }
    return this.leased(
      context,
      'start',
      signal,
      async (lease, _identity, current) => {
        const row = lease.row;
        if (!row?.diskRetained) throw new PersonVmError('NOT_FOUND');
        if (!row.instanceId || !sameVmBinding(bindingOf(row), binding))
          throw new PersonVmError('LEASE_LOST');
        if (
          row.phase === 'stopped' ||
          row.phase === 'cold' ||
          (retained && row.phase === 'deleted')
        ) {
          if (row.nativeCreated) {
            if (row.egressReceipt || row.holds.length)
              throw new PersonVmError('VM_ACTIVE');
            await this.assertRetainedStartup(binding, lease, current);
          }
          await lease.guard();
          return true;
        }
        if (retained) throw new PersonVmError('LEASE_LOST');
        if (
          row.phase !== 'running' ||
          !(await host?.recoverStoppedEntryPermits(lease, current, binding))
        )
          return false;
        await lease.assertAdmissionOpen(true);
        await this.identity(context, 'start', current);
        await lease.guard();
        if (
          row.egressReceipt &&
          this.options.ownsEgressReceipt &&
          !this.options.ownsEgressReceipt(
            this.receipt(binding, row.egressReceipt),
          )
        )
          throw new PersonVmError('CLEANUP_INCOMPLETE');
        const stopped = await this.cleanup(row, lease, 'takeover', false);
        if (row.nativeCreated && stopped !== 'stopped')
          throw new PersonVmError('PROVIDER_FAILED');
        return true;
      },
    );
  }
  hasStoppedEntryWork(binding: PersonVmBinding) {
    return this.admissionHost?.hasStoppedEntryRecovery(binding) === true;
  }
  /** A shutdown probe is read-only. Unknown native activity leaves the
   * process and its current owners alive for a later stop attempt. */
  async assertWorkerShutdownSafe(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const row = await this.options.store.read(binding.personId);
    signal.throwIfAborted();
    if (!row || row.organizationId !== binding.organizationId)
      throw new PersonVmError('LEASE_LOST');
    if (row.vmId !== binding.vmId || row.leaseEpoch > binding.leaseEpoch)
      return;
    if (!row.instanceId || !sameVmBinding(binding, bindingOf(row)))
      throw new PersonVmError('LEASE_LOST');
    if (row.holds.length) throw new PersonVmError('VM_ACTIVE');
    if (row.leaseOwner) throw new PersonVmError('LEASE_CONFLICT');
    const state = await this.options.native.status(binding, signal);
    signal.throwIfAborted();
    if (this.admissionShared) {
      const admission = this.admissionShared;
      await admission.transaction(
        binding.personId,
        signal,
        async (tx) => {
          if (!sameVmBinding(rowBinding(tx.row), binding) || tx.row.lease_owner)
            throw new PersonVmError('LEASE_CONFLICT');
          if ((tx.row.holds as unknown[]).length)
            throw new PersonVmError('VM_ACTIVE');
          for (const participant of ['gateway', 'entry'] as const) {
            const counts = await admission.counts(tx, participant);
            if (counts.active || counts.queued)
              throw new PersonVmError('VM_ACTIVE');
          }
        },
        true,
      );
    }
    const store = this.options.store;
    if (store instanceof PostgresPersonVmStore) {
      const idle = await store.idleStopReceipt(binding);
      if (
        idle?.completed === false ||
        (await store.hasUnjoinedIdleStop(binding))
      )
        throw new PersonVmError('CLEANUP_INCOMPLETE');
    }
    signal.throwIfAborted();
    // Production has no public VM-wide autonomous freeze/drain witness.
    // A running VM remains with its current owner, even after SIGTERM.
    if (state !== 'stopped' && state !== 'absent')
      throw new PersonVmError('ACTIVITY_UNKNOWN');
  }
  /** Internal Worker shutdown after its ingress and selection owners are fenced.
   * Only the exact epoch previously prepared by that Host can be stopped here.
   * The lease and physical readback are shared with the ordinary lifecycle. */
  async shutdownOwned(binding: PersonVmBinding, stopNative = true) {
    await this.options.store.withLease(
      binding.personId,
      { now: this.now, ttlMs: this.options.leaseTtlMs },
      async (lease) => {
        const row = lease.row;
        if (
          !row ||
          row.personId !== binding.personId ||
          row.organizationId !== binding.organizationId
        )
          throw new PersonVmError('LEASE_LOST');
        const current =
          row.instanceId !== null && sameVmBinding(binding, bindingOf(row));
        const superseded =
          row.vmId !== binding.vmId || row.leaseEpoch > binding.leaseEpoch;
        const guard = () => lease.assertPhysicalOwner?.() ?? lease.guard();
        const preparation = this.retainedStartupMounts.get(binding.personId);
        if (preparation)
          await this.joinRetainedStartupMount(
            preparation,
            lease,
            AbortSignal.timeout(this.options.cleanupTimeoutMs),
          );
        if (
          (!stopNative && superseded) ||
          (current && row.phase === 'deleted')
        ) {
          await guard();
          if (!this.options.settleSupersededBinding)
            throw new PersonVmError('CLEANUP_INCOMPLETE');
          await this.options.settleSupersededBinding(
            binding,
            AbortSignal.timeout(this.options.cleanupTimeoutMs),
          );
          return;
        }
        if (!current) throw new PersonVmError('LEASE_LOST');
        if (stopNative && row.phase === 'stopped' && !row.egressReceipt) return;
        await guard();
        if (!stopNative) {
          if (
            row.egressReceipt &&
            !this.options.ownsEgressReceipt?.(
              this.receipt(binding, row.egressReceipt),
            )
          )
            throw new PersonVmError('CLEANUP_INCOMPLETE');
          const signal = AbortSignal.timeout(this.options.cleanupTimeoutMs);
          const idle = await lease.idleStopReceipt?.(binding);
          if (idle && !idle.completed) {
            await this.finishDispatchedIdleStop(lease, row, idle, signal);
            return;
          }
          if (await lease.hasUnjoinedIdleStop?.(binding))
            throw new PersonVmError('CLEANUP_INCOMPLETE');
          await this.mounted(row, signal, lease);
          const state = await this.options.native.status(binding, signal);
          if (state !== 'stopped' && state !== 'absent')
            throw new PersonVmError('CLEANUP_INCOMPLETE');
        }
        // Revocation fences business admission, not cleanup of the exact
        // physical owner already selected under this same exclusive lease.
        await this.cleanup(row, { ...lease, guard }, 'stop', stopNative);
      },
    );
  }
  async stop(context: RequestContext, signal: AbortSignal) {
    return this.leased(context, 'stop', signal, (lease, _identity, current) =>
      this.stopOwned(context, lease, current),
    );
  }
  private async stopOwned(
    context: RequestContext,
    lease: VmLease,
    signal: AbortSignal,
    admissionOwned = false,
  ) {
    if (!admissionOwned) {
      await this.admissionHost?.recoverStoppedEntryPermits(lease, signal);
      await lease.assertAdmissionOpen(true);
    }
    const row = this.required(lease.row);
    if (row.holds.length > 0) throw new PersonVmError('VM_ACTIVE');
    if (row.phase === 'running' || row.phase === 'failed')
      await this.takeoverSafe(row, signal, lease);
    if (row.phase === 'starting') throw new PersonVmError('ACTIVITY_UNKNOWN');
    if ((row.phase === 'cold' || row.phase === 'stopped') && !row.egressReceipt)
      return view(row);
    return this.commitStop(context.requestId, lease, row);
  }
  private async stopForUpgrade(
    lease: VmLease,
    row: VmRecord,
    requestId: string,
    signal: AbortSignal,
    previousWorker: boolean,
    assertAuthority?: PersonVmPrewarmFence['assertAuthority'],
    prepareWake?: PrepareUpgradeWake,
    dispatchUpgradeStop?: PersonVmPrewarmFence['dispatchUpgradeStop'],
  ) {
    const binding = bindingOf(row);
    if (row.holds.length) throw new PersonVmError('VM_ACTIVE');
    await lease.assertAdmissionOpen(true);
    if (
      !this.admissionShared ||
      !row.egressReceipt ||
      this.options.hasUnconfirmedEgress?.(binding)
    )
      throw new PersonVmError('CLEANUP_INCOMPLETE');
    // The exclusive physical lease makes the running binding unavailable
    // for new admission. An unresolved participant remains a blocker.
    await this.admissionShared.transaction(
      row.personId,
      signal,
      async (tx) => {
        checkAdmissionBinding(tx, binding);
        for (const participant of ['entry', 'gateway'] as const) {
          const counts = await this.admissionShared!.counts(tx, participant);
          if (counts.active || counts.queued || counts.deferred)
            throw new PersonVmError('VM_ACTIVE');
        }
      },
      true,
    );
    signal.throwIfAborted();
    const stop = async () => {
      await assertAuthority?.(signal);
      signal.throwIfAborted();
      await lease.guard();
      const mount = await this.options.disk.verifyAttachedMount?.(
        { vmId: row.vmId, tier: row.diskTier },
        signal,
      );
      if (!mount || !this.options.native.readAttachedStatus)
        throw new PersonVmError('ACTIVITY_UNKNOWN');
      await lease.guard();
      const state = await this.options.native.readAttachedStatus(
        binding,
        mount,
        signal,
      );
      // Only a currently authorized foreground open permits restarting a
      // running orphan. Release/admin drain never borrows this authority.
      if (
        state !== 'stopped' &&
        state !== 'absent' &&
        !(dispatchUpgradeStop && state === 'running')
      )
        throw new PersonVmError('ACTIVITY_UNKNOWN');
      const assertCurrent = async (active: AbortSignal) => {
        await lease.guard();
        await assertAuthority?.(active);
        active.throwIfAborted();
      };
      await assertCurrent(signal);
      const stopped = await this.commitStop(
        requestId,
        lease,
        row,
        state === 'running' && dispatchUpgradeStop
          ? {
              requestId,
              signal: lease.signal,
              assertCurrent: async (physical) => {
                await assertCurrent(signal);
                physical.throwIfAborted();
              },
              auditAction: 'stop.upgrade-dispatch',
              dispatch: (physical, nativeStop) =>
                dispatchUpgradeStop(binding, signal, () => {
                  physical.throwIfAborted();
                  return nativeStop(physical);
                }),
            }
          : undefined,
        'stop.upgrade',
        state !== 'running',
      );
      if (state === 'running') this.options.observeOwnedStop?.(binding);
      return stopped;
    };
    if (previousWorker) {
      const receipt = this.receipt(binding, row.egressReceipt);
      if (
        !this.needsUpgradeStop(row) ||
        !this.options.withPreviousGatewayFenced
      )
        throw new PersonVmError('LEASE_LOST');
      if (
        receipt.gatewayPorts.some(
          (port, index) => port !== row.gatewayPorts[index],
        ) ||
        receipt.gatewayPorts.length !== row.gatewayPorts.length
      )
        throw new PersonVmError('EGRESS_BINDING_INVALID');
      return this.options.withPreviousGatewayFenced(
        binding,
        receipt.gatewayPorts,
        signal,
        stop,
      );
    }
    // Release can stop a quiescent VM without waiting out the normal idle
    // interval. Its future native deliveries still need the same wake handoff.
    const activity = this.options.upgradeActivity;
    const assertSample = activity?.assertSampleCurrent;
    if (!activity || !assertSample || !prepareWake)
      throw new PersonVmError('ACTIVITY_UNKNOWN');
    const assertStopCurrent = async (probe: AbortSignal) => {
      const active = AbortSignal.any([probe, signal]);
      await assertAuthority?.(active);
      await lease.guard();
      active.throwIfAborted();
    };
    const preparation = { binding, requestId, assertStopCurrent };
    await assertStopCurrent(signal);
    const wake = await prepareWake(preparation, signal);
    let cursor: PersonVmActivityCursor | undefined;
    const now = this.now;
    const stopped = await this.commitStop(requestId, lease, row, {
      requestId,
      // The operator can cancel before dispatch. Once the exact native stop
      // starts, the physical lease owns its bounded join and readback.
      signal: lease.signal,
      async assertCurrent(probe) {
        const active = AbortSignal.any([probe, signal]);
        await assertStopCurrent(active);
        const checked = await prepareWake(preparation, active);
        if (checked.nextWakeAt !== wake.nextWakeAt)
          throw new PersonVmError('ACTIVITY_UNKNOWN');
        const native = await activity.observe(binding, active, 'inspection');
        if (
          !sameVmBinding(native.activity.binding, binding) ||
          native.activity.state !== 'known' ||
          native.coverage.state === 'unknown' ||
          native.activeScheduleDeliveries !== 0 ||
          checked.scheduleFingerprints.length !==
            native.scheduleFingerprints?.length ||
          checked.scheduleFingerprints.some(
            (fingerprint, index) =>
              fingerprint !== native.scheduleFingerprints?.[index],
          )
        )
          throw new PersonVmError('ACTIVITY_UNKNOWN');
        if (
          [
            native.activity.activeTurns,
            native.activity.activeJobs,
            native.activity.activeSubtasks,
            native.activity.pendingApprovals,
          ].some((value) => value !== 0)
        )
          throw new PersonVmError('VM_ACTIVE');
        await assertStopCurrent(active);
        cursor = native.coverage.cursor;
      },
      dispatch: (active, stop) =>
        wake.dispatch(active, (fenced) => {
          signal.throwIfAborted();
          if (
            wake.nextWakeAt !== null &&
            Date.parse(wake.nextWakeAt) <= now().getTime()
          )
            throw new PersonVmError('ACTIVITY_UNKNOWN');
          if (!cursor) throw new PersonVmError('ACTIVITY_UNKNOWN');
          assertSample(binding, cursor, fenced);
          return stop(fenced);
        }),
    });
    this.options.observeOwnedStop?.(binding);
    return stopped;
  }
  async stopRunningForUpgrade(
    binding: PersonVmBinding,
    requestId: string,
    signal: AbortSignal,
    assertAuthority: PersonVmPrewarmFence['assertAuthority'],
    prepareWake: PrepareUpgradeWake,
  ) {
    if (!this.workerDrain) throw new PersonVmError('AUTHORIZATION_DENIED');
    if (
      assertAuthority &&
      (await this.recoverIdleStop(binding, assertAuthority, signal))
    )
      return;
    return this.options.store.withLease(
      binding.personId,
      { now: this.now, ttlMs: this.options.leaseTtlMs },
      async (lease) => {
        const active = AbortSignal.any([signal, lease.signal]);
        active.throwIfAborted();
        const row = this.required(lease.row);
        if (!sameVmBinding(bindingOf(row), binding))
          throw new PersonVmError('LEASE_LOST');
        if (row.phase === 'stopped' && !row.egressReceipt) return;
        const previousWorker = await this.canStopPreviousWorkerVm(lease, row);
        if (row.phase !== 'running' && !previousWorker)
          throw new PersonVmError('ACTIVITY_UNKNOWN');
        await this.stopForUpgrade(
          lease,
          row,
          requestId,
          active,
          previousWorker,
          assertAuthority,
          prepareWake,
        );
      },
    );
  }
  private async commitStop(
    requestId: string,
    lease: VmLease,
    row: VmRecord,
    idle?: IdleStopGuard,
    action = 'stop',
    requireNativeStopped = false,
  ) {
    await lease.audit(row, {
      requestId,
      action,
      result: 'started',
    });
    try {
      const stoppedAudit: VmAudit = {
        requestId,
        action,
        result: 'succeeded',
      };
      if (row.instanceId)
        await this.cleanup(row, lease, 'stop', true, {
          audit: stoppedAudit,
          idle,
          requireNativeStopped,
        });
      else await lease.audit(row, stoppedAudit);
      return view(row);
    } catch (error) {
      await lease.audit(row, {
        requestId,
        action,
        result: 'failed',
        errorCode: safeError(error).code,
      });
      throw error;
    }
  }
  async delete(
    context: RequestContext,
    input: { deleteDisk?: boolean },
    signal: AbortSignal,
  ) {
    if (input.deleteDisk !== undefined && typeof input.deleteDisk !== 'boolean')
      throw new PersonVmError('DISK_DELETE_NOT_AUTHORIZED');
    return this.leased(
      context,
      'delete',
      signal,
      async (lease, _identity, signal) => {
        await lease.assertAdmissionOpen(true);
        const row = lease.row;
        if (!row) throw new PersonVmError('NOT_FOUND');
        if (input.deleteDisk) {
          try {
            const allowed = await this.identity(context, 'delete-disk', signal);
            this.checkOrganization(row, allowed.organizationId);
          } catch (error) {
            await lease.audit(row, {
              requestId: context.requestId,
              action: 'delete-disk',
              result: 'denied',
              errorCode: 'DISK_DELETE_NOT_AUTHORIZED',
            });
            throw new PersonVmError('DISK_DELETE_NOT_AUTHORIZED', {
              cause: error,
            });
          }
        }
        if (row.phase === 'running')
          await this.takeoverSafe(row, signal, lease);
        if (row.holds.length > 0 || row.phase === 'starting')
          throw new PersonVmError('VM_ACTIVE');
        if (row.diskRetained) await this.reconcileDisk(row, signal, lease);
        const action = input.deleteDisk ? 'delete-disk' : 'delete';
        await lease.audit(row, {
          requestId: context.requestId,
          action,
          result: 'started',
        });
        try {
          await this.retireForDeletion(row, lease, signal);
          if (input.deleteDisk && row.diskRetained) {
            await lease.guard();
            await this.options.disk.delete(
              { vmId: row.vmId, tier: row.diskTier },
              signal,
            );
            row.diskRetained = false;
            row.verifiedWebSlotCapacity = null;
          }
          row.phase = 'deleted';
          await lease.save(row);
          await lease.audit(row, {
            requestId: context.requestId,
            action,
            result: 'succeeded',
          });
          return view(row);
        } catch (error) {
          row.phase = 'failed';
          await lease.save(row);
          await lease.audit(row, {
            requestId: context.requestId,
            action,
            result: 'failed',
            errorCode: safeError(error).code,
          });
          throw safeError(error);
        }
      },
    );
  }
  private async retireForDeletion(
    row: VmRecord,
    lease: VmLease,
    signal: AbortSignal,
  ) {
    if (row.instanceId && row.diskRetained) {
      if (row.phase !== 'running') await this.takeoverSafe(row, signal, lease);
      await this.cleanup(row, lease, 'delete');
    }
  }
  /** Separate server-only authority. Never make a platform operator the
   * target person or grant the target session ordinary delete authority. */
  async deleteForPlatform(
    context: RequestContext,
    input: PlatformVmDeletionRequest,
    signal: AbortSignal,
  ): Promise<PlatformVmDeletionResult> {
    const authorize = this.options.authorizePlatformDeletion;
    if (!authorize || !UuidSchema.safeParse(input.personId).success)
      throw new PersonVmError('AUTHORIZATION_DENIED');
    input =
      input.action === 'review'
        ? { ...input, personId: input.personId.toLowerCase() }
        : {
            ...input,
            personId: input.personId.toLowerCase(),
            vmId: input.vmId.toLowerCase(),
            ...(input.action === 'purge-disk' && {
              confirmationId: input.confirmationId.toLowerCase(),
            }),
          };
    const operator = RequestContextSchema.parse(context);
    if (operator.actor.type !== 'user')
      throw new PersonVmError('AUTHORIZATION_DENIED');
    await authorize(operator, signal);
    signal.throwIfAborted();
    return this.options.store.withLease(
      input.personId,
      {
        now: this.now,
        ttlMs: this.options.leaseTtlMs,
        deletionAction: input.action,
      },
      async (lease) => {
        const active = AbortSignal.any([signal, lease.signal]);
        const row = lease.row;
        const audit = lease.auditPlatformDeletion;
        const inspect = this.options.disk.inspectDeletionTarget?.bind(
          this.options.disk,
        );
        if (!audit || !inspect) throw new PersonVmError('RUNTIME_NOT_READY');
        active.throwIfAborted();
        if (!row) {
          await authorize(operator, active);
          throw new PersonVmError('NOT_FOUND');
        }
        const lockedOperator: PlatformVmDeletionAuthorization = (sql) =>
          authorize(operator, active, sql);
        const confirmationId =
          input.action === 'purge-disk'
            ? input.confirmationId
            : input.action === 'review' && row.diskRetained
              ? randomUUID()
              : null;
        const observed = {
          vmId: row.vmId,
          personId: row.personId,
          organizationId: row.organizationId,
          phase: row.phase,
          instanceId: row.instanceId,
          leaseEpoch: row.leaseEpoch,
          diskTier: row.diskTier,
          diskRetained: row.diskRetained,
        };
        const unverified = async (error: unknown): Promise<never> => {
          const failure = safeError(error);
          if (input.action !== 'review')
            await audit({
              context: operator,
              target: { ...observed, diskIdentitySha256: null },
              confirmationId,
              action: input.action,
              result:
                failure.code === 'AUTHORIZATION_DENIED' ? 'denied' : 'failed',
              diskUnverified: true,
              requestedTarget: { vmId: input.vmId },
              errorCode: failure.code,
            });
          throw failure;
        };
        await authorize(operator, active).catch(unverified);
        active.throwIfAborted();
        // An interrupted pool adoption may already expose formal filenames.
        // Only the creation path can finish the claim under the same lease.
        await this.assertNoPendingDisk(row, active).catch(unverified);
        const erasing = await lease.readPlatformErasingDisk?.();
        const disk = await inspect(
          row.vmId,
          active,
          erasing?.diskIdentitySha256 ?? undefined,
        ).catch(unverified);
        const resumingErase = disk.state === 'absent' && !!erasing;
        const neverCreatedDisk =
          disk.state === 'absent' &&
          row.phase === 'failed' &&
          row.diskRetained &&
          !row.instanceId &&
          !row.nativeCreated &&
          !row.egressReceipt;
        if (
          disk.state === 'unknown' ||
          row.diskRetained !==
            (disk.state === 'ready' || resumingErase || neverCreatedDisk) ||
          (disk.state === 'ready' &&
            (!disk.identitySha256 ||
              (erasing &&
                (erasing.diskIdentitySha256 !== disk.identitySha256 ||
                  erasing.diskTier !== disk.disk.tier))))
        )
          return unverified(new PersonVmError('PROVIDER_FAILED'));
        const target = {
          ...observed,
          diskTier:
            disk.state === 'ready'
              ? disk.disk.tier
              : (erasing?.diskTier ?? row.diskTier),
          diskIdentitySha256:
            disk.state === 'ready'
              ? (disk.identitySha256 ?? null)
              : (erasing?.diskIdentitySha256 ?? null),
        };
        const entry = {
          context: operator,
          target,
          confirmationId,
          action: input.action,
        };
        try {
          await authorize(operator, active);
          active.throwIfAborted();
        } catch (error) {
          const failure = safeError(error);
          if (input.action !== 'review')
            await audit({
              ...entry,
              result:
                failure.code === 'AUTHORIZATION_DENIED' ? 'denied' : 'failed',
              errorCode: failure.code,
            });
          throw failure;
        }
        if (input.action === 'review') {
          await audit({ ...entry, result: 'reviewed' });
          return { target, confirmationId };
        }
        if (
          input.vmId !== row.vmId ||
          (input.action === 'retain-disk' &&
            input.leaseEpoch !== row.leaseEpoch)
        ) {
          await audit({
            ...entry,
            result: 'denied',
            errorCode: 'LEASE_LOST',
            requestedTarget: {
              vmId: input.vmId,
              ...(input.action === 'retain-disk' && {
                leaseEpoch: input.leaseEpoch,
              }),
            },
          });
          throw new PersonVmError('LEASE_LOST');
        }
        const purge = input.action === 'purge-disk';
        try {
          if (purge && !row.diskRetained)
            throw new PersonVmError('DISK_DELETE_NOT_AUTHORIZED');
          if (!purge && (erasing || disk.state !== 'ready'))
            throw new PersonVmError('CLEANUP_INCOMPLETE');
          await audit({ ...entry, result: 'started' });
        } catch (error) {
          if (error instanceof PersonVmError)
            await audit({ ...entry, result: 'denied', errorCode: error.code });
          throw error;
        }
        try {
          if (row.holds.length || row.phase === 'starting')
            throw new PersonVmError('VM_ACTIVE');
          if (!row.instanceId && (row.nativeCreated || row.egressReceipt))
            throw new PersonVmError('CLEANUP_INCOMPLETE');
          await authorize(operator, active);
          active.throwIfAborted();
          const retained =
            !erasing && (await lease.confirmRetainedDeletion?.()) === true;
          if (!erasing && !retained) {
            if (!lease.claimDeletionCleanup)
              throw new PersonVmError('RUNTIME_NOT_READY');
            await lease.claimDeletionCleanup();
          }
          await lease.assertAdmissionOpen(true);
          await lease.guard();
          const startupMount = this.retainedStartupMounts.get(row.personId);
          if (startupMount)
            await this.joinRetainedStartupMount(
              startupMount,
              lease,
              AbortSignal.any([
                active,
                AbortSignal.timeout(this.options.cleanupTimeoutMs),
              ]),
            );
          if (
            row.egressReceipt &&
            !this.options.ownsEgressReceipt?.(
              this.receipt(bindingOf(row), row.egressReceipt),
            )
          )
            throw new PersonVmError('CLEANUP_INCOMPLETE');
          const releaseHome = this.options.native.releaseDiskHome?.bind(
            this.options.native,
          );
          if (!releaseHome) throw new PersonVmError('RUNTIME_NOT_READY');
          const release = (mount: string, cleanupSignal: AbortSignal) =>
            releaseHome(row.vmId, mount, cleanupSignal);
          if (retained) {
            if (
              disk.state !== 'ready' ||
              !this.options.disk.verifyDeletionDetached
            )
              throw new PersonVmError('CLEANUP_INCOMPLETE');
            await this.options.disk.verifyDeletionDetached(disk.disk, active);
          } else if (row.instanceId) {
            await this.takeoverSafe(row, active, lease);
            await this.cleanup(row, lease, 'delete', true, {
              onDetached: release,
            });
          } else if (disk.state === 'ready' && !erasing) {
            await this.options.disk.detach(disk.disk, active, (mount) =>
              release(mount, active),
            );
          }
          if (purge) {
            await lease.guard();
            // Once the compute and mount owners have joined, retain a
            // recoverable database checkpoint until both image and key are gone.
            if (erasing) {
              await audit({ ...entry, result: 'erasing' }, lockedOperator);
            } else {
              row.phase = 'deleted';
              row.nativeCreated = false;
              row.instanceId = null;
              row.gatewayPorts = [];
              row.diskTier = target.diskTier;
              await lease.save(row, {
                deletionAudit: { ...entry, result: 'erasing' },
                authorizeDeletion: lockedOperator,
              });
            }
            await this.options.disk.delete(
              { vmId: row.vmId, tier: target.diskTier },
              active,
              {
                identitySha256: target.diskIdentitySha256,
                beforeErase: (mount) => releaseHome(row.vmId, mount, active),
              },
            );
            row.diskRetained = false;
            row.verifiedWebSlotCapacity = null;
          }
          row.phase = 'deleted';
          if (!purge && retained)
            await audit({ ...entry, result: 'succeeded' }, lockedOperator);
          else
            await lease.save(row, {
              deletionAudit: { ...entry, result: 'succeeded' },
              authorizeDeletion: purge ? undefined : lockedOperator,
            });
          return { vm: view(row) };
        } catch (error) {
          const failure = safeError(error);
          await audit({
            ...entry,
            result:
              failure.code === 'AUTHORIZATION_DENIED' ? 'denied' : 'failed',
            errorCode: failure.code,
          });
          throw failure;
        }
      },
    );
  }
  /** Scheduler calls with a current trusted identity. No Agent/task scheduler is added. */
  async reconcileIdle(context: RequestContext, signal: AbortSignal) {
    if (this.admissionHost) {
      const identity = await this.identity(context, 'stop', signal);
      const row = this.required(
        await this.options.store.read(identity.personId),
      );
      this.checkOrganization(row, identity.organizationId);
      if (row.phase === 'running') {
        await this.admissionHost.reconcileIdle(context, bindingOf(row), signal);
        return view(
          this.required(await this.options.store.read(identity.personId)),
        );
      }
    }
    return this.leased(
      context,
      'stop',
      signal,
      async (lease, _identity, signal) => {
        const row = this.required(lease.row);
        if (row.phase === 'starting' || row.phase === 'failed')
          return view(row);
        if (row.phase === 'running') {
          let snapshot: PersonVmActivity;
          try {
            snapshot = await this.inactive(row, signal);
          } catch (error) {
            if (
              error instanceof PersonVmError &&
              (error.code === 'VM_ACTIVE' || error.code === 'ACTIVITY_UNKNOWN')
            ) {
              row.lastActivityAt = this.now().toISOString();
              row.idleSince = null;
              row.activityObservedAt = null;
              await lease.save(row);
              return view(row);
            }
            throw error;
          }
          // Polling 0 cannot prove a continuous idle interval or freeze a job
          // beginning after this read. Automatic running-VM reclamation remains
          // disabled until a real native window/admission guarantee is available.
          row.idleSince = null;
          row.activityObservedAt = snapshot.observedAt;
          await lease.save(row);
          return view(row);
        }
        const stoppedFor = row.stoppedAt
          ? this.now().getTime() - Date.parse(row.stoppedAt)
          : 0;
        if (row.phase === 'stopped' && stoppedFor >= PERSON_VM_COLD_MS) {
          await this.options.disk.move(
            { vmId: row.vmId, tier: row.diskTier },
            'cold',
            signal,
          );
          row.diskTier = 'cold';
          row.phase = 'cold';
          await lease.save(row);
          await lease.audit(row, {
            requestId: context.requestId,
            action: 'cold',
            result: 'succeeded',
          });
        }
        return view(row);
      },
    );
  }
  async assertAdmissionBinding(
    context: RequestContext,
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<void> {
    const identity = await this.identity(context, 'read', signal);
    if (
      context.actor.type !== 'user' ||
      identity.personId !== binding.personId ||
      identity.organizationId !== binding.organizationId
    )
      throw new PersonVmError('AUTHORIZATION_DENIED');
    const shared = this.admissionShared;
    if (!this.admissionHost || !shared)
      throw new PersonVmError('RUNTIME_NOT_READY');
    const egress = this.options.egress;
    if (!egress) throw new PersonVmError('EGRESS_UNAVAILABLE');
    const receipt = await shared.transaction(
      identity.personId,
      signal,
      async (tx) => {
        checkAdmissionBinding(tx, binding);
        if (tx.row.disk_retained !== true) throw new PersonVmError('NOT_FOUND');
        if (!tx.row.egress_receipt)
          throw new PersonVmError('EGRESS_UNAVAILABLE');
        return this.receipt(
          binding,
          tx.row.egress_receipt as PersonVmEgressReceipt,
        );
      },
    );
    // No physical lease/running assertion: admit/activate/wake retain those
    // responsibilities. Do not hold a PG row lock while checking local egress.
    await egress.assertActive(receipt, signal);
    signal.throwIfAborted();
  }
  async resolve(context: RequestContext, signal: AbortSignal) {
    const accessOrder = ++this.idleAccessOrder;
    const identity = await this.identity(context, 'read', signal);
    const active = this.currentLease.getStore();
    const ownLease =
      active?.active === true &&
      active.requestId === context.requestId &&
      active.personId === identity.personId
        ? active.lease
        : null;
    if (ownLease) await ownLease.guard();
    const row = this.required(
      ownLease
        ? ownLease.row
        : await this.options.store.read(identity.personId),
    );
    this.checkOrganization(row, identity.organizationId);
    // A stopped instance can still have a pending stop receipt. Renew only
    // eligibility to reconcile its original binding, never readiness or send.
    if (
      !ownLease &&
      row.instanceId &&
      row.nativeCreated &&
      row.diskRetained &&
      row.phase !== 'deleted'
    )
      await this.observeCurrentAccess(context, row, accessOrder, signal);
    if (
      (!ownLease && row.leaseOwner) ||
      row.phase !== 'running' ||
      !row.egressReceipt ||
      !this.options.egress
    )
      throw new PersonVmError(
        ownLease ? 'RUNTIME_NOT_READY' : 'LEASE_CONFLICT',
      );
    const binding = bindingOf(row);
    const receipt = this.receipt(binding, row.egressReceipt);
    await this.options.egress.assertActive(receipt, signal);
    signal.throwIfAborted();
    return binding;
  }
  private async observeCurrentAccess(
    context: RequestContext,
    row: VmRecord,
    order: number,
    signal: AbortSignal,
  ) {
    const publish = this.options.observeOwnedAccess;
    if (!publish) return;
    const identity = await this.identity(context, 'read', signal);
    this.checkOrganization(row, identity.organizationId);
    if (row.personId !== identity.personId)
      throw new PersonVmError('AUTHORIZATION_DENIED');
    signal.throwIfAborted();
    publish(bindingOf(row), context, order);
  }
  async assertCurrentBinding(
    context: RequestContext,
    binding: PersonVmBinding,
    signal: AbortSignal,
  ) {
    if (!sameVmBinding(await this.resolve(context, signal), binding))
      throw new PersonVmError('LEASE_LOST');
  }
  private async finishDispatchedIdleStop(
    lease: VmLease,
    row: VmRecord,
    attempt: { requestId: string; completed: boolean },
    signal: AbortSignal,
  ) {
    if (row.holds.length) throw new PersonVmError('VM_ACTIVE');
    if (
      attempt.completed &&
      (row.phase === 'stopped' || row.phase === 'cold') &&
      !row.egressReceipt
    )
      return;
    const binding = bindingOf(row);
    const finish = async () => {
      await this.mounted(row, signal, lease);
      await lease.guard();
      // This receipt already records a joined native stop. Revalidate the
      // exact terminal instance without dispatching another stop.
      if (!this.options.native.assertStopped)
        throw new PersonVmError('ACTIVITY_UNKNOWN');
      signal.throwIfAborted();
      await this.options.native.assertStopped(binding, signal);
      const stoppedAudit: VmAudit | undefined = attempt.completed
        ? undefined
        : { requestId: attempt.requestId, action: 'stop', result: 'succeeded' };
      await this.cleanup(row, lease, 'takeover', true, {
        audit: stoppedAudit,
        nativeAlreadyJoined: true,
      });
    };
    const fence = this.options.withPreviousGatewayFenced;
    if (fence && row.egressReceipt && this.needsUpgradeStop(row)) {
      const ports = this.receipt(binding, row.egressReceipt).gatewayPorts;
      await fence(binding, ports, signal, finish);
    } else await finish();
  }

  /** Finish a previously authorized, joined stop. This never starts a VM,
   * dispatches a new stop, or admits native work. */
  recoverJoinedIdleStop(binding: PersonVmBinding, signal: AbortSignal) {
    return this.recoverIdleStop(
      binding,
      async (active) => active.throwIfAborted(),
      signal,
    );
  }

  private async recoverIdleStop(
    binding: PersonVmBinding,
    assertAuthority: (signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ) {
    const store = this.options.store;
    if (!(store instanceof PostgresPersonVmStore)) return false;
    const attempt = await store.idleStopReceipt(binding);
    if (!attempt) return false;
    const persisted = this.required(await store.read(binding.personId));
    if (!persisted.instanceId || !sameVmBinding(bindingOf(persisted), binding))
      throw new PersonVmError('LEASE_LOST');
    if (
      attempt.completed &&
      !persisted.leaseOwner &&
      (persisted.phase === 'stopped' || persisted.phase === 'cold') &&
      !persisted.egressReceipt
    ) {
      this.options.observeOwnedStop?.(binding);
      return true;
    }
    const options = { now: this.now, ttlMs: this.options.leaseTtlMs, signal };
    const recover = async (lease: VmLease) => {
      const current = AbortSignal.any([signal, lease.signal]);
      const row = this.required(lease.row);
      if (!row.instanceId || !sameVmBinding(bindingOf(row), binding))
        throw new PersonVmError('LEASE_LOST');
      await assertAuthority(current);
      await lease.assertAdmissionOpen(true);
      await lease.guard();
      const latest = await lease.idleStopReceipt?.(binding);
      if (!latest || latest.requestId !== attempt.requestId) return false;
      await this.finishDispatchedIdleStop(lease, row, latest, current);
      return true;
    };
    if (persisted.leaseOwner && attempt.completed) {
      await assertAuthority(signal);
      if (
        await store.releaseJoinedIdleStopLease(
          binding,
          attempt.requestId,
          this.now(),
          signal,
        )
      ) {
        this.options.observeOwnedStop?.(binding);
        return true;
      }
    }
    const completed = persisted.leaseOwner
      ? await store.recover(binding.personId, options, recover)
      : await store.withLease(binding.personId, options, recover);
    if (completed) this.options.observeOwnedStop?.(binding);
    return completed;
  }

  async recoverExpired(context: RequestContext, signal: AbortSignal) {
    const identity = await this.identity(context, 'stop', signal);
    const before = this.required(
      await this.options.store.read(identity.personId),
    );
    this.checkOrganization(before, identity.organizationId);
    let idleStopped: PersonVmBinding | undefined;
    const recovered = await this.options.store.recover(
      identity.personId,
      { now: this.now, ttlMs: this.options.leaseTtlMs, signal },
      async (lease) => {
        const current = AbortSignal.any([signal, lease.signal]);
        await this.admissionHost?.recoverStoppedEntryPermits(lease, current);
        await lease.assertAdmissionOpen(true);
        const row = this.required(lease.row);
        this.checkOrganization(row, identity.organizationId);
        return this.inLeaseFrame(
          context,
          identity.personId,
          lease,
          async () => {
            const pending =
              (await this.options.diskPool?.status(row, current)) === 'pending';
            if (
              pending &&
              (!this.unfinishedCreate(row) ||
                row.holds.length ||
                row.egressReceipt)
            )
              throw new PersonVmError('CLEANUP_INCOMPLETE');
            const idleAttempt = row.instanceId
              ? await lease.idleStopReceipt?.(bindingOf(row))
              : undefined;
            const inspected = idleAttempt
              ? undefined
              : pending
                ? { state: 'absent' as const }
                : await this.takeoverSafe(row, current, lease);
            await lease.audit(row, {
              requestId: context.requestId,
              action: 'recover',
              result: 'started',
            });
            if (inspected?.state === 'absent') {
              // Ownership is recovered, but an initial creation without image
              // bytes is not a stopped/ready disk. Keep the retryable phase.
              row.phase = 'failed';
              row.stoppedAt = null;
              await lease.save(row);
              await lease.audit(row, {
                requestId: context.requestId,
                action: 'recover-create-retry',
                result: 'succeeded',
              });
              return view(row);
            }
            try {
              if (idleAttempt) {
                await this.finishDispatchedIdleStop(
                  lease,
                  row,
                  idleAttempt,
                  current,
                );
                idleStopped = bindingOf(row);
              } else await this.cleanup(row, lease, 'takeover');
              await lease.audit(row, {
                requestId: context.requestId,
                action: 'recover',
                result: 'succeeded',
              });
              return view(row);
            } catch (error) {
              await lease.audit(row, {
                requestId: context.requestId,
                action: 'recover',
                result: 'failed',
                errorCode: safeError(error).code,
              });
              throw error;
            }
          },
        );
      },
    );
    if (idleStopped) this.options.observeOwnedStop?.(idleStopped);
    return recovered;
  }
  async acquireHold(
    context: RequestContext,
    binding: PersonVmBinding,
    input: Pick<VmHold, 'kind' | 'operationId'>,
    signal: AbortSignal,
  ) {
    return this.leased(context, 'start', signal, async (lease) => {
      const row = this.required(lease.row);
      if (row.phase !== 'running' || !sameVmBinding(bindingOf(row), binding))
        throw new PersonVmError('LEASE_LOST');
      if (
        !input.operationId ||
        !['turn', 'job', 'subtask', 'approval', 'host-operation'].includes(
          input.kind,
        )
      )
        throw new PersonVmError('AUTHORIZATION_DENIED');
      const old = row.holds.find(
        (hold) =>
          hold.kind === input.kind && hold.operationId === input.operationId,
      );
      if (old) return old.id;
      const hold = { id: randomUUID(), ...input };
      row.holds.push(hold);
      row.idleSince = null;
      row.activityObservedAt = null;
      row.lastActivityAt = this.now().toISOString();
      await lease.save(row);
      return hold.id;
    });
  }
  async releaseHold(
    context: RequestContext,
    binding: PersonVmBinding,
    holdId: string,
    signal: AbortSignal,
  ) {
    await this.leased(
      context,
      'start',
      signal,
      async (lease) => {
        const row = this.required(lease.row);
        if (!sameVmBinding(bindingOf(row), binding))
          throw new PersonVmError('LEASE_LOST');
        row.holds = row.holds.filter((hold) => hold.id !== holdId);
        row.idleSince = null;
        row.activityObservedAt = null;
        row.lastActivityAt = this.now().toISOString();
        await lease.save(row);
      },
      { allowClosed: true },
    );
  }
}
