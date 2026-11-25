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
    // Preserve duplicates/unknown keys for the authenticated document's strict
    // parser. The page neither resolves identity nor silently repairs input.
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
    const selection = await findDEntryEmployee(context);
    if (selection)
      return (
        <EmployeeNativePage
          query={new URLSearchParams(selection).toString()}
          prepare
        />
      );
    return <EmployeeNativePage query="" prepare />;
  }
  return <EmployeeNativePage query={query.toString()} prepare />;
}
