import { randomUUID } from 'node:crypto';
import {
  sameDEntryIdentity,
  type DEntryIdentity,
  type DEntryNativePrewarmStatus,
  type DEntryNativePrewarmTrigger,
  type DEntryNativePrewarmTicket,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import { PersonVmError, type PersonVmPrewarmTarget } from '@allrice/person-vm';
import { DEntryNativeUnavailable } from './native-owner.js';

export type PrewarmGeneration = PersonVmPrewarmTarget;
export type PrewarmPlan = {
  key: string;
  target: PrewarmGeneration;
  running?: boolean;
  upgradeRestart?: boolean;
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
    mode: 'authority' | 'operation' | 'ready',
  ): Promise<boolean>;
  prewarm(
    context: RequestContext,
    identity: DEntryIdentity,
    trigger: DEntryNativePrewarmTrigger,
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
    foreground: boolean;
    ticket: DEntryNativePrewarmTicket;
    expires: number;
    replies: number;
    published: boolean;
    state: DEntryNativePrewarmStatus;
    revoked: AbortSignal;
    proof?: AbortSignal;
    settled?: Promise<void>;
    closeJoin?: Promise<boolean>;
    release(): Promise<boolean>;
  };
  const tickets = new Map<string, Operation>();
  const pending = new Set<Promise<void>>();
  const lifetimeReleases = new Set<Promise<boolean>>();
  const active = (entry: Operation) =>
    entry.state.state === 'accepted' ||
    entry.state.state === 'starting' ||
    entry.state.state === 'restarting';
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
    accept(
      context: RequestContext,
      identity: DEntryIdentity,
      plan: PrewarmPlan,
      authority: { revoked: AbortSignal; close(): Promise<void> },
      start: (signal: AbortSignal) => Promise<AbortSignal | void>,
      trigger: DEntryNativePrewarmTrigger = 'page',
    ) {
      lifetime.throwIfAborted();
      authority.revoked.throwIfAborted();
      const foreground = trigger === 'open';
      const now = Date.now();
      for (const [id, entry] of tickets) {
        if (entry.expires <= now) {
          if (!active(entry)) {
            tickets.delete(id);
            void entry.release();
          }
        } else if (
          active(entry) &&
          !entry.revoked.aborted &&
          belongs(entry, context, identity) &&
          entry.plan.key === plan.key &&
          entry.plan.upgradeRestart === plan.upgradeRestart &&
          (!plan.upgradeRestart || entry.foreground === foreground) &&
          (!plan.target.restoreRetained || entry.plan.target.restoreRetained) &&
          compatiblePrewarmGeneration(entry.plan.target, plan.target)
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
      const signal = AbortSignal.any([
        lifetime,
        authority.revoked,
        AbortSignal.timeout(lifetimeMs),
      ]);
      const operation: Operation = {
        identity,
        sessionId: context.sessionId,
        plan,
        foreground,
        ticket,
        expires,
        replies: 0,
        published: false,
        state: { state: 'accepted' },
        revoked: authority.revoked,
        release() {
          if (operation.closeJoin) return operation.closeJoin;
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
          operation.state = {
            state:
              plan.upgradeRestart && foreground ? 'restarting' : 'starting',
          };
          operation.proof = (await start(signal)) || undefined;
          operation.proof?.throwIfAborted();
          signal.throwIfAborted();
        } catch (error) {
          failed = true;
          explicitOpenRequired =
            error instanceof PersonVmError &&
            error.code === 'UPGRADE_OPEN_REQUIRED';
        }
        if (!plan.assertTicketThread || failed || signal.aborted)
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
      return accepted(operation, true);
    },
    async read(
      operationId: string,
      context: RequestContext,
      identity: DEntryIdentity,
      signal: AbortSignal,
      verify: (plan: PrewarmPlan, ready: boolean) => Promise<boolean>,
    ): Promise<DEntryNativePrewarmStatus> {
      const entry = tickets.get(operationId);
      if (!entry || entry.expires <= Date.now()) return { state: 'expired' };
      if (!belongs(entry, context, identity))
        throw new DataAccessError('not_found');
      const state = entry.state;
      const ready = state.state === 'ready';
      if (
        !(await verify(entry.plan, ready)) ||
        (ready && entry.proof?.aborted) ||
        entry.expires <= Date.now()
      )
        return { state: 'expired' };
      if (state.state !== 'failed') {
        try {
          await entry.plan.assertTicketThread?.(signal);
        } catch (error) {
          signal.throwIfAborted();
          // A normal failure joins and closes its observer. A concurrent poll
          // can have captured 'starting' immediately before that close.
          if (
            !entry.revoked.aborted &&
            entry.closeJoin &&
            (entry.state.state === 'starting' ||
              entry.state.state === 'restarting' ||
              entry.state.state === 'failed') &&
            entry.expires > Date.now()
          )
            return entry.state;
          if (!entry.revoked.aborted && !(error instanceof DataAccessError))
            throw new DEntryNativeUnavailable();
          return { state: 'expired' };
        }
      }
      if (entry.expires <= Date.now() || (ready && entry.proof?.aborted))
        return { state: 'expired' };
      return entry.state.state === 'failed' ? entry.state : state;
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
