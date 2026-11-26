import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

script = Path(__file__).with_name('ec2-power.py')
spec = importlib.util.spec_from_file_location('ec2_power', script)
power = importlib.util.module_from_spec(spec)
spec.loader.exec_module(power)

TARGET = {
    'account': '123456789012', 'region': 'us-east-1', 'instance': 'i-01234567890abcdef',
    'profile': 'allrice-trial', 'permissionSet': 'ScopedTrial', 'release': 'a' * 40, 'tree': 'b' * 40,
    'manifestDigest': 'sha256:' + 'c' * 64,
    'healthUrl': 'https://trial.example.com/api/health/ready',
}


def receipt():
    return {key: TARGET[key] for key in ('account', 'region', 'instance', 'release', 'tree', 'manifestDigest')}


ROLE_ARN = 'arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_ScopedTrial_0123456789abcdef/FakeSession'


def mock_aws(*states, account=TARGET['account'], tag=power.TAG_VALUE, arn=ROLE_ARN):
    upcoming = iter(states)

    def invoke(service, operation, *args):
        if (service, operation) == ('sts', 'get-caller-identity'):
            return {'Account': account, 'Arn': arn}
        if args != ('--instance-ids', TARGET['instance']):
            raise AssertionError('unexpected EC2 selector')
        if operation == 'describe-instances':
            return {'Reservations': [{'OwnerId': TARGET['account'], 'Instances': [{
                'InstanceId': TARGET['instance'], 'State': {'Name': next(upcoming)},
                'InstanceType': 'c7g.metal', 'Architecture': 'arm64', 'RootDeviceType': 'ebs',
                'Placement': {'AvailabilityZone': 'us-east-1a'},
                'Tags': [{'Key': power.TAG, 'Value': tag}],
            }]}]}
        if operation not in ('start-instances', 'stop-instances'):
            raise AssertionError('unexpected EC2 operation')
        return {}

    return Mock(side_effect=invoke)


class Ec2PowerTests(unittest.TestCase):
    def test_policy_only_grants_one_instance_writes_and_regional_reads(self):
        power.checked_target(TARGET)
        read, write = power.iam_policy(TARGET)['Statement']
        self.assertEqual(read['Action'], ['ec2:DescribeInstances'])
        self.assertEqual(read['Condition']['StringEquals']['aws:RequestedRegion'], TARGET['region'])
        self.assertEqual(write['Action'], ['ec2:StartInstances'])
        self.assertEqual(write['Condition']['StringEquals']['ec2:InstanceType'], 'c7g.metal')
        self.assertEqual(write['Condition']['StringEquals']['ec2:RootDeviceType'], 'ebs')
        self.assertEqual(write['Resource'], 'arn:aws:ec2:us-east-1:123456789012:instance/i-01234567890abcdef')

    def test_targets_are_pinned_and_redirect_like_health_urls_are_rejected(self):
        for overrides in ({'profile': 'default'}, {'instance': '*'}, {'healthUrl': 'http://trial.example.com/api/health/ready'},
                          {'healthUrl': 'https://trial.example.com@other.invalid/api/health/ready'}):
            with self.assertRaises(RuntimeError):
                power.checked_target({**TARGET, **overrides})
        aws = mock_aws(account='000000000000')
        with self.assertRaisesRegex(RuntimeError, 'account'):
            power.run_power('start', TARGET, aws)
        aws.assert_called_once_with('sts', 'get-caller-identity')
        aws = mock_aws(arn=ROLE_ARN.replace('ScopedTrial', 'Administrator'))
        with self.assertRaisesRegex(RuntimeError, 'permission set'):
            power.run_power('start', TARGET, aws)
        aws.assert_called_once_with('sts', 'get-caller-identity')
        with self.assertRaisesRegex(RuntimeError, 'test tag'):
            power.run_power('start', TARGET, mock_aws('stopped', tag='wrong'))

    def test_named_role_must_be_direct_sso_and_cannot_select_another_account(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config'
            config = '''
[profile allrice-trial]
sso_session = trial
sso_account_id = 123456789012
sso_role_name = ScopedTrial
[sso-session trial]
sso_region = us-east-1
sso_start_url = https://example.awsapps.com/start
'''
            path.write_text(config)
            power.check_sso_profile(TARGET, path)
            path.write_text(config.replace('ScopedTrial', 'Administrator'))
            with self.assertRaisesRegex(RuntimeError, 'directly select'):
                power.check_sso_profile(TARGET, path)
            path.write_text(config.replace('sso_session = trial', 'credential_process = my-script'))
            with self.assertRaisesRegex(RuntimeError, 'directly select'):
                power.check_sso_profile(TARGET, path)
            path.write_text('corrupted example access token line')
            with self.assertRaisesRegex(RuntimeError, '^AWS CLI SSO configuration is invalid$'):
                power.check_sso_profile(TARGET, path)

    def test_cli_uses_pinned_profile_and_leaves_running_stop_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            target_file = Path(directory) / 'target.json'
            target_file.write_text(json.dumps(TARGET))
            fake = mock_aws('running')
            calls = []

            def subprocess_run(args, **options):
                calls.append(args)
                self.assertEqual(args[:5], ['aws', '--profile', TARGET['profile'], '--region', TARGET['region']])
                self.assertNotIn('AWS_ACCESS_KEY_ID', options['env'])
                self.assertNotIn('AWS_ENDPOINT_URL', options['env'])
                self.assertEqual(options['env']['AWS_SHARED_CREDENTIALS_FILE'], os.devnull)
                index = args.index('--cli-read-timeout') + 2
                return SimpleNamespace(returncode=0, stdout=json.dumps(fake(*args[index:])))

            with patch.object(power, 'check_sso_profile'), patch.object(power.subprocess, 'run', subprocess_run), \
                    patch.dict(power.os.environ, {'AWS_ACCESS_KEY_ID': 'test-only', 'AWS_ENDPOINT_URL': 'test-only'}), \
                    patch('sys.argv', ['ec2-power.py', 'stop', '--target', str(target_file)]):
                with self.assertRaisesRegex(RuntimeError, 'stop deferred'):
                    power.main()
            self.assertEqual(len(calls), 2)
            self.assertNotIn('stop-instances', [arg for call in calls for arg in call])

    def test_start_waits_for_matching_ready_once_and_resumes_pending(self):
        for first in ('stopped', 'pending'):
            aws = mock_aws(first, 'pending', 'running', 'running')
            ready = Mock(side_effect=[False, True])
            self.assertEqual(power.run_power('start', TARGET, aws, ready=ready, sleep=lambda _: None),
                             {'state': 'running', 'webReady': True})
            self.assertEqual(sum(c.args[1] == 'start-instances' for c in aws.call_args_list),
                             int(first == 'stopped'))

    def test_stop_never_writes_without_exact_drain_proof(self):
        aws = mock_aws('running')
        with self.assertRaisesRegex(RuntimeError, 'owning host drain'):
            power.run_power('stop', TARGET, aws)
        self.assertEqual(len(aws.call_args_list), 2)
        gate = Mock()
        gate.freeze_and_prove.return_value = {**receipt(), 'release': '0' * 40}
        with self.assertRaisesRegex(RuntimeError, 'different host'):
            power.run_power('stop', TARGET, aws := mock_aws('running'), stop_gate=gate)
        self.assertEqual(len(aws.call_args_list), 2)

    def test_stop_uses_ordinary_ec2_stop_only_after_mock_owner_receipt(self):
        gate = Mock()
        gate.freeze_and_prove.return_value = receipt()
        aws = mock_aws('running', 'running', 'stopping', 'stopped')
        self.assertEqual(power.run_power('stop', TARGET, aws, stop_gate=gate, sleep=lambda _: None),
                         {'state': 'stopped', 'webReady': False})
        gate.freeze_and_prove.assert_called_once_with(TARGET)
        self.assertIn(('ec2', 'stop-instances', '--instance-ids', TARGET['instance']),
                      [call.args for call in aws.call_args_list])
        self.assertEqual(power.run_power('stop', TARGET, mock_aws('stopped'))['state'], 'stopped')

    def test_ready_checks_the_actual_published_web_identity(self):
        body = {'status': 'ready', 'identity': {
            'service': 'web', 'mode': 'production', 'environment': 'dev',
            'repository': 'semiok/allrice-vm', 'repositoryId': 1469490636,
            'sourceSha': TARGET['release'], 'sourceTree': TARGET['tree'], 'manifestDigest': TARGET['manifestDigest'],
        }}
        class ReadyResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, _size):
                return json.dumps(body).encode()

        with patch.object(power, 'build_opener', return_value=Mock(open=Mock(return_value=ReadyResponse()))):
            self.assertTrue(power.health_ready(TARGET))
            body['maintenance'] = {'state': 'open'}
            self.assertTrue(power.health_ready(TARGET))
            for state in ('requested', 'quiesced', 'unknown'):
                body['maintenance'] = {'state': state}
                self.assertFalse(power.health_ready(TARGET))
            body.pop('maintenance')
            body['identity']['manifestDigest'] = 'wrong'
            self.assertFalse(power.health_ready(TARGET))


if __name__ == '__main__':
    unittest.main()
