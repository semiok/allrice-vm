import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('AWS trial controller, permissions and dry-run without AWS access', () => {
  const file = fileURLToPath(new URL('./ec2-trial.test.py', import.meta.url));
  const result = spawnSync('python3', ['-IB', file, '-v'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
