import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  COMMAND_MEMORY_CONTROL_FILES,
  COMMAND_MEMORY_STATE_ROOT,
  PERSON_VM_COMMAND_MEMORY_VERIFIER,
  checkedReadonlyCommandMemoryDirectory,
  hashCommandMemoryControlFiles,
  type ReadonlyCommandMemoryDirectory,
} from '@allrice/person-vm';
import {
  VM_MEMORY_CONTRACT_VERSION,
  VM_PHYSICAL_MEMORY_BYTES,
} from './contract.ts';
import type { VmMemoryPolicy } from './contract.ts';

export type VmMemoryGuestPlan = Readonly<{
  /** Files staged inside this person's VM. The protected control code is mounted. */
  files: readonly Readonly<{ path: string; contents: string; mode: number }>[];
  initialize: Readonly<{ executable: 'node'; args: readonly string[] }>;
  /** Execute this launcher BEFORE native DSH. It joins the protected group and
   * sets oom_score_adj before exec, avoiding a post-spawn placement race. */
  launcher: string;
  env: Readonly<Record<string, string>>;
}>;

const cgroupRoot = '/sys/fs/cgroup';
const dshGroup = join(cgroupRoot, 'allrice-dsh');
const commandsGroup = join(cgroupRoot, 'allrice-commands');
const procRoot = '/proc';
const receiptDirectory = join(COMMAND_MEMORY_STATE_ROOT, 'receipts');
const guestNodeExecutable = '/usr/local/bin/node';
const writerSource = `${PERSON_VM_COMMAND_MEMORY_VERIFIER}
const roots = ${JSON.stringify({ cgroupRoot, commandsGroup, dshGroup, procRoot, receiptDirectory })};
module.exports = executionRef => prepareDshCommandMemoryReceipt(roots, executionRef);
if (require.main === module) {
  const env = process.env;
  const evidence = verifyCommandMemoryReceipt({
    cgroupRoot: env.ALLRICE_MEMORY_CGROUP_ROOT,
    commandsGroup: env.ALLRICE_MEMORY_COMMANDS_GROUP,
    dshGroup: env.ALLRICE_MEMORY_DSH_GROUP,
    procRoot: env.ALLRICE_MEMORY_PROC_ROOT,
    receiptDirectory: env.ALLRICE_MEMORY_RECEIPT_DIRECTORY,
    executionRef: env.ALLRICE_MEMORY_EXECUTION_REF,
    dshDispatch: env.ALLRICE_MEMORY_DSH_DISPATCH === '1',
    pid: Number(process.argv[2]),
  }, process.argv[3]);
  if (evidence) {
    process.stdout.write(JSON.stringify(evidence));
    if ('error' in evidence) process.exitCode = 1;
  }
}
`;

/** Publication input for the separate, exactly verified native RO mount. */
export async function readPersonVmDshCommandMemoryControls() {
  const files = await Promise.all(
    COMMAND_MEMORY_CONTROL_FILES.map(async (name) => ({
      name,
      contents:
        name === 'command-observer.cjs'
          ? writerSource
          : await readFile(
              new URL(`../guest/${name}`, import.meta.url),
              'utf8',
            ),
      mode: name === 'launch-dsh.sh' ? 0o555 : 0o444,
    })),
  );
  const sha256 = hashCommandMemoryControlFiles(
    new Map(files.map((file) => [file.name, Buffer.from(file.contents)])),
  );
  return {
    files,
    sha256,
    guestDirectory: `/opt/allrice/command-memory/${sha256}`,
  };
}

/** Produces inert artifacts. No subprocess, VM boot or cgroup mutation occurs.
 * MET-266's runtime owner must stage/init before authenticated DSH readiness. */
export async function createVmMemoryGuestPlan(input: {
  persistentDirectory: string;
  /** Host platform configuration; no phase4 fallback or guest-selected limits. */
  policy: VmMemoryPolicy;
  /** Expected cap from the same trusted platform snapshot as the VM provider. */
  platformPhysicalBytes?: number;
  /** Actual approval/config release reference, not permission granted by a string. */
  policyRef: string;
  /** Explicit cooperative receipt setup. The real command owner supplies a
   * fresh execution nonce per dispatch; the plan never creates one. */
  commandReceipt?: Readonly<{
    nodeExecutable: string;
    receiptDirectory: string;
  }>;
  /** Supplied by the same trusted native owner that verifies and mounts it. */
  dshCommandMemory?: ReadonlyCommandMemoryDirectory;
}): Promise<VmMemoryGuestPlan> {
  if (typeof input.policyRef !== 'string' || !input.policyRef.trim())
    throw new Error('approved_memory_policy_required');
  const policy = { ...input.policy };
  const { platformPhysicalBytes = VM_PHYSICAL_MEMORY_BYTES } = input;
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
    policy.physicalBytes <= 0 ||
    policy.physicalBytes !== platformPhysicalBytes ||
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
  const configuredReceipt = input.commandReceipt;
  const legacyReceipt = configuredReceipt && {
    nodeExecutable: configuredReceipt.nodeExecutable,
    receiptDirectory: configuredReceipt.receiptDirectory,
  };
  const configuredControls = input.dshCommandMemory;
  const controls =
    configuredControls &&
    checkedReadonlyCommandMemoryDirectory(configuredControls);
  if (controls && legacyReceipt)
    throw new Error('ambiguous_command_memory_owner');
  const controlDirectory = controls?.guestDirectory ?? directory;
  const receipt = controls
    ? { nodeExecutable: guestNodeExecutable, receiptDirectory }
    : legacyReceipt;
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
      (!controls && !receipt.receiptDirectory.startsWith(root + '/')))
  )
    throw new Error('invalid_command_receipt_configuration');
  const config = {
    contractVersion: VM_MEMORY_CONTRACT_VERSION,
    platformPhysicalBytes,
    cgroupRoot,
    dshGroup,
    commandsGroup,
    swapFile: join(directory, 'swapfile'),
    procRoot,
    policy,
    policyRef: input.policyRef,
    ...(controls ? { protectedCommandMemory: true } : {}),
    ...(receipt ? { receiptDirectory: receipt.receiptDirectory } : {}),
  };
  const names = controls
    ? []
    : ['initialize.cjs', 'bash-env.sh', 'launch-dsh.sh', 'sample.cjs'];
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
  const configPath = join(
    controls ? COMMAND_MEMORY_STATE_ROOT : directory,
    'config.json',
  );
  files.push({
    path: configPath,
    contents: JSON.stringify(config) + '\n',
    mode: 0o600,
  });
  const receiptWriter = join(controlDirectory, 'command-observer.cjs');
  if (receipt && !controls)
    files.push({
      path: receiptWriter,
      contents: writerSource,
      mode: 0o700,
    });
  return {
    files,
    initialize: {
      executable: 'node',
      args: [join(controlDirectory, 'initialize.cjs'), configPath],
    },
    launcher: join(controlDirectory, 'launch-dsh.sh'),
    env: {
      BASH_ENV: join(controlDirectory, 'bash-env.sh'),
      ALLRICE_MEMORY_CGROUP_ROOT: cgroupRoot,
      ALLRICE_MEMORY_DSH_GROUP: dshGroup,
      ALLRICE_MEMORY_COMMANDS_GROUP: commandsGroup,
      ALLRICE_MEMORY_COMMAND_HIGH: String(policy.commandHighBytes),
      ALLRICE_MEMORY_COMMAND_MAX: String(policy.commandMaxBytes),
      ALLRICE_MEMORY_COMMAND_SWAP_MAX: String(policy.commandSwapMaxBytes),
      ALLRICE_MEMORY_COMMAND_OOM_SCORE: String(policy.commandOomScoreAdj),
      ALLRICE_MEMORY_DSH_OOM_SCORE: String(policy.dshOomScoreAdj),
      ALLRICE_MEMORY_PROC_ROOT: procRoot,
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
  plan: Pick<VmMemoryGuestPlan, 'env' | 'launcher'>,
  input: {
    cliPath: string;
    cleanupTimeoutMs: number;
    readonlyDshDirectory: string;
    controls: ReadonlyCommandMemoryDirectory;
  },
) {
  const { guestDirectory } = checkedReadonlyCommandMemoryDirectory(
    input.controls,
  );
  const writer = join(guestDirectory, 'command-observer.cjs');
  const guard = join(guestDirectory, 'bash-env.sh');
  const plugin = join(guestDirectory, 'dsh-command-memory.mjs');
  if (
    !/^\/opt\/allrice\/dsh\/[a-f0-9]{64}$/.test(input.readonlyDshDirectory) ||
    normalize(input.cliPath) !== input.cliPath ||
    !input.cliPath.startsWith(input.readonlyDshDirectory + '/') ||
    plan.launcher !== join(guestDirectory, 'launch-dsh.sh') ||
    plan.env.ALLRICE_MEMORY_RECEIPT_WRITER !== writer ||
    plan.env.ALLRICE_MEMORY_RECEIPT_DIRECTORY !== receiptDirectory ||
    plan.env.ALLRICE_MEMORY_RECEIPT_NODE !== guestNodeExecutable ||
    plan.env.BASH_ENV !== guard ||
    !Number.isSafeInteger(input.cleanupTimeoutMs) ||
    input.cleanupTimeoutMs <= 0 ||
    input.cleanupTimeoutMs > 2 ** 32 - 1
  )
    throw new Error('invalid_dsh_command_memory_patch');
  return [
    {
      id: 'sandbox',
      name: '@deepseek-ai/dsh-sandbox-local',
      disabled: true,
    },
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
          config: {
            cliPath: input.cliPath,
            cleanupTimeoutMs: input.cleanupTimeoutMs,
            readonlyDshDirectory: input.readonlyDshDirectory,
            controlDirectory: guestDirectory,
            guard,
            writer,
            receiptDirectory,
          },
        },
      ],
    },
  ] as const;
}
