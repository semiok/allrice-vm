import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import Llm, { type LlmRuntime } from '@deepseek-ai/dsh-llm';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import {
  PlatformModelConfigurationSchema,
  type PlatformModelConfiguration,
} from '@allrice/contracts';
import { getDatabase, readPlatformModelSettings } from '@allrice/database';
import {
  ModelGatewayError,
  createOwnedModelTransport,
  withGatewayAuthTransaction,
  type DshGatewayRoute,
  type GatewayFetchClassification,
} from '@allrice/model-gateway';
import {
  createProductionModelImages,
  type ReadProductionModelImage,
} from './production-model-images.js';
import { codexSubscriptionHome } from '../codex-subscription-home.js';

const provider = 'openai-codex';
const credential = PiAi.recordKeyFor(provider);

async function readSelectedSubscription(connectionId: string) {
  const [selected] = await getDatabase()<{ slot: 1 | 2; revision: string }[]>`
    select slot, extract(epoch from updated_at)::text as revision
    from allrice_codex_subscriptions
    where enabled and exists (
      select 1
      from allrice_model_connections c
      join allrice_model_providers p on p.id=c.provider_id
      where c.id=${connectionId} and c.scope='platform'
        and c.credential_reference='deployment:codex-default' and c.base_url is null
        and c.status='ready' and p.enabled
        and p.provider_key in ('codex','openai-codex') and p.auth_mode='chatgpt_subscription'
    )
  `;
  if (!selected) throw new ModelGatewayError('AUTHORIZATION_DENIED');
  return selected;
}

export function managedCodexModel(model: string) {
  if (
    !['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'].includes(model)
  )
    return { id: model };
  return {
    id: model,
    ...(model === 'gpt-6.2-sol' ? { name: 'GPT-6.2 Sol' } : {}),
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
  connectionId: string,
  selection: Awaited<ReturnType<typeof readSelectedSubscription>>,
  model: string,
  reasoning: PlatformModelConfiguration['reasoningEffort'],
  images: ReturnType<typeof createProductionModelImages> | undefined,
) {
  lifetime.throwIfAborted();
  const historicalIds =
    PlatformModelConfigurationSchema.shape.workModel.options.filter(
      (id) => id !== model,
    );
  const stopped = new AbortController();
  const revoked = AbortSignal.any([lifetime, stopped.signal]);
  const host = new Context();
  const users = new Set<Promise<void>>();
  function retain() {
    revoked.throwIfAborted();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    users.add(done);
    return () => {
      users.delete(done);
      release();
    };
  }
  let closing: Promise<void> | undefined;
  function close() {
    if (closing) return closing;
    stopped.abort(new ModelGatewayError('ADMISSION_CLOSED'));
    return (closing = Promise.all([...users]).then(() => host.fiber.dispose()));
  }
  async function assertCurrent(signal: AbortSignal) {
    const active = AbortSignal.any([signal, revoked]);
    active.throwIfAborted();
    const record = await host.credentials.describeRecord(credential);
    const current = await readSelectedSubscription(connectionId);
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
          [provider]: {
            transport: 'sse',
            models: [model, ...historicalIds].map(managedCodexModel),
            reasoning,
          },
        },
      })
      .await();
    const modelInfo = await host.llm.resolveModelInfo(provider, model, revoked);
    if (modelInfo.reasoning?.defaultEffort !== reasoning)
      throw new ModelGatewayError('BINDING_INVALID');
    const historicalModels = await Promise.all(
      historicalIds.map((id) =>
        host.llm.resolveModelInfo(provider, id, revoked),
      ),
    );
    await assertCurrent(revoked);
    return {
      revoked,
      retain,
      close,
      modelMetadata: { modelInfo, historicalModels },
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
  approvedModel?: string,
) {
  lifetime.throwIfAborted();
  // Keep the audited platform connection and default. A scoped Codex rule
  // may pin a model that the same platform adapter supports.
  const {
    configuration: { connectionId, workModel, reasoningEffort },
  } = await readPlatformModelSettings();
  lifetime.throwIfAborted();
  const model = PlatformModelConfigurationSchema.shape.workModel.parse(
    approvedModel ?? workModel,
  );
  const stopped = new AbortController();
  const revoked = AbortSignal.any([lifetime, stopped.signal]);
  const route: DshGatewayRoute = Object.freeze({
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
  const retiring = new Set<Promise<void>>();
  const retirementFailures: unknown[] = [];
  function retire(value: NonNullable<typeof generation>) {
    const joined = value.close();
    retiring.add(joined);
    void joined.then(
      () => retiring.delete(joined),
      (error: unknown) => {
        retiring.delete(joined);
        retirementFailures.push(error);
      },
    );
  }
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
        const selection = await readSelectedSubscription(connectionId);
        active.throwIfAborted();
        generation = await openCodexGeneration(
          revoked,
          connectionId,
          selection,
          model,
          reasoningEffort,
          images,
        );
        active.throwIfAborted();
        return generation;
      } catch (error) {
        if (active.aborted && !revoked.aborted) throw error;
        if (generation) {
          // Revocation is synchronous. A stream in this very check may own
          // the old generation until its native HTTP/credential work joins.
          const previous = generation;
          generation = undefined;
          retire(previous);
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
  let catalog:
    | Promise<Awaited<ReturnType<typeof openCodexGeneration>>['modelMetadata']>
    | undefined;
  function readCatalogModelMetadata(signal: AbortSignal) {
    signal.throwIfAborted();
    return (catalog ??= (async () => {
      const host = new Context();
      try {
        await host.plugin(Llm).await();
        await host
          .plugin(PiAi, {
            providers: {
              [provider]: {
                transport: 'sse',
                models: [
                  ...PlatformModelConfigurationSchema.shape.workModel.options,
                ].map(managedCodexModel),
                reasoning: reasoningEffort,
              },
            },
          })
          .await();
        const all = await Promise.all(
          PlatformModelConfigurationSchema.shape.workModel.options.map((id) =>
            host.llm.resolveModelInfo(provider, id, lifetime),
          ),
        );
        return {
          modelInfo: all.find(({ id }) => id === model)!,
          historicalModels: all.filter(({ id }) => id !== model),
        };
      } finally {
        await host.fiber.dispose();
      }
    })()).then((info) => {
      signal.throwIfAborted();
      return info;
    });
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
      const releasePrepare = selected.retain();
      const prepared = await selected.llm
        .prepareCall(config, operation)
        .finally(releasePrepare);
      operation.throwIfAborted();
      return {
        ...prepared,
        async *stream(options) {
          const active = options.signal
            ? AbortSignal.any([operation, options.signal])
            : operation;
          const release = selected.retain();
          try {
            await current(active);
            active.throwIfAborted();
            yield* prepared.stream({ ...options, signal: active });
          } finally {
            release();
          }
        },
      };
    },
  };
  return Object.freeze({
    llm,
    route,
    readCatalogModelMetadata,
    async readModelMetadata(signal: AbortSignal) {
      return (await current(signal)).modelMetadata;
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
        catalog,
        operations.then(async () => {
          if (generation) retire(generation);
          await Promise.allSettled([...retiring]);
          if (retirementFailures.length)
            throw new AggregateError(
              retirementFailures,
              'CODEX_GENERATION_CLOSE_UNKNOWN',
            );
        }),
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
