import { LlmAdapter, LlmError } from './native-llm.ts';
import type {
  GenerateOptions,
  LlmRuntime,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import {
  isModelCallReference,
  MODEL_CALL_REFERENCE_HEADER,
  MODEL_CALL_RECIPIENT_HEADER,
  MODEL_GATEWAY_CONTRACT_VERSION,
  ModelGatewayError,
} from './contract.ts';

type ManagedGuestModelCall = {
  readonly provider: string;
  readonly model: string;
  readonly modelInfo?: LlmResolvedModelInfo;
  readonly models?: readonly {
    model: string;
    modelInfo: LlmResolvedModelInfo;
  }[];
  readonly lifetime?: AbortSignal;
  /** The authorized native invocation delivers a reference for this call
   * before the adapter sends its first request. The adapter never mints one. */
  resolveCallReference(
    selection: Readonly<{
      provider: string;
      model: string;
      sessionId: NonNullable<GenerateOptions['sessionId']>;
    }>,
    signal: AbortSignal,
    purpose?: GenerateOptions['purpose'],
  ): Promise<
    string | { reference: string; recipient?: string; release(): void }
  >;
};
import type {
  DshGatewayRoute,
  GatewayProvider,
  ModelCallBinding,
} from './contract.ts';

export type DshGatewayStreamScope = (
  binding: ModelCallBinding,
  signal: AbortSignal,
  stream: () => AsyncIterable<StreamChunk>,
) => AsyncIterable<StreamChunk>;

/** Use the existing host subscription loader's LlmRuntime, including its
 * credentials/refresh implementation. This function never opens credentials.
 * The loader's pinned provider profile must use HTTP SSE, not websocket/auto. */
export function createDshGatewayProvider(
  llm: Pick<LlmRuntime, 'prepareCall'>,
  route: DshGatewayRoute,
  fetchOwned?: GatewayProvider['fetchOwned'],
  assertDispatchCurrent?: GatewayProvider['assertDispatchCurrent'],
  scopeStream?: DshGatewayStreamScope,
  confirmTransportClosed?: GatewayProvider['confirmTransportClosed'],
): GatewayProvider {
  return {
    classify: route.classify,
    ...(route.hostedWebSearch
      ? {
          hostedWebSearch: Object.freeze({
            provider: route.provider,
            model: route.model,
          }),
        }
      : {}),
    ...(fetchOwned ? { requireTransportProof: true as const } : {}),
    fetchOwned,
    assertDispatchCurrent,
    confirmTransportClosed,
    async *stream(binding, input, signal) {
      if (
        binding.provider !== route.provider ||
        binding.model !== route.model ||
        route.transport !== 'sse'
      )
        throw new ModelGatewayError('BINDING_INVALID');
      const prepared = await llm.prepareCall(
        {
          provider: route.provider,
          model: route.model,
          ...(input.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: input.reasoningEffort }),
          ...(input.temperature === undefined
            ? {}
            : { temperature: input.temperature }),
          ...(input.maxTokens === undefined
            ? {}
            : { maxTokens: input.maxTokens }),
          ...(input.stop === undefined ? {} : { stop: input.stop }),
        },
        signal,
      );
      const stream = () =>
        prepared.stream({
          ...input,
          // Guest replay metadata is never authority to replay native OpenAI
          // items under a shared Host credential. Use DSH's normal neutral
          // history conversion on this route, retaining text and tool history.
          ...(route.provider === 'openai' || route.provider === 'deepseek'
            ? {
                messages: input.messages.map((message) => {
                  if (message.role !== 'assistant') return message;
                  const source = { ...message.source };
                  delete source.replayState;
                  return { ...message, source };
                }),
              }
            : {}),
          ...prepared.config,
          signal,
          sessionId: binding.native.sessionId as GenerateOptions['sessionId'],
        });
      yield* scopeStream ? scopeStream(binding, signal, stream) : stream();
    },
  };
}

/** Guest-side public DSH provider seam. The host supplies the managed endpoint
 * and optional VM-local egress capability, never an upstream model credential.
 * Neither supplies person/tenant authority. No reconnect, retry, credential
 * refresh or tool protocol is invented here. */
export class GatewayLlmAdapter extends LlmAdapter {
  constructor(
    private readonly endpoint: string,
    private readonly egressCapability?: string,
    private readonly managed?: ManagedGuestModelCall,
  ) {
    super();
  }
  override async listModels(provider: string) {
    const route = this.managed;
    if (!route || route.provider !== provider)
      return super.listModels(provider);
    route.lifetime?.throwIfAborted();
    return route.models
      ? route.models.map(({ modelInfo }) => modelInfo)
      : [await this.resolveModel(provider, route.model)];
  }
  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ) {
    const route = this.managed;
    if (!route) return super.resolveModel(provider, model, signal);
    signal?.throwIfAborted();
    route.lifetime?.throwIfAborted();
    if (route.provider !== provider)
      throw new ModelGatewayError('BINDING_INVALID');
    if (route.models) {
      const found = route.models.find((value) => value.model === model);
      if (!found) throw new ModelGatewayError('BINDING_INVALID');
      return found.modelInfo;
    }
    if (route.model !== model) throw new ModelGatewayError('BINDING_INVALID');
    return route.modelInfo ?? super.resolveModel(provider, model, signal);
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let reference: string | undefined;
    let recipient: string | undefined;
    const signal =
      options.signal && this.managed?.lifetime
        ? AbortSignal.any([options.signal, this.managed.lifetime])
        : options.signal;
    let release: (() => void) | undefined;
    try {
      if (this.managed) {
        const { provider, model, sessionId } = options;
        if (
          provider !== this.managed.provider ||
          (this.managed.models
            ? !this.managed.models.some((value) => value.model === model)
            : model !== this.managed.model) ||
          !sessionId ||
          !signal
        )
          throw new ModelGatewayError('BINDING_INVALID');
        signal.throwIfAborted();
        const selection = { provider, model, sessionId };
        const issued = options.purpose
          ? await this.managed.resolveCallReference(
              selection,
              signal,
              options.purpose,
            )
          : await this.managed.resolveCallReference(selection, signal);
        reference = typeof issued === 'string' ? issued : issued.reference;
        if (typeof issued !== 'string') {
          release = issued.release;
          recipient = issued.recipient;
        }
        signal.throwIfAborted();
        if (!isModelCallReference(reference))
          throw new ModelGatewayError('BINDING_INVALID');
      }
      yield* this.streamRequest(options, signal, reference, recipient);
    } finally {
      release?.();
    }
  }
  private async *streamRequest(
    options: GenerateOptions,
    signal: AbortSignal | undefined,
    reference: string | undefined,
    recipient: string | undefined,
  ): AsyncIterable<StreamChunk> {
    const {
      messages,
      system,
      tools,
      toolHistory,
      temperature,
      maxTokens,
      stop,
      reasoningEffort,
      purpose,
    } = options;
    const response = await fetch(this.endpoint, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-allrice-model-contract': String(MODEL_GATEWAY_CONTRACT_VERSION),
        ...(reference === undefined
          ? {}
          : { [MODEL_CALL_REFERENCE_HEADER]: reference }),
        ...(recipient ? { [MODEL_CALL_RECIPIENT_HEADER]: recipient } : {}),
        ...(this.egressCapability === undefined
          ? {}
          : { authorization: 'Bearer ' + this.egressCapability }),
      },
      body: JSON.stringify({
        messages,
        system,
        tools,
        toolHistory,
        temperature,
        maxTokens,
        stop,
        reasoningEffort,
        purpose,
      }),
    });
    if (response.status === 413) {
      await response.body?.cancel();
      throw new LlmError(
        'Model request exceeds the maximum input size',
        'INPUT_TOO_LARGE',
        {
          status: 413,
        },
      );
    }
    if (!response.body)
      throw new LlmError('Host gateway returned no stream', 'TRANSPORT', {
        status: response.status,
      });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let terminal = false;
    let exhausted = false;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const result = await reader.read();
        if (result.done) {
          exhausted = true;
          break;
        }
        buffer += decoder.decode(result.value, { stream: true });
        for (;;) {
          const index = buffer.indexOf('\n');
          if (index < 0) break;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          const chunk = JSON.parse(line) as StreamChunk;
          if (
            !chunk ||
            ![
              'block-start',
              'text-delta',
              'reasoning-delta',
              'tool-call-delta',
              'block-end',
              'usage',
              'finish',
            ].includes(chunk.type)
          )
            throw new LlmError('Invalid host gateway stream', 'TRANSPORT');
          if (terminal)
            throw new LlmError('Data after host terminal', 'TRANSPORT');
          if (chunk.type === 'finish') terminal = true;
          yield chunk;
        }
      }
      if (buffer.trim() || !terminal)
        throw new LlmError(
          'Host gateway stream ended without terminal',
          'TRANSPORT',
        );
    } finally {
      if (!exhausted) await reader.cancel();
      reader.releaseLock();
    }
  }
}

/** Called from the guest's sealed profile in its Cordis fiber. Reuse the
 * native adapter registration with one managed route and no upstream secret. */
export function registerManagedGatewayAdapter(
  llm: Pick<LlmRuntime, 'registerAdapter'>,
  config: {
    readonly origin: string;
    readonly capability: string;
    readonly route: ManagedGuestModelCall;
  },
) {
  const origin = new URL(config.origin);
  if (
    origin.origin !== config.origin ||
    origin.protocol !== 'http:' ||
    origin.username ||
    origin.password ||
    !isModelCallReference(config.capability)
  )
    throw new ModelGatewayError('BINDING_INVALID');
  const route = Object.freeze({ ...config.route });
  return llm.registerAdapter(
    [route.provider],
    new GatewayLlmAdapter(
      new URL('/v1/stream', origin).href,
      config.capability,
      route,
    ),
  );
}
