import { setTimeout as wait } from 'node:timers/promises';
import type { StoragePort } from '@allrice/contracts';
import { z } from 'zod';
import {
  isDEntryNativeRunJournalCurrent,
  assertDEntryNativeDeliveryRun,
  createDedicatedDatabase,
  getDatabase,
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

type NativeOwners = Pick<
  ReturnType<typeof createAssignedNativeWebStartup>,
  'runJournalOwners'
>;
function ownerScope(
  location: ReturnType<NativeOwners['runJournalOwners']>[number],
) {
  const { binding } = location.receipt;
  return {
    organizationId: binding.organizationId,
    workspaceId: location.endpoint.workspaceId,
    personId: binding.personId,
    vmId: binding.vmId,
    vmInstanceId: binding.instanceId,
    leaseEpoch: binding.leaseEpoch,
    employeeInstanceId: location.endpoint.employeeInstanceId,
    employeeRelease: location.endpoint.employeeVersionId,
  };
}

const pendingDeliveries = z.array(DEntryNativeDeliveryClaimSchema).max(4);
async function reconcileDeliveries(
  owner: NativeWebOwner,
  scope: DEntryNativeRunJournalOwner,
  storage: StoragePort,
  signal: AbortSignal,
  sql: ReturnType<typeof getDatabase>,
) {
  const offers = pendingDeliveries.parse(
    await owner.exchangeNativeDeliveryFor(
      { action: 'delivery-pending' },
      signal,
    ),
  );
  for (const offer of offers) {
    signal.throwIfAborted();
    const active = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
    try {
      const { candidates } = await listDEntryNativeRunCandidates(
        scope,
        undefined,
        64,
        offer,
        sql,
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
            attempt.cursor === offer.cursor &&
            attempt.attemptId === offer.attemptId &&
            attempt.leaseEpoch === scope.leaseEpoch &&
            attempt.vmInstanceId === scope.vmInstanceId,
        );
      if (!candidate) continue;
      const capture = await sql.begin(async (tx) => {
        await assertDEntryNativeDeliveryRun(tx, candidate, scope, active);
        const result = await owner.exchangeNativeDeliveryFor(
          { ...offer, action: 'delivery-read' },
          active,
        );
        active.throwIfAborted();
        return DEntryNativeDeliveryCaptureSchema.parse(result);
      });
      if (
        capture.ticket !== offer.ticket ||
        capture.sessionId !== offer.sessionId ||
        capture.turn !== offer.turn ||
        capture.callId !== offer.callId ||
        capture.callSequence !== offer.callSequence ||
        capture.cursor !== offer.cursor ||
        capture.attemptId !== offer.attemptId
      )
        continue;
      await publishCapturedDEntryDelivery(
        candidate,
        capture,
        storage,
        async (tx) => {
          await assertDEntryNativeDeliveryRun(tx, candidate, scope, active);
          if (
            (await owner.exchangeNativeDeliveryFor(
              { ...offer, action: 'delivery-live' },
              active,
            )) !== true
          )
            throw new PersonVmError('LEASE_LOST');
        },
        active,
        sql,
      );
      await owner.exchangeNativeDeliveryFor(
        { ...offer, action: 'delivery-ack' },
        active,
      );
    } catch {
      // A lost response or a transient write retries the original in-memory
      // offer. No persisted journal or fresh pathname can recreate it.
    }
  }
}

/** Delivery traffic has its own short poll and one in-flight request per
 * owner. A slow terminal scan or a busy peer cannot hold another owner. */
export async function reconcileNativeDeliveries(
  startup: NativeOwners,
  storage: StoragePort,
  signal: AbortSignal,
) {
  if (signal.aborted) return;
  const sql = createDedicatedDatabase(getDatabase(), {
    max: 4,
    lockTimeoutMs: 2_000,
    statementTimeoutMs: 5_000,
  });
  let closed: Promise<void> | undefined;
  const close = () => {
    closed ??= sql.end({ timeout: 1 });
    void closed.catch(() => {});
  };
  signal.addEventListener('abort', close, { once: true });
  const active = new Map<NativeWebOwner, Promise<void>>();
  let sweeping: Promise<void> | undefined;
  let nextSweep = 0;
  try {
    while (!signal.aborted) {
      for (const location of startup.runJournalOwners()) {
        const { owner, revoked } = location;
        if (!owner.modelAdapterId || revoked.aborted || active.has(owner))
          continue;
        const current = AbortSignal.any([signal, revoked]);
        active.set(
          owner,
          reconcileDeliveries(
            owner,
            ownerScope(location),
            storage,
            current,
            sql,
          )
            .catch(() => {})
            .finally(() => active.delete(owner)),
        );
      }
      if (!sweeping && Date.now() >= nextSweep) {
        nextSweep = Date.now() + 60_000;
        sweeping = sweepDEntryNativeDeliveryReservations(storage, signal, sql)
          .catch(() => {})
          .finally(() => {
            sweeping = undefined;
          });
      }
      await wait(2_000, undefined, { signal, ref: false });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener('abort', close);
    close();
    await Promise.allSettled([...active.values(), sweeping, closed]);
  }
}

/** Retry the durable ledger while the original native owner can attest the
 * terminal event from its process memory. */
export async function reconcileNativeRunTerminals(
  startup: NativeOwners,
  signal: AbortSignal,
) {
  const positions = new WeakMap<
    NativeWebOwner,
    Parameters<typeof listDEntryNativeRunCandidates>[1]
  >();
  while (!signal.aborted) {
    const local = startup.runJournalOwners();
    for (const location of local) {
      const { owner } = location;
      if (!owner.modelAdapterId || signal.aborted || location.revoked.aborted)
        continue;
      const active = AbortSignal.any([signal, location.revoked]);
      const scope = ownerScope(location);
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
