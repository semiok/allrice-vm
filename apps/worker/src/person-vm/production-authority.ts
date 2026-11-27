import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DEntryIdentitySchema,
  RequestContextSchema,
  sameDEntryIdentity,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import {
  DataAccessError,
  requireCurrentPlatformAdmin,
  readContentPrincipal,
  readPersonVmWakeRoster,
  withOwnedPersonVmAuthorityTransaction,
  getDatabase,
  requireDEntryNativeIdentity,
} from '@allrice/database';
import {
  PersonVmError,
  type PersonVmAction,
  type PersonVmAuthority,
  type PersonVmBinding,
} from '@allrice/person-vm';

export async function authorizeProductionPersonVmDeletion(
  context: RequestContext,
  signal: AbortSignal,
  sql?: ReturnType<typeof getDatabase>,
) {
  signal.throwIfAborted();
  try {
    await requireCurrentPlatformAdmin(context, sql, Boolean(sql));
  } catch (error) {
    if (error instanceof DataAccessError)
      throw new PersonVmError('AUTHORIZATION_DENIED', { cause: error });
    throw error;
  }
  signal.throwIfAborted();
}

type Operation = {
  context: RequestContext;
  expected: DEntryIdentity;
  signal: AbortSignal;
  active: boolean;
  pending: Set<Promise<unknown>>;
};
function denied(): never {
  throw new PersonVmError('AUTHORIZATION_DENIED');
}
function user(context: RequestContext) {
  const parsed = RequestContextSchema.parse(context);
  if (parsed.actor.type !== 'user') denied();
  return parsed;
}

/** Current database reads only. The private operation carries a selector and
 * expected identity, never a reusable permit or a writer transaction fence. */
export function createProductionPersonVmAuthority(lifetime?: AbortSignal) {
  const operations = new AsyncLocalStorage<Operation>();
  const stopped = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const active = (signal: AbortSignal, operation?: Operation) =>
    AbortSignal.any([
      stopped.signal,
      signal,
      ...(lifetime ? [lifetime] : []),
      ...(operation ? [operation.signal] : []),
    ]);
  function own<T>(work: () => Promise<T>, operation?: Operation) {
    const task = Promise.resolve().then(work);
    pending.add(task);
    operation?.pending.add(task);
    const settled = () => {
      pending.delete(task);
      operation?.pending.delete(task);
    };
    void task.then(settled, settled);
    return task;
  }
  function guard(operation: Operation, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!operation.active) denied();
  }
  async function current(operation: Operation, signal: AbortSignal) {
    guard(operation, signal);
    const { expected, context } = operation;
    const identity = await requireDEntryNativeIdentity(context, {
      workspaceId: expected.workspaceId,
      employeeInstanceId: expected.employeeInstanceId,
      ...(expected.threadId ? { threadId: expected.threadId } : {}),
    });
    guard(operation, signal);
    if (!sameDEntryIdentity(identity, expected)) denied();
    // The original gate awaits rollout policy. Re-read the original current
    // principal afterward; old RC memberships cannot survive that async gap.
    const principal = await readContentPrincipal({
      ...context,
      workspaceId: expected.workspaceId,
    });
    guard(operation, signal);
    if (
      !principal ||
      !principal.writable ||
      principal.userId !== expected.personId ||
      principal.organizationId !== expected.organizationId
    )
      denied();
    return {
      personId: principal.userId,
      organizationId: principal.organizationId,
    };
  }
  const authority: PersonVmAuthority = Object.freeze({
    authorize(
      context: RequestContext,
      action: PersonVmAction,
      signal: AbortSignal,
    ) {
      const operation = operations.getStore();
      return own(async () => {
        const stop = active(signal, operation);
        stop.throwIfAborted();
        if (operation) guard(operation, stop);
        const scope = user(context);
        if (action === 'read') {
          const principal = await readContentPrincipal(scope);
          stop.throwIfAborted();
          if (operation) guard(operation, stop);
          if (
            !principal ||
            principal.userId !== scope.actor.id ||
            principal.organizationId !== scope.organizationId
          )
            denied();
          return {
            personId: principal.userId,
            organizationId: principal.organizationId,
          };
        }
        // No new public stop/delete permission. Existing internal owner cleanup
        // does not obtain authority by pretending to be a read/start request.
        if (action !== 'create' && action !== 'start') denied();
        if (
          !operation ||
          !operation.active ||
          operation.context.sessionId !== scope.sessionId ||
          operation.context.actor.id !== scope.actor.id ||
          operation.context.organizationId !== scope.organizationId ||
          operation.context.workspaceId !== scope.workspaceId
        )
          denied();
        return current(operation, stop);
      }, operation);
    },
  });
  return Object.freeze({
    authority,
    withCurrentSelection<T>(
      context: RequestContext,
      expected: DEntryIdentity,
      signal: AbortSignal,
      work: () => Promise<T>,
    ): Promise<T> {
      return own(async () => {
        const scope = user(context);
        const identity = DEntryIdentitySchema.parse(expected);
        if (
          identity.personId !== scope.actor.id ||
          identity.organizationId !== scope.organizationId ||
          (scope.workspaceId !== null &&
            scope.workspaceId !== identity.workspaceId)
        )
          denied();
        const operation: Operation = {
          context: scope,
          expected: Object.freeze(identity),
          signal: active(signal),
          active: true,
          pending: new Set(),
        };
        return operations.run(operation, async () => {
          let result: T;
          try {
            await current(operation, operation.signal);
            result = await work();
            await current(operation, operation.signal);
          } finally {
            operation.active = false;
            // Detached descendants keep the closed scope and cannot authorize.
            // Already started SQL still joins before the operation leaves.
            await Promise.allSettled([...operation.pending]);
          }
          operation.signal.throwIfAborted();
          return result;
        });
      });
    },
    dispatchUpgradeStop(
      context: RequestContext,
      expected: DEntryIdentity,
      binding: PersonVmBinding,
      signal: AbortSignal,
      assertTicket: (signal: AbortSignal) => Promise<void>,
      dispatch: () => Promise<void>,
    ) {
      const operation = operations.getStore();
      return own(async () => {
        const checking = active(signal, operation);
        if (
          !operation ||
          !sameDEntryIdentity(operation.expected, expected) ||
          operation.context.sessionId !== context.sessionId ||
          context.actor.type !== 'user' ||
          context.actor.id !== binding.personId ||
          expected.personId !== binding.personId ||
          expected.organizationId !== binding.organizationId
        )
          denied();
        guard(operation, checking);
        await withOwnedPersonVmAuthorityTransaction(
          getDatabase(),
          'isolation level read committed',
          checking,
          async (tx, locked) => {
            await tx`set local statement_timeout = '3000ms'`;
            const roster = await readPersonVmWakeRoster(
              tx,
              binding,
              [expected],
              true,
            );
            if (!roster) denied();
            const [session] = await tx`select s.id from allrice_sessions s
              where s.id=${context.sessionId} and s.user_id=${binding.personId}
                and s.revoked_at is null and s.expires_at > clock_timestamp()
              for share of s nowait`;
            if (!session) denied();
            if (expected.threadId) {
              const [thread] = await tx`select t.id from allrice_chat_sessions t
                where t.id=${expected.threadId} and t.workspace_id=${expected.workspaceId}
                  and t.organization_id=${binding.organizationId} and t.owner_id=${binding.personId}
                  and t.execution_generation='4.0' and t.archived_at is null
                  and coalesce(t.employee_instance_id,t.employee_assignment_id)=${expected.employeeInstanceId}
                for share of t nowait`;
              if (!thread) denied();
            }
            await tx`select m.id from allrice_memberships m
              where m.user_id=${binding.personId} and m.organization_id=${binding.organizationId}
                and m.active and m.role in ('admin','member')
                and (m.workspace_id is null or m.workspace_id=${expected.workspaceId})
              order by m.id for share of m nowait`;
            await assertTicket(locked);
            guard(operation, locked);
            // The authorization connection orders revocation against dispatch.
            // The native command has its own physical lease and bounded join.
            await dispatch();
          },
        );
      }, operation);
    },
    close() {
      if (closing) return closing;
      stopped.abort(new PersonVmError('RUNTIME_NOT_READY'));
      closing = Promise.allSettled([...pending]).then(() => {});
      return closing;
    },
  });
}
