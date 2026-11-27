/** Private projections from the original Workflow ledger into the memory
 * caller. Authorizing reads never use a pool checkout separate from the
 * original transaction. The root/tool facts are locators, not authority. */
import { isDeepStrictEqual } from 'node:util';
import {
  UuidSchema,
  type AdoptedHumanSourceProjection,
  type RequestContext,
} from '@allrice/contracts';
import { readEmployeeBusinessCurrentPreflight } from './business-runtime/current-preflight.ts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { readLockedNativeMemoryExecutionEvidence } from './d-entry-native-memory-evidence.ts';
import type {
  MemoryRuntimeAssembly,
  MemoryRuntimeExecution,
} from './memory-runtime-binding.ts';
import { readLockedNativeMemoryAuthority } from './memory-runtime-current.ts';
import { runtimePolicyDigest } from './runtime-policy-digest.ts';

export type NativeMemoryRootObservation = Readonly<
  ({ mode: 'issue'; nativeRequestRef: string } | { mode: 'restore' }) & {
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

export type NativeMemoryToolObservation = Readonly<{
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

type Evidence = Awaited<
  ReturnType<typeof readLockedNativeMemoryExecutionEvidence>
>;
type Authority = Awaited<ReturnType<typeof readLockedNativeMemoryAuthority>>;
const deny = (): never => {
  throw new DataAccessError('authorization_denied');
};

function project(
  evidence: Evidence,
  authority: Authority,
): MemoryRuntimeExecution {
  const { original, call, nativeRequestRef } = evidence;
  const nativeCall = call
    ? {
        rootSessionRef: original.rootSessionRef,
        parentSessionRef: call.tool.executionParentRef,
        sessionRef: call.tool.executionSessionRef,
        callRef: UuidSchema.parse(nativeRequestRef),
        toolId:
          call.tool.name === 'mcp__allrice__memory_read'
            ? 'memory_read'
            : 'memory_remember',
        toolVersion: call.tool.dispatch.version,
      }
    : null;
  return {
    binding: {
      scope: authority.current.scope,
      threadId: original.threadId,
      executionGeneration: '4.0',
      b: original.b,
      executionBoundaryRef: original.originalExecutionId,
      rootOriginRef: original.rootOriginRef,
      rootSessionRef: original.rootSessionRef,
      nativeCall,
    },
    nativeOwnerRef: original.nativeOwnerRef,
    nativeProfileRef: original.nativeProfileRef,
    nativeSessionRef: nativeCall?.sessionRef ?? original.rootSessionRef,
    parentSessionRef: nativeCall?.parentSessionRef ?? null,
    moduleConfigRevisionRef: original.moduleConfigRevisionRef,
    moduleOrigin: {
      kind: 'builtin',
      moduleId: 'employee-memory',
      applicationBuild: original.applicationBuild,
    },
  };
}

function observedHuman(call: NonNullable<Evidence['call']>) {
  const { human } = call.tool;
  return {
    kind: human.kind,
    requestId: human.occurrence.requestId,
    occurrenceId: human.occurrence.messageId,
    sourceSessionRef: human.occurrence.sessionId,
    turn: human.occurrence.turn,
    proofVersion: call.proofVersion,
    proofDigest: human.digest,
  };
}

function source(
  evidence: Evidence,
  authority: Authority,
): AdoptedHumanSourceProjection {
  const { binding } = project(evidence, authority);
  if (!binding.nativeCall || !evidence.call) return deny();
  const human = observedHuman(evidence.call);
  const value = {
    scope: binding.scope,
    threadId: binding.threadId,
    b: binding.b,
    executionBoundaryRef: binding.executionBoundaryRef,
    rootOriginRef: binding.rootOriginRef,
    nativeCall: binding.nativeCall,
    sourceRef: runtimePolicyDigest(evidence.call.tool.human.occurrence),
    proof: { version: human.proofVersion, digest: human.proofDigest },
    // Revision from the still-locked current instance and release, and the
    // source thread's still-current pinned root. Never reuse the old VM epoch.
    accessRevisionRef: runtimePolicyDigest({
      releaseRevision: authority.releaseRevision,
      employeeRevision: authority.identity.employeeRevision,
      employeeVersionId: authority.identity.employeeVersionId,
      threadId: binding.threadId,
      rootOriginRef: binding.rootOriginRef,
      sourceSessionRef: human.sourceSessionRef,
    }),
  };
  return human.kind === 'adopted-steering'
    ? { ...value, kind: human.kind, adoptedByExecution: true }
    : { ...value, kind: human.kind };
}

function checkRoot(evidence: Evidence, root: NativeMemoryRootObservation) {
  const o = evidence.original;
  if (
    o.b !== root.runId ||
    o.threadId !== root.threadId ||
    o.employeeInstanceId !== root.employeeInstanceId ||
    o.originalRequestId !== root.originalPromptRequestId ||
    o.human.occurrence.turn !== root.originalTurn ||
    o.rootSessionRef !== root.rootNativeSessionRef ||
    o.nativeOwnerRef !== root.nativeOwnerRef ||
    o.nativeProfileRef !== root.nativeProfileRef ||
    o.moduleConfigRevisionRef !== root.moduleConfigRevisionRef ||
    o.vm.vmId !== root.vm.vmId ||
    o.vm.instanceId !== root.vm.instanceId ||
    o.vm.leaseEpoch !== root.vm.leaseEpoch
  )
    deny();
}

function checkCall(evidence: Evidence, expected: NativeMemoryToolObservation) {
  const call = evidence.call;
  if (
    !call ||
    evidence.nativeRequestRef !== expected.nativeRequestRef ||
    call.executionRef !== expected.executionRef ||
    call.tool.executionSessionRef !== expected.nativeSessionRef ||
    call.tool.executionParentRef !== expected.parentSessionRef ||
    call.tool.callId !== expected.callRef ||
    call.tool.name !== 'mcp__allrice__' + expected.toolId ||
    call.tool.dispatch.version !== expected.toolVersion ||
    !isDeepStrictEqual(observedHuman(call), expected.humanSource)
  )
    deny();
}

export function workflowMemoryRuntime(
  expected?:
    | { root: NativeMemoryRootObservation }
    | { call: NativeMemoryToolObservation },
): MemoryRuntimeAssembly {
  return {
    async current(context, target, signal) {
      return (
        await readEmployeeBusinessCurrentPreflight(
          context,
          target,
          undefined,
          signal,
        )
      ).projection;
    },
    async bind(tx, context, target, signal, preflight) {
      let locked: Authority | undefined;
      function authority() {
        if (!locked) return deny();
        return locked;
      }
      const read = (
        selector: Parameters<typeof readLockedNativeMemoryExecutionEvidence>[3],
        threadId = authority().identity.threadId,
      ) =>
        readLockedNativeMemoryExecutionEvidence(
          tx,
          context,
          { ...authority().identity, threadId },
          selector,
          signal,
        );
      return {
        async current() {
          if (
            preflight?.module.kind !== 'builtin' ||
            !preflight.module.applicationModules.applicationBuild
          )
            return deny();
          locked = await readLockedNativeMemoryAuthority(
            tx,
            context,
            target,
            preflight.module.applicationModules,
            signal,
          );
          return locked.current;
        },
        async firstContext(selector) {
          if (
            expected === undefined ||
            !('root' in expected) ||
            expected.root.mode !== 'issue'
          )
            return deny();
          const root = expected.root;
          const evidence = await read({
            mode: 'issue',
            runId: root.runId,
            nativeRequestRef: selector.nativeRequestRef,
          });
          checkRoot(evidence, root);
          const module = authority().current.module;
          if (
            module.kind !== 'builtin' ||
            !isDeepStrictEqual(
              evidence.original.applicationBuild,
              module.applicationModules.applicationBuild,
            )
          )
            return deny();
          return project(evidence, authority());
        },
        async stored(selector) {
          const evidence = await read({ mode: 'restore', runId: selector.b });
          if (expected && 'root' in expected)
            checkRoot(evidence, expected.root);
          return project(evidence, authority());
        },
        async actual(selector) {
          const evidence = await read({
            mode: 'call',
            nativeRequestRef: selector.nativeRequestRef,
          });
          if (expected && 'call' in expected)
            checkCall(evidence, expected.call);
          return project(evidence, authority());
        },
        async adopted(selector) {
          return source(
            await read({
              mode: 'call',
              nativeRequestRef: selector.nativeCall.callRef,
            }),
            authority(),
          );
        },
        async storedSource(selector) {
          if (!isDeepStrictEqual(selector.scope, authority().current.scope))
            return deny();
          return source(
            await read(
              {
                mode: 'stored-call',
                runId: selector.b,
                nativeRequestRef: selector.nativeCall.callRef,
              },
              selector.threadId,
            ),
            authority(),
          );
        },
      };
    },
  };
}

/** Pool lookup supplies only the address of the caller scope. The named
 * authorization reads the exact occurrence again inside its dedicated tx. */
export async function locateNativeMemoryTool(
  context: RequestContext,
  nativeRequestRef: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (context.actor.type !== 'user') return deny();
  const ref = UuidSchema.parse(nativeRequestRef);
  const [row] = await getDatabase()<
    {
      workspace_id: string;
      instance_ref: string | null;
      thread_ref: string | null;
    }[]
  >`
    select r.workspace_id,r.execution_spec->>'employeeInstanceId' as instance_ref,
      r.execution_spec->>'threadId' as thread_ref
    from allrice_run_events e join allrice_runs r on r.id=e.run_id
      and r.organization_id=e.organization_id and r.workspace_id=e.workspace_id
    where e.id=${ref} and r.organization_id=${context.organizationId}
      and r.owner_id=${context.actor.id} and r.visibility='private'
      and (${context.workspaceId}::uuid is null or r.workspace_id=${context.workspaceId}::uuid)
      and e.event_type='harness.native'
      and e.payload->>'source'='dsh-native-execution-evidence-v1'
      and e.payload->>'kind'='memory-tool'
  `;
  signal.throwIfAborted();
  if (!row) return deny();
  return {
    workspaceId: UuidSchema.parse(row.workspace_id),
    employeeInstanceId: UuidSchema.parse(row.instance_ref),
    threadId: UuidSchema.parse(row.thread_ref),
    nativeRequestRef: ref,
    module: { kind: 'builtin' as const, moduleId: 'employee-memory' as const },
  };
}
