import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
} from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

function requireEmpty(condition, reason) {
  if (!condition) throw new Error('Template guest rejected: ' + reason);
}

export function assertEmptyGuest(state, { dsh, controls, pageSize }) {
  requireEmpty(
    state.work.length === 0 && state.privateEntries.length === 0,
    'residual tenant directory or file',
  );
  requireEmpty(state.seeds.length === 0, 'persistent seed or host key');
  requireEmpty(
    state.inet.length === 0 && state.unix.length === 0,
    'network listener or socket',
  );
  requireEmpty(state.swap.length === 0, 'active swap');
  const external = new Map([
    ['/work', 'virtiofs'],
    [dsh, 'ext4'],
    [controls, 'virtiofs'],
  ]);
  const builtin = new Map([
    ['/', ['ext4']],
    ['/dev', ['devtmpfs', 'tmpfs']],
    ['/dev/pts', ['devpts']],
    ['/dev/shm', ['tmpfs']],
    ['/proc', ['proc']],
    ['/sys', ['sysfs']],
    ['/sys/fs/cgroup', ['cgroup2']],
    ['/run', ['tmpfs']],
    ['/tmp', ['tmpfs']],
    ['/.msb', ['tmpfs']],
    ['/sys/kernel/security', ['securityfs']],
  ]);
  const mounts = new Set();
  for (const { path, type, flags } of state.mounts) {
    requireEmpty(!mounts.has(path), 'duplicate mount');
    mounts.add(path);
    if (external.has(path)) {
      requireEmpty(
        type === external.get(path) &&
          flags.includes(path === '/work' ? 'rw' : 'ro'),
        'unapproved external mount',
      );
    } else
      requireEmpty(
        builtin.get(path)?.includes(type),
        'unexpected template mount',
      );
  }
  requireEmpty(
    mounts.has('/') && [...external.keys()].every((path) => mounts.has(path)),
    'required mount absent',
  );
  const allowedEnv = new Set([
    'HOME',
    'HOSTNAME',
    'PATH',
    'LANG',
    'LC_ALL',
    'PWD',
    'TERM',
    'USER',
    'LOGNAME',
    'SHLVL',
    'TMPDIR',
    'NODE_VERSION',
    'YARN_VERSION',
  ]);
  requireEmpty(state.processes.length === 2, 'unexpected guest process count');
  const agent = state.processes.find(({ task }) => task === 'agent');
  const audit = state.processes.find(({ task }) => task === 'audit');
  requireEmpty(agent && audit, 'unexpected guest process');
  for (const process of state.processes) {
    requireEmpty(
      process.cwd === '/' && process.env.every((key) => allowedEnv.has(key)),
      'unexpected process working directory or environment',
    );
    requireEmpty(
      process.fds.every((target) =>
        /^(?:pipe:\[\d+\]|socket:\[\d+\]|anon_inode:\[[\w-]+\]|\/dev\/(?:null|zero|random|urandom|console|tty|ttyS0|hvc0|vsock))$/.test(
          target,
        ),
      ),
      'unapproved open descriptor',
    );
  }
  requireEmpty(state.pageSize === pageSize, 'guest ABI page size mismatch');
  return {
    version: 1,
    workEmpty: true,
    approvedMounts: true,
    approvedProcessesAndDescriptors: true,
    noTenantFiles: true,
    noSeedFiles: true,
    noInetSockets: true,
    noSwap: true,
    pageSize,
  };
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function entries(path) {
  try {
    requireEmpty(
      lstatSync(path).isDirectory(),
      'unexpected guest directory type',
    );
    return readdirSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function collect() {
  const privateEntries = [
    '/workspaces',
    '/workbench',
    '/data',
    '/srv',
    '/mnt',
    '/root/.ssh',
    '/home/node/.ssh',
    '/root/.config',
    '/root/.dsh',
    '/home/node/.dsh',
  ].flatMap(entries);
  const homeEntries = new Set(['.bashrc', '.profile', '.bash_logout']);
  privateEntries.push(
    ...entries('/root').filter((name) => !homeEntries.has(name)),
    ...entries('/home').filter((name) => name !== 'node'),
    ...entries('/home/node').filter((name) => !homeEntries.has(name)),
    ...entries('/tmp'),
  );
  const seeds = [
    '/var/lib/systemd/random-seed',
    '/var/lib/urandom/random-seed',
    '/etc/random-seed',
    '/var/lib/random-seed',
    '/root/.rnd',
    '/home/node/.rnd',
    '/run/systemd/random-seed',
    '/.msb/tls/ca.pem',
    '/.msb/tls/host-cas.pem',
  ].filter(exists);
  seeds.push(
    ...entries('/etc/ssh').filter((name) => name.startsWith('ssh_host_')),
  );
  const inet = ['tcp', 'tcp6', 'udp', 'udp6', 'raw', 'raw6'].flatMap((family) =>
    read('/proc/net/' + family)
      .trim()
      .split('\n')
      .slice(1),
  );
  // Abstract Unix names are counted as well. Agent control uses vsock.
  const unix = read('/proc/net/unix')
    .trim()
    .split('\n')
    .slice(1)
    .filter((line) => line.trim().split(/\s+/).length >= 8);
  const mounts = read('/proc/self/mountinfo')
    .trim()
    .split('\n')
    .map((line) => {
      const [details, filesystem] = line.split(' - ');
      const fields = details.split(' ');
      return {
        path: fields[4],
        type: filesystem.split(' ')[0],
        flags: fields[5].split(','),
      };
    });
  const processes = [];
  for (const pid of entries('/proc').filter((name) => /^\d+$/.test(name))) {
    const base = '/proc/' + pid;
    const status = read(base + '/status');
    if (/^Kthread:\s+1$/m.test(status)) continue;
    const executable = readlinkSync(base + '/exe');
    const task =
      pid === String(process.pid) && executable === process.execPath
        ? 'audit'
        : pid === '1' &&
            /^(?:init|agentd|microsandbox-agentd)(?: \(deleted\))?$/.test(
              basename(executable),
            )
          ? 'agent'
          : 'unrecognized';
    const fds = [];
    for (const fd of entries(base + '/fd')) {
      try {
        fds.push(readlinkSync(base + '/fd/' + fd));
      } catch (error) {
        // readdir opened the audit process's own directory descriptor temporarily.
        if (!(pid === String(process.pid) && error.code === 'ENOENT'))
          throw error;
      }
    }
    processes.push({
      task,
      cwd: readlinkSync(base + '/cwd'),
      fds,
      env: read(base + '/environ')
        .split('\0')
        .filter(Boolean)
        .map((entry) => entry.split('=')[0]),
    });
  }
  return {
    work: entries('/work'),
    privateEntries,
    seeds,
    inet,
    unix,
    mounts,
    processes,
    swap: read('/proc/swaps').trim().split('\n').slice(1),
    pageSize:
      Number(
        read('/proc/self/smaps').match(/^KernelPageSize:\s+(\d+) kB$/m)?.[1],
      ) * 1024,
  };
}

function warmPublicFile(path) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    while (readSync(fd, buffer) > 0) {
      // Read public code into the page cache without starting an employee service.
    }
  } finally {
    closeSync(fd);
  }
}

// The capture command supplies this module directly to the guest Node process.
if (
  !process.argv[1] ||
  process.argv[1] === '--audit-guest' ||
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const [, , dsh, controls, pageSize] = process.argv;
    requireEmpty(
      /^\/opt\/allrice\/dsh\/[0-9a-f]{64}$/.test(dsh) &&
        /^\/opt\/allrice\/command-memory\/[0-9a-f]{64}$/.test(controls),
      'unexpected public mount path',
    );
    warmPublicFile(dsh + '/node_modules/@deepseek-ai/dsh/lib/bin.js');
    warmPublicFile(controls + '/initialize.cjs');
    const result = assertEmptyGuest(collect(), {
      dsh,
      controls,
      pageSize: Number(pageSize),
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    console.error(
      error.message.startsWith('Template guest rejected:')
        ? error.message
        : 'Template guest observation unavailable',
    );
    process.exitCode = 1;
  }
}
