import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { CloseCommand, DEntryPageInput } from './types.js';

// Same byte budget as the rc.2 WebSocket Gateway's native uplink inbox.
const maxBytes = 262_144;
const done = { done: true, value: undefined } as const;

export function pageUplink(endpoint: string) {
  const queue: { value: JsonValue | undefined; bytes: number }[] = [];
  let buffered = 0;
  let ended = false;
  let closed = false;
  let wake: (() => void) | undefined;
  let seenInput = false;
  let taken = false;
  const notify = () => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  const close = () => {
    closed = true;
    queue.length = 0;
    buffered = 0;
    notify();
  };
  return {
    close,
    hasItems: () => seenInput,
    add(command: DEntryPageInput) {
      if (closed) return;
      if (command.type === 'input-end') {
        ended = true;
        notify();
        return;
      }
      if (ended)
        throw new RemoteError('gateway/protocol', 'Input arrived after end', {
          endpoint,
        });
      const bytes = Buffer.byteLength(JSON.stringify(command));
      if (buffered + bytes > maxBytes)
        throw new RemoteError(
          'gateway/uplink-overflow',
          'Native input is full',
          { endpoint },
        );
      seenInput = true;
      buffered += bytes;
      queue.push({ value: command.value, bytes });
      notify();
    },
    [Symbol.asyncIterator](): AsyncIterator<JsonValue | undefined> {
      if (taken) throw Error('Native input already has a consumer');
      taken = true;
      return {
        async next() {
          while (!closed) {
            const item = queue.shift();
            if (item) {
              buffered -= item.bytes;
              return { done: false, value: item.value };
            }
            if (ended) break;
            if (wake) throw Error('Native input already has a pending read');
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          return done;
        },
        async return() {
          close();
          return done;
        },
      };
    },
  };
}

export async function pumpPageInput(
  input: AsyncIterator<CloseCommand | DEntryPageInput>,
  receive: (command: DEntryPageInput) => void,
) {
  while (true) {
    const item = await input.next();
    if (item.done || item.value === 'close') return;
    receive(item.value);
  }
}
