import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { it, expect } from 'vitest';
import { withGuestFreshnessHelper } from './guest-freshness.fixture.mjs';

it.each([
  ['success', 1, 65, false],
  ['reseed failure', 1, 65, true],
  ['unsupported protocol', 2, 65, false],
  ['truncated challenge', 1, 34, false],
])(
  'guest private stream blocks and never acknowledges %s early',
  async (kind, version, length, fail) => {
    await withGuestFreshnessHelper(async (binary) => {
      const child = spawn(binary, fail ? ['reseed-failure'] : [], {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      });
      const finished = once(child, 'close');
      const channel = child.stdio[3];
      try {
        const [wait] = await once(channel, 'data');
        expect(wait).toEqual(Buffer.from([1]));
        expect(child.exitCode).toBeNull();
        const frame = Buffer.concat([
          Buffer.from([version]),
          Buffer.alloc(32, 23),
          Buffer.alloc(32, 17),
        ]);
        const response = [];
        channel.on('data', (chunk) => response.push(chunk));
        channel.end(frame.subarray(0, length));
        if (kind === 'success') {
          expect(await finished).toEqual([0, null]);
          expect(Buffer.concat(response)).toEqual(
            Buffer.concat([frame.subarray(0, 33), Buffer.alloc(32, 97)]),
          );
        } else {
          expect(await finished).toEqual([1, null]);
          expect(response).toEqual([]);
        }
      } finally {
        channel.destroy();
        if (child.exitCode === null) child.kill();
        await finished;
      }
    });
  },
);
