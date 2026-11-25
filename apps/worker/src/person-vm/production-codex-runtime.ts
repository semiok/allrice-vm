import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import Llm, { type LlmRuntime } from '@deepseek-ai/dsh-llm';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import { requireEnabledCodexSubscription } from '@allrice/database';
import {
  ModelGatewayError,
  withGatewayAuthTransaction,
  type GatewayFetchClassification,
} from '@allrice/model-gateway';
import { codexSubscriptionHome } from '../codex-subscription-home.js';

const provider = 'openai-codex';
const credential = PiAi.recordKeyFor(provider);

class MeteredCodexCredentials extends LocalCredentials {
  override modifyRecord(
    ...args: Parameters<LocalCredentials['modifyRecord']>
  ): ReturnType<LocalCredentials['modifyRecord']> {
    if (args[0] !== credential)
      return Promise.reject(new ModelGatewayError('AUTHORIZATION_DENIED'));
    // Join the original DSH operation, including writer lock and persistence.
    return withGatewayAuthTransaction(() => super.modifyRecord(...args));
  }
}

function classify(
  input: RequestInfo | URL,
  init?: RequestInit,
): GatewayFetchClassification | null {
  const request = input instanceof Request ? input : undefined;
  if ((init?.method ?? request?.method)?.toUpperCase() !== 'POST') return null;
  const url = URL.parse(request?.url ?? String(input));
  if (!url || url.username || url.password || url.search || url.hash)
    return null;
  if (url.href === 'https://chatgpt.com/backend-api/codex/responses')
    return { kind: 'model', protocol: 'openai-responses' };
  if (url.href === 'https://auth.openai.com/oauth/token')
    return { kind: 'auth-refresh', protocol: 'opaque' };
  return null;
}

/** Host-only owner for the same subscription that the admin authorization
 * broker maintains. A change of slot never retargets this route generation. */
export async function createProductionCodexRuntime(lifetime: AbortSignal) {
  lifetime.throwIfAborted();
  const slot = await requireEnabledCodexSubscription();
  lifetime.throwIfAborted();
  const model =
    process.env.ALLRICE_DSH_CODEX_MODEL ??
    process.env.ALLRICE_CODEX_MODEL ??
    'gpt-6.1-sol';
  if (!model || model.trim() !== model)
    throw new ModelGatewayError('BINDING_INVALID');
  const stopped = new AbortController();
  const revoked = AbortSignal.any([lifetime, stopped.signal]);
  const host = new Context();
  const route = Object.freeze({
    provider,
    model,
    transport: 'sse' as const,
    classify,
  });
  let closing: Promise<void> | undefined;
  function close() {
    stopped.abort(new ModelGatewayError('ADMISSION_CLOSED'));
    return (closing ??= host.fiber.dispose());
  }
  async function assertCurrent(signal?: AbortSignal) {
    const active = signal ? AbortSignal.any([signal, revoked]) : revoked;
    active.throwIfAborted();
    const selected = await requireEnabledCodexSubscription().catch(
      (error: unknown) => {
        stopped.abort(new ModelGatewayError('AUTHORIZATION_DENIED'));
        throw error;
      },
    );
    active.throwIfAborted();
    const record = await host.credentials.describeRecord(credential);
    active.throwIfAborted();
    if (selected !== slot || !record.configured || record.kind !== 'grant') {
      stopped.abort(new ModelGatewayError('AUTHORIZATION_DENIED'));
      active.throwIfAborted();
    }
  }
  try {
    await host.plugin(Llm).await();
    await host
      .plugin(MeteredCodexCredentials, {
        path: join(codexSubscriptionHome(slot), '.credentials.yaml'),
      })
      .await();
    await host
      .plugin(PiAi, {
        providers: {
          [provider]: { transport: 'sse', models: [{ id: model }] },
        },
      })
      .await();
    await assertCurrent();
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'CODEX_RUNTIME_CLOSE_UNKNOWN');
    }
    throw error;
  }
  const llm: Pick<LlmRuntime, 'prepareCall'> = {
    async prepareCall(config, signal) {
      if (config.provider !== provider || config.model !== model)
        throw new ModelGatewayError('BINDING_INVALID');
      await assertCurrent(signal);
      const operation = signal ? AbortSignal.any([signal, revoked]) : revoked;
      const prepared = await host.llm.prepareCall(config, operation);
      operation.throwIfAborted();
      return {
        ...prepared,
        async *stream(options) {
          const active = options.signal
            ? AbortSignal.any([operation, options.signal])
            : operation;
          await assertCurrent(active);
          yield* prepared.stream({ ...options, signal: active });
        },
      };
    },
  };
  return Object.freeze({ llm, route, revoked, assertCurrent, close });
}
