import { beforeEach, expect, it, vi } from 'vitest';
import type { DEntryRolloutPolicy } from '@allrice/contracts';
import type * as EmployeeInstances from './employees/employee-instances.ts';

const data = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  employee: vi.fn(),
  principal: vi.fn(),
}));
vi.mock('./core/client.ts', () => ({ getDatabase: data.getDatabase }));
vi.mock('./content-maintenance.ts', () => ({
  readContentPrincipal: data.principal,
}));
vi.mock('./employees/employee-instances.ts', async (original) => ({
  ...(await original<typeof EmployeeInstances>()),
  getEmployeeInstance: data.employee,
}));

import {
  readPersonVmDiskPreparationRoster,
  readPersonVmDiskPreparationTarget,
} from './d-entry-release-policy.ts';
import { EmployeeInstanceError } from './employees/employee-instances.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = id(1);
const other = id(2);
const org = id(3);
const secondOrg = id(4);
const workspace = id(5);
const first = id(6);
const second = id(7);
const version = id(8);
const selection = (
  employeeInstanceId = first,
  organizationId = org,
  personId = person,
  generation: '4.0' | '3.x' = '4.0',
) => ({ employeeInstanceId, organizationId, personId, generation });

const signal = () => new AbortController().signal;
function fixture(
  selections: DEntryRolloutPolicy['selections'],
  vm: Record<string, unknown>[] = [],
  defaultGeneration: DEntryRolloutPolicy['defaultGeneration'] = '3.x',
) {
  const seen: { query: string; params: unknown[] }[] = [];
  const sql = vi.fn(
    async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const query = strings.join('?');
      seen.push({ query, params });
      if (query.includes('set local transaction_timeout')) return [];
      if (query.includes('from allrice_settings')) {
        return [
          {
            value: {
              revision: 'revision-1',
              defaultGeneration,
              selections,
            },
          },
        ];
      }
      if (query.includes('from person_virtual_machines')) return vm;
      if (query.includes('from allrice_employee_instances'))
        return [
          {
            owner_id: String(params[2]).toLowerCase(),
            organization_id: String(params[1]).toLowerCase(),
            workspace_id: workspace,
          },
        ];
      throw Error('Unexpected fixture query');
    },
  );
  const begin = vi.fn(
    async (_mode: string, callback: (tx: typeof sql) => unknown) =>
      callback(sql),
  );
  data.getDatabase.mockReturnValue(Object.assign(sql, { begin }));
  return { begin, seen, sql };
}
beforeEach(() => {
  vi.resetAllMocks();
  data.principal.mockResolvedValue({ writable: true });
  data.employee.mockImplementation(async (_subject, employeeId) => ({
    id: String(employeeId).toLowerCase(),
    workspaceId: workspace,
    revision: 1,
    source: { employeeVersionId: version },
  }));
});

it('pages distinct 4.0 people without splitting same-person selections or including 3.x', async () => {
  fixture([
    selection(second),
    selection(),
    selection(first, secondOrg, other),
    selection(first, org, id(9), '3.x'),
  ]);
  const roster = await readPersonVmDiskPreparationRoster(signal());
  expect(roster.page(0, 1)).toEqual({ personIds: [person], nextOffset: 1 });
  expect(roster.page(1, 1)).toEqual({
    personIds: [other],
    nextOffset: null,
  });
  expect(() => roster.page(0, 0)).toThrow('Invalid disk preparation page');
});

it('does not authorize policy UUID spellings rejected by the foreground matcher', async () => {
  const spelled = 'a0000000-0000-4000-8000-000000000008';
  fixture([selection(spelled.toUpperCase())]);
  expect(await readPersonVmDiskPreparationTarget(person, signal())).toBeNull();
  fixture([selection(first, org, spelled.toUpperCase())]);
  expect(
    (await readPersonVmDiskPreparationRoster(signal())).page(0, 16).personIds,
  ).toEqual([]);
  expect(
    await readPersonVmDiskPreparationTarget(spelled.toUpperCase(), signal()),
  ).toBeNull();
});

it('fails closed on a published policy that defaults everyone to 4.0', async () => {
  fixture([selection()], [], '4.0');
  await expect(readPersonVmDiskPreparationRoster(signal())).rejects.toThrow(
    'D entry published policy is unavailable',
  );
  await expect(
    readPersonVmDiskPreparationTarget(person, signal()),
  ).rejects.toThrow('D entry published policy is unavailable');
});

it('reads policy, membership and employee version in one short snapshot without a session', async () => {
  const { begin, seen, sql } = fixture([selection()]);
  expect(await readPersonVmDiskPreparationTarget(person, signal())).toEqual({
    personId: person,
    organizationId: org,
    workspaceId: workspace,
    employeeInstanceId: first,
    employeeRevision: 1,
    employeeVersionId: version,
    policyRevision: 'revision-1',
  });
  expect(begin.mock.calls[0]?.[0]).toBe(
    'isolation level repeatable read read only',
  );
  expect(
    seen.find(({ query }) => query.includes('from allrice_employee_instances'))
      ?.params,
  ).toEqual([first, org, person]);
  const subject = {
    actor: { type: 'user', id: person },
    organizationId: org,
    workspaceId: workspace,
  };
  expect(data.principal).toHaveBeenCalledExactlyOnceWith(subject, sql);
  expect(data.employee).toHaveBeenCalledExactlyOnceWith(subject, first, sql);
});

it('requires a writable current membership and a live assignment', async () => {
  fixture([selection(), selection(second)]);
  data.principal.mockResolvedValueOnce({ writable: false });
  data.employee.mockRejectedValueOnce(
    new EmployeeInstanceError('instance_archived'),
  );
  expect(await readPersonVmDiskPreparationTarget(person, signal())).toBeNull();
  expect(data.employee).toHaveBeenCalledTimes(1);
  expect(data.employee.mock.calls[0]?.[1]).toBe(second);
});

it('denies ambiguous enterprise ownership and respects the existing person disk owner', async () => {
  const selections = [selection(), selection(second, secondOrg)];
  fixture(selections);
  await expect(
    readPersonVmDiskPreparationTarget(person, signal()),
  ).rejects.toMatchObject({
    code: 'ORGANIZATION_CONFLICT',
  });
  fixture(selections, [
    {
      organization_id: secondOrg,
      phase: 'stopped',
      disk_retained: true,
      native_created: false,
      instance_id: null,
    },
  ]);
  expect(
    await readPersonVmDiskPreparationTarget(person, signal()),
  ).toMatchObject({
    organizationId: secondOrg,
    employeeInstanceId: second,
  });
});

it.each([
  { phase: 'deleted', native_created: false, instance_id: null },
  { phase: 'stopped', native_created: true, instance_id: null },
  { phase: 'starting', native_created: false, instance_id: id(10) },
])(
  'skips tombstones and rows already owned by native startup (%j)',
  async (state) => {
    fixture(
      [selection()],
      [{ organization_id: org, disk_retained: true, ...state }],
    );
    expect(
      await readPersonVmDiskPreparationTarget(person, signal()),
    ).toBeNull();
    expect(data.employee).not.toHaveBeenCalled();
  },
);

it('propagates unexpected eligibility errors and rejects a cancelled scan', async () => {
  fixture([selection()]);
  data.employee.mockRejectedValueOnce(Error('synthetic source failure'));
  await expect(
    readPersonVmDiskPreparationTarget(person, signal()),
  ).rejects.toThrow('synthetic source failure');
  const cancel = new AbortController();
  cancel.abort(Error('cancelled'));
  await expect(
    readPersonVmDiskPreparationTarget(person, cancel.signal),
  ).rejects.toThrow('cancelled');
});
