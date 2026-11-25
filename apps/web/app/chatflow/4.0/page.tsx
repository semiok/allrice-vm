import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { IdentityError } from '@allrice/database';
import { findDEntryEmployee } from '../../../lib/d-entry/entry-threads';
import { getRequestContext } from '../../../lib/identity/session';
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
    const result = await findDEntryEmployee(auth.context).then(
      (selection) => ({ selection, unavailable: false }),
      () => ({ selection: null, unavailable: true }),
    );
    return (
      <EmployeeNativePage
        query={
          result.selection
            ? new URLSearchParams(result.selection).toString()
            : ''
        }
        initialUnavailable={result.unavailable}
        prepare
      />
    );
  }
  return <EmployeeNativePage query={query.toString()} prepare />;
}
