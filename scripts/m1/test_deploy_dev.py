# Unit tests for scripts/m1/deploy-dev (MET-221): migration/contract gates, plist
# cleanup and recovery, and the pre-migration snapshot. deploy-dev is sourced for
# its functions in a fake HOME with psql and pg_dump stubbed; a release's
# migration-compatibility.js is imported by the real node.
#   python3 -m unittest discover -s scripts/m1 -p 'test_*.py'
import gzip
import json
import os
import plistlib
import re
import runpy
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DEPLOY_DEV = os.path.join(HERE, 'deploy-dev')
_pinned = os.path.expanduser('~/.local/opt/node-22.23.2/bin/node')
NODE = _pinned if os.path.exists(_pinned) else shutil.which('node')
QA_DATABASE = 'allrice40_qa_tool_test'
QA_DATABASE_URL = 'postgres://tester@127.0.0.1:5434/' + QA_DATABASE
QA_DATABASE_CLAIM = '49000:allrice40-qa:' + 'b' * 32
ARCHIVED = [
    '0073_gemini_model_provider.sql',
    '0213_native_chat_executor_transitions.sql',
    '0214_native_control_cloud_absence.sql',
    '0215_terminal_native_test_retirements.sql',
    '0216_native_legacy_chat_adoption.sql',
]
FILES = ['0001_baseline.sql', '0073_runtime_operation_ledger.sql', '0212_dsh_runtime_close_observations.sql',
         '0217_brand_content_feedback.sql', '0218_native_generation_binding.sql']


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)
    os.chmod(path, mode)


@unittest.skipUnless(NODE, 'node is not installed')
class DeployDevMigrations(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix='deploy-dev-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, 'home')
        self.releases = os.path.join(self.home, 'allrice40-dev-releases')
        self.initial_release = self.release()
        local = os.path.join(self.home, 'allrice40-dev/.local')
        self.once_reference = json.dumps({'artifactId': 'provenance', 'stateRoot': local + '/native-once-control-m1'})
        for role in ('web', 'worker'):
            path = os.path.join(self.home, 'Library/LaunchAgents/ai.bplabs.allrice40-dev-%s.plist' % role)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'wb') as f:
                plistlib.dump(self.plist(role), f)
        write(os.path.join(self.home, 'allrice40-dev/.env'), 'ALLRICE_TEST=1\n', 0o600)
        write(os.path.join(local, 'storage/org/file.txt'), 'stored')
        write(os.path.join(local, 'dsh-runtime-m1/rt/journal.jsonl'), '{"v":1}\n')
        write(os.path.join(local, 'bridge/big.bin'), 'not snapshotted')
        self.stubs = os.path.join(self.tmp, 'stubs')
        self.applied = os.path.join(self.tmp, 'applied.txt')
        # $CONTRACT_FILE holds psql's answer for the journal contract row ('row:<highWater>', empty: no row).
        write(os.path.join(self.stubs, 'psql'), '#!/bin/sh\n[ -z "$PSQL_FAIL" ] || exit 2\nfor a; do q=$a; done\n'
              'case "$q" in *to_regclass*person_virtual_machines*|*to_regclass*person_vm_scheduled_wakes*) echo f ;; *allrice_runtime_metadata*) [ -z "$CONTRACT_FAIL" ] || exit 2; cat "$CONTRACT_FILE" 2>/dev/null ;; *) cat "$APPLIED" ;; esac\n', 0o755)
        write(os.path.join(self.stubs, 'pg_dump'), '#!/bin/sh\n[ -z "$PG_DUMP_FAIL" ] || exit 1\necho "-- dump of $*"\n', 0o755)
        write(os.path.join(self.stubs, 'curl'), '#!/bin/sh\nexit 7\n', 0o755)
        write(os.path.join(self.stubs, 'launchctl'), '#!/bin/sh\nexit 113\n', 0o755)
        write(os.path.join(self.stubs, 'ps'), '#!/bin/sh\n'
              'if [ -z "$PROCESS_TREE_STOPPED" ] && [ -n "$PROCESS_ARGS_BEFORE" ]; then '
              'printf "%s" "$PROCESS_ARGS_BEFORE"; else printf "%s" "$PROCESS_ARGS"; fi\n', 0o755)
        write(os.path.join(self.stubs, 'lsof'), '#!' + sys.executable + '\n'
              'import json,os,sys\n'
              'for fields in json.loads(os.environ.get("PROCESS_LSOF", "[]")):\n'
              '    sys.stdout.buffer.write(("\\0".join(fields) + "\\0\\n").encode())\n'
              'print(os.environ.get("PROCESS_LSOF_WARNING", ""), end="", file=sys.stderr)\n'
              'sys.exit(int(os.environ.get("PROCESS_LSOF_EXIT", "0")))\n', 0o755)
        if sys.platform != 'darwin':  # GNU cp has no clonefile flag
            write(os.path.join(self.stubs, 'cp'), '#!/bin/sh\n[ "$1" != -c ] || shift\nexec /bin/cp "$@"\n', 0o755)
        self.snapshots = os.path.join(self.home, 'allrice40-dev/qa/pre-migrate')

    def plist(self, role, release=None, legacy=False):
        release = release or self.initial_release
        local = os.path.join(self.home, 'allrice40-dev/.local')
        env = {'DATABASE_URL': 'postgres://tester@127.0.0.1:5434/allrice40_dev', 'ALLRICE_WEB_PORT': '3311', 'ALLRICE_WORKER_PORT': '3312',
               'ALLRICE_RELEASE_SHA': 'a' * 40, 'ALLRICE_DSH_NATIVE_ARTIFACT_ID': 'sha256:' + 'a' * 64,
               'ALLRICE_NATIVE_ONCE_REFERENCE': self.once_reference, 'UNRELATED_SETTING': 'keep',
               'ALLRICE_STORAGE_ROOT': local + '/storage', 'ALLRICE_EXECUTION_ROOT': local + '/executions',
               'ALLRICE_DSH_RUNTIME_ROOT': local + '/dsh-runtime-m1', 'ALLRICE_DSH_PLATFORM_HOME': local + '/dsh-platform'}
        if legacy:
            env.update({'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID': 'old-root',
                        'ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS': 'obsolete-not-json',
                        'ALLRICE_DSH_RETAINED_ARTIFACT_ID': 'old', 'ALLRICE_DSH_RETAINED_ROOT_2': '/old',
                        'ALLRICE_DSH_ORIGIN_READER_ROOT': '/old-reader'})
        return {'Label': 'ai.bplabs.allrice40-dev-' + role,
                'WorkingDirectory': release + ('/apps/web' if role == 'web' else ''), 'KeepAlive': True,
                'ProgramArguments': [NODE, '--env-file=' + self.home + '/allrice40-dev/.env',
                                     release + ('/apps/web/server.mjs' if role == 'web' else '/apps/worker/dist/index.js')],
                'EnvironmentVariables': env}

    def live_plist(self, role):
        return os.path.join(self.home, 'Library/LaunchAgents/ai.bplabs.allrice40-dev-%s.plist' % role)

    def read_plist(self, path):
        with open(path, 'rb') as f:
            return plistlib.load(f)

    def seed_legacy_plists(self):
        for role in ('web', 'worker'):
            with open(self.live_plist(role), 'wb') as f:
                plistlib.dump(self.plist(role, legacy=True), f)

    def assert_no_legacy_settings(self, env):
        self.assertNotIn('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', env)
        self.assertNotIn('ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS', env)
        self.assertFalse(any(key.startswith('ALLRICE_DSH_RETAINED_') for key in env))
        self.assertFalse(any(key.startswith('ALLRICE_DSH_ORIGIN_READER_') for key in env))

    def seed_identity(self, rel, sha):
        for entry in ('apps/web/server.mjs', 'apps/worker/dist/index.js'):
            write(os.path.join(rel, entry), '')
        write(os.path.join(rel, '.local/dev-build-identity.json'), json.dumps({
            'repository': 'semiok/allrice-vm', 'repositoryId': 1469490636, 'environment': 'dev',
            'sourceSha': sha, 'sourceTree': 'd' * 40, 'manifestDigest': 'sha256:' + 'e' * 64, 'files': [],
        }))

    def release(self, files=FILES, archived=ARCHIVED, module=None, store=True, sha='a' * 40):
        os.makedirs(self.releases, exist_ok=True)
        rel = tempfile.mkdtemp(prefix='rel-', dir=self.releases)
        self.seed_identity(rel, sha)
        db = os.path.join(rel, 'packages/database')
        for name in files:
            write(os.path.join(db, 'migrations', name), '-- %s\n' % name)
        write(os.path.join(db, 'migrations/README.md'), 'not a migration')
        write(os.path.join(db, 'package.json'), '{"type":"module"}\n')
        if module is None:
            module = 'export const archivedMigrationNames = %s;\nexport function migrationsMatch() {}\n' % archived
        if module is not False:
            write(os.path.join(db, 'dist/migration-compatibility.js'), module)
        # Importing anything else would be a bug: migrate.js runs migrations when it loads.
        write(os.path.join(db, 'dist/migrate.js'), 'throw new Error("migrate.js was imported");\n')
        if store:  # releases from MET-221 PR2b-1 on know the journal contract high water
            write(os.path.join(db, 'dist/native-journal-contract-store.js'), 'export {};\n')
        return rel

    def remove_deploy_build(self):
        for entry in os.listdir(self.releases):
            if re.fullmatch(r'20[0-9]{6}-[0-9]{4}-[a-f0-9]{8}', entry):
                shutil.rmtree(os.path.join(self.releases, entry))

    def run_dd(self, script, applied, CONTRACT='', **env):
        write(self.applied, ''.join(n + '\n' for n in applied))
        env['CONTRACT_FILE'] = os.path.join(self.tmp, 'contract.txt')
        write(env['CONTRACT_FILE'], CONTRACT)
        path = ':'.join([self.stubs, os.path.dirname(NODE), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])
        # The source helper imports service_target under this isolated environment.
        env = dict(HOME=self.home, PATH=path, TEST_PATH=path, APPLIED=self.applied,
                   PYTHONDONTWRITEBYTECODE='1', **env)
        initial = ('source "$1"; PATH=$TEST_PATH; M1_LAUNCHCTL="$TEST_STUBS/launchctl"; '
                   'port_closed() { return 0; }; ')
        env['TEST_STUBS'] = self.stubs
        return subprocess.run(['/bin/bash', '-c', initial + script,
                               'test', DEPLOY_DEV], env=env, capture_output=True, text=True, timeout=60)

    def check(self, rel, applied):  # -> (known, printed)
        p = self.run_dd('if out=$(check_migrations_known "$REL"); then echo "OK $out"; else echo "REFUSED $out"; fi',
                        applied, REL=rel)
        self.assertEqual(p.returncode, 0, p.stderr)
        verdict, _, printed = p.stdout.strip().partition(' ')
        return verdict == 'OK', printed

    def test_drain_cli_accepts_no_socket_hint_under_bash_nounset(self):
        p = self.run_dd(r"""
          fake_python() { printf '%s\n' "$@"; cat >/dev/null; }
          M1_PY=fake_python
          DRAIN_TOKEN=synthetic
          worker_drain_cli 661e00de-c0fc-45e6-a1db-bfd158aedad8 73001
        """, FILES)
        self.assertEqual(p.returncode, 0, (p.stdout, p.stderr))
        self.assertEqual(p.stdout.splitlines()[1:], [
            '--pid', '73001', '--boot-id', '661e00de-c0fc-45e6-a1db-bfd158aedad8',
        ])

    def test_release_refuses_running_vms_without_a_drain(self):
        p = self.run_dd("""
          job_state() { echo 'running 73001'; }
          vm_upgrade_candidates() { echo 1; }
          stop_job() { echo "unexpected stop"; return 99; }
          stop_both
        """, FILES)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('require a current Worker drain receipt', p.stdout)
        self.assertNotIn('unexpected stop', p.stdout)

    def test_release_consumes_only_current_drain_and_never_forces_deferred_worker(self):
        write(os.path.join(self.initial_release, '.local/person-vm-host.json'), '{}', 0o600)
        manifest = os.path.join(self.initial_release, '.local/dev-build-identity.json')
        with open(manifest) as f:
            identity = json.load(f)
        identity['files'] = [{'path': '.local/person-vm-host.json', 'scope': 'worker'}]
        write(manifest, json.dumps(identity))
        plist = self.read_plist(self.live_plist('worker'))
        plist['KeepAlive'] = {'SuccessfulExit': False}
        with open(self.live_plist('worker'), 'wb') as f:
            plistlib.dump(plist, f)
        for mode in ('missing', 'stale', 'expired', 'deferred', 'wake-before', 'wake-during', 'wake-after', 'success'):
            with self.subTest(mode=mode):
                p = self.run_dd(r"""
                  M1_LAUNCHCTL=test_launchctl
                  test_launchctl() {
                    echo "$1"
                    [ "$1" != bootout ] || stopped=yes
                  }
                  job_state() {
                    if [ "${stopped:-}" = yes ]; then echo gone; else echo 'running 73001'; fi
                  }
                  vm_upgrade_candidates() { echo 0; }
                  dev_sql() {
                    case "$1" in
                      *to_regclass*) echo t ;;
                      *'select not exists'*)
                        if [ "$MODE" = wake-before ] ||
                          [ -f "$STATE/fixture-wake" ]; then echo f; else echo t; fi ;;
                      *) return 1 ;;
                    esac
                  }
                  worker_boot() { echo '661e00de-c0fc-45e6-a1db-bfd158aedad8'; }
                  DRAIN_SOCKET=/test/owner
                  DRAIN_TOKEN=fixture
                  read_drain_receipt() {
                    [ "$MODE" != missing ] || return 1
                    local valid='661e00de-c0fc-45e6-a1db-bfd158aedad8' year=2099
                    [ "$MODE" != stale ] || valid='144d2c90-65c5-44a7-b3e2-54589ab0eb79'
                    [ "$MODE" != expired ] || year=2020
                    if [ "$MODE" = wake-during ]; then touch "$STATE/fixture-wake"; fi
                    printf '{"bootId":"%s","stopped":2,"expiresAt":"%s-01-01T00:00:00Z"}\n' "$valid" "$year"
                  }
                  claim_drained_worker() {
                    echo claim
                    if [ "$MODE" = wake-after ]; then touch "$STATE/fixture-wake"; fi
                  }
                  wait_for_drained_worker_exit() { [ "$MODE" != deferred ]; }
                  port_closed() { return 0; }
                  stop_job() { echo "stop-web $1"; }
                  mkdir -p "$STATE"
                  rm -f "$STATE/fixture-wake"
                  stop_both release
                """, FILES, MODE=mode)
                lines = p.stdout.splitlines()
                if mode == 'success':
                    self.assertEqual(p.returncode, 0, (p.stdout, p.stderr))
                    self.assertEqual(lines[:2], ['claim', 'bootout'])
                    self.assertIn('Person VM drain consumed:', p.stdout)
                    self.assertIn('stop-web', p.stdout)
                else:
                    self.assertNotEqual(p.returncode, 0)
                    self.assertEqual('bootout' in lines, mode == 'wake-after')
                    self.assertNotIn('stop-web', p.stdout)
                    self.assertEqual('claim' in lines, mode in ('deferred', 'wake-after'))
                    if mode.startswith('wake-'):
                        self.assertIn('outstanding Person VM wake', p.stdout)

    def test_early_worker_exit_preserves_recovery_files_and_original_pid(self):
        write(os.path.join(self.initial_release, '.local/person-vm-host.json'), '{}', 0o600)
        manifest = os.path.join(self.initial_release, '.local/dev-build-identity.json')
        with open(manifest) as f:
            identity = json.load(f)
        identity['files'] = [{'path': '.local/person-vm-host.json', 'scope': 'worker'}]
        write(manifest, json.dumps(identity))
        plist = self.read_plist(self.live_plist('worker'))
        plist['KeepAlive'] = {'SuccessfulExit': False}
        with open(self.live_plist('worker'), 'wb') as f:
            plistlib.dump(plist, f)

        for mode in ('before-wake-guard', 'before-first-read', 'late-wake-guard',
                     'early', 'late', 'pending-wake', 'host-uninstalled'):
            with self.subTest(mode=mode):
                p = self.run_dd(r'''
                  mkdir -p "$STATE"
                  rm -f "$STATE/fixture-loaded"
                  case "$MODE" in
                    before-wake-guard|before-first-read) touch "$STATE/fixture-loaded" ;;
                  esac
                  if [ "$MODE" = before-wake-guard ]; then
                    verify_no_committed_vm_wakes() { return 1; }
                  elif [ "$MODE" = late-wake-guard ]; then
                    verify_no_committed_vm_wakes() {
                      if [ -f "$STATE/first-probe" ]; then return 1; fi
                      touch "$STATE/first-probe"
                    }
                  fi
                  job_state() {
                    if [ -f "$STATE/fixture-loaded" ]; then echo loaded; else echo 'running 73001'; fi
                  }
                  worker_boot() { echo '661e00de-c0fc-45e6-a1db-bfd158aedad8'; }
                  read_drain_receipt() {
                    test -s "$INFLIGHT/worker-exit" || return 1
                    if [ "$MODE" = late ]; then return 1; fi
                    touch "$STATE/fixture-loaded"
                    echo '{"bootId":"661e00de-c0fc-45e6-a1db-bfd158aedad8","stopped":0,"expiresAt":"2099-01-01T00:00:00Z"}'
                  }
                  DRAIN_TOKEN=fixture
                  inflight_begin "$(penv "$WORKER_PLIST" ALLRICE_RELEASE_SHA)"
                  stop_both release
                ''', FILES, MODE=mode)
                self.assertNotEqual(p.returncode, 0, (p.stdout, p.stderr))
                self.assertIn('Worker exit unconfirmed', p.stdout)
                state = os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight')
                if mode.startswith('before-'):
                    self.assertFalse(os.path.exists(os.path.join(state, 'worker-exit')))
                else:
                    with open(os.path.join(state, 'worker-exit')) as f:
                        self.assertEqual(f.read().splitlines(), [
                            self.initial_release, '73001', '661e00de-c0fc-45e6-a1db-bfd158aedad8',
                        ])
                self.assertTrue(os.path.isfile(os.path.join(state, 'state')))
                # The original process can disappear after the refusal was recorded.
                write(os.path.join(self.home, 'allrice40-dev/qa/fixture-loaded'), '')

                p = self.run_dd(r'''
                  M1_LAUNCHCTL=test_launchctl
                  test_launchctl() { test "$1" = bootout; }
                  job_state() { if [ -n "${restored:-}" ]; then echo 'running 73002'; else echo loaded; fi; }
                  worker_vm_recovery() {
                    [ "$2" = 73002 ] || return 1
                    if [ "$MODE" = host-uninstalled ]; then
                      echo '661e00de-c0fc-45e6-a1db-bfd158aedad8 uninstalled'
                    else
                      echo '661e00de-c0fc-45e6-a1db-bfd158aedad8 host-ready'
                    fi
                  }
                  wait_for_drained_worker_exit() {
                    if [[ "$MODE" = before-* ]]; then
                      test -z "$1" || return 1
                    else
                      test "$1" = 73001 || return 1
                    fi
                    echo joined-original
                  }
                  dev_sql() {
                    case "$1" in
                      *to_regclass*) echo t ;;
                      *'select not exists'*) [ "$MODE" != pending-wake ] && echo t || echo f ;;
                      *) command psql -X -At -c "$1" ;;
                    esac
                  }
                  vm_upgrade_candidates() { echo 1; }
                  stop_job() { :; }
                  start_both_on() { restored=yes; echo "restarted $1"; }
                  recover
                ''', FILES, CONTRACT='row:1', MODE=mode)
                if mode in ('pending-wake', 'host-uninstalled'):
                    self.assertNotEqual(p.returncode, 0, (p.stdout, p.stderr))
                    self.assertIn('joined-original', p.stdout)
                    self.assertIn('restarted ' + 'a' * 40, p.stdout)
                    self.assertNotIn('is healthy again', p.stdout)
                    self.assertTrue(os.path.isfile(os.path.join(state, 'state')))
                    if mode == 'host-uninstalled':
                        retry = r'''
                          job_state() {
                            if [ -n "${restored:-}" ]; then echo 'running 73003'
                            elif [ -n "${removed:-}" ]; then echo gone
                            else echo 'running 73002'
                            fi
                          }
                          worker_boot() { echo '661e00de-c0fc-45e6-a1db-bfd158aedad8'; }
                          worker_vm_recovery() {
                            case "$2:$MODE" in
                              73002:known) echo "$(worker_boot) uninstalled" ;;
                              73003:known) echo "$(worker_boot) wake-ready" ;;
                            esac
                          }
                          verify_no_committed_vm_wakes() { [ -n "${restored:-}" ]; }
                          kill() { test "$*" = '-TERM 73002' && echo exact-worker-term; }
                          wait_for_drained_worker_exit() { test "$1" = 73002; }
                          M1_LAUNCHCTL=test_launchctl
                          test_launchctl() { test "$1" = bootout && removed=yes; }
                          stop_job() { :; }
                          vm_upgrade_candidates() { echo 1; }
                          start_both_on() { restored=yes; }
                          recover
                        '''
                        unknown = self.run_dd(retry, FILES, CONTRACT='row:1', MODE='unknown')
                        self.assertNotEqual(unknown.returncode, 0, (unknown.stdout, unknown.stderr))
                        self.assertNotIn('exact-worker-term', unknown.stdout)
                        self.assertTrue(os.path.isfile(os.path.join(state, 'state')))
                        resumed = self.run_dd(retry, FILES, CONTRACT='row:1', MODE='known')
                        self.assertEqual(resumed.returncode, 0, (resumed.stdout, resumed.stderr))
                        self.assertIn('exact-worker-term', resumed.stdout)
                        self.assertFalse(os.path.exists(state))
                    else:
                        shutil.rmtree(state)
                    continue
                self.assertEqual(p.returncode, 0, (p.stdout, p.stderr))
                self.assertIn('joined-original', p.stdout)
                self.assertIn('restarted ' + 'a' * 40, p.stdout)
                self.assertFalse(os.path.exists(state))

    def test_archived_names_are_known(self):
        known, pending = self.check(self.release(), FILES + ARCHIVED)
        self.assertTrue(known)
        self.assertEqual(pending, '')

    def test_names_that_differ_slightly_are_refused(self):
        rel = self.release()
        for near in ('0213_x.sql', '0213_native_chat_executor_transition.sql', '0214_native_control_cloud_absence.sq',
                     '0215_Terminal_native_test_retirements.sql', ' 0216_native_legacy_chat_adoption.sql', 'README.md'):
            with self.subTest(near=near):
                known, printed = self.check(rel, FILES + ARCHIVED[:1] + [near])
                self.assertFalse(known)
                self.assertIn(near.strip(), printed)

    def test_unarchived_deleted_migration_is_refused(self):
        known, printed = self.check(self.release(archived=ARCHIVED[:1]), FILES + ARCHIVED)
        self.assertFalse(known)
        self.assertIn('0213_native_chat_executor_transitions.sql', printed)

    def test_unreadable_archive_list_refuses(self):
        for module in (False, 'export const somethingElse = [];\n', 'export const archivedMigrationNames = ["../x"];\n',
                       'import "./migrate.js";\nexport const archivedMigrationNames = [];\n'):
            with self.subTest(module=module):
                known, printed = self.check(self.release(module=module), FILES)
                self.assertFalse(known)
                self.assertIn('cannot read archivedMigrationNames', printed)

    def test_unreadable_database_refuses(self):
        p = self.run_dd('check_migrations_known "$REL" || echo "REFUSED"', FILES, REL=self.release(), PSQL_FAIL='1')
        self.assertIn('cannot read allrice_schema_migrations', p.stdout)
        self.assertIn('REFUSED', p.stdout)

    def test_pending_migrations_are_listed(self):
        known, pending = self.check(self.release(), FILES[:-1] + ARCHIVED)
        self.assertTrue(known)
        self.assertEqual(pending, '0218_native_generation_binding.sql')

    def snapshot(self, applied, forced='0', name='20261026-1800-abcdef12', **env):
        return self.run_dd('inflight_phase() { :; }; pending=$(check_migrations_known "$REL"); pre_migrate_snapshot "$NAME" "$pending" "$FORCED"',
                           applied, REL=self.release(), NAME=name, FORCED=forced, **env)

    def test_no_snapshot_without_migrations(self):
        p = self.snapshot(FILES + ARCHIVED)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('no migrations to apply; no snapshot', p.stdout)
        self.assertFalse(os.path.exists(self.snapshots))

    def assert_snapshot(self, name):
        d = os.path.join(self.snapshots, name)
        self.assertEqual(sorted(os.listdir(d)), ['allrice40_dev.sql.gz', 'dsh-runtime-m1', 'env', 'storage', 'web.plist', 'worker.plist'])
        with gzip.open(os.path.join(d, 'allrice40_dev.sql.gz'), 'rt') as f:
            self.assertEqual(f.read(), '-- dump of -Fp --no-owner --no-privileges postgres://tester@127.0.0.1:5434/allrice40_dev\n')
        with open(os.path.join(d, 'storage/org/file.txt')) as f:
            self.assertEqual(f.read(), 'stored')
        self.assertEqual(os.stat(os.path.join(d, 'env')).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(d).st_mode & 0o777, 0o700)

    def test_snapshot_before_pending_migrations(self):
        p = self.snapshot(FILES[:-1] + ARCHIVED)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('to apply: 0218_native_generation_binding.sql', p.stdout)
        self.assert_snapshot('20261026-1800-abcdef12')

    def test_forced_snapshot_without_migrations(self):
        p = self.snapshot(FILES + ARCHIVED, forced='1')
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('forced; no migrations to apply', p.stdout)
        self.assert_snapshot('20261026-1800-abcdef12')

    def test_keeps_the_newest_two_snapshots(self):
        for name in ('20261026-1000-aaaaaaaa', '20261026-1200-cccccccc', '20261026-1100-bbbbbbbb'):
            self.assertEqual(self.snapshot(FILES + ARCHIVED, forced='1', name=name).returncode, 0)
        self.assertEqual(sorted(os.listdir(self.snapshots)), ['20261026-1100-bbbbbbbb', '20261026-1200-cccccccc'])

    def test_pruning_is_best_effort_and_clears_leftovers(self):
        for name in ('20261026-1000-aaaaaaaa/ro', '20261026-1100-bbbbbbbb', '20261026-0900-killed.tmp'):
            os.makedirs(os.path.join(self.snapshots, name))
        locked = os.path.join(self.snapshots, '20261026-1000-aaaaaaaa/ro')
        write(os.path.join(locked, 'f'), 'x')
        os.chmod(locked, 0o555)  # rm -rf cannot empty it
        self.addCleanup(os.chmod, locked, 0o755)
        p = self.snapshot(FILES + ARCHIVED, forced='1', name='20261026-1200-cccccccc')
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('could not prune', p.stderr)
        self.assertEqual(sorted(os.listdir(self.snapshots)), ['20261026-1000-aaaaaaaa', '20261026-1100-bbbbbbbb', '20261026-1200-cccccccc'])

    def precheck(self, output, earlier=''):
        rel = self.release()
        write(os.path.join(rel, 'scripts/dev-release/verify-native-retention.mjs'),
              'console.error(%s); process.exit(1);\n' % json.dumps(output))
        log = os.path.join(self.tmp, 'deploy.log')
        write(log, earlier)
        p = self.run_dd('precheck "$REL" sha art "$PLOG" || echo "REFUSED"', [], REL=rel, PLOG=log)
        self.assertIn('REFUSED', p.stdout, p.stderr)
        return p.stdout

    def test_precheck_names_the_failure(self):
        cases = [
            ('Error: DSH_NATIVE_CONTEXT_INCOMPATIBLE [chat 1 generation]', 'incompatible with this version'),
            ('Error: DSH_NATIVE_JOURNAL_CONTRACT_AHEAD [2 > 1]', 'journal contract range does not cover'),
            ('error: relation "allrice_new_table" does not exist', 'a defect, the checker must run on the schema before'),
            ('Error: DSH_NATIVE_ARTIFACT_REFERENCES_UNCOVERED [INCOMPATIBLE-looking detail]', 'pre-stop native check failed: DSH_NATIVE_ARTIFACT_REFERENCES_UNCOVERED'),
        ]
        for output, expected in cases:
            with self.subTest(output=output):
                result = self.precheck(output)
                self.assertIn(expected, result)
                self.assertNotIn('MET-195', result)
                self.assertNotIn('two-step', result)
        # Text from earlier in the deploy log (the build) is not this check's failure.
        out = self.precheck('Error: DSH_NATIVE_SOMETHING_ELSE', earlier='relation "x" does not exist\n')
        self.assertIn('pre-stop native check failed: DSH_NATIVE_SOMETHING_ELSE', out)

    def contract(self, rel, high_water, **env):
        p = self.run_dd('if out=$(check_contract_known "$REL"); then echo "OK"; else echo "REFUSED $out"; fi',
                        FILES + ARCHIVED, REL=rel, CONTRACT=high_water, **env)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout.strip()

    def test_journals_above_contract_1_need_a_release_that_knows_the_contract(self):
        old, new = self.release(store=False), self.release()
        self.assertIn('predates the journal contract', self.contract(old, 'row:2'))
        self.assertEqual(self.contract(new, 'row:2'), 'OK')
        for row in ('', 'row:1'):  # no row yet, or the PR2b-1 baseline
            with self.subTest(row=row):
                self.assertEqual(self.contract(old, row), 'OK')
        for row in ('row:', 'row:0', 'row:01', 'row:2.5', 'row:1234567890', 'row:invalid 2', 'row:invalid {"highWater": "2"}'):
            with self.subTest(row=row):  # a row that is there but not the store's shape
                self.assertIn('unreadable journal contract row', self.contract(new, row))
        self.assertIn('cannot read the journal contract', self.contract(new, 'row:2', PSQL_FAIL='1'))

    def test_status_shows_whether_a_rollback_would_pass(self):
        old = self.release(store=False)
        write(os.path.join(self.home, 'allrice40-dev/qa/.previous-release'), old + '\n' + self.initial_release + '\n')
        for high_water, expected in (('1', 'it predates the journal contract, fine while the journals are at contract 1'),
                                     ('2', 'would be REFUSED: the journals reach contract 2')):
            with self.subTest(high_water=high_water):
                p = self.run_dd('status', FILES + ARCHIVED, CONTRACT='row:' + high_water)
                self.assertEqual(p.returncode, 0, p.stderr)
                self.assertIn('journal contract:   high water %s' % high_water, p.stdout)
                self.assertIn(expected, p.stdout)

    # Flow tests: everything that would build, lock or touch launchd is stubbed; STOPPED in
    # the output means the run got as far as stopping Dev.
    FLOW_STUBS = ('precheck() { echo PRECHECK >&2; [ -z "${RAISE:-}" ] || printf %s "$RAISE" > "$CONTRACT_FILE"; }; '
                  'take_lock() { echo LOCKED; }; '
                  'inflight_begin() { :; }; stop_both() { echo STOPPED; return 1; }; ')

    def test_rollback_checks_the_contract_before_stopping_and_again_under_the_lock(self):
        old = self.release(store=False)
        log = os.path.join(self.home, 'allrice40-dev/qa/deploys.jsonl')
        write(log, json.dumps({'kind': 'deploy', 'toRelease': old, 'toSha': 'a' * 40, 'toArtifact': 'sha256:' + 'a' * 64}) + '\n')
        run = lambda **env: self.run_dd(self.FLOW_STUBS + 'rollback "$OLD"', FILES + ARCHIVED, OLD=old, **env)
        for race in (False, True):
            with self.subTest(race=race):
                p = run(CONTRACT='row:1', RAISE='row:2') if race else run(CONTRACT='row:2')
                self.assertNotEqual(p.returncode, 0)
                self.assertIn('predates the journal contract', p.stderr)
                self.assertEqual('PRECHECK' in p.stderr, race)
                self.assertEqual('LOCKED' in p.stdout, race)
                self.assertNotIn('STOPPED', p.stdout)
                self.assert_recovery_guidance(p.stderr)
                with open(log) as f:
                    records = [json.loads(line) for line in f]
                self.assertEqual(len(records), 3 if race else 2)
                self.assertEqual(records[-1]['kind'], 'failed')
                self.assertEqual(records[-1]['phase'], 'rollback-contract')
                self.assertIn(records[-1]['reason'], p.stderr)
        self.assertIn('STOPPED', run(CONTRACT='row:1').stdout)

    def test_deploy_refuses_an_old_candidate_before_stopping(self):
        old = self.release(store=False, sha='b' * 40)
        stubs = self.FLOW_STUBS + (
            'df() { printf "h\\nx x x 100\\n"; }; resolve_ref() { echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; }; '
            'git() { [ "$3 $4" != "worktree add" ] || { mkdir -p "$(dirname "$7")" && cp -R "$OLD" "$7"; }; }; pnpm() { :; }; '
            'node() { case "$1" in apps/*) echo \'{"artifactId":"sha256:%s"}\' ;; scripts/*) : ;; *) command node "$@" ;; esac; }; '
            % ('c' * 64))
        for high_water, stopped in (('2', False), ('1', True)):
            with self.subTest(high_water=high_water):
                p = self.run_dd(stubs + 'deploy --skip-smoke', FILES + ARCHIVED, OLD=old, CONTRACT='row:' + high_water)
                self.assertIn('PRECHECK', p.stderr)
                self.assertEqual('STOPPED' in p.stdout, stopped, p.stderr)
                if not stopped:
                    self.assertIn('predates the journal contract', p.stderr)
                    self.assertNotIn('Do not log out or reboot M1', p.stderr)
                    self.assertIn('Dev untouched', p.stderr)
                    self.assertNotIn('Restore the pre-migration snapshot', p.stderr)
                    self.assertTrue(os.path.isfile(self.live_plist('worker')))
                    with open(os.path.join(self.home, 'allrice40-dev/qa/deploys.jsonl')) as f:
                        self.assertIn('"phase": "contract"', f.read())
                self.remove_deploy_build()

    def saved_release(self, old):
        inflight = os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight')
        for role in ('web', 'worker'):  # the launchd files saved before the deploy point at the old release
            os.makedirs(inflight, exist_ok=True)
            with open(os.path.join(inflight, role + '.plist'), 'wb') as f:
                plistlib.dump(self.plist(role, release=old), f)
        write(os.path.join(inflight, 'state'), 'switching\n' + 'a' * 40 + '\n')

    def test_recovery_does_not_switch_to_another_release_with_a_committed_wake(self):
        self.saved_release(self.release(store=False))
        p = self.run_dd(r'''
          dev_sql() {
            case "$1" in
              *to_regclass*) echo t ;;
              *'select not exists'*) echo f ;;
              *) return 1 ;;
            esac
          }
          stop_release_worker() { echo unexpected-stop; }
          start_both_on() { echo unexpected-start; }
          recover
        ''', FILES + ARCHIVED, CONTRACT='row:1')
        self.assertNotEqual(p.returncode, 0, (p.stdout, p.stderr))
        self.assertIn('outstanding Person VM wake', p.stdout)
        self.assertNotIn('unexpected-stop', p.stdout)
        self.assertNotIn('unexpected-start', p.stdout)
        self.assertTrue(os.path.isfile(os.path.join(
            self.home, 'allrice40-dev/qa/deploy-inflight/state',
        )))

    def test_recovery_starts_missing_web_without_draining_the_restored_worker(self):
        for mode in ('healthy', 'wake-pending', 'worker-exited'):
            with self.subTest(mode=mode):
                self.saved_release(self.initial_release)
                p = self.run_dd(r'''
                  job_state() {
                    if [ "$1" = "$WEB_LABEL" ]; then echo gone
                    elif [ "$MODE" = worker-exited ] && [ -f "$STATE/web-ready" ]; then echo loaded
                    else echo 'running 73002'
                    fi
                  }
                  worker_vm_recovery() { echo '661e00de-c0fc-45e6-a1db-bfd158aedad8 wake-ready'; }
                  start_job() { test "$1" = "$WEB_LABEL" && echo web-started; }
                  wait_ready() { touch "$STATE/web-ready"; }
                  verify_no_committed_vm_wakes() { test "$MODE" != wake-pending; }
                  vm_upgrade_candidates() { echo 0; }
                  stop_both() { echo unexpected-stop; return 1; }
                  rm -f "$STATE/web-ready"
                  recover
                ''', FILES, CONTRACT='row:1', MODE=mode)
                self.assertIn('web-started', p.stdout)
                self.assertNotIn('unexpected-stop', p.stdout)
                self.assertEqual(p.returncode == 0, mode == 'healthy', p.stdout + p.stderr)
                self.assertEqual(os.path.isfile(os.path.join(
                    self.home, 'allrice40-dev/qa/deploy-inflight/state',
                )), mode != 'healthy')

    def test_failed_deploy_does_not_restore_a_version_that_cannot_read_the_journals(self):
        self.saved_release(self.release(store=False))
        script = 'stop_both() { :; }; start_both_on() { echo STARTED; }; if restore; then echo restore=0; else echo restore=1; fi'
        cases = (('row:2', {}, False), ('row:1', {}, True), ('row:2', {'PSQL_FAIL': '1'}, False), ('row:invalid 2', {}, False))
        for row, env, started in cases:
            with self.subTest(row=row, env=env):
                p = self.run_dd(script, FILES + ARCHIVED, CONTRACT=row, **env)
                self.assertEqual('STARTED' in p.stdout, started, p.stdout)
                self.assertIn('restore=%d' % (0 if started else 1), p.stdout)
                if not started and not env:
                    self.assertIn('not starting aaaaaaaa:', p.stdout)
                    self.assertIn('LaunchAgents plists parked', p.stdout)

    def assert_recovery_guidance(self, output):
        self.assertIn('Restore the pre-migration snapshot', output)
        self.assertIn('docs/runbooks/m1-database.md or fix forward', output)
        self.assertIn('move %s aside first' % os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight'), output)
        self.assertIn('keep %s for the next deploy' % os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled'), output)
        self.assertNotIn('Do not log out or reboot M1', output)

    def assert_parked(self):
        for role in ('web', 'worker'):
            self.assertFalse(os.path.exists(self.live_plist(role)))
            parked = os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled', role + '.plist')
            self.assertEqual(self.read_plist(parked), self.plist(role))

    def test_automatic_restore_and_recover_refuse_committed_unknown_migrations(self):
        old = self.release(files=FILES[:-1])
        for entry in ('INFLIGHT_MINE=1; die "candidate did not become healthy"', 'recover'):
            for unreadable in (False, True):
                with self.subTest(entry=entry, unreadable=unreadable):
                    self.saved_release(old)
                    log = os.path.join(self.home, 'allrice40-dev/qa/deploys.jsonl')
                    write(log, '')
                    script = ('take_lock() { :; }; stop_both() { echo STOPPED; }; '
                              'start_both_on() { echo STARTED; }; ' + entry)
                    p = self.run_dd(script, FILES + ARCHIVED, CONTRACT='row:1',
                                    **({'PSQL_FAIL': '1'} if unreadable else {}))
                    self.assertNotEqual(p.returncode, 0)
                    self.assertIn('STOPPED', p.stdout)
                    self.assertNotIn('STARTED', p.stdout)
                    self.assertNotIn('is healthy again', p.stdout)
                    self.assertNotIn('migrations have committed', p.stdout)
                    if unreadable:
                        self.assertIn('migration compatibility could not be checked', p.stdout)
                        self.assertNotIn('has applied migrations this version does not know', p.stdout)
                    else:
                        self.assertIn('has applied migrations this version does not know', p.stdout)
                        self.assertNotIn('migration compatibility could not be checked', p.stdout)
                    self.assertIn('Services remain stopped', p.stdout)
                    self.assert_recovery_guidance(p.stdout)
                    self.assertIn('cannot read allrice_schema_migrations' if unreadable else FILES[-1], p.stdout)
                    self.assertTrue(os.path.isfile(os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight/state')))
                    self.assert_parked()
                    self.assertEqual(self.read_plist(os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight/worker.plist')),
                                     self.plist('worker', old))
                    with open(log) as f:
                        records = [json.loads(line) for line in f]
                    gate = next(r for r in records if r.get('phase') == 'restore-migrations')
                    self.assertEqual(gate['kind'], 'failed')
                    self.assertEqual(gate['restored'], 'no')
                    self.assertEqual(gate['manualIntervention'], 'required')
                    self.assertIn(gate['reason'], p.stdout)
                    if 'INFLIGHT_MINE' in entry:
                        self.assertEqual(len(records), 2)
                        self.assertEqual(records[-1]['phase'], 'switching')
                        self.assertEqual(records[-1]['reason'], 'candidate did not become healthy')
                    else:
                        self.assertEqual(len(records), 1)

    def test_restore_and_recover_start_a_known_version_after_a_transaction_rollback_or_snapshot_restore(self):
        for entry in ('INFLIGHT_MINE=1; on_exit 1', 'recover'):
            for applied, files in ((FILES[:-1] + ARCHIVED, FILES[:-1]), (FILES + ARCHIVED, FILES)):
                with self.subTest(entry=entry, files=files):
                    self.saved_release(self.release(files=files))
                    p = self.run_dd('take_lock() { :; }; stop_both() { echo STOPPED; }; '
                                    'start_both_on() { echo STARTED; }; ' + entry, applied, CONTRACT='row:1')
                    self.assertEqual(p.returncode, 1 if 'on_exit' in entry else 0, p.stderr)
                    self.assertIn('STARTED', p.stdout)
                    self.assertIn('is healthy again', p.stdout)
                    self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight')))

    def test_point_plists_cleans_both_roles_even_when_artifact_is_unchanged(self):
        rel = self.release(sha='b' * 40)
        for art in ('sha256:' + 'a' * 64, 'sha256:' + 'c' * 64):
            with self.subTest(art=art):
                self.seed_legacy_plists()
                p = self.run_dd('mkdir -p "$STATE"; stage_plists "$REL" "$SHA" "$ART" && activate_plists', [],
                                REL=rel, SHA='b' * 40, ART=art)
                self.assertEqual(p.returncode, 0, p.stderr)
                for role in ('web', 'worker'):
                    path = self.live_plist(role)
                    value = self.read_plist(path)
                    env = value['EnvironmentVariables']
                    self.assert_no_legacy_settings(env)
                    self.assertEqual(env['ALLRICE_DSH_NATIVE_ARTIFACT_ID'], art)
                    self.assertEqual(env['ALLRICE_RELEASE_SHA'], 'b' * 40)
                    self.assertEqual(env['ALLRICE_NATIVE_ONCE_REFERENCE'], self.once_reference)
                    self.assertEqual(env['UNRELATED_SETTING'], 'keep')
                    self.assertEqual(env['ALLRICE_DSH_CORDIS_CONFIG'], rel + '/apps/worker/dsh/allrice-restricted.cordis.yml')
                    self.assertEqual(value['WorkingDirectory'], rel + '/apps/web' if role == 'web' else rel)
                    self.assertEqual(value['ProgramArguments'], [os.path.join(HERE, 'with-env'), role, NODE,
                                     rel + ('/apps/web/server.mjs' if role == 'web' else '/apps/worker/dist/index.js')])
                    self.assertEqual(value['KeepAlive'], {'SuccessfulExit': False} if role == 'worker' else True)
                    self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_precheck_only_overrides_the_seal_and_profile(self):
        rel = self.release()
        write(os.path.join(rel, 'scripts/dev-release/verify-native-retention.mjs'),
              'console.log(JSON.stringify(process.env));\n')
        log = os.path.join(self.tmp, 'precheck.log')
        p = self.run_dd('precheck "$REL" sha candidate "$PLOG"', [], REL=rel, PLOG=log)
        self.assertEqual(p.returncode, 0, p.stderr)
        with open(log) as f:
            env = json.load(f)
        self.assertEqual(env['ALLRICE_DSH_NATIVE_ARTIFACT_ID'], 'candidate')
        self.assertEqual(env['ALLRICE_DSH_CORDIS_CONFIG'], rel + '/apps/worker/dsh/allrice-restricted.cordis.yml')
        self.assert_no_legacy_settings(env)

    def test_precheck_and_launch_share_clean_environment_with_real_env_file(self):
        self.seed_legacy_plists()
        env_file = os.path.join(self.home, 'allrice40-dev/.env')
        contents = ('DATABASE_URL=postgres://env-file/overridden\n'
                    'UNRELATED_ENV="space and \'quote\'"\nALLRICE_TEST=1\n'
                    'ALLRICE_DSH_RETAINED_ENV_ROOT=/old-env\n'
                    'export ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID=old-env-root\n'
                    'ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS=old-env-delivery\n'
                    'ALLRICE_DSH_ORIGIN_READER_ENV_ROOT=/old-reader\n'
                    'ALLRICE_DSH_RETAINEDNESS=keep-similar-key\n'
                    'ALLRICE_STORAGE_ROOT=' + self.home + '/allrice-dev/.local/storage\n'
                    'ALLRICE_DSH_PLATFORM_HOME=' + self.home + '/allrice-dev/.local/dsh-platform\n'
                    'ALLRICE_WORKER_INTERNAL_URL=http://127.0.0.1:3012\n'
                    'ALLRICE_WORKER_PORT=3012\n')
        write(env_file, contents, 0o600)
        base_env = dict(HOME=self.home, PATH=os.path.dirname(NODE) + ':/usr/bin:/bin')
        # Use the real Node parser, not an env-file stub: these bytes do reintroduce
        # retired settings when the original launch command loads the shared file.
        probe = 'console.log(JSON.stringify(process.env));\n'
        raw = subprocess.run([NODE, '--env-file=' + env_file, '-e', probe],
                             env=base_env, capture_output=True, text=True, timeout=10)
        self.assertEqual(raw.returncode, 0, raw.stderr)
        self.assertEqual(json.loads(raw.stdout)['ALLRICE_DSH_RETAINED_ENV_ROOT'], '/old-env')
        rel = self.release()
        for script in ('scripts/dev-release/verify-native-retention.mjs',
                       'apps/web/server.mjs', 'apps/worker/dist/index.js'):
            write(os.path.join(rel, script), probe)
        log = os.path.join(self.tmp, 'clean-precheck.log')
        # The deployment identity stays the same, as on a forward retry. Compare
        # service configuration, excluding shell-only PWD/SHLVL and test inputs.
        config = lambda env: {k: v for k, v in env.items()
                              if k.startswith(('ALLRICE_', 'UNRELATED_')) or k == 'DATABASE_URL'}
        for retry in (False, True):
            with self.subTest(retry=retry):
                write(log, '')
                p = self.run_dd('precheck "$REL" "$SHA" "$ART" "$PLOG"; '
                                'mkdir -p "$STATE"; stage_plists "$REL" "$SHA" "$ART" && activate_plists', [],
                                REL=rel, SHA='a' * 40, ART='sha256:' + 'c' * 64, PLOG=log)
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
                with open(log) as f:
                    checked = json.load(f)
                for role in ('web', 'worker'):
                    launch = self.read_plist(self.live_plist(role))
                    started = subprocess.run(launch['ProgramArguments'], cwd=launch['WorkingDirectory'],
                                             env=dict(base_env, **launch['EnvironmentVariables']),
                                             capture_output=True, text=True, timeout=10)
                    self.assertEqual(started.returncode, 0, started.stderr)
                    actual = json.loads(started.stdout)
                    self.assertEqual(config(actual), config(checked))
                    for env in (checked, actual):
                        self.assert_no_legacy_settings(env)
                        self.assertEqual(env['UNRELATED_ENV'], "space and 'quote'")
                        self.assertEqual(env['ALLRICE_DSH_RETAINEDNESS'], 'keep-similar-key')
                        self.assertEqual(env['DATABASE_URL'], 'postgres://tester@127.0.0.1:5434/allrice40_dev')
                        self.assertEqual(env['ALLRICE_NATIVE_ONCE_REFERENCE'], self.once_reference)
                        self.assertEqual(env['ALLRICE_STORAGE_ROOT'], self.home + '/allrice40-dev/.local/storage')
                        self.assertEqual(env['ALLRICE_DSH_PLATFORM_HOME'], self.home + '/allrice40-dev/.local/dsh-platform')
                with open(env_file) as f:
                    self.assertEqual(f.read(), contents)
                self.assertEqual(os.stat(env_file).st_mode & 0o777, 0o600)

        # Consumers of the generated launch command must still obtain Node,
        # including QA's own --env-file command with its isolated database.
        qa = self.write_qa_plists()
        for role in ('web', 'worker'):
            launch = self.read_plist(os.path.join(qa, role + '.plist'))
            write(launch['ProgramArguments'][2], probe)
            started = subprocess.run(launch['ProgramArguments'], cwd=launch['WorkingDirectory'],
                                     env=dict(base_env, **launch['EnvironmentVariables']),
                                     capture_output=True, text=True, timeout=10)
            self.assertEqual(started.returncode, 0, started.stderr)
            actual = json.loads(started.stdout)
            self.assertEqual(actual['DATABASE_URL'], QA_DATABASE_URL)
            self.assertEqual(actual['ALLRICE_STORAGE_ROOT'], qa + '/.local/storage')
            self.assertEqual(actual['ALLRICE_DSH_PLATFORM_HOME'], self.home + '/allrice40-dev/.local/dsh-platform')
            self.assertEqual(actual['ALLRICE_WORKER_INTERNAL_URL'], 'http://127.0.0.1:3201')
            self.assertEqual(actual['ALLRICE_WORKER_PORT'], '3201')
            self.assert_no_legacy_settings(actual)
        monitor = runpy.run_path(os.path.join(HERE, 'monitor'))
        cfg = dict(monitor['M1'], webPlist=self.live_plist('web'),
                   workerPlist=self.live_plist('worker'), envFile=env_file)
        from unittest.mock import patch
        with patch.dict(os.environ, HOME=self.home):
            self.assertEqual(monitor['derive_m1'](cfg)['node'], NODE)

    def write_qa_plists(self, task='tool-test'):
        with open(os.path.join(HERE, 'qa-instance')) as f:
            marker = '  /usr/bin/python3 - "$task" "$dir"'
            script = marker + f.read().split(marker, 1)[1].split('\nPY\n', 1)[0] + '\nPY\n'
        directory = os.path.join(self.home, 'allrice-qa', '_allrice40-' + task)
        release = os.path.join(self.home, 'allrice40-worktrees', '.qa-' + task + '.Fixture1')
        database = 'allrice40_qa_' + task.replace('-', '_')
        self.seed_identity(release, 'b' * 40)
        entry = os.stat(release)
        write(os.path.join(directory, 'instance.json'), json.dumps(dict(
            task=task, repository='semiok/allrice-vm', repositoryId=1469490636,
            webPort=3200, workerPort=3201, nativeArtifactId='new-art', database=database,
            databaseClaim=QA_DATABASE_CLAIM, plistClaims={},
            worktree=dict(name=os.path.basename(release), device=entry.st_dev, inode=entry.st_ino))))
        p = self.run_dd('task=$QA_TASK; dir=$QA_DIR; release=$QA_RELEASE; db=$QA_DATABASE; web=3200; worker=3201; '
                        'sha=$SHA; artifact=new-art;\n' + script, [],
                        QA_TASK=task, QA_DIR=directory, QA_RELEASE=release, QA_DATABASE=database, SHA='b' * 40, USER='tester')
        self.assertEqual(p.returncode, 0, p.stderr)
        return directory

    def test_qa_plists_do_not_inherit_retired_settings(self):
        self.seed_legacy_plists()
        directory = self.write_qa_plists()
        for role in ('web', 'worker'):
            value = self.read_plist(os.path.join(directory, role + '.plist'))
            env = value['EnvironmentVariables']
            self.assertEqual(env['ALLRICE_DSH_PLATFORM_HOME'], os.path.join(self.home, 'allrice40-dev/.local/dsh-platform'))
            p = self.run_dd('service_plist_config "$PLIST" "$LABEL" "$PORT_KEY" "$PORT" "$QA_DATABASE"', [],
                            PLIST=os.path.join(directory, role + '.plist'), LABEL=value['Label'],
                            QA_DATABASE=QA_DATABASE,
                            PORT_KEY='ALLRICE_' + role.upper() + '_PORT', PORT=env['ALLRICE_' + role.upper() + '_PORT'])
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            self.assert_no_legacy_settings(value['EnvironmentVariables'])
            self.assertEqual(value['EnvironmentVariables']['ALLRICE_DSH_NATIVE_ARTIFACT_ID'], 'new-art')
            self.assertEqual(value['EnvironmentVariables']['DATABASE_URL'], QA_DATABASE_URL)
            self.assertEqual(value['EnvironmentVariables']['UNRELATED_SETTING'], 'keep')

    def test_qa_env_does_not_copy_retired_settings(self):
        # Both QA processes use --env-file; cleaning only the plist cannot
        # prevent a retained setting in the copied .env from reaching Node.
        write(os.path.join(self.home, 'allrice40-dev/.env'),
              'DATABASE_URL=postgres://tester@127.0.0.1:5434/allrice40_dev\nUNRELATED_ENV=keep\n'
              'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID=old-root\n'
              'ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS=[]\n'
              'ALLRICE_DSH_RETAINED_1_ROOT=/old\n'
              ' export ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID = old-export\n'
              '  ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS = []\n'
              'export ALLRICE_DSH_RETAINED_EXPORTED_ROOT=/old-export\n', 0o600)
        directory = self.write_qa_plists()
        with open(os.path.join(directory, '.env')) as f:
            env = dict(line.rstrip('\n').split('=', 1) for line in f)
        self.assertEqual(env['DATABASE_URL'], QA_DATABASE_URL)
        self.assertEqual(env['UNRELATED_ENV'], 'keep')
        self.assert_no_legacy_settings(env)

    def test_qa_plist_cannot_select_another_instance_database(self):
        directory = self.write_qa_plists()
        path = os.path.join(directory, 'worker.plist')
        worker = self.read_plist(path)
        other = 'allrice40_qa_other_task'
        worker['EnvironmentVariables']['DATABASE_URL'] = 'postgres://tester@127.0.0.1:5434/' + other
        with open(path, 'wb') as f:
            plistlib.dump(worker, f)
        p = self.run_dd('service_plist_config "$PLIST" "$LABEL" ALLRICE_WORKER_PORT 3201 "$DATABASE"', [],
                        PLIST=path, LABEL=worker['Label'], DATABASE=other)
        self.assertNotEqual(p.returncode, 0)

    def test_contract_refusal_is_recorded_for_automatic_restore_and_recover(self):
        old = self.release(store=False)
        for entry in ('INFLIGHT_MINE=1; die "candidate did not become healthy"', 'recover'):
            for row, extra in (('row:2', {}), ('row:invalid 2', {}), ('row:1', {'CONTRACT_FAIL': '1'})):
                with self.subTest(entry=entry, row=row, extra=extra):
                    self.saved_release(old)
                    log = os.path.join(self.home, 'allrice40-dev/qa/deploys.jsonl')
                    write(log, '')
                    p = self.run_dd('take_lock() { :; }; stop_job() { echo STOPPED:$2; }; '
                                    'start_both_on() { echo STARTED; }; ' + entry, FILES + ARCHIVED, CONTRACT=row, **extra)
                    self.assertNotEqual(p.returncode, 0)
                    self.assertIn('STOPPED:3312\nSTOPPED:3311', p.stdout)
                    self.assertNotIn('STARTED', p.stdout)
                    self.assert_parked()
                    with open(log) as f:
                        records = [json.loads(line) for line in f]
                    self.assertEqual(len(records), 2 if 'INFLIGHT_MINE' in entry else 1)
                    failure = records[0]
                    self.assertEqual(failure['kind'], 'failed')
                    self.assertEqual(failure['phase'], 'restore-contract')
                    self.assertEqual(failure['restored'], 'no')
                    self.assertEqual(failure['manualIntervention'], 'required')
                    self.assertIn(failure['reason'], p.stdout)
                    self.assertIn('cannot read the journal contract' if extra else
                                  ('unreadable journal contract row' if 'invalid' in row else 'predates the journal contract'), failure['reason'])

    def test_recover_rechecks_parked_configuration_and_restores_after_snapshot_recovery(self):
        old = self.release(files=FILES[:-1])
        self.saved_release(old)
        script = ('take_lock() { :; }; stop_job() { echo STOPPED:$2; }; '
                  'start_job() { [ -f "$2" ] && echo STARTED:$1; }; wait_ready() { echo READY:$2; }; recover')
        for _ in range(2):  # repeated --recover does not recreate unsafe login entries
            p = self.run_dd(script, FILES + ARCHIVED, CONTRACT='row:1')
            self.assertNotEqual(p.returncode, 0)
            self.assertNotIn('STARTED', p.stdout)
            self.assert_parked()
        p = self.run_dd(script, FILES[:-1] + ARCHIVED, CONTRACT='row:1')
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('STOPPED:3312\nSTOPPED:3311', p.stdout)
        self.assertIn('READY:' + 'a' * 40, p.stdout)
        for role in ('web', 'worker'):
            self.assertEqual(self.read_plist(self.live_plist(role)), self.plist(role, old))
        self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled')))

    def test_partial_park_failure_is_reported_and_does_not_skip_the_other_plist(self):
        self.saved_release(self.release(files=FILES[:-1]))
        p = self.run_dd('stop_job() { :; }; start_both_on() { echo STARTED; }; '
                        'mv() { case "$1" in *-web.plist) return 1 ;; *) command mv "$@" ;; esac; }; '
                        'if restore; then exit 9; fi', FILES + ARCHIVED, CONTRACT='row:1')
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn('STARTED', p.stdout)
        self.assertIn('Could not park all LaunchAgents plists', p.stdout)
        self.assertNotIn('login will not restart these services', p.stdout)
        self.assertTrue(os.path.exists(self.live_plist('web')))
        self.assertFalse(os.path.exists(self.live_plist('worker')))
        with open(os.path.join(self.home, 'allrice40-dev/qa/deploys.jsonl')) as f:
            failure = json.loads(f.readline())
        self.assertEqual(failure['phase'], 'restore-migrations')
        self.assertIn('Could not park all', failure['reason'])

    def test_status_reads_parked_plists_without_restoring_them(self):
        self.saved_release(self.release(files=FILES[:-1]))
        p = self.run_dd('stop_job() { :; }; if restore; then exit 9; fi; status', FILES + ARCHIVED, CONTRACT='row:1')
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stderr, '')
        self.assertIn('configured sha:     ' + 'a' * 40, p.stdout)
        self.assertIn('journal contract:   high water 1', p.stdout)
        self.assertIn('UNFINISHED DEPLOY', p.stdout)
        self.assertIn('PARKED configuration', p.stdout)
        self.assertIn('launchd has no Dev jobs', p.stdout)
        self.assert_parked()

    def successful_deploy_stubs(self):
        write(os.path.join(self.stubs, 'pnpm'), '#!/bin/sh\necho "DB_PREPARE:$*"\n', 0o755)
        smoke = os.path.join(self.tmp, 'smoke-tools')
        write(os.path.join(smoke, 'smoke-test'), '#!/bin/sh\necho "SMOKE:$*"\n', 0o755)
        os.symlink(os.path.join(HERE, 'with-env'), os.path.join(smoke, 'with-env'))
        os.symlink(os.path.join(HERE, 'lib.sh'), os.path.join(smoke, 'lib.sh'))
        os.symlink(os.path.join(HERE, 'service_target.py'), os.path.join(smoke, 'service_target.py'))
        stubs = (
            'df() { printf "h\\nx x x 100\\n"; }; resolve_ref() { echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; }; '
            'git() { [ "$3 $4" != "worktree add" ] || { mkdir -p "$(dirname "$7")" && cp -R "$CANDIDATE" "$7"; }; }; pnpm() { :; }; '
            'node() { case "$1" in apps/*) printf \'{"artifactId":"%s"}\\n\' "$ART" ;; '
            'scripts/dev-release/prepare-identity.mjs) '
            '[ -z "${IDENTITY_ARGS_FILE:-}" ] || printf "%s\\n" "$@" > "$IDENTITY_ARGS_FILE" ;; '
            'scripts/*) : ;; *) command node "$@" ;; esac; }; '
            'precheck() { echo PRECHECK; }; take_lock() { :; }; stop_job() { echo STOPPED:$2; }; '
            'worker_boot() { :; }; report_after_stop() { :; }; prune_releases() { :; }; '
            'start_job() { [ -f "$2" ] && echo STARTED:$1; }; wait_ready() { echo READY:$2; }; BIN=$SMOKE; ')
        return stubs, smoke

    def test_deploy_seals_optional_person_vm_host_configuration(self):
        stubs, smoke = self.successful_deploy_stubs()
        sha = 'b' * 40
        candidate = self.release(sha=sha)
        config = os.path.join(self.home, 'allrice40-dev/config/person-vm-host.json')
        identity_args = os.path.join(self.tmp, 'identity-args')
        seed = os.path.join(self.tmp, 'private-config-seed')
        write(seed, '{"private_fixture":"not logged"}', 0o600)
        os.makedirs(os.path.dirname(config))
        for timing in ('absent', 'before build', 'during build'):
            with self.subTest(timing=timing):
                build_stubs = stubs
                if timing == 'before build':
                    write(config, '{"private_fixture":"not logged"}', 0o600)
                elif timing == 'during build':
                    build_stubs += 'pnpm() { [ "$1" != install ] || cp -p "$CONFIG_SEED" "$CONFIG"; }; '
                result = self.run_dd(
                    build_stubs + 'deploy --skip-smoke',
                    FILES + ARCHIVED, CONTRACT='row:1', CANDIDATE=candidate,
                    ART='sha256:' + 'c' * 64, SMOKE=smoke, IDENTITY_ARGS_FILE=identity_args,
                    CONFIG=config, CONFIG_SEED=seed,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                with open(identity_args) as f:
                    args = f.read().splitlines()
                release = self.read_plist(self.live_plist('worker'))['WorkingDirectory']
                expected = ['scripts/dev-release/prepare-identity.mjs', '--root=' + release, '--release-sha=' + sha]
                if timing != 'absent':
                    expected.append('--person-vm-config=' + config)
                    os.unlink(config)
                self.assertEqual(args, expected)
                self.remove_deploy_build()
                self.seed_legacy_plists()

    def test_deploy_stops_if_config_disappears_or_becomes_unsafe_during_build(self):
        stubs, smoke = self.successful_deploy_stubs()
        candidate = self.release(sha='b' * 40)
        config = os.path.join(self.home, 'allrice40-dev/config/person-vm-host.json')
        write(config, '{}', 0o600)
        identity_args = os.path.join(self.tmp, 'identity-args')
        for mutation, error in (
            ('unlink "$CONFIG"', 'required person VM host configuration is missing'),
            ('printf "{}" > "$CONFIG" && chmod 644 "$CONFIG"', 'mode 0600 (no symlinks)'),
        ):
            with self.subTest(mutation=mutation):
                result = self.run_dd(
                    stubs + 'pnpm() { [ "$1" != install ] || { ' + mutation + '; }; }; deploy --skip-smoke',
                    FILES + ARCHIVED, CONTRACT='row:1', CANDIDATE=candidate,
                    ART='sha256:' + 'c' * 64, SMOKE=smoke, IDENTITY_ARGS_FILE=identity_args,
                    CONFIG=config,
                )
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn(error, result.stderr)
                self.assertFalse(os.path.exists(identity_args))
                self.assertNotIn('STOPPED:', result.stdout)
                self.assertEqual(self.read_plist(self.live_plist('worker'))['WorkingDirectory'], self.initial_release)
                self.remove_deploy_build()

    def test_deploy_requires_person_vm_host_configuration_when_requested(self):
        result = self.run_dd(
            'git() { echo UNEXPECTED_GIT; return 91; }; deploy --require-person-vm-config',
            FILES + ARCHIVED,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn('required person VM host configuration is missing', result.stderr)
        self.assertNotIn('UNEXPECTED_GIT', result.stdout)

    def test_deploy_rejects_unsafe_person_vm_host_configuration_before_build(self):
        config = os.path.join(self.home, 'allrice40-dev/config/person-vm-host.json')
        target = os.path.join(self.tmp, 'valid-person-vm-host.json')
        write(target, '{}', 0o600)
        os.makedirs(os.path.dirname(config))
        owner_probe = os.path.join(self.tmp, 'python-for-foreign-owner')
        write(owner_probe, '#!' + sys.executable + '\n'
              'import os,sys\n'
              'sys.argv = sys.argv[1:]\n'
              'uid = os.getuid()\n'
              'os.getuid = lambda: uid + 1\n'
              'exec(sys.stdin.read())\n', 0o755)
        for kind in ('wrong mode', 'wrong owner', 'symlink', 'dangling symlink', 'directory'):
            with self.subTest(kind=kind):
                python_override = ''
                if kind == 'wrong mode':
                    write(config, '{}', 0o644)
                elif kind == 'wrong owner':
                    write(config, '{}', 0o600)
                    python_override = 'M1_PY="$OWNER_PROBE"; '
                elif kind == 'symlink':
                    os.symlink(target, config)
                elif kind == 'dangling symlink':
                    os.symlink(target + '.missing', config)
                else:
                    os.mkdir(config, 0o700)
                result = self.run_dd(
                    python_override + 'git() { echo UNEXPECTED_GIT; return 91; }; deploy',
                    FILES + ARCHIVED, OWNER_PROBE=owner_probe,
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn('mode 0600 (no symlinks)', result.stderr)
                self.assertNotIn('UNEXPECTED_GIT', result.stdout)
                if kind == 'directory':
                    os.rmdir(config)
                else:
                    os.unlink(config)

    def test_successful_deploy_and_forward_fix_rewrite_plists_and_run_smoke(self):
        stubs, smoke = self.successful_deploy_stubs()
        stubs += 'deploy'
        for forward in (False, True):
            with self.subTest(forward=forward):
                candidate = self.release(files=FILES + (['0219_tool_fixture.sql'] if forward else []), sha='b' * 40)
                self.seed_legacy_plists()
                if forward:
                    self.saved_release(self.release(files=FILES[:-1]))
                    p = self.run_dd('stop_job() { :; }; if restore; then exit 9; fi', FILES + ARCHIVED, CONTRACT='row:1')
                    self.assertEqual(p.returncode, 0, p.stderr)
                    self.assertFalse(os.path.exists(self.live_plist('worker')))
                    shutil.move(os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight'), os.path.join(self.tmp, 'failed-deploy'))
                p = self.run_dd(stubs, FILES + ARCHIVED, CONTRACT='row:1', CANDIDATE=candidate,
                                ART='sha256:' + ('c' if forward else 'a') * 64, SMOKE=smoke)
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
                self.assertIn('SMOKE:--dev --expect-sha ' + 'b' * 40, p.stdout)
                self.assertLess(p.stdout.index('STARTED:ai.bplabs.allrice40-dev-worker'), p.stdout.index('STARTED:ai.bplabs.allrice40-dev-web'))
                for role in ('web', 'worker'):
                    env = self.read_plist(self.live_plist(role))['EnvironmentVariables']
                    self.assert_no_legacy_settings(env)
                    self.assertEqual(env['ALLRICE_DSH_NATIVE_ARTIFACT_ID'], 'sha256:' + ('c' if forward else 'a') * 64)
                    self.assertEqual(env['ALLRICE_RELEASE_SHA'], 'b' * 40)
                with open(os.path.join(self.home, 'allrice40-dev/qa/deploys.jsonl')) as f:
                    records = [json.loads(line) for line in f]
                self.assertEqual([r['kind'] for r in records[-2:]], ['deploy', 'smoke'])
                self.assertEqual(records[-1]['result'], 'passed')
                self.assertEqual(records[-2]['toSha'], 'b' * 40)
                self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight')))
                self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled')))
                if forward:
                    self.assert_snapshot(os.listdir(self.snapshots)[0])
                    self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice40-dev/qa/.previous-release')))
                else:
                    with open(os.path.join(self.home, 'allrice40-dev/qa/.previous-release')) as f:
                        self.assertEqual(f.read().splitlines(), [records[-2]['fromRelease'], records[-2]['toRelease']])
                log_path = os.path.join(self.home, 'allrice40-dev/qa/deploy-logs')
                with open(os.path.join(log_path, os.listdir(log_path)[0])) as f:
                    self.assertIn('DB_PREPARE:db:prepare', f.read())
                self.remove_deploy_build()

    def test_with_env_does_not_pass_retired_settings_from_any_source(self):
        # Exercise the actual executable, including .env and inherited exports,
        # for both services and the parked-configuration fallback.
        self.seed_legacy_plists()
        write(os.path.join(self.home, 'allrice40-dev/.env'),
              'ALLRICE_TEST=1\nALLRICE_DSH_RETAINED_ENV_ROOT=/old-env\n'
              'ALLRICE_DSH_ORIGIN_READER_ENV_ROOT=/old-reader\n'
              'export ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID=old-env-root\n'
              'ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS=old-env-delivery\n', 0o600)
        for parked in (False, True):
            if parked:
                p = self.run_dd('park_plists', [])
                self.assertEqual(p.returncode, 0, p.stderr)
            for role in ('web', 'worker'):
                with self.subTest(parked=parked, role=role):
                    p = self.run_dd('"$BIN/with-env" "$ROLE" "$PROBE_PY" -c '
                                    "'import os,json; print(json.dumps(dict(os.environ)))'", [],
                                    ROLE=role, PROBE_PY=sys.executable,
                                    ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID='old-parent-root',
                                    ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS='old-parent-delivery',
                                    ALLRICE_DSH_RETAINED_PARENT_ROOT='/old-parent',
                                    ALLRICE_DSH_ORIGIN_READER_PARENT_ROOT='/old-parent-reader')
                    self.assertEqual(p.returncode, 0, p.stderr)
                    env = json.loads(p.stdout)
                    self.assertEqual(env['DATABASE_URL'], 'postgres://tester@127.0.0.1:5434/allrice40_dev')
                    self.assertEqual(env['ALLRICE_DSH_NATIVE_ARTIFACT_ID'], 'sha256:' + 'a' * 64)
                    self.assertEqual(env['UNRELATED_SETTING'], 'keep')
                    self.assert_no_legacy_settings(env)

    def test_failed_smoke_only_offers_default_rollback_when_one_is_recorded(self):
        stubs, smoke = self.successful_deploy_stubs()
        write(os.path.join(smoke, 'smoke-test'), '#!/bin/sh\nexit 1\n', 0o755)
        for forward in (False, True):
            with self.subTest(forward=forward):
                self.seed_legacy_plists()
                if forward:
                    p = self.run_dd('park_plists', [])
                    self.assertEqual(p.returncode, 0, p.stderr)
                p = self.run_dd(stubs + 'deploy', FILES + ARCHIVED, CONTRACT='row:1',
                                CANDIDATE=self.release(sha='b' * 40), ART='sha256:' + 'c' * 64, SMOKE=smoke)
                self.assertEqual(p.returncode, 5, p.stdout + p.stderr)
                self.assertIn('smoke test failed on bbbbbbbb', p.stderr)
                default = self.run_dd('previous_release', [])
                if forward:
                    self.assertNotEqual(default.returncode, 0)
                    self.assertIn('no default rollback target', p.stderr)
                    self.assertIn('deploy-dev --release-manager --rollback <release-dir>', p.stderr)
                    self.assertNotRegex(p.stderr, r'--rollback\s*$')
                else:
                    self.assertEqual(default.returncode, 0, default.stderr)
                    self.assertIn('to switch back run: ~/allrice40-dev/bin/deploy-dev --release-manager --rollback', p.stderr)
                    self.assertNotIn('<release-dir>', p.stderr)
                with open(os.path.join(self.home, 'allrice40-dev/qa/deploys.jsonl')) as f:
                    self.assertEqual(json.loads(f.readlines()[-1])['result'], 'failed')
                self.remove_deploy_build()

    def test_deploy_with_parked_plists_and_inflight_state_refuses_before_build(self):
        self.saved_release(self.release(files=FILES[:-1]))
        p = self.run_dd('stop_job() { :; }; if restore; then exit 9; fi; '
                        'git() { echo GIT_CALLED; return 91; }; deploy',
                        FILES + ARCHIVED, CONTRACT='row:1')
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('run ~/allrice40-dev/bin/deploy-dev --release-manager --recover first', p.stderr)
        self.assertNotIn('GIT_CALLED', p.stdout)
        self.assert_parked()
        self.assertTrue(os.path.isfile(os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight/state')))

    def test_forward_deploy_of_the_parked_candidate_starts_services(self):
        # A failed start has already switched the plists to the candidate. The
        # old release cannot read its migration, so recovery parks those NEW
        # plists. Follow the documented forward-fix procedure, including moving
        # inflight aside; a configured SHA is not evidence of running services.
        stubs, smoke = self.successful_deploy_stubs()
        for force in (False, True):
            with self.subTest(force=force):
                candidate = self.release(sha='b' * 40)
                self.saved_release(self.release(files=FILES[:-1]))
                p = self.run_dd('mkdir -p "$STATE"; stage_plists "$CANDIDATE" "$SHA" "$ART" && activate_plists; '
                                'stop_job() { :; }; if restore; then exit 9; fi',
                                FILES + ARCHIVED, CONTRACT='row:1', CANDIDATE=candidate,
                                SHA='b' * 40, ART='sha256:' + 'c' * 64)
                self.assertEqual(p.returncode, 0, p.stderr)
                shutil.move(os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight'),
                            os.path.join(self.tmp, 'failed-deploy-' + str(force)))
                p = self.run_dd(stubs + 'deploy --ref ' + 'b' * 40 + (' --force' if force else ''),
                                FILES + ARCHIVED, CONTRACT='row:1', CANDIDATE=candidate,
                                ART='sha256:' + 'c' * 64, SMOKE=smoke)
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
                self.assertIn('STARTED:ai.bplabs.allrice40-dev-worker', p.stdout)
                self.assertIn('STARTED:ai.bplabs.allrice40-dev-web', p.stdout)
                self.assertIn('SMOKE:--dev --expect-sha ' + 'b' * 40, p.stdout)
                self.assertNotIn('nothing to deploy', p.stdout)
                for role in ('web', 'worker'):
                    self.assertEqual(self.read_plist(self.live_plist(role))['EnvironmentVariables']['ALLRICE_RELEASE_SHA'], 'b' * 40)
                self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled')))
                self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight')))
                self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice40-dev/qa/.previous-release')))
                self.remove_deploy_build()
                self.seed_legacy_plists()

    def test_same_sha_is_skipped_only_with_both_active_plists(self):
        stubs, smoke = self.successful_deploy_stubs()
        candidate = self.release(sha='a' * 40)
        stubs += 'resolve_ref() { echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; }; deploy'
        for parked in (False, True):
            with self.subTest(partial_park=parked):
                if parked:
                    directory = os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled')
                    os.makedirs(directory)
                    shutil.move(self.live_plist('web'), os.path.join(directory, 'web.plist'))
                p = self.run_dd(stubs, FILES + ARCHIVED, CONTRACT='row:1',
                                CANDIDATE=candidate, ART='sha256:' + 'a' * 64, SMOKE=smoke)
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
                self.assertEqual('nothing to deploy' in p.stdout, not parked)
                self.assertEqual('STARTED:ai.bplabs.allrice40-dev-worker' in p.stdout, parked)
                self.assertEqual('STARTED:ai.bplabs.allrice40-dev-web' in p.stdout, parked)

    def test_partial_parking_failure_can_be_retried_without_losing_saved_configuration(self):
        old = self.release(files=FILES[:-1])
        for entry in ('INFLIGHT_MINE=1; die "candidate unhealthy"', 'recover'):
            with self.subTest(entry=entry):
                self.saved_release(old)
                # Make the second move fail, after Web has already been parked.
                p = self.run_dd('take_lock() { :; }; stop_job() { :; }; '
                                'start_job() { echo UNEXPECTED_START; return 90; }; '
                                'mv() { case "$1" in *-worker.plist) return 1 ;; *) command mv "$@" ;; esac; }; ' + entry,
                                FILES + ARCHIVED, CONTRACT='row:1')
                self.assertNotEqual(p.returncode, 0)
                self.assertIn('Could not park all LaunchAgents plists', p.stdout)
                self.assertNotIn('UNEXPECTED_START', p.stdout)
                self.assertFalse(os.path.exists(self.live_plist('web')))
                self.assertTrue(os.path.exists(self.live_plist('worker')))
                saved = os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight')
                before = {r: self.read_plist(os.path.join(saved, r + '.plist')) for r in ('web', 'worker')}
                p = self.run_dd('ready_sha() { :; }; status', FILES + ARCHIVED, CONTRACT='row:1')
                self.assertEqual(p.returncode, 0, p.stderr)
                self.assertEqual(p.stderr, '')
                self.assertIn('UNFINISHED DEPLOY', p.stdout)
                self.assertIn('run ~/allrice40-dev/bin/deploy-dev --release-manager --recover', p.stdout)
                self.assertFalse(os.path.exists(self.live_plist('web')))
                self.assertTrue(os.path.exists(self.live_plist('worker')))
                script = ('take_lock() { :; }; stop_job() { echo STOPPED:$2; }; '
                          'start_job() { [ -f "$2" ] && echo STARTED:$1; }; wait_ready() { :; }; recover')
                p = self.run_dd(script, FILES + ARCHIVED, CONTRACT='row:1')
                self.assertNotEqual(p.returncode, 0)
                self.assertNotIn('STARTED:', p.stdout)
                for role in ('web', 'worker'):
                    self.assertFalse(os.path.exists(self.live_plist(role)))
                    self.assertEqual(self.read_plist(os.path.join(saved, role + '.plist')), before[role])
                # After restoring the snapshot, retry must load the original
                # recovery copies, not the candidate's parked templates.
                p = self.run_dd(script, FILES[:-1] + ARCHIVED, CONTRACT='row:1')
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
                self.assertLess(p.stdout.index('STARTED:ai.bplabs.allrice40-dev-worker'), p.stdout.index('STARTED:ai.bplabs.allrice40-dev-web'))
                for role in ('web', 'worker'):
                    self.assertEqual(self.read_plist(self.live_plist(role)), before[role])
                self.assertFalse(os.path.exists(saved))
                self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled')))

    def test_recovery_after_partial_plist_write_uses_the_consistent_saved_pair(self):
        stubs, smoke = self.successful_deploy_stubs()
        candidate = self.release(sha='c' * 40)
        self.saved_release(self.release(files=FILES[:-1]))
        # Web is activated, then publishing the staged Worker file fails.
        p = self.run_dd('stage_plists "$CANDIDATE" "$SHA" "$ART"; '
                        'mv() { if [ "$3" = "$WORKER_PLIST" ]; then echo WORKER_REPLACE_FAILED >&2; return 1; fi; command mv "$@"; }; '
                        'if activate_plists; then exit 9; fi; unset -f mv; '
                        'stop_job() { :; }; if restore; then exit 9; fi',
                        FILES + ARCHIVED, CONTRACT='row:1', CANDIDATE=candidate,
                        SHA='c' * 40, ART='sha256:' + 'c' * 64)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('WORKER_REPLACE_FAILED', p.stderr)
        parked = os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled')
        for role, letter in (('web', 'c'), ('worker', 'a')):
            self.assertEqual(self.read_plist(os.path.join(parked, role + '.plist'))['EnvironmentVariables']['ALLRICE_DSH_NATIVE_ARTIFACT_ID'], 'sha256:' + letter * 64)
        p = self.run_dd('take_lock() { :; }; stop_job() { :; }; start_job() { :; }; wait_ready() { :; }; recover',
                        FILES[:-1] + ARCHIVED, CONTRACT='row:1')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        for role in ('web', 'worker'):
            self.assertEqual(self.read_plist(self.live_plist(role))['EnvironmentVariables']['ALLRICE_RELEASE_SHA'], 'a' * 40)
        # The repaired pair can now be safely used for a subsequent release.
        p = self.run_dd(stubs + 'deploy', FILES + ARCHIVED, CONTRACT='row:1',
                        CANDIDATE=self.release(sha='b' * 40), ART='sha256:' + 'a' * 64, SMOKE=smoke)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        for role in ('web', 'worker'):
            env = self.read_plist(self.live_plist(role))['EnvironmentVariables']
            self.assertEqual(env['ALLRICE_DSH_NATIVE_ARTIFACT_ID'], 'sha256:' + 'a' * 64)
            self.assertEqual(env['ALLRICE_RELEASE_SHA'], 'b' * 40)
        self.assertIn('SMOKE:--dev --expect-sha ' + 'b' * 40, p.stdout)
        self.assertFalse(os.path.exists(parked))
        self.assertTrue(os.path.exists(os.path.join(self.home, 'allrice40-dev/qa/.previous-release')))

    def test_deploy_and_rollback_refuse_an_unrecoverable_pair_before_side_effects(self):
        other = self.release(sha='a' * 40)  # Same commit, different sealed build directory.
        with open(self.live_plist('web'), 'wb') as f:
            plistlib.dump(self.plist('web', other), f)
        for command in ('deploy', 'rollback "$TARGET"'):
            with self.subTest(command=command):
                p = self.run_dd('git() { echo GIT; }; stop_both() { echo STOPPED; }; ' + command, [], TARGET=other)
                self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
                self.assertIn('refusing a mismatched Dev configuration', p.stderr)
                self.assertNotIn('STOPPED', p.stdout)
                self.assertNotIn('GIT', p.stdout)
                self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight')))

    def test_dev_operations_refuse_old_or_miswired_plists_before_effects(self):
        rejected = [
            ('worker', 'DATABASE_URL', 'postgres://tester@127.0.0.1:5432/allrice_dev'),
            ('worker', 'DATABASE_URL', 'postgres://tester@127.0.0.1:5434/allrice40_dev?port=5432'),
            ('web', 'ALLRICE_WEB_PORT', '3011'),
            ('worker', 'ALLRICE_WORKER_PORT', '3012'),
            ('worker', 'Label', 'ai.bplabs.allrice-dev-worker'),
            ('web', 'ALLRICE_STORAGE_ROOT', self.home + '/allrice-dev/.local/storage'),
            ('worker', 'ALLRICE_EXECUTION_ROOT', '.local/executions'),
            ('worker', 'ALLRICE_DSH_PLATFORM_HOME', self.home + '/allrice-dev/.local/dsh-platform'),
        ]
        with tempfile.TemporaryDirectory(dir=self.tmp) as output:
            touched = os.path.join(output, 'started')
            for parked in (False, True):
                if parked:
                    self.assertEqual(self.run_dd('park_plists', []).returncode, 0)
                for role, key, value in rejected:
                    with self.subTest(parked=parked, key=key, value=value):
                        path = (os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled', role + '.plist')
                                if parked else self.live_plist(role))
                        valid = self.plist(role)
                        bad = self.plist(role)
                        (bad if key == 'Label' else bad['EnvironmentVariables'])[key] = value
                        with open(path, 'wb') as f:
                            plistlib.dump(bad, f)
                        try:
                            p = self.run_dd('deploy', [])
                            self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
                            self.assertIn('refusing a mismatched Dev configuration', p.stderr)
                            self.assertFalse(os.path.isdir(self.snapshots))
                            p = self.run_config_tool('with-env', role, '/usr/bin/touch', touched)
                            self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
                            self.assertFalse(os.path.exists(touched))
                            if role == 'worker':
                                p = self.run_config_tool('schedule-recover', '--dev', '--release-manager', '--execute')
                                self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
                                self.assertIn('expected ai.bplabs.allrice40-dev-worker', p.stderr)
                        finally:
                            with open(path, 'wb') as f:
                                plistlib.dump(valid, f)

    def test_startup_arguments_refuse_legacy_overrides_but_allow_versioned_4_0_loader(self):
        self.assertEqual(self.run_dd('park_plists', []).returncode, 0)
        parked = os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled')
        for role, old in (
            ('web', [NODE, self.initial_release + '/apps/web/server.mjs', '--port', '3011']),
            ('worker', [os.path.join(self.home, 'allrice-dev/bin/with-env'), 'worker', NODE, self.initial_release + '/apps/worker/dist/index.js']),
            ('worker', [NODE, '--env-file=' + os.path.join(self.home, 'allrice-dev/.env'), self.initial_release + '/apps/worker/dist/index.js']),
            ('worker', [NODE, self.release() + '/apps/worker/dist/index.js']),
        ):
            with self.subTest(role=role, argv=old):
                path = os.path.join(parked, role + '.plist')
                invalid = self.plist(role)
                invalid['ProgramArguments'] = old
                with open(path, 'wb') as f:
                    plistlib.dump(invalid, f)
                self.assertEqual(self.run_dd('deploy', []).returncode, 2)
                self.assertFalse(os.path.isdir(self.snapshots))
                with open(path, 'wb') as f:
                    plistlib.dump(self.plist(role), f)
        path = os.path.join(parked, 'web.plist')
        valid = self.plist('web')
        historical_loader = os.path.join(self.home, 'allrice40-dev/tools', 'd' * 40, 'with-env')
        write(historical_loader, '#!/bin/sh\nexit 99\n', 0o755)
        valid['ProgramArguments'] = [historical_loader, 'web', NODE, self.initial_release + '/apps/web/server.mjs', '--port', '3311']
        with open(path, 'wb') as f:
            plistlib.dump(valid, f)
        p = self.run_dd('dev_plist_pair', [])
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    def test_loaded_native_controller_roots_are_covered_by_snapshot(self):
        dotenv = os.path.join(self.home, 'allrice40-dev/.env')
        local = os.path.join(self.home, 'allrice40-dev/.local')
        root = os.path.join(local, 'native-once-control-m1')
        write(os.path.join(root, 'controller.data'), 'once fixture')
        worker = self.plist('worker')
        worker['EnvironmentVariables'].pop('ALLRICE_NATIVE_ONCE_REFERENCE')
        for index, loader in enumerate((False, True)):
            with self.subTest(loader=loader):
                if loader:
                    worker['ProgramArguments'] = [os.path.join(HERE, 'with-env'), 'worker', NODE,
                                                  worker['ProgramArguments'][-1]]
                with open(self.live_plist('worker'), 'wb') as f:
                    plistlib.dump(worker, f)
                for valid in (False, True):
                    target = root if valid else self.home + '/allrice-dev/.local/native-once-control-m1'
                    reference = shlex.quote(json.dumps({'stateRoot': target}))
                    write(dotenv, 'ALLRICE_NATIVE_ONCE_ENABLED=1\nALLRICE_NATIVE_ONCE_REFERENCE=' + reference + '\n')
                    name = '20261124-030%d-aaaaaaaa' % index
                    p = self.run_dd('snapshot "$NAME"', [], NAME=name)
                    self.assertEqual(p.returncode, 0 if valid else 1, p.stdout + p.stderr)
                    self.assertEqual(os.path.exists(os.path.join(self.snapshots, name, 'native-once-control-m1/controller.data')), valid)

    def test_disabled_native_controller_can_leave_reference_empty(self):
        worker = self.plist('worker')
        worker['EnvironmentVariables'].update(ALLRICE_NATIVE_ONCE_ENABLED='0', ALLRICE_NATIVE_ONCE_REFERENCE='')
        with open(self.live_plist('worker'), 'wb') as f:
            plistlib.dump(worker, f)
        write(os.path.join(self.home, 'allrice40-dev/.env'), 'ALLRICE_NATIVE_ONCE_ENABLED=1\nALLRICE_NATIVE_ONCE_REFERENCE=bad\n')
        p = self.run_dd('"$BIN/with-env" worker /bin/bash -c '
                        "'printf \"%s\\n%s\\n\" \"$ALLRICE_NATIVE_ONCE_ENABLED\" \"$ALLRICE_NATIVE_ONCE_REFERENCE\"'", [])
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(p.stdout, '0\n\n')

    def test_deploy_preserves_controller_setting_sources_after_dotenv_changes(self):
        dotenv = os.path.join(self.home, 'allrice40-dev/.env')
        recurring_root = self.home + '/allrice40-dev/.local/native-recurring-control-m1'
        recurring_dotenv = json.dumps({'artifactId': 'dotenv', 'stateRoot': recurring_root})
        recurring_plist = json.dumps({'artifactId': 'plist', 'stateRoot': recurring_root})

        def write_settings(once, recurring):
            write(dotenv, f'ALLRICE_NATIVE_ONCE_ENABLED={once}\n'
                  f'ALLRICE_NATIVE_ONCE_REFERENCE={shlex.quote(self.once_reference)}\n'
                  f'ALLRICE_NATIVE_RECURRING_ENABLED={recurring}\n'
                  f'ALLRICE_NATIVE_RECURRING_REFERENCE={shlex.quote(recurring_dotenv)}\n')

        for role in ('web', 'worker'):
            value = self.plist(role)
            env = value['EnvironmentVariables']
            del env['ALLRICE_NATIVE_ONCE_REFERENCE']
            if role == 'worker':
                env['ALLRICE_NATIVE_RECURRING_REFERENCE'] = recurring_plist
            with open(self.live_plist(role), 'wb') as f:
                plistlib.dump(value, f)
        write_settings('1', '0')
        stubs, _ = self.successful_deploy_stubs()
        contract = os.path.join(self.tmp, 'contract-cli.txt')
        write(contract, 'row:1')
        write(self.applied, '\n'.join(FILES + ARCHIVED) + '\n')
        p = self.run_config_tool('deploy-dev', '--release-manager', '--skip-smoke',
                deploy_stubs=stubs.replace('BIN=$SMOKE; ', ''), APPLIED=self.applied, CONTRACT_FILE=contract,
                CANDIDATE=self.release(sha='b' * 40), ART='sha256:' + 'b' * 64)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        for role in ('web', 'worker'):
            env = self.read_plist(self.live_plist(role))['EnvironmentVariables']
            self.assertNotIn('ALLRICE_NATIVE_ONCE_ENABLED', env)
            self.assertNotIn('ALLRICE_NATIVE_RECURRING_ENABLED', env)
            self.assertNotIn('ALLRICE_NATIVE_ONCE_REFERENCE', env)
            self.assertEqual(env.get('ALLRICE_NATIVE_RECURRING_REFERENCE'), recurring_plist if role == 'worker' else None)

        for once, recurring in (('0', '1'), ('1', '0')):
            write_settings(once, recurring)
            for role in ('web', 'worker'):
                p = self.run_config_tool('with-env', role, sys.executable, '-c',
                    'import json,os; print(json.dumps([os.environ[k] for k in ('
                    '"ALLRICE_NATIVE_ONCE_ENABLED", "ALLRICE_NATIVE_RECURRING_ENABLED", "ALLRICE_NATIVE_RECURRING_REFERENCE")]))')
                self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
                self.assertEqual(json.loads(p.stdout), [once, recurring, recurring_plist if role == 'worker' else recurring_dotenv])

    def test_qa_smoke_refuses_a_web_route_to_a_different_worker(self):
        task = 'tool-test'
        qa = self.write_qa_plists(task)
        for role in ('web', 'worker'):
            live = os.path.join(self.home, 'Library/LaunchAgents/ai.bplabs.allrice40-qa-%s-%s.plist' % (task, role))
            plist = self.read_plist(os.path.join(qa, role + '.plist'))
            if role == 'web':
                plist['EnvironmentVariables'].update(ALLRICE_WORKER_PORT='3211', ALLRICE_WORKER_INTERNAL_URL='http://127.0.0.1:3211')
            with open(live, 'wb') as f:
                plistlib.dump(plist, f)
        p = self.run_config_tool('smoke-test', '--instance', task)
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn('expected ai.bplabs.allrice40-qa-tool-test-web', p.stderr)
        self.assertFalse(os.path.exists(os.path.join(qa, 'smoke')))

    def test_qa_smoke_selects_4_0_when_3_x_has_the_same_task(self):
        task = 'tool-test'
        qa = self.write_qa_plists(task)
        write(os.path.join(self.home, 'allrice-qa', task, 'instance.json'), '{"webPort":3210,"workerPort":3211}')
        for role in ('web', 'worker'):
            agents = os.path.join(self.home, 'Library/LaunchAgents')
            write(os.path.join(agents, 'ai.bplabs.allrice-qa-%s-%s.plist' % (task, role)), 'old 3.x plist fixture')
            shutil.copyfile(os.path.join(qa, role + '.plist'),
                            os.path.join(agents, 'ai.bplabs.allrice40-qa-%s-%s.plist' % (task, role)))
        probe = os.path.join(self.tmp, 'smoke-args.json')
        write(os.path.join(self.home, '.local/opt/node-22.23.2/bin/node'), '#!' + sys.executable + '\n'
              'import json,os,sys\nargs=sys.argv[2:]; out=args[args.index("--out")+1]\n'
              'json.dump(args,open(os.environ["PROBE"],"w")); os.makedirs(out,exist_ok=True)\n'
              'json.dump({"results":[]},open(out+"/result.json","w"))\n', 0o755)
        p = self.run_config_tool('smoke-test', '--instance', task, '--only', 'chat', PROBE=probe)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        with open(probe) as f:
            args = json.load(f)
        self.assertEqual(args[args.index('--url') + 1], 'http://127.0.0.1:3200')
        self.assertEqual(args[args.index('--worker-url') + 1], 'http://127.0.0.1:3201')
        self.assertEqual(args[args.index('--creds') + 1], os.path.join(qa, 'creds.json'))
        self.assertEqual(os.path.dirname(args[args.index('--out') + 1]), os.path.join(qa, 'smoke'))

    def test_smoke_and_recovery_share_allocator_lock_before_reading_instance(self):
        from concurrent.futures import ThreadPoolExecutor
        import fcntl
        instance = os.path.join(self.home, 'allrice-qa', '_allrice40-switch')
        os.makedirs(instance)
        metadata = os.path.join(instance, 'instance.json')
        tools = ('smoke-test', 'schedule-recover')
        for name in tools:
            with self.subTest(tool=name):
                write(metadata, json.dumps({'task': 'switch', 'repository': 'semiok/allrice-vm', 'repositoryId': 1469490636}))
                with ThreadPoolExecutor(max_workers=1) as worker:
                    with open(os.path.join(self.home, 'allrice-qa', '.alloc.lock'), 'a') as lock:
                        fcntl.flock(lock, fcntl.LOCK_EX)
                        pending = worker.submit(self.run_config_tool, name, '--instance', 'switch')
                        time.sleep(.25)
                        self.assertFalse(pending.done(), 'selection must wait for the common allocator')
                        write(metadata, json.dumps({'repository': 'semiok/allrice', 'repositoryId': 1323769790}))
                    p = pending.result(timeout=5)
                self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
                self.assertIn('repository', p.stderr)
                self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice-qa', '.task40-switch.lock')))

    def test_qa_generation_reads_parked_configuration_without_restoring_dev(self):
        p = self.run_dd('park_plists', [])
        self.assertEqual(p.returncode, 0, p.stderr)
        directory = self.write_qa_plists()
        for role in ('web', 'worker'):
            env = self.read_plist(os.path.join(directory, role + '.plist'))['EnvironmentVariables']
            self.assertEqual(env['DATABASE_URL'], QA_DATABASE_URL)
            self.assertEqual(env['ALLRICE_DSH_NATIVE_ARTIFACT_ID'], 'new-art')
        self.assert_parked()

    def run_config_tool(self, name, *args, deploy_stubs='', **env):
        # Run the real entrypoint in a fake HOME. Only external services are replaced;
        # configuration selection and writes still use the source scripts and lib.sh.
        directory = os.path.join(self.tmp, 'config-tools')
        with open(os.path.join(HERE, 'lib.sh')) as f:
            write(os.path.join(directory, 'lib.sh'), f.read() + '\n' +
                  ('' if name == 'schedule-recover' else 'job_state() { echo gone; };\nport_closed() { return 0; };\n') +
                  'stop_job() { export PROCESS_TREE_STOPPED=1; };\n'
                  'start_job() { echo UNEXPECTED_START >&2; return 90; };\n'
                  'M1_LAUNCHCTL="$TEST_STUBS/launchctl"\n')
        shutil.copyfile(os.path.join(HERE, 'with-env'), os.path.join(directory, 'with-env'))
        shutil.copyfile(os.path.join(HERE, 'service_target.py'), os.path.join(directory, 'service_target.py'))
        os.chmod(os.path.join(directory, 'with-env'), 0o755)
        with open(os.path.join(HERE, name)) as f:
            script = re.sub(r'^export PATH=.*$', 'export PATH="$TEST_PATH"', f.read(), flags=re.M)
        if name == 'schedule-recover':
            script = script.replace('PG=/opt/homebrew/opt/postgresql@17/bin', 'PG="$TEST_STUBS"')
            shutil.copyfile(os.path.join(HERE, 'qa-lease.py'), os.path.join(directory, 'qa-lease.py'))
            node = os.path.join(self.home, '.local/opt/node-22.23.2/bin/node')
            os.makedirs(os.path.dirname(node), exist_ok=True)
            if not os.path.exists(node):
                os.symlink(NODE, node)
            with open(os.path.join(HERE, 'schedule-recover-processes.py')) as f:
                source = f.read()
            source = source.replace('def observe_process(pid):', 'def native_observe_process(pid):', 1)
            source = source.replace('def process_started(pid):', 'def native_process_started(pid):', 1)
            source = source.replace('def observe_unix_socket(pid, file):', 'def native_observe_unix_socket(pid, file):', 1)
            marker = "if __name__ == '__main__':"
            source = source.replace(marker, '''def process_started(pid):
    if str(pid) == os.environ.get('PROCESS_WORKER_PID') and os.environ.get('PROCESS_TREE_STOPPED'):
        raise OSError('fixture Worker exited')
    return json.loads(os.environ.get('PROCESS_STARTS', '{}'))[str(pid)]

def observe_process(pid):
    row = json.loads(os.environ.get('PROCESS_SNAPSHOT', 'null'))
    if row is None:
        raise OSError('fixture process environment unavailable')
    return row['executable'], row['args'], row['environment'], row['started']

def observe_unix_socket(pid, file):
    rows = json.loads(os.environ.get('PROCESS_UNIX_SOCKETS', '{}'))
    if file.descriptor not in rows:
        raise ValueError('Unix 套接字缺少可核实的 FD 或 PCB 标识')
    row = rows[file.descriptor]
    if 'errno' in row:
        raise OSError(row['errno'], 'fixture socket read failure')
    return row

''' + marker)
            for path in ('/bin/ps', '/usr/sbin/lsof'):
                source = source.replace(repr(path), f'os.environ["TEST_STUBS"] + "/{os.path.basename(path)}"')
            write(os.path.join(directory, 'schedule-recover-processes.py'), source)
            start, rest = script.split('boot_at() {', 1)
            script = start + 'sleep() { :; }; boot_at() { echo 2000-01-01; };\nread -r status' + rest.split('read -r status', 1)[1]
        if name == 'deploy-dev':
            shutil.copyfile(os.path.join(HERE, 'deploy-result.py'), os.path.join(directory, 'deploy-result.py'))
            marker = '# --release-manager is a deliberate speed bump'
            script = script.replace(marker, deploy_stubs + '\n' + marker)
        path = os.path.join(directory, name)
        write(path, script, 0o755)
        path_env = ':'.join([self.stubs, os.path.dirname(NODE), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])
        env = dict(HOME=self.home, PATH=path_env, TEST_STUBS=self.stubs, TEST_PATH=path_env, **env)
        return subprocess.run(['/bin/bash', path, *args], env=env, capture_output=True, text=True, timeout=20)

    def test_cli_deploy_and_recover_preserve_explicit_launchd_programs(self):
        stubs, _ = self.successful_deploy_stubs()
        candidate = self.release(sha='b' * 40)
        contract = os.path.join(self.tmp, 'contract-cli.txt')
        write(contract, 'row:1')
        write(self.applied, '\n'.join(FILES + ARCHIVED) + '\n')
        states = dict(deploy_stubs=stubs.replace('BIN=$SMOKE; ', ''), APPLIED=self.applied,
                      CONTRACT_FILE=contract, CANDIDATE=candidate, ART='sha256:' + 'b' * 64)
        historical = os.path.join(self.home, 'allrice40-dev/tools', 'f' * 40, 'with-env')
        write(historical, '#!/bin/sh\nexit 99\n', 0o755)
        originals = {}
        for role in ('web', 'worker'):
            original = self.plist(role)
            if role == 'worker':
                original['ProgramArguments'] = [historical, role, NODE, original['ProgramArguments'][-1]]
            original['Program'] = original['ProgramArguments'][0]
            originals[role] = original
            with open(self.live_plist(role), 'wb') as f:
                plistlib.dump(original, f)
        p = self.run_config_tool('deploy-dev', '--release-manager', '--skip-smoke', **states)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('STOPPED:3311', p.stdout)
        self.assertIn('READY:' + 'b' * 40, p.stdout)
        inflight = os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight')
        write(os.path.join(inflight, 'state'), 'switching\n' + 'a' * 40 + '\n')
        for role, original in originals.items():
            active = self.read_plist(self.live_plist(role))
            self.assertEqual(active['Program'], active['ProgramArguments'][0])
            self.assertTrue(active['Program'].endswith('/with-env'))
            self.assertEqual(active['EnvironmentVariables']['ALLRICE_RELEASE_SHA'], 'b' * 40)
            with open(os.path.join(inflight, role + '.plist'), 'wb') as f:
                plistlib.dump(original, f)
        p = self.run_config_tool('deploy-dev', '--release-manager', '--recover', **states)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('READY:' + 'a' * 40, p.stdout)
        self.assertFalse(os.path.exists(inflight))
        for role, original in originals.items():
            self.assertEqual(self.read_plist(self.live_plist(role)), original)

    def test_cli_refuses_uncovered_storage_and_mixed_saved_entry_before_stopping(self):
        stubs, _ = self.successful_deploy_stubs()
        stubs = stubs.replace('BIN=$SMOKE; ', '')
        self.saved_release(self.initial_release)
        saved = os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight/worker.plist')
        old = self.home + '/allrice-dev-releases/old/apps/worker/dist/index.js'
        write(old, '')
        wrong = self.read_plist(saved)
        wrong['ProgramArguments'][-1] = old
        with open(saved, 'wb') as f:
            plistlib.dump(wrong, f)
        p = self.run_config_tool('deploy-dev', '--release-manager', '--recover', deploy_stubs=stubs)
        self.assertNotEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertNotIn('STOPPED:', p.stdout)
        self.assertEqual(self.read_plist(saved), wrong)
        shutil.rmtree(os.path.dirname(saved))
        storage = os.path.join(self.home, 'allrice40-dev/.local/storage')
        shutil.move(storage, os.path.join(self.tmp, 'state-storage'))
        os.symlink(os.path.join(self.tmp, 'state-storage'), storage)
        p = self.run_config_tool('deploy-dev', '--release-manager', '--skip-smoke', deploy_stubs=stubs)
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertNotIn('STOPPED:', p.stdout)
        p = self.run_config_tool('backup-daily')
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice40-backups')))

    def test_backup_copies_parked_plists_and_finishes(self):
        self.assertEqual(self.run_dd('park_plists', []).returncode, 0)
        os.makedirs(os.path.join(self.home, 'allrice40-backups/db'))
        # File copying is local to the fixture; no rsync installation is needed in CI.
        write(os.path.join(self.stubs, 'rsync'), '#!' + sys.executable + '\n'
              'import shutil,sys\nshutil.copytree(sys.argv[-2], sys.argv[-1], dirs_exist_ok=True)\n', 0o755)
        p = self.run_config_tool('backup-daily')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('ok db=', p.stdout)
        files = os.path.join(self.home, 'allrice40-backups/files')
        day = os.path.join(files, os.listdir(files)[0])
        for role in ('web', 'worker'):
            self.assertEqual(self.read_plist(os.path.join(day, role + '.plist')), self.plist(role))
        self.assert_parked()

    def test_cloud_start_reads_parked_config_without_loading_dev(self):
        calls = os.path.join(self.tmp, 'cloud-calls')
        colima = os.path.join(self.stubs, 'colima')
        write(colima, '#!/bin/sh\necho "$*" >> "$CALLS"\n'
              '[ "$1" != status ] || exit 1\necho \'{"ready":true}\'\n', 0o755)
        write(os.path.join(self.stubs, 'docker'), '#!/bin/sh\necho "running healthy"\n', 0o755)
        write(os.path.join(self.stubs, 'curl'), '#!/bin/sh\necho \'{"ready":true}\'\n', 0o755)
        write(os.path.join(self.stubs, 'launchctl'), '#!/bin/sh\necho UNEXPECTED_LAUNCHCTL >&2\nexit 90\n', 0o755)
        worker = self.plist('worker')
        worker['EnvironmentVariables'].update(ALLRICE_CLOUD_PROFILE='fixture-cloud', ALLRICE_CLOUD_COLIMA=colima,
                                              ALLRICE_OFFICE_RENDERER_URL='http://fixture-renderer')
        with open(self.live_plist('worker'), 'wb') as f:
            plistlib.dump(worker, f)
        self.assertEqual(self.run_dd('park_plists', []).returncode, 0)
        p = self.run_config_tool('cloud-autostart', CALLS=calls)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('cloud watchdog attests ready', p.stdout)
        self.assertNotIn('UNEXPECTED', p.stdout + p.stderr)
        with open(calls) as f:
            self.assertIn('start fixture-cloud', f.read())
        for role in ('web', 'worker'):
            self.assertFalse(os.path.exists(self.live_plist(role)))
        self.assertEqual(self.read_plist(os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled/worker.plist')), worker)

    def test_smoke_dev_reads_parked_ports_and_artifact(self):
        self.assertEqual(self.run_dd('park_plists', []).returncode, 0)
        probe = os.path.join(self.tmp, 'smoke-args.json')
        write(os.path.join(self.home, '.local/opt/node-22.23.2/bin/node'), '#!' + sys.executable + '\n'
              'import json,os,sys\nargs=sys.argv[2:]; out=args[args.index("--out")+1]\n'
              'json.dump(args,open(os.environ["PROBE"],"w")); os.makedirs(out,exist_ok=True)\n'
              'json.dump({"results":[]},open(out+"/result.json","w"))\n', 0o755)
        out = os.path.join(self.tmp, 'smoke-result')
        p = self.run_config_tool('smoke-test', '--dev', '--only', 'chat', '--out', out, PROBE=probe)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        with open(probe) as f:
            args = json.load(f)
        self.assertEqual(args[args.index('--url') + 1], 'http://127.0.0.1:3311')
        self.assertEqual(args[args.index('--worker-url') + 1], 'http://127.0.0.1:3312')
        with open(os.path.join(out, 'result.json')) as f:
            self.assertEqual(json.load(f)['nativeArtifactId'], 'sha256:' + 'a' * 64)
        self.assert_parked()

    def seed_recovery_partition(self):
        rows = [{'partitionId': 'once', 'ownerId': 'old-worker', 'epoch': 1, 'tokenDigest': 'token',
                 'expiresAt': '2000-01-01', 'closed': False, 'expired': True, 'proofNull': True, 'audit': None}]
        write(os.path.join(self.stubs, 'curl'), '#!/bin/sh\necho \'{}\'\n', 0o755)
        write(os.path.join(self.stubs, 'psql'), '#!' + sys.executable + '\n'
              'import json,os,sys\n'
              'if "-f" in sys.argv:\n'
              '    if os.environ.get("SQL_FAIL"): sys.exit(1)\n'
              '    evidence=next(a.split("=",1)[1] for a in sys.argv if a.startswith("evidence="))\n'
              '    assert json.loads(evidence)["processObservations"] == "process-observations.json"\n'
              '    claim=next((a.split("=",1)[1] for a in sys.argv if a.startswith("database_claim=")), "")\n'
              '    open(os.environ["PROOF"],"w").write(claim); sys.exit(0)\n'
              'if "pg_stat_activity" in sys.argv[-1]: print(os.environ.get("WORKER_SESSIONS", "0")); sys.exit(0)\n'
              'rows=json.loads(os.environ["ROWS"])\n'
              'if os.path.exists(os.environ["PROOF"]): rows[0].update(closed=True,audit=True)\n'
              'print(json.dumps(rows))\n', 0o755)
        return rows

    def recovery_scan_fixture(self, task):
        instance = self.write_qa_plists(task)
        worker = self.read_plist(os.path.join(instance, 'worker.plist'))
        web = self.read_plist(os.path.join(instance, 'web.plist'))
        agents = os.path.join(self.home, 'Library/LaunchAgents')
        for role, plist in (('worker', worker), ('web', web)):
            destination = os.path.join(agents, plist['Label'] + '.plist')
            subprocess.run([sys.executable, '-B', os.path.join(HERE, 'qa-lease.py'), 'publish-plist',
                            os.path.join(instance, 'instance.json'), role, destination],
                           env=dict(HOME=self.home, PATH=os.defpath), capture_output=True, text=True, check=True)
        self.recovery_web_plist = destination
        self.recovery_web_cwd = web['WorkingDirectory']
        self.recovery_worker_plist = os.path.join(agents, worker['Label'] + '.plist')
        self.recovery_worker_cwd = worker['WorkingDirectory']
        write(os.path.join(self.stubs, 'launchctl'), '#!/bin/sh\n'
              'case "$2" in\n'
              '  *-web) set -- "$PROCESS_WEB_PLIST" "$PROCESS_WEB_CWD" "$PROCESS_WEB_PID" ;;\n'
              '  *-worker) [ -z "$PROCESS_TREE_STOPPED" ] || exit 113; '
              'set -- "$PROCESS_WORKER_PLIST" "$PROCESS_WORKER_CWD" "$PROCESS_WORKER_PID" ;;\n'
              '  *) exit 113 ;;\n'
              'esac\n[ -n "$3" ] || exit 113\n'
              'printf "path = %s\\nworking directory = %s\\npid = %s\\n" "$@"\n', 0o755)
        return instance, worker, web

    def test_schedule_recover_checks_the_verified_worktree_and_instance_directory(self):
        task = 'recover-scan'
        instance, worker, web = self.recovery_scan_fixture(task)
        release = worker['WorkingDirectory']
        web_entry = web['ProgramArguments'][2]
        old = os.path.join(self.home, 'allrice-qa', task, 'release')
        old_entry = os.path.join(old, 'apps/worker/dist/index.js')
        old_web_entry = os.path.join(old, 'apps/web/server.mjs')
        write(old_entry, '')
        write(old_web_entry, '')
        relative = os.path.relpath(os.path.join(release, 'apps/worker/dist/index.js'), self.home)
        rows = self.seed_recovery_partition()
        for name, script, cwd, allowed in (
            ('release cwd', old_entry, release, False),
            ('absolute release script', os.path.join(release, 'apps/worker/dist/index.js'), self.home, False),
            ('relative release script', relative, self.home, False),
            ('script after end of options', '-- ' + relative, self.home, False),
            ('separate unhandled rejection value', '--unhandled-rejections strict ' + relative, self.home, False),
            ('separate numeric value before delimiter', '--max-http-header-size 16384 -- ' + relative, self.home, False),
            ('instance cwd', old_entry, instance, False),
            ('3.x script after end of options', '-- ' + old_entry, self.home, True),
            ('same name 3.x with documented options', '--unhandled-rejections strict --max-http-header-size 16384 ' + old_entry, old, True),
            ('same name 3.x release', old_entry, old, True),
            ('unrecognized option with an apparent 3.x entry', '--unknown-runtime-option ' + old_entry, old, False),
            ('unknown attached option', '--unknown-runtime-option=value ' + old_entry, old, False),
            ('missing option value or entry', '--max-http-header-size --', old, False),
            ('unrecognized args cannot use the Web exemption', '--unknown-runtime-option /elsewhere/apps/web/server.mjs', old, False),
            ('inline execution with apparent 3.x entry', '--eval=process.exit() ' + old_entry, old, False),
            ('ambiguous apparent Web entry with Worker argument', '--title demo ' + web_entry + ' ' + relative, self.home, False),
        ):
            with self.subTest(name=name):
                self.check_recovery_scan(task, rows, name, ['node', *shlex.split(script)], cwd, allowed)

        duplicate = os.path.join(instance, '.local/project/apps/web/server.mjs')
        nested = os.path.join(release, 'nested/apps/web/server.mjs')
        for path in (duplicate, nested):
            write(path, '// inert fixture\n')
        db_env = {'DATABASE_URL': worker['EnvironmentVariables']['DATABASE_URL']}
        env_file = os.path.join(self.tmp, 'node-config.env')
        clean_env = os.path.join(self.tmp, 'clean.env')
        old_env = os.path.join(os.path.dirname(old), '.env')
        write(env_file, 'export NODE_OPTIONS="--require /outside/unexecuted-fixture.js"\n')
        write(clean_env, 'NODE_OPTIONS="--unhandled-rejections strict"\n')
        write(old_env, 'DATABASE_URL=postgres://tester@127.0.0.1:5432/allrice_qa_recover_scan\n')
        old_args = [NODE, old_entry]
        web_args, web_cwd = web['ProgramArguments'], web['WorkingDirectory']
        web_state = {'web_pid': '999999'}
        for name, args, cwd, allowed, facts in (
            ('verified Web with environment file', web_args, web_cwd, True, dict(web_state, environment=db_env)),
            ('Web argv without confirmed service', web_args, web_cwd, False, dict(environment=db_env)),
            ('Web argv with another service PID', web_args, web_cwd, False, dict(web_pid='999998', environment=db_env)),
            ('Web argv under an unrelated loaded plist', web_args, web_cwd, False,
             dict(web_state, environment=db_env, job_plist=self.recovery_web_plist + '.other')),
            ('Web argv with wrong cwd', web_args, old, False, dict(web_state, environment=db_env)),
            ('Web suffix in instance data', [NODE, duplicate], instance, False, dict(web_state, environment=db_env)),
            ('Web suffix in nested release', [NODE, nested], release, False, dict(web_state, environment=db_env)),
            ('Web with inherited preload', web_args, web_cwd, False,
             dict(web_state, environment=dict(db_env, NODE_OPTIONS='--require /outside/unexecuted-fixture.js'))),
            ('startup snapshot', [NODE, '--snapshot-blob', '/outside/unexecuted.blob', old_entry], old, False, {}),
            ('snapshot builder', [NODE, '--build-snapshot-config=/outside/unexecuted.json', old_entry], old, False, {}),
            ('inherited preload', old_args, old, False, dict(environment={'NODE_OPTIONS': '--import /outside/unexecuted.mjs'})),
            ('file preload', [NODE, '--env-file', env_file, old_entry], old, False, {}),
            ('env file after apparent script', [*old_args, '--env-file=' + env_file], old, False, {}),
            ('config file after apparent script', [*old_args, '--experimental-config-file=/outside/unexecuted.json'], old, False, {}),
            ('inherited native loader setting', old_args, old, False,
             dict(environment={'DYLD_INSERT_LIBRARIES': '/outside/unexecuted.dylib'})),
            ('inherited empty options override the file', [NODE, '--env-file=' + env_file, old_entry], old, True,
             dict(environment={'NODE_OPTIONS': ''})),
            ('ordinary env options', [NODE, '--env-file=' + clean_env, old_entry], old, True, {}),
            ('ordinary 3.x Web', [NODE, '--env-file=' + old_env, old_web_entry, '--hostname', '127.0.0.1', '--port', '3200'],
             os.path.dirname(old_web_entry), True, {}),
            ('env file edited since launch', [NODE, '--env-file=' + clean_env, old_entry], old, False,
             dict(started=os.stat(clean_env).st_ctime_ns - 1)),
            ('unavailable optional env file', [NODE, '--env-file-if-exists=' + clean_env + '.missing', old_entry], old, False, {}),
            ('unavailable process environment', old_args, old, False, dict(observed=False)),
        ):
            with self.subTest(name=name):
                self.check_recovery_scan(task, rows, name, args, cwd, allowed, **facts)
        os.unlink(self.recovery_web_plist)
        shutil.copyfile(os.path.join(instance, 'web.plist'), self.recovery_web_plist)
        self.check_recovery_scan(task, rows, 'Web plist has an unrelated inode', web_args, web_cwd, False,
                                 environment=db_env, **web_state)

    def test_schedule_recover_refuses_uncertain_launch_evidence(self):
        task = 'recover-evidence'
        instance, worker, web = self.recovery_scan_fixture(task)
        rows = self.seed_recovery_partition()
        entry = os.path.join(self.home, 'allrice-qa', task, 'release', 'ordinary.mjs')
        write(entry, '// inert fixture\n')
        outside = os.path.dirname(entry)
        for name, contents, allowed in (
            ('LF', b'FIXTURE_FIRST=one\nFIXTURE_SECOND=two\n', True),
            ('CRLF', b'FIXTURE_FIRST=one\r\nFIXTURE_SECOND=two\r\n', True),
            ('standalone CR between fields', b'FIXTURE_FIRST=one\rFIXTURE_SECOND=two\n', False),
            ('standalone CR inside a key', b'FIXTURE_\rSECOND=two\n', False),
        ):
            with self.subTest(name=name):
                path = os.path.join(self.tmp, name + '.env')
                with open(path, 'wb') as dotenv:
                    dotenv.write(contents)
                self.check_recovery_scan(task, rows, name, [NODE, '--env-file=' + path, entry], outside, allowed,
                                         reason=None if allowed else '环境文件含独立回车')

        secret = 'fictional-fixture-password'
        dsn = 'postgres://tester:' + secret + '@127.0.0.1:5434'
        target = '/allrice40_qa_recover_evidence'
        review_host = '请把 DSN 改成标准本机地址，或确认这个进程不连目标库'
        for name, value, extra, allowed, reason in (
            ('full other database takes precedence', dsn + '/allrice_qa_recover_evidence',
             {'PGDATABASE': target[1:]}, True, None),
            ('full target database', dsn + target, {'PGDATABASE': 'other'}, False, None),
            ('target at localhost', 'postgres://localhost' + target, {}, False, 'DATABASE_URL 指向目标库'),
            ('target at IPv6 loopback', 'postgres://[::1]' + target, {}, False, 'DATABASE_URL 指向目标库'),
            ('target via default socket', 'postgresql://' + target, {}, False, 'DATABASE_URL 指向目标库'),
            ('target via explicit socket', 'postgres://%2Fprivate%2Ftmp' + target, {}, False, 'DATABASE_URL 指向目标库'),
            ('target at abbreviated loopback', 'postgres://127.1' + target, {}, False, review_host),
            ('target at nonstandard host', 'postgres://pg-fixture.invalid' + target, {}, False, review_host),
            ('other database at nonstandard host', 'postgres://pg-fixture.invalid/other', {}, True, None),
            ('empty path despite PGDATABASE', dsn, {'PGDATABASE': 'other'}, False, 'URL 路径缺少库名'),
            ('slash path despite username', dsn + '/', {}, False, 'URL 路径缺少库名'),
            ('unverified connection overrides', dsn + '/other?database=' + target[1:], {}, False, 'DATABASE_URL 无法核实'),
        ):
            with self.subTest(name=name):
                self.check_recovery_scan(task, rows, name, [NODE, entry], outside, allowed,
                                         environment=dict(extra, DATABASE_URL=value), reason=reason, secret=secret)
        self.check_recovery_scan(task, rows, 'official Web with pathless DSN',
                                 web['ProgramArguments'], web['WorkingDirectory'], False,
                                 web_pid='999999', environment={'DATABASE_URL': dsn + '/', 'PGDATABASE': target[1:]},
                                 reason='URL 路径缺少库名', secret=secret)

        helper = '/bin/sh'
        for name, args, cwd, allowed, facts in (
            ('visible unrelated helper', [helper, entry], outside, True, {}),
            ('helper environment hidden outside scope', [helper, entry], outside, True,
             dict(env_visible=False, reason='套接字观测未见目标')),
            ('helper native environment unavailable', [helper, entry], outside, True,
             dict(observed=False, reason='套接字观测未见目标')),
            ('helper environment hidden in target cwd', [helper, entry], instance, False,
             dict(env_visible=False, reason='lsof 显示工作目录属于目标')),
            ('helper with target cwd', [helper, entry], instance, False, {}),
            ('helper with target launch path', [helper, os.path.join(instance, 'helper.sh')], outside, False, {}),
            ('known Worker descendant reparented', [helper, entry], outside, False,
             dict(worker_parent=True, env_visible=False, reason='停止前已核实为 Worker 或其子进程')),
            ('known Worker descendant off current list', [helper, entry], outside, False,
             dict(worker_parent=True, listed=False, reason='停止前已核实为 Worker 或其子进程')),
        ):
            with self.subTest(name=name):
                self.check_recovery_scan(task, rows, name, args, cwd, allowed, executable=helper, **facts)

    def test_schedule_recover_uses_lsof_for_helpers_with_hidden_environments(self):
        task = 'recover-open-files'
        _, worker, _ = self.recovery_scan_fixture(task)
        rows = self.seed_recovery_partition()
        safe = '套接字观测未见目标'
        connection = '套接字观测命中本机 PostgreSQL 5434 端点'
        unreadable = '无法核实 lsof'
        secret = 'fixture-sensitive-file-name'
        opened = os.path.join(worker['WorkingDirectory'], secret)
        write(opened, '// synthetic fixture\n')
        for name, allowed, reason, facts in (
            ('open file in target', False, 'lsof 显示打开文件属于目标',
             dict(file_sets=[['f3', 'tREG', 'n' + opened]])),
            ('open file outside target', True, safe,
             dict(file_sets=[['f3', 'tREG', 'n' + os.path.join(self.home, secret)]])),
            ('confirmed unnamed system handles', True, safe,
             dict(file_sets=[['f3', 'tNPOLICY', 'n'], ['f4', 'tNEXUS', 'n'], ['f5', 'tKQUEUE', 'n'], ['f6', 'tPIPE', 'n']])),
            ('unnamed unknown descriptor', False, 'TYPE=unknown',
             dict(file_sets=[['f3', 'tunknown', 'n']])),
            ('unknown descriptor names a target file', False, '打开文件属于目标',
             dict(file_sets=[['f3', 'tunknown', 'n' + opened]])),
            ('known unnamed handle with explicit error', False, 'errno=13',
             dict(file_sets=[['ferr', 'tNPOLICY', 'nFD info error: Permission denied errno=13']])),
            ('loopback IPv4 PG connection', False, connection,
             dict(file_sets=[['f4', 'tIPv4', 'PTCP', 'n127.0.0.1:49600->127.0.0.1:5434']])),
            ('loopback IPv6 PG connection', False, connection,
             dict(file_sets=[['f4', 'tIPv6', 'PTCP', 'n[::1]:49600->[::1]:5434']])),
            ('loopback UDP PG endpoint', False, connection,
             dict(file_sets=[['f4', 'tIPv4', 'PUDP', 'n127.0.0.1:49600->127.0.0.1:5434']])),
            ('incomplete IP peer', False, 'TCP/UDP 连接记录不完整（TYPE=IPv4）',
             dict(file_sets=[['f4', 'tIPv4', 'PTCP', 'n127.0.0.1:49600->']])),
            ('PG listener is not a TCP client', True, safe,
             dict(file_sets=[['f4', 'tIPv4', 'PTCP', 'n127.0.0.1:5434']])),
            ('local TCP connection to another port', True, safe,
             dict(file_sets=[['f4', 'tIPv4', 'PTCP', 'n127.0.0.1:49600->127.0.0.1:5432']])),
            ('same port on nonlocal host', True, safe,
             dict(file_sets=[['f4', 'tIPv4', 'PTCP', 'n127.0.0.1:49600->192.0.2.1:5434']])),
            ('Unix PG socket by name', False, connection,
             dict(file_sets=[['f4', 'tunix', 'n/private/tmp/.s.PGSQL.5434']])),
            ('Unix PG socket by peer', False, connection,
             dict(file_sets=[['f4', 'tunix', 'n->0xabc'], ['p999997'],
                             ['f5', 'tunix', 'd0xabc', 'n/private/tmp/.s.PGSQL.5434']])),
            ('Unix peer for different PG port', True, safe,
             dict(file_sets=[['f4', 'tunix', 'n->0xabc'], ['p999997'],
                             ['f5', 'tunix', 'd0xabc', 'n/private/tmp/.s.PGSQL.5432']])),
            ('identified unnamed Unix pair', True, safe,
             dict(file_sets=[['f4', 'tunix', 'd0xdef', 'n->0xabc'], ['p999997'],
                             ['f5', 'tunix', 'd0xabc', 'n->0xdef']])),
            ('Unix endpoint name missing', False, 'Unix 套接字缺少可核实的 FD 或 PCB 标识（TYPE=unix）',
             dict(file_sets=[['f4', 'tunix', 'n']])),
            ('Unix peer not observed', False, 'Unix 套接字缺少可核实的 FD 或 PCB 标识（TYPE=unix）',
             dict(file_sets=[['f4', 'tunix', 'n->0xabc']])),
            ('PG peer available via candidate FD alone', False, connection,
             dict(file_sets=[['f4', 'tunix', 'd0xdef', 'n->0xabc']],
                  unix_sockets={'4': dict(connected=True, localNamed=False, peerNamed=True, targetPg=True)})),
            ('non-PG named peer available via candidate FD alone', True, safe,
             dict(file_sets=[['f4', 'tunix', 'd0xdef', 'n->0xabc']],
                  unix_sockets={'4': dict(connected=True, localNamed=False, peerNamed=True, targetPg=False)})),
            ('kernel confirms connected endpoints both unnamed', True, safe,
             dict(file_sets=[['f4', 'tunix', 'd0xdef', 'n->0xabc']],
                  unix_sockets={'4': dict(connected=True, localNamed=False, peerNamed=False, targetPg=False)})),
            ('kernel confirms unbound and unconnected', True, safe,
             dict(file_sets=[['f4', 'tunix', 'd0xdef', 'n->(none)']],
                  unix_sockets={'4': dict(connected=False, localNamed=False, peerNamed=False, targetPg=False)})),
            ('kernel socket read denied out of index', False, '本机 Unix FD 读取失败（TYPE=unix）。errno=13',
             dict(file_sets=[['f4', 'tunix', 'd0xdef', 'n->0xabc']], unix_sockets={'4': {'errno': 13}})),
            ('missing cwd preserves the FD errno', False, '本机 Unix FD 读取失败（TYPE=unix）。errno=13',
             dict(cwd=None, file_sets=[['f4', 'tunix', 'd0xdef', 'n->0xabc']], unix_sockets={'4': {'errno': 13}})),
            ('lsof has no record for a still present process', False, unreadable, dict(cwd=None)),
            ('per PID lsof permission error', False, '系统未提供 errno',
             dict(file_sets=[['ferr', 'tunknown', 'nFD info error: Operation not permitted']])),
            ('lsof returned an error', False, unreadable, dict(lsof_exit=1)),
            ('lsof stdout with a permission warning', False, unreadable,
             dict(lsof_warning='lsof: Permission denied: ' + secret)),
        ):
            with self.subTest(name=name):
                cwd = facts.pop('cwd', self.home)
                self.check_recovery_scan(task, rows, name, ['/bin/sh'], cwd, allowed,
                                         executable='/bin/sh', env_visible=False, reason=reason, secret=secret, **facts)

    def test_schedule_recover_checks_disjoint_node_without_trusting_its_runtime(self):
        task = 'recover-other-node'
        instance, worker, _ = self.recovery_scan_fixture(task)
        rows = self.seed_recovery_partition()
        runtime = os.path.join(self.tmp, 'alternate-runtime', 'node')
        script = os.path.join(self.home, 'outside', 'ordinary.mjs')
        env_file = os.path.join(self.tmp, 'outside.env')
        write(runtime, 'inert fixture')
        write(script, '// inert fixture\n')
        write(env_file, 'FIXTURE=ordinary\n')
        for name, args, cwd, env, allowed in (
            ('alternate Node outside target', [runtime, script, '--ordinary-app-argument'], self.home, {}, True),
            ('alternate Node with relative entry and neutral options',
             [runtime, '--enable-source-maps', './ordinary.mjs'], os.path.dirname(script),
             {'NODE_OPTIONS': '--trace-warnings --max-old-space-size=1024'}, True),
            ('alternate Node with 5434', [runtime, script], self.home, {'PGPORT': '5434'}, False),
            ('alternate Node with target cwd', [runtime, script], instance, {}, False),
            ('alternate Node with target path', [runtime, script, worker['WorkingDirectory']], self.home, {}, False),
            ('alternate Node with target database', [runtime, script], self.home,
             {'DATABASE_URL': 'postgres://localhost/allrice40_qa_recover_other_node'}, False),
            ('alternate Node with env file', [runtime, '--env-file=' + env_file, script], self.home, {}, False),
            ('early env file option after script', [runtime, script, '--env-file=' + env_file], self.home, {}, False),
            ('alternate runtime with startup config after script', [runtime, script, '--experimental-config-file=' + env_file],
             self.home, {}, False),
            ('alternate Node with preloaded code', [runtime, script], self.home,
             {'NODE_OPTIONS': '--import /unexecuted-fixture.mjs'}, False),
            ('unknown Node launch mode', [runtime, '--unverified-launch-mode', script], self.home, {}, False),
        ):
            with self.subTest(name=name):
                self.check_recovery_scan(task, rows, name, args, cwd, allowed, executable=runtime, environment=env,
                                         reason='普通 Node 启动未见目标库' if allowed else None)
        self.check_recovery_scan(task, rows, 'outside Node with a newer entry file', [runtime, script], self.home, True,
                                 executable=runtime, started=os.stat(script).st_ctime_ns - 1,
                                 reason='普通 Node 启动未见目标库')
        self.check_recovery_scan(task, rows, 'Node with opaque loader environment', [runtime, script], self.home, False,
                                 executable=runtime, environment={'NODE_FIXTURE_SETTINGS': 'opaque'},
                                 reason='启动环境含无法核实作用的加载设置')
        builtins = self.check_recovery_scan(task, rows, 'outside Node exposing built-in internals',
                                            [runtime, '--expose-internals', script], self.home, True,
                                            executable=runtime)
        proxy = self.check_recovery_scan(task, rows, 'outside Node using the HTTP proxy switch',
                                         [runtime, script], self.home, True, executable=runtime,
                                         environment={'NODE_USE_ENV_PROXY': '1'})
        self.assertIn('--expose-internals', builtins['evidence']['startup']['recognizedOptions'])
        self.assertIn('NODE_USE_ENV_PROXY', proxy['evidence']['startup']['recognizedSettings'])

        alias_directory = os.path.join(self.home, 'installed-launcher')
        command_directory = os.path.join(os.path.dirname(script), 'commands')
        os.mkdir(command_directory)
        launcher = os.path.join(command_directory, 'fixture-cli')
        os.symlink(os.path.dirname(script), alias_directory)
        os.symlink('../ordinary.mjs', launcher)
        for name, args in (
            ('installed launcher directory', [runtime, '--expose-internals', os.path.join(alias_directory, 'ordinary.mjs')]),
            ('extensionless command symlink', [runtime, launcher]),
        ):
            with self.subTest(name=name):
                observed_launch = self.check_recovery_scan(task, rows, name, args, self.home, True, executable=runtime)
                self.assertEqual(observed_launch['evidence']['startup']['ordinaryEntry'], 'symlink verified at startup')

        target_entry = os.path.join(instance, 'target.mjs')
        write(target_entry, '// inert target fixture\n')
        target_link = os.path.join(command_directory, 'target-cli')
        inside_target_link = os.path.join(instance, 'link-to-outside')
        crossing_link = os.path.join(command_directory, 'crossing-cli')
        os.symlink(target_entry, target_link)
        os.symlink(script, inside_target_link)
        os.symlink(inside_target_link, crossing_link)
        for name, path, started in (
            ('outside launcher resolves into the target', target_link, None),
            ('outside launcher traverses the target', crossing_link, None),
            ('outside launcher changed after exec', launcher, os.lstat(launcher).st_ctime_ns - 1),
        ):
            with self.subTest(name=name):
                self.check_recovery_scan(task, rows, name, [runtime, path], self.home, False,
                                         executable=runtime, started=started)

        preload = self.check_recovery_scan(task, rows, 'entry uses an explicit preload',
                                          [runtime, '--expose-internals', '--require', script, script], self.home,
                                          False, executable=runtime, reason='入口前的 --require 会预加载模块', secret=script)
        self.assertTrue(preload['evidence']['startup']['extraCodeSourceFlag'])
        search_path = os.path.join(self.home, 'fixture-unreported-search-path')
        module_path = self.check_recovery_scan(task, rows, 'proxy switch with a module search path', [runtime, script],
                                              self.home, False, executable=runtime, reason='NODE_PATH 增加模块搜索目录',
                                              environment={'NODE_USE_ENV_PROXY': '1', 'NODE_PATH': search_path}, secret=search_path)
        self.assertIn('NODE_PATH', module_path['evidence']['startup']['recognizedLoadingControls'])
        for name, args, cwd, env in (
            ('built-in access with target PG port', [runtime, '--expose-internals', script], self.home, {'PGPORT': '5434'}),
            ('built-in access from target cwd', [runtime, '--expose-internals', script], instance, {}),
            ('built-in access with an env file', [runtime, '--expose-internals', '--env-file=' + env_file, script],
             self.home, {}),
            ('built-in access in opaque inherited options', [runtime, script], self.home,
             {'NODE_OPTIONS': '--expose-internals'}),
            ('proxy switch in an unverified form', [runtime, script], self.home,
             {'NODE_USE_ENV_PROXY': 'fixture-unsupported-proxy-setting'}),
        ):
            with self.subTest(name=name):
                self.check_recovery_scan(task, rows, name, args, cwd, False, executable=runtime, environment=env,
                                         secret='fixture-unsupported-proxy-setting')
        self.check_recovery_scan(task, rows, 'startup data unavailable for a Node candidate',
                                 [runtime, '--expose-internals', script], self.home, False,
                                 executable=runtime, observed=False, reason='无法读取进程启动环境')

    def test_schedule_recover_refuses_a_visible_worker_database_session(self):
        task = 'recover-worker-session'
        self.recovery_scan_fixture(task)
        rows = self.seed_recovery_partition()
        proof = os.path.join(self.tmp, 'worker-session-proof')
        result = self.run_config_tool('schedule-recover', '--instance', task, '--execute',
                                      ROWS=json.dumps(rows), PROOF=proof, WORKER_SESSIONS='1')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('1 Worker session(s) still on the database', result.stderr)
        self.assertFalse(os.path.exists(proof))

    def check_recovery_scan(self, task, rows, name, args, cwd, allowed, *, environment=None, started=None,
                            web_pid='', observed=True, job_plist=None, executable=NODE, env_visible=True,
                            worker_parent=False, listed=True, reason=None, secret=None,
                            file_sets=(), lsof_exit=0, lsof_warning='', unix_sockets=None):
        proof = os.path.join(self.tmp, 'scan-proof-' + name.replace(' ', '-'))
        started = started or time.time_ns()
        environment = dict(HOME=self.home, **(environment or {})) if env_visible else {}
        snapshot = dict(executable=executable, args=args, environment=environment, started=started) if observed else None
        command = os.path.basename(executable)
        before = f'999998 1 node\n999999 999998 {command}\n' if worker_parent else ''
        file_sets = ([['fcwd', 'tDIR', 'n' + cwd]] if cwd else []) + list(file_sets)
        if file_sets:
            file_sets.insert(0, ['p999999'])
        p = self.run_config_tool('schedule-recover', '--instance', task, '--execute',
                                 ROWS=json.dumps(rows), PROOF=proof, PROCESS_WEB_PID=web_pid,
                                 PROCESS_WEB_PLIST=job_plist or self.recovery_web_plist, PROCESS_WEB_CWD=self.recovery_web_cwd,
                                 PROCESS_WORKER_PID='999998' if worker_parent else '',
                                 PROCESS_WORKER_PLIST=self.recovery_worker_plist, PROCESS_WORKER_CWD=self.recovery_worker_cwd,
                                 PROCESS_SNAPSHOT=json.dumps(snapshot), PROCESS_ARGS=f'999999 1 {command}\n' if listed else '',
                                 PROCESS_ARGS_BEFORE=before, PROCESS_STARTS=json.dumps({'999998': started - 1, '999999': started}),
                                 PROCESS_LSOF=json.dumps(file_sets), PROCESS_LSOF_EXIT=str(lsof_exit),
                                 PROCESS_LSOF_WARNING=lsof_warning, PROCESS_UNIX_SOCKETS=json.dumps(unix_sockets or {}))
        self.assertEqual(p.returncode, 0 if allowed else 1, p.stdout + p.stderr)
        self.assertEqual(os.path.exists(proof), allowed)
        instance = os.path.join(self.home, 'allrice-qa', '_allrice40-' + task)
        latest = sorted(name for name in os.listdir(instance) if name.startswith('schedule-recover-'))[-1]
        with open(os.path.join(instance, latest, 'process-observations.json'), encoding='utf-8') as stream:
            report = json.load(stream)
        if lsof_exit or lsof_warning:
            self.assertEqual(report['status'], 'error')
            self.assertNotIn('processes', report)
            self.assertIn('cannot verify process observations', p.stderr)
        else:
            self.assertEqual(report['status'], 'complete')
            count = 1 + int(worker_parent)
            self.assertEqual((report['total'], report['allowed'], report['blocked']),
                             (count, int(allowed) + int(worker_parent), int(not allowed)))
            self.assertEqual(len(report['processes']), count)
            observed = report['processes'][-1]
            self.assertEqual(set(observed) - {'evidence'}, {'pid', 'command', 'allowed', 'reason'})
            self.assertEqual((observed['pid'], observed['command'], observed['allowed']), (999999, command, allowed))
            if unix_sockets:
                native = [item for item in observed['evidence']['unixSockets'] if item['source'] == 'proc_pidfdinfo']
                self.assertEqual(len(native), len(unix_sockets))
                for info, fixture in zip(native, unix_sockets.values()):
                    self.assertEqual(info['type'], 'unix')
                    self.assertEqual({key: info[key] for key in fixture}, fixture)
                if cwd is None:
                    self.assertIn('未看到此进程的可核实 cwd', observed['reason'])
        if allowed:
            with open(proof) as f:
                self.assertEqual(f.read(), QA_DATABASE_CLAIM)
        elif not (lsof_exit or lsof_warning):
            self.assertIn('processes that could own the partitions are still running', p.stderr)
        if reason:
            self.assertIn(reason, report['reason'] if report['status'] == 'error' else observed['reason'])
            if not allowed:
                self.assertIn(reason, p.stderr)
        if secret:
            self.assertNotIn(secret, p.stdout + p.stderr)
            self.assertNotIn(secret, json.dumps(report))
        return observed if report['status'] == 'complete' else None

    def test_schedule_recover_uses_parked_config_and_leaves_worker_stopped(self):
        worker = self.plist('worker')
        worker['EnvironmentVariables']['DATABASE_URL'] = 'postgres://tester@127.0.0.1:5434/allrice40_dev'
        with open(self.live_plist('worker'), 'wb') as f:
            plistlib.dump(worker, f)
        self.assertEqual(self.run_dd('park_plists', []).returncode, 0)
        rows = self.seed_recovery_partition()
        instance = self.write_qa_plists('recover-test')
        shutil.copyfile(os.path.join(instance, 'worker.plist'),
                        os.path.join(self.home, 'Library/LaunchAgents/ai.bplabs.allrice40-qa-recover-test-worker.plist'))
        for mode in ('dev', 'instance'):
            args = ('--dev', '--release-manager') if mode == 'dev' else ('--instance', 'recover-test')
            if mode == 'instance':
                import fcntl
                task_lock = os.path.join(self.home, 'allrice-qa/.task40-recover-test.lock')
                with open(task_lock, 'a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX)
                    refused = self.run_config_tool('schedule-recover', *args, '--execute',
                                                   ROWS=json.dumps(rows), PROOF=os.path.join(self.tmp, 'never-written'))
                    self.assertEqual(refused.returncode, 3, refused.stdout + refused.stderr)
                    self.assertTrue(os.path.exists(task_lock))
                    self.assertFalse(os.path.exists(os.path.join(self.tmp, 'never-written')))
            for failure in ('1', ''):
                with self.subTest(mode=mode, transaction_failure=failure):
                    proof = os.path.join(self.tmp, 'proof-' + mode)
                    p = self.run_config_tool('schedule-recover', *args, '--execute',
                                             ROWS=json.dumps(rows), PROOF=proof, SQL_FAIL=failure)
                    self.assertEqual(p.returncode, 1 if failure else 0, p.stdout + p.stderr)
                    self.assertNotIn('UNEXPECTED_START', p.stdout + p.stderr)
                    self.assertEqual(os.path.exists(proof), not failure)
                    if not failure:
                        self.assertIn('left stopped', p.stdout)
                    if mode == 'instance':
                        self.assertFalse(os.path.exists(task_lock))
                    for role in ('web', 'worker'):
                        self.assertFalse(os.path.exists(self.live_plist(role)))
                    self.assertEqual(self.read_plist(os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled/worker.plist')), worker)

    def test_parking_directory_failure_records_manual_intervention_and_preserves_plists(self):
        self.saved_release(self.release(files=FILES[:-1]))
        disabled = os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled')
        write(disabled, 'not a directory\n')
        p = self.run_dd('take_lock() { :; }; stop_job() { :; }; '
                        'start_job() { echo UNEXPECTED_START; return 90; }; recover',
                        FILES + ARCHIVED, CONTRACT='row:1')
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('Could not park all LaunchAgents plists', p.stdout)
        self.assertNotIn('login will not restart', p.stdout)
        self.assertNotIn('UNEXPECTED_START', p.stdout)
        for role in ('web', 'worker'):
            self.assertEqual(self.read_plist(self.live_plist(role)), self.plist(role))
        with open(os.path.join(self.home, 'allrice40-dev/qa/deploys.jsonl')) as f:
            record = json.loads(f.readline())
        self.assertEqual(record['phase'], 'restore-migrations')
        self.assertEqual(record['manualIntervention'], 'required')
        self.assertEqual(record['restored'], 'no')

    def test_rollback_after_parking_checks_gates_then_rewrites_and_cleans_up(self):
        current, target = self.release(sha='b' * 40), self.release(sha='c' * 40)
        self.saved_release(self.release(files=FILES[:-1]))
        p = self.run_dd('stage_plists "$CURRENT" "$SHA" "$ART" && activate_plists; '
                        'stop_job() { :; }; if restore; then exit 9; fi',
                        FILES + ARCHIVED, CONTRACT='row:1', CURRENT=current,
                        SHA='b' * 40, ART='sha256:' + 'b' * 64)
        self.assertEqual(p.returncode, 0, p.stderr)
        shutil.move(os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight'), os.path.join(self.tmp, 'failed-deploy'))
        log = os.path.join(self.home, 'allrice40-dev/qa/deploys.jsonl')
        with open(log, 'a') as f:
            f.write(json.dumps({'kind': 'deploy', 'toRelease': target, 'toSha': 'c' * 40,
                               'toArtifact': 'sha256:' + 'c' * 64}) + '\n')
        commands = ('take_lock() { :; }; precheck() { :; }; stop_job() { echo STOPPED:$2; }; '
                    'start_job() { [ -f "$2" ] && echo STARTED:$1; }; wait_ready() { :; }; rollback "$TARGET"')
        p = self.run_dd(commands, FILES + ARCHIVED + ['9999_unknown.sql'], CONTRACT='row:1', TARGET=target)
        self.assertNotEqual(p.returncode, 0)
        self.assertNotIn('STOPPED:', p.stdout)
        self.assertNotIn('STARTED:', p.stdout)
        for role in ('web', 'worker'):
            self.assertFalse(os.path.exists(self.live_plist(role)))
        p = self.run_dd(commands, FILES + ARCHIVED, CONTRACT='row:1', TARGET=target)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertLess(p.stdout.index('STARTED:ai.bplabs.allrice40-dev-worker'), p.stdout.index('STARTED:ai.bplabs.allrice40-dev-web'))
        for role in ('web', 'worker'):
            env = self.read_plist(self.live_plist(role))['EnvironmentVariables']
            self.assert_no_legacy_settings(env)
            self.assertEqual(env['ALLRICE_RELEASE_SHA'], 'c' * 40)
            self.assertEqual(env['ALLRICE_DSH_NATIVE_ARTIFACT_ID'], 'sha256:' + 'c' * 64)
        self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice40-dev/qa/deploy-disabled')))
        self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice40-dev/qa/deploy-inflight')))
        with open(log) as f:
            records = [json.loads(line) for line in f]
        self.assertEqual(records[-2]['phase'], 'rollback-migrations')
        self.assertEqual(records[-1]['kind'], 'rollback')

    def test_rollback_refuses_unknown_migrations_before_stop_and_rechecks_under_lock(self):
        old = self.release(files=FILES[:-1])
        log = os.path.join(self.home, 'allrice40-dev/qa/deploys.jsonl')
        for unreadable in (False, True):
            for applied, race in ((FILES + ARCHIVED, False), (FILES[:-1] + ARCHIVED, True)):
                with self.subTest(race=race, unreadable=unreadable):
                    write(log, json.dumps({'kind': 'deploy', 'toRelease': old, 'toSha': 'a' * 40,
                                           'toArtifact': 'sha256:' + 'a' * 64}) + '\n')
                    stubs = self.FLOW_STUBS
                    if race:
                        # precheck runs in command substitution: mutate the psql fixture, not its subshell environment.
                        change = 'rm "$APPLIED"' if unreadable else 'echo 0218_native_generation_binding.sql >> "$APPLIED"'
                        stubs += 'precheck() { echo PRECHECK; %s; }; ' % change
                    p = self.run_dd(stubs + 'rollback "$OLD"', applied, OLD=old, CONTRACT='row:1',
                                    **({'PSQL_FAIL': '1'} if unreadable and not race else {}))
                    self.assertNotEqual(p.returncode, 0)
                    self.assertIn('migration compatibility could not be checked' if unreadable else FILES[-1], p.stderr)
                    self.assertEqual('has applied migrations this version does not know' in p.stderr, not unreadable)
                    self.assertNotIn('STOPPED', p.stdout)
                    self.assertEqual('LOCKED' in p.stdout, race)
                    self.assert_recovery_guidance(p.stderr)
                    with open(log) as f:
                        records = [json.loads(line) for line in f]
                    self.assertEqual(len(records), 2)  # exactly one failure, even before inflight_begin
                    failure = records[-1]
                    self.assertEqual(failure['kind'], 'failed')
                    self.assertEqual(failure['phase'], 'rollback-migrations')
                    self.assertEqual(failure['toRelease'], old)
                    self.assertEqual(failure['toSha'], 'a' * 40)
                    self.assertEqual(failure['manualIntervention'], 'required')
                    self.assertIn(failure['reason'], p.stderr)

    def test_failed_snapshot_stops_the_deploy(self):
        p = self.snapshot(FILES[:-1] + ARCHIVED, PG_DUMP_FAIL='1')
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('FAILED: pre-migration snapshot failed', p.stderr)
        self.assertEqual(os.listdir(self.snapshots), [])

    def test_unready_worker_does_not_stop_the_deploy(self):
        # Nothing listens on the plist's Worker port: no boot id, and set -e must not abort.
        p = self.run_dd('boot=$(worker_boot); echo "boot=[$boot]"', [])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('boot=[]', p.stdout)

    def test_after_stop_report_never_fails(self):
        p = self.run_dd('report_after_stop 11111111-2222-3333-4444-555555555555; echo "rc=$?"', [], PSQL_FAIL='1')
        self.assertIn('after stop (diagnostic, not a gate)', p.stdout)
        self.assertIn('rc=0', p.stdout)


class DatabaseRestoreRunbook(unittest.TestCase):
    def convert(self, original):
        with open(os.path.join(HERE, '../../docs/runbooks/m1-database.md')) as f:
            runbook = f.read()
        script = textwrap.dedent(runbook.split("<<'PY'\n", 1)[1].split('   PY\n', 1)[0])
        with tempfile.TemporaryDirectory(prefix='restore-dump-test-') as tmp:
            source, target = os.path.join(tmp, 'original.sql'), os.path.join(tmp, 'public.sql')
            with open(source, 'wb') as f:
                f.write(original)
            p = subprocess.run([sys.executable, '-', source, target], input=script,
                               capture_output=True, text=True, timeout=10)
            with open(source, 'rb') as f:
                self.assertEqual(f.read(), original)
            if os.path.exists(target):
                with open(target, 'rb') as f:
                    return p, f.read()
            return p, None

    STATEMENT = b"SELECT pg_catalog.set_config('search_path', '', false);\n"
    BODY = (b"CREATE FUNCTION public.example() RETURNS void LANGUAGE sql AS $$\n" + STATEMENT + b"$$;\n"
            b"COPY public.messages (body) FROM stdin;\n" + STATEMENT +
            b'{"text":"set_config(\'search_path\', \'\', false)"}\n\\.\n')

    def test_changes_only_the_complete_header_statement_and_preserves_body_bytes(self):
        for newline in (b'\n', b'\r\n'):
            with self.subTest(newline=newline):
                preamble = b"-- PostgreSQL database dump\n\n\\restrict Abc123\nSET statement_timeout = 0;\n"
                settings = b"SET check_function_bodies = false;\n\n-- Name: example; Type: FUNCTION\n"
                original = preamble + self.STATEMENT + settings + self.BODY
                expected = preamble + b"SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);\n" + settings + self.BODY
                p, converted = self.convert(original.replace(b'\n', newline))
                self.assertEqual(p.returncode, 0, p.stderr)
                self.assertEqual(converted, expected.replace(b'\n', newline))

    def test_refuses_missing_or_repeated_header_statement_without_writing(self):
        for original in (self.BODY, self.STATEMENT * 2 + self.BODY,
                         b'COPY public.messages (body) FROM stdin;\n' + self.STATEMENT + b'\\.\n'):
            with self.subTest(original=original):
                p, converted = self.convert(original)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn('Expected exactly one search_path statement in dump header', p.stderr)
                self.assertIsNone(converted)


if __name__ == '__main__':
    unittest.main()
