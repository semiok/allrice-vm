"""Identify processes that may still own schedule partitions during M1 recovery."""
import ctypes
import ipaddress
import json
import os
import plistlib
import re
import socket
import stat
import struct
import subprocess
import sys
from collections import deque
from pathlib import Path
from typing import NamedTuple
from urllib.parse import unquote, urlsplit

from service_target import canonical, dotenv_environment, service_config

# Options whose values do not choose code or its loader. Everything else is opaque.
VALUE_OPTIONS = {
    '--unhandled-rejections': r'strict|throw|warn|warn-with-error-code|none',
    '--max-http-header-size': r'[0-9]+',
    '--max-old-space-size': r'[0-9]+',
}
BOOLEAN_OPTIONS = {'--enable-source-maps', '--no-warnings', '--trace-warnings', '--trace-deprecation', '--trace-uncaught'}
BUILTIN_ACCESS_OPTION = '--expose-internals'
HTTP_PROXY_SETTING = 'NODE_USE_ENV_PROXY'
ENV_FILE_OPTIONS = {'--env-file', '--env-file-if-exists'}
WEB_OPTIONS = {'--hostname': r'127\.0\.0\.1|0\.0\.0\.0|localhost|::1?', '--port': r'[0-9]+'}
BSD_INFO = struct.Struct('=12I16s32s6IQQ')  # Darwin proc_bsdinfo, including start time
SOCKET_FDINFO_SIZE = 792  # Darwin struct socket_fdinfo from <sys/proc_info.h>
UNIX_SOCKET_FLAVOR = 3  # PROC_PIDFDSOCKETINFO
PINNED_NODE = Path.home() / '.local/opt/node-22.23.2/bin/node'
LOADER_PREFIXES = ('DYLD_', 'LD_', 'NODE_')
LOADER_SETTINGS = {'OPENSSL_CONF', 'OPENSSL_MODULES', 'OPENSSL_ENGINES'}
ENV_UNAVAILABLE = '无法读取进程启动环境。请按 PID 核查该进程的所属服务与启动环境可见性。'
WORKER_DESCENDANT = '停止前已核实为 Worker 或其子进程。请核查该进程已退出。'
LSOF_UNAVAILABLE = '无法核实 lsof 的工作目录、文件或连接。'
PG_PORT = '5434'
PG_SOCKET = '.s.PGSQL.' + PG_PORT
UNNAMED_HANDLES = {'NPOLICY', 'NEXUS', 'KQUEUE', 'PIPE'}
NON_FILE_HANDLES = UNNAMED_HANDLES | {'CHAN', 'systm', 'rte'}
PATH_FILES = {'REG', 'DIR', 'CHR', 'BLK', 'FIFO', 'LINK'}
EARLY_SOURCE_OPTIONS = ENV_FILE_OPTIONS | {'--experimental-config-file', '--experimental-default-config-file',
                                          '--require', '--import', '--loader', '--experimental-loader', '--eval',
                                          '--snapshot-blob', '--build-snapshot', '--build-snapshot-config'}


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
    ctypes.set_errno(0)
    if system.proc_pidinfo(pid, 3, 0, info, BSD_INFO.size) != BSD_INFO.size:  # PROC_PIDTBSDINFO
        raise OSError(ctypes.get_errno() or None, 'process start time unavailable')
    seconds, microseconds = BSD_INFO.unpack(info.raw)[-2:]
    return seconds * 10**9 + microseconds * 1000


def observe_process(pid):
    """Get discrete exec arguments and environment without replaying the command."""
    system = ctypes.CDLL(None, use_errno=True)
    start = process_started(pid)
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    length = ctypes.c_size_t()
    ctypes.set_errno(0)
    if system.sysctl(mib, 3, None, ctypes.byref(length), None, 0) or not length.value:
        raise OSError(ctypes.get_errno() or None, 'process arguments unavailable')
    data = ctypes.create_string_buffer(length.value)
    ctypes.set_errno(0)
    if system.sysctl(mib, 3, data, ctypes.byref(length), None, 0):
        raise OSError(ctypes.get_errno() or None, 'process arguments unavailable')
    if process_started(pid) != start:
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


def plain_node_options(args, allow_env_files, *, recognize_builtin_access=False):
    files = []
    i = 0
    while i < len(args) and args[i].startswith('-'):
        if args[i] == '--' and allow_env_files:
            return i + 1, files
        key, eq, value = args[i].partition('=')
        i += 1
        if not eq and (key in BOOLEAN_OPTIONS or (recognize_builtin_access and key == BUILTIN_ACCESS_OPTION)):
            continue
        is_env_file = key in ENV_FILE_OPTIONS and allow_env_files
        if key not in VALUE_OPTIONS and not is_env_file:
            if key in ('-r', '--require', '--import'):
                raise UnverifiedStartup(f'Node 入口前的 {key} 会预加载模块。请按 PID 核查加载来源。')
            kind = 'long' if key.startswith('--') else 'short'
            raise ValueError(f'unrecognized {kind} startup option')
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


def ordinary_node_entry(script, start, scope):
    """Verify a disjoint file entry, including an unchanged launcher symlink."""
    resolved = script.resolve(strict=True)
    if resolved.suffix not in ('.js', '.mjs', '.cjs') or any(
            path.is_relative_to(root) for path in (script, resolved) for root in scope):
        return None
    target = resolved.stat()
    if resolved == script:
        return 'direct file' if stat.S_ISREG(target.st_mode) else None
    if '..' in script.parts or not launch_file(target, start):
        return None

    # A launcher alias retargeted after exec says nothing about its original entry.
    def identity(st):
        return st.st_dev, st.st_ino, st.st_ctime_ns

    parent = Path(script.anchor)
    parts = deque(script.parts[1:])
    links = {}
    while parts:
        component = parts.popleft()
        if component == '..':
            parent = parent.parent
            continue
        path = parent / component
        if any(path.is_relative_to(root) for root in scope):
            return None
        info = path.lstat()
        if not stat.S_ISLNK(info.st_mode):
            parent = path
            continue
        if info.st_ctime_ns > start or path in links or len(links) >= 40:
            return None
        links[path] = identity(info)
        destination = path.readlink()
        if destination.is_absolute():
            parent = Path(destination.anchor)
        parts.extendleft(reversed(destination.parts[1:] if destination.is_absolute() else destination.parts))
    if (links and parent == resolved and script.resolve(strict=True) == resolved
            and all(identity(path.lstat()) == saved for path, saved in links.items())
            and identity(resolved.stat()) == identity(target)):
        return 'symlink verified at startup'
    return None


def node_options_kind(raw_options):
    if not raw_options:
        return 'empty'
    # The small scalar whitelist needs no quoting or escape interpretation.
    if re.fullmatch(r'[a-z0-9 =-]*', raw_options):
        options = raw_options.split()
        try:
            i, _ = plain_node_options(options, allow_env_files=False)
        except ValueError:
            pass
        else:
            if i == len(options):
                return 'recognized neutral options'
    return 'unverified'


def loader_categories(environment, *, neutral_settings=()):
    categories = {prefix for key, value in environment.items()
                  if value and key not in ('NODE_ENV', 'NODE_OPTIONS') and key not in neutral_settings
                  for prefix in LOADER_PREFIXES if key.startswith(prefix)}
    if any(environment.get(key) for key in LOADER_SETTINGS):
        categories.add('OpenSSL')
    return sorted(categories)


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
    if node_options_kind(environment.get('NODE_OPTIONS', '')) == 'unverified' or loader_categories(environment):
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
    except OSError as error:
        raise UnverifiedStartup(lsof_problem('无法执行 lsof', errno=error.errno)) from None
    except subprocess.SubprocessError:
        raise UnverifiedStartup(lsof_problem('lsof 未完成观测')) from None
    if result.returncode != 0 or result.stderr:
        diagnostic = os.fsdecode(result.stderr)
        returncode = f'退出码 {result.returncode}' if result.returncode else '报告诊断'
        raise UnverifiedStartup(lsof_problem(f'lsof {returncode}', diagnostic=diagnostic))
    if result.stdout and not result.stdout.endswith(b'\0\n'):
        raise UnverifiedStartup(lsof_problem('lsof 字段记录不完整'))
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
            raise UnverifiedStartup(lsof_problem('lsof 字段记录不完整'))
    return files


def lsof_problem(reason, file_type=None, diagnostic='', errno=None):
    if file_type is not None:
        label = file_type if re.fullmatch(r'[a-zA-Z0-9_-]{1,20}', file_type) else '未提供或无法识别'
        reason += f'（TYPE={label}）'
    if any(error in diagnostic for error in ('Permission denied', 'Operation not permitted')):
        reason += '，lsof 报告权限错误'
    if errno is None:
        reported = re.search(r'\berrno\s*[=:]\s*([0-9]+)', diagnostic)
        errno = reported.group(1) if reported else None
    detail = f'errno={errno}' if errno is not None else '系统未提供 errno'
    return f'{LSOF_UNAVAILABLE} {reason}。{detail}。'


def pg_unix_socket(file):
    return file.kind == 'unix' and file.name.startswith('/') and Path(file.name).name == PG_SOCKET


def unix_address(info, offset):
    length, family = info[offset:offset + 2]  # sockaddr_un.sun_len and sun_family
    if (length, family) == (0, 0):
        return ''
    if not 2 <= length <= 106 or family != socket.AF_UNIX:
        raise ValueError('Unix 套接字地址格式无法核实')
    name, _, padding = info[offset + 2:offset + length].partition(b'\0')
    if not name and any(padding):
        raise ValueError('Unix 套接字名称格式无法核实')
    return os.fsdecode(name)


def observe_unix_socket(pid, file):
    """Read a candidate's own socket, including the peer address held by the kernel."""
    if not file.descriptor.isdecimal() or not re.fullmatch(r'0x[a-fA-F0-9]+', file.device):
        raise ValueError('Unix 套接字缺少可核实的 FD 或 PCB 标识')
    system = ctypes.CDLL(None, use_errno=True)
    start = process_started(pid)
    buffer = ctypes.create_string_buffer(SOCKET_FDINFO_SIZE)
    ctypes.set_errno(0)
    size = system.proc_pidfdinfo(pid, int(file.descriptor), UNIX_SOCKET_FLAVOR, buffer, SOCKET_FDINFO_SIZE)
    if size != SOCKET_FDINFO_SIZE:
        raise OSError(ctypes.get_errno() or None, 'proc_pidfdinfo socket read failed')
    info = buffer.raw
    # socket_info fields, then un_sockinfo inside socket_info.soi_proto.
    pcb = struct.unpack_from('=Q', info, 168)[0]
    family = struct.unpack_from('=i', info, 184)[0]
    state = struct.unpack_from('=H', info, 192)[0]
    kind = struct.unpack_from('=i', info, 256)[0]
    peer = struct.unpack_from('=Q', info, 272)[0]
    if ((family, kind) != (socket.AF_UNIX, 3) or pcb != int(file.device, 16)
            or process_started(pid) != start):
        raise ValueError('Unix 套接字身份在采样中无法核实')
    if file.name in ('->(none)', '(none)'):
        same_peer = not peer
    elif file.name.startswith('->'):
        same_peer = bool(re.fullmatch(r'->0x[a-fA-F0-9]+', file.name) and peer == int(file.name[2:], 16))
    else:
        same_peer = not file.name
    if not same_peer:
        raise ValueError('Unix 套接字对端在采样中无法核实')
    local, remote = unix_address(info, 280), unix_address(info, 535)
    target = any(name and Path(name).name == PG_SOCKET for name in (local, remote))
    connected = bool(state & 2)
    # Keep transitional states uncertain unless a target address is already visible.
    if not target and (state & (4 | 8) or connected != bool(peer) or (remote and not connected)):
        raise ValueError('Unix 套接字连接状态无法核实')
    return {'connected': connected, 'localNamed': bool(local), 'peerNamed': bool(remote), 'targetPg': target}


def internet_endpoint(value):
    host, separator, port = value.rpartition(':')
    if not separator or not host or not re.fullmatch(r'\*|[0-9]{1,5}', port):
        raise ValueError('invalid address')
    address = None if host == '*' else ipaddress.ip_address(host.strip('[]').split('%', 1)[0])
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    if port != '*' and int(port) > 65535:
        raise ValueError('invalid port')
    return address, port


def pg_connection(pid, file, unix_devices, evidence):
    if file.kind == 'unix':
        table = {'type': 'unix', 'source': 'lsof'}
        if file.name.startswith('/'):
            target = pg_unix_socket(file)
            evidence.append(dict(table, localNamed=True, targetPg=target))
            return target
        peer = unix_devices.get(file.name[2:]) if re.fullmatch(r'->0x[a-fA-F0-9]+', file.name) else None
        if peer and peer.name.startswith('/'):
            target = pg_unix_socket(peer)
            evidence.append(dict(table, peerNamed=True, targetPg=target))
            return target
        if peer and file.device and peer.name == '->' + file.device:
            evidence.append(dict(table, localNamed=False, peerNamed=False, connected=True, targetPg=False))
            return False  # Both observed endpoints are unnamed.
        table['source'] = 'proc_pidfdinfo'
        try:
            info = observe_unix_socket(pid, file)
        except OSError as error:
            reason = lsof_problem('本机 Unix FD 读取失败', file.kind, errno=error.errno)
            evidence.append(dict(table, error=reason, errno=error.errno))
            raise UnverifiedStartup(reason) from None
        except ValueError as error:
            reason = lsof_problem(str(error), file.kind)
            evidence.append(dict(table, error=reason, errno=None))
            raise UnverifiedStartup(reason) from None
        evidence.append(dict(table, **info))
        return info['targetPg']
    if file.kind not in ('IPv4', 'IPv6'):
        return False
    try:
        if file.protocol not in ('TCP', 'UDP'):
            raise ValueError('unknown protocol')
        local, arrow, remote = file.name.partition('->')
        internet_endpoint(local)
        if not arrow:
            return False
        address, port = internet_endpoint(remote)
        if address is None or port == '*':
            raise ValueError('incomplete peer')
        return port == PG_PORT and address.is_loopback
    except ValueError:
        raise UnverifiedStartup(lsof_problem('TCP/UDP 连接记录不完整', file.kind)) from None


def file_gap(file):
    if file.descriptor in ('err', 'NOFD') or (not file.name.startswith('/') and (
            'info error:' in file.name or file.name.startswith(('Permission denied', 'Operation not permitted')))):
        return lsof_problem('lsof 记录了逐 PID 文件读取错误', file.kind, file.name)
    if file.kind in ('unix', 'IPv4', 'IPv6'):
        return None  # Endpoint completeness is checked by pg_connection.
    if file.kind in PATH_FILES:
        return None if file.name.startswith('/') else lsof_problem('文件路径无法核实', file.kind)
    if file.kind in NON_FILE_HANDLES:
        if file.name or file.kind in UNNAMED_HANDLES:
            return None
        return lsof_problem('此句柄没有可核实的名称', file.kind)
    return lsof_problem('未识别的文件描述符类型', file.kind)


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
    unix_devices = {}
    for entries in files.values():
        for file in entries:
            if file.kind == 'unix' and file.device and (file.device not in unix_devices or pg_unix_socket(file)):
                unix_devices[file.device] = file
    ancestors, pid = set(), str(os.getpid())
    while pid in processes and pid not in ancestors:
        ancestors.add(pid)
        pid = processes[pid][0]

    def classify(pid, name, entries, evidence):
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
        startup_status, startup_errno = 'read', None
        try:
            observed, args, inherited, start = observe_process(int(pid))
        except (OSError, ValueError, struct.error) as error:
            if here is None and not alive(pid):
                return True, '进程在检查启动信息时已退出。'
            startup_status = 'read failed' if isinstance(error, OSError) else 'startup record incomplete'
            startup_errno = getattr(error, 'errno', None)
            observed, inherited = '', None
        node = name == 'node' or Path(observed).name == 'node' or (web and pid == web[0])
        if node:
            facts = {'type': 'node', 'environment': startup_status if inherited or startup_status != 'read' else 'empty',
                     'errno': startup_errno, 'cwdVisible': here is not None}
            evidence['startup'] = facts
        if not inherited:
            if node:
                return False, ENV_UNAVAILABLE
            if here is not None and scoped(here):
                return False, '启动环境不可见，lsof 显示工作目录属于目标。'
            if any(file.name.startswith('/') and scoped(file.name) for file in entries):
                return False, '启动环境不可见，lsof 显示打开文件属于目标。'
            gaps = [lsof_problem('未看到此进程的可核实 cwd', '')] if here is None else []
            sockets = []
            for file in entries:
                problem = file_gap(file)
                if problem:
                    gaps.append(problem)
                    continue
                try:
                    if pg_connection(int(pid), file, unix_devices, sockets):
                        if sockets:
                            evidence['unixSockets'] = sockets
                        return False, '启动环境不可见，套接字观测命中本机 PostgreSQL 5434 端点。'
                except UnverifiedStartup as error:
                    gaps.append(str(error))
            if sockets:
                evidence['unixSockets'] = sockets
            if gaps:
                return False, ' '.join(dict.fromkeys(gaps))
            return True, '启动环境不可见，文件和套接字观测未见目标目录、打开文件或 PG 连接，且不属于已记录 Worker 子树。'
        if not node:
            if targets_database(inherited.get('DATABASE_URL', ''), db):
                return False, 'DATABASE_URL 指向目标库。请核查该进程已退出。'
            if ((here is not None and scoped(here)) or (Path(observed).is_absolute() and scoped(observed))
                    or any(scoped_argument(arg, here) for arg in args)):
                return False, '启动路径或工作目录属于目标。请核查该进程已退出。'
            return True, '可读启动环境与观测到的路径未指向目标。'
        values = (*args, *inherited.keys(), *inherited.values())
        source_keys = {arg.partition('=')[0].replace('_', '-') for arg in args[1:]}
        source_option = bool(source_keys & EARLY_SOURCE_OPTIONS) or any(
            arg.startswith(('-r', '-e', '-p')) and not arg.startswith('--') for arg in args[1:])
        # This setting selects HTTP(S) proxy behavior without selecting startup code.
        neutral_settings = (HTTP_PROXY_SETTING,) if inherited.get(HTTP_PROXY_SETTING) in ('0', '1') else ()
        facts.update(targetDatabaseMarker=any(db in value for value in values),
                     targetPortMarker=any(PG_PORT in value for value in values),
                     targetPathMarker=any(str(root) in value for value in values for root in scope),
                     envFileFlag=bool(source_keys & ENV_FILE_OPTIONS), extraCodeSourceFlag=source_option,
                     nodeOptions=node_options_kind(inherited.get('NODE_OPTIONS', '')),
                     loaderEnvironment=loader_categories(inherited, neutral_settings=neutral_settings))
        if neutral_settings:
            facts['recognizedSettings'] = {HTTP_PROXY_SETTING: 'configures HTTP(S) proxy behavior'}
        if inherited.get('NODE_PATH'):
            facts['recognizedLoadingControls'] = {'NODE_PATH': 'adds module search directories'}
        if here is None or not canonical(here) or not here.is_dir():
            return False, 'Node 工作目录无法核实。请按 PID 核查 cwd。'
        facts['cwdOutsideTarget'] = not scoped(here)
        if not args or (args[0] != 'node' and not Path(args[0]).is_absolute()):
            return False, 'Node 的启动入口无法核实。请按 PID 核查启动命令。'
        try:
            index, env_files = plain_node_options(args[1:], allow_env_files=True, recognize_builtin_access=True)
            script = Path(args[index + 1])
        except UnverifiedStartup:
            raise
        except ValueError as error:
            facts['startupOptions'] = str(error)
            return False, 'Node 启动参数无法确认为普通文件启动，入口前的选项可能改变代码来源。请按 PID 核查。'
        except IndexError:
            facts['startupOptions'] = 'entry missing'
            return False, 'Node 缺少可核实的普通文件入口。请按 PID 核查。'
        facts['startupOptions'] = 'recognized'
        builtin_access = BUILTIN_ACCESS_OPTION in args[1:index + 1]
        if builtin_access:
            facts['recognizedOptions'] = {BUILTIN_ACCESS_OPTION: 'allows the entry to require built-in internal modules'}
        facts['entryForm'] = 'absolute' if script.is_absolute() else 'relative'
        if not script.is_absolute():
            script = here / script
        facts['entryOutsideTarget'] = not scoped(script)
        if 'recognizedLoadingControls' in facts:
            return False, 'Node 启动环境的 NODE_PATH 增加模块搜索目录。请按 PID 核查加载来源。'
        # Node can read env/config options even after an apparent script entry.
        if (not env_files and not source_option and facts['cwdOutsideTarget'] and facts['entryOutsideTarget']
                and not any(scoped_argument(arg, here) for arg in args[1:])
                and not any(facts[key] for key in ('targetDatabaseMarker', 'targetPortMarker', 'targetPathMarker'))):
            if not targets_database(inherited.get('DATABASE_URL', ''), db):
                entry = ordinary_node_entry(script, start, scope)
                if facts['nodeOptions'] == 'unverified' or facts['loaderEnvironment']:
                    return False, 'Node 启动环境含无法核实作用的加载设置。请按 PID 核查运行时的启动环境。'
                if entry:
                    facts['ordinaryEntry'] = entry
                    return True, '可读的普通 Node 启动未见目标库、5434、目标路径或额外代码来源。'
        if builtin_access:
            return False, 'Node 启用了内置模块访问，尚未核实其启动范围与恢复目标分离。'
        if Path(observed).resolve() != PINNED_NODE.resolve():
            return False, 'Node 使用其他运行时且无法凭可读的启动证据排除归属。请按 PID 核查。'
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
        evidence = {}
        try:
            allowed, reason = classify(pid, name, files.get(pid, ()), evidence)
        except UnverifiedStartup as error:
            allowed, reason = False, str(error)
        except (OSError, RuntimeError, ValueError, IndexError, AttributeError, subprocess.SubprocessError):
            allowed, reason = False, '启动参数或文件来源无法核实。请按 PID 核查实际入口和环境文件。'
        command = ''.join(char if char.isprintable() else '?' for char in name)
        row = {'pid': int(pid), 'command': command, 'allowed': allowed, 'reason': reason}
        if evidence:
            row['evidence'] = evidence
        observations.append(row)
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
