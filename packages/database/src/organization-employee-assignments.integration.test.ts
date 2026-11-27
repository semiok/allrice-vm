import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BrowserProfileSchema,
  type OrganizationAiTarget,
  type RequestContext,
} from '@allrice/contracts';
import { PostgresPersonVmStore } from '@allrice/person-vm';
import { harness, signal } from '../../person-vm/src/test-support.ts';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import {
  compilePlatformEmployee,
  savePlatformEmployeeDraft,
} from './employees/platform-employees.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  login,
} from './identity.ts';
import {
  createManagedOrganization,
  importOrganizationPeople,
  listOrganizationPeople,
  setOrganizationAccountStatus,
  updateOrganizationPerson,
  updateManagedOrganization,
} from './organization-administration.ts';
import {
  listOrganizationAiAssignments,
  changeOrganizationAiAssignments,
} from './organization-employee-assignments.ts';
import {
  changeEmployeeInstanceLifecycle,
  createEmployeeInstance,
} from './employees/employee-instances.ts';
import {
  listAdminTenantMembers,
  updateAdminTenantMember,
} from './tenant-administration.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { changeAdminTenantEmployee } from './tenant-employees.ts';
import {
  preparePersonNativeWebRoster,
  readPersonNativeWebRoster,
} from './employees/native-web-roster.ts';
import { updateDEntryReleasePolicy } from './d-entry-release-policy.ts';
import { recordManagedCloudEnvironment } from './tenant-employee-access.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
  getChatSessionHistory,
  sendChatMessage,
} from './workspace/service.ts';
import { resolveEmployeeExecution } from './employees/employeehub.ts';
import { assembleEmployeeKernel } from '../../../apps/worker/src/employee-kernel.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('MET-161 personal AI assignment and frozen company persona', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>,
    admin: RequestContext;
  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    const p = await ensureBootstrapPortalPrincipal({
      organizationSlug: 'allrice-platform',
      organizationName: 'Platform',
      workspaceSlug: 'default',
      workspaceName: 'Default',
      email: 'assignment-admin@example.test',
      displayName: 'Admin',
      role: 'member',
    });
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
    admin = (await authenticateSession(
      (await createSession(p.user.id)).token,
    ))!;
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fixture) await fixture.close();
  });
  async function setup({ browserGrant = false } = {}) {
    const c = await createManagedOrganization(admin, {
      name: '星米科技',
      businessContext: '文创企业',
    });
    const source = await createEmployeeAdministrationFixture(fixture.db);
    if (browserGrant) {
      const { capabilities } = source.definition;
      await savePlatformEmployeeDraft(source.employeeId, {
        definition: {
          ...source.definition,
          capabilities: {
            ...capabilities,
            toolNames: [...capabilities.toolNames, 'browser.workspace'],
          },
        },
      });
      expect((await compilePlatformEmployee(source.employeeId)).valid).toBe(
        true,
      );
    }
    await source.preview();
    expect((await source.publish()).valid).toBe(true);
    const entry = async (target: OrganizationAiTarget = { type: 'all' }) =>
      (
        await listOrganizationAiAssignments(
          admin,
          c.organizationId,
          c.defaultWorkspaceId,
          target,
        )
      ).employees.find((e) => e.employeeId === source.employeeId)!;
    const change = async (
      action: 'include' | 'exclude' | 'inherit' | 'default',
      target: OrganizationAiTarget = { type: 'all' },
      defaultEnabled?: boolean,
    ) => {
      const e = await entry();
      return changeOrganizationAiAssignments(admin, c.organizationId, {
        workspaceId: c.defaultWorkspaceId,
        employeeId: e.employeeId,
        revisionId: e.revisionId,
        expectedVersion: e.deployment?.version ?? null,
        action,
        target,
        ...(defaultEnabled === undefined ? {} : { defaultEnabled }),
      });
    };
    const person = async (name: string, job = '财务') => {
      const username = `person-${randomUUID()}`;
      const p = (
        await importOrganizationPeople(admin, c.organizationId, {
          people: [
            {
              username,
              displayName: name,
              jobTitle: job,
              responsibilities: '供应商对账',
            },
          ],
        })
      ).created[0]!;
      const signed = await login({ username, password: `${username}@123` });
      const context = (await authenticateSession(signed.session.token))!;
      return {
        ...p,
        username,
        context,
        target: selected(p.userId),
      };
    };
    return { ...c, source, entry, change, person };
  }
  const selected = (id: string): OrganizationAiTarget => ({
    type: 'selected',
    userIds: [id],
  });
  async function heartbeat() {
    await recordManagedCloudEnvironment(
      {
        workerId: randomUUID(),
        browser: { available: false, profile: null, reason: 'fixture' },
        compute: { available: false, profile: null, reason: 'fixture' },
      },
      fixture.db,
    );
  }
  it('prepares a company roster before hiring, inherits it on account creation, and persists personal exclusions across heartbeat and publication', async () => {
    const f = await setup();
    await f.change('default', { type: 'all' }, true);
    expect(
      await fixture.db`select id from allrice_memberships where organization_id=${f.organizationId}`,
    ).toHaveLength(0);
    const a = await f.person('小雪'),
      b = await f.person('小李');
    const workspace = () =>
      getEmployeeWorkspace(a.context, f.defaultWorkspaceId);
    const original = (await workspace()).employees[0]!;
    expect((await f.entry()).targetAssignedCount).toBe(2);
    await f.change('exclude', selected(a.userId));
    const version = (await f.entry()).deployment!.tenantVersionId;
    await heartbeat();
    expect((await workspace()).employees).toEqual([]);
    expect(
      (await getEmployeeWorkspace(b.context, f.defaultWorkspaceId)).employees,
    ).toHaveLength(1);
    // The existing published package refresh must preserve explicit choices.
    const { materializePlatformEmployeeRevision } =
      await import('./employees/platform-employees.ts');
    await fixture.db.begin(async (tx) =>
      materializePlatformEmployeeRevision(tx, {
        employeeId: f.source.employeeId,
        revision: (await f.source.revision()) as Parameters<
          typeof materializePlatformEmployeeRevision
        >[1]['revision'],
        definition: f.source.definition,
        workspaceIds: [f.defaultWorkspaceId],
        actorLabel: admin.actor.id,
      }),
    );
    await heartbeat();
    expect((await workspace()).employees).toEqual([]);
    expect((await f.entry()).deployment!.tenantVersionId).not.toBe(version);
    await f.change('inherit', selected(a.userId));
    expect((await workspace()).employees[0]!.id).toBe(original.id);
    expect(
      await fixture.db`select id from allrice_employee_versions where employee_id=${original.employeeId}`,
    ).toHaveLength(2);
    expect((await workspace()).employees[0]!.currentVersion.id).toBe(
      (await getEmployeeWorkspace(b.context, f.defaultWorkspaceId))
        .employees[0]!.currentVersion.id,
    );
    expect((await f.entry()).targetAssignedCount).toBe(2);
  });
  it('supports selected/filter/all actions without grants to others and keeps personal additions when company defaults are off', async () => {
    const f = await setup(),
      a = await f.person('财务甲'),
      b = await f.person('销售乙', '销售');
    expect(
      (await getEmployeeWorkspace(a.context, f.defaultWorkspaceId)).employees,
    ).toEqual([]);
    await f.change('include', { type: 'search', search: '财务' });
    expect((await f.entry()).targetAssignedCount).toBe(1);
    expect(
      (await getEmployeeWorkspace(b.context, f.defaultWorkspaceId)).employees,
    ).toEqual([]);
    await f.change('default', { type: 'all' }, true);
    expect((await f.entry()).targetAssignedCount).toBe(2);
    await f.change('default', { type: 'all' }, false);
    expect((await f.entry()).targetAssignedCount).toBe(1);
    expect(
      (await getEmployeeWorkspace(a.context, f.defaultWorkspaceId)).employees,
    ).toHaveLength(1);
    await f.change('exclude', { type: 'all' });
    await heartbeat();
    expect((await f.entry()).targetAssignedCount).toBe(0);
    await f.change('include', selected(b.userId));
    expect((await f.entry()).targetAssignedCount).toBe(1);
  });
  it('rolls back an inherited assignment over capacity and preserves the existing cold-start roster', async () => {
    const f = await setup();
    const a = await f.person('已开通');
    const legacy = await f.person('普通用户');
    const workspaceId = f.defaultWorkspaceId;
    const org = f.organizationId;
    const selection = { organizationId: org, personId: a.userId };
    let current = a.context;
    const prepare = () =>
      preparePersonNativeWebRoster({ ...current, workspaceId });
    const publish = (released: boolean) =>
      updateDEntryReleasePolicy(admin, {
        revision: 'initial',
        defaultGeneration: '3.x',
        selections: released ? [selection] : [],
      });
    await publish(true);
    try {
      const original = await createEmployeeInstance(a.context, {
        workspaceId,
        expectedOwnerId: a.userId,
        profile: { name: '我的员工' },
        requestId: randomUUID(),
      });
      await fixture.db`insert into person_virtual_machines
        (person_id,vm_id,organization_id,instance_id,phase,disk_tier,native_created,lease_epoch,verified_web_slot_capacity)
        values(${a.userId},${randomUUID()},${org},${randomUUID()},'stopped','warm',true,1,1)`;
      const oldRoster = await prepare();
      expect(
        oldRoster.entries.map(({ employeeInstanceId }) => employeeInstanceId),
      ).toEqual([original.id]);
      const prior = await f.entry();
      for (const change of [
        () => f.change('include', selected(a.userId)),
        () => f.change('default', { type: 'all' }, true),
      ]) {
        await expect(change()).rejects.toMatchObject({
          code: 'employee_port_slots_full',
        });
        expect(await f.entry()).toEqual(prior);
        expect(await prepare()).toEqual(oldRoster);
        expect(
          await readPersonNativeWebRoster({ ...a.context, workspaceId }),
        ).toEqual(oldRoster);
      }
      const beforeDisable = await account(f.organizationId, a.userId);
      const suspended = await setOrganizationAccountStatus(
        admin,
        org,
        a.userId,
        {
          active: false,
          expectedVersion: beforeDisable.version,
        },
      );
      const audits = () => fixture.db`select id from allrice_audit_events
        where organization_id=${org} and action='organization.ai_assignment.updated'
        order by id`;
      const oldAudits = await audits();
      for (const change of [
        () => f.change('include', a.target),
        () => f.change('default', { type: 'all' }, true),
      ]) {
        await expect(change()).rejects.toMatchObject({
          code: 'employee_port_slots_full',
        });
        expect(await f.entry()).toEqual(prior);
        expect(await audits()).toEqual(oldAudits);
      }
      await setOrganizationAccountStatus(admin, org, a.userId, {
        active: true,
        expectedVersion: suspended.person.version,
      });
      const login = await createSession(a.userId);
      current = (await authenticateSession(login.token, {
        organizationId: org,
        workspaceId,
      }))!;
      expect(await prepare()).toEqual(oldRoster);
      await f.change('include', selected(legacy.userId));
      const { tenantEmployeeId, tenantVersionId } = (await f.entry())
        .deployment!;
      const { employees } = await getEmployeeWorkspace(
        legacy.context,
        workspaceId,
      );
      expect(employees).toHaveLength(1);
      expect(employees[0]).toMatchObject({
        employeeId: tenantEmployeeId,
        organizationId: org,
        workspaceId,
        userId: legacy.userId,
        active: true,
        currentVersion: {
          id: tenantVersionId,
          employeeId: tenantEmployeeId,
          manifest: { name: f.source.definition.name },
        },
      });
      expect(await prepare()).toEqual(oldRoster);
    } finally {
      await publish(false);
    }
  });

  async function account(organizationId: string, userId: string) {
    return (await listOrganizationPeople(admin, organizationId)).people.find(
      (person) => person.userId === userId,
    )!;
  }

  it('isolates a failed materialization from other people, releases, and health while preserving prior grants', async () => {
    const b = await setup({ browserGrant: true });
    const person = await b.person('两企成员');
    const unaffected = await b.person('普通三代成员');
    const a = await createManagedOrganization(admin, {
      name: '实际 VM 所属企业',
      businessContext: '独立测试',
    });
    const conflict = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
    const later = `ffffffff-ffff-4fff-bfff-${randomUUID().slice(-12)}`;
    await fixture.db`insert into allrice_workspaces(id,organization_id,slug,name)
      values(${conflict},${b.organizationId},'conflict-health','Earlier conflict'),
        (${later},${b.organizationId},'later-health','Later workspace')`;
    await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role)
      values(${a.organizationId},${a.defaultWorkspaceId},${person.userId},'member')`;
    const choose = async (
      workspaceId: string,
      action: 'include' | 'exclude',
      target = person.target,
      sourceId = b.source.employeeId,
    ) => {
      const entry = (
        await listOrganizationAiAssignments(
          admin,
          b.organizationId,
          workspaceId,
        )
      ).employees.find(({ employeeId }) => employeeId === sourceId)!;
      return changeOrganizationAiAssignments(admin, b.organizationId, {
        workspaceId,
        employeeId: entry.employeeId,
        revisionId: entry.revisionId,
        expectedVersion: entry.deployment?.version ?? null,
        action,
        target,
      });
    };
    const status = async (
      active: boolean,
      userId = person.userId,
      organizationId = a.organizationId,
    ) =>
      setOrganizationAccountStatus(admin, organizationId, userId, {
        active,
        expectedVersion: (await account(organizationId, userId)).version,
      });
    const assignment = async (workspaceId: string, userId = person.userId) =>
      (
        await fixture.db`
      select a.id,a.active,a.selection_mode,a.employee_version_id
      from allrice_employee_assignments a
      join allrice_platform_employee_tenant_assignments d on d.tenant_employee_id=a.employee_id
      where a.organization_id=${b.organizationId} and a.workspace_id=${workspaceId}
        and d.employee_id=${b.source.employeeId} and a.user_id=${userId}`
      )[0];
    const clock = () => fixture.db<
      { workspace_id: string; last_heartbeat_at: Date; state: string }[]
    >`
      select workspace_id,last_heartbeat_at,state from allrice_execution_targets
      where organization_id=${b.organizationId} and target_key='allrice.cloud.browser' order by workspace_id`;
    const archiveGeneral = async (workspaceId: string) => {
      const root = (
        await getEmployeeWorkspace(person.context, workspaceId)
      ).employees[0]!.instances!.find(({ kind }) => kind === 'general')!;
      await changeEmployeeInstanceLifecycle(person.context, root.id, {
        workspaceId,
        expectedRevision: root.revision,
        operation: 'archive',
        requestId: randomUUID(),
      });
      return root;
    };
    const profile = BrowserProfileSchema.parse({
      version: 1,
      network: 'public_https',
      origins: [],
      allowHumanCredentials: true,
      allowUploads: true,
      allowDownloads: true,
    });
    const report = {
      workerId: randomUUID(),
      browser: { available: true, profile, reason: null },
      compute: { available: false, profile: null, reason: 'fixture' },
    };
    const store = new PostgresPersonVmStore(() =>
      client.createDedicatedDatabase(fixture.db),
    );
    const h = harness(store);
    const publish = (enabled: boolean) =>
      updateDEntryReleasePolicy(admin, {
        revision: 'initial',
        defaultGeneration: '3.x',
        selections: enabled
          ? [a.organizationId, b.organizationId].map((organizationId) => ({
              organizationId,
              personId: person.userId,
            }))
          : [],
      });
    let ownerContext: RequestContext | null = null;
    const warning = vi.spyOn(console, 'warn');
    try {
      await b.change('include', person.target);
      await choose(conflict, 'include', unaffected.target);
      await choose(later, 'include');
      const archivedRoot = await archiveGeneral(later);
      const withdrawnRoot = await archiveGeneral(b.defaultWorkspaceId);
      await choose(later, 'exclude');
      const historical = await assignment(b.defaultWorkspaceId);
      expect(historical).toMatchObject({
        active: true,
        selection_mode: 'include',
      });
      await publish(true);
      await status(false);
      await choose(conflict, 'include');
      const pending = await assignment(conflict);
      expect(pending).toMatchObject({
        active: false,
        selection_mode: 'include',
      });
      await recordManagedCloudEnvironment(report, fixture.db);
      const before = await clock();
      expect(before.map(({ workspace_id }) => workspace_id)).toEqual([
        conflict,
        b.defaultWorkspaceId,
        later,
      ]);
      expect(before.every(({ state }) => state === 'online')).toBe(true);
      expect(await assignment(b.defaultWorkspaceId)).toEqual(historical);
      await expect(
        preparePersonNativeWebRoster(person.context),
      ).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      expect(await assignment(conflict)).toEqual(pending);
      await status(true);
      const login = await createSession(person.userId);
      ownerContext = await authenticateSession(login.token, {
        organizationId: a.organizationId,
        workspaceId: a.defaultWorkspaceId,
      });
      expect(ownerContext).not.toBeNull();
      expect(
        (await h.service.prewarm(ownerContext!, { trigger: 'page' }, signal()))
          .ready,
      ).toBe(true);

      await status(false);
      const excluded = await assignment(later);
      const catalog = () =>
        listOrganizationAiAssignments(
          admin,
          b.organizationId,
          later,
          person.target,
        );
      const previousCatalog = await catalog();
      const audit = () => fixture.db`select id from allrice_audit_events
        where workspace_id=${later} and action='organization.ai_assignment.updated'`;
      const previousAudit = await audit();
      const archived = () => fixture.db`select id,revision,archived_at
        from allrice_employee_instances where id=${archivedRoot.id}`;
      const archiveBefore = await archived();
      expect(archiveBefore).toMatchObject([{ archived_at: expect.any(Date) }]);
      await expect(choose(later, 'include')).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      expect(await assignment(later)).toEqual(excluded);
      expect(await catalog()).toEqual(previousCatalog);
      expect(await audit()).toEqual(previousAudit);
      expect(await archived()).toEqual(archiveBefore);
      await status(true);

      const realGrant = await assignment(conflict, unaffected.userId);
      expect(realGrant).toMatchObject({ active: true });
      const thread = await createChatSession(unaffected.context, {
        workspaceId: conflict,
        employeeAssignmentId: realGrant!.id,
        title: 'Pending scoped revocation',
      });
      const turn = await sendChatMessage(
        unaffected.context,
        conflict,
        thread.id,
        {
          text: '处理我的工作区资料',
          clientMessageId: randomUUID(),
        },
      );
      const threadBinding =
        () => fixture.db`select employee_assignment_id,employee_version_id,execution_generation
        from allrice_chat_sessions where id=${thread.id}`;
      const beforeRevocation = await threadBinding();
      const revoked = await choose(conflict, 'exclude', unaffected.target);
      expect(revoked.cancellationRequestedCount).toBe(1);
      expect(await assignment(conflict, unaffected.userId)).toMatchObject({
        id: realGrant!.id,
        active: false,
        selection_mode: 'exclude',
      });
      expect(
        (await getEmployeeWorkspace(unaffected.context, conflict)).employees,
      ).toEqual([]);
      expect(await threadBinding()).toEqual(beforeRevocation);
      expect(
        await fixture.db`select cancel_requested_at from allrice_jobs where run_id=${turn.run.id}`,
      ).toMatchObject([{ cancel_requested_at: expect.any(Date) }]);
      expect(
        await fixture.db`select metadata from allrice_audit_events
        where organization_id=${b.organizationId} and workspace_id=${conflict} and actor_id=${admin.actor.id}
          and action='organization.ai_assignment.updated' and resource_type='platform_employee' and resource_id=${b.source.employeeId}
          and reason='exclude' order by occurred_at desc,id desc limit 1`,
      ).toMatchObject([{ metadata: { userIds: [unaffected.userId] } }]);
      expect(await assignment(conflict)).toEqual(pending);

      await choose(conflict, 'include', unaffected.target);
      const independent = await createEmployeeAdministrationFixture(fixture.db);
      await independent.preview();
      expect((await independent.publish()).valid).toBe(true);
      await expect(
        choose(conflict, 'include', unaffected.target, independent.employeeId),
      ).resolves.toMatchObject({ changedCount: 1 });
      expect(
        (await getEmployeeWorkspace(unaffected.context, conflict)).employees,
      ).toHaveLength(2);
      const member = (
        await listAdminTenantMembers(admin, b.organizationId, null)
      ).members.find(({ userId }) => userId === unaffected.userId)!;
      await expect(
        updateAdminTenantMember(admin, b.organizationId, member.id, {
          active: true,
          role: 'viewer',
          workspaceId: member.workspaceId,
          expectedVersion: member.version,
        }),
      ).resolves.toMatchObject({ changed: true, member: { role: 'viewer' } });
      expect(
        await readContentPrincipal({
          ...unaffected.context,
          workspaceId: conflict,
        }),
      ).toMatchObject({ writable: false });
      expect(await assignment(conflict, unaffected.userId)).toMatchObject({
        active: false,
      });
      expect(
        await fixture.db`select id from allrice_audit_events
        where action='tenant.member.updated' and resource_id=${member.id}`,
      ).toHaveLength(1);
      const imported = await b.person('新普通成员');
      expect(
        await readContentPrincipal({
          ...imported.context,
          workspaceId: conflict,
        }),
      ).toMatchObject({ writable: true });
      expect(await assignment(conflict)).toEqual(pending);

      const interactive = await b.person('明确重提派发的普通成员');
      const background = await b.person('等后台派发的普通成员');
      for (const { userId, target } of [interactive, background]) {
        await status(false, userId, b.organizationId);
        await choose(conflict, 'include', target);
        await status(true, userId, b.organizationId);
      }
      const interactivePending = await assignment(conflict, interactive.userId);
      const backgroundPending = await assignment(conflict, background.userId);
      expect(interactivePending).toMatchObject({
        active: false,
        selection_mode: 'include',
      });
      expect(backgroundPending).toMatchObject({
        active: false,
        selection_mode: 'include',
      });
      await expect(
        choose(conflict, 'include', interactive.target),
      ).resolves.toMatchObject({
        changedCount: 0,
      });
      expect(await assignment(conflict, interactive.userId)).toEqual({
        ...interactivePending,
        active: true,
      });
      expect(await assignment(conflict, background.userId)).toEqual(
        backgroundPending,
      );
      expect(await assignment(conflict)).toEqual(pending);

      await recordManagedCloudEnvironment(report, fixture.db);
      expect(await assignment(conflict, background.userId)).toEqual({
        ...backgroundPending,
        active: true,
      });
      for (const [recipient, intent] of [
        [interactive, interactivePending],
        [background, backgroundPending],
      ] as const) {
        const { token } = await createSession(recipient.userId);
        const current = await authenticateSession(token, {
          organizationId: b.organizationId,
          workspaceId: conflict,
        });
        expect(
          (await getEmployeeWorkspace(current!, conflict)).employees,
        ).toEqual([
          expect.objectContaining({
            id: intent!.id,
            isDefault: true,
            currentVersion: expect.objectContaining({
              id: intent!.employee_version_id,
              manifest: expect.objectContaining({
                name: b.source.definition.name,
              }),
            }),
          }),
        ]);
        expect(
          await fixture.db`
          select g.owner_id from allrice_browser_control_grants g
          join allrice_execution_targets t on t.id=g.target_id
          where g.organization_id=${b.organizationId} and g.workspace_id=${conflict} and g.owner_id=${recipient.userId}
            and g.enabled and g.revoked_at is null and t.target_key='allrice.cloud.browser'`,
        ).toEqual([{ owner_id: recipient.userId }]);
      }
      expect(warning).toHaveBeenCalledWith(
        '[MET-159] managed cloud roster sync deferred',
        {
          organizationId: b.organizationId,
          workspaceId: conflict,
          error: expect.objectContaining({ code: 'authorization_denied' }),
        },
      );
      expect(await assignment(conflict)).toEqual(pending);
      expect(await assignment(b.defaultWorkspaceId)).toEqual(historical);
      expect(await assignment(later)).toEqual(excluded);
      const after = await clock();
      expect(after.map(({ workspace_id }) => workspace_id)).toEqual(
        before.map(({ workspace_id }) => workspace_id),
      );
      for (const [index, row] of after.entries()) {
        expect(row.state).toBe('online');
        expect(row.last_heartbeat_at.getTime()).toBeGreaterThan(
          before[index]!.last_heartbeat_at.getTime(),
        );
      }

      await status(false);
      const changeDeployment = async (action: 'withdraw' | 'assign') => {
        const current = await b.entry(person.target);
        return changeAdminTenantEmployee(admin, b.organizationId, {
          workspaceId: b.defaultWorkspaceId,
          employeeId: current.employeeId,
          revisionId: current.revisionId,
          expectedVersion: current.deployment?.version ?? null,
          action,
        });
      };
      await expect(changeDeployment('withdraw')).resolves.toEqual({
        changed: true,
      });
      const dormant = await assignment(b.defaultWorkspaceId);
      expect(dormant).toMatchObject({
        id: historical!.id,
        active: false,
        selection_mode: 'include',
      });
      const deployment = await b.entry(person.target);
      expect(deployment.deployment).toMatchObject({ active: false });
      const reopenState = () => fixture.db`
        select d.tenant_employee_version_id,e.status,i.archived_at,i.revision,
          (select count(*)::int from allrice_employee_versions v where v.employee_id=e.id) version_count,
          (select count(*)::int from allrice_audit_events a where a.organization_id=d.organization_id
            and a.workspace_id=d.workspace_id and a.resource_type='platform_employee' and a.resource_id=d.employee_id) audit_count
        from allrice_platform_employee_tenant_assignments d
        join allrice_employees e on e.id=d.tenant_employee_id
        join allrice_employee_assignments personal on personal.organization_id=d.organization_id
          and personal.workspace_id=d.workspace_id and personal.employee_id=e.id and personal.user_id=${person.userId}
        join allrice_employee_instances i on i.id=${withdrawnRoot.id} and i.assignment_id=personal.id and i.kind='general'
        where d.organization_id=${b.organizationId} and d.workspace_id=${b.defaultWorkspaceId} and d.employee_id=${b.source.employeeId}`;
      const prior = await reopenState();
      expect(prior).toMatchObject([
        { status: 'archived', archived_at: expect.any(Date) },
      ]);
      const foreignOwner = await store.read(person.userId);
      for (const reopen of [
        () => changeDeployment('assign'),
        () => b.change('default', { type: 'all' }, true),
      ]) {
        await expect(reopen()).rejects.toMatchObject({
          code: 'authorization_denied',
        });
        expect(await b.entry(person.target)).toEqual(deployment);
        expect(await assignment(b.defaultWorkspaceId)).toEqual(dormant);
        expect(await reopenState()).toEqual(prior);
        expect(await store.read(person.userId)).toEqual(foreignOwner);
      }
    } finally {
      warning.mockRestore();
      const vm = await store.read(person.userId);
      if (ownerContext && vm?.phase === 'running') {
        h.states.set(vm.vmId, 'stopped');
        await h.service.stop(ownerContext, signal());
      }
      await publish(false);
    }
  });

  it('withdraws only the selected person, requests cancellation, preserves history and freezes company/person data for each run', async () => {
    const f = await setup(),
      a = await f.person('小雪'),
      b = await f.person('小李', '销售');
    await f.change('default', { type: 'all' }, true);
    const session = await createChatSession(a.context, {
      workspaceId: f.defaultWorkspaceId,
      title: '对账工作',
    });
    const sent = await sendChatMessage(
      a.context,
      f.defaultWorkspaceId,
      session.id,
      { text: '整理对账资料', clientMessageId: randomUUID() },
    );
    const resolve = () =>
      resolveEmployeeExecution({
        organizationId: f.organizationId,
        workspaceId: f.defaultWorkspaceId,
        ownerId: a.userId,
        runId: sent.run.id,
      });
    const first = await resolve();
    expect(first.promptSnapshot.organizationContext).toMatchObject({
      companyName: '星米科技',
      displayName: '小雪',
      jobTitle: '财务',
      userId: a.userId,
    });
    await updateManagedOrganization(admin, f.organizationId, {
      name: '星米集团',
      businessContext: '新业务',
      expectedRevision: 1,
    });
    const p = (
      await listOrganizationPeople(admin, f.organizationId)
    ).people.find((p) => p.userId === a.userId)!;
    await updateOrganizationPerson(admin, f.organizationId, a.userId, {
      username: a.username,
      displayName: '林小雪',
      jobTitle: '财务经理',
      responsibilities: '预算管理',
      expectedVersion: p.version,
    });
    expect((await resolve()).promptSnapshot.organizationContext).toEqual(
      first.promptSnapshot.organizationContext,
    );
    const nextSession = await createChatSession(a.context, {
      workspaceId: f.defaultWorkspaceId,
      title: '新预算',
    });
    const next = await sendChatMessage(
      a.context,
      f.defaultWorkspaceId,
      nextSession.id,
      { text: '整理预算', clientMessageId: randomUUID() },
    );
    const fresh = await resolveEmployeeExecution({
      organizationId: f.organizationId,
      workspaceId: f.defaultWorkspaceId,
      ownerId: a.userId,
      runId: next.run.id,
    });
    expect(fresh.promptSnapshot.organizationContext).toMatchObject({
      companyName: '星米集团',
      displayName: '林小雪',
      jobTitle: '财务经理',
      responsibilities: '预算管理',
    });
    const kernel = assembleEmployeeKernel({
      employeeAssignmentId: nextSession.employeeAssignmentId!,
      employeeVersionId: nextSession.employeeVersionId!,
      sessionId: nextSession.id,
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      resolved: fresh,
    });
    expect(kernel.harness).toBe('dsh');
    expect(kernel.systemInstructions).toContain('财务经理');
    expect(kernel.systemInstructions).not.toContain('销售');
    const removed = await f.change('exclude', selected(a.userId));
    expect(removed.cancellationRequestedCount).toBe(2);
    expect(
      (await getChatSessionHistory(a.context, f.defaultWorkspaceId, session.id))
        .session.id,
    ).toBe(session.id);
    await expect(
      sendChatMessage(a.context, f.defaultWorkspaceId, session.id, {
        text: '不能执行',
        clientMessageId: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(
      (await getEmployeeWorkspace(b.context, f.defaultWorkspaceId)).employees,
    ).toHaveLength(1);
    expect((await resolve()).promptSnapshot.organizationContext).toEqual(
      first.promptSnapshot.organizationContext,
    );
    await f.change('include', selected(a.userId));
    const canceled =
      await fixture.db`select cancel_requested_at from allrice_jobs where run_id in ${fixture.db([sent.run.id, next.run.id])}`;
    expect(canceled).toHaveLength(2);
    expect(canceled.every((row) => row.cancel_requested_at)).toBe(true);
  });
  it('rejects foreign people, ordinary users and stale concurrent changes', async () => {
    const f = await setup(),
      a = await f.person('甲'),
      other = await setup(),
      b = await other.person('乙');
    const e = await f.entry(),
      input = {
        workspaceId: f.defaultWorkspaceId,
        employeeId: e.employeeId,
        revisionId: e.revisionId,
        expectedVersion: null,
        action: 'include',
        target: selected(a.userId),
      };
    await expect(
      changeOrganizationAiAssignments(a.context, f.organizationId, input),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(f.change('include', selected(b.userId))).rejects.toMatchObject(
      { code: 'not_found' },
    );
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        changeOrganizationAiAssignments(admin, f.organizationId, input),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'employee_changed' },
    });
    expect((await f.entry()).targetAssignedCount).toBe(1);
  });
});
