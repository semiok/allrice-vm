import { DEntrySelectionInputSchema } from '@allrice/contracts';
import {
  DataAccessError,
  EmployeeInstanceError,
  IdentityError,
  requireDEntryNativeIdentity,
} from '@allrice/database';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const workbench = '/chatflow/4.0';
const employeeSelection = DEntrySelectionInputSchema.omit({ threadId: true });

function navigationResponse(status: 307 | 404 | 503, location?: string) {
  const headers = new Headers({
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
  });
  if (location) headers.set('location', location);
  return new Response(null, { status, headers });
}

/** The advertised DSH entry resolves the path to the authenticated workbench. */
export async function GET(
  request: Request,
  {
    params,
  }: { params: Promise<{ workspaceId: string; employeeInstanceId: string }> },
) {
  const selection = employeeSelection.safeParse(await params);
  if (!selection.success) return navigationResponse(404);
  const { workspaceId, employeeInstanceId } = selection.data;
  try {
    const context = await getRequestContext(request);
    if (!context) {
      const query = new URLSearchParams({
        next: `${workbench}/${workspaceId}/${employeeInstanceId}`,
      });
      return navigationResponse(307, `/login?${query}`);
    }
    await requireDEntryNativeIdentity(context, selection.data);
    const query = new URLSearchParams(selection.data);
    return navigationResponse(307, `${workbench}?${query}`);
  } catch (error) {
    if (
      error instanceof DataAccessError ||
      error instanceof IdentityError ||
      (error instanceof EmployeeInstanceError &&
        error.code === 'instance_archived')
    )
      return navigationResponse(404);
    return navigationResponse(503);
  }
}
