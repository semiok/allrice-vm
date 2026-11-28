import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  DEntryNativeDiscoverySchema,
  DEntrySelectionInputSchema,
  sameDEntryIdentity,
} from '@allrice/contracts';
import {
  getDEntryNativeRootPin,
  IdentityError,
  preparePersonNativeWebRoster,
} from '@allrice/database';
import {
  findDEntryCreationWorkspace,
  findDEntryEmployee,
} from '../../../lib/d-entry/entry-threads';
import { readStartupProfileAssetUrls } from '../../../lib/d-entry/released-profile-assets';
import { currentNativeRequest } from '../../../lib/d-entry/native-request';
import {
  readDEntryWorkerJson,
  requestDEntryWorker,
} from '../../../lib/d-entry/native-worker';
import { getRequestContext } from '../../../lib/identity/session';
import { EmployeeFirstStart } from './employee-first-start';
import { EmployeeNativePage } from './employee-native-page';

export const dynamic = 'force-dynamic';

async function readWarmEntry(query: URLSearchParams) {
  const selection = DEntrySelectionInputSchema.safeParse(
    Object.fromEntries(query),
  );
  if (
    !selection.success ||
    !selection.data.threadId ||
    [...query.keys()].some((key) => query.getAll(key).length !== 1)
  )
    return;
  try {
    const request = new Request('http://localhost/chatflow/4.0', {
      headers: await headers(),
      signal: AbortSignal.timeout(1_500),
    });
    const context = await getRequestContext(request);
    if (!context) return;
    const input = await currentNativeRequest(request, selection.data, context);
    const [root, discovery] = await Promise.all([
      getDEntryNativeRootPin(context, selection.data),
      requestDEntryWorker(input, 'native-owner').then((response) =>
        readDEntryWorkerJson(response, (value) =>
          DEntryNativeDiscoverySchema.strip().parse(value),
        ),
      ),
    ]);
    // Discovery is read-only. The socket must still own and admit the page.
    if (
      discovery.controlReady &&
      sameDEntryIdentity(discovery.identity, input.identity) &&
      sameDEntryIdentity(root.identity, input.identity)
    )
      return input.identity;
  } catch {
    // Cold or unavailable: start through the regular browser prewarm path.
  }
}

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
  const [startupAssetUrls, warmIdentity] = await Promise.all([
    readStartupProfileAssetUrls(),
    readWarmEntry(query),
  ]);
  return (
    <EmployeeNativePage
      query={query.toString()}
      startupAssetUrls={startupAssetUrls}
      warmIdentity={warmIdentity}
      prepare
    />
  );
}
