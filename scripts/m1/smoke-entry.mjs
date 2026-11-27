// Observe the production page's own cold entry requests, without issuing a second warmup.
const ENTRY = '/chatflow/4.0';
const DOCUMENT = ENTRY + '/document';
const PROFILE = '/api/v1/d-entry/profile';
const RELEASED_PROFILE_ASSETS = '/_next/static/dsh-profile/';
const PREWARM = '/api/v1/d-entry/native-prewarm';
const SESSIONS = '/api/v1/sessions';
const RPC = '/api/v1/d-entry/native-rpc';
const LOGIN = '/api/v1/auth/login';
const FRAME = 'iframe[title="员工工作区"]';
const EDITOR = '[role="textbox"][data-composer-input]';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export class SmokeSkip extends Error {}
export class SmokeFailure extends Error {}

function requireFact(condition, reason) {
  if (!condition) throw new SmokeFailure(reason);
}

function sameEmployee(query, selection) {
  return (
    query.get('workspaceId') === selection.workspaceId &&
    query.get('employeeInstanceId') === selection.employeeInstanceId
  );
}

export async function smokeNativeEntry(
  page,
  base,
  credentials,
  receipt,
  { hello = false, timeout = 360_000, missingVmHost = false } = {},
) {
  const origin = new URL(base).origin;
  const fact = receipt.stages;
  const resources = new Map();
  const bootstraps = [];
  let selection;
  let ticket;
  let openedThread;
  let ready = false;
  let warm = false;
  let allowedPrompt;
  let sentPrompt;
  let observation = Promise.resolve();
  let outcome;
  const stopped = new Promise((_, reject) => {
    outcome = reject;
  });
  // Expected prerequisites and network failures race browser waits.
  void stopped.catch(() => {});
  const guarded = (action) => Promise.race([action, stopped]);
  const consume = async (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin) return;
    const method = response.request().method();
    const status = response.status();
    if (url.pathname === LOGIN && method === 'POST') {
      requireFact(status === 200, '登录未成功');
      fact.login = status;
    } else if (url.pathname === PREWARM && method === 'POST') {
      const request = response.request().postDataJSON();
      if (request?.trigger !== 'page') return;
      fact.employee = 'existing';
      fact.prewarm = status;
      requireFact(!selection, '观察到重复的页面预热');
      selection = request.selection;
      requireFact(
        UUID.test(selection?.workspaceId ?? '') &&
          UUID.test(selection?.employeeInstanceId ?? ''),
        '员工选择无效',
      );
      if (status === 204) {
        warm = true;
        return;
      }
      if (status === 503 && missingVmHost)
        throw new SmokeSkip('当前 Worker 发布未配置真实 VM 宿主');
      requireFact(status === 202, '预热未返回 202');
      ticket = (await response.json()).operationId;
      requireFact(UUID.test(ticket ?? ''), '预热票据无效');
    } else if (url.pathname === PREWARM + '/status' && method === 'GET') {
      requireFact(
        ticket &&
          url.searchParams.get('operationId') === ticket &&
          sameEmployee(url.searchParams, selection) &&
          (url.searchParams.get('threadId') ?? undefined) ===
            selection.threadId,
        '预热轮询与原票据不一致',
      );
      requireFact(status === 200, '预热状态请求失败');
      const result = await response.json();
      requireFact(
        ['accepted', 'starting', 'ready'].includes(result.state),
        result.code === 'START_UNAVAILABLE'
          ? 'VM 启动未就绪（服务未区分名额不足和启动故障）'
          : '预热未达到 ready',
      );
      (fact.polls ??= []).push(result.state);
      if (result.state === 'ready') ready = true;
    } else if (method === 'POST' && url.pathname === SESSIONS) {
      const requested = response.request().postDataJSON()?.selection;
      requireFact(
        (ready || warm) &&
          !selection.threadId &&
          !openedThread &&
          url.search === '?entry=4.0' &&
          status === 200 &&
          requested?.workspaceId === selection.workspaceId &&
          requested?.employeeInstanceId === selection.employeeInstanceId &&
          requested?.threadId === undefined,
        '未观察到与预热员工一致的原生会话打开请求',
      );
      const opened = await response.json();
      requireFact(
        opened?.workspaceId === selection.workspaceId &&
          opened?.employeeInstanceId === selection.employeeInstanceId &&
          UUID.test(opened?.threadId ?? ''),
        '原生会话打开回执与员工选择不一致',
      );
      openedThread = opened.threadId;
    } else if (method === 'GET' && url.pathname === PROFILE + '/bootstrap') {
      bootstraps.push([url.href, status]);
    } else if (
      method === 'GET' &&
      (url.pathname.startsWith(PROFILE + '/assets/static/') ||
        url.pathname.startsWith(DOCUMENT + '/') ||
        url.pathname.startsWith(RELEASED_PROFILE_ASSETS))
    ) {
      resources.set(url.href, {
        status,
        media: response.headers()['content-type']?.split(';')[0],
      });
    }
  };
  const observe = (response) => {
    observation = observation.then(() => consume(response));
    void observation.catch(outcome);
  };
  const rpcAddress = (url) => url.origin === origin && url.pathname === RPC;
  async function guardPrompt(route) {
    const request = route.request();
    let body;
    if (request.method() === 'POST') {
      try {
        body = request.postDataJSON();
      } catch {
        outcome(new SmokeFailure('原生 RPC 请求无法校验'));
        await route.abort();
        return;
      }
    }
    if (body?.endpoint !== 'session/prompt') {
      await route.continue();
      return;
    }
    const prompt = body.payload?.args?.request;
    const content = prompt?.content;
    if (
      !allowedPrompt ||
      sentPrompt ||
      body.scopeId !== allowedPrompt.scope ||
      !body.selection ||
      body.selection.workspaceId !== selection.workspaceId ||
      body.selection.employeeInstanceId !== selection.employeeInstanceId ||
      body.selection.threadId !== allowedPrompt.thread ||
      new URL(request.url()).search !== '?carrier=page' ||
      typeof body.rpcId !== 'string' ||
      !body.rpcId ||
      prompt?.sessionId !== allowedPrompt.nativeSessionId ||
      !UUID.test(prompt?.requestId ?? '') ||
      prompt.mode !== 'queue' ||
      content?.length !== 1 ||
      content[0]?.type !== 'text' ||
      content[0]?.text !== '你好' ||
      Object.keys(content[0]).length !== 2
    ) {
      outcome(new SmokeFailure('拦截了未经授权或重复的模型消息'));
      await route.abort();
      return;
    }
    sentPrompt = request;
    await route.continue();
  }
  // Keep the guard until the caller closes this dedicated browser page.
  await page.route(rpcAddress, guardPrompt);
  page.on('response', observe);

  try {
    receipt.step = 'login';
    await guarded(
      page.goto(origin + '/login?next=' + encodeURIComponent(ENTRY), {
        waitUntil: 'domcontentloaded',
        timeout,
      }),
    );
    requireFact(
      new URL(page.url()).origin === origin &&
        new URL(page.url()).pathname === '/login',
      '登录页未保持同源',
    );
    await guarded(
      page
        .locator('input[name="username"]')
        .fill(credentials.username, { timeout }),
    );
    await guarded(
      page
        .locator('input[name="password"]')
        .fill(credentials.password, { timeout }),
    );
    await guarded(
      page
        .getByRole('button', { name: '登录', exact: true })
        .click({ timeout }),
    );
    await guarded(
      page.waitForURL(
        (url) => url.origin === origin && url.pathname === ENTRY,
        { timeout },
      ),
    );
    await guarded(observation);
    requireFact(fact.login === 200, '未观察到登录响应');

    receipt.step = 'native-entry';
    const zero = page.getByRole('heading', {
      name: '新建你的第一个员工',
      exact: true,
    });
    const iframe = page.locator(FRAME);
    const target = await guarded(
      Promise.race([
        zero.waitFor({ timeout }).then(() => 'zero'),
        iframe.waitFor({ state: 'visible', timeout }).then(() => 'editor'),
      ]),
    );
    if (target === 'zero') {
      fact.employee = 'zero';
      throw new SmokeSkip('冒烟账号没有可预热的员工');
    }
    const child = page.frameLocator(FRAME);
    const editor = child.locator(EDITOR);
    await guarded(editor.waitFor({ state: 'visible', timeout }));
    await guarded(editor.focus({ timeout }));
    const document = await guarded(
      editor.evaluate(
        (node) => ({
          source: node.ownerDocument.defaultView?.frameElement?.src,
          loaded: node.ownerDocument.URL,
          nativeSessionId:
            node.ownerDocument.querySelector('#app')?.dataset.nativeSessionId,
          publicAssetRoot:
            node.ownerDocument.querySelector('#app')?.dataset.publicAssetRoot,
          assets: [
            ...node.ownerDocument.querySelectorAll(
              '[data-allrice-document-asset]',
            ),
          ].map((asset) => ({
            url: asset.src ?? asset.href,
            kind: asset.getAttribute('data-allrice-document-asset'),
          })),
          editable:
            node.isContentEditable &&
            node.getAttribute('aria-disabled') !== 'true',
          focused: node.ownerDocument.activeElement === node,
        }),
        undefined,
        { timeout },
      ),
    );
    await guarded(observation);
    requireFact(ready || warm, '未观察到原票据轮询至 ready');
    const source = new URL(document.source);
    const loaded = new URL(document.loaded);
    const scope = source.searchParams.get('scopeId');
    const thread = source.searchParams.get('threadId');
    const path = loaded.pathname.slice(DOCUMENT.length + 1).split('/');
    const [, workspace, employee, publishedThread, binding, graph, manifest] =
      path;
    requireFact(
      source.origin === origin &&
        source.pathname === DOCUMENT &&
        sameEmployee(source.searchParams, selection) &&
        (selection.threadId ?? openedThread) === thread &&
        UUID.test(scope ?? '') &&
        UUID.test(thread ?? '') &&
        loaded.origin === origin &&
        loaded.pathname.startsWith(DOCUMENT + '/') &&
        path[0] === scope &&
        workspace === selection.workspaceId &&
        employee === selection.employeeInstanceId &&
        publishedThread === thread &&
        /^[a-zA-Z0-9_-]{1,160}$/.test(binding ?? '') &&
        /^[a-zA-Z0-9_-]{1,160}$/.test(graph ?? '') &&
        /^[a-f0-9]{64}$/.test(manifest ?? '') &&
        path.slice(7).join('/') === 'native/index.html' &&
        resources.get(loaded.href)?.status === 200,
      '编辑器不属于本次原生工作台',
    );
    const bootstrap = bootstraps.filter(([address]) => {
      const url = new URL(address);
      return (
        url.searchParams.get('scopeId') === scope &&
        url.searchParams.get('threadId') === thread &&
        sameEmployee(url.searchParams, selection)
      );
    });
    requireFact(
      bootstrap.length === 1 && bootstrap[0][1] === 200,
      '原生 bootstrap 未返回 200',
    );
    fact.bootstrap = 200;
    const managed =
      origin +
      PROFILE +
      '/assets/static/' +
      path.slice(0, 7).join('/') +
      '/managed/';
    const publishedRoot = RELEASED_PROFILE_ASSETS + manifest + '/';
    requireFact(
      document.publicAssetRoot === undefined ||
        document.publicAssetRoot === publishedRoot,
      '原生静态资源目录与发布清单不一致',
    );
    const publicRoot = document.publicAssetRoot && origin + publishedRoot;
    const nativeRoots = [new URL('assets/', loaded).href];
    if (publicRoot) nativeRoots.push(publicRoot + 'native/assets/');
    const managedAsset = (name) => (url) =>
      url === managed + name ||
      (publicRoot !== undefined && url === publicRoot + 'managed/' + name);
    const nativeStyle = (prefix) => (url) =>
      nativeRoots.some((root) => {
        const start = root + prefix + '-';
        return (
          url.startsWith(start) &&
          /^[a-zA-Z0-9_-]+\.css$/.test(url.slice(start.length))
        );
      });
    for (const [key, mime, expected, kind] of [
      [
        'javascript',
        /^(?:text|application)\/javascript$/,
        [managedAsset('employee-web-entry.js')],
        'entry',
      ],
      [
        'css',
        /^text\/css$/,
        [
          nativeStyle('index'),
          nativeStyle('vendor'),
          managedAsset('employee-web-entry.css'),
        ],
        'style',
      ],
    ]) {
      requireFact(
        expected.every((matcher) => {
          const [asset, duplicate] = document.assets.filter(
            (asset) => asset.kind === kind && matcher(asset.url),
          );
          const result = asset && resources.get(asset.url);
          return (
            !duplicate && result?.status === 200 && mime.test(result.media)
          );
        }),
        '原生 ' + key + ' 未返回 200',
      );
      fact[key] = expected.map(() => 200);
    }
    requireFact(document.editable && document.focused, '原生编辑器不可输入');
    fact.editor = true;
    if (hello) {
      requireFact(document.nativeSessionId, '原生会话未确认');
      receipt.step = 'optional-hello';
      requireFact(
        !(await guarded(editor.innerText({ timeout }))).trim(),
        '编辑器已有草稿',
      );
      await guarded(page.keyboard.insertText('你好'));
      requireFact(
        (await guarded(editor.innerText({ timeout }))).trim() === '你好',
        '原生编辑器输入未回显',
      );
      allowedPrompt = {
        scope,
        thread,
        nativeSessionId: document.nativeSessionId,
      };
      const [sent] = await guarded(
        Promise.all([
          page.waitForResponse(
            (response) => response.request() === sentPrompt,
            {
              timeout,
            },
          ),
          child
            .getByRole('button', { name: /^(发送消息|Send message)$/u })
            .click({ timeout }),
        ]),
      );
      const reply = await guarded(sent.json());
      requireFact(
        sent.status() === 200 &&
          reply?.type === 'server-response' &&
          reply.rpcId === sentPrompt.postDataJSON().rpcId &&
          reply.result?.ok === true &&
          reply.result.value?.accepted === true,
        '原生问候未获接收回执',
      );
      allowedPrompt = undefined;
      fact.hello = 'accepted';
    }
    if (warm) throw new SmokeSkip('当前 VM 已预热，缺少冷启动 202 证据');
  } finally {
    page.off('response', observe);
  }
}
