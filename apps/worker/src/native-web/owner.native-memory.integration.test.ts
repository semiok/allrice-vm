import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ModelCallBinding } from '@allrice/model-gateway';
import { TYPERT_REMOTE as Native } from '@deepseek-ai/dsh-api-session-controller/remote';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as client from '../../../../packages/database/src/core/client.ts';
import { readLockedDEntryNativeRootPin } from '../../../../packages/database/src/d-entry-native-root.ts';
import { dEntryReleasePolicyKey } from '../../../../packages/database/src/d-entry-release-policy.ts';
import { createNativeEmployeeMemoryHost } from '../../../../packages/database/src/employee-memory-runtime.ts';
import {
  changeEmployeeInstanceLifecycle,
  createEmployeeInstance,
  ensureGeneralEmployeeInstance,
} from '../../../../packages/database/src/employees/employee-instances.ts';
import {
  authenticateSession,
  createSession,
} from '../../../../packages/database/src/identity.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import * as buildIdentity from '../../../../packages/database/src/service-build-identity.ts';
import { insertEmployeeMemoryPair } from '../../../../packages/database/src/workspace/employee-memory-mutation.ts';
import { memoryPairDigest } from '../../../../packages/database/src/workspace/employee-memory-primitives.ts';
import {
  createChatSession,
  promoteManagedEmployeeMemory,
} from '../../../../packages/database/src/workspace/service.ts';
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
  createProductionNativeMemorySource,
  executeProductionNativeMemoryTool,
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
    args: { number: 1 },
  },
  {
    id: 'memory_remember',
    args: candidate,
  },
] as const;
const build = {
  sourceSha: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  manifestDigest: 'sha256:' + 'c'.repeat(64),
  webBuildId: 'isolated-memory-build',
};

it.skipIf(
  !cli ||
    process.env.NATIVE_MEMORY_POSTGRES !== '1' ||
    process.env.ALLRICE_RUN_DB_INTEGRATION !== '1',
)(
  'commits both sealed rc.2 tool occurrences before native memory execution and denies revoked or mismatched evidence',
  { tags: ['manual:NATIVE_MEMORY_POSTGRES'], timeout: 45_000 },
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
      const authenticated = await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!authenticated) throw Error('Isolated owner did not authenticate');
      const context = authenticated;
      // Create two independent employee records before opting the existing
      // member into 4.0, which restricts new employee creation.
      const employee = await createEmployeeInstance(context, {
        workspaceId: f.workspace,
        assignmentId: f.assignment,
        requestId: randomUUID(),
        profile: { name: 'Original memory employee' },
      });
      const peer = {
        employee: randomUUID(),
        assignment: randomUUID(),
        version: randomUUID(),
      };
      await db.begin(async (tx) => {
        await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
          values(${peer.employee},${f.org},${f.workspace},'memory-scope-peer','Peer employee')`;
        await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
          select ${peer.version},organization_id,workspace_id,${peer.employee},version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot
          from allrice_employee_versions where id=${f.version}`;
        await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id,is_default)
          values(${peer.assignment},${f.org},${f.workspace},${peer.employee},${peer.version},${f.user},false)`;
        await ensureGeneralEmployeeInstance(tx, peer.assignment);
      });
      const primary = await createChatSession(
        context,
        {
          workspaceId: f.workspace,
          employeeInstanceId: employee.id,
          title: 'Original native memory thread',
        },
        { executionGeneration: '4.0' },
      );
      const identity = {
        organizationId: f.org,
        workspaceId: f.workspace,
        personId: f.user,
        employeeInstanceId: employee.id,
        employeeRevision: employee.revision,
        employeeVersionId: f.version,
        threadId: primary.id,
      };
      const target = (nativeRequestRef: string) => ({
        workspaceId: f.workspace,
        employeeInstanceId: employee.id,
        threadId: primary.id,
        nativeRequestRef,
      });
      await db.begin(async (tx) => {
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
            instanceId: employee.id,
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
      const selected = selectNativeMemoryConfiguration(
        createProductionNativeMemorySource(),
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
      const delivered = new Map<string, { id: string; value: unknown }>();
      const rememberCallId = randomUUID();
      const retryCallId = randomUUID();
      const callbackInputs = new Map<
        string,
        Parameters<MemoryHostPublication['call']>[1]
      >();
      const attempts = new Map<
        string,
        NonNullable<Awaited<ReturnType<typeof recordNativeExecutionRequest>>>
      >();
      let rootInput: MemoryRootObservation | undefined;
      let indexDocument: string | undefined;
      let assistantCalls = 0;

      async function sealRequest() {
        const first = attempts.size === 0;
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
        expect(observation.firstMemoryAttempt).toBe(first);
        expect(observation.memoryToolVersions).toEqual(selected.toolVersions);
        const vm = owner.binding;
        const step: ModelCallBinding = {
          execution: { runId: run.runId, executionId: randomUUID() },
          context,
          vm,
          employeeInstanceId: employee.id,
          employeeRelease: f.version,
          allriceThreadRef: primary.id,
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
        const receipt = await db.begin(async (tx) => {
          const executionSpec = {
            source: 'dsh-native-prompt',
            generation: '4.0',
            loginSessionId: login.id,
            threadId: primary.id,
            employeeInstanceId: employee.id,
            employeeRelease: f.version,
            nativeRequestId: nativePromptId,
            rootSessionId: nativeSessionId,
            adapterId: step.native.profile,
            vmId: vm.vmId,
            personId: f.user,
          };
          if (first)
            await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec)
                values (${run.runId},${f.org},${f.workspace},${f.user},'running',${tx.json(executionSpec)})`;
          await tx`select id from allrice_runs where id=${run.runId} for update`;
          await tx`insert into allrice_run_events(id,run_id,organization_id,workspace_id,sequence,event_type,payload)
          values (${step.execution.executionId},${run.runId},${f.org},${f.workspace},
            (select coalesce(max(sequence),-1)+1 from allrice_run_events where run_id=${run.runId}),
            'step.started',${tx.json({
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
            })})`;
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
              employeeInstanceId: employee.id,
              employeeRelease: f.version,
              employeeRevision: identity.employeeRevision,
              threadId: primary.id,
              vm,
            },
            native.promptIds,
            false,
          );
        });
        if (!receipt) throw Error('Workflow evidence was not committed');
        expect(receipt.firstIssue).toBe(first);
        attempts.set(native.id, receipt);
        if (!first) {
          if (!rootInput) throw Error('No original root input');
          await expect(
            publication.root(
              context,
              { ...rootInput, mode: 'restore' },
              signal,
            ),
          ).resolves.toEqual({
            executionRef: run.runId,
            memoryIndexDocument: indexDocument,
          });
          return;
        }
        rootInput = {
          mode: 'issue',
          nativeRequestRef: step.execution.executionId,
          runId: run.runId,
          workspaceId: f.workspace,
          employeeInstanceId: employee.id,
          threadId: primary.id,
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
        const [route] = await db<
          { connectionId: string; slot: 1 | 2; revision: string }[]
        >`
          select c.id as "connectionId",s.slot,extract(epoch from s.updated_at)::text
          as revision from allrice_model_connections c
          join allrice_model_providers p on p.id=c.provider_id
          cross join allrice_codex_subscriptions s
          where p.provider_key='codex' and c.credential_reference='deployment:codex-default'
            and c.scope='platform' and c.status='ready' and s.enabled`;
        if (!route) throw Error('Missing isolated ready Codex route');
        const dispatch = vi.fn();
        const send = () =>
          host.dispatchRoot(context, restore, signal, route, dispatch);
        await send();
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(issued);
        dispatch.mockClear();
        const held = deferredPromptFact<number>();
        const release = deferredPromptFact<void>();
        const blocker = db.begin(async (tx) => {
          await tx`select id from allrice_employee_memory_contexts where budget_ref=${run.runId} for update`;
          const [connection] = await tx<
            { pid: number }[]
          >`select pg_backend_pid() as pid`;
          held.resolve(connection!.pid);
          await release.promise;
        });
        try {
          const pid = await held.promise;
          const sending = send();
          const rejected = expect(sending).rejects.toMatchObject({
            code: 'authorization_denied',
          });
          try {
            await vi.waitFor(
              async () => {
                const [row] = await db<{ waiting: boolean }[]>`
                select exists(select 1 from pg_stat_activity a where a.pid <> ${pid}
                and ${pid}=any(pg_blocking_pids(a.pid))) as waiting`;
                expect(row?.waiting).toBe(true);
              },
              { timeout: 5_000 },
            );
            await db`update allrice_model_connections set status='disabled' where id=${route.connectionId}`;
          } finally {
            release.resolve();
            await rejected;
          }
          expect(dispatch).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await blocker;
          await db`update allrice_model_connections set status='ready' where id=${route.connectionId}`;
        }
        await send();
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(issued);
      }

      async function commitWithoutDelivery(ref: string, input: unknown) {
        const abort = new AbortController();
        const canceled = Error('Canceled after the real candidate commit');
        const createDedicated = client.createDedicatedDatabase;
        vi.spyOn(client, 'createDedicatedDatabase').mockImplementationOnce(
          (db) => {
            const dedicated = createDedicated(db);
            return new Proxy(dedicated, {
              get(handle, key, receiver) {
                if (key !== 'reserve')
                  return Reflect.get(handle, key, receiver);
                return async () => {
                  const session = await dedicated.reserve();
                  return new Proxy(session, {
                    apply(handle, receiver, args) {
                      const query: unknown = Reflect.apply(
                        handle,
                        receiver,
                        args,
                      );
                      if (!(
                        Array.isArray(args[0]) &&
                        args[0].join('').trim() === 'commit'
                      ))
                        return query;
                      return Promise.resolve(query).then(() =>
                        abort.abort(canceled),
                      );
                    },
                  });
                };
              },
            });
          },
        );
        await expect(
          host.remember(context, target(ref), input, abort.signal),
        ).rejects.toMatchObject({
          name: 'EmployeeMemoryWriteOutcomeUnknown',
          cause: canceled,
        });
      }

      const server = createServer((request, response) => {
        void (async () => {
          if (request.headers.authorization !== 'Bearer ' + capability)
            throw Error('Fixture capability mismatch');
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          if (
            request.url === '/v1/reference' ||
            request.url === '/v1/reference/session-title'
          ) {
            const title = request.url.endsWith('/session-title');
            if (!title && assistantCalls < 2) await sealRequest();
            if (!title && assistantCalls === 2) {
              const attempt = await owner.readNativeAttemptFor(
                context,
                { kind: 'session', sessionId: nativeSessionId },
                signal,
              );
              expect(attempt?.observation?.proofState).toBe('adopted');
            }
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
          if (!title) assistantCalls++;
          if (!title && assistantCalls === 3) {
            const modelInput = Buffer.concat(chunks).toString('utf8');
            expect(modelInput).toContain(confirmed.details);
            expect(modelInput).toContain(
              'Memory candidate outcome is unconfirmed. Do not retry.',
            );
          }
          if (!title && assistantCalls === 4) {
            const modelInput = Buffer.concat(chunks).toString('utf8');
            expect(modelInput).toContain(retryCallId);
            expect(
              modelInput.match(
                /Memory candidate outcome is unconfirmed\. Do not retry\./g,
              )?.length,
            ).toBeGreaterThanOrEqual(2);
            results.resolve();
          }
          const called =
            title || assistantCalls > 3
              ? []
              : assistantCalls === 1
                ? tools
                : tools.filter(({ id }) => id === 'memory_remember');
          const deltas = called.length
            ? called.map(({ id, args }, index) => ({
                type: 'tool-call-delta',
                index,
                id:
                  id === 'memory_remember'
                    ? assistantCalls === 3
                      ? retryCallId
                      : rememberCallId
                    : randomUUID(),
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
                  type: 'usage',
                  usage: {
                    inputTokens: 15,
                    outputTokens: 5,
                    cacheReadTokens: 0,
                    totalTokens: 20,
                  },
                },
                {
                  type: 'finish',
                  reason: { kind: called.length ? 'tool-calls' : 'stop' },
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
      const owner = (
        await setupNativeWebFixture(
          cli,
          roots,
          cleanup,
          undefined,
          {
            identity,
            loginSessionId: login.id,
            nativeMemoryEnabled: true,
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
              async (fact, active, args) => {
                try {
                  const receipt = attempts.get(fact.attemptId);
                  if (!receipt)
                    throw Error('Missing committed attempt receipt');
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
                  callbackInputs.set(ref, input);
                  const { nativeRequestRef } = await publication.call(
                    context,
                    input,
                    active,
                  );
                  if (nativeRequestRef !== ref || !args)
                    throw Error(
                      'The sealed production tool did not send its own arguments',
                    );
                  const unknownWrite =
                    toolId === 'memory_remember' && attempts.size === 2;
                  const toolActions = unknownWrite
                    ? {
                        ...host,
                        async remember() {
                          await commitWithoutDelivery(ref, args.value);
                          throw Error('Candidate result was lost after commit');
                        },
                      }
                    : host;
                  const result = await executeProductionNativeMemoryTool(
                    toolActions,
                    toolId,
                    context,
                    target(ref),
                    args.value,
                    active,
                  );
                  delivered.set(ref, {
                    id: toolId,
                    value: unknownWrite
                      ? null
                      : toolId === 'memory_read'
                        ? result.text
                        : JSON.parse(result.text),
                  });
                  if (unknownWrite) {
                    expect(result.outcome).toBe('unknown');
                    // The database commit happened, but the private response
                    // carries no authoritative result to the waiting tool.
                    return null;
                  }
                  return result;
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
      const { vmId, instanceId, leaseEpoch } = owner.binding;
      await db`insert into person_virtual_machines
        (person_id,vm_id,organization_id,phase,disk_tier,native_created,instance_id,lease_epoch,egress_receipt)
        values (${f.user},${vmId},${f.org},'running','warm',true,${instanceId},${leaseEpoch},'{}')`;
      const pinRoot = (threadId: string, root: string, member = identity) =>
        db.begin(async (tx) => {
          const selected = { ...member, threadId };
          const creation = {
            schemaVersion: 1,
            identity: selected,
            host: {
              binding: owner.binding,
              bindingRef: randomUUID(),
              rosterDigest: 'fixture',
            },
            operationId: randomUUID(),
            releaseRevision: 'fixture',
          };
          await tx`update allrice_chat_sessions set d_entry_native_root_claim=${tx.json(creation)} where id=${threadId}`;
          await tx`update allrice_chat_sessions set d_entry_native_root=${tx.json({ ...creation, nativeSessionId: root })} where id=${threadId}`;
          const pin = await readLockedDEntryNativeRootPin(tx, selected);
          if (!pin) throw Error('No original root pin');
          return pin;
        });
      const nativePin = await pinRoot(primary.id, nativeSessionId);
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

      expect(callbackInputs.size).toBe(3);
      expect(attempts.size).toBe(2);
      const invoked = [...delivered.entries()];
      const read = invoked.find(([, call]) => call.id === 'memory_read');
      if (!read) throw Error('The original memory read did not run');
      const [readRef, readResult] = read;
      expect(readResult.value).toEqual(
        expect.stringContaining(confirmed.details),
      );
      const writes = invoked.filter(
        ([, call]) => call.id === 'memory_remember',
      );
      expect(writes).toHaveLength(2);
      const [ref, remembered] = writes[0]!;
      const [otherRef, otherRemembered] = writes[1]!;
      expect(callbackInputs.get(ref)?.callRef).toBe(rememberCallId);
      expect(callbackInputs.get(otherRef)?.callRef).toBe(rememberCallId);
      const receiptShape = {
        summary: candidate.summary,
        state: 'pending',
        requiresConfirmation: true,
      };
      expect(remembered.value).toMatchObject(receiptShape);
      expect(otherRemembered.value).toBeNull();
      expect(
        await host.remember(context, target(ref), candidate, signal),
      ).toEqual(remembered.value);
      await expect(
        host.readOrdinal(context, target(ref), { number: 1 }, signal),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        publication.call(
          context,
          { ...callbackInputs.get(ref)!, callRef: 'forged' },
          signal,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        publication.call(
          { ...context, actor: { type: 'user', id: randomUUID() } },
          callbackInputs.get(ref)!,
          signal,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        host.remember(context, target(randomUUID()), candidate, signal),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const other = await createChatSession(
        context,
        {
          workspaceId: f.workspace,
          employeeInstanceId: employee.id,
          title: 'Same owner, different caller scope',
        },
        { executionGeneration: '4.0' },
      );
      const alternateRoot = await owner.createRootFor(context, {}, signal);
      if (!alternateRoot.ok)
        throw Error('Alternate native root was not created');
      await pinRoot(other.id, alternateRoot.value.sessionId);
      await expect(
        host.remember(
          context,
          { ...target(ref), threadId: other.id },
          candidate,
          signal,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const peerThread = await createChatSession(
        context,
        {
          workspaceId: f.workspace,
          employeeInstanceId: peer.assignment,
          title: 'Different employee for the same owner',
        },
        { executionGeneration: '4.0' },
      );
      const peerRoot = await owner.createRootFor(context, {}, signal);
      if (!peerRoot.ok) throw Error('Peer native root was not created');
      await pinRoot(peerThread.id, peerRoot.value.sessionId, {
        ...identity,
        employeeInstanceId: peer.assignment,
        employeeRevision: 1,
        employeeVersionId: peer.version,
        threadId: peerThread.id,
      });
      const peerTarget = {
        ...target(ref),
        employeeInstanceId: peer.assignment,
        threadId: peerThread.id,
      };
      await expect(
        host.remember(context, peerTarget, candidate, signal),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        host.reconcileRemember(
          context,
          { ...peerTarget, b: run.runId },
          signal,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        host.readOrdinal(
          context,
          { ...peerTarget, nativeRequestRef: readRef },
          { number: 1 },
          signal,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const candidates = await db<
        { id: string; revision: number; call_ref: string }[]
      >`
        select id,revision,metadata#>>'{allriceEmployeeMemoryV4,nativeCall,callRef}' as call_ref
        from allrice_memories where summary=${candidate.summary}`;
      expect(candidates).toHaveLength(2);
      expect(new Set(candidates.map(({ call_ref }) => call_ref))).toEqual(
        new Set([ref, otherRef]),
      );
      const pending = candidates.find(({ call_ref }) => call_ref === ref);
      expect(pending?.call_ref).toBe(ref);
      expect(pending?.call_ref).not.toBe(callbackInputs.get(ref)?.callRef);
      const mutation = {
        instanceId: employee.id,
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
      await db`update allrice_runs set state='succeeded' where id=${run.runId}`;
      await expect(
        host.remember(context, target(ref), candidate, signal),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        host.readOrdinal(context, target(readRef), { number: 1 }, signal),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      if (!rootInput) throw Error('No original root input');
      const restore = { ...rootInput, mode: 'restore' as const };
      await expect(publication.root(context, restore, signal)).resolves.toEqual(
        {
          executionRef: run.runId,
          memoryIndexDocument: indexDocument,
        },
      );
      expect(await savedIndex()).toEqual(spent);
      await db`update person_virtual_machines set phase='stopped' where vm_id=${owner.binding.vmId}`;
      await expect(
        publication.root(context, { ...rootInput, mode: 'restore' }, signal),
      ).resolves.toEqual({
        executionRef: run.runId,
        memoryIndexDocument: indexDocument,
      });
      expect(await savedIndex()).toEqual(spent);
      await expect(
        host.remember(context, target(ref), candidate, signal),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const reconcile = () =>
        host.reconcileRemember(
          context,
          { ...target(ref), b: run.runId },
          signal,
        );
      await expect(reconcile()).resolves.toMatchObject({
        id: pending?.id,
        status: 'recorded',
        state: 'pending',
        originalReceiptCurrent: true,
      });
      await expect(
        host.reconcileRemember(
          context,
          { ...target(otherRef), b: run.runId },
          signal,
        ),
      ).resolves.toMatchObject({
        id: candidates.find(({ call_ref }) => call_ref === otherRef)?.id,
        status: 'recorded',
        state: 'pending',
        originalReceiptCurrent: true,
      });
      await expect(
        host.reconcileRemember(
          context,
          { ...target(ref), b: randomUUID() },
          signal,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await db`update allrice_chat_sessions set archived_at=now() where id=${primary.id}`;
      await expect(reconcile()).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await expect(confirm()).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await db`update allrice_chat_sessions set archived_at=null where id=${primary.id}`;
      await expect(confirm()).resolves.toMatchObject({ state: 'active' });
      await db`update allrice_sessions set revoked_at=now() where id=${login.id}`;
      await expect(
        host.remember(context, target(ref), candidate, signal),
      ).rejects.toThrow();
      await expect(
        publication.root(context, restore, signal),
      ).rejects.toThrow();
      const newLogin = await createSession(f.user);
      const current = await authenticateSession(newLogin.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!current) throw Error('Current login was not authenticated');
      await expect(
        host.reconcileRemember(
          current,
          { ...target(otherRef), b: run.runId },
          signal,
        ),
      ).resolves.toMatchObject({ status: 'recorded', state: 'pending' });
      await expect(
        changeEmployeeInstanceLifecycle(current, employee.id, {
          workspaceId: f.workspace,
          requestId: randomUUID(),
          expectedRevision: employee.revision,
          operation: 'archive',
        }),
      ).resolves.toMatchObject({ archivedAt: expect.any(String) });
      await expect(
        publication.root(current, restore, signal),
      ).rejects.toMatchObject({
        code: 'instance_archived',
      });
      await expect(
        host.readOrdinal(current, target(readRef), { number: 1 }, signal),
      ).rejects.toMatchObject({ code: 'instance_archived' });
      await expect(
        host.reconcileRemember(
          current,
          { ...target(otherRef), b: run.runId },
          signal,
        ),
      ).rejects.toMatchObject({ code: 'instance_archived' });
      expect(await savedIndex()).toEqual(spent);
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
