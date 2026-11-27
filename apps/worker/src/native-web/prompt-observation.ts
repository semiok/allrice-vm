import { addAbortListener } from 'node:events';
import { randomUUID } from 'node:crypto';
import { UuidSchema } from '@allrice/contracts';
import { PersonVmError } from '@allrice/person-vm';
import { z } from 'zod';
import type { nativeWebTransport } from './transport.js';

const adoptedMessage = z
  .object({
    messageId: z.string().min(1).max(256),
    turn: z.number().int().positive(),
  })
  .strict();
export const NativePromptOccurrenceSchema = adoptedMessage.extend({
  sessionId: z.string().min(1).max(256),
  scopeId: UuidSchema,
  requestId: z.string().min(1).max(256),
});
export type NativePromptOccurrence = z.infer<
  typeof NativePromptOccurrenceSchema
>;

export function deferredPromptFact<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function waitForPromptFact<T>(
  fact: Promise<T>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const aborted = deferredPromptFact<never>();
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
  const ready = deferredPromptFact<void>();
  const claim = deferredPromptFact<z.infer<typeof adoptedMessage>>();
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
          } else if (record.startsWith('claimed ') && state === 'inserted') {
            const adopted = adoptedMessage.safeParse(
              JSON.parse(record.slice('claimed '.length)),
            );
            if (!adopted.success) throw failed();
            state = 'claimed';
            claim.resolve(adopted.data);
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
    async assertClaimed(
      active: AbortSignal,
      expected?: NativePromptOccurrence,
    ) {
      const adopted = await waitForPromptFact(
        claim.promise,
        AbortSignal.any([active, current]),
      );
      if (
        expected &&
        (expected.sessionId !== source.sessionId ||
          expected.scopeId !== source.scopeId ||
          expected.requestId !== source.requestId ||
          expected.messageId !== adopted.messageId ||
          expected.turn !== adopted.turn)
      )
        throw failed();
    },
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
