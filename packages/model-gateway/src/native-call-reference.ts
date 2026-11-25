import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { sameVmBinding, type PersonVmBinding } from '@allrice/person-vm';
import {
  isModelCallReference,
  MODEL_CALL_REFERENCE_HEADER,
  MODEL_CALL_RECIPIENT_HEADER,
  ModelGatewayError,
  type ModelCallBinding,
  type ModelGatewayAuthority,
} from './contract.ts';

/** Host-only issuance. The active native dispatch owner supplies the exact
 * call and its lifetime. HTTP can only redeem a reference issued by this owner. */
export function createNativeModelCallReferences(
  authority: Pick<ModelGatewayAuthority, 'assertCall'>,
  lifetime: AbortSignal,
) {
  type Pending = {
    binding: ModelCallBinding;
    recipient?: string;
    remove(): void;
  };
  const pending = new Map<string, Pending>();
  return {
    async issue(
      binding: ModelCallBinding,
      callLifetime: AbortSignal,
      recipient?: string,
    ) {
      if (recipient !== undefined && !isModelCallReference(recipient))
        throw new ModelGatewayError('BINDING_INVALID');
      const active = AbortSignal.any([lifetime, callLifetime]);
      active.throwIfAborted();
      const snapshot = structuredClone(binding);
      await authority.assertCall(structuredClone(snapshot), active);
      active.throwIfAborted();
      const reference = randomBytes(32).toString('base64url');
      const remove = () => {
        pending.delete(reference);
        active.removeEventListener('abort', remove);
      };
      pending.set(reference, { binding: snapshot, recipient, remove });
      active.addEventListener('abort', remove, { once: true });
      return reference;
    },
    async resolveCall(
      headers: Readonly<IncomingHttpHeaders>,
      binding: PersonVmBinding,
      signal: AbortSignal,
    ) {
      lifetime.throwIfAborted();
      signal.throwIfAborted();
      const reference = headers[MODEL_CALL_REFERENCE_HEADER];
      const claim = isModelCallReference(reference)
        ? pending.get(reference)
        : undefined;
      if (!claim || !sameVmBinding(claim.binding.vm, binding))
        throw new ModelGatewayError('AUTHORIZATION_DENIED');
      const recipient = headers[MODEL_CALL_RECIPIENT_HEADER];
      if (
        claim.recipient &&
        (!isModelCallReference(recipient) ||
          !timingSafeEqual(
            Buffer.from(recipient),
            Buffer.from(claim.recipient),
          ))
      )
        throw new ModelGatewayError('AUTHORIZATION_DENIED');
      claim.remove();
      return claim.binding;
    },
  };
}
