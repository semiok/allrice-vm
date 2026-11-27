import { expect, it } from 'vitest';
import {
  PlatformPersonVmPolicySchema,
  readPlatformPersonVmConfiguration,
} from './platform-person-vm-configuration.ts';

it('keeps the application platform defaults at 2GiB and twenty minutes', () => {
  expect(readPlatformPersonVmConfiguration()).toEqual({
    memoryMiB: 2 * 1024,
    idleMs: 20 * 60 * 1000,
    commandHighBytes: 1280 * 1024 ** 2,
    commandMaxBytes: 1280 * 1024 ** 2,
    commandSwapMaxBytes: 512 * 1024 ** 2,
  });
});
it('has no request override and returns an immutable shared platform configuration', () => {
  const configuration = readPlatformPersonVmConfiguration();
  expect(
    Reflect.apply(readPlatformPersonVmConfiguration, undefined, [
      {
        memoryMiB: 1,
        idleMs: 1,
        organizationId: 'untrusted',
      },
    ]),
  ).toBe(configuration);
  expect(Reflect.set(configuration, 'memoryMiB', 1)).toBe(false);
  expect(Reflect.set(configuration, 'idleMs', 1)).toBe(false);
  expect(Reflect.set(configuration, 'commandHighBytes', 1)).toBe(false);
  expect(Reflect.set(configuration, 'commandMaxBytes', 1)).toBe(false);
  expect(Reflect.set(configuration, 'commandSwapMaxBytes', 1)).toBe(false);
  expect(readPlatformPersonVmConfiguration()).toEqual({
    memoryMiB: 2 * 1024,
    idleMs: 20 * 60 * 1000,
    commandHighBytes: 1280 * 1024 ** 2,
    commandMaxBytes: 1280 * 1024 ** 2,
    commandSwapMaxBytes: 512 * 1024 ** 2,
  });
});

it.each([
  { memoryMiB: 1024, idleMs: 5 * 60_000 },
  { memoryMiB: 4096, idleMs: 60 * 60_000 },
])('accepts a platform policy of $memoryMiB MiB and $idleMs ms', (policy) => {
  expect(PlatformPersonVmPolicySchema.parse(policy)).toEqual(policy);
});

it.each([
  ['memoryMiB', 1023],
  ['memoryMiB', 4097],
  ['memoryMiB', 1024.5],
  ['memoryMiB', '1024'],
  ['idleMs', 5 * 60_000 - 1],
  ['idleMs', 60 * 60_000 + 1],
  ['idleMs', 5 * 60_000 + 0.5],
  ['idleMs', Infinity],
])('rejects invalid platform %s value %s', (field, value) => {
  expect(() =>
    PlatformPersonVmPolicySchema.parse({
      memoryMiB: 2048,
      idleMs: 20 * 60_000,
      [field]: value,
    }),
  ).toThrow();
});
