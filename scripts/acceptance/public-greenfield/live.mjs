import { createHash } from 'node:crypto';
import {
  constants,
  openSync,
  fstatSync,
  closeSync,
  readFileSync,
  realpathSync,
  lstatSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBrowser } from './browser.mjs';
import {
  captureVmBinding,
  CheckFailed,
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
        [...username].every(
          (char) => char >= ' ' && char.charCodeAt(0) !== 127,
        ) &&
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

async function loadOwner(path, expectedDigest) {
  // This is executable code explicitly supplied by the release operator. It
  // binds the already authorized local Host owner. No public stop URL is used.
  requireFact(
    typeof path === 'string' &&
      isAbsolute(path) &&
      path.endsWith('.mjs') &&
      typeof expectedDigest === 'string' &&
      expectedDigest.length === 64 &&
      /^[0-9a-f]{64}$/u.test(expectedDigest),
    'managed-owner-module-invalid',
  );
  const directory = realpathSync(dirname(path));
  const dir = lstatSync(directory);
  requireFact(
    dir.isDirectory() &&
      dir.uid === process.getuid?.() &&
      (dir.mode & 0o7777) === 0o700,
    'managed-owner-directory-not-private',
  );
  const verifiedPath = join(directory, basename(path));
  withPrivateFile(verifiedPath, (fd, info) => {
    requireFact(
      info.size > 0 &&
        info.size <= 1024 * 1024 &&
        createHash('sha256').update(readFileSync(fd)).digest('hex') ===
          expectedDigest,
      'managed-owner-digest-mismatch',
    );
  });
  const { managedOwner } = await import(pathToFileURL(verifiedPath).href);
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

async function webHealth(signal) {
  const response = await fetch(`${publicOrigin}/api/health/ready`, {
    cache: 'no-store',
    redirect: 'error',
    signal: globalThis.AbortSignal.any([
      signal,
      globalThis.AbortSignal.timeout(15_000),
    ]),
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
    recordHelloIntent,
  } = {},
) {
  const pre = preflight(options);
  if (pre.blockers.length) return pre;
  const {
    ownerPath,
    credentialPath,
    seal,
    sendHello,
    browserExecutable,
    signal: cancelled,
  } = options;
  if (sendHello && !recordHelloIntent) {
    pre.blockers.push('hello-intent-receipt-required');
    return pre;
  }
  if (!credentialPath || !/^sha256:[0-9a-f]{64}$/u.test(seal ?? '')) {
    pre.blockers.push('private-credentials-and-exact-release-seal-required');
    return pre;
  }
  // A caller's Playwright debugging settings can include network call details.
  if (
    process.env.DEBUG ||
    process.env.NODE_DEBUG ||
    process.env.PWDEBUG ||
    process.env.PWDEBUGIMPL
  ) {
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
      helloToNativeTurnEndMs: null,
      helloToCompleteReplyMs: null,
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
  let helloBinding;
  let stage = 'managedOwner';
  const signal = () => globalThis.AbortSignal.timeout(30_000);
  const active = () =>
    cancelled ? globalThis.AbortSignal.any([cancelled, signal()]) : signal();
  const assertActive = () =>
    requireFact(!cancelled?.aborted, 'acceptance-interrupted');
  const readBoots = async () => {
    assertActive();
    const workers = await owner.workerHealth({ release, signal: active() });
    return [
      checkHealth(workers, release, 'worker'),
      checkHealth(await publicHealth(active()), release),
    ];
  };
  const currentOperation = async () => {
    requireFact(isId(operationId), 'cleanup-dispatch-unconfirmed');
    const started = await owner.operationResult({
      identity,
      operationId,
      signal: signal(),
    });
    requireFact(
      started?.operationId === operationId,
      'cleanup-operation-mismatch',
    );
    return started;
  };
  const readVm = () => owner.exactVm({ identity, signal: signal() });
  function assertBoots(before, after) {
    requireFact(
      after.every((boot, index) => boot === before[index]),
      'service-restarted',
    );
  }
  try {
    assertActive();
    owner = await ownerSource(ownerPath, options.ownerDigest);
    assertActive();
    stage = 'credentials';
    const config = credentials(credentialPath);
    identity = config.identity;
    stage = 'operatorPreparation';
    const prepared = await owner.prepare({
      identity,
      username: config.account.username,
      release,
      signal: active(),
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
      signal: cancelled,
      sendHello,
      reopenWarm: false,
      beforeHello: async () => {
        assertBoots(before, await readBoots());
        const started = await currentOperation();
        requireFact(started.state === 'allocated', 'hello-start-unconfirmed');
        helloBinding = captureVmBinding(started.binding, identity);
        const current = await readVm();
        assertActive();
        requireFact(
          current?.state === 'running' && sameVmBinding(helloBinding, current),
          'hello-owner-changed',
        );
        recordHelloIntent({
          action:
            '以验收员在本次新员工及线程只发送一条“你好”，收到回复后结束。',
          release,
        });
      },
      onColdTicket: (id) => {
        operationId = id;
      },
    });
    requireFact(
      isId(operationId) &&
        receipt.browser.cold.prewarmRequests === 1 &&
        receipt.browser.carrierJoined === true &&
        receipt.stages.coldEditor === 'passed' &&
        (!sendHello || receipt.stages.hello === 'passed'),
      'public-workbench-unverified',
    );
    stage = 'releaseAfter';
    assertBoots(before, await readBoots());
    receipt.stages[stage] = 'passed';
  } catch (error) {
    fail(
      stage,
      cancelled?.aborted ? new CheckFailed('acceptance-interrupted') : error,
    );
  } finally {
    try {
      if (receipt.browser.cold.prewarmRequests) {
        requireFact(receipt.browser.closed, 'cleanup-dispatch-unconfirmed');
        const started = await currentOperation();
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
          requireFact(
            !helloBinding || sameVmBinding(helloBinding, binding),
            'cleanup-target-changed',
          );
          requireFact(
            started.carrierJoined === true,
            'cleanup-carrier-unconfirmed',
          );
          const current = await readVm();
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
              stopped.leaseReleased === true &&
              stopped.portReleased === true,
            'cleanup-unconfirmed',
          );
          const readback = await readVm();
          requireFact(
            readback?.state === 'stopped' &&
              sameVmBinding(binding, readback) &&
              readback.diskRetained === true &&
              readback.unmounted === true &&
              readback.leaseReleased === true &&
              readback.portReleased === true,
            'cleanup-readback-unconfirmed',
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
  if (cancelled?.aborted)
    fail('interrupted', new CheckFailed('acceptance-interrupted'));
  if (!receipt.firstFailure) receipt.status = 'passed';
  return receipt;
}
