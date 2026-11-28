import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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

export async function withGuestFreshnessHelper(run) {
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
