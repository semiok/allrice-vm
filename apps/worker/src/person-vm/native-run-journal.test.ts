import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import {
  buildForkSeed,
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  SessionStore,
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { AgentMessageSource } from '@deepseek-ai/dsh-subagent';
import { expect, it } from 'vitest';
// @ts-expect-error The fixed guest plugin is copied as JavaScript.
import * as runJournal from '../../dsh/allrice-native-run-journal.mjs';

const {
  createNativeRunTerminalAttestations,
  findDEntryNativeRunTerminal,
  readPersistedRunTerminal,
} = runJournal;

const sessionId = 'session-00000000-0000-4000-8000-000000000036';
type SessionRequestId = Extract<
  NonNullable<Parameters<typeof createUserMessage>[0]['source']>,
  { kind: 'user'; rpcId: string }
>['rpcId'];
const selection = {
  sessionId,
  nativeRequestId: '76621b92-7b25-47a0-8d6c-c958f957bfd8',
  purpose: 'assistant',
  cursor: 11,
  turn: 1,
};

it('loads the retained probe backend through the sealed CLI tree from an unrelated cwd', async () => {
  const workspace = await realpath(new URL('../../../../', import.meta.url));
  const cli = await realpath(
    join(
      workspace,
      'packages/dsh-web-composition/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ),
  );
  const program = await readFile(
    new URL('../../dsh/allrice-native-run-journal.mjs', import.meta.url),
    'utf8',
  );
  const root = await mkdtemp(join(tmpdir(), 'allrice-d-entry-probe-'));
  const run = (readonlyRoot: string) =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        program +
          `
const { Context, backend } = await loadRetainedRunBackend(...process.argv.slice(1, 3));
const ctx = new Context();
try {
  await ctx.plugin(backend.default ?? backend, { root: process.argv[3] }).await();
  if (!ctx.get('sessionPersistence')) throw new Error('No native backend');
} finally {
  await ctx.fiber.dispose();
}`,
        '--',
        cli,
        readonlyRoot,
        root,
      ],
      { cwd: root, encoding: 'utf8', timeout: 10_000 },
    );
  try {
    const loaded = run(workspace);
    expect(loaded.status, loaded.stderr).toBe(0);
    const escaped = run(dirname(cli));
    expect(escaped.status).toBe(1);
    expect(escaped.stderr).toContain('UNVERIFIED_DSH_READER');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

it('requires the same attached rc.2 turn and terminal fact as the durable journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allrice-native-run-receipt-'));
  const ctx = new Context();
  try {
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' }).await();
    await ctx.plugin(SessionStore).await();
    const native = ctx.get('sessionPersistence') as SessionPersistence;
    const sessions = ctx.get('sessions');
    if (!sessions) throw new Error('Native SessionStore did not mount');
    const session = sessions.prepare(SessionId(sessionId), {
      meta: { cwd: root },
    });
    const detach = sessions.enter(session);
    const attested = createNativeRunTerminalAttestations();
    ctx.on('session/created', (subject) => attested.attach(subject), {
      global: true,
    });
    ctx.on('session/disposed', (subject) => attested.detach(subject), {
      global: true,
    });
    ctx.on(
      'session/event',
      (subject, event) => {
        if (sessions.get(subject.id) === subject)
          attested.observe(subject, event);
      },
      { global: true },
    );
    const current = () => sessions.get(session.id);
    let rows: SessionEvent[];
    try {
      sessions.announce(session);
      rows = appendTurn(
        session,
        1,
        { kind: 'user', rpcId: selection.nativeRequestId as SessionRequestId },
        true,
      );
      const start = rows[0]!;
      const end = rows.at(-1)!;
      if (end.type !== 'turn/end')
        throw new Error('Expected a native turn end');
      const selected = { ...selection, cursor: rows[2]!.seq };
      const active = new AbortController().signal;
      const read = (receipts = attested) =>
        receipts.read(current, native, selected, active);

      expect(await read()).toBeNull();
      const journal = await writeAndRead(native, session, rows);
      const terminal = findDEntryNativeRunTerminal(selected, journal);
      expect(terminal).toMatchObject({
        sessionId,
        turn: 1,
        reason: 'completed',
        sequence: end.seq,
      });
      expect(await read()).toEqual(terminal);
      expect(await read(createNativeRunTerminalAttestations())).toBeNull();

      for (const event of [
        { ...end, time: end.time + 1 },
        { ...end, seq: end.seq + 1 },
        { ...end, data: { ...end.data, turn: 2 } },
        { ...end, data: { ...end.data, reason: { kind: 'max-tokens' } } },
        { ...end, data: { ...end.data, reason: { kind: 'interrupted' } } },
        { ...end, data: { ...end.data, reason: { kind: 'forked' } } },
      ]) {
        const wrong = createNativeRunTerminalAttestations();
        wrong.observe(session, start);
        wrong.observe(session, event);
        expect(await read(wrong)).toBeNull();
      }
      const noStart = createNativeRunTerminalAttestations();
      noStart.observe(session, end);
      expect(await read(noStart)).toBeNull();
      const wrongStart = createNativeRunTerminalAttestations();
      wrongStart.observe(session, { ...start, seq: start.seq + 1 });
      wrongStart.observe(session, end);
      expect(await read(wrongStart)).toBeNull();
      expect(
        await attested.read(
          current,
          native,
          { ...selected, turn: null, purpose: 'session-title' },
          active,
        ),
      ).toBeNull();
    } finally {
      detach();
    }

    const selected = { ...selection, cursor: rows[2]!.seq };
    const active = new AbortController().signal;
    const expected = findDEntryNativeRunTerminal(selected, {
      header: session.header,
      events: rows,
      inheritedEventCount: session.inheritedEventCount,
    });
    expect(expected).not.toBeNull();
    expect(await attested.read(current, native, selected, active)).toEqual(
      expected,
    );
    const replacement = sessions.prepare(SessionId(sessionId), {
      meta: session.header,
      seed: structuredClone(rows),
      inheritedEventCount: session.inheritedEventCount,
      eventState: 'detached',
    });
    const nextRequestId = randomUUID();
    let next: SessionEvent[];
    const writer = await native.open(session.id, 'write');
    try {
      // The native resume path persists its unpublished suffix, including
      // the end-of-seed marker, before it announces the restored Session.
      await writer.append(
        replacement.snapshotEvents(SessionLogOffset(rows.length)),
      );
      const detachReplacement = sessions.enter(replacement);
      try {
        expect(
          await attested.read(current, native, selected, active),
        ).toBeNull();
        sessions.announce(replacement);
        expect(
          await attested.read(current, native, selected, active),
        ).toBeNull();
        next = appendTurn(
          replacement,
          2,
          { kind: 'user', rpcId: nextRequestId as SessionRequestId },
          true,
        );
        expect(await sessions.flush(replacement)).toBe(true);
      } finally {
        detachReplacement();
      }
    } finally {
      await writer.close();
    }
    expect(await attested.read(current, native, selected, active)).toBeNull();
    expect(
      await attested.read(
        current,
        native,
        {
          ...selected,
          turn: 2,
          cursor: next[2]!.seq,
          nativeRequestId: nextRequestId,
        },
        active,
      ),
    ).toMatchObject({ sessionId, turn: 2, sequence: next.at(-1)!.seq });
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('attests only a fork’s own physical turn with its registered source', () => {
  const parentId = SessionId('native-parent');
  const forkId = SessionId('native-fork');
  const parent = Session.create(parentId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: parentId,
    createdAt: 1,
    isSeeded: false,
  });
  const source = { kind: 'user' as const, rpcId: selection.nativeRequestId };
  const prefix = appendTurn(parent, 1, source, true);
  const seed = buildForkSeed(prefix, SessionSeq(prefix.length - 1));
  const fork = Session.create(
    forkId,
    seed,
    {
      ...parent.header,
      id: forkId,
      isSeeded: true,
      parentSession: parentId,
    },
    SessionLogOffset(prefix.length),
  );
  const own = appendTurn(fork, 2, source, true);
  const observed = {
    header: fork.header,
    events: [...seed, ...own],
    inheritedEventCount: prefix.length,
  };
  const actual = {
    ...selection,
    sessionId: forkId,
    turn: 2,
    cursor: own[2]!.seq,
  };
  expect(
    findDEntryNativeRunTerminal(
      { ...actual, forkedFromNativeSessionId: parentId },
      observed,
    ),
  ).toMatchObject({
    sessionId: forkId,
    turn: 2,
    sequence: own.at(-1)!.seq,
  });
  expect(findDEntryNativeRunTerminal(actual, observed)).toBeNull();
  expect(
    findDEntryNativeRunTerminal(
      { ...actual, forkedFromNativeSessionId: 'unregistered-parent' },
      observed,
    ),
  ).toBeNull();
  expect(
    findDEntryNativeRunTerminal(
      {
        ...actual,
        forkedFromNativeSessionId: parentId,
        turn: 1,
        cursor: prefix[2]!.seq,
      },
      observed,
    ),
  ).toBeNull();
});

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
