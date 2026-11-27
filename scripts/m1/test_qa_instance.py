# Exercise the production cmd_up in a private HOME. Only external commands and
# port availability are stubbed; no PostgreSQL, launchd, network or live QA state.
# CI collects this with python3 -m unittest discover -s scripts/m1 -p 'test_*.py'.
import fcntl
import json
import os
import plistlib
import shutil
import subprocess
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE_SHA = 'a' * 40
ARTIFACT_ID = 'sha256:' + 'b' * 64

SYSTEM_STUB = '''
import fcntl, os, socket

def local_port(address, *args, **kwargs):
    if str(address[1]) == os.environ.get('QA_TEST_PORT_OPEN'):
        return socket.socket()
    if str(address[1]) == os.environ.get('QA_TEST_PORT_UNKNOWN'):
        raise TimeoutError('fixture could not read the port')
    raise ConnectionRefusedError

socket.create_connection = local_port
attempts = os.environ.get('QA_TEST_LOCK_ATTEMPTS')
if attempts:
    flock = fcntl.flock

    def record_blocked_allocator(fd, operation):
        try:
            flock(fd, operation)
        except BlockingIOError:
            with open(os.path.expanduser('~/allrice-qa/.alloc.lock')) as allocator:
                if os.path.sameopenfile(fd, allocator.fileno()):
                    with open(attempts, 'a') as log:
                        log.write(os.environ['QA_TEST_TASK'] + '\\n')
            raise

    fcntl.flock = record_blocked_allocator
'''

COMMAND_STUB = '''#!/usr/bin/python3
import json, os, plistlib, re, sys, shutil, fcntl
from pathlib import Path
command, args = Path(sys.argv[0]).name, sys.argv[1:]
sql_input = sys.stdin.read() if command == 'psql' and '-c' not in args and '-Atc' not in args else ''
with open(os.environ['QA_TEST_EVENTS'], 'a') as f:
    f.write(json.dumps({'command': command, 'args': args, 'cwd': os.getcwd(), 'stdin': sql_input}) + '\\n')
databases, jobs = Path.home() / 'qa-databases', Path.home() / 'qa-jobs'
if command == 'git':
    if 'rev-parse' in args:
        print('a' * 40)
    elif 'worktree' in args and 'add' in args:
        if os.environ.get('QA_TEST_GIT_ADD_FAIL'):
            sys.exit(44)
        release = Path(args[-2])
        (release / 'scripts/m1').mkdir(parents=True)
        if not os.environ.get('QA_TEST_MISSING_BOOTSTRAP'):
            (release / 'scripts/m1/qa-bootstrap.mjs').write_text('// ref bootstrap')
    elif 'worktree' in args and 'remove' in args:
        if os.environ.get('QA_TEST_GIT_REMOVE_FAIL'):
            sys.exit(45)
        shutil.rmtree(args[-1])
elif command == 'node':
    if args[0].endswith('/prepare-native-artifact.mjs'):
        print(json.dumps({'artifactId': 'sha256:' + 'b' * 64}))
    elif args[0].endswith('/prepare-identity.mjs'):
        if os.environ.get('QA_TEST_IDENTITY_FAIL'):
            sys.exit(42)
        release = Path(args[1].split('=', 1)[1]); sha = args[2].split('=', 1)[1]
        for entry in ('apps/web/server.mjs', 'apps/worker/dist/index.js'):
            path = release / entry
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        identity = release / '.local/dev-build-identity.json'
        identity.parent.mkdir(exist_ok=True)
        identity.write_text(json.dumps(dict(repository='semiok/allrice-vm', repositoryId=1469490636,
            environment='dev', sourceSha=sha, sourceTree='d'*40, manifestDigest='sha256:'+'e'*64)))
    elif args[0].endswith('/qa-bootstrap.mjs'):
        if Path(args[0]).read_text() != '// ref bootstrap':
            sys.exit(43)
elif command == 'launchctl':
    verb, target = args[0], args[-1]
    if verb == 'bootstrap':
        path = Path(target)
        if os.environ.get('QA_TEST_BOOTSTRAP_FAIL') and path.stem.endswith(os.environ['QA_TEST_BOOTSTRAP_FAIL']):
            sys.exit(46)
        plist = plistlib.loads(path.read_bytes())
        job = jobs / plist['Label']
        with job.open('x') as file:
            json.dump(dict(path=str(path), cwd=plist['WorkingDirectory']), file)
    else:
        job = jobs / target.rsplit('/', 1)[-1]
        if verb == 'print':
            if os.environ.get('QA_TEST_LAUNCHCTL_UNKNOWN') and job.name.endswith(os.environ['QA_TEST_LAUNCHCTL_UNKNOWN']):
                sys.exit(47)
            elif job.is_file():
                data = json.loads(job.read_text())
                print('path = %s\\nworking directory = %s\\nstate = waiting' % (data['path'], data['cwd']))
            elif any(name in target for name in os.environ.get('QA_TEST_LIVE', '').split(',') if name):
                print('state = running\\npid = 12345')
            else:
                sys.exit(113)
        elif verb == 'bootout':
            job.unlink(missing_ok=True)
        elif verb == 'kickstart':
            assert job.is_file()
elif command == 'lsof':
    print('p999999\\nfcwd\\nn/private/tmp/unrelated')
elif command == 'ps':
    print('999999 1 node /tmp/unrelated.mjs')
elif command == 'psql':
    query = args[-1]
    lookup = re.search(r"datname='([a-z0-9_]+)'", query)
    create = re.fullmatch(r'CREATE DATABASE "([a-z0-9_]+)" OID ([0-9]+)', query)
    if create:
        path = databases / create[1]
        with path.open('x') as f:
            f.write('1:' if os.environ.get('QA_TEST_SWAP_AFTER_CREATE') else create[2] + ':')
        if os.environ.get('QA_TEST_CREATE_UNKNOWN'):
            sys.exit(49)
    elif lookup:
        if os.environ.get('QA_TEST_DB_UNKNOWN'):
            sys.exit(48)
        path = databases / lookup[1]
        if path.is_file():
            print(path.read_text() if 'oid::text' in query else 1)
    elif sql_input:
        expected = re.search(r" = '([0-9]+:allrice40-qa:[a-f0-9]+)'", sql_input)[1]
        comment = re.search(r'COMMENT ON DATABASE "([a-z0-9_]+)" IS (.+);', sql_input)
        if comment:
            path = databases / comment[1]
            stamp = path.read_text().partition(':')[0] + ':' + comment[2].strip("'")
            if stamp == expected:
                path.write_text(stamp)
                print('confirmed')
        else:
            rename = re.search(r'ALTER DATABASE "([a-z0-9_]+)" RENAME TO "([a-z0-9_]+)"', sql_input)
            path, parked = databases / rename[1], databases / rename[2]
            if os.environ.get('QA_TEST_SWAP_BEFORE_RETIRE'):
                path.write_text('1:' + expected.partition(':')[2])
            if path.read_text() == expected and not parked.exists():
                path.rename(parked)
                print('confirmed')
elif command == 'createdb':
    path = databases / args[-1]
    with path.open('x') as f:
        f.write('49000:')
    if os.environ.get('QA_TEST_CREATE_UNKNOWN'):
        sys.exit(49)
elif command == 'dropdb':
    if os.environ.get('QA_TEST_DROP_FAIL'):
        sys.exit(51)
    (databases / args[-1]).unlink()
elif command == 'pnpm' and args == ['db:prepare'] and os.environ.get('QA_TEST_DB_PREP_FAIL'):
    sys.exit(50)
elif command == 'sleep' and os.environ.get('QA_TEST_RELEASE'):
    # The waiting process must release the allocator so an owner can down.
    with open(Path.home() / 'allrice-qa/.alloc.lock', 'rb') as f:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        shutil.rmtree(Path.home() / 'allrice-qa' / os.environ['QA_TEST_RELEASE'])
elif command not in ('pnpm', 'psql', 'dropdb', 'createdb', 'launchctl', 'curl'):
    sys.exit(99)
'''

# Relevant 3.x behavior from 4c2e1069. This independent fixture freezes the task
# grammar, paths and allocator contract while skipping builds and lease expiry.
LEGACY_QA = '''
import fcntl, json, os, plistlib, re, shutil, subprocess, sys, time
from pathlib import Path

op, task = sys.argv[1:]
if not re.fullmatch('[a-z0-9][a-z0-9-]{0,30}', task):
    sys.exit('task name must match [a-z0-9-], max 31 chars')
home = Path.home()
qa = home / 'allrice-qa'
qa.mkdir(exist_ok=True)
directory = qa / task
task_lock = qa / ('.task-' + task + '.lock')
db = 'allrice_qa_' + task.replace('-', '_')
agents = home / 'Library/LaunchAgents'
bin_dir = home / '.local/opt/node-22.23.2/bin'

def allocate():
    records = [json.loads(p.read_text()) for p in qa.glob('*/instance.json') if not p.parent.name.startswith('.')]
    if len(records) >= 3:
        print('all 3 slots occupied', file=sys.stderr)
        sys.exit(75)
    claimed = {port for data in records for port in (data['webPort'], data['webPort'] + 1)}
    web = next(port for port in range(3200, 3300, 2) if not claimed.intersection((port, port + 1)))
    directory.mkdir()
    (directory / 'instance.json').write_text(json.dumps(dict(
        task=task, webPort=web, workerPort=web+1, database=db, owner='legacy', card='MET-260')))

def lock_allocator(allocator):
    for _ in range(300):
        try:
            fcntl.flock(allocator.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            time.sleep(.05)
    sys.exit('legacy allocation lock timed out')

with (qa / '.alloc.lock').open('a') as allocator:
    lock_allocator(allocator)
    with task_lock.open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            if op == 'up':
                allocate()
            fcntl.flock(allocator.fileno(), fcntl.LOCK_UN)
            if op == 'up':
                (directory / 'release').mkdir()
                subprocess.run([bin_dir / 'createdb', '-h', '127.0.0.1', db], check=True)
            for role in ('web', 'worker'):
                label = 'ai.bplabs.allrice-qa-' + task + '-' + role
                plist = agents / (label + '.plist')
                if op == 'up':
                    plist.write_bytes(plistlib.dumps(dict(Label=label, WorkingDirectory=str(directory / 'release'))))
                    subprocess.run([bin_dir / 'launchctl', 'bootstrap', 'gui/%d' % os.getuid(), plist], check=True)
                else:
                    subprocess.run([bin_dir / 'launchctl', 'bootout', 'gui/%d/%s' % (os.getuid(), label)], check=True)
                    plist.unlink(missing_ok=True)
            if op == 'down':
                exists = subprocess.check_output([bin_dir / 'psql', '-h', '127.0.0.1', '-d', 'postgres',
                                                  '-Atc', "select 1 from pg_database where datname='%s'" % db], text=True)
                if '1' in exists:
                    subprocess.run([bin_dir / 'dropdb', '-h', '127.0.0.1', '--force', db], check=True)
                if directory.is_dir():
                    shutil.rmtree(directory)
        finally:
            lock_allocator(allocator)
            task_lock.unlink()
'''


class QaInstanceBuildIdentity(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix='qa-instance-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, 'home')
        self.instance = Path(self.home, 'allrice-qa/_allrice40-met-218-test')
        self.worktrees = Path(self.home, 'allrice40-worktrees')
        self.db_dir = Path(self.home, 'qa-databases')
        self.jobs = Path(self.home, 'qa-jobs')
        self.events = os.path.join(self.tmp, 'events.jsonl')
        Path(self.tmp, 'sitecustomize.py').write_text(SYSTEM_STUB)
        self.legacy_script = Path(self.tmp, 'legacy-qa-instance.py')
        self.legacy_script.write_text(LEGACY_QA)
        node_bin = os.path.join(self.home, '.local/opt/node-22.23.2/bin')
        os.makedirs(node_bin)
        self.db_dir.mkdir()
        self.jobs.mkdir()
        for name in ('git', 'pnpm', 'node', 'psql', 'dropdb', 'createdb', 'launchctl', 'curl', 'lsof', 'ps', 'sleep'):
            path = os.path.join(node_bin, name)
            with open(path, 'w') as f:
                f.write(COMMAND_STUB)
            os.chmod(path, 0o755)
        # Keep the actual dispatch, locks, writes and plist generation. The
        # socket probe and launchctl are confined to host stubs.
        with open(os.path.join(HERE, 'qa-instance')) as f:
            definitions, marker, dispatch = f.read().partition('\ncase "${1:-}" in')
        self.assertTrue(marker, 'qa-instance command dispatch marker changed')
        host_stubs = '\nM1_LAUNCHCTL="$NODE_BIN/launchctl"\n'
        shutil.copyfile(os.path.join(HERE, 'lib.sh'), os.path.join(self.tmp, 'lib.sh'))
        shutil.copyfile(os.path.join(HERE, 'service_target.py'), os.path.join(self.tmp, 'service_target.py'))
        shutil.copyfile(os.path.join(HERE, 'qa-lease.py'), os.path.join(self.tmp, 'qa-lease.py'))
        Path(self.tmp, 'qa-bootstrap.mjs').write_text('// installed bootstrap')
        self.dispatch_script = os.path.join(self.tmp, 'qa-instance-cli')
        Path(self.dispatch_script).write_text(definitions + host_stubs + marker + dispatch)
        dev = os.path.join(self.home, 'allrice40-dev')
        os.makedirs(dev)
        with open(os.path.join(dev, '.env'), 'w') as f:
            f.write('DATABASE_URL=postgres://stub/allrice_dev\nUNRELATED_SETTING=keep\n'
                    'ALLRICE_WORKER_PORT=3012\nALLRICE_WORKER_INTERNAL_URL=http://127.0.0.1:3012\n')
        release = Path(self.home, 'allrice40-dev-releases', 'sealed')
        for entry in ('apps/web/server.mjs', 'apps/worker/dist/index.js'):
            path = release / entry
            path.parent.mkdir(parents=True)
            path.touch()
        identity = release / '.local/dev-build-identity.json'
        identity.parent.mkdir()
        identity.write_text(json.dumps(dict(repository='semiok/allrice-vm', repositoryId=1469490636,
            environment='dev', sourceSha=SOURCE_SHA, sourceTree='d'*40, manifestDigest='sha256:'+'e'*64)))
        self.agents = Path(self.home, 'Library/LaunchAgents')
        self.agents.mkdir(parents=True)
        for role in ('web', 'worker'):
            entry = 'apps/web/server.mjs' if role == 'web' else 'apps/worker/dist/index.js'
            with (self.agents / ('ai.bplabs.allrice40-dev-' + role + '.plist')).open('wb') as f:
                plistlib.dump({
                    'Label': 'ai.bplabs.allrice40-dev-' + role,
                    'ProgramArguments': [os.path.join(node_bin, 'node'),
                                         '--env-file=' + os.path.join(dev, '.env'),
                                         str(release / entry)],
                    'WorkingDirectory': str(release / 'apps/web' if role == 'web' else release),
                    'EnvironmentVariables': {
                        'DATABASE_URL': 'postgres://tester@127.0.0.1:5434/allrice40_dev',
                        'ALLRICE_WEB_PORT': '3311', 'ALLRICE_WORKER_PORT': '3312',
                        'ALLRICE_WORKER_INTERNAL_URL': 'http://127.0.0.1:3312',
                        'ALLRICE_RELEASE_SHA': SOURCE_SHA,
                        'ALLRICE_STORAGE_ROOT': dev + '/.local/storage',
                        'ALLRICE_EXECUTION_ROOT': dev + '/.local/executions',
                        'ALLRICE_DSH_RUNTIME_ROOT': dev + '/.local/dsh-runtime-m1',
                        'ALLRICE_DSH_PLATFORM_HOME': dev + '/.local/dsh-platform',
                        'ALLRICE_DEV_MAINTENANCE_ENABLED': '1',
                        'ALLRICE_CLOUD_RUNNER_ENABLED': '1',
                        'ALLRICE_CLOUD_MCP_ENABLED': '1',
                        'UNRELATED_SETTING': 'keep',
                    },
                }, f)

    def up(self, identity_fail=False, **extra):
        # A caller's SHA cannot replace resolve_ref's Git result.
        result = self.cli('up', 'met-218-test', '--owner', 'test-line', '--card', 'MET-218', '--ref', SOURCE_SHA,
                          ALLRICE_RELEASE_SHA='c' * 40, QA_TEST_IDENTITY_FAIL='1' if identity_fail else '', **extra)
        with open(self.events) as f:
            return result, [json.loads(line) for line in f]

    def test_identity_is_prepared_after_build_and_native_artifact_before_database_or_start(self):
        result, events = self.up()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        build = next(i for i, e in enumerate(events) if e['command'] == 'pnpm' and 'build' in e['args'])
        native = next(i for i, e in enumerate(events) if e['command'] == 'node' and 'prepare-native-artifact.mjs' in e['args'][0])
        identity = next(i for i, e in enumerate(events) if e['command'] == 'node' and 'prepare-identity.mjs' in e['args'][0])
        database = next(i for i, e in enumerate(events) if e['command'] == 'psql' and e['args'][-1].startswith('CREATE DATABASE'))
        start = next(i for i, e in enumerate(events) if e['command'] == 'launchctl' and e['args'][0] == 'bootstrap')
        self.assertLess(build, native)
        self.assertLess(native, identity)
        self.assertLess(identity, database)
        self.assertLess(database, start)
        data = json.loads((self.instance / 'instance.json').read_text())
        release = str(self.worktrees / data['worktree']['name'])
        self.assertEqual(events[identity]['cwd'], release)
        self.assertEqual(events[identity]['args'], [
            'scripts/dev-release/prepare-identity.mjs', '--root=' + release,
            '--release-sha=' + SOURCE_SHA,
        ])
        envs = {}
        for role in ('web', 'worker'):
            with (self.instance / (role + '.plist')).open('rb') as f:
                plist = plistlib.load(f)
            self.assertEqual(plist['Label'], 'ai.bplabs.allrice40-qa-met-218-test-' + role)
            env = plist['EnvironmentVariables']
            envs[role] = env
            self.assertEqual(env['ALLRICE_DEV_MAINTENANCE_ENABLED'], '0')
            self.assertEqual(env['ALLRICE_CLOUD_RUNNER_ENABLED'], '0')
            self.assertEqual(env['ALLRICE_CLOUD_MCP_ENABLED'], '0')
            self.assertEqual(env['ALLRICE_RELEASE_SHA'], SOURCE_SHA)
            self.assertEqual(env['ALLRICE_DSH_NATIVE_ARTIFACT_ID'], ARTIFACT_ID)
            self.assertEqual(env['UNRELATED_SETTING'], 'keep')
        self.assertEqual(data['setup'], 'ready')
        self.assertEqual(data['owner'], 'test-line')
        self.assertEqual(data['card'], 'MET-218')
        self.assertIn('repositoryExpiresAt', data)
        self.assertNotIn('expiresAt', data, 'old allocator must treat the new instance as legacy')
        self.assertEqual(data['repository'], 'semiok/allrice-vm')
        self.assertEqual(data['repositoryId'], 1469490636)
        self.assertEqual(data['database'], 'allrice40_qa_met_218_test')
        self.assertEqual((self.db_dir / data['database']).read_text(), data['databaseClaim'])
        worker = str(data['workerPort'])
        self.assertEqual(envs['web']['ALLRICE_WORKER_PORT'], worker)
        self.assertEqual(envs['worker']['ALLRICE_WORKER_PORT'], worker)
        self.assertEqual(envs['web']['ALLRICE_WORKER_INTERNAL_URL'], f'http://127.0.0.1:{worker}')
        dotenv = (self.instance / '.env').read_text()
        self.assertIn(f'ALLRICE_WORKER_INTERNAL_URL=http://127.0.0.1:{worker}\n', dotenv)
        self.assertNotIn('ALLRICE_WORKER_INTERNAL_URL=http://127.0.0.1:3012', dotenv)
        bootstrap = next(e for e in events if e['command'] == 'node' and e['args'][0].endswith('/qa-bootstrap.mjs'))
        self.assertEqual(bootstrap['args'][0], release + '/scripts/m1/qa-bootstrap.mjs')
        self.assertEqual(bootstrap['args'][bootstrap['args'].index('--env') + 1], str(self.instance / '.env'))

    def test_identity_failure_stops_before_database_creation_or_services(self):
        result, events = self.up(identity_fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('build identity preparation failed', result.stderr)
        self.assertEqual(events[-1]['command'], 'node')
        self.assertEqual(events[-1]['args'][0], 'scripts/dev-release/prepare-identity.mjs')
        self.assertFalse(any(e['command'] in ('psql', 'createdb', 'launchctl', 'curl') for e in events))
        self.assertFalse(any(e['command'] == 'pnpm' and 'db:prepare' in e['args'] for e in events))
        with (self.instance / 'instance.json').open() as f:
            self.assertEqual(json.load(f)['setup'], 'building')
        self.assertFalse((self.instance / 'worker.plist').exists())

    def test_down_only_removes_the_reserved_worktree_after_failed_add(self):
        foreign = self.worktrees / '.qa-met-218-test'
        foreign.mkdir(parents=True)
        (foreign / 'keep').write_text('unrelated worktree')
        link = self.worktrees / '.qa-met-218-test.Existing'
        link.symlink_to(foreign)
        result = self.cli('up', 'met-218-test', '--owner', 'test-line', '--card', 'MET-218', QA_TEST_GIT_ADD_FAIL='1')
        self.assertEqual(result.returncode, 44, result.stdout + result.stderr)
        data = json.loads((self.instance / 'instance.json').read_text())
        reserved = self.worktrees / data['worktree']['name']
        self.assertTrue(reserved.is_dir())
        result = self.cli('down', 'met-218-test', QA_TEST_GIT_REMOVE_FAIL='1')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.instance.exists())
        self.assertFalse(reserved.exists())
        self.assertTrue(link.is_symlink())
        self.assertEqual((foreign / 'keep').read_text(), 'unrelated worktree')

    def test_down_refuses_a_replaced_worktree_before_mutations(self):
        result, _ = self.up()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        data = json.loads((self.instance / 'instance.json').read_text())
        reserved = self.worktrees / data['worktree']['name']
        original = reserved.rename(self.worktrees / 'original')
        for symlink in (True, False):
            with self.subTest(symlink=symlink):
                if symlink:
                    reserved.symlink_to(original)
                else:
                    reserved.mkdir()
                before = Path(self.events).read_bytes()
                result = self.cli('down', 'met-218-test')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('cannot verify the reserved worktree', result.stderr)
                self.assertEqual(Path(self.events).read_bytes(), before)
                self.assertTrue(self.instance.is_dir())
                self.assertTrue(reserved.is_dir())
                if symlink:
                    reserved.unlink()
                else:
                    reserved.rmdir()

    def test_instance_commands_refuse_a_preexisting_symlink(self):
        foreign = Path(self.home, 'foreign')
        foreign.mkdir()
        self.instance.parent.mkdir()
        self.instance.symlink_to(foreign)
        metadata = foreign / 'instance.json'
        original = '{"repository":"semiok/allrice-vm","repositoryId":1469490636,"task":"met-218-test"}'
        metadata.write_text(original)
        for args in (('up', 'met-218-test', '--owner', 'test-line', '--card', 'MET-218'), ('down', 'met-218-test')):
            result = self.cli(*args)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(metadata.read_text(), original)
            self.assertTrue(self.instance.is_symlink())
            self.assertFalse(Path(self.events).exists())

    def cli(self, *args, **extra):
        return self.run_cli(['/bin/bash', self.dispatch_script, *args], **extra)

    def legacy_cli(self, *args, **extra):
        return self.run_cli(['/usr/bin/python3', self.legacy_script, *args], **extra)

    def run_cli(self, args, **extra):
        env = dict(os.environ, HOME=self.home, USER='tester', QA_TEST_EVENTS=self.events, PYTHONPATH=self.tmp, **extra)
        return subprocess.run(args, env=env, capture_output=True, text=True, timeout=35)

    def assert_no_cleanup_since(self, offset):
        for line in Path(self.events).read_text()[offset:].splitlines():
            event = json.loads(line)
            self.assertNotEqual(event['command'], 'dropdb')
            self.assertNotEqual((event['command'], event['args'][0]), ('launchctl', 'bootout'))
            self.assertFalse(event['command'] == 'git' and 'remove' in event['args'])

    def test_existing_database_survives_refused_up_and_down(self):
        db = self.db_dir / 'allrice40_qa_met_218_test'
        db.write_text('49001:existing database')
        up, events = self.up()
        self.assertNotEqual(up.returncode, 0)
        self.assertIn('already exists', up.stderr)
        self.assertFalse(any(event['args'][-1].startswith('CREATE DATABASE') for event in events))
        self.assertIsNone(json.loads((self.instance / 'instance.json').read_text())['databaseClaim'])
        down = self.cli('down', 'met-218-test')
        self.assertEqual(down.returncode, 0, down.stdout + down.stderr)
        self.assertEqual(db.read_text(), '49001:existing database')
        self.assertFalse(self.instance.exists())

    def test_uncertain_create_keeps_database_and_slot_until_absence_is_confirmed(self):
        up, _ = self.up(QA_TEST_CREATE_UNKNOWN='1')
        self.assertNotEqual(up.returncode, 0)
        self.assertIn('database creation failed', up.stderr)
        checkpoint = self.instance / 'instance.json'
        data = json.loads(checkpoint.read_text())
        self.assertEqual(data['databaseClaim'], 'pending')
        db = self.db_dir / data['database']
        actual = db.read_text()
        before = len(Path(self.events).read_text())
        down = self.cli('down', 'met-218-test')
        self.assertNotEqual(down.returncode, 0)
        self.assertIn('cannot verify ownership of database', down.stderr)
        self.assert_no_cleanup_since(before)
        self.assertRegex(actual, r'^[1-9][0-9]*:$')
        self.assertEqual(db.read_text(), actual)
        self.assertTrue(checkpoint.is_file())
        db.unlink()
        retry = self.cli('down', 'met-218-test')
        self.assertEqual(retry.returncode, 0, retry.stdout + retry.stderr)
        self.assertFalse(self.instance.exists())

    def test_down_drops_confirmed_database_after_setup_failed_and_rejects_replacement(self):
        up, _ = self.up(QA_TEST_DB_PREP_FAIL='1')
        self.assertNotEqual(up.returncode, 0)
        self.assertIn('db:prepare failed', up.stderr)
        checkpoint = self.instance / 'instance.json'
        data = json.loads(checkpoint.read_text())
        claim = data['databaseClaim']
        db = self.db_dir / data['database']
        self.assertEqual(db.read_text(), claim)
        for actual, extra in (('1:' + claim.split(':', 1)[1], {}), (claim.partition(':')[0] + ':other generation', {}),
                              (claim, {'QA_TEST_DB_UNKNOWN': '1'})):
            with self.subTest(actual=actual, extra=extra):
                db.write_text(actual)
                before = len(Path(self.events).read_text())
                down = self.cli('down', 'met-218-test', **extra)
                self.assertNotEqual(down.returncode, 0)
                self.assertIn('cannot verify ownership of database', down.stderr)
                self.assert_no_cleanup_since(before)
                self.assertEqual(db.read_text(), actual)
                self.assertTrue(checkpoint.is_file())
        db.write_text(claim)
        down = self.cli('down', 'met-218-test')
        self.assertEqual(down.returncode, 0, down.stdout + down.stderr)
        self.assertFalse(db.exists())
        self.assertFalse(self.instance.exists())

    def test_create_does_not_mark_a_database_replaced_before_ownership_is_confirmed(self):
        up, _ = self.up(QA_TEST_SWAP_AFTER_CREATE='1')
        self.assertNotEqual(up.returncode, 0)
        self.assertIn('cannot confirm and mark the created database', up.stderr)
        data = json.loads((self.instance / 'instance.json').read_text())
        db = self.db_dir / data['database']
        self.assertEqual(db.read_text(), '1:')
        down = self.cli('down', 'met-218-test')
        self.assertNotEqual(down.returncode, 0)
        self.assertEqual(db.read_text(), '1:')
        self.assertTrue(self.instance.is_dir())

    def test_guarded_retirement_preserves_database_replaced_after_down_preflight(self):
        up, _ = self.up(QA_TEST_DB_PREP_FAIL='1')
        self.assertIn('db:prepare failed', up.stderr)
        data = json.loads((self.instance / 'instance.json').read_text())
        db = self.db_dir / data['database']
        before = len(Path(self.events).read_text())
        down = self.cli('down', 'met-218-test', QA_TEST_SWAP_BEFORE_RETIRE='1')
        self.assertIn('cannot retire owned database', down.stderr)
        self.assertNotEqual(down.returncode, 0)
        self.assertEqual(db.read_text(), '1:' + data['databaseClaim'].partition(':')[2])
        self.assertEqual(list(self.db_dir.iterdir()), [db])
        self.assert_no_cleanup_since(before)
        self.assertTrue(self.instance.is_dir())

    def test_retry_drops_only_retired_database_when_active_name_has_been_reused(self):
        up, _ = self.up(QA_TEST_DB_PREP_FAIL='1')
        self.assertIn('db:prepare failed', up.stderr)
        data = json.loads((self.instance / 'instance.json').read_text())
        db = self.db_dir / data['database']
        retired = self.db_dir / ('allrice40_qa_retired_' + data['databaseClaim'].split(':')[-1])
        down = self.cli('down', 'met-218-test', QA_TEST_DROP_FAIL='1')
        self.assertIn('cannot drop retired database', down.stderr)
        self.assertNotEqual(down.returncode, 0)
        self.assertFalse(db.exists())
        self.assertEqual(retired.read_text(), data['databaseClaim'])
        db.write_text('1:replacement')
        retry = self.cli('down', 'met-218-test')
        self.assertEqual(retry.returncode, 0, retry.stdout + retry.stderr)
        self.assertEqual(db.read_text(), '1:replacement')
        self.assertFalse(retired.exists() or self.instance.exists())

    def test_preexisting_launchagent_survives_failed_up_and_down(self):
        label = 'ai.bplabs.allrice40-qa-met-218-test-worker'
        plist, job = self.agents / (label + '.plist'), self.jobs / label
        for path, original, message in (
            (plist, 'pre-existing plist', 'LaunchAgent plist already exists'),
            (job, json.dumps(dict(path='/other.plist', cwd='/other')), 'already loaded'),
        ):
            with self.subTest(path=path):
                path.write_text(original)
                before = path.stat().st_ino
                up, events = self.up()
                self.assertIn(message, up.stderr)
                self.assertNotEqual(up.returncode, 0)
                self.assertFalse(any(e['args'][-1].startswith('CREATE DATABASE') for e in events))
                down = self.cli('down', 'met-218-test')
                self.assertEqual(down.returncode, 0, down.stdout + down.stderr)
                self.assertEqual((path.stat().st_ino, path.read_text()), (before, original))
                path.unlink()

    def test_down_preflights_both_owned_roles_before_stopping_either(self):
        up, _ = self.up()
        self.assertEqual(up.returncode, 0, up.stdout + up.stderr)
        label = 'ai.bplabs.allrice40-qa-met-218-test-worker'
        worker_plist, worker_job = self.agents / (label + '.plist'), self.jobs / label
        original_plist, original_job = worker_plist.read_bytes(), worker_job.read_text()
        for mutation in ('different inode', 'loaded job from another worktree', 'unknown job state'):
            with self.subTest(mutation=mutation):
                extra = {}
                if mutation == 'different inode':
                    worker_plist.unlink()
                    worker_plist.write_bytes(original_plist)
                elif mutation == 'loaded job from another worktree':
                    unexpected = dict(json.loads(original_job), cwd='/elsewhere')
                    worker_job.write_text(json.dumps(unexpected))
                else:
                    extra['QA_TEST_LAUNCHCTL_UNKNOWN'] = '-worker'
                before = len(Path(self.events).read_text())
                down = self.cli('down', 'met-218-test', **extra)
                self.assertNotEqual(down.returncode, 0)
                self.assertIn('cannot verify LaunchAgent ownership', down.stderr)
                self.assert_no_cleanup_since(before)
                self.assertTrue(worker_plist.is_file() and worker_job.is_file())
                if mutation == 'different inode':
                    worker_plist.unlink()
                    os.link(self.instance / 'worker.plist', worker_plist)
                elif mutation == 'loaded job from another worktree':
                    worker_job.write_text(original_job)
        down = self.cli('down', 'met-218-test')
        self.assertEqual(down.returncode, 0, down.stdout + down.stderr)
        self.assertFalse(worker_plist.exists() or worker_job.exists())

    def test_down_after_partial_bootstrap_stops_only_the_loaded_role(self):
        up, _ = self.up(QA_TEST_BOOTSTRAP_FAIL='-web')
        self.assertEqual(up.returncode, 46, up.stdout + up.stderr)
        self.assertEqual([job.name for job in self.jobs.iterdir()], ['ai.bplabs.allrice40-qa-met-218-test-worker'])
        before = len(Path(self.events).read_text())
        down = self.cli('down', 'met-218-test')
        self.assertEqual(down.returncode, 0, down.stdout + down.stderr)
        events = [json.loads(line) for line in Path(self.events).read_text()[before:].splitlines()]
        self.assertEqual([e['args'][-1].rsplit('/', 1)[-1] for e in events
                          if e['command'] == 'launchctl' and e['args'][0] == 'bootout'],
                         ['ai.bplabs.allrice40-qa-met-218-test-worker'])
        self.assertFalse(list(self.agents.glob('ai.bplabs.allrice40-qa-*.plist')))
        self.assertFalse(list(self.db_dir.iterdir()))

    def test_down_requires_closed_original_port_when_published_plist_and_job_are_gone(self):
        up, _ = self.up()
        self.assertEqual(up.returncode, 0, up.stdout + up.stderr)
        label = 'ai.bplabs.allrice40-qa-met-218-test-worker'
        (self.agents / (label + '.plist')).unlink()
        (self.jobs / label).unlink()
        metadata = (self.instance / 'instance.json').read_bytes()
        data = json.loads(metadata)
        db = self.db_dir / data['database']
        for mock_port in ('QA_TEST_PORT_OPEN', 'QA_TEST_PORT_UNKNOWN'):
            with self.subTest(mock_port=mock_port):
                before = len(Path(self.events).read_text())
                down = self.cli('down', 'met-218-test', **{mock_port: str(data['workerPort'])})
                self.assertNotEqual(down.returncode, 0, down.stdout + down.stderr)
                self.assertIn('cannot confirm recorded worker port', down.stderr)
                self.assert_no_cleanup_since(before)
                self.assertEqual(db.read_text(), data['databaseClaim'])
                self.assertEqual((self.instance / 'instance.json').read_bytes(), metadata)
        down = self.cli('down', 'met-218-test')
        self.assertEqual(down.returncode, 0, down.stdout + down.stderr)
        self.assertFalse(db.exists() or self.instance.exists())

    def test_mixed_generations_share_three_slots_and_port_pairs_concurrently(self):
        qa = self.instance.parent
        qa.mkdir()
        allocator = qa / '.alloc.lock'
        attempts = Path(self.tmp, 'allocator-attempts')
        attempts.touch()
        tasks = ('old-one', 'new-one', 'old-two', 'new-two')

        def request(task):
            env = dict(QA_TEST_LOCK_ATTEMPTS=str(attempts), QA_TEST_TASK=task)
            if task.startswith('old-'):
                return self.legacy_cli('up', task, **env)
            return self.cli('up', task, '--owner', 'new', '--card', 'MET-260', **env)

        with ThreadPoolExecutor(max_workers=4) as workers:
            with allocator.open('a') as lock:
                inode = os.fstat(lock.fileno()).st_ino
                fcntl.flock(lock, fcntl.LOCK_EX)
                pending = [workers.submit(request, task) for task in tasks]
                deadline = time.monotonic() + 10
                while set(attempts.read_text().splitlines()) != set(tasks) and time.monotonic() < deadline:
                    time.sleep(.05)
                self.assertEqual(set(attempts.read_text().splitlines()), set(tasks))
                self.assertFalse(list(qa.glob('*/instance.json')))
            results = [future.result() for future in pending]
        self.assertEqual(sorted(r.returncode for r in results), [0, 0, 0, 75],
                         [r.stdout + r.stderr for r in results])
        records = [json.loads(p.read_text()) for p in qa.glob('*/instance.json')]
        self.assertEqual(len(records), 3)
        self.assertEqual({data['task'] for data in records}, {task for task, r in zip(tasks, results) if r.returncode == 0})
        self.assertEqual(sorted(port for data in records for port in (data['webPort'], data['workerPort'])),
                         list(range(3200, 3206)))
        self.assertEqual(allocator.stat().st_ino, inode)
        self.assertEqual(request('old-extra').returncode, 75)
        self.assertEqual(request('new-extra').returncode, 75)

    def test_same_task_down_preserves_the_other_generation_in_both_directions(self):
        task = 'met-218-test'
        qa = self.instance.parent
        old_instance = qa / task
        up, _ = self.up()
        self.assertEqual(up.returncode, 0, up.stdout + up.stderr)
        old = self.legacy_cli('up', task)
        self.assertEqual(old.returncode, 0, old.stdout + old.stderr)
        record = json.loads((self.instance / 'instance.json').read_text())
        new_release = self.worktrees / record['worktree']['name']

        def snapshot(directory, release, prefix, db):
            paths = [directory, release, self.db_dir / db]
            paths += list(directory.rglob('*')) + list(release.rglob('*'))
            for role in ('web', 'worker'):
                name = f'ai.bplabs.{prefix}-qa-{task}-{role}'
                paths.extend((self.agents / (name + '.plist'), self.jobs / name))
            return {path: (path.stat().st_ino, path.read_bytes() if path.is_file() else None) for path in paths}

        for old_down in (True, False):
            with self.subTest(old_down=old_down):
                if old_down:
                    protected = (self.instance, new_release, 'allrice40', record['database'])
                    protected_lock, removed, down = qa / ('.task40-' + task + '.lock'), old_instance, self.legacy_cli
                    invalid = self.legacy_cli('down', self.instance.name)
                    self.assertIn('task name must match', invalid.stderr)
                    self.assertEqual(invalid.returncode, 1)
                else:
                    old = self.legacy_cli('up', task)
                    self.assertEqual(old.returncode, 0, old.stdout + old.stderr)
                    protected = (old_instance, old_instance / 'release', 'allrice', 'allrice_qa_met_218_test')
                    protected_lock, removed, down = qa / ('.task-' + task + '.lock'), self.instance, self.cli
                original = snapshot(*protected)
                with protected_lock.open('a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX)
                    result = down('down', task)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertFalse(removed.exists())
                    retry = down('down', task)
                    self.assertEqual(retry.returncode, 0 if old_down else 1, retry.stdout + retry.stderr)
                    self.assertEqual(protected_lock.stat().st_ino, os.fstat(lock.fileno()).st_ino)
                    self.assertEqual(snapshot(*protected), original)

    def seed(self, task, expired=True, old_version=False):
        directory = Path(self.home, 'allrice-qa', task if old_version else '_allrice40-' + task)
        (directory / 'logs').mkdir(parents=True)
        now = time.time()
        from datetime import datetime, timezone
        stamp = lambda value: datetime.fromtimestamp(value, timezone.utc).isoformat()
        data = {'repository': 'semiok/allrice-vm', 'repositoryId': 1469490636, 'task': task, 'webPort': 3298, 'workerPort': 3299, 'sha': SOURCE_SHA,
                'ref': SOURCE_SHA, 'database': 'allrice40_qa_' + task.replace('-', '_'),
                'databaseClaim': None, 'plistClaims': {},
                'owner': 'owner-' + task, 'card': 'MET-220', 'repositoryCreatedAt': stamp(now - 86400),
                'repositoryExpiresAt': stamp(now - 60 if expired else now + 600)}
        if old_version:
            data.pop('repository')
            data.pop('repositoryId')
            data['createdAt'] = data.pop('repositoryCreatedAt')
            data['expiresAt'] = data.pop('repositoryExpiresAt')
            data['database'] = 'allrice_qa_' + task.replace('-', '_')
        (directory / 'instance.json').write_text(json.dumps(data))
        (directory / 'creds.json').write_text('SECRET-CREDS')
        (directory / '.env').write_text('SECRET-ENV')
        (directory / 'logs/build.log').write_text('safe build output')
        (directory / 'logs/creds.json').write_text('SECRET-CREDS')
        (directory / 'logs/secret.log').symlink_to(directory / 'creds.json')
        return directory

    def test_full_capacity_reclaims_expired_stopped_only_and_archives_without_creds(self):
        old = self.seed('expired-stopped')
        live = self.seed('expired-live')
        fresh = self.seed('fresh', expired=False)
        result = self.cli('up', 'met-218-test', '--owner', 'tester', '--card', 'MET-218', QA_TEST_LIVE='expired-live')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(old.exists())
        self.assertTrue(live.exists())
        self.assertTrue(fresh.exists())
        archives = list(Path(self.home, 'allrice40-dev/qa/codex/qa-reclaimed').iterdir())
        self.assertEqual(len(archives), 1)
        files = sorted(str(p.relative_to(archives[0])) for p in archives[0].rglob('*') if p.is_file())
        self.assertEqual(files, ['instance.json', 'logs/build.log'])
        self.assertNotIn('SECRET', ''.join(p.read_text() for p in archives[0].rglob('*') if p.is_file()))
        self.assertFalse(Path(self.home, 'allrice-qa/.task40-met-218-test.lock').exists())

    def test_full_capacity_keeps_running_and_prints_occupants(self):
        for task in ['one', 'two', 'three']:
            self.seed(task)
        result = self.cli('up', 'met-218-test', '--owner', 'tester', '--card', 'MET-218', QA_TEST_LIVE='one,two,three')
        self.assertEqual(result.returncode, 75, result.stdout + result.stderr)
        self.assertIn('owner=owner-one', result.stderr)
        self.assertIn('process=running lease=expired', result.stderr)
        self.assertEqual(len(list(Path(self.home, 'allrice-qa').glob('*/instance.json'))), 3)
        self.assertFalse(Path(self.home, 'allrice40-dev/qa/codex/qa-reclaimed').exists())

    def test_renew_preserves_creation_and_caps_ttl(self):
        directory = self.seed('renew-me')
        before = json.loads((directory / 'instance.json').read_text())
        result = self.cli('renew', 'renew-me', '--ttl', '24h')
        self.assertEqual(result.returncode, 0, result.stderr)
        after = json.loads((directory / 'instance.json').read_text())
        self.assertEqual(before['repositoryCreatedAt'], after['repositoryCreatedAt'])
        self.assertNotIn('createdAt', after)
        self.assertNotIn('expiresAt', after)
        self.assertNotEqual(before['repositoryExpiresAt'], after['repositoryExpiresAt'])
        refused = self.cli('renew', 'renew-me', '--ttl', '25h')
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(after, json.loads((directory / 'instance.json').read_text()))

    def test_old_repository_instances_count_toward_capacity_but_cannot_be_reclaimed_or_changed(self):
        for task in ['old-one', 'old-two', 'old-three']:
            self.seed(task, old_version=True)
        result = self.cli('up', 'met-218-test', '--owner', 'tester', '--card', 'MET-218')
        self.assertEqual(result.returncode, 75, result.stdout + result.stderr)
        for operation in ['renew', 'down']:
            result = self.cli(operation, 'old-one')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('does not belong to semiok/allrice-vm', result.stderr)
        self.assertEqual(len(list(Path(self.home, 'allrice-qa').glob('*/instance.json'))), 3)
        events = [json.loads(line) for line in Path(self.events).read_text().splitlines()]
        self.assertFalse(any(e['command'] in ('createdb', 'dropdb') for e in events))

    def test_wait_does_not_hold_allocator_and_continues_when_owner_releases(self):
        for task in ['one', 'two', 'three']:
            self.seed(task, expired=False)
        result = self.cli('up', 'met-218-test', '--owner', 'tester', '--card', 'MET-218', '--wait',
                          LINEAR_API_KEY='test-only', QA_TEST_RELEASE='_allrice40-one')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.instance / 'instance.json').exists())
        self.assertFalse(Path(self.home, 'allrice-qa/_allrice40-one').exists())

    def test_task_lock_prevents_reclaim_during_other_operation(self):
        import fcntl
        for task in ['one', 'two', 'three']:
            self.seed(task, expired=task == 'one')
        with Path(self.home, 'allrice-qa/.task40-one.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = self.cli('up', 'met-218-test', '--owner', 'tester', '--card', 'MET-218')
        self.assertEqual(result.returncode, 75, result.stdout + result.stderr)
        self.assertTrue(Path(self.home, 'allrice-qa/_allrice40-one/instance.json').exists())

    def test_missing_owner_card_or_ref_bootstrap_refuses_before_build(self):
        for args in [[], ['--owner', 'test'], ['--card', 'MET-220']]:
            result = self.cli('up', 'met-218-test', *args)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(Path(self.events).exists())
        result = self.cli('up', 'met-218-test', '--owner', 'test', '--card', 'MET-220', QA_TEST_MISSING_BOOTSTRAP='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ref has no QA bootstrap script', result.stderr)
        events = [json.loads(line) for line in Path(self.events).read_text().splitlines()]
        self.assertFalse(any(e['command'] in ['pnpm', 'createdb', 'node'] for e in events))


if __name__ == '__main__':
    unittest.main()
