import { setTimeout as wait } from 'node:timers/promises';
import {
  isDEntryNativeRunJournalCurrent,
  listDEntryNativeRunCandidates,
  nextRetainedDEntryNativeRunJournalOwner,
  publishDEntryNativeRunTerminal,
  type DEntryNativeRunJournalOwner,
} from '@allrice/database';
import { PersonVmError } from '@allrice/person-vm';
import type { createAssignedNativeWebStartup } from '../native-web/composition.js';
import type { NativeWebOwner } from '../native-web/owner.js';
import {
  dEntryNativeRunJournalSelection,
  type RetainedNativeRunReconciler,
} from './retained-native-run-reader.js';

/** Passive projection for each authenticated local profile. The retry source
 * is the persisted Run + execution rows, with no dependency on model calls or
 * on the original prompt's request lifetime. */
export async function reconcileNativeRunTerminals(
  startup: Pick<
    ReturnType<typeof createAssignedNativeWebStartup>,
    'runJournalOwners'
  >,
  reconcileRetainedRun: RetainedNativeRunReconciler,
  signal: AbortSignal,
) {
  const positions = new WeakMap<
    NativeWebOwner,
    Parameters<typeof listDEntryNativeRunCandidates>[1]
  >();
  let retainedAfter: DEntryNativeRunJournalOwner | undefined;
  let retained:
    | {
        scope: DEntryNativeRunJournalOwner;
        after?: Parameters<typeof listDEntryNativeRunCandidates>[1];
      }
    | undefined;
  while (!signal.aborted) {
    const local = startup.runJournalOwners();
    for (const location of local) {
      const { owner, endpoint, receipt } = location;
      const { binding } = receipt;
      if (!owner.modelAdapterId || signal.aborted || location.revoked.aborted)
        continue;
      const active = AbortSignal.any([signal, location.revoked]);
      const scope = {
        organizationId: binding.organizationId,
        workspaceId: endpoint.workspaceId,
        personId: binding.personId,
        vmId: binding.vmId,
        vmInstanceId: binding.instanceId,
        leaseEpoch: binding.leaseEpoch,
        employeeInstanceId: endpoint.employeeInstanceId,
        employeeRelease: endpoint.employeeVersionId,
      };
      const page = await listDEntryNativeRunCandidates(
        scope,
        positions.get(owner),
      ).catch(() => null);
      if (!page) continue;
      for (const candidate of page.candidates) {
        if (active.aborted) break;
        try {
          const end = await owner.readPersistedRunTerminalFor(
            dEntryNativeRunJournalSelection(candidate),
            async (reading) => {
              if (
                !(await isDEntryNativeRunJournalCurrent(
                  candidate,
                  scope,
                  reading,
                ))
              )
                throw new PersonVmError('LEASE_LOST');
            },
            active,
          );
          if (end)
            await publishDEntryNativeRunTerminal(candidate, end, active, {
              owner: scope,
            });
        } catch {
          // Lost evidence, a busy owner or an uncertain SQL outcome all leave
          // the existing row discoverable on the next pass through this page.
        }
      }
      positions.set(owner, page.next);
    }
    if (signal.aborted) break;
    if (!retained) {
      const scope = await nextRetainedDEntryNativeRunJournalOwner(
        retainedAfter,
      ).catch(() => undefined);
      if (scope) retained = { scope };
      else retainedAfter = undefined;
    }
    if (retained) {
      const { scope, after } = retained;
      const haveLocalOwner = startup
        .runJournalOwners()
        .some(
          (location) =>
            location.receipt.binding.vmId === scope.vmId &&
            location.endpoint.employeeInstanceId === scope.employeeInstanceId &&
            location.endpoint.employeeVersionId === scope.employeeRelease,
        );
      const page = haveLocalOwner
        ? null
        : await listDEntryNativeRunCandidates(scope, after, 4).catch(
            () => null,
          );
      for (const candidate of page?.candidates ?? []) {
        if (signal.aborted) break;
        try {
          await reconcileRetainedRun(candidate, scope, signal);
        } catch {
          // Unavailable physical scope, native evidence or a database ACK
          // leaves the exact pending Run discoverable on a later scan.
        }
      }
      if (page?.next) retained = { scope, after: page.next };
      else {
        retainedAfter = scope;
        retained = undefined;
      }
    }

    await wait(10_000, undefined, { signal, ref: false }).catch(
      (error: unknown) => {
        if (!signal.aborted) throw error;
      },
    );
  }
}
