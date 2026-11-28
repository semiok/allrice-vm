import type { PersonVmBinding } from '@allrice/person-vm';
import { sameVmBinding } from '@allrice/person-vm';
import type {
  createPostgresPersonVmScheduledWakeStore,
  createPostgresNativeScheduleObservationLedger,
  NativeScheduleLedgerOrigin,
  ScheduledWakeClaim,
} from '@allrice/database';
import { PERSON_VM_WAKE_CLAIM_MS } from '@allrice/database';
import {
  readNativeScheduleObservations,
  type NativeScheduleObservationBatch,
} from '../native-schedule-observation.js';

type Ledger = ReturnType<typeof createPostgresNativeScheduleObservationLedger>;
type WakeStore = ReturnType<typeof createPostgresPersonVmScheduledWakeStore>;
type NativeCatalog = Parameters<typeof readNativeScheduleObservations>[0];

type Profile = {
  origin: NativeScheduleLedgerOrigin;
  receiptId: string;
  schedule: NativeCatalog;
};
type Capture = {
  profiles: readonly Profile[];
  /** Rechecks the complete roster and current authenticated native owners.
   * The stop coordinator still owns the final exclusion of concurrent writes. */
  assertCurrent(signal: AbortSignal): Promise<void>;
  /** The production owner verifies captured work can actually be delivered. */
  assertDeliverable?(
    batches: readonly NativeScheduleObservationBatch[],
    signal: AbortSignal,
  ): Promise<void>;
  confirmObservations?(
    batches: readonly NativeScheduleObservationBatch[],
    signal: AbortSignal,
  ): Promise<void>;
};
type StartResult = 'ready' | 'not-started' | 'denied' | 'stale' | 'unknown';
type Options = {
  ledger: Pick<Ledger, 'commitBatch'>;
  store: WakeStore;
  leadMs?: number;
  now?: () => Date;
  /** Owner must supply ALL profiles for this binding, even those with no rules.
   * Derive every receipt ID from this attempt or retain its original IDs.
   * Reject incomplete or unauthenticated scope, never synthesize an empty list. */
  capture(
    binding: PersonVmBinding,
    planId: string,
    signal: AbortSignal,
  ): Promise<Capture>;
  /** Authorize again using current durable eligibility and then use the
   * original start/bootstrap under its physical lease. Check assertClaim
   * and the exact stopped binding inside that lease before any effect.
   * Only report not-started with positive evidence that no start took effect
   * and that the original stopped generation still owns the retained disk. */
  start(
    claim: ScheduledWakeClaim,
    assertClaim: () => Promise<boolean>,
    signal: AbortSignal,
  ): Promise<StartResult>;
};
export type PrepareStopWithWakeResult =
  | { ok: true; nextWakeAt: string | null }
  | {
      blocked: true;
      reason:
        | 'SCHEDULE_OBSERVATION_UNAVAILABLE'
        | 'SCHEDULE_WAKE_UNAVAILABLE'
        | 'SCHEDULE_TOO_CLOSE'
        | 'WAKE_PLAN_UNCONFIRMED';
    };

const retryDelayMs = [10_000, 30_000, 60_000] as const;
export const DEFAULT_SCHEDULE_WAKE_LEAD_MS = 120_000;

export function earliestNativeScheduleTarget(
  batches: readonly NativeScheduleObservationBatch[],
) {
  let target: number | null = null;
  for (const { items } of batches) {
    for (const item of items) {
      if (item.status !== 'active') continue;
      const time = Date.parse(item.scheduledAt);
      if (!Number.isFinite(time)) throw new Error('SCHEDULE_TARGET_INVALID');
      if (target === null || time < target) target = time;
    }
  }
  return target;
}

export function createPersonVmScheduledWake(input: Options) {
  const now = input.now ?? (() => new Date());
  const leadMs = input.leadMs ?? DEFAULT_SCHEDULE_WAKE_LEAD_MS;
  if (!Number.isSafeInteger(leadMs) || leadMs < 0)
    throw new RangeError('SCHEDULE_WAKE_LEAD_INVALID');

  return {
    /** A durable wake handoff only. The caller holds the ordinary lifecycle
     * lease across preparation and physical stop, keeps the native observation
     * current, and uses the same attempt ID for the successful stop audit. */
    async prepareStopWithWake(
      binding: PersonVmBinding,
      planId: string,
      signal: AbortSignal,
    ): Promise<PrepareStopWithWakeResult> {
      signal.throwIfAborted();
      let reason: Extract<
        PrepareStopWithWakeResult,
        { blocked: true }
      >['reason'] = 'WAKE_PLAN_UNCONFIRMED';
      try {
        reason = 'SCHEDULE_OBSERVATION_UNAVAILABLE';
        const captured = await input.capture(binding, planId, signal);
        const profiles = captured.profiles;
        if (
          profiles.length === 0 ||
          new Set(profiles.map(({ origin }) => origin.employeeInstanceId))
            .size !== profiles.length ||
          new Set(profiles.map(({ receiptId }) => receiptId)).size !==
            profiles.length ||
          profiles.some(({ origin }) => !sameVmBinding(binding, origin))
        )
          return { blocked: true, reason };

        // allSettled joins all native reads, even if an earlier one rejects.
        const reads = await Promise.allSettled(
          profiles.map(({ schedule }) =>
            readNativeScheduleObservations(schedule, signal),
          ),
        );
        const batches = reads.map((read) => {
          if (read.status === 'rejected') throw read.reason;
          return read.value;
        });
        await captured.assertCurrent(signal);
        signal.throwIfAborted();
        const target = earliestNativeScheduleTarget(batches);
        const wakeAt = target === null ? null : new Date(target - leadMs);
        const canWait = () =>
          wakeAt === null || wakeAt.getTime() > now().getTime();
        if (!canWait()) return { blocked: true, reason: 'SCHEDULE_TOO_CLOSE' };
        if (wakeAt !== null && captured.assertDeliverable) {
          reason = 'SCHEDULE_WAKE_UNAVAILABLE';
          await captured.assertDeliverable(batches, signal);
          signal.throwIfAborted();
        }

        reason = 'WAKE_PLAN_UNCONFIRMED';
        for (const [index, { origin, receiptId }] of profiles.entries()) {
          await input.ledger.commitBatch(
            {
              kind: 'snapshot',
              receiptId,
              origin,
              batch: batches[index]!,
              invalidateReceiptIds: [],
            },
            signal,
          );
        }
        await captured.assertCurrent(signal);
        signal.throwIfAborted();
        if (!canWait()) return { blocked: true, reason: 'SCHEDULE_TOO_CLOSE' };
        const staged = await input.store.stage({
          ...binding,
          planId,
          receiptIds: profiles.map(({ receiptId }) => receiptId).sort(),
          targetAt: target === null ? null : new Date(target),
          wakeAt,
        });
        signal.throwIfAborted();
        if (!staged) return { blocked: true, reason };
        await captured.assertCurrent(signal);
        signal.throwIfAborted();
        if (wakeAt !== null && captured.assertDeliverable) {
          reason = 'SCHEDULE_WAKE_UNAVAILABLE';
          await captured.assertDeliverable(batches, signal);
          signal.throwIfAborted();
        }
        if (captured.confirmObservations) {
          reason = 'SCHEDULE_OBSERVATION_UNAVAILABLE';
          await captured.confirmObservations(batches, signal);
          signal.throwIfAborted();
        }
        if (!canWait()) return { blocked: true, reason: 'SCHEDULE_TOO_CLOSE' };
        return { ok: true, nextWakeAt: wakeAt?.toISOString() ?? null };
      } catch (error) {
        if (signal.aborted) throw error;
        return { blocked: true, reason };
      }
    },

    /** A bounded tick for the host's existing scheduler. The caller owns the
     * interval, shutdown join, and monitoring of rejection/failure audit. */
    async runDueOnce(signal: AbortSignal): Promise<boolean> {
      signal.throwIfAborted();
      const claim = await input.store.claim(PERSON_VM_WAKE_CLAIM_MS);
      if (!claim)
        return signal.aborted
          ? false
          : input.store.recordExpiredUnrecoverableClaim();
      const current = () => input.store.isCurrent(claim);
      let eligible: boolean;
      try {
        eligible = !signal.aborted && (await current());
      } catch (error) {
        try {
          await input.store.releaseUnusedClaim(claim);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'SCHEDULE_WAKE_CLAIM_RELEASE_FAILED',
            { cause: error },
          );
        }
        throw error;
      }
      if (signal.aborted) return input.store.releaseUnusedClaim(claim);
      let result: StartResult = 'stale';
      if (eligible) {
        try {
          result = await input.start(claim, current, signal);
        } catch {
          result = 'unknown';
        }
      }
      if (result === 'ready') {
        await input.store.settle(claim, { state: 'ready' });
      } else if (result === 'not-started') {
        const delay = retryDelayMs[claim.attempts - 1];
        await input.store.settle(
          claim,
          delay === undefined
            ? { state: 'blocked', reason: 'RETRY_LIMIT' }
            : {
                state: 'waiting',
                reason: 'START_UNAVAILABLE',
                retryDelayMs: delay,
              },
        );
      } else if (result === 'denied' || result === 'stale') {
        await input.store.settle(claim, {
          state: 'blocked',
          reason:
            result === 'denied' ? 'CURRENT_AUTHORITY_DENIED' : 'STALE_PLAN',
        });
      } else {
        await input.store.settle(claim, {
          state: 'unknown',
          reason: 'START_UNCONFIRMED',
        });
      }
      return true;
    },
  };
}
