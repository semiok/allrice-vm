-- MET-93: platform AI employee production backend. Platform definitions are
-- global authoring records; tenant employee/version rows remain runtime copies.

create table allrice_platform_dsh_skills (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text not null,
  content text not null,
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  model_invocable boolean not null default true,
  user_invocable boolean not null default true,
  required_tool_refs jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  source text not null default 'allrice'
    check (source in ('allrice', 'dsh-migrated')),
  created_by_label text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (octet_length(content) <= 500000),
  check (jsonb_typeof(required_tool_refs) = 'array')
);

insert into allrice_platform_dsh_skills (
  name, description, content, checksum, model_invocable, user_invocable,
  required_tool_refs, enabled, source, created_by_label
)
select distinct on (name)
  name, description, content, checksum, model_invocable, user_invocable,
  required_tool_refs, enabled, 'allrice', 'MET-93 migration'
from allrice_dsh_skills
order by name, updated_at desc, id;

create table allrice_platform_employees (
  id uuid primary key default gen_random_uuid(),
  employee_key text not null unique
    check (employee_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  description text not null,
  status text not null default 'draft'
    check (status in ('draft', 'testing', 'published', 'disabled', 'archived')),
  current_draft_revision_id uuid,
  current_published_revision_id uuid,
  created_by_label text not null default 'system',
  updated_by_label text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table allrice_platform_employee_revisions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references allrice_platform_employees(id),
  revision integer not null check (revision > 0),
  status text not null default 'draft'
    check (status in ('draft', 'testing', 'published', 'disabled')),
  definition jsonb not null,
  runtime_profile jsonb,
  checksum text not null check (checksum ~ '^sha256:[a-f0-9]{64}$'),
  validation_report jsonb not null default '{"valid":false,"errors":[]}'::jsonb,
  created_by_label text not null default 'system',
  published_by_label text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (employee_id, revision),
  unique (employee_id, id),
  check (jsonb_typeof(definition) = 'object'),
  check (runtime_profile is null or jsonb_typeof(runtime_profile) = 'object'),
  check (jsonb_typeof(validation_report) = 'object')
);

alter table allrice_platform_employees
  add foreign key (id, current_draft_revision_id)
    references allrice_platform_employee_revisions(employee_id, id),
  add foreign key (id, current_published_revision_id)
    references allrice_platform_employee_revisions(employee_id, id);

create table allrice_platform_employee_tenant_assignments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references allrice_platform_employees(id),
  revision_id uuid not null,
  organization_id uuid not null,
  workspace_id uuid not null,
  tenant_employee_id uuid,
  tenant_employee_version_id uuid,
  active boolean not null default true,
  assigned_by_label text not null default 'system',
  assigned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (employee_id, revision_id)
    references allrice_platform_employee_revisions(employee_id, id),
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  foreign key (organization_id, workspace_id, tenant_employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, tenant_employee_version_id)
    references allrice_employee_versions(organization_id, workspace_id, id),
  unique (employee_id, workspace_id)
);

create table allrice_platform_employee_test_runs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references allrice_platform_employees(id),
  revision_id uuid not null,
  requested_by_label text not null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  input jsonb not null,
  output jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (employee_id, revision_id)
    references allrice_platform_employee_revisions(employee_id, id),
  check (jsonb_typeof(input) = 'object'),
  check (output is null or jsonb_typeof(output) = 'object')
);

insert into allrice_runtime_metadata (key, value)
values (
  'platform-employee-production',
  '{"version":"0048","issue":"MET-93","authority":"allrice-control-plane","harness":"dsh"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
