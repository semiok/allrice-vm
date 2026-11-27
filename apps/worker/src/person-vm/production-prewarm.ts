import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import {
  DataAccessError,
  type withOwnedPersonVmAuthorityTransaction,
} from '@allrice/database';
import { PersonVmError, type PersonVmPort } from '@allrice/person-vm';
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
  input: Parameters<PersonVmPort['prewarm']>[1] & {
    assertLockedUpgradeTicket?: LockedUpgradeTicketCheck;
  },
  physicalSignal: AbortSignal,
) => ReturnType<PersonVmPort['prewarm']>;

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
    try {
      return await input.current.withCurrentSelection(
        context,
        identity,
        physicalSignal,
        () => {
          const dispatch = input.current.dispatchUpgradeStop;
          const { assertLockedUpgradeTicket, ...prewarm } = request;
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
                        identity,
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
