import { sameDEntryIdentity } from '@allrice/contracts';
import type {
  RemoteAccessBinding,
  RemoteAccessPolicy,
  RemoteAccessRole,
} from '@deepseek-ai/dsh-api-remote-access';
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types';
import type { DEntryPrincipal, DEntryPrincipalIssue } from './types.js';

export { DEntryPrincipalIssueSchema as issueSchema } from './types.js';
export const readEndpoints = [
  'session/attachment',
  'session/page',
  'session/follow',
  'session/projections',
  'skills/list',
] as const;
export const writeEndpoints = [
  'session/prompt',
  'session/updateQueue',
  'session/cancel',
  'session/rename',
  'session/selectModel',
] as const;
const readRole: RemoteAccessRole<'session'> = {
  name: 'allrice-current-session-read',
  resource: 'session',
  actions: readEndpoints,
};
const editorCatalogActions = ['session/list', 'session/control'] as const;
const editorReadRole: RemoteAccessRole<'session'> = {
  ...readRole,
  actions: [...readEndpoints, ...editorCatalogActions],
};
// rc.2 enters these argumentless catalog methods on the global resource,
// then checks the same action on each returned session. Keep this entry
// permission out of browser snapshots, which are evaluated without args.
const editorCatalogEntry: Extract<
  RemoteAccessBinding,
  { resource: { kind: 'global' } }
> = {
  role: {
    name: 'allrice-editor-catalog-entry',
    resource: 'global',
    actions: editorCatalogActions,
  },
  resource: { kind: 'global' },
  condition: ({ args }) =>
    args === undefined
      ? { kind: 'deny', reason: 'call-required' }
      : { kind: 'allow' },
};
// The guest event relay projects this native notification down to locale.
const localeEvents: RemoteAccessBinding = {
  resource: { kind: 'global' },
  role: {
    name: 'allrice-employee-locale-events',
    resource: 'global',
    actions: ['event:settings/document-updated'],
  },
};
const writeRole: RemoteAccessRole<'session'> = {
  name: 'allrice-current-root-write',
  resource: 'session',
  actions: writeEndpoints,
};
export interface Projection {
  readonly issue: DEntryPrincipalIssue;
  readonly parent: PeerScope;
  active: boolean;
  bindings: readonly RemoteAccessBinding[];
}
export function principalPolicy(
  scopes: ReadonlyMap<string, Projection>,
): RemoteAccessPolicy<DEntryPrincipal> {
  return {
    bindings(principal) {
      const value = scopes.get(principal.scopeId);
      if (
        !value?.active ||
        value.parent.signal.aborted ||
        !sameDEntryIdentity(value.issue.identity, principal.identity)
      )
        return [];
      return value.issue.access === 'execute'
        ? [...value.bindings, editorCatalogEntry, localeEvents]
        : [...value.bindings, localeEvents];
    },
  };
}
/** Native summaries, not browser child flags, establish this projection. SQL pin
 * and admission remain outside the guest and are never replaced by these rows. */
export function projectSessions(
  issue: DEntryPrincipalIssue,
  items: readonly SessionSummary[],
): readonly RemoteAccessBinding[] {
  const entries = new Map(
    items.map((entry) => [String(entry.sessionId), entry]),
  );
  if (entries.size !== items.length) throw Error('PRINCIPAL_CATALOG_INVALID');
  const root = entries.get(issue.root.nativeSessionId);
  if (!root || root.parentSessionId || root.origin === 'subagent')
    throw Error('PRINCIPAL_ROOT_INVALID');
  const bindings: RemoteAccessBinding[] = [];
  for (const entry of items) {
    let cursor = entry;
    const seen = new Set<string>();
    while (String(cursor.sessionId) !== issue.root.nativeSessionId) {
      if (seen.has(String(cursor.sessionId)) || !cursor.parentSessionId) break;
      seen.add(String(cursor.sessionId));
      const next = entries.get(String(cursor.parentSessionId));
      if (!next) break;
      cursor = next;
    }
    if (String(cursor.sessionId) !== issue.root.nativeSessionId) continue;
    bindings.push({
      role: issue.access === 'execute' ? editorReadRole : readRole,
      resource: { kind: 'session', id: entry.sessionId },
    });
    if (entry === root && issue.access === 'execute')
      bindings.push({
        role: writeRole,
        resource: { kind: 'session', id: entry.sessionId },
      });
  }
  return bindings;
}
