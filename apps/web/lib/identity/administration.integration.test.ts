import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  getDEntryPersonRollout,
  readDEntryReleasePolicy,
  revokeSession,
  updateDEntryPersonRollout,
} from '@allrice/database';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { tenantValidationFixture } from '../../../../packages/database/src/tenant-validation.fixture.ts';
import { authorizeFixturePlatformAdministrator } from '../../../../packages/database/src/platform-authority.fixture.ts';
import { GET as runtimeDetails } from '../../app/api/v1/admin/runtime-console/[sessionId]/events/route';
import { GET as activity } from '../../app/api/v1/admin/activity/route';
import { GET as deliverables } from '../../app/api/v1/admin/organizations/[organizationId]/deliverables/route';
import { GET as validation } from '../../app/api/v1/admin/tenants/[organizationId]/validation/route';
import { GET as vmSummary } from '../../app/api/v1/admin/person-vms/[personId]/route';
import {
  GET as rollout,
  PUT as change,
} from '../../app/api/v1/admin/d-entry-release-policy/person/route';
import {
  GET as bulkRollout,
  PUT as replaceRollout,
} from '../../app/api/v1/admin/d-entry-release-policy/route';
import { projectRuntimeTimelineEvents } from '../../app/runtime-console/runtime-timeline';

const cookie = vi.hoisted(() => ({ token: '' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'allrice_session' && cookie.token
        ? { value: cookie.token }
        : undefined,
  }),
}));

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

integration('MET-288 live administration HTTP contract', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let tenant: Awaited<ReturnType<typeof tenantValidationFixture>>;
  let foreign: typeof tenant;
  let operator: Awaited<ReturnType<typeof account>>;
  let manager: Awaited<ReturnType<typeof account>>;
  let member: Awaited<ReturnType<typeof createSession>>;
  const vmId = randomUUID();
  const origin = 'https://allrice.test';
  const api = origin + '/api/v1/admin';
  const selected = () => ({
    organizationId: tenant.target.organizationId,
    personId: tenant.target.subjectId,
  });
  const foreignTarget = () => ({
    organizationId: foreign.target.organizationId,
    personId: foreign.target.subjectId,
  });

  async function account() {
    const name = `admin-test-${randomUUID()}`;
    const principal = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug: name,
        organizationName: name,
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: `${name}@example.test`,
        displayName: name,
        role: 'member',
      },
      fixture.db,
    );
    const login = await createSession(principal.user.id);
    return { id: principal.user.id, token: login.token };
  }
  function request(path: string, token: string, organizationId?: string) {
    cookie.token = token;
    return new Request(api + path, {
      headers:
        organizationId && token !== operator.token
          ? { 'x-allrice-organization-id': organizationId }
          : undefined,
    });
  }
  function rolloutRead(
    token: string,
    target = selected(),
    loginOrganization = target.organizationId,
  ) {
    return rollout(
      request(
        '/d-entry-release-policy/person?' + new URLSearchParams(target),
        token,
        loginOrganization,
      ),
    );
  }
  function rolloutWrite(token: string, body: unknown, writeOrigin = origin) {
    cookie.token = token;
    return change(
      new Request(api + '/d-entry-release-policy/person', {
        method: 'PUT',
        headers: { origin: writeOrigin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }
  function vmRead(
    token: string,
    target = selected(),
    loginOrganization = target.organizationId,
  ) {
    return vmSummary(
      request(
        '/person-vms/' +
          target.personId +
          '?organizationId=' +
          target.organizationId,
        token,
        loginOrganization,
      ),
      {
        params: Promise.resolve({ personId: target.personId }),
      },
    );
  }
  function eventsRead(
    token: string,
    sessionId: string,
    targetOrg: string,
    loginOrganization = targetOrg,
  ) {
    return runtimeDetails(
      request(
        '/runtime-console/' + sessionId + '/events?organizationId=' + targetOrg,
        token,
        loginOrganization,
      ),
      {
        params: Promise.resolve({ sessionId }),
      },
    );
  }
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '0');
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    tenant = await tenantValidationFixture(fixture.db);
    foreign = await tenantValidationFixture(fixture.db);
    operator = await account();
    manager = await account();
    member = await createSession(tenant.target.subjectId);
    await authorizeFixturePlatformAdministrator(fixture.db, operator.id);
    await fixture.db`insert into allrice_memberships(organization_id,user_id,role)
      values(${tenant.target.organizationId},${manager.id},'admin')`;
    await fixture.db`insert into person_virtual_machines(person_id,organization_id,vm_id,phase,disk_tier,gateway_ports,holds)
      values(${tenant.target.subjectId},${tenant.target.organizationId},${vmId},'stopped','warm','[44001,44002]','["PRIVATE_HOLD"]')`;
  }, 120_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fixture) await fixture.close();
  });

  it('scopes the read matrix to current platform authority and projects only VM summary fields', async () => {
    const ok = await vmRead(operator.token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(await ok.json()).toEqual({
      ...selected(),
      vmId,
      phase: 'stopped',
      diskTier: 'warm',
      diskRetained: true,
      leaseEpoch: '0',
      gatewayPortCount: 2,
      stoppedAt: null,
      recordedAt: expect.any(String),
      source: 'recorded_vm_state',
    });
    expect((await vmRead('', selected())).status).toBe(401);
    expect((await vmRead(member.token)).status).toBe(403);
    expect((await vmRead(manager.token)).status).toBe(403);
    expect(
      (await vmRead(manager.token, foreignTarget(), selected().organizationId))
        .status,
    ).toBe(403);
    expect(
      (
        await vmRead(operator.token, {
          ...selected(),
          personId: foreignTarget().personId,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await vmRead(operator.token, {
          ...foreignTarget(),
          personId: selected().personId,
        })
      ).status,
    ).toBe(404);
    expect((await vmRead(manager.token, foreignTarget())).status).toBe(403);
    expect((await rolloutRead(manager.token)).status).toBe(403);
  });

  it('never promotes VM ownership, delegated actors or a workspace-only admin', async () => {
    const genuine = (await authenticateSession(member.token, {
      organizationId: selected().organizationId,
    }))!;
    const guest = {
      ...genuine,
      actor: { type: 'worker' as const, id: operator.id },
    };
    await expect(
      getDEntryPersonRollout(guest, selected()),
    ).rejects.toMatchObject({ code: 'authentication_required' });
    await expect(
      updateDEntryPersonRollout(guest, {
        ...selected(),
        enabled: true,
        expectedRevision: 'unpublished',
      }),
    ).rejects.toMatchObject({ code: 'authentication_required' });
    await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
      values(${selected().organizationId},${tenant.target.workspaceId},${selected().personId},'admin')
      on conflict(organization_id,workspace_id,user_id) do update set role='admin'`;
    expect((await vmRead(member.token)).status).toBe(403);
    expect((await rolloutRead(member.token)).status).toBe(403);
  });

  it('publishes one pair and returns the exact committed audit receipt; denies stale and invalid changes', async () => {
    const org = selected().organizationId;
    const input = {
      ...selected(),
      enabled: true,
      expectedRevision: 'unpublished',
    };
    expect(await (await rolloutRead(operator.token)).json()).toEqual({
      ...selected(),
      enabled: false,
      revision: 'unpublished',
    });
    expect((await rolloutWrite(manager.token, input)).status).toBe(403);
    expect(
      (await rolloutWrite(operator.token, input, 'https://different.test'))
        .status,
    ).toBe(403);
    expect(
      (
        await rolloutWrite(operator.token, {
          ...input,
          personId: foreignTarget().personId,
        })
      ).status,
    ).toBe(404);
    expect(
      (await rolloutRead(manager.token, foreignTarget(), org)).status,
    ).toBe(403);
    expect(
      (
        await rolloutRead(operator.token, {
          ...selected(),
          personId: foreignTarget().personId,
        })
      ).status,
    ).toBe(404);
    const response = await rolloutWrite(operator.token, input);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      ...selected(),
      enabled: true,
      audit: { id: expect.any(String), occurredAt: expect.any(String) },
    });
    expect(await readDEntryReleasePolicy()).toMatchObject({
      revision: result.revision,
      selections: [selected()],
    });
    const [audit] =
      await fixture.db`select actor_id,organization_id,resource_id,action,request_id,metadata,occurred_at
      from allrice_audit_events where id=${result.audit.id}`;
    expect(audit).toMatchObject({
      actor_id: operator.id,
      organization_id: org,
      resource_id: selected().personId,
      request_id: expect.any(String),
      action: 'd_entry_release.person.update',
      metadata: {
        previousRevision: 'unpublished',
        revision: result.revision,
        previousEnabled: false,
        enabled: true,
      },
    });
    expect(audit?.occurred_at.toISOString()).toBe(result.audit.occurredAt);
    cookie.token = operator.token;
    const staleReplace = await replaceRollout(
      new Request(api + '/d-entry-release-policy', {
        method: 'PUT',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          revision: 'unpublished',
          defaultGeneration: '3.x',
          selections: [],
        }),
      }),
    );
    expect(staleReplace.status).toBe(409);
    expect(await readDEntryReleasePolicy()).toMatchObject({
      revision: result.revision,
      selections: [selected()],
    });
    expect(
      (await rolloutWrite(operator.token, { ...input, enabled: false })).status,
    ).toBe(409);
    const second = await rolloutWrite(operator.token, {
      ...foreignTarget(),
      enabled: true,
      expectedRevision: result.revision,
    });
    expect(second.status).toBe(200);
    const secondResult = await second.json();
    const removal = await rolloutWrite(operator.token, {
      ...input,
      enabled: false,
      expectedRevision: secondResult.revision,
    });
    expect(removal.status).toBe(200);
    expect((await readDEntryReleasePolicy()).selections).toEqual([
      foreignTarget(),
    ]);
    expect(await (await rolloutRead(operator.token)).json()).toMatchObject({
      enabled: false,
    });
    const [count] =
      await fixture.db`select count(*)::int as count from allrice_audit_events where action='d_entry_release.person.update'`;
    expect(count?.count).toBe(3);
  });

  it('invalidates retained platform sessions at the store before a policy write', async () => {
    const login = await createSession(operator.id);
    const authenticated = (await authenticateSession(login.token))!;
    const previous = await readDEntryReleasePolicy();
    await revokeSession(login.token);
    await expect(
      updateDEntryPersonRollout(authenticated, {
        ...selected(),
        enabled: true,
        expectedRevision: previous.revision,
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(await readDEntryReleasePolicy()).toEqual(previous);
  });

  it('orders rollout enablement after an already locked native admission subject', async () => {
    const authenticated = (await authenticateSession(operator.token))!;
    const previous = await readDEntryReleasePolicy();
    const holder = deferred<number>();
    const proceed = deferred<void>();
    const admission = fixture.db.begin(async (tx) => {
      const [backend] =
        await tx`select pg_backend_pid() as pid from allrice_users
        where id=${selected().personId} for no key update`;
      holder.resolve(Number(backend!.pid));
      await proceed.promise;
      return readDEntryReleasePolicy(tx, true);
    });
    let publication: ReturnType<typeof updateDEntryPersonRollout> | undefined;
    try {
      const blocker = await Promise.race([
        holder.promise,
        admission.then(() => {
          throw new Error(
            'Admission released before the policy contention test',
          );
        }),
      ]);
      publication = updateDEntryPersonRollout(authenticated, {
        ...selected(),
        enabled: true,
        expectedRevision: previous.revision,
      });
      void publication.catch(() => {});
      await expect
        .poll(async () => {
          const [row] = await fixture.db`select exists (
          select 1 from pg_stat_activity a where ${blocker}::int=any(pg_blocking_pids(a.pid))
            and a.query like '%for share of o,u,m%'
        ) as blocked`;
          return row?.blocked;
        })
        .toBe(true);
      proceed.resolve();
      expect(await admission).toEqual(previous);
      await expect(publication).resolves.toMatchObject({ enabled: true });
    } finally {
      proceed.resolve();
      await Promise.allSettled([admission, publication]);
    }
  });

  it('redacts legacy event labels, tool inputs, outputs and dialogue', async () => {
    const { organizationId, workspaceId } = tenant.target;
    const runId = tenant.task.runId;
    const sessionId = tenant.task.chatSessionId;
    const [seq] =
      await fixture.db`select coalesce(max(sequence),0)::int + 1 as next from allrice_run_events where run_id=${runId}`;
    const event = {
      source: 'dsh',
      presentation: 'tool',
      status: 'PRIVATE_TOOL_STATUS',
      label: 'PRIVATE_TOOL_LABEL',
      summary: 'PRIVATE_TOOL_OUTPUT',
      nativePayload: { callId: 'PRIVATE_TOOL_ID', query: 'PRIVATE_TOOL_INPUT' },
    };
    await fixture.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      values(${organizationId},${workspaceId},${runId},${seq!.next},'harness.native',${fixture.db.json(event)})`;
    const toolRecord = {
      source: 'tool_broker',
      name: 'PRIVATE_TOOL_NAME',
      toolCallId: 'PRIVATE_TOOL_CALL',
      summary: 'PRIVATE_TOOL_OUTPUT',
    };
    const next = Number(seq!.next) + 1;
    await fixture.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      values(${organizationId},${workspaceId},${runId},${next},'tool.started',${fixture.db.json(toolRecord)}),
      (${organizationId},${workspaceId},${runId},${next + 1},'tool.completed',${fixture.db.json(toolRecord)})`;
    await fixture.db`update allrice_chat_sessions set title='PRIVATE_SESSION_TITLE' where id=${sessionId}`;
    const dashboard = await activity(
      request(
        '/activity?' +
          new URLSearchParams({
            organizationId,
            userId: tenant.target.subjectId,
          }),
        operator.token,
      ),
    );
    expect(dashboard.status).toBe(200);
    const work = await dashboard.json();
    expect(work.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: runId,
          title: '会话',
        }),
      ]),
    );
    expect(JSON.stringify(work)).not.toMatch(
      /PRIVATE_SESSION_TITLE|PRIVATE_TOOL/,
    );
    const files = await deliverables(
      request(
        '/organizations/' + organizationId + '/deliverables',
        operator.token,
      ),
      { params: Promise.resolve({ organizationId }) },
    );
    expect(files.status).toBe(200);
    const fileList = await files.json();
    expect(fileList.deliverables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: tenant.artifact.artifactId,
          sessionTitle: '会话',
        }),
      ]),
    );
    expect(JSON.stringify(fileList)).not.toContain('PRIVATE_SESSION_TITLE');
    const response = await eventsRead(
      operator.token,
      sessionId,
      organizationId,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    const turn = body.timeline.turns.find(
      (turn: { run: { id: string } }) => turn.run.id === runId,
    );
    expect(turn).toMatchObject({
      userMessage: { text: null },
      assistantMessage: { text: null },
      events: expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          status: 'info',
          title: 'tool',
          detail: null,
        }),
      ]),
    });
    expect(JSON.stringify(body)).not.toMatch(
      /PRIVATE_TOOL|Synthetic research goal|Synthetic finished report/,
    );
    const projected = projectRuntimeTimelineEvents(turn.events).filter(
      ({ sequence }) => sequence >= next,
    );
    expect(projected).toMatchObject([
      { sequence: next, status: 'completed', kind: 'tool', detail: null },
    ]);
    expect(
      (await eventsRead(member.token, sessionId, organizationId)).status,
    ).toBe(403);
    expect(
      (
        await eventsRead(
          operator.token,
          foreign.task.chatSessionId,
          organizationId,
        )
      ).status,
    ).toBe(404);
    expect(
      (await eventsRead(manager.token, sessionId, organizationId)).status,
    ).toBe(403);
  });

  it('reports committed 4.0 lifecycle rows without crossing tenant, workspace or owner', async () => {
    const { organizationId, workspaceId, subjectId } = tenant.target;
    const sessionId = randomUUID(),
      id = randomUUID(),
      wrongScopeRun = randomUUID();
    await fixture.db`insert into allrice_chat_sessions(
      id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_instance_id,
      employee_version_id,title,execution_generation
    )
    select ${sessionId},organization_id,workspace_id,owner_id,employee_assignment_id,employee_instance_id,
      employee_version_id,'PRIVATE_TITLE','4.0'
    from allrice_chat_sessions where id=${tenant.task.chatSessionId}`;
    const spec = {
      generation: '4.0',
      source: 'dsh-native-prompt',
      threadId: sessionId,
      text: 'PRIVATE_NATIVE_PROMPT',
    };
    await fixture.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec)
      values(${id},${organizationId},${workspaceId},${subjectId},'running',${fixture.db.json(spec)}),
      (${wrongScopeRun},${organizationId},${workspaceId},${manager.id},'running',${fixture.db.json(spec)})`;
    await fixture.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      values(${organizationId},${workspaceId},${id},0,'step.started','{"source":"dsh-native-attempt","input":"PRIVATE_NATIVE_TOOL"}')`;
    const response = await eventsRead(
      operator.token,
      sessionId.toUpperCase(),
      organizationId,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.timeline.turns.map((turn: { run: { id: string } }) => turn.run.id),
    ).toEqual([id]);
    expect(body.timeline.turns[0].events[0]).toMatchObject({
      kind: 'lifecycle',
      title: 'step.started',
      detail: null,
    });
    expect(JSON.stringify(body)).not.toContain('PRIVATE_');
  });

  it('denies raw tool artifacts and private business artifacts at the diagnostic list and download boundary', async () => {
    const { organizationId, workspaceId, subjectId } = tenant.target;
    const runId = tenant.task.runId;
    await fixture.db`update allrice_deliverable_versions set change_summary='PRIVATE_IMAGE_EDIT_PROMPT'
      where id=${tenant.artifact.artifactId}`;
    const command = await tenant.createArtifact(
      runId,
      'PRIVATE_COMMAND_OUTPUT',
      undefined,
      {
        kind: 'command_output',
      },
    );
    const snapshot = await tenant.createArtifact(
      runId,
      'PRIVATE_PROJECT_SNAPSHOT',
      undefined,
      {
        kind: 'file',
        provenanceKind: 'project_snapshot',
      },
    );
    const restrictedFiles = [];
    for (let i = 0; i < 51; i++) {
      restrictedFiles.push(
        (await tenant.createArtifact(runId, `PRIVATE_FILE_${i}`, undefined))
          .artifactId,
      );
    }
    const restricted = { artifactId: restrictedFiles[0]! };
    await fixture.db`update allrice_deliverable_versions set created_at='2001-01-01'
      where id=${tenant.artifact.artifactId}`;
    await fixture.db`insert into allrice_workbench_file_policies
      (object_id,organization_id,workspace_id,owner_id,file_name,scope)
      select object_id,organization_id,workspace_id,owner_id,file_name,'personal'
      from allrice_deliverable_versions where id=any(${restrictedFiles}::uuid[])`;
    const read = (artifactId?: string) =>
      validation(
        request(
          '/tenants/' +
            organizationId +
            '/validation?' +
            new URLSearchParams({
              workspaceId,
              subjectId,
              runId,
              ...(artifactId && { artifactId, download: '1' }),
            }),
          operator.token,
        ),
        { params: Promise.resolve({ organizationId }) },
      );
    const response = await read();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.artifacts.map((item: { id: string }) => item.id)).toEqual([
      tenant.artifact.artifactId,
    ]);
    expect(body.artifacts[0].version.changeSummary).toBeNull();
    expect(body.artifactsTruncated).toBe(false);
    expect(JSON.stringify(body)).not.toContain('PRIVATE_IMAGE_EDIT_PROMPT');
    const company = (query: Record<string, string> = {}) =>
      deliverables(
        request(
          '/organizations/' +
            organizationId +
            '/deliverables?' +
            new URLSearchParams(query),
          operator.token,
        ),
        { params: Promise.resolve({ organizationId }) },
      );
    const companyList = await company();
    expect(companyList.status).toBe(200);
    expect(
      (await companyList.json()).deliverables.map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual([tenant.artifact.artifactId]);
    for (const artifact of [command, snapshot, restricted]) {
      const denied = await read(artifact.artifactId);
      expect(denied.status).toBe(404);
      expect(await denied.text()).not.toContain('PRIVATE_');
      expect(
        (await company({ artifactId: artifact.artifactId, download: '1' }))
          .status,
      ).toBe(404);
      expect((await company({ before: artifact.artifactId })).status).toBe(404);
    }
  });

  it('allows only a revision-matched platform replacement of unreadable rollout data', async () => {
    const path = '/d-entry-release-policy';
    const corrupt = (value: string) =>
      fixture.db`insert into allrice_settings(scope_type,key,value)
        values('system','d_entry_rollout_policy',${value}::text::jsonb)
        on conflict(scope_type,scope_id,key) do update set value=excluded.value`;
    const replace = (revision: string) =>
      replaceRollout(
        new Request(api + path, {
          method: 'PUT',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({
            revision,
            defaultGeneration: '3.x',
            selections: [],
          }),
        }),
      );
    await corrupt('{"private":"PRIVATE_ROLLOUT","integer":9007199254740992}');
    await expect(readDEntryReleasePolicy()).rejects.toThrow(
      'D entry published policy is unavailable',
    );
    expect((await bulkRollout(request(path, manager.token))).status).toBe(403);
    const read = await bulkRollout(request(path, operator.token));
    expect(read.status).toBe(200);
    const first = await read.json();
    expect(first).toEqual({
      revision: expect.stringMatching(/^repair:[a-f0-9]{64}$/),
      defaultGeneration: '3.x',
      selections: [],
    });
    await corrupt('{"private":"PRIVATE_ROLLOUT","integer":9007199254740993}');
    expect((await replace(first.revision)).status).toBe(409);
    const latest = await (
      await bulkRollout(request(path, operator.token))
    ).json();
    expect(latest.revision).not.toBe(first.revision);
    const repaired = await replace(latest.revision);
    expect(repaired.status).toBe(200);
    const updated = await repaired.json();
    expect(await readDEntryReleasePolicy()).toEqual(updated);
    expect(updated.revision).not.toMatch(/^repair:/);
    const [audit] = await fixture.db`select actor_id from allrice_audit_events
      where action='d_entry_release.update' and metadata->>'revision'=${updated.revision}`;
    expect(audit?.actor_id).toBe(operator.id);
  });
});
