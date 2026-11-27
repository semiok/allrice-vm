-- MET-289 host wake projection. Native observations stay in migration 0257.
create table person_vm_scheduled_wakes (
  person_id uuid not null,
  organization_id uuid not null,
  vm_id uuid not null,
  instance_id uuid not null,
  lease_epoch bigint not null check (lease_epoch > 0),
  plan_id uuid primary key,
  receipt_ids uuid[] not null check (cardinality(receipt_ids) > 0),
  target_at timestamptz,
  wake_at timestamptz,
  retry_at timestamptz,
  state text not null check (state in ('empty','waiting','claimed','ready','blocked','unknown')),
  claim_id uuid,
  claim_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  reason text,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((target_at is null) = (wake_at is null)),
  check ((target_at is null) = (state = 'empty')),
  check (wake_at <= target_at),
  check ((state = 'claimed') = (claim_id is not null and claim_until is not null)),
  check ((claim_id is null) = (claim_until is null)),
  check (retry_at is null or state = 'waiting')
);
create index person_vm_scheduled_wakes_claim_expiry
  on person_vm_scheduled_wakes (claim_until,plan_id)
  where state = 'claimed';

create index person_vm_scheduled_wakes_authority_scope
  on person_vm_scheduled_wakes(organization_id,person_id)
  where revoked_at is null and state in ('empty','waiting','claimed');

-- Revocation is durable even while the Worker is offline. A subsequent grant
-- may permit a new stop plan but must not revive any of the previous plans.
create function allrice_person_vm_wake_authority_changed() returns trigger language plpgsql as $$
declare
  fact jsonb;
  affected_person uuid;
  affected_org uuid;
  affected_workspace uuid;
  previous_policy jsonb := '[]';
  current_policy jsonb := '[]';
begin
  if tg_op='UPDATE' and new is not distinct from old then return null; end if;
  if tg_table_name='allrice_settings' then
    if tg_op='INSERT' or old.scope_type is distinct from 'system'
      or old.scope_id is not null or old.key is distinct from 'd_entry_rollout_policy'
      or jsonb_typeof(old.value->'selections') is distinct from 'array'
    then return null; end if;
    previous_policy := old.value->'selections';
    if tg_op='UPDATE' and new.scope_type='system' and new.scope_id is null
      and new.key='d_entry_rollout_policy' and new.value->>'defaultGeneration'='3.x'
      and jsonb_typeof(new.value->'selections')='array'
    then current_policy := new.value->'selections'; end if;
    -- A new policy revision alone does not change anyone's qualification.
  end if;
  for fact in select distinct value from jsonb_array_elements(
    case when tg_table_name='allrice_settings' then jsonb_build_array('{}'::jsonb)
      when tg_op='INSERT' then jsonb_build_array(to_jsonb(new))
      when tg_op='DELETE' then jsonb_build_array(to_jsonb(old))
      else jsonb_build_array(to_jsonb(old),to_jsonb(new)) end)
  loop
    affected_person := (case when tg_table_name='allrice_users' then fact->>'id'
      else coalesce(fact->>'user_id',fact->>'owner_id') end)::uuid;
    affected_org := (case when tg_table_name='allrice_organizations' then fact->>'id'
      else fact->>'organization_id' end)::uuid;
    affected_workspace := (case when tg_table_name='allrice_workspaces' then fact->>'id'
      else fact->>'workspace_id' end)::uuid;
    with invalidated as (
      update person_vm_scheduled_wakes w set revoked_at=clock_timestamp(),
        state=case when w.state='waiting' then 'blocked' else w.state end,
        retry_at=null,reason='STALE_PLAN',updated_at=clock_timestamp()
      where w.revoked_at is null and w.state in ('empty','waiting','claimed')
        and (affected_person is null or w.person_id=affected_person)
        and (affected_org is null or w.organization_id=affected_org)
        and (affected_workspace is null or exists(
          select 1 from allrice_native_schedule_observation_receipts receipt
          where receipt.receipt_id=any(w.receipt_ids)
            and receipt.workspace_id=affected_workspace))
        and (tg_table_name<>'allrice_memberships' or exists(
          select 1 from allrice_native_schedule_observation_receipts receipt
          where receipt.receipt_id=any(w.receipt_ids)
            and (affected_workspace is null or receipt.workspace_id=affected_workspace)
            and not exists(select 1 from allrice_memberships member
              where member.organization_id=w.organization_id and member.user_id=w.person_id
                and member.active and member.role in ('admin','member')
                and (member.workspace_id is null or member.workspace_id=receipt.workspace_id))))
        and (tg_table_name<>'allrice_employee_instances' or exists(
          select 1 from allrice_native_schedule_observation_receipts receipt
          where receipt.receipt_id=any(w.receipt_ids)
            and receipt.employee_instance_id=(fact->>'id')::uuid))
        and (tg_table_name not in ('allrice_employee_assignments','allrice_employees',
          'allrice_platform_employee_tenant_assignments') or exists(
          select 1 from allrice_native_schedule_observation_receipts receipt
          join allrice_employee_instances i on i.id=receipt.employee_instance_id
          left join allrice_employee_assignments a on a.id=i.assignment_id
          where receipt.receipt_id=any(w.receipt_ids)
            and case tg_table_name
              when 'allrice_employee_assignments' then i.assignment_id=(fact->>'id')::uuid
              when 'allrice_employees' then a.employee_id=(fact->>'id')::uuid
              else a.employee_id=(fact->>'tenant_employee_id')::uuid and fact->>'active'='false'
            end))
        -- The published rollout opts in a person within one organization.
        and (tg_table_name<>'allrice_settings' or (
          exists(select 1 from jsonb_array_elements(previous_policy) selection
            where lower(selection->>'organizationId')=w.organization_id::text
              and lower(selection->>'personId')=w.person_id::text)
          and not exists(select 1 from jsonb_array_elements(current_policy) selection
            where lower(selection->>'organizationId')=w.organization_id::text
              and lower(selection->>'personId')=w.person_id::text)))
        and (tg_table_name<>'allrice_native_schedule_observation_receipts' or exists(
          select 1 from allrice_native_schedule_observation_receipts receipt
          where receipt.receipt_id=any(w.receipt_ids)
            and receipt.employee_instance_id::text=fact->>'employee_instance_id'
            and receipt.workspace_id::text=fact->>'workspace_id'
            and receipt.vm_id::text=fact->>'vm_id'
            and exists(select 1 from jsonb_array_elements_text(
              fact #> '{input_payload,invalidateReceiptIds}') invalidated(id)
              where lower(invalidated.id)=receipt.receipt_id::text)))
      returning w.*
    )
    insert into person_vm_audit
      (person_id,organization_id,vm_id,request_id,action,result,error_code,lease_epoch)
    select person_id,organization_id,vm_id,plan_id,'scheduled-wake.invalidate',
      'denied',case when tg_table_name='allrice_native_schedule_observation_receipts'
        then 'NATIVE_SCHEDULE_INVALIDATED' else 'CURRENT_AUTHORITY_CHANGED' end,
      lease_epoch from invalidated;
  end loop;
  return null;
end $$;
create trigger person_vm_wake_user_changed after delete or update of status
  on allrice_users for each row execute function allrice_person_vm_wake_authority_changed();
create trigger person_vm_wake_organization_changed after delete or update of archived_at
  on allrice_organizations for each row execute function allrice_person_vm_wake_authority_changed();
create trigger person_vm_wake_workspace_changed after delete or update of archived_at,organization_id
  on allrice_workspaces for each row execute function allrice_person_vm_wake_authority_changed();
create trigger person_vm_wake_membership_changed after delete or update of active,role,user_id,organization_id,workspace_id
  on allrice_memberships for each row execute function allrice_person_vm_wake_authority_changed();
create trigger person_vm_wake_instance_changed after delete or update of revision,archived_at,assignment_id,owner_id,organization_id,workspace_id
  on allrice_employee_instances for each row execute function allrice_person_vm_wake_authority_changed();
create trigger person_vm_wake_assignment_changed after delete or update of active,employee_version_id,employee_id,user_id,organization_id,workspace_id
  on allrice_employee_assignments for each row execute function allrice_person_vm_wake_authority_changed();
create trigger person_vm_wake_employee_changed after delete or update of status
  on allrice_employees for each row execute function allrice_person_vm_wake_authority_changed();
create trigger person_vm_wake_deployment_changed after insert or delete or update
  on allrice_platform_employee_tenant_assignments for each row execute function allrice_person_vm_wake_authority_changed();
create trigger person_vm_wake_policy_changed after delete or update of scope_type,scope_id,key,value
  on allrice_settings for each row execute function allrice_person_vm_wake_authority_changed();
create trigger person_vm_wake_schedule_invalidated after insert
  on allrice_native_schedule_observation_receipts for each row
  when (jsonb_array_length(new.input_payload->'invalidateReceiptIds')>0)
  execute function allrice_person_vm_wake_authority_changed();
