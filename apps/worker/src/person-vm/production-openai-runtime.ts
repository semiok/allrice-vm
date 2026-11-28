import { Context } from '@deepseek-ai/cordis';
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment';
import Llm, {
  type LlmResolvedModelInfo,
  type LlmRuntime,
} from '@deepseek-ai/dsh-llm';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import {
  classifyDeepSeek,
  classifyOpenAiResponses,
  DEEPSEEK_API_BASE_URL,
  createOwnedModelTransport,
  ModelGatewayError,
  OPENAI_RESPONSES_BASE_URL,
  type DshGatewayRoute,
} from '@allrice/model-gateway';
import {
  createProductionModelImages,
  type ReadProductionModelImage,
} from './production-model-images.js';

// Only exact models verified for this opt-in Responses capability.
const openAiSearchModels = new Set(['gpt-4.1-mini', 'gpt-6.2-astra']);

export type ManagedApiRoute =
  | Readonly<{
      provider: 'openai';
      model: string;
      protocol: 'responses';
      search?: boolean;
    }>
  | Readonly<{
      provider: 'deepseek';
      model: string;
      protocol: 'chat' | 'responses';
      search?: boolean;
    }>;

export async function createProductionOpenAiRuntime(
  lifetime: AbortSignal,
  ownerId: string,
  readModelImage?: ReadProductionModelImage,
  configured?: ManagedApiRoute,
  allowUnavailable = false,
) {
  lifetime.throwIfAborted();
  const provider = configured?.provider ?? 'openai';
  const protocol = configured?.protocol ?? 'responses';
  const model = configured?.model ?? process.env.ALLRICE_DSH_OPENAI_MODEL;
  const legacySearchModel = process.env.ALLRICE_DSH_OPENAI_WEB_SEARCH_MODEL;
  const search = configured
    ? configured.search === true
    : legacySearchModel !== undefined && legacySearchModel === model;
  if (
    !model ||
    model.length > 128 ||
    model.trim() !== model ||
    (!configured &&
      legacySearchModel !== undefined &&
      legacySearchModel !== model) ||
    (search &&
      (protocol !== 'responses' ||
        (provider === 'deepseek'
          ? model !== 'deepseek-v4-pro'
          : !openAiSearchModels.has(model))))
  )
    throw new ModelGatewayError('BINDING_INVALID');
  const keyName =
    provider === 'openai'
      ? 'ALLRICE_OPENAI_API_KEY'
      : 'ALLRICE_DEEPSEEK_API_KEY';
  const readKey = () =>
    provider === 'openai'
      ? process.env.ALLRICE_OPENAI_API_KEY
      : process.env.ALLRICE_DEEPSEEK_API_KEY;
  const key = readKey();
  const credential = key && key.trim() === key ? key : undefined;
  const requireCredentialAtBoot = !configured && !allowUnavailable;
  if (requireCredentialAtBoot && !credential)
    throw new ModelGatewayError('AUTHORIZATION_DENIED');

  const route: DshGatewayRoute = Object.freeze({
    provider,
    model,
    transport: 'sse',
    classify:
      provider === 'openai'
        ? classifyOpenAiResponses
        : (input, init) => classifyDeepSeek(protocol, input, init),
    ...(search ? { hostedWebSearch: true as const } : {}),
  });
  const stop = new AbortController();
  const revoked = AbortSignal.any([lifetime, stop.signal]);
  const context = new Context();
  // Only this host Context sees the key. The native credential lookup cannot
  // fall back to a guest, project dotenv file or another provider's grant.
  context.provide(
    DSH_LAUNCH_ENVIRONMENT_KEY,
    createLaunchEnvironmentSnapshot([
      {
        source: 'process',
        values: credential ? { [keyName]: credential } : {},
      },
    ]),
  );
  const images = readModelImage
    ? createProductionModelImages(readModelImage)
    : undefined;
  const transport = createOwnedModelTransport(ownerId);
  const active = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  function retain() {
    revoked.throwIfAborted();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    active.add(done);
    return () => {
      active.delete(done);
      release();
    };
  }
  async function assertCurrent(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!credential || readKey() !== credential)
      stop.abort(new ModelGatewayError('AUTHORIZATION_DENIED'));
    revoked.throwIfAborted();
    return revoked;
  }
  function close() {
    if (closing) return closing;
    stop.abort(new ModelGatewayError('ADMISSION_CLOSED'));
    return (closing = Promise.allSettled([
      transport.close(),
      Promise.all(active).then(() => context.fiber.dispose()),
    ]).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(failures, 'OPENAI_RUNTIME_CLOSE_UNKNOWN');
    }));
  }

  try {
    await context.plugin(Llm).await();
    if (images) await context.plugin(images.plugin).await();
    await context
      .plugin(PiAi, {
        providers: {
          [provider]: {
            api:
              protocol === 'chat' ? 'openai-completions' : 'openai-responses',
            apiKeyEnv: keyName,
            baseURL:
              provider === 'openai'
                ? OPENAI_RESPONSES_BASE_URL
                : DEEPSEEK_API_BASE_URL,
            transport: 'sse',
            models: [
              {
                id: model,
                ...(provider === 'deepseek'
                  ? { reasoningEfforts: false as const }
                  : {}),
                ...(provider === 'openai' && model === 'gpt-6.2-astra'
                  ? {
                      contextWindow: 1_050_000,
                      maxTokens: 128_000,
                      input: ['text', 'image'],
                      reasoningEfforts: {
                        low: 'low',
                        medium: 'medium',
                        high: 'high',
                        xhigh: 'xhigh',
                        max: 'max',
                      },
                    }
                  : {}),
              },
            ],
          },
        },
      })
      .await();
    const modelInfo = await context.llm.resolveModelInfo(
      provider,
      model,
      revoked,
    );
    const metadata = {
      modelInfo,
      historicalModels: [] as LlmResolvedModelInfo[],
    };
    if (requireCredentialAtBoot) await assertCurrent();
    const llm: Pick<LlmRuntime, 'prepareCall'> = {
      async prepareCall(config, signal) {
        if (config.provider !== provider || config.model !== model)
          throw new ModelGatewayError('BINDING_INVALID');
        const operation = signal ? AbortSignal.any([signal, revoked]) : revoked;
        await assertCurrent(operation);
        const release = retain();
        const prepared = await context.llm
          .prepareCall(config, operation)
          .finally(release);
        operation.throwIfAborted();
        return {
          ...prepared,
          async *stream(options) {
            const signal = options.signal
              ? AbortSignal.any([operation, options.signal])
              : operation;
            await assertCurrent(signal);
            const release = retain();
            try {
              yield* prepared.stream({ ...options, signal });
            } finally {
              release();
            }
          },
        };
      },
    };
    return Object.freeze({
      route,
      llm,
      revoked,
      assertCurrent,
      close,
      async readCatalogModelMetadata(signal: AbortSignal) {
        signal.throwIfAborted();
        return metadata;
      },
      async readModelMetadata(signal: AbortSignal) {
        await assertCurrent(signal);
        return metadata;
      },
      scopeStream: images?.stream,
      transport: {
        ...transport,
        async beforeDispatch(signal: AbortSignal) {
          await assertCurrent(signal);
        },
      },
      confirmTransportStopped: transport.stoppedEvidence,
    });
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'OPENAI_RUNTIME_CLOSE_UNKNOWN',
      );
    }
    throw error;
  }
}
