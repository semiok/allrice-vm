import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { setImmediate as nextTick } from 'node:timers/promises';
import {
  captureNativeDelivery,
  observeNativeDeliveries,
} from './allrice-native-delivery-capture.mjs';

assert.equal(
  process.platform,
  'linux',
  'this test exercises Linux /proc/self/fd',
);

const fs = {
  async resolve(path) {
    return path;
  },
  processPath(path) {
    return path;
  },
  async stat(path) {
    const identity = await stat(path, { bigint: true });
    return {
      type: identity.isFile() ? 'file' : 'other',
      version: [
        identity.dev,
        identity.ino,
        identity.size,
        identity.mtimeNs,
        identity.ctimeNs,
      ].join(':'),
    };
  },
};
async function workspace(t) {
  const parent = await mkdtemp('/tmp/allrice-native-delivery-');
  t.after(() => rm(parent, { force: true, recursive: true }));
  const root = await realpath(parent);
  const work = join(root, 'work');
  const document = join(work, 'draft.md');
  await mkdir(work);
  await writeFile(document, 'original exact bytes\r\n');
  return {
    root,
    work,
    document,
    signal: new globalThis.AbortController().signal,
  };
}

test('captures bytes, rejects replacement, and does not re-read after confirmation', async (t) => {
  const { work, document, signal } = await workspace(t);
  const finish = await captureNativeDelivery(
    fs,
    [{ path: 'draft.md' }],
    work,
    work,
    signal,
  );
  const captured = await finish([{ path: document }]);
  assert.equal(
    Buffer.from(captured[0].base64, 'base64').toString(),
    await readFile(document, 'utf8'),
  );
  await writeFile(document, 'a later version');
  assert.equal(
    Buffer.from(captured[0].base64, 'base64').toString(),
    'original exact bytes\r\n',
  );
  await assert.rejects(finish([{ path: document }]), /FILE_CHANGED/);
});

test('rejects path escape, private directories, symlinks, hard links, and FIFOs', async (t) => {
  const { root, work, document, signal } = await workspace(t);
  const other = join(root, 'elsewhere');
  await mkdir(other);
  await writeFile(join(other, 'private.md'), 'unrelated bytes');
  await symlink(join(other, 'private.md'), join(work, 'symlink.md'));
  await symlink(other, join(work, 'ancestor-link'));
  await link(document, join(work, 'hard.md'));
  execFileSync('mkfifo', [join(work, 'pipe.md')]);
  for (const path of [
    '../elsewhere/private.md',
    join(other, 'private.md'),
    '.allrice/internal.md',
    'symlink.md',
    'ancestor-link/private.md',
    'hard.md',
    'draft.md',
    'pipe.md',
  ])
    await assert.rejects(
      captureNativeDelivery(fs, [{ path }], work, work, signal),
      undefined,
      path,
    );
});

test('keeps native success behind the exact archive acknowledgement', async (t) => {
  const { work, document } = await workspace(t);
  const lifetime = new globalThis.AbortController();
  const callbacks = new Map();
  const session = { id: 'native-thread', seq: 5 };
  const agent = { session };
  const scope = {
    fs,
    sessions: new Map([[session.id, session]]),
    workingDirectory: { ensure: async () => dirname(document) },
    agents: new Map([[session.id, agent]]),
    on: (type, callback) => callbacks.set(type, callback),
  };
  const receive = observeNativeDeliveries(scope, {
    root: work,
    lifetime: lifetime.signal,
    current: () => true,
    unwrap: (value) => value,
  });
  const exec = {
    name: 'present',
    token: Symbol(),
    arguments: { files: [{ path: document }] },
    callId: 'one-present',
    signal: new globalThis.AbortController().signal,
    agent,
  };
  const observeCall = (step, assistantSeq) => {
    const attemptId = 'attempt-' + step;
    callbacks.get('agent/assistant-stream')({
      agent,
      frame: { type: 'start', step, turn: 2, attemptId },
    });
    callbacks.get('session/event')(session, {
      type: 'assistant/message',
      seq: assistantSeq,
      data: {
        step,
        turn: 2,
        message: {
          content: [{ type: 'tool-call', name: 'present', id: exec.callId }],
        },
      },
    });
    callbacks.get('agent/assistant-stream')({
      agent,
      frame: {
        type: 'end',
        attemptId,
        outcome: {
          kind: 'committed',
          eventType: 'assistant/message',
          seq: assistantSeq,
        },
      },
    });
    callbacks.get('session/event')(session, {
      type: 'tool/call',
      seq: assistantSeq + 1,
      data: { step, turn: 2, name: 'present', callId: exec.callId },
    });
  };
  observeCall(1, 6);
  const result = {
    isError: false,
    value: { turn: 2, files: [{ path: document }] },
  };
  await callbacks.get('tools/execute')(exec, async () => result);
  let settled = false;
  const complete = callbacks
    .get('tools/post-execute')(exec, result, async () => ({ kind: 'accept' }))
    .finally(() => {
      settled = true;
    });
  await nextTick();
  const [offer] = await receive({ action: 'delivery-pending' }).json();
  assert.equal(settled, false);
  assert.equal(
    receive({ ...offer, action: 'delivery-ack', callId: 'not-mine' }).status,
    404,
  );
  const snapshot = await receive({ ...offer, action: 'delivery-read' }).json();
  assert.equal(
    Buffer.from(snapshot.files[0].base64, 'base64').toString(),
    'original exact bytes\r\n',
  );
  // An interrupted Worker may read and retry the original capture but cannot
  // obtain newer file content under the same tool invocation.
  await writeFile(document, 'other session wrote this');
  assert.deepEqual(
    await receive({ ...offer, action: 'delivery-read' }).json(),
    snapshot,
  );
  assert.equal(receive({ ...offer, action: 'delivery-ack' }).status, 200);
  assert.equal((await complete).kind, 'accept');
  assert.equal(receive({ ...offer, action: 'delivery-read' }).status, 404);

  observeCall(2, 10);
  const next = { ...exec, token: Symbol() };
  await callbacks.get('tools/execute')(next, async () => result);
  const interrupted = callbacks.get('tools/post-execute')(
    next,
    result,
    async () => ({ kind: 'accept' }),
  );
  assert.equal(
    (await receive({ action: 'delivery-pending' }).json()).length,
    1,
  );
  lifetime.abort();
  assert.equal((await interrupted).kind, 'block');
  assert.deepEqual(await receive({ action: 'delivery-pending' }).json(), []);
});
