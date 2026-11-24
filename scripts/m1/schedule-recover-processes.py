"""Identify processes that may still own schedule partitions during M1 recovery."""
import ctypes
import os
import plistlib
import re
import stat
import struct
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

from service_target import canonical, dotenv_environment, service_config

# Options whose values do not choose code or its loader. Everything else is opaque.
VALUE_OPTIONS = {
    '--unhandled-rejections': r'strict|throw|warn|warn-with-error-code|none',
    '--max-http-header-size': r'[0-9]+',
}
ENV_FILE_OPTIONS = {'--env-file', '--env-file-if-exists'}
WEB_OPTIONS = {'--hostname': r'127\.0\.0\.1|0\.0\.0\.0|localhost|::1?', '--port': r'[0-9]+'}
BSD_INFO = struct.Struct('=12I16s32s6IQQ')  # Darwin proc_bsdinfo, including start time
PINNED_NODE = Path.home() / '.local/opt/node-22.23.2/bin/node'
LOADER_PREFIXES = ('DYLD_', 'LD_', 'NODE_')
LOADER_SETTINGS = {'OPENSSL_CONF', 'OPENSSL_MODULES', 'OPENSSL_ENGINES'}


def loader_setting(key):
    return key in LOADER_SETTINGS or key.startswith(LOADER_PREFIXES)


def observe_process(pid):
    """Get discrete exec arguments and environment without replaying the command."""
    system = ctypes.CDLL(None, use_errno=True)
    info = ctypes.create_string_buffer(BSD_INFO.size)

    def started():
        if system.proc_pidinfo(pid, 3, 0, info, BSD_INFO.size) != BSD_INFO.size:  # PROC_PIDTBSDINFO
            raise OSError('process start time unavailable')
        seconds, microseconds = BSD_INFO.unpack(info.raw)[-2:]
        return seconds * 10**9 + microseconds * 1000

    start = started()
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    length = ctypes.c_size_t()
    if system.sysctl(mib, 3, None, ctypes.byref(length), None, 0) or not length.value:
        raise OSError('process arguments unavailable')
    data = ctypes.create_string_buffer(length.value)
    if system.sysctl(mib, 3, data, ctypes.byref(length), None, 0) or started() != start:
        raise OSError('process arguments changed during inspection')
    payload = data.raw[:length.value]
    argc = struct.unpack_from('=i', payload)[0]
    executable, _, rest = payload[4:].partition(b'\0')
    fields = rest.lstrip(b'\0').split(b'\0')
    if not executable or not 0 < argc < len(fields) or b'' not in fields[argc:]:
        raise ValueError('incomplete process arguments or environment')
    end = fields.index(b'', argc)
    if end == argc:
        raise ValueError('process environment could not be verified')
    environment = {}
    for field in fields[argc:end]:
        key, eq, value = os.fsdecode(field).partition('=')
        if not key or not eq or key in environment:
            raise ValueError('ambiguous process environment')
        environment[key] = value
    # The Darwin exec strings include padding and Apple startup strings. A
    # second possible value for a relevant setting makes the snapshot ambiguous.
    for field in fields[end + 1:]:
        key, eq, value = os.fsdecode(field).partition('=')
        if eq and (key == 'DATABASE_URL' or loader_setting(key)) and environment.get(key) != value:
            raise ValueError('ambiguous process startup settings')
    return os.fsdecode(executable), list(map(os.fsdecode, fields[:argc])), environment, start


def plain_node_options(args, allow_env_files):
    files = []
    i = 0
    while i < len(args) and args[i].startswith('-'):
        if args[i] == '--' and allow_env_files:
            return i + 1, files
        key, eq, value = args[i].partition('=')
        i += 1
        is_env_file = key in ENV_FILE_OPTIONS and allow_env_files
        if key not in VALUE_OPTIONS and not is_env_file:
            raise ValueError('unknown Node launch option')
        if not eq:
            if i >= len(args) or args[i].startswith('-'):
                raise ValueError('missing Node launch option value')
            value = args[i]
            i += 1
        if is_env_file:
            files.append(Path(value))
        elif not re.fullmatch(VALUE_OPTIONS[key], value):
            raise ValueError('unverified Node launch option value')
    return i, files


def ordinary_script_arguments(script, args):
    # Node's early env/config loaders can inspect arguments after the script.
    # Only the service's known literal app flags are safe beyond that boundary.
    return not args or (script.name == 'server.mjs' and len(args) % 2 == 0 and
                        all(key in WEB_OPTIONS and re.fullmatch(WEB_OPTIONS[key], value)
                            for key, value in zip(args[::2], args[1::2])))


def launch_file(st, start):
    return stat.S_ISREG(st.st_mode) and max(st.st_ctime_ns, st.st_mtime_ns) <= start


def effective_environment(start, inherited, files):
    environment = {}
    for path in files:
        # A missing or replaced file, including --env-file-if-exists, cannot
        # establish which options were in effect when this process started.
        if not canonical(path):
            raise ValueError('env file unavailable')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, encoding='utf-8') as file:
            st = os.fstat(file.fileno())
            if not launch_file(st, start):
                raise ValueError('env file could not be verified at launch')
            contents = file.read()
        current = path.stat()
        if not canonical(path) or (st.st_dev, st.st_ino, st.st_ctime_ns, st.st_mtime_ns) != (
                current.st_dev, current.st_ino, current.st_ctime_ns, current.st_mtime_ns):
            raise ValueError('env file replaced during inspection')
        environment.update(dotenv_environment(contents, PINNED_NODE))
    environment.update(inherited)
    # The small scalar whitelist needs no quoting or escape interpretation.
    raw_options = environment.get('NODE_OPTIONS', '')
    if not re.fullmatch(r'[a-z0-9 =-]*', raw_options):
        raise ValueError('unverified Node startup options')
    options = raw_options.split()
    i, _ = plain_node_options(options, allow_env_files=False)
    if i != len(options) or any(value for key, value in environment.items()
                                if loader_setting(key) and key not in ('NODE_ENV', 'NODE_OPTIONS')):
        raise ValueError('unverified Node startup environment')
    return environment


def verified_web_launch(db, release, worker_port, web_config, web_label, web_port, web_state):
    if not re.fullmatch(r'running [1-9][0-9]*', web_state):
        return None
    try:
        release = Path(release)
        with Path(web_config).open('rb') as file:
            web = plistlib.load(file)
        if web.get('WorkingDirectory') != str(release / 'apps/web') or not service_config(
                web, web_label, 'ALLRICE_WEB_PORT', web_port, db, Path(__file__).parent, worker_port):
            return None
        args = web['ProgramArguments']
        if Path(args[0]).name == 'with-env':
            args = args[2:]
        return web_state.split()[1], args, release / 'apps/web', release / 'apps/web/server.mjs'
    except (OSError, KeyError, TypeError, ValueError, plistlib.InvalidFileException):
        return None


def ps(*options):
    command = ['/bin/ps', *options, '-xww', '-U', str(os.getuid()), '-o', 'pid=,ppid=,ucomm=,command=']
    rows = subprocess.run(command, capture_output=True, text=True, check=True).stdout.splitlines()
    processes = {}
    for row in rows:
        pid, ppid, name, *command = row.split(None, 3)
        processes[pid] = (ppid, name, command[0] if command else '')
    return processes


def node_cwds():
    result = subprocess.run(['/usr/sbin/lsof', '-a', '-u', str(os.getuid()), '-d', 'cwd', '-c', 'node', '-Fpn'],
                            capture_output=True, text=True)
    if result.returncode not in (0, 1):
        raise ValueError('lsof failed')
    paths, pid = {}, None
    for line in result.stdout.splitlines():
        if line.startswith('p'):
            pid = line[1:]
        elif line.startswith('n') and pid:
            paths[pid] = Path(line[1:])
    return paths


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def main(db, roots, *web_settings):
    def scoped(path):
        return any(Path(path).resolve().is_relative_to(root) for root in scope)

    def targets_db(value):
        target = urlsplit(value)
        return target.hostname in (None, '127.0.0.1', 'localhost') and target.path.lstrip('/') == db

    scope = [Path(root).resolve() for root in roots.split('|')]
    web = verified_web_launch(db, *web_settings)
    processes, with_env, cwds = ps(), ps('-E'), node_cwds()
    ancestors, pid = set(), str(os.getpid())
    while pid in processes and pid not in ancestors:
        ancestors.add(pid)
        pid = processes[pid][0]
    for pid, (_, name, cmd) in processes.items():
        if pid in ancestors:
            continue
        here = cwds.get(pid)
        if here is None and name != 'node' and not (web and pid == web[0]):
            # Preserve the existing DATABASE_URL check for non-Node Worker children.
            full = with_env.get(pid, ('', '', ''))[2][len(cmd):]
            if any(item.startswith('DATABASE_URL=') and targets_db(item[13:]) for item in full.split()):
                print(pid, 'database client')
            continue
        try:
            observed, args, inherited, start = observe_process(int(pid))
            if (here is None or not canonical(here) or not here.is_dir()
                    or not args or Path(observed).resolve() != PINNED_NODE.resolve()):
                raise ValueError('process executable or cwd is unknown')
            if args[0] != 'node' and not Path(args[0]).is_absolute():
                raise ValueError('unverified Node argv[0]')
            index, files = plain_node_options(args[1:], allow_env_files=True)
            script = Path(args[index + 1])
            if (script.suffix not in ('.js', '.mjs', '.cjs') or not canonical(script)
                    or not launch_file(script.stat(), start)):
                raise ValueError('entry is not a verifiable absolute file')
            if not ordinary_script_arguments(script, args[index + 2:]):
                raise ValueError('arguments after the entry are not a plain startup')
            environment = effective_environment(start, inherited, files)
            if web and pid == web[0] and args == web[1] and here == web[2] and script == web[3]:
                continue
            if (scoped(here) or scoped(script) or any(map(scoped, files))
                    or targets_db(environment.get('DATABASE_URL', ''))):
                print(pid, script)
        except (OSError, RuntimeError, ValueError, IndexError, AttributeError, struct.error, subprocess.SubprocessError):
            if here is not None or alive(pid):
                print(pid, 'Node startup could not be verified')


if __name__ == '__main__':
    main(*sys.argv[1:])
