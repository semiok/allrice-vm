import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import {
  DataAccessError,
  type withOwnedPersonVmAuthorityTransaction,
} from '@allrice/database';
import {
  PersonVmError,
  type PersonVmBinding,
  type PersonVmPort,
  type PersonVmService,
} from '@allrice/person-vm';
import type { createProductionPersonVmAuthority } from './production-authority.js';

export type PrewarmAuthorityTransaction = Parameters<
  Parameters<typeof withOwnedPersonVmAuthorityTransaction>[3]
>[0];

type LockedUpgradeTicketCheck = (
  sql: PrewarmAuthorityTransaction,
  signal: AbortSignal,
) => Promise<void>;

export type CurrentSelectionPrewarm = (
  context: RequestContext,
  identity: DEntryIdentity,
  input: Omit<Parameters<PersonVmPort['prewarm']>[1], 'selectedEmployee'> & {
    assertLockedUpgradeTicket?: LockedUpgradeTicketCheck;
  },
  physicalSignal: AbortSignal,
) => ReturnType<PersonVmPort['prewarm']>;
export type CurrentSelectionEntryRecovery = (
  context: RequestContext,
  identity: DEntryIdentity,
  binding: PersonVmBinding,
  signal: AbortSignal,
  retained?: boolean,
) => Promise<boolean>;

export function createProductionStoppedEntryReconciliation(input: {
  vm: Pick<
    PersonVmService,
    'hasStoppedEntryWork' | 'reconcileStoppedEntryForPrewarm'
  >;
  current: Pick<
    ReturnType<typeof createProductionPersonVmAuthority>,
    'withCurrentSelection'
  >;
}): CurrentSelectionEntryRecovery {
  return async (context, identity, binding, signal, retained) => {
    if (!retained && !input.vm.hasStoppedEntryWork(binding)) return false;
    try {
      return await input.current.withCurrentSelection(
        context,
        identity,
        signal,
        () =>
          input.vm.reconcileStoppedEntryForPrewarm(
            context,
            binding,
            signal,
            retained,
          ),
      );
    } catch (error) {
      if (
        error instanceof PersonVmError &&
        error.code === 'AUTHORIZATION_DENIED'
      )
        throw new DataAccessError('authorization_denied');
      throw error;
    }
  };
}

/** The final Host passes the SAME authority owner used by its VM service.
 * Caller cancellation is handled by the outer request; this physical operation
 * only receives current revocation/service lifetime, never a browser permit. */
export function createProductionCurrentPrewarm(input: {
  vm: Pick<PersonVmPort, 'prewarm'>;
  current: Pick<
    ReturnType<typeof createProductionPersonVmAuthority>,
    'withCurrentSelection'
  > &
    Partial<
      Pick<
        ReturnType<typeof createProductionPersonVmAuthority>,
        'dispatchUpgradeStop'
      >
    >;
}): CurrentSelectionPrewarm {
  return async (context, identity, request, physicalSignal) => {
    const expected = Object.freeze({ ...identity });
    try {
      return await input.current.withCurrentSelection(
        context,
        expected,
        physicalSignal,
        () => {
          const dispatch = input.current.dispatchUpgradeStop;
          const { assertLockedUpgradeTicket, ...requestInput } = request;
          const prewarm = {
            ...requestInput,
            selectedEmployee: Object.freeze({
              personId: expected.personId,
              organizationId: expected.organizationId,
              workspaceId: expected.workspaceId,
              employeeInstanceId: expected.employeeInstanceId,
              employeeRevision: expected.employeeRevision,
              employeeVersionId: expected.employeeVersionId,
            }),
          };
          const target = prewarm.target;
          return input.vm.prewarm(
            context,
            prewarm.trigger === 'open' &&
              target &&
              dispatch &&
              assertLockedUpgradeTicket
              ? {
                  ...prewarm,
                  target: {
                    ...target,
                    dispatchUpgradeStop: (binding, signal, stop) =>
                      dispatch(
                        context,
                        expected,
                        binding,
                        signal,
                        assertLockedUpgradeTicket,
                        stop,
                      ),
                  },
                }
              : prewarm,
            physicalSignal,
          );
        },
      );
    } catch (error) {
      if (
        error instanceof PersonVmError &&
        error.code === 'AUTHORIZATION_DENIED'
      )
        throw new DataAccessError('authorization_denied');
      throw error;
    }
  };
}
