import type { RequestContext } from '@allrice/contracts';

export type MemoryRootObservation = Readonly<{
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
  moduleConfigRevisionRef: string;
  toolVersions: Readonly<Record<MemoryToolObservation['toolId'], string>>;
  publication: MemoryHostPublication;
}>;
