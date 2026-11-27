#!/usr/bin/env python3
"""Operate one configured AllRice ARM64 test instance using AWS CLI SSO."""

import argparse
from configparser import Error as ConfigError, RawConfigParser
from http.client import HTTPException
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

TAG = 'AllRicePurpose'
TAG_VALUE = '4.0-linux-trial'
STATES = {'pending', 'running', 'stopping', 'stopped'}


def checked_target(target):
    patterns = {
        'account': r'[0-9]{12}', 'region': r'[a-z]{2}-[a-z]+-[0-9]+',
        'instance': r'i-[0-9a-f]{17}', 'profile': r'[A-Za-z0-9][A-Za-z0-9_-]*',
        'permissionSet': r'[A-Za-z0-9_+=,.@-]{1,32}',
        'release': r'[0-9a-f]{40}', 'tree': r'[0-9a-f]{40}',
        'manifestDigest': r'sha256:[0-9a-f]{64}',
    }
    if (not isinstance(target, dict) or target.keys() != patterns.keys() | {'healthUrl'} or
            any(not isinstance(target[key], str) or not re.fullmatch(pattern, target[key])
                for key, pattern in patterns.items()) or target['profile'] == 'default'):
        raise RuntimeError('invalid private EC2 target configuration')
    if not isinstance(target['healthUrl'], str):
        raise RuntimeError('healthUrl must be a fixed HTTPS ready endpoint')
    url = urlsplit(target['healthUrl'])
    if (url.scheme != 'https' or not url.hostname or not re.fullmatch(r'[a-z0-9.-]+', url.hostname)
            or url.netloc != url.hostname or url.path != '/api/health/ready'
            or url.query or url.fragment or target['healthUrl'] != f'https://{url.hostname}{url.path}'):
        raise RuntimeError('healthUrl must be a fixed HTTPS ready endpoint')
    return target


def iam_policy(target):
    region = target['region']
    instance = f"arn:aws:ec2:{region}:{target['account']}:instance/{target['instance']}"
    return {
        'Version': '2012-10-17',
        'Statement': [
            {'Effect': 'Allow', 'Action': ['ec2:DescribeInstances'], 'Resource': '*',
             'Condition': {'StringEquals': {'aws:RequestedRegion': region}}},
            {'Effect': 'Allow', 'Action': ['ec2:StartInstances'], 'Resource': instance,
             'Condition': {'StringEquals': {f'ec2:ResourceTag/{TAG}': TAG_VALUE,
                                         'ec2:InstanceType': 'c7g.metal', 'ec2:RootDeviceType': 'ebs'}}},
        ],
    }


def check_sso_profile(target, path):
    config = RawConfigParser()
    try:
        found = config.read(path, encoding='utf-8')
    except (ConfigError, UnicodeError):
        raise RuntimeError('AWS CLI SSO configuration is invalid') from None
    if not found:
        raise RuntimeError('AWS CLI SSO configuration is unavailable')
    entry = 'profile ' + target['profile']
    if not config.has_section(entry):
        raise RuntimeError('configure the named AWS CLI SSO profile')
    profile = config[entry]
    allowed = {'sso_session', 'sso_account_id', 'sso_role_name', 'region', 'output'}
    if (not set(profile) <= allowed or profile.get('sso_account_id') != target['account']
            or profile.get('sso_role_name') != target['permissionSet'] or not profile.get('sso_session')
            or not config.has_section('sso-session ' + profile['sso_session'])):
        raise RuntimeError('the named profile must directly select an Identity Center account and role')


class AwsCli:
    def __init__(self, target):
        check_sso_profile(target, Path.home() / '.aws/config')
        self.target = target
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('AWS_')}
        self.env.update(AWS_SHARED_CREDENTIALS_FILE=os.devnull, AWS_EC2_METADATA_DISABLED='true',
                        AWS_PAGER='', AWS_RETRY_MODE='standard', AWS_MAX_ATTEMPTS='1',
                        AWS_IGNORE_CONFIGURED_ENDPOINT_URLS='true')

    def __call__(self, service, operation, *arguments):
        result = subprocess.run(
            ['aws', '--profile', self.target['profile'], '--region', self.target['region'],
             '--no-cli-pager', '--no-cli-auto-prompt', '--output', 'json',
             '--cli-connect-timeout', '5', '--cli-read-timeout', '10',
             service, operation, *arguments],
            env=self.env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20,
        )
        if result.returncode:
            raise RuntimeError(f'AWS {service} {operation} failed (exit {result.returncode})')
        return json.loads(result.stdout)


def instance_state(target, aws):
    result = aws('ec2', 'describe-instances', '--instance-ids', target['instance'])
    reservations = result['Reservations']
    if len(reservations) != 1 or reservations[0]['OwnerId'] != target['account']:
        raise RuntimeError('AWS reservation owner mismatch')
    instances = reservations[0]['Instances']
    if len(instances) != 1:
        raise RuntimeError('expected the one configured instance')
    instance = instances[0]
    if (instance['InstanceId'] != target['instance'] or instance['InstanceType'] != 'c7g.metal'
            or instance['Architecture'] != 'arm64' or instance['RootDeviceType'] != 'ebs'
            or not re.fullmatch(re.escape(target['region']) + r'[a-z]', instance['Placement']['AvailabilityZone'])
            or [t['Value'] for t in instance.get('Tags', []) if t['Key'] == TAG] != [TAG_VALUE]):
        raise RuntimeError('AWS instance identity, type or test tag mismatch')
    state = instance['State']['Name']
    if state not in STATES:
        raise RuntimeError('instance state cannot be operated safely')
    return state


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def health_ready(target):
    try:
        with build_opener(NoRedirect()).open(target['healthUrl'], timeout=5) as response:
            data = response.read(65537)
            if response.status != 200 or len(data) > 65536:
                return False
            document = json.loads(data)
            identity = document['identity']
            maintenance = document.get('maintenance')
            open_for_use = maintenance is None or (
                isinstance(maintenance, dict) and maintenance.get('state') == 'open'
            )
            return (document['status'] == 'ready' and identity['service'] == 'web'
                    and identity['environment'] == 'dev' and identity['mode'] == 'production'
                    and identity['repository'] == 'semiok/allrice-vm' and identity['repositoryId'] == 1469490636
                    and identity['sourceSha'] == target['release'] and identity['sourceTree'] == target['tree']
                    and identity['manifestDigest'] == target['manifestDigest']
                    and open_for_use)
    except (URLError, HTTPException, OSError, KeyError, TypeError, ValueError):
        return False


def run_power(action, target, aws, *, ready=health_ready, stop_gate=None,
              now=time.monotonic, sleep=time.sleep, wait_seconds=900):
    if action not in {'status', 'start', 'stop'}:
        raise RuntimeError('unsupported power action')
    identity = aws('sts', 'get-caller-identity')
    if identity.get('Account') != target['account']:
        raise RuntimeError('AWS caller account mismatch')
    role = f"arn:aws:sts::{target['account']}:assumed-role/AWSReservedSSO_{target['permissionSet']}_"
    if not re.fullmatch(re.escape(role) + r'[0-9a-f]{16}/[^/]+', identity.get('Arn', '')):
        raise RuntimeError('AWS caller is not the selected trial permission set')
    state = instance_state(target, aws)
    if action == 'status':
        return {'state': state, 'webReady': state == 'running' and ready(target)}

    if action == 'start':
        if state == 'stopping':
            raise RuntimeError('wait for the existing stop to finish')
        if state == 'stopped':
            aws('ec2', 'start-instances', '--instance-ids', target['instance'])
    else:
        if state == 'stopped':
            return {'state': 'stopped', 'webReady': False}
        if state == 'running':
            if stop_gate is None:
                raise RuntimeError('stop deferred: the owning host drain is unavailable')
            # The future owner gate must keep admission frozen until this
            # instance is confirmed stopped, even if AWS or the caller fails.
            receipt = stop_gate.freeze_and_prove(target)
            if receipt != {key: target[key] for key in ('account', 'region', 'instance', 'release', 'tree', 'manifestDigest')}:
                raise RuntimeError('stop deferred: drain receipt targets a different host')
            if instance_state(target, aws) != 'running':
                raise RuntimeError('stop deferred: EC2 state changed during drain')
            aws('ec2', 'stop-instances', '--instance-ids', target['instance'])
        elif state != 'stopping':
            raise RuntimeError('stop deferred: the instance is still starting')

    deadline = now() + wait_seconds
    while now() < deadline:
        state = instance_state(target, aws)
        if action == 'start' and state == 'running' and ready(target):
            return {'state': state, 'webReady': True}
        if action == 'stop' and state == 'stopped':
            return {'state': state, 'webReady': False}
        sleep(10)
    raise RuntimeError(f'{action} observation timed out; inspect state before acting again')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('policy', 'status', 'start', 'stop'))
    parser.add_argument('--target', type=Path, required=True)
    args = parser.parse_args()
    target = checked_target(json.loads(args.target.read_text(encoding='utf-8')))
    if args.action == 'policy':
        print(json.dumps(iam_policy(target), indent=2))
    else:
        print(json.dumps(run_power(args.action, target, AwsCli(target))))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        raise SystemExit(str(error)) from None
