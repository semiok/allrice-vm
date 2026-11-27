import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  observeDelegatedInputs,
  observeNativePrompts,
  readPromptOrigins,
} from './allrice-native-web-owner.mjs';

it('keeps the admitted prompt of a long turn and excludes queued and future input', () => {
  const user = (rpcId) => ({ source: { kind: 'user', rpcId } });
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: user('older') },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: user('current') },
    ...Array.from({ length: 48 }, () => ({ type: 'tool/result', data: {} })),
    { type: 'agent/inbox/spliced', data: { inserted: [user('queued')] } },
    { type: 'user/message', data: user('future') },
  ].map((event, seq) => ({ ...event, seq }));

  expect(readPromptOrigins(events, events.length - 2, 2)).toEqual({
    turn: 2,
    ids: ['current'],
    delegated: false,
    inherited: [],
  });
});

it('uses the native title source sequence after a later turn has started', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'user/message',
      data: { source: { kind: 'user', rpcId: 'first' } },
    },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    {
      type: 'user/message',
      data: { source: { kind: 'user', rpcId: 'second' } },
    },
    { type: 'session/title-llm-request', data: { messageSeqs: [1] } },
  ].map((event, seq) => ({ ...event, seq }));
  expect(readPromptOrigins(events, 5, null, 'session-title')).toEqual({
    turn: 1,
    ids: ['first'],
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
    input(
      root,
      {
        id: rpcId,
        source: {
          kind: 'user',
          rpcId,
          principal: { kind: 'allrice-d-entry', scopeId: 'scope-' + rpcId },
        },
      },
      turn,
    );
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
    return readPromptOrigins(
      agent.session.events,
      cursor,
      turn,
      'assistant',
      (event, number) =>
        delegations.claimed(agent.session, event.data, number)?.ids,
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
    rootWake: delegations.rootWake,
    searchOrigin: delegations.searchOrigin,
  };
}

const relay = (id, sender) => ({
  id,
  source: { kind: 'agent-message', form: 'relay', senderSessionId: sender.id },
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

function promptFixture() {
  const events = new EventEmitter();
  const agent = {
    session: { id: 'root', header: {} },
    inbox: { nextTurn: [], nextStep: [] },
  };
  const lifetime = new globalThis.AbortController();
  const request = { signal: new globalThis.AbortController().signal };
  const observe = observeNativePrompts(
    {
      on: events.on.bind(events),
      agents: { get: () => agent },
    },
    lifetime.signal,
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
    claimed: observe.claimed,
  };
}

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
    expect(await f.next(running)).toBe('inserted');
    expect(await f.next(running)).toBe('claimed');
    expect(await f.next(waiting)).toBe('inserted');
    f.emit('discarded', second);
    f.emit('inserted', { ...second });
    f.agent.inbox.nextTurn = [];
    f.agent.inbox.nextStep = [second];
    f.emit('discarded', second);
    f.emit('inserted', second);
    await Promise.resolve();
    expect(await f.outcome(queued)).toEqual({ inserted: true });
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
    expect(await f.outcome(retry)).toEqual({ inserted: false });
    expect(await f.outcome(other)).toEqual({ inserted: false });
    const newItem = f.message(other);
    f.emit('inserted', newItem);
    f.emit('claimed', newItem, 1);
    f.end(1);
    expect(await f.next(different)).toBe('inserted');
    expect(await f.next(different)).toBe('claimed');
    expect(await f.next(different)).toBe('ended');
    expect(await f.outcome(retry)).toEqual({ inserted: false });
  } finally {
    f.lifetime.abort();
  }
});

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
    claims: [{ scopeId: 'scope-original', requestId: 'original' }],
  });
  f.append(root, 'turn/end', { turn: 1 });
  f.openRoot(root, 2, 'next-login');
  expect(f.searchOrigin('child').proof).toEqual({
    rootSessionId: 'root',
    turn: 1,
    claims: [{ scopeId: 'scope-original', requestId: 'original' }],
  });
  expect(f.searchOrigin('root')?.proof.claims).toEqual([
    { scopeId: 'scope-next-login', requestId: 'next-login' },
  ]);
  child.status = 'idle';
  expect(f.searchOrigin('child')).toBeNull();
  f.append(root, 'turn/end', { turn: 2 });
  expect(f.searchOrigin('root')).toBeNull();
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
