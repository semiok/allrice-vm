import { expect, it, vi } from 'vitest';
import { withOomNotice } from './dsh-command-memory.mjs';

it.each([
  [0, '0'],
  [137, '0'],
  [0, '1'],
  [137, '1'],
])(
  'keeps native result status %s and adds a stderr note only for observed group kill %s',
  async (exitCode, oomKill) => {
    const native = Buffer.from('native stderr');
    const outcome = { exitCode, signal: null };
    const finished = Promise.withResolvers();
    const handle = {
      done: finished.promise,
      terminate: vi.fn(),
      waitForExit: vi.fn(async () => true),
      collected: {
        stderr: {
          readFrom(offset) {
            return {
              text: native.subarray(offset).toString(),
              nextOffset: native.length,
              lossy: false,
            };
          },
        },
      },
    };
    const owner = {
      observe: () => ({
        receipt: { baseline: { oomKill: '0' } },
        after: { oomKill },
      }),
    };
    const decorated = withOomNotice(handle, owner);
    expect(decorated.collected.stderr.readFrom(0).text).toBe('native stderr');
    finished.resolve(outcome);
    expect(await decorated.done).toBe(outcome);
    const view = decorated.collected.stderr.readFrom(0);
    if (oomKill === '1') {
      expect(view.text).toContain('native stderr\n命令组记录到 OOM');
      expect(decorated.collected.stderr.readFrom(native.length).text).toContain(
        '命令组记录到 OOM',
      );
    } else expect(view.text).toBe('native stderr');
    expect(view.nextOffset).toBe(Buffer.byteLength(view.text));
    expect(decorated.collected.stderr.readFrom(view.nextOffset).text).toBe('');
    const signal = new AbortController().signal;
    decorated.terminate();
    expect(handle.terminate).toHaveBeenCalledOnce();
    expect(await decorated.waitForExit(signal)).toBe(true);
    expect(handle.waitForExit).toHaveBeenCalledExactlyOnceWith(signal);
  },
);
