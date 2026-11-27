import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import {
  selectDEntryGeneration,
  type DEntryRolloutPolicy,
  type RequestContext,
} from '@allrice/contracts';
import {
  createDEntryIdentityResolver,
  DataAccessError,
  EmployeeInstanceError,
  IdentityError,
} from '@allrice/database';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { proxy } from '../../../../../proxy';
import { loginDestination } from '../../../../../lib/portal/login-destination';
import { GET } from './route';

const reads = vi.hoisted(() => ({
  context: vi.fn(),
  employee: vi.fn(),
  writable: vi.fn(),
  policy: vi.fn(),
  native: vi.fn(),
}));

vi.mock('../../../../../lib/identity/session', () => ({
  getRequestContext: reads.context,
}));
vi.mock(import('@allrice/database'), async (original) => ({
  ...(await original()),
  requireDEntryNativeIdentity: reads.native,
}));

const resolveIdentity = createDEntryIdentityResolver({
  getEmployeeInstance: reads.employee,
  getEmployeeInstanceForHistory: vi.fn(),
  requireCurrentWorkspaceWriteAuthority: reads.writable,
  authorizeSessionOwner: vi.fn(),
  authorizeSessionHistoryOwner: vi.fn(),
});

const origin = 'https://employees.example.test';
const selection = {
  workspaceId: randomUUID(),
  employeeInstanceId: randomUUID(),
};
const unrelatedEmployee = randomUUID();
const path = `/chatflow/4.0/${selection.workspaceId}/${selection.employeeInstanceId}`;
const context: RequestContext = {
  actor: { type: 'user', id: randomUUID() },
  organizationId: randomUUID(),
  workspaceId: selection.workspaceId,
  sessionId: randomUUID(),
  requestId: randomUUID(),
  memberships: [],
  authenticatedAt: new Date().toISOString(),
};
const policy = {
  revision: 'fixture',
  defaultGeneration: '3.x',
  selections: [
    {
      organizationId: context.organizationId,
      personId: context.actor.id,
    },
  ],
} satisfies DEntryRolloutPolicy;
const route = (
  params: Awaited<Parameters<typeof GET>[1]['params']> = selection,
  request = new Request(origin + path),
) => GET(request, { params: Promise.resolve(params) });

beforeEach(() => {
  vi.resetAllMocks();
  reads.context.mockResolvedValue(context);
  reads.employee.mockImplementation(async (_context, id) => {
    if (id !== selection.employeeInstanceId && id !== unrelatedEmployee)
      throw new DataAccessError('not_found');
    return {
      id,
      ownerId: id === unrelatedEmployee ? randomUUID() : context.actor.id,
      organizationId: context.organizationId,
      workspaceId: selection.workspaceId,
      revision: 1,
      source: { employeeVersionId: randomUUID() },
    };
  });
  reads.writable.mockResolvedValue(undefined);
  reads.policy.mockResolvedValue(policy);
  reads.native.mockImplementation(
    async (current: RequestContext, input: unknown) => {
      const identity = await resolveIdentity(current, input, 'execute');
      if (selectDEntryGeneration(await reads.policy(), identity) !== '4.0')
        throw new DataAccessError('authorization_denied');
      return identity;
    },
  );
});
afterEach(() => vi.unstubAllEnvs());

it('returns through the unified portal login to the exact entry and opens the authorized workbench', async () => {
  vi.stubEnv('ALLRICE_EMPLOYEE_PORTAL_HOSTS', 'employees.example.test');
  vi.stubEnv('ALLRICE_ADMIN_PORTAL_HOSTS', '');
  const requested = new NextRequest(origin + path, {
    headers: { host: 'employees.example.test' },
  });
  const auth = proxy(requested);
  expect(auth.status).toBe(307);
  const login = new URL(auth.headers.get('location')!);
  expect(login.origin + login.pathname).toBe(origin + '/login');
  const next = login.searchParams.get('next');
  expect(next).toBe(path);
  const destination = loginDestination(next, '/chatflow', origin, true);
  expect(destination).toBe(path);
  const original = new Request(origin + destination);
  const response = await route(selection, original);
  expect(reads.context).toHaveBeenCalledExactlyOnceWith(original);
  expect(reads.native).toHaveBeenCalledExactlyOnceWith(context, selection);
  expect(reads.employee).toHaveBeenCalledExactlyOnceWith(
    context,
    selection.employeeInstanceId,
  );
  expect(reads.writable).toHaveBeenCalledExactlyOnceWith(
    context,
    selection.workspaceId,
  );
  expect(reads.policy).toHaveBeenCalledTimes(1);
  expect(response.status).toBe(307);
  expect(response.headers.get('location')).toBe(
    `/chatflow/4.0?${new URLSearchParams(selection)}`,
  );
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});

it('constructs the login return from validated path IDs when the session is absent', async () => {
  const foreign = 'https://foreign.example.test/collect';
  reads.context.mockResolvedValueOnce(null);
  const response = await route(
    selection,
    new Request(`${origin}${path}?${new URLSearchParams({ next: foreign })}`),
  );
  expect(response.status).toBe(307);
  expect(response.headers.get('location')).toBe(
    `/login?${new URLSearchParams({ next: path })}`,
  );
  expect(loginDestination(foreign, '/chatflow', origin, true)).toBe(
    '/chatflow',
  );
  expect(reads.employee).not.toHaveBeenCalled();
});

it('returns identical denials for malformed, unavailable, foreign, and ineligible selections', async () => {
  const malformed = await route({
    ...selection,
    employeeInstanceId: '//foreign.example.test',
  });
  expect(reads.context).not.toHaveBeenCalled();
  const wrongWorkspace = await route({
    ...selection,
    workspaceId: randomUUID(),
  });
  const missing = await route({
    ...selection,
    employeeInstanceId: randomUUID(),
  });
  const foreign = await route({
    ...selection,
    employeeInstanceId: unrelatedEmployee,
  });
  reads.employee.mockRejectedValueOnce(
    new EmployeeInstanceError('instance_archived'),
  );
  const archived = await route();
  reads.writable.mockRejectedValueOnce(
    new IdentityError('authorization_denied'),
  );
  const revoked = await route();
  reads.policy.mockResolvedValueOnce({ ...policy, selections: [] });
  const ineligible = await route();
  for (const response of [
    malformed,
    wrongWorkspace,
    missing,
    foreign,
    archived,
    revoked,
    ineligible,
  ]) {
    expect(response.status).toBe(404);
    expect(Object.fromEntries(response.headers)).toEqual({
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
    });
    expect(await response.text()).toBe('');
  }
});
