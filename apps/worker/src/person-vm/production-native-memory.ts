import { createHash } from 'node:crypto';
import {
  MemoryOrdinalInputSchema,
  RememberPersonalMemoryInputSchema,
  memoryIndexPolicy,
  type RequestContext,
} from '@allrice/contracts';
import { createNativeEmployeeMemoryHost } from '@allrice/database';
import type { ModelDispatchAuthority } from '@allrice/model-gateway';
import { z } from 'zod';
import type { NativeExecutionBuild } from './production-native-execution-evidence.js';

export type MemoryRootObservation = Readonly<
  (
    | {
        mode: 'issue';
        nativeRequestRef: string;
      }
    | {
        mode: 'restore';
      }
  ) & {
    runId: string;
    workspaceId: string;
    employeeInstanceId: string;
    threadId: string;
    originalPromptRequestId: string;
    originalTurn: number;
    rootNativeSessionRef: string;
    nativeOwnerRef: string;
    nativeProfileRef: string;
    moduleConfigRevisionRef: string;
    vm: Readonly<{ vmId: string; instanceId: string; leaseEpoch: number }>;
  }
>;

export type MemoryToolObservation = Readonly<{
  executionRef: string;
  nativeRequestRef: string;
  nativeSessionRef: string;
  parentSessionRef: string | null;
  callRef: string;
  toolId: 'memory_read' | 'memory_remember';
  toolVersion: string;
  humanSource: Readonly<{
    kind: 'ordinary-human-message' | 'adopted-steering';
    requestId: string;
    occurrenceId: string;
    sourceSessionRef: string;
    turn: number;
    proofVersion: string;
    proofDigest: string;
  }> | null;
}>;

export type MemoryHostPublication = Readonly<{
  root(
    context: RequestContext,
    input: MemoryRootObservation,
    signal: AbortSignal,
  ): Promise<Readonly<{ executionRef: string; memoryIndexDocument: string }>>;
  dispatchRoot?(
    context: RequestContext,
    input: Extract<MemoryRootObservation, { mode: 'restore' }>,
    signal: AbortSignal,
    codex: ModelDispatchAuthority['codex'],
    start: (root: {
      executionRef: string;
      memoryIndexDocument: string;
    }) => void,
  ): Promise<void>;
  call(
    context: RequestContext,
    input: MemoryToolObservation,
    signal: AbortSignal,
  ): Promise<Readonly<{ nativeRequestRef: string }>>;
}>;

/** Private installation input. The revision identifies the exact immutable
 * memory configuration selected by the source, never a model settings digest. */
export type ProductionNativeMemorySource = Readonly<{
  toolVersions: Readonly<Record<MemoryToolObservation['toolId'], string>>;
  publication: MemoryHostPublication;
  tools?: Pick<
    ReturnType<typeof createNativeEmployeeMemoryHost>,
    'readOrdinal' | 'remember'
  >;
}>;

const memoryToolVersion = 'allrice-native-employee-memory-v1';
const toolVersions = Object.freeze({
  memory_read: memoryToolVersion,
  memory_remember: memoryToolVersion,
});

export function productionNativeMemoryToolDefinitions() {
  return [
    {
      id: 'memory_read',
      version: toolVersions.memory_read,
      description:
        'Read details for a marked number in this Run’s confirmed memory index. Do not guess missing numbers.',
      parameters: z.toJSONSchema(MemoryOrdinalInputSchema),
    },
    {
      id: 'memory_remember',
      version: toolVersions.memory_remember,
      description:
        'Propose a stable fact personally stated by the current user. The owner must confirm it before it becomes active. Do not retry an unknown outcome.',
      parameters: z.toJSONSchema(RememberPersonalMemoryInputSchema, {
        io: 'input',
      }),
    },
  ];
}

export function createProductionNativeMemorySource(): ProductionNativeMemorySource {
  const host = createNativeEmployeeMemoryHost();
  return Object.freeze({ toolVersions, publication: host, tools: host });
}

export async function executeProductionNativeMemoryTool(
  tools: NonNullable<ProductionNativeMemorySource['tools']>,
  toolId: MemoryToolObservation['toolId'],
  context: RequestContext,
  target: Parameters<typeof tools.readOrdinal>[1],
  input: unknown,
  signal: AbortSignal,
) {
  if (toolId === 'memory_read')
    return tools.readOrdinal(context, target, input, signal);
  const candidate = RememberPersonalMemoryInputSchema.parse(input);
  try {
    return JSON.stringify(
      await tools.remember(context, target, candidate, signal),
    );
  } catch {
    // Once the writer is entered, a missing receipt does not prove rollback.
    return 'Memory candidate outcome is unconfirmed. Do not retry. Check Pending memories before taking further action.';
  }
}

export function selectNativeMemoryConfiguration(
  source: ProductionNativeMemorySource,
  build: NonNullable<NativeExecutionBuild>,
) {
  const { memory_read, memory_remember } = source.toolVersions;
  const selected = [
    'employee-memory-v2',
    build.sourceSha,
    build.sourceTree,
    build.manifestDigest,
    build.webBuildId,
    memoryIndexPolicy,
    ['mcp__allrice__memory_read', memory_read],
    ['mcp__allrice__memory_remember', memory_remember],
  ];
  return Object.freeze({
    ...source,
    moduleConfigRevisionRef:
      'sha256:' +
      createHash('sha256').update(JSON.stringify(selected)).digest('hex'),
  });
}
