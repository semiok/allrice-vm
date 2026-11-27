import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const publicOrigin = 'https://allricevm.bplabs.xyz';
export const entry = '/chatflow/4.0';
export const paths = {
  login: '/api/v1/auth/login',
  employee: '/api/v1/employee-instances',
  prewarm: '/api/v1/d-entry/native-prewarm',
  poll: '/api/v1/d-entry/native-prewarm/status',
  thread: '/api/v1/sessions',
  identity: '/api/v1/d-entry/identity',
  mux: '/api/v1/d-entry/native-mux',
  rpc: '/api/v1/d-entry/native-rpc',
  policy: '/api/v1/admin/d-entry-release-policy',
};
export const repo = 'semiok/allrice-vm';
export const repoId = 1469490636;

const sha = /^[a-f0-9]{40}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && uuid.test(value);
export const peoplePath = (org) => `/api/v1/admin/organizations/${org}/people`;
export const DSH_EDITOR = '[role="textbox"][data-composer-input]';

export class CheckFailed extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function requireFact(condition, code, status) {
  if (!condition) throw new CheckFailed(code, status);
}

export function failure(stage, error) {
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

export function checkHealth(response, release, service = 'web') {
  const info = response.body?.identity;
  requireFact(
    response.status === 200 &&
      response.body?.status === 'ready' &&
      info?.repository === repo &&
      String(info.repositoryId) === String(repoId) &&
      info?.service === service &&
      info.environment === 'dev' &&
      info.mode === 'production' &&
      info.sourceSha === release.sha &&
      info.sourceTree === release.tree &&
      (!release.seal || info.manifestDigest === release.seal) &&
      isId(info.bootId),
    'release-identity-mismatch',
    response.status,
  );
  return info.bootId;
}

export const sameSelection = (selection, expected) =>
  selection &&
  expected &&
  selection.workspaceId === expected.workspaceId &&
  selection.employeeInstanceId === expected.employeeInstanceId &&
  selection.threadId === expected.threadId;

// The host-only PersonVmBinding contract. None of these values reach receipts.
const vmIdFields = ['vmId', 'personId', 'organizationId', 'instanceId'];
export const sameVmBinding = (left, right) =>
  left &&
  right &&
  left.leaseEpoch === right.leaseEpoch &&
  vmIdFields.every((key) => left[key] === right[key]);

export function captureVmBinding(binding, identity) {
  requireFact(
    binding &&
      vmIdFields.every((key) => isId(binding[key])) &&
      binding.personId === identity.personId &&
      binding.organizationId === identity.organizationId &&
      Number.isSafeInteger(binding.leaseEpoch) &&
      binding.leaseEpoch > 0,
    'start-binding-unverified',
  );
  return Object.freeze({
    vmId: binding.vmId,
    personId: binding.personId,
    organizationId: binding.organizationId,
    instanceId: binding.instanceId,
    leaseEpoch: binding.leaseEpoch,
  });
}

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const originMain = 'refs/remotes/origin/main';
const prerequisites = {
  'async-prewarm': '1db5c856d66cdda41a429a2be0625a50d8ad50ce',
  'system-disk-and-dsh-startup': '70042d3cca750229f4ae96b96fdd8d76552d039c',
};

function localGit(args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  }).trim();
}

/** Check local source evidence before a future operator could use credentials. */
export function livePreflight(options, git = localGit) {
  const { allowPublicWrites, releaseSha, releaseTree, ownerPath } = options;
  const expected =
    sha.test(releaseSha ?? '') && sha.test(releaseTree ?? '')
      ? { sha: releaseSha, tree: releaseTree }
      : null;
  const receipt = {
    mode: 'live',
    status: 'blocked',
    requestedRelease: expected,
    localRef: null,
    blockers: [],
  };
  const { blockers } = receipt;
  if (!allowPublicWrites || !expected) {
    blockers.push('explicit-live-approval-and-exact-release-required');
    return receipt;
  }
  try {
    const main = git(['rev-parse', '--verify', originMain + '^{commit}']);
    requireFact(sha.test(main), 'local-release-sha-invalid');
    // Resolve the tree from the commit just read, even if the ref moves.
    const tree = git(['rev-parse', '--verify', main + '^{tree}']);
    requireFact(sha.test(tree), 'local-release-tree-invalid');
    receipt.localRef = { name: originMain, sha: main, tree };
    if (main !== releaseSha || tree !== releaseTree)
      blockers.push('local-origin-main-release-mismatch');
    for (const [name, commit] of Object.entries(prerequisites)) {
      try {
        git(['merge-base', '--is-ancestor', commit, main]);
      } catch {
        blockers.push(`${name}-merge-unverified`);
      }
    }
    try {
      git([
        'grep',
        '-q',
        '<EmployeeFirstStart',
        main,
        '--',
        'apps/web/app/chatflow/4.0/page.tsx',
      ]);
      git([
        'grep',
        '-q',
        'expectedOwnerId: workspace.viewerId',
        main,
        '--',
        'apps/web/app/chatflow/employee-create-dialog.tsx',
      ]);
    } catch {
      blockers.push('zero-employee-page-wiring-unverified');
    }
    try {
      git([
        'grep',
        '-q',
        'createEmployeeLinuxCapture(config.native, runtime)',
        main,
        '--',
        'scripts/dev-release/prepare-identity.mjs',
      ]);
      git([
        'cat-file',
        '-e',
        `${main}:scripts/person-vm-image/employee-profile.mjs`,
      ]);
    } catch {
      blockers.push('employee-linux-profile-sealing-unverified');
    }
  } catch {
    blockers.push('repository-release-unavailable');
  }
  // Production authority explicitly denies public stops. No public browser run
  // may start a VM until an authorized same-Worker exact-owner stop is bound.
  if (!ownerPath) blockers.push('managed-exact-owner-stop-unavailable');
  return receipt;
}
