import { randomUUID } from 'node:crypto';
import type { ModelCallBinding } from '@allrice/model-gateway';
import { describe, expect, it, vi } from 'vitest';
import * as client from '../../../packages/database/src/core/client.ts';
import { readLockedNativeMemoryExecutionEvidence } from '../../../packages/database/src/d-entry-native-memory-evidence.ts';
import { readLockedDEntryNativeRootPin } from '../../../packages/database/src/d-entry-native-root.ts';
import { ensureGeneralEmployeeInstance } from '../../../packages/database/src/employees/employee-instances.ts';
import { createRunAuthorityFixture } from '../../../packages/database/src/run-authority.fixture.ts';
import { createRuntimeFixtureDatabase } from '../../../packages/database/src/runtime.fixture.ts';
import { deferredPromptFact } from '../src/native-web/prompt-observation.js';
import {
  nativeExecutionEvidenceSource,
  nativeAdoptedTextProofVersion,
  recordNativeExecutionRequest,
  recordNativeExecutionTool,
  recordNativeMemoryToolCall,
  recoverNativeMemoryRun,
  bindNativeMemoryExecutionRef,
  type NativeExecutionEvidence,
} from '../src/person-vm/production-native-execution-evidence.js';

describe.skipIf(process.env.ALLRICE_RUN_DB_INTEGRATION !== '1')(
  'native execution evidence in the original PostgreSQL ledger',
  () => {
    it('keeps one original B, links exact dispatches, and refuses ambiguity and repeated facts', async () => {
      const { db, close } = await createRuntimeFixtureDatabase({
        ownSchemaOnly: true,
      });
      const database = vi.spyOn(client, 'getDatabase').mockReturnValue(db);
      try {
        const f = await createRunAuthorityFixture(db, {
          configure: false,
          executionGeneration: '4.0',
        });
        const run = {
          runId: randomUUID(),
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
        };
        const { runId, organizationId, workspaceId, ownerId } = run;
        const userRequest = randomUUID();
        const loginSessionId = randomUUID();
        const vm = {
          vmId: randomUUID(),
          personId: ownerId,
          organizationId,
          instanceId: randomUUID(),
          leaseEpoch: 1,
        };
        const identity = {
          organizationId,
          workspaceId,
          personId: ownerId,
          employeeInstanceId: f.assignment,
          employeeRevision: 1,
          employeeVersionId: f.version,
          threadId: f.session,
        };
        const pin = await db.begin(async (tx) => {
          await ensureGeneralEmployeeInstance(tx, f.assignment);
          const creation = {
            schemaVersion: 1,
            identity,
            host: {
              binding: vm,
              bindingRef: randomUUID(),
              rosterDigest: 'roster',
            },
            operationId: randomUUID(),
            releaseRevision: 'fixture',
          };
          await tx`update allrice_chat_sessions set d_entry_native_root_claim=${tx.json(creation)}
            where id=${f.session}`;
          await tx`update allrice_chat_sessions set d_entry_native_root=${tx.json(
            {
              ...creation,
              nativeSessionId: 'native-root',
            },
          )} where id=${f.session}`;
          await tx`insert into person_virtual_machines
            (person_id,vm_id,organization_id,phase,disk_tier,native_created,instance_id,lease_epoch,egress_receipt)
            values (${ownerId},${vm.vmId},${organizationId},'running','warm',true,
              ${vm.instanceId},${vm.leaseEpoch},'{}')`;
          return readLockedDEntryNativeRootPin(tx, identity);
        });
        if (!pin) throw Error('Root pin is missing');
        const adopted = {
          kind: 'ordinary-human-message' as const,
          occurrence: {
            sessionId: 'native-root',
            scopeId: randomUUID(),
            requestId: userRequest,
            messageId: randomUUID(),
            turn: 1,
          },
          sequence: 4,
          digest: 'sha256:' + 'a'.repeat(64),
        };
        const origin = {
          originalRequestId: userRequest,
          human: adopted,
          rootOriginRef: pin.rootOriginDigest,
          rootSessionRef: 'native-root',
          nativeOwnerRef: randomUUID(),
          nativeProfileRef: 'profile',
          applicationBuild: {
            sourceSha: 'a'.repeat(40),
            sourceTree: 'b'.repeat(40),
            webBuildId: 'sealed-web',
            manifestDigest: 'sha256:' + 'c'.repeat(64),
          },
          adoptedModelConfiguration: {
            provider: 'openai-codex',
            model: 'fixture',
            digest: 'sha256:' + 'd'.repeat(64),
          },
          employeeInstanceId: f.assignment,
          employeeRelease: f.version,
          employeeRevision: 1,
          threadId: f.session,
          vm,
        };
        const call = (attempt: number): ModelCallBinding => ({
          execution: { runId, executionId: randomUUID() },
          context: {
            actor: { type: 'user', id: ownerId },
            organizationId,
            workspaceId,
            requestId: randomUUID(),
            sessionId: loginSessionId,
            memberships: [],
            authenticatedAt: new Date().toISOString(),
          },
          vm,
          employeeInstanceId: origin.employeeInstanceId,
          employeeRelease: origin.employeeRelease,
          allriceThreadRef: f.session,
          native: {
            instanceId: origin.nativeOwnerRef,
            profile: origin.nativeProfileRef,
            sessionId: 'native-root',
            rootSessionId: 'native-root',
            parentSessionId: null,
            callId: randomUUID(),
            attemptKind: 'assistant',
            attemptId: 'native-root:' + attempt,
            attemptCursor: 7 * attempt,
            attemptTurn: 1,
          },
          executionGeneration: '4.0',
          gatewayRelease: origin.applicationBuild.manifestDigest,
          provider: 'openai-codex',
          model: 'fixture',
        });
        const signal = new AbortController().signal;
        const first = call(1);
        const second = call(2);
        const spec = {
          generation: '4.0',
          source: 'dsh-native-prompt',
          loginSessionId,
          threadId: f.session,
          employeeInstanceId: f.assignment,
          employeeRelease: f.version,
          nativeRequestId: userRequest,
          rootSessionId: adopted.occurrence.sessionId,
          adapterId: origin.nativeProfileRef,
          vmId: vm.vmId,
          personId: ownerId,
        };
        await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec)
          values (${runId},${organizationId},${workspaceId},${ownerId},'running',
          ${db.json(spec)})`;
        const write = (
          value: ModelCallBinding,
          human:
            | (Omit<typeof adopted, 'kind'> & {
                kind: 'ordinary-human-message' | 'adopted-steering';
              })
            | null,
          retry = false,
          moduleConfigRevisionRef = 'sha256:' + '2'.repeat(64),
          originalHuman?: Omit<typeof adopted, 'kind'>,
        ) =>
          db.begin(async (tx) => {
            await tx`select id from allrice_runs where id=${runId} for update`;
            if (!retry)
              await tx`insert into allrice_run_events
              (id,run_id,organization_id,workspace_id,sequence,event_type,payload)
              select ${value.execution.executionId},${runId},${organizationId},${workspaceId},
                coalesce(max(sequence)+1,0),'step.started',${tx.json({
                  source: 'dsh-native-attempt',
                  kind: 'assistant',
                  profile: value.native.profile,
                  sessionId: value.native.sessionId,
                  parentSessionId: value.native.parentSessionId,
                  nativeInstanceId: value.native.instanceId,
                  vmInstanceId: vm.instanceId,
                  leaseEpoch: vm.leaseEpoch,
                  attemptId: value.native.attemptId!,
                  cursor: value.native.attemptCursor!,
                  turn: value.native.attemptTurn!,
                  contributingRequestIds: [userRequest],
                })}
              from allrice_run_events where run_id=${runId}`;
            return recordNativeExecutionRequest(
              tx,
              run,
              value,
              { ...origin, human, moduleConfigRevisionRef },
              [userRequest],
              retry,
              originalHuman,
            );
          });
        const receipt = await write(first, adopted);
        if (!receipt) throw Error('First receipt missing');
        expect(await write(first, adopted, true, 'later-config')).toEqual({
          ...receipt,
          firstIssue: false,
        });
        expect(receipt.firstIssue).toBe(true);
        const executionRef = first.execution.executionId;
        const firstSelection = {
          mode: 'issue' as const,
          runId,
          nativeRequestRef: executionRef,
        };
        const read = (
          select: Parameters<typeof readLockedNativeMemoryExecutionEvidence>[3],
          context = first.context,
        ) =>
          db.begin((tx) =>
            readLockedNativeMemoryExecutionEvidence(
              tx,
              context,
              identity,
              select,
              signal,
            ),
          );
        await expect(read(firstSelection)).resolves.toMatchObject({
          original: receipt.origin,
          first: receipt.request,
          nativeRequestRef: executionRef,
          call: null,
        });
        await expect(
          read({ ...firstSelection, runId: randomUUID() }),
        ).rejects.toThrow();
        await expect(
          read(firstSelection, { ...first.context, sessionId: randomUUID() }),
        ).rejects.toThrow();
        const rolledBack = Error('fixture transaction rollback');
        await expect(
          db.begin(async (tx) => {
            await tx`update person_virtual_machines set lease_epoch=2 where vm_id=${vm.vmId}`;
            await expect(
              readLockedNativeMemoryExecutionEvidence(
                tx,
                first.context,
                identity,
                firstSelection,
                signal,
              ),
            ).rejects.toThrow('authorization_denied');
            throw rolledBack;
          }),
        ).rejects.toBe(rolledBack);
        await expect(read(firstSelection)).resolves.toMatchObject({
          first: receipt.request,
        });
        await expect(
          bindNativeMemoryExecutionRef(receipt, executionRef, signal),
        ).resolves.toBe(true);
        await expect(
          bindNativeMemoryExecutionRef(receipt, executionRef, signal),
        ).resolves.toBe(true);
        await expect(
          bindNativeMemoryExecutionRef(receipt, randomUUID(), signal),
        ).resolves.toBe(false);
        const original = {
          occurrence: adopted.occurrence,
          sequence: adopted.sequence,
          digest: adopted.digest,
        };
        const selector = {
          ...origin,
          organizationId,
          workspaceId,
          ownerId,
          loginSessionId,
          moduleConfigRevisionRef: 'sha256:' + '2'.repeat(64),
          original,
        };
        await expect(recoverNativeMemoryRun(selector, signal)).resolves.toBe(
          runId,
        );
        await expect(
          recoverNativeMemoryRun(
            { ...selector, loginSessionId: randomUUID() },
            signal,
          ),
        ).resolves.toBeNull();
        await expect(
          recoverNativeMemoryRun(
            { ...selector, vm: { ...vm, leaseEpoch: 2 } },
            signal,
          ),
        ).resolves.toBeNull();
        await expect(
          recoverNativeMemoryRun(
            {
              ...selector,
              original: { ...original, digest: 'sha256:' + 'b'.repeat(64) },
            },
            signal,
          ),
        ).resolves.toBeNull();
        const ambiguous = await write(second, null, false, 'later-config');
        if (!ambiguous) throw Error('Second receipt missing');
        expect(ambiguous.request).toMatchObject({ b: runId, human: null });
        await expect(
          read({
            ...firstSelection,
            nativeRequestRef: second.execution.executionId,
          }),
        ).rejects.toThrow();
        const steer = {
          ...adopted,
          kind: 'adopted-steering' as const,
          sequence: 12,
          occurrence: {
            ...adopted.occurrence,
            requestId: randomUUID(),
            scopeId: randomUUID(),
            messageId: randomUUID(),
          },
        };
        const steered = await write(
          call(3),
          steer,
          false,
          'later-config',
          original,
        );
        expect(steered).toMatchObject({
          firstIssue: false,
          origin: receipt.origin,
          request: { b: runId, human: steer },
        });
        const tool = {
          attemptId: first.native.attemptId!,
          assistantSequence: 9,
          sequence: 10,
          callId: 'tool-call-original',
          name: 'fixture_tool_evidence',
          dispatch: {
            kind: 'sealed-handler' as const,
            version: 'sealed-test-handler-v1',
          },
          human: adopted,
        };
        await recordNativeExecutionTool(
          receipt,
          {
            ...tool,
            callId: 'wrong-content',
            human: { ...adopted, digest: 'sha256:' + 'e'.repeat(64) },
          },
          signal,
        );
        await recordNativeExecutionTool(
          ambiguous,
          {
            ...tool,
            attemptId: second.native.attemptId!,
            assistantSequence: 16,
            sequence: 17,
            callId: 'ambiguous',
          },
          signal,
        );
        await Promise.all([
          recordNativeExecutionTool(receipt, tool, signal),
          recordNativeExecutionTool(receipt, tool, signal),
        ]);
        const memoryTool = {
          ...tool,
          name: 'mcp__allrice__memory_remember',
          callId: 'memory-call-1',
          sequence: 11,
          executionSessionRef: origin.rootSessionRef,
          executionParentRef: null,
        };
        await expect(
          recordNativeMemoryToolCall(receipt, randomUUID(), memoryTool, signal),
        ).resolves.toBeNull();
        await expect(
          recordNativeMemoryToolCall(
            receipt,
            executionRef,
            {
              ...memoryTool,
              executionSessionRef: 'other-session',
            },
            signal,
          ),
        ).resolves.toBeNull();
        const locked = deferredPromptFact<void>();
        const unlocked = deferredPromptFact<void>();
        const blocker = db.begin(async (tx) => {
          await tx`select id from allrice_runs where id=${runId} for update`;
          locked.resolve();
          await unlocked.promise;
        });
        try {
          await Promise.race([locked.promise, blocker]);
          await expect(
            recordNativeMemoryToolCall(
              receipt,
              executionRef,
              memoryTool,
              signal,
            ),
          ).rejects.toMatchObject({ code: '55P03' });
          const [written] = await db`select id from allrice_run_events
            where run_id=${runId} and payload->>'kind'='memory-tool'`;
          expect(written).toBeUndefined();
        } finally {
          unlocked.resolve();
          await blocker;
        }
        const [toolRef, replay] = await Promise.all([
          recordNativeMemoryToolCall(receipt, executionRef, memoryTool, signal),
          recordNativeMemoryToolCall(receipt, executionRef, memoryTool, signal),
        ]);
        if (!toolRef) throw Error('Memory tool fact is missing');
        expect(replay).toBe(toolRef);
        const toolSelection = {
          mode: 'call' as const,
          nativeRequestRef: toolRef,
        };
        await expect(read(toolSelection)).resolves.toMatchObject({
          nativeRequestRef: toolRef,
          original: receipt.origin,
          first: receipt.request,
          call: {
            executionId: executionRef,
            executionRef,
            proofVersion: nativeAdoptedTextProofVersion,
            tool: memoryTool,
          },
        });
        await expect(
          read({ mode: 'call', nativeRequestRef: executionRef }),
        ).rejects.toThrow();
        await expect(
          recordNativeMemoryToolCall(
            receipt,
            executionRef,
            {
              ...memoryTool,
              sequence: 12,
            },
            signal,
          ),
        ).resolves.toBeNull();
        await expect(
          recordNativeMemoryToolCall(
            receipt,
            executionRef,
            {
              ...memoryTool,
              callId: 'duplicate-sequence',
            },
            signal,
          ),
        ).resolves.toBeNull();
        await db`update person_virtual_machines set phase='stopped' where vm_id=${vm.vmId}`;
        await expect(read(toolSelection)).rejects.toThrow();
        await expect(read(firstSelection)).rejects.toThrow();
        const storedToolSelection = {
          ...toolSelection,
          mode: 'stored-call' as const,
          runId,
        };
        await expect(
          read(storedToolSelection, {
            ...first.context,
            sessionId: randomUUID(),
          }),
        ).resolves.toMatchObject({
          nativeRequestRef: toolRef,
          call: { tool: memoryTool },
        });
        await expect(
          read({ ...storedToolSelection, runId: randomUUID() }),
        ).rejects.toThrow();
        await expect(read({ mode: 'restore', runId })).resolves.toMatchObject({
          original: receipt.origin,
          first: receipt.request,
          nativeRequestRef: null,
        });
        await db`update person_virtual_machines set phase='running' where vm_id=${vm.vmId}`;
        const refused = call(4);
        await db`create function refuse_native_evidence_fixture()
          returns trigger language plpgsql as $body$
          begin
            raise exception 'synthetic native evidence failure';
          end;
          $body$`;
        await db`create trigger refuse_native_evidence_fixture
          before insert on allrice_run_events for each row
          when ((new.payload->>'source')='dsh-native-execution-evidence-v1')
          execute function refuse_native_evidence_fixture()`;
        expect(await write(refused, adopted)).toBeNull();
        const [priorAudit] = await db`select event_type from allrice_run_events
          where run_id=${runId} and id=${refused.execution.executionId}`;
        expect(priorAudit?.event_type).toBe('step.started');
        const rows = await db<{ payload: NativeExecutionEvidence }[]>`
          select payload from allrice_run_events
          where run_id=${runId} and payload->>'source'=${nativeExecutionEvidenceSource}
          order by sequence`;
        expect(rows.map(({ payload }) => payload)).toMatchObject([
          {
            kind: 'origin',
            b: runId,
            ...origin,
            originalExecutionId: first.execution.executionId,
            moduleConfigRevisionRef: 'sha256:' + '2'.repeat(64),
          },
          receipt.request,
          { kind: 'memory-root', b: runId, executionRef },
          ambiguous.request,
          steered?.request,
          {
            kind: 'tool',
            b: runId,
            executionId: first.execution.executionId,
            proofVersion: 'dsh-adopted-text-v1',
            tool,
          },
          {
            kind: 'memory-tool',
            b: runId,
            executionId: executionRef,
            executionRef,
            tool: memoryTool,
          },
        ]);
      } finally {
        database.mockRestore();
        await close();
      }
    }, 120_000);
  },
);
