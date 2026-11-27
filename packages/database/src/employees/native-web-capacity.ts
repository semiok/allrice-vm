import type postgres from 'postgres';
import type { DEntryRolloutPolicy, RequestContext } from '@allrice/contracts';
import { DataAccessError } from '../data.ts';
import { readDEntryReleasePolicy } from '../d-entry-release-policy.ts';
import { readServicePersonVmEmployeePortSlots } from '../service-build-identity.ts';
import { EmployeeAccessBusyError } from './employee-access-cancellation.ts';
import { EmployeeInstanceError } from './employee-instances.ts';
import {
  readNativeWebEmployeeIds,
  type NativeWebCapacityEntry,
} from './native-web-roster.ts';

type Tx = postgres.TransactionSql;
type Owner = DEntryRolloutPolicy['selections'][number];

const rosterRefusals = new WeakSet<Error>();

function refuseRoster(error: Error): never {
  rosterRefusals.add(error);
  throw error;
}

/** Background refresh may defer only the original errors from this gate. */
export function isNativeWebRosterAdmissionError(
  error: unknown,
): error is Error {
  return error instanceof Error && rosterRefusals.has(error);
}

/** The target row is the same global fence used by self-service and live
 * roster reads. The caller may already hold a platform, member or deployment
 * lock. NOWAIT lets that whole authorized transaction settle on contention. */
async function lockPeople(tx: Tx, targets: readonly Owner[]) {
  const people = [...new Set(targets.map(({ personId }) => personId))];
  if (!people.length) return;
  try {
    await tx`select id from allrice_users where id=any(${tx.array(people)}::uuid[])
      order by id for no key update nowait`;
  } catch (error) {
    rethrowLockError(error);
  }
}

type VmCapacityRow = {
  organization_id: string;
  phase: string;
  lease_owner: string | null;
  verified_web_slot_capacity: number | null;
};

function rethrowLockError(error: unknown): never {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '55P03'
  )
    refuseRoster(new EmployeeAccessBusyError());
  throw error;
}

async function readVm(
  tx: Tx,
  personId: string,
): Promise<VmCapacityRow | undefined> {
  try {
    const [row] = await tx<
      VmCapacityRow[]
    >`select organization_id,phase,lease_owner,verified_web_slot_capacity
      from person_virtual_machines where person_id=${personId} for share nowait`;
    return row;
  } catch (error) {
    rethrowLockError(error);
  }
}

async function assertCapacity(
  tx: Tx,
  owner: Owner,
  after: number,
  enrolling: boolean,
) {
  let vm = await readVm(tx, owner.personId);
  if (!vm && enrolling) {
    // An empty row is not a fence against the first physical owner. Never
    // wait on the VM lock while holding the user row needed by its roster.
    const [claim] = await tx`select pg_try_advisory_xact_lock_shared(
      hashtextextended(${'person-vm:' + owner.personId},0)) as locked`;
    if (claim?.locked !== true) refuseRoster(new EmployeeAccessBusyError());
    vm = await readVm(tx, owner.personId);
  }
  if (vm && vm.organization_id !== owner.organizationId) {
    if (enrolling) refuseRoster(new DataAccessError('authorization_denied'));
    vm = undefined;
  }
  if (
    enrolling &&
    vm?.verified_web_slot_capacity === null &&
    (vm.lease_owner !== null ||
      !['stopped', 'cold', 'deleted'].includes(vm.phase))
  )
    refuseRoster(
      new EmployeeInstanceError(
        'employee_port_slots_full',
        '当前工作台还没确认停机，停机后可以创建更多员工。',
      ),
    );
  const capacity =
    vm?.verified_web_slot_capacity ??
    (await readServicePersonVmEmployeePortSlots());
  if (after > capacity)
    refuseRoster(
      new EmployeeInstanceError(
        'employee_port_slots_full',
        `每人最多 ${capacity} 个员工`,
      ),
    );
}

/** Self-service already holds the current user's identity and rollout locks. */
export async function assertNativeWebEmployeeCapacity(
  context: RequestContext,
  tx: Tx,
) {
  const owner = {
    personId: context.actor.id.toLowerCase(),
    organizationId: context.organizationId.toLowerCase(),
  };
  const roster = await readNativeWebEmployeeIds(tx, owner, true);
  await assertCapacity(tx, owner, roster.size + 1, true);
}

type ChangeScope =
  | {
      organizationId: string;
      workspaceId?: string;
      personIds?: readonly string[];
    }
  | { personId: string };

export async function captureNativeWebRosterChange(
  tx: Tx,
  scope: ChangeScope,
  options: {
    recheckWriter?: () => Promise<void>;
    enrolling?: boolean;
    lockBeforeRead?: boolean;
    whenEnabled?: true;
  } = {},
) {
  const policy = await readDEntryReleasePolicy(tx, true);
  const personIds =
    'personIds' in scope && scope.personIds
      ? new Set(scope.personIds.map((id) => id.toLowerCase()))
      : undefined;
  const workspaceId =
    'workspaceId' in scope ? scope.workspaceId?.toLowerCase() : undefined;
  let targets = policy.selections.filter((selection) =>
    'personId' in scope
      ? selection.personId === scope.personId.toLowerCase()
      : selection.organizationId === scope.organizationId.toLowerCase() &&
        (!personIds || personIds.has(selection.personId)),
  );
  if (
    targets.length &&
    workspaceId &&
    !personIds &&
    'organizationId' in scope
  ) {
    const members = await tx<{ user_id: string }[]>`
      select distinct m.user_id from allrice_memberships m
      where m.organization_id=${scope.organizationId}
        and m.user_id=any(${tx.array(targets.map(({ personId }) => personId))}::uuid[])
        and m.active and m.role in ('admin','member')
        and (m.workspace_id is null or m.workspace_id=${workspaceId})`;
    const eligible = new Set(members.map(({ user_id }) => user_id));
    targets = targets.filter(({ personId }) => eligible.has(personId));
  }
  // A membership becoming writable must share the account row fence even
  // when the account is currently disabled and the visible roster is empty.
  if (options.lockBeforeRead) await lockPeople(tx, targets);
  const readRoster = (owner: Owner) =>
    readNativeWebEmployeeIds(tx, owner, options.whenEnabled);
  type Roster = Awaited<ReturnType<typeof readRoster>>;
  const previous: { owner: Owner; ids: Roster }[] = [];
  for (const owner of targets)
    previous.push({ owner, ids: await readRoster(owner) });
  return async (changed?: {
    assignmentIds?: ReadonlySet<string>;
    employeeId?: string;
    grantedPeople?: ReadonlySet<string>;
  }) => {
    if (changed?.assignmentIds?.size === 0 && !changed.grantedPeople?.size)
      return;
    const additions = [];
    for (const { owner, ids } of previous) {
      const wasAdded = (entry: NativeWebCapacityEntry, id: string) =>
        !ids.has(id) &&
        (!changed?.assignmentIds ||
          (entry.assignmentId !== null &&
            changed.assignmentIds.has(entry.assignmentId))) &&
        (!changed?.employeeId || changed.employeeId === entry.employeeId) &&
        (!workspaceId || workspaceId === entry.workspaceId);
      // A new or reactivated assignment is a grant even if the target
      // cannot currently log in. Check its physical owner and legacy phase.
      const granted = changed?.grantedPeople?.has(owner.personId) === true;
      if (
        granted ||
        [...(await readRoster(owner))].some(([id, entry]) =>
          wasAdded(entry, id),
        )
      )
        additions.push({ owner, wasAdded, granted });
    }
    if (!additions.length) return;
    await options.recheckWriter?.();
    if (!options.lockBeforeRead)
      await lockPeople(
        tx,
        additions.map(({ owner }) => owner),
      );
    for (const { owner, wasAdded, granted } of additions) {
      const current = await readRoster(owner);
      if (granted || [...current].some(([id, entry]) => wasAdded(entry, id)))
        await assertCapacity(
          tx,
          owner,
          current.size,
          options.enrolling !== false,
        );
    }
  };
}

/** The publisher already holds its exact authority and exclusive policy lock. */
export async function assertNativeWebRolloutCapacity(
  tx: Tx,
  previous: DEntryRolloutPolicy,
  next: DEntryRolloutPolicy,
) {
  const selections = new Set(
    previous.selections.map(
      ({ organizationId, personId }) => `${organizationId}:${personId}`,
    ),
  );
  const targets = next.selections.filter(
    ({ organizationId, personId }) =>
      !selections.has(`${organizationId}:${personId}`),
  );
  await lockPeople(tx, targets);
  for (const owner of targets) {
    const count = (await readNativeWebEmployeeIds(tx, owner, true)).size;
    if (count) await assertCapacity(tx, owner, count, false);
  }
}
