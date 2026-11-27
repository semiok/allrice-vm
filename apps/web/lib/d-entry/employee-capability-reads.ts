import { isDeepStrictEqual } from 'node:util';
import {
  BrandMediaReadInputSchema,
  brandMediaModule,
  brandMediaRelease,
  type BrandMediaArticle,
  type BrandMediaReadResult,
} from '@allrice/contracts';
import {
  BrandMediaError,
  DataAccessError,
  EmployeeModuleError,
  ReferenceLibraryError,
  canUsePersonalEmployeeScenes,
  getEmployeeInstance,
  listEmployeeInstanceModules,
  listEmployeeSceneSkills,
  listPersonalSceneSkills,
  readBrandMedia,
  sameEmployeeModuleRelease,
} from '@allrice/database';
import { brandMediaErrorResponse } from '../brand-media/responses';
import { workbenchFileError, workbenchFileHeaders } from '../workbench-files';
import { requireEmployeePanelsContext } from './employee-panels-context';
import type { PanelRoute } from './employee-panels-http';

type Scope = Awaited<ReturnType<typeof requireEmployeePanelsContext>>;

function guardedRead(
  read: (
    scope: Scope,
    request: Request,
  ) => Promise<{
    data: unknown;
    recheck(current: Scope): Promise<void>;
  }>,
  businessError = workbenchFileError,
) {
  return async (request: Request, { params }: PanelRoute) => {
    try {
      const { panelEmployeeInstanceId } = await params;
      const scope = await requireEmployeePanelsContext(
        request,
        panelEmployeeInstanceId,
        false,
      );
      if (
        !scope.selection.threadId ||
        !request.headers.get('x-allrice-expected-viewer-id')
      )
        throw new DataAccessError('authorization_denied');
      const { data, recheck } = await read(scope, request);
      const { context } = await scope.current();
      // A current page identity does not establish current business access.
      await recheck({ ...scope, context });
      request.signal.throwIfAborted();
      return Response.json(data, { headers: workbenchFileHeaders });
    } catch (error) {
      const response =
        error instanceof ReferenceLibraryError
          ? workbenchFileError(error)
          : businessError(error);
      for (const [header, value] of Object.entries(workbenchFileHeaders))
        response.headers.set(header, value);
      return response;
    }
  };
}

async function sceneCatalog({ context, selection }: Scope) {
  const instanceId = selection.employeeInstanceId;
  const instance = await getEmployeeInstance(context, instanceId);
  if (await canUsePersonalEmployeeScenes(instance)) {
    const catalog = await listPersonalSceneSkills(context, instanceId);
    if (catalog.instanceId !== instanceId)
      throw new DataAccessError('authorization_denied');
    return { source: 'personal' as const, catalog };
  }
  const catalog = await listEmployeeSceneSkills(context, instanceId);
  if (catalog.instanceId !== instanceId)
    throw new DataAccessError('authorization_denied');
  return { source: 'published' as const, catalog };
}

function projectSceneCatalog({
  source,
  catalog,
}: Awaited<ReturnType<typeof sceneCatalog>>) {
  if (source === 'personal')
    return {
      source,
      instanceId: catalog.instanceId,
      revision: catalog.revision,
      skills: catalog.skills.map(
        ({ sceneId, name, description, version, revision }) => ({
          sceneId,
          name,
          description,
          version,
          revision,
        }),
      ),
    };
  return {
    source,
    instanceId: catalog.instanceId,
    skills: catalog.skills.map(
      ({ pin, scene, bundleVersion, bundleChecksum, contentChecksum }) => ({
        pin,
        name: scene.name,
        description: scene.appliesWhen,
        bundleVersion,
        bundleChecksum,
        contentChecksum,
      }),
    ),
  };
}

export const readCapabilityScenes = guardedRead(async (scope) => {
  const observed = await sceneCatalog(scope);
  return {
    data: projectSceneCatalog(observed),
    async recheck(current) {
      // The source readers still own package and reference access.
      if (!isDeepStrictEqual(observed, await sceneCatalog(current)))
        throw new DataAccessError('authorization_denied');
    },
  };
});

const moduleTarget = ({ selection }: Scope) => ({
  workspaceId: selection.workspaceId,
  instanceId: selection.employeeInstanceId,
});

/** Read through the module's owner gate as well as the D Entry page gate. */
async function currentBrandBinding(scope: Scope) {
  const target = moduleTarget(scope);
  const { modules } = await listEmployeeInstanceModules(scope.context, target);
  const entry = modules.find(
    ({ descriptor }) => descriptor.id === brandMediaRelease.moduleId,
  );
  const binding = entry?.binding;
  if (
    !entry?.enabled ||
    !binding ||
    binding.revokedAt ||
    !sameEmployeeModuleRelease(binding.release, brandMediaRelease)
  )
    return null;
  if (
    binding.ownerId !== scope.context.actor.id ||
    binding.organizationId !== scope.context.organizationId ||
    binding.workspaceId !== target.workspaceId ||
    binding.instanceId !== target.instanceId
  )
    throw new DataAccessError('authorization_denied');
  return binding;
}

async function requireSameBrandBinding(
  scope: Scope,
  expected: Awaited<ReturnType<typeof currentBrandBinding>>,
) {
  const current = await currentBrandBinding(scope);
  if (expected && !current) throw new EmployeeModuleError('module_unavailable');
  if (!isDeepStrictEqual(expected, current))
    throw new EmployeeModuleError('module_version_conflict');
}

export const readCapabilityModules = guardedRead(async (scope) => {
  const binding = await currentBrandBinding(scope);
  return {
    data: {
      instanceId: scope.selection.employeeInstanceId,
      modules: binding
        ? [
            {
              displayName: brandMediaModule.displayName,
              release: binding.release,
              revision: binding.revision,
            },
          ]
        : [],
    },
    recheck: (current) => requireSameBrandBinding(current, binding),
  };
}, brandMediaErrorResponse);

function savedArticle({
  id,
  topicId,
  title,
  revision,
  createdAt,
  updatedAt,
  publication,
}: BrandMediaArticle) {
  return {
    id,
    topicId,
    title,
    revision,
    createdAt,
    updatedAt,
    publication: { state: publication.state, schedule: publication.schedule },
  };
}

function projectBrandRecords(result: BrandMediaReadResult) {
  // Preserve saved record identities, titles and calendar facts. Bodies,
  // provenance and asset pins stay with the source reader.
  if (result.view === 'topics')
    return {
      view: result.view,
      items: result.items.map(
        ({ id, candidate, revision, createdAt, updatedAt }) => ({
          id,
          title: candidate.title,
          revision,
          createdAt,
          updatedAt,
        }),
      ),
      nextCursor: result.nextCursor,
    };
  if (result.view === 'article')
    return {
      view: result.view,
      article: savedArticle(result.article),
    };
  return {
    view: result.view,
    items: result.items.map(savedArticle),
    ...(result.view === 'articles' ? { nextCursor: result.nextCursor } : {}),
  };
}

export const readCapabilityBrandMedia = guardedRead(async (scope, request) => {
  const query = new URL(request.url).searchParams;
  query.delete('workspaceId');
  query.delete('threadId');
  if (query.has('instanceId'))
    throw new DataAccessError('authorization_denied');
  const { cursor, ...fields } = Object.fromEntries(query);
  const input = BrandMediaReadInputSchema.parse({
    ...moduleTarget(scope),
    ...fields,
    ...(cursor === undefined ? {} : { cursor: JSON.parse(cursor) }),
  });

  const binding = await currentBrandBinding(scope);
  if (!binding) throw new EmployeeModuleError('module_unavailable');
  const data = projectBrandRecords(await readBrandMedia(scope.context, input));
  return {
    data,
    async recheck(current) {
      const records = projectBrandRecords(
        await readBrandMedia(current.context, input),
      );
      if (!isDeepStrictEqual(data, records))
        throw new BrandMediaError('version_conflict');
      await requireSameBrandBinding(current, binding);
    },
  };
}, brandMediaErrorResponse);
