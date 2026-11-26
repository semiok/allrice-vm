#!/usr/bin/env python3
"""Rehearse the Snow reset against a fresh, synthetic PostgreSQL dump only."""

import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import uuid


HERE = Path(__file__).resolve().parent
MIGRATIONS = HERE.parents[2] / 'packages/database/migrations'
PG_ENV = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
PG_ENV['LC_ALL'] = 'C'
ORG, PERSON, ADMIN, ACCEPTOR, WORKSPACE, EMPLOYEE, VERSION = (
    str(uuid.UUID(int=index)) for index in range(1, 8)
)
TARGET = 'snow_reset_restore'
SOURCE = 'snow_reset_source'

FIXTURE = """
insert into allrice_organizations (id,slug,name) values (:'organization','snow-reset-fixture','Synthetic QA');
insert into allrice_workspaces (id,organization_id,slug,name)
  values (:'workspace',:'organization','main','QA');
insert into allrice_users (id,email,display_name,password_hash,username) values
  (:'person','snow@invalid.test','Snow','non-credential','snow'),
  (:'admin','admin@invalid.test','Admin','non-credential','admin'),
  (:'acceptor','acceptance@invalid.test','验收员','non-credential','acceptance');
insert into allrice_memberships (organization_id,workspace_id,user_id,role) values
  (:'organization',:'workspace',:'person','member'),
  (:'organization',:'workspace',:'admin','admin'),
  (:'organization',:'workspace',:'acceptor','member');
insert into allrice_employees (id,organization_id,workspace_id,employee_key,name)
  values (:'employee',:'organization',:'workspace','qa-shared','Shared QA employee');
insert into allrice_employee_versions (id,organization_id,workspace_id,employee_id,version,name,
  model,system_prompt,capabilities,config_checksum)
  values (:'version',:'organization',:'workspace',:'employee',1,'Shared QA employee',
  'fixture','fixture','{}','sha256:' || repeat('0',64));
insert into allrice_employee_assignments (id,organization_id,workspace_id,employee_id,employee_version_id,user_id)
  select user_id, organization_id, workspace_id, :'employee', :'version', user_id from allrice_memberships
  where organization_id=:'organization';
insert into allrice_employee_user_profiles (organization_id,workspace_id,employee_id,user_id)
  select organization_id,workspace_id,employee_id,user_id from allrice_employee_assignments
  where organization_id=:'organization';
insert into allrice_employee_instances (id,organization_id,workspace_id,owner_id,assignment_id,kind,creation_version_id)
  select id,organization_id,workspace_id,user_id,id,'general',employee_version_id from allrice_employee_assignments
  where organization_id=:'organization';
insert into allrice_employee_instance_revisions (instance_id,revision,profile)
  select id,1,'{}' from allrice_employee_instances where organization_id=:'organization';
insert into allrice_chat_sessions (id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_instance_id,employee_version_id)
  select id,organization_id,workspace_id,owner_id,'QA session',assignment_id,id,creation_version_id
  from allrice_employee_instances where organization_id=:'organization';
insert into allrice_messages (id,organization_id,workspace_id,session_id,owner_id,role,content)
  select id,organization_id,workspace_id,id,owner_id,'user','"fixture"'
  from allrice_chat_sessions where organization_id=:'organization';
insert into allrice_runs (id,organization_id,workspace_id,owner_id,state,execution_spec,input)
  select id,organization_id,workspace_id,owner_id,
    case when owner_id=:'person' then 'canceled' else 'succeeded' end,'{}','{}'
  from allrice_chat_sessions where organization_id=:'organization';
insert into allrice_employee_runs (run_id,organization_id,workspace_id,owner_id,employee_assignment_id,
  employee_version_id,session_id,user_message_id,assistant_message_id,status,provider_snapshot,prompt_snapshot,completed_at)
  select id,organization_id,workspace_id,owner_id,id,:'version',id,id,id,'succeeded','{}','{}',now()
  from allrice_runs where organization_id=:'organization';
insert into allrice_employee_run_steps (organization_id,workspace_id,run_id,sequence,event_type)
  select organization_id,workspace_id,run_id,0,'fixture.done'
  from allrice_employee_runs where organization_id=:'organization';
insert into allrice_memories (id,organization_id,workspace_id,owner_id,content,source_type,source_id)
  select id,organization_id,workspace_id,owner_id,'fixture','message',id
  from allrice_messages where organization_id=:'organization';
insert into allrice_credential_bindings (organization_id,owner_id,provider,label,vault_key)
  values (:'organization',:'admin','openai-codex','mock metadata','synthetic-no-credential');
insert into allrice_settings (scope_type,key,value)
  values ('system','d_entry_rollout_policy',jsonb_build_object('revision','fixture','defaultGeneration','3.x',
    'selections',jsonb_build_array(
      jsonb_build_object('organizationId',:'organization','personId',:'person',
        'employeeInstanceId',:'person','generation','4.0'),
      jsonb_build_object('organizationId',:'organization','personId',:'acceptor'))));
"""
EXPECTED_REMOVALS = {
    'allrice_employee_assignments': 'id',
    'allrice_employee_user_profiles': 'user_id',
    'allrice_employee_instances': 'id',
    'allrice_employee_instance_revisions': 'instance_id',
    'allrice_chat_sessions': 'id',
    'allrice_messages': 'id',
    'allrice_runs': 'id',
    'allrice_employee_runs': 'run_id',
    'allrice_employee_run_steps': 'run_id',
    'allrice_memories': 'id',
}
VARIABLES = dict(organization=ORG, person=PERSON, admin=ADMIN, acceptor=ACCEPTOR,
                 workspace=WORKSPACE, employee=EMPLOYEE, version=VERSION)


def run(argv, *, text=None, suppress=False):
    result = subprocess.run(
        argv, env=PG_ENV, input=text, text=True, capture_output=True, timeout=180,
    )
    if result.returncode and not suppress:
        raise RuntimeError(f'{Path(argv[0]).name}: {result.stderr.strip()}')
    return result


def snapshot(sql, *, expected=False):
    # Compare every public table's row multiset, excluding only the expected
    # target rows and the single rollout row, which is checked separately.
    conditions = {
        table: f"t.{column} <> '{PERSON}'::uuid"
        for table, column in EXPECTED_REMOVALS.items()
    } if expected else {}
    conditions['allrice_settings'] = "not (scope_type='system' and key='d_entry_rollout_policy')"
    predicates = ','.join(
        f"('{table}', '{predicate.replace(chr(39), chr(39) * 2)}')"
        for table, predicate in conditions.items()
    )
    output = sql(TARGET, rf"""
select format('select %L || '':'' || md5(coalesce(string_agg(h, '''' order by h), ''''))
  from (select md5(to_jsonb(t)::text) h from public.%I t where %s) data',
  table_name, table_name, coalesce(predicate, 'true'))
from information_schema.tables left join (values {predicates}) v(name,predicate) on name=table_name
where table_schema='public' and table_type='BASE TABLE' order by table_name
\gexec
""").stdout
    return output.splitlines()


def migrate(sql):
    # Use the real ordered migration bytes, in one transaction as migrate.ts
    # does, so later files see the same schema/journal and temporary tables.
    files = sorted(MIGRATIONS.glob('*.sql'))
    assert len(files) > 200
    sql(SOURCE, 'begin; create table allrice_schema_migrations (name text primary key,'
        ' applied_at timestamptz not null default now());\n' + '\n'.join(
            f"\n{path.read_text()}\ninsert into allrice_schema_migrations(name) values('{path.name}');"
            for path in files
        ) + '\ncommit;')
    print(f'{len(files)} repository migrations applied', flush=True)


def exercise(socket_path, dump):
    connection = ['-w', '-h', str(socket_path), '-p', '5432', '-U', 'snow_rehearsal']

    def sql(db, text, *, suppress=False, **overrides):
        variables = {**VARIABLES, **overrides}
        return run(['psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', *connection, '-d', db,
                    *(part for k, v in variables.items() for part in ('-v', f'{k}={v}'))],
                   text="set client_min_messages=warning; set allrice.snow_rehearsal='synthetic';\n" + text,
                   suppress=suppress)

    for name in [SOURCE, TARGET]:
        run(['createdb', *connection, name])
    migrate(sql)
    sql(SOURCE, FIXTURE)
    run(['pg_dump', *connection, '-Fc', '--file', str(dump), SOURCE])
    run(['pg_restore', *connection, '--single-transaction', '-d', TARGET, str(dump)])
    print('pg_dump → pg_restore verified on a private Unix-socket PostgreSQL', flush=True)

    packet = (HERE / 'reset.sql').read_text()
    expected = snapshot(sql, expected=True)
    before = snapshot(sql)
    policy_query = "select value from allrice_settings where key='d_entry_rollout_policy';"
    old_policy = json.loads(sql(TARGET, policy_query).stdout)
    trigger_query = """
select json_agg(json_build_array(tgrelid::regclass,tgname,tgenabled) order by tgrelid::regclass::text,tgname)
from pg_trigger where not tgisinternal;
"""
    triggers = sql(TARGET, trigger_query).stdout
    assert len(before) > 200 and len(before) == len(expected)
    assert before != expected

    bad_identity = sql(TARGET, packet, person=ADMIN, policy_format='person', suppress=True)
    assert bad_identity.returncode and 'snow fixture identity mismatch' in bad_identity.stderr
    assert snapshot(sql) == before

    # A partly converted rollout must not drop or rewrite someone else's tuple.
    sql(TARGET, """
update allrice_settings set value = jsonb_set(value,'{selections,1}',
  value->'selections'->1 || jsonb_build_object('employeeInstanceId',:'acceptor','generation','4.0'))
where key='d_entry_rollout_policy';
""")
    mixed = sql(TARGET, policy_query).stdout
    conflict = sql(TARGET, packet, policy_format='person', suppress=True)
    assert conflict.returncode and 'other people still have tuples' in conflict.stderr
    assert snapshot(sql) == before and sql(TARGET, policy_query).stdout == mixed
    sql(TARGET, """
update allrice_settings set value=jsonb_set(value,'{selections,1}',(value->'selections'->1)
  - array['employeeInstanceId','generation']) where key='d_entry_rollout_policy';
""")

    sql(TARGET, "update allrice_messages set owner_id=:'admin' where id=:'person';")
    cross_scope = sql(TARGET, packet, policy_format='person', suppress=True)
    assert cross_scope.returncode and 'cross-owner or cross-organization' in cross_scope.stderr
    sql(TARGET, "update allrice_messages set owner_id=:'person' where id=:'person';")
    assert snapshot(sql) == before

    sql(TARGET, packet, policy_format='person')
    assert snapshot(sql) == expected
    assert sql(TARGET, trigger_query).stdout == triggers
    policy = json.loads(sql(TARGET, policy_query).stdout)
    assert policy['selections'] == [
        old_policy['selections'][1], {'organizationId': ORG, 'personId': PERSON},
    ]
    assert policy['revision'] != old_policy['revision'] and policy['defaultGeneration'] == '3.x'
    sql(TARGET, packet, policy_format='person')
    assert snapshot(sql) == expected
    assert json.loads(sql(TARGET, policy_query).stdout) == policy
    sql(TARGET, """
update allrice_settings set value=jsonb_set(value,'{selections}',
  value->'selections' || jsonb_build_array(jsonb_build_object('organizationId',:'organization',
    'personId',:'person','employeeInstanceId',:'person','generation','4.0')))
where key='d_entry_rollout_policy';
""")
    sql(TARGET, packet, policy_format='tuple-remove')
    assert json.loads(sql(TARGET, policy_query).stdout)['selections'] == policy['selections']
    assert snapshot(sql) == expected
    print(f'PASS: {len(EXPECTED_REMOVALS)} scoped row families removed, {len(expected)} tables compared, foreign keys enabled', flush=True)
    print('PASS: admin/acceptance and shared rows preserved; foreign owner and mixed rollout rejected; repeat unchanged', flush=True)


def interrupted(signum, _frame):
    raise InterruptedError(f'rehearsal interrupted by signal {signum}')


def main():
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    # No host/database arguments, no fallback to DATABASE_URL or the test PG
    # service. The data directory, Unix socket and dump are all temporary.
    with tempfile.TemporaryDirectory(prefix='snowpg-', dir='/tmp') as directory:
        root = Path(directory)
        passfile = root / 'pgpass'
        passfile.touch(mode=0o600)
        PG_ENV['PGPASSFILE'] = str(passfile)
        pgdata = root / 'pg'
        run(['initdb', '-D', str(pgdata), '-U', 'snow_rehearsal', '-A', 'trust', '-E', 'UTF8'])
        try:
            run(['pg_ctl', '-D', str(pgdata), '-l', str(root / 'postgres.log'),
                 '-o', f"-c listen_addresses='' -p 5432 -k {root}", '-w', 'start'])
            exercise(root, root / 'synthetic.dump')
        finally:
            if (pgdata / 'postmaster.pid').exists():
                run(['pg_ctl', '-D', str(pgdata), '-m', 'immediate', '-w', 'stop'])
    print('Private PostgreSQL stopped; socket, dump and data directory released', flush=True)


if __name__ == '__main__':
    main()
