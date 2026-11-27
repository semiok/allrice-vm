import { readFile } from 'node:fs/promises';
import {
  DEntryNativeTurnEndSchema,
  isDEntryNativeRunJournalCurrent,
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
    ...(attempt.sessionId === prompt.rootSessionId &&
      prompt.forkedFromNativeSessionId && {
        forkedFromNativeSessionId: prompt.forkedFromNativeSessionId,
      }),
  };
}

/** Collect an observation of the physical journal on the existing VM. The
 * legacy workspace can write the journal, so this is not terminal authority. */
export function createRetainedNativeRunReader(input: {
  store: Pick<PostgresPersonVmStore, 'withRetainedReadLease'>;
  disk: Pick<ApfsPersonVmDisk, 'verifyAttachedMount'>;
  native: Pick<MicrosandboxPersonVm, 'readAttachedProbe'>;
  hasLocalOwner(binding: PersonVmBinding): boolean;
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
    const binding: PersonVmBinding = {
      vmId: owner.vmId,
      personId: owner.personId,
      organizationId: owner.organizationId,
      instanceId: owner.vmInstanceId,
      leaseEpoch: owner.leaseEpoch,
    };
    if (input.hasLocalOwner(binding)) return null;
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
        if (!mount) return null;
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
        if (decoded === null) return null;
        return Object.freeze({
          observedTerminal: DEntryNativeTurnEndSchema.parse(decoded),
        });
      },
      () => !input.hasLocalOwner(binding),
    );
  };
}
