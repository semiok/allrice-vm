import {
  RequestContextSchema,
  UuidSchema,
  sameDEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import {
  DataAccessError,
  EmployeeInstanceError,
  IdentityError,
  getDEntryNativeRootPin,
  requireCurrentWorkspaceWriteAuthority,
} from '@allrice/database';
import { EgressError, type EgressAuthority } from '@allrice/egress-gateway';
import {
  ModelGatewayError,
  type ModelCallBinding,
  type ModelGatewayAuthority,
} from '@allrice/model-gateway';
import {
  PersonVmError,
  sameVmBinding,
  type PersonVmBinding,
} from '@allrice/person-vm';
import { webSearchRoute } from './production-web-search.js';
import type { AssignedNativeWebCatalog } from '../native-web/composition.js';

type Catalog = Omit<AssignedNativeWebCatalog, 'owner'> & {
  owner: Pick<AssignedNativeWebCatalog['owner'], 'controlReady'>;
};

const denied = () => new EgressError('DENIED');
const stale = () => new EgressError('STALE_BINDING');

/** The local VM ticket cannot select a login, employee or read-route policy.
 * Only the managed model service supplies an exact operation to this owner. */
export function createProductionEgressAuthority(input: {
  startup: {
    catalog(binding: PersonVmBinding, employeeInstanceId: string): Catalog;
  };
  modelAuthority: Pick<ModelGatewayAuthority, 'assertCall'>;
  modelRoute:
    | Pick<ModelCallBinding, 'provider' | 'model'>
    | ((call: ModelCallBinding) => boolean);
  lifetime: AbortSignal;
}) {
  const route = input.modelRoute;
  if (typeof route !== 'function' && (!route.provider || !route.model))
    throw new EgressError('POLICY_INVALID');
  const matchesRoute =
    typeof route === 'function'
      ? route
      : (call: ModelCallBinding) =>
          call.provider === route.provider && call.model === route.model;
  input.lifetime.throwIfAborted();
  const resolved = new WeakMap<
    RequestContext,
    {
      call: ModelCallBinding;
      signal: AbortSignal;
      route: 'model' | 'model-reference';
    } | null
  >();

  const webSearches = new WeakMap<
    RequestContext,
    {
      binding: PersonVmBinding;
      signal: AbortSignal;
      assertCurrent(signal: AbortSignal): Promise<void>;
    }
  >();

  const authority: EgressAuthority = {
    async context(_binding, signal) {
      input.lifetime.throwIfAborted();
      signal.throwIfAborted();
      throw denied();
    },
    async allow(context, binding, routeId, signal) {
      input.lifetime.throwIfAborted();
      signal.throwIfAborted();
      if (routeId === webSearchRoute) {
        const search = webSearches.get(context);
        webSearches.delete(context);
        if (
          !search ||
          search.signal !== signal ||
          !sameVmBinding(search.binding, binding)
        )
          throw denied();
        await search.assertCurrent(signal);
        signal.throwIfAborted();
        return;
      }
      const request = resolved.get(context);
      if (!request || request.route !== routeId || request.signal !== signal)
        throw denied();
      resolved.set(context, null);
      const { call } = request;
      if (!sameVmBinding(call.vm, binding)) throw stale();

      try {
        // Gateway already checks the shared VM admission binding. The startup
        // catalog supplies the profile this exact epoch actually published.
        const selected = input.startup.catalog(
          binding,
          call.employeeInstanceId,
        );
        const active = AbortSignal.any([
          input.lifetime,
          signal,
          selected.revoked,
        ]);
        active.throwIfAborted();
        const { endpoint } = selected;
        if (
          !sameVmBinding(selected.receipt.binding, binding) ||
          endpoint.employeeInstanceId !== call.employeeInstanceId ||
          (context.workspaceId !== null &&
            context.workspaceId !== endpoint.workspaceId) ||
          !selected.owner.controlReady()
        )
          throw denied();
        const selection = {
          workspaceId: endpoint.workspaceId,
          employeeInstanceId: endpoint.employeeInstanceId,
          threadId: call.allriceThreadRef,
        };
        const pin = await getDEntryNativeRootPin(context, selection);
        active.throwIfAborted();
        if (
          pin.vmId !== binding.vmId ||
          pin.rootNativeSessionId !== call.native.rootSessionId ||
          !sameDEntryIdentity(pin.identity, {
            ...selection,
            personId: binding.personId,
            organizationId: binding.organizationId,
            employeeRevision: endpoint.employeeRevision,
            employeeVersionId: endpoint.employeeVersionId,
          })
        )
          throw denied();

        // The existing model owner checks the actual Run, native ancestry,
        // employee/gateway release and configured route on this same call.
        await input.modelAuthority.assertCall(call, active);
        active.throwIfAborted();
        await requireCurrentWorkspaceWriteAuthority(
          context,
          selection.workspaceId,
        );
        active.throwIfAborted();
        const current = input.startup.catalog(binding, call.employeeInstanceId);
        current.revoked.throwIfAborted();
        if (
          current.receipt !== selected.receipt ||
          current.endpoint !== endpoint ||
          current.owner !== selected.owner ||
          current.bindingRef !== selected.bindingRef ||
          !current.owner.controlReady()
        )
          throw stale();
      } catch (error) {
        if (error instanceof PersonVmError && error.code === 'LEASE_LOST')
          throw stale();
        if (
          (error instanceof DataAccessError &&
            (error.code === 'authorization_denied' ||
              error.code === 'authentication_required' ||
              error.code === 'not_found')) ||
          (error instanceof IdentityError &&
            error.code === 'authorization_denied') ||
          (error instanceof EmployeeInstanceError &&
            error.code === 'instance_archived') ||
          (error instanceof ModelGatewayError &&
            (error.code === 'AUTHORIZATION_DENIED' ||
              error.code === 'BINDING_INVALID'))
        )
          throw denied();
        throw error;
      }
    },
  };

  return Object.freeze({
    authority: Object.freeze(authority),
    bindWebSearch(
      context: RequestContext,
      binding: PersonVmBinding,
      signal: AbortSignal,
      assertCurrent: (signal: AbortSignal) => Promise<void>,
    ) {
      input.lifetime.throwIfAborted();
      signal.throwIfAborted();
      if (
        webSearches.has(context) ||
        context.actor.type !== 'user' ||
        context.actor.id !== binding.personId ||
        context.organizationId !== binding.organizationId
      )
        throw denied();
      webSearches.set(context, { binding, signal, assertCurrent });
    },
    /** Register the private clone owned by ManagedHostService.resolve. Gateway
     * passes its exact context and service signal to allow before dispatch.
     * The weak association carries no permit and is consumed before I/O. */
    bindModelCall(
      call: ModelCallBinding,
      signal: AbortSignal,
      route: 'model' | 'model-reference' = 'model',
    ) {
      input.lifetime.throwIfAborted();
      signal.throwIfAborted();
      const { context } = call;
      if (
        resolved.has(context) ||
        !RequestContextSchema.safeParse(context).success ||
        context.actor.type !== 'user' ||
        context.actor.id !== call.vm.personId ||
        context.organizationId !== call.vm.organizationId ||
        call.executionGeneration !== '4.0' ||
        !matchesRoute(call) ||
        !UuidSchema.safeParse(call.employeeInstanceId).success ||
        !UuidSchema.safeParse(call.allriceThreadRef).success
      )
        throw denied();
      Object.freeze(context.actor);
      for (const membership of context.memberships) Object.freeze(membership);
      Object.freeze(context.memberships);
      Object.freeze(context);
      Object.freeze(call.vm);
      Object.freeze(call.execution);
      Object.freeze(call.native);
      Object.freeze(call);
      resolved.set(context, { call, signal, route });
    },
  });
}
