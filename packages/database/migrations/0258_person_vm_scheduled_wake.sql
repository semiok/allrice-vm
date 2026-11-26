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
begin
  if tg_op='UPDATE' and new is not distinct from old then return null; end if;
  for fact in select distinct value from jsonb_array_elements(
    case when tg_op='INSERT' then jsonb_build_array(to_jsonb(new))
      when tg_op='DELETE' then jsonb_build_array(to_jsonb(old))
      else jsonb_build_array(to_jsonb(old),to_jsonb(new)) end)
  loop
    if tg_table_name='allrice_settings' and (
      fact->>'scope_type' is distinct from 'system'
      or fact->>'scope_id' is not null
      or fact->>'key' is distinct from 'd_entry_rollout_policy') then continue; end if;
    affected_person := (case when tg_table_name='allrice_users' then fact->>'id'
      else coalesce(fact->>'user_id',fact->>'owner_id') end)::uuid;
    affected_org := (case when tg_table_name='allrice_organizations' then fact->>'id'
      else fact->>'organization_id' end)::uuid;
    affected_workspace := (case when tg_table_name='allrice_workspaces' then fact->>'id'
      else fact->>'workspace_id' end)::uuid;
    with invalidated as (
      update person_vm_scheduled_wakes w set revoked_at=clock_timestamp()
      where w.revoked_at is null and w.state in ('empty','waiting','claimed')
        and (affected_person is null or w.person_id=affected_person)
        and (affected_org is null or w.organization_id=affected_org)
        and (affected_workspace is null or exists(
          select 1 from allrice_native_schedule_observation_receipts receipt
          where receipt.receipt_id=any(w.receipt_ids)
            and receipt.workspace_id=affected_workspace))
      returning w.*
    )
    insert into person_vm_audit
      (person_id,organization_id,vm_id,request_id,action,result,error_code,lease_epoch)
    select person_id,organization_id,vm_id,plan_id,'scheduled-wake.invalidate',
      'denied','CURRENT_AUTHORITY_CHANGED',lease_epoch from invalidated;
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
create trigger person_vm_wake_policy_changed after insert or delete or update of scope_type,scope_id,key,value
  on allrice_settings for each row execute function allrice_person_vm_wake_authority_changed();
