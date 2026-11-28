import { performance } from 'node:perf_hooks';

const boundaries = [
  'accepted',
  'epoch_reserved',
  'host_disk_net_ready',
  'restore_dispatch',
  'fresh_gate_connected',
  'freshness_confirmed',
  'work_verified',
  'native_editor_proof',
  'ready_committed',
];

const spans = [
  ['admission', 0, 1],
  ['hostDiskAndNetwork', 1, 2],
  ['resumeToGate', 3, 4],
  ['freshness', 4, 5],
  ['workMount', 5, 6],
  ['nativeEditor', 6, 7],
  ['readyCommit', 7, 8],
];

export function measureRestore(now = () => performance.now()) {
  const samples = [];
  return {
    mark(boundary) {
      const elapsed = now();
      if (
        boundary !== boundaries[samples.length] ||
        boundary === undefined ||
        !Number.isFinite(elapsed) ||
        elapsed < (samples.at(-1) ?? 0)
      ) {
        throw new Error('SNAPSHOT_TIMELINE_INVALID');
      }
      samples.push(elapsed);
    },
    read() {
      const between = (start, end) =>
        samples[end] === undefined ? null : samples[end] - samples[start];
      return {
        offsetsMs: Object.fromEntries(
          samples.map((value, index) => [
            boundaries[index],
            value - samples[0],
          ]),
        ),
        stagesMs: Object.fromEntries(
          spans.map(([name, start, end]) => [name, between(start, end)]),
        ),
        dispatchGapMs: between(2, 3),
        totalMs: between(0, 8),
      };
    },
  };
}
