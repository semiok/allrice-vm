/* global AbortSignal */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';

import {
  LinuxSnapshotConfigurationSchema,
  PersonVmTemplateManifestSchema,
} from '../../../packages/person-vm/src/template-snapshot-contract.ts';
import { measureRestore } from './measure.mjs';

/** @typedef {import('../../../packages/person-vm/src/template-snapshot-contract.ts').PersonVmTemplatePort} PersonVmTemplatePort */

const bindingFields = [
  'organizationId',
  'personId',
  'vmId',
  'instanceId',
  'leaseEpoch',
];

function isBinding(binding) {
  return (
    binding &&
    bindingFields
      .slice(0, -1)
      .every((key) => typeof binding[key] === 'string' && binding[key]) &&
    Number.isSafeInteger(binding.leaseEpoch) &&
    binding.leaseEpoch > 0
  );
}

function sameBinding(expected, observed) {
  return (
    observed && bindingFields.every((key) => expected[key] === observed[key])
  );
}

function sameDisk(expected, observed) {
  return (
    sameBinding(expected.binding, observed?.binding) &&
    expected.image?.device === observed.image?.device &&
    expected.image?.inode === observed.image?.inode &&
    expected.mountId === observed.mountId &&
    expected.workDirectory === observed.workDirectory
  );
}

function sameCompute(expected, observed) {
  return (
    observed?.pid === expected.pid && observed.startedAt === expected.startedAt
  );
}

function requireProof(condition, code) {
  if (!condition) throw new ProbeFailure(code);
}

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
  }
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function hostPath(path) {
  return (
    typeof path === 'string' &&
    path.length < 4096 &&
    path.startsWith('/') &&
    !path.endsWith('/') &&
    posix.normalize(path) === path &&
    !path.includes(':') &&
    [...path].every((char) => char >= ' ' && char.charCodeAt(0) !== 127)
  );
}

function inside(path, root) {
  return path === root || path.startsWith(root + '/');
}

function strictRestoreArgs({ template, binding, disk, control }) {
  const descriptors = template.manifest.files.filter(
    ({ path }) => posix.basename(path) === 'snapshot.json',
  );
  requireProof(descriptors.length === 1, 'SNAPSHOT_DESCRIPTOR_UNPROVED');
  const snapshotPath = posix.dirname(
    posix.join(template.seal.templateDirectory, descriptors[0].path),
  );
  requireProof(
    [snapshotPath, disk.workDirectory, control.socketPath].every(hostPath) &&
      inside(snapshotPath, template.seal.templateDirectory) &&
      !inside(disk.workDirectory, template.seal.templateDirectory) &&
      !inside(template.seal.templateDirectory, disk.workDirectory) &&
      !inside(control.socketPath, disk.workDirectory) &&
      !inside(disk.workDirectory, control.socketPath) &&
      !inside(control.socketPath, template.seal.templateDirectory) &&
      !inside(template.seal.templateDirectory, control.socketPath) &&
      Number.isInteger(control.port) &&
      control.port > 0 &&
      control.port <= 65535,
    'UNSAFE_RESTORE_INPUT',
  );
  const name =
    'probe-' + digest(JSON.stringify(bindingFields.map((key) => binding[key])));
  return Object.freeze([
    'snap',
    'restore',
    snapshotPath,
    '--name',
    name,
    '--cow-mem',
    '--external-mount-policy',
    'strict',
    '--volume',
    disk.workDirectory + ':/work',
    '--vsock',
    control.socketPath + ':' + control.port + '/stream',
    '--net-default',
    'deny',
  ]);
}

function addOnce(seen, value, code) {
  requireProof(!seen.has(value), code);
  seen.add(value);
}

async function confirmFreshness({
  scope,
  binding,
  compute,
  egress,
  control,
  isolationId,
  signal,
  seen,
  random,
  timeline,
}) {
  const stream = await scope.connectGate(compute, signal);
  signal.throwIfAborted();
  requireProof(
    stream.waitingVersion === 1 &&
      sameBinding(binding, stream.binding) &&
      sameCompute(compute, stream.compute) &&
      stream.endpoint === control.socketPath,
    'GATE_PEER_UNVERIFIED',
  );
  timeline.mark('fresh_gate_connected');
  const frame = Buffer.alloc(65);
  frame[0] = 1;
  let challenge, entropy, response;
  try {
    challenge = random(32);
    entropy = random(32);
    requireProof(
      Buffer.isBuffer(challenge) &&
        Buffer.isBuffer(entropy) &&
        challenge.length === 32 &&
        entropy.length === 32,
      'HOST_RANDOM_UNAVAILABLE',
    );
    addOnce(seen.challenges, digest(challenge), 'CHALLENGE_REUSED');
    addOnce(seen.entropy, digest(entropy), 'ENTROPY_REUSED');
    challenge.copy(frame, 1);
    entropy.copy(frame, 33);
    response = await stream.exchange(frame, signal);
    signal.throwIfAborted();
    requireProof(
      Buffer.isBuffer(response) &&
        response.length === 65 &&
        response[0] === 1 &&
        timingSafeEqual(response.subarray(1, 33), challenge),
      'GATE_RESEED_UNCONFIRMED',
    );
    const sample = response.subarray(33);
    requireProof(
      !timingSafeEqual(sample, entropy) && !timingSafeEqual(sample, challenge),
      'GUEST_RANDOM_INVALID',
    );
    addOnce(seen.samples, digest(sample), 'GUEST_RANDOM_REUSED');
  } finally {
    frame.fill(0);
    if (Buffer.isBuffer(challenge)) challenge.fill(0);
    if (Buffer.isBuffer(entropy)) entropy.fill(0);
    if (Buffer.isBuffer(response)) response.fill(0);
  }

  const identity = await scope.confirmIsolation(compute, signal);
  signal.throwIfAborted();
  requireProof(
    sameBinding(binding, identity?.binding) &&
      sameCompute(compute, identity.compute) &&
      identity.endpoint === control.socketPath &&
      identity.isolationId === isolationId &&
      identity.egressBindingId === egress.bindingId &&
      identity.blockedBusinessRoutes === true &&
      identity.priorNetworkStateGone === true &&
      identity.freshNetworkIdentity === true &&
      identity.freshControlIdentity === true &&
      identity.cgroupVerified === true &&
      identity.runtimeReset === true,
    'FRESH_ISOLATION_UNPROVED',
  );
  timeline.mark('freshness_confirmed');
}

/**
 * The synthetic native driver joins each call. It owns the paused gate, and
 * verifies a new private endpoint/peer, namespace and cgroup against the exact
 * compute. The driver must spawn synchronously within dispatchCurrent's callback.
 * The authority fence must exclude rollover of the lease and both receipts
 * through that invocation. The driver reports partial ownership to the same
 * scope. There is no default runner, production owner or credential issuer.
 *
 * @returns {PersonVmTemplatePort}
 */
function scopedTemplatePort(
  native,
  scope,
  seen,
  random,
  qualify,
  timeline,
  gateTimeoutMs,
  resources,
) {
  const { control, isolationId } = resources;
  return {
    qualify,
    inspect: (binding, signal) => native.inspect(binding, signal),
    stopAndJoin: (binding, signal) => native.stopAndJoin(binding, signal),
    async restore({
      template,
      binding,
      disk,
      egress,
      assertCurrent,
      onNativeDispatch,
      signal,
    }) {
      const argv = strictRestoreArgs({
        template,
        binding,
        disk,
        control,
      });
      await assertCurrent(signal);
      const receipt = await native.restoreStrict({
        binding,
        argv,
        signal,
        template,
        disk,
        egress,
        async dispatchCurrent(start) {
          await assertCurrent(signal);
          // The scope validates the current lease and both pinned receipts as
          // one authority and invokes start under that authority.
          return scope.withCurrentAuthority(
            { binding, ...resources },
            signal,
            () => {
              signal.throwIfAborted();
              onNativeDispatch();
              return start();
            },
          );
        },
      });
      signal.throwIfAborted();
      requireProof(
        sameBinding(binding, receipt?.binding) &&
          receipt.templateDigest === template.seal.manifestSha256 &&
          receipt.memoryMode === 'cow' &&
          Number.isSafeInteger(receipt.computeIdentity?.pid) &&
          receipt.computeIdentity.pid > 0 &&
          typeof receipt.computeIdentity.startedAt === 'string' &&
          receipt.computeIdentity.startedAt.length > 0,
        'NATIVE_RESTORE_UNPROVED',
      );
      const compute = receipt.computeIdentity;
      const deadline = AbortSignal.timeout(gateTimeoutMs);
      try {
        await confirmFreshness({
          scope,
          binding,
          compute,
          egress,
          control,
          isolationId,
          seen,
          random,
          timeline,
          signal: AbortSignal.any([signal, deadline]),
        });
      } catch (error) {
        if (!signal.aborted && deadline.aborted)
          throw new ProbeFailure('GATE_DEADLINE_EXPIRED');
        throw error;
      }
      const mount = await scope.verifyMountedWork(compute, signal);
      requireProof(
        sameCompute(compute, mount?.compute) &&
          mount.path === '/work' &&
          sameDisk(disk, mount.ownedDisk) &&
          mount.verifiedAgainstOwnedDisk === true,
        'WORK_MOUNT_UNPROVED',
      );
      await assertCurrent(signal);
      timeline.mark('work_verified');
      return {
        binding,
        templateDigest: template.seal.manifestSha256,
        computeIdentity: compute,
        controlEndpoint: control.socketPath,
        mountIdentity: disk,
        guestWorkMount: {
          path: '/work',
          sourceMountId: disk.mountId,
          verifiedAgainstOwnedDisk: true,
        },
        networkIdentity: {
          isolationId,
          egressBindingId: egress.bindingId,
        },
        freshness: {
          kernelEntropyReseeded: true,
          userRuntimeReinitialized: true,
          networkIdentityRefreshed: true,
          cgroupVerified: true,
          controlEndpointFresh: true,
          controlPeerVerified: true,
          controlChallengeConsumed: true,
        },
      };
    },
  };
}

async function confirmed(operation) {
  try {
    return (await operation()) === true;
  } catch {
    return false;
  }
}

async function cleanup({
  lease,
  binding,
  scope,
  port,
  nativeAttempted,
  dispatched,
  destinationUnconfirmed,
}) {
  if (!lease) return true;
  const cleanupSignal = AbortSignal.timeout(30_000);
  const fenced =
    !scope || (await confirmed(() => scope.fenceAndJoin(cleanupSignal)));
  const stopped =
    !dispatched ||
    (await confirmed(async () => {
      const receipt = await port.stopAndJoin(binding, cleanupSignal);
      if (
        receipt?.state !== 'stopped' ||
        !sameBinding(binding, receipt.binding) ||
        receipt.nativeGone !== true ||
        receipt.operationsJoined !== true ||
        receipt.networkClosed !== true
      )
        return false;
      const state = await port.inspect(binding, cleanupSignal);
      return state === 'stopped' || state === 'absent';
    }));
  const undispatched =
    !nativeAttempted ||
    dispatched ||
    (await confirmed(
      async () => (await port.inspect(binding, cleanupSignal)) === 'absent',
    ));
  if (
    destinationUnconfirmed ||
    !fenced ||
    !stopped ||
    !undispatched ||
    cleanupSignal.aborted
  )
    return false;
  if (scope && !(await confirmed(() => scope.release(cleanupSignal))))
    return false;
  return confirmed(() => lease.release(cleanupSignal));
}

/** Shares replay checks across the synthetic clones in a probe batch.
 * Stream operations must abort and join on their signal before returning. */
export function createRestoreProbe({
  qualify,
  reserve,
  openScope,
  native,
  now,
  random = randomBytes,
  gateTimeoutMs = 5000,
}) {
  requireProof(
    Number.isSafeInteger(gateTimeoutMs) &&
      gateTimeoutMs > 0 &&
      gateTimeoutMs <= 30_000,
    'GATE_DEADLINE_INVALID',
  );
  const seen = {
    challenges: new Set(),
    entropy: new Set(),
    samples: new Set(),
    controls: new Set(),
    isolation: new Set(),
  };
  return async ({ seal, signal, disconnected }) => {
    const runSignal = AbortSignal.any(
      disconnected ? [signal, disconnected] : [signal],
    );
    const timeline = measureRestore(now);
    let lease;
    let binding;
    let scope;
    let port;
    let resources;
    let destinationUnconfirmed = false;
    let nativeAttempted = false;
    let dispatched = false;
    let stage = 'admission';
    let failure = null;
    try {
      timeline.mark('accepted');
      runSignal.throwIfAborted();
      const config = LinuxSnapshotConfigurationSchema.parse(seal);
      if (!config.enabled) throw new ProbeFailure('PROBE_DISABLED');
      lease = await reserve(runSignal);
      requireProof(isBinding(lease.binding), 'LEASE_BINDING_INVALID');
      binding = Object.freeze({ ...lease.binding });
      const assertCurrent = async (currentSignal) => {
        currentSignal.throwIfAborted();
        await lease.assertCurrent(currentSignal);
        if (resources) {
          currentSignal.throwIfAborted();
          const current = await scope.readOwnedReceipts(currentSignal);
          requireProof(
            sameDisk(resources.disk, current?.disk) &&
              sameBinding(binding, current.egress?.binding) &&
              current.egress.bindingId === resources.egress.bindingId &&
              Array.isArray(current.egress.gatewayPorts) &&
              current.egress.gatewayPorts.length === 0 &&
              current.control?.socketPath === resources.control.socketPath &&
              current.control.port === resources.control.port &&
              current.isolationId === resources.isolationId &&
              current.networkFenced === true,
            'OWNED_RESOURCES_CHANGED',
          );
          await lease.assertCurrent(currentSignal);
        }
        currentSignal.throwIfAborted();
      };
      await assertCurrent(runSignal);
      const qualified = await qualify(config, runSignal);
      requireProof(
        qualified.seal?.manifestSha256 === config.manifestSha256 &&
          qualified.seal?.templateDirectory === config.templateDirectory,
        'TEMPLATE_IDENTITY_MISMATCH',
      );
      const template = {
        seal: config,
        manifest: PersonVmTemplateManifestSchema.parse(qualified.manifest),
      };
      await assertCurrent(runSignal);
      timeline.mark('epoch_reserved');

      stage = 'host_disk_and_network';
      destinationUnconfirmed = true;
      requireProof(
        (await native.inspect(binding, runSignal)) === 'absent',
        'DESTINATION_NOT_PROVEN_ABSENT',
      );
      destinationUnconfirmed = false;
      await assertCurrent(runSignal);
      // openScope only establishes ownership; prepare owns every I/O it starts.
      scope = openScope(binding);
      await scope.prepare(template, runSignal);
      const { disk, egress, control, isolationId, networkFenced } =
        await scope.readOwnedReceipts(runSignal);
      requireProof(
        sameBinding(binding, disk?.binding) &&
          typeof disk.mountId === 'string' &&
          disk.mountId.length > 0 &&
          typeof disk.image?.device === 'string' &&
          disk.image.device.length > 0 &&
          typeof disk.image?.inode === 'string' &&
          disk.image.inode.length > 0 &&
          sameBinding(binding, egress?.binding) &&
          typeof egress.bindingId === 'string' &&
          egress.bindingId.length > 0 &&
          Array.isArray(egress.gatewayPorts) &&
          egress.gatewayPorts.length === 0 &&
          control &&
          typeof isolationId === 'string' &&
          isolationId.length > 0 &&
          networkFenced === true,
        'OWNED_RESOURCES_UNPROVED',
      );
      resources = {
        disk: Object.freeze({
          ...disk,
          binding,
          image: Object.freeze({ ...disk.image }),
        }),
        egress: Object.freeze({
          ...egress,
          binding,
          gatewayPorts: Object.freeze([]),
        }),
        control: Object.freeze({ ...control }),
        isolationId,
      };
      timeline.mark('host_disk_net_ready');

      stage = 'restore';
      // A driver that fails before its dispatch hook must still prove absence.
      port = scopedTemplatePort(
        {
          inspect: native.inspect.bind(native),
          stopAndJoin: native.stopAndJoin.bind(native),
          async restoreStrict(input) {
            nativeAttempted = true;
            const receipt = await native.restoreStrict(input);
            requireProof(dispatched, 'DISPATCH_UNRECORDED');
            return receipt;
          },
        },
        scope,
        seen,
        random,
        qualify,
        timeline,
        gateTimeoutMs,
        resources,
      );
      const restored = await port.restore({
        template,
        binding,
        disk: resources.disk,
        egress: resources.egress,
        assertCurrent,
        signal: runSignal,
        onNativeDispatch() {
          requireProof(!dispatched, 'RESTORE_ALREADY_DISPATCHED');
          addOnce(
            seen.controls,
            resources.control.socketPath,
            'CONTROL_ENDPOINT_REUSED',
          );
          addOnce(
            seen.isolation,
            resources.isolationId,
            'NETWORK_IDENTITY_REUSED',
          );
          runSignal.throwIfAborted();
          timeline.mark('restore_dispatch');
          dispatched = true;
        },
      });
      stage = 'editor';
      await assertCurrent(runSignal);
      const editor = await scope.withCurrentAuthority(
        { binding, ...resources },
        runSignal,
        () => {
          runSignal.throwIfAborted();
          return scope.probeSyntheticEditor(restored, runSignal);
        },
      );
      requireProof(
        sameBinding(binding, editor?.binding) && editor.editorReady === true,
        'EDITOR_PROOF_UNAVAILABLE',
      );
      timeline.mark('native_editor_proof');
      stage = 'ready';
      await assertCurrent(runSignal);
      requireProof(
        (await scope.withCurrentAuthority(
          { binding, ...resources },
          runSignal,
          () => {
            runSignal.throwIfAborted();
            return scope.confirmSyntheticReady(restored, runSignal);
          },
        )) === true,
        'READY_UNCONFIRMED',
      );
      await assertCurrent(runSignal);
      timeline.mark('ready_committed');
    } catch (error) {
      failure = {
        stage,
        code: runSignal.aborted
          ? 'INTERRUPTED'
          : error instanceof ProbeFailure
            ? error.message
            : 'PROBE_STEP_FAILED',
      };
    }
    const resourcesReleased = await cleanup({
      lease,
      binding,
      scope,
      port,
      nativeAttempted,
      dispatched,
      destinationUnconfirmed,
    });
    return {
      evidence: 'synthetic',
      failure:
        failure ??
        (resourcesReleased
          ? null
          : {
              stage: 'cleanup',
              code: 'RESOURCE_RELEASE_UNCONFIRMED',
            }),
      resourcesReleased,
      timeline: timeline.read(),
    };
  };
}
