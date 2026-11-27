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
  type PersonVmPort,
  type PersonVmView,
} from '@allrice/person-vm';
import type {
  CurrentSelectionPrewarm,
  PrewarmAuthorityTransaction,
} from '../person-vm/production-prewarm.js';
import { DEntryNativeUnavailable } from '../d-entry/native-owner.js';
import { currentDEntryNativeDataPort } from '../d-entry/native-data.js';
import {
  compatiblePrewarmGeneration as compatible,
  installDEntryNativePrewarmPort,
  type DEntryNativePrewarmPort,
  type PrewarmGeneration as Generation,
  type PrewarmPlan,
} from '../d-entry/native-prewarm.js';
import { installAssignedDEntryNativeCatalog } from './native-catalog.js';

type VmStamp = Generation & {
  phase: PersonVmView['phase'];
  diskRetained?: boolean;
  leaseOwner: string | null;
  hasEgressReceipt?: boolean;
};
type VmStampRow = Omit<VmStamp, 'leaseEpoch'> & { leaseEpoch: string };
type Coordination = {
  authorityRevision: string | null;
  vm: VmStamp | null;
  upgradeRestart?: boolean;
};
type ReadCoordination = (
  identity: DEntryIdentity,
  sessionId: string,
) => Promise<Coordination>;

// The release restart reuses the same query under its already-held
// authority lock. It must never request a second pool connection there.
async function readCoordinationInTransaction(
  sql: PrewarmAuthorityTransaction,
  identity: DEntryIdentity,
  sessionId: string,
): Promise<Coordination> {
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
      disk_retained as "diskRetained", lease_owner as "leaseOwner",
      (egress_receipt is not null) as "hasEgressReceipt",
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
        ? JSON.stringify([policy.revision, grants, employeeGrant, threadGrant])
        : null,
    vm: vm ? { ...vm, leaseEpoch: Number(vm.leaseEpoch) } : null,
  };
}
const readCurrentCoordination: ReadCoordination = (identity, sessionId) =>
  getDatabase().begin('isolation level repeatable read read only', (sql) =>
    readCoordinationInTransaction(sql, identity, sessionId),
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
  revision: string,
  result: PersonVmView,
  target: Generation,
) {
  if (
    stamp.authorityRevision !== revision ||
    stamp.vm?.phase !== 'running' ||
    !stamp.vm.instanceId ||
    !result.ready ||
    result.vmId !== stamp.vm.vmId ||
    !compatible(target, stamp.vm)
  )
    return;
  return stamp.vm;
}

type Flight = {
  target: Generation;
  join(revoked: AbortSignal): void;
  work: Promise<{ result: PersonVmView; generation: Generation | undefined }>;
};

function prewarmKey(
  context: RequestContext,
  identity: DEntryIdentity,
  revision: string,
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
    revision,
  ]);
}

/** Consume the existing VM lifecycle; no completed-result or authority cache. */
export function createDEntryNativePrewarmPort(input: {
  prewarmCurrent: CurrentSelectionPrewarm;
  lifetime: AbortSignal;
  requireEditorProof?: boolean;
  readCoordination?: ReadCoordination;
  ownsRunningBinding?: (binding: PersonVmBinding) => boolean;
}) {
  input.lifetime.throwIfAborted();
  const stopped = new AbortController();
  const admission = AbortSignal.any([input.lifetime, stopped.signal]);
  const pending = new Set<Promise<AbortSignal | undefined>>();
  const flights = new Map<string, Set<Flight>>();
  let closing: Promise<void> | undefined;

  const load = input.readCoordination;
  const ownsRunningBinding = input.ownsRunningBinding;
  const readCoordination: ReadCoordination | undefined =
    load &&
    (async (identity, sessionId) => {
      const stamp = await load(identity, sessionId);
      const vm = stamp.vm;
      if (
        (vm?.phase === 'running' || vm?.phase === 'failed') &&
        vm.instanceId &&
        vm.vmId &&
        vm.hasEgressReceipt &&
        ownsRunningBinding &&
        !ownsRunningBinding({
          personId: identity.personId,
          organizationId: identity.organizationId,
          vmId: vm.vmId,
          instanceId: vm.instanceId,
          leaseEpoch: vm.leaseEpoch,
        })
      ) {
        // No local owner is only a planning fact. The VM service requires
        // its physical lease and independent prior-gateway fencing.
        return {
          ...stamp,
          vm: { ...vm, phase: 'stopped' },
          upgradeRestart: true,
        };
      }
      return stamp;
    });

  function shared({
    key,
    target,
    starting,
    revoked,
    start,
    confirm,
  }: {
    key: string;
    target: Generation;
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
      if (
        !compatible(flight.target, target) ||
        (target.restoreRetained && !flight.target.restoreRetained)
      )
        continue;
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
    mode: 'authority' | 'operation' | 'ready',
  ) {
    const signal = AbortSignal.any([admission, caller]);
    signal.throwIfAborted();
    const stamp = await readCoordination?.(identity, context.sessionId);
    signal.throwIfAborted();
    if (
      !stamp?.authorityRevision ||
      plan.key !== prewarmKey(context, identity, stamp.authorityRevision)
    )
      return false;
    if (mode === 'authority') return true;
    const exact = (vm: Generation | null | undefined) =>
      !!vm &&
      vm.leaseEpoch === plan.target.leaseEpoch &&
      (!plan.target.vmId || vm.vmId === plan.target.vmId) &&
      (!plan.target.instanceId || vm.instanceId === plan.target.instanceId);
    if (mode === 'ready')
      return (
        stamp.vm?.phase === 'running' &&
        !!stamp.vm.instanceId &&
        !stamp.vm.leaseOwner &&
        exact(stamp.vm)
      );
    if (stamp.vm?.phase === 'deleted')
      return (
        (plan.target.restoreRetained === true ||
          plan.target.replacesVmId === stamp.vm.vmId) &&
        exact(plannedGeneration(stamp.vm))
      );
    return exact(stamp.vm) || exact(plannedGeneration(stamp.vm));
  }
  const port: DEntryNativePrewarmPort = {
    isCurrent,
    async prepare(context, identity, caller) {
      const signal = AbortSignal.any([admission, caller]);
      signal.throwIfAborted();
      const read = readCoordination;
      const data = currentDEntryNativeDataPort();
      if (!read || (input.requireEditorProof && !data?.assertEditorReady))
        throw new DEntryNativeUnavailable();
      const stamp = await read(identity, context.sessionId);
      signal.throwIfAborted();
      const target = plannedGeneration(stamp.vm);
      if (!stamp.authorityRevision || !target)
        throw new DataAccessError('authorization_denied');
      const key = prewarmKey(context, identity, stamp.authorityRevision);
      return {
        key,
        target,
        running: stamp.vm?.phase === 'running' && !stamp.vm.leaseOwner,
        ...(stamp.upgradeRestart && { upgradeRestart: true }),
      };
    },
    prewarm(context, identity, trigger, caller, revoked, plan) {
      if (admission.aborted) return Promise.reject(admission.reason);
      const data = currentDEntryNativeDataPort();
      const prove = data?.assertEditorReady?.bind(data);
      if (input.requireEditorProof && !prove)
        return Promise.reject(new DEntryNativeUnavailable());
      const task = Promise.resolve().then(async () => {
        const active = AbortSignal.any([admission, caller, revoked]);
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
        // branch checks VM-wide readiness. A cold Host follows normal startup.
        const runningProof = plan?.running
          ? await prove?.(context, identity, active)
          : undefined;
        runningProof?.throwIfAborted();
        const noPlanStamp =
          !plan && ownsRunningBinding
            ? await readCoordination?.(identity, context.sessionId)
            : undefined;
        if (
          !plan &&
          input.requireEditorProof &&
          prove &&
          (!noPlanStamp || noPlanStamp.vm?.phase === 'running')
        ) {
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
        const read = readCoordination;
        const stamp = await read?.(identity, context.sessionId);
        active.throwIfAborted();
        if (
          (plan?.upgradeRestart || stamp?.upgradeRestart) &&
          trigger !== 'open'
        )
          throw new PersonVmError('UPGRADE_OPEN_REQUIRED');
        const revision = stamp?.authorityRevision;
        const target =
          stamp &&
          (plan ? plannedGeneration(stamp.vm) : targetGeneration(stamp.vm));
        if (
          plan &&
          (!revision ||
            !target ||
            !compatible(target, plan.target) ||
            (target.restoreRetained && !plan.target.restoreRetained) ||
            plan.key !== prewarmKey(context, identity, revision))
        )
          throw new DataAccessError('authorization_denied');
        const start = (signal: AbortSignal) =>
          input.prewarmCurrent(
            context,
            identity,
            {
              trigger,
              ...(trigger === 'open' &&
                plan && {
                  async assertLockedUpgradeTicket(sql, current) {
                    const stamp = await readCoordinationInTransaction(
                      sql,
                      identity,
                      context.sessionId,
                    );
                    if (
                      !stamp.authorityRevision ||
                      plan.key !==
                        prewarmKey(context, identity, stamp.authorityRevision)
                    )
                      throw new DataAccessError('authorization_denied');
                    await plan.assertTicketThread?.(current);
                    current.throwIfAborted();
                  },
                }),
              ...(plan && {
                target: {
                  ...plan.target,
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
          read && revision && target
            ? shared({
                key: prewarmKey(context, identity, revision),
                target,
                starting: stamp?.vm?.phase === 'starting',
                revoked,
                start,
                async confirm(result, flight) {
                  return matchingGeneration(
                    await read(identity, context.sessionId),
                    revision,
                    result,
                    flight.target,
                  );
                },
              })
            : undefined;
        const warmed = ticket && (await ticket.flight.work);
        async function qualify(result: PersonVmView, generation?: Generation) {
          await current();
          if (
            result.personId !== identity.personId ||
            result.organizationId !== identity.organizationId
          )
            throw new DataAccessError('authorization_denied');
          const sameGeneration = async () => {
            const expected = plan?.target ?? generation;
            if (!expected || !read || !revision) return true;
            const actual = matchingGeneration(
              await read(identity, context.sessionId),
              revision,
              result,
              expected,
            );
            if (actual && plan) plan.target = actual;
            return Boolean(actual);
          };
          let proof: AbortSignal | undefined;
          try {
            proof = runningProof ?? (await prove?.(context, identity, active));
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
        const own = await start(AbortSignal.any([input.lifetime, revoked]));
        const qualified = await qualify(own);
        if (plan && !qualified) throw new DEntryNativeUnavailable();
        return qualified?.proof;
      });
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
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

export function installDEntryNativePrewarm(input: {
  prewarmCurrent: CurrentSelectionPrewarm;
  lifetime: AbortSignal;
  requireEditorProof?: boolean;
  readCoordination?: ReadCoordination;
  ownsRunningBinding?: (binding: PersonVmBinding) => boolean;
}) {
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
    ownsRunningBinding?: (binding: PersonVmBinding) => boolean;
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
