\set ON_ERROR_STOP on
begin isolation level serializable;
set local search_path = pg_catalog, public;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- This packet only accepts the private cluster created by rehearse.py.
create temporary table reset_input (
  phase text, mode text, approved_accounts jsonb, expected_policy jsonb
) on commit drop;
insert into reset_input values (:'phase', :'mode', :'approved_accounts', :'expected_policy');

create temporary table reset_accounts (
  account text primary key, organization uuid, workspace uuid, person uuid unique, username text unique
) on commit drop;
insert into reset_accounts values
  ('snow', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000002', 'snow'),
  ('acceptance', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000004', 'acceptance');

create temporary table reset_receipt (result jsonb);

create temporary table reset_rows (relation oid, location tid, primary key (relation, location)) on commit drop;
create temporary table reset_edges on commit drop as
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
  request reset_input%rowtype;
  target reset_accounts%rowtype;
  selected reset_accounts%rowtype;
  edge record;
  item record;
  guard record;
  old_policy jsonb;
  next_selections jsonb := '[]'::jsonb;
  entry jsonb;
  seen_accounts text[] := array[]::text[];
  seen_people text[] := array[]::text[];
  selection_key text;
  row_counts jsonb;
  native_conflict text;
  joins text;
  added integer;
  changed integer;
  total integer;
  approved constant regclass[] := array[
    'allrice_employee_instances','allrice_employee_instance_revisions',
    'allrice_employee_assignments','allrice_employee_user_profiles','allrice_employees','allrice_employee_versions',
    'allrice_chat_sessions','allrice_messages','allrice_chat_input_requests','allrice_message_attachments',
    'allrice_file_references','allrice_runs','allrice_run_events','allrice_jobs',
    'allrice_employee_runs','allrice_employee_run_steps','allrice_context_checkpoints',
    'allrice_memories','allrice_memory_revisions','allrice_employee_memory_operations'
  ]::regclass[];
begin
  if current_database() <> 'snow_reset_restore' or inet_server_addr() is not null
    or current_setting('listen_addresses') <> ''
    or current_setting('allrice.snow_rehearsal', true) is distinct from 'synthetic' then
    raise exception 'synthetic restore required';
  end if;
  select * into strict request from reset_input;
  if request.phase is null or request.phase not in ('snow', 'cutover', 'acceptance')
    or request.mode is null or request.mode not in ('plan', 'apply') then
    raise exception 'unsupported reset phase or mode';
  end if;
  if request.approved_accounts is distinct from (
    select jsonb_object_agg(account, jsonb_build_object(
      'organizationId', organization, 'workspaceId', workspace, 'personId', person, 'username', username))
    from reset_accounts
  ) then raise exception 'approved fixture account list mismatch'; end if;
  if exists (
    select 1 from reset_accounts a where not exists (
      select 1 from allrice_users u join allrice_memberships m on m.user_id = u.id
      join allrice_organizations o on o.id = m.organization_id
      join allrice_workspaces w on (w.organization_id, w.id) = (m.organization_id, m.workspace_id)
      where u.id = a.person and u.username collate "C" = a.username collate "C" and u.status = 'active'
        and (m.organization_id, m.workspace_id) = (a.organization, a.workspace) and m.active
        and o.slug = 'snow-reset-fixture' and o.archived_at is null
        and w.slug = 'main' and w.archived_at is null
    )
  ) then raise exception 'fixture account or membership mismatch'; end if;

  -- The cutover can proceed only after Snow has no remaining business rows.
  select * into strict target from reset_accounts
    where account = case when request.phase = 'acceptance' then 'acceptance' else 'snow' end;

  if exists (
    select 1 from allrice_employee_instances where owner_id = target.person
      and (organization_id, workspace_id) is distinct from (target.organization, target.workspace)
    union all select 1 from allrice_employee_assignments where user_id = target.person
      and (organization_id, workspace_id) is distinct from (target.organization, target.workspace)
  ) then raise exception 'employee data outside approved workspace or organization'; end if;

  -- Do not use the legacy EmployeeHub GET, which can materialize a default employee.
  insert into reset_rows
    select tableoid, ctid from allrice_employee_instances
      where (organization_id, workspace_id, owner_id) = (target.organization, target.workspace, target.person)
    union all select tableoid, ctid from allrice_employee_assignments
      where (organization_id, workspace_id, user_id) = (target.organization, target.workspace, target.person)
    union all select tableoid, ctid from allrice_employee_user_profiles
      where (organization_id, workspace_id, user_id) = (target.organization, target.workspace, target.person)
    union all select tableoid, ctid from allrice_chat_sessions
      where (organization_id, workspace_id, owner_id) = (target.organization, target.workspace, target.person)
    union all select tableoid, ctid from allrice_runs
      where (organization_id, workspace_id, owner_id) = (target.organization, target.workspace, target.person);
  -- The new creator stamps personal-<id> and the self-assignment's assigned_by.
  -- Generic deployment and version rows can be shared and are not roots.
  insert into reset_rows
    select distinct e.tableoid, e.ctid
    from allrice_employees e join allrice_employee_assignments a
      on (a.organization_id, a.workspace_id, a.employee_id) = (e.organization_id, e.workspace_id, e.id)
    where (e.organization_id, e.workspace_id, a.user_id) = (target.organization, target.workspace, target.person)
      and a.assigned_by = target.person and e.employee_key = 'personal-' || e.id;

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
          (f.key = ''workspace_id'' and f.value is distinct from $2) or
          (f.key in (''owner_id'', ''user_id'', ''person_id'') and f.value is distinct from $3))',
      item.relation::regclass) into changed using target.organization::text, target.workspace::text, target.person::text;
    if changed > 0 then raise exception 'cross-owner, workspace or organization reference: %', item.relation::regclass; end if;
  end loop;
  -- Some legacy FKs pin a workspace and ID but omit the owning person.
  -- Never remove an extension whose personal parent belongs to another user.
  for edge in select * from reset_edges where child in (select relation from reset_rows)
    and parent in ('allrice_employee_instances'::regclass, 'allrice_employee_assignments'::regclass,
      'allrice_chat_sessions'::regclass, 'allrice_messages'::regclass,
      'allrice_runs'::regclass, 'allrice_employee_runs'::regclass, 'allrice_memories'::regclass)
  loop
    execute format(
      'select count(*) from %s child join %s parent on %s
       join reset_rows x on x.relation = child.tableoid and x.location = child.ctid
       where not exists (select 1 from reset_rows p where p.relation = parent.tableoid and p.location = parent.ctid)',
      edge.child::regclass, edge.parent::regclass, edge.predicate) into changed;
    if changed > 0 then raise exception 'outside-scope personal parent: %', edge.parent::regclass; end if;
  end loop;

  -- Compare typed reference paths against planned rows, even when the
  -- reference claims a different person or version than its relational row.
  with planned_threads as (
    select s.id from allrice_chat_sessions s
    join reset_rows x on x.relation = s.tableoid and x.location = s.ctid
  ), planned_instances as (
    select i.id from allrice_employee_instances i
    join reset_rows x on x.relation = i.tableoid and x.location = i.ctid
  ), planned_versions as (
    select v.id from allrice_employee_versions v
    join reset_rows x on x.relation = v.tableoid and x.location = v.ctid
  ), planned_employees as (
    select e.id from allrice_employees e
    join reset_rows x on x.relation = e.tableoid and x.location = e.ctid
  )
  select case
    when exists (
      select 1 from allrice_chat_sessions s
      cross join lateral (values (s.d_entry_native_root_claim), (s.d_entry_native_root)) as root(pin)
      where root.pin is not null and s.id not in (select id from planned_threads)
        and (lower(root.pin#>>'{identity,threadId}') in (select id::text from planned_threads)
          or lower(root.pin#>>'{identity,employeeInstanceId}') in (select id::text from planned_instances)
          or lower(root.pin#>>'{identity,employeeVersionId}') in (select id::text from planned_versions))
    ) then 'D entry native root'
    when exists (
      select 1 from allrice_chat_sessions s
      where s.native_root_origin->>'contextKind' = 'chat' and s.id not in (select id from planned_threads)
        and (lower(s.native_root_origin->>'contextId') in (select id::text from planned_threads)
          or lower(case s.native_root_origin->>'schemaVersion'
            when '1' then s.native_root_origin#>>'{frozenIdentity,sourceId}'
            when '2' then s.native_root_origin#>>'{birthSource,employeeVersionId}'
          end) in (select id::text from planned_versions))
    ) then 'legacy native root'
    when exists (
      select 1 from allrice_native_session_bindings b
      where b.context_kind = 'chat' and b.context_id in (select id from planned_threads)
    ) then 'native chat binding'
    when exists (
      select 1 from allrice_employee_memory_contexts m
      where m.thread_id in (select id from planned_threads)
        or m.instance_id in (select id from planned_instances)
        or m.employee_id in (select id from planned_employees)
    ) then 'employee memory context'
    when exists (
      select 1 from allrice_native_schedule_observation_receipts r
      where r.employee_instance_id in (select id from planned_instances)
        or lower(r.input_payload#>>'{origin,employeeVersionId}') in (select id::text from planned_versions)
    ) then 'native schedule observation receipt'
  end into native_conflict;
  if native_conflict is not null then
    raise exception 'retained % references a planned deletion', native_conflict;
  end if;

  if exists (
    select 1 from allrice_message_attachments a
    join reset_rows x on x.relation = a.tableoid and x.location = a.ctid
    where a.attached_by <> target.person
  ) then raise exception 'target attachment belongs to another account'; end if;
  if exists (
    select 1 from allrice_memories m join reset_rows x on x.relation = m.tableoid and x.location = m.ctid
    where m.source_type = 'message' and not exists (
      select 1 from allrice_messages msg
      join reset_rows y on y.relation = msg.tableoid and y.location = msg.ctid
      where msg.id = m.source_id
    )
  ) then raise exception 'outside-scope or unresolved source message'; end if;
  if exists (
    select 1 from allrice_runs r join reset_rows x on x.relation = r.tableoid and x.location = r.ctid
    where r.state not in ('succeeded', 'failed', 'canceled')
  ) then raise exception 'target has active runs'; end if;
  if exists (
    select 1 from allrice_jobs j join reset_rows x on x.relation = j.tableoid and x.location = j.ctid
    where j.status not in ('succeeded', 'failed', 'dead_letter', 'canceled') or j.lease_token is not null
  ) then raise exception 'target has active jobs'; end if;

  select coalesce(jsonb_object_agg(relation::regclass::text, row_count), '{}'::jsonb) into row_counts
  from (select relation, count(*) as row_count from reset_rows group by relation) counts;
  insert into reset_receipt values (jsonb_build_object(
    'phase', request.phase, 'mode', request.mode, 'account', target.account, 'rows', row_counts));

  if request.phase = 'cutover' and row_counts <> '{}'::jsonb then
    raise exception 'snow business rows are not zero';
  end if;

  -- Host owns every VM write. This is only a database-side prerequisite for apply.
  if request.mode = 'apply' and (
    exists (select 1 from person_virtual_machines where person_id = target.person
      and (organization_id <> target.organization or phase <> 'deleted' or disk_retained
        or lease_owner is not null or holds <> '[]'::jsonb or egress_receipt is not null))
    or exists (select 1 from person_vm_admission_permits where person_id = target.person)
  ) then raise exception 'target VM state or admission is not cleared'; end if;

  if request.phase = 'cutover' or (request.phase = 'acceptance' and request.mode = 'apply') then
    -- Protect the whole existing setting, including unrelated entries and revision.
    select value into strict old_policy from allrice_settings
      where scope_type = 'system' and scope_id is null and key = 'd_entry_rollout_policy' for update;
    if old_policy is distinct from request.expected_policy then
      raise exception 'rollout policy changed since approved snapshot';
    end if;
    if jsonb_typeof(old_policy->'selections') is distinct from 'array'
      or old_policy->>'defaultGeneration' is distinct from '3.x'
      or jsonb_typeof(old_policy->'revision') is distinct from 'string'
      or old_policy->>'revision' = ''
      or old_policy - array['selections','defaultGeneration','revision'] <> '{}'::jsonb then
      raise exception 'rollout policy shape is unsupported';
    end if;
    for entry in select e.value from jsonb_array_elements(old_policy->'selections')
      with ordinality as e(value, position) order by e.position
    loop
      if jsonb_typeof(entry) is distinct from 'object'
        or coalesce(entry->>'organizationId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        or coalesce(entry->>'personId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        or (entry - array['organizationId','personId'] <> '{}'::jsonb
          and (entry - array['organizationId','personId','employeeInstanceId','generation'] <> '{}'::jsonb
            or coalesce(entry->>'employeeInstanceId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
            or coalesce(entry->>'generation','') not in ('3.x','4.0'))) then
        raise exception 'rollout selection shape is unsupported';
      end if;
      select * into selected from reset_accounts
        where organization::text = lower(entry->>'organizationId') and person::text = lower(entry->>'personId');
      if found then
        if not (selected.account = any(seen_accounts)) then
          seen_accounts := array_append(seen_accounts, selected.account);
          next_selections := next_selections || jsonb_build_object(
            'organizationId', selected.organization, 'personId', selected.person);
        end if;
      else
        if entry ? 'employeeInstanceId' then
          raise exception 'unapproved account still has a rollout tuple';
        end if;
        selection_key := (entry->>'organizationId') || '/' || (entry->>'personId');
        if selection_key <> lower(selection_key) or selection_key = any(seen_people) then
          raise exception 'unapproved person selection is not canonical or unique';
        end if;
        seen_people := array_append(seen_people, selection_key);
        next_selections := next_selections || entry;
      end if;
    end loop;
    if cardinality(seen_accounts) <> 2 then
      raise exception 'rollout policy is missing an approved account';
    end if;
    if request.phase = 'acceptance' and next_selections is distinct from old_policy->'selections' then
      raise exception 'two-person rollout cutover has not completed';
    end if;
    if request.phase = 'cutover' then
      if request.mode = 'apply' and next_selections is distinct from old_policy->'selections' then
        update allrice_settings set
          value = jsonb_set(jsonb_set(old_policy, '{selections}', next_selections), '{revision}', to_jsonb(gen_random_uuid())),
          updated_at = clock_timestamp()
          where scope_type = 'system' and scope_id is null and key = 'd_entry_rollout_policy'
          returning value into old_policy;
      end if;
      if request.mode = 'apply' then
        update reset_receipt set result = result || jsonb_build_object('policy', old_policy);
      end if;
      return;
    end if;
  end if;
  if request.mode = 'plan' or row_counts = '{}'::jsonb then return; end if;

  -- Only these reviewed non-FK guards on the disposable restore may be
  -- paused. Unfamiliar modes fail closed instead of silently changing them.
  create temporary table reset_guards (relation regclass, name name) on commit drop;
  insert into reset_guards values
    ('allrice_employee_instance_revisions', 'employee_instance_revision_immutable'),
    ('allrice_employee_versions', 'allrice_employee_versions_no_delete'),
    ('allrice_employee_runs', 'allrice_employee_runs_no_delete'),
    ('allrice_employee_run_steps', 'allrice_employee_run_steps_no_delete');
  for guard in select * from reset_guards loop
    if not exists (select 1 from pg_trigger where tgrelid = guard.relation
      and tgname = guard.name and not tgisinternal and tgenabled = 'O'
      and (tgtype & 8) <> 0) then
      raise exception 'unexpected deletion guard: %', guard.name;
    end if;
    execute format('alter table %s disable trigger %I', guard.relation, guard.name);
  end loop;
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
  for guard in select * from reset_guards loop
    execute format('alter table %s enable trigger %I', guard.relation, guard.name);
  end loop;
end $$;
commit;
select result from reset_receipt;
drop table pg_temp.reset_receipt;
