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
import { createProductionCodexRuntime } from './production-codex-runtime.js';
import { createProductionOpenAiRuntime } from './production-openai-runtime.js';
import type { ProductionPersonVmHostSources } from './production-host.js';

type HostInput = Parameters<ProductionPersonVmHostSources['bind']>[0];
type ModelRuntime = Awaited<ReturnType<typeof createProductionModelRuntime>>;
type CallReferences = ReturnType<typeof createNativeModelCallReferences>;

function createProductionModelRuntime(
  ...args: Parameters<typeof createProductionCodexRuntime>
) {
  switch (process.env.ALLRICE_DSH_MODEL_PROVIDER ?? 'openai-codex') {
    case 'openai-codex':
      return createProductionCodexRuntime(...args);
    case 'openai':
      return createProductionOpenAiRuntime(...args);
    default:
      throw new ModelGatewayError('BINDING_INVALID');
  }
}

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
      route: ModelRuntime['route'];
      routeRevoked: AbortSignal;
      readModelInfo: ModelRuntime['readModelInfo'];
      assertRouteCurrent: ModelRuntime['assertCurrent'];
      confirmTransportStopped: ModelRuntime['confirmTransportStopped'];
      bindReference(call: ModelCallBinding, signal: AbortSignal): void;
      issueCall: CallReferences['issue'];
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
      const modelRuntime = await createProductionModelRuntime(
        lifetime,
        host.modelOwnerId,
        (...args) => {
          if (!native?.readModelImage)
            throw new ModelGatewayError('AUTHORIZATION_DENIED');
          return native.readModelImage(...args);
        },
      );
      const authority = execution.authority;
      const calls = createNativeModelCallReferences(
        authority,
        modelRuntime.revoked,
      );
      let entry: ReturnType<typeof installProductionDEntrySource> | undefined;
      try {
        const egress = createProductionEgressAuthority({
          startup,
          modelAuthority: authority,
          modelRoute: modelRuntime.route,
          lifetime,
        });
        native = await execution.attach(host, {
          route: modelRuntime.route,
          routeRevoked: modelRuntime.revoked,
          readModelInfo: modelRuntime.readModelInfo,
          assertRouteCurrent: modelRuntime.assertCurrent,
          confirmTransportStopped: modelRuntime.confirmTransportStopped,
          bindReference: (call, signal) =>
            egress.bindModelCall(call, signal, 'model-reference'),
          issueCall: calls.issue,
        });
        const owned = native;
        lifetime.throwIfAborted();
        entry = installProductionDEntrySource({
          startup,
          admission,
          lifetime,
          confirmPhysical: (context, identity, binding, active) =>
            host.current.withCurrentSelection(context, identity, active, () =>
              host.vm.assertRunningReadiness(context, binding, active),
            ),
          async resolveSendRoute(input, signal) {
            const active = AbortSignal.any([
              lifetime,
              modelRuntime.revoked,
              signal,
            ]);
            const generation = await modelRuntime.assertCurrent(active);
            const guest = await owned.resolveSendRoute(input, active);
            await modelRuntime.assertCurrent(active);
            active.throwIfAborted();
            generation.throwIfAborted();
            guest.revoked.throwIfAborted();
            if (
              guest.provider !== modelRuntime.route.provider ||
              guest.model !== modelRuntime.route.model
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
              await modelRuntime.assertCurrent(signal);
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
            close: modelRuntime.close,
          },
          model: {
            authority,
            llm: modelRuntime.llm,
            route: modelRuntime.route,
            transport: modelRuntime.transport,
            scopeStream: modelRuntime.scopeStream,
            async resolveCall(headers, binding, signal) {
              await modelRuntime.assertCurrent(signal);
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
          modelRuntime.close,
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
