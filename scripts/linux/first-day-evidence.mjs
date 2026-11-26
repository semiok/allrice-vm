import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const stages = new Map([
  ['preflight', '实例、封签和卷身份'],
  ['host', 'KVM、LUKS2/XFS 和 reflink'],
  ['single-vm', '单 VM 启动、隔离及卸载'],
  ['workbench', '公网工作台与权限'],
  ['timing', '冷启、预备盘、同盘重启与热开的分段计时'],
  ['concurrency', '1→2→4 个合成人的并发及释放'],
  ['recovery', '合成 PG 和卷恢复'],
]);

const skipReasons = new Map([
  ['not-run', '尚未执行'],
  ['not-authorized', '尚未授权'],
  ['blocked', '前置未通过'],
  ['unavailable', '目标环境尚未就绪'],
]);

class EvidenceError extends Error {}

function matches(pattern, value) {
  return (
    typeof value === 'string' && value === value.trim() && pattern.test(value)
  );
}

function runIdentity(run) {
  const { mode, target, id, commit, tree, seal } = run ?? {};
  const validTarget =
    (mode === 'fixture' && target === 'local-fixture') ||
    (mode === 'linux' && matches(/^i-[a-f0-9]{17}$/, target));
  if (
    !validTarget ||
    !matches(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, id) ||
    !matches(/^[a-f0-9]{40}$/, commit) ||
    !matches(/^[a-f0-9]{40}$/, tree) ||
    !matches(/^sha256:[a-f0-9]{64}$/, seal)
  ) {
    throw new EvidenceError('运行身份无效');
  }
  return JSON.stringify([mode, target, id, commit, tree, seal]);
}

async function verifyArtifact(directory, step, artifact) {
  const { file, sha256 } = artifact ?? {};
  if (
    !matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, file) ||
    !matches(/^[a-f0-9]{64}$/, sha256)
  ) {
    throw new EvidenceError(`${step} 的原件文件名或摘要无效`);
  }
  try {
    const handle = await open(
      join(directory, file),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size === 0) throw new Error();
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk);
      }
      if (hash.digest('hex') !== sha256) throw new Error();
    } finally {
      await handle.close();
    }
  } catch {
    throw new EvidenceError(`${step} 的原件缺失、不可读或摘要不符`);
  }
  return file;
}

async function summarize(indexFile) {
  const packet = JSON.parse(await readFile(indexFile, 'utf8'));
  if (packet?.version !== 1 || !Array.isArray(packet.records)) {
    throw new EvidenceError('未知索引版本或缺少阶段记录');
  }
  const { run } = packet;
  const identity = runIdentity(run);
  const records = new Map();
  for (const record of packet.records) {
    if (!stages.has(record?.step) || records.has(record.step)) {
      throw new EvidenceError('阶段未知或重复');
    }
    if (runIdentity(record.run) !== identity) {
      throw new EvidenceError(`${record.step} 的运行身份与索引不符`);
    }
    records.set(record.step, record);
  }

  const rows = [];
  let priorPassed = true;
  let failed = false;
  for (const [step, title] of stages) {
    const record = records.get(step);
    let status = '待验';
    let detail = '未提交原件';
    if (record?.result === 'pass' || record?.result === 'fail') {
      const file = await verifyArtifact(
        dirname(indexFile),
        step,
        record.artifact,
      );
      failed ||= record.result === 'fail';
      status = record.result === 'fail' ? '失败' : '已记录';
      detail = `\`${file}\``;
      if (record.result === 'pass' && !priorPassed) {
        failed = true;
        status = '顺序异常';
      }
    } else if (record) {
      if (record.result !== 'skip' || !skipReasons.has(record.reason)) {
        throw new EvidenceError(`${step} 的状态或跳过原因无效`);
      }
      status = '跳过';
      detail = skipReasons.get(record.reason);
    }
    priorPassed &&= record?.result === 'pass';
    rows.push(`| ${title} | ${status} | ${detail} |`);
  }

  const fixture = run.mode === 'fixture';
  const state = failed
    ? '记录有失败或顺序异常'
    : fixture
      ? '仅模拟'
      : priorPassed
        ? '证据齐全，待实机验收复核'
        : '证据未齐';
  return {
    exitCode: failed ? 1 : fixture || !priorPassed ? 2 : 0,
    markdown: [
      '# Linux 首日验收证据',
      '',
      `结论：${state}。工具核对运行身份、原件摘要和步骤顺序。`,
      `运行 \`${run.id}\`，目标 \`${run.target}\`。`,
      `提交 \`${run.commit}\`，tree \`${run.tree}\`，封签 \`${run.seal}\`。`,
      '',
      '| 步骤 | 状态 | 原件或原因 |',
      '| --- | --- | --- |',
      ...rows,
      '',
    ].join('\n'),
  };
}

async function main(args) {
  if (args.length !== 1) {
    throw new EvidenceError('用法：node first-day-evidence.mjs INDEX.json');
  }
  const report = await summarize(resolve(args[0]));
  process.stdout.write(report.markdown);
  process.exitCode = report.exitCode;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      error instanceof EvidenceError
        ? error.message
        : '证据索引不可读或格式无效',
    );
    process.exitCode = 1;
  });
}
