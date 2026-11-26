import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runBrowser } from './browser.mjs';
import {
  CheckFailed,
  checkHealth,
  isId,
  liveBlockers,
  paths,
  peoplePath,
  requireFact,
} from './contracts.mjs';
import { fixtureDriver, makeFixture } from './fixture.mjs';

function failure(stage, error) {
  return {
    stage,
    code:
      error instanceof CheckFailed
        ? error.code
        : error?.name === 'TimeoutError'
          ? 'browser-timeout'
          : 'operation-failed',
    ...(error instanceof CheckFailed && Number.isInteger(error.status)
      ? { httpStatus: error.status }
      : {}),
  };
}

function policySelections(response) {
  const policy = response.body;
  requireFact(
    response.status === 200 &&
      policy?.defaultGeneration === '3.x' &&
      typeof policy.revision === 'string' &&
      Array.isArray(policy.selections) &&
      policy.selections.every(
        (item) =>
          item &&
          Object.keys(item).length === 2 &&
          isId(item.organizationId) &&
          isId(item.personId),
      ),
    'person-policy-invalid',
    response.status,
  );
  const keys = policy.selections.map(
    ({ organizationId, personId }) => `${organizationId}/${personId}`,
  );
  requireFact(new Set(keys).size === keys.length, 'person-policy-duplicate');
  return { policy, keys };
}

function prepare(fixture, receipt) {
  const { organizationId, workspaceId, account } = fixture;
  requireFact(
    isId(organizationId) &&
      isId(workspaceId) &&
      /^qa-greenfield-[a-z0-9-]+$/.test(account.username),
    'fixture-account-scope',
  );
  // The fixture models the serialized ADMIN change. The production API
  // replaces the whole policy, so live needs the release owner's exclusive window.
  const { policy, keys } = policySelections(
    fixture.adminHttp('GET', paths.policy),
  );
  const created = fixture.adminHttp('POST', peoplePath(organizationId), {
    people: [{ ...account, displayName: '验收账号' }],
  });
  const user = created.body?.created?.[0];
  requireFact(
    created.status === 201 &&
      created.body?.created?.length === 1 &&
      user?.username === account.username &&
      isId(user.userId),
    'admin-account-creation',
    created.status,
  );
  receipt.stages.adminAccount = 'passed';
  const personId = user.userId;
  const key = `${organizationId}/${personId}`;
  requireFact(!keys.includes(key), 'fixture-account-already-released');
  const selections = [...policy.selections, { organizationId, personId }];
  const changed = policySelections(
    fixture.adminHttp('PUT', paths.policy, { ...policy, selections }),
  );
  const readback = policySelections(fixture.adminHttp('GET', paths.policy));
  for (const result of [changed, readback]) {
    requireFact(
      result.policy.revision === changed.policy.revision &&
        result.policy.revision !== policy.revision &&
        result.keys.length === selections.length &&
        [...keys, key].every((item) => result.keys.includes(item)),
      'person-policy-readback-mismatch',
    );
  }
  receipt.stages.personScopedRelease = 'passed';
  return { organizationId, workspaceId, personId };
}

export async function dryRun({
  fixture = makeFixture(),
  browserExecutable,
  recordFirstFailure = () => {},
} = {}) {
  const phase = () => ({ prewarmRequests: 0, initialHttp: null, polls: [] });
  const receipt = {
    mode: 'dry-run',
    source: 'synthetic-browser-fixture',
    status: 'failed',
    stages: {},
    release: fixture.release,
    browser: { cold: phase(), warm: phase(), closed: false },
    timings: {
      loginHttpMs: null,
      loginToEntryMs: null,
      employeeCreationHttpMs: null,
      diskMs: null,
      cacheMs: null,
      vmBootMs: null,
      guestDshReadyMs: null,
      coldInitialResponseMs: null,
      coldPrewarmToReadyObservedMs: null,
      coldToEditableMs: null,
      warmToEditableMs: null,
    },
    cleanup: { status: 'vm-not-observed' },
    firstFailure: null,
  };
  function fail(stage, error) {
    if (receipt.firstFailure) return;
    receipt.firstFailure = failure(stage, error);
    receipt.stages[stage] = 'failed';
    try {
      recordFirstFailure(receipt.firstFailure);
    } catch {
      receipt.firstFailureFileFailed = true;
    }
  }
  const currentDeploy = () =>
    ['web', 'worker'].map((service) =>
      checkHealth(fixture.health(service), fixture.release, service),
    );
  let identity;
  let stage = 'releaseBefore';
  try {
    const before = currentDeploy();
    receipt.stages[stage] = 'passed';
    stage = 'adminSetup';
    identity = prepare(fixture, receipt);
    stage = 'browser';
    const { account, employeeName, timeout } = fixture;
    await runBrowser({
      driver: fixtureDriver(fixture.publicHttp),
      account,
      employeeName,
      timeout,
      identity,
      receipt,
      browserExecutable,
      fail,
    });
    stage = 'releaseAfter';
    const after = currentDeploy();
    requireFact(
      after.every((boot, index) => boot === before[index]),
      'service-restarted',
    );
    receipt.stages[stage] = 'passed';
  } catch (error) {
    fail(stage, error);
  } finally {
    try {
      const target = identity && fixture.exactVm(identity);
      requireFact(
        target || !receipt.browser.cold.prewarmReady,
        'cleanup-target-unverified',
      );
      if (target) {
        requireFact(
          receipt.browser.closed &&
            target.personId === identity.personId &&
            target.organizationId === identity.organizationId &&
            target.workspaceId === identity.workspaceId &&
            isId(target.vmId) &&
            Number.isSafeInteger(target.leaseEpoch) &&
            target.leaseEpoch > 0,
          'cleanup-target-unverified',
        );
        const stopped = fixture.stopExact(target);
        requireFact(
          stopped?.state === 'stopped' &&
            stopped.personId === identity.personId &&
            stopped.organizationId === identity.organizationId &&
            stopped.vmId === target.vmId &&
            stopped.leaseEpoch === target.leaseEpoch &&
            stopped.diskRetained === true &&
            stopped.accountRetained === true,
          'cleanup-unconfirmed',
        );
        receipt.cleanup = {
          status: 'stopped',
          accountRetained: true,
          diskRetained: true,
        };
      }
    } catch (error) {
      receipt.cleanup = {
        status: 'failed',
        failure: failure('cleanup', error),
      };
      fail('cleanup', error);
    }
  }
  if (!receipt.firstFailure) receipt.status = 'passed';
  return receipt;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' },
      live: { type: 'boolean' },
      'allow-public-writes': { type: 'boolean' },
      'release-sha': { type: 'string' },
      'release-tree': { type: 'string' },
      output: { type: 'string' },
    },
  });
  requireFact(
    !(values.live && values['dry-run']) &&
      (values.live ||
        !(
          values['allow-public-writes'] ||
          values['release-sha'] ||
          values['release-tree']
        )),
    'conflicting-run-mode',
  );
  const output = values.output
    ? resolve(values.output)
    : mkdtempSync(join(tmpdir(), 'allrice40-greenfield-'));
  if (values.output) mkdirSync(output, { mode: 0o700 });
  const write = (name, value) =>
    writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  const receipt = values.live
    ? {
        mode: 'live',
        status: 'blocked',
        blockers: liveBlockers({
          allowPublicWrites: values['allow-public-writes'],
          releaseSha: values['release-sha'],
          releaseTree: values['release-tree'],
        }),
      }
    : await dryRun({
        browserExecutable:
          process.env.ALLRICE_BROWSER_EXECUTABLE ??
          process.env.ALLRICE_MANAGED_BROWSER_EXECUTABLE,
        recordFirstFailure: (item) => write('first-failure.json', item),
      });
  write('receipt.json', receipt);
  process.stdout.write(
    `${receipt.mode} ${receipt.status} · ${join(output, 'receipt.json')}\n`,
  );
  process.exitCode =
    receipt.status === 'passed' ? 0 : receipt.status === 'blocked' ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch(() => {
    // Raw Node/Playwright errors can contain private request credentials.
    process.stderr.write(
      'Greenfield acceptance could not start or write a new receipt.\n',
    );
    process.exitCode = 2;
  });
