import { expect, it } from 'vitest';
import { nativeEntryFixture } from '../d-entry/native-entry.fixture.js';
import { createProductionEmployeeRuntime } from './production-employee-runtime.js';

it('keeps omission off, with defaults and limits only when the Host enables employee runtime', () => {
  expect(createProductionEmployeeRuntime(undefined, 20)).toBeUndefined();
  expect(createProductionEmployeeRuntime({}, 20)).toMatchObject({
    maxRunning: 4,
    employeeIdleMs: 1_200_000,
  });
  for (const settings of [
    { employeeMaxRunning: 21 },
    { employeeMaxRunning: 1.5 },
    { employeeIdleMs: 59_999 },
    { employeeIdleMs: 86_400_001 },
  ])
    expect(() => createProductionEmployeeRuntime(settings, 20)).toThrow(
      'RUNTIME_NOT_READY',
    );
});

it('consumes the exact startup selection and does not infer demand from a retained roster', () => {
  const { binding, context, endpoint } = nativeEntryFixture();
  const selectedEmployee = {
    personId: binding.personId,
    organizationId: binding.organizationId,
    workspaceId: endpoint.workspaceId,
    employeeInstanceId: endpoint.employeeInstanceId,
    employeeRevision: endpoint.employeeRevision,
    employeeVersionId: endpoint.employeeVersionId,
  };
  const runtime = createProductionEmployeeRuntime({}, 20)!;
  const web = {
    context,
    receipt: { binding, rosterDigest: 'fixture', endpoints: [endpoint] },
  };
  const active = new AbortController();
  expect(runtime.readColdSelection(web, active.signal)).toBeNull();
  const current = { ...web, selectedEmployee };
  expect(runtime.readColdSelection(current, active.signal)).toBe(
    selectedEmployee,
  );
  const lost = new Error('startup expired');
  active.abort(lost);
  expect(() => runtime.readColdSelection(current, active.signal)).toThrow(lost);
});
