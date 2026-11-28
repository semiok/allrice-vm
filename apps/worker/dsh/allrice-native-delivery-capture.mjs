import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { posix } from 'node:path';

const maximumFileBytes = 8_000_000;
const maximumBatchBytes = 16_000_000;

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
    const path = posix.isAbsolute(file.path)
      ? file.path
      : `${cwd}/${file.path}`;
    if (!isBoundaryPath(path, root) || captured.has(path))
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
    const boundary = scope.sessionProjections.stateOf(session, 'turnBoundary');
    if (!boundary?.lastTurn || boundary.openTurnStartSeq === null)
      return next();
    executing.set(exec.token, null);
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
        !result.isError &&
        result.value?.turn === boundary.lastTurn &&
        isLive(session)
      ) {
        const files = await finish(result.value.files);
        executing.set(exec.token, {
          session,
          signal,
          files,
          turn: boundary.lastTurn,
          callId: exec.callId,
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
      entry && !entry.signal.aborted && isLive(entry.session);
    const proof = (ticket, { session, turn, callId }) => ({
      ticket,
      sessionId: session.id,
      turn,
      callId,
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
      entry.callId !== value.callId
    )
      return new globalThis.Response(null, { status: 404 });
    if (value.action === 'delivery-read')
      return globalThis.Response.json(
        { ...proof(value.ticket, entry), files: entry.files },
        { headers },
      );
    entry.finish(true);
    return globalThis.Response.json(true, { headers });
  };
}
