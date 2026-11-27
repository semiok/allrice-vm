import { lstat, readFile, realpath } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function isPrompt(event, requestId) {
  if (event.type !== 'user/message') return false;
  const source = record(record(event.data).source);
  return source.kind === 'user' && source.rpcId === requestId;
}

function isWakeMessage(event, sessionId) {
  if (event.type !== 'user/message') return false;
  const source = record(record(event.data).source);
  if (
    typeof source.senderSessionId !== 'string' ||
    !source.senderSessionId ||
    source.senderSessionId === sessionId
  )
    return false;
  return (
    (source.kind === 'agent-message' && source.form === 'relay') ||
    (source.kind === 'subagent-settled' &&
      source.form === 'notice' &&
      typeof source.summary === 'string')
  );
}

function terminalReason(event) {
  const kind = record(record(event.data).reason).kind;
  switch (kind) {
    case 'completed':
    case 'aborted':
    case 'interrupted':
    case 'blocked':
    case 'error':
    case 'max-tokens':
      return kind;
    default:
      return null;
  }
}

function turnEnd(sessionId, event, turn) {
  const reason = terminalReason(event);
  const time = new Date(event.time);
  if (
    record(event.data).turn !== turn ||
    !reason ||
    !Number.isSafeInteger(event.time) ||
    event.time < 0 ||
    !Number.isFinite(+time)
  )
    return null;
  return {
    sessionId,
    sequence: event.seq,
    turn,
    reason,
    occurredAt: time.toISOString(),
  };
}

/** Project only a contiguous physical journal returned by native
 * sessionPersistence. session-query can synthesize a cold interrupted tail. */
export function isNativeForkHeader(header) {
  return (
    header.origin === undefined &&
    header.isSeeded === true &&
    typeof header.parentSession === 'string' &&
    header.parentSession.length > 0 &&
    header.parentSession !== header.id
  );
}

export function findDEntryNativeRunTerminal(
  {
    sessionId,
    nativeRequestId,
    cursor: index,
    turn: expectedTurn,
    purpose,
    delegated = false,
    parentSessionId = null,
    forkedFromNativeSessionId,
  },
  { header, events, inheritedEventCount },
  witnessedStartSequence,
) {
  const cursor = events[index];
  const child = parentSessionId !== null;
  const matchingHeader = child
    ? forkedFromNativeSessionId === undefined &&
      delegated &&
      header.origin === 'subagent' &&
      header.parentSession === parentSessionId
    : forkedFromNativeSessionId !== undefined
      ? isNativeForkHeader(header) &&
        header.parentSession === forkedFromNativeSessionId &&
        inheritedEventCount > 0
      : !header.isSeeded &&
        header.parentSession === undefined &&
        header.origin === undefined &&
        inheritedEventCount === 0;
  if (
    sessionId !== header.id ||
    !matchingHeader ||
    !Number.isSafeInteger(inheritedEventCount) ||
    inheritedEventCount < 0 ||
    (!header.isSeeded && inheritedEventCount !== 0) ||
    index < inheritedEventCount ||
    cursor?.seq !== index
  )
    return null;

  let anchor = cursor.seq;
  if (purpose === 'session-title') {
    if (delegated || cursor.type !== 'session/title-llm-request') return null;
    const seqs = record(cursor.data).messageSeqs;
    if (!Array.isArray(seqs)) return null;
    const matching = new Set();
    for (const seq of seqs) {
      if (
        !Number.isSafeInteger(seq) ||
        seq < inheritedEventCount ||
        seq >= cursor.seq
      )
        return null;
      const message = events[seq];
      if (message?.seq !== seq) return null;
      if (isPrompt(message, nativeRequestId)) matching.add(seq);
    }
    if (matching.size !== 1) return null;
    anchor = [...matching][0];
  } else {
    if (expectedTurn === null) return null;
    if (purpose === 'compaction') {
      const data = record(cursor.data);
      if (
        cursor.type !== 'compaction/start' ||
        typeof data.compactionId !== 'string' ||
        !data.compactionId ||
        data.turn !== expectedTurn
      )
        return null;
    }
  }

  let start;
  // Child scope was established at admission. Its header and own bracket
  // pin that fact. A root wake also needs an actual adopted native message.
  let hasInput = child;
  for (let seq = anchor; seq >= inheritedEventCount; --seq) {
    const event = events[seq];
    if (
      event?.seq !== seq ||
      event.type === 'turn/end' ||
      event.type === 'session/end-seed'
    )
      return null;
    if (event.type === 'turn/start') {
      start = event;
      break;
    }
    if (!hasInput)
      hasInput = delegated
        ? isWakeMessage(event, sessionId)
        : isPrompt(event, nativeRequestId);
  }
  const turn = record(start?.data).turn;
  if (
    !hasInput ||
    typeof turn !== 'number' ||
    !Number.isSafeInteger(turn) ||
    turn < 1 ||
    (expectedTurn !== null && turn !== expectedTurn) ||
    (witnessedStartSequence !== undefined &&
      start.seq !== witnessedStartSequence)
  )
    return null;

  for (let sequence = anchor + 1; sequence < events.length; ++sequence) {
    const event = events[sequence];
    if (
      event?.seq !== sequence ||
      event.type === 'turn/start' ||
      event.type === 'session/end-seed'
    )
      return null;
    if (event.type !== 'turn/end') continue;
    return turnEnd(header.id, event, turn);
  }
  return null;
}

export async function readPersistedRunTerminal(
  persistence,
  selection,
  active,
  witnessedStartSequence,
) {
  const {
    sessionId,
    nativeRequestId,
    cursor,
    turn,
    delegated = false,
    parentSessionId = null,
    forkedFromNativeSessionId,
  } = selection;
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    sessionId.length > 256 ||
    typeof nativeRequestId !== 'string' ||
    nativeRequestId.length === 0 ||
    nativeRequestId.length > 256 ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !(turn === null || Number.isSafeInteger(turn)) ||
    typeof delegated !== 'boolean' ||
    (forkedFromNativeSessionId !== undefined &&
      (parentSessionId !== null ||
        typeof forkedFromNativeSessionId !== 'string' ||
        !forkedFromNativeSessionId.length ||
        forkedFromNativeSessionId.length > 256 ||
        forkedFromNativeSessionId === sessionId)) ||
    (parentSessionId !== null &&
      (!delegated ||
        typeof parentSessionId !== 'string' ||
        parentSessionId.length === 0 ||
        parentSessionId.length > 256 ||
        parentSessionId === sessionId))
  )
    return null;
  active.throwIfAborted();
  if (!persistence) return null;
  // The backend reads the physical prefix. The query/follow service can add
  // a generated interrupted closer when it displays a cold orphaned turn.
  const stored = await persistence.stat(sessionId, { signal: active });
  if (
    !stored ||
    stored.header.id !== sessionId ||
    stored.formatStatus !== 'current'
  )
    return null;
  const handle = await persistence.open(sessionId, 'read', { signal: active });
  try {
    if (handle.access !== 'read') return null;
    const { events } = await handle.read(0, undefined, { signal: active });
    const after = await persistence.stat(sessionId, { signal: active });
    active.throwIfAborted();
    if (after?.revision !== stored.revision || after.formatStatus !== 'current')
      return null;
    return findDEntryNativeRunTerminal(
      selection,
      {
        header: handle.header,
        events,
        inheritedEventCount: handle.inheritedEventCount,
      },
      witnessedStartSequence,
    );
  } finally {
    await handle.close();
  }
}

/** One observer per managed native owner. Only attached SessionStore events
 * reach observe. Disposal may retain a completed receipt. Reactivation keeps
 * the turn watermark and may attest only a later turn of the new Session. */
export function createNativeRunTerminalAttestations() {
  const sessions = new Map();
  const receipts = new Map();
  function matches(state, current) {
    return (
      !!state &&
      (state.detached
        ? !current
        : !!current && state.session.deref() === current)
    );
  }
  function entered(session, turn = 0) {
    return {
      session: new WeakRef(session),
      parentSessionId: session.header.parentSession ?? null,
      createdAt: session.header.createdAt,
      origin: session.header.origin,
      seeded: session.header.isSeeded,
      detached: false,
      turn,
      start: null,
    };
  }
  return {
    hasCurrent({ sessionId, turn }, current) {
      const state = sessions.get(sessionId);
      const receipt = receipts.get(JSON.stringify([sessionId, turn]));
      return matches(state, current) && receipt?.state === state;
    },
    attach(session) {
      const state = sessions.get(session.id);
      if (!state) return;
      if (state.detached) {
        const sameHeader =
          state.parentSessionId === (session.header.parentSession ?? null) &&
          state.createdAt === session.header.createdAt &&
          state.origin === session.header.origin &&
          state.seeded === session.header.isSeeded;
        sessions.set(
          session.id,
          sameHeader ? entered(session, state.turn) : null,
        );
      } else if (state.session.deref() !== session)
        sessions.set(session.id, null);
    },
    detach(session) {
      const state = sessions.get(session.id);
      if (state?.session.deref() === session) state.detached = true;
    },
    observe(session, event) {
      const { id } = session;
      let state = sessions.get(id);
      if (state === null) return;
      if (state && (state.detached || state.session.deref() !== session)) {
        // A restored session can reuse its id and old turn numbers. Keep
        // this denial for the life of the owner, even after receipt eviction.
        sessions.set(id, null);
        return;
      }
      const { type, seq } = event;
      const turn = record(event.data).turn;
      if (
        !Number.isSafeInteger(turn) ||
        turn < 1 ||
        !Number.isSafeInteger(seq) ||
        seq < 0
      )
        return;
      if (type === 'turn/start') {
        if (!state) {
          if (sessions.size >= 1024) return;
          state = entered(session);
          sessions.set(id, state);
        }
        if (state.start !== null || turn <= state.turn) {
          sessions.set(id, null);
          return;
        }
        state.turn = turn;
        state.start = seq;
        return;
      }
      if (type !== 'turn/end' || !state || state.start === null) return;
      const start = state.start;
      state.start = null;
      const end = turnEnd(id, event, state.turn);
      // Native cold recovery can persist an interrupted closer before it
      // attaches the Session. Fork closers are excluded by turnEnd as well.
      if (!end || end.reason === 'interrupted' || end.sequence <= start) return;
      receipts.set(JSON.stringify([id, turn]), { state, start, end });
      if (receipts.size > 2048) receipts.delete(receipts.keys().next().value);
    },
    async read(currentSession, persistence, selection, active) {
      const {
        sessionId,
        turn,
        cursor,
        purpose,
        parentSessionId,
        forkedFromNativeSessionId,
      } = selection;
      const state = sessions.get(sessionId);
      if (
        !state ||
        state.parentSessionId !==
          (parentSessionId ?? forkedFromNativeSessionId ?? null) ||
        !Number.isSafeInteger(turn) ||
        turn < 1 ||
        (purpose !== 'assistant' && purpose !== 'compaction')
      )
        return null;
      const sameSession = () => {
        return (
          sessions.get(sessionId) === state && matches(state, currentSession())
        );
      };
      if (!sameSession()) return null;
      const receipt = receipts.get(JSON.stringify([sessionId, turn]));
      if (
        receipt?.state !== state ||
        cursor <= receipt.start ||
        cursor >= receipt.end.sequence
      )
        return null;
      const stored = await readPersistedRunTerminal(
        persistence,
        selection,
        active,
        receipt.start,
      );
      active.throwIfAborted();
      const { end } = receipt;
      return sameSession() &&
        stored?.sessionId === end.sessionId &&
        stored.turn === end.turn &&
        stored.sequence === end.sequence &&
        stored.reason === end.reason &&
        stored.occurredAt === end.occurredAt
        ? stored
        : null;
    },
  };
}

async function loadRetainedRunBackend(cli, readonlyRoot) {
  const sealed = await realpath(readonlyRoot);
  const cliLocation = await realpath(cli);
  if (sealed !== readonlyRoot || !cliLocation.startsWith(sealed + '/'))
    throw Error('UNVERIFIED_DSH_READER');
  const cliRequire = createRequire(cliLocation);
  const resolveSealed = async (requireFrom, id) => {
    const location = await realpath(requireFrom.resolve(id));
    if (!location.startsWith(sealed + '/'))
      throw Error('UNVERIFIED_DSH_READER');
    return location;
  };
  const base = createRequire(
    await resolveSealed(cliRequire, '@deepseek-ai/dsh-base/package.json'),
  );
  const backendId = '@deepseek-ai/dsh-session-persistence-jsonl';
  const metadata = JSON.parse(
    await readFile(
      await resolveSealed(base, backendId + '/package.json'),
      'utf8',
    ),
  );
  if (metadata.version !== '0.2.1-rc.2') throw Error('UNVERIFIED_DSH_READER');
  const backendLocation = await resolveSealed(base, backendId);
  const cordisLocation = await resolveSealed(
    createRequire(backendLocation),
    '@deepseek-ai/cordis',
  );
  // Keep these public specifiers visible to the native artifact scanner.
  // Only this probe's imports use the entries verified on the Guest mount.
  const entries = new Map([
    ['@deepseek-ai/cordis', pathToFileURL(cordisLocation).href],
    [backendId, pathToFileURL(backendLocation).href],
  ]);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const url =
        context.parentURL === import.meta.url && entries.get(specifier);
      return url
        ? { url, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  try {
    const { Context } = await import('@deepseek-ai/cordis');
    const backend = await import('@deepseek-ai/dsh-session-persistence-jsonl');
    return { Context, backend };
  } finally {
    hooks.deregister();
  }
}

// Executed only by the Host's fixed managed read probe on an already running
// retained VM. The CLI is on its verified read-only release mount.
export async function printRetainedRunTerminal([
  cli,
  readonlyRoot,
  employee,
  encoded,
]) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      employee,
    )
  )
    throw Error('INVALID_JOURNAL_SCOPE');
  const root = `/work/.allrice/employees/${employee}/dsh/sessions`;
  const knownDirectory = await lstat(root).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  });
  if (!knownDirectory?.isDirectory() || (await realpath(root)) !== root) {
    stdout.write('null');
    return;
  }

  const { Context, backend } = await loadRetainedRunBackend(cli, readonlyRoot);
  const ctx = new Context();
  let end;
  try {
    // Same public backend and defaults as dsh-base's dshHomePath('sessions').
    await ctx.plugin(backend.default ?? backend, { root }).await();
    end = await readPersistedRunTerminal(
      ctx.get('sessionPersistence'),
      JSON.parse(encoded),
      globalThis.AbortSignal.timeout(8000),
    );
    if ((await realpath(root)) !== root) throw Error('JOURNAL_SCOPE_CHANGED');
  } finally {
    await ctx.fiber.dispose();
  }
  stdout.write(JSON.stringify(end));
}
