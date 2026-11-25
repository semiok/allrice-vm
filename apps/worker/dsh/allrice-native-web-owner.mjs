import { Buffer } from 'node:buffer';
import { renameSync, write } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { URL } from 'node:url';

export const name = 'allrice-native-web-owner';
export const inject = [
  'connection',
  'webServer',
  'typertGateway',
  'appReady',
  'loader',
  'clientModules',
  'allricePrincipal',
];
const activeOwners = new WeakMap();
const cordisOriginal = Symbol.for('cordis.original');
const commandMemoryReady = Symbol.for('allrice.person-vm-command-memory.ready');
const original = (value) => value?.[cordisOriginal] ?? value;
const publicationCodes = new Set([
  'EACCES',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'EHOSTUNREACH',
  'EIO',
  'EISDIR',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'ETIMEDOUT',
]);

async function waitWhileOwned(signal, subscribe) {
  let stop, unsubscribe;
  const release = () => {
    const cancel = unsubscribe;
    unsubscribe = undefined;
    cancel?.();
  };
  try {
    return await new Promise((resolve, reject) => {
      stop = () => {
        release();
        resolve(false);
      };
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
      unsubscribe = subscribe(() => resolve(true), reject);
    });
  } finally {
    release();
    signal.removeEventListener('abort', stop);
  }
}

/** One credential-free Upgrade on this sealed listener. rc.2 destroys the
 * socket for an absent route and emits this bounded reply from the real mux. */
async function confirmGatewayMux(webServer, baseUrl, signal) {
  signal.throwIfAborted();
  const { host, port, protocol } = webServer;
  if (
    !isIP(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    protocol !== 'http:'
  )
    throw Error('Native gateway listener is unavailable');
  const expected = Buffer.from('unauthorized');
  const bytes = Buffer.alloc(expected.length);
  let physicalClose, failure;
  let received = 0;
  let complete = false;
  const agent = new (class extends Agent {
    createConnection(...args) {
      const socket = super.createConnection(...args);
      physicalClose = new Promise((resolve) => socket.once('close', resolve));
      return socket;
    }
  })({ keepAlive: false });
  const invalid = () =>
    Error('Native gateway mux readiness response was invalid');
  try {
    await new Promise((resolve) => {
      const call = request(
        {
          // Node retains an IPv6 interface zone in hostname. URL does not.
          hostname: host,
          port,
          protocol,
          path: '/api/remote.mux',
          agent,
          signal,
          headers: {
            Host: new URL(baseUrl).host,
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
            'Sec-WebSocket-Version': '13',
          },
        },
        (response) => {
          response.on('error', (error) => (failure ??= error));
          if (
            response.httpVersion !== '1.1' ||
            response.statusCode !== 401 ||
            response.statusMessage !== 'Unauthorized' ||
            response.headers.connection !== 'close' ||
            response.headers['content-type'] !== 'text/plain; charset=utf-8' ||
            response.headers['content-length'] !== String(expected.length)
          ) {
            failure = invalid();
            response.destroy();
            return;
          }
          response.on('data', (chunk) => {
            if (chunk.length > bytes.length - received) {
              failure = invalid();
              response.destroy();
              return;
            }
            chunk.copy(bytes, received);
            received += chunk.length;
          });
          response.once('end', () => {
            complete = received === bytes.length && bytes.equals(expected);
          });
        },
      );
      call.on('error', (error) => (failure ??= error));
      call.once('upgrade', (_response, socket) => {
        failure = invalid();
        socket.destroy();
      });
      call.once('close', resolve);
      call.end();
    });
  } finally {
    agent.destroy();
    await physicalClose;
  }
  if (failure) {
    if (
      signal.aborted &&
      failure.code === 'ABORT_ERR' &&
      failure.cause === signal.reason
    )
      throw signal.reason;
    throw failure;
  }
  signal.throwIfAborted();
  if (!complete) throw invalid();
}

/** An explicit local unloader also receives the actual profile retirement. */
export async function unloadNativeWebOwner(fiber) {
  const retire = activeOwners.get(fiber.dispose);
  if (!retire) throw Error('Native web owner retirement is unavailable');
  const results = await Promise.allSettled([retire(), fiber.dispose()]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, 'Native web owner retirement failed');
}

/** Native local login only. This file never establishes an AllRice principal. */
async function readManagedImage(scope, request, value, owned) {
  const { ref, target } = value;
  const limit = 20 * 1024 * 1024;
  if (typeof ref?.attachmentId !== 'string' || ref.attachmentId.length > 256)
    return null;
  const within = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;
  if (
    target !== null &&
    (!within(target?.width, 8192) ||
      !within(target?.height, 8192) ||
      !within(target?.maxBytes, limit))
  )
    return null;
  const active = globalThis.AbortSignal.any([request.signal, owned.signal]);
  active.throwIfAborted();
  // The native controller proves the attachment actually belongs to this
  // Session's durable content before the native store derives a variant.
  const { attachment, data } = await scope.sessionController.attachment({
    sessionId: value.sessionId,
    attachmentId: ref.attachmentId,
  });
  active.throwIfAborted();
  if (
    !within(attachment.bytes, limit) ||
    !['attachmentId', 'bytes', 'mediaType', 'width', 'height'].every(
      (key) => attachment[key] === ref[key],
    )
  )
    return null;
  if (!target) return { ref: attachment, data };
  const image = await scope.attachments.readImageRequest(
    attachment,
    target,
    active,
  );
  active.throwIfAborted();
  if (!within(image.bytes, limit)) return null;
  return { ...image, data: Buffer.from(image.data).toString('base64') };
}

// DSH publishes a child's durable catalog entry on its exact parent before
// running the initial delegated prompt. Continuing a child in a later turn
// needs its own accepted-input source and cannot reuse its creation event.
function delegatedPromptIds(sessions, sessionId) {
  let child = sessions.get(sessionId);
  if (!child?.header.parentSession) return [];
  const seen = new Set([sessionId]);
  while (child.header.parentSession) {
    const parent = sessions.get(child.header.parentSession);
    if (!parent || seen.has(parent.id)) return [];
    seen.add(parent.id);
    const events = parent.snapshotEvents();
    const catalog = events.filter(
      (event) =>
        event.type === 'subagent/catalog' &&
        event.data.childId === child.id &&
        event.data.childCreatedAt === child.header.createdAt &&
        event.data.version === 0,
    );
    if (catalog.length !== 1) return [];
    const edge = catalog[0];
    const start = events.findLast(
      (event) => event.type === 'turn/start' && event.seq < edge.seq,
    );
    if (
      !start ||
      events.some((event) => event.type === 'turn/end' && event.seq > start.seq)
    )
      return [];
    if (parent.header.parentSession) {
      child = parent;
      continue;
    }
    const result = new Set();
    for (const event of events) {
      if (event.seq <= start.seq || event.seq > edge.seq) continue;
      const messages =
        event.type === 'user/message'
          ? [event.data]
          : event.type === 'agent/inbox/spliced'
            ? event.data.inserted
            : [];
      for (const message of messages)
        if (
          message?.source?.kind === 'user' &&
          typeof message.source.rpcId === 'string'
        )
          result.add(message.source.rpcId);
    }
    return [...result];
  }
  return [];
}

export function apply(ctx, config) {
  return applyNativeWebOwner(ctx, config);
}

export function applyNativeWebOwner(
  ctx,
  config,
  registerManagedGatewayAdapter,
) {
  const { artifactPath, nonce, baseUrl, commandMemoryPlugin, modelAdapter } =
    config;
  const { fiber } = ctx;
  const providers = Object.entries(fiber.store ?? {}).map(
    ([name, provider]) => [name, provider.fiber, original(provider.value)],
  );
  const temporary = `${artifactPath}.${randomUUID()}.tmp`;
  const lifetime = new globalThis.AbortController();
  const { signal } = lifetime;
  const canceled = Error('Native auth publication canceled');
  let publicationStage = 'readiness';
  let publishing;
  let publicationFailure;
  let stagingCleanupFailure;
  let commandMemory;
  let registeredModel;
  let modelFiber;
  let published = false;
  let retiring = false;
  const stop = () => {
    retiring = true;
    lifetime.abort(canceled);
    registeredModel?.dispose();
    registeredModel = undefined;
  };
  const sameConfig = (value) =>
    value?.artifactPath === artifactPath &&
    value?.nonce === nonce &&
    value?.baseUrl === baseUrl &&
    value?.commandMemoryPlugin === commandMemoryPlugin &&
    JSON.stringify(value?.modelAdapter) === JSON.stringify(modelAdapter);
  const entry = fiber.entry;
  const current = () =>
    !retiring &&
    fiber.uid !== null &&
    (!entry || sameConfig(entry.options.config)) &&
    (!commandMemory ||
      (original(ctx.get('subprocess')) === commandMemory.subprocess &&
        original(ctx.get('sandbox')) === commandMemory.sandbox)) &&
    (!registeredModel || original(ctx.get('llm')) === registeredModel.llm) &&
    providers.every(([name, provider, value]) => {
      const live = ctx.get(name);
      return provider.uid !== null && live != null && original(live) === value;
    });
  const observed = ctx.allricePrincipal.observeProfileGraph(ctx.clientModules, {
    current,
    publish() {
      return (publishing = publish().catch((error) => {
        if (error === canceled) return;
        publicationFailure = { error };
        throw error;
      }));
    },
    async retire() {
      stop();
      await publishing?.catch(() => {});
      const [modelCleanup] = await Promise.allSettled([
        Promise.resolve().then(() => modelFiber?.dispose()),
      ]);
      try {
        if (published) await rm(artifactPath, { force: true });
      } catch (error) {
        if (stagingCleanupFailure)
          throw new AggregateError(
            [stagingCleanupFailure.error, error],
            'Native auth cleanup failed',
          );
        throw error;
      }
      if (modelCleanup.status === 'rejected') throw modelCleanup.reason;
      if (stagingCleanupFailure) throw stagingCleanupFailure.error;
    },
  });
  const retire = () => {
    stop();
    return observed.close();
  };
  // An explicit caller can observe the generation's publication failure.
  // Successors wait for the real shared retirement and its cleanup failures.
  activeOwners.set(fiber.dispose, async () => {
    try {
      await retire();
    } catch (error) {
      if (publicationFailure && publicationFailure.error !== error)
        throw new AggregateError(
          [publicationFailure.error, error],
          'Native web owner retirement failed',
        );
      throw error;
    }
    if (publicationFailure) throw publicationFailure.error;
  });
  const retireMissingOwner = () => {
    if (!current()) void retire().catch(() => {});
  };
  // Cordis clears the actual uid or injection before its loading effect can
  // reach a disposer. That notification also fences existing scopes now.
  ctx.on('internal/plugin', retireMissingOwner);
  ctx.on('internal/service', retireMissingOwner);
  ctx.on('loader/partial-dispose', (changed) => {
    if (!entry || changed !== entry || sameConfig(entry.options.config)) return;
    void retire().catch(() => {});
  });
  ctx.effect(() => retire, 'allrice native profile and local auth lifetime');
  // Startup and this entry must settle before the launcher can call appReady.
  // The observer owns publication outside the Loader's apply task.
  void observed.ready.catch((error) => {
    if (!current()) return;
    publicationFailure ??= { error };
    void retire().catch(() => {});
    if (publishing) {
      // The rc.2 startup log exporter is removed before appReady. Write only
      // the bounded marker to the existing native job's stderr, after fencing.
      const code = publicationCodes.has(error?.code) ? error.code : 'FAILED';
      try {
        write(
          2,
          `Native web auth publication failed [${publicationStage}/${code}]\n`,
          () => {},
        );
      } catch {
        // A closed diagnostic sink cannot change the retirement result.
      }
    }
  });

  async function publish() {
    if (!(await waitWhileOwned(signal, (ready) => ctx.appReady.onReady(ready))))
      return;
    if (!current()) return;
    // rc.2 dispatches ready listeners synchronously. This continuation runs
    // after dispatch and lets the shared Loader settle its actual entries.
    if (
      !(await waitWhileOwned(signal, (settled, reject) => {
        void ctx.loader.await().then(settled, reject);
      }))
    )
      return;
    if (!current()) return;
    if (commandMemoryPlugin !== undefined) {
      // Resolve the active providers through Cordis's actual dependency
      // snapshot. A persistent profile can contribute other providers.
      const observed = ctx.inject(['subprocess', 'sandbox'], () => {});
      try {
        await observed;
        const runtime = observed.store?.subprocess;
        const confinement = observed.store?.sandbox;
        const subprocess = original(runtime?.value);
        const sandbox = original(confinement?.value);
        if (
          subprocess?.[commandMemoryReady] !== true ||
          !runtime?.fiber ||
          runtime.fiber.entry?.options?.name !== commandMemoryPlugin ||
          confinement?.fiber.parent.fiber !== runtime.fiber ||
          typeof sandbox?.confine !== 'function'
        )
          throw Error('Native command memory controls are unavailable');
        commandMemory = { subprocess, sandbox };
      } finally {
        await observed.dispose();
      }
    }
    if (!current()) return;
    if (modelAdapter !== undefined) {
      publicationStage = 'model';
      if (typeof registerManagedGatewayAdapter !== 'function')
        throw Error('Native managed model module is unavailable');
      if (!current()) return;
      const { id, origin, capability, provider, model, modelInfo } =
        modelAdapter;
      if (!/^[a-f0-9]{64}$/.test(id))
        throw Error('Native managed model binding is invalid');
      modelFiber = ctx.inject(
        ['llm', 'connection', 'sessionController', 'attachments', 'sessions'],
        async (scope) => {
          if (!current()) return;
          const modelCalls = new Map();
          scope.connection.fetch.register({
            // Native exact Fetch routes are delivered only to the authenticated
            // owner Peer. This path is consumed by the managed Host transport.
            path: '/api/allrice-managed-model/current',
            methods: ['POST'],
            requestBody: 'buffered',
            async fetch(request) {
              if (!current())
                return new globalThis.Response(null, { status: 404 });
              const value = await request.json();
              if (
                value?.adapterId !== id ||
                typeof value?.sessionId !== 'string' ||
                !['assistant', 'compaction', 'session-title'].includes(
                  value.purpose,
                )
              )
                return new globalThis.Response(null, { status: 404 });
              const found = modelCalls.get(
                JSON.stringify([value.sessionId, value.purpose]),
              );
              if (!found || found.signal.aborted)
                return new globalThis.Response(null, { status: 404 });
              const headers = { 'cache-control': 'no-store' };
              if (value.action === undefined)
                return globalThis.Response.json(
                  {
                    id: found.id,
                    recipient: found.recipient,
                    delegatedPromptIds: found.delegatedPromptIds,
                  },
                  { headers },
                );
              if (
                value.action !== 'read-image' ||
                (value.purpose !== 'assistant' && value.attemptId !== found.id)
              )
                return new globalThis.Response(null, { status: 404 });
              const image = await readManagedImage(
                scope,
                request,
                value,
                found,
              );
              return image
                ? globalThis.Response.json(image, { headers })
                : new globalThis.Response(null, { status: 404 });
            },
          });
          const dispose = registerManagedGatewayAdapter(scope.llm, {
            origin,
            capability,
            route: {
              provider,
              model,
              modelInfo,
              lifetime: signal,
              async resolveCallReference(selection, active, purpose) {
                const key = JSON.stringify([
                  selection.sessionId,
                  purpose ?? 'assistant',
                ]);
                if (modelCalls.has(key))
                  throw Error('Concurrent native model ownership is ambiguous');
                const owned = {
                  id: randomUUID(),
                  recipient: randomBytes(32).toString('base64url'),
                  delegatedPromptIds: delegatedPromptIds(
                    scope.sessions,
                    selection.sessionId,
                  ),
                  signal: active,
                };
                modelCalls.set(key, owned);
                const release = () => {
                  active.removeEventListener('abort', release);
                  if (modelCalls.get(key) === owned) modelCalls.delete(key);
                };
                active.addEventListener('abort', release, { once: true });
                try {
                  active.throwIfAborted();
                  const endpoint = new URL(
                    purpose ? '/v1/reference/' + purpose : '/v1/reference',
                    origin,
                  );
                  const response = await globalThis.fetch(endpoint, {
                    method: 'POST',
                    redirect: 'error',
                    signal: active,
                    headers: {
                      authorization: 'Bearer ' + capability,
                      'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                      ...selection,
                      adapterId: id,
                      recipient: owned.recipient,
                    }),
                  });
                  if (!response.ok) {
                    await response.body?.cancel();
                    throw Error('Native managed model call was denied');
                  }
                  return {
                    reference: (await response.json()).reference,
                    recipient: owned.recipient,
                    release,
                  };
                } catch (error) {
                  release();
                  throw error;
                }
              },
            },
          });
          registeredModel = { dispose, llm: original(scope.llm), id };
          const models = await scope.llm.listModels(provider);
          if (models.length !== 1 || models[0].id !== model)
            throw Error('Native managed model was not registered');
        },
      );
      if (
        !(await waitWhileOwned(signal, (ready, reject) => {
          void Promise.resolve(modelFiber).then(ready, reject);
        }))
      )
        return;
      if (!registeredModel)
        throw Error('Native managed model was not installed');
    }
    if (!current()) return;
    publicationStage = 'mux';
    await confirmGatewayMux(ctx.webServer, baseUrl, signal);
    if (!current()) return;
    publicationStage = 'artifact';
    await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
    if (!current()) return;
    let primary;
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          v: 1,
          nonce,
          modelAdapterId: registeredModel?.id,
          authenticatedUrl: ctx.connection.authenticatedUrl(baseUrl),
        }),
        { flag: 'wx', mode: 0o600 },
      );
      // The last generation check and same-directory publication have one
      // ordering with Cordis disposal, even if staging the nonce took time.
      if (current()) {
        renameSync(temporary, artifactPath);
        published = true;
        return;
      }
    } catch (error) {
      primary = { error };
    }
    try {
      await rm(temporary, { force: true });
    } catch (error) {
      const failure = primary
        ? new AggregateError(
            [primary.error, error],
            'Native auth staging failed',
          )
        : error;
      stagingCleanupFailure = { error: failure };
      throw failure;
    }
    if (primary) throw primary.error;
  }
}
