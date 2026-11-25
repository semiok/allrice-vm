import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  observeNativePrompts,
  readRootPromptOrigins,
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

  expect(readRootPromptOrigins(events, events.length - 2, 2)).toEqual({
    turn: 2,
    ids: ['current'],
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
  expect(readRootPromptOrigins(events, 5, null, 'session-title')).toEqual({
    turn: 1,
    ids: ['first'],
  });
});

function promptFixture() {
  const events = new EventEmitter();
  const agent = {
    session: { id: 'root', header: {} },
    inbox: { nextTurn: [], nextStep: [] },
  };
  const lifetime = new AbortController();
  const peer = { principal: { kind: 'owner' }, interactions: 'none' };
  const request = { signal: new AbortController().signal };
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
    observe(
      { ...value, action: 'observe-prompt' },
      request,
      peer,
    ).body.getReader();
  const outcome = (value) =>
    observe({ ...value, action: 'prompt-outcome' }, request, peer).json();
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
  return { agent, emit, end, issue, message, next, open, outcome, lifetime };
}

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
