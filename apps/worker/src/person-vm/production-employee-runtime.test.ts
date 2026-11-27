import { expect, it, vi } from 'vitest';
import { PersonVmError, type MicrosandboxPersonVm } from '@allrice/person-vm';
import { nativeEntryFixture } from '../d-entry/native-entry.fixture.js';
import { spawnMicrosandboxManagedProbe } from '../../../../packages/person-vm/src/microsandbox-bootstrap.ts';
import { createProductionEmployeeRuntime } from './production-employee-runtime.js';

it('keeps omission off, with defaults and limits only when the Host enables employee runtime', () => {
  const native = { readAttachedProbe: vi.fn() };
  expect(
    createProductionEmployeeRuntime(undefined, native, 20),
  ).toBeUndefined();
  expect(createProductionEmployeeRuntime({}, native, 20)).toMatchObject({
    maxRunning: 4,
    employeeIdleMs: 1_200_000,
  });
  for (const settings of [
    { employeeMaxRunning: 21 },
    { employeeMaxRunning: 1.5 },
    { employeeIdleMs: 59_999 },
    { employeeIdleMs: 86_400_001 },
  ])
    expect(() => createProductionEmployeeRuntime(settings, native, 20)).toThrow(
      'RUNTIME_NOT_READY',
    );
  expect(native.readAttachedProbe).not.toHaveBeenCalled();
});

it('only interprets the exact managed read result as an unused HOME tree', async () => {
  const { binding } = nativeEntryFixture();
  const scope = {
    binding,
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
  };
  const readAttachedProbe = vi.fn<MicrosandboxPersonVm['readAttachedProbe']>();
  const runtime = createProductionEmployeeRuntime(
    {},
    { readAttachedProbe },
    20,
  )!;
  const check = () =>
    runtime.readUnusedEmployeeHomes(scope, '/synthetic/mount');
  const command = vi.fn(async ([action]: string[]) => {
    if (action === 'exec') return 'fixture-home-probe';
    if (action === 'wait')
      return JSON.stringify({ code: 0, success: true, timed_out: false });
    if (action === 'logs')
      return JSON.stringify({
        id: 'fixture-home-probe',
        s: 'stdout',
        e: null,
        d: 'allrice-employee-homes-unused\n',
      });
    throw new Error(`Unexpected managed probe command: ${action}`);
  });
  readAttachedProbe.mockImplementationOnce(async (scope, _mount, spec) => {
    const job = await spawnMicrosandboxManagedProbe(
      { scope, name: 'fixture', cleanupTimeoutMs: 1_000, command },
      spec,
    );
    await job.wait(scope.signal);
    return job.stdout(scope.signal);
  });
  await expect(check()).resolves.toBe(true);
  expect(command.mock.calls.map(([args]) => args[0])).toEqual([
    'exec',
    'wait',
    'logs',
  ]);
  expect(command.mock.calls[0]![0]).toEqual(
    expect.arrayContaining(['--workdir', '/bin']),
  );
  expect(readAttachedProbe).toHaveBeenCalledExactlyOnceWith(
    scope,
    '/synthetic/mount',
    expect.objectContaining({
      executable: 'node',
      args: [
        '--input-type=module',
        '--eval',
        expect.stringContaining('/work/.allrice/employees'),
      ],
    }),
  );
  readAttachedProbe.mockResolvedValueOnce('');
  await expect(check()).resolves.toBe(false);
  const unknown = new PersonVmError('CLEANUP_INCOMPLETE');
  readAttachedProbe.mockRejectedValueOnce(unknown);
  await expect(check()).rejects.toBe(unknown);
});

it('forwards the selected profile on retained starts but defers siblings only with the owned startup proof', async () => {
  const { binding, context, endpoint } = nativeEntryFixture();
  const selectedEmployee = {
    personId: binding.personId,
    organizationId: binding.organizationId,
    workspaceId: endpoint.workspaceId,
    employeeInstanceId: endpoint.employeeInstanceId,
    employeeRevision: endpoint.employeeRevision,
    employeeVersionId: endpoint.employeeVersionId,
  };
  const runtime = createProductionEmployeeRuntime(
    {},
    { readAttachedProbe: vi.fn() },
    20,
  )!;
  const web = {
    context,
    receipt: { binding, rosterDigest: 'fixture', endpoints: [endpoint] },
  };
  const signal = new AbortController().signal;
  await expect(runtime.readColdSelection(web, signal)).resolves.toBeNull();
  await expect(
    runtime.readColdSelection({ ...web, selectedEmployee }, signal),
  ).resolves.toEqual({
    selected: selectedEmployee,
    neverStarted: [],
  });
  await expect(
    runtime.readColdSelection(
      {
        ...web,
        selectedEmployee,
        unusedEmployeeHomes: true,
      },
      signal,
    ),
  ).resolves.toEqual({
    selected: selectedEmployee,
    neverStarted: [selectedEmployee],
  });
});
