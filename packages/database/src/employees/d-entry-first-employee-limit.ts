import type postgres from 'postgres';

/** Read the temporary first-employee limit after the caller establishes current write authority. */
export async function readFirstEmployeeLimit(
  sql: postgres.Sql | postgres.TransactionSql,
  personId: string,
) {
  const [row] = await sql<{ blocked: boolean }[]>`select
    exists(select 1 from allrice_employee_instances where owner_id=${personId})
    or exists(select 1 from allrice_employee_assignments where user_id=${personId} and active)
    or exists(select 1 from person_virtual_machines
      where person_id=${personId} and (phase<>'deleted' or disk_retained))
    as blocked`;
  return row?.blocked !== false;
}
