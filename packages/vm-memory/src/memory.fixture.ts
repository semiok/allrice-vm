/** Synthetic, event-driven host source. Never production telemetry. */
import type { PersonVmBinding } from '@allrice/person-vm';
import { VM_MEMORY_POLICY } from './contract.ts';
import type { VmMemoryObservation, VmMemorySource } from './contract.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
export function memoryObservation(
  binding: PersonVmBinding,
  pressure: VmMemoryObservation['pressure'] = 'normal',
): VmMemoryObservation {
  return {
    binding,
    revision: 'synthetic-1',
    evidenceRef: 'fixture:external-observer',
    pressure,
    physical: {
      configuredBytes: VM_MEMORY_POLICY.physicalBytes,
      enforcedBytes: VM_MEMORY_POLICY.physicalBytes,
    },
    host: { vmRssBytes: 1234, helperRssBytes: 567, swapBytes: 0 },
    guest: null,
  };
}
export class FixtureMemorySource implements VmMemorySource {
  observation: VmMemoryObservation | null;
  subscribers = new Set<() => void>();
  bindings: PersonVmBinding[] = [];
  waiting = deferred();
  detached = deferred();
  constructor(
    binding: PersonVmBinding,
    pressure: VmMemoryObservation['pressure'] = 'normal',
  ) {
    this.observation = memoryObservation(binding, pressure);
  }
  publish(value: VmMemoryObservation | null) {
    this.observation = value;
    for (const notify of this.subscribers) notify();
  }
  async watch(binding: PersonVmBinding, signal: AbortSignal) {
    signal.throwIfAborted();
    this.bindings.push(binding);
    let pending = false;
    let wake: (() => void) | undefined;
    let closed = false;
    const notify = () => {
      pending = true;
      wake?.();
      wake = undefined;
    };
    const close = async () => {
      closed = true;
      this.subscribers.delete(notify);
      signal.removeEventListener('abort', notify);
      notify();
      this.detached.resolve();
    };
    this.subscribers.add(notify);
    signal.addEventListener('abort', notify);
    return {
      read: () => this.observation,
      wait: async () => {
        this.waiting.resolve();
        signal.throwIfAborted();
        if (closed) throw Error('synthetic_watch_closed');
        if (!pending)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        pending = false;
        signal.throwIfAborted();
      },
      close,
    };
  }
}
