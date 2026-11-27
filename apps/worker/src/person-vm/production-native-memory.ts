import { createHash } from 'node:crypto';
import { memoryIndexPolicy, type RequestContext } from '@allrice/contracts';
import type { NativeExecutionBuild } from './production-native-execution-evidence.js';

export type MemoryRootObservation = Readonly<{
  mode: 'issue' | 'restore';
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
}>;

export type MemoryToolObservation = Readonly<{
  executionRef: string;
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
}>;

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
