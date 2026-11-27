import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  brandMediaModule,
  brandMediaRelease,
  type DEntryIdentity,
  type EmployeeModuleBinding,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import type * as Database from '@allrice/database';
import { GET as brandMedia } from '../../app/api/v1/d-entry/panels/[panelEmployeeInstanceId]/brand-media/route';
import { GET as modules } from '../../app/api/v1/d-entry/panels/[panelEmployeeInstanceId]/modules/route';
import { GET as sceneSkills } from '../../app/api/v1/d-entry/panels/[panelEmployeeInstanceId]/scene-skills/route';

const ports = vi.hoisted(() => ({
  context: vi.fn(),
  authorize: vi.fn(),
  instance: vi.fn(),
  personalEligibility: vi.fn(),
  personalScenes: vi.fn(),
  publishedScenes: vi.fn(),
  modules: vi.fn(),
  brand: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  requireEmployeePanelsAccess: ports.authorize,
  getEmployeeInstance: ports.instance,
  canUsePersonalEmployeeScenes: ports.personalEligibility,
  listPersonalSceneSkills: ports.personalScenes,
  listEmployeeSceneSkills: ports.publishedScenes,
  listEmployeeInstanceModules: ports.modules,
  readBrandMedia: ports.brand,
}));
vi.mock('../identity/session', () => ({ getRequestContext: ports.context }));

const selection = {
  workspaceId: randomUUID(),
  employeeInstanceId: randomUUID(),
  threadId: randomUUID(),
};
const instanceId = selection.employeeInstanceId;
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
const target = { instanceId, workspaceId: selection.workspaceId };
const binding: EmployeeModuleBinding = {
  ...target,
  organizationId: identity.organizationId,
  ownerId: identity.personId,
  release: brandMediaRelease,
  revision: 3,
  enabledAt: '2026-11-01T00:00:00.000Z',
  revokedAt: null,
};
const directory = (current = binding) => ({
  modules: [
    {
      descriptor: brandMediaModule,
      binding: current,
      enabled: !current.revokedAt,
    },
  ],
});
const getByName = {
  'scene-skills': sceneSkills,
  modules,
  'brand-media': brandMedia,
};

function get(
  route: keyof typeof getByName,
  filters: Record<string, string | null> = {},
  viewerId: string | null = identity.personId,
) {
  const query = new URLSearchParams({
    workspaceId: selection.workspaceId,
    threadId: selection.threadId,
  });
  for (const [key, value] of Object.entries(filters)) {
    if (value === null) query.delete(key);
    else query.set(key, value);
  }
  const path = `/api/v1/d-entry/panels/${instanceId}/${route}?${query}`;
  return getByName[route](
    new Request('https://allrice.test' + path, {
      headers: viewerId ? { 'x-allrice-expected-viewer-id': viewerId } : {},
    }),
    { params: Promise.resolve({ panelEmployeeInstanceId: instanceId }) },
  );
}

beforeEach(() => {
  for (const port of Object.values(ports)) port.mockReset();
  ports.context.mockResolvedValue(context);
  ports.authorize.mockResolvedValue(identity);
  ports.instance.mockResolvedValue({ id: instanceId });
  ports.modules.mockResolvedValue(directory());
});

it.each(['scene-skills', 'modules', 'brand-media'] as const)(
  'rejects an unauthorized thread at the %s GET before reading business data',
  async (route) => {
    const threadId = randomUUID();
    ports.authorize.mockRejectedValueOnce(
      new DataAccessError('authorization_denied'),
    );
    const reply = await get(route, { threadId });
    expect(reply.status).toBe(403);
    expect(ports.authorize).toHaveBeenCalledWith(context, {
      ...selection,
      threadId,
    });
    expect(ports.instance).not.toHaveBeenCalled();
    expect(ports.modules).not.toHaveBeenCalled();
    expect(ports.brand).not.toHaveBeenCalled();
  },
);

it('requires a selected thread and expected viewer before reading the module directory', async () => {
  expect((await get('modules', { threadId: null })).status).toBe(403);
  expect((await get('modules', {}, null)).status).toBe(403);
  expect(ports.modules).not.toHaveBeenCalled();
});

it('reads the authorized personal workflow catalog without carrying runtime data', async () => {
  ports.personalEligibility.mockResolvedValue(true);
  const row = {
    sceneId: randomUUID(),
    name: 'Review reports',
    description: 'Review completed drafts',
    version: 'v1',
    revision: 2,
  };
  ports.personalScenes.mockResolvedValue({
    instanceId,
    revision: 4,
    skills: [
      {
        ...row,
        nativeName: 'private-runtime-name',
        metadata: { internal: true },
        content: 'hidden steps',
        resources: ['private/path'],
      },
    ],
  });
  const reply = await get('scene-skills');
  expect(reply.status).toBe(200);
  expect(reply.headers.get('cache-control')).toBe('private, no-store');
  expect(await reply.json()).toEqual({
    source: 'personal',
    instanceId,
    revision: 4,
    skills: [row],
  });
  expect(ports.personalScenes).toHaveBeenCalledWith(context, instanceId);
  expect(ports.publishedScenes).not.toHaveBeenCalled();
});

it('reads published workflow metadata through the published source and discards it when the employee changes', async () => {
  ports.personalEligibility.mockResolvedValue(false);
  const pin = {
    setId: randomUUID(),
    revisionId: randomUUID(),
    sceneId: randomUUID(),
    sourceRevisionId: randomUUID(),
  };
  const bundle = {
    bundleVersion: '1.0.1',
    bundleChecksum: 'sha256:' + 'a'.repeat(64),
    contentChecksum: 'sha256:' + 'b'.repeat(64),
  };
  const catalog = {
    instanceId,
    skills: [
      {
        pin,
        ...bundle,
        scene: {
          name: 'Scan accounts',
          appliesWhen: 'Monthly close',
          references: [{ internal: true }],
        },
        content: 'private steps',
      },
    ],
  };
  ports.publishedScenes.mockResolvedValue(catalog);
  const reply = await get('scene-skills');
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({
    source: 'published',
    instanceId,
    skills: [
      { pin, ...bundle, name: 'Scan accounts', description: 'Monthly close' },
    ],
  });
  expect(ports.personalScenes).not.toHaveBeenCalled();

  ports.publishedScenes.mockRejectedValueOnce(new DataAccessError('not_found'));
  const withdrawn = await get('scene-skills');
  expect(withdrawn.status).toBe(404);
  expect(await withdrawn.json()).not.toHaveProperty('skills');
  expect(ports.personalScenes).not.toHaveBeenCalled();

  ports.publishedScenes.mockImplementationOnce(async () => {
    ports.authorize.mockResolvedValue({ ...identity, employeeRevision: 2 });
    return catalog;
  });
  const stale = await get('scene-skills');
  expect(stale.status).toBe(403);
  expect(await stale.json()).not.toHaveProperty('skills');
  expect(ports.publishedScenes).toHaveBeenLastCalledWith(context, instanceId);
});

it('reports only the exact installed module revision for the scoped owner', async () => {
  const reply = await get('modules');
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({
    instanceId,
    modules: [
      {
        displayName: brandMediaModule.displayName,
        release: brandMediaRelease,
        revision: 3,
      },
    ],
  });
  expect(ports.modules).toHaveBeenCalledWith(context, target);

  ports.modules.mockResolvedValueOnce(
    directory({
      ...binding,
      release: { ...brandMediaRelease, digest: 'sha256:' + '0'.repeat(64) },
    }),
  );
  expect(await (await get('modules')).json()).toEqual({
    instanceId,
    modules: [],
  });
  ports.modules.mockResolvedValueOnce(
    directory({ ...binding, ownerId: randomUUID() }),
  );
  expect((await get('modules')).status).toBe(403);
});

const savedTopic = {
  id: randomUUID(),
  revision: 2,
  createdAt: '2026-10-01T01:00:01.200001Z',
  updatedAt: '2026-10-02T01:00:01.200001Z',
};
const topicPage = {
  view: 'topics',
  nextCursor: { id: savedTopic.id, createdAt: savedTopic.createdAt },
  items: [
    {
      ...savedTopic,
      candidate: { title: 'Saved idea', summary: 'Internal notes' },
      direction: 'Old input',
      sourceRunId: randomUUID(),
      references: [{ private: true }],
    },
  ],
};

it('reads pinned saved brand records without returning old runs, attachments, or generated text', async () => {
  ports.brand.mockResolvedValueOnce(topicPage);
  const reply = await get('brand-media', { view: 'topics' });
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({
    view: 'topics',
    nextCursor: topicPage.nextCursor,
    items: [{ ...savedTopic, title: 'Saved idea' }],
  });
  expect(ports.brand).toHaveBeenCalledWith(context, {
    ...target,
    view: 'topics',
  });
  expect(ports.modules).toHaveBeenCalledTimes(2);

  const article = {
    ...savedTopic,
    topicId: savedTopic.id,
    id: randomUUID(),
    title: 'Saved article',
  };
  const schedule = {
    plannedAt: '2026-12-01T08:00:00.000Z',
    timezone: 'Asia/Shanghai',
  };
  ports.brand.mockResolvedValueOnce({
    view: 'calendar',
    items: [
      {
        ...article,
        requirements: 'Old input',
        body: { objectId: randomUUID() },
        images: [{ internal: true }],
        publication: {
          state: 'published',
          schedule,
          links: { wechat: 'https://example.test' },
        },
      },
    ],
  });
  const calendar = await get('brand-media', {
    view: 'calendar',
    month: '2026-12',
    timezone: 'Asia/Shanghai',
  });
  expect(calendar.status).toBe(200);
  expect(await calendar.json()).toEqual({
    view: 'calendar',
    items: [{ ...article, publication: { state: 'published', schedule } }],
  });
});

it.each([
  {
    state: 'revoked',
    change: { revokedAt: '2026-11-27T00:00:00.000Z' },
    status: 403,
  },
  { state: 'changed', change: { revision: binding.revision + 1 }, status: 409 },
])(
  'withholds completed brand data when its binding was $state during the read',
  async ({ change, status }) => {
    ports.brand.mockImplementationOnce(async () => {
      ports.modules.mockResolvedValue(directory({ ...binding, ...change }));
      return topicPage;
    });
    const reply = await get('brand-media', { view: 'topics' });
    expect(reply.status).toBe(status);
    expect(reply.headers.get('cache-control')).toBe('private, no-store');
    expect(await reply.json()).not.toHaveProperty('items');
    expect(ports.brand).toHaveBeenCalledOnce();
    expect(ports.modules).toHaveBeenCalledTimes(2);
  },
);

it.each(['runs', 'help'])(
  'rejects the unexposed brand %s operation',
  async (view) => {
    expect((await get('brand-media', { view })).status).toBe(422);
    expect(ports.modules).not.toHaveBeenCalled();
    expect(ports.brand).not.toHaveBeenCalled();
  },
);
