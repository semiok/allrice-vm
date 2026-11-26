#!/usr/bin/env python3
"""Rehearse the two approved fixture accounts on a private PostgreSQL restore."""

from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid


HERE = Path(__file__).resolve().parent
MIGRATIONS = HERE.parents[2] / 'packages/database/migrations'
PG_ENV = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
PG_ENV['LC_ALL'] = 'C'
(
    ORG, PERSON, ADMIN, ACCEPTOR, WORKSPACE, EMPLOYEE, VERSION,
    NATIVE_SESSION, PRIVATE, PRIVATE_VERSION, PRIVATE_ASSIGNMENT,
    ACCEPTOR_SESSION, ACCEPTOR_PRIVATE, ACCEPTOR_VERSION, ACCEPTOR_ASSIGNMENT,
    OUTSIDE_ORG, OUTSIDE_WORKSPACE, OUTSIDER, SHARED_OBJECT,
    LEGACY_THREAD, BINDING_JOB, SCHEDULE_RECEIPT,
) = (
    str(uuid.UUID(f'00000000-0000-4000-8000-{index:012x}')) for index in range(1, 23)
)
TARGET = 'snow_reset_restore'
SOURCE = 'snow_reset_source'
requested_signal = None

APPROVED_ACCOUNTS = {
    'snow': dict(organizationId=ORG, workspaceId=WORKSPACE, personId=PERSON, username='snow'),
    'acceptance': dict(organizationId=ORG, workspaceId=WORKSPACE, personId=ACCEPTOR, username='acceptance'),
}

FIXTURE = """
insert into allrice_organizations (id,slug,name) values
  (:'organization','snow-reset-fixture','Synthetic QA'),
  (:'outside_org','outside-fixture','Other tenant');
insert into allrice_workspaces (id,organization_id,slug,name)
  values (:'workspace',:'organization','main','QA'), (:'outside_workspace',:'outside_org','main','Other tenant');
insert into allrice_users (id,email,display_name,password_hash,username) values
  (:'person','snow@invalid.test','Snow','non-credential','snow'),
  (:'admin','admin@invalid.test','Admin','non-credential','admin'),
  (:'acceptor','acceptance@invalid.test','验收员','non-credential','acceptance'),
  (:'outsider','outsider@invalid.test','Other tenant','non-credential','outsider');
insert into allrice_memberships (organization_id,workspace_id,user_id,role) values
  (:'organization',:'workspace',:'person','member'),
  (:'organization',:'workspace',:'admin','admin'),
  (:'organization',:'workspace',:'acceptor','member'),
  (:'outside_org',:'outside_workspace',:'outsider','admin');
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
insert into allrice_storage_objects (id, organization_id, workspace_id, owner_id, object_key,
  category, media_type, size_bytes, checksum, visibility, state)
  values (:'shared_object',:'organization',:'workspace',:'admin','synthetic/shared',
    'uploads','text/plain',0,'sha256:' || repeat('0',64),'workspace','ready');
insert into allrice_message_attachments (organization_id,workspace_id,message_id,object_id,attached_by,file_name)
  select organization_id,workspace_id,id,:'shared_object',owner_id,'shared.txt'
  from allrice_messages where organization_id=:'organization';
insert into allrice_file_references (organization_id,workspace_id,object_id,session_id,owner_id,file_name)
  select organization_id,workspace_id,:'shared_object',id,owner_id,'shared.txt'
  from allrice_chat_sessions where organization_id=:'organization';
insert into allrice_storage_access_grants (nonce,object_id,subject_id,operation,expires_at)
  values (:'shared_object',:'shared_object',:'admin','read',now() + interval '1 day');
insert into allrice_chat_input_requests (user_message_id,organization_id,workspace_id,session_id,
  owner_id,client_message_id,request_digest,kind)
  select id,organization_id,workspace_id,session_id,owner_id,id,'sha256:' || repeat('0',64),'message'
  from allrice_messages where organization_id=:'organization';
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
create temporary table personal_fixture (
  person_id uuid, employee_id uuid, version_id uuid, assignment_id uuid, session_id uuid
);
insert into personal_fixture values
  (:'person',:'private',:'private_version',:'private_assignment',:'native_session'),
  (:'acceptor',:'acceptor_private',:'acceptor_version',:'acceptor_assignment',:'acceptor_session');
insert into allrice_employees (id,organization_id,workspace_id,employee_key,name)
  select employee_id,:'organization',:'workspace','personal-' || employee_id,'Synthetic personal'
  from personal_fixture;
insert into allrice_employee_versions (id,organization_id,workspace_id,employee_id,version,name,
  model,system_prompt,capabilities,config_checksum)
  select version_id,:'organization',:'workspace',employee_id,1,'Synthetic personal',
    'fixture','fixture','{}','sha256:' || repeat('0',64) from personal_fixture;
insert into allrice_employee_assignments (id,organization_id,workspace_id,employee_id,employee_version_id,user_id,assigned_by,is_default)
  select assignment_id,:'organization',:'workspace',employee_id,version_id,person_id,person_id,false
  from personal_fixture;
insert into allrice_employee_instances (id,organization_id,workspace_id,owner_id,assignment_id,
  kind,creation_version_id,creation_request_id,creation_input)
  select assignment_id,:'organization',:'workspace',person_id,assignment_id,
    'custom',version_id,assignment_id,'{}' from personal_fixture;
insert into allrice_employee_instance_revisions (instance_id,revision,profile)
  select assignment_id,1,'{}' from personal_fixture;
insert into allrice_chat_sessions (id,organization_id,workspace_id,owner_id,title,employee_assignment_id,
  employee_instance_id,employee_version_id,execution_generation)
  select session_id,:'organization',:'workspace',person_id,'Synthetic 4.0 session',
    assignment_id,assignment_id,version_id,'4.0' from personal_fixture;
update allrice_chat_sessions s set d_entry_native_root_claim=jsonb_build_object('schemaVersion',1,
  'identity',jsonb_build_object('organizationId',:'organization','workspaceId',:'workspace','personId',f.person_id,
    'threadId',f.session_id,'employeeInstanceId',f.assignment_id,'employeeRevision',1,'employeeVersionId',f.version_id),
  'host',jsonb_build_object('binding',jsonb_build_object('organizationId',:'organization','personId',f.person_id,
    'vmId',f.session_id,'instanceId',f.session_id,'leaseEpoch',1),'bindingRef','fixture','rosterDigest','fixture'),
  'releaseRevision','fixture','operationId','fixture') from personal_fixture f where s.id=f.session_id;
update allrice_chat_sessions set d_entry_native_root=d_entry_native_root_claim || '{"nativeSessionId":"fixture"}'::jsonb
  where id in (select session_id from personal_fixture);
insert into allrice_credential_bindings (organization_id,owner_id,provider,label,vault_key)
  select organization_id,user_id,'openai-codex','mock metadata','synthetic-no-credential-' || user_id
  from allrice_memberships;
insert into allrice_sessions (user_id,token_hash,expires_at)
  select user_id,repeat(md5(user_id::text),2),now() + interval '1 day' from allrice_memberships;
insert into allrice_settings (scope_type,key,value)
  values ('system','d_entry_rollout_policy',jsonb_build_object('revision','fixture','defaultGeneration','3.x',
    'selections',jsonb_build_array(
      jsonb_build_object('organizationId',:'organization','personId',:'person',
        'employeeInstanceId',:'person','generation','4.0'),
      jsonb_build_object('organizationId',:'organization','personId',:'admin'),
      jsonb_build_object('organizationId',:'outside_org','personId',:'outsider'),
      jsonb_build_object('organizationId',:'organization','personId',:'acceptor',
        'employeeInstanceId',:'acceptor','generation','4.0'),
      jsonb_build_object('organizationId',:'organization','personId',:'person',
        'employeeInstanceId',:'private_assignment','generation','4.0'))));
"""

def expected_removals(person, employee, version, assignment, session):
    return {
        'allrice_employee_assignments': ('id', (person, assignment)),
        'allrice_employee_user_profiles': ('user_id', (person,)),
        'allrice_employee_instances': ('id', (person, assignment)),
        'allrice_employee_instance_revisions': ('instance_id', (person, assignment)),
        'allrice_employees': ('id', (employee,)),
        'allrice_employee_versions': ('id', (version,)),
        'allrice_chat_sessions': ('id', (person, session)),
        'allrice_messages': ('id', (person,)),
        'allrice_message_attachments': ('message_id', (person,)),
        'allrice_file_references': ('session_id', (person,)),
        'allrice_chat_input_requests': ('user_message_id', (person,)),
        'allrice_runs': ('id', (person,)),
        'allrice_employee_runs': ('run_id', (person,)),
        'allrice_employee_run_steps': ('run_id', (person,)),
        'allrice_memories': ('id', (person,)),
    }


SNOW_REMOVALS = expected_removals(PERSON, PRIVATE, PRIVATE_VERSION, PRIVATE_ASSIGNMENT, NATIVE_SESSION)
ACCEPTANCE_REMOVALS = expected_removals(ACCEPTOR, ACCEPTOR_PRIVATE, ACCEPTOR_VERSION, ACCEPTOR_ASSIGNMENT, ACCEPTOR_SESSION)
ALL_REMOVALS = {
    table: (column, ids + ACCEPTANCE_REMOVALS[table][1])
    for table, (column, ids) in SNOW_REMOVALS.items()
}
VARIABLES = dict(organization=ORG, person=PERSON, admin=ADMIN, acceptor=ACCEPTOR,
                 workspace=WORKSPACE, employee=EMPLOYEE, version=VERSION, native_session=NATIVE_SESSION,
                 private=PRIVATE, private_version=PRIVATE_VERSION, private_assignment=PRIVATE_ASSIGNMENT,
                 acceptor_session=ACCEPTOR_SESSION, acceptor_private=ACCEPTOR_PRIVATE,
                 acceptor_version=ACCEPTOR_VERSION, acceptor_assignment=ACCEPTOR_ASSIGNMENT,
                 outside_org=OUTSIDE_ORG, outside_workspace=OUTSIDE_WORKSPACE, outsider=OUTSIDER,
                 shared_object=SHARED_OBJECT)


def run(argv, *, text=None, suppress=False):
    check_interrupted()
    result = subprocess.run(
        argv, env=PG_ENV, input=text, text=True, capture_output=True, timeout=180,
    )
    check_interrupted()
    if result.returncode and not suppress:
        raise RuntimeError(f'{Path(argv[0]).name}: {result.stderr.strip()}')
    return result


def snapshot(sql, *, db=TARGET, without=None):
    # Compare every public table's row multiset, excluding only the expected
    # target rows and the single rollout row, which is checked separately.
    conditions = {
        table: f"t.{column} not in (" + ", ".join(f"'{value}'::uuid" for value in ids) + ")"
        for table, (column, ids) in (without or {}).items()
    }
    conditions['allrice_settings'] = "not (scope_type='system' and key='d_entry_rollout_policy')"
    predicates = ','.join(
        f"('{table}', '{predicate.replace(chr(39), chr(39) * 2)}')"
        for table, predicate in conditions.items()
    )
    output = sql(db, rf"""
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


def check_retained_legacy_references(sql, rejected_unchanged):
    def digest(value):
        encoded = json.dumps(value, sort_keys=True, separators=(',', ':')).encode('ascii')
        return 'sha256:' + sha256(encoded).hexdigest()

    # The legacy reader resolves the birth version from native_root_origin.
    generation = 'dsh-0.2.1-rc.2-687f282'
    checksum = 'sha256:' + '0' * 64
    origin = dict(contextKind='chat', contextId=LEGACY_THREAD, rootSeed=LEGACY_THREAD,
                  distributionGeneration=generation, profileId='restricted', artifactId=checksum)
    source_policy = dict(family='allrice_declarative_employee_v1', variant='definition_only')
    source_policy['digest'] = digest({
        **source_policy, 'manifestSchema': 2, 'packageSchema': None, 'declaredGeneration': None,
        'executionGeneration': generation, 'profileId': 'restricted',
        'validation': 'original-checksums-known-tools-reviewed-frozen-bundles-v1',
    })
    for legacy_root in [
        {**origin, 'schemaVersion': 1, 'frozenIdentity': {
            'kind': 'employee_package', 'checksum': checksum, 'sourceId': PRIVATE_VERSION,
        }},
        {**origin, 'schemaVersion': 2, 'scope': dict(organizationId=ORG, workspaceId=WORKSPACE, ownerId=ACCEPTOR),
         'birthSource': dict(employeeVersionId=PRIVATE_VERSION, configChecksum=checksum, manifestDigest=checksum,
                             manifestSchema=2, packageSchema=None, packageChecksum=None, declaredGeneration=None,
                             capabilitySnapshotDigest=checksum),
         'sourcePolicy': source_policy},
    ]:
        sql(TARGET, """
insert into allrice_chat_sessions (id,organization_id,workspace_id,owner_id,title,
  employee_assignment_id,employee_instance_id,employee_version_id,execution_generation,native_root_origin)
values (:'legacy_thread',:'organization',:'workspace',:'acceptor','Retained legacy chat',
  :'acceptor',:'acceptor',:'version','3.x',:'legacy_root'::jsonb);
""", legacy_thread=LEGACY_THREAD, legacy_root=json.dumps(legacy_root))
        rejected_unchanged('snow', 'retained legacy native root references a planned deletion')
        sql(TARGET, "delete from allrice_chat_sessions where id=:'legacy_thread';", legacy_thread=LEGACY_THREAD)

    # The legacy writer uses the 3.x chat's ID as its context/storage key.
    binding_id = f'dsh-{PERSON}-fixture'
    sql(TARGET, """
insert into allrice_native_session_bindings (native_session_id,organization_id,workspace_id,owner_id,
  context_kind,context_id,storage_context_key,storage_namespace,artifact_id,artifact_manifest_digest,
  distribution_generation,profile_id,first_run_id,first_job_id,first_attempt,binding_basis)
values (:'binding_id',:'organization',:'workspace',:'acceptor','chat',:'person',:'person',
  :'storage_namespace',:'checksum',:'checksum','dsh-0.1.5-rc.3-a4c74a9','restricted',
  :'acceptor',:'binding_job',1,'approved_compatibility_reader');
""", binding_id=binding_id, binding_job=BINDING_JOB, checksum=checksum,
        storage_namespace=f'/fixture/{ORG}/{WORKSPACE}/{ACCEPTOR}/{PERSON}/sessions')
    rejected_unchanged('snow', 'retained native chat binding references a planned deletion')
    sql(TARGET, "delete from allrice_native_session_bindings where native_session_id=:'binding_id';",
        binding_id=binding_id)

    # The receipt's relational instance is retained, so only the JSON version can match.
    receipt = dict(kind='snapshot', receiptId=SCHEDULE_RECEIPT, invalidateReceiptIds=[],
                   origin=dict(organizationId=ORG, workspaceId=WORKSPACE, personId=ACCEPTOR,
                               vmId=ACCEPTOR_SESSION, instanceId=ACCEPTOR_SESSION, leaseEpoch=1,
                               employeeInstanceId=ACCEPTOR_ASSIGNMENT, employeeRevision=1,
                               employeeVersionId=PRIVATE_VERSION, bindingRef='fixture'),
                   batch=dict(items=[], fingerprint=digest([])))
    sql(TARGET, """
insert into allrice_native_schedule_observation_receipts (receipt_id,organization_id,workspace_id,
  person_id,vm_id,employee_instance_id,input_digest,input_payload)
values (:'receipt_id',:'organization',:'workspace',:'acceptor',:'acceptor_session',
  :'acceptor_assignment',:'input_digest',:'receipt'::jsonb);
""", receipt_id=SCHEDULE_RECEIPT, input_digest=digest(receipt), receipt=json.dumps(receipt))
    rejected_unchanged('snow', 'retained native schedule observation receipt references a planned deletion')
    # Remove the injected row from the disposable restore before the success scenario.
    sql(TARGET, """
begin;
alter table allrice_native_schedule_observation_receipts disable trigger allrice_native_schedule_observation_receipt_immutable;
delete from allrice_native_schedule_observation_receipts where receipt_id=:'receipt_id';
alter table allrice_native_schedule_observation_receipts enable trigger allrice_native_schedule_observation_receipt_immutable;
commit;
""", receipt_id=SCHEDULE_RECEIPT)


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

    packet = (HERE / 'reset.sql').read_text()
    policy_query = """
select to_jsonb(s) from allrice_settings s
where scope_type='system' and scope_id is null and key='d_entry_rollout_policy';
"""
    trigger_query = """
select json_agg(json_build_array(tgrelid::regclass,tgname,tgenabled) order by tgrelid::regclass::text,tgname)
from pg_trigger;
"""

    def policy_row(db=TARGET):
        return json.loads(sql(db, policy_query).stdout)

    def reset(phase, *, mode='apply', accounts=APPROVED_ACCOUNTS, expected=None, db=TARGET, error=None):
        result = sql(db, packet, phase=phase, mode=mode, approved_accounts=json.dumps(accounts),
                     expected_policy=json.dumps(expected), suppress=error is not None)
        if error is not None:
            assert result.returncode and error in result.stderr, result.stderr
            assert not result.stdout.strip()
            return None
        return json.loads(result.stdout)

    def rejected_unchanged(phase, error, **inputs):
        rows = snapshot(sql)
        policy = policy_row()
        triggers = sql(TARGET, trigger_query).stdout
        reset(phase, error=error, **inputs)
        assert snapshot(sql) == rows and policy_row() == policy
        assert sql(TARGET, trigger_query).stdout == triggers

    before = snapshot(sql)
    expect_snow = snapshot(sql, without=SNOW_REMOVALS)
    expect_both = snapshot(sql, without=ALL_REMOVALS)
    old_row = policy_row()
    old_policy = old_row['value']
    triggers = sql(TARGET, trigger_query).stdout
    assert len(before) > 200 and len(before) == len(expect_snow) == len(expect_both)
    assert before != expect_snow and expect_snow != expect_both
    assert snapshot(sql, db=SOURCE) == before and policy_row(SOURCE) == old_row
    print('pg_dump → pg_restore reconciled on private Unix-socket PostgreSQL', flush=True)

    reset('snow', db=SOURCE, error='synthetic restore required')
    assert snapshot(sql, db=SOURCE) == before and policy_row(SOURCE) == old_row
    rejected_unchanged('admin', 'unsupported reset phase or mode')
    rejected_unchanged('acceptance', 'approved fixture account list mismatch',
                       accounts={**APPROVED_ACCOUNTS, 'acceptance': {
                           **APPROVED_ACCOUNTS['acceptance'], 'personId': ADMIN, 'username': 'admin',
                       }})
    rejected_unchanged('snow', 'approved fixture account list mismatch',
                       accounts={**APPROVED_ACCOUNTS, 'snow': {
                           **APPROVED_ACCOUNTS['snow'], 'username': 'Snow',
                       }})
    sql(TARGET, "update allrice_users set username='fixture-alias' where id=:'acceptor';")
    rejected_unchanged('snow', 'fixture account or membership mismatch')
    sql(TARGET, "update allrice_users set username='acceptance' where id=:'acceptor';")
    sql(TARGET, "update allrice_memberships set active=false where user_id=:'acceptor';")
    rejected_unchanged('acceptance', 'fixture account or membership mismatch')
    sql(TARGET, "update allrice_memberships set active=true where user_id=:'acceptor';")

    for phase, removals in [('snow', SNOW_REMOVALS), ('acceptance', ACCEPTANCE_REMOVALS)]:
        plan = reset(phase, mode='plan')
        assert plan == {'phase': phase, 'mode': 'plan', 'account': phase,
                        'rows': {table: len(ids) for table, (_, ids) in removals.items()}}
    assert snapshot(sql) == before and policy_row() == old_row
    rejected_unchanged('cutover', 'snow business rows are not zero', expected=old_policy)
    rejected_unchanged('acceptance', 'two-person rollout cutover has not completed', expected=old_policy)

    # Two approved people still have independent FK closures.
    sql(TARGET, "update allrice_messages set owner_id=:'acceptor' where id=:'person';")
    rejected_unchanged('snow', 'cross-owner, workspace or organization reference')
    sql(TARGET, "update allrice_messages set owner_id=:'person' where id=:'person';")
    sql(TARGET, "update allrice_message_attachments set attached_by=:'acceptor' where message_id=:'person';")
    rejected_unchanged('snow', 'target attachment belongs to another account')
    sql(TARGET, "update allrice_message_attachments set attached_by=:'person' where message_id=:'person';")
    sql(TARGET, "update allrice_runs set owner_id=:'acceptor' where id=:'person';")
    rejected_unchanged('snow', 'outside-scope personal parent')
    sql(TARGET, "update allrice_runs set owner_id=:'person' where id=:'person';")

    # Simulate a damaged stored proof on the account that Snow's reset retains.
    # Change only the chosen JSON, leaving its relational bindings intact.
    for column in ('d_entry_native_root_claim', 'd_entry_native_root'):
        original_pin = json.loads(sql(TARGET, f"select {column} from allrice_chat_sessions where id=:'acceptor_session';").stdout)
        write_pin = f"""
begin;
alter table allrice_chat_sessions disable trigger allrice_d_entry_native_root_guard;
update allrice_chat_sessions set {column}=:'pin'::jsonb where id=:'acceptor_session';
alter table allrice_chat_sessions enable trigger allrice_d_entry_native_root_guard;
commit;
"""
        for field, foreign_id in [('threadId', NATIVE_SESSION), ('employeeInstanceId', PRIVATE_ASSIGNMENT),
                                  ('employeeVersionId', PRIVATE_VERSION.upper())]:
            wrong_pin = {**original_pin, 'identity': {**original_pin['identity'], field: foreign_id}}
            sql(TARGET, write_pin, pin=json.dumps(wrong_pin))
            rejected_unchanged('snow', 'retained D entry native root references a planned deletion')
        sql(TARGET, write_pin, pin=json.dumps(original_pin))

    check_retained_legacy_references(sql, rejected_unchanged)

    sql(TARGET, """
insert into allrice_employee_memory_contexts (organization_id,workspace_id,owner_id,instance_id,employee_id,
  budget_ref,thread_id,native_owner_ref,native_profile_ref,root_native_session_ref,execution_generation,
  module_release,module_config_revision_ref,document,state)
values (:'organization',:'workspace',:'acceptor',:'acceptor_assignment',:'acceptor_private',
  'fixture-foreign-thread',:'native_session','fixture','fixture','fixture','4.0',
  '{}','fixture','fixture','{"schemaVersion":2,"meter":"utf8_bytes"}');
""")
    rejected_unchanged('snow', 'retained employee memory context references a planned deletion', mode='plan')
    sql(TARGET, "delete from allrice_employee_memory_contexts where budget_ref='fixture-foreign-thread';")

    sql(TARGET, """
create table synthetic_unreviewed (thread uuid references allrice_chat_sessions(id));
insert into synthetic_unreviewed values (:'acceptor_session');
""")
    rejected_unchanged('acceptance', 'unreviewed dependent table', mode='plan')
    sql(TARGET, 'drop table synthetic_unreviewed;')

    sql(TARGET, """
insert into allrice_jobs (organization_id,workspace_id,owner_id,run_id,idempotency_key,timeout_at,payload)
  values (:'organization',:'workspace',:'person',:'person','fixture-active',now() + interval '1 hour','{}');
""")
    rejected_unchanged('snow', 'target has active jobs')
    sql(TARGET, "delete from allrice_jobs where idempotency_key='fixture-active';")

    setup_failure = """
create function synthetic_fail_delete() returns trigger language plpgsql as $$
begin
  raise exception 'synthetic late delete failure';
end $$;
create trigger synthetic_fail_delete before delete on allrice_employee_assignments
for each row execute function synthetic_fail_delete();
"""
    teardown_failure = """
drop trigger synthetic_fail_delete on allrice_employee_assignments;
drop function synthetic_fail_delete();
"""
    sql(TARGET, setup_failure)
    rejected_unchanged('snow', 'synthetic late delete failure')
    sql(TARGET, teardown_failure)
    assert snapshot(sql) == before and policy_row() == old_row

    assert reset('snow')['rows']
    assert snapshot(sql) == expect_snow and policy_row() == old_row
    assert not reset('snow')['rows'] and snapshot(sql) == expect_snow and policy_row() == old_row

    rejected_unchanged('cutover', 'rollout policy changed since approved snapshot',
                       expected={**old_policy, 'revision': 'stale'})
    rejected_unchanged('cutover', 'rollout policy changed since approved snapshot',
                       expected={**old_policy, 'selections': old_policy['selections'][:2]})
    sql(TARGET, """
update allrice_settings set value=jsonb_set(value,'{selections,1}',
  (value->'selections'->1) || jsonb_build_object('employeeInstanceId',:'admin','generation','4.0'))
where scope_type='system' and scope_id is null and key='d_entry_rollout_policy';
""")
    rejected_unchanged('cutover', 'unapproved account still has a rollout tuple', expected=policy_row()['value'])
    sql(TARGET, """
update allrice_settings set value=:'original'::jsonb
where scope_type='system' and scope_id is null and key='d_entry_rollout_policy';
""", original=json.dumps(old_policy))
    assert policy_row() == old_row
    assert not reset('cutover', mode='plan', expected=old_policy)['rows']
    assert policy_row() == old_row
    sql(TARGET, """
create function synthetic_fail_policy() returns trigger language plpgsql as $$
begin
  raise exception 'synthetic late rollout failure';
end $$;
create trigger synthetic_fail_policy after update on allrice_settings
for each row execute function synthetic_fail_policy();
""")
    rejected_unchanged('cutover', 'synthetic late rollout failure', expected=old_policy)
    sql(TARGET, 'drop trigger synthetic_fail_policy on allrice_settings; drop function synthetic_fail_policy();')
    cutover = reset('cutover', expected=old_policy)
    assert not cutover['rows']
    policy = cutover['policy']
    assert policy_row()['value'] == policy
    assert policy['selections'] == [
        {'organizationId': ORG, 'personId': PERSON}, *old_policy['selections'][1:3],
        {'organizationId': ORG, 'personId': ACCEPTOR},
    ]
    assert policy['revision'] != old_policy['revision'] and policy['defaultGeneration'] == '3.x'
    new_row = policy_row()
    for key in ['id', 'scope_type', 'scope_id', 'key', 'updated_by']:
        assert new_row[key] == old_row[key]
    assert snapshot(sql) == expect_snow
    rejected_unchanged('cutover', 'rollout policy changed since approved snapshot', expected=old_policy)
    assert not reset('cutover', expected=policy)['rows'] and policy_row() == new_row

    rejected_unchanged('acceptance', 'rollout policy changed since approved snapshot')
    replace_policy = """
update allrice_settings set value=:'replacement'::jsonb
where scope_type='system' and scope_id is null and key='d_entry_rollout_policy';
"""
    for changed_policy in [
        {**policy, 'revision': 'changed-after-cutover'},
        {**policy, 'selections': [policy['selections'][0], *reversed(policy['selections'][1:3]), policy['selections'][3]]},
    ]:
        sql(TARGET, replace_policy, replacement=json.dumps(changed_policy))
        rejected_unchanged('acceptance', 'rollout policy changed since approved snapshot', expected=policy)
    sql(TARGET, replace_policy, replacement=json.dumps(policy))
    assert policy_row() == new_row

    sql(TARGET, setup_failure)
    rejected_unchanged('acceptance', 'synthetic late delete failure', expected=policy)
    sql(TARGET, teardown_failure)
    assert snapshot(sql) == expect_snow and policy_row() == new_row
    assert reset('acceptance', expected=policy)['rows']
    assert snapshot(sql) == expect_both and policy_row() == new_row
    assert sql(TARGET, trigger_query).stdout == triggers
    assert not reset('acceptance', expected=policy)['rows'] and snapshot(sql) == expect_both and policy_row() == new_row
    print(f'PASS: independently cleared both accounts across {len(ALL_REMOVALS)} row families; {len(before)} tables reconciled', flush=True)
    print('PASS: unauthorized identities, cross-person references, unknown dependents, active jobs, stale rollout and late failures rejected unchanged', flush=True)
    print('PASS: retained native JSON and memory references rejected; acceptance bound to the committed rollout value', flush=True)
    print('PASS: two-person rollout changed once; unrelated entries, shared rows, accounts, credentials and FKs preserved', flush=True)


def interrupted(signum, _frame):
    # Do not raise across Popen's child creation/handle handoff or shutdown.
    global requested_signal
    requested_signal = signum


def check_interrupted():
    if requested_signal is not None:
        raise InterruptedError(f'rehearsal interrupted by signal {requested_signal}')


def main():
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    # No host/database arguments, no fallback to DATABASE_URL or the test PG
    # service. The data directory, Unix socket and dump are all temporary.
    root = Path(tempfile.mkdtemp(prefix='snowpg-', dir='/tmp'))
    pgdata = root / 'pg'
    server = None
    try:
        passfile = root / 'pgpass'
        passfile.touch(mode=0o600)
        PG_ENV['PGPASSFILE'] = str(passfile)
        run(['initdb', '-D', str(pgdata), '-U', 'snow_rehearsal', '-A', 'trust', '-E', 'UTF8'])
        with (root / 'postgres.log').open('wb') as log:
            server = subprocess.Popen(
                ['postgres', '-D', str(pgdata), '-c', 'listen_addresses=', '-p', '5432', '-k', str(root)],
                env=PG_ENV, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            )
        deadline = time.monotonic() + 15
        while run(['pg_isready', '-q', '-h', str(root), '-p', '5432', '-t', '1',
                   '-U', 'snow_rehearsal', '-d', 'postgres'], suppress=True).returncode:
            if server.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError('private PostgreSQL failed readiness')
            time.sleep(0.1)
        exercise(root, root / 'synthetic.dump')
    finally:
        if server is not None and server.poll() is None:
            server.send_signal(signal.SIGINT)  # PostgreSQL fast shutdown and join.
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.send_signal(signal.SIGQUIT)
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    raise RuntimeError(f'PostgreSQL shutdown incomplete; retained private directory {root}') from None
        shutil.rmtree(root)
    check_interrupted()
    print('Private PostgreSQL stopped; socket, dump and data directory released', flush=True)


if __name__ == '__main__':
    if len(sys.argv) != 1 or not __debug__:
        raise SystemExit('rehearse.py requires assertions enabled and accepts no arguments')
    main()
