import { randomUUID } from 'node:crypto';
import type { ModelCallBinding } from '@allrice/model-gateway';
import { describe, expect, it, vi } from 'vitest';
import * as client from '../../../packages/database/src/core/client.ts';
import { createRunAuthorityFixture } from '../../../packages/database/src/run-authority.fixture.ts';
import { createRuntimeFixtureDatabase } from '../../../packages/database/src/runtime.fixture.ts';
import {
  nativeExecutionEvidenceSource,
  recordNativeExecutionRequest,
  recordNativeExecutionTool,
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
        const vm = {
          vmId: randomUUID(),
          personId: ownerId,
          organizationId,
          instanceId: randomUUID(),
          leaseEpoch: 1,
        };
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
          rootOriginRef: 'root-pin',
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
            sessionId: randomUUID(),
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
        await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec)
          values (${runId},${organizationId},${workspaceId},${ownerId},'running',
          '{"generation":"4.0"}'::jsonb)`;
        const write = (
          value: ModelCallBinding,
          human: typeof adopted | null,
          retry = false,
          moduleConfigRevisionRef = 'fixture-memory-config-v2',
        ) =>
          db.begin(async (tx) => {
            await tx`select id from allrice_runs where id=${runId} for update`;
            if (!retry)
              await tx`insert into allrice_run_events
              (id,run_id,organization_id,workspace_id,sequence,event_type,payload)
              select ${value.execution.executionId},${runId},${organizationId},${workspaceId},
                coalesce(max(sequence)+1,0),'step.started','{"source":"dsh-native-attempt","kind":"assistant"}'::jsonb
              from allrice_run_events where run_id=${runId}`;
            return recordNativeExecutionRequest(
              tx,
              run,
              value,
              { ...origin, human, moduleConfigRevisionRef },
              [userRequest],
              retry,
            );
          });
        const receipt = await write(first, adopted);
        if (!receipt) throw Error('First receipt missing');
        expect(receipt.openedOrigin).toBe(true);
        expect(await write(first, adopted, true, 'later-config')).toEqual({
          ...receipt,
          openedOrigin: false,
        });
        const ambiguous = await write(second, null, false, 'later-config');
        if (!ambiguous) throw Error('Second receipt missing');
        expect(ambiguous.request).toMatchObject({ b: runId, human: null });
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
        const refused = call(3);
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
            moduleConfigRevisionRef: 'fixture-memory-config-v2',
          },
          receipt.request,
          ambiguous.request,
          {
            kind: 'tool',
            b: runId,
            executionId: first.execution.executionId,
            proofVersion: 'dsh-adopted-text-v1',
            tool,
          },
        ]);
      } finally {
        database.mockRestore();
        await close();
      }
    }, 120_000);
  },
);
