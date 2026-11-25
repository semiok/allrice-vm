import { setTimeout as wait } from 'node:timers/promises';
import {
  isDEntryNativeRunJournalCurrent,
  listDEntryNativeRunCandidates,
  publishDEntryNativeRunTerminal,
} from '@allrice/database';
import { PersonVmError } from '@allrice/person-vm';
import type { createAssignedNativeWebStartup } from '../native-web/composition.js';
import type { NativeWebOwner } from '../native-web/owner.js';
import { dEntryNativeRunJournalSelection } from './retained-native-run-reader.js';

/** Retry the durable ledger while the original native owner can attest the
 * terminal event from its process memory. */
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
        const { attempt, prompt } = candidate;
        if (
          prompt.adapterId !== owner.modelAdapterId ||
          attempt.profile !== owner.modelAdapterId ||
          attempt.nativeInstanceId !== owner.nativeInstanceId ||
          attempt.vmInstanceId !== scope.vmInstanceId ||
          attempt.leaseEpoch !== scope.leaseEpoch ||
          attempt.turn === null
        )
          continue;
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
    await wait(10_000, undefined, { signal, ref: false }).catch(
      (error: unknown) => {
        if (!signal.aborted) throw error;
      },
    );
  }
}
