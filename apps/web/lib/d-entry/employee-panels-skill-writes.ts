import {
  PersonalSkillConfirmRequestSchema,
  PersonalSkillRemoveRequestSchema,
  PersonalSkillRemoveResponseSchema,
  UuidSchema,
  sameDEntryIdentity,
} from '@allrice/contracts';
import {
  DataAccessError,
  PersonalSkillError,
  ReferenceLibraryError,
  managePersonalSkill,
  requireEmployeePanelsAccess,
} from '@allrice/database';
import { FileArchiveError } from '@allrice/file-archives';
import { SkillPreviewError } from '@allrice/skill-import';
import { apiProblem } from '../api-problem';
import { employeeHubErrorResponse } from '../employeehub/responses';
import { confirmPersonalSkillSource } from '../skills/personal-skill-confirm';
import { readSkillConfirmationRequest } from '../skills/preview-request';
import { addSkillSourceErrorReason } from '../skills/source-error-reason';
import { workbenchFileHeaders } from '../workbench-files';
import { requireEmployeePanelsContext } from './employee-panels-context';
import type { PanelRoute } from './employee-panels-http';

async function requireSkillWrite(request: Request, instanceId: string) {
  const scope = await requireEmployeePanelsContext(request, instanceId, true);
  if (
    !scope.selection.threadId ||
    !request.headers.get('x-allrice-expected-viewer-id')
  )
    throw new DataAccessError('authorization_denied');
  const { context, identity } = await scope.current();
  if (!context.sessionId) throw new DataAccessError('authentication_required');
  const requireCurrentAccess: NonNullable<
    Parameters<typeof managePersonalSkill>[2]
  > = async (candidate, target, tx) => {
    request.signal.throwIfAborted();
    if (
      target !== identity.employeeInstanceId ||
      candidate.sessionId !== context.sessionId
    )
      throw new DataAccessError('authorization_denied');
    const current = await requireEmployeePanelsAccess(
      candidate,
      scope.selection,
      tx,
    );
    if (!sameDEntryIdentity(current, identity))
      throw new DataAccessError('authorization_denied');
    request.signal.throwIfAborted();
  };
  return { context, requireCurrentAccess };
}

function skillWriteError(error: unknown, operation: 'confirm' | 'disable') {
  let response: Response;
  if (error instanceof SkillPreviewError || error instanceof FileArchiveError)
    response = apiProblem({
      status: 422,
      code: 'VALIDATION_FAILED',
      retryable: false,
      message: '技能预览已失效或内容不完整，请重新读取后确认。',
    });
  else if (error instanceof PersonalSkillError) {
    const unavailable = error.code === 'unavailable';
    response = apiProblem({
      status: unavailable ? 404 : 409,
      code: unavailable ? 'RESOURCE_NOT_FOUND' : 'VERSION_CONFLICT',
      retryable: false,
      message:
        error.code === 'name_conflict'
          ? '技能 name 已存在或与原技能不同，请检查后重新读取。'
          : error.code === 'limit'
            ? '技能数量或版本已达到上限，请先检查当前安装。'
            : '技能状态或权限已变化，请刷新后重试。',
    });
  } else if (
    error instanceof ReferenceLibraryError &&
    error.code === 'request_conflict'
  ) {
    response = apiProblem({
      status: 409,
      code: 'CONFLICT',
      message: '当前登录身份已变化，请刷新后重试。',
      retryable: false,
    });
  } else response = employeeHubErrorResponse(error);
  for (const [header, value] of Object.entries(workbenchFileHeaders))
    response.headers.set(header, value);
  return operation === 'confirm'
    ? addSkillSourceErrorReason(response, error, 'confirm')
    : response;
}

export async function confirmEmployeePanelSkill(
  request: Request,
  { params }: PanelRoute,
) {
  try {
    const { panelEmployeeInstanceId } = await params;
    const scope = await requireSkillWrite(request, panelEmployeeInstanceId);
    const input = PersonalSkillConfirmRequestSchema.parse(
      await readSkillConfirmationRequest(request),
    );
    if (input.workspaceId !== scope.context.workspaceId)
      throw new DataAccessError('authorization_denied');
    const result = await confirmPersonalSkillSource(
      scope.context,
      panelEmployeeInstanceId,
      input,
      request.signal,
      scope.requireCurrentAccess,
    );
    return Response.json(result, { headers: workbenchFileHeaders });
  } catch (error) {
    return skillWriteError(error, 'confirm');
  }
}

export async function disableEmployeePanelSkill(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      panelEmployeeInstanceId: string;
      installationId: string;
    }>;
  },
) {
  try {
    const target = await params;
    const instanceId = target.panelEmployeeInstanceId;
    const scope = await requireSkillWrite(request, instanceId);
    const installationId = UuidSchema.parse(target.installationId);
    const input = PersonalSkillRemoveRequestSchema.parse(await request.json());
    if (input.workspaceId !== scope.context.workspaceId)
      throw new DataAccessError('authorization_denied');
    const skill = await managePersonalSkill(
      scope.context,
      { ...input, instanceId, installationId, operation: 'disable' },
      scope.requireCurrentAccess,
    );
    const binding = skill.bindings.find(
      (item) => item.instanceId === instanceId,
    );
    if (!binding || binding.enabled) throw new PersonalSkillError('conflict');
    return Response.json(
      PersonalSkillRemoveResponseSchema.parse({
        receipt: {
          operation: 'disable',
          scope: 'instance',
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          instanceId,
          installationId,
          revision: skill.revision,
          versionId: skill.versionId,
          binding,
        },
      }),
      { headers: workbenchFileHeaders },
    );
  } catch (error) {
    return skillWriteError(error, 'disable');
  }
}
