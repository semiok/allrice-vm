import { createHash, randomUUID } from 'node:crypto';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import {
  ModelGatewayError,
  MODEL_GATEWAY_CONTRACT_VERSION,
} from './contract.ts';
import type {
  ModelCallBinding,
  ModelGatewayAuthority,
  ModelGatewayAdmission,
  ModelGatewayPort,
  ModelGatewayStore,
  GatewayModelInput,
  GatewayProvider,
} from './contract.ts';
import type {
  PersonVmAdmissionPermit,
  PersonVmBinding,
} from '@allrice/person-vm';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMeteredTransport, installScopedFetch } from './transport.ts';
import { runGatewayAdmission } from './admission.ts';

// Allow long DSH contexts and tool histories on the JSON wire. Images travel
// as attachment references and resolve separately on the Host.
const maxModelInputBytes = 8 * 1024 * 1024;
const inputKeys = [
  'messages',
  'system',
  'tools',
  'toolHistory',
  'temperature',
  'maxTokens',
  'stop',
  'reasoningEffort',
  'purpose',
];
export function decodeGatewayInput(value: unknown): GatewayModelInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ModelGatewayError('INVALID_INPUT');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !inputKeys.includes(key)) ||
    !Array.isArray(input.messages)
  )
    throw new ModelGatewayError('INVALID_INPUT');
  for (const message of input.messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      !['system', 'user', 'assistant', 'tool', 'developer'].includes(
        message.role,
      ) ||
      !Array.isArray(message.content)
    )
      throw new ModelGatewayError('INVALID_INPUT');
  }
  if (input.system !== undefined && typeof input.system !== 'string')
    throw new ModelGatewayError('INVALID_INPUT');
  if (
    input.tools !== undefined &&
    (!Array.isArray(input.tools) ||
      input.tools.some(
        (tool) =>
          !tool ||
          typeof tool.name !== 'string' ||
          typeof tool.description !== 'string' ||
          !tool.parameters ||
          typeof tool.parameters !== 'object' ||
          Array.isArray(tool.parameters),
      ))
  )
    throw new ModelGatewayError('INVALID_INPUT');
  if (
    input.temperature !== undefined &&
    (typeof input.temperature !== 'number' ||
      !Number.isFinite(input.temperature))
  )
    throw new ModelGatewayError('INVALID_INPUT');
  if (
    input.maxTokens !== undefined &&
    (typeof input.maxTokens !== 'number' ||
      !Number.isSafeInteger(input.maxTokens) ||
      input.maxTokens <= 0)
  )
    throw new ModelGatewayError('INVALID_INPUT');
  if (
    input.stop !== undefined &&
    (!Array.isArray(input.stop) ||
      input.stop.some((s) => typeof s !== 'string'))
  )
    throw new ModelGatewayError('INVALID_INPUT');
  if (
    input.reasoningEffort !== undefined &&
    typeof input.reasoningEffort !== 'string'
  )
    throw new ModelGatewayError('INVALID_INPUT');
  if (
    input.purpose !== undefined &&
    !['compaction', 'session-title'].includes(String(input.purpose))
  )
    throw new ModelGatewayError('INVALID_INPUT');
  // Message/tool semantics remain DSH's public contract. These checks enforce
  // the wire boundary, never infer intent, identity or permissions from content.
  return input as unknown as GatewayModelInput;
}

function assertBinding(b: ModelCallBinding): void {
  const strings = [
    b.vm.vmId,
    b.vm.personId,
    b.vm.organizationId,
    b.vm.instanceId,
    b.execution.runId,
    b.execution.executionId,
    b.employeeInstanceId,
    b.employeeRelease,
    b.allriceThreadRef,
    b.native.instanceId,
    b.native.profile,
    b.native.sessionId,
    b.native.rootSessionId,
    b.native.callId,
    b.executionGeneration,
    b.gatewayRelease,
    b.provider,
    b.model,
  ];
  if (
    strings.some((s) => typeof s !== 'string' || !s.trim()) ||
    !Number.isSafeInteger(b.vm.leaseEpoch) ||
    b.vm.leaseEpoch <= 0 ||
    b.context.actor.type !== 'user' ||
    b.context.actor.id !== b.vm.personId ||
    b.context.organizationId !== b.vm.organizationId ||
    (b.native.sessionId === b.native.rootSessionId) !==
      (b.native.parentSessionId === null) ||
    (b.native.parentSessionId !== null &&
      (!b.native.parentSessionId.trim() ||
        b.native.parentSessionId === b.native.sessionId))
  )
    throw new ModelGatewayError('BINDING_INVALID');
}
const vmKey = (vm: PersonVmBinding) =>
  JSON.stringify([
    vm.vmId,
    vm.personId,
    vm.organizationId,
    vm.instanceId,
    vm.leaseEpoch,
  ]);
async function readInput(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<GatewayModelInput> {
  const length = request.headers['content-length'];
  if (length && Number(length) > maxModelInputBytes)
    throw new ModelGatewayError('INPUT_TOO_LARGE');
  const chunks: Buffer[] = [];
  let bytes = 0;
  const onAbort = () => request.destroy();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    // Keep the socket writable on an early exit so the peer receives the 413.
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      signal.throwIfAborted();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxModelInputBytes)
        throw new ModelGatewayError('INPUT_TOO_LARGE');
      chunks.push(buffer);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  try {
    return decodeGatewayInput(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
  } catch (cause) {
    throw new ModelGatewayError('INVALID_INPUT', { cause });
  }
}
async function send(
  response: ServerResponse,
  chunk: StreamChunk,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (response.destroyed) throw new ModelGatewayError('ADMISSION_CLOSED');
  if (response.write(JSON.stringify(chunk) + '\n')) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      signal.removeEventListener('abort', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ModelGatewayError('ADMISSION_CLOSED'));
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    signal.addEventListener('abort', onClose, { once: true });
    if (signal.aborted) onClose();
  });
}

/** Inert until a trusted host explicitly creates and mounts it. */
export function createModelGateway(options: {
  ownerId: string;
  authority: ModelGatewayAuthority;
  store: ModelGatewayStore;
  provider: GatewayProvider | ((binding: ModelCallBinding) => GatewayProvider);
  admission: ModelGatewayAdmission;
  /** Host-owned context selected for the authenticated, redeemed attempt. */
  readTrustedContext?(
    binding: ModelCallBinding,
    signal: AbortSignal,
    phase: 'seal' | 'dispatch',
  ): Promise<string | undefined>;
  confirmTransportStopped?(
    ownerId: string,
    signal: AbortSignal,
  ): Promise<string>;
}): ModelGatewayPort {
  if (
    !options.ownerId.trim() ||
    options.admission.participant.participant !== 'gateway'
  )
    throw new ModelGatewayError('BINDING_INVALID');
  const uninstall = installScopedFetch();
  const active = new Set<{
    key: string;
    controller: AbortController;
    done: Promise<void>;
  }>();
  let closed = false;
  const revoked = new Set<string>();
  // The request callback may finish without proving the underlying join.
  // Keep the failure after it leaves the active set, scoped to its VM epoch.
  const unfinishedPermits = new Set<PersonVmAdmissionPermit>();
  async function releaseStoppedPermits(signal: AbortSignal) {
    const recover = options.admission.recoverStoppedPermit;
    if (!recover) return;
    for (const permit of unfinishedPermits) {
      await recover(permit, signal);
      unfinishedPermits.delete(permit);
    }
  }
  const unconfirmedJoins = new Map<
    string,
    { binding: PersonVmBinding; failures: ModelGatewayError[] }
  >();
  function incompleteJoin(record: {
    binding: PersonVmBinding;
    failures: ModelGatewayError[];
  }) {
    return Object.assign(
      new ModelGatewayError('LEDGER_UNAVAILABLE', {
        cause: new AggregateError(
          record.failures,
          'Model transport join unconfirmed',
        ),
      }),
      { binding: record.binding },
    );
  }
  return {
    admission: options.admission.participant,
    async issueReference(binding, hostSignal, issue) {
      assertBinding(binding);
      const key = vmKey(binding.vm);
      const controller = new AbortController();
      const signal = AbortSignal.any([hostSignal, controller.signal]);
      if (closed || revoked.has(key))
        throw new ModelGatewayError('ADMISSION_CLOSED');
      const task = runGatewayAdmission(
        options.admission,
        binding,
        `${options.ownerId}:reference:${randomUUID()}`,
        signal,
        async (active, activate) => {
          try {
            await activate();
            active.throwIfAborted();
            await options.authority.assertCall(binding, active);
            return { ok: true, value: await issue(active) };
          } catch (error) {
            return { ok: false, error };
          }
        },
        options.admission.recoverStoppedPermit
          ? (permit) => {
              unfinishedPermits.add(permit);
            }
          : undefined,
      );
      const entry = {
        key,
        controller,
        done: task.then(
          () => {},
          () => {},
        ),
      };
      active.add(entry);
      try {
        return await task;
      } finally {
        active.delete(entry);
      }
    },
    async handle(request, response, bindingInput, hostSignal) {
      const controller = new AbortController();
      // Detach the immutable admission fact before the first await.
      let binding: ModelCallBinding;
      try {
        binding = JSON.parse(JSON.stringify(bindingInput)) as ModelCallBinding;
        assertBinding(binding);
      } catch {
        response.writeHead(403);
        response.end();
        return;
      }
      let delivery: AbortSignal | undefined;
      try {
        delivery = options.authority.deliverySignal?.(binding);
      } catch {
        response.writeHead(403).end();
        return;
      }
      const signal = AbortSignal.any([
        hostSignal,
        controller.signal,
        ...(delivery ? [delivery] : []),
      ]);
      const assertDelivery = async (active: AbortSignal) => {
        active.throwIfAborted();
        const observed = options.authority.assertDeliveryObserved;
        if (delivery && observed) {
          delivery.throwIfAborted();
          await observed(binding, active);
          delivery.throwIfAborted();
          active.throwIfAborted();
        } else await assertCurrent(active);
      };
      const key = vmKey(binding.vm);
      let finish!: () => void;
      const entry = {
        key,
        controller,
        done: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      };
      active.add(entry);
      const onClose = () => {
        if (!response.writableEnded)
          controller.abort(new Error('model_gateway_client_disconnected'));
      };
      response.on('close', onClose);
      const assertCurrent = async (currentSignal: AbortSignal) => {
        currentSignal.throwIfAborted();
        if (closed || revoked.has(key))
          throw new ModelGatewayError('ADMISSION_CLOSED');
        await options.authority.assertCall(binding, currentSignal);
        currentSignal.throwIfAborted();
      };
      try {
        await assertCurrent(signal);
        if (
          request.method !== 'POST' ||
          request.url !== '/v1/stream' ||
          request.headers['x-allrice-model-contract'] !==
            String(MODEL_GATEWAY_CONTRACT_VERSION)
        )
          throw new ModelGatewayError('INVALID_INPUT');
        const terminalReply = await runGatewayAdmission<StreamChunk>(
          options.admission,
          binding,
          `${options.ownerId}:${randomUUID()}`,
          signal,
          async (signal, activate) => {
            let transport:
              ReturnType<typeof createMeteredTransport> | undefined;
            let iterator: AsyncIterator<StreamChunk> | undefined;
            let exhausted = false;
            let joinFailure: unknown;
            let joined = true;
            let terminalReply: StreamChunk | undefined;
            let operationFailure: unknown;
            let operationFailed = false;
            try {
              const received = await readInput(request, signal);
              const kind = binding.native.attemptKind;
              if (
                kind &&
                received.purpose !== (kind === 'assistant' ? undefined : kind)
              )
                throw new ModelGatewayError('BINDING_INVALID');
              let trustedContext: string | undefined;
              if (options.readTrustedContext && !received.purpose) {
                await assertDelivery(signal);
                trustedContext = await options.readTrustedContext(
                  binding,
                  signal,
                  'seal',
                );
                await assertDelivery(signal);
              }
              signal.throwIfAborted();
              const input = trustedContext
                ? {
                    ...received,
                    system: received.system
                      ? `${received.system}\n\n${trustedContext}`
                      : trustedContext,
                  }
                : received;
              const serialized = JSON.stringify(input);
              if (
                trustedContext &&
                Buffer.byteLength(serialized) > maxModelInputBytes
              )
                throw new ModelGatewayError('INPUT_TOO_LARGE');
              const digest =
                'sha256:' +
                createHash('sha256').update(serialized).digest('hex');
              const provider =
                typeof options.provider === 'function'
                  ? options.provider(binding)
                  : options.provider;
              const callId = await options.store.claimCall(binding, digest);
              transport = createMeteredTransport({
                ...options,
                provider,
                binding,
                callId,
                signal,
                assertCurrent,
                activate,
                assertContextCurrent:
                  trustedContext === undefined
                    ? undefined
                    : async (active) => {
                        if (
                          trustedContext !==
                          (await options.readTrustedContext?.(
                            binding,
                            active,
                            'dispatch',
                          ))
                        )
                          throw new ModelGatewayError('AUTHORIZATION_DENIED');
                      },
              });
              iterator = transport.run(() => {
                const source = provider.stream(binding, input, signal);
                return source[Symbol.asyncIterator]();
              });
              response.writeHead(200, {
                'content-type': 'application/x-ndjson',
                'cache-control': 'no-store',
                'x-allrice-model-contract': String(
                  MODEL_GATEWAY_CONTRACT_VERSION,
                ),
              });
              let terminal:
                Extract<StreamChunk, { type: 'finish' }> | undefined;
              for (;;) {
                await assertDelivery(signal);
                const result = await transport.run(() => iterator!.next());
                if (result.done) {
                  exhausted = true;
                  break;
                }
                await assertDelivery(signal);
                if (result.value.type === 'finish') terminal = result.value;
                // Never forward provider-synthesized zeros, nor announce success
                // before the actual upstream body and durable receipt have settled.
                else if (result.value.type !== 'usage')
                  await send(response, result.value, signal);
              }
              await transport.drain();
              await assertCurrent(signal);
              const attempts = (await options.store.attempts(callId)).filter(
                (a) => a.kind === 'model',
              );
              const last = attempts.at(-1);
              if (
                terminal &&
                (terminal.reason.kind === 'error' ||
                  terminal.reason.kind === 'aborted')
              ) {
                const failure = terminal.reason.failure;
                terminalReply = {
                  ...terminal,
                  reason: {
                    kind: terminal.reason.kind,
                    failure: new LlmError(
                      'Upstream model request failed',
                      failure.code,
                      {
                        ...(failure.status === undefined
                          ? {}
                          : { status: failure.status }),
                        ...(failure.providerRetryAfterMs === undefined
                          ? {}
                          : {
                              providerRetryAfterMs:
                                failure.providerRetryAfterMs,
                            }),
                        ...(failure.requestId === undefined
                          ? {}
                          : { requestId: failure.requestId }),
                        ...(failure.offloadImages === undefined
                          ? {}
                          : { offloadImages: failure.offloadImages }),
                      },
                    ).failure,
                  },
                };
              } else {
                if (
                  !terminal ||
                  !['stop', 'tool-calls', 'max-tokens'].includes(
                    terminal.reason.kind,
                  )
                )
                  throw new ModelGatewayError('PROVIDER_FAILED');
                if (
                  !last ||
                  last.outcome !== 'closed' ||
                  last.httpStatus === null ||
                  last.httpStatus < 200 ||
                  last.httpStatus >= 300 ||
                  !(
                    last.terminal === 'completed' ||
                    (terminal.reason.kind === 'max-tokens' &&
                      last.terminal === 'incomplete' &&
                      last.terminalReason === 'max_output_tokens')
                  )
                )
                  throw new ModelGatewayError('MISSING_UPSTREAM_TERMINAL');
                if (last.usage.usageComplete && last.usage.cacheUsageKnown) {
                  const usage = last.usage;
                  await send(
                    response,
                    {
                      type: 'usage',
                      usage: {
                        inputTokens:
                          usage.inputTokens! - usage.cachedInputTokens!,
                        outputTokens: usage.outputTokens!,
                        cacheReadTokens: usage.cachedInputTokens!,
                        totalTokens: usage.totalTokens!,
                      },
                    },
                    signal,
                  );
                }
                terminalReply = terminal;
              }
            } catch (error) {
              // Business failure is a value until actual shutdown has joined. A
              // normal upstream refusal must not leave an unknown admission item.
              operationFailure = error;
              operationFailed = true;
              controller.abort(error);
            } finally {
              if (!exhausted && iterator) {
                controller.abort(new Error('model_gateway_iterator_closed'));
                try {
                  await transport!.run(() => iterator!.return?.());
                } catch (error) {
                  joined = false;
                  joinFailure ??= error;
                }
              }
              try {
                await transport?.drain();
              } catch (error) {
                // A receipt write can fail AFTER actual HTTP/transactions
                // joined. Retain its exact DB slot and business error, without
                // inventing still-running activity from an error code.
                operationFailure = operationFailed
                  ? new ModelGatewayError('LEDGER_UNAVAILABLE', {
                      cause: new AggregateError(
                        [operationFailure, error],
                        'receipt and request failure',
                      ),
                    })
                  : error;
                operationFailed = true;
                if (!transport!.joinKnown) {
                  joined = false;
                  joinFailure ??= error;
                }
              }
            }
            if (!joined) {
              const error = new ModelGatewayError('LEDGER_UNAVAILABLE', {
                cause:
                  operationFailed && operationFailure !== joinFailure
                    ? new AggregateError(
                        [operationFailure, joinFailure],
                        'request join unknown',
                      )
                    : joinFailure,
              });
              const previous = unconfirmedJoins.get(key);
              if (previous) previous.failures.push(error);
              else
                unconfirmedJoins.set(key, {
                  binding: Object.freeze(binding.vm),
                  failures: [error],
                });
              throw error;
            }
            return operationFailed
              ? { ok: false, error: operationFailure }
              : { ok: true, value: terminalReply! };
          },
          options.admission.recoverStoppedPermit
            ? (permit) => {
                unfinishedPermits.add(permit);
              }
            : undefined,
        );
        await assertCurrent(signal);
        await send(response, terminalReply, signal);
        response.end();
      } catch (error) {
        controller.abort(error);
        // Drain before any error response; a ledger failure supersedes an
        // apparently successful provider and keeps its unresolved DB lease.
        const code =
          error instanceof ModelGatewayError ? error.code : 'PROVIDER_FAILED';
        const rebind = code === 'EXECUTION_REBIND_REQUIRED';
        if (!response.destroyed) {
          if (!response.headersSent && code === 'INPUT_TOO_LARGE') {
            response.writeHead(413, { connection: 'close' }).end();
            return;
          }
          if (!response.headersSent)
            response.writeHead(
              rebind
                ? 200
                : code === 'DUPLICATE_CALL'
                  ? 409
                  : code === 'INVALID_INPUT'
                    ? 400
                    : code === 'AUTHORIZATION_DENIED'
                      ? 403
                      : 503,
              { 'content-type': 'application/x-ndjson' },
            );
          response.end(
            JSON.stringify({
              type: 'finish',
              reason: {
                kind: rebind ? 'aborted' : 'error',
                failure: new LlmError('Host model gateway request failed', code)
                  .failure,
              },
            }) + '\n',
          );
        }
      } finally {
        response.off('close', onClose);
        active.delete(entry);
        finish();
      }
    },
    async revoke(binding) {
      const key = vmKey(binding);
      revoked.add(key);
      const entries = [...active].filter((entry) => entry.key === key);
      for (const entry of entries)
        entry.controller.abort(new Error('model_gateway_binding_revoked'));
      await Promise.all(entries.map((entry) => entry.done));
      const incomplete = unconfirmedJoins.get(key);
      if (incomplete) throw incompleteJoin(incomplete);
    },
    async reconcileClosedOwner(signal) {
      signal.throwIfAborted();
      if (!closed || active.size || !options.confirmTransportStopped)
        throw new ModelGatewayError('AUTHORIZATION_DENIED');
      const evidence = await options.confirmTransportStopped(
        options.ownerId,
        signal,
      );
      signal.throwIfAborted();
      if (!evidence.trim()) throw new ModelGatewayError('AUTHORIZATION_DENIED');
      await releaseStoppedPermits(signal);
      const released = await options.store.reconcileOwner(
        options.ownerId,
        evidence,
      );
      unconfirmedJoins.clear();
      uninstall();
      return released;
    },
    async reconcileOwner(context, ownerId, signal) {
      signal.throwIfAborted();
      const recoveringClosedOwner =
        ownerId === options.ownerId && closed && active.size === 0;
      const evidence = await options.authority.confirmOwnerStopped(
        context,
        ownerId,
        signal,
      );
      signal.throwIfAborted();
      if (!evidence.evidenceRef.trim())
        throw new ModelGatewayError('AUTHORIZATION_DENIED');
      if (recoveringClosedOwner) await releaseStoppedPermits(signal);
      const released = await options.store.reconcileOwner(
        ownerId,
        evidence.evidenceRef,
      );
      if (recoveringClosedOwner && active.size === 0) {
        // The stop proof was accepted before beginning the durable write.
        // Once it commits, carry the count and finish the local fence even
        // if the maintenance caller canceled while the ledger was settling.
        unconfirmedJoins.clear();
        uninstall();
        return released;
      }
      signal.throwIfAborted();
      return released;
    },
    async close() {
      closed = true;
      for (const entry of active)
        entry.controller.abort(new Error('model_gateway_closed'));
      await Promise.all([...active].map((entry) => entry.done));
      if (unconfirmedJoins.size)
        // A detached provider can still inherit a stopped metered scope. Keep
        // its fence installed until this exact closed owner is recovered.
        throw new AggregateError(
          [...unconfirmedJoins.values()].map(incompleteJoin),
          'Model gateway join unconfirmed',
        );
      uninstall();
    },
    ledger: {
      async summarize(context, signal) {
        const identity = await options.authority.authorizeUsage(
          context,
          signal,
        );
        signal.throwIfAborted();
        if (
          context.actor.type !== 'user' ||
          identity.personId !== context.actor.id ||
          identity.organizationId !== context.organizationId
        )
          throw new ModelGatewayError('AUTHORIZATION_DENIED');
        return options.store.usage(identity.personId, identity.organizationId);
      },
    },
  };
}
