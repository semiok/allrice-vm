import { randomUUID } from 'node:crypto';
import type { RequestContext } from '@allrice/contracts';
import {
  PersonVmError,
  type PersonVmActivity,
  type PersonVmBinding,
  type PersonVmEgressReceipt,
  type PersonVmRuntimePort,
  type PersonVmAuthority,
  type PersonVmEgressPort,
} from './contract.ts';
import type { PersonDisk, PersonVmDiskPort } from './encrypted-disk.ts';
import type { PersonVmNativePort } from './microsandbox.ts';
import { PersonVmService } from './person-vm.ts';
import type { PersonVmStore, VmAudit, VmRecord } from './store.ts';
import type { DiskPoolOwner } from './disk-pool-platform.ts';

export function context(
  organizationId: string = randomUUID(),
  personId: string = randomUUID(),
): RequestContext {
  return {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: personId },
    organizationId,
    workspaceId: null,
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
}
export class MemoryStore implements PersonVmStore {
  rows = new Map<string, VmRecord>();
  audits: (VmAudit & DiskPoolOwner)[] = [];
  onOfflineWait?: () => void;
  private busy = new Map<
    string,
    { preparation?: string; settled: Promise<void> }
  >();
  async read(id: string) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }
  async withLease<T>(
    personId: string,
    options: Parameters<PersonVmStore['withLease']>[1],
    work: Parameters<PersonVmStore['withLease']>[2],
  ): Promise<T> {
    const lane = options.offlinePreparation;
    lane?.signal.throwIfAborted();
    const prior = this.busy.get(personId);
    let joinedOfflinePreparation = false;
    if (lane?.mode === 'join' && prior?.preparation === lane.organizationId) {
      joinedOfflinePreparation = true;
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(lane.signal.reason);
      });
      lane.signal.addEventListener('abort', abort, { once: true });
      try {
        this.onOfflineWait?.();
        await Promise.race([prior.settled, cancelled]);
      } finally {
        lane.signal.removeEventListener('abort', abort);
      }
      lane.signal.throwIfAborted();
    }
    if (this.busy.has(personId) || this.rows.get(personId)?.leaseOwner)
      throw new PersonVmError('LEASE_CONFLICT');
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.busy.set(personId, {
      settled,
      preparation: lane?.mode === 'prepare' ? lane.organizationId : undefined,
    });
    const row = await this.read(personId);
    const owner = randomUUID();
    if (this.rows.has(personId)) this.rows.get(personId)!.leaseOwner = owner;
    try {
      return (await work({
        row,
        joinedOfflinePreparation,
        signal: new AbortController().signal,
        assertAdmissionOpen: async () => {},
        guard: async () => {},
        hasCompletedDiskDeletion: async ({ personId, organizationId, vmId }) =>
          this.audits.some(
            (event) =>
              event.personId === personId &&
              event.organizationId === organizationId &&
              event.vmId === vmId &&
              event.action === 'delete-disk' &&
              event.result === 'succeeded',
          ),
        hasRetainedDiskRows: async (vmIds) =>
          vmIds.every((id) =>
            [...this.rows.values()].some(
              (row) => row.vmId === id && row.diskRetained,
            ),
          ),
        save: async (value) => {
          this.rows.set(personId, {
            ...structuredClone(value),
            leaseOwner: owner,
          });
        },
        audit: async (value, event) => {
          this.audits.push({
            ...event,
            vmId: value.vmId,
            personId: value.personId,
            organizationId: value.organizationId,
          });
        },
      })) as T;
    } finally {
      this.busy.delete(personId);
      const saved = this.rows.get(personId);
      if (saved) saved.leaseOwner = null;
      settle();
    }
  }
  async recover<T>(): Promise<T> {
    throw new PersonVmError('LEASE_CONFLICT');
  }
}
export function harness(store: PersonVmStore = new MemoryStore()) {
  let time = Date.parse('2026-11-21T10:00:00Z');
  const now = () => new Date(time);
  const log: string[] = [];
  const disks = new Set<string>();
  const diskTiers = new Map<string, PersonDisk['tier']>();
  const partialDisks = new Set<string>();
  const mounts = new Set<string>();
  const states = new Map<
    string,
    'absent' | 'stopped' | 'running' | 'unknown'
  >();
  let allow = true,
    allowDeleteDisk = false;
  const authority: PersonVmAuthority = {
    authorize: async (rc, action) => {
      if (!allow || (action === 'delete-disk' && !allowDeleteDisk))
        throw new PersonVmError('AUTHORIZATION_DENIED');
      return { personId: rc.actor.id, organizationId: rc.organizationId };
    },
  };
  const disk: PersonVmDiskPort = {
    listFormalDiskIds: async () => [...new Set([...disks, ...partialDisks])],
    confirmAbsence: async (vmId) =>
      !disks.has(vmId) && !partialDisks.has(vmId) && !mounts.has(vmId),
    inspect: async (id) =>
      partialDisks.has(id)
        ? { state: 'unknown' }
        : disks.has(id)
          ? { state: 'ready', disk: { vmId: id, tier: diskTiers.get(id)! } }
          : { state: 'absent' },
    create: async (ref) => {
      log.push('disk:create');
      if (partialDisks.has(ref.vmId))
        throw new PersonVmError('PROVIDER_FAILED');
      if (disks.has(ref.vmId)) return;
      disks.add(ref.vmId);
      diskTiers.set(ref.vmId, ref.tier);
    },
    attach: async (ref) => {
      log.push('disk:attach');
      if (!disks.has(ref.vmId) || diskTiers.get(ref.vmId) !== ref.tier)
        throw new PersonVmError('PROVIDER_FAILED');
      mounts.add(ref.vmId);
      return '/synthetic/' + ref.vmId;
    },
    detach: async (ref) => {
      log.push('disk:detach');
      mounts.delete(ref.vmId);
    },
    move: async (ref, tier) => {
      log.push('disk:' + tier);
      if (mounts.has(ref.vmId)) throw new PersonVmError('CLEANUP_INCOMPLETE');
      diskTiers.set(ref.vmId, tier);
      return { ...ref, tier };
    },
    delete: async (ref: PersonDisk) => {
      log.push('disk:delete');
      if (mounts.has(ref.vmId)) throw new PersonVmError('CLEANUP_INCOMPLETE');
      disks.delete(ref.vmId);
      diskTiers.delete(ref.vmId);
    },
  };
  const native: PersonVmNativePort = {
    bootstrap: async () => {
      log.push('native:bootstrap');
      return {
        launch: async () => {
          throw new PersonVmError('RUNTIME_NOT_READY');
        },
      };
    },
    prepare: async () => {
      log.push('native:prepare');
    },
    status: async (binding) => states.get(binding.vmId) ?? 'absent',
    create: async (binding) => {
      log.push('native:create');
      states.set(binding.vmId, 'running');
    },
    start: async (binding) => {
      log.push('native:start');
      states.set(binding.vmId, 'running');
    },
    stop: async (binding) => {
      log.push('native:stop');
      if (states.has(binding.vmId)) states.set(binding.vmId, 'stopped');
    },
    ping: async (binding) => {
      if (states.get(binding.vmId) !== 'running')
        throw new PersonVmError('PROVIDER_FAILED');
    },
  };
  let ports = [38990];
  const active = new Set<string>();
  const egress: PersonVmEgressPort = {
    prepare: async (binding) => {
      log.push('egress:prepare');
      const receipt = { binding, bindingId: randomUUID(), gatewayPorts: ports };
      active.add(receipt.bindingId);
      return receipt;
    },
    assertActive: async (receipt) => {
      if (!active.has(receipt.bindingId))
        throw new PersonVmError('EGRESS_UNAVAILABLE');
    },
    revoke: async (receipt) => {
      log.push('egress:revoke');
      active.delete(receipt.bindingId);
    },
  };
  let activity: Partial<PersonVmActivity> = {};
  let readiness = { authenticated: true, editorReady: true, canSend: true };
  const runtime: PersonVmRuntimePort = {
    memoryGuestPlan: async () => ({
      files: [],
      initialize: { executable: 'node', args: [] },
      launcher: '/synthetic/launcher',
      env: {},
    }),
    start: async () => {
      log.push('runtime:start');
    },
    activity: async (binding) => ({
      binding,
      observedAt: now().toISOString(),
      state: 'known',
      activeTurns: 0,
      activeJobs: 0,
      activeSubtasks: 0,
      pendingApprovals: 0,
      ...activity,
    }),
    readiness: async (binding) => ({ binding, ...readiness }),
  };
  const options = {
    store,
    authority,
    disk,
    native,
    egress,
    runtime,
    now,
    leaseTtlMs: 90000,
    activityMaxAgeMs: 5000,
    cleanupTimeoutMs: 10000,
  };
  const service = new PersonVmService(options);
  return {
    service,
    store,
    options,
    native,
    disk,
    egress,
    runtime,
    now,
    log,
    states,
    mounts,
    disks,
    diskTiers,
    partialDisks,
    active,
    advance: (ms: number) => {
      time += ms;
    },
    setActivity: (value: Partial<PersonVmActivity>) => {
      activity = value;
    },
    setReadiness: (value: typeof readiness) => {
      readiness = value;
    },
    setPorts: (value: number[]) => {
      ports = value;
    },
    authorize: (value: boolean) => {
      allow = value;
    },
    authorizeDiskDelete: (value: boolean) => {
      allowDeleteDisk = value;
    },
  };
}
export const signal = () => new AbortController().signal;
export async function running(h: ReturnType<typeof harness>, rc = context()) {
  await h.service.prewarm(rc, { trigger: 'page' }, signal());
  return { rc, binding: await h.service.resolve(rc, signal()) };
}
/** Deterministic instantaneous samples, never proof of continuous native idle. */
export async function idleFor(
  h: ReturnType<typeof harness>,
  rc: RequestContext,
  durationMs: number,
) {
  let result = await h.service.reconcileIdle(rc, signal());
  for (let elapsed = 0; elapsed < durationMs;) {
    const step = Math.min(h.options.activityMaxAgeMs, durationMs - elapsed);
    h.advance(step);
    elapsed += step;
    result = await h.service.reconcileIdle(rc, signal());
  }
  return result;
}
export function currentReceipt(
  binding: PersonVmBinding,
): PersonVmEgressReceipt {
  return { binding, bindingId: randomUUID(), gatewayPorts: [38990] };
}
