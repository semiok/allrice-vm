import {
  createNativeModelCallReferences,
  ModelGatewayError,
  type ModelGatewayAuthority,
} from '@allrice/model-gateway';
import type { PersonVmRuntimePort } from '@allrice/person-vm';
import type { ManagedHostService } from '@allrice/egress-gateway';
import type { ModelCallBinding } from '@allrice/model-gateway';
import type { ReadProductionModelImage } from './production-model-images.js';
import {
  installProductionDEntrySource,
  type ResolveProductionDEntrySendRoute,
} from './production-dentry-source.js';
import { createProductionEgressAuthority } from './production-egress-authority.js';
import { createHostSearchProvider } from './production-web-search.js';
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
      readModelInfo: CodexRuntime['readModelInfo'];
      assertRouteCurrent: CodexRuntime['assertCurrent'];
      confirmTransportStopped: CodexRuntime['confirmTransportStopped'];
      bindReference(call: ModelCallBinding, signal: AbortSignal): void;
      issueCall: CallReferences['issue'];
      webSearch?: {
        provider: NonNullable<ReturnType<typeof createHostSearchProvider>>;
        bind: ReturnType<
          typeof createProductionEgressAuthority
        >['bindWebSearch'];
      };
    },
  ): Promise<{
    resolveSendRoute: ResolveProductionDEntrySendRoute;
    references?: readonly ManagedHostService[];
    readModelImage?: ReadProductionModelImage;
    redeem?(call: ModelCallBinding, signal: AbortSignal): void;
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
      let native:
        | Awaited<ReturnType<ProductionNativeModelExecution['attach']>>
        | undefined;
      const codex = await createProductionCodexRuntime(
        lifetime,
        host.modelOwnerId,
        (...args) => {
          if (!native?.readModelImage)
            throw new ModelGatewayError('AUTHORIZATION_DENIED');
          return native.readModelImage(...args);
        },
      );
      const authority = execution.authority;
      const calls = createNativeModelCallReferences(authority, codex.revoked);
      let entry: ReturnType<typeof installProductionDEntrySource> | undefined;
      try {
        const egress = createProductionEgressAuthority({
          startup,
          modelAuthority: authority,
          modelRoute: codex.route,
          lifetime,
        });
        const provider = createHostSearchProvider(process.env.DEEPSEEK_API_KEY);
        native = await execution.attach(host, {
          route: codex.route,
          routeRevoked: codex.revoked,
          readModelInfo: codex.readModelInfo,
          assertRouteCurrent: codex.assertCurrent,
          confirmTransportStopped: codex.confirmTransportStopped,
          bindReference: (call, signal) =>
            egress.bindModelCall(call, signal, 'model-reference'),
          issueCall: calls.issue,
          ...(provider
            ? { webSearch: { provider, bind: egress.bindWebSearch } }
            : {}),
        });
        const owned = native;
        lifetime.throwIfAborted();
        entry = installProductionDEntrySource({
          startup,
          admission,
          lifetime,
          async resolveSendRoute(input, signal) {
            const active = AbortSignal.any([lifetime, codex.revoked, signal]);
            const generation = await codex.assertCurrent(active);
            const guest = await owned.resolveSendRoute(input, active);
            await codex.assertCurrent(active);
            active.throwIfAborted();
            generation.throwIfAborted();
            guest.revoked.throwIfAborted();
            if (
              guest.provider !== codex.route.provider ||
              guest.model !== codex.route.model
            )
              throw new ModelGatewayError('BINDING_INVALID');
            return {
              provider: guest.provider,
              model: guest.model,
              revoked: AbortSignal.any([guest.revoked, generation, lifetime]),
            };
          },
        });
        const installed = entry;
        lifetime.throwIfAborted();
        return {
          runtime: {
            async readiness(binding, signal) {
              await codex.assertCurrent(signal);
              return installed.readiness(binding, signal);
            },
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
            services: owned.references ?? [],
            close: codex.close,
          },
          model: {
            authority,
            llm: codex.llm,
            route: codex.route,
            transport: codex.transport,
            scopeStream: codex.scopeStream,
            async resolveCall(headers, binding, signal) {
              await codex.assertCurrent(signal);
              const call = await calls.resolveCall(headers, binding, signal);
              owned.redeem?.(call, signal);
              return call;
            },
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
