import { expect, it } from 'vitest';
import { readRootPromptOrigins } from './allrice-native-web-owner.mjs';

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
