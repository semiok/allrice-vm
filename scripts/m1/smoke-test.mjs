#!/usr/bin/env node
import { createRequire } from 'node:module';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SmokeSkip, smokeNativeEntry } from './smoke-entry.mjs';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    'worker-url': { type: 'string' },
    creds: { type: 'string' },
    out: { type: 'string' },
    'expect-sha': { type: 'string' },
    hello: { type: 'boolean' },
    'vm-unavailable': { type: 'string' },
  },
});
if (!args.url || !args['worker-url'] || !args.creds || !args.out) {
  console.error(
    'usage: smoke-test.mjs --url URL --worker-url URL --creds FILE --out DIR [--expect-sha SHA] [--hello] [--vm-unavailable capacity|host]',
  );
  process.exit(2);
}

class SmokeFailure extends Error {}
const sha = /^[a-f0-9]{40}$/;
const declaredLimit =
  args['vm-unavailable'] ?? process.env.ALLRICE_SMOKE_VM_UNAVAILABLE;
const prerequisites = new Map([
  ['capacity', '没有可用的真实 VM 名额'],
  ['host', '真实 VM 宿主未就绪'],
]);
const receipt = {
  at: new Date().toISOString(),
  status: 'failed',
  stages: {},
  step: 'services',
};
await mkdir(args.out, { recursive: true, mode: 0o700 });

async function readySha(base, path) {
  const response = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  const version = result.identity?.sourceSha;
  if (!response.ok || result.status !== 'ready' || !sha.test(version ?? ''))
    throw new SmokeFailure('服务未就绪或缺少发布提交');
  return version;
}

async function versions() {
  const [web, worker] = await Promise.all([
    readySha(args.url, '/api/health/ready'),
    readySha(args['worker-url'], '/health/ready'),
  ]);
  if (web !== worker || (args['expect-sha'] && web !== args['expect-sha']))
    throw new SmokeFailure('Web、Worker 与预期发布提交不一致');
  return { web, worker };
}

async function playwright() {
  const installed = join(homedir(), 'allrice40-dev-releases');
  for (const name of await readdir(installed).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    const require = createRequire(
      join(installed, name, 'apps/web/package.json'),
    );
    let module;
    try {
      module = require.resolve('playwright-core');
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      continue;
    }
    return require(module);
  }
  throw new SmokeSkip('缺少可用的发布浏览器依赖');
}

let browser;
try {
  receipt.versionStart = await versions();
  if (declaredLimit !== undefined) {
    if (!prerequisites.has(declaredLimit))
      throw new SmokeFailure('未知的 VM 前提缺口');
    throw new SmokeSkip(prerequisites.get(declaredLimit));
  }
  receipt.step = 'browser';
  const executablePath =
    process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try {
    await access(executablePath);
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new SmokeSkip('找不到用于原生冒烟的 Chromium');
    throw error;
  }
  const { chromium } = await playwright();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });
  const credentials = JSON.parse(await readFile(args.creds, 'utf8'));
  await smokeNativeEntry(page, args.url, credentials, receipt, {
    hello: args.hello,
  });
  receipt.status = 'passed';
} catch (error) {
  if (error instanceof SmokeSkip) receipt.status = 'skipped';
  // Dry operational evidence must not contain credentials, request bodies or scope URLs.
  receipt.reason =
    error instanceof SmokeSkip ||
    error instanceof SmokeFailure ||
    (error.constructor === Error &&
      /^[\p{Script=Han} 0-9A-Za-z（）]+$/u.test(error.message))
      ? error.message
      : '原生冒烟步骤失败';
} finally {
  if (receipt.versionStart) {
    try {
      receipt.versionEnd = await versions();
      if (receipt.versionStart.web !== receipt.versionEnd.web)
        throw new SmokeFailure('冒烟期间发布提交变化');
    } catch {
      receipt.status = 'failed';
      receipt.reason = '冒烟结束时服务提交未通过复核';
    }
  }
  try {
    await browser?.close();
  } catch {
    receipt.status = 'failed';
    receipt.reason = '冒烟浏览器未正常退出';
  }
  const file = join(args.out, 'result.json');
  await writeFile(file + '.tmp', JSON.stringify(receipt, null, 2) + '\n', {
    mode: 0o600,
  });
  await rename(file + '.tmp', file);
}
console.log(
  receipt.status === 'skipped'
    ? '跳过：' + receipt.reason
    : receipt.status === 'passed'
      ? '4.0 原生冒烟通过'
      : '4.0 原生冒烟失败 [' + receipt.step + ']：' + receipt.reason,
);
process.exitCode =
  receipt.status === 'skipped' ? 77 : receipt.status === 'passed' ? 0 : 1;
