import { createHash } from 'node:crypto';
import {
  createDshGatewayProvider,
  ModelGatewayError,
  sameModelRoute,
  selectScopedModel,
  type ModelCallBinding,
  type ModelRouteKey,
} from '@allrice/model-gateway';
import type { PersonVmBinding } from '@allrice/person-vm';
import { z } from 'zod';
import { createProductionCodexRuntime } from './production-codex-runtime.js';
import type { ReadProductionModelImage } from './production-model-images.js';
import { createProductionOpenAiRuntime } from './production-openai-runtime.js';

const model = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value);
const identifier = z.string().min(1).max(256);
const routesSchema = z
  .object({
    routes: z
      .array(
        z.discriminatedUnion('provider', [
          z
            .object({
              id: identifier,
              provider: z.literal('openai-codex'),
              model,
            })
            .strict(),
          z
            .object({
              id: identifier,
              provider: z.literal('openai'),
              model,
              protocol: z.literal('responses'),
              search: z.boolean().optional(),
            })
            .strict(),
          z
            .object({
              id: identifier,
              provider: z.literal('deepseek'),
              model,
              protocol: z.enum(['chat', 'responses']),
              search: z.boolean().optional(),
            })
            .strict(),
        ]),
      )
      .max(16),
    rules: z
      .array(
        z
          .object({
            organizationId: z.string().uuid(),
            personId: z.string().uuid(),
            route: identifier,
            sessionId: identifier.optional(),
            parentSessionId: identifier.optional(),
            scope: z.enum(['root', 'subagent']).optional(),
            attempt: z
              .enum(['assistant', 'compaction', 'session-title'])
              .optional(),
          })
          .strict(),
      )
      .max(512),
  })
  .strict();

type Runtime = Awaited<
  ReturnType<
    typeof createProductionCodexRuntime | typeof createProductionOpenAiRuntime
  >
>;
type VmOwner = Pick<PersonVmBinding, 'personId' | 'organizationId'>;

function readConfig() {
  const source = process.env.ALLRICE_DSH_MODEL_ROUTES;
  if (source === undefined) return;
  if (source.length <= 256 * 1024) {
    try {
      const config = routesSchema.parse(JSON.parse(source));
      if (
        new Set(config.routes.map(({ id }) => id)).size !==
          config.routes.length ||
        config.rules.some(
          (rule) =>
            !config.routes.some(({ id }) => id === rule.route) ||
            (rule.scope === 'root' && rule.parentSessionId !== undefined) ||
            !(
              rule.sessionId ||
              rule.parentSessionId ||
              rule.scope ||
              rule.attempt
            ),
        )
      )
        throw new Error();
      return config;
    } catch {
      // The original input might contain mistakenly pasted secrets.
    }
  }
  throw new ModelGatewayError('BINDING_INVALID');
}

export async function createProductionModelRouting(
  lifetime: AbortSignal,
  ownerId: string,
  readModelImage: ReadProductionModelImage,
) {
  const config = readConfig();
  const defaultProvider =
    process.env.ALLRICE_DSH_MODEL_PROVIDER ?? 'openai-codex';
  if (defaultProvider !== 'openai-codex' && defaultProvider !== 'openai')
    throw new ModelGatewayError('BINDING_INVALID');
  const fallback = await (defaultProvider === 'openai'
    ? createProductionOpenAiRuntime(lifetime, ownerId, readModelImage)
    : createProductionCodexRuntime(lifetime, ownerId, readModelImage));
  const runtimes: Runtime[] = [fallback];
  const definitions = new Map<string, ModelRouteKey>();
  const retired = new Set<Runtime>();
  async function revokeRoute(route: ModelRouteKey) {
    const runtime = runtimeFor(route);
    retired.add(runtime);
    await runtime.close();
  }
  async function close() {
    const results = await Promise.allSettled(
      runtimes.map((runtime) => runtime.close()),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, 'MODEL_ROUTE_CLOSE_INCOMPLETE');
  }
  try {
    for (const route of config?.routes ?? []) {
      if (runtimes.some((runtime) => sameModelRoute(runtime.route, route)))
        throw new ModelGatewayError('BINDING_INVALID');
      const runtime = await (route.provider === 'openai-codex'
        ? createProductionCodexRuntime(
            lifetime,
            ownerId,
            readModelImage,
            route.model,
          )
        : createProductionOpenAiRuntime(
            lifetime,
            ownerId,
            readModelImage,
            route,
          ));
      runtimes.push(runtime);
      definitions.set(route.id, {
        provider: route.provider,
        model: route.model,
      });
    }
    function rulesFor(binding: VmOwner) {
      return (config?.rules ?? [])
        .filter(
          (rule) =>
            rule.organizationId === binding.organizationId &&
            rule.personId === binding.personId,
        )
        .map(({ route, sessionId, parentSessionId, scope, attempt }) => ({
          ...definitions.get(route)!,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(parentSessionId === undefined ? {} : { parentSessionId }),
          ...(scope === undefined ? {} : { scope }),
          ...(attempt === undefined ? {} : { attempt }),
        }));
    }
    function runtimeFor(route: ModelRouteKey) {
      const found = runtimes.find((runtime) =>
        sameModelRoute(runtime.route, route),
      );
      if (!found) throw new ModelGatewayError('BINDING_INVALID');
      return found;
    }
    function select(binding: VmOwner, native: ModelCallBinding['native']) {
      return selectScopedModel(rulesFor(binding), native, fallback.route);
    }
    const providers = new Map(
      runtimes.map(
        ({ route, llm, transport, scopeStream }) =>
          [
            route,
            createDshGatewayProvider(
              llm,
              route,
              transport.fetchOwned,
              transport.beforeDispatch,
              scopeStream,
            ),
          ] as const,
      ),
    );
    return {
      fallback,
      close,
      revokeRoute,
      scoped: config !== undefined,
      select,
      provider(call: ModelCallBinding) {
        if (!sameModelRoute(select(call.vm, call.native), call))
          throw new ModelGatewayError('BINDING_INVALID');
        const runtime = runtimeFor(call);
        if (retired.has(runtime))
          throw new ModelGatewayError('AUTHORIZATION_DENIED');
        return providers.get(runtime.route)!;
      },
      async assertCurrent(call: ModelCallBinding, signal: AbortSignal) {
        if (!sameModelRoute(select(call.vm, call.native), call))
          throw new ModelGatewayError('BINDING_INVALID');
        const runtime = runtimeFor(call);
        if (retired.has(runtime))
          throw new ModelGatewayError('AUTHORIZATION_DENIED');
        return runtime.assertCurrent(signal);
      },
      async guestCatalog(binding: VmOwner, signal: AbortSignal) {
        const rules = rulesFor(binding);
        if (!rules.length) return;
        const models = await Promise.all(
          runtimes
            .filter(
              (runtime) =>
                !retired.has(runtime) &&
                rules.some((rule) => sameModelRoute(rule, runtime.route)),
            )
            .map(async (runtime) => ({
              provider: runtime.route.provider,
              model: runtime.route.model,
              modelInfo: await runtime.readModelInfo(signal),
            })),
        );
        return { rules, models };
      },
      async confirmTransportStopped(candidate: string, signal: AbortSignal) {
        const evidence = await Promise.all(
          runtimes.map((runtime) =>
            runtime.confirmTransportStopped(candidate, signal),
          ),
        );
        signal.throwIfAborted();
        return evidence.length === 1
          ? evidence[0]!
          : 'model-pools-stopped:' +
              createHash('sha256')
                .update(JSON.stringify(evidence))
                .digest('hex');
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'MODEL_ROUTE_START_INCOMPLETE',
      );
    }
    throw error;
  }
}

export type ProductionModelRouting = Awaited<
  ReturnType<typeof createProductionModelRouting>
>;
