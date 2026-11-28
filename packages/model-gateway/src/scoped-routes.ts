import type { ModelCallBinding, ModelRouteKey } from './contract.ts';

type AttemptKind = NonNullable<ModelCallBinding['native']['attemptKind']>;

export type ScopedModelRule = ModelRouteKey &
  Readonly<{
    sessionId?: string;
    parentSessionId?: string;
    scope?: 'root' | 'subagent';
    attempt?: AttemptKind;
  }>;

export function sameModelRoute(a: ModelRouteKey, b: ModelRouteKey) {
  return a.provider === b.provider && a.model === b.model;
}

/** Rules are host-approved and in operator precedence order. Guest callers may
 * mirror the choice for native model metadata; only the host authorizes it. */
export function selectScopedModel(
  rules: readonly ScopedModelRule[],
  native: Pick<
    ModelCallBinding['native'],
    'sessionId' | 'parentSessionId' | 'attemptKind'
  >,
  fallback: ModelRouteKey,
): ModelRouteKey {
  const rule = rules.find(
    (rule) =>
      (rule.sessionId === undefined || rule.sessionId === native.sessionId) &&
      (rule.parentSessionId === undefined ||
        rule.parentSessionId === native.parentSessionId) &&
      (rule.scope === undefined ||
        rule.scope ===
          (native.parentSessionId === null ? 'root' : 'subagent')) &&
      (rule.attempt === undefined || rule.attempt === native.attemptKind),
  );
  return rule ? { provider: rule.provider, model: rule.model } : fallback;
}
