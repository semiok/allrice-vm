import { addAbortListener } from 'node:events';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { UuidSchema } from '@allrice/contracts';
import { PersonVmError } from '@allrice/person-vm';
import { z } from 'zod';
import type { nativeWebTransport } from './transport.js';

const nativeMessageId = z.string().min(1).max(256);
const insertedMessage = z.object({ messageId: nativeMessageId }).strict();
const insertedOutcome = z
  .object({ messageId: nativeMessageId.nullable() })
  .strict();
const adoptedMessage = z
  .object({
    messageId: nativeMessageId,
    turn: z.number().int().positive(),
  })
  .strict();
export const NativePromptOccurrenceSchema = adoptedMessage.extend({
  sessionId: z.string().min(1).max(256),
  parentSessionId: z.string().min(1).max(256).optional(),
  scopeId: UuidSchema,
  requestId: z.string().min(1).max(256),
});
export type NativePromptOccurrence = z.infer<
  typeof NativePromptOccurrenceSchema
>;

export const NativeAdoptedTextSchema = z
  .object({
    occurrence: NativePromptOccurrenceSchema,
    kind: z.enum(['ordinary-human-message', 'adopted-steering']),
    sequence: z.number().int().nonnegative(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export const NativeRequestObservationSchema = z
  .object({
    request: z
      .object({
        provider: z.string().min(1).max(128),
        model: z.string().min(1).max(128),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict()
      .nullable(),
    human: NativeAdoptedTextSchema.nullable(),
    proofState: z.enum([
      'adopted',
      'no-unique-text',
      'no-matching-attempt',
      'no-matching-claim',
      'competing-inbox-input',
    ]),
  })
  .strict();

const nativeToolObservation = z
  .object({
    attemptId: z.string().min(1).max(512),
    assistantSequence: z.number().int().nonnegative(),
    callId: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    sequence: z.number().int().nonnegative(),
    human: NativeAdoptedTextSchema,
  })
  .strict();

export type NativeToolObservation = z.infer<typeof nativeToolObservation>;
export type NativeRequestObservation = z.infer<
  typeof NativeRequestObservationSchema
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
    parentSessionId?: string;
    scopeId: string;
    requestId: string;
  },
  signal: AbortSignal,
  setupTimeoutMs: number,
  onTool?: (fact: NativeToolObservation) => void,
) {
  const close = new AbortController();
  const current = AbortSignal.any([signal, close.signal]);
  const request = { ...source, id: randomUUID() };
  const ready = deferredPromptFact<void>();
  const insertion = deferredPromptFact<string>();
  const claim = deferredPromptFact<z.infer<typeof adoptedMessage>>();
  const failed = () => new PersonVmError('PROVIDER_FAILED');
  let state: 'opening' | 'ready' | 'inserted' | 'claimed' = 'opening';
  let terminal: 'discarded' | 'ended' | undefined;
  let insertedMessageId: string | undefined;
  let tail = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function recordInsertion(messageId: string) {
    if (insertedMessageId && insertedMessageId !== messageId) throw failed();
    insertedMessageId = messageId;
    insertion.resolve(messageId);
  }
  async function readInsertedMessageId(active: AbortSignal) {
    const checking = AbortSignal.any([
      active,
      current,
      AbortSignal.timeout(setupTimeoutMs),
    ]);
    checking.throwIfAborted();
    if (insertedMessageId) return insertedMessageId;
    const response = await transport.readManagedModelProof(
      JSON.stringify({ ...request, action: 'prompt-outcome' }),
      checking,
    );
    checking.throwIfAborted();
    // The observer disappears at terminal, but its original stream still
    // carries the insertion ahead of that terminal.
    if (!response) return waitForPromptFact(insertion.promise, checking);
    const outcome = insertedOutcome.safeParse(JSON.parse(response));
    if (!outcome.success) throw failed();
    if (outcome.data.messageId) recordInsertion(outcome.data.messageId);
    return insertedMessageId;
  }
  const settled = transport
    .readManagedModelProof(
      JSON.stringify({ ...request, action: 'observe-prompt' }),
      current,
      false,
      (chunk) => {
        const records = (tail + decoder.decode(chunk, { stream: true })).split(
          '\n',
        );
        tail = records.pop()!;
        for (const record of records) {
          if (terminal) throw failed();
          if (record === 'ready' && state === 'opening') {
            state = 'ready';
            ready.resolve();
          } else if (record.startsWith('inserted ') && state === 'ready') {
            const item = insertedMessage.safeParse(
              JSON.parse(record.slice('inserted '.length)),
            );
            if (!item.success) throw failed();
            state = 'inserted';
            recordInsertion(item.data.messageId);
          } else if (record.startsWith('claimed ') && state === 'inserted') {
            const adopted = adoptedMessage.safeParse(
              JSON.parse(record.slice('claimed '.length)),
            );
            if (
              !adopted.success ||
              adopted.data.messageId !== insertedMessageId
            )
              throw failed();
            state = 'claimed';
            claim.resolve(adopted.data);
          } else if (record.startsWith('tool ') && state === 'claimed') {
            const fact = nativeToolObservation.safeParse(
              JSON.parse(record.slice(5)),
            );
            if (
              fact.success &&
              fact.data.human.occurrence.messageId === insertedMessageId &&
              fact.data.human.occurrence.sessionId === source.sessionId &&
              fact.data.human.occurrence.parentSessionId ===
                source.parentSessionId &&
              fact.data.human.occurrence.scopeId === source.scopeId &&
              fact.data.human.occurrence.requestId === source.requestId
            ) {
              onTool?.(fact.data);
            }
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
      if (decoder.decode() || tail || !terminal) throw failed();
      if (terminal === 'discarded') claim.reject(failed());
      return terminal;
    });
  void settled.catch((error: unknown) => {
    ready.reject(error);
    insertion.reject(error);
    claim.reject(error);
  });
  void insertion.promise.catch(() => {});
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
    inserted: () => insertedMessageId !== undefined,
    readInsertedMessageId,
    async assertInserted(messageId: string, active: AbortSignal) {
      if ((await readInsertedMessageId(active)) !== messageId) throw failed();
    },
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
          expected.parentSessionId !== source.parentSessionId ||
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
      return (await readInsertedMessageId(current)) === undefined;
    },
  };
}

export type NativePromptObservation = ReturnType<typeof observeNativePrompt>;
