import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { selectScopedModel } from '@allrice/model-gateway';
import {
  managedModelRequest,
  managedModelPrompt,
  nativePromptOccurrence,
  observeDelegatedInputs,
  observeNativePrompts,
  observeOriginalRequest,
  readPromptOrigins,
  withNativeToolEvidence,
  withNativeMemoryToolPublication,
} from './allrice-native-web-owner.mjs';

const promptRoot = { id: 'root', header: {} };
const principal = { kind: 'allrice-d-entry', scopeId: randomUUID() };
function userPrompt(rpcId) {
  return { id: `message-${rpcId}`, source: { kind: 'user', rpcId, principal } };
}
function readDirect(session) {
  return (event, turn) => nativePromptOccurrence(session, event.data, turn);
}

it('keeps the admitted prompt of a long turn and excludes queued and future input', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: userPrompt('older') },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: userPrompt('current') },
    { type: 'user/message', data: userPrompt('steered') },
    ...Array.from({ length: 48 }, () => ({ type: 'tool/result', data: {} })),
    { type: 'agent/inbox/spliced', data: { inserted: [userPrompt('queued')] } },
    { type: 'user/message', data: userPrompt('future') },
  ].map((event, seq) => ({ ...event, seq }));

  expect(
    readPromptOrigins(
      events,
      events.length - 2,
      2,
      'assistant',
      undefined,
      0,
      readDirect(promptRoot),
    ),
  ).toEqual({
    turn: 2,
    prompts: ['current', 'steered'].map((requestId) => ({
      sessionId: 'root',
      scopeId: principal.scopeId,
      requestId,
      messageId: `message-${requestId}`,
      turn: 2,
    })),
    delegated: false,
    inherited: [],
  });
});

it('derives the first owned prompt on a native fork without assigning its seeded ancestor prompt', () => {
  const fork = {
    id: 'fork',
    header: { id: 'fork', parentSession: 'root', isSeeded: true },
  };
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: userPrompt('ancestor') },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'session/end-seed', data: {} },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: userPrompt('first-fork-prompt') },
  ].map((event, seq) => ({ ...event, seq }));
  expect(
    readPromptOrigins(
      events,
      1,
      1,
      'assistant',
      undefined,
      4,
      readDirect(fork),
    ),
  ).toBeNull();
  expect(
    readPromptOrigins(
      events,
      5,
      2,
      'assistant',
      undefined,
      4,
      readDirect(fork),
    ),
  ).toEqual({
    turn: 2,
    prompts: [
      {
        sessionId: 'fork',
        scopeId: principal.scopeId,
        requestId: 'first-fork-prompt',
        messageId: 'message-first-fork-prompt',
        turn: 2,
      },
    ],
    delegated: false,
    inherited: [],
  });
});

it('uses the native title source sequence after a later turn has started', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'user/message',
      data: userPrompt('first'),
    },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    {
      type: 'user/message',
      data: userPrompt('second'),
    },
    { type: 'session/title-llm-request', data: { messageSeqs: [1] } },
  ].map((event, seq) => ({ ...event, seq }));
  expect(
    readPromptOrigins(
      events,
      5,
      null,
      'session-title',
      undefined,
      0,
      readDirect(promptRoot),
    ),
  ).toEqual({
    turn: 1,
    prompts: [
      {
        sessionId: 'root',
        scopeId: principal.scopeId,
        requestId: 'first',
        messageId: 'message-first',
        turn: 1,
      },
    ],
    delegated: false,
    inherited: [],
  });
});

function fixture(claimed = () => true) {
  const callbacks = new Map();
  const agents = new Map();
  const sessions = new Map();
  const delegations = observeDelegatedInputs(
    {
      on: (name, callback) => callbacks.set(name, callback),
      sessions,
      agents: {
        get: (id) => agents.get(id),
        isOwnedBy: (id, parent) => agents.get(id)?.parent === parent,
      },
    },
    claimed,
  );
  function emit(name, payload) {
    callbacks.get(name)(payload);
  }
  function agent(id, parent) {
    const session = {
      id,
      header: { parentSession: parent?.id, createdAt: Date.now() },
      events: [],
    };
    const value = { id, session, parent };
    agents.set(id, value);
    sessions.set(id, session);
    return value;
  }
  function append(agent, type, data) {
    const { session } = agent;
    const seq = session.events.length;
    const event = { seq, type, data };
    session.events.push(event);
    callbacks.get('session/event')(session, event);
  }
  function input(agent, message, turn) {
    emit('agent/inbox/inserted', { agent, message });
    emit('agent/inbox/claimed', { agent, message, turn });
    append(agent, 'user/message', message);
  }
  function openRoot(root, turn, rpcId) {
    append(root, 'turn/start', { turn });
    const message = userPrompt(rpcId);
    message.source.principal = {
      kind: 'allrice-d-entry',
      scopeId: 'scope-' + rpcId,
    };
    input(root, message, turn);
  }
  function createChild(root, id) {
    const child = agent(id, root);
    emit('subagent/start', { id, runId: 'activation', local: true });
    const message = { id: 'initial', source: { kind: 'user' } };
    emit('agent/inbox/inserted', { agent: child, message });
    append(child, 'turn/start', { turn: 1 });
    emit('agent/inbox/claimed', { agent: child, message, turn: 1 });
    // rc.2 writes the parent's catalog edge after accepting the child inbox.
    append(root, 'subagent/catalog', {
      version: 0,
      mode: 'continuable',
      childId: id,
      childCreatedAt: child.session.header.createdAt,
    });
    append(child, 'user/message', message);
    return child;
  }
  function proof(agent, turn, cursor = agent.session.events.length - 1) {
    const origin = readPromptOrigins(
      agent.session.events,
      cursor,
      turn,
      'assistant',
      (event, number) =>
        delegations.claimed(agent.session, event.data, number)?.prompts,
      0,
      readDirect(agent.session),
    );
    return (
      origin && {
        turn: origin.turn,
        delegated: origin.delegated,
        ids: origin.prompts.map(({ requestId }) => requestId),
        inherited: origin.inherited.map(({ requestId }) => requestId),
      }
    );
  }
  function dispose(agent) {
    agents.delete(agent.id);
    sessions.delete(agent.id);
    emit('agent/disposed', { agent });
  }
  return {
    agent,
    append,
    claimed: delegations.claimed,
    createChild,
    dispose,
    emit,
    input,
    openRoot,
    proof,
    searchOrigin: delegations.searchOrigin,
    rootWake(id) {
      const wake = delegations.rootWake(id);
      if (wake.kind !== 'delegated') return wake;
      return {
        kind: wake.kind,
        turn: wake.turn,
        promptIds: wake.prompts.map(({ requestId }) => requestId),
      };
    },
  };
}

const relay = (id, sender) => ({
  id,
  source: { kind: 'agent-message', form: 'relay', senderSessionId: sender.id },
});

it('requires an adopted page source for every direct journal input', () => {
  const f = fixture();
  const root = f.agent('root');
  f.openRoot(root, 1, 'adopted');
  expect(f.proof(root, 1)).toMatchObject({ ids: ['adopted'] });
  f.input(
    root,
    { id: 'unbound-message', source: { kind: 'user', rpcId: 'unbound-input' } },
    1,
  );
  expect(f.proof(root, 1)).toBeNull();
});

it('proves a continuable child at its own turn after both original and newer parent turns end', () => {
  const f = fixture();
  const root = f.agent('root');
  f.openRoot(root, 1, 'origin');
  const child = f.createChild(root, 'child');
  f.append(root, 'turn/end', { turn: 1 });
  f.openRoot(root, 2, 'different-login');
  f.append(root, 'turn/end', { turn: 2 });

  expect(f.rootWake(root.id)).toEqual({ kind: 'clear' });
  expect(f.proof(child, 1)).toEqual({
    turn: 1,
    ids: ['origin'],
    delegated: true,
    inherited: ['origin'],
  });

  const message = relay('to-idle-parent', child);
  f.emit('agent/inbox/inserted', { agent: root, message });
  f.append(root, 'turn/start', { turn: 3 });
  f.emit('agent/inbox/claimed', { agent: root, message, turn: 3 });
  expect(f.proof(root, 3)?.ids).toEqual([]);
  expect(f.rootWake(root.id)).toEqual({
    kind: 'delegated',
    turn: 3,
    promptIds: ['origin'],
  });
  f.append(root, 'user/message', message);
  expect(f.proof(root, 3)).toEqual({
    turn: 3,
    ids: ['origin'],
    delegated: true,
    inherited: ['origin'],
  });
  expect(message.source).toEqual({
    kind: 'agent-message',
    form: 'relay',
    senderSessionId: 'child',
  });
  f.append(root, 'turn/end', { turn: 2 });
  expect(f.rootWake(root.id)).toMatchObject({ kind: 'delegated', turn: 3 });
  f.append(root, 'turn/end', { turn: 3 });
  expect(f.rootWake(root.id)).toEqual({ kind: 'clear' });
});

it('binds an inbox relay to its accepted sender origin when the child resumes later', () => {
  const f = fixture();
  const root = f.agent('root');
  f.openRoot(root, 1, 'first');
  const original = f.createChild(root, 'child');
  f.append(original, 'turn/end', { turn: 1 });
  f.dispose(original);
  f.emit('subagent/end', { id: original.id, runId: 'activation', local: true });
  f.append(root, 'turn/end', { turn: 1 });
  f.openRoot(root, 2, 'continuation');

  const child = f.agent(original.id, root);
  Object.assign(child.session, original.session);
  f.emit('subagent/start', { id: child.id, runId: 'resume', local: true });
  const message = relay('to-child', root);
  f.emit('agent/inbox/inserted', { agent: child, message });
  f.append(root, 'turn/end', { turn: 2 });
  f.openRoot(root, 3, 'future-input');
  f.append(child, 'turn/start', { turn: 2 });
  f.emit('agent/inbox/claimed', { agent: child, message, turn: 2 });
  f.append(child, 'user/message', message);
  expect(f.proof(child, 2)).toEqual({
    turn: 2,
    ids: ['continuation'],
    delegated: true,
    inherited: ['continuation'],
  });

  f.append(child, 'turn/end', { turn: 2 });
  f.append(child, 'turn/start', { turn: 3 });
  f.input(child, { id: 'later', source: { kind: 'user' } }, 3);
  expect(f.proof(child, 3)).toBeNull();
});

it('allows a settlement notice only after its paired native activation ends', () => {
  const f = fixture();
  const root = f.agent('root');
  f.openRoot(root, 1, 'origin');
  const child = f.createChild(root, 'child');
  f.append(root, 'turn/end', { turn: 1 });
  f.append(child, 'turn/end', { turn: 1 });
  f.dispose(child);
  const notice = {
    id: 'settlement',
    source: {
      kind: 'subagent-settled',
      form: 'notice',
      senderSessionId: child.id,
    },
  };
  f.emit('agent/inbox/inserted', { agent: root, message: notice });
  f.append(root, 'turn/start', { turn: 2 });
  f.emit('agent/inbox/claimed', { agent: root, message: notice, turn: 2 });
  f.emit('subagent/end', { id: child.id, runId: 'unknown', local: true });
  expect(f.claimed(root.session, notice, 2)).toBeNull();
  expect(f.rootWake(root.id)).toEqual({ kind: 'unproven' });
  f.emit('subagent/end', { id: child.id, runId: 'activation', local: true });
  expect(f.rootWake(root.id)).toEqual({
    kind: 'delegated',
    turn: 2,
    promptIds: ['origin'],
  });
  f.append(root, 'user/message', notice);
  expect(f.proof(root, 2)).toEqual({
    turn: 2,
    ids: ['origin'],
    delegated: true,
    inherited: ['origin'],
  });
  f.append(root, 'turn/end', { turn: 2 });
  expect(f.rootWake(root.id)).toEqual({ kind: 'clear' });
  f.append(root, 'turn/start', { turn: 3 });
  f.append(root, 'user/message', notice);
  expect(f.proof(root, 3)).toBeNull();
});

it.each(['unclaimed', 'discarded', 'unrelated'])(
  'rejects a %s relay even in a real prompt turn',
  (kind) => {
    const f = fixture();
    const root = f.agent('root');
    const otherRoot = f.agent('other-root');
    f.openRoot(root, 1, 'authorized');
    f.openRoot(otherRoot, 1, 'unrelated');
    const child = f.createChild(
      kind === 'unrelated' ? otherRoot : root,
      'child',
    );
    const message = relay('input', child);
    f.emit('agent/inbox/inserted', { agent: root, message });
    if (kind === 'discarded')
      f.emit('agent/inbox/discarded', { agent: root, message });
    if (kind !== 'unclaimed')
      f.emit('agent/inbox/claimed', { agent: root, message, turn: 1 });
    const before = root.session.events.length - 1;
    f.append(root, 'user/message', message);
    expect(f.proof(root, 1, before)?.ids).toEqual(['authorized']);
    expect(f.proof(root, 1)).toBeNull();
  },
);

function promptFixture(capture = false, tools = new Map()) {
  const events = new EventEmitter();
  const agent = {
    session: { id: 'root', header: {}, seq: 5 },
    inbox: { nextTurn: [], nextStep: [] },
  };
  const lifetime = new globalThis.AbortController();
  const request = { signal: new globalThis.AbortController().signal };
  const observe = observeNativePrompts(
    {
      on: events.on.bind(events),
      agents: { get: () => agent },
      tools,
    },
    lifetime.signal,
    capture ? () => true : undefined,
  );
  const issue = (scopeId = randomUUID(), requestId = randomUUID()) => ({
    id: randomUUID(),
    sessionId: agent.session.id,
    scopeId,
    requestId,
  });
  const open = (value) =>
    observe({ ...value, action: 'observe-prompt' }, request).body.getReader();
  const outcome = (value) =>
    observe({ ...value, action: 'prompt-outcome' }, request).json();
  const message = ({ scopeId, requestId }) => ({
    id: randomUUID(),
    source: {
      kind: 'user',
      rpcId: requestId,
      principal: { kind: 'allrice-d-entry', scopeId },
    },
  });
  const emit = (type, message, turn) =>
    events.emit(`agent/inbox/${type}`, { agent, message, turn });
  const end = (turn) =>
    events.emit('session/event', agent.session, {
      type: 'turn/end',
      data: { turn },
    });
  const next = async (reader) =>
    new TextDecoder().decode((await reader.read()).value).trim();
  return {
    agent,
    emit,
    end,
    issue,
    message,
    next,
    open,
    outcome,
    lifetime,
    events,
    observe,
    claimed: observe.claimed,
  };
}

it('only attests the sealed tool selected by this native prompt assembly, even with same-schema replacement', async () => {
  const schema = {
    name: 'mcp__allrice__memory_read',
    description: 'Read memory',
    parameters: { type: 'object' },
    deferLoading: true,
  };
  const build = (version) =>
    withNativeMemoryToolPublication(
      { ...schema, execute: async () => true },
      version,
    );
  const original = build('version-one');
  const tools = new Map([[schema.name, original]]);
  const f = promptFixture(true, tools);
  try {
    const [assemble] = f.events.listeners('system-prompt/assemble');
    const assembly = { tools: [schema] };
    f.events.emit('session/event', f.agent.session, {
      type: 'turn/start',
      data: { turn: 1 },
    });
    await assemble(assembly, { agent: f.agent }, async () => assembly);
    f.events.emit('agent/assistant-stream', {
      agent: f.agent,
      frame: { type: 'start', attemptId: 'active', turn: 1, step: 1 },
    });
    const versions = (id, schemas = [schema]) =>
      f.observe.memoryToolVersions(f.agent.session, id, schemas);
    expect(versions('active').memory_read).toBe('version-one');
    tools.set('other-agent-tool', { name: 'other-agent-tool' });
    f.events.emit('tools/change');
    expect(versions('active').memory_read).toBe('version-one');
    expect(versions('other').memory_read).toBeNull();
    expect(
      versions('active', [{ ...schema, deferLoading: false }]).memory_read,
    ).toBeNull();
    tools.set(schema.name, build('version-two'));
    expect(versions('active').memory_read).toBeNull();

    // rc.2 projects the tool schema before emitting its assembly waterfall.
    // A same-schema registry change after projection invalidates that step.
    f.events.emit('session/event', f.agent.session, {
      type: 'step/end',
      data: { turn: 1, step: 1 },
    });
    const versionTwo = tools.get(schema.name);
    tools.set(schema.name, original);
    f.events.emit('tools/change');
    tools.set(schema.name, versionTwo);
    f.events.emit('tools/change');
    await assemble(assembly, { agent: f.agent }, async () => assembly);
    f.events.emit('agent/assistant-stream', {
      agent: f.agent,
      frame: {
        type: 'start',
        attemptId: 'changed-during-assembly',
        turn: 1,
        step: 2,
      },
    });
    expect(versions('changed-during-assembly').memory_read).toBeNull();
    f.events.emit('session/event', f.agent.session, {
      type: 'step/end',
      data: { turn: 1, step: 2 },
    });
    tools.set(schema.name, build('version-two'));
    await assemble(assembly, { agent: f.agent }, async () => assembly);
    f.events.emit('agent/assistant-stream', {
      agent: f.agent,
      frame: {
        type: 'start',
        attemptId: 'change-before-notification',
        turn: 1,
        step: 3,
      },
    });
    expect(versions('change-before-notification').memory_read).toBeNull();
  } finally {
    f.lifetime.abort();
  }
});

it('reads only the exact live prompt claim from the real observer', async () => {
  const f = promptFixture();
  const issue = f.issue();
  const reader = f.open(issue);
  const item = f.message(issue);
  try {
    expect(f.claimed(f.agent.session, item, 2)).toBe(false);
    f.emit('inserted', item);
    f.emit('claimed', item, 2);
    expect(f.claimed(f.agent.session, item, 2)).toBe(true);
    expect(f.claimed(f.agent.session, f.message(issue), 2)).toBe(false);
    expect(f.claimed(f.agent.session, item, 3)).toBe(false);
    f.end(2);
    expect(f.claimed(f.agent.session, item, 2)).toBe(false);
  } finally {
    await reader.cancel();
    f.lifetime.abort();
  }
});

it('observes a true queue remove and keeps a native edit or steer of the same occurrence', async () => {
  const f = promptFixture();
  const active = f.issue(),
    queued = f.issue(active.scopeId);
  const running = f.open(active),
    waiting = f.open(queued);
  try {
    expect(await f.next(running)).toBe('ready');
    expect(await f.next(waiting)).toBe('ready');
    const first = f.message(active),
      second = f.message(queued);
    f.emit('inserted', first);
    f.emit('claimed', first, 7);
    f.agent.inbox.nextTurn = [second];
    f.emit('inserted', second);
    expect(await f.next(running)).toBe(
      'inserted ' + JSON.stringify({ messageId: first.id }),
    );
    expect(await f.next(running)).toBe(
      'claimed ' + JSON.stringify({ messageId: first.id, turn: 7 }),
    );
    expect(await f.next(waiting)).toBe(
      'inserted ' + JSON.stringify({ messageId: second.id }),
    );
    f.emit('discarded', second);
    f.emit('inserted', { ...second });
    f.agent.inbox.nextTurn = [];
    f.agent.inbox.nextStep = [second];
    f.emit('discarded', second);
    f.emit('inserted', second);
    await Promise.resolve();
    expect(await f.outcome(queued)).toEqual({ messageId: second.id });
    f.agent.inbox.nextStep = [];
    f.emit('discarded', second);
    expect(await f.next(waiting)).toBe('discarded');
    expect((await waiting.read()).done).toBe(true);
    f.end(8);
    f.end(7);
    expect(await f.next(running)).toBe('ended');
    expect((await running.read()).done).toBe(true);
  } finally {
    f.lifetime.abort();
  }
});

it('does not adopt a pending retry occurrence or another principal using the same request ID', async () => {
  const f = promptFixture();
  const original = f.issue();
  const item = f.message(original);
  f.agent.inbox.nextTurn = [item];
  const retry = f.issue(original.scopeId, original.requestId);
  const other = f.issue(randomUUID(), original.requestId);
  const waiting = f.open(retry),
    different = f.open(other);
  try {
    expect(await f.next(waiting)).toBe('ready');
    expect(await f.next(different)).toBe('ready');
    f.emit('discarded', item);
    f.emit('inserted', item);
    expect(await f.outcome(retry)).toEqual({ messageId: null });
    expect(await f.outcome(other)).toEqual({ messageId: null });
    const newItem = f.message(other);
    f.emit('inserted', newItem);
    f.emit('claimed', newItem, 1);
    f.end(1);
    expect(await f.next(different)).toBe(
      'inserted ' + JSON.stringify({ messageId: newItem.id }),
    );
    expect(await f.next(different)).toBe(
      'claimed ' + JSON.stringify({ messageId: newItem.id, turn: 1 }),
    );
    expect(await f.next(different)).toBe('ended');
    expect(await f.outcome(retry)).toEqual({ messageId: null });
  } finally {
    f.lifetime.abort();
  }
});

it('keeps the model configuration and rejects competing or non-text input for the same assistant request', () => {
  const first = {
    ...userPrompt('first'),
    content: [{ type: 'text', text: 'original input' }],
  };
  const occurrence = nativePromptOccurrence(promptRoot, first, 1);
  const origin = { prompts: [occurrence], delegated: false };
  const header = {
    seq: 0,
    type: 'request/header',
    data: {
      header: {
        config: { provider: 'sealed', model: 'fixture', temperature: 0.4 },
      },
    },
  };
  const start = { seq: 1, type: 'turn/start', data: { turn: 1 } };
  const user = { seq: 2, type: 'user/message', data: first };
  const observe = (events, value = origin) =>
    observeOriginalRequest(
      { events, inheritedEventCount: 0 },
      events.length - 1,
      1,
      value,
    );
  const initial = observe([header, start, user]);
  expect(initial.firstMemoryAttempt).toBe(true);
  expect(
    observe([
      header,
      start,
      user,
      {
        seq: 3,
        type: 'assistant/attempt',
        data: {},
      },
    ]).firstMemoryAttempt,
  ).toBe(false);
  expect(initial).toMatchObject({
    request: {
      provider: 'sealed',
      model: 'fixture',
      digest: expect.stringMatching(/^sha256:/),
    },
    human: {
      occurrence,
      sequence: 2,
      digest: expect.stringMatching(/^sha256:/),
    },
  });
  expect(
    observe(
      [
        header,
        start,
        user,
        {
          seq: 3,
          type: 'user/message',
          data: userPrompt('steer'),
        },
      ],
      {
        ...origin,
        prompts: [occurrence, { ...occurrence, messageId: 'another' }],
      },
    ),
  ).toEqual({ request: initial.request, human: null });
  expect(
    observe([
      header,
      start,
      user,
      {
        seq: 3,
        type: 'user/message',
        data: { id: 'clock-notice', source: { kind: 'clock-notice' } },
      },
    ]).human,
  ).toEqual(initial.human);
  expect(
    observe([
      header,
      start,
      {
        ...user,
        data: {
          ...first,
          content: [{ type: 'image', mediaType: 'image/png' }],
        },
      },
    ]).human,
  ).toBeNull();
  expect(
    observe([header, start, user], { ...origin, delegated: true }).human,
  ).toBeNull();
  const steering = {
    ...userPrompt('steer'),
    content: [{ type: 'text', text: 'adopted steer' }],
  };
  const steerOccurrence = nativePromptOccurrence(promptRoot, steering, 1);
  const continued = [
    header,
    start,
    user,
    { seq: 3, type: 'assistant/message', data: {} },
    { seq: 4, type: 'step/start', data: { turn: 1, step: 2 } },
    { seq: 5, type: 'user/message', data: steering },
  ];
  const augmented = { ...origin, prompts: [occurrence, steerOccurrence] };
  expect(observe(continued, augmented)).toMatchObject({
    originalHuman: initial.human,
    human: { occurrence: steerOccurrence, sequence: 5 },
    firstMemoryAttempt: false,
  });
  const otherSteer = { ...steering, id: 'another-steer' };
  expect(
    observe(
      [...continued, { seq: 6, type: 'user/message', data: otherSteer }],
      {
        ...augmented,
        prompts: [
          ...augmented.prompts,
          nativePromptOccurrence(promptRoot, otherSteer, 1),
        ],
      },
    ),
  ).toMatchObject({
    originalHuman: initial.human,
    human: null,
    firstMemoryAttempt: false,
  });
});

it('binds the real same-ID steer and rejects a second claimed native input', async () => {
  const f = promptFixture(true);
  const request = f.issue();
  const reader = f.open(request);
  try {
    const text = 'synthetic original text';
    const message = {
      ...f.message(request),
      content: [{ type: 'text', text }],
    };
    f.agent.inbox.nextTurn = [message];
    f.emit('inserted', message);
    // The native queue edits send events for this same occurrence into the
    // next-step inbox before the Agent claims it.
    f.agent.inbox.nextTurn = [];
    f.agent.inbox.nextStep = [message];
    f.emit('inserted', message);
    f.agent.inbox.nextStep = [];
    f.emit('claimed', message, 1);
    f.events.emit('agent/assistant-stream', {
      agent: f.agent,
      frame: { type: 'start', attemptId: 'root:1', turn: 1, step: 1 },
    });
    const human = {
      occurrence: nativePromptOccurrence(f.agent.session, message, 1),
      sequence: 3,
      digest:
        'sha256:' +
        createHash('sha256')
          .update(JSON.stringify([text]))
          .digest('hex'),
    };
    expect(f.observe.attest(f.agent.session, 'root:1', 4, 1, human)).toEqual({
      human: { ...human, kind: 'adopted-steering' },
      proofState: 'adopted',
    });
    f.emit('claimed', { id: 'timer', source: { kind: 'schedule' } }, 1);
    expect(f.observe.attest(f.agent.session, 'root:1', 4, 1, human)).toEqual({
      human: null,
      proofState: 'competing-inbox-input',
    });
  } finally {
    f.lifetime.abort();
    await reader.cancel();
  }
});

it.each([false, true])(
  'separates short circuit and sealed body, including a private memory publication %s',
  async (memory) => {
    let runs = 0;
    const wrap = memory
      ? withNativeMemoryToolPublication
      : withNativeToolEvidence;
    const tool = wrap(
      {
        name: memory ? 'mcp__allrice__memory_remember' : 'fixture_native_tool',
        execute(_args, _exec, nativeRequestRef) {
          expect(nativeRequestRef).toBe(
            memory ? 'committed-call-ref' : undefined,
          );
          runs++;
          return { isError: false };
        },
      },
      'fixture-release',
    );
    const sameName = withNativeToolEvidence({ ...tool }, 'different-release');
    const registry = new Map([[tool.name, tool]]);
    const f = promptFixture(true, registry);
    const request = f.issue();
    const reader = f.open({ ...request, memoryCalls: memory });
    try {
      const text = 'synthetic original text';
      if (memory) {
        f.events.emit('session/event', f.agent.session, {
          type: 'turn/start',
          data: { turn: 1 },
        });
        const [assemble] = f.events.listeners('system-prompt/assemble');
        const assembly = { tools: [tool] };
        await assemble(assembly, { agent: f.agent }, async () => assembly);
      }
      const message = {
        ...f.message(request),
        content: [{ type: 'text', text }],
      };
      f.agent.inbox.nextTurn = [message];
      f.emit('inserted', message);
      f.agent.inbox.nextTurn = [];
      f.emit('claimed', message, 1);
      const attemptId = 'root:1';
      f.events.emit('agent/assistant-stream', {
        agent: f.agent,
        frame: { type: 'start', attemptId, turn: 1, step: 1 },
      });
      const human = {
        occurrence: nativePromptOccurrence(f.agent.session, message, 1),
        sequence: 3,
        digest:
          'sha256:' +
          createHash('sha256')
            .update(JSON.stringify([text]))
            .digest('hex'),
      };
      expect(
        f.observe.attest(f.agent.session, attemptId, 4, 1, human).proofState,
      ).toBe('adopted');
      const faked = { id: 'short-circuit', name: tool.name, type: 'tool-call' };
      const actual = { id: 'real-body', name: tool.name, type: 'tool-call' };
      const replaced = { ...actual, id: 'replacement-body' };
      const append = (type, seq, data) =>
        f.events.emit('session/event', f.agent.session, {
          type,
          seq,
          data: { turn: 1, step: 1, ...data },
        });
      append('assistant/message', 7, {
        message: { content: [faked, actual, replaced] },
      });
      f.events.emit('agent/assistant-stream', {
        agent: f.agent,
        frame: {
          type: 'end',
          attemptId,
          outcome: {
            kind: 'committed',
            eventType: 'assistant/message',
            seq: 7,
          },
        },
      });
      const [through] = f.events.listeners('tools/execute');
      let sequence = 8;
      const invoke = (block, next) => {
        append('tool/call', sequence++, { callId: block.id, name: block.name });
        const exec = {
          callId: block.id,
          name: block.name,
          agent: f.agent,
          signal: f.lifetime.signal,
          token: Symbol(),
        };
        return through(exec, () => next(exec));
      };
      await invoke(faked, (exec) => {
        expect(() => sameName.execute({}, exec)).toThrow();
        return { isError: false };
      });
      expect(runs).toBe(0);
      const executed = invoke(actual, (exec) => tool.execute({}, exec));
      const records = [];
      for (let i = 0; i < (memory ? 4 : 5); i++)
        records.push(await f.next(reader));
      if (memory) {
        expect(runs).toBe(0);
        expect(records[3]).toMatch(/^memory-call /);
        const { ticket, fact } = JSON.parse(records[3].slice(12));
        expect(fact).toMatchObject({
          attemptId,
          callId: actual.id,
          human,
          dispatch: { kind: 'sealed-handler', version: 'fixture-release' },
        });
        const reply = {
          ...request,
          action: 'memory-call-result',
          ticket,
          nativeRequestRef: 'committed-call-ref',
        };
        const proofRequest = { signal: f.lifetime.signal };
        expect(
          f.observe({ ...reply, requestId: 'other' }, proofRequest).status,
        ).toBe(404);
        expect(f.observe(reply, proofRequest).status).toBe(200);
        expect(f.observe(reply, proofRequest).status).toBe(404);
        await expect(
          tool.execute({}, { signal: f.lifetime.signal, token: Symbol() }),
        ).rejects.toThrow();
      } else {
        expect(() =>
          tool.execute({}, { signal: f.lifetime.signal, token: Symbol() }),
        ).toThrow();
        expect(
          records
            .slice(3)
            .map((record) => JSON.parse(record.slice(5)).dispatch),
        ).toEqual([
          { kind: 'registry-result' },
          { kind: 'sealed-handler', version: 'fixture-release' },
        ]);
      }
      await executed;
      expect(runs).toBe(1);
      if (memory) {
        const replacement = withNativeMemoryToolPublication(
          { ...tool },
          'fixture-release',
        );
        registry.set(tool.name, replacement);
        await expect(
          invoke(replaced, (exec) => replacement.execute({}, exec)),
        ).rejects.toThrow('Native memory call unavailable');
        expect(runs).toBe(1);
      }
    } finally {
      f.lifetime.abort();
      await reader.cancel();
    }
  },
);

it('derives Search authority from the exact running turn and native child lineage', () => {
  const f = fixture();
  const root = f.agent('root');
  root.status = 'running';
  f.openRoot(root, 1, 'original');
  const child = f.createChild(root, 'child');
  child.status = 'running';
  expect(f.searchOrigin('root').proof).toEqual({
    rootSessionId: 'root',
    turn: 1,
    claims: [
      {
        sessionId: 'root',
        scopeId: 'scope-original',
        requestId: 'original',
        messageId: 'message-original',
        turn: 1,
      },
    ],
  });
  f.append(root, 'turn/end', { turn: 1 });
  f.openRoot(root, 2, 'next-login');
  expect(f.searchOrigin('child').proof).toEqual({
    rootSessionId: 'root',
    turn: 1,
    claims: [
      {
        sessionId: 'root',
        scopeId: 'scope-original',
        requestId: 'original',
        messageId: 'message-original',
        turn: 1,
      },
    ],
  });
  expect(f.searchOrigin('root')?.proof.claims).toEqual([
    {
      sessionId: 'root',
      scopeId: 'scope-next-login',
      requestId: 'next-login',
      messageId: 'message-next-login',
      turn: 2,
    },
  ]);
  child.status = 'idle';
  expect(f.searchOrigin('child')).toBeNull();
  f.append(root, 'turn/end', { turn: 2 });
  expect(f.searchOrigin('root')).toBeNull();
});

it('permits a native fork to search from its own adopted prompt and not from seed history', () => {
  const f = fixture((_session, message) => message.id === 'message-own-prompt');
  const fork = f.agent('fork');
  Object.assign(fork.session.header, {
    id: 'fork',
    parentSession: 'ancestor',
    isSeeded: true,
  });
  fork.status = 'running';
  f.openRoot(fork, 1, 'seed-history');
  expect(f.searchOrigin('fork')).toBeNull();
  f.append(fork, 'turn/end', { turn: 1 });
  f.openRoot(fork, 2, 'own-prompt');
  expect(f.searchOrigin('fork')?.proof).toEqual({
    rootSessionId: 'fork',
    turn: 2,
    claims: [
      {
        sessionId: 'fork',
        scopeId: 'scope-own-prompt',
        requestId: 'own-prompt',
        messageId: 'message-own-prompt',
        turn: 2,
      },
    ],
  });
});

it('denies an unobserved direct root input and a same-ID direct child input', () => {
  const rejected = fixture(() => false);
  const noClaim = rejected.agent('root');
  noClaim.status = 'running';
  rejected.openRoot(noClaim, 1, 'same-rpc');
  expect(rejected.searchOrigin('root')).toBeNull();

  const f = fixture();
  const root = f.agent('root');
  f.openRoot(root, 1, 'same-rpc');
  const child = f.createChild(root, 'child');
  child.session.header.origin = 'subagent';
  child.status = 'running';
  expect(f.searchOrigin('child')).not.toBeNull();
  f.input(
    child,
    {
      id: 'different-occurrence',
      source: {
        kind: 'user',
        rpcId: 'same-rpc',
        principal: { kind: 'allrice-d-entry', scopeId: 'scope-same-rpc' },
      },
    },
    1,
  );
  expect(f.searchOrigin('child')).toBeNull();
});

it('routes through the DSH agent/request payload with an opaque scoped receiver before selecting adapter controls', async () => {
  const lifetime = new globalThis.AbortController();
  const root = { provider: 'openai-codex', model: 'root-fixture' };
  const child = { provider: 'deepseek', model: 'child-fixture' };
  const next = () => Promise.resolve({ ...root, reasoningEffort: 'high' });
  const waterfall = managedModelRequest(
    selectScopedModel,
    [{ ...child, parentSessionId: 'parent', scope: 'subagent' }],
    root,
    lifetime.signal,
  );
  const payload = {
    agent: {
      session: {
        id: 'child',
        header: { origin: 'subagent', parentSession: 'parent' },
      },
    },
    signal: lifetime.signal,
  };
  const scopeCarrier = Object.freeze({});
  await expect(waterfall.call(scopeCarrier, payload, next)).resolves.toEqual(
    child,
  );
  payload.agent.session.header.parentSession = 'other';
  await expect(waterfall.call(scopeCarrier, payload, next)).resolves.toEqual(
    await next(),
  );
  lifetime.abort();
  await expect(
    waterfall.call(scopeCarrier, payload, next),
  ).rejects.toMatchObject({ name: 'AbortError' });
});

it('uses the current scoped model in the native prompt without mutating the retained session', async () => {
  const lifetime = new globalThis.AbortController();
  const route = { provider: 'openai', model: 'vision-fixture' };
  const prior = { provider: 'deepseek', model: 'old-text-fixture' };
  const context = { agent: { session: { id: 'retained', header: {} } } };
  const native = Object.freeze({
    variables: Object.freeze({ ...prior, name: 'fixture' }),
  });
  const next = async () => native;
  const prompt = managedModelPrompt(
    selectScopedModel,
    [],
    route,
    lifetime.signal,
  );
  await expect(prompt(null, context, next)).resolves.toEqual({
    variables: { ...route, name: 'fixture' },
  });
  expect(native.variables).toEqual({ ...prior, name: 'fixture' });
  await expect(prompt(null, {}, next)).resolves.toBe(native);
  lifetime.abort();
  await expect(prompt(null, context, next)).rejects.toMatchObject({
    name: 'AbortError',
  });
});
