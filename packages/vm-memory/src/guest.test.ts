import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  mkdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VM_MEMORY_PHASE4_REFERENCE_POLICY } from './contract.ts';
import type { GuestMemorySample } from './contract.ts';
import { createVmMemoryGuestPlan as createPlan } from './guest-config.ts';

// Explicit historical policy is a fixture choice, never a production fallback.
const createVmMemoryGuestPlan = (input: { persistentDirectory: string }) =>
  createPlan({
    ...input,
    policy: VM_MEMORY_PHASE4_REFERENCE_POLICY,
    policyRef: 'fixture:phase4-reference-not-product-approval',
  });

const require = createRequire(import.meta.url);
type Config = {
  contractVersion: number;
  policyRef: string;
  cgroupRoot: string;
  dshGroup: string;
  commandsGroup: string;
  procRoot: string;
  swapFile: string;
  policy: Record<string, number>;
};
const { initialize } = require('../guest/initialize.cjs') as {
  initialize(
    config: Config,
    io: unknown,
    run: unknown,
  ): { swapFileBytes: number; groups: Record<string, Record<string, string>> };
};
const { sample } = require('../guest/sample.cjs') as {
  sample(config: Config, io: unknown): GuestMemorySample;
};
const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function virtualGuest() {
  const plan = await createVmMemoryGuestPlan({
    persistentDirectory: '/fixture/encrypted',
  });
  const config = JSON.parse(
    plan.files.find((file) => file.path.endsWith('/config.json'))!.contents,
  ) as Config;
  const files = new Map<string, string>([
    [join(config.procRoot, 'swaps'), 'Filename Type Size Used Priority\n'],
  ]);
  const enoent = () =>
    Object.assign(new Error('fixture-file-missing'), { code: 'ENOENT' });
  let swapSize: number | undefined;
  const io = {
    readFileSync(file: string) {
      const value = files.get(file);
      if (value === undefined) throw enoent();
      return value;
    },
    writeFileSync(file: string, value: string) {
      files.set(file, value === '+memory' ? 'memory' : String(value));
    },
    mkdirSync(directory: string) {
      files.set(
        join(directory, 'cgroup.procs'),
        files.get(join(directory, 'cgroup.procs')) ?? '',
      );
    },
    chmodSync: vi.fn(),
    lstatSync() {
      if (swapSize === undefined) throw enoent();
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        size: swapSize,
      };
    },
    statSync() {
      return { size: swapSize };
    },
  };
  const run = vi.fn((command: string) => {
    if (command === 'fallocate') swapSize = config.policy.swapBytes;
    if (command === 'swapon')
      files.set(
        join(config.procRoot, 'swaps'),
        `Filename Type Size Used Priority\n${config.swapFile} file 2097148 0 -2\n`,
      );
  });
  return {
    config,
    files,
    io,
    run,
    setSwapSize(value: number) {
      swapSize = value;
    },
  };
}

describe.sequential(
  'guest artifacts without VM, kernel mutation or pressure allocation',
  () => {
    it('产品计划必须显式给平台policy和批准来源，不把样机值当默认', async () => {
      await expect(
        createPlan({
          persistentDirectory: '/fixture/encrypted',
          policy: VM_MEMORY_PHASE4_REFERENCE_POLICY,
          policyRef: '',
        }),
      ).rejects.toThrow('approved_memory_policy_required');
      const f = await virtualGuest();
      expect(() =>
        initialize({ ...f.config, policyRef: '' }, f.io, f.run),
      ).toThrow('approved_memory_policy_required');
      expect(f.run).not.toHaveBeenCalled();
    });
    it('初始化读取真实接口回值，RAM/swap分开，重复启动不重格式化已用swap', async () => {
      const f = await virtualGuest();
      const result = initialize(f.config, f.io, f.run);
      expect(result.swapFileBytes).toBe(2147483648);
      expect(result.groups[f.config.commandsGroup]).toEqual({
        'memory.high': '805306368',
        'memory.max': '1342177280',
        'memory.swap.max': '2147483648',
        'memory.oom.group': '0',
      });
      expect(result.groups[f.config.dshGroup]).toMatchObject({
        'memory.low': '268435456',
        'memory.swap.max': '536870912',
        'memory.max': 'max',
      });
      initialize(f.config, f.io, f.run);
      expect(f.run.mock.calls.map(([command]) => command)).toEqual([
        'fallocate',
        'mkswap',
        'swapon',
      ]);
      expect(f.io.chmodSync).toHaveBeenCalledWith(f.config.swapFile, 0o600);
    });

    it('已有错误swap或live父组不擅自重格式化/移动运行进程', async () => {
      const f = await virtualGuest();
      f.setSwapSize(1);
      expect(() => initialize(f.config, f.io, f.run)).toThrow(
        'existing_swap_file_invalid',
      );
      expect(f.run).not.toHaveBeenCalled();
      f.setSwapSize(2147483648);
      f.files.set(join(f.config.commandsGroup, 'cgroup.procs'), '123\n');
      expect(() => initialize(f.config, f.io, f.run)).toThrow(
        'memory_group_has_live_processes',
      );
      expect(f.run.mock.calls.map(([command]) => command)).not.toContain(
        'mkswap',
      );
    });

    it('内核不支持swap/memcg或回读不符时明确失败，不输出设置成功', async () => {
      const f = await virtualGuest();
      expect(() =>
        initialize(f.config, f.io, () => {
          throw Error('synthetic-swap-unsupported');
        }),
      ).toThrow('synthetic-swap-unsupported');
      expect(() =>
        initialize(f.config, { ...f.io, writeFileSync() {} }, f.run),
      ).toThrow();
    });

    it('诊断按键取RAM/swap/局部/父组/全局计数，缺失保持null', async () => {
      const f = await virtualGuest();
      f.files.set(
        join(f.config.procRoot, 'meminfo'),
        'SwapFree: 20 kB\nMemAvailable: 30 kB\nMemTotal: 100 kB\nSwapTotal: 40 kB\n',
      );
      f.files.set(join(f.config.procRoot, 'vmstat'), 'oom_kill 9\n');
      f.files.set(join(f.config.commandsGroup, 'memory.current'), '70\n');
      f.files.set(join(f.config.commandsGroup, 'memory.swap.current'), '12\n');
      f.files.set(
        join(f.config.commandsGroup, 'memory.events'),
        'oom 3\noom_kill 2\n',
      );
      f.files.set(
        join(f.config.commandsGroup, 'memory.events.local'),
        'oom 1\noom_kill 0\n',
      );
      expect(sample(f.config, f.io)).toEqual({
        ramBytes: 102400,
        availableBytes: 30720,
        swapTotalBytes: 40960,
        swapFreeBytes: 20480,
        commandRamBytes: 70,
        commandSwapBytes: 12,
        dshRamBytes: null,
        dshSwapBytes: null,
        commandOomKills: 2,
        parentLocalOoms: 1,
        globalOomKills: 9,
      });
    });

    it('工件只走原生BASH_ENV/launcher，无轮询、默认超时或第二命令runner', async () => {
      const plan = await createVmMemoryGuestPlan({
        persistentDirectory: '/fixture/encrypted',
      });
      expect(plan.env.BASH_ENV).toBe(
        '/fixture/encrypted/allrice-memory/bash-env.sh',
      );
      expect(plan.env.ALLRICE_MEMORY_COMMAND_OOM_SCORE).toBe('800');
      const launcher = plan.files.find((file) =>
        file.path.endsWith('/launch-dsh.sh'),
      )!.contents;
      expect(launcher.indexOf('cgroup.procs')).toBeLessThan(
        launcher.indexOf('exec "$@"'),
      );
      expect(launcher).toContain('oom_score_adj');
      await expect(
        createVmMemoryGuestPlan({ persistentDirectory: '/' }),
      ).rejects.toThrow('invalid_guest_memory_directory');
    });

    it('命令保护尚未装配时在原生bash执行前明确失败，不运行用户命令', async () => {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), 'met267-uninitialized-')),
      );
      directories.push(directory);
      const guard = join(directory, 'bash-env.sh');
      const plan = await createVmMemoryGuestPlan({
        persistentDirectory: '/fixture/encrypted',
      });
      await writeFile(
        guard,
        plan.files.find((file) => file.path.endsWith('/bash-env.sh'))!.contents,
      );
      let result: { code?: number; stdout: string; stderr: string } | undefined;
      try {
        result = await execute(
          '/bin/bash',
          ['--noprofile', '--norc', '-c', 'printf "must-not-run\\n"'],
          {
            env: { PATH: '/usr/bin:/bin', BASH_ENV: guard },
          },
        );
      } catch (error) {
        result = error as { code: number; stdout: string; stderr: string };
      }
      expect(result?.code).toBe(75);
      expect(result?.stdout).toBe('');
      expect(result?.stderr).toContain('COMMAND_MEMORY_SETUP_FAILED');
    });

    it.each([
      {
        events: 'oom 1\noom_kill 1\n',
        exit: 9,
        expected: 137,
        text: 'COMMAND_MEMORY_LIMIT',
      },
      {
        events: 'oom 0\noom_kill 1\n',
        exit: 9,
        expected: 137,
        text: 'COMMAND_OOM_KILLED',
      },
      { events: 'oom 0\noom_kill 0\n', exit: 137, expected: 137, text: '' },
      { events: 'oom 0\noom_kill 0\n', exit: 0, expected: 0, text: '' },
    ])(
      '原生bash入口自动映射合成计数 $text / $exit；没有手工拼错误或重放命令',
      async (scenario) => {
        const directory = await realpath(
          await mkdtemp(join(tmpdir(), 'met267-guest-')),
        );
        directories.push(directory);
        const plan = await createVmMemoryGuestPlan({
          persistentDirectory: '/fixture/encrypted',
        });
        const bin = join(directory, 'bin');
        const commands = join(directory, 'commands');
        const dsh = join(directory, 'dsh');
        const proc = join(directory, 'proc');
        await Promise.all(
          [bin, commands, dsh, proc].map((file) => mkdir(file)),
        );
        const guard = join(directory, 'bash-env.sh');
        await writeFile(
          guard,
          plan.files.find((file) => file.path.endsWith('/bash-env.sh'))!
            .contents,
        );
        // Synthetic sysfs: mkdir creates the kernel-owned files in a temporary tree.
        await writeFile(
          join(bin, 'mkdir'),
          '#!/bin/sh\n/bin/mkdir "$1" || exit $?\nprintf "oom 0\\noom_kill 0\\n" > "$1/memory.events.local"\npid=${1##*-}\n/bin/mkdir -p "$ALLRICE_MEMORY_PROC_ROOT/$pid"\n: > "$ALLRICE_MEMORY_PROC_ROOT/$pid/oom_score_adj"\n',
          { mode: 0o700 },
        );
        const command =
          'printf "%s" "$SYNTHETIC_EVENTS" > "$allrice_memory_child/memory.events.local"; printf "ran-once\\n"; exit "$SYNTHETIC_EXIT"';
        let result: { stdout: string; stderr: string; code?: number };
        try {
          result = await execute(
            '/bin/bash',
            ['--noprofile', '--norc', '-c', command],
            {
              env: {
                ...plan.env,
                PATH: `${bin}:/usr/bin:/bin`,
                BASH_ENV: guard,
                ALLRICE_MEMORY_COMMANDS_GROUP: commands,
                ALLRICE_MEMORY_DSH_GROUP: dsh,
                ALLRICE_MEMORY_PROC_ROOT: proc,
                SYNTHETIC_EVENTS: scenario.events,
                SYNTHETIC_EXIT: String(scenario.exit),
              },
            },
          );
        } catch (error) {
          result = error as { stdout: string; stderr: string; code: number };
        }
        expect(result.code ?? 0).toBe(scenario.expected);
        expect(result.stdout).toBe('ran-once\n');
        if (scenario.text) expect(result.stderr).toContain(scenario.text);
        else expect(result.stderr).not.toContain('COMMAND_');
        // Regular files emulate cgroup control files, so teardown removes them here.
        expect(await readFile(join(dsh, 'cgroup.procs'), 'utf8')).toMatch(
          /^\d+\n$/,
        );
      },
    );
  },
);
