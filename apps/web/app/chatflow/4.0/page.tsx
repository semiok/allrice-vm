import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { DEntrySelectionInputSchema } from '@allrice/contracts';
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
import { publicProfileModules } from '../../../lib/d-entry/public-profile-warmup';
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
  const cancellation = new AbortController();
  const { signal } = cancellation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        cancellation.abort();
        resolve(undefined);
      }, 1_500);
    });
    const discover = async () => {
      const requestHeaders = await headers();
      if (requestHeaders.get('sec-fetch-dest') !== 'document') return;
      const request = new Request('http://localhost/chatflow/4.0', {
        headers: requestHeaders,
        signal,
      });
      const context = await getRequestContext(request);
      signal.throwIfAborted();
      if (!context) return;
      const root = await getDEntryNativeRootPin(context, selection.data, {
        runningSnapshot: true,
      });
      signal.throwIfAborted();
      // This only identifies a known thread. The existing socket checks the
      // current editor proof before admitting the warm attempt.
      return root.identity;
    };
    return await Promise.race([discover(), deadline]);
  } catch {
    // Cold or unavailable: start through the regular browser prewarm path.
  } finally {
    clearTimeout(timer);
    cancellation.abort();
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
  const page = (
    <EmployeeNativePage
      query={query.toString()}
      startupAssetUrls={startupAssetUrls}
      warmIdentity={warmIdentity}
      prepare
    />
  );
  const modules = warmIdentity ? publicProfileModules(startupAssetUrls) : [];
  return modules.length ? (
    <>
      {modules.map((url) => (
        <link key={url} rel="modulepreload" href={url} />
      ))}
      {page}
    </>
  ) : (
    page
  );
}
