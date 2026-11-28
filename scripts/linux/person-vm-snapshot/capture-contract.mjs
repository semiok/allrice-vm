import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
export const hashPattern = /^[0-9a-f]{64}$/;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const device = /^(?:0|[1-9]\d*):(?:0|[1-9]\d*)$/;

export function matches(pattern, value) {
  return (
    typeof value === 'string' && value === value.trim() && pattern.test(value)
  );
}

export const templateArchiveName = 'template.msb';

export const payloads = Object.freeze({
  [templateArchiveName]: 'metadata',
  'execution.bin': 'state',
  'memory.json': 'memory',
  'root-disk.json': 'root-disk',
  'runtime.ext4': 'dsh-runtime-disk',
  'device-topology.json': 'device-topology',
});

export function requireCapture(condition, reason) {
  if (!condition) throw new Error('Snapshot capture refused: ' + reason);
}

function hasKeys(value, expected) {
  return value && isDeepStrictEqual(Object.keys(value).sort(), expected.sort());
}

export function checkHostPreflight(host, preflight) {
  requireCapture(
    hasKeys(preflight, [
      'kvmApi',
      'reflink',
      'msbVersion',
      'kernel',
      'pageBytes',
      'dataUuid',
      'dataDevice',
      'scratchUuid',
      'scratchLuksUuid',
      'scratchDevice',
    ]) &&
      preflight.kvmApi === host.kvmApiVersion &&
      preflight.kvmApi === 12 &&
      preflight.reflink === true &&
      preflight.msbVersion === '0.7.16' &&
      preflight.kernel === host.kernel &&
      preflight.pageBytes === host.pageSize &&
      matches(uuid, preflight.dataUuid) &&
      matches(uuid, preflight.scratchUuid) &&
      matches(uuid, preflight.scratchLuksUuid) &&
      preflight.dataUuid !== preflight.scratchUuid &&
      matches(device, preflight.dataDevice) &&
      matches(device, preflight.scratchDevice) &&
      preflight.dataDevice !== preflight.scratchDevice,
    'Linux host-preflight ABI or scratch identity mismatch',
  );
}

export function checkCaptureReceipt(capture, { expected, mode }) {
  requireCapture(
    hasKeys(capture, [
      'version',
      'mode',
      'engineVersion',
      'boot',
      'cleanup',
      'full',
      'integrityVerified',
      'preflight',
      'host',
      'guest',
      'inputs',
      'deviceTopologySha256',
      'audit',
      'files',
    ]) &&
      capture.version === 1 &&
      capture.mode === mode &&
      capture.engineVersion === '0.7.16' &&
      capture.boot === 'new-offline-public-oci' &&
      capture.cleanup === 'stopped-and-removed' &&
      capture.full === true &&
      capture.integrityVerified === true,
    'missing build, integrity or cleanup proof',
  );
  checkHostPreflight(expected.host, capture.preflight);
  requireCapture(
    isDeepStrictEqual(capture.host, expected.host) &&
      isDeepStrictEqual(capture.guest, expected.guest) &&
      isDeepStrictEqual(capture.inputs, expected.inputs) &&
      capture.deviceTopologySha256 === expected.deviceTopologySha256,
    'capture compatibility mismatch',
  );
  requireCapture(
    isDeepStrictEqual(capture.audit, {
      version: 1,
      workEmpty: true,
      approvedMounts: true,
      approvedProcessesAndDescriptors: true,
      noTenantFiles: true,
      noSeedFiles: true,
      noInetSockets: true,
      noSwap: true,
      pageSize: expected.guest.pageSize,
    }),
    'missing empty-guest audit',
  );
  const items = capture.files;
  requireCapture(
    Array.isArray(items) &&
      items.length === Object.keys(payloads).length &&
      Object.keys(payloads).every(
        (path) =>
          items.filter(
            (file) =>
              file.path === path &&
              file.role === payloads[path] &&
              Number.isSafeInteger(file.sizeBytes) &&
              file.sizeBytes > 0 &&
              matches(hashPattern, file.sha256),
          ).length === 1,
      ),
    'invalid capture file inventory',
  );
  requireCapture(
    items.find((file) => file.role === 'dsh-runtime-disk').sha256 ===
      expected.inputs.dshRuntimeDiskSha256 &&
      items.find((file) => file.role === 'device-topology').sha256 ===
        expected.deviceTopologySha256,
    'capture input digest mismatch',
  );
}

export function firstDayIndex(run, receiptBytes, mode) {
  const validTarget =
    (mode === 'fixture' && run?.target === 'local-fixture') ||
    (mode === 'linux' && matches(/^i-[0-9a-f]{17}$/, run?.target));
  requireCapture(
    validTarget &&
      hasKeys(run, ['mode', 'target', 'id', 'commit', 'tree', 'seal']) &&
      run.mode === mode &&
      matches(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, run.id) &&
      matches(/^[0-9a-f]{40}$/, run.commit) &&
      matches(/^[0-9a-f]{40}$/, run.tree) &&
      matches(/^sha256:[0-9a-f]{64}$/, run.seal),
    'invalid first-day identity',
  );
  return {
    version: 1,
    run,
    records: [
      {
        step: 'preflight',
        run,
        result: 'pass',
        artifact: { file: 'capture.json', sha256: sha256(receiptBytes) },
      },
      ...[
        'host',
        'single-vm',
        'workbench',
        'timing',
        'concurrency',
        'recovery',
      ].map((step) => ({ step, run, result: 'skip', reason: 'not-run' })),
    ],
  };
}
