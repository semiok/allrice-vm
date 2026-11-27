import { randomUUID } from 'node:crypto';
import {
  sameDEntryIdentity,
  type DEntryIdentity,
  type DEntryNativePrewarmStatus,
  type DEntryNativePrewarmTicket,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError, DEntryTicketObserverClosed } from '@allrice/database';
import type {
  PersonVmBinding,
  PersonVmPrewarmTarget,
} from '@allrice/person-vm';
import { DEntryNativeUnavailable } from './native-owner.js';

export type PrewarmGeneration = PersonVmPrewarmTarget;
export type PrewarmVerificationMode =
  'authority' | 'operation' | 'ready' | 'failed' | 'reuse';
type PrewarmReadMode = Exclude<PrewarmVerificationMode, 'authority' | 'reuse'>;
export type PrewarmReservation = { vmId?: string; instance?: PersonVmBinding };
export type PrewarmPlan = {
  key: string;
  target: PrewarmGeneration;
  running?: boolean;
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
    (!requested.restoreRetained || target.restoreRetained === true) &&
    (target.replacesVmId === requested.replacesVmId ||
      (!requested.replacesVmId &&
        target.vmId !== null &&
        target.vmId === requested.vmId)) &&
    compatiblePrewarmGeneration(target, requested)
  );
}

/** An incomplete target gains specificity only from its own physical leases. */
export function observedPrewarmTarget({
  target,
  reservation,
}: Pick<PrewarmPlan, 'target' | 'reservation'>): PrewarmGeneration {
  if (!reservation) return target;
  return {
    ...target,
    vmId: target.vmId ?? reservation.vmId ?? null,
    instanceId: target.instanceId ?? reservation.instance?.instanceId ?? null,
  };
}

function readMode(status: DEntryNativePrewarmStatus): PrewarmReadMode {
  if (status.state === 'ready') return 'ready';
  if (status.state === 'failed') return 'failed';
  return 'operation';
}

/** Trusted composition only. This port grants no catalog or execution access. */
export interface DEntryNativePrewarmPort {
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
  ): Promise<boolean>;
  prewarm(
    context: RequestContext,
    identity: DEntryIdentity,
    trigger: 'page' | 'input',
    signal: AbortSignal,
    revoked: AbortSignal,
    plan?: PrewarmPlan,
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
  prepare(context, identity, signal) {
    if (!installed?.prepare) throw new DEntryNativeUnavailable();
    return installed.prepare(context, identity, signal);
  },
  isCurrent(context, identity, plan, signal, mode) {
    if (!installed?.isCurrent) throw new DEntryNativeUnavailable();
    return installed.isCurrent(context, identity, plan, signal, mode);
  },
  prewarm(context, identity, trigger, signal, revoked, plan) {
    signal.throwIfAborted();
    if (!installed) throw new DEntryNativeUnavailable();
    return installed.prewarm(context, identity, trigger, signal, revoked, plan);
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
    ticket: DEntryNativePrewarmTicket;
    expires: number;
    deadline: AbortSignal;
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
    entry.state.state === 'accepted' || entry.state.state === 'starting';
  const expired = (entry: Operation, now = Date.now()) =>
    entry.deadline.aborted || entry.expires <= now;
  const belongs = (
    entry: Operation,
    context: RequestContext,
    identity: DEntryIdentity,
  ) =>
    entry.sessionId === context.sessionId &&
    sameDEntryIdentity(entry.identity, identity);
  function discardUnpublished(entry: Operation) {
    if (entry.published || entry.replies || active(entry)) return;
    tickets.delete(entry.ticket.operationId);
    void entry.release();
  }
  function accepted(entry: Operation, owned: boolean) {
    entry.replies += 1;
    return {
      ticket: entry.ticket,
      owned,
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
      prior: PrewarmPlan,
    ) {
      const entry = [...tickets.values()].find((entry) => entry.plan === prior);
      if (
        !entry ||
        expired(entry) ||
        entry.revoked.aborted ||
        !belongs(entry, context, identity)
      )
        return;
      const mode = ():
        Exclude<PrewarmVerificationMode, 'authority'> | undefined => {
        if (active(entry)) return 'reuse';
        if (entry.state.state === 'ready' && !entry.proof?.aborted)
          return 'ready';
        if (
          entry.state.state === 'failed' &&
          entry.state.code === 'START_UNAVAILABLE'
        )
          return 'failed';
      };
      return {
        ...accepted(entry, false),
        async observeThread(signal: AbortSignal) {
          try {
            await entry.plan.assertTicketThread?.(signal);
            return true;
          } catch (error) {
            signal.throwIfAborted();
            if (
              error instanceof DEntryTicketObserverClosed &&
              entry.closedOnDeadline
            ) {
              entry.revoked.throwIfAborted();
              return false;
            }
            throw error;
          }
        },
        assertNotRevoked() {
          entry.revoked.throwIfAborted();
        },
        async recheck(
          context: RequestContext,
          identity: DEntryIdentity,
          verify: (
            mode: Exclude<PrewarmVerificationMode, 'authority'>,
          ) => Promise<boolean>,
        ) {
          const live = () =>
            tickets.get(entry.ticket.operationId) === entry &&
            !expired(entry) &&
            !entry.revoked.aborted &&
            belongs(entry, context, identity);
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
    },
    accept(
      context: RequestContext,
      identity: DEntryIdentity,
      plan: PrewarmPlan,
      authority: { revoked: AbortSignal; close(): Promise<void> },
      start: (signal: AbortSignal) => Promise<AbortSignal | void>,
    ) {
      lifetime.throwIfAborted();
      authority.revoked.throwIfAborted();
      const now = Date.now();
      for (const [id, entry] of tickets) {
        if (expired(entry, now)) {
          if (!active(entry)) {
            tickets.delete(id);
            void entry.release('expired');
          }
        } else if (
          active(entry) &&
          !entry.revoked.aborted &&
          belongs(entry, context, identity) &&
          entry.plan.key === plan.key &&
          (!plan.orphanedInstanceId ||
            entry.plan.orphanedInstanceId === plan.orphanedInstanceId) &&
          canSharePrewarmTarget(entry.plan, plan.target)
        ) {
          return accepted(entry, false);
        }
      }
      if (pending.size >= 256) throw new DEntryNativeUnavailable();
      if (tickets.size >= 2048) {
        for (const [id, entry] of tickets) {
          if (active(entry)) continue;
          tickets.delete(id);
          void entry.release();
          break;
        }
      }
      const lifetimeMs = 10 * 60_000;
      const expires = now + lifetimeMs;
      const ticket = {
        operationId: randomUUID(),
        expiresAt: new Date(expires).toISOString(),
        pollAfterMs: 1000,
      };
      const deadline = AbortSignal.timeout(lifetimeMs);
      const signal = AbortSignal.any([lifetime, authority.revoked, deadline]);
      const operation: Operation = {
        identity,
        sessionId: context.sessionId,
        plan,
        ticket,
        expires,
        deadline,
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
        try {
          signal.throwIfAborted();
          operation.state = { state: 'starting' };
          operation.proof = (await start(signal)) || undefined;
          operation.proof?.throwIfAborted();
          signal.throwIfAborted();
        } catch {
          failed = true;
        }
        if (
          signal.aborted ||
          (!(failed && plan.observeTerminalFailure) &&
            (!plan.assertTicketThread || failed))
        )
          failed = !(await operation.release()) || failed;
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
                code: denied ? 'AUTHORITY_REVOKED' : 'START_UNAVAILABLE',
              }
            : { state: 'ready' };
        discardUnpublished(operation);
      });
      pending.add(task);
      operation.settled = task;
      void task.then(() => pending.delete(task));
      return accepted(operation, true);
    },
    async read(
      operationId: string,
      context: RequestContext,
      identity: DEntryIdentity,
      signal: AbortSignal,
      verify: (plan: PrewarmPlan, mode: PrewarmReadMode) => Promise<boolean>,
    ): Promise<DEntryNativePrewarmStatus> {
      const entry = tickets.get(operationId);
      if (!entry || expired(entry)) return { state: 'expired' };
      if (!belongs(entry, context, identity))
        throw new DataAccessError('not_found');
      const state = entry.state;
      const ready = state.state === 'ready';
      const orphan = entry.plan.orphanedInstanceId !== undefined;
      if (
        !(await verify(entry.plan, readMode(state))) ||
        (orphan && entry.revoked.aborted) ||
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
            (closing.state === 'starting' || closing.state === 'failed') &&
            !expired(entry)
          ) {
            if (
              !(await verify(entry.plan, readMode(closing))) ||
              expired(entry)
            )
              return { state: 'expired' };
            return closing;
          }
          if (!entry.revoked.aborted && !(error instanceof DataAccessError))
            throw new DEntryNativeUnavailable();
          return { state: 'expired' };
        }
      }
      // Deletion or an orphan release can advance while the thread guard joins.
      const latest = entry.state;
      const recheck = orphan || watchThread || latest !== state;
      if (
        (recheck && !(await verify(entry.plan, readMode(latest)))) ||
        expired(entry) ||
        (orphan && entry.revoked.aborted) ||
        (ready && entry.proof?.aborted)
      )
        return { state: 'expired' };
      return latest.state === 'failed' ? latest : state;
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
