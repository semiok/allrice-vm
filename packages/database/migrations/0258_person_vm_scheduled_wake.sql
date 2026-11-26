-- MET-289 host wake projection. Native observations stay in migration 0257.
create table person_vm_scheduled_wakes (
  person_id uuid primary key,
  organization_id uuid not null,
  vm_id uuid not null,
  instance_id uuid not null,
  lease_epoch bigint not null check (lease_epoch > 0),
  plan_id uuid not null unique,
  receipt_ids uuid[] not null check (cardinality(receipt_ids) > 0),
  target_at timestamptz,
  wake_at timestamptz,
  retry_at timestamptz,
  state text not null check (state in ('empty','waiting','claimed','ready','blocked','unknown')),
  claim_id uuid,
  claim_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  reason text,
  updated_at timestamptz not null default now(),
  check ((target_at is null) = (wake_at is null)),
  check ((target_at is null) = (state = 'empty')),
  check (wake_at <= target_at),
  check ((state = 'claimed') = (claim_id is not null and claim_until is not null)),
  check ((claim_id is null) = (claim_until is null)),
  check (retry_at is null or state = 'waiting')
);
create index person_vm_scheduled_wakes_due
  on person_vm_scheduled_wakes ((coalesce(retry_at,wake_at)),person_id)
  where state in ('waiting','claimed');
