import { randomUUID } from 'node:crypto';
import {
  sameDEntryIdentity,
  type DEntryIdentity,
  type DEntryNativePrewarmStatus,
  type DEntryNativePrewarmTicket,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import { DEntryNativeUnavailable } from './native-owner.js';

export type PrewarmGeneration = {
  vmId: string | null;
  instanceId: string | null;
  leaseEpoch: number;
};
export type PrewarmPlan = {
  key: string;
  target: PrewarmGeneration;
  ready?: AbortSignal;
};

export function compatiblePrewarmGeneration(
  a: PrewarmGeneration,
  b: PrewarmGeneration,
) {
  return (
    a.leaseEpoch === b.leaseEpoch &&
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
  assertReady?(
    context: RequestContext,
    identity: DEntryIdentity,
    plan: PrewarmPlan,
    signal: AbortSignal,
  ): Promise<void>;
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
  assertReady(context, identity, plan, signal) {
    if (!installed?.assertReady) throw new DEntryNativeUnavailable();
    return installed.assertReady(context, identity, plan, signal);
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
    state: DEntryNativePrewarmStatus;
    proof?: AbortSignal;
  };
  const tickets = new Map<string, Operation>();
  const pending = new Set<Promise<void>>();
  const active = (entry: Operation) =>
    entry.state.state === 'accepted' || entry.state.state === 'starting';
  const belongs = (
    entry: Operation,
    context: RequestContext,
    identity: DEntryIdentity,
  ) =>
    entry.sessionId === context.sessionId &&
    sameDEntryIdentity(entry.identity, identity);

  return {
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
        if (entry.expires <= now) {
          if (!active(entry)) tickets.delete(id);
        } else if (
          active(entry) &&
          belongs(entry, context, identity) &&
          entry.plan.key === plan.key &&
          compatiblePrewarmGeneration(entry.plan.target, plan.target)
        ) {
          return { ticket: entry.ticket, owned: false };
        }
      }
      if (tickets.size >= 256) throw new DEntryNativeUnavailable();
      const lifetimeMs = 10 * 60_000;
      const expires = now + lifetimeMs;
      const ticket = {
        operationId: randomUUID(),
        expiresAt: new Date(expires).toISOString(),
        pollAfterMs: 1000,
      };
      const operation: Operation = {
        identity,
        sessionId: context.sessionId,
        plan,
        ticket,
        expires,
        state: { state: 'accepted' },
      };
      tickets.set(ticket.operationId, operation);
      const signal = AbortSignal.any([
        lifetime,
        authority.revoked,
        AbortSignal.timeout(lifetimeMs),
      ]);
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
        try {
          await authority.close();
        } catch (error) {
          cleanupFailed(error);
          failed = true;
        }
        operation.state =
          failed || signal.aborted || operation.proof?.aborted
            ? {
                state: 'failed',
                code:
                  authority.revoked.aborted && !lifetime.aborted
                    ? 'AUTHORITY_REVOKED'
                    : 'START_UNAVAILABLE',
              }
            : { state: 'ready' };
      });
      pending.add(task);
      void task.then(() => pending.delete(task));
      return { ticket, owned: true };
    },
    async read(
      operationId: string,
      context: RequestContext,
      identity: DEntryIdentity,
      verify: (plan: PrewarmPlan) => Promise<void>,
    ): Promise<DEntryNativePrewarmStatus> {
      const entry = tickets.get(operationId);
      if (!entry || entry.expires <= Date.now()) return { state: 'expired' };
      if (!belongs(entry, context, identity))
        throw new DataAccessError('not_found');
      if (entry.state.state !== 'ready') return entry.state;
      if (entry.proof?.aborted) return { state: 'expired' };
      await verify(entry.plan);
      if (entry.proof?.aborted || entry.expires <= Date.now())
        return { state: 'expired' };
      return entry.state;
    },
    async close() {
      await Promise.allSettled(pending);
      tickets.clear();
    },
  };
}
