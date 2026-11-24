"""Identify processes that may still own schedule partitions during M1 recovery."""
import ctypes
import json
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
ENV_UNAVAILABLE = '无法读取进程启动环境。请按 PID 核查该进程的所属服务与启动环境可见性。'
WORKER_DESCENDANT = '停止前已核实为 Worker 或其子进程。请核查该进程已退出。'


class UnverifiedStartup(ValueError):
    """A reason safe to show without revealing arguments, environment or credentials."""


def loader_setting(key):
    return key in LOADER_SETTINGS or key.startswith(LOADER_PREFIXES)


def process_started(pid):
    system = ctypes.CDLL(None, use_errno=True)
    info = ctypes.create_string_buffer(BSD_INFO.size)
    if system.proc_pidinfo(pid, 3, 0, info, BSD_INFO.size) != BSD_INFO.size:  # PROC_PIDTBSDINFO
        raise OSError('process start time unavailable')
    seconds, microseconds = BSD_INFO.unpack(info.raw)[-2:]
    return seconds * 10**9 + microseconds * 1000


def observe_process(pid):
    """Get discrete exec arguments and environment without replaying the command."""
    system = ctypes.CDLL(None, use_errno=True)
    start = process_started(pid)
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    length = ctypes.c_size_t()
    if system.sysctl(mib, 3, None, ctypes.byref(length), None, 0) or not length.value:
        raise OSError('process arguments unavailable')
    data = ctypes.create_string_buffer(length.value)
    if system.sysctl(mib, 3, data, ctypes.byref(length), None, 0) or process_started(pid) != start:
        raise OSError('process arguments changed during inspection')
    payload = data.raw[:length.value]
    argc = struct.unpack_from('=i', payload)[0]
    executable, _, rest = payload[4:].partition(b'\0')
    fields = rest.lstrip(b'\0').split(b'\0')
    if not executable or not 0 < argc < len(fields) or b'' not in fields[argc:]:
        raise ValueError('incomplete process arguments or environment')
    end = fields.index(b'', argc)
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
        with os.fdopen(fd, 'rb') as file:
            st = os.fstat(file.fileno())
            if not launch_file(st, start):
                raise ValueError('env file could not be verified at launch')
            contents = file.read()
        current = path.stat()
        if not canonical(path) or (st.st_dev, st.st_ino, st.st_ctime_ns, st.st_mtime_ns) != (
                current.st_dev, current.st_ino, current.st_ctime_ns, current.st_mtime_ns):
            raise ValueError('env file replaced during inspection')
        if b'\r' in contents.replace(b'\r\n', b''):
            raise UnverifiedStartup('环境文件含独立回车（CR）。请核查 --env-file 指向的文件，统一为 LF 或 CRLF 后重启对应进程。')
        try:
            contents.decode('utf-8')
            if b'\0' in contents:
                raise ValueError
        except ValueError:
            raise UnverifiedStartup('环境文件编码无法核实。请核查 --env-file 使用 UTF-8 文本且无 NUL 字节。') from None
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


def ps():
    command = ['/bin/ps', '-xww', '-U', str(os.getuid()), '-o', 'pid=,ppid=,ucomm=']
    rows = subprocess.run(command, capture_output=True, text=True, check=True).stdout.splitlines()
    processes = {}
    for row in rows:
        pid, ppid, name = row.strip().split(None, 2)
        processes[pid] = (ppid, name)
    return processes


def process_cwds():
    result = subprocess.run(['/usr/sbin/lsof', '-a', '-u', str(os.getuid()), '-d', 'cwd', '-Fpn'],
                            capture_output=True, text=True)
    if result.returncode != 0:
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


def worker_tree(pid):
    root_start = process_started(int(pid))
    processes = ps()
    if pid not in processes:
        raise ValueError('Worker PID missing from process list')
    children = {}
    for child, (parent, _) in processes.items():
        children.setdefault(parent, []).append(child)
    pending = [pid]
    known = {}
    while pending:
        child = pending.pop()
        try:
            known[child] = process_started(int(child))
        except OSError:
            if alive(child):
                raise
        pending.extend(children.get(child, ()))
    if known.get(pid) != root_start or process_started(int(pid)) != root_start:
        raise ValueError('Worker changed while recording descendants')
    print(json.dumps(known))


def targets_database(value, db):
    if not value:
        return False
    try:
        target = urlsplit(value)
        host, port = target.hostname, target.port
    except ValueError:
        raise UnverifiedStartup('DATABASE_URL 无法核实。请核查连接串的主机、端口和库名。') from None
    if not target.path.strip('/'):
        raise UnverifiedStartup('DATABASE_URL 的 URL 路径缺少库名。请核查启动配置并显式填写 /数据库名。')
    if (target.scheme not in ('postgres', 'postgresql') or target.query or target.fragment
            or not re.fullmatch(r'/[a-zA-Z0-9_-]+', target.path)
            or (host and any(char in host for char in '%,'))
            or (port is not None and port < 1) or any(ord(char) <= 32 for char in value)):
        raise UnverifiedStartup('DATABASE_URL 无法核实。请核查连接串使用明确的主机、端口和单一库名。')
    return host in (None, '127.0.0.1', 'localhost', '::1') and target.path[1:] == db


def main(db, roots, known_tree, *web_settings):
    def scoped(path):
        return any(Path(path).resolve().is_relative_to(root) for root in scope)

    def scoped_argument(arg, here):
        path = arg.split('=', 1)[1] if arg.startswith('-') and '=' in arg else arg
        return ((path.startswith('/') and scoped(path))
                or (here is not None and path.startswith(('./', '../')) and scoped(here / path)))

    scope = [Path(root).resolve() for root in roots.split('|')]
    known = json.loads(known_tree)
    web = verified_web_launch(db, *web_settings)
    processes, cwds = ps(), process_cwds()
    # A known descendant missing from the current UID list may still be alive.
    for pid in known.keys() - processes.keys():
        try:
            if process_started(int(pid)) == known[pid]:
                print(pid, WORKER_DESCENDANT)
        except OSError:
            if alive(pid):
                print(pid, ENV_UNAVAILABLE)
    ancestors, pid = set(), str(os.getpid())
    while pid in processes and pid not in ancestors:
        ancestors.add(pid)
        pid = processes[pid][0]
    for pid, (_, name) in processes.items():
        if pid in ancestors:
            continue
        here = cwds.get(pid)
        try:
            observed, args, inherited, start = observe_process(int(pid))
        except (OSError, ValueError, struct.error):
            if here is not None or alive(pid):
                print(pid, ENV_UNAVAILABLE)
            continue
        if not inherited:
            print(pid, ENV_UNAVAILABLE)
            continue
        if known.get(pid) == start:
            print(pid, WORKER_DESCENDANT)
            continue
        try:
            if name != 'node' and Path(observed).name != 'node' and not (web and pid == web[0]):
                database = targets_database(inherited.get('DATABASE_URL', ''), db)
                if (database or (here is not None and scoped(here))
                        or (Path(observed).is_absolute() and scoped(observed))
                        or any(scoped_argument(arg, here) for arg in args)):
                    print(pid, '进程使用目标库或目标工作路径。请核查该进程已退出。')
                continue
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
            database = targets_database(environment.get('DATABASE_URL', ''), db)
            if web and pid == web[0] and args == web[1] and here == web[2] and script == web[3]:
                continue
            if scoped(here) or scoped(script) or any(map(scoped, files)) or database:
                print(pid, script)
        except UnverifiedStartup as error:
            print(pid, error)
        except (OSError, RuntimeError, ValueError, IndexError, AttributeError, subprocess.SubprocessError):
            print(pid, '启动参数或文件来源无法核实。请按 PID 核查实际入口和环境文件。')


if __name__ == '__main__':
    action, *arguments = sys.argv[1:]
    if action == 'worker-tree':
        worker_tree(*arguments)
    elif action == 'scan':
        main(*arguments)
    else:
        sys.exit('unknown process inspection')
