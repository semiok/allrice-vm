import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DSH_INSTALLED_DISTRIBUTION } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import {
  compilePlatformEmployee,
  createPlatformEmployeeDraft,
  getPlatformEmployee,
  listPlatformEmployees,
  publishPlatformEmployee,
  savePlatformEmployeeDraft,
} from './employees/platform-employees.ts';
import { reviewEmployeePublication } from './employee-administration.ts';
import {
  changeAdminTenantEmployee,
  listAdminTenantEmployees,
} from './tenant-employees.ts';
import { listOrganizationAiAssignments } from './organization-employee-assignments.ts';
import { readPlatformEmployeeHistoryRevision } from './platform-employee-history.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('an empty employee catalog in a freshly migrated database', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    vi.stubEnv('ALLRICE_ENV', 'development');
  }, 60_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await f?.close();
  });

  it('creates, publishes and assigns an employee only after an explicit admin action', async () => {
    const principal = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug: `seed-${randomUUID()}`,
        organizationName: 'Seed regression',
        workspaceSlug: 'default',
        workspaceName: 'Seed regression',
        email: `seed-${randomUUID()}@example.test`,
        displayName: 'Seed admin',
        role: 'admin',
      },
      f.db,
    );
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', principal.user.email);
    const context = (await authenticateSession(
      (await createSession(principal.user.id)).token,
      {
        organizationId: principal.organizationId,
        workspaceId: principal.workspaceId,
      },
    ))!;
    expect(await listPlatformEmployees()).toEqual([]);
    const created = await createPlatformEmployeeDraft(
      { key: 'test-employee', name: 'Test employee' },
      principal.user.id,
    );
    const employeeId = created!.id;
    const initial = created!.currentDraft!;
    expect(initial).toMatchObject({ revision: 1, runtimeProfile: null });
    expect(created!.currentPublished).toBeNull();
    expect(initial.definition.capabilities.toolNames).toEqual([]);
    const detail = (await getPlatformEmployee(employeeId))!;
    expect(detail.currentDraft).toEqual(initial);
    expect(
      await readPlatformEmployeeHistoryRevision(
        context,
        employeeId,
        initial.id,
      ),
    ).toMatchObject({ checksum: initial.checksum, runtimeProfile: null });
    const list = () =>
      listAdminTenantEmployees(
        context,
        principal.organizationId,
        principal.workspaceId,
      );
    expect((await list()).employees).toEqual([]);
    expect(
      (
        await listOrganizationAiAssignments(
          context,
          principal.organizationId,
          principal.workspaceId,
        )
      ).employees,
    ).toEqual([]);

    const definition = {
      ...initial.definition,
      description: 'Explicitly configured test employee',
    };
    const saved = await savePlatformEmployeeDraft(employeeId, {
      definition,
      expectedRevisionId: detail.currentDraft?.id ?? null,
    });
    // The HTTP PUT route compiles after saving, as does the review/publication path.
    expect((await compilePlatformEmployee(employeeId)).errors).toEqual([]);
    const review = await reviewEmployeePublication(context, employeeId);
    expect(review.errors).toEqual([]);
    const published = await publishPlatformEmployee(
      employeeId,
      {
        scope: 'assigned',
        expectedRevisionId: review.revisionId,
        expectedPublishedRevisionId: review.publishedRevisionId,
        expectedPackageChecksum: review.packageChecksum,
        policyVersions: review.policyVersions,
      },
      principal.user.id,
      context,
    );
    expect(published.errors).toEqual([]);
    expect(published.revisionId).toBe(saved!.currentDraft!.id);
    expect(published.runtimeProfile?.distributionGeneration).toBe(
      DSH_INSTALLED_DISTRIBUTION.generation,
    );
    expect(
      await changeAdminTenantEmployee(context, principal.organizationId, {
        workspaceId: principal.workspaceId,
        employeeId,
        revisionId: published.revisionId,
        action: 'assign',
        expectedVersion: null,
      }),
    ).toEqual({ changed: true });
    expect(
      (await list()).employees.find((e) => e.employeeId === employeeId),
    ).toMatchObject({
      canAssign: true,
      deployment: { active: true, revisionId: published.revisionId },
    });
    expect(
      await readPlatformEmployeeHistoryRevision(
        context,
        employeeId,
        initial.id,
      ),
    ).toEqual(initial);
  });
});
