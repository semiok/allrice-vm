import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { type DEntryIdentity, type RequestContext } from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import type * as Database from '@allrice/database';
import { GET } from '../../app/api/v1/d-entry/panels/[panelEmployeeInstanceId]/skills/route';
import { skillTestCatalog } from '../../test/employee-skills-host-data';

const ports = vi.hoisted(() => ({
  context: vi.fn(),
  authorize: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  requireEmployeePanelsAccess: ports.authorize,
  getEmployeeSkillCatalog: ports.catalog,
}));
vi.mock('../identity/session', () => ({ getRequestContext: ports.context }));

const selection = {
  workspaceId: randomUUID(),
  employeeInstanceId: randomUUID(),
  threadId: randomUUID(),
};
const identity: DEntryIdentity = {
  ...selection,
  organizationId: randomUUID(),
  personId: randomUUID(),
  employeeRevision: 1,
  employeeVersionId: randomUUID(),
};
const context: RequestContext = {
  requestId: randomUUID(),
  sessionId: randomUUID(),
  actor: { type: 'user', id: identity.personId },
  organizationId: identity.organizationId,
  workspaceId: selection.workspaceId,
  memberships: [],
  authenticatedAt: new Date().toISOString(),
};
const catalog = skillTestCatalog(
  selection.employeeInstanceId,
  selection.workspaceId,
);

function get(
  threadId: string | null = selection.threadId,
  viewerId: string | null = identity.personId,
) {
  const query = new URLSearchParams({ workspaceId: selection.workspaceId });
  if (threadId) query.set('threadId', threadId);
  const path = `/api/v1/d-entry/panels/${selection.employeeInstanceId}/skills?${query}`;
  return GET(
    new Request('https://allrice.test' + path, {
      headers: viewerId ? { 'x-allrice-expected-viewer-id': viewerId } : {},
    }),
    {
      params: Promise.resolve({
        panelEmployeeInstanceId: selection.employeeInstanceId,
      }),
    },
  );
}

beforeEach(() => {
  ports.context.mockReset().mockResolvedValue(context);
  ports.authorize.mockReset().mockResolvedValue(identity);
  ports.catalog.mockReset().mockResolvedValue(catalog);
});

it('reads only with the current 4.0 thread and rechecks that selection before exposing the catalog', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual(catalog);
  expect(ports.catalog.mock.calls).toEqual([
    [context, selection.employeeInstanceId],
  ]);
  expect(ports.authorize.mock.calls).toEqual([
    [context, selection],
    [context, selection],
    [context, selection],
  ]);
});

it.each([
  { missing: 'thread', threadId: null, viewerId: identity.personId },
  { missing: 'expected viewer', threadId: selection.threadId, viewerId: null },
])(
  'rejects the omitted $missing before reading the catalog',
  async ({ threadId, viewerId }) => {
    const response = await get(threadId, viewerId);
    expect(response.status).toBe(403);
    expect(ports.catalog).not.toHaveBeenCalled();
  },
);

it('rejects a thread refused by the existing 4.0 panel authority', async () => {
  const otherThread = randomUUID();
  ports.authorize.mockRejectedValueOnce(
    new DataAccessError('authorization_denied'),
  );
  const response = await get(otherThread);
  expect(response.status).toBe(403);
  expect(ports.authorize).toHaveBeenCalledWith(context, {
    ...selection,
    threadId: otherThread,
  });
  expect(ports.catalog).not.toHaveBeenCalled();
});

it('discards a completed catalog if employee authority changes during the read', async () => {
  ports.catalog.mockImplementationOnce(async () => {
    ports.authorize.mockResolvedValue({ ...identity, employeeRevision: 2 });
    return catalog;
  });
  const response = await get();
  expect(response.status).toBe(403);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const problem = await response.json();
  expect(problem).toMatchObject({ error: { code: 'AUTHORIZATION_DENIED' } });
  expect(problem).not.toHaveProperty('personalSkills');
  expect(ports.catalog).toHaveBeenCalledOnce();
  expect(ports.authorize).toHaveBeenCalledTimes(3);
});
