import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import Mock

script = Path(__file__).with_name('host-preflight.py')
spec = importlib.util.spec_from_file_location('host_preflight', script)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
LUKS = '11111111-2222-3333-4444-555555555555'
MAPPER_ID = 'CRYPT-LUKS2-' + LUKS.replace('-', '') + '-qa'


def mount(path, **overrides):
    result = dict(target=str(path), source='/dev/mapper/qa', fstype='xfs', uuid=UUID, options='rw,nosuid')
    device = Path(path).stat().st_dev if Path(path).exists() else None
    result['maj:min'] = f'{os.major(device)}:{os.minor(device)}' if device is not None else '253:7'
    return json.dumps({'filesystems': [{**result, **overrides}]})


class PreflightTests(unittest.TestCase):
    def test_host_matches_exact_os_arch_and_distro(self):
        ubuntu = 'ID=ubuntu\nVERSION_ID="24.04"\n'
        host.require_host('Linux', 'aarch64', ubuntu)
        for system, arch, release in (
            ('Darwin', 'arm64', ubuntu), ('Linux', 'x86_64', ubuntu),
            ('Linux', 'aarch64', ubuntu.replace('24.04', '22.04')),
        ):
            with self.assertRaisesRegex(RuntimeError, 'Ubuntu'):
                host.require_host(system, arch, release)

    def test_kvm_requires_real_api_and_joins_both_fds(self):
        open_device, ioctl, close = Mock(return_value=7), Mock(side_effect=[12, 8]), Mock()
        host.verify_kvm(1234, open_device, ioctl, close)
        self.assertEqual([c.args for c in close.call_args_list], [(8,), (7,)])
        self.assertEqual([c.args for c in ioctl.call_args_list], [(7, host.KVM_GET_API_VERSION, 0),
                                                                 (7, host.KVM_CREATE_VM, 0)])
        close.reset_mock()
        with self.assertRaisesRegex(RuntimeError, 'API version'):
            host.verify_kvm(1234, open_device, Mock(return_value=11), close)
        close.assert_called_once_with(7)
        with self.assertRaisesRegex(RuntimeError, 'non-root'):
            host.verify_kvm(0, open_device, ioctl, close)

    def test_luks_guard_requires_exact_mount_uuid_and_luks2(self):
        path = Path('/scratch')
        read = Mock(return_value=MAPPER_ID)
        host.verify_luks2(path, UUID, LUKS, Mock(return_value=mount(path)), read)
        read.assert_called_once_with('253:7')
        for override in [{'uuid': 'wrong'}, {'options': 'ro'}, {'fstype': 'ext4'}, {'source': '/dev/vdb'}]:
            with self.assertRaises(RuntimeError):
                host.verify_luks2(path, UUID, LUKS, Mock(return_value=mount(path, **override)), read)
        with self.assertRaisesRegex(RuntimeError, 'LUKS2'):
            host.verify_luks2(path, UUID, LUKS, Mock(return_value=mount(path)), Mock(return_value='CRYPT-LUKS1-wrong'))


    def test_reflink_protocol_checks_cow_and_cleans_its_scratch_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)

            def clone_or_findmnt(*args):
                if args[0] == '/usr/bin/findmnt':
                    return mount(path)
                self.assertEqual(args[:3], ('/usr/bin/cp', '--reflink=always', '--'))
                shutil.copyfile(args[3], args[4])  # Simulate a successful kernel COW command.

            host.verify_reflink(path, UUID, LUKS, clone_or_findmnt, Mock(return_value=MAPPER_ID))
            self.assertEqual(list(path.iterdir()), [])

            def reject_clone(*args):
                if args[0] == '/usr/bin/findmnt':
                    return mount(path)
                raise RuntimeError('unsupported reflink')

            with self.assertRaisesRegex(RuntimeError, 'unsupported reflink'):
                host.verify_reflink(path, UUID, LUKS, reject_clone, Mock(return_value=MAPPER_ID))
            self.assertEqual(list(path.iterdir()), [])

    def test_dependency_plan_has_no_effect_until_explicitly_applied_as_operator(self):
        command = Mock()
        args = host.install_dependencies(1000, False, command)
        self.assertIn('cryptsetup', args)
        command.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, 'operator'):
            host.install_dependencies(1000, True, command)
        command.assert_not_called()
        host.install_dependencies(0, True, command)
        command.assert_called_once_with(*args, capture=False, timeout=900)


if __name__ == '__main__':
    unittest.main()
