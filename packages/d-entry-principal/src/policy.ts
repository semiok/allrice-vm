import { sameDEntryIdentity } from '@allrice/contracts';
import type {
  RemoteAccessBinding,
  RemoteAccessPolicy,
  RemoteAccessRole,
} from '@deepseek-ai/dsh-api-remote-access';
import type {
  InvocationDescriptor,
  PeerScope,
} from '@deepseek-ai/dsh-typert-protocol';
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types';
import type {
  DEntryPrincipal,
  DEntryPrincipalIssue,
  DEntryScopeIssue,
} from './types.js';
import { pageEndpoint, requirePageNativeMethod } from './page-native-method.js';
import { isManagedPageEvent } from './page-capability-policy.js';

export { DEntryScopeIssueSchema as issueSchema } from './types.js';
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
  readonly issue: DEntryScopeIssue;
  readonly parent: PeerScope;
  active: boolean;
  bindings: readonly RemoteAccessBinding[];
  eventBindings?: readonly RemoteAccessBinding[];
}

/** Adapt the native Host forwarding declaration to exact DSH action names. */
export function pageEventRoles(
  descriptors: readonly {
    event: string;
    mode: string;
    resources?: Readonly<Record<string, unknown>>;
  }[],
) {
  const global = {
    name: 'allrice-page-events',
    resource: 'global',
    actions: [] as `event:${string}`[],
  } as const satisfies RemoteAccessRole<'global'>;
  const session = {
    name: 'allrice-page-session-events',
    resource: 'session',
    actions: [] as `event:${string}`[],
  } as const satisfies RemoteAccessRole<'session'>;
  for (const descriptor of descriptors) {
    if (descriptor.mode !== 'emit' || isManagedPageEvent(descriptor.event))
      continue;
    const resources = Object.keys(descriptor.resources ?? {});
    if (resources.length === 0)
      global.actions.push(`event:${descriptor.event}`);
    if (resources.length === 1 && resources[0] === 'session')
      session.actions.push(`event:${descriptor.event}`);
  }
  return { global, session };
}

/** Only child-origin edges participate in an existing thread's ancestry. */
export function nativeSessionRoot(
  entries: ReadonlyMap<string, SessionSummary>,
  sessionId: string,
) {
  let entry = entries.get(sessionId);
  const seen = new Set<string>();
  while (entry?.origin === 'subagent') {
    if (!entry.parentSessionId || seen.has(entry.sessionId)) return;
    seen.add(entry.sessionId);
    entry = entries.get(entry.parentSessionId);
  }
  return entry;
}

/** Native snapshots still describe a non-owner Peer. Page Session actions
 * come from the same generated registry and policy as page dispatch. */
export function projectPageSessions(
  items: readonly SessionSummary[],
  descriptors: readonly InvocationDescriptor[],
): readonly RemoteAccessBinding[] {
  const actions = descriptors.flatMap((method) => {
    if (method.namespace !== 'session' && method.namespace !== 'skills')
      return [];
    const endpoint = pageEndpoint(method);
    try {
      requirePageNativeMethod(
        { get: () => method },
        endpoint,
        method.mode ?? 'unary',
        {},
        undefined,
      );
      return [endpoint];
    } catch {
      return [];
    }
  });
  const role: RemoteAccessRole<'session'> = {
    name: 'allrice-current-vm-session',
    resource: 'session',
    actions,
  };
  const bindings: RemoteAccessBinding[] = items.map(({ sessionId }) => ({
    role,
    resource: { kind: 'session', id: sessionId },
  }));
  if (
    descriptors.some((method) => pageEndpoint(method) === 'subagents/prompt')
  ) {
    const entries = new Map(
      items.map((item) => [String(item.sessionId), item]),
    );
    const grant: Extract<
      RemoteAccessBinding,
      { resource: { kind: 'global' } }
    > = {
      role: {
        name: 'allrice-current-vm-child-prompt',
        resource: 'global',
        actions: ['subagents/prompt'],
      },
      resource: { kind: 'global' },
      condition: ({ args }) => {
        const request = args?.request;
        if (
          entries.size === items.length &&
          request &&
          typeof request === 'object' &&
          'childSessionId' in request &&
          typeof request.childSessionId === 'string' &&
          'parentSessionId' in request &&
          typeof request.parentSessionId === 'string'
        ) {
          const parent = entries.get(request.parentSessionId);
          const child = entries.get(request.childSessionId);
          if (
            parent?.agentAvailable &&
            child?.origin === 'subagent' &&
            child.parentSessionId === parent.sessionId
          )
            return { kind: 'allow' };
        }
        return { kind: 'deny', reason: 'child-address-required' };
      },
    };
    bindings.push(grant);
  }
  return bindings;
}
export function principalPolicy(
  scopes: ReadonlyMap<string, Projection>,
): RemoteAccessPolicy<DEntryPrincipal> {
  return {
    bindings(principal) {
      const value = scopes.get(principal.scopeId);
      if (
        !value ||
        value.parent.signal.aborted ||
        !sameDEntryIdentity(value.issue.identity, principal.identity)
      )
        return [];
      if (value.issue.access === 'page') {
        const events = value.eventBindings ?? [];
        return value.active ? [...value.bindings, ...events] : events;
      }
      if (!value.active) return [];
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
  if (
    !root ||
    root.parentSessionId !== issue.root.forkedFromNativeSessionId ||
    root.origin === 'subagent'
  )
    throw Error('PRINCIPAL_ROOT_INVALID');
  const bindings: RemoteAccessBinding[] = [];
  for (const entry of items) {
    if (nativeSessionRoot(entries, entry.sessionId) !== root) continue;
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
