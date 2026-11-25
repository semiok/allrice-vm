import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
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
    const context = await getRequestContext(
      new Request('http://localhost/chatflow/4.0', {
        headers: await headers(),
      }),
    );
    if (!context) redirect('/login?next=%2Fchatflow%2F4.0');
    const result = await findDEntryEmployee(context).then(
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
