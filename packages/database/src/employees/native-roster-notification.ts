import type postgres from 'postgres';

type RosterTable =
  'allrice_employee_assignments' | 'allrice_employee_instances';
type Workspace = { organizationId: string; workspaceId: string };
type Sql = postgres.Sql | postgres.TransactionSql;

/** The installed update/delete triggers already publish this channel.
 * Insertion owners publish the same hint inside their existing transaction. */
export function notifyNativeRosterInsert(
  sql: Sql,
  table: RosterTable,
  scope: Workspace & { personId: string },
) {
  return notifyNativeRosterInserts(sql, table, scope, [scope.personId]);
}

export async function notifyNativeRosterInserts(
  sql: Sql,
  table: RosterTable,
  scope: Workspace,
  people: readonly string[],
) {
  if (!people.length) return;
  await sql`select pg_notify('allrice_d_entry_authority', jsonb_build_object(
    'schema', current_schema(), 'table', ${table}::text, 'id', null,
    'organizationId', ${scope.organizationId}::text, 'workspaceId', ${scope.workspaceId}::text,
    'personId', person.id)::text) from unnest(${sql.array([...people])}::uuid[]) as person(id)`;
}
