import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as database from './core/client.ts';
import { DataAccessError } from './data.ts';
import * as rootPin from './d-entry-native-root.ts';
import {
  listDEntryNativeRunCandidates,
  publishDEntryNativeRunTerminal,
} from './d-entry-native-execution.ts';
import { getRun, getRunForRead, listRunEvents } from './execution/queue.ts';
import { authenticateSession, createSession } from './identity.ts';
import { createRuntimeFixtureDatabase, runFixture } from './runtime.fixture.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

suite('4.0 native Run audit projection with real PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;

  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(database, 'getDatabase').mockReturnValue(fixture.db);
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await fixture?.close();
  });

  it('retries an atomic failed projection and replays the same scoped Run and execution IDs', async () => {
    const { db } = fixture;
    const f = await runFixture(db);
    const { organizationId, workspaceId } = f.task.scope;
    const personId = f.context.actor.id;
    const login = await createSession(personId);
    const context = (await authenticateSession(login.token, {
      organizationId,
      workspaceId,
    }))!;
    const rootSessionId = 'session-' + randomUUID();
    const runId = randomUUID();
    const executionId = randomUUID();
    const prompt = {
      generation: '4.0',
      source: 'dsh-native-prompt',
      threadId: randomUUID(),
      employeeInstanceId: randomUUID(),
      employeeRelease: randomUUID(),
      personId,
      vmId: randomUUID(),
      rootSessionId,
      adapterId: 'native-adapter',
      loginSessionId: context.sessionId,
      nativeRequestId: randomUUID(),
    };
    const attempt = {
      source: 'dsh-native-attempt',
      profile: prompt.adapterId,
      sessionId: rootSessionId,
      parentSessionId: null,
      nativeInstanceId: randomUUID(),
      vmInstanceId: randomUUID(),
      leaseEpoch: 3,
      attemptId: rootSessionId + ':1',
      kind: 'assistant',
      cursor: 11,
      turn: 1,
      contributingRequestIds: [prompt.nativeRequestId],
    };
    const owner = {
      organizationId,
      workspaceId,
      personId,
      vmId: prompt.vmId,
      vmInstanceId: attempt.vmInstanceId,
      leaseEpoch: attempt.leaseEpoch,
      employeeInstanceId: prompt.employeeInstanceId,
      employeeRelease: prompt.employeeRelease,
      adapterId: prompt.adapterId,
      nativeInstanceId: attempt.nativeInstanceId,
    };
    const readPin = vi
      .spyOn(rootPin, 'getDEntryNativeRootPin')
      .mockResolvedValue({
        vmId: prompt.vmId,
        rootNativeSessionId: rootSessionId,
        rootOriginDigest: 'sha256:' + 'a'.repeat(64),
        rootBindingRef: randomUUID(),
        identity: {
          organizationId,
          workspaceId,
          personId,
          employeeInstanceId: prompt.employeeInstanceId,
          employeeRevision: 1,
          employeeVersionId: prompt.employeeRelease,
          threadId: prompt.threadId,
        },
      });
    await db.begin(async (tx) => {
      await tx`insert into allrice_runs
        (id,organization_id,workspace_id,owner_id,state,execution_spec,started_at)
        values (${runId},${organizationId},${workspaceId},${personId},'running',${tx.json(prompt)},clock_timestamp())`;
      await tx`insert into allrice_run_events
        (id,organization_id,workspace_id,run_id,sequence,event_type,payload)
        values (${executionId},${organizationId},${workspaceId},${runId},0,'step.started',${tx.json(attempt)})`;
    });
    expect(
      (
        await listDEntryNativeRunCandidates({
          ...owner,
          vmInstanceId: randomUUID(),
        })
      ).candidates,
    ).toHaveLength(0);
    const scan = await listDEntryNativeRunCandidates(owner);
    expect(scan.candidates).toHaveLength(1);
    const candidate = scan.candidates[0]!;
    expect(candidate).toMatchObject({ runId, executionId, prompt, attempt });
    const terminal = {
      sessionId: rootSessionId,
      turn: 1,
      sequence: 23,
      reason: 'completed' as const,
      occurredAt: new Date().toISOString(),
    };
    const signal = new AbortController().signal;
    await db.unsafe(`
      create function refuse_native_terminal_fixture() returns trigger
      language plpgsql as $$
      begin
        if new.payload->>'source'='dsh-native-turn-end' then
          raise exception 'fixture missed terminal commit';
        end if;
        return new;
      end $$;
      create trigger refuse_native_terminal_fixture before insert on allrice_run_events
      for each row execute procedure refuse_native_terminal_fixture();
    `);
    try {
      await expect(
        publishDEntryNativeRunTerminal(candidate, terminal, signal),
      ).rejects.toThrow('fixture missed terminal commit');
      expect(await getRunForRead(context, workspaceId, runId)).toMatchObject({
        status: 'running',
        completedAt: null,
      });
    } finally {
      await db`drop trigger refuse_native_terminal_fixture on allrice_run_events`;
    }

    const reread = (await listDEntryNativeRunCandidates(owner)).candidates[0]!;
    const racing = await Promise.all([
      publishDEntryNativeRunTerminal(reread, terminal, signal),
      publishDEntryNativeRunTerminal(reread, terminal, signal),
    ]);
    expect(racing.sort()).toEqual([false, true]);
    expect(
      (await listDEntryNativeRunCandidates(owner)).candidates,
    ).toHaveLength(0);

    const persisted = await getRunForRead(context, workspaceId, runId);
    expect(persisted).toMatchObject({
      generation: '4.0',
      id: runId,
      organizationId,
      workspaceId,
      ownerId: personId,
      threadId: prompt.threadId,
      employeeRelease: prompt.employeeRelease,
      status: 'succeeded',
      completedAt: terminal.occurredAt,
    });
    expect(persisted).not.toHaveProperty('job');
    const events = await listRunEvents(context, workspaceId, runId);
    expect(events).toMatchObject([
      { eventId: executionId, runId, type: 'step.started', sequence: 0 },
      {
        runId,
        type: 'run.succeeded',
        sequence: 1,
        occurredAt: terminal.occurredAt,
        payload: { executionId, nativeSequence: 23, reason: 'completed' },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(prompt.adapterId);
    expect(await listRunEvents(context, workspaceId, runId, 0)).toEqual([
      events[1],
    ]);
    readPin.mockRejectedValueOnce(new DataAccessError('authorization_denied'));
    await expect(
      listRunEvents(context, workspaceId, runId),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(
      await db`select id from allrice_jobs where run_id=${runId}`,
    ).toHaveLength(0);
    await expect(getRun(context, workspaceId, runId)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await getRunForRead(context, workspaceId, f.task.runId)).toEqual(
      await getRun(context, workspaceId, f.task.runId),
    );

    const peer = randomUUID();
    await db`insert into allrice_users(id,email,display_name,password_hash)
      values (${peer},${peer + '@example.test'},'Same workspace peer','not-login')`;
    await db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
      values (${organizationId},${workspaceId},${peer},'admin')`;
    const peerLogin = await createSession(peer);
    const peerContext = (await authenticateSession(peerLogin.token, {
      organizationId,
      workspaceId,
    }))!;
    await expect(
      getRunForRead(peerContext, workspaceId, runId),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      listRunEvents(peerContext, workspaceId, runId),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
