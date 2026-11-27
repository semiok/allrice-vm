"""Local 4.0 service targets for deployment, maintenance and monitoring."""
import json
import os
import plistlib
import re
import shlex
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

DEV_DATABASE = 'allrice40_dev'
DEV_PORTS = {'web': 3311, 'worker': 3312}
REPOSITORY = 'semiok/allrice-vm'
REPOSITORY_ID = 1469490636
QA_DIRECTORY_PREFIX = '_allrice40-'
QA_LABEL_PREFIX = 'ai.bplabs.allrice40-qa-'
QA_TASK_PATTERN = r'[a-z0-9][a-z0-9-]{0,30}'
ENTRIES = {'web': 'apps/web/server.mjs', 'worker': 'apps/worker/dist/index.js'}
SHA = re.compile(r'[a-f0-9]{40}')
DIGEST = re.compile(r'sha256:[a-f0-9]{64}')
CONTROLLERS = ('ONCE', 'RECURRING')
CONTROLLER_KEYS = tuple(f'ALLRICE_NATIVE_{kind}_{key}' for kind in CONTROLLERS for key in ('ENABLED', 'REFERENCE'))


def database_matches(dsn, database=DEV_DATABASE, port=5434):
    try:
        target = urlsplit(dsn)
        return (target.scheme in ('postgres', 'postgresql') and target.hostname == '127.0.0.1'
                and target.port == port and target.path == '/' + database
                and not target.query and not target.fragment)
    except (ValueError, TypeError, AttributeError):
        return False


def canonical(path):
    return path.is_absolute() and path.resolve() == path


def qa_instance_dir(task):
    return Path.home().resolve() / 'allrice-qa' / (QA_DIRECTORY_PREFIX + task)


def qa_instance_data(path):
    if not canonical(path):
        raise ValueError('QA instance path is not canonical')
    data = json.loads(path.read_text())
    task = data.get('task') if isinstance(data, dict) else None
    if (not isinstance(task, str) or not re.fullmatch(QA_TASK_PATTERN, task)
            or path != qa_instance_dir(task) / 'instance.json'
            or data.get('repository') != REPOSITORY or data.get('repositoryId') != REPOSITORY_ID):
        raise ValueError('expected a 4.0 QA instance')
    return data


def qa_instance_database(data):
    name = data.get('database')
    expected = 'allrice40_qa_' + data['task'].replace('-', '_')
    if name != expected:
        raise ValueError('invalid 4.0 QA database name')
    return name


def qa_worktree(data):
    """Resolve the directory reserved by this instance before git worktree add."""
    if 'worktree' not in data:
        return None
    record = data['worktree']
    task = data.get('task')
    name = record.get('name') if isinstance(record, dict) else None
    if (not isinstance(task, str) or not re.fullmatch(QA_TASK_PATTERN, task) or not isinstance(name, str)
            or not re.fullmatch(r'\.qa-' + re.escape(task) + r'\.[a-zA-Z0-9]{8}', name)):
        raise ValueError('invalid QA worktree record')
    release = Path.home().resolve() / 'allrice40-worktrees' / name
    if not canonical(release.parent):
        raise ValueError('QA worktree root is not canonical')
    try:
        entry = release.lstat()
    except FileNotFoundError:
        return None
    if (not stat.S_ISDIR(entry.st_mode) or record.get('device') != entry.st_dev
            or record.get('inode') != entry.st_ino):
        raise ValueError('QA worktree does not match the reserved directory')
    return release


def release_identity(release, task=None):
    """Read the build identity from the selected 4.0 release directory."""
    home = Path.home().resolve()
    manifest = release / '.local/dev-build-identity.json'
    try:
        in_scope = (release == qa_worktree(qa_instance_data(qa_instance_dir(task) / 'instance.json')) if task else
                    release.parent == home / 'allrice40-dev-releases')
        if not in_scope or not canonical(release) or not canonical(manifest):
            return None
        for entry in ENTRIES.values():
            path = release / entry
            if not canonical(path) or not path.is_file():
                return None
        with manifest.open() as file:
            doc = json.load(file)
        if (doc.get('repository') == REPOSITORY and doc.get('repositoryId') == REPOSITORY_ID
                and doc.get('environment') == 'dev' and SHA.fullmatch(doc.get('sourceSha', ''))
                and SHA.fullmatch(doc.get('sourceTree', '')) and DIGEST.fullmatch(doc.get('manifestDigest', ''))):
            return doc
    except (OSError, RuntimeError, ValueError, TypeError, AttributeError):
        pass
    return None


def ready_identity(doc, role, expected=None):
    identity = doc.get('identity') if isinstance(doc, dict) else None
    return (isinstance(identity, dict) and doc.get('status') == 'ready'
            and identity.get('repository') == REPOSITORY and identity.get('repositoryId') == REPOSITORY_ID
            and identity.get('environment') == 'dev' and identity.get('service') == role
            and identity.get('mode') == 'production' and (expected is None or all(
                identity.get(key) == expected[key] for key in ('sourceSha', 'sourceTree', 'manifestDigest'))))


def dotenv_environment(contents, node, keys=()):
    """Read declarative Node dotenv values without using them to start Node."""
    result = subprocess.run([node, '-e', '''
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const env = parseEnv(readFileSync(0, 'utf8'));
const keys = process.argv.slice(1);
process.stdout.write(JSON.stringify(keys.length ? Object.fromEntries(keys.map(key => [key, env[key]])) : env));
''', *keys], input=contents, capture_output=True, check=True, timeout=5, env={})
    return json.loads(result.stdout)


def controller_settings(env, loaded_env_file):
    """Read the same declarative values Node's --env-file supplies, without sourcing the file."""
    missing = [key for key in CONTROLLER_KEYS if key not in env]
    defaults = {}
    if loaded_env_file and missing:
        dotenv = loaded_env_file.read_bytes()
        if any(key.encode() in dotenv for key in missing):
            pinned = Path.home() / '.local/opt/node-22.23.2/bin/node'
            node = shutil.which(str(pinned)) or shutil.which('node') or shutil.which('node', path='/opt/homebrew/bin:/usr/local/bin')
            if not node:
                raise ValueError('Node is required to read the controller environment')
            defaults = dotenv_environment(dotenv, node, missing)
    return {key: env.get(key, defaults.get(key, '')) for key in CONTROLLER_KEYS}


def state_matches(env, controllers, role, task):
    """The launchd values win over .env and name the roots covered by backup."""
    home = Path.home().resolve()
    dev = home / 'allrice40-dev/.local'
    state = qa_instance_dir(task) / '.local' if task else dev
    roots = {
        'ALLRICE_STORAGE_ROOT': state / 'storage',
        'ALLRICE_EXECUTION_ROOT': state / 'executions',
        'ALLRICE_DSH_RUNTIME_ROOT': state / ('dsh-runtime' if task else 'dsh-runtime-m1'),
        'ALLRICE_DSH_PLATFORM_HOME': dev / 'dsh-platform',
    }
    for key, target in roots.items():
        if role == 'web' and key != 'ALLRICE_STORAGE_ROOT' and key not in env:
            continue
        if env.get(key) != str(target) or not canonical(target) or (target.exists() and not target.is_dir()):
            return False
    # An enabled native controller's state lives in the same snapshot layout.
    for controller in CONTROLLERS:
        prefix = f'ALLRICE_NATIVE_{controller}'
        if controllers[f'{prefix}_ENABLED'] != '1':
            continue
        reference = json.loads(controllers[f'{prefix}_REFERENCE'])
        target = state / ('native-' + controller.lower() + '-control' + ('' if task else '-m1'))
        if (not isinstance(reference, dict) or reference.get('stateRoot') != str(target)
                or not canonical(target) or (target.exists() and not target.is_dir())):
            return False
    return True


def service_config(plist, label, port_key, port, database, tools, worker_port=None):
    try:
        return _service_config(plist, label, port_key, port, database, tools, worker_port)
    except (OSError, RuntimeError, ValueError, TypeError, subprocess.SubprocessError):
        return None


def _service_config(plist, label, port_key, port, database, tools, worker_port):
    if not isinstance(plist, dict):
        return None
    role = 'web' if port_key == 'ALLRICE_WEB_PORT' else 'worker'
    home = Path.home().resolve()
    args = plist.get('ProgramArguments')
    env = plist.get('EnvironmentVariables')
    task = None
    if database != DEV_DATABASE:
        match = re.fullmatch(re.escape(QA_LABEL_PREFIX) + '(' + QA_TASK_PATTERN + ')-' + role, label)
        if not match or not 3200 <= int(port) <= 3299:
            return None
        task = match[1]
        if database != qa_instance_database(qa_instance_data(qa_instance_dir(task) / 'instance.json')):
            return None
    if (plist.get('Label') != label or not isinstance(env, dict)
            or not all(isinstance(value, str) for value in env.values())
            or env.get('HOME', str(home)) != str(home)
            or env.get(port_key) != port or not database_matches(env.get('DATABASE_URL', ''), database)
            or not isinstance(args, list) or not args or not all(isinstance(arg, str) for arg in args)):
        return None

    if plist.get('Program', args[0]) != args[0]:
        return None
    if task and role == 'web':
        internal_port = env.get('ALLRICE_WORKER_PORT')
        if (internal_port == port or not 3200 <= int(internal_port) <= 3299
                or (worker_port is not None and internal_port != worker_port)
                or env.get('ALLRICE_WORKER_INTERNAL_URL') != f'http://127.0.0.1:{internal_port}'):
            return None

    cwd = Path(plist.get('WorkingDirectory', ''))
    release = cwd.parent.parent if role == 'web' else cwd
    expected_cwd = release / 'apps/web' if role == 'web' else release
    identity = release_identity(release, task)
    if cwd != expected_cwd or not identity or env.get('ALLRICE_RELEASE_SHA') != identity['sourceSha']:
        return None

    env_path = qa_instance_dir(task) / '.env' if task else home / 'allrice40-dev/.env'
    if not canonical(env_path) or not env_path.is_file():
        return None
    loaded = Path(args[0])
    loaded_env_file = None
    if loaded.name == 'with-env':
        actual = loaded.resolve()
        previous_tools = home / 'allrice40-dev/tools'
        current = (Path(tools) / 'with-env').resolve()
        versioned = (actual.name == 'with-env' and actual.parent.parent == previous_tools
                     and re.fullmatch(r'[a-f0-9]{40}', actual.parent.name))
        if (task or not loaded.is_absolute() or args[1:2] != [role] or not actual.is_file()
                or not (actual == current or versioned)):
            return None
        args = args[2:]
        loaded_env_file = env_path
        # A loader supplies the validated plist environment. A second env file
        # could supply options after it and is not emitted by deploy-dev.
        allow_env_file = False
    else:
        allow_env_file = True

    if not args or not Path(args[0]).is_absolute() or Path(args[0]).name != 'node':
        return None
    args = args[1:]
    if args and args[0].startswith('--env-file='):
        if not allow_env_file or args[0] != '--env-file=' + str(env_path):
            return None
        loaded_env_file = env_path
        args = args[1:]
    if not args or Path(args[0]) != release / ENTRIES[role]:
        return None
    flags = args[1:]
    if role == 'web':
        if '--dev' in flags:
            return None
        if '--port' in flags and (flags.count('--port') != 1 or flags[flags.index('--port') + 1:][:1] != [port]):
            return None
    controllers = controller_settings(env, loaded_env_file)
    if not state_matches(env, controllers, role, task):
        return None
    return {'identity': identity, 'controllers': controllers}


def main():
    if sys.argv[1] in ('qa-owned', 'qa-worktree', 'qa-database'):
        try:
            data = qa_instance_data(Path(sys.argv[2]))
            if sys.argv[1] == 'qa-worktree':
                release = qa_worktree(data)
                if release:
                    print(release)
            elif sys.argv[1] == 'qa-database':
                print(qa_instance_database(data))
        except (OSError, RuntimeError, ValueError):
            sys.exit(1)
        return
    if sys.argv[1] == 'release':
        path, *sha = sys.argv[2:]
        identity = release_identity(Path(path))
        if not identity or (sha and [identity['sourceSha']] != sha):
            sys.exit(f'{path}: expected a matching sealed 4.0 release')
        return
    if sys.argv[1] == 'ready':
        role, path, *recovery = sys.argv[2:]
        identity = release_identity(Path(path))
        if identity:
            try:
                doc = json.load(sys.stdin)
                if ready_identity(doc, role, identity):
                    if not recovery:
                        print(identity['sourceSha'])
                    elif role == 'worker' and len(recovery) == 1:
                        proof = doc.get('personVmRecovery')
                        boot = doc['identity'].get('bootId')
                        if (isinstance(proof, dict) and type(proof.get('pid')) is int
                                and str(proof['pid']) == recovery[0]
                                and isinstance(boot, str)
                                and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', boot)
                                and proof.get('state') in ('uninstalled', 'host-ready', 'wake-ready', 'drain-required')):
                            print(boot, proof['state'])
            except ValueError:
                pass
        return
    path, label, port_key, port, database, *mode = sys.argv[1:]
    worker_port = mode[0].partition('=')[2] if mode and mode[0].startswith('worker-port=') else None
    try:
        with open(path, 'rb') as file:
            plist = plistlib.load(file)
        valid = service_config(plist, label, port_key, port, database, Path(__file__).resolve().parent, worker_port)
    except (OSError, plistlib.InvalidFileException, ValueError, RuntimeError):
        valid = False
    if not valid:
        sys.exit(f'{path}: expected {label}, {port_key}={port}, PostgreSQL 127.0.0.1:5434/{database}, sealed 4.0 release and matching startup and state paths')
    if mode == ['exports']:
        env = dict(plist['EnvironmentVariables'], **valid['controllers'])
        for key in set(os.environ) | set(env):
            if key in ('PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', 'ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS') or key.startswith(('ALLRICE_DSH_RETAINED_', 'ALLRICE_DSH_ORIGIN_READER_')):
                print(f'unset {shlex.quote(key)}')
                env.pop(key, None)
        for key, value in env.items():
            print(f'export {key}={shlex.quote(str(value))}')


if __name__ == '__main__':
    main()
