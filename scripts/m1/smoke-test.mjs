#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { SmokeFailure, SmokeSkip, smokeNativeEntry } from './smoke-entry.mjs';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    'worker-url': { type: 'string' },
    creds: { type: 'string' },
    out: { type: 'string' },
    'expect-sha': { type: 'string' },
    hello: { type: 'boolean' },
    'worker-release': { type: 'string' },
  },
});
if (
  !args.url ||
  !args['worker-url'] ||
  !args.creds ||
  !args.out ||
  !args['worker-release'] ||
  !isAbsolute(args['worker-release'])
) {
  console.error(
    'usage: smoke-test.mjs --url URL --worker-url URL --creds FILE --out DIR [--expect-sha SHA] [--hello] --worker-release DIR',
  );
  process.exit(2);
}

const sha = /^[a-f0-9]{40}$/;
const receipt = {
  at: new Date().toISOString(),
  status: 'failed',
  stages: {},
  step: 'services',
};
await mkdir(args.out, { recursive: true, mode: 0o700 });

async function readyIdentity(base, path, service) {
  const response = await fetch(new URL(path, base), {
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  const identity = result.identity;
  if (
    !response.ok ||
    result.status !== 'ready' ||
    identity?.repository !== 'semiok/allrice-vm' ||
    String(identity.repositoryId) !== '1469490636' ||
    identity.service !== service ||
    identity.mode !== 'production' ||
    !sha.test(identity.sourceSha ?? '') ||
    !sha.test(identity.sourceTree ?? '') ||
    !/^sha256:[a-f0-9]{64}$/.test(identity.manifestDigest ?? '')
  )
    throw new SmokeFailure('服务未就绪或缺少发布提交');
  return identity;
}

async function versions() {
  const [web, worker] = await Promise.all([
    readyIdentity(args.url, '/api/health/ready', 'web'),
    readyIdentity(args['worker-url'], '/health/ready', 'worker'),
  ]);
  if (
    web.sourceSha !== worker.sourceSha ||
    web.sourceTree !== worker.sourceTree ||
    web.manifestDigest !== worker.manifestDigest ||
    (args['expect-sha'] && web.sourceSha !== args['expect-sha'])
  )
    throw new SmokeFailure('Web、Worker 与预期发布提交不一致');
  return {
    web: web.sourceSha,
    worker: worker.sourceSha,
    manifest: worker.manifestDigest,
  };
}

async function missingVmHost() {
  const root = args['worker-release'];
  const { manifestDigest, ...manifest } = JSON.parse(
    await readFile(join(root, '.local/dev-build-identity.json'), 'utf8'),
  );
  const digest =
    'sha256:' +
    createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  if (
    digest !== manifestDigest ||
    digest !== receipt.versionStart.manifest ||
    manifest.sourceSha !== receipt.versionStart.worker
  )
    throw new SmokeFailure('无法核对 Worker 真实 VM 宿主的发布来源');
  return !manifest.files.some(
    (file) => file.path === '.local/person-vm-host.json',
  );
}

function playwright() {
  const require = createRequire(
    join(args['worker-release'], 'apps/web/package.json'),
  );
  let module;
  try {
    module = require.resolve('playwright-core');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    throw new SmokeSkip('当前发布缺少浏览器依赖');
  }
  return require(module);
}

let browser;
try {
  receipt.versionStart = await versions();

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
  const { chromium } = playwright();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    serviceWorkers: 'block',
  });
  const credentials = JSON.parse(await readFile(args.creds, 'utf8'));
  await smokeNativeEntry(page, args.url, credentials, receipt, {
    hello: args.hello,
    missingVmHost: await missingVmHost(),
  });
  receipt.status = 'passed';
} catch (error) {
  if (error instanceof SmokeSkip) receipt.status = 'skipped';
  // Dry operational evidence must not contain credentials, request bodies or scope URLs.
  receipt.reason =
    error instanceof SmokeSkip || error instanceof SmokeFailure
      ? error.message
      : '原生冒烟步骤失败';
} finally {
  if (receipt.versionStart) {
    try {
      receipt.versionEnd = await versions();
      if (
        receipt.versionStart.web !== receipt.versionEnd.web ||
        receipt.versionStart.manifest !== receipt.versionEnd.manifest
      ) {
        receipt.status = 'failed';
        receipt.reason = '冒烟期间发布提交变化';
      }
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
