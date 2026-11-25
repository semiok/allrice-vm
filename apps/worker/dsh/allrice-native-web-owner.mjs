import { Buffer } from 'node:buffer';
import { renameSync, write } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { URL } from 'node:url';
import { TextEncoder } from 'node:util';

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

// The controller's follow window is for display. Read all admitted input
// from the live journal at the exact cursor of the authenticated attempt.
export function readRootPromptOrigins(events, cursor, turn, purpose) {
  const addPrompt = (event, ids) => {
    if (event?.type !== 'user/message') return;
    const source = event.data.source;
    if (source?.kind === 'user' && typeof source.rpcId === 'string')
      ids.add(source.rpcId);
  };
  if (purpose === 'session-title') {
    const request = events[cursor];
    if (request?.type !== 'session/title-llm-request') return null;
    const messageSeqs = request.data.messageSeqs;
    if (
      !Array.isArray(messageSeqs) ||
      messageSeqs.some(
        (seq) => !Number.isSafeInteger(seq) || seq < 0 || seq >= cursor,
      )
    )
      return null;
    const ids = new Set();
    let sourceTurn = null;
    for (const seq of messageSeqs) {
      const previousSize = ids.size;
      addPrompt(events[seq], ids);
      if (ids.size !== previousSize && sourceTurn === null)
        sourceTurn =
          events.findLast(
            (event) => event.seq < seq && event.type === 'turn/start',
          )?.data.turn ?? null;
    }
    return sourceTurn === null ? null : { turn: sourceTurn, ids: [...ids] };
  }
  const start = events.findLast(
    (event) =>
      event.seq <= cursor &&
      event.type === 'turn/start' &&
      (turn === null || event.data.turn === turn),
  );
  if (!start) return null;
  const ids = new Set();
  for (const event of events.slice(start.seq + 1, cursor + 1))
    addPrompt(event, ids);
  return { turn: start.data.turn, ids: [...ids] };
}

async function observeRootPromptOrigins(
  scope,
  id,
  cursor,
  turn,
  purpose,
  signal,
) {
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !(turn === null || Number.isSafeInteger(turn))
  )
    return null;
  const live = scope.sessions.get(id);
  if (!live || live.header.parentSession || live.header.isSeeded) return null;
  const observed = await scope.sessionQuery.observeSession(id, { signal });
  try {
    signal.throwIfAborted();
    if (
      observed.source !== 'live' ||
      scope.sessions.get(id) !== live ||
      observed.header.id !== id ||
      observed.cursor < cursor
    )
      return null;
    const origin = readRootPromptOrigins(
      observed.events,
      cursor,
      turn,
      purpose,
    );
    return origin?.ids.length > 0 && origin.ids.length <= 64 ? origin : null;
  } finally {
    observed[Symbol.dispose]();
  }
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
      if (event.type !== 'user/message') continue;
      const source = event.data.source;
      if (source?.kind === 'user' && typeof source.rpcId === 'string')
        result.add(source.rpcId);
    }
    return [...result];
  }
  return [];
}

/** Carry only the inbox facts for an exact scoped prompt through the existing
 * authenticated owner transport. A waiter is registered before dispatch. */
export function observeNativePrompts(scope, lifetime) {
  const observers = new Map();
  const sources = new Map();
  const turns = new WeakMap();
  const headers = {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  };
  const encoder = new TextEncoder();
  const sourceKey = (root, principal, requestId) =>
    JSON.stringify([root, principal, requestId]);
  const pending = (agent) => [...agent.inbox.nextTurn, ...agent.inbox.nextStep];
  function messageKey(agent, message) {
    const { source } = message;
    const session = agent.session;
    if (
      session.header.parentSession ||
      session.header.isSeeded ||
      source?.kind !== 'user' ||
      typeof source.rpcId !== 'string' ||
      source.principal?.kind !== 'allrice-d-entry'
    )
      return undefined;
    return sourceKey(session.id, source.principal.scopeId, source.rpcId);
  }
  const matches = (agent, message) =>
    sources.get(messageKey(agent, message)) ?? [];
  scope.on(
    'agent/inbox/inserted',
    ({ agent, message }) => {
      for (const observer of matches(agent, message)) {
        if (observer.existing.has(message.id) || observer.itemId) continue;
        observer.itemId = message.id;
        observer.send('inserted');
      }
    },
    { global: true },
  );
  scope.on(
    'agent/inbox/claimed',
    ({ agent, message, turn }) => {
      for (const observer of matches(agent, message)) {
        if (observer.itemId !== message.id || observer.turn !== undefined)
          continue;
        observer.turn = turn;
        const session = original(agent.session);
        let active = turns.get(session);
        if (!active) turns.set(session, (active = new Map()));
        let claimed = active.get(turn);
        if (!claimed) active.set(turn, (claimed = new Set()));
        claimed.add(observer);
        observer.unclaim = () => {
          claimed.delete(observer);
          if (claimed.size === 0) active.delete(turn);
        };
        observer.send('claimed');
      }
    },
    { global: true },
  );
  scope.on(
    'agent/inbox/discarded',
    ({ agent, message }) => {
      for (const observer of matches(agent, message)) {
        if (observer.itemId !== message.id) continue;
        // rc.2 queue edit replaces in place. Queue steer removes and immediately
        // reinserts the same occurrence in its synchronous native command.
        globalThis.queueMicrotask(() => {
          if (!observers.has(observer.id) || observer.turn !== undefined)
            return;
          try {
            if (!pending(agent).some((item) => item.id === message.id))
              observer.finish('discarded');
          } catch {
            observer.finish(); // Loss of the inbox source cannot prove discard.
          }
        });
      }
    },
    { global: true },
  );
  scope.on(
    'session/event',
    (session, event) => {
      if (event.type !== 'turn/end') return;
      for (const observer of turns
        .get(original(session))
        ?.get(event.data.turn) ?? [])
        observer.finish('ended');
    },
    { global: true },
  );
  return (value, request) => {
    const notFound = () => new globalThis.Response(null, { status: 404 });
    if (
      typeof value?.id !== 'string' ||
      value.id.length !== 36 ||
      typeof value.sessionId !== 'string' ||
      typeof value.scopeId !== 'string' ||
      value.scopeId.length !== 36 ||
      typeof value.requestId !== 'string'
    )
      return notFound();
    const { id, sessionId, scopeId, requestId } = value;
    const key = sourceKey(sessionId, scopeId, requestId);
    if (value.action === 'prompt-outcome') {
      const observer = observers.get(id);
      return observer?.key === key
        ? globalThis.Response.json(
            { inserted: observer.itemId !== undefined },
            { headers: { 'cache-control': 'no-store' } },
          )
        : notFound();
    }
    if (observers.has(id)) return notFound();
    const signal = globalThis.AbortSignal.any([request.signal, lifetime]);
    signal.throwIfAborted();
    const agent = scope.agents.get(sessionId);
    const existing = new Set(
      agent
        ? pending(agent)
            .filter((message) => messageKey(agent, message) === key)
            .map(({ id }) => id)
        : [],
    );
    for (const observer of sources.get(key) ?? []) {
      if (observer.itemId) existing.add(observer.itemId);
    }
    let close;
    const body = new ReadableStream({
      start(controller) {
        const send = (type) => controller.enqueue(encoder.encode(`${type}\n`));
        let group = sources.get(key);
        if (!group) sources.set(key, (group = new Set()));
        close = () => {
          if (!observers.delete(id)) return false;
          signal.removeEventListener('abort', abort);
          group.delete(observer);
          if (group.size === 0) sources.delete(key);
          observer.unclaim?.();
          return true;
        };
        const abort = () => {
          if (close()) controller.close();
        };
        const observer = {
          id,
          key,
          existing,
          send,
          finish(type) {
            if (!close()) return;
            if (type) send(type);
            controller.close();
          },
        };
        observers.set(id, observer);
        group.add(observer);
        signal.addEventListener('abort', abort, { once: true });
        send('ready');
      },
      cancel() {
        close?.();
      },
    });
    return new globalThis.Response(body, { headers });
  };
}

// Bind continuations when the live native inbox accepts and then claims the
// exact relayed message. The recorded sender is an actual DSH Agent, and
// the recipient cannot borrow a parent's earlier turn after sender movement.
function observeDelegatedInputs(scope) {
  const inserted = new WeakMap();
  const claimed = new WeakMap();
  function currentPromptIds(session) {
    const events = session.snapshotEvents();
    const start = events.findLast((event) => event.type === 'turn/start');
    if (
      !start ||
      events.some((event) => event.type === 'turn/end' && event.seq > start.seq)
    )
      return [];
    if (session.header.parentSession) {
      const proof = claimed.get(session);
      return proof?.turn === start.data.turn
        ? [...proof.ids]
        : delegatedPromptIds(scope.sessions, session.id);
    }
    const ids = new Set();
    for (const event of events) {
      if (event.seq <= start.seq || event.type !== 'user/message') continue;
      const source = event.data.source;
      if (source?.kind === 'user' && typeof source.rpcId === 'string')
        ids.add(source.rpcId);
    }
    return [...ids];
  }
  scope.on('agent/inbox/inserted', ({ agent, message }) => {
    const child = agent.session;
    const source = message.source;
    if (
      source?.kind !== 'agent-message' ||
      source.form !== 'relay' ||
      source.senderSessionId !== child.header.parentSession
    )
      return;
    const parent = scope.sessions.get(source.senderSessionId);
    if (!parent) return;
    let messages = inserted.get(child);
    if (!messages) {
      messages = new Map();
      inserted.set(child, messages);
    }
    messages.set(message.id, currentPromptIds(parent));
  });
  scope.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const session = agent.session;
    const messages = inserted.get(session);
    const proof = messages?.get(message.id);
    if (!proof) return;
    messages.delete(message.id);
    let state = claimed.get(session);
    if (state?.turn !== turn) {
      state = { turn, ids: new Set() };
      claimed.set(session, state);
    }
    for (const id of proof) state.ids.add(id);
  });
  scope.on('agent/inbox/discarded', ({ agent, message }) => {
    inserted.get(agent.session)?.delete(message.id);
  });
  return (sessionId) => {
    const session = scope.sessions.get(sessionId);
    return session?.header.parentSession ? currentPromptIds(session) : [];
  };
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
        [
          'llm',
          'connection',
          'sessionController',
          'attachments',
          'sessions',
          'sessionQuery',
          'agents',
        ],
        async (scope) => {
          if (!current()) return;
          const modelCalls = new Map();
          const delegateOrigins = observeDelegatedInputs(scope);
          const promptFacts = observeNativePrompts(scope, signal);
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
                value?.adapterId === id &&
                (value.action === 'observe-prompt' ||
                  value.action === 'prompt-outcome')
              )
                return promptFacts(value, request);
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
              if (value.action === undefined) {
                const session = scope.sessions.get(value.sessionId);
                if (!session)
                  return new globalThis.Response(null, { status: 404 });
                const origin = session.header.parentSession
                  ? null
                  : await observeRootPromptOrigins(
                      scope,
                      value.sessionId,
                      value.cursor,
                      value.turn,
                      value.purpose,
                      globalThis.AbortSignal.any([
                        found.signal,
                        request.signal,
                      ]),
                    );
                if (!session.header.parentSession && !origin)
                  return new globalThis.Response(null, { status: 404 });
                return globalThis.Response.json(
                  {
                    id: found.id,
                    recipient: found.recipient,
                    sourceTurn: origin?.turn ?? null,
                    promptIds: origin?.ids ?? found.delegatedPromptIds,
                  },
                  { headers },
                );
              }
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
                  delegatedPromptIds: delegateOrigins(selection.sessionId),
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
