import type postgres from 'postgres';

/** The installed update/delete triggers already publish this channel.
 * Insertion owners publish the same hint inside their existing transaction. */
export async function notifyNativeRosterInsert(
  sql: postgres.Sql | postgres.TransactionSql,
  table: 'allrice_employee_assignments' | 'allrice_employee_instances',
  scope: { organizationId: string; workspaceId: string; personId?: string },
) {
  await sql`select pg_notify('allrice_d_entry_authority', jsonb_build_object(
    'schema', current_schema(), 'table', ${table}::text, 'id', null,
    'organizationId', ${scope.organizationId}::text, 'workspaceId', ${scope.workspaceId}::text,
    'personId', ${scope.personId ?? null}::text)::text)`;
}
