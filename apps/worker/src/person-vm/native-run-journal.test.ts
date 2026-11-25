import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import {
  buildForkSeed,
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { AgentMessageSource } from '@deepseek-ai/dsh-subagent';
import { expect, it } from 'vitest';
// @ts-expect-error The fixed guest plugin is copied as JavaScript.
import * as runJournal from '../../dsh/allrice-native-run-journal.mjs';

const { findDEntryNativeRunTerminal, readPersistedRunTerminal } = runJournal;

const sessionId = 'session-00000000-0000-4000-8000-000000000036';
const selection = {
  sessionId,
  nativeRequestId: '76621b92-7b25-47a0-8d6c-c958f957bfd8',
  purpose: 'assistant',
  cursor: 11,
  turn: 1,
};

it('replays the committed DSH Web journal through the rc.2 read handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allrice-d-entry-run-journal-'));
  const ctx = new Context();
  try {
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' }).await();
    const native = ctx.get('sessionPersistence') as SessionPersistence;
    const fixture = await readFile(
      new URL(
        '../../../../packages/dsh-web-composition/tests/fixtures/process.json',
        import.meta.url,
      ),
      'utf8',
    );
    const [{ type, ...header }, ...events] = JSON.parse(
      fixture.replaceAll('__WORKSPACE__', root),
    );
    expect(type).toBe('session');
    const writer = await native.create(header);
    try {
      await writer.append(events.slice(0, 23));
      await writer.flush();
      const open = await native.open(header.id, 'read');
      try {
        const unfinished = await open.read();
        expect(
          findDEntryNativeRunTerminal(selection, {
            header: open.header,
            events: unfinished.events,
            inheritedEventCount: open.inheritedEventCount,
          }),
        ).toBeNull();
      } finally {
        await open.close();
      }
      await writer.append(events.slice(23));
      await writer.flush();
    } finally {
      await writer.close();
    }

    const reader = await native.open(header.id, 'read');
    try {
      const { events: durableEvents } = await reader.read();
      const journal = {
        header: reader.header,
        events: durableEvents,
        inheritedEventCount: reader.inheritedEventCount,
      };
      const end = {
        sessionId,
        turn: 1,
        sequence: 23,
        reason: 'completed',
        occurredAt: new Date(events[23].time).toISOString(),
      };
      expect(findDEntryNativeRunTerminal(selection, journal)).toEqual(end);
      expect(
        findDEntryNativeRunTerminal(selection, {
          ...journal,
          header: { ...journal.header, id: randomUUID() },
        }),
      ).toBeNull();
      expect(
        findDEntryNativeRunTerminal(
          {
            ...selection,
            turn: 2,
          },
          journal,
        ),
      ).toBeNull();

      const titleSeq = durableEvents.length;
      const delayedTitle = {
        ...journal,
        events: [
          ...durableEvents,
          {
            seq: titleSeq,
            type: 'session/title-llm-request',
            time: events[23].time + 200,
            data: { messageSeqs: [8] },
          },
        ],
      };
      expect(
        findDEntryNativeRunTerminal(
          {
            ...selection,
            purpose: 'session-title',
            cursor: titleSeq,
            turn: null,
          },
          delayedTitle,
        ),
      ).toEqual(end);
    } finally {
      await reader.close();
    }
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function appendTurn(
  session: Session,
  turn: number,
  source: Parameters<typeof createUserMessage>[0]['source'],
  completed: boolean,
) {
  const rows: SessionEvent[] = [
    session.append('turn/start', { turn }),
    session.append('step/start', { turn, step: 1 }),
    session.append(
      'user/message',
      createUserMessage({
        source,
        content: [{ type: 'text', text: 'fixture accepted input' }],
      }),
      { surfaceOp: 'append' },
    ),
  ];
  if (completed)
    rows.push(
      session.append('step/end', { turn, step: 1 }),
      session.append('turn/end', { turn, reason: { kind: 'completed' } }),
    );
  return rows;
}

async function writeAndRead(
  native: SessionPersistence,
  session: Session,
  rows: readonly SessionEvent[],
) {
  const writer = await native.create(session.header, {
    inheritedEventCount: session.inheritedEventCount,
  });
  try {
    await writer.append(rows);
    await writer.flush();
  } finally {
    await writer.close();
  }
  const reader = await native.open(session.id, 'read');
  try {
    const { events } = await reader.read();
    return {
      header: reader.header,
      inheritedEventCount: reader.inheritedEventCount,
      events,
    };
  } finally {
    await reader.close();
  }
}

it('matches a derived turn only inside its physical child or root-wake bracket', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'allrice-d-entry-derived-journal-'),
  );
  const ctx = new Context();
  try {
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' }).await();
    const native = ctx.get('sessionPersistence') as SessionPersistence;
    const parentId = SessionId('session-' + randomUUID());
    const childId = SessionId('session-' + randomUUID());
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: parentId,
      cwd: root,
      createdAt: Date.now(),
      isSeeded: false,
    };
    const parent = Session.create(parentId, undefined, header);
    const human = { kind: 'user' as const, rpcId: selection.nativeRequestId };
    const prefix = appendTurn(parent, 1, human, false);
    const seed = buildForkSeed(prefix, SessionSeq(prefix.length - 1));
    const child = Session.create(
      childId,
      seed,
      {
        ...header,
        id: childId,
        isSeeded: true,
        parentSession: parentId,
        origin: 'subagent',
        delegationDepth: 1,
      },
      SessionLogOffset(prefix.length),
    );
    const own = appendTurn(child, 2, { kind: 'user' }, true);
    const childJournal = await writeAndRead(native, child, [...seed, ...own]);
    expect(childJournal.inheritedEventCount).toBe(prefix.length);
    const selectedChild = {
      ...selection,
      sessionId: childId,
      parentSessionId: parentId,
      delegated: true,
      cursor: own[2]!.seq,
      turn: 2,
    };
    expect(
      findDEntryNativeRunTerminal(selectedChild, childJournal),
    ).toMatchObject({
      sessionId: childId,
      turn: 2,
      sequence: own[4]!.seq,
      reason: 'completed',
    });
    expect(
      findDEntryNativeRunTerminal(
        {
          ...selectedChild,
          parentSessionId: SessionId('session-' + randomUUID()),
        },
        childJournal,
      ),
    ).toBeNull();
    expect(
      findDEntryNativeRunTerminal(
        {
          ...selectedChild,
          turn: 1,
          cursor: prefix[2]!.seq,
        },
        childJournal,
      ),
    ).toBeNull();
    expect(
      findDEntryNativeRunTerminal(
        {
          ...selectedChild,
          turn: 1,
          cursor: seed[prefix.length + 1]!.seq,
        },
        childJournal,
      ),
    ).toBeNull();
    expect(
      findDEntryNativeRunTerminal(
        {
          ...selectedChild,
          purpose: 'session-title',
          turn: null,
        },
        childJournal,
      ),
    ).toBeNull();

    const closedParent = [
      ...prefix,
      parent.append('step/end', { turn: 1, step: 1 }),
      parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ];
    const relay: AgentMessageSource = {
      kind: 'agent-message',
      form: 'relay',
      senderSessionId: childId,
    };
    const wake = appendTurn(parent, 2, relay, true);
    const notice = appendTurn(
      parent,
      3,
      {
        kind: 'subagent-settled',
        form: 'notice',
        senderSessionId: childId,
        summary: 'Child finished',
      },
      true,
    );
    const parentJournal = await writeAndRead(native, parent, [
      ...closedParent,
      ...wake,
      ...notice,
    ]);
    const selectedWake = {
      ...selection,
      sessionId: parentId,
      delegated: true,
      parentSessionId: null,
      cursor: wake[2]!.seq,
      turn: 2,
    };
    expect(
      await readPersistedRunTerminal(
        native,
        selectedWake,
        new AbortController().signal,
      ),
    ).toEqual(findDEntryNativeRunTerminal(selectedWake, parentJournal));
    expect(
      findDEntryNativeRunTerminal(selectedWake, parentJournal),
    ).toMatchObject({
      sessionId: parentId,
      turn: 2,
      sequence: wake[4]!.seq,
      reason: 'completed',
    });
    expect(
      findDEntryNativeRunTerminal(
        {
          ...selectedWake,
          turn: 3,
          cursor: notice[2]!.seq,
        },
        parentJournal,
      ),
    ).toMatchObject({
      sessionId: parentId,
      turn: 3,
      sequence: notice[4]!.seq,
      reason: 'completed',
    });
    expect(
      findDEntryNativeRunTerminal(
        {
          ...selectedWake,
          turn: 1,
          cursor: prefix[2]!.seq,
        },
        parentJournal,
      ),
    ).toBeNull();
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
