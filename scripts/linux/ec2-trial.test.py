from copy import deepcopy
import json
from pathlib import Path
import runpy
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).parent
SCRIPT = ROOT / 'ec2-trial.py'
TRIAL = runpy.run_path(str(SCRIPT))
TARGET = json.loads((ROOT / 'ec2-trial.target.example.json').read_text())
BOOT = '8741f90a-bbbb-cccc-dddd-eeeeeeeeeeee'
WEB_BOOT = '12345678-aaaa-bbbb-cccc-eeeeeeeeeeee'
COMMAND = '12345678-1234-1234-1234-123456789012'
NEXT_COMMAND = '87654321-1234-1234-1234-123456789012'


class AwsFixture:
    def __init__(self):
        self.state = 'stopped'
        self.az = TARGET['az']
        self.state_reason = 'Client.UserInitiatedShutdown'
        self.calls = []
        self.reads = 0
        self.command = COMMAND
        self.history = {}
        self.events = []
        self.plugin = 'runAcceptance'
        self.host = TRIAL['expected_evidence'](TARGET, BOOT, WEB_BOOT)

    def __call__(self, service, operation, *args):
        self.calls.append((operation, args))
        power = TARGET['power']
        if service == 'sts':
            return {'Account': power['account'],
                    'Arn': f"arn:aws:sts::{power['account']}:assumed-role/AWSReservedSSO_ScopedTrial_1234567890abcdef/operator"}
        if operation == 'describe-instances':
            instance = {
                'InstanceId': power['instance'], 'InstanceType': 'c7g.metal',
                'Architecture': 'arm64', 'RootDeviceType': 'ebs', 'RootDeviceName': '/dev/sda1',
                'Placement': {'AvailabilityZone': self.az}, 'InstanceLifecycle': 'spot',
                'Tags': [{'Key': 'AllRicePurpose', 'Value': '4.0-linux-trial'}],
                'State': {'Name': self.state},
                'StateReason': {'Code': self.state_reason},
                'BlockDeviceMappings': [{'DeviceName': '/dev/sdf', 'Ebs': {
                    'VolumeId': TARGET['dataVolume'], 'Status': 'attached', 'DeleteOnTermination': False,
                }}],
            }
            return {'Reservations': [{'OwnerId': power['account'], 'Instances': [instance]}]}
        if operation == 'start-instances':
            self.state = 'running'
            return {}
        if operation == 'get-connection-status':
            return {'Target': power['instance'], 'Status': 'connected'}
        if operation == 'send-command':
            return {'Command': {'CommandId': self.command}}
        if operation == 'get-command-invocation':
            command = args[args.index('--command-id') + 1]
            host = self.history.get(command)
            status = 'Success'
            if host is None:
                self.reads += 1
                if self.reads < 5 or self.reads == 6:
                    code = 'InvocationDoesNotExist' if self.reads < 5 else 'ThrottlingException'
                    error = subprocess.CompletedProcess([], 254, '',
                                                        f'aws: [ERROR]: An error occurred ({code}) when calling test')
                    raise TRIAL['POWER']['AwsCallError'](service, operation, error)
                if self.reads == 5:
                    status = 'Pending'
                if self.reads == 7:
                    error = subprocess.CompletedProcess([], 255, '',
                                                        'aws: [ERROR]: Read timeout on endpoint URL: fixture')
                    raise TRIAL['POWER']['AwsCallError'](service, operation, error)
                host = self.host
            return {'InstanceId': power['instance'], 'CommandId': command, 'Status': status,
                    'ResponseCode': 0, 'PluginName': self.plugin, 'DocumentName': 'AllRice40-LinuxTrialProbe',
                    'DocumentVersion': TARGET['documentVersion'], 'StandardOutputContent': json.dumps(host)}
        raise AssertionError('unexpected AWS call')


class TrialTests(unittest.TestCase):
    def execute(self, action, aws, **options):
        ready = options.pop('ready', lambda _: {'bootId': WEB_BOOT})
        return TRIAL['run_trial'](action, TARGET, aws, ready=ready, sleep=lambda _: None,
                                  log=aws.events.append, **options)

    def next_attempt(self, before):
        aws = AwsFixture()
        aws.command = NEXT_COMMAND
        aws.history[before['commandId']] = deepcopy(before['host'])
        return aws

    def test_cli_dry_run_works_in_an_empty_environment_and_policy_is_scoped(self):
        with TemporaryDirectory() as directory:
            profile = Path(directory) / 'trial.json'
            profile.write_text(json.dumps(TARGET))
            profile.chmod(0o600)
            for action in ('start', 'stop', 'policy', 'agent-policy'):
                run = subprocess.run([sys.executable, '-IB', str(SCRIPT), action, '--target',
                                      str(profile), '--dry-run'], env={'HOME': directory, 'PATH': directory},
                                     check=True, capture_output=True, text=True, timeout=5)
                result = json.loads(run.stdout)
                if action == 'policy':
                    statements = result['Statement']
                    actions = ' '.join(json.dumps(row['Action']) for row in statements)
                    self.assertNotIn('StopInstances', actions)
                    self.assertNotIn('RunInstances', actions)
                    send = [row['Resource'] for row in statements if row['Action'] == 'ssm:SendCommand']
                    self.assertEqual(len(send), 2)
                    self.assertEqual(sum(path.endswith('/AllRice40-LinuxTrialProbe') for path in send), 1)
                    self.assertFalse(any('*' in path for path in send))
                elif action == 'agent-policy':
                    actions = result['Statement'][0]['Action']
                    self.assertIn('ssm:UpdateInstanceInformation', actions)
                    self.assertFalse(any('GetParameter' in entry for entry in actions))
                    self.assertNotIn('ssm:SendCommand', actions)
                else:
                    self.assertEqual(result['mode'], 'dry-run')
                    self.assertIn('deferred', result['stop'])
                    self.assertEqual(result['ssmSend'] is None, action == 'stop')
            previous = Path(directory) / 'previous.json'
            previous.write_text('null')
            previous.chmod(0o600)
            invalid = subprocess.run([sys.executable, '-IB', str(SCRIPT), 'start', '--target', str(profile),
                                      '--before', str(previous), '--transition', 'rollback', '--dry-run'],
                                     env={'HOME': directory, 'PATH': directory}, capture_output=True, text=True,
                                     timeout=5)
            self.assertNotEqual(invalid.returncode, 0)
            self.assertIn('invalid previous receipt', invalid.stderr)

    def test_start_dispatches_once_with_document_identity_and_attested_output(self):
        aws = AwsFixture()
        result = self.execute('start', aws)
        self.assertEqual(result['host']['bootId'], BOOT)
        self.assertEqual(result['transition'], 'not-run')
        sent = [args for op, args in aws.calls if op == 'send-command']
        self.assertEqual(sent, [TRIAL['send_args'](TARGET)])
        self.assertNotIn('--parameters', sent[0])
        self.assertEqual(sum(op == 'start-instances' for op, _ in aws.calls), 1)
        self.assertEqual(sum(op == 'get-command-invocation' for op, _ in aws.calls), 8)
        self.assertEqual([entry['commandId'] for entry in aws.events], [COMMAND])

    def test_wrong_az_blocks_start_and_running_stop_still_requires_owner(self):
        aws = AwsFixture()
        aws.az = 'us-east-1z'
        with self.assertRaisesRegex(RuntimeError, 'AZ'):
            self.execute('start', aws)
        self.assertFalse(any(op in {'start-instances', 'send-command'} for op, _ in aws.calls))
        aws = AwsFixture()
        aws.state_reason = 'Server.SpotInstanceShutdown'
        with self.assertRaisesRegex(RuntimeError, 'manual stop'):
            self.execute('start', aws)
        self.assertNotIn('start-instances', [op for op, _ in aws.calls])
        aws = AwsFixture()
        aws.state = 'running'
        with self.assertRaisesRegex(RuntimeError, 'owning host drain'):
            self.execute('stop', aws)
        self.assertFalse(any(op in {'stop-instances', 'send-command'} for op, _ in aws.calls))

    def test_rejects_wrong_invocation_and_wrong_host_evidence(self):
        aws = AwsFixture()
        aws.plugin = 'unexpected'
        with self.assertRaisesRegex(RuntimeError, 'invocation identity'):
            self.execute('start', aws)
        self.assertEqual([entry['commandId'] for entry in aws.events], [COMMAND])
        aws = AwsFixture()
        aws.host['dataVolume'] = 'vol-00000000000000000'
        with self.assertRaisesRegex(RuntimeError, 'probe evidence'):
            self.execute('start', aws)
        with self.assertRaisesRegex(RuntimeError, 'not the Web process'):
            self.execute('start', AwsFixture(), ready=lambda _: {'bootId': BOOT})

    def test_checks_actual_restart_and_only_accepts_a_verified_rollback(self):
        before = self.execute('start', AwsFixture())
        aws = AwsFixture()
        with self.assertRaisesRegex(RuntimeError, 'requires a previous live receipt'):
            self.execute('start', aws, before=None, transition='restart')
        self.assertEqual(aws.calls, [])
        with self.assertRaisesRegex(RuntimeError, 'new boot ID'):
            self.execute('start', self.next_attempt(before), before=before, transition='restart')
        reboot = self.next_attempt(before)
        reboot.host['bootId'] = BOOT.replace('8741f90a', 'aaaaaaaa')
        self.assertEqual(self.execute('start', reboot, before=before, transition='restart')['transition'], 'restart')
        old = deepcopy(before)
        old['host']['release'] = 'f' * 40
        with self.assertRaisesRegex(RuntimeError, 'rollback candidate'):
            self.execute('start', AwsFixture(), before=old, transition='rollback')
        old['host']['rollback'] = {key: TARGET['power'][key] for key in TRIAL['RELEASE']}
        mismatch = self.next_attempt(before)
        with self.assertRaisesRegex(RuntimeError, 'original SSM invocation'):
            self.execute('start', mismatch, before=old, transition='rollback')
        self.assertFalse(any(op in {'start-instances', 'send-command'} for op, _ in mismatch.calls))
        self.assertEqual(self.execute('start', self.next_attempt(old), before=old, transition='rollback')['transition'], 'rollback')


if __name__ == '__main__':
    unittest.main()
