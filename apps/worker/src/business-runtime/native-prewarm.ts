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
  type PersonVmPort,
  type PersonVmView,
} from '@allrice/person-vm';
import type { CurrentSelectionPrewarm } from '../person-vm/production-prewarm.js';
import { DEntryNativeUnavailable } from '../d-entry/native-owner.js';
import { currentDEntryNativeDataPort } from '../d-entry/native-data.js';
import {
  installDEntryNativePrewarmPort,
  type DEntryNativePrewarmPort,
} from '../d-entry/native-prewarm.js';
import { installAssignedDEntryNativeCatalog } from './native-catalog.js';

type Generation = {
  vmId: string | null;
  instanceId: string | null;
  leaseEpoch: number;
};
type VmStamp = Generation & { phase: PersonVmView['phase'] };
type VmStampRow = Omit<VmStamp, 'leaseEpoch'> & { leaseEpoch: string };
type Coordination = { authorityRevision: string | null; vm: VmStamp | null };
type ReadCoordination = (identity: DEntryIdentity) => Promise<Coordination>;

const readCurrentCoordination: ReadCoordination = (identity) =>
  getDatabase().begin(
    'isolation level repeatable read read only',
    async (sql) => {
      const policy = await readDEntryReleasePolicy(sql);
      if (selectDEntryGeneration(policy, identity) !== '4.0')
        throw new DataAccessError('authorization_denied');
      const [snapshot] = await sql<
        { vm: VmStampRow | null; grants: string[] }[]
      >`
      select (select row_to_json(stamp) from (
        select vm_id as "vmId", instance_id as "instanceId", phase,
          lease_epoch::text as "leaseEpoch" from person_virtual_machines
        where person_id=${identity.personId} and organization_id=${identity.organizationId}
      ) stamp) as vm,
      array(select m.id::text || ':' || m.xmin::text from allrice_memberships m
        where m.user_id=${identity.personId} and m.organization_id=${identity.organizationId}
          and m.active and m.role in ('admin','member')
          and (m.workspace_id is null or m.workspace_id=${identity.workspaceId})
        order by m.id) as grants`;
      const { vm, grants } = snapshot!;
      return {
        // Tuple versions partition reuse across a revoke/regrant even if the
        // restored membership has the same role. They never grant authority.
        authorityRevision: grants.length
          ? JSON.stringify([policy.revision, grants])
          : null,
        vm: vm ? { ...vm, leaseEpoch: Number(vm.leaseEpoch) } : null,
      };
    },
  );

function targetGeneration(vm: VmStamp | null): Generation | undefined {
  if (!vm) return { vmId: null, instanceId: null, leaseEpoch: 1 };
  if (vm.phase === 'deleted' || !Number.isSafeInteger(vm.leaseEpoch)) return;
  if (vm.phase === 'running' || (vm.phase === 'starting' && vm.instanceId))
    return vm;
  // A retained or as-yet-unstarted VM advances exactly one epoch on start.
  if (!Number.isSafeInteger(vm.leaseEpoch + 1)) return;
  return { vmId: vm.vmId, instanceId: null, leaseEpoch: vm.leaseEpoch + 1 };
}

function compatible(a: Generation, b: Generation) {
  return (
    a.leaseEpoch === b.leaseEpoch &&
    (!a.vmId || !b.vmId || a.vmId === b.vmId) &&
    (!a.instanceId || !b.instanceId || a.instanceId === b.instanceId)
  );
}

function completedGeneration(
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
    throw new PersonVmError('LEASE_LOST');
  return stamp.vm;
}

type Flight = {
  target: Generation;
  join(revoked: AbortSignal): void;
  work: Promise<PersonVmView>;
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
}) {
  input.lifetime.throwIfAborted();
  const stopped = new AbortController();
  const admission = AbortSignal.any([input.lifetime, stopped.signal]);
  const pending = new Set<Promise<AbortSignal | undefined>>();
  const flights = new Map<string, Set<Flight>>();
  let closing: Promise<void> | undefined;

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
    confirm(result: PersonVmView, flight: Flight): Promise<Generation>;
  }) {
    const group = flights.get(key) ?? new Set<Flight>();
    for (const flight of group) {
      if (!compatible(flight.target, target)) continue;
      // A later waiter may already know which physical start was published.
      flight.target = {
        vmId: flight.target.vmId ?? target.vmId,
        instanceId: flight.target.instanceId ?? target.instanceId,
        leaseEpoch: target.leaseEpoch,
      };
      flight.join(revoked);
      return flight;
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
      flight.target = await confirm(result, flight);
      physical.throwIfAborted();
      return result;
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
    return flight;
  }
  const port: DEntryNativePrewarmPort = {
    prewarm(context, identity, trigger, caller, revoked) {
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
        if (input.requireEditorProof && prove) {
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
        const stamp = await read?.(identity);
        active.throwIfAborted();
        const revision = stamp?.authorityRevision;
        const target = stamp && targetGeneration(stamp.vm);
        const start = (signal: AbortSignal) =>
          input.prewarmCurrent(context, identity, { trigger }, signal);
        const flight =
          read && revision && target
            ? shared({
                key: prewarmKey(context, identity, revision),
                target,
                starting: stamp?.vm?.phase === 'starting',
                revoked,
                start,
                async confirm(result, flight) {
                  return completedGeneration(
                    await read(identity),
                    revision,
                    result,
                    flight.target,
                  );
                },
              })
            : undefined;
        const result = await (flight?.work ??
          start(AbortSignal.any([input.lifetime, revoked])));
        await current();
        if (
          result.personId !== identity.personId ||
          result.organizationId !== identity.organizationId
        )
          throw new DataAccessError('authorization_denied');
        const proof = await prove?.(context, identity, active);
        if (flight && read && revision)
          completedGeneration(
            await read(identity),
            revision,
            result,
            flight.target,
          );
        active.throwIfAborted();
        return proof;
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
