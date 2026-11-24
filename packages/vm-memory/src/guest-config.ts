import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PERSON_VM_COMMAND_MEMORY_VERIFIER } from '@allrice/person-vm';
import {
  VM_MEMORY_CONTRACT_VERSION,
  VM_PHYSICAL_MEMORY_BYTES,
} from './contract.ts';
import type { VmMemoryPolicy } from './contract.ts';

export type VmMemoryGuestPlan = Readonly<{
  /** Stage only into this person's encrypted persistent disk, never the host. */
  files: readonly Readonly<{ path: string; contents: string; mode: number }>[];
  initialize: Readonly<{ executable: 'node'; args: readonly string[] }>;
  /** Execute this launcher BEFORE native DSH. It joins the protected group and
   * sets oom_score_adj before exec, avoiding a post-spawn placement race. */
  launcher: string;
  env: Readonly<Record<string, string>>;
}>;

/** Produces inert artifacts. No subprocess, VM boot or cgroup mutation occurs.
 * MET-266's runtime owner must stage/init before authenticated DSH readiness. */
export async function createVmMemoryGuestPlan(input: {
  persistentDirectory: string;
  /** Host platform configuration; no phase4 fallback or guest-selected limits. */
  policy: VmMemoryPolicy;
  /** Actual approval/config release reference, not permission granted by a string. */
  policyRef: string;
  /** Explicit cooperative receipt setup. The real command owner supplies a
   * fresh execution nonce per dispatch; the plan never creates one. */
  commandReceipt?: Readonly<{
    nodeExecutable: string;
    receiptDirectory: string;
  }>;
}): Promise<VmMemoryGuestPlan> {
  if (typeof input.policyRef !== 'string' || !input.policyRef.trim())
    throw new Error('approved_memory_policy_required');
  const policy = { ...input.policy };
  const byteValues = [
    policy.physicalBytes,
    policy.swapBytes,
    policy.dshLowBytes,
    policy.dshSwapMaxBytes,
    policy.commandHighBytes,
    policy.commandMaxBytes,
    policy.commandSwapMaxBytes,
  ];
  const scores = [policy.dshOomScoreAdj, policy.commandOomScoreAdj];
  if (
    !byteValues.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !scores.every(
      (value) => Number.isInteger(value) && value >= -1000 && value <= 1000,
    ) ||
    policy.physicalBytes !== VM_PHYSICAL_MEMORY_BYTES ||
    !(policy.swapBytes > 0) ||
    policy.commandOomGroup !== 0 ||
    policy.commandHighBytes > policy.commandMaxBytes
  )
    throw new Error('invalid_memory_policy');
  const root = normalize(input.persistentDirectory);
  if (
    !isAbsolute(root) ||
    root === '/' ||
    /\s/.test(root) ||
    root.includes('\0')
  )
    throw new Error('invalid_guest_memory_directory');
  const directory = join(root, 'allrice-memory');
  const receipt = input.commandReceipt
    ? { ...input.commandReceipt }
    : undefined;
  if (
    receipt &&
    (![receipt.nodeExecutable, receipt.receiptDirectory].every(
      (value) =>
        typeof value === 'string' &&
        isAbsolute(value) &&
        value !== '/' &&
        normalize(value) === value &&
        !/[\s\0]/.test(value),
    ) ||
      !receipt.receiptDirectory.startsWith(root + '/'))
  )
    throw new Error('invalid_command_receipt_configuration');
  const cgroupRoot = '/sys/fs/cgroup';
  const dshGroup = join(cgroupRoot, 'allrice-dsh');
  const commandsGroup = join(cgroupRoot, 'allrice-commands');
  const config = {
    contractVersion: VM_MEMORY_CONTRACT_VERSION,
    platformPhysicalBytes: VM_PHYSICAL_MEMORY_BYTES,
    cgroupRoot,
    dshGroup,
    commandsGroup,
    swapFile: join(directory, 'swapfile'),
    procRoot: '/proc',
    policy,
    policyRef: input.policyRef,
    ...(receipt ? { receiptDirectory: receipt.receiptDirectory } : {}),
  };
  const names = [
    'initialize.cjs',
    'bash-env.sh',
    'launch-dsh.sh',
    'sample.cjs',
    ...(receipt ? ['dsh-command-memory.mjs'] : []),
  ];
  const files = await Promise.all(
    names.map(async (name) => ({
      path: join(directory, name),
      contents: await readFile(
        new URL(`../guest/${name}`, import.meta.url),
        'utf8',
      ),
      mode: 0o700,
    })),
  );
  files.push({
    path: join(directory, 'config.json'),
    contents: JSON.stringify(config) + '\n',
    mode: 0o600,
  });
  const receiptWriter = join(directory, 'command-observer.cjs');
  if (receipt)
    files.push({
      path: receiptWriter,
      contents: `${PERSON_VM_COMMAND_MEMORY_VERIFIER}
const roots = ${JSON.stringify({ cgroupRoot, commandsGroup, dshGroup, procRoot: '/proc', receiptDirectory: receipt.receiptDirectory })};
module.exports = executionRef =>
  verifyCommandMemoryReceipt({ ...roots, executionRef }, 'complete-and-release', true);
if (require.main === module) {
  const env = process.env;
  const evidence = verifyCommandMemoryReceipt({
    cgroupRoot: env.ALLRICE_MEMORY_CGROUP_ROOT,
    commandsGroup: env.ALLRICE_MEMORY_COMMANDS_GROUP,
    dshGroup: env.ALLRICE_MEMORY_DSH_GROUP,
    procRoot: env.ALLRICE_MEMORY_PROC_ROOT,
    receiptDirectory: env.ALLRICE_MEMORY_RECEIPT_DIRECTORY,
    executionRef: env.ALLRICE_MEMORY_EXECUTION_REF,
    pid: Number(process.argv[2]),
  }, process.argv[3]);
  if (evidence) {
    process.stdout.write(JSON.stringify(evidence));
    if ('error' in evidence) process.exitCode = 1;
  }
}
`,
      mode: 0o700,
    });
  return {
    files,
    initialize: {
      executable: 'node',
      args: [join(directory, 'initialize.cjs'), join(directory, 'config.json')],
    },
    launcher: join(directory, 'launch-dsh.sh'),
    env: {
      BASH_ENV: join(directory, 'bash-env.sh'),
      ALLRICE_MEMORY_CGROUP_ROOT: cgroupRoot,
      ALLRICE_MEMORY_DSH_GROUP: dshGroup,
      ALLRICE_MEMORY_COMMANDS_GROUP: commandsGroup,
      ALLRICE_MEMORY_COMMAND_HIGH: String(policy.commandHighBytes),
      ALLRICE_MEMORY_COMMAND_MAX: String(policy.commandMaxBytes),
      ALLRICE_MEMORY_COMMAND_SWAP_MAX: String(policy.commandSwapMaxBytes),
      ALLRICE_MEMORY_COMMAND_OOM_SCORE: String(policy.commandOomScoreAdj),
      ALLRICE_MEMORY_DSH_OOM_SCORE: String(policy.dshOomScoreAdj),
      ALLRICE_MEMORY_PROC_ROOT: '/proc',
      ...(receipt
        ? {
            ALLRICE_MEMORY_RECEIPT_NODE: receipt.nodeExecutable,
            ALLRICE_MEMORY_RECEIPT_WRITER: receiptWriter,
            ALLRICE_MEMORY_RECEIPT_DIRECTORY: receipt.receiptDirectory,
          }
        : {}),
    },
  };
}

/** Overlay for the pinned native rc.2 Web profile. It keeps the native `bash`
 * tool and places the command in its cgroup before executing the confined argv. */
export function createPersonVmDshCommandMemoryPatch(
  plan: Pick<VmMemoryGuestPlan, 'env' | 'files'>,
  input: { cliPath: string; cleanupTimeoutMs: number },
) {
  const writer = plan.env.ALLRICE_MEMORY_RECEIPT_WRITER;
  if (writer === undefined) return undefined;
  const guard = plan.env.BASH_ENV;
  const plugin = join(dirname(writer), 'dsh-command-memory.mjs');
  if (
    !guard ||
    ![writer, guard, plugin, input.cliPath].every(
      (path) => isAbsolute(path) && normalize(path) === path,
    ) ||
    ![writer, guard, plugin].every((path) =>
      plan.files.some((file) => file.path === path),
    ) ||
    !Number.isSafeInteger(input.cleanupTimeoutMs) ||
    input.cleanupTimeoutMs <= 0 ||
    input.cleanupTimeoutMs > 2 ** 32 - 1
  )
    throw new Error('invalid_dsh_command_memory_patch');
  return [
    {
      id: 'subprocess',
      name: '@deepseek-ai/dsh-subprocess-local',
      disabled: true,
    },
    {
      insert: [
        {
          id: 'allrice-person-vm-command-memory',
          name: pathToFileURL(plugin).href,
          config: { ...input, guard, writer },
        },
      ],
    },
  ];
}
