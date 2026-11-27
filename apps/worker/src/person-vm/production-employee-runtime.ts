import {
  PersonVmError,
  type MicrosandboxPersonVm,
  type PersonVmStartingScope,
  type PersonVmWebStartup,
} from '@allrice/person-vm';

export type ProductionEmployeeRuntimeSettings = Readonly<{
  employeeMaxRunning?: number;
  employeeIdleMs?: number;
}>;

const defaults = Object.freeze({
  employeeMaxRunning: 4,
  employeeIdleMs: 20 * 60 * 1000,
});

const unused = 'allrice-employee-homes-unused';
// Probe the AllRice-owned root before staging the authenticated release.
// A pre-existing directory or a symlink is deliberately inconclusive.
const program = `
import { lstatSync } from 'node:fs';
function homesNeverCreated() {
  for (const path of ['/work', '/work/.allrice', '/work/.allrice/employees']) {
    try {
      if (!lstatSync(path).isDirectory()) return false;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  }
  return false;
}
if (homesNeverCreated()) console.log(${JSON.stringify(unused)});
`;

export function resolveProductionEmployeeRuntimeSettings(
  settings: ProductionEmployeeRuntimeSettings,
  slots: number,
) {
  const employeeMaxRunning =
    settings.employeeMaxRunning ?? Math.min(defaults.employeeMaxRunning, slots);
  const employeeIdleMs = settings.employeeIdleMs ?? defaults.employeeIdleMs;
  if (
    !Number.isSafeInteger(employeeMaxRunning) ||
    employeeMaxRunning < 1 ||
    employeeMaxRunning > slots ||
    !Number.isSafeInteger(employeeIdleMs) ||
    employeeIdleMs < 60_000 ||
    employeeIdleMs > 86_400_000
  )
    throw new PersonVmError('RUNTIME_NOT_READY');
  return Object.freeze({ employeeMaxRunning, employeeIdleMs });
}

export function createProductionEmployeeRuntime(
  settings: ProductionEmployeeRuntimeSettings | undefined,
  native: Pick<MicrosandboxPersonVm, 'readAttachedProbe'>,
  slots: number,
) {
  if (!settings) return undefined;
  const { employeeMaxRunning, employeeIdleMs } =
    resolveProductionEmployeeRuntimeSettings(settings, slots);
  return Object.freeze({
    maxRunning: employeeMaxRunning,
    employeeIdleMs,
    async readUnusedEmployeeHomes(scope: PersonVmStartingScope, mount: string) {
      const output = await native.readAttachedProbe(scope, mount, {
        executable: 'node',
        args: ['--input-type=module', '--eval', program],
        // First boot checks the HOME tree before bootstrap creates /work.
        workdir: '/bin',
      });
      scope.signal.throwIfAborted();
      return output === unused + '\n';
    },
    async readColdSelection(web: PersonVmWebStartup, active: AbortSignal) {
      const selected = web.selectedEmployee;
      if (!selected) return null;
      active.throwIfAborted();
      const { organizationId, personId } = web.receipt.binding;
      return {
        selected,
        neverStarted: (web.unusedEmployeeHomes === true
          ? web.receipt.endpoints
          : []
        ).map(
          ({
            workspaceId,
            employeeInstanceId,
            employeeRevision,
            employeeVersionId,
          }) => ({
            organizationId,
            personId,
            workspaceId,
            employeeInstanceId,
            employeeRevision,
            employeeVersionId,
          }),
        ),
      };
    },
  });
}
