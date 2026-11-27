/** Disposable PostgreSQL fixture for quality native tests only; no provider,
 * preview executor, shared account, or production entrypoint imports this file. */
import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createCompletedRunFixture } from './completed-run.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import { publishTestPlatformQualityEmployee } from './platform-quality-employee.fixture.ts';

export async function createPlatformQualityNativeFixture() {
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', `sha256:${'a'.repeat(64)}`);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', `sha256:${'a'.repeat(64)}`);
  vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
  vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
  vi.stubEnv('ALLRICE_ENV', 'development');
  vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
  for (const feature of [
    'RUNTIME_POLICY',
    'BRIDGE_OPERATION_LEDGER',
    'LOCAL_COMMAND',
    'CLOUD_RUNNER',
    'BROWSER_CONTROL',
    'WORKBENCH',
  ])
    vi.stubEnv(`ALLRICE_${feature}_ENABLED`, '1');
  const fixture = await createRuntimeFixtureDatabase();
  const databaseSpy = vi
    .spyOn(client, 'getDatabase')
    .mockReturnValue(fixture.db);
  try {
    const { db } = fixture;
    const company = await createCompletedRunFixture(db);
    const principal = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'control-plane',
        workspaceName: 'Control plane',
        email: `native-quality-${randomUUID()}@example.test`,
        displayName: 'Isolated native quality administrator',
        role: 'member',
      },
      db,
    );
    const adminEmail = principal.user.email;
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
    const admin = (await authenticateSession(
      (await createSession(principal.user.id)).token,
    ))!;
    expect(admin.actor.id).toBe(principal.user.id);

    await db`update allrice_model_connections set status='ready' where id='52000000-0000-4000-8000-000000000001'`;
    await db`update allrice_model_providers set enabled=true where provider_key='codex'`;
    await publishTestPlatformQualityEmployee();
    return { ...fixture, company, admin, adminEmail };
  } catch (error) {
    try {
      await fixture.close();
    } finally {
      databaseSpy.mockRestore();
    }
    throw error;
  }
}
