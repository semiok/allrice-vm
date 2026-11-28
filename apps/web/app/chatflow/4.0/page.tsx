import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { IdentityError, preparePersonNativeWebRoster } from '@allrice/database';
import {
  findDEntryCreationWorkspace,
  findDEntryEmployee,
} from '../../../lib/d-entry/entry-threads';
import { readStartupProfileAssetUrls } from '../../../lib/d-entry/released-profile-assets';
import { getRequestContext } from '../../../lib/identity/session';
import { EmployeeFirstStart } from './employee-first-start';
import { EmployeeNativePage } from './employee-native-page';

export const dynamic = 'force-dynamic';

export default async function EmployeeNativeEntryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    // Preserve duplicates and unknown keys for the strict entry parser.
    for (const item of Array.isArray(value)
      ? value
      : value === undefined
        ? []
        : [value])
      query.append(key, item);
  }
  if (!query.size) {
    const auth = await getRequestContext(
      new Request('http://localhost/chatflow/4.0', {
        headers: await headers(),
      }),
    ).then(
      (context) => ({ context, state: 'checked' as const }),
      (error: unknown) => ({
        context: null,
        state:
          error instanceof IdentityError &&
          ['tenant_context_invalid', 'authorization_denied'].includes(
            error.code,
          )
            ? ('denied' as const)
            : ('unavailable' as const),
      }),
    );
    if (auth.state !== 'checked')
      return (
        <EmployeeNativePage
          query=""
          initialUnavailable={auth.state === 'unavailable'}
          prepare
        />
      );
    if (!auth.context) redirect('/login?next=%2Fchatflow%2F4.0');
    const context = auth.context;
    try {
      let selection = await findDEntryEmployee(context);
      if (!selection && context.actor.type === 'user') {
        const workspaceId = await findDEntryCreationWorkspace(context);
        if (workspaceId) {
          // Existing assignments can precede their general instances.
          const { entries } = await preparePersonNativeWebRoster(context);
          if (
            !entries.some(
              (entry) =>
                !context.workspaceId ||
                entry.workspaceId === context.workspaceId,
            )
          )
            return (
              <EmployeeFirstStart
                organizationId={context.organizationId}
                workspaceId={workspaceId}
                viewerId={context.actor.id}
              />
            );
          selection = await findDEntryEmployee(context);
        }
      }
      return (
        <EmployeeNativePage
          query={selection ? new URLSearchParams(selection).toString() : ''}
          startupAssetUrls={
            selection ? await readStartupProfileAssetUrls() : []
          }
          prepare
        />
      );
    } catch {
      return <EmployeeNativePage query="" initialUnavailable prepare />;
    }
  }
  return (
    <EmployeeNativePage
      query={query.toString()}
      startupAssetUrls={await readStartupProfileAssetUrls()}
      prepare
    />
  );
}
