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
import { createNativeRunTerminalAttestations } from './allrice-native-run-journal.mjs';

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

function nativeOriginInput(source) {
  return ['user', 'agent-message', 'subagent-settled'].includes(source?.kind);
}

function nativePromptId(source) {
  return source?.kind === 'user' && typeof source.rpcId === 'string'
    ? source.rpcId
    : null;
}

// The controller's follow window is for display. Read admitted input from the
// live journal at the exact cursor of the authenticated attempt.
export function readPromptOrigins(
  events,
  cursor,
  turn,
  purpose,
  readDelegated = () => null,
  ownFrom = 0,
) {
  const addPrompt = (event, ids) => {
    if (event?.type !== 'user/message') return;
    const id = nativePromptId(event.data.source);
    if (id !== null) ids.add(id);
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
    return sourceTurn === null
      ? null
      : { turn: sourceTurn, ids: [...ids], delegated: false, inherited: [] };
  }
  const start = events.findLast(
    (event) =>
      event.seq >= ownFrom &&
      event.seq <= cursor &&
      event.type === 'turn/start' &&
      event.data.turn === turn,
  );
  if (!start) return null;
  const ids = new Set();
  const inherited = new Set();
  let delegated = false;
  for (let seq = start.seq + 1; seq <= cursor; seq++) {
    const event = events[seq];
    if (event.type === 'turn/end' || event.type === 'turn/start') return null;
    if (event.type !== 'user/message' || !nativeOriginInput(event.data.source))
      continue;
    const id = nativePromptId(event.data.source);
    if (id !== null) {
      ids.add(id);
      continue;
    }
    const source = readDelegated(event, turn);
    if (!source?.length) return null;
    if (!ids.size) delegated = true;
    for (const promptId of source) {
      inherited.add(promptId);
      ids.add(promptId);
    }
  }
  return { turn, ids: [...ids], delegated, inherited: [...inherited] };
}

async function observePromptOrigins(
  scope,
  live,
  cursor,
  turn,
  purpose,
  delegations,
  signal,
) {
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !(turn === null || Number.isSafeInteger(turn))
  )
    return null;
  const { id, header } = live;
  const root = delegations.root(live);
  if (!root || (header.parentSession && purpose === 'session-title'))
    return null;
  const observed = await scope.sessionQuery.observeSession(id, {
    signal,
    projectionMode: 'none',
  });
  try {
    signal.throwIfAborted();
    if (
      observed.source !== 'live' ||
      delegations.root(live) !== root ||
      observed.header.id !== id ||
      observed.cursor < cursor
    )
      return null;
    const origin = readPromptOrigins(
      observed.events,
      cursor,
      turn,
      purpose,
      (event, sourceTurn) =>
        delegations.claimed(live, event.data, sourceTurn)?.ids,
      observed.inheritedEventCount,
    );
    return origin?.ids.length > 0 && origin.ids.length <= 64
      ? {
          ...origin,
          rootSessionId: root.id,
          delegated: !!header.parentSession || origin.delegated,
        }
      : null;
  } finally {
    observed[Symbol.dispose]();
  }
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
  function observe(value, request) {
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
  }
  observe.claimed = (session, message, turn) => {
    const agent = scope.agents.get(session.id);
    return (
      !!agent &&
      original(agent.session) === original(session) &&
      matches(agent, message).some(
        (entry) => entry.itemId === message.id && entry.turn === turn,
      )
    );
  };
  return observe;
}

// Only provenance is kept here. DSH owns delivery, scheduling, and teardown.
export function observeDelegatedInputs(scope, observedClaim = () => false) {
  const turns = new WeakMap();
  const inboxes = new WeakMap();
  const activations = new Map();
  const global = { global: true };

  function liveAgent(id) {
    const agent = original(scope.agents.get(id));
    return agent && original(scope.sessions.get(id)) === original(agent.session)
      ? agent
      : null;
  }

  function root(session) {
    const seen = new Set();
    let agent = liveAgent(session.id);
    if (original(agent?.session) !== original(session)) return null;
    while (agent.session.header.parentSession) {
      if (seen.has(agent)) return null;
      seen.add(agent);
      const activation = activations.get(agent.id);
      if (
        activation?.child !== agent ||
        liveAgent(activation.parent.id) !== activation.parent
      )
        return null;
      agent = activation.parent;
    }
    return agent.session.header.isSeeded ? null : original(agent.session);
  }

  function collect(session, inputs) {
    const owner = root(session);
    if (!owner || !inputs?.length) return null;
    const ids = new Set();
    const claims = new Map();
    let searchProven = true;
    for (const input of inputs) {
      if (input?.root !== owner) return null;
      for (const id of input.ids) ids.add(id);
      if (!input.claims) searchProven = false;
      else
        for (const claim of input.claims)
          claims.set(JSON.stringify(claim), claim);
    }
    return {
      root: owner,
      ids: [...ids],
      claims: searchProven ? [...claims.values()] : null,
    };
  }

  function currentOrigin(session) {
    return collect(session, turns.get(original(session))?.inputs);
  }

  function claimed(session, message, turn) {
    const state = turns.get(original(session));
    const record = state?.turn === turn && state.claimed.get(message.id);
    const { source } = message;
    return record &&
      record.source.kind === source.kind &&
      record.source.form === source.form &&
      record.source.senderSessionId === source.senderSessionId &&
      record.source.rpcId === source.rpcId &&
      record.origin?.root === root(session)
      ? record.origin
      : null;
  }

  function rootWake(sessionId) {
    const agent = liveAgent(sessionId);
    if (!agent) return { kind: 'clear' };
    const session = original(agent.session);
    if (root(session) !== session) return { kind: 'unproven' };
    const state = turns.get(session);
    if (!state?.firstInput)
      return { kind: agent.status === 'running' ? 'unproven' : 'clear' };
    if (state.firstInput === 'prompt') return { kind: 'clear' };
    const origin = collect(
      session,
      [...state.claimed.values()].map(({ origin }) => origin),
    );
    if (!origin || state.unprovenClaim) return { kind: 'unproven' };
    const promptIds = [...new Set([...origin.ids, ...state.directClaims])];
    return promptIds.length && promptIds.length <= 64
      ? { kind: 'delegated', turn: state.turn, promptIds }
      : { kind: 'unproven' };
  }

  scope.on(
    'subagent/start',
    ({ id, runId, local }) => {
      if (!local) return;
      const child = liveAgent(id);
      const parentId = child?.session.header.parentSession;
      const parent = parentId && liveAgent(parentId);
      if (!parent || !scope.agents.isOwnedBy(id, parent)) return;
      activations.set(id, { runId, parent, child, inputs: [] });
    },
    global,
  );
  scope.on(
    'agent/disposed',
    ({ agent: subject }) => {
      const agent = original(subject);
      const activation = activations.get(agent.id);
      if (activation?.child === agent) activation.disposed = true;
      turns.get(original(agent.session))?.stop.abort();
    },
    global,
  );
  scope.on(
    'subagent/end',
    ({ id, runId, local }) => {
      const activation = activations.get(id);
      if (!local || activation?.runId !== runId) return;
      const { notice, parent, child } = activation;
      turns.get(original(child.session))?.stop.abort();
      if (notice && liveAgent(parent.id) === parent)
        notice.origin = collect(parent.session, activation.inputs);
      activations.delete(id);
    },
    global,
  );
  scope.on(
    'agent/inbox/inserted',
    ({ agent: subject, message }) => {
      const agent = original(subject);
      const session = original(agent.session);
      if (liveAgent(agent.id) !== agent) return;
      const { source } = message;
      const recipient = activations.get(agent.id);
      const record = { source, origin: null };
      if (recipient?.child === agent && !recipient.receivedInput) {
        recipient.receivedInput = true;
        if (source?.kind === 'user' && source.rpcId === undefined)
          recipient.initial = record;
      }
      if (source?.kind === 'agent-message' && source.form === 'relay') {
        const sender = liveAgent(source.senderSessionId);
        const senderActivation = activations.get(source.senderSessionId);
        if (
          sender &&
          ((recipient?.child === agent && recipient.parent === sender) ||
            (senderActivation?.child === sender &&
              senderActivation.parent === agent))
        )
          record.origin = currentOrigin(sender.session);
      } else if (
        source?.kind === 'subagent-settled' &&
        source.form === 'notice'
      ) {
        const sender = activations.get(source.senderSessionId);
        if (sender?.disposed && sender.parent === agent && !sender.notice)
          sender.notice = record;
      }
      if (
        record !== recipient?.initial &&
        source?.kind !== 'agent-message' &&
        source?.kind !== 'subagent-settled'
      )
        return;
      let inbox = inboxes.get(session);
      if (!inbox) {
        inbox = new Map();
        inboxes.set(session, inbox);
      }
      inbox.set(message.id, record);
    },
    global,
  );
  scope.on(
    'agent/inbox/claimed',
    ({ agent, message, turn }) => {
      const session = original(agent.session);
      const inbox = inboxes.get(session);
      const record = inbox?.get(message.id);
      inbox?.delete(message.id);
      const state = turns.get(session);
      if (state?.turn !== turn) return;
      if (record) state.claimed.set(message.id, record);
      if (!session.header.parentSession && nativeOriginInput(message.source)) {
        const id = nativePromptId(message.source);
        state.firstInput ??= id === null ? 'delegated' : 'prompt';
        if (id !== null) state.directClaims.add(id);
        else if (!record) state.unprovenClaim = true;
      }
    },
    global,
  );
  scope.on(
    'agent/inbox/discarded',
    ({ agent, message }) => {
      inboxes.get(original(agent.session))?.delete(message.id);
    },
    global,
  );
  scope.on(
    'session/event',
    (subject, event) => {
      const session = original(subject);
      const agent = liveAgent(session.id);
      if (original(agent?.session) !== session) return;
      if (event.type === 'turn/start') {
        turns.get(session)?.stop.abort();
        turns.set(session, {
          turn: event.data.turn,
          stop: new globalThis.AbortController(),
          claimed: new Map(),
          inputs: [],
          directClaims: new Set(),
        });
        return;
      }
      const state = turns.get(session);
      if (!state) return;
      if (event.type === 'turn/end') {
        if (event.data.turn === state.turn) {
          state.stop.abort();
          turns.delete(session);
        }
        return;
      }
      if (event.type === 'subagent/catalog') {
        // rc.2 appends its v0 catalog edge synchronously after accepting the
        // first child inbox message. A later, untagged input has no such edge.
        const { childId, childCreatedAt, mode, version } = event.data;
        const activation = activations.get(childId);
        if (
          version === 0 &&
          mode === 'continuable' &&
          activation?.parent === agent &&
          activation.child.session.header.createdAt === childCreatedAt &&
          liveAgent(childId) === activation.child &&
          activation.initial
        ) {
          activation.initial.origin = currentOrigin(session);
          activation.initial = undefined;
        }
        return;
      }
      if (
        event.type !== 'user/message' ||
        !nativeOriginInput(event.data.source)
      )
        return;
      const id = nativePromptId(event.data.source);
      const principal = event.data.source?.principal;
      const origin =
        id === null
          ? claimed(session, event.data, state.turn)
          : {
              root: root(session),
              ids: [id],
              claims:
                !session.header.parentSession &&
                principal?.kind === 'allrice-d-entry' &&
                observedClaim(session, event.data, state.turn)
                  ? [{ requestId: id, scopeId: principal.scopeId }]
                  : null,
            };
      state.inputs.push(origin);
      const activation = activations.get(agent.id);
      if (activation?.child === agent) activation.inputs.push(origin);
    },
    global,
  );
  function searchOrigin(sessionId) {
    const agent = liveAgent(sessionId);
    if (!agent || agent.status !== 'running') return null;
    const session = original(agent.session);
    const state = turns.get(session);
    const origin = currentOrigin(session);
    if (!state || !origin?.claims?.length || origin.claims.length > 64)
      return null;
    return {
      signal: state.stop.signal,
      proof: {
        rootSessionId: origin.root.id,
        claims: origin.claims,
        turn: state.turn,
      },
    };
  }

  return { root, claimed, rootWake, searchOrigin };
}

export function apply(ctx, config) {
  return applyNativeWebOwner(ctx, config);
}

export function applyNativeWebOwner(
  ctx,
  config,
  registerManagedGatewayAdapter,
  managedSearch,
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
          'agents',
          'sessions',
          'sessionQuery',
          ...(modelAdapter.webSearchEnabled ? ['tools', 'web'] : []),
        ],
        async (scope) => {
          if (!current()) return;
          const modelCalls = new Map();
          const promptFacts = observeNativePrompts(scope, signal);
          const delegations = observeDelegatedInputs(
            scope,
            promptFacts.claimed,
          );
          let openSearch;
          if (modelAdapter.webSearchEnabled) {
            const disposeSearch = await managedSearch.applyManagedSearch(
              scope,
              {
                cliPath: modelAdapter.cliPath,
                origin,
                capability,
                adapterId: id,
                enabled: true,
              },
            );
            scope.on('dispose', disposeSearch);
            openSearch = managedSearch.observeManagedSearchCalls(
              scope,
              id,
              signal,
              delegations.searchOrigin,
            );
          }
          const terminalAttestations = createNativeRunTerminalAttestations();
          const currentSession = (sessionId) =>
            original(scope.sessions.get(sessionId));
          scope.on(
            'session/created',
            (session) => terminalAttestations.attach(original(session)),
            { global: true },
          );
          scope.on(
            'session/disposed',
            (session) => terminalAttestations.detach(original(session)),
            { global: true },
          );
          scope.on(
            'session/event',
            (subject, event) => {
              if (
                !current() ||
                (event.type !== 'turn/start' && event.type !== 'turn/end')
              )
                return;
              const session = original(subject);
              if (currentSession(session.id) === session)
                terminalAttestations.observe(session, event);
            },
            { global: true },
          );
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
                value.action === 'read-root-wake' &&
                typeof value.sessionId === 'string' &&
                value.sessionId.length > 0 &&
                value.sessionId.length <= 256 &&
                Object.keys(value).length === 3
              )
                return globalThis.Response.json(
                  delegations.rootWake(value.sessionId),
                  { headers: { 'cache-control': 'no-store' } },
                );
              if (
                value?.adapterId === id &&
                value.action === 'observe-search-call' &&
                openSearch
              )
                return openSearch(value, request);
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
              if (value.action === 'read-run-terminal') {
                const persistence = scope.get('sessionPersistence');
                const terminal = await terminalAttestations.read(
                  () => currentSession(value.sessionId),
                  persistence,
                  value,
                  globalThis.AbortSignal.any([request.signal, signal]),
                );
                return terminal &&
                  current() &&
                  terminalAttestations.hasCurrent(
                    value,
                    currentSession(value.sessionId),
                  ) &&
                  original(scope.get('sessionPersistence')) ===
                    original(persistence)
                  ? globalThis.Response.json(terminal, {
                      headers: { 'cache-control': 'no-store' },
                    })
                  : new globalThis.Response(null, { status: 404 });
              }
              const found = modelCalls.get(
                JSON.stringify([value.sessionId, value.purpose]),
              );
              if (!found || found.signal.aborted)
                return new globalThis.Response(null, { status: 404 });
              const headers = { 'cache-control': 'no-store' };
              if (value.action === undefined) {
                const origin = await observePromptOrigins(
                  scope,
                  found.session,
                  value.cursor,
                  value.turn,
                  value.purpose,
                  delegations,
                  globalThis.AbortSignal.any([found.signal, request.signal]),
                );
                if (!origin)
                  return new globalThis.Response(null, { status: 404 });
                return globalThis.Response.json(
                  {
                    id: found.id,
                    recipient: found.recipient,
                    rootSessionId: origin.rootSessionId,
                    sourceTurn: origin.turn,
                    promptIds: origin.ids,
                    delegated: origin.delegated,
                    delegatedPromptIds: origin.inherited,
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
                const session = scope.sessions.get(selection.sessionId);
                if (!session)
                  throw Error('Native model session is unavailable');
                const owned = {
                  id: randomUUID(),
                  recipient: randomBytes(32).toString('base64url'),
                  session,
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
