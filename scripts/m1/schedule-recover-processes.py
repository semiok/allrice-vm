"""Identify processes that may still own schedule partitions during M1 recovery."""
import ctypes
import ipaddress
import json
import os
import plistlib
import re
import stat
import struct
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple
from urllib.parse import unquote, urlsplit

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
LSOF_UNAVAILABLE = '无法核实 lsof 的工作目录、文件或连接。请检查 lsof 读取错误和权限。'
PG_PORT = '5434'
PG_SOCKET = '.s.PGSQL.' + PG_PORT


class UnverifiedStartup(ValueError):
    """A reason safe to show without revealing arguments, environment or credentials."""


class OpenFile(NamedTuple):
    descriptor: str
    kind: str
    name: str
    device: str
    protocol: str


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


def process_files():
    try:
        result = subprocess.run(['/usr/sbin/lsof', '-nP', '-a', '-u', str(os.getuid()), '-F0pdftPn'],
                                capture_output=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        raise UnverifiedStartup(LSOF_UNAVAILABLE) from None
    if result.returncode != 0 or result.stderr or (result.stdout and not result.stdout.endswith(b'\0\n')):
        raise UnverifiedStartup(LSOF_UNAVAILABLE)
    files, pid = {}, None
    # -F0 terminates fields with NUL and each process or file set with a newline.
    for entry in result.stdout.split(b'\0\n'):
        if not entry:
            continue
        fields = {field[:1]: os.fsdecode(field[1:]) for field in entry.split(b'\0')}
        if b'p' in fields and fields[b'p'].isdigit():
            pid = fields[b'p']
            files[pid] = []
        elif pid is not None and b'f' in fields:
            files[pid].append(OpenFile(fields[b'f'], fields.get(b't', ''), fields.get(b'n', ''),
                                       fields.get(b'd', ''), fields.get(b'P', '')))
        else:
            raise UnverifiedStartup(LSOF_UNAVAILABLE)
    return files


def pg_unix_socket(file):
    return file.kind == 'unix' and file.name.startswith('/') and Path(file.name).name == PG_SOCKET


def pg_connection(file, unix_peers):
    if file.kind == 'unix':
        return pg_unix_socket(file) or (file.name.startswith('->') and file.name[2:] in unix_peers)
    if file.protocol != 'TCP' or '->' not in file.name:
        return False
    host, _, port = file.name.rsplit('->', 1)[1].rpartition(':')
    if port != PG_PORT:
        return False
    try:
        address = ipaddress.ip_address(host.strip('[]'))
    except ValueError:
        raise UnverifiedStartup(LSOF_UNAVAILABLE) from None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return address.is_loopback


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
            known[child] = {'started': process_started(int(child)), 'command': processes[child][1]}
        except OSError:
            if alive(child):
                raise
        pending.extend(children.get(child, ()))
    if known.get(pid, {}).get('started') != root_start or process_started(int(pid)) != root_start:
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
            or (port is not None and port < 1) or any(ord(char) <= 32 for char in value)):
        raise UnverifiedStartup('DATABASE_URL 无法核实。请核查连接串使用明确的主机、端口和单一库名。')
    if target.path[1:] == db:
        if host in (None, '127.0.0.1', 'localhost', '::1') or unix_dsn_host(host):
            return True
        raise UnverifiedStartup('DATABASE_URL 使用非标准主机且库名与目标相同。请把 DSN 改成标准本机地址，或确认这个进程不连目标库。')
    if host and any(char in host for char in '%,') and not unix_dsn_host(host):
        raise UnverifiedStartup('DATABASE_URL 无法核实。请核查连接串使用明确的主机、端口和单一库名。')
    return False


def unix_dsn_host(host):
    # libpq accepts a percent-encoded absolute socket directory in the host field.
    if not re.match(r'%2[fF]', host) or re.search(r'%(?![a-fA-F0-9]{2})', host):
        return False
    try:
        directory = unquote(host, errors='strict')
    except UnicodeDecodeError:
        return False
    return (directory.startswith('/') and not directory.startswith('//') and directory == os.path.normpath(directory)
            and not any(ord(char) < 32 for char in directory))


def scan_processes(db, roots, known_tree, *web_settings):
    def scoped(path):
        resolved = Path(path).resolve()
        return any(resolved.is_relative_to(root) for root in scope)

    def scoped_argument(arg, here):
        path = arg.split('=', 1)[1] if arg.startswith('-') and '=' in arg else arg
        return ((path.startswith('/') and scoped(path))
                or (here is not None and path.startswith(('./', '../')) and scoped(here / path)))

    scope = [Path(root).resolve() for root in roots.split('|')]
    known = json.loads(known_tree)
    web = verified_web_launch(db, *web_settings)
    processes, files = ps(), process_files()
    unix_peers = {file.device for entries in files.values() for file in entries
                  if file.device and pg_unix_socket(file)}
    ancestors, pid = set(), str(os.getpid())
    while pid in processes and pid not in ancestors:
        ancestors.add(pid)
        pid = processes[pid][0]

    def classify(pid, name, entries):
        if pid in known:
            try:
                if process_started(int(pid)) == known[pid]['started']:
                    return False, WORKER_DESCENDANT
            except OSError:
                if alive(pid):
                    return False, ENV_UNAVAILABLE
            if pid not in processes:
                return True, '已记录的进程在本次采样中已退出。'
        cwd = next((file.name for file in entries if file.descriptor == 'cwd' and file.name.startswith('/')), None)
        here = Path(cwd) if cwd else None
        try:
            observed, args, inherited, start = observe_process(int(pid))
        except (OSError, ValueError, struct.error):
            if here is None and not alive(pid):
                return True, '进程在检查启动信息时已退出。'
            observed, inherited = '', None
        node = name == 'node' or Path(observed).name == 'node' or (web and pid == web[0])
        if not inherited:
            if node:
                return False, ENV_UNAVAILABLE
            if here is None or any(
                    not file.name or file.descriptor in ('err', 'NOFD') or (
                        not file.name.startswith('/') and (
                            'info error:' in file.name
                            or file.name.startswith(('Permission denied', 'Operation not permitted'))
                        )
                    ) for file in entries):
                return False, LSOF_UNAVAILABLE
            if scoped(here):
                return False, '启动环境不可见，lsof 显示工作目录属于目标。'
            if any(file.name.startswith('/') and scoped(file.name) for file in entries):
                return False, '启动环境不可见，lsof 显示打开文件属于目标。'
            if any(pg_connection(file, unix_peers) for file in entries):
                return False, '启动环境不可见，lsof 显示本机 PostgreSQL 5434 端点连接。'
            return True, '启动环境不可见，lsof 未见目标工作目录、打开文件或 PG 连接，且不属于已记录 Worker 子树。'
        if not node:
            if targets_database(inherited.get('DATABASE_URL', ''), db):
                return False, 'DATABASE_URL 指向目标库。请核查该进程已退出。'
            if ((here is not None and scoped(here)) or (Path(observed).is_absolute() and scoped(observed))
                    or any(scoped_argument(arg, here) for arg in args)):
                return False, '启动路径或工作目录属于目标。请核查该进程已退出。'
            return True, '可读启动环境与观测到的路径未指向目标。'
        if here is None or not canonical(here) or not here.is_dir():
            return False, 'Node 工作目录无法核实。请按 PID 核查 cwd。'
        if Path(observed).resolve() != PINNED_NODE.resolve():
            return False, 'Node 不是当前工具可核实的固定运行时。请按 PID 核查运行时。'
        if not args or (args[0] != 'node' and not Path(args[0]).is_absolute()):
            return False, 'Node 的启动入口无法核实。请按 PID 核查启动命令。'
        try:
            index, env_files = plain_node_options(args[1:], allow_env_files=True)
            script = Path(args[index + 1])
        except (ValueError, IndexError):
            return False, 'Node 启动参数无法确认为普通文件启动。请按 PID 核查入口前的选项。'
        if (script.suffix not in ('.js', '.mjs', '.cjs') or not canonical(script)
                or not launch_file(script.stat(), start)):
            return False, 'Node 入口无法核实为启动时的规范绝对文件。请按 PID 核查入口路径。'
        if not ordinary_script_arguments(script, args[index + 2:]):
            return False, 'Node 入口后的参数不属于已核实的启动方式。请按 PID 核查入口后的参数。'
        try:
            environment = effective_environment(start, inherited, env_files)
        except UnverifiedStartup:
            raise
        except (ValueError, OSError, subprocess.SubprocessError):
            return False, 'Node 环境文件或启动环境无法核实。请按 PID 核查 --env-file 和加载选项。'
        database = targets_database(environment.get('DATABASE_URL', ''), db)
        if web and pid == web[0] and args == web[1] and here == web[2] and script == web[3]:
            return True, '已核实为当前 release 的 Web 进程。'
        if database:
            return False, 'DATABASE_URL 指向目标库。请核查该进程已退出。'
        if scoped(here) or scoped(script) or any(map(scoped, env_files)):
            return False, 'Node 入口、工作目录或环境文件属于目标。'
        return True, '已核实普通 Node 文件启动，入口与启动环境未指向目标。'

    observations = []
    # A known descendant missing from the current UID list may still be alive.
    for pid in sorted((processes.keys() | known.keys()) - ancestors, key=int):
        name = processes[pid][1] if pid in processes else known[pid]['command']
        try:
            allowed, reason = classify(pid, name, files.get(pid, ()))
        except UnverifiedStartup as error:
            allowed, reason = False, str(error)
        except (OSError, RuntimeError, ValueError, IndexError, AttributeError, subprocess.SubprocessError):
            allowed, reason = False, '启动参数或文件来源无法核实。请按 PID 核查实际入口和环境文件。'
        command = ''.join(char if char.isprintable() else '?' for char in name)
        observations.append({'pid': int(pid), 'command': command, 'allowed': allowed, 'reason': reason})
    return observations


def main(report_path, *arguments):
    report_path = Path(report_path)
    try:
        observations = scan_processes(*arguments)
    except UnverifiedStartup as error:
        reason = str(error)
    except (OSError, ValueError, subprocess.SubprocessError):
        reason = '无法完整读取进程清单。请核查本机进程观测权限。'
    else:
        allowed = sum(row['allowed'] for row in observations)
        report = {'status': 'complete', 'total': len(observations), 'allowed': allowed,
                  'blocked': len(observations) - allowed, 'processes': observations}
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        for row in observations:
            if not row['allowed']:
                print(row['pid'], row['command'], row['reason'])
        return
    report_path.write_text(json.dumps({'status': 'error', 'reason': reason}, ensure_ascii=False) + '\n', encoding='utf-8')
    sys.exit(reason)


if __name__ == '__main__':
    action, *arguments = sys.argv[1:]
    if action == 'worker-tree':
        worker_tree(*arguments)
    elif action == 'scan':
        main(*arguments)
    else:
        sys.exit('unknown process inspection')
