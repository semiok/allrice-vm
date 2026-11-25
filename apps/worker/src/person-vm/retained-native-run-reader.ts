import { readFile } from 'node:fs/promises';
import {
  DEntryNativeTurnEndSchema,
  isDEntryNativeRunJournalCurrent,
  publishDEntryNativeRunTerminal,
  type DEntryNativeRunCandidate,
  type DEntryNativeRunJournalOwner,
} from '@allrice/database';
import {
  PersonVmError,
  type ApfsPersonVmDisk,
  type MicrosandboxPersonVm,
  type PersonVmBinding,
  type PersonVmStartingScope,
  type PostgresPersonVmStore,
} from '@allrice/person-vm';

export type RetainedNativeRunReconciler = ReturnType<
  typeof createRetainedNativeRunReconciler
>;

export function dEntryNativeRunJournalSelection({
  attempt,
  prompt,
}: DEntryNativeRunCandidate) {
  return {
    sessionId: attempt.sessionId,
    nativeRequestId: prompt.nativeRequestId,
    purpose: attempt.kind,
    cursor: attempt.cursor,
    turn: attempt.turn,
    delegated: prompt.source === 'dsh-native-delegation',
    parentSessionId: attempt.parentSessionId,
  };
}

/** Narrow Host-only read on an existing exact VM. The normal lifecycle owns
 * every disk attach, VM start, and profile/login transition. */
export function createRetainedNativeRunReconciler(input: {
  store: Pick<PostgresPersonVmStore, 'withRetainedReadLease'>;
  disk: Pick<ApfsPersonVmDisk, 'verifyAttachedMount'>;
  native: Pick<MicrosandboxPersonVm, 'readAttachedProbe'>;
  cliPath: string;
  readonlyGuestDirectory: string;
}) {
  let probeSource: Promise<string> | undefined;
  return async (
    candidate: DEntryNativeRunCandidate,
    owner: DEntryNativeRunJournalOwner,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (!input.cliPath.startsWith(input.readonlyGuestDirectory + '/'))
      throw new PersonVmError('PROVIDER_FAILED');
    probeSource ??= readFile(
      new URL('../../dist/allrice-native-run-journal.mjs', import.meta.url),
      'utf8',
    ).catch((error: unknown) => {
      probeSource = undefined;
      throw error;
    });
    const program = await probeSource;
    signal.throwIfAborted();
    const binding: PersonVmBinding = {
      vmId: owner.vmId,
      personId: owner.personId,
      organizationId: owner.organizationId,
      instanceId: owner.vmInstanceId,
      leaseEpoch: owner.leaseEpoch,
    };
    return input.store.withRetainedReadLease(
      binding,
      signal,
      async (lease, disk) => {
        const scope: PersonVmStartingScope = Object.freeze({
          ...lease,
          async assertCurrent() {
            await lease.assertCurrent();
            if (
              !(await isDEntryNativeRunJournalCurrent(
                candidate,
                owner,
                lease.signal,
                lease.leaseOwner,
              ))
            )
              throw new PersonVmError('LEASE_LOST');
            await lease.assertCurrent();
          },
        });
        await scope.assertCurrent();
        const mount = await input.disk.verifyAttachedMount(disk, scope.signal);
        if (!mount) return false;
        await scope.assertCurrent();
        const output = await input.native.readAttachedProbe(scope, mount, {
          executable: 'node',
          args: [
            '--input-type=module',
            '--eval',
            program +
              '\nawait printRetainedRunTerminal(process.argv.slice(1));',
            '--',
            input.cliPath,
            input.readonlyGuestDirectory,
            owner.employeeInstanceId,
            JSON.stringify(dEntryNativeRunJournalSelection(candidate)),
          ],
        });
        if (
          (await input.disk.verifyAttachedMount(disk, scope.signal)) !== mount
        )
          throw new PersonVmError('LEASE_LOST');
        await scope.assertCurrent();
        if (Buffer.byteLength(output, 'utf8') > 1024)
          throw new PersonVmError('PROVIDER_FAILED');
        const decoded: unknown = JSON.parse(output);
        if (decoded === null) return false;
        const end = DEntryNativeTurnEndSchema.parse(decoded);
        return publishDEntryNativeRunTerminal(candidate, end, scope.signal);
      },
    );
  };
}
