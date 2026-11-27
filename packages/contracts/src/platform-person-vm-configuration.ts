/** Application-versioned platform defaults. The Host's sealed configuration
 * may select the width of a new or converted employee port pool. */
export const MAX_PERSON_VM_EMPLOYEE_PORT_SLOTS = 20;

export type PlatformPersonVmConfiguration = Readonly<{
  memoryMiB: number;
  idleMs: number;
  /** New or converted pools only. A verified existing pool keeps its width. */
  employeePortSlots: number;
  commandHighBytes: number;
  commandMaxBytes: number;
  commandSwapMaxBytes: number;
}>;
const configuration: PlatformPersonVmConfiguration = Object.freeze({
  memoryMiB: 2 * 1024,
  idleMs: 20 * 60 * 1000,
  employeePortSlots: MAX_PERSON_VM_EMPLOYEE_PORT_SLOTS,
  commandHighBytes: 1280 * 1024 ** 2,
  commandMaxBytes: 1280 * 1024 ** 2,
  commandSwapMaxBytes: 512 * 1024 ** 2,
});

export function readPlatformPersonVmConfiguration(): PlatformPersonVmConfiguration {
  return configuration;
}
