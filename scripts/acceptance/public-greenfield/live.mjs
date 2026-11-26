import {
  constants,
  openSync,
  fstatSync,
  closeSync,
  readFileSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBrowser } from './browser.mjs';
import {
  captureVmBinding,
  checkHealth,
  failure,
  isId,
  livePreflight,
  publicOrigin,
  requireFact,
  sameVmBinding,
} from './contracts.mjs';
import { publicDriver } from './live-driver.mjs';

function withPrivateFile(path, read) {
  requireFact(
    typeof path === 'string' && isAbsolute(path),
    'private-path-required',
  );
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    requireFact(
      info.isFile() &&
        (info.mode & 0o7777) === 0o600 &&
        info.uid === process.getuid?.() &&
        info.nlink === 1,
      'private-file-mode',
    );
    return read(fd, info);
  } finally {
    closeSync(fd);
  }
}

export function credentials(path) {
  return withPrivateFile(path, (fd, info) => {
    requireFact(info.size > 0 && info.size <= 8192, 'credential-file-size');
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    const { organizationId, workspaceId, personId, username, password } =
      value ?? {};
    requireFact(
      Object.keys(value ?? {}).length === 5 &&
        [organizationId, workspaceId, personId].every(isId) &&
        typeof username === 'string' &&
        username === username.trim() &&
        username.length > 0 &&
        username.length <= 80 &&
        !/[\u0000-\u001f\u007f]/u.test(username) &&
        !['snow', 'admin'].includes(username.toLowerCase()) &&
        typeof password === 'string' &&
        password.length > 0 &&
        password.length <= 4096,
      'acceptance-credential-shape',
    );
    return {
      identity: { organizationId, workspaceId, personId },
      account: { username, password },
    };
  });
}

async function loadOwner(path) {
  // This is executable code explicitly supplied by the release operator. It
  // binds the already authorized local Host owner. No public stop URL is used.
  withPrivateFile(path, () =>
    requireFact(path.endsWith('.mjs'), 'managed-owner-module-invalid'),
  );
  const { managedOwner } = await import(pathToFileURL(path).href);
  requireFact(
    [
      'prepare',
      'workerHealth',
      'operationResult',
      'exactVm',
      'stopExact',
      'close',
    ].every((method) => typeof managedOwner?.[method] === 'function'),
    'managed-owner-module-invalid',
  );
  return managedOwner;
}

async function webHealth() {
  const response = await fetch(`${publicOrigin}/api/health/ready`, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() };
}

const sameIdentity = (left, right) =>
  ['organizationId', 'workspaceId', 'personId'].every(
    (key) => left?.[key] === right[key],
  );

export async function runLive(
  options,
  {
    preflight = livePreflight,
    ownerSource = loadOwner,
    publicHealth = webHealth,
    browser = runBrowser,
    recordFirstFailure = () => {},
  } = {},
) {
  const pre = preflight(options);
  if (pre.blockers.length) return pre;
  const { ownerPath, credentialPath, seal, sendHello, browserExecutable } =
    options;
  if (!credentialPath || !/^sha256:[0-9a-f]{64}$/u.test(seal ?? '')) {
    pre.blockers.push('private-credentials-and-exact-release-seal-required');
    return pre;
  }
  // A caller's Playwright debugging settings can include network call details.
  if (process.env.DEBUG || process.env.PWDEBUG || process.env.PWDEBUGIMPL) {
    pre.blockers.push('browser-debugging-enabled');
    return pre;
  }
  const release = { ...pre.requestedRelease, seal };
  const receipt = {
    ...pre,
    source: 'public-chromium',
    status: 'blocked',
    release,
    stages: {},
    browser: {
      cold: { prewarmRequests: 0, initialHttp: null, polls: [] },
      closed: false,
    },
    timings: {
      loginHttpMs: null,
      loginToEntryMs: null,
      loginToZeroEmployeeMs: null,
      employeeCreationHttpMs: null,
      coldInitialResponseMs: null,
      coldPrewarmToReadyObservedMs: null,
      readyToEditableMs: null,
      coldToEditableMs: null,
      diskMs: null,
      cacheMs: null,
      vmBootMs: null,
      guestDshReadyMs: null,
      helloToFirstReplyMs: null,
      helloToTurnEndMs: null,
    },
    cleanup: { status: 'not-dispatched' },
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
  let owner;
  let identity;
  let operationId;
  let stage = 'managedOwner';
  const signal = () => AbortSignal.timeout(30_000);
  const readBoots = async () => {
    const workers = await owner.workerHealth({ release, signal: signal() });
    return [
      checkHealth(workers, release, 'worker'),
      checkHealth(await publicHealth(), release),
    ];
  };
  try {
    owner = await ownerSource(ownerPath);
    stage = 'credentials';
    const config = credentials(credentialPath);
    identity = config.identity;
    stage = 'operatorPreparation';
    const prepared = await owner.prepare({
      identity,
      username: config.account.username,
      release,
      signal: signal(),
    });
    requireFact(
      prepared?.role === '验收员' &&
        prepared.username === config.account.username &&
        sameIdentity(prepared.identity, identity) &&
        prepared.state === 'zero-employee-no-vm' &&
        prepared.personScopedRelease === true,
      'operator-preparation-unverified',
    );
    receipt.stages[stage] = 'passed';
    stage = 'releaseBefore';
    const before = await readBoots();
    receipt.stages[stage] = 'passed';
    receipt.status = 'failed';
    stage = 'browser';
    await browser({
      driver: publicDriver(),
      identity,
      account: config.account,
      employeeName: '验收员工',
      receipt,
      timeout: 320_000,
      browserExecutable,
      fail,
      sendHello,
      reopenWarm: false,
      onColdTicket: (id) => {
        operationId = id;
      },
    });
    requireFact(
      isId(operationId) &&
        receipt.browser.cold.prewarmRequests === 1 &&
        receipt.stages.coldEditor === 'passed' &&
        (!sendHello || receipt.stages.hello === 'passed'),
      'public-workbench-unverified',
    );
    stage = 'releaseAfter';
    const after = await readBoots();
    requireFact(
      after.every((boot, index) => boot === before[index]),
      'service-restarted',
    );
    receipt.stages[stage] = 'passed';
  } catch (error) {
    fail(stage, error);
  } finally {
    try {
      if (receipt.browser.cold.prewarmRequests) {
        requireFact(
          receipt.browser.closed && operationId,
          'cleanup-dispatch-unconfirmed',
        );
        const started = await owner.operationResult({
          identity,
          operationId,
          signal: signal(),
        });
        requireFact(
          started?.operationId === operationId,
          'cleanup-operation-mismatch',
        );
        if (started.state === 'unallocated') {
          requireFact(
            !receipt.browser.cold.prewarmReady,
            'cleanup-unconfirmed',
          );
          receipt.cleanup = { status: 'not-allocated' };
        } else {
          requireFact(
            started.state === 'allocated',
            'cleanup-start-unconfirmed',
          );
          const binding = captureVmBinding(started.binding, identity);
          const current = await owner.exactVm({ identity, signal: signal() });
          requireFact(
            sameVmBinding(binding, current),
            'cleanup-target-changed',
          );
          const stopped = await owner.stopExact({ binding, signal: signal() });
          requireFact(
            stopped?.state === 'stopped' &&
              sameVmBinding(binding, stopped) &&
              stopped.diskRetained === true &&
              stopped.accountRetained === true &&
              stopped.unmounted === true &&
              stopped.leaseReleased === true,
            'cleanup-unconfirmed',
          );
          receipt.cleanup = {
            status: 'stopped',
            accountRetained: true,
            diskRetained: true,
          };
        }
      }
    } catch (error) {
      receipt.cleanup = {
        status: 'failed',
        failure: failure('cleanup', error),
      };
      fail('cleanup', error);
    } finally {
      try {
        await owner?.close({ signal: signal() });
      } catch (error) {
        receipt.ownerClose = 'failed';
        fail('ownerClose', error);
      }
    }
  }
  if (!receipt.firstFailure) receipt.status = 'passed';
  return receipt;
}
