import { z } from 'zod';

const minuteMs = 60 * 1000;

export const PlatformPersonVmPolicySchema = z.strictObject({
  memoryMiB: z
    .number()
    .int()
    .min(1024)
    .max(4 * 1024),
  idleMs: z
    .number()
    .int()
    .min(5 * minuteMs)
    .max(60 * minuteMs),
});

export const MAX_PERSON_VM_EMPLOYEE_PORT_SLOTS = 20;

/** Application-versioned platform configuration. Operators change this file
 * and release the application to adjust these defaults for every person.
 * No request, environment, enterprise or employee override is read here. */
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
  ...PlatformPersonVmPolicySchema.parse({
    memoryMiB: 2 * 1024,
    idleMs: 20 * minuteMs,
  }),
  employeePortSlots: MAX_PERSON_VM_EMPLOYEE_PORT_SLOTS,
  commandHighBytes: 1280 * 1024 ** 2,
  commandMaxBytes: 1280 * 1024 ** 2,
  commandSwapMaxBytes: 512 * 1024 ** 2,
});

export function readPlatformPersonVmConfiguration(): PlatformPersonVmConfiguration {
  return configuration;
}
