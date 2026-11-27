import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import {
  PersonVmError,
  type PersonVmBinding,
  type PersonVmPort,
  type PersonVmService,
} from '@allrice/person-vm';
import type { createProductionPersonVmAuthority } from './production-authority.js';

export type CurrentSelectionPrewarm = (
  context: RequestContext,
  identity: DEntryIdentity,
  input: Omit<Parameters<PersonVmPort['prewarm']>[1], 'selectedEmployee'>,
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
  >;
}): CurrentSelectionPrewarm {
  return async (context, identity, trigger, physicalSignal) => {
    const expected = Object.freeze({ ...identity });
    try {
      return await input.current.withCurrentSelection(
        context,
        expected,
        physicalSignal,
        () =>
          input.vm.prewarm(
            context,
            {
              ...trigger,
              selectedEmployee: Object.freeze({
                personId: expected.personId,
                organizationId: expected.organizationId,
                workspaceId: expected.workspaceId,
                employeeInstanceId: expected.employeeInstanceId,
                employeeRevision: expected.employeeRevision,
                employeeVersionId: expected.employeeVersionId,
              }),
            },
            physicalSignal,
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
