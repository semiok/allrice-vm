import {
  BrandMediaReadInputSchema,
  brandMediaModule,
  brandMediaRelease,
  type BrandMediaArticle,
} from '@allrice/contracts';
import {
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
  read: (scope: Scope, request: Request) => Promise<unknown>,
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
      const result = await read(scope, request);
      await scope.current();
      return Response.json(result, { headers: workbenchFileHeaders });
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

export const readCapabilityScenes = guardedRead(
  async ({ context, selection }) => {
    const instanceId = selection.employeeInstanceId;
    const instance = await getEmployeeInstance(context, instanceId);
    if (await canUsePersonalEmployeeScenes(instance)) {
      const catalog = await listPersonalSceneSkills(context, instanceId);
      if (catalog.instanceId !== instanceId)
        throw new DataAccessError('authorization_denied');
      return {
        source: 'personal' as const,
        instanceId,
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
    }
    const catalog = await listEmployeeSceneSkills(context, instanceId);
    if (catalog.instanceId !== instanceId)
      throw new DataAccessError('authorization_denied');
    return {
      source: 'published' as const,
      instanceId,
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
  },
);

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

export const readCapabilityModules = guardedRead(async (scope) => {
  const binding = await currentBrandBinding(scope);
  return {
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
  const result = await readBrandMedia(scope.context, input);
  const current = await currentBrandBinding(scope);
  if (!current) throw new EmployeeModuleError('module_unavailable');
  if (current.revision !== binding.revision)
    throw new EmployeeModuleError('module_version_conflict');

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
}, brandMediaErrorResponse);
