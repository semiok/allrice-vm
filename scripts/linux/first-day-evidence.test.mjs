import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const cli = fileURLToPath(new URL('./first-day-evidence.mjs', import.meta.url));
const stepNames = [
  'preflight',
  'host',
  'single-vm',
  'workbench',
  'timing',
  'concurrency',
  'recovery',
];

async function fixture(fn, mode = 'linux') {
  const directory = await mkdtemp(join(tmpdir(), 'allrice-linux-evidence-'));
  const index = join(directory, 'index.json');
  const run = {
    mode,
    target: mode === 'linux' ? 'i-01234567890abcdef' : 'local-fixture',
    id: 'trial-01',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    seal: 'sha256:' + 'c'.repeat(64),
  };
  try {
    const records = [];
    for (const step of stepNames) {
      const file = `${step}.log`;
      const bytes = `synthetic private content: ${step}\n`;
      await writeFile(join(directory, file), bytes);
      records.push({
        step,
        run: { ...run },
        result: 'pass',
        artifact: {
          file,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      });
    }
    const packet = { version: 1, run, records };
    const report = async () => {
      await writeFile(index, JSON.stringify(packet));
      return spawnSync(process.execPath, [cli, index], { encoding: 'utf8' });
    };
    await fn({ directory, packet, records, report });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('CLI inventories all seven stages and only prints the bound artifact names', async () => {
  await fixture(async ({ records, report }) => {
    records.reverse();
    const result = await report();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /证据齐全，待实机验收复核/);
    assert.doesNotMatch(result.stdout, /synthetic private content/);
    for (const step of stepNames)
      assert.ok(result.stdout.includes(`${step}.log`));
    assert.ok(
      result.stdout.indexOf('preflight.log') <
        result.stdout.indexOf('recovery.log'),
    );
  });
});

test('fixture evidence cannot satisfy the target run and skip remains incomplete', async () => {
  await fixture(async ({ report }) => {
    const result = await report();
    assert.equal(result.status, 2);
    assert.match(result.stdout, /仅模拟/);
  }, 'fixture');

  await fixture(async ({ packet, records, report }) => {
    packet.records = [
      records[0],
      { ...records[1], result: 'skip', reason: 'not-authorized' },
    ];
    const result = await report();
    assert.equal(result.status, 2);
    assert.match(result.stdout, /跳过 \| 尚未授权/);
    assert.match(result.stdout, /待验 \| 未提交原件/);
  });
});

test('keeps a failure visible when later claims lack a prerequisite or a valid artifact', async () => {
  await fixture(async ({ directory, records, report }) => {
    records[1].result = 'fail';
    records[3].artifact.file = 'missing.log';
    const firstFailure = join(directory, records[1].artifact.file);
    const before = await readFile(firstFailure);
    const result = await report();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /失败 \| `host.log`/);
    assert.match(result.stdout, /前置未通过 \| `single-vm.log`/);
    assert.match(result.stdout, /原件无效 \| workbench 的原件缺失/);
    assert.deepEqual(await readFile(firstFailure), before);
  });
});

test('rejects a different target, commit, tree, seal, run or mode', async () => {
  await fixture(async ({ records, report }) => {
    const original = records[1].run;
    for (const change of [
      { id: 'trial-02' },
      { target: 'i-fedcba09876543210' },
      { commit: 'd'.repeat(40) },
      { tree: 'd'.repeat(40) },
      { seal: 'sha256:' + 'd'.repeat(64) },
      { mode: 'fixture', target: 'local-fixture' },
    ]) {
      records[1].run = { ...original, ...change };
      const result = await report();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /运行身份与索引不符/);
      assert.equal(result.stdout, '');
    }
  });
});

test('rejects tampering, traversal, symlinks and missing files without exposing bytes', async () => {
  await fixture(async ({ directory, records, report }) => {
    const artifact = records[0].artifact;
    const original = artifact.file;
    await symlink(original, join(directory, 'link.log'));
    for (const file of [
      '../private.log',
      'link.log',
      'missing.log',
      'preflight.log\n',
    ]) {
      artifact.file = file;
      const result = await report();
      assert.equal(result.status, 1);
      assert.match(result.stdout, /原件无效 \| preflight 的原件/);
      assert.ok(!result.stdout.includes(file));
    }
    artifact.file = original;
    await writeFile(join(directory, original), 'replacement private bytes');
    const result = await report();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /摘要不符/);
    assert.doesNotMatch(result.stdout, /private bytes/);
  });
});

test('one artifact cannot satisfy two stages even under different filenames', async () => {
  await fixture(async ({ directory, records, report }) => {
    const first = records[0].artifact;
    records[1].artifact = { ...first };
    const duplicate = await report();
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stdout, /其他阶段已使用同一原件/);

    const copy = 'copy.log';
    await writeFile(
      join(directory, copy),
      await readFile(join(directory, first.file)),
    );
    records[1].artifact = { ...first, file: copy };
    const repeatedBytes = await report();
    assert.equal(repeatedBytes.status, 1);
    assert.match(repeatedBytes.stdout, /其他阶段已使用同一原件/);
  });
});

test('rejects duplicate stages, unknown results and unsafe skip reasons', async () => {
  await fixture(async ({ records, report }) => {
    records.push(records[0]);
    const duplicate = await report();
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /阶段未知或重复/);
    records.pop();
    for (const result of ['success', 'skip']) {
      records[0].result = result;
      records[0].reason = 'unrecognized reason';
      const invalid = await report();
      assert.equal(invalid.status, 1);
      assert.match(invalid.stdout, /状态或跳过原因无效/);
      assert.doesNotMatch(invalid.stdout, /unrecognized reason/);
    }
  });
});
