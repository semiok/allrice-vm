import { constants, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
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

function rejectCredentialText(value: string) {
  const hostKeys = [
    process.env.ALLRICE_OPENAI_API_KEY,
    process.env.ALLRICE_DEEPSEEK_API_KEY,
  ];
  if (hostKeys.some((key) => key && key.trim() && value.includes(key.trim())))
    throw new ModelGatewayError('BINDING_INVALID');
}

function readConfig() {
  const source = process.env.ALLRICE_DSH_MODEL_ROUTES;
  if (source === undefined) return;
  if (source.length <= 256 * 1024) {
    try {
      const config = routesSchema.parse(JSON.parse(source));
      for (const route of config.routes) rejectCredentialText(route.model);
      for (const rule of config.rules) {
        if (rule.sessionId) rejectCredentialText(rule.sessionId);
        if (rule.parentSessionId) rejectCredentialText(rule.parentSessionId);
      }
      if (
        new Set(config.routes.map(({ id }) => id)).size !==
          config.routes.length ||
        config.routes.some(({ id }) => id === 'default') ||
        config.rules.some(
          (rule) =>
            !config.routes.some(({ id }) => id === rule.route) ||
            (rule.attempt !== undefined &&
              rule.attempt !== 'assistant' &&
              (rule.sessionId !== undefined ||
                rule.parentSessionId !== undefined ||
                rule.scope !== undefined)) ||
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

const revocationsSchema = z.array(identifier).max(17);

async function readRevocations(path: string) {
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.())
      throw new ModelGatewayError('AUTHORIZATION_DENIED');
    const data = Buffer.alloc(8193);
    const { bytesRead } = await fd.read(data, 0, data.length);
    if (bytesRead === data.length)
      throw new ModelGatewayError('AUTHORIZATION_DENIED');
    return revocationsSchema.parse(
      JSON.parse(data.subarray(0, bytesRead).toString('utf8')),
    );
  } finally {
    await fd.close();
  }
}

export async function createProductionModelRouting(
  lifetime: AbortSignal,
  ownerId: string,
  readModelImage: ReadProductionModelImage,
) {
  const config = readConfig();
  const revocationPath = process.env.ALLRICE_DSH_MODEL_REVOCATIONS_FILE;
  if (revocationPath !== undefined && (!config || !isAbsolute(revocationPath)))
    throw new ModelGatewayError('BINDING_INVALID');
  const defaultProvider =
    process.env.ALLRICE_DSH_MODEL_PROVIDER ?? 'openai-codex';
  if (defaultProvider !== 'openai-codex' && defaultProvider !== 'openai')
    throw new ModelGatewayError('BINDING_INVALID');
  const defaultModel =
    defaultProvider === 'openai'
      ? process.env.ALLRICE_DSH_OPENAI_MODEL
      : (process.env.ALLRICE_DSH_CODEX_MODEL ??
        process.env.ALLRICE_CODEX_MODEL);
  if (defaultModel) rejectCredentialText(defaultModel);
  const fallback = await (defaultProvider === 'openai'
    ? createProductionOpenAiRuntime(
        lifetime,
        ownerId,
        readModelImage,
        undefined,
        config !== undefined,
      )
    : createProductionCodexRuntime(lifetime, ownerId, readModelImage));
  const runtimes: Runtime[] = [fallback];
  const definitions = new Map<string, ModelRouteKey>([
    ['default', fallback.route],
  ]);
  const retired = new Set<Runtime>();
  const watchStop = new AbortController();
  let watching: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  function close() {
    watchStop.abort();
    return (closing ??= Promise.allSettled([
      ...runtimes.map((runtime) => runtime.close()),
      watching,
    ]).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(failures, 'MODEL_ROUTE_CLOSE_INCOMPLETE');
    }));
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
    function retire(routes: readonly ModelRouteKey[]) {
      for (const route of routes) {
        const runtime = runtimeFor(route);
        if (retired.has(runtime)) continue;
        retired.add(runtime);
        // Stop admission and cancel synchronously. Global shutdown still joins
        // this exact cached close and supplies proof for every pool.
        void runtime.close().catch(() => {});
      }
    }
    if (revocationPath !== undefined) {
      async function refreshRevocations(path: string) {
        const ids = await readRevocations(path);
        const routes = ids.map((id) => {
          const route = definitions.get(id);
          if (!route) throw new ModelGatewayError('AUTHORIZATION_DENIED');
          return route;
        });
        retire(routes);
      }
      try {
        await refreshRevocations(revocationPath);
      } catch {
        throw new ModelGatewayError('AUTHORIZATION_DENIED');
      }
      const signal = AbortSignal.any([lifetime, watchStop.signal]);
      watching = (async () => {
        try {
          for (;;) {
            await wait(1000, undefined, { signal, ref: false });
            await refreshRevocations(revocationPath);
          }
        } catch {
          if (!signal.aborted) retire(runtimes.map(({ route }) => route));
        }
      })();
    }
    function select(binding: VmOwner, native: ModelCallBinding['native']) {
      const rules = rulesFor(binding);
      const kind = native.attemptKind;
      if (kind === 'compaction' || kind === 'session-title') {
        const explicit = rules.find(({ attempt }) => attempt === kind);
        if (explicit)
          return { provider: explicit.provider, model: explicit.model };
        // Inherited maintenance is only allowed on the same policy route as
        // its native session. The Guest cannot request a different fallback.
        return selectScopedModel(
          rules,
          { ...native, attemptKind: 'assistant' },
          fallback.route,
        );
      }
      return selectScopedModel(rules, native, fallback.route);
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
              transport.confirmClosed,
            ),
          ] as const,
      ),
    );
    return {
      fallback,
      close,
      scoped: config !== undefined,
      select,
      applies: (binding: VmOwner) => rulesFor(binding).length > 0,
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
            .filter(({ route }) =>
              rules.some((rule) => sameModelRoute(rule, route)),
            )
            .map(async (runtime) => ({
              provider: runtime.route.provider,
              model: runtime.route.model,
              modelInfo: await runtime.readCatalogModelInfo(signal),
            })),
        );
        const maintenance = (attempt: 'compaction' | 'session-title') => {
          const rule = rules.find((rule) => rule.attempt === attempt);
          return rule && { provider: rule.provider, model: rule.model };
        };
        return {
          defaultModelInfo: await fallback.readCatalogModelInfo(signal),
          rules,
          models,
          compaction: maintenance('compaction'),
          title: maintenance('session-title'),
        };
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
