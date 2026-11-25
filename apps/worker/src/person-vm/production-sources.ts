import {
  createNativeModelCallReferences,
  ModelGatewayError,
  type ModelGatewayAuthority,
} from '@allrice/model-gateway';
import type { PersonVmRuntimePort } from '@allrice/person-vm';
import {
  installProductionDEntrySource,
  type ResolveProductionDEntrySendRoute,
} from './production-dentry-source.js';
import { createProductionEgressAuthority } from './production-egress-authority.js';
import { createProductionCodexRuntime } from './production-codex-runtime.js';
import type { ProductionPersonVmHostSources } from './production-host.js';

type HostInput = Parameters<ProductionPersonVmHostSources['bind']>[0];
type CodexRuntime = Awaited<ReturnType<typeof createProductionCodexRuntime>>;
type CallReferences = ReturnType<typeof createNativeModelCallReferences>;

async function closeSources(
  owners: readonly (() => Promise<void> | undefined)[],
) {
  const results = await Promise.allSettled(
    owners.map((close) => Promise.resolve().then(close)),
  );
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
}

/** Trusted execution seam. The implementation owns real Run/call creation,
 * delivery of each call reference to its Guest stream, and installation proof
 * for the exact employee and VM epoch. It cannot come from a browser payload. */
export interface ProductionNativeModelExecution {
  authority: ModelGatewayAuthority;
  attach(
    host: HostInput,
    input: {
      route: CodexRuntime['route'];
      routeRevoked: AbortSignal;
      issueCall: CallReferences['issue'];
    },
  ): Promise<{
    resolveSendRoute: ResolveProductionDEntrySendRoute;
    activity: PersonVmRuntimePort['activity'];
    close(): Promise<void>;
  }>;
}

export function createProductionPersonVmSources(
  execution: ProductionNativeModelExecution,
): ProductionPersonVmHostSources {
  return {
    async bind(host) {
      const { lifetime, startup, admission } = host;
      lifetime.throwIfAborted();
      const codex = await createProductionCodexRuntime(lifetime);
      const authority = execution.authority;
      const calls = createNativeModelCallReferences(authority, codex.revoked);
      let native:
        | Awaited<ReturnType<ProductionNativeModelExecution['attach']>>
        | undefined;
      let entry: ReturnType<typeof installProductionDEntrySource> | undefined;
      try {
        native = await execution.attach(host, {
          route: codex.route,
          routeRevoked: codex.revoked,
          issueCall: calls.issue,
        });
        const owned = native;
        lifetime.throwIfAborted();
        const egress = createProductionEgressAuthority({
          startup,
          modelAuthority: authority,
          modelRoute: codex.route,
          lifetime,
        });
        entry = installProductionDEntrySource({
          startup,
          admission,
          lifetime,
          async resolveSendRoute(input, signal) {
            const active = AbortSignal.any([lifetime, codex.revoked, signal]);
            await codex.assertCurrent(active);
            const guest = await owned.resolveSendRoute(input, active);
            await codex.assertCurrent(active);
            active.throwIfAborted();
            guest.revoked.throwIfAborted();
            if (
              guest.provider !== codex.route.provider ||
              guest.model !== codex.route.model
            )
              throw new ModelGatewayError('BINDING_INVALID');
            return {
              provider: guest.provider,
              model: guest.model,
              revoked: AbortSignal.any([
                guest.revoked,
                codex.revoked,
                lifetime,
              ]),
            };
          },
        });
        const installed = entry;
        lifetime.throwIfAborted();
        return {
          runtime: {
            readiness: installed.readiness,
            activity: owned.activity.bind(owned),
            async close() {
              const failures = await closeSources([
                () => installed.close(),
                () => owned.close(),
              ]);
              if (failures.length)
                throw new AggregateError(
                  failures,
                  'PERSON_VM_RUNTIME_CLOSE_INCOMPLETE',
                );
            },
          },
          egress: {
            authority: egress.authority,
            bindModelCall: egress.bindModelCall,
            policy: { routes: [] },
            close: codex.close,
          },
          model: {
            authority,
            llm: codex.llm,
            route: codex.route,
            resolveCall: calls.resolveCall,
          },
        };
      } catch (error) {
        const failures = await closeSources([
          () => entry?.close(),
          () => native?.close(),
          codex.close,
        ]);
        if (failures.length)
          throw new AggregateError(
            [error, ...failures],
            'PERSON_VM_SOURCES_START_FAILED',
          );
        throw error;
      }
    },
  };
}
