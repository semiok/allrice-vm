import { randomUUID } from 'node:crypto';
import {
  sameDEntryIdentity,
  type DEntryIdentity,
  type DEntryNativePrewarmStatus,
  type DEntryNativePrewarmTrigger,
  type DEntryNativePrewarmTicket,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError, DEntryTicketObserverClosed } from '@allrice/database';
import {
  PersonVmError,
  type PersonVmBinding,
  type PersonVmPrewarmTarget,
} from '@allrice/person-vm';
import { DEntryNativeUnavailable } from './native-owner.js';

export type PrewarmGeneration = PersonVmPrewarmTarget;
export type PrewarmVerificationMode =
  | 'authority'
  | 'issue'
  | 'operation'
  | 'ready'
  | 'failed'
  | 'reuse'
  | 'waiting';
type PrewarmReadMode = Exclude<
  PrewarmVerificationMode,
  'authority' | 'issue' | 'reuse'
>;
type PrewarmReuseMode = PrewarmReadMode | 'issue' | 'reuse';
export type PrewarmReservation = { vmId?: string; instance?: PersonVmBinding };
export type ReportPrewarmCapacity = (activeLimit: number | undefined) => void;
export type PrewarmPlan = {
  key: string;
  target: PrewarmGeneration;
  running?: boolean;
  upgradeRestart?: boolean;
  /** In-process observations only. The HTTP response carries just the ticket. */
  orphanedInstanceId?: string;
  observeTerminalFailure?: true;
  reservation?: PrewarmReservation;
  reuse?: PrewarmPlan;
  assertTicketThread?(signal: AbortSignal): Promise<void>;
};

export function compatiblePrewarmGeneration(
  a: PrewarmGeneration,
  b: PrewarmGeneration,
) {
  return (
    a.leaseEpoch === b.leaseEpoch &&
    (!a.replacesVmId || !b.replacesVmId || a.replacesVmId === b.replacesVmId) &&
    (!a.vmId || !b.vmId || a.vmId === b.vmId) &&
    (!a.instanceId || !b.instanceId || a.instanceId === b.instanceId)
  );
}

export function canSharePrewarmTarget(
  existing: Pick<PrewarmPlan, 'target' | 'reservation'>,
  requested: PrewarmGeneration,
) {
  const target = observedPrewarmTarget(existing);
  return (
    (requested.instanceId === null ||
      (requested.vmId !== null &&
        target.vmId === requested.vmId &&
        target.instanceId === requested.instanceId)) &&
    (!requested.restoreRetained || target.restoreRetained === true) &&
    (target.replacesVmId === requested.replacesVmId ||
      (!requested.replacesVmId &&
        target.vmId !== null &&
        target.vmId === requested.vmId)) &&
    compatiblePrewarmGeneration(target, requested)
  );
}

/** An incomplete target gains specificity only from its own physical leases
 * or the exact local upgrade start it joined and revalidated. */
export function observedPrewarmTarget({
  target,
  reservation,
}: Pick<PrewarmPlan, 'target' | 'reservation'>): PrewarmGeneration {
  if (!reservation) return target;
  const instance = reservation.instance;
  if (instance) {
    if (!compatiblePrewarmGeneration(target, instance)) return target;
    return {
      ...target,
      vmId: instance.vmId,
      instanceId: instance.instanceId,
      leaseEpoch: instance.leaseEpoch,
    };
  }
  return {
    ...target,
    vmId: target.vmId ?? reservation.vmId ?? null,
  };
}

function readMode(status: DEntryNativePrewarmStatus): PrewarmReadMode {
  if (status.state === 'ready') return 'ready';
  if (status.state === 'failed') return 'failed';
  if (status.state === 'waiting_for_capacity') return 'waiting';
  return 'operation';
}

/** Trusted composition only. This port grants no catalog or execution access. */
export interface DEntryNativePrewarmPort {
  confirmRunning?(
    context: RequestContext,
    identity: DEntryIdentity,
    plan: PrewarmPlan,
    signal: AbortSignal,
  ): Promise<AbortSignal | undefined>;
  prepare?(
    context: RequestContext,
    identity: DEntryIdentity,
    signal: AbortSignal,
  ): Promise<PrewarmPlan>;
  isCurrent?(
    context: RequestContext,
    identity: DEntryIdentity,
    plan: PrewarmPlan,
    signal: AbortSignal,
    mode: PrewarmVerificationMode,
    /** A POST is about to publish its response, even if the original ticket is ready. */
    purpose?: 'publish',
  ): Promise<boolean>;
  prewarm(
    context: RequestContext,
    identity: DEntryIdentity,
    trigger: DEntryNativePrewarmTrigger,
    signal: AbortSignal,
    revoked: AbortSignal,
    plan?: PrewarmPlan,
    reportCapacity?: ReportPrewarmCapacity,
  ): Promise<AbortSignal | void>;
}

let installed: DEntryNativePrewarmPort | undefined;
export function installDEntryNativePrewarmPort(port: DEntryNativePrewarmPort) {
  if (installed) throw new DEntryNativeUnavailable();
  installed = port;
  return () => {
    if (installed === port) installed = undefined;
  };
}

export const dEntryNativePrewarmPort: DEntryNativePrewarmPort = {
  async confirmRunning(context, identity, plan, signal) {
    return installed?.confirmRunning?.(context, identity, plan, signal);
  },
  prepare(context, identity, signal) {
    if (!installed?.prepare) throw new DEntryNativeUnavailable();
    return installed.prepare(context, identity, signal);
  },
  isCurrent(context, identity, plan, signal, mode, purpose) {
    if (!installed?.isCurrent) throw new DEntryNativeUnavailable();
    return installed.isCurrent(context, identity, plan, signal, mode, purpose);
  },
  prewarm(context, identity, trigger, signal, revoked, plan, reportCapacity) {
    signal.throwIfAborted();
    if (!installed) throw new DEntryNativeUnavailable();
    return installed.prewarm(
      context,
      identity,
      trigger,
      signal,
      revoked,
      plan,
      reportCapacity,
    );
  },
};

export function createPrewarmOperations(
  lifetime: AbortSignal,
  cleanupFailed: (error: unknown) => void,
) {
  type Operation = {
    identity: DEntryIdentity;
    sessionId: string;
    plan: PrewarmPlan;
    foreground: boolean;
    preparedTarget: PrewarmGeneration;
    ticket: DEntryNativePrewarmTicket;
    expires: number;
    deadline: AbortSignal;
    cancellation: AbortController;
    cancellationFailed?: true;
    replies: number;
    published: boolean;
    state: DEntryNativePrewarmStatus;
    revoked: AbortSignal;
    proof?: AbortSignal;
    settled?: Promise<void>;
    closeJoin?: Promise<boolean>;
    closedOnDeadline?: true;
    release(cause?: 'expired'): Promise<boolean>;
  };
  const tickets = new Map<string, Operation>();
  const pending = new Set<Promise<void>>();
  const lifetimeReleases = new Set<Promise<boolean>>();
  const active = (entry: Operation) =>
    entry.state.state === 'accepted' ||
    entry.state.state === 'starting' ||
    entry.state.state === 'restarting' ||
    entry.state.state === 'waiting_for_capacity';
  const timedOut = (entry: Operation, now = Date.now()) =>
    entry.deadline.aborted || entry.expires <= now;
  const expired = (entry: Operation) =>
    entry.cancellation.signal.aborted || timedOut(entry);
  const belongs = (
    entry: Operation,
    context: RequestContext,
    identity: DEntryIdentity,
  ) =>
    entry.sessionId === context.sessionId &&
    sameDEntryIdentity(entry.identity, identity);
  function matchesPendingTarget(
    entry: Operation,
    plan: PrewarmPlan,
    canIssue: boolean,
  ) {
    const requested = plan.target;
    if (requested.instanceId !== null)
      return canIssue && canSharePrewarmTarget(entry.plan, requested);

    if (entry.plan.orphanedInstanceId !== plan.orphanedInstanceId) return false;
    const origin = entry.preparedTarget;
    if (plan.running || entry.plan.running || origin.instanceId !== null)
      return false;
    const sameOrigin =
      origin.vmId === requested.vmId &&
      origin.leaseEpoch === requested.leaseEpoch &&
      origin.replacesVmId === requested.replacesVmId &&
      origin.restoreRetained === requested.restoreRetained;
    // Orphan reuse separately verifies the exact predecessor and actual lease.
    if (plan.orphanedInstanceId !== undefined) return sameOrigin;

    const reservation = entry.plan.reservation;
    const started = reservation?.instance;
    if (!started)
      return (
        canIssue &&
        (sameOrigin ||
          (requested.vmId !== null &&
            reservation?.vmId === requested.vmId &&
            canSharePrewarmTarget({ target: origin, reservation }, requested)))
      );
    // A delayed cold request needs a start that consumed its original target.
    // A ticket issued against an already assigned instance only proves that instance.
    return (
      started.personId === entry.identity.personId &&
      started.organizationId === entry.identity.organizationId &&
      compatiblePrewarmGeneration(origin, started) &&
      (requested.vmId !== null || origin.vmId === null) &&
      canSharePrewarmTarget({ target: origin, reservation }, requested)
    );
  }
  function discardUnpublished(entry: Operation) {
    if (entry.published || entry.replies || active(entry)) return;
    tickets.delete(entry.ticket.operationId);
    void entry.release();
  }
  function accepted(entry: Operation) {
    entry.replies += 1;
    return {
      ticket: entry.ticket,
      settled: entry.settled,
      ready: () => entry.state.state === 'ready' && !entry.proof?.aborted,
      assertTicketThread: entry.plan.assertTicketThread,
      publish() {
        entry.published = true;
      },
      finishReply() {
        entry.replies -= 1;
        discardUnpublished(entry);
      },
    };
  }

  return {
    reuse(
      context: RequestContext,
      identity: DEntryIdentity,
      plan: PrewarmPlan,
      canIssue = false,
      trigger: DEntryNativePrewarmTrigger = 'page',
    ) {
      const prior = plan.reuse;
      let publishedInstance = false;
      const candidate = [...tickets.values()].find((entry) => {
        if (expired(entry) || entry.revoked.aborted) return false;
        if (
          entry.plan.upgradeRestart !== plan.upgradeRestart ||
          (plan.upgradeRestart && entry.foreground !== (trigger === 'open'))
        )
          return false;
        const observerOpen = !entry.plan.assertTicketThread || !entry.closeJoin;
        if (prior)
          return (
            observerOpen &&
            entry.plan === prior &&
            belongs(entry, context, identity)
          );
        if (
          observerOpen &&
          active(entry) &&
          belongs(entry, context, identity) &&
          entry.plan.key === plan.key &&
          matchesPendingTarget(entry, plan, canIssue)
        )
          return true;
        if (
          canIssue &&
          plan.target.instanceId === null &&
          entry.identity.personId === identity.personId &&
          entry.identity.organizationId === identity.organizationId
        ) {
          const known = observedPrewarmTarget(entry.plan);
          publishedInstance ||=
            known.instanceId !== null &&
            known.leaseEpoch >= plan.target.leaseEpoch;
        }
        return false;
      });
      if (!candidate) return { existing: undefined, publishedInstance };
      const entry = candidate;
      // If present, this POST's observer was installed before selection,
      // while the original observer was still open.
      const assertCurrentThread = plan.assertTicketThread;
      const mode = (): PrewarmReuseMode | undefined => {
        if (active(entry)) {
          if (entry.plan.orphanedInstanceId === undefined) return 'issue';
          return canIssue && !prior ? 'operation' : 'reuse';
        }
        if (entry.state.state === 'ready' && !entry.proof?.aborted)
          return 'ready';
        if (
          (prior || canIssue) &&
          entry.state.state === 'failed' &&
          entry.state.code === 'START_UNAVAILABLE'
        )
          return 'failed';
      };
      async function observeClosedThread(
        signal: AbortSignal,
        error: DEntryTicketObserverClosed,
      ) {
        entry.revoked.throwIfAborted();
        if (expired(entry) || entry.closedOnDeadline) return;
        // Only a known startup failure with a joined observer can defer to
        // this POST's observer. An in-progress or failed close has no proof.
        const closing = entry.closeJoin;
        if (
          !entry.published ||
          mode() !== 'failed' ||
          !assertCurrentThread ||
          !closing ||
          !(await closing)
        )
          throw error;
        signal.throwIfAborted();
        await assertCurrentThread(signal);
        return () => entry.closeJoin === closing && mode() === 'failed';
      }
      const existing = {
        ...accepted(entry),
        plan: entry.plan,
        async observeThread(signal: AbortSignal, preferCurrent = false) {
          const assertOriginalThread = entry.plan.assertTicketThread;
          if (!assertOriginalThread) return () => true;
          if (preferCurrent && assertCurrentThread) {
            if (!entry.closeJoin) await assertCurrentThread(signal);
            if (entry.closeJoin)
              return observeClosedThread(
                signal,
                new DEntryTicketObserverClosed(),
              );
            return () => !entry.closeJoin;
          }
          try {
            await assertOriginalThread(signal);
            return () => !entry.closeJoin;
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof DEntryTicketObserverClosed)) throw error;
            return observeClosedThread(signal, error);
          }
        },
        assertNotRevoked() {
          entry.revoked.throwIfAborted();
        },
        async recheck(
          context: RequestContext,
          identity: DEntryIdentity,
          verify: (mode: PrewarmReuseMode) => Promise<boolean>,
        ) {
          const live = () =>
            tickets.get(entry.ticket.operationId) === entry &&
            !expired(entry) &&
            !entry.revoked.aborted &&
            belongs(entry, context, identity) &&
            (!!prior || matchesPendingTarget(entry, plan, canIssue));
          const initial = mode();
          if (!initial || !live()) return;
          const verified = await verify(initial);
          const current = mode();
          // The original operation may settle while checking its live lease.
          // Verify that exact terminal state before writing an accepted reply.
          const valid =
            current === initial
              ? verified
              : current && live() && (await verify(current));
          if (valid) return () => live() && mode() === current;
        },
      };
      return { existing, publishedInstance };
    },
    accept(
      context: RequestContext,
      identity: DEntryIdentity,
      plan: PrewarmPlan,
      authority: { revoked: AbortSignal; close(): Promise<void> },
      start: (
        signal: AbortSignal,
        reportCapacity: ReportPrewarmCapacity,
      ) => Promise<AbortSignal | void>,
      trigger: DEntryNativePrewarmTrigger = 'page',
    ) {
      lifetime.throwIfAborted();
      authority.revoked.throwIfAborted();
      const foreground = trigger === 'open';
      const now = Date.now();
      for (const [id, entry] of tickets) {
        if (timedOut(entry, now)) {
          if (!active(entry)) {
            tickets.delete(id);
            void entry.release('expired');
          }
        }
      }
      if (pending.size >= 256) throw new DEntryNativeUnavailable();
      if (tickets.size >= 2048) {
        for (const [id, entry] of tickets) {
          if (active(entry) || entry.cancellationFailed) continue;
          tickets.delete(id);
          void entry.release();
          break;
        }
      }
      if (tickets.size >= 2048) throw new DEntryNativeUnavailable();
      const lifetimeMs = 10 * 60_000;
      const expires = now + lifetimeMs;
      const ticket = {
        operationId: randomUUID(),
        expiresAt: new Date(expires).toISOString(),
        pollAfterMs: 1000,
      };
      const deadline = AbortSignal.timeout(lifetimeMs);
      const cancellation = new AbortController();
      const signal = AbortSignal.any([
        lifetime,
        authority.revoked,
        deadline,
        cancellation.signal,
      ]);
      const operation: Operation = {
        identity,
        sessionId: context.sessionId,
        plan,
        foreground,
        preparedTarget: plan.target,
        ticket,
        expires,
        deadline,
        cancellation,
        replies: 0,
        published: false,
        state: { state: 'accepted' },
        revoked: authority.revoked,
        release(cause) {
          if (operation.closeJoin) return operation.closeJoin;
          if (
            cause === 'expired' ||
            (deadline.aborted && signal.reason === deadline.reason)
          )
            operation.closedOnDeadline = true;
          signal.removeEventListener('abort', releaseExpired);
          const closing = Promise.resolve()
            .then(() => authority.close())
            .then(
              () => true,
              (error) => {
                cleanupFailed(error);
                return false;
              },
            );
          operation.closeJoin = closing;
          lifetimeReleases.add(closing);
          void closing.then(() => lifetimeReleases.delete(closing));
          return closing;
        },
      };
      tickets.set(ticket.operationId, operation);
      function releaseExpired() {
        if (active(operation)) return; // the start owns cleanup until it joins
        void operation.release();
      }
      signal.addEventListener('abort', releaseExpired, { once: true });
      const task = Promise.resolve().then(async () => {
        let failed = false;
        let explicitOpenRequired = false;
        try {
          signal.throwIfAborted();
          const starting = {
            state:
              plan.upgradeRestart && foreground ? 'restarting' : 'starting',
          } as const;
          operation.state = starting;
          operation.proof =
            (await start(signal, (activeLimit) => {
              if (!signal.aborted && active(operation))
                operation.state =
                  activeLimit === undefined
                    ? starting
                    : { state: 'waiting_for_capacity', activeLimit };
            })) || undefined;
          operation.proof?.throwIfAborted();
          signal.throwIfAborted();
        } catch (error) {
          failed = true;
          explicitOpenRequired =
            error instanceof PersonVmError &&
            error.code === 'UPGRADE_OPEN_REQUIRED';
          if (
            cancellation.signal.aborted &&
            error !== cancellation.signal.reason
          )
            operation.cancellationFailed = true;
        }
        if (
          signal.aborted ||
          (!(failed && plan.observeTerminalFailure) &&
            (!plan.assertTicketThread || failed))
        ) {
          if (!(await operation.release())) {
            failed = true;
            if (cancellation.signal.aborted)
              operation.cancellationFailed = true;
          }
        }
        const reason: unknown = authority.revoked.reason;
        const denied =
          reason instanceof DataAccessError &&
          [
            'authentication_required',
            'authorization_denied',
            'not_found',
          ].includes(reason.code);
        operation.state =
          failed || signal.aborted || operation.proof?.aborted
            ? {
                state: 'failed',
                code: denied
                  ? 'AUTHORITY_REVOKED'
                  : explicitOpenRequired
                    ? 'UPGRADE_OPEN_REQUIRED'
                    : 'START_UNAVAILABLE',
              }
            : { state: 'ready' };
        discardUnpublished(operation);
      });
      pending.add(task);
      operation.settled = task;
      void task.then(() => pending.delete(task));
      return accepted(operation);
    },
    async read(
      operationId: string,
      context: RequestContext,
      identity: DEntryIdentity,
      signal: AbortSignal,
      verify: (plan: PrewarmPlan, mode: PrewarmReadMode) => Promise<boolean>,
    ): Promise<DEntryNativePrewarmStatus> {
      const entry = tickets.get(operationId);
      if (!entry || !belongs(entry, context, identity) || expired(entry))
        return { state: 'expired' };
      const state = entry.state;
      const ready = state.state === 'ready';
      const orphan = entry.plan.orphanedInstanceId !== undefined;
      const verifyRead = async (sample: DEntryNativePrewarmStatus) => {
        if (await verify(entry.plan, readMode(sample))) return sample;
        // A lifecycle lease temporarily hides the capacity reason. The
        // original operation may still be current and must not be expired.
        if (
          sample.state === 'waiting_for_capacity' &&
          (await verify(entry.plan, 'operation'))
        )
          return { state: 'starting' } as const;
      };
      const observed = await verifyRead(state);
      if (
        !observed ||
        ((orphan || state.state === 'waiting_for_capacity') &&
          entry.revoked.aborted) ||
        (ready && entry.proof?.aborted) ||
        expired(entry)
      )
        return { state: 'expired' };
      const watchThread =
        (state.state !== 'failed' || entry.plan.observeTerminalFailure) &&
        entry.plan.assertTicketThread;
      if (watchThread) {
        try {
          await watchThread(signal);
        } catch (error) {
          signal.throwIfAborted();
          // A normal failure joins and closes its observer. A concurrent poll
          // can have captured 'starting' immediately before that close.
          const closing = entry.state;
          if (
            !orphan &&
            !entry.revoked.aborted &&
            entry.closeJoin &&
            (active(entry) || closing.state === 'failed') &&
            !expired(entry)
          ) {
            const verified = await verifyRead(closing);
            return verified && !expired(entry)
              ? verified
              : { state: 'expired' };
          }
          if (!entry.revoked.aborted && !(error instanceof DataAccessError))
            throw new DEntryNativeUnavailable();
          return { state: 'expired' };
        }
      }
      // Deletion or an orphan release can advance while the thread guard joins.
      const latest = entry.state;
      const recheck = orphan || watchThread || latest !== state;
      const verified = recheck ? await verifyRead(latest) : observed;
      if (
        !verified ||
        expired(entry) ||
        ((orphan || latest.state === 'waiting_for_capacity') &&
          entry.revoked.aborted) ||
        ((ready || latest.state === 'ready') && entry.proof?.aborted)
      )
        return { state: 'expired' };
      if (latest.state === 'failed') return latest;
      if (
        state.state === 'waiting_for_capacity' ||
        latest.state === 'waiting_for_capacity'
      )
        return entry.state === latest ? verified : { state: 'starting' };
      return state;
    },
    async cancel(
      operationId: string,
      context: RequestContext,
      identity: DEntryIdentity,
      signal: AbortSignal,
      verify: (plan: PrewarmPlan, mode: PrewarmReadMode) => Promise<boolean>,
    ): Promise<DEntryNativePrewarmStatus> {
      const status = await this.read(
        operationId,
        context,
        identity,
        signal,
        verify,
      );
      signal.throwIfAborted();
      const entry = tickets.get(operationId);
      if (!entry || !belongs(entry, context, identity) || timedOut(entry))
        return { state: 'expired' };
      if (!entry.cancellation.signal.aborted) {
        if (status.state !== 'waiting_for_capacity') return status;
        if (expired(entry) || entry.revoked.aborted)
          return { state: 'expired' };
        if (entry.state.state !== 'waiting_for_capacity')
          return { state: 'starting' };
        entry.cancellation.abort();
      }
      await entry.settled;
      if (!(await entry.release()) || entry.cancellationFailed)
        throw new DEntryNativeUnavailable();
      return { state: 'expired' };
    },
    async close() {
      await Promise.allSettled(pending);
      await Promise.allSettled(
        [...tickets.values()].map((entry) => entry.release()),
      );
      await Promise.allSettled(lifetimeReleases);
      tickets.clear();
    },
  };
}
