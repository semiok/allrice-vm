import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import {
  BUNDLED_SKILL_RANK,
  type SkillProviderControl,
} from '@deepseek-ai/dsh-skill';
import type {
  DEntryScopeIssue,
  PrincipalScopeCommand,
  PrincipalSkillRead,
  PrincipalSkillResult,
  ScopeFrame,
} from './types.js';

type SkillNotice = Extract<ScopeFrame, { type: 'skill-read' | 'skill-cancel' }>;

export class PrincipalSkillClient {
  private readonly reads = new Map<
    string,
    (result: PrincipalSkillResult) => void
  >();
  constructor(
    private readonly scopeId: string,
    private readonly lifetime: AbortSignal,
    private readonly send: (notice: SkillNotice) => void,
    private readonly invalidate: () => void,
  ) {}

  async read(command: PrincipalSkillRead, signal?: AbortSignal) {
    const active = signal
      ? AbortSignal.any([signal, this.lifetime])
      : this.lifetime;
    active.throwIfAborted();
    const id = randomUUID();
    return new Promise<PrincipalSkillResult>((resolve, reject) => {
      const finish = () => {
        this.reads.delete(id);
        active.removeEventListener('abort', cancel);
      };
      const cancel = () => {
        finish();
        if (!this.lifetime.aborted)
          this.send({ type: 'skill-cancel', scopeId: this.scopeId, id });
        reject(active.reason);
      };
      this.reads.set(id, (result) => {
        finish();
        if (active.aborted) reject(active.reason);
        else resolve(result);
      });
      active.addEventListener('abort', cancel, { once: true });
      this.send({
        type: 'skill-read',
        scopeId: this.scopeId,
        id,
        read: command,
      });
    });
  }

  receive(command: Exclude<PrincipalScopeCommand, 'close'>) {
    if (command.type === 'skills-changed') this.invalidate();
    else this.reads.get(command.id)?.(command.result);
  }
}

type Scope = Readonly<{
  issue: DEntryScopeIssue;
  active: boolean;
  abort: AbortController;
  skills: PrincipalSkillClient;
}>;

const opaque = {
  kind: 'opaque' as const,
  description: 'AllRice instruction-only Skill',
};

function sourceScope(message: {
  source: { kind: string };
}): string | undefined {
  const source = message.source;
  if (
    source.kind !== 'user' ||
    !('rpcId' in source) ||
    typeof source.rpcId !== 'string' ||
    !('principal' in source)
  )
    return;
  const principal = source.principal;
  if (
    principal &&
    typeof principal === 'object' &&
    'kind' in principal &&
    principal.kind === 'allrice-d-entry' &&
    'scopeId' in principal &&
    typeof principal.scopeId === 'string'
  )
    return principal.scopeId;
}

/** Preserve the initiating native peer across a queued turn. Never borrow a
 * scope from another login merely because it is available in this process. */
export function installPrincipalSkillProvider(
  ctx: Context,
  scopes: ReadonlyMap<string, Scope>,
) {
  const current = new AsyncLocalStorage<
    { scope: Scope; signal: AbortSignal } | undefined
  >();
  const turns = new WeakMap<Agent, { turn: number; scope: Scope }>();
  let registry: SkillProviderControl | undefined;
  const invalidate = () => registry?.invalidate();
  const bound = (scope: Scope | undefined) =>
    scope?.active &&
    !scope.abort.signal.aborted &&
    scope.issue.access !== 'history'
      ? scope
      : undefined;
  const run = <T>(
    scope: Scope | undefined,
    signal: AbortSignal,
    next: () => T,
  ) => {
    invalidate();
    const accepted = bound(scope);
    return current.run(accepted && { scope: accepted, signal }, next);
  };
  const read = (request: PrincipalSkillRead, signal?: AbortSignal) => {
    const claim = current.getStore();
    if (!claim || !bound(claim.scope)) return;
    return claim.scope.skills.read(
      request,
      signal ? AbortSignal.any([claim.signal, signal]) : claim.signal,
    );
  };
  ctx.inject(['skills', 'agents', 'tools'], (target) => {
    target.effect(() =>
      target.skills.registerProvider((control) => {
        registry = control;
        return {
          name: 'allrice-capabilities',
          async list({ signal }) {
            const result = await read({ kind: 'list' }, signal);
            if (result?.kind !== 'catalog')
              return { candidates: [], complete: false };
            return result.entries.map(
              ({ name, description, revision, ...invocation }) => ({
                name,
                description,
                invocation,
                ...source,
                locator: revision,
                rank: BUNDLED_SKILL_RANK,
              }),
            );
          },
          async get(candidate, { signal }) {
            if (typeof candidate.locator !== 'string') return;
            const result = await read(
              {
                kind: 'body',
                name: candidate.name,
                revision: candidate.locator,
              },
              signal,
            );
            if (result?.kind === 'body') {
              const { name, description, invocation } = candidate;
              return {
                name,
                description,
                invocation,
                ...source,
                content: result.content,
              };
            }
          },
        };
      }),
    );
    target.on('agent/pre-step', ({ agent, messages, turn, signal }, next) => {
      if (turns.get(agent)?.turn !== turn) turns.delete(agent);
      if (messages.length) {
        const inputs = messages.filter(({ source }) => source.kind === 'user');
        const id = inputs[0] && sourceScope(inputs[0]);
        const scope =
          id && inputs.every((message) => sourceScope(message) === id)
            ? bound(scopes.get(id))
            : undefined;
        if (scope) turns.set(agent, { scope, turn });
        else if (inputs.length) turns.delete(agent);
      }
      const claimed = turns.get(agent);
      return run(
        claimed?.turn === turn ? claimed.scope : undefined,
        signal,
        next,
      );
    });
    target.on('tools/execute', (exec, next) => {
      if (exec.name !== 'skill') return next();
      const agent = exec.agent;
      return run(
        agent ? turns.get(agent)?.scope : undefined,
        exec.signal,
        next,
      );
    });
  });
  return { invalidate, run };
}

const source = {
  provider: 'allrice-capabilities',
  source: 'allrice-managed',
  resourceBase: opaque,
};
