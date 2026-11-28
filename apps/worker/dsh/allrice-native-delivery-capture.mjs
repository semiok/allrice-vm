import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { posix } from 'node:path';

const maximumFileBytes = 8_000_000;
const maximumBatchBytes = 16_000_000;
const deliveryExtensions = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.tsv',
  '.json',
  '.html',
  '.htm',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.zip',
]);

function isBoundaryPath(path, root) {
  return (
    typeof path === 'string' &&
    path.length <= 1024 &&
    path.startsWith(`${root}/`) &&
    !Array.from(path).some(
      (character) =>
        character < ' ' || character === '\u007f' || character === '\\',
    ) &&
    path
      .slice(root.length + 1)
      .split('/')
      .every(
        (component) =>
          component && !component.startsWith('.') && component.length <= 255,
      )
  );
}

function sameFile(a, b) {
  return (
    a.isFile() &&
    b.isFile() &&
    a.nlink === 1n &&
    b.nlink === 1n &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

async function readDocument(path, nameIdentity, maximum, signal) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const descriptor = `/proc/self/fd/${file.fd}`;
    const before = await file.stat({ bigint: true });
    if (
      !sameFile(nameIdentity, before) ||
      before.size > BigInt(maximum) ||
      (await readlink(descriptor)) !== path
    )
      throw Error('NATIVE_DELIVERY_FILE_UNAVAILABLE');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) throw Error('NATIVE_DELIVERY_FILE_CHANGED');
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (!sameFile(before, after) || (await readlink(descriptor)) !== path)
      throw Error('NATIVE_DELIVERY_FILE_CHANGED');
    signal.throwIfAborted();
    return bytes;
  } finally {
    await file.close();
  }
}

/** Freeze an explicit native delivery while its registered tool is executing.
 * The caller must compare finish() with the actual canonical result before it
 * can publish. Replaying a turn or a path cannot produce this witness. */
export async function captureNativeDelivery(fs, files, cwd, root, signal) {
  if (
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > 8 ||
    (cwd !== root && !isBoundaryPath(cwd, root))
  )
    throw Error('NATIVE_DELIVERY_FILES_INVALID');
  const captured = new Map();
  let remainder = maximumBatchBytes;
  for (const file of files) {
    signal.throwIfAborted();
    if (typeof file?.path !== 'string' || !file.path.trim())
      throw Error('NATIVE_DELIVERY_FILES_INVALID');
    let input = file.path;
    while (input.startsWith('./')) input = input.slice(2);
    const path = posix.isAbsolute(input) ? input : `${cwd}/${input}`;
    if (
      !isBoundaryPath(path, root) ||
      captured.has(path) ||
      !deliveryExtensions.has(posix.extname(path).toLowerCase())
    )
      throw Error('NATIVE_DELIVERY_FILES_INVALID');
    const nameIdentity = await lstat(path, { bigint: true });
    const target = await fs.resolve(path, { cwd, signal });
    const expected = await fs.stat(target, signal);
    if (fs.processPath(target) !== path || expected?.type !== 'file')
      throw Error('NATIVE_DELIVERY_FILE_UNAVAILABLE');
    const bytes = await readDocument(
      path,
      nameIdentity,
      Math.min(maximumFileBytes, remainder),
      signal,
    );
    captured.set(path, {
      target,
      version: expected.version,
      bytes,
      nameIdentity,
    });
    remainder -= bytes.length;
  }
  return async function finish(declared) {
    if (!Array.isArray(declared) || declared.length !== captured.size)
      throw Error('NATIVE_DELIVERY_FILES_INVALID');
    const sealed = [];
    for (const [path, value] of captured) {
      const current = await fs.stat(value.target, signal);
      if (
        declared[sealed.length]?.path !== path ||
        current?.type !== 'file' ||
        current.version !== value.version ||
        !sameFile(value.nameIdentity, await lstat(path, { bigint: true }))
      )
        throw Error('NATIVE_DELIVERY_FILE_CHANGED');
      sealed.push({ path, base64: value.bytes.toString('base64') });
    }
    signal.throwIfAborted();
    return sealed;
  };
}

/** One bounded live rendezvous. No consumer can reconstruct a pending
 * publication from mutable workspace files or retained session history. */
export function observeNativeDeliveries(
  scope,
  { root, lifetime, current, unwrap },
) {
  const attempts = new WeakMap();
  scope.on(
    'agent/assistant-stream',
    ({ agent, frame }) => {
      const session = unwrap(agent.session);
      if (!isLive(session)) return;
      if (frame.type === 'start') {
        attempts.set(session, {
          attemptId: frame.attemptId,
          cursor: session.seq - 1,
          turn: frame.turn,
          step: frame.step,
          calls: new Map(),
        });
        return;
      }
      const attempt = attempts.get(session);
      if (frame.type === 'end' && attempt?.attemptId === frame.attemptId) {
        if (
          frame.outcome.kind === 'committed' &&
          frame.outcome.eventType === 'assistant/message' &&
          attempt.assistant?.seq === frame.outcome.seq
        )
          attempt.committed = true;
        else attempts.delete(session);
      }
    },
    { global: true },
  );
  scope.on(
    'session/event',
    (subject, event) => {
      const session = unwrap(subject);
      const attempt = attempts.get(session);
      if (!attempt || !isLive(session)) return;
      if (event.type === 'step/end' || event.type === 'turn/end') {
        attempts.delete(session);
        return;
      }
      if (
        event.data?.turn !== attempt.turn ||
        event.data?.step !== attempt.step
      )
        return;
      if (event.type === 'assistant/message') attempt.assistant = event;
      if (
        event.type === 'tool/call' &&
        event.data.name === 'present' &&
        attempt.committed &&
        attempt.assistant.seq < event.seq &&
        attempt.assistant.data.message.content.filter(
          (block) =>
            block.type === 'tool-call' &&
            block.id === event.data.callId &&
            block.name === 'present',
        ).length === 1
      )
        attempt.calls.set(
          event.data.callId,
          attempt.calls.has(event.data.callId) ? null : event.seq,
        );
    },
    { global: true },
  );
  const executing = new Map();
  const pending = new Map();
  const unavailable = () => ({
    kind: 'block',
    feedback: [
      {
        type: 'text',
        text: '交付未能保存到个人交付成果，文件仍在工作区。请重试交付。',
      },
    ],
  });
  const isLive = (session) =>
    current() &&
    !lifetime.aborted &&
    unwrap(scope.sessions.get(session.id)) === session;

  scope.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'present' || !exec.agent) return next();
    const session = unwrap(exec.agent.session);
    if (executing.size + pending.size >= 4 || !isLive(session)) return next();
    const signal = globalThis.AbortSignal.any([lifetime, exec.signal]);
    const attempt = attempts.get(session);
    const callSequence = attempt?.calls.get(exec.callId);
    if (
      !callSequence ||
      exec.parent !== undefined ||
      unwrap(scope.agents.get(session.id)) !== unwrap(exec.agent)
    )
      return next();
    attempt.calls.delete(exec.callId);
    executing.set(exec.token, null);
    const forget = () => executing.delete(exec.token);
    signal.addEventListener('abort', forget, { once: true });
    try {
      const cwd = await scope.workingDirectory.ensure(exec.agent, signal);
      const finish = await captureNativeDelivery(
        scope.fs,
        exec.arguments?.files,
        cwd,
        root,
        signal,
      );
      const result = await next();
      if (
        !signal.aborted &&
        !result.isError &&
        result.value?.turn === attempt.turn &&
        attempts.get(session) === attempt &&
        isLive(session)
      ) {
        const files = await finish(result.value.files);
        executing.set(exec.token, {
          session,
          signal,
          files,
          turn: attempt.turn,
          attemptId: attempt.attemptId,
          cursor: attempt.cursor,
          callId: exec.callId,
          callSequence,
          forget,
        });
      } else {
        executing.delete(exec.token);
      }
      return result;
    } catch (error) {
      executing.delete(exec.token);
      if (signal.aborted) throw error;
      // The registry applies the post-execution policy to the result.
      throw Error(
        '交付文件无法固定到个人交付成果，请检查工作区内的文件并重试。',
      );
    }
  });

  scope.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name !== 'present' || !exec.agent) return next();
    const found = executing.get(exec.token);
    executing.delete(exec.token);
    found?.signal.removeEventListener('abort', found.forget);
    if (result.isError) return next();
    if (!found || !isLive(found.session)) return unavailable();
    const selected = await next();
    if (selected.kind !== 'accept') return selected;
    if (Object.hasOwn(selected, 'value') || Object.hasOwn(selected, 'content'))
      return unavailable();
    const ticket = randomUUID();
    const signal = globalThis.AbortSignal.any([
      found.signal,
      globalThis.AbortSignal.timeout(60_000),
    ]);
    const saved = await new Promise((resolve) => {
      const finish = (accepted) => {
        pending.delete(ticket);
        signal.removeEventListener('abort', cancel);
        resolve(accepted);
      };
      const cancel = () => finish(false);
      pending.set(ticket, { ...found, signal, finish });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
    return saved && !signal.aborted && isLive(found.session)
      ? selected
      : unavailable();
  });

  return function delivery(value) {
    const headers = { 'cache-control': 'no-store' };
    const live = (entry) =>
      entry &&
      !entry.signal.aborted &&
      isLive(entry.session) &&
      attempts.get(entry.session)?.attemptId === entry.attemptId;
    const proof = (
      ticket,
      { session, turn, callId, callSequence, attemptId, cursor },
    ) => ({
      ticket,
      sessionId: session.id,
      turn,
      callId,
      callSequence,
      attemptId,
      cursor,
    });
    if (value.action === 'delivery-pending')
      return globalThis.Response.json(
        [...pending].flatMap(([ticket, entry]) =>
          live(entry) ? [proof(ticket, entry)] : [],
        ),
        { headers },
      );
    const entry = pending.get(value.ticket);
    if (
      !live(entry) ||
      entry.session.id !== value.sessionId ||
      entry.turn !== value.turn ||
      entry.callId !== value.callId ||
      entry.callSequence !== value.callSequence ||
      entry.attemptId !== value.attemptId ||
      entry.cursor !== value.cursor
    )
      return new globalThis.Response(null, { status: 404 });
    if (value.action === 'delivery-read')
      return globalThis.Response.json(
        { ...proof(value.ticket, entry), files: entry.files },
        { headers },
      );
    if (value.action === 'delivery-live')
      return globalThis.Response.json(true, { headers });
    entry.finish(true);
    return globalThis.Response.json(true, { headers });
  };
}
