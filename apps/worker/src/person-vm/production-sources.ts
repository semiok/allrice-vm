import {
  createNativeModelCallReferences,
  ModelGatewayError,
  sameModelRoute,
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
import {
  createProductionModelRouting,
  type ProductionModelRouting,
} from './production-model-routing.js';
import type { ProductionPersonVmHostSources } from './production-host.js';

type HostInput = Parameters<ProductionPersonVmHostSources['bind']>[0];
type ModelRuntime = ProductionModelRouting['fallback'];
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
      route: ModelRuntime['route'];
      routeRevoked: AbortSignal;
      readModelInfo: ModelRuntime['readModelInfo'];
      assertRouteCurrent: ModelRuntime['assertCurrent'];
      confirmTransportStopped: ModelRuntime['confirmTransportStopped'];
      scoped?: Pick<
        ProductionModelRouting,
        'select' | 'assertCurrent' | 'guestCatalog' | 'applies'
      >;
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
      const routing = await createProductionModelRouting(
        lifetime,
        host.modelOwnerId,
        (...args) => {
          if (!native?.readModelImage)
            throw new ModelGatewayError('AUTHORIZATION_DENIED');
          return native.readModelImage(...args);
        },
      );
      const modelRuntime = routing.fallback;
      const modelLifetime = routing.scoped ? lifetime : modelRuntime.revoked;
      const authority = execution.authority;
      const calls = createNativeModelCallReferences(authority, modelLifetime);
      let entry: ReturnType<typeof installProductionDEntrySource> | undefined;
      try {
        const egress = createProductionEgressAuthority({
          startup,
          modelAuthority: authority,
          modelRoute: routing.scoped
            ? (call) =>
                sameModelRoute(call, routing.select(call.vm, call.native))
            : modelRuntime.route,
          lifetime,
        });
        native = await execution.attach(host, {
          route: modelRuntime.route,
          routeRevoked: modelLifetime,
          readModelInfo: modelRuntime.readModelInfo,
          assertRouteCurrent: modelRuntime.assertCurrent,
          confirmTransportStopped: routing.confirmTransportStopped,
          scoped: routing.scoped ? routing : undefined,
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
            const active = AbortSignal.any([lifetime, modelLifetime, signal]);
            const configured = routing.applies(input.binding);
            const generation = configured
              ? modelLifetime
              : await modelRuntime.assertCurrent(active);
            const guest = await owned.resolveSendRoute(input, active);
            if (!configured) await modelRuntime.assertCurrent(active);
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
              if (!routing.applies(binding))
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
            close: routing.close,
          },
          model: {
            authority,
            llm: modelRuntime.llm,
            route: modelRuntime.route,
            transport: modelRuntime.transport,
            scopeStream: modelRuntime.scopeStream,
            ...(routing.scoped
              ? {
                  selectProvider: routing.provider,
                  closeTransport: routing.close,
                  confirmTransportStopped: routing.confirmTransportStopped,
                }
              : {}),
            async resolveCall(headers, binding, signal) {
              const call = await calls.resolveCall(headers, binding, signal);
              await routing.assertCurrent(call, signal);
              owned.redeem?.(call, signal);
              return call;
            },
          },
        };
      } catch (error) {
        const failures = await closeSources([
          () => entry?.close(),
          () => native?.close(),
          routing.close,
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
