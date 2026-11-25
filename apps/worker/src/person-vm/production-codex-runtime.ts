import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import Llm, { type LlmRuntime } from '@deepseek-ai/dsh-llm';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import { getDatabase } from '@allrice/database';
import {
  ModelGatewayError,
  createOwnedModelTransport,
  withGatewayAuthTransaction,
  type GatewayFetchClassification,
} from '@allrice/model-gateway';
import {
  createProductionModelImages,
  type ReadProductionModelImage,
} from './production-model-images.js';
import { codexSubscriptionHome } from '../codex-subscription-home.js';

const provider = 'openai-codex';
const credential = PiAi.recordKeyFor(provider);

async function readSelectedSubscription() {
  const [selected] = await getDatabase()<{ slot: 1 | 2; revision: string }[]>`
    select slot, extract(epoch from updated_at)::text as revision
    from allrice_codex_subscriptions where enabled
  `;
  if (!selected) throw new ModelGatewayError('AUTHORIZATION_DENIED');
  return selected;
}

export function managedCodexModel(model: string) {
  if (!['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'].includes(model))
    return { id: model };
  return {
    id: model,
    contextWindow: 272000,
    input: ['text', 'image'] as ('text' | 'image')[],
    reasoningEfforts: {
      low: 'low' as const,
      medium: 'medium' as const,
      high: 'high' as const,
      xhigh: 'xhigh' as const,
    },
  };
}

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
async function openCodexGeneration(
  lifetime: AbortSignal,
  selection: Awaited<ReturnType<typeof readSelectedSubscription>>,
  model: string,
  images: ReturnType<typeof createProductionModelImages> | undefined,
) {
  lifetime.throwIfAborted();
  const modelMetadata = managedCodexModel(model);
  const stopped = new AbortController();
  const revoked = AbortSignal.any([lifetime, stopped.signal]);
  const host = new Context();
  let closing: Promise<void> | undefined;
  function close() {
    stopped.abort(new ModelGatewayError('ADMISSION_CLOSED'));
    return (closing ??= host.fiber.dispose());
  }
  async function assertCurrent(signal: AbortSignal) {
    const active = AbortSignal.any([signal, revoked]);
    active.throwIfAborted();
    const record = await host.credentials.describeRecord(credential);
    const current = await readSelectedSubscription();
    active.throwIfAborted();
    if (
      !record.configured ||
      record.kind !== 'grant' ||
      current.slot !== selection.slot ||
      current.revision !== selection.revision
    )
      throw new ModelGatewayError('AUTHORIZATION_DENIED');
  }
  try {
    await host.plugin(Llm).await();
    if (images) await host.plugin(images.plugin).await();
    await host
      .plugin(MeteredCodexCredentials, {
        path: join(codexSubscriptionHome(selection.slot), '.credentials.yaml'),
      })
      .await();
    await host
      .plugin(PiAi, {
        providers: {
          [provider]: { transport: 'sse', models: [modelMetadata] },
        },
      })
      .await();
    const modelInfo = await host.llm.resolveModelInfo(provider, model, revoked);
    await assertCurrent(revoked);
    return {
      selection,
      revoked,
      close,
      modelInfo,
      llm: host.llm,
      assertCurrent,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'CODEX_RUNTIME_CLOSE_UNKNOWN');
    }
    throw error;
  }
}

export async function createProductionCodexRuntime(
  lifetime: AbortSignal,
  ownerId: string,
  readModelImage?: ReadProductionModelImage,
) {
  lifetime.throwIfAborted();
  const model =
    process.env.ALLRICE_DSH_CODEX_MODEL ??
    process.env.ALLRICE_CODEX_MODEL ??
    'gpt-6.1-sol';
  if (!model || model.trim() !== model)
    throw new ModelGatewayError('BINDING_INVALID');
  const stopped = new AbortController();
  const revoked = AbortSignal.any([lifetime, stopped.signal]);
  const route = Object.freeze({
    provider,
    model,
    transport: 'sse' as const,
    classify,
  });
  const images = readModelImage
    ? createProductionModelImages(readModelImage)
    : undefined;
  const transport = createOwnedModelTransport(ownerId);
  let generation: Awaited<ReturnType<typeof openCodexGeneration>> | undefined;
  let operations = Promise.resolve();
  let closing: Promise<void> | undefined;

  async function current(signal: AbortSignal = revoked) {
    const active = AbortSignal.any([signal, revoked]);
    const task = operations.then(async () => {
      active.throwIfAborted();
      try {
        if (generation && !generation.revoked.aborted) {
          // A failed read invalidates exactly the generation whose current
          // authority could not be established. A later request may reopen.
          await generation.assertCurrent(active);
          return generation;
        }
        const selection = await readSelectedSubscription();
        active.throwIfAborted();
        generation = await openCodexGeneration(
          revoked,
          selection,
          model,
          images,
        );
        active.throwIfAborted();
        return generation;
      } catch (error) {
        if (active.aborted && !revoked.aborted) throw error;
        if (generation) {
          await generation.close();
          generation = undefined;
        }
        throw error;
      }
    });
    operations = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  const llm: Pick<LlmRuntime, 'prepareCall'> = {
    async prepareCall(config, signal) {
      if (config.provider !== provider || config.model !== model)
        throw new ModelGatewayError('BINDING_INVALID');
      const selected = await current(signal);
      const operation = AbortSignal.any([
        selected.revoked,
        ...(signal ? [signal] : []),
      ]);
      const prepared = await selected.llm.prepareCall(config, operation);
      operation.throwIfAborted();
      return {
        ...prepared,
        async *stream(options) {
          const active = options.signal
            ? AbortSignal.any([operation, options.signal])
            : operation;
          await current(active);
          active.throwIfAborted();
          yield* prepared.stream({ ...options, signal: active });
        },
      };
    },
  };
  return Object.freeze({
    llm,
    route,
    async readModelInfo(signal: AbortSignal) {
      return (await current(signal)).modelInfo;
    },
    scopeStream: images?.stream,
    revoked,
    async assertCurrent(signal?: AbortSignal) {
      const selected = await current(signal);
      signal?.throwIfAborted();
      selected.revoked.throwIfAborted();
      return selected.revoked;
    },
    transport: {
      ...transport,
      async beforeDispatch(signal: AbortSignal) {
        await current(signal);
        signal.throwIfAborted();
      },
    },
    confirmTransportStopped: transport.stoppedEvidence,
    close() {
      if (closing) return closing;
      stopped.abort(new ModelGatewayError('ADMISSION_CLOSED'));
      return (closing = Promise.allSettled([
        transport.close(),
        operations.then(() => generation?.close()),
      ]).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(failures, 'CODEX_RUNTIME_CLOSE_UNKNOWN');
      }));
    },
  });
}
