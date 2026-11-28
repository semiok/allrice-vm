import { beforeEach, expect, it, vi } from 'vitest';
import type { DEntryRolloutPolicy } from '@allrice/contracts';
import type * as EmployeeInstances from './employees/employee-instances.ts';

const data = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  createDedicatedDatabase: vi.fn(),
  employee: vi.fn(),
  publication: vi.fn(),
  principal: vi.fn(),
}));
vi.mock('./core/client.ts', () => ({
  getDatabase: data.getDatabase,
  createDedicatedDatabase: data.createDedicatedDatabase,
}));
vi.mock('./content-maintenance.ts', () => ({
  readContentPrincipal: data.principal,
}));
vi.mock('./employees/employee-instances.ts', async (original) => ({
  ...(await original<typeof EmployeeInstances>()),
  getEmployeeInstance: data.employee,
  readEmployeeVersionPublication: data.publication,
}));

import {
  readPersonVmDiskPreparationForegroundBusy,
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
const assignedEmployee = id(9);
const selection = (organizationId = org, personId = person) => ({
  organizationId,
  personId,
});
const instance = (
  instanceId = first,
  organizationId = org,
  ownerId = person,
) => ({
  id: instanceId,
  organization_id: organizationId,
  owner_id: ownerId,
  workspace_id: workspace,
  employee_id: assignedEmployee,
});

const signal = () => new AbortController().signal;
function fixture(
  selections: DEntryRolloutPolicy['selections'],
  vm: Record<string, unknown>[] = [],
  defaultGeneration: DEntryRolloutPolicy['defaultGeneration'] = '3.x',
  platformVersion = false,
  tenantVersionVerified = true,
  instances = [instance()],
) {
  const seen: { query: string; params: unknown[] }[] = [];
  const sql = vi.fn(
    async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const query = strings.join('?');
      seen.push({ query, params });
      if (
        query.startsWith('begin ') ||
        query.includes('set local transaction_timeout') ||
        query === 'commit'
      )
        return [];
      if (query.includes('from allrice_settings')) {
        return [
          {
            value: JSON.stringify({
              revision: 'revision-1',
              defaultGeneration,
              selections,
            }),
          },
        ];
      }
      if (query.includes('from person_virtual_machines')) return vm;
      if (query.includes('join allrice_audit_events audit'))
        return [{ verified: tenantVersionVerified }];
      if (query.includes('from allrice_employee_instances')) {
        const [organizations, ownerId] = params as [string, string];
        return instances
          .filter(
            (row) =>
              organizations.split(',').includes(row.organization_id) &&
              row.owner_id === ownerId,
          )
          .map((row) => ({
            ...row,
            platform_version: platformVersion,
          }));
      }
      throw Error('Unexpected fixture query');
    },
  );
  const end = vi.fn(async () => {});
  data.getDatabase.mockReturnValue({ options: { fetch_types: true } });
  data.createDedicatedDatabase.mockReturnValue(Object.assign(sql, { end }));
  return { end, seen, sql };
}
beforeEach(() => {
  vi.resetAllMocks();
  data.principal.mockResolvedValue({ writable: true });
  data.employee.mockImplementation(async (_subject, employeeId) => ({
    id: String(employeeId).toLowerCase(),
    workspaceId: workspace,
    revision: 1,
    source: { kind: 'tenant_version', employeeVersionId: version },
  }));
});

it('pages distinct 4.0 people without splitting a person released in multiple organizations', async () => {
  fixture([selection(secondOrg), selection(), selection(secondOrg, other)]);
  const roster = await readPersonVmDiskPreparationRoster(signal());
  expect(roster.page(0, 1)).toEqual({ personIds: [person], nextOffset: 1 });
  expect(roster.page(1, 1)).toEqual({
    personIds: [other],
    nextOffset: null,
  });
  expect(() => roster.page(0, 0)).toThrow('Invalid disk preparation page');
});

it('uses the person release contract’s canonical UUID spelling', async () => {
  const spelled = 'a0000000-0000-4000-8000-000000000008';
  fixture([selection(org, spelled.toUpperCase())], [], '3.x', false, true, [
    instance(first, org, spelled),
    instance(second, org, other),
  ]);
  expect(
    (await readPersonVmDiskPreparationRoster(signal())).page(0, 16).personIds,
  ).toEqual([spelled]);
  expect(
    await readPersonVmDiskPreparationTarget(spelled.toUpperCase(), signal()),
  ).toMatchObject({
    personId: spelled,
    organizationId: org,
    employeeInstanceId: first,
  });
  expect(await readPersonVmDiskPreparationTarget(other, signal())).toBeNull();
});

it('does not prepare without a current employee of the released person and organization', async () => {
  fixture([selection()], [], '3.x', false, true, [
    instance(first, org, other),
    instance(second, secondOrg, person),
  ]);
  expect(await readPersonVmDiskPreparationTarget(person, signal())).toBeNull();
  expect(data.employee).not.toHaveBeenCalled();
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

it('resolves the released person’s employee from the same snapshot as policy, membership and version', async () => {
  const { seen, sql } = fixture([selection()]);
  expect(await readPersonVmDiskPreparationTarget(person, signal())).toEqual({
    personId: person,
    organizationId: org,
    workspaceId: workspace,
    employeeInstanceId: first,
    employeeRevision: 1,
    employeeVersionId: version,
    platformRevisionId: null,
    policyRevision: 'revision-1',
  });
  expect(seen[0]?.query).toBe(
    'begin isolation level repeatable read read only',
  );
  const candidates = seen.find(({ query }) =>
    query.includes('from allrice_employee_instances'),
  );
  expect(candidates?.params).toEqual([org, person]);
  expect(candidates?.query).toContain('a.user_id=i.owner_id and a.active');
  expect(candidates?.query).toContain('i.archived_at is null');
  expect(candidates?.query).toContain('order by i.organization_id,i.id');
  const subject = {
    actor: { type: 'user', id: person },
    organizationId: org,
    workspaceId: workspace,
  };
  expect(data.principal).toHaveBeenCalledExactlyOnceWith(subject, sql);
  expect(data.employee).toHaveBeenCalledExactlyOnceWith(subject, first, sql);
});

it('requires a writable current membership and a live assignment', async () => {
  fixture([selection()], [], '3.x', false, true, [
    instance(),
    instance(second),
  ]);
  data.principal.mockResolvedValueOnce({ writable: false });
  data.employee.mockRejectedValueOnce(
    new EmployeeInstanceError('instance_archived'),
  );
  expect(await readPersonVmDiskPreparationTarget(person, signal())).toBeNull();
  expect(data.employee).toHaveBeenCalledTimes(1);
  expect(data.employee.mock.calls[0]?.[1]).toBe(second);
});

it('denies ambiguous enterprise ownership and respects the existing person disk owner', async () => {
  const selections = [selection(), selection(secondOrg)];
  const instances = [instance(), instance(second, secondOrg)];
  fixture(selections, [], '3.x', false, true, instances);
  await expect(
    readPersonVmDiskPreparationTarget(person, signal()),
  ).rejects.toMatchObject({
    code: 'ORGANIZATION_CONFLICT',
  });
  fixture(
    selections,
    [
      {
        organization_id: secondOrg,
        phase: 'stopped',
        disk_retained: true,
        native_created: false,
        instance_id: null,
      },
    ],
    '3.x',
    false,
    true,
    instances,
  );
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

it('reads the foreground busy projection in a bounded read-only transaction', async () => {
  const { seen } = fixture([selection()], [{ busy: true }]);
  expect(
    await readPersonVmDiskPreparationForegroundBusy(person, signal()),
  ).toBe(true);
  expect(data.createDedicatedDatabase).toHaveBeenCalledWith({
    options: { fetch_types: false },
  });
  expect(seen[0]?.query).toBe('begin read only');
  expect(seen[1]?.query).toBe("set local transaction_timeout = '5s'");
  expect(seen[2]?.query).toMatch(
    /lease_owner is not null or instance_id is not null\s+or holds/,
  );
  expect(seen[2]?.params).toEqual([person]);
  expect(seen[3]?.query).toBe('commit');

  fixture([selection()]);
  expect(
    await readPersonVmDiskPreparationForegroundBusy(person, signal()),
  ).toBe(false);
});

it('requires an exact, still published platform source without rejecting tenant-only versions', async () => {
  const { sql } = fixture([selection()]);
  data.employee.mockImplementation(async () => ({
    id: first,
    workspaceId: workspace,
    revision: 1,
    source: {
      kind: 'platform',
      employeeVersionId: version,
      templateRevisionId: id(10),
    },
  }));
  data.publication
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ revision_id: id(10) });
  expect(await readPersonVmDiskPreparationTarget(person, signal())).toBeNull();
  expect(
    await readPersonVmDiskPreparationTarget(person, signal()),
  ).toMatchObject({
    employeeVersionId: version,
    platformRevisionId: id(10),
  });
  expect(data.publication).toHaveBeenNthCalledWith(
    1,
    {
      organizationId: org,
      workspaceId: workspace,
      employeeId: assignedEmployee,
      versionId: version,
    },
    sql,
  );

  data.publication.mockClear();
  data.employee.mockResolvedValueOnce({
    id: first,
    workspaceId: workspace,
    revision: 1,
    source: { kind: 'tenant_version', employeeVersionId: version },
  });
  expect(
    await readPersonVmDiskPreparationTarget(person, signal()),
  ).toMatchObject({ employeeVersionId: version, platformRevisionId: null });
  expect(data.publication).not.toHaveBeenCalled();
});

it('does not treat a missing platform version mapping as a tenant-only publication', async () => {
  const { seen } = fixture([selection()], [], '3.x', true);
  expect(await readPersonVmDiskPreparationTarget(person, signal())).toBe(
    'version-source-unverified',
  );
  expect(
    seen.find(({ query }) => query.includes('as platform_version'))?.query,
  ).toContain('d.tenant_employee_version_id=a.employee_version_id');

  // A tenant-authored version of the same employee is independently eligible.
  fixture([selection()], [], '3.x', false);
  expect(
    await readPersonVmDiskPreparationTarget(person, signal()),
  ).toMatchObject({ employeeVersionId: version, platformRevisionId: null });
});

it('reports an older platform version with no mapping after deployment moves to a different version', async () => {
  // PostgreSQL can confirm the deployment points elsewhere, while mapInstances
  // labels the still-assigned older version tenant_version solely from absence.
  const { seen } = fixture([selection()], [], '3.x', false, false);
  expect(await readPersonVmDiskPreparationTarget(person, signal())).toBe(
    'version-source-unverified',
  );
  const proof = seen.find(({ query }) => query.includes('as verified'));
  expect(proof?.params).toEqual([
    org,
    workspace,
    assignedEmployee,
    version,
    first,
    person,
  ]);
  expect(proof?.query).toContain('audit.resource_id=v.id');
  expect(proof?.query).toContain("'admin_published_immutable_manifest'");
  expect(data.publication).not.toHaveBeenCalled();
});

it.each([
  [first, second],
  [second, first],
])(
  'skips the same person regardless of the ordering of known and unknown sources (%s, %s)',
  async (left, right) => {
    fixture([selection()], [], '3.x', false, false, [
      instance(left),
      instance(right),
    ]);
    data.employee.mockImplementation(async (_scope, employeeId) => ({
      id: employeeId,
      workspaceId: workspace,
      revision: 1,
      source:
        employeeId === first
          ? {
              kind: 'platform',
              employeeVersionId: id(11),
              templateRevisionId: id(12),
            }
          : { kind: 'tenant_version', employeeVersionId: version },
    }));
    data.publication.mockResolvedValue({ revision_id: id(12) });
    expect(await readPersonVmDiskPreparationTarget(person, signal())).toBe(
      'version-source-unverified',
    );
  },
);

it('terminates its dedicated transaction on cancellation and joins the current read', async () => {
  const { end } = fixture([selection()]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  data.principal.mockImplementationOnce(async () => {
    await gate;
    return { writable: true };
  });
  const controller = new AbortController();
  const result = readPersonVmDiskPreparationTarget(person, controller.signal);
  const finished = vi.fn();
  void result.then(finished, finished);
  try {
    await vi.waitFor(() => expect(data.principal).toHaveBeenCalledOnce());
    controller.abort(Error('read cancelled'));
    await vi.waitFor(() =>
      expect(end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 }),
    );
    expect(finished).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await expect(result).rejects.toThrow('read cancelled');
});
