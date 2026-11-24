"""Local 4.0 service targets for deployment, maintenance and monitoring."""
import json
import os
import plistlib
import re
import shlex
import sys
from pathlib import Path
from urllib.parse import urlsplit

DEV_DATABASE = 'allrice40_dev'
DEV_PORTS = {'web': 3311, 'worker': 3312}
REPOSITORY = 'semiok/allrice-vm'
REPOSITORY_ID = 1469490636
ENTRIES = {'web': 'apps/web/server.mjs', 'worker': 'apps/worker/dist/index.js'}
SHA = re.compile(r'[a-f0-9]{40}')
DIGEST = re.compile(r'sha256:[a-f0-9]{64}')


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


def release_identity(release, task=None):
    """Read the build identity from the selected 4.0 release directory."""
    home = Path.home().resolve()
    manifest = release / '.local/dev-build-identity.json'
    try:
        in_scope = (release == home / 'allrice-qa' / task / 'release' if task else
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


def state_matches(env, role, task):
    """The launchd values win over .env and name the roots covered by backup."""
    home = Path.home().resolve()
    dev = home / 'allrice40-dev/.local'
    state = home / 'allrice-qa' / task / '.local' if task else dev
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
    for controller in ('once', 'recurring'):
        key = 'ALLRICE_NATIVE_' + controller.upper() + '_REFERENCE'
        reference = json.loads(env.get(key, 'null'))
        if reference is not None:
            target = state / ('native-' + controller + '-control' + ('' if task else '-m1'))
            if (not isinstance(reference, dict) or reference.get('stateRoot') != str(target)
                    or not canonical(target) or (target.exists() and not target.is_dir())):
                return False
    return True


def service_identity(plist, label, port_key, port, database, tools):
    try:
        return _service_identity(plist, label, port_key, port, database, tools)
    except (OSError, RuntimeError, ValueError, TypeError):
        return None


def _service_identity(plist, label, port_key, port, database, tools):
    if not isinstance(plist, dict):
        return None
    role = 'web' if port_key == 'ALLRICE_WEB_PORT' else 'worker'
    home = Path.home().resolve()
    args = plist.get('ProgramArguments')
    env = plist.get('EnvironmentVariables')
    task = None
    if database != DEV_DATABASE:
        match = re.fullmatch(r'ai\.bplabs\.allrice-qa-([a-z0-9][a-z0-9-]{0,30})-' + role, label)
        if (not match or database != 'allrice40_qa_' + match[1].replace('-', '_')
                or not 3200 <= int(port) <= 3299):
            return None
        task = match[1]
    if (plist.get('Label') != label or not isinstance(env, dict)
            or env.get('HOME', str(home)) != str(home)
            or env.get(port_key) != port or not database_matches(env.get('DATABASE_URL', ''), database)
            or not isinstance(args, list) or not args or not all(isinstance(arg, str) for arg in args)):
        return None

    if plist.get('Program', args[0]) != args[0]:
        return None

    cwd = Path(plist.get('WorkingDirectory', ''))
    release = cwd.parent.parent if role == 'web' else cwd
    expected_cwd = release / 'apps/web' if role == 'web' else release
    identity = release_identity(release, task)
    if (cwd != expected_cwd or not identity or env.get('ALLRICE_RELEASE_SHA') != identity['sourceSha']
            or not state_matches(env, role, task)):
        return None

    env_path = home / 'allrice-qa' / task / '.env' if task else home / 'allrice40-dev/.env'
    if not canonical(env_path) or not env_path.is_file():
        return None
    loaded = Path(args[0])
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
        args = args[1:]
    if not args or Path(args[0]) != release / ENTRIES[role]:
        return None
    flags = args[1:]
    if role == 'web':
        if '--dev' in flags:
            return None
        if '--port' in flags and (flags.count('--port') != 1 or flags[flags.index('--port') + 1:][:1] != [port]):
            return None
    return identity


def main():
    if sys.argv[1] == 'release':
        path, *sha = sys.argv[2:]
        identity = release_identity(Path(path))
        if not identity or (sha and [identity['sourceSha']] != sha):
            sys.exit(f'{path}: expected a matching sealed 4.0 release')
        return
    if sys.argv[1] == 'ready':
        role, path = sys.argv[2:]
        identity = release_identity(Path(path))
        if identity:
            try:
                doc = json.load(sys.stdin)
                if ready_identity(doc, role, identity):
                    print(identity['sourceSha'])
            except ValueError:
                pass
        return
    path, label, port_key, port, database, *mode = sys.argv[1:]
    try:
        with open(path, 'rb') as file:
            plist = plistlib.load(file)
        valid = service_identity(plist, label, port_key, port, database, Path(__file__).resolve().parent)
    except (OSError, plistlib.InvalidFileException, ValueError, RuntimeError):
        valid = False
    if not valid:
        sys.exit(f'{path}: expected {label}, {port_key}={port}, PostgreSQL 127.0.0.1:5434/{database}, sealed 4.0 release and matching startup and state paths')
    if mode == ['exports']:
        env = plist['EnvironmentVariables']
        for key in set(os.environ) | set(env):
            if key in ('PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', 'ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS') or key.startswith(('ALLRICE_DSH_RETAINED_', 'ALLRICE_DSH_ORIGIN_READER_')):
                print(f'unset {shlex.quote(key)}')
                env.pop(key, None)
        for key, value in env.items():
            print(f'export {key}={shlex.quote(str(value))}')


if __name__ == '__main__':
    main()
