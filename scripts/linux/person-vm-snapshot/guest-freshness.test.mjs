import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { it, expect } from 'vitest';

const probe = fileURLToPath(new URL('./guest-freshness.c', import.meta.url));
const compile = promisify(execFile);
const fixture = `
#include <string.h>
#include <unistd.h>

int snapshot_freshness_gate(int, int (*)(const unsigned char *),
                            int (*)(unsigned char *));
static int added;
static int fail;
static int reseed(const unsigned char *entropy) {
  if (fail || entropy[0] != 17) return -1;
  added = 1;
  return 0;
}
static int sample(unsigned char *out) {
  if (!added) return -1;
  memset(out, 97, 32);
  return 0;
}
int main(int argc, char **argv) {
  (void)argv;
  fail = argc > 1;
  return snapshot_freshness_gate(3, reseed, sample) == 0 ? 0 : 1;
}
`;

async function withHelper(run) {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-gate-test-'));
  try {
    const driver = join(root, 'fixture.c');
    const binary = join(root, 'fixture');
    await writeFile(driver, fixture, { mode: 0o600 });
    // Compile the identical gate on Darwin and Linux with injected ioctls.
    await compile('cc', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-U__linux__',
      probe,
      driver,
      '-o',
      binary,
    ]);
    await run(binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it.each([
  ['success', 1, 65, false],
  ['reseed failure', 1, 65, true],
  ['unsupported protocol', 2, 65, false],
  ['truncated challenge', 1, 34, false],
])(
  'guest private stream blocks and never acknowledges %s early',
  async (kind, version, length, fail) => {
    await withHelper(async (binary) => {
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
