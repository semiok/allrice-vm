import { PersonVmError, type PersonVmWebStartup } from '@allrice/person-vm';

export type ProductionEmployeeRuntimeSettings = Readonly<{
  employeeMaxRunning?: number;
  /** Validated seal field. Employee idle retirement remains disabled. */
  employeeIdleMs?: number;
}>;

const defaults = Object.freeze({
  employeeMaxRunning: 4,
  employeeIdleMs: 20 * 60 * 1000,
});

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
  slots: number,
) {
  if (!settings) return undefined;
  const { employeeMaxRunning, employeeIdleMs } =
    resolveProductionEmployeeRuntimeSettings(settings, slots);
  return Object.freeze({
    maxRunning: employeeMaxRunning,
    employeeIdleMs,
    readColdSelection(web: PersonVmWebStartup, active: AbortSignal) {
      active.throwIfAborted();
      return web.selectedEmployee ?? null;
    },
  });
}
