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
const directory = documentPath + '/' + scopeId + '/publication';
const staticPath = profile + '/assets/static/' + scopeId + '/publication';
const json = (value) => JSON.stringify(value);

async function fixture(mode) {
  const traffic = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://local.test');
    const path = url.pathname;
    const method = request.method;
    traffic.push({ path, method });
    function write(status, body, media = 'text/html') {
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
        if (initial.status === 202) {
          const {operationId} = await initial.json();
          const url = ${json(prewarm + '/status?')} + new URLSearchParams({...${json(selection)}, operationId});
          await (await fetch(url)).json();
          const result = await (await fetch(url)).json();
          if (result.state === 'ready') {
            const frame = document.createElement('iframe');
            frame.title = '员工工作区'; frame.src = ${json(documentPath + '?' + query)};
            document.querySelector('main').append(frame);
          }
        }
      </script>`,
      );
    }
    if (path === prewarm) {
      if (mode === 'warm') return write(204, '');
      if (mode === 'failure') return write(503, '{}', 'application/json');
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
      <link data-allrice-document-asset="style" rel="stylesheet" href="assets/theme.css">
      <link data-allrice-document-asset="style" rel="stylesheet" href="${staticPath}/managed/entry.css">
      <script data-allrice-document-asset="entry" src="${staticPath}/managed/entry.js"></script>
      <div role="textbox" data-composer-input contenteditable="false" style="min-height:24px"></div><button>发送消息</button>
      <script type="module">
        await fetch(${json(profile + '/bootstrap?' + query)});
        const editor = document.querySelector('[data-composer-input]');
        editor.setAttribute('contenteditable', ${json(mode === 'disabled' ? 'false' : 'true')});
        document.querySelector('button').onclick = () => {
          fetch('/api/v1/d-entry/native-rpc', {method:'POST', body: JSON.stringify({
            endpoint: 'session/prompt', scopeId: ${json(scopeId)},
            payload:{args:{request:{content:[{type:'text', text:editor.innerText}]}}}
          })});
        };
      </script>`,
      );
    if (path === staticPath + '/managed/entry.js')
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
        json({ result: { ok: true, value: { accepted: true } } }),
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
suite('4.0 release smoke', () => {
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
        { hello, timeout: 5000 },
      );
      await assertion(smoke, receipt, local.traffic);
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
            css: [200, 200],
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
    ['warm', '当前 VM 已预热，缺少冷启动 202 证据'],
  ])('identifies the %s prerequisite skip', async (mode, reason) => {
    await run(mode, async (smoke) => {
      const error = await smoke.catch((error) => error);
      expect(error).toBeInstanceOf(SmokeSkip);
      expect(error.message).toBe(reason);
    });
  });

  it.each([
    ['failure', '预热未返回 202'],
    ['bad-css', '原生 css 未返回 200'],
    ['disabled', '原生编辑器不可输入'],
  ])('fails %s', async (mode, reason) => {
    await run(mode, async (smoke) => {
      const error = await smoke.catch((error) => error);
      expect(error).not.toBeInstanceOf(SmokeSkip);
      expect(error.message).toBe(reason);
    });
  });
});
