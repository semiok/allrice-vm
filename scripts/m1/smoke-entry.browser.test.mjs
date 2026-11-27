// Synthetic local service; exercises the release smoke runner in real Chromium.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmokeSkip, smokeNativeEntry } from './smoke-entry.mjs';

const require = createRequire(
  new URL('../../apps/web/package.json', import.meta.url),
);
const { chromium } = require('playwright-core');
const entry = '/chatflow/4.0';
const documentPath = entry + '/document';
const profile = '/api/v1/d-entry/profile';
const prewarm = '/api/v1/d-entry/native-prewarm';
const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const selection = { workspaceId: id(1), employeeInstanceId: id(2) };
const scopeId = id(3);
const operationId = id(4);
const query = new URLSearchParams({ ...selection, scopeId, threadId: id(5) });
const publication = [
  scopeId,
  selection.workspaceId,
  selection.employeeInstanceId,
  id(5),
  'binding',
  'graph',
  'a'.repeat(64),
].join('/');
const directory = documentPath + '/' + publication;
const staticPath = profile + '/assets/static/' + publication;
const json = (value) => JSON.stringify(value);

async function fixture(mode) {
  const traffic = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://local.test');
    const path = url.pathname;
    const method = request.method;
    traffic.push({ path, method });
    function write(status, body, media = 'text/html; charset=utf-8') {
      response.writeHead(status, { 'Content-Type': media });
      response.end(body);
    }
    function redirect(location) {
      response.writeHead(307, { Location: location });
      response.end();
    }
    if (path === '/login')
      return write(
        200,
        `<form>
      <input name="username"><input name="password" type="password">
      <button>登录</button>
      </form><script>
      document.forms[0].onsubmit = async (event) => {
        event.preventDefault();
        const result = await fetch('/api/v1/auth/login', {method:'POST'});
        if (result.ok) location.assign(${json(entry)});
      };
      </script>`,
      );
    if (path === '/api/v1/auth/login' && method === 'POST')
      return write(200, '{}', 'application/json');
    if (path === entry) {
      if (mode === 'zero') return write(200, '<h1>新建你的第一个员工</h1>');
      return write(
        200,
        `<main></main><script type="module">
        const initial = await fetch(${json(prewarm)}, {
          method:'POST', body: JSON.stringify({trigger:'page', selection:${json(selection)}}),
          headers:{'Content-Type':'application/json'}
        });
        let ready = initial.status === 204;
        if (initial.status === 202) {
          const {operationId} = await initial.json();
          const url = ${json(prewarm + '/status?')} + new URLSearchParams({...${json(selection)}, operationId});
          await (await fetch(url)).json();
          const result = await (await fetch(url)).json();
          ready = result.state === 'ready';
        }
        if (ready) {
            const frame = document.createElement('iframe');
            frame.title = '员工工作区'; frame.src = ${json(documentPath + '?' + query)};
            document.querySelector('main').append(frame);
        }
      </script>`,
      );
    }
    if (path === prewarm) {
      if (mode.startsWith('warm')) return write(204, '');
      if (mode === 'failure' || mode === 'no-vm-host')
        return write(503, '{}', 'application/json');
      return write(202, json({ operationId }), 'application/json');
    }
    if (path === prewarm + '/status') {
      const state =
        traffic.filter((event) => event.path === path).length === 1
          ? 'starting'
          : 'ready';
      return write(200, json({ state }), 'application/json');
    }
    if (path === documentPath)
      return redirect(directory + '/native/index.html');
    if (path === directory + '/native/index.html')
      return write(
        200,
        `
      <link data-allrice-document-asset="style" rel="stylesheet" href="assets/index-aa.css">
      ${mode === 'missing-vendor' ? '' : '<link data-allrice-document-asset="style" rel="stylesheet" href="assets/vendor-bb.css">'}
      <link data-allrice-document-asset="style" rel="stylesheet" href="${mode === 'foreign-css' ? staticPath.replace('/graph/', '/future/') : staticPath}/managed/employee-web-entry.css">
      <script data-allrice-document-asset="entry" src="${staticPath}/managed/employee-web-entry.js"></script>
      <div id="app" data-native-session-id="native-session" hidden><div role="textbox" data-composer-input contenteditable="false" style="min-height:24px" tabindex="0"></div></div><button>发送消息</button>
      <script type="module">
        await fetch(${json(profile + '/bootstrap?' + query)});
        const editor = document.querySelector('[data-composer-input]');
        editor.setAttribute('contenteditable', ${json(mode.endsWith('disabled') ? 'false' : 'true')});
        const send = () => fetch('/api/v1/d-entry/native-rpc?carrier=page', {method:'POST', body: JSON.stringify({
          endpoint: 'session/prompt', scopeId: ${json(scopeId)}, rpcId:'rpc',
          selection: ${json({ ...selection, threadId: id(5) })},
          payload:{args:{request:{sessionId: 'native-session', requestId: ${json(id(6))}, mode:'queue', content:[{type:'text', text:editor.innerText}]}}}
        })});
        document.querySelector('button').onclick = send;
        if (${json(mode === 'unexpected-prompt')}) await send();
        document.querySelector('#app').hidden = false;
      </script>`,
      );
    if (path === staticPath + '/managed/employee-web-entry.js')
      return write(200, '// native JS', 'text/javascript');
    if (path.endsWith('.css'))
      return write(
        mode === 'bad-css' && path.includes('/managed/') ? 503 : 200,
        'div {color:black}',
        'text/css',
      );
    if (path === profile + '/bootstrap')
      return write(200, '{}', 'application/json');
    if (path === '/api/v1/d-entry/native-rpc')
      return write(
        200,
        json({
          type: 'server-response',
          rpcId: 'rpc',
          result: { ok: true, value: { accepted: true } },
        }),
        'application/json',
      );
    write(404, '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    traffic,
    close: () => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    },
  };
}

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('4.0 release smoke', { timeout: 15_000 }, () => {
  let browser;
  beforeAll(async () => {
    const executablePath = process.env.ALLRICE_TEST_CHROME_EXECUTABLE;
    browser = await chromium.launch({
      headless: true,
      ...(executablePath && { executablePath }),
    });
  });
  afterAll(() => browser?.close());

  async function run(mode, assertion, hello = false) {
    const local = await fixture(mode);
    const page = await browser.newPage();
    const receipt = { stages: {} };
    try {
      const smoke = smokeNativeEntry(
        page,
        local.origin,
        { username: 'smoke', password: 'fake' },
        receipt,
        { hello, timeout: 5000, missingVmHost: mode === 'no-vm-host' },
      );
      await assertion(
        smoke.catch((error) => {
          // Retain the exact local path/step if a browser wait fails.
          if (!(error instanceof SmokeSkip)) {
            error.message += ` (step: ${receipt.step}, requests: ${json(local.traffic)})`;
          }
          throw error;
        }),
        receipt,
        local.traffic,
      );
      expect(local.traffic.every((event) => event.path !== '/chatflow')).toBe(
        true,
      );
    } finally {
      await page.close();
      await local.close();
    }
  }

  it.each([false, true])(
    'observes the complete cold entry with opt-in hello %s',
    async (hello) => {
      await run(
        'cold',
        async (smoke, receipt, traffic) => {
          await smoke;
          expect(receipt.stages).toMatchObject({
            login: 200,
            employee: 'existing',
            prewarm: 202,
            polls: ['starting', 'ready'],
            bootstrap: 200,
            javascript: [200],
            css: [200, 200, 200],
            editor: true,
          });
          expect(
            traffic
              .filter(({ method }) => method === 'POST')
              .map(({ path }) => path),
          ).toEqual([
            '/api/v1/auth/login',
            prewarm,
            ...(hello ? ['/api/v1/d-entry/native-rpc'] : []),
          ]);
          expect(receipt.stages.hello).toBe(hello ? 'accepted' : undefined);
        },
        hello,
      );
    },
  );

  it.each([
    ['zero', '冒烟账号没有可预热的员工'],
    ['no-vm-host', '当前 Worker 发布未配置真实 VM 宿主'],
    ['warm', '当前 VM 已预热，缺少冷启动 202 证据'],
  ])('identifies the %s prerequisite skip', async (mode, reason) => {
    await run(mode, async (smoke, receipt) => {
      const error = await smoke.catch((error) => error);
      expect(error).toBeInstanceOf(SmokeSkip);
      if (mode === 'warm') expect(receipt.stages.editor).toBe(true);
      expect(error.message).toContain(reason);
    });
  });

  it.each([
    ['failure', '预热未返回 202'],
    ['bad-css', '原生 css 未返回 200'],
    ['missing-vendor', '原生 css 未返回 200'],
    ['foreign-css', '原生 css 未返回 200'],
    ['disabled', '原生编辑器不可输入'],
    ['warm-disabled', '原生编辑器不可输入'],
    ['unexpected-prompt', '拦截了未经授权或重复的模型消息'],
  ])('fails %s', async (mode, reason) => {
    await run(mode, async (smoke) => {
      const error = await smoke.catch((error) => error);
      expect(error).not.toBeInstanceOf(SmokeSkip);
      expect(error.message).toContain(reason);
    });
  });
});
