import { setTimeout as wait } from 'node:timers/promises';
import {
  isDEntryNativeRunJournalCurrent,
  listDEntryNativeRunCandidates,
  publishDEntryNativeRunTerminal,
} from '@allrice/database';
import { PersonVmError } from '@allrice/person-vm';
import type { createAssignedNativeWebStartup } from '../native-web/composition.js';
import type { NativeWebOwner } from '../native-web/owner.js';

/** Passive projection for each authenticated local profile. The retry source
 * is the persisted Run + execution rows, with no dependency on model calls or
 * on the original prompt's request lifetime. */
export async function reconcileNativeRunTerminals(
  startup: Pick<
    ReturnType<typeof createAssignedNativeWebStartup>,
    'runJournalOwners'
  >,
  signal: AbortSignal,
) {
  const positions = new WeakMap<
    NativeWebOwner,
    Parameters<typeof listDEntryNativeRunCandidates>[1]
  >();
  while (!signal.aborted) {
    for (const location of startup.runJournalOwners()) {
      const { owner, endpoint, receipt } = location;
      const { binding } = receipt;
      const adapterId = owner.modelAdapterId;
      if (!adapterId || signal.aborted || location.revoked.aborted) continue;
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
        adapterId,
        nativeInstanceId: owner.nativeInstanceId,
      };
      const page = await listDEntryNativeRunCandidates(
        scope,
        positions.get(owner),
      ).catch(() => null);
      if (!page) continue;
      for (const candidate of page.candidates) {
        if (active.aborted) break;
        const { attempt, prompt } = candidate;
        try {
          const end = await owner.readPersistedRunTerminalFor(
            {
              sessionId: attempt.sessionId,
              nativeRequestId: prompt.nativeRequestId,
              purpose: attempt.kind,
              attemptId: attempt.attemptId,
              cursor: attempt.cursor,
              turn: attempt.turn,
            },
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
          if (end) await publishDEntryNativeRunTerminal(candidate, end, active);
        } catch {
          // Lost evidence, a busy owner or an uncertain SQL outcome all leave
          // the existing row discoverable on the next pass through this page.
        }
      }
      positions.set(owner, page.next);
    }
    await wait(10_000, undefined, { signal, ref: false }).catch(
      (error: unknown) => {
        if (!signal.aborted) throw error;
      },
    );
  }
}
