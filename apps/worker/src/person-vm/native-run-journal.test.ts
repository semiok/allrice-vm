import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { expect, it } from 'vitest';
// @ts-expect-error The fixed guest plugin is copied as JavaScript.
import { findDEntryNativeRunTerminal } from '../../dsh/allrice-native-web-owner.mjs';

const sessionId = 'session-00000000-0000-4000-8000-000000000036';
const selection = {
  sessionId,
  nativeRequestId: '76621b92-7b25-47a0-8d6c-c958f957bfd8',
  attemptId: sessionId + ':1',
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
      const journal = { header: reader.header, events: durableEvents };
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
