/** Explicit template publication in an isolated test database. */
import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import {
  createPlatformEmployeeDraft,
  publishPlatformEmployee,
  savePlatformEmployeeDraft,
} from './employees/platform-employees.ts';

export async function publishTestPlatformQualityEmployee(
  input: {
    key?: string;
    name?: string;
    mission?: string;
    workStyle?: string;
    bridgeAccess?: 'read_only' | 'read_write';
    toolNames?: string[];
  } = {},
) {
  const name = input.name ?? 'Isolated quality employee';
  const created = await createPlatformEmployeeDraft({
    key: input.key ?? 'quality-test-' + randomUUID(),
    name,
  });
  const draft = created?.currentDraft;
  if (!created || !draft) throw Error('Failed to create quality fixture draft');
  const toolNames = input.toolNames ?? [
    'workspace.project',
    'browser.workspace',
    'cloud.process.execute',
  ];
  await savePlatformEmployeeDraft(created.id, {
    definition: {
      ...draft.definition,
      identity: {
        ...draft.definition.identity,
        mission: input.mission ?? draft.definition.identity.mission,
        workStyle: input.workStyle ?? draft.definition.identity.workStyle,
      },
      capabilities: {
        ...draft.definition.capabilities,
        explicitToolNames: toolNames,
        toolNames,
      },
      securityPolicy: {
        ...draft.definition.securityPolicy,
        bridgeAccess: input.bridgeAccess ?? 'read_only',
        connectorIdentityModes: ['user'],
        deniedCapabilities: ['secret:use'],
      },
    },
  });
  const publication = await publishPlatformEmployee(created.id, {
    scope: 'assigned',
  });
  expect(publication.errors).toEqual([]);
  expect(publication.valid).toBe(true);
  vi.stubEnv('ALLRICE_PLATFORM_QUALITY_EMPLOYEE_ID', created.id);
  return created.id;
}
