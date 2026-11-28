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
    originalHuman: NativeAdoptedTextSchema.omit({ kind: true })
      .nullable()
      .optional(),
    firstMemoryAttempt: z.boolean().optional(),
    memoryToolVersions: z
      .object({
        memory_read: z.string().min(1).max(256).nullable(),
        memory_remember: z.string().min(1).max(256).nullable(),
      })
      .strict()
      .nullable()
      .optional(),
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
    dispatch: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('registry-result') }).strict(),
      z
        .object({
          kind: z.literal('sealed-handler'),
          version: z.string().min(1).max(256),
        })
        .strict(),
    ]),
  })
  .strict();

export type NativeToolObservation = z.infer<typeof nativeToolObservation>;
const nativeMemoryToolObservation = nativeToolObservation.extend({
  executionSessionRef: nativeMessageId,
  executionParentRef: nativeMessageId.nullable(),
});
export type NativeMemoryToolObservation = z.infer<
  typeof nativeMemoryToolObservation
>;
export type NativeMemoryToolResult = Readonly<{
  outcome: 'result' | 'unknown';
  text: string;
}>;
export type PublishNativeMemoryCall = (
  fact: NativeMemoryToolObservation,
  signal: AbortSignal,
  argumentsFromTool?: { value: unknown },
) => Promise<string | NativeMemoryToolResult | null>;
const memoryCallFrame = z
  .object({
    ticket: UuidSchema,
    fact: nativeMemoryToolObservation,
    argumentsFromTool: z.object({ value: z.json() }).strict().optional(),
  })
  .strict();
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
  onMemoryCall?: PublishNativeMemoryCall,
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
  const memoryCalls = new Map<
    string,
    { stop: AbortController; done: Promise<void> }
  >();
  const tickets = new Set<string>();
  function matchesSource(fact: NativeToolObservation) {
    const occurrence = fact.human.occurrence;
    return (
      occurrence.messageId === insertedMessageId &&
      occurrence.sessionId === source.sessionId &&
      occurrence.parentSessionId === source.parentSessionId &&
      occurrence.scopeId === source.scopeId &&
      occurrence.requestId === source.requestId
    );
  }
  function publishMemoryCall(frame: z.infer<typeof memoryCallFrame>) {
    if (
      !onMemoryCall ||
      tickets.has(frame.ticket) ||
      !matchesSource(frame.fact)
    )
      throw failed();
    tickets.add(frame.ticket);
    const stop = new AbortController();
    const active = AbortSignal.any([
      current,
      stop.signal,
      AbortSignal.timeout(30_000),
    ]);
    const done = Promise.resolve()
      .then(async () => {
        active.throwIfAborted();
        const result = await onMemoryCall(
          frame.fact,
          active,
          frame.argumentsFromTool,
        ).catch(() => null);
        active.throwIfAborted();
        await transport.readManagedModelProof(
          JSON.stringify({
            ...request,
            action: 'memory-call-result',
            ticket: frame.ticket,
            nativeRequestRef: typeof result === 'string' ? result : null,
            ...(result && typeof result === 'object' && { result }),
          }),
          active,
        );
      })
      .catch(() => {
        // A lost result cannot authorize the waiting tool body.
      })
      .finally(() => {
        memoryCalls.delete(frame.ticket);
      });
    memoryCalls.set(frame.ticket, { stop, done });
  }
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
      JSON.stringify({
        ...request,
        action: 'observe-prompt',
        ...(onMemoryCall && { memoryCalls: true }),
      }),
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
            if (fact.success && matchesSource(fact.data)) {
              onTool?.(fact.data);
            }
          } else if (record.startsWith('memory-call ') && state === 'claimed') {
            publishMemoryCall(
              memoryCallFrame.parse(JSON.parse(record.slice(12))),
            );
          } else if (
            record.startsWith('memory-call-cancel ') &&
            state === 'claimed'
          ) {
            const ticket = UuidSchema.parse(record.slice(19));
            if (!tickets.has(ticket)) throw failed();
            memoryCalls.get(ticket)?.stop.abort();
          } else if (
            (record === 'discarded' && state === 'inserted') ||
            (record === 'ended' && state === 'claimed')
          ) {
            terminal = record;
          } else throw failed();
        }
      },
      onMemoryCall === undefined ? undefined : 128 * 1024,
    )
    .then(() => {
      if (decoder.decode() || tail || !terminal) throw failed();
      if (terminal === 'discarded') claim.reject(failed());
      return terminal;
    })
    .finally(async () => {
      const pending = [...memoryCalls.values()];
      for (const call of pending) call.stop.abort();
      await Promise.all(pending.map(({ done }) => done));
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
