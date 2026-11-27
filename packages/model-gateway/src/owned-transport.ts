import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import { ModelGatewayError, type GatewayProvider } from './contract.ts';

/** Dedicated pool for the exact model Host. A worker or VM shutdown alone
 * cannot prove these sockets joined. Only this dispatcher's destroy can. */
export function createOwnedModelTransport(ownerId: string) {
  const dispatcher = new Agent({ allowH2: false });
  let closing: Promise<void> | undefined;
  let evidence: string | undefined;
  const fetchOwned: NonNullable<GatewayProvider['fetchOwned']> = (
    fetch,
    request,
    init,
  ) => {
    if (closing) throw new ModelGatewayError('ADMISSION_CLOSED');
    const owned = { ...init, dispatcher };
    return fetch(request, owned);
  };
  return {
    fetchOwned,
    close() {
      return (closing ??= Promise.resolve().then(async () => {
        await dispatcher.destroy();
        evidence = `undici-owner-stopped:${ownerId}:${randomUUID()}`;
      }));
    },
    async confirmClosed() {
      const join = closing;
      if (!join) return false;
      return join.then(
        () => evidence !== undefined,
        () => false,
      );
    },
    async stoppedEvidence(candidate: string, signal: AbortSignal) {
      signal.throwIfAborted();
      if (candidate !== ownerId || !closing)
        throw new ModelGatewayError('AUTHORIZATION_DENIED');
      await closing;
      signal.throwIfAborted();
      if (!evidence) throw new ModelGatewayError('AUTHORIZATION_DENIED');
      return evidence;
    },
  };
}
