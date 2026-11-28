import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import {
  DEntrySessionActivitySchema,
  type DEntrySessionChangeRequestSchema,
  type DEntrySessionChangeResultSchema,
} from '@allrice/contracts';
import {
  authorizeSessionHistoryOwner,
  DataAccessError,
  EmployeeInstanceError,
  requireDEntrySessionChangeRoot,
  runDEntryAdmittedActivity,
  syncDEntryNativeRootArchive,
  syncDEntryNativeRootTitle,
} from '@allrice/database';
import { PersonVmError } from '@allrice/person-vm';
import type { DEntryHttpDependencies } from './http.js';
import {
  DEntryNativeUnavailable,
  currentDEntryNativeOwner,
  sameDEntryVmBinding,
} from './native-owner.js';
import { observeDEntryFinish, ownDEntryCatalog } from './native-data.js';

const archiveValue = z.object({ archivedSessionIds: z.array(z.string()) });
const archiveBaseline = z.object({
  type: z.literal('baseline'),
  value: archiveValue,
});
const activeFailure = z.object({
  code: z.literal('workspace/session-active'),
  details: z.object({ activity: z.array(DEntrySessionActivitySchema).min(1) }),
});
const denied = () => new DataAccessError('authorization_denied');

/** A standalone action owns the target employee's verified Host. In
 * particular, the open sidebar's page/transport grants no rights to a sibling. */
export async function changeDEntrySession(
  deps: DEntryHttpDependencies,
  token: string,
  input: z.infer<typeof DEntrySessionChangeRequestSchema>,
  caller: AbortSignal,
  cleanupFailed: (error: unknown) => void,
): Promise<z.infer<typeof DEntrySessionChangeResultSchema>> {
  const { threadId, ...selection } = input.selection;
  const { change } = input;
  const context = await deps.authenticate(token, {
    organizationId: input.organizationId,
    workspaceId: selection.workspaceId,
  });
  if (!context) throw new DataAccessError('authentication_required');
  const scope = { ...context, workspaceId: selection.workspaceId };
  const session = () =>
    authorizeSessionHistoryOwner(scope, selection.workspaceId, threadId);
  let root;
  try {
    root = await requireDEntrySessionChangeRoot(scope, input.selection);
  } catch (error) {
    if (
      error instanceof EmployeeInstanceError &&
      error.code === 'instance_archived'
    ) {
      const target = await session();
      if (target.employeeInstanceId !== selection.employeeInstanceId)
        throw denied();
      return { state: 'employee_archived' };
    }
    throw error;
  }
  if ('title' in change && (await session()).archivedAt) throw denied();
  const expected = root;
  const identity = { ...root.identity, threadId: null };
  const authority = await deps.watch(scope, selection, identity, caller);
  let requestFailed = false;
  let requestError: unknown;
  try {
    const signal = AbortSignal.any([caller, authority.revoked]);
    const assertRoot = async (active: AbortSignal) => {
      active.throwIfAborted();
      const fresh = await requireDEntrySessionChangeRoot(
        scope,
        input.selection,
      );
      if (
        fresh.rootOriginDigest !== expected.rootOriginDigest ||
        fresh.identity.employeeRevision !== identity.employeeRevision ||
        fresh.identity.employeeVersionId !== identity.employeeVersionId ||
        ('title' in change && (await session()).archivedAt)
      )
        throw denied();
      active.throwIfAborted();
    };
    const resolve = () =>
      currentDEntryNativeOwner(deps.owners, scope, identity, signal);
    await assertRoot(signal);
    const current = await resolve().catch(async (error: unknown) => {
      if (
        !(error instanceof DEntryNativeUnavailable) &&
        !(
          error instanceof PersonVmError &&
          ['NOT_FOUND', 'RUNTIME_NOT_READY'].includes(error.code)
        )
      )
        throw error;
      // The same production prewarm owner can activate an existing employee
      // without minting a thread or approving an upgrade stop.
      await deps.prewarm.prewarm(scope, identity, 'page', signal, signal);
      return resolve();
    });
    const binding = current.view.receipt.binding;
    if (binding.vmId !== expected.vmId) throw denied();
    const data = deps.data();
    if (!data) throw new DEntryNativeUnavailable();
    const operationId = randomUUID();
    const owner = await data.resolveAdmissionOwner({
      context: scope,
      identity,
      owner: current.owner,
      operationId,
      signal: current.signal,
      access: 'page',
    });
    if (
      owner.context.sessionId !== scope.sessionId ||
      owner.context.workspaceId !== scope.workspaceId ||
      owner.operationId !== operationId ||
      !sameDEntryVmBinding(owner.binding, binding)
    )
      throw denied();
    return await runDEntryAdmittedActivity(
      {
        ports: observeDEntryFinish(data.admission, cleanupFailed),
        owner: {
          ...owner,
          async assertCurrent(active) {
            await assertRoot(active);
            await owner.assertCurrent(active);
          },
        },
        signal: current.signal,
      },
      (signal) => {
        const catalog = ownDEntryCatalog(current.owner, signal);
        const scopeId = randomUUID();
        const activity = catalog.owner.acquirePrincipal(
          scope,
          { access: 'page', scopeId, identity },
          signal,
        );
        return {
          async run(
            active,
          ): Promise<z.infer<typeof DEntrySessionChangeResultSchema>> {
            const native = await activity.run(active);
            const sessionId = expected.rootNativeSessionId;
            const call = async (
              endpoint: string,
              request: Record<string, string | boolean>,
              signal: AbortSignal,
            ) => {
              await assertRoot(signal);
              await owner.assertCurrent(signal);
              const result = await native.invokePage(
                { kind: 'page', scopeId, endpoint, args: { request } },
                signal,
              );
              if (result.endpoint !== endpoint || result.attachments.length)
                throw new DEntryNativeUnavailable();
              return result.value;
            };
            if ('title' in change) {
              TYPERT_REMOTE.methods['session/rename'].result
                .create()
                .parse(
                  await call(
                    'session/rename',
                    { sessionId, title: change.title },
                    active,
                  ),
                );
              await syncDEntryNativeRootTitle(
                scope,
                expected,
                binding,
                async (signal) => {
                  const result = TYPERT_REMOTE.methods[
                    'session/projections'
                  ].result
                    .create()
                    .parse(
                      await call('session/projections', { sessionId }, signal),
                    );
                  const title =
                    result?.kind === 'sequenced' && result.values.title;
                  if (typeof title !== 'string')
                    throw new DEntryNativeUnavailable();
                  return title;
                },
                active,
              );
            } else {
              try {
                const answer = archiveValue.parse(
                  await call(
                    change.archived
                      ? 'workspace/archiveSession'
                      : 'workspace/unarchiveSession',
                    {
                      sessionId,
                      ...(change.archived &&
                        change.stopActivity && { stopActivity: true }),
                    },
                    active,
                  ),
                );
                if (
                  answer.archivedSessionIds.includes(sessionId) !==
                  change.archived
                )
                  throw new DEntryNativeUnavailable();
              } catch (error) {
                const failure = activeFailure.safeParse(error);
                if (change.archived && !change.stopActivity && failure.success)
                  return {
                    state: 'active',
                    activity: failure.data.details.activity,
                  };
                throw error;
              }
              await syncDEntryNativeRootArchive(
                scope,
                expected,
                binding,
                async (signal) => {
                  await assertRoot(signal);
                  await owner.assertCurrent(signal);
                  // Read the current native archive state for each PG CAS attempt.
                  // An earlier RPC receipt alone can predate a concurrent reversal.
                  for await (const frame of native.streamPage(
                    {
                      kind: 'page',
                      scopeId,
                      endpoint: 'workspace/follow',
                      args: {},
                    },
                    signal,
                  ))
                    return archiveBaseline
                      .parse(frame.value)
                      .value.archivedSessionIds.includes(sessionId);
                  throw new DEntryNativeUnavailable();
                },
                active,
              );
            }
            await assertRoot(active);
            return { state: 'changed', session: await session() };
          },
          async close() {
            try {
              await catalog.close();
            } catch (error) {
              cleanupFailed(error);
              throw error;
            }
          },
        };
      },
    );
  } catch (error) {
    requestFailed = true;
    requestError = error;
    throw error;
  } finally {
    await authority.close().catch((error: unknown) => {
      cleanupFailed(error);
      if (requestFailed)
        throw new AggregateError(
          [requestError, error],
          'Session change cleanup unconfirmed',
          { cause: requestError },
        );
      throw error;
    });
  }
}
