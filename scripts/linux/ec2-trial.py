#!/usr/bin/env python3
"""Start one prepared EC2 trial host and observe its fixed SSM acceptance probe."""

import argparse
import json
import os
from pathlib import Path
import re
import runpy
import stat
import subprocess
import sys
import time

POWER = runpy.run_path(str(Path(__file__).with_name('ec2-power.py')))
DOCUMENT = 'AllRice40-LinuxTrialProbe'
PLUGIN = 'runAcceptance'
UUID = r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
RELEASE = {'release': r'[0-9a-f]{40}', 'tree': r'[0-9a-f]{40}',
           'manifestDigest': r'sha256:[0-9a-f]{64}'}


def fields_match(value, patterns):
    return isinstance(value, dict) and all(
        isinstance(value.get(key), str) and re.fullmatch(pattern, value[key])
        for key, pattern in patterns.items()
    )


def read_private(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)) as file:
        info = os.fstat(file.fileno())
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != os.getuid() or info.st_size > 65536):
            raise RuntimeError('expected an owned 0600 JSON file')
        return json.loads(file.read(65537))


def checked_trial(trial):
    extra = {'dataVolume': r'vol-[0-9a-f]{17}', 'dataUuid': UUID,
             'scratchUuid': UUID, 'scratchLuksUuid': UUID,
             'documentVersion': r'[1-9][0-9]{0,8}', 'documentHash': r'[0-9a-f]{64}',
             'az': r'[a-z]{2}-[a-z]+-[0-9]+[a-z]', 'market': r'spot|on-demand'}
    if not fields_match(trial, extra) or trial.keys() != extra.keys() | {'power', 'rollback'}:
        raise RuntimeError('invalid trial inventory')
    target = POWER['checked_target'](trial['power'])
    if trial['az'][:-1] != target['region'] or trial['dataUuid'] == trial['scratchUuid']:
        raise RuntimeError('trial AZ or filesystem identity mismatch')
    rollback = trial['rollback']
    if rollback is not None and (
        not fields_match(rollback, RELEASE) or rollback.keys() != RELEASE.keys()
        or rollback['release'] == target['release']
    ):
        raise RuntimeError('invalid rollback release')
    return trial


def arn(trial, service, suffix):
    target = trial['power']
    return f"arn:aws:{service}:{target['region']}:{target['account']}:{suffix}"


def policy(trial):
    target = trial['power']
    result = POWER['iam_policy'](target)
    instance = arn(trial, 'ec2', 'instance/' + target['instance'])
    tag = {'ssm:resourceTag/AllRicePurpose': '4.0-linux-trial'}
    result['Statement'][1]['Condition']['StringEquals']['ec2:AvailabilityZone'] = trial['az']
    result['Statement'] += [
        {'Effect': 'Allow', 'Action': 'ssm:GetConnectionStatus',
         'Resource': instance},
        {'Effect': 'Allow', 'Action': 'ssm:SendCommand', 'Resource': instance,
         'Condition': {'StringEquals': tag}},
        {'Effect': 'Allow', 'Action': 'ssm:SendCommand',
         'Resource': arn(trial, 'ssm', 'document/' + DOCUMENT)},
        {'Effect': 'Allow', 'Action': 'ssm:GetCommandInvocation', 'Resource': '*',
         'Condition': {'StringEquals': {'aws:RequestedRegion': target['region']}}},
    ]
    return result


def agent_policy(trial):
    return {'Version': '2012-10-17', 'Statement': [
        {'Effect': 'Allow', 'Action': [
            'ssm:UpdateInstanceInformation',
            'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
            'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
        ], 'Resource': '*', 'Condition': {
            'StringEquals': {'aws:RequestedRegion': trial['power']['region']},
        }},
    ]}


def send_args(trial):
    return (
        '--instance-ids', trial['power']['instance'], '--document-name', DOCUMENT,
        '--document-version', trial['documentVersion'],
        '--document-hash-type', 'Sha256', '--document-hash', trial['documentHash'],
        '--max-concurrency', '1', '--max-errors', '0', '--timeout-seconds', '120',
    )


def read_invocation(trial, command, aws):
    instance = trial['power']['instance']
    response = aws('ssm', 'get-command-invocation', '--instance-id', instance,
                   '--command-id', command, '--plugin-name', PLUGIN)
    if (response.get('InstanceId'), response.get('CommandId'), response.get('PluginName'),
            response.get('DocumentName'), response.get('DocumentVersion')) != (
            instance, command, PLUGIN, DOCUMENT, trial['documentVersion']):
        raise RuntimeError(f'SSM invocation identity mismatch for {command}')
    return response


def completed_host(response):
    if response.get('Status') != 'Success' or response.get('ResponseCode') != 0:
        raise RuntimeError('SSM invocation did not succeed')
    return json.loads(response['StandardOutputContent'])


def expected_evidence(trial, boot_id, web_boot_id):
    return {
        'bootId': boot_id,
        'webBootId': web_boot_id,
        **{key: trial['power'][key] for key in RELEASE},
        **{key: trial[key] for key in ('dataVolume', 'dataUuid', 'scratchUuid', 'scratchLuksUuid', 'rollback')},
        'systemd': ['allrice40-worker.service', 'allrice40-web.service'],
        'workerReady': True, 'kvmApi': 12, 'luks2': True, 'xfs': True, 'reflink': True,
    }


def previous_boot(trial, scope, before, transition):
    if (before.get('mode') != 'live' or before.get('scope') != scope or before.get('state') != 'running'
            or before.get('webReady') is not True or not fields_match(before, {'commandId': UUID})):
        raise RuntimeError('previous receipt refers to a different trial host')
    host = before.get('host')
    if not fields_match(host, {'bootId': UUID, 'webBootId': UUID, **RELEASE}):
        raise RuntimeError('previous receipt has no matching host and filesystem evidence')
    before_release = {key: host[key] for key in RELEASE}
    expected = expected_evidence(trial, host['bootId'], host['webBootId'])
    if host != {**expected, **before_release, 'rollback': host.get('rollback')}:
        raise RuntimeError('previous host or filesystem evidence is incomplete')
    current_release = {key: trial['power'][key] for key in RELEASE}
    if transition == 'restart' and before_release != current_release:
        raise RuntimeError('restart needs the same release')
    if transition == 'rollback' and (
        host['rollback'] != current_release or before_release == current_release
    ):
        raise RuntimeError('active release is not the verified rollback candidate')
    return host['bootId']


def run_trial(action, trial, aws, *, before=None, transition=None,
              ready=POWER['ready_web_identity'], now=time.monotonic, sleep=time.sleep,
              log=lambda event: print(json.dumps(event), file=sys.stderr, flush=True)):
    target = trial['power']
    scope = {key: target[key] for key in ('account', 'region', 'instance')}
    scope.update(az=trial['az'], dataVolume=trial['dataVolume'])
    if transition and not isinstance(before, dict):
        raise RuntimeError('transition requires a previous live receipt')
    previous = previous_boot(trial, scope, before, transition) if transition else None
    states = []

    def checked_aws(service, operation, *args):
        answer = aws(service, operation, *args)
        if (service, operation) == ('ec2', 'describe-instances'):
            instance = answer['Reservations'][0]['Instances'][0]
            volumes = [entry for entry in instance['BlockDeviceMappings']
                       if entry.get('Ebs', {}).get('VolumeId') == trial['dataVolume']]
            market = instance.get('InstanceLifecycle', 'on-demand')
            if (instance['Placement']['AvailabilityZone'] != trial['az'] or market != trial['market']
                    or len(volumes) != 1 or volumes[0]['DeviceName'] == instance['RootDeviceName']
                    or volumes[0]['Ebs'].get('Status') != 'attached'
                    or volumes[0]['Ebs'].get('DeleteOnTermination') is not False):
                raise RuntimeError('approved AZ, market or retained data EBS identity mismatch')
            if not states:
                if (action == 'start' and market == 'spot' and instance['State']['Name'] == 'stopped'
                        and instance.get('StateReason', {}).get('Code') != 'Client.UserInitiatedShutdown'):
                    raise RuntimeError('stopped Spot is not a verified manual stop; check the request and capacity')
                if transition:
                    original = read_invocation(trial, before['commandId'], aws)
                    if completed_host(original) != before['host']:
                        raise RuntimeError('previous receipt differs from its original SSM invocation')
                states.append(instance['State']['Name'])
        return answer

    result = POWER['run_power'](action, target, checked_aws, ready=ready, now=now, sleep=sleep)
    if action == 'stop':
        return {'mode': 'live', 'scope': scope, **result}
    if transition == 'restart' and states[0] != 'stopped':
        raise RuntimeError('restart verification requires an observed stopped instance before start')

    for _ in range(18):
        connection = aws('ssm', 'get-connection-status', '--target', target['instance'])
        if connection.get('Target') != target['instance']:
            raise RuntimeError('SSM connection refers to a different host')
        if connection.get('Status') == 'connected':
            break
        sleep(5)
    else:
        raise RuntimeError('SSM did not connect to the approved host')

    command = aws('ssm', 'send-command', *send_args(trial))['Command']['CommandId']
    if not isinstance(command, str) or not re.fullmatch(UUID, command):
        raise RuntimeError('SSM did not return a command identity')
    log({'step': 'ssm-submitted', 'scope': scope, 'commandId': command})
    # Delivery + execution may span separate SSM deadlines. Never resend the command.
    deadline = now() + 420
    while now() < deadline:
        try:
            response = read_invocation(trial, command, aws)
        except POWER['AwsCallError'] as error:
            if not error.transport and error.code not in {'InvocationDoesNotExist', 'Throttling', 'ThrottlingException',
                                  'TooManyRequestsException', 'InternalServerError', 'ServiceUnavailable'}:
                raise RuntimeError(f'SSM status unavailable for {command}') from None
            sleep(5)
            continue
        except subprocess.TimeoutExpired:
            sleep(5)
            continue
        if response['Status'] == 'Success' and response['ResponseCode'] == 0:
            break
        if response['Status'] not in {'Pending', 'InProgress', 'Delayed', 'Cancelling'}:
            raise RuntimeError(f'SSM probe failed for {command}')
        sleep(5)
    else:
        raise RuntimeError(f'SSM probe timed out for {command}')

    host = completed_host(response)
    if not fields_match(host, {'bootId': UUID, 'webBootId': UUID}) or host != expected_evidence(
        trial, host['bootId'], host['webBootId'],
    ):
        raise RuntimeError('SSM probe evidence does not match the approved release, disk or checks')
    if POWER['instance_state'](target, checked_aws) != 'running' or (
        (ready(target) or {}).get('bootId') != host['webBootId']
    ):
        raise RuntimeError('public ready endpoint is not the Web process observed on the approved host')
    if transition == 'restart' and host['bootId'] == previous:
        raise RuntimeError('restart needs a new boot ID')
    return {'mode': 'live', 'scope': scope, 'commandId': command, 'host': host,
            'transition': transition or 'not-run', **result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('policy', 'agent-policy', 'start', 'stop'))
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--before', type=Path)
    parser.add_argument('--transition', choices=('restart', 'rollback'))
    args = parser.parse_args()
    if bool(args.before) != bool(args.transition) or (args.before and args.action != 'start'):
        parser.error('start needs --before and --transition together')
    trial = checked_trial(read_private(args.target))
    before = read_private(args.before) if args.before else None
    if args.before and not isinstance(before, dict):
        raise RuntimeError('invalid previous receipt')
    if args.action == 'policy':
        output = policy(trial)
    elif args.action == 'agent-policy':
        output = agent_policy(trial)
    elif args.dry_run:
        output = {'mode': 'dry-run', 'action': args.action,
                  'start': 'ec2-power guarded StartInstances' if args.action == 'start' else None,
                  'ssmSend': send_args(trial) if args.action == 'start' else None,
                  'stop': 'deferred without owner drain', 'transition': args.transition or 'not-run'}
    else:
        output = run_trial(args.action, trial, POWER['AwsCli'](trial['power']), before=before,
                           transition=args.transition)
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.TimeoutExpired):
        raise SystemExit('invalid or unavailable trial input or response') from None
