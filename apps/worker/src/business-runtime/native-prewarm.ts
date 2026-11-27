import {
  sameDEntryIdentity,
  selectDEntryGeneration,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import {
  DataAccessError,
  getDatabase,
  readDEntryReleasePolicy,
  requireDEntryNativeIdentity,
} from '@allrice/database';
import {
  PersonVmError,
  type PersonVmBinding,
  type PersonVmLeaseReleaseStage,
  type PersonVmPort,
  type PersonVmView,
} from '@allrice/person-vm';
import type {
  CurrentSelectionEntryRecovery,
  CurrentSelectionPrewarm,
} from '../person-vm/production-prewarm.js';
import { DEntryNativeUnavailable } from '../d-entry/native-owner.js';
import { currentDEntryNativeDataPort } from '../d-entry/native-data.js';
import {
  canSharePrewarmTarget,
  compatiblePrewarmGeneration as compatible,
  installDEntryNativePrewarmPort,
  observedPrewarmTarget,
  type DEntryNativePrewarmPort,
  type PrewarmGeneration as Generation,
  type PrewarmPlan,
  type PrewarmReservation,
  type PrewarmVerificationMode,
} from '../d-entry/native-prewarm.js';
import { installAssignedDEntryNativeCatalog } from './native-catalog.js';

type VmStamp = Generation & {
  phase: PersonVmView['phase'];
  diskRetained?: boolean;
  nativeCreated?: boolean;
  deletionFence?: string | null;
  leaseOwner: string | null;
  rowVersion?: string;
};
type VmStampRow = Omit<VmStamp, 'leaseEpoch'> & { leaseEpoch: string };
type Coordination = { authorityRevision: string | null; vm: VmStamp | null };
type ReadCoordination = (
  identity: DEntryIdentity,
  sessionId: string,
) => Promise<Coordination>;

const readCurrentCoordination: ReadCoordination = (identity, sessionId) =>
  getDatabase().begin(
    'isolation level repeatable read read only',
    async (sql) => {
      const policy = await readDEntryReleasePolicy(sql);
      if (selectDEntryGeneration(policy, identity) !== '4.0')
        throw new DataAccessError('authorization_denied');
      const [snapshot] = await sql<
        {
          vm: VmStampRow | null;
          loginActive: boolean;
          grants: string[];
          employeeGrant: string | null;
          threadGrant: string | null;
        }[]
      >`
      select (select row_to_json(stamp) from (
        select vm_id as "vmId", instance_id as "instanceId", phase,
          disk_retained as "diskRetained", native_created as "nativeCreated",
          prewarm_deletion_fence as "deletionFence",
          lease_owner as "leaseOwner", xmin::text as "rowVersion",
          lease_epoch::text as "leaseEpoch" from person_virtual_machines
        where person_id=${identity.personId} and organization_id=${identity.organizationId}
      ) stamp) as vm,
      exists(select 1 from allrice_sessions s where s.id=${sessionId}
        and s.user_id=${identity.personId} and s.revoked_at is null
        and s.expires_at>clock_timestamp()) as "loginActive",
      array(select m.id::text || ':' || m.xmin::text from allrice_memberships m
        where m.user_id=${identity.personId} and m.organization_id=${identity.organizationId}
          and m.active and m.role in ('admin','member')
          and (m.workspace_id is null or m.workspace_id=${identity.workspaceId})
        order by m.id) as grants,
      (select concat_ws(':', i.xmin, a.id, a.xmin, e.xmin, w.xmin, o.xmin, u.xmin,
          array(select d.id::text || ':' || d.xmin::text from allrice_platform_employee_tenant_assignments d
            where d.organization_id=i.organization_id and d.workspace_id=i.workspace_id
              and d.tenant_employee_id=a.employee_id order by d.id))
        from allrice_employee_instances i
        join allrice_employee_assignments a on a.id=i.assignment_id
        join allrice_employees e on e.id=a.employee_id and e.status='active'
        join allrice_workspaces w on w.id=i.workspace_id and w.organization_id=i.organization_id and w.archived_at is null
        join allrice_organizations o on o.id=i.organization_id and o.archived_at is null
        join allrice_users u on u.id=i.owner_id and u.status='active'
        where i.id=${identity.employeeInstanceId} and i.owner_id=${identity.personId}
          and i.organization_id=${identity.organizationId} and i.workspace_id=${identity.workspaceId}
          and i.archived_at is null and a.active) as "employeeGrant",
      case when ${identity.threadId}::uuid is null then 'employee'
      else (select jsonb_build_array(c.id, c.employee_instance_id,
          c.employee_assignment_id, c.employee_version_id, c.execution_generation)::text
        from allrice_chat_sessions c
        where c.id=${identity.threadId} and c.owner_id=${identity.personId}
          and c.organization_id=${identity.organizationId} and c.workspace_id=${identity.workspaceId}
          and c.archived_at is null) end as "threadGrant"`;
      const { vm, loginActive, grants, employeeGrant, threadGrant } = snapshot!;
      return {
        // Tuple versions partition reuse across a revoke/regrant even if the
        // restored membership has the same role. They never grant authority.
        authorityRevision:
          loginActive && grants.length && employeeGrant && threadGrant
            ? JSON.stringify([
                policy.revision,
                grants,
                employeeGrant,
                threadGrant,
              ])
            : null,
        vm: vm ? { ...vm, leaseEpoch: Number(vm.leaseEpoch) } : null,
      };
    },
  );

function targetGeneration(
  vm: VmStamp | null,
  allowRetainedRestore = false,
): Generation | undefined {
  if (!vm) return { vmId: null, instanceId: null, leaseEpoch: 1 };
  if (!Number.isSafeInteger(vm.leaseEpoch)) return;
  if (vm.phase === 'deleted') {
    if (!allowRetainedRestore || !vm.vmId) return;
    const leaseEpoch = vm.leaseEpoch + 1;
    if (!Number.isSafeInteger(leaseEpoch)) return;
    if (vm.diskRetained === false)
      return {
        vmId: null,
        instanceId: null,
        leaseEpoch,
        replacesVmId: vm.vmId,
      };
    if (vm.diskRetained !== true) return;
    return {
      vmId: vm.vmId,
      instanceId: null,
      leaseEpoch,
      restoreRetained: true,
    };
  }
  if (vm.phase === 'running' || (vm.phase === 'starting' && vm.instanceId))
    return vm;
  // A retained or as-yet-unstarted VM advances exactly one epoch on start.
  if (!Number.isSafeInteger(vm.leaseEpoch + 1)) return;
  return { vmId: vm.vmId, instanceId: null, leaseEpoch: vm.leaseEpoch + 1 };
}

function plannedGeneration(vm: VmStamp | null) {
  // An explicit request can select the next epoch of an already unowned
  // starting row. A ticket issued while the prior owner was present cannot.
  return targetGeneration(
    vm?.phase === 'starting' && !vm.leaseOwner
      ? { ...vm, instanceId: null }
      : vm,
    true,
  );
}

function matchingGeneration(
  stamp: Coordination,
  result: PersonVmView,
  target: Generation,
) {
  if (
    stamp.vm?.phase !== 'running' ||
    !stamp.vm.instanceId ||
    stamp.vm.leaseOwner ||
    result.phase !== 'running' ||
    !result.ready ||
    result.vmId !== stamp.vm.vmId ||
    !compatible(target, stamp.vm)
  )
    return;
  return stamp.vm;
}

function exactPrewarmBinding(
  identity: DEntryIdentity,
  generation: Generation | undefined,
): PersonVmBinding | undefined {
  if (!generation?.vmId || !generation.instanceId) return;
  return Object.freeze({
    personId: identity.personId,
    organizationId: identity.organizationId,
    vmId: generation.vmId,
    instanceId: generation.instanceId,
    leaseEpoch: generation.leaseEpoch,
  });
}

type Flight = {
  target: Generation;
  reservation: PrewarmReservation | undefined;
  join(revoked: AbortSignal): void;
  work: Promise<{ result: PersonVmView; generation: Generation | undefined }>;
};

type OrphanedStart = {
  predecessor: PersonVmBinding;
  active?: AbortSignal;
  lease?: { token: string; signal: AbortSignal };
  instance?: PersonVmBinding;
  failure?: {
    phase: 'starting' | 'stopped' | 'failed';
    release?: { rowVersion: string; stage: PersonVmLeaseReleaseStage };
  };
};

function matchesInstance(
  vm: Generation | null | undefined,
  binding: PersonVmBinding,
) {
  return (
    vm?.vmId === binding.vmId &&
    vm.instanceId === binding.instanceId &&
    vm.leaseEpoch === binding.leaseEpoch
  );
}

function ownsOrphanedLease(takeover: OrphanedStart, vm: VmStamp) {
  return (
    takeover.active &&
    !takeover.active.aborted &&
    takeover.lease &&
    !takeover.lease.signal.aborted &&
    takeover.lease.token === vm.leaseOwner
  );
}

function prewarmKey(
  context: RequestContext,
  identity: DEntryIdentity,
  stamp: Coordination,
) {
  return JSON.stringify([
    context.sessionId,
    context.workspaceId,
    identity.personId,
    identity.organizationId,
    identity.workspaceId,
    identity.employeeInstanceId,
    identity.employeeRevision,
    identity.employeeVersionId,
    identity.threadId,
    stamp.authorityRevision,
    stamp.vm?.deletionFence ?? null,
  ]);
}

/** Consume the existing VM lifecycle; no completed-result or authority cache. */
export function createDEntryNativePrewarmPort(input: {
  prewarmCurrent: CurrentSelectionPrewarm;
  lifetime: AbortSignal;
  requireEditorProof?: boolean;
  readCoordination?: ReadCoordination;
  isLiveSlottedBinding?(binding: PersonVmBinding): boolean;
  reconcileStoppedEntry?: CurrentSelectionEntryRecovery;
}) {
  input.lifetime.throwIfAborted();
  const stopped = new AbortController();
  const admission = AbortSignal.any([input.lifetime, stopped.signal]);
  const pending = new Set<Promise<AbortSignal | undefined>>();
  const flights = new Map<string, Set<Flight>>();
  const orphanedStarts = new WeakMap<PrewarmPlan, OrphanedStart>();
  const activeOrphanedPlans = new Map<string, PrewarmPlan>();
  let closing: Promise<void> | undefined;

  function shared({
    key,
    target,
    reservation,
    starting,
    revoked,
    start,
    confirm,
  }: {
    key: string;
    target: Generation;
    reservation: PrewarmReservation | undefined;
    starting: boolean;
    revoked: AbortSignal;
    start: (signal: AbortSignal) => Promise<PersonVmView>;
    confirm(
      result: PersonVmView,
      flight: Flight,
    ): Promise<Generation | undefined>;
  }) {
    const group = flights.get(key) ?? new Set<Flight>();
    for (const flight of group) {
      if (!canSharePrewarmTarget(flight, target)) continue;
      // A later waiter may already know which physical start was published.
      flight.target = {
        ...flight.target,
        vmId: flight.target.vmId ?? target.vmId,
        instanceId: flight.target.instanceId ?? target.instanceId,
        leaseEpoch: target.leaseEpoch,
      };
      flight.join(revoked);
      return { flight, started: false };
    }
    // An unowned starting row may need takeover under the existing lease.
    // The takeover can advance the epoch, so its observed binding is not a
    // reliable key for a new shared operation.
    if (starting) return;
    const lost = new AbortController();
    const watchers = new Map<AbortSignal, () => void>();
    const physical = AbortSignal.any([input.lifetime, lost.signal]);
    const work = Promise.resolve().then(async () => {
      physical.throwIfAborted();
      const result = await start(physical);
      physical.throwIfAborted();
      const generation = await confirm(result, flight);
      physical.throwIfAborted();
      return { result, generation };
    });
    const flight: Flight = {
      target,
      reservation,
      work,
      join(signal) {
        if (watchers.has(signal)) return;
        const check = () => {
          if ([...watchers.keys()].every((entry) => entry.aborted)) {
            // A permanently revoked operation cannot accept another waiter.
            group.delete(flight);
            lost.abort(signal.reason);
          }
        };
        watchers.set(signal, check);
        signal.addEventListener('abort', check, { once: true });
        if (signal.aborted) check();
      },
    };
    group.add(flight);
    flights.set(key, group);
    flight.join(revoked);
    const settled = () => {
      for (const [signal, check] of watchers)
        signal.removeEventListener('abort', check);
      group.delete(flight);
      if (!group.size && flights.get(key) === group) flights.delete(key);
    };
    void work.then(settled, settled);
    return { flight, started: true };
  }
  async function isCurrent(
    context: RequestContext,
    identity: DEntryIdentity,
    plan: PrewarmPlan,
    caller: AbortSignal,
    mode: PrewarmVerificationMode,
  ) {
    const signal = AbortSignal.any([admission, caller]);
    signal.throwIfAborted();
    // A reserve/instance receipt may arrive while this MVCC snapshot is read.
    // Compare the snapshot with observations already available on entry.
    const target = observedPrewarmTarget(plan);
    const startedElsewhere =
      plan.target.instanceId !== null && !plan.reservation?.instance;
    const stamp = await input.readCoordination?.(identity, context.sessionId);
    signal.throwIfAborted();
    if (
      !stamp?.authorityRevision ||
      plan.key !== prewarmKey(context, identity, stamp)
    )
      return false;
    if (mode === 'authority') return true;
    const exact = (vm: Generation | null | undefined) =>
      !!vm &&
      vm.leaseEpoch === target.leaseEpoch &&
      (!target.vmId || vm.vmId === target.vmId) &&
      (!target.instanceId || vm.instanceId === target.instanceId);
    const takeover = orphanedStarts.get(plan);
    const vm = stamp.vm;
    if (mode === 'issue') {
      if (takeover)
        return (
          vm?.phase === 'starting' &&
          vm.diskRetained === true &&
          !vm.leaseOwner &&
          matchesInstance(vm, takeover.predecessor)
        );
      const latest = plannedGeneration(vm);
      return Boolean(
        latest &&
        (!plan.running || vm?.phase === 'running') &&
        canSharePrewarmTarget(plan, latest),
      );
    }
    if (mode === 'ready')
      return (
        vm?.phase === 'running' &&
        target.vmId !== null &&
        target.instanceId !== null &&
        !vm.leaseOwner &&
        exact(vm) &&
        (!takeover ||
          (!!takeover.instance && matchesInstance(vm, takeover.instance)))
      );
    if (mode === 'reuse' && !takeover) return false;
    if (takeover && (plan.target.instanceId === null || mode === 'reuse')) {
      if (!vm || vm.phase === 'deleted') return false;
      const active = takeover.active && !takeover.active.aborted;
      const ownsLease = ownsOrphanedLease(takeover, vm);
      if (matchesInstance(vm, takeover.predecessor)) {
        const failure = takeover.failure;
        const release = failure?.release;
        if (release?.stage === 'unconfirmed') return false;
        if (vm.leaseOwner)
          return Boolean(
            ownsLease &&
            (vm.phase === 'starting' ||
              vm.phase === 'stopped' ||
              vm.phase === 'failed'),
          );
        if (mode === 'reuse') return false;
        if (!failure) return Boolean(active && vm.phase === 'starting');
        return Boolean(
          release &&
          vm.rowVersion === release.rowVersion &&
          vm.phase === failure.phase &&
          ((active && takeover.lease && !takeover.lease.signal.aborted) ||
            (plan.observeTerminalFailure && release.stage === 'joined')),
        );
      }
      if (
        mode === 'reuse' &&
        (!active || (!ownsLease && vm.phase !== 'running'))
      )
        return false;
      return Boolean(
        takeover.instance &&
        matchesInstance(vm, takeover.instance) &&
        (!vm.leaseOwner || ownsLease),
      );
    }
    if (vm?.phase === 'deleted')
      return (
        ((target.restoreRetained === true && vm.diskRetained === true) ||
          (target.replacesVmId === vm.vmId && vm.diskRetained === false)) &&
        exact(plannedGeneration(vm))
      );
    // Pending tickets can wait before their first lease. A failed ticket must
    // still be on that exact original empty row or an observed reservation.
    if (vm && !target.vmId && mode === 'failed') return false;
    if (vm?.phase === 'stopped' && startedElsewhere) return false;
    return exact(vm) || exact(plannedGeneration(vm));
  }
  const port: DEntryNativePrewarmPort = {
    isCurrent,
    async prepare(context, identity, caller) {
      const signal = AbortSignal.any([admission, caller]);
      signal.throwIfAborted();
      const read = input.readCoordination;
      const data = currentDEntryNativeDataPort();
      if (!read || (input.requireEditorProof && !data?.assertEditorReady))
        throw new DEntryNativeUnavailable();
      let stamp = await read(identity, context.sessionId);
      signal.throwIfAborted();
      const old = stamp.vm;
      if (
        stamp.authorityRevision &&
        old &&
        (old.phase === 'starting' || old.phase === 'stopped')
      ) {
        const key = prewarmKey(context, identity, stamp);
        const prior = activeOrphanedPlans.get(key);
        const takeover = prior && orphanedStarts.get(prior);
        // Use the same snapshot for deduplication and retained preflight: a
        // second request must not try to claim the first request's lease.
        if (
          prior &&
          takeover &&
          matchesInstance(old, takeover.predecessor) &&
          ownsOrphanedLease(takeover, old)
        )
          return { key, target: prior.target, reuse: prior };
      }
      const binding = exactPrewarmBinding(identity, old ?? undefined);
      const retained =
        old?.nativeCreated === true &&
        (old.phase === 'stopped' ||
          old.phase === 'cold' ||
          (old.phase === 'deleted' && old.diskRetained === true));
      // Only a fresh POST may reconcile. A previously issued ticket keeps its
      // exact old epoch through status polling and its original activation.
      if (
        stamp.authorityRevision &&
        (retained || (old?.phase === 'running' && !old.leaseOwner))
      ) {
        const reconciled =
          binding &&
          (await input.reconcileStoppedEntry?.(
            context,
            identity,
            binding,
            signal,
            retained,
          ));
        if (retained && !reconciled) throw new DEntryNativeUnavailable();
        if (reconciled) stamp = await read(identity, context.sessionId);
      }
      signal.throwIfAborted();
      const target = plannedGeneration(stamp.vm);
      if (!stamp.authorityRevision || !target)
        throw new DataAccessError('authorization_denied');
      const key = prewarmKey(context, identity, stamp);
      const plan: PrewarmPlan = {
        key,
        target,
        running: stamp.vm?.phase === 'running' && !stamp.vm.leaseOwner,
      };
      if (
        stamp.vm?.phase === 'starting' &&
        !stamp.vm.leaseOwner &&
        target.instanceId === null
      ) {
        const predecessor = exactPrewarmBinding(identity, stamp.vm);
        if (predecessor) {
          plan.orphanedInstanceId = predecessor.instanceId;
          orphanedStarts.set(plan, { predecessor });
        }
      }
      return plan;
    },
    prewarm(context, identity, trigger, caller, revoked, plan) {
      if (admission.aborted) return Promise.reject(admission.reason);
      const data = currentDEntryNativeDataPort();
      const prove = data?.assertEditorReady?.bind(data);
      if (input.requireEditorProof && !prove)
        return Promise.reject(new DEntryNativeUnavailable());
      const active = AbortSignal.any([admission, caller, revoked]);
      const takeover = plan && orphanedStarts.get(plan);
      if (plan && takeover) {
        if (takeover.active || activeOrphanedPlans.has(plan.key))
          return Promise.reject(new DEntryNativeUnavailable());
        takeover.active = active;
        activeOrphanedPlans.set(plan.key, plan);
      }
      const task = Promise.resolve().then(async () => {
        const selection = {
          workspaceId: identity.workspaceId,
          employeeInstanceId: identity.employeeInstanceId,
          ...(identity.threadId ? { threadId: identity.threadId } : {}),
        };
        async function current() {
          active.throwIfAborted();
          const next = await requireDEntryNativeIdentity(context, selection);
          active.throwIfAborted();
          if (!sameDEntryIdentity(identity, next))
            throw new DataAccessError('authorization_denied');
        }
        await current();
        active.throwIfAborted();
        // Enrol a newly eligible employee on a live Host before the running
        // branch checks VM-wide readiness, using the accepted physical owner.
        const runningBinding = plan?.running
          ? exactPrewarmBinding(identity, plan.target)
          : undefined;
        if (plan?.running && !runningBinding)
          throw new DEntryNativeUnavailable();
        if (
          plan?.running &&
          !(await isCurrent(context, identity, plan, active, 'ready'))
        )
          throw new DEntryNativeUnavailable();
        const runningProof = runningBinding
          ? await prove?.(context, identity, active, runningBinding)
          : undefined;
        runningProof?.throwIfAborted();
        if (
          runningProof &&
          plan &&
          runningBinding &&
          input.isLiveSlottedBinding?.(runningBinding)
        ) {
          await current();
          await plan.assertTicketThread?.(active);
          if (!(await isCurrent(context, identity, plan, active, 'ready')))
            throw new DEntryNativeUnavailable();
          active.throwIfAborted();
          runningProof.throwIfAborted();
          return runningProof;
        }
        if (!plan && input.requireEditorProof && prove) {
          try {
            await prove(context, identity, active);
          } catch (error) {
            if (
              !(error instanceof PersonVmError) ||
              !['NOT_FOUND', 'LEASE_CONFLICT'].includes(error.code)
            )
              throw error;
          }
        }
        // Browser disconnect/uninstallation cannot kill shared running work.
        // Genuine authority revocation still fences this physical operation.
        active.throwIfAborted();
        const read = input.readCoordination;
        const stamp = await read?.(identity, context.sessionId);
        active.throwIfAborted();
        const key =
          stamp?.authorityRevision && prewarmKey(context, identity, stamp);
        const target =
          stamp &&
          (plan ? plannedGeneration(stamp.vm) : targetGeneration(stamp.vm));
        if (
          plan &&
          (!key ||
            !target ||
            !canSharePrewarmTarget(plan, target) ||
            plan.key !== key)
        )
          throw new DataAccessError('authorization_denied');
        if (
          takeover &&
          (stamp?.vm?.phase !== 'starting' ||
            stamp.vm.leaseOwner ||
            !matchesInstance(stamp.vm, takeover.predecessor))
        )
          throw new PersonVmError('LEASE_LOST');
        const reservation: PrewarmReservation | undefined = plan
          ? {}
          : undefined;
        if (plan && reservation) plan.reservation = reservation;
        async function currentGeneration(
          result: PersonVmView,
          expected: Generation,
        ) {
          if (
            !read ||
            !key ||
            (plan && (!expected.vmId || !expected.instanceId))
          )
            return;
          const next = await read(identity, context.sessionId);
          if (
            !next.authorityRevision ||
            prewarmKey(context, identity, next) !== key
          )
            return;
          return matchingGeneration(next, result, expected);
        }
        const start = (signal: AbortSignal) =>
          input.prewarmCurrent(
            context,
            identity,
            {
              trigger,
              ...(plan && {
                target: {
                  ...plan.target,
                  deletionFence: stamp?.vm?.deletionFence ?? null,
                  ...(reservation && {
                    observeVmReservation(vmId: string) {
                      reservation.vmId = vmId;
                    },
                    observeVmStart(binding: PersonVmBinding) {
                      reservation.vmId = binding.vmId;
                      reservation.instance = binding;
                    },
                  }),
                  ...(takeover && {
                    orphanedStart: {
                      predecessor: takeover.predecessor,
                      observeLease(token: string, signal: AbortSignal) {
                        takeover.lease = { token, signal };
                      },
                      observeInstance(binding: PersonVmBinding) {
                        takeover.instance = binding;
                      },
                      observeFailure(
                        token: string,
                        phase: NonNullable<OrphanedStart['failure']>['phase'],
                      ) {
                        if (takeover.lease?.token === token)
                          takeover.failure = { phase };
                      },
                      observeRelease(
                        token: string,
                        rowVersion: string,
                        stage: PersonVmLeaseReleaseStage,
                      ) {
                        if (takeover.lease?.token === token && takeover.failure)
                          takeover.failure.release = { rowVersion, stage };
                      },
                    },
                  }),
                  async assertAuthority(current) {
                    if (
                      !(await isCurrent(
                        context,
                        identity,
                        plan,
                        current,
                        'authority',
                      ))
                    )
                      throw new DataAccessError('authorization_denied');
                    await plan.assertTicketThread?.(current);
                  },
                },
              }),
            },
            signal,
          );
        const ticket =
          !takeover && read && key && target
            ? shared({
                key,
                target,
                reservation,
                starting: stamp?.vm?.phase === 'starting',
                revoked,
                start,
                async confirm(result, flight) {
                  return currentGeneration(
                    result,
                    plan ? observedPrewarmTarget(plan) : flight.target,
                  );
                },
              })
            : undefined;
        if (plan && ticket) plan.reservation = ticket.flight.reservation;
        const warmed = ticket && (await ticket.flight.work);
        async function qualify(result: PersonVmView, generation?: Generation) {
          await current();
          if (
            result.personId !== identity.personId ||
            result.organizationId !== identity.organizationId
          )
            throw new DataAccessError('authorization_denied');
          const sameGeneration = async () => {
            const expected = generation ?? plan?.target;
            if (!expected || !read || !key) return true;
            const actual = await currentGeneration(result, expected);
            if (actual && plan) plan.target = actual;
            return Boolean(actual);
          };
          const expected = exactPrewarmBinding(identity, generation);
          // A previously accepted cold ticket only uses the physical binding
          // published by its own start. No ticket is rebound during proof.
          if (
            plan &&
            (!expected ||
              (plan.target.instanceId === null &&
                (!plan.reservation?.instance ||
                  !matchesInstance(generation, plan.reservation.instance))))
          )
            return;
          let proof: AbortSignal | undefined;
          try {
            proof =
              runningProof ??
              (expected
                ? await prove?.(context, identity, active, expected)
                : await prove?.(context, identity, active));
          } catch (error) {
            active.throwIfAborted();
            const missingOwner =
              error instanceof DEntryNativeUnavailable ||
              (error instanceof PersonVmError &&
                [
                  'NOT_FOUND',
                  'LEASE_CONFLICT',
                  'LEASE_LOST',
                  'RUNTIME_NOT_READY',
                ].includes(error.code));
            if (missingOwner && !(await sameGeneration())) return;
            throw error;
          }
          if (!(await sameGeneration())) return;
          active.throwIfAborted();
          proof?.throwIfAborted();
          return { proof };
        }
        if (warmed && (plan || ticket?.started || warmed.generation)) {
          const qualified = await qualify(warmed.result, warmed.generation);
          if (qualified) return qualified.proof;
        }
        if (plan && ticket) throw new DEntryNativeUnavailable();
        // A transition can outrun the reservation or a caller's editor proof.
        // Use the original lease path when the shared epoch no longer matches.
        if (ticket) await current();
        active.throwIfAborted();
        let own: PersonVmView;
        try {
          own = await start(AbortSignal.any([input.lifetime, revoked]));
        } catch (error) {
          // The exact physical operation has joined. Preserve only a
          // pre-publication failure it actually observed under this lease.
          if (
            plan &&
            takeover?.failure?.release?.stage === 'joined' &&
            takeover.lease &&
            !takeover.instance &&
            !takeover.lease.signal.aborted &&
            !active.aborted
          )
            plan.observeTerminalFailure = true;
          throw error;
        }
        // A takeover can succeed without a shared flight. Verify its fresh
        // persisted instance against the original ticket before opening it.
        const expected = plan && observedPrewarmTarget(plan);
        const generation = expected && (await currentGeneration(own, expected));
        const qualified = await qualify(own, generation);
        if (plan && !qualified) throw new DEntryNativeUnavailable();
        return qualified?.proof;
      });
      pending.add(task);
      const settled = () => {
        pending.delete(task);
        if (plan && takeover) {
          activeOrphanedPlans.delete(plan.key);
          takeover.active = undefined;
          takeover.lease = undefined;
        }
      };
      void task.then(settled, settled);
      return task;
    },
  };
  return {
    port,
    close() {
      if (closing) return closing;
      stopped.abort(new DEntryNativeUnavailable());
      // Wait for actual create/start settlement; never stop or delete the VM.
      closing = Promise.allSettled([...pending]).then(() => {});
      return closing;
    },
  };
}

export function installDEntryNativePrewarm(
  input: Parameters<typeof createDEntryNativePrewarmPort>[0],
) {
  const assembly = createDEntryNativePrewarmPort(input);
  let uninstall: () => void;
  try {
    uninstall = installDEntryNativePrewarmPort(assembly.port);
  } catch (error) {
    void assembly.close();
    throw error;
  }
  const close = () => {
    uninstall();
    input.lifetime.removeEventListener('abort', abort);
    return assembly.close();
  };
  const abort = () => {
    void close();
  };
  input.lifetime.addEventListener('abort', abort, { once: true });
  if (input.lifetime.aborted) abort();
  return { close };
}

/** A real production composition can install both narrow ports together.
 * Construction of its actual VM/runtime/configuration remains its prerequisite. */
export function installAssignedDEntryNativeRuntime(
  input: Omit<
    Parameters<typeof installAssignedDEntryNativeCatalog>[0],
    'vm'
  > & {
    vm: Pick<PersonVmPort, 'resolve' | 'assertCurrentBinding'>;
    prewarmCurrent: CurrentSelectionPrewarm;
    isLiveSlottedBinding?(binding: PersonVmBinding): boolean;
    reconcileStoppedEntry?: CurrentSelectionEntryRecovery;
  },
) {
  const catalog = installAssignedDEntryNativeCatalog(input);
  let prewarm: ReturnType<typeof installDEntryNativePrewarm>;
  try {
    prewarm = installDEntryNativePrewarm({
      ...input,
      requireEditorProof: true,
      readCoordination: readCurrentCoordination,
    });
  } catch (error) {
    void catalog.close();
    throw error;
  }
  return {
    async close() {
      await Promise.all([prewarm.close(), catalog.close()]);
    },
  };
}
