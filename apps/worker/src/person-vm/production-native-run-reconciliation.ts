import { setTimeout as wait } from 'node:timers/promises';
import type { StoragePort } from '@allrice/contracts';
import { z } from 'zod';
import {
  isDEntryNativeRunJournalCurrent,
  assertDEntryNativeDeliveryRun,
  DEntryNativeDeliveryClaimSchema,
  DEntryNativeDeliveryCaptureSchema,
  publishCapturedDEntryDelivery,
  sweepDEntryNativeDeliveryReservations,
  type DEntryNativeRunJournalOwner,
  listDEntryNativeRunCandidates,
  publishDEntryNativeRunTerminal,
} from '@allrice/database';
import { PersonVmError } from '@allrice/person-vm';
import type { createAssignedNativeWebStartup } from '../native-web/composition.js';
import type { NativeWebOwner } from '../native-web/owner.js';
import { dEntryNativeRunJournalSelection } from './retained-native-run-reader.js';

const pendingDeliveries = z.array(DEntryNativeDeliveryClaimSchema).max(4);
async function reconcileDeliveries(
  owner: NativeWebOwner,
  scope: DEntryNativeRunJournalOwner,
  storage: StoragePort,
  signal: AbortSignal,
) {
  const offers = pendingDeliveries.parse(
    await owner.exchangeNativeDeliveryFor(
      { action: 'delivery-pending' },
      signal,
    ),
  );
  for (const offer of offers) {
    signal.throwIfAborted();
    try {
      const { candidates } = await listDEntryNativeRunCandidates(
        scope,
        undefined,
        64,
        offer,
      );
      const candidate = candidates
        .reverse()
        .find(
          ({ attempt, prompt }) =>
            attempt.nativeInstanceId === owner.nativeInstanceId &&
            attempt.profile === owner.modelAdapterId &&
            prompt.adapterId === owner.modelAdapterId &&
            attempt.sessionId === offer.sessionId &&
            attempt.turn === offer.turn &&
            attempt.leaseEpoch === scope.leaseEpoch &&
            attempt.vmInstanceId === scope.vmInstanceId,
        );
      if (!candidate) continue;
      const capture = DEntryNativeDeliveryCaptureSchema.parse(
        await owner.exchangeNativeDeliveryFor(
          { ...offer, action: 'delivery-read' },
          signal,
        ),
      );
      if (
        capture.ticket !== offer.ticket ||
        capture.sessionId !== offer.sessionId ||
        capture.turn !== offer.turn ||
        capture.callId !== offer.callId
      )
        continue;
      await publishCapturedDEntryDelivery(
        candidate,
        capture,
        storage,
        (tx) => assertDEntryNativeDeliveryRun(tx, candidate, scope, signal),
        signal,
      );
      await owner.exchangeNativeDeliveryFor(
        { ...offer, action: 'delivery-ack' },
        signal,
      );
    } catch {
      // A lost response or a transient write retries the original in-memory
      // offer. No persisted journal or fresh pathname can recreate it.
    }
  }
}

/** Retry the durable ledger while the original native owner can attest the
 * terminal event from its process memory. */
export async function reconcileNativeRunTerminals(
  startup: Pick<
    ReturnType<typeof createAssignedNativeWebStartup>,
    'runJournalOwners'
  >,
  signal: AbortSignal,
  storage?: StoragePort,
) {
  let nextSweep = 0;
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
      if (storage)
        await reconcileDeliveries(owner, scope, storage, active).catch(
          () => {},
        );
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
    if (storage && !signal.aborted && Date.now() >= nextSweep) {
      nextSweep = Date.now() + 60_000;
      await sweepDEntryNativeDeliveryReservations(storage, signal).catch(
        () => {},
      );
    }
    await wait(10_000, undefined, { signal, ref: false }).catch(
      (error: unknown) => {
        if (!signal.aborted) throw error;
      },
    );
  }
}
