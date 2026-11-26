\set ON_ERROR_STOP on
begin;
set local search_path = pg_catalog, public;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- This packet only accepts the private cluster created by rehearse.py.
create temporary table reset_input (organization uuid, person uuid, policy_format text);
insert into reset_input values (:'organization', :'person', :'policy_format');

create temporary table reset_rows (relation oid, location tid, primary key (relation, location));
create temporary table reset_edges as
select c.confrelid as parent, c.conrelid as child,
  string_agg(format('child.%I = parent.%I', a.attname, b.attname), ' and ' order by k.n) as predicate
from pg_constraint c
cross join lateral unnest(c.conkey, c.confkey) with ordinality as k(child_column, parent_column, n)
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.child_column
join pg_attribute b on b.attrelid = c.confrelid and b.attnum = k.parent_column
where c.contype = 'f'
group by c.oid;

do $$
declare
  target reset_input%rowtype;
  edge record;
  item record;
  old_policy jsonb;
  new_policy jsonb;
  retained jsonb;
  entry jsonb;
  marker jsonb;
  joins text;
  added integer;
  changed integer;
  total integer;
  approved constant regclass[] := array[
    'allrice_employee_instances','allrice_employee_instance_revisions',
    'allrice_employee_assignments','allrice_employees','allrice_employee_versions',
    'allrice_chat_sessions','allrice_messages','allrice_message_attachments',
    'allrice_file_references','allrice_runs','allrice_run_events','allrice_jobs',
    'allrice_employee_runs','allrice_employee_run_steps','allrice_context_checkpoints',
    'allrice_memories','allrice_memory_revisions','allrice_employee_memory_operations'
  ]::regclass[];
begin
  if current_database() <> 'snow_reset_restore' or inet_server_addr() is not null
    or current_setting('allrice.snow_rehearsal', true) is distinct from 'synthetic' then
    raise exception 'synthetic restore required';
  end if;
  select * into strict target from reset_input;
  if not exists (
    select 1 from allrice_users u join allrice_memberships m on m.user_id = u.id
    join allrice_organizations o on o.id = m.organization_id
    where u.id = target.person and u.username = 'snow' and u.status = 'active'
      and m.organization_id = target.organization and m.active
      and o.slug = 'snow-reset-fixture'
  ) then raise exception 'snow fixture identity mismatch'; end if;

  -- Do not use the legacy EmployeeHub GET, which can materialize a default employee.
  insert into reset_rows
    select tableoid, ctid from allrice_employee_instances
      where organization_id = target.organization and owner_id = target.person
    union all select tableoid, ctid from allrice_employee_assignments
      where organization_id = target.organization and user_id = target.person
    union all select tableoid, ctid from allrice_chat_sessions
      where organization_id = target.organization and owner_id = target.person
    union all select tableoid, ctid from allrice_runs
      where organization_id = target.organization and owner_id = target.person;
  -- The new creator stamps personal-<id> and the self-assignment's assigned_by.
  -- Generic deployment and version rows can be shared and are not roots.
  insert into reset_rows
    select distinct e.tableoid, e.ctid
    from allrice_employees e join allrice_employee_assignments a
      on (a.organization_id, a.workspace_id, a.employee_id) = (e.organization_id, e.workspace_id, e.id)
    where e.organization_id = target.organization and a.user_id = target.person
      and a.assigned_by = target.person and e.employee_key = 'personal-' || e.id;
  if exists (
    select 1 from allrice_runs r join reset_rows x on x.relation = r.tableoid and x.location = r.ctid
    where r.state not in ('succeeded', 'failed', 'cancelled')
  ) then raise exception 'snow has active runs'; end if;

  -- Compute incoming FK closure before any write. Discover even CASCADE and
  -- SET NULL references so a protected row cannot be silently changed.
  loop
    total := 0;
    for edge in select * from reset_edges where parent in (select relation from reset_rows) loop
      execute format(
        'insert into reset_rows select child.tableoid, child.ctid from %s child join %s parent on %s
         join reset_rows x on x.relation = parent.tableoid and x.location = parent.ctid on conflict do nothing',
        edge.child::regclass, edge.parent::regclass, edge.predicate);
      get diagnostics added = row_count;
      total := total + added;
    end loop;
    -- Message-derived Memory uses a polymorphic source ID without an FK.
    insert into reset_rows
      select m.tableoid, m.ctid from allrice_memories m join allrice_messages msg
        on m.source_type = 'message' and m.source_id = msg.id
      join reset_rows x on x.relation = msg.tableoid and x.location = msg.ctid
      on conflict do nothing;
    get diagnostics added = row_count;
    exit when total + added = 0;
  end loop;

  for item in select distinct relation from reset_rows loop
    if not (item.relation::regclass = any(approved)) then
      raise exception 'unreviewed dependent table: %', item.relation::regclass;
    end if;
    execute format(
      'select count(*) from %s r join reset_rows x on x.relation = r.tableoid and x.location = r.ctid
       where exists (select 1 from jsonb_each_text(to_jsonb(r)) f where
          (f.key = ''organization_id'' and f.value is distinct from $1) or
          (f.key in (''owner_id'', ''user_id'', ''person_id'') and f.value is distinct from $2))',
      item.relation::regclass) into changed using target.organization::text, target.person::text;
    if changed > 0 then raise exception 'cross-owner or cross-organization reference: %', item.relation::regclass; end if;
  end loop;
  if exists (
    select 1 from allrice_jobs j join reset_rows x on x.relation = j.tableoid and x.location = j.ctid
    where j.status not in ('succeeded', 'failed', 'dead_letter', 'canceled') or j.lease_token is not null
  ) then raise exception 'snow has active jobs'; end if;

  select value into strict old_policy from allrice_settings
    where scope_type = 'system' and scope_id is null and key = 'd_entry_rollout_policy' for update;
  if jsonb_typeof(old_policy->'selections') is distinct from 'array'
    or old_policy->>'defaultGeneration' is distinct from '3.x'
    or jsonb_typeof(old_policy->'revision') is distinct from 'string'
    or old_policy - array['selections','defaultGeneration','revision'] <> '{}'::jsonb then
    raise exception 'rollout policy shape is unsupported';
  end if;
  for entry in select value from jsonb_array_elements(old_policy->'selections') loop
    if jsonb_typeof(entry) <> 'object'
      or coalesce(entry->>'organizationId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      or coalesce(entry->>'personId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      or (entry - array['organizationId','personId'] <> '{}'::jsonb
        and (entry - array['organizationId','personId','employeeInstanceId','generation'] <> '{}'::jsonb
          or coalesce(entry->>'employeeInstanceId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
          or coalesce(entry->>'generation','') not in ('3.x','4.0'))) then
      raise exception 'rollout selection shape is unsupported';
    end if;
  end loop;
  select coalesce(jsonb_agg(selection order by position), '[]'::jsonb) into retained
    from jsonb_array_elements(old_policy->'selections') with ordinality as e(selection,position)
    where not (lower(selection->>'organizationId') = target.organization::text
      and lower(selection->>'personId') = target.person::text);
  marker := jsonb_build_object('organizationId',target.organization,'personId',target.person);
  if target.policy_format = 'person' then
    if exists (select 1 from jsonb_array_elements(retained) e where e ? 'employeeInstanceId') then
      raise exception 'other people still have tuples; wait for rollout owner cutover';
    end if;
    retained := retained || jsonb_build_array(marker);
  elsif target.policy_format is distinct from 'tuple-remove' then
    raise exception 'unsupported rollout format';
  end if;

  -- Exact deletion-only exceptions exercised only on the disposable restore.
  -- FKs and every other trigger stay enabled; the transaction restores the original four.
  alter table allrice_employee_instance_revisions disable trigger employee_instance_revision_immutable;
  alter table allrice_employee_versions disable trigger allrice_employee_versions_no_delete;
  alter table allrice_employee_runs disable trigger allrice_employee_runs_no_delete;
  alter table allrice_employee_run_steps disable trigger allrice_employee_run_steps_no_delete;
  loop
    total := 0;
    for item in select distinct relation from reset_rows loop
      select coalesce(string_agg(format('not exists (select 1 from %s child where %s)',
               child::regclass, predicate), ' and '), 'true') into joins
        from reset_edges where parent = item.relation;
      execute format(
        'with removed as (
           delete from %s parent using reset_rows x where parent.tableoid = x.relation
               and parent.ctid = x.location and (%s) returning parent.ctid as location
         ) delete from reset_rows x using removed r where x.relation = $1 and x.location = r.location',
         item.relation::regclass, joins) using item.relation;
      get diagnostics changed = row_count;
      total := total + changed;
    end loop;
    exit when not exists (select 1 from reset_rows);
    if total = 0 then raise exception 'dependency cycle or blocked delete'; end if;
  end loop;
  alter table allrice_employee_run_steps enable trigger allrice_employee_run_steps_no_delete;
  alter table allrice_employee_runs enable trigger allrice_employee_runs_no_delete;
  alter table allrice_employee_versions enable trigger allrice_employee_versions_no_delete;
  alter table allrice_employee_instance_revisions enable trigger employee_instance_revision_immutable;

  if retained is distinct from old_policy->'selections' then
    new_policy := jsonb_set(jsonb_set(old_policy,'{selections}',retained),'{revision}',to_jsonb(gen_random_uuid()));
    update allrice_settings set value = new_policy, updated_at = clock_timestamp()
      where scope_type = 'system' and scope_id is null and key = 'd_entry_rollout_policy';
  end if;
end $$;
commit;
