import { describe, expect, it } from 'vitest';
import { API_REMOTE_FORWARDED_EVENTS } from '@deepseek-ai/dsh-api-remotes';
import { pageEventRoles, projectSessions } from '../src/policy.js';
import { DEntryPrincipalIssueSchema } from '../src/types.js';
import { issue, summary } from './host-fixture.js';

it('projects native page notification roles for inventory and inspection while keeping managed events and answers sealed', () => {
  const { global, session } = pageEventRoles(API_REMOTE_FORWARDED_EVENTS);
  expect(global.actions).toEqual(
    expect.arrayContaining([
      'event:plugin-manager/changed',
      'event:cordis/dynamic-package',
      'event:cordis/inspect-query',
    ]),
  );
  expect(session.actions).toContain('event:api-session/status');
  expect(global.actions).not.toContain('event:api-session/status');
  for (const action of [
    'event:approval/request',
    'event:user-questions/request',
    'event:cordis/request-run',
    'event:cordis/request-run-resolved',
    'event:plugin-manager/install-state',
    'event:plugin-manager/install-log',
    'event:credentials/record-updated',
    'event:deepseek-account/session-expired',
  ]) {
    expect(global.actions).not.toContain(action);
    expect(session.actions).not.toContain(action);
  }
});

describe('native resource projection is bounded by the original root and access', () => {
  it('projects actual descendant ancestry, never a sibling, missing parent or cyclic browser-selected root', () => {
    const selected = issue('execute');
    const rows = [
      summary('root'),
      summary('child', 'root'),
      summary('grandchild', 'child'),
      { ...summary('fork'), parentSessionId: summary('root').sessionId },
      summary('fork-child', 'fork'),
      summary('other'),
      summary('orphan', 'absent'),
      summary('cycle-a', 'cycle-b'),
      summary('cycle-b', 'cycle-a'),
    ];
    const values = projectSessions(selected, rows);
    expect(
      values
        .filter((binding) => binding.role.actions.includes('session/page'))
        .map((binding) => binding.resource),
    ).toEqual([
      { kind: 'session', id: 'root' },
      { kind: 'session', id: 'child' },
      { kind: 'session', id: 'grandchild' },
    ]);
    expect(
      values
        .filter((binding) => binding.role.actions.includes('session/prompt'))
        .map((binding) => binding.resource),
    ).toEqual([{ kind: 'session', id: 'root' }]);
    expect(
      values.some(
        (binding) =>
          binding.resource.kind === 'global' ||
          binding.role.actions.some((action) => action.startsWith('event:')),
      ),
    ).toBe(false);
    const forkIssue = {
      ...selected,
      root: {
        ...selected.root,
        nativeSessionId: 'fork',
        forkedFromNativeSessionId: 'root',
      },
    };
    expect(
      projectSessions(forkIssue, rows)
        .filter((binding) => binding.role.actions.includes('session/page'))
        .map((binding) => binding.resource),
    ).toEqual([
      { kind: 'session', id: 'fork' },
      { kind: 'session', id: 'fork-child' },
    ]);
  });
  it('history/read projection cannot imply send, VM ownership, global list or control authority', () => {
    const values = projectSessions(issue('history'), [
      summary('root'),
      summary('child', 'root'),
    ]);
    for (const action of ['session/prompt', 'session/list', 'session/control'])
      expect(values.flatMap((binding) => binding.role.actions)).not.toContain(
        action,
      );
    expect(values).toHaveLength(2);
  });
  it('rejects duplicate IDs, a child selected as root and a root missing from the real catalog', () => {
    expect(() =>
      projectSessions(issue(), [summary('root'), summary('root')]),
    ).toThrow('PRINCIPAL_CATALOG_INVALID');
    expect(() =>
      projectSessions(issue(), [summary('root', 'another')]),
    ).toThrow('PRINCIPAL_ROOT_INVALID');
    expect(() => projectSessions(issue(), [summary('another')])).toThrow(
      'PRINCIPAL_ROOT_INVALID',
    );
  });
  it('retains the original UUID/identity strict contract rather than accepting grants or a client principal', () => {
    const selected = issue();
    expect(() =>
      DEntryPrincipalIssueSchema.parse({ ...selected, grants: [] }),
    ).toThrow();
    expect(() =>
      DEntryPrincipalIssueSchema.parse({
        ...selected,
        identity: { ...selected.identity, owner: true },
      }),
    ).toThrow();
    expect(() =>
      DEntryPrincipalIssueSchema.parse({
        ...selected,
        scopeId: 'opaque-browser-scope',
      }),
    ).toThrow();
  });
});
