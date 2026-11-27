import { DataAccessError, getEmployeeSkillCatalog } from '@allrice/database';
import { requireEmployeePanelsContext } from '../../../../../../../lib/d-entry/employee-panels-context';
import type { PanelRoute } from '../../../../../../../lib/d-entry/employee-panels-http';
import {
  workbenchFileError,
  workbenchFileHeaders,
} from '../../../../../../../lib/workbench-files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: PanelRoute) {
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
    const catalog = await getEmployeeSkillCatalog(
      scope.context,
      scope.selection.employeeInstanceId,
    );
    await scope.current();
    return Response.json(catalog, { headers: workbenchFileHeaders });
  } catch (error) {
    const response = workbenchFileError(error);
    for (const [header, value] of Object.entries(workbenchFileHeaders))
      response.headers.set(header, value);
    return response;
  }
}
