import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'linux')(
  'keeps native delivery bytes and acknowledgements inside the Linux file and live-owner boundaries',
  { tags: ['platform:linux'] },
  async () => {
    const harness = fileURLToPath(
      new URL(
        '../../dsh/allrice-native-delivery-capture.node.mjs',
        import.meta.url,
      ),
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--test', harness],
      {
        timeout: 10_000,
      },
    );
    expect(stdout).toContain('# pass 3');
    expect(stdout).toContain('# fail 0');
  },
);
