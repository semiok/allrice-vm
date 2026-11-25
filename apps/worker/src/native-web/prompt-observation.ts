import { addAbortListener } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PersonVmError } from '@allrice/person-vm';
import type { nativeWebTransport } from './transport.js';

export async function waitForPromptFact<T>(
  fact: Promise<T>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const listener = addAbortListener(signal, () =>
    aborted.reject(signal.reason),
  );
  try {
    return await Promise.race([fact, aborted.promise]);
  } finally {
    listener[Symbol.dispose]();
  }
}

export function observeNativePrompt(
  transport: Pick<
    ReturnType<typeof nativeWebTransport>,
    'readManagedModelProof'
  >,
  source: {
    adapterId: string;
    sessionId: string;
    scopeId: string;
    requestId: string;
  },
  signal: AbortSignal,
  setupTimeoutMs: number,
) {
  const close = new AbortController();
  const current = AbortSignal.any([signal, close.signal]);
  const request = { ...source, id: randomUUID() };
  const ready = Promise.withResolvers<void>();
  const claim = Promise.withResolvers<void>();
  const failed = () => new PersonVmError('PROVIDER_FAILED');
  let state: 'opening' | 'ready' | 'inserted' | 'claimed' = 'opening';
  let terminal: 'discarded' | 'ended' | undefined;
  let tail = '';
  const settled = transport
    .readManagedModelProof(
      JSON.stringify({ ...request, action: 'observe-prompt' }),
      current,
      false,
      (chunk) => {
        const records = (tail + chunk.toString('latin1')).split('\n');
        tail = records.pop()!;
        for (const record of records) {
          if (terminal) throw failed();
          if (record === 'ready' && state === 'opening') {
            state = 'ready';
            ready.resolve();
          } else if (record === 'inserted' && state === 'ready') {
            state = 'inserted';
          } else if (record === 'claimed' && state === 'inserted') {
            state = 'claimed';
            claim.resolve();
          } else if (
            (record === 'discarded' && state === 'inserted') ||
            (record === 'ended' && state === 'claimed')
          ) {
            terminal = record;
          } else throw failed();
        }
      },
    )
    .then(() => {
      if (tail || !terminal) throw failed();
      if (terminal === 'discarded') claim.reject(failed());
      return terminal;
    });
  void settled.catch((error: unknown) => {
    ready.reject(error);
    claim.reject(error);
  });
  void claim.promise.catch(() => {});
  const readySignal = AbortSignal.any([
    current,
    AbortSignal.timeout(setupTimeoutMs),
  ]);
  return {
    ready: waitForPromptFact(ready.promise, readySignal),
    settled,
    async close() {
      close.abort();
      await settled.catch(() => {});
    },
    inserted: () => state === 'inserted' || state === 'claimed',
    assertClaimed: (active: AbortSignal) =>
      waitForPromptFact(claim.promise, AbortSignal.any([active, current])),
    /** Called only after a verified successful native prompt reply. The
     * native RPC commits any new inbox occurrence before acknowledging it. */
    async confirmedReplay() {
      if (state === 'inserted' || state === 'claimed') return false;
      const response = await transport.readManagedModelProof(
        JSON.stringify({ ...request, action: 'prompt-outcome' }),
        AbortSignal.any([current, AbortSignal.timeout(setupTimeoutMs)]),
      );
      return response === '{"inserted":false}';
    },
  };
}

export type NativePromptObservation = ReturnType<typeof observeNativePrompt>;
