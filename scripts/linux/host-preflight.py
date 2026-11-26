#!/usr/bin/env python3
"""Prepare and check the Ubuntu arm64 test host without provisioning any volume."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import tempfile

PACKAGES = (
    'acl', 'ca-certificates', 'cryptsetup', 'e2fsprogs',
    'util-linux', 'xfsprogs', 'jq',
)
KVM_GET_API_VERSION = 0xAE00
KVM_CREATE_VM = 0xAE01
DATA_MOUNT = '/var/lib/allrice40'
FS_UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')


def require_host(system, machine, release):
    fields = {}
    for line in release.splitlines():
        key, sep, value = line.partition('=')
        if sep:
            fields[key] = value.strip('"')
    if (system, machine, fields.get('ID'), fields.get('VERSION_ID')) != (
        'Linux', 'aarch64', 'ubuntu', '24.04',
    ):
        raise RuntimeError('Ubuntu 24.04 on aarch64 is required')


def run(*args, capture=True, timeout=15):
    result = subprocess.run(
        args, check=False, text=True, timeout=timeout,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.DEVNULL if capture else None,
    )
    if result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} failed (exit {result.returncode})')
    return result.stdout


def require_path(value):
    path = Path(value)
    if not path.is_absolute() or str(path) != value or path.resolve(strict=True) != path:
        raise RuntimeError('a canonical existing absolute path is required')
    return path


def read_mount(path, expected_uuid, command=run):
    if not FS_UUID.fullmatch(expected_uuid):
        raise RuntimeError('an explicit filesystem UUID is required')
    data = json.loads(command(
        '/usr/bin/findmnt', '--json', '--mountpoint', str(path),
        '--output', 'TARGET,SOURCE,FSTYPE,UUID,OPTIONS',
    ))
    entries = data.get('filesystems')
    if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
        raise RuntimeError('expected one exact mount')
    mount = entries[0]
    if (mount.get('target') != str(path) or mount.get('uuid') != expected_uuid or
            'rw' not in str(mount.get('options', '')).split(',')):
        raise RuntimeError('mount identity or writable state mismatch')
    return mount


def verify_luks2(path, expected_uuid, command=run):
    mount = read_mount(path, expected_uuid, command)
    source = mount.get('source')
    if (mount.get('fstype') != 'xfs' or not isinstance(source, str) or
            not re.fullmatch(r'/dev/(mapper/[A-Za-z0-9_-]+|dm-[0-9]+)', source)):
        raise RuntimeError('the separate scratch volume must be XFS on dm-crypt')
    status = command('/usr/sbin/cryptsetup', 'status', source)
    if not re.search(r'^\s*type:\s*LUKS2\s*$', status, re.M):
        raise RuntimeError('scratch mapper is not confirmed LUKS2')
    return mount


def verify_kvm(uid, open_device=os.open, ioctl=fcntl.ioctl, close=os.close):
    if uid == 0:
        raise RuntimeError('KVM must be tested as the non-root Worker user')
    fd = open_device('/dev/kvm', os.O_RDWR | os.O_CLOEXEC)
    try:
        if ioctl(fd, KVM_GET_API_VERSION, 0) != 12:
            raise RuntimeError('unexpected KVM API version')
        vm = ioctl(fd, KVM_CREATE_VM, 0)
        close(vm)
    finally:
        close(fd)


def verify_reflink(path, expected_uuid, command=run):
    mount = read_mount(path, expected_uuid, command)
    if mount.get('fstype') != 'xfs':
        raise RuntimeError('expected XFS for the reflink check')
    # Do not accept a global sample on a different mount or cp's fallback mode.
    # Use a unique directory on the explicit disposable XFS test filesystem.
    with tempfile.TemporaryDirectory(prefix='.allrice-reflink-', dir=path) as directory:
        source = Path(directory) / 'source'
        clone = Path(directory) / 'clone'
        data = b'fixture before copy' * 4096
        source.write_bytes(data)
        command('/usr/bin/cp', '--reflink=always', '--', str(source), str(clone))
        if clone.read_bytes() != data or clone.stat().st_ino == source.stat().st_ino:
            raise RuntimeError('strict reflink contents or inode mismatch')
        with clone.open('r+b') as file:
            file.write(b'changed')
        if source.read_bytes() != data or clone.read_bytes() == data:
            raise RuntimeError('strict reflink did not isolate the write')


def install_dependencies(uid, apply, command=run):
    args = ('/usr/bin/apt-get', 'install', '--no-install-recommends', '--', *PACKAGES)
    if apply:
        if uid != 0:
            raise RuntimeError('dependency installation requires the host operator')
        command(*args, capture=False, timeout=900)
    return args


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    install = actions.add_parser('install-deps')
    install.add_argument('--apply', action='store_true')
    for action in ('check-luks', 'check-runtime'):
        check = actions.add_parser(action)
        check.add_argument('--scratch-mount', required=True)
        check.add_argument('--scratch-uuid', required=True)
        if action == 'check-runtime':
            check.add_argument('--data-uuid', required=True)
            check.add_argument('--node', required=True)
            check.add_argument('--msb', required=True)
    args = parser.parse_args()
    require_host(platform.system(), platform.machine(), Path('/etc/os-release').read_text())

    if args.action == 'install-deps':
        command = install_dependencies(os.geteuid(), args.apply)
        print(json.dumps({'apt': command, 'applied': args.apply}))
        return

    scratch = require_path(args.scratch_mount)
    if str(scratch) == '/' or scratch == Path(DATA_MOUNT) or Path(DATA_MOUNT) in scratch.parents:
        raise RuntimeError('a separate disposable mount is required')
    if args.action == 'check-luks':
        verify_luks2(scratch, args.scratch_uuid)
        print(json.dumps({'luks2': True, 'scratchUuid': args.scratch_uuid}))
        return

    if args.data_uuid == args.scratch_uuid:
        raise RuntimeError('data and scratch filesystems must differ')
    read_mount(require_path(DATA_MOUNT), args.data_uuid)
    verify_kvm(os.geteuid())
    for required in ('/sys/fs/cgroup/cgroup.controllers', '/proc/pressure/memory'):
        if not Path(required).is_file():
            raise RuntimeError('cgroup v2 and memory PSI are required')
    verify_reflink(scratch, args.scratch_uuid)
    if run(str(require_path(args.node)), '--version').strip() != 'v22.23.2':
        raise RuntimeError('unexpected release Node version')
    msb = str(require_path(args.msb))
    if not re.search(r'\b0\.7\.16\b', run(msb, '--version')):
        raise RuntimeError('unexpected release MSB version')
    run(msb, 'doctor', timeout=60)
    print(json.dumps({'kvmApi': 12, 'reflink': True, 'msbDoctor': True,
                      'kernel': platform.release(), 'pageBytes': os.sysconf('SC_PAGE_SIZE')}))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        raise SystemExit(str(error)) from None
