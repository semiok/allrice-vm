"""Local 4.0 service targets for deployment, maintenance and monitoring."""
import os
import plistlib
import re
import shlex
import sys
from pathlib import Path
from urllib.parse import urlsplit

DEV_DATABASE = 'allrice40_dev'
DEV_PORTS = {'web': 3311, 'worker': 3312}


def database_matches(dsn, database=DEV_DATABASE):
    try:
        target = urlsplit(dsn)
        return (target.scheme in ('postgres', 'postgresql') and target.hostname == '127.0.0.1'
                and target.port == 5434 and target.path == '/' + database
                and not target.query and not target.fragment)
    except (ValueError, TypeError, AttributeError):
        return False


def service_matches(plist, label, port_key, port, database, tools):
    if not isinstance(plist, dict):
        return False
    role = 'web' if port_key == 'ALLRICE_WEB_PORT' else 'worker'
    home = Path.home()
    args = plist.get('ProgramArguments')
    env = plist.get('EnvironmentVariables')
    if (plist.get('Label') != label or not isinstance(env, dict)
            or env.get(port_key) != port or not database_matches(env.get('DATABASE_URL', ''), database)
            or not isinstance(args, list) or not args or not all(isinstance(arg, str) for arg in args)):
        return False

    if plist.get('Program', args[0]) != args[0]:
        return False

    entry = '/apps/web/server.mjs' if role == 'web' else '/apps/worker/dist/index.js'
    env_path = home / 'allrice40-dev/.env' if database == DEV_DATABASE else home / 'allrice-qa' / label[len('ai.bplabs.allrice-qa-'):-len(role)-1] / '.env'
    loaded = Path(args[0])
    if loaded.name == 'with-env':
        try:
            actual = loaded.resolve()
            previous_tools = home.resolve() / 'allrice40-dev/tools'
            current = (Path(tools) / 'with-env').resolve()
        except (OSError, RuntimeError):
            return False
        versioned = (actual.name == 'with-env' and actual.parent.parent == previous_tools
                     and re.fullmatch(r'[a-f0-9]{40}', actual.parent.name))
        if (database != DEV_DATABASE or not loaded.is_absolute() or args[1:2] != [role]
                or not (actual == current or versioned)):
            return False
        args = args[2:]
        # A loader supplies the validated plist environment. A second env file
        # could supply options after it and is not emitted by deploy-dev.
        allow_env_file = False
    else:
        allow_env_file = True

    if not args or not Path(args[0]).is_absolute() or Path(args[0]).name != 'node':
        return False
    args = args[1:]
    if args and args[0].startswith('--env-file='):
        if not allow_env_file or args[0] != '--env-file=' + str(env_path):
            return False
        args = args[1:]
    if not args or not Path(args[0]).is_absolute() or not args[0].endswith(entry):
        return False
    flags = args[1:]
    if role == 'web':
        if '--dev' in flags:
            return False
        if '--port' in flags and (flags.count('--port') != 1 or flags[flags.index('--port') + 1:][:1] != [port]):
            return False
    return True


def main():
    path, label, port_key, port, database, *mode = sys.argv[1:]
    try:
        with open(path, 'rb') as file:
            plist = plistlib.load(file)
        valid = service_matches(plist, label, port_key, port, database, Path(__file__).resolve().parent)
    except (OSError, plistlib.InvalidFileException, ValueError, RuntimeError):
        valid = False
    if not valid:
        sys.exit(f'{path}: expected {label}, {port_key}={port}, PostgreSQL 127.0.0.1:5434/{database} and matching startup arguments')
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
