import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  MemoryOrdinalInputSchema,
  RememberPersonalMemoryInputSchema,
} from '@allrice/contracts';
import type { ModelCallBinding } from '@allrice/model-gateway';
import { TYPERT_REMOTE as Native } from '@deepseek-ai/dsh-api-session-controller/remote';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as client from '../../../../packages/database/src/core/client.ts';
import { readLockedDEntryNativeRootPin } from '../../../../packages/database/src/d-entry-native-root.ts';
import { dEntryReleasePolicyKey } from '../../../../packages/database/src/d-entry-release-policy.ts';
import { createNativeEmployeeMemoryHost } from '../../../../packages/database/src/employee-memory-runtime.ts';
import { ensureGeneralEmployeeInstance } from '../../../../packages/database/src/employees/employee-instances.ts';
import {
  authenticateSession,
  createSession,
} from '../../../../packages/database/src/identity.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import * as buildIdentity from '../../../../packages/database/src/service-build-identity.ts';
import { insertEmployeeMemoryPair } from '../../../../packages/database/src/workspace/employee-memory-mutation.ts';
import { memoryPairDigest } from '../../../../packages/database/src/workspace/employee-memory-primitives.ts';
import { promoteManagedEmployeeMemory } from '../../../../packages/database/src/workspace/service.ts';
import {
  listen,
  closeServer,
} from '../../../../packages/model-gateway/src/gateway.fixture.js';
import {
  bindNativeMemoryExecutionRef,
  nativeAdoptedTextProofVersion,
  recordNativeExecutionRequest,
  recordNativeMemoryToolCall,
} from '../person-vm/production-native-execution-evidence.js';
import {
  selectNativeMemoryConfiguration,
  type MemoryHostPublication,
  type MemoryRootObservation,
} from '../person-vm/production-native-memory.js';
import { setupNativeWebFixture } from './owner.native.fixture.js';
import { deferredPromptFact, waitForPromptFact } from './prompt-observation.js';

const cli = process.env.ALLRICE_NATIVE_WEB_TEST_CLI;
const candidate = {
  summary: 'Keep the isolated acceptance note',
  details: 'candidate from the real adopted turn',
};
const confirmed = {
  summary: 'Previously confirmed for this employee',
  details: 'unique authorized memory body',
};
const tools = [
  {
    id: 'memory_read',
    schema: z.toJSONSchema(MemoryOrdinalInputSchema),
    args: { number: 1 },
  },
  {
    id: 'memory_remember',
    schema: z.toJSONSchema(RememberPersonalMemoryInputSchema, { io: 'input' }),
    args: candidate,
  },
] as const;
const build = {
  sourceSha: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  manifestDigest: 'sha256:' + 'c'.repeat(64),
  webBuildId: 'isolated-memory-build',
};

it.skipIf(!cli || process.env.ALLRICE_RUN_DB_INTEGRATION !== '1')(
  'commits both sealed rc.2 tool occurrences before native memory execution and denies revoked or mismatched evidence',
  { tags: ['manual:ALLRICE_NATIVE_WEB_TEST_CLI'], timeout: 45_000 },
  async () => {
    const { db, close } = await createRuntimeFixtureDatabase({
      ownSchemaOnly: true,
    });
    const database = vi.spyOn(client, 'getDatabase').mockReturnValue(db);
    const seal = vi
      .spyOn(buildIdentity, 'readServiceBuildIdentity')
      .mockResolvedValue({
        ...build,
        schemaVersion: 1,
        environment: 'dev',
        repository: 'semiok/allrice-vm',
        repositoryId: 1469490636,
        service: 'worker',
        mode: 'production',
        artifactDigest: 'sha256:' + 'd'.repeat(64),
        runtimeGraphDigest: 'sha256:' + 'e'.repeat(64),
        bootId: randomUUID(),
        pid: 1,
        startedAt: new Date().toISOString(),
        nodeVersion: 'v22.23.2',
        protocols: {
          identity: 1,
          ordinaryConsumer: 1,
          releaseAdmission: 'disabled',
        },
      });
    const roots: string[] = [];
    const cleanup: (() => Promise<void>)[] = [];
    const failures: unknown[] = [];
    try {
      const f = await createRunAuthorityFixture(db, {
        configure: false,
        executionGeneration: '4.0',
      });
      const login = await createSession(f.user);
      const identity = {
        organizationId: f.org,
        workspaceId: f.workspace,
        personId: f.user,
        employeeInstanceId: f.assignment,
        employeeRevision: 1,
        employeeVersionId: f.version,
        threadId: f.session,
      };
      const context = await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!context) throw Error('Isolated owner did not authenticate');
      await db.begin(async (tx) => {
        await ensureGeneralEmployeeInstance(tx, f.assignment);
        const release = {
          revision: randomUUID(),
          defaultGeneration: '3.x',
          selections: [{ organizationId: f.org, personId: f.user }],
        };
        await tx`insert into allrice_settings(scope_type,key,value) values('system',${dEntryReleasePolicyKey},${tx.json(release)})`;
        await insertEmployeeMemoryPair(
          tx,
          context,
          {
            organizationId: f.org,
            workspaceId: f.workspace,
            ownerId: f.user,
            instanceId: f.assignment,
            employeeId: f.employee,
          },
          confirmed,
          {
            sourceType: 'user',
            sourceId: null,
            sourceLabel: 'fixture owner confirmed',
            trust: 'user_confirmed',
            lifecycleState: 'durable',
            confidence: 1,
            memoryClass: 'work_note',
          },
        );
      });
      const signal = AbortSignal.timeout(35_000);
      const host = createNativeEmployeeMemoryHost();
      const publication: MemoryHostPublication = host;
      const version = 'isolated-memory-v1';
      const selected = selectNativeMemoryConfiguration(
        {
          toolVersions: { memory_read: version, memory_remember: version },
          publication,
        },
        build,
      );
      const modelName = 'fixture-codex';
      const capability = randomBytes(32).toString('base64url');
      const nativePromptId = randomUUID();
      const run = {
        runId: randomUUID(),
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
      };
      const references = new Map<string, boolean>();
      const error = deferredPromptFact<never>();
      void error.promise.catch(() => {});
      const results = deferredPromptFact<void>();
      const delivered = new Map<
        string,
        { nativeRequestRef: string; value: unknown }
      >();
      const receipts = new Map<
        string,
        Awaited<ReturnType<typeof recordNativeMemoryToolCall>>
      >();
      const callbackInputs = new Map<
        string,
        Parameters<MemoryHostPublication['call']>[1]
      >();
      let receipt:
        | NonNullable<Awaited<ReturnType<typeof recordNativeExecutionRequest>>>
        | undefined;
      let rootInput: MemoryRootObservation | undefined;
      let indexDocument: string | undefined;
      let assistantCalls = 0;

      async function sealFirstRequest() {
        const native = await owner.readNativeAttemptFor(
          context,
          { kind: 'session', sessionId: nativeSessionId },
          signal,
        );
        const observation = native?.observation;
        if (
          !native ||
          !observation?.human ||
          !observation.request ||
          !owner.modelAdapterId
        )
          throw Error('The actual adopted native request is unavailable');
        expect(observation.proofState).toBe('adopted');
        expect(observation.firstMemoryAttempt).toBe(true);
        expect(observation.memoryToolVersions).toEqual(selected.toolVersions);
        const vm = owner.binding;
        const step: ModelCallBinding = {
          execution: { runId: run.runId, executionId: randomUUID() },
          context,
          vm,
          employeeInstanceId: f.assignment,
          employeeRelease: f.version,
          allriceThreadRef: f.session,
          native: {
            instanceId: owner.nativeInstanceId,
            profile: owner.modelAdapterId,
            sessionId: nativeSessionId,
            rootSessionId: nativeSessionId,
            parentSessionId: null,
            callId: randomUUID(),
            attemptKind: 'assistant',
            attemptId: native.id,
            attemptCursor: native.cursor,
            attemptTurn: native.turn!,
          },
          executionGeneration: '4.0',
          gatewayRelease: build.manifestDigest,
          provider: 'openai-codex',
          model: modelName,
        };
        const model = observation.request,
          human = observation.human;
        receipt =
          (await db.begin(async (tx) => {
            const executionSpec = {
              source: 'dsh-native-prompt',
              generation: '4.0',
              loginSessionId: login.id,
              threadId: f.session,
              employeeInstanceId: f.assignment,
              employeeRelease: f.version,
              nativeRequestId: nativePromptId,
              rootSessionId: nativeSessionId,
              adapterId: step.native.profile,
              vmId: vm.vmId,
              personId: f.user,
            };
            await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec)
          values (${run.runId},${f.org},${f.workspace},${f.user},'running',${tx.json(executionSpec)})`;
            await tx`insert into allrice_run_events(id,run_id,organization_id,workspace_id,sequence,event_type,payload)
          values (${step.execution.executionId},${run.runId},${f.org},${f.workspace},0,'step.started',${tx.json(
            {
              source: 'dsh-native-attempt',
              kind: 'assistant',
              sessionId: nativeSessionId,
              parentSessionId: null,
              profile: step.native.profile,
              nativeInstanceId: step.native.instanceId,
              vmInstanceId: vm.instanceId,
              leaseEpoch: vm.leaseEpoch,
              cursor: native.cursor,
              turn: native.turn,
              attemptId: native.id,
              contributingRequestIds: native.promptIds,
            },
          )})`;
            return recordNativeExecutionRequest(
              tx,
              run,
              step,
              {
                originalRequestId: nativePromptId,
                human,
                rootOriginRef: nativePin.rootOriginDigest,
                rootSessionRef: nativeSessionId,
                nativeOwnerRef: step.native.instanceId,
                nativeProfileRef: step.native.profile,
                applicationBuild: build,
                moduleConfigRevisionRef: selected.moduleConfigRevisionRef,
                adoptedModelConfiguration: model,
                employeeInstanceId: f.assignment,
                employeeRelease: f.version,
                employeeRevision: identity.employeeRevision,
                threadId: f.session,
                vm,
              },
              native.promptIds,
              false,
            );
          })) ?? undefined;
        if (!receipt) throw Error('Workflow evidence was not committed');
        rootInput = {
          mode: 'issue',
          nativeRequestRef: step.execution.executionId,
          runId: run.runId,
          workspaceId: f.workspace,
          employeeInstanceId: f.assignment,
          threadId: f.session,
          originalPromptRequestId: nativePromptId,
          originalTurn: human.occurrence.turn,
          rootNativeSessionRef: nativeSessionId,
          nativeOwnerRef: step.native.instanceId,
          nativeProfileRef: step.native.profile,
          moduleConfigRevisionRef: selected.moduleConfigRevisionRef,
          vm,
        };
        const firstStep = rootInput.nativeRequestRef;
        const restore = { ...rootInput, mode: 'restore' as const };
        await expect(
          publication.root(context, restore, signal),
        ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_UNAVAILABLE' });
        await expect(
          publication.root(
            context,
            { ...rootInput, nativeRequestRef: randomUUID() },
            signal,
          ),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        const issued = await publication.root(context, rootInput, signal);
        expect(firstStep).toBe(receipt.origin.originalExecutionId);
        indexDocument = issued.memoryIndexDocument;
        expect(indexDocument).toContain(confirmed.summary);
        expect(
          await bindNativeMemoryExecutionRef(
            receipt,
            issued.executionRef,
            signal,
          ),
        ).toBe(true);
        expect(await publication.root(context, restore, signal)).toEqual(
          issued,
        );
      }

      const server = createServer((request, response) => {
        void (async () => {
          if (request.headers.authorization !== 'Bearer ' + capability)
            throw Error('Fixture capability mismatch');
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          if (request.url === '/fixture-memory-tool') {
            const body = z
              .object({
                id: z.enum(['memory_read', 'memory_remember']),
                ref: z.string(),
                args: z.unknown(),
              })
              .strict()
              .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            const value =
              body.id === 'memory_read'
                ? await host.readOrdinal(context, body.ref, body.args, signal)
                : await host.remember(context, body.ref, body.args, signal);
            delivered.set(body.id, { nativeRequestRef: body.ref, value });
            response
              .writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify(value));
            if (delivered.size === 2) results.resolve();
            return;
          }
          if (
            request.url === '/v1/reference' ||
            request.url === '/v1/reference/session-title'
          ) {
            const title = request.url.endsWith('/session-title');
            if (!title && !receipt) await sealFirstRequest();
            const reference = randomBytes(32).toString('base64url');
            references.set(reference, title);
            response
              .writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify({ reference }));
            return;
          }
          const title = references.get(
            String(request.headers['x-allrice-model-call-reference']),
          );
          if (request.url !== '/v1/stream' || title === undefined)
            throw Error('Unknown test model request');
          const first = !title && ++assistantCalls === 1;
          const deltas = first
            ? tools.map(({ id, args }, index) => ({
                type: 'tool-call-delta',
                index,
                id: randomUUID(),
                name: 'mcp__allrice__' + id,
                argumentsDelta: JSON.stringify(args),
              }))
            : [
                {
                  type: 'text-delta',
                  index: 0,
                  text: 'Isolated native memory check.',
                },
              ];
          response
            .writeHead(200, { 'content-type': 'application/x-ndjson' })
            .end(
              [
                ...deltas,
                {
                  type: 'finish',
                  reason: { kind: first ? 'tool-calls' : 'stop' },
                },
              ]
                .map((value) => JSON.stringify(value) + '\n')
                .join(''),
            );
        })().catch((cause: unknown) => {
          error.reject(cause);
          response.destroy(Error('Fixture failure', { cause }));
        });
      });
      const origin = await listen(server);
      cleanup.push(() => closeServer(server));
      const probe = `
        import { withNativeMemoryToolPublication } from './owner.mjs';
        export const inject = ['tools'];
        export function apply(ctx) {
          for(const tool of ${JSON.stringify(tools)}) {
            ctx.tools.register(withNativeMemoryToolPublication({
              name: 'mcp__allrice__' + tool.id,
              description: 'Validate the isolated native memory contract.',
              parameters: tool.schema,
              output: { schema: {type:'string'}, render: text => [{type:'text',text}] },
              async execute(args, exec, ref) {
                const response = await fetch(${JSON.stringify(origin + '/fixture-memory-tool')}, {
                  method: 'POST', signal: exec.signal,
                  headers: {authorization: ${JSON.stringify('Bearer ' + capability)}, 'content-type':'application/json'},
                  body: JSON.stringify({id:tool.id,args,ref}),
                });
                if (!response.ok) throw Error('Fixture tool refused');
                return JSON.stringify(await response.json());
              },
            }, ${JSON.stringify(version)}));
          }
        }
      `;
      const owner = (
        await setupNativeWebFixture(
          cli,
          roots,
          cleanup,
          undefined,
          {
            identity,
            loginSessionId: login.id,
            nativeToolEvidenceProbe: probe,
          },
          {
            origin,
            capability,
            provider: 'openai-codex',
            model: modelName,
            modelInfo: {
              provider: 'openai-codex',
              id: modelName,
              name: modelName,
              inputModalities: ['text'],
            },
          },
          async (request) => {
            if (request.endpoint !== 'session/prompt')
              throw Error('Unexpected fixture prompt');
            const observation = request.observe(
              signal,
              undefined,
              async (fact, active) => {
                try {
                  if (!receipt)
                    throw Error('Missing original authorized receipt');
                  const ref = await recordNativeMemoryToolCall(
                    receipt,
                    run.runId,
                    fact,
                    active,
                  );
                  if (!ref) throw Error('Missing committed tool receipt');
                  const toolId = z
                    .enum(['memory_read', 'memory_remember'])
                    .parse(fact.name.replace('mcp__allrice__', ''));
                  const { human } = fact;
                  if (fact.dispatch.kind !== 'sealed-handler')
                    throw Error('Missing sealed tool body');
                  const input = {
                    executionRef: run.runId,
                    nativeRequestRef: ref,
                    nativeSessionRef: fact.executionSessionRef,
                    parentSessionRef: fact.executionParentRef,
                    callRef: fact.callId,
                    toolId,
                    toolVersion: fact.dispatch.version,
                    humanSource: {
                      kind: human.kind,
                      requestId: human.occurrence.requestId,
                      occurrenceId: human.occurrence.messageId,
                      sourceSessionRef: human.occurrence.sessionId,
                      turn: human.occurrence.turn,
                      proofVersion: nativeAdoptedTextProofVersion,
                      proofDigest: human.digest,
                    },
                  };
                  receipts.set(toolId, ref);
                  callbackInputs.set(toolId, input);
                  const { nativeRequestRef } = await publication.call(
                    context,
                    input,
                    active,
                  );
                  return nativeRequestRef;
                } catch (cause) {
                  error.reject(cause);
                  throw cause;
                }
              },
            );
            await observation.ready;
            return {
              undispatched: () => observation.close(),
              accepted() {},
              unknown() {},
            };
          },
        )
      ).owner;

      const created = await owner.createRootFor(context, {}, signal);
      if (!created.ok) throw Error('Root was not created');
      const nativeSessionId = created.value.sessionId;
      const nativePin = await db.begin(async (tx) => {
        const creation = {
          schemaVersion: 1,
          identity,
          host: {
            binding: owner.binding,
            bindingRef: randomUUID(),
            rosterDigest: 'fixture',
          },
          operationId: randomUUID(),
          releaseRevision: 'fixture',
        };
        await tx`update allrice_chat_sessions set d_entry_native_root_claim=${tx.json(creation)} where id=${f.session}`;
        await tx`update allrice_chat_sessions set d_entry_native_root=${tx.json({ ...creation, nativeSessionId })} where id=${f.session}`;
        const { vmId, instanceId, leaseEpoch } = owner.binding;
        await tx`insert into person_virtual_machines
        (person_id,vm_id,organization_id,phase,disk_tier,native_created,instance_id,lease_epoch,egress_receipt)
        values (${f.user},${vmId},${f.org},'running','warm',true,${instanceId},${leaseEpoch},'{}')`;
        const pin = await readLockedDEntryNativeRootPin(tx, identity);
        if (!pin) throw Error('No original root pin');
        return pin;
      });
      const scopeId = randomUUID();
      const owned = owner.acquirePrincipal(
        {
          access: 'execute',
          scopeId,
          identity,
          root: {
            nativeSessionId,
            rootOriginDigest: nativePin.rootOriginDigest,
            rootBindingRef: nativePin.rootBindingRef,
          },
        },
        signal,
        context,
      );
      cleanup.push(() => owned.close());
      const scope = await owned.run(signal);
      expect(
        await scope.invoke(
          {
            endpoint: 'session/prompt',
            scopeId,
            args: Native.methods['session/prompt']
              .input({ strict: true })
              .create()
              .parse({
                request: {
                  sessionId: nativeSessionId,
                  requestId: nativePromptId,
                  content: [
                    { type: 'text', text: 'Run the isolated memory check.' },
                  ],
                  mode: 'queue',
                },
              }),
          },
          signal,
        ),
      ).toMatchObject({ value: { accepted: true } });
      await waitForPromptFact(
        Promise.race([results.promise, error.promise]),
        signal,
      );

      expect(new Set(receipts.values()).size).toBe(2);
      expect(delivered.get('memory_read')).toMatchObject({
        nativeRequestRef: receipts.get('memory_read'),
        value: expect.stringContaining(confirmed.details),
      });
      const remembered = delivered.get('memory_remember');
      const ref = remembered!.nativeRequestRef;
      expect(remembered).toMatchObject({
        nativeRequestRef: receipts.get('memory_remember'),
        value: {
          summary: candidate.summary,
          state: 'pending',
          requiresConfirmation: true,
        },
      });
      expect(await host.remember(context, ref, candidate, signal)).toEqual(
        remembered!.value,
      );
      await expect(
        host.readOrdinal(context, ref, { number: 1 }, signal),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        publication.call(
          context,
          { ...callbackInputs.get('memory_remember')!, callRef: 'forged' },
          signal,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        publication.call(
          { ...context, actor: { type: 'user', id: randomUUID() } },
          callbackInputs.get('memory_remember')!,
          signal,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        host.remember(context, randomUUID(), candidate, signal),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const candidates = await db<{ id: string; revision: number }[]>`
        select id,revision from allrice_memories where summary=${candidate.summary}`;
      expect(candidates).toHaveLength(1);
      const [pending] = candidates;
      const mutation = {
        instanceId: f.assignment,
        expectedRevision: pending!.revision,
        pairDigest: memoryPairDigest(candidate),
        idempotencyKey: randomUUID(),
      };
      const confirm = () =>
        promoteManagedEmployeeMemory(
          context,
          f.workspace,
          pending!.id,
          mutation,
        );
      const savedIndex = () => db`
        select state, document from allrice_employee_memory_contexts where budget_ref=${run.runId}`;
      const spent = await savedIndex();
      expect(spent).toEqual([
        {
          state: expect.objectContaining({ toolReads: 1 }),
          document: indexDocument,
        },
      ]);
      await db`update person_virtual_machines set phase='stopped' where vm_id=${owner.binding.vmId}`;
      if (!rootInput) throw Error('No original root input');
      await expect(
        publication.root(context, { ...rootInput, mode: 'restore' }, signal),
      ).resolves.toEqual({
        executionRef: run.runId,
        memoryIndexDocument: indexDocument,
      });
      expect(await savedIndex()).toEqual(spent);
      await expect(
        host.remember(context, ref, candidate, signal),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await db`update allrice_chat_sessions set archived_at=now() where id=${f.session}`;
      await expect(confirm()).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await db`update allrice_chat_sessions set archived_at=null where id=${f.session}`;
      await expect(confirm()).resolves.toMatchObject({ state: 'active' });
      await db`update allrice_sessions set revoked_at=now() where id=${login.id}`;
      await expect(
        host.remember(context, ref, candidate, signal),
      ).rejects.toThrow();
      await expect(
        publication.root(context, { ...rootInput, mode: 'restore' }, signal),
      ).rejects.toThrow();
    } catch (cause) {
      failures.push(cause);
    } finally {
      for (const dispose of [
        ...cleanup.reverse(),
        ...roots.map(
          (root) => () => rm(root, { recursive: true, force: true }),
        ),
        close,
      ]) {
        try {
          await dispose();
        } catch (cause) {
          failures.push(cause);
        }
      }
      seal.mockRestore();
      database.mockRestore();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'Native memory fixture failed');
  },
);
