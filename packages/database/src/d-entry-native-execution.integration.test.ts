import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as database from './core/client.ts';
import { DataAccessError } from './data.ts';
import { createDEntryAuthorityFeed } from './d-entry-authority.ts';
import * as rootPin from './d-entry-native-root.ts';
import {
  isDEntryNativeRunJournalCurrent,
  listDEntryNativeRunCandidates,
  nextRetainedDEntryNativeRunJournalOwner,
  publishDEntryNativeRunTerminal,
} from './d-entry-native-execution.ts';
import { getRun, getRunForRead, listRunEvents } from './execution/queue.ts';
import { authenticateSession, createSession } from './identity.ts';
import { ensureGeneralEmployeeInstance } from './employees/employee-instances.ts';
import { createRunAuthorityFixture } from './run-authority.fixture.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';

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

  it('observes committed thread authority changes before the fence despite restoration, without invalidating a title edit', async () => {
    const { db } = fixture;
    const f = await createRunAuthorityFixture(db, {
      configure: false,
      executionGeneration: '4.0',
    });
    const [namespace] = await db<
      { schema: string }[]
    >`select current_schema() as schema`;
    const feed = createDEntryAuthorityFeed(
      process.env.ALLRICE_TEST_DATABASE_URL!,
    );
    const abort = new AbortController();
    const changed = vi.fn();
    try {
      const unsubscribe = await feed.subscribe(
        {
          changed(change) {
            if (
              change.schema === namespace!.schema &&
              change.table === 'allrice_chat_sessions' &&
              change.id === f.session
            )
              changed();
          },
          lost: (error) => abort.abort(error),
        },
        abort.signal,
      );
      try {
        await db`update allrice_chat_sessions set title='Ordinary title edit' where id=${f.session}`;
        await feed.observeThroughCommit(
          AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
        );
        expect(changed).not.toHaveBeenCalled();
        await db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.session}`;
        await db`update allrice_chat_sessions set archived_at=null where id=${f.session}`;
        await feed.observeThroughCommit(
          AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
        );
        expect(changed).toHaveBeenCalledTimes(2);
      } finally {
        unsubscribe();
      }
    } finally {
      await feed.close();
    }
  });

  it('recovers an atomic failure through a new owner of the original retained VM and root', async () => {
    const { db } = fixture;
    const f = await createRunAuthorityFixture(db, {
      configure: false,
      executionGeneration: '4.0',
    });
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
      threadId: f.session,
      employeeInstanceId: f.assignment,
      employeeRelease: f.version,
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
    };
    const identity = {
      organizationId,
      workspaceId,
      personId,
      employeeInstanceId: prompt.employeeInstanceId,
      employeeRevision: 1,
      employeeVersionId: prompt.employeeRelease,
      threadId: prompt.threadId,
    };
    const originalCreation = {
      schemaVersion: 1,
      identity,
      host: {
        binding: {
          organizationId,
          personId,
          vmId: owner.vmId,
          instanceId: owner.vmInstanceId,
          leaseEpoch: owner.leaseEpoch,
        },
        bindingRef: randomUUID(),
        rosterDigest: 'sha256:' + 'a'.repeat(64),
      },
      operationId: randomUUID(),
      releaseRevision: 'native-run-fixture',
    };
    const readPin = vi
      .spyOn(rootPin, 'getDEntryNativeRootPin')
      .mockResolvedValue({
        vmId: prompt.vmId,
        rootNativeSessionId: rootSessionId,
        rootOriginDigest: 'sha256:' + 'a'.repeat(64),
        rootBindingRef: originalCreation.operationId,
        identity,
      });
    await db.begin(async (tx) => {
      await ensureGeneralEmployeeInstance(tx, f.assignment);
      await tx`update allrice_chat_sessions
        set d_entry_native_root_claim=${tx.json(originalCreation)} where id=${f.session}`;
      await tx`update allrice_chat_sessions
        set d_entry_native_root=${tx.json({ ...originalCreation, nativeSessionId: rootSessionId })}
        where id=${f.session}`;
      await tx`insert into person_virtual_machines
        (person_id,vm_id,organization_id,phase,disk_tier,native_created,instance_id,lease_epoch,egress_receipt)
        values (${personId},${owner.vmId},${organizationId},'running','warm',true,
          ${owner.vmInstanceId},${owner.leaseEpoch},'{}')`;
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
    expect(
      await isDEntryNativeRunJournalCurrent(candidate, owner, signal),
    ).toBe(true);
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
        publishDEntryNativeRunTerminal(candidate, terminal, signal, { owner }),
      ).rejects.toThrow('fixture missed terminal commit');
      expect(await getRunForRead(context, workspaceId, runId)).toMatchObject({
        status: 'running',
        completedAt: null,
      });
    } finally {
      await db`drop trigger refuse_native_terminal_fixture on allrice_run_events`;
    }

    const restarted = {
      ...owner,
      vmInstanceId: randomUUID(),
      leaseEpoch: owner.leaseEpoch + 1,
    };
    await db`update person_virtual_machines
      set instance_id=${restarted.vmInstanceId},lease_epoch=${restarted.leaseEpoch}
      where person_id=${personId}`;
    expect(
      await isDEntryNativeRunJournalCurrent(candidate, owner, signal),
    ).toBe(false);
    expect(
      (await listDEntryNativeRunCandidates(owner)).candidates,
    ).toHaveLength(0);
    expect(
      await isDEntryNativeRunJournalCurrent(candidate, restarted, signal),
    ).toBe(true);
    expect(
      await isDEntryNativeRunJournalCurrent(
        {
          ...candidate,
          attempt: { ...candidate.attempt, leaseEpoch: restarted.leaseEpoch },
        },
        restarted,
        signal,
      ),
    ).toBe(false);
    expect(
      await isDEntryNativeRunJournalCurrent(
        {
          ...candidate,
          attempt: {
            ...candidate.attempt,
            leaseEpoch: restarted.leaseEpoch + 1,
          },
        },
        restarted,
        signal,
      ),
    ).toBe(false);
    expect(
      await isDEntryNativeRunJournalCurrent(
        {
          ...candidate,
          prompt: { ...candidate.prompt, rootSessionId: 'another-root' },
        },
        restarted,
        signal,
      ),
    ).toBe(false);
    const [reread] = (await listDEntryNativeRunCandidates(restarted))
      .candidates;
    expect(reread).toEqual(candidate);
    expect(await nextRetainedDEntryNativeRunJournalOwner()).toEqual(restarted);
    const leaseOwner = randomUUID();
    await db`update person_virtual_machines
      set lease_owner=${leaseOwner},lease_expires_at=clock_timestamp()+interval '1 minute'
      where person_id=${personId}`;
    try {
      expect(
        await isDEntryNativeRunJournalCurrent(
          candidate,
          restarted,
          signal,
          leaseOwner,
        ),
      ).toBe(true);
      expect(
        await isDEntryNativeRunJournalCurrent(
          candidate,
          restarted,
          signal,
          randomUUID(),
        ),
      ).toBe(false);
      expect(
        await isDEntryNativeRunJournalCurrent(candidate, restarted, signal),
      ).toBe(false);
    } finally {
      await db`update person_virtual_machines
        set lease_owner=null,lease_expires_at=null where person_id=${personId}`;
    }
    // A stale positive Guest read cannot settle the Run after the actual
    // publication boundary has lost its employee binding.
    await db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
    try {
      await expect(
        publishDEntryNativeRunTerminal(candidate, terminal, signal, {
          owner: restarted,
        }),
      ).resolves.toBe(false);
    } finally {
      await db`update allrice_employee_assignments set active=true where id=${f.assignment}`;
    }
    // A successor authenticates with its own adapter. The birth provenance
    // remains the original payload on both the Run and the exact execution.
    expect(
      await publishDEntryNativeRunTerminal(
        {
          ...reread!,
          prompt: { ...reread!.prompt, adapterId: 'new-live-adapter' },
          attempt: {
            ...reread!.attempt,
            profile: 'new-live-adapter',
            nativeInstanceId: randomUUID(),
          },
        },
        terminal,
        signal,
        { owner: restarted },
      ),
    ).toBe(false);
    const racing = await Promise.all([
      publishDEntryNativeRunTerminal(reread!, terminal, signal, {
        owner: restarted,
      }),
      publishDEntryNativeRunTerminal(reread!, terminal, signal, {
        owner: restarted,
      }),
    ]);
    expect(racing.sort()).toEqual([false, true]);
    expect(
      (await listDEntryNativeRunCandidates(restarted)).candidates,
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
    await db`insert into allrice_run_events
      (organization_id,workspace_id,run_id,sequence,event_type,payload)
      values (${organizationId},${workspaceId},${runId},2,'harness.native',
        '{"source":"dsh-native-execution-evidence-v1","kind":"tool","human":"private-fact"}'::jsonb)`;
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
