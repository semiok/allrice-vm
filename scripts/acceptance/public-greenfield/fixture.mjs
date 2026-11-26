/* global document, FormData, window, WebSocket, URLSearchParams, crypto, setTimeout */
import { randomUUID } from 'node:crypto';
import {
  entry,
  paths,
  peoplePath,
  repo,
  repoId,
  requireFact,
  sameVmBinding,
} from './contracts.mjs';

const json = (value, status = 200, headers) => ({
  status,
  json: value,
  headers,
});
const html = (body) => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  html: `<!doctype html><meta charset="utf-8">${body}`,
});
const client = (run, args) =>
  `<script>(${run.toString()})(${JSON.stringify(args)})</script>`;
const go = (path) =>
  html(`<script>window.location.replace(${JSON.stringify(path)})</script>`);

export function fixtureDriver(publicHttp, issueCarrier) {
  return {
    // All requests are fulfilled in Playwright. Chromium also has DNS and
    // proxy access disabled if something escapes interception.
    chromiumArgs: [
      '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
    async install(context, { inspect, openCarrier, fail }) {
      await context.route('**/*', async (route) => {
        try {
          const request = route.request();
          const method = request.method();
          const observed = {
            url: new URL(request.url()),
            method,
            body: method === 'POST' ? request.postDataJSON() : undefined,
            organization: await request.headerValue(
              'x-allrice-organization-id',
            ),
            workspace: await request.headerValue('x-allrice-workspace-id'),
          };
          const reply = await inspect(observed, () => publicHttp(observed));
          await route.fulfill({
            status: reply.status,
            headers: reply.headers,
            ...(reply.json !== undefined
              ? { json: reply.json }
              : { body: reply.html }),
          });
        } catch (error) {
          fail(error);
          await route.abort('blockedbyclient').catch(() => {});
        }
      });
      await context.routeWebSocket('**/*', (socket) => {
        // This is the in-process end of the synthetic WebSocket. It never
        // calls connectToServer, including for an unexpected endpoint.
        socket.onMessage((message) => {
          try {
            requireFact(
              typeof message === 'string',
              'fixture-websocket-blocked',
            );
            const reply = openCarrier(
              new URL(socket.url()),
              JSON.parse(message),
              issueCarrier,
            );
            socket.send(JSON.stringify(reply));
          } catch (error) {
            fail(error);
            void socket.close().catch(() => {});
          }
        });
      });
    },
  };
}

function login(endpoint) {
  document.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const body = JSON.stringify(
      Object.fromEntries(new FormData(event.currentTarget)),
    );
    const reply = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (reply.ok) window.location.assign((await reply.json()).homePath);
  };
}

function createEmployee({ endpoint, entry, organizationId, workspaceId }) {
  const dialog = document.querySelector('dialog');
  document.querySelector('main button').onclick = () => dialog.showModal();
  dialog.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    const name = dialog.querySelector('[data-employee-name]').value;
    const reply = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-allrice-organization-id': organizationId,
        'x-allrice-workspace-id': workspaceId,
      },
      body: JSON.stringify({
        workspaceId,
        requestId: crypto.randomUUID(),
        profile: { name },
      }),
    });
    if (!reply.ok) return;
    const { instance } = await reply.json();
    window.location.assign(
      entry +
        '?' +
        new URLSearchParams({ workspaceId, employeeInstanceId: instance.id }),
    );
  };
}

async function openEmployee({ entry, paths, failWith }) {
  const selection = Object.fromEntries(
    new URLSearchParams(window.location.search),
  );
  const post = (path, payload) =>
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  if (failWith === 'unexpected-write') {
    await post('/api/v1/d-entry/native-rpc?carrier=page', {
      endpoint: 'session/prompt',
    });
    return;
  }
  const start = await post(paths.prewarm, { selection, trigger: 'page' });
  if (start.status === 202) {
    const { operationId, pollAfterMs } = await start.json();
    const query = new URLSearchParams({ ...selection, operationId });
    let delay = pollAfterMs;
    for (let attempt = 0; ; attempt++) {
      if (attempt === 0 || failWith !== 'fast-next-poll')
        await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(3000, delay + 1000);
      const poll = await fetch(paths.poll + '?' + query);
      if (!poll.ok) return;
      const { state } = await poll.json();
      if (state === 'failed') return;
      if (state === 'ready') break;
    }
  } else if (start.status !== 204) return;
  if (!selection.threadId) {
    const opened = await post(paths.thread + '?entry=4.0', { selection });
    if (!opened.ok) return;
    selection.threadId = (await opened.json()).threadId;
  }
  const query = new URLSearchParams(selection);
  const checked = await fetch(paths.identity + '?' + query);
  if (!checked.ok) return;
  const { identity } = await checked.json();
  const mux = new URL(paths.mux, window.location.href);
  mux.protocol = 'wss:';
  mux.search = new URLSearchParams({
    carrier: 'page',
    organizationId: identity.organizationId,
    ...selection,
  });
  const { scopeId } = await new Promise((resolve) => {
    const socket = new WebSocket(mux);
    const streamId = crypto.randomUUID();
    socket.addEventListener(
      'open',
      () =>
        socket.send(
          JSON.stringify({
            type: 'open',
            streamId,
            endpoint: '$d-entry/page',
            payload: { args: {} },
          }),
        ),
      { once: true },
    );
    socket.addEventListener(
      'message',
      (event) => {
        const frame = JSON.parse(event.data);
        if (
          frame.streamId === streamId &&
          frame.type === 'item' &&
          frame.value.type === 'opened'
        )
          resolve(frame.value.scopeReference);
      },
      { once: true },
    );
  });
  window.history.replaceState(null, '', entry + '?' + query);
  const frame = document.createElement('iframe');
  frame.title = '员工工作区';
  query.set('scopeId', scopeId);
  frame.src = entry + '/document?' + query;
  document.body.append(frame);
}

export function makeFixture(failWith, { failCleanup = false } = {}) {
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const workspaceId = '22222222-2222-4222-8222-222222222222';
  const personId = '33333333-3333-4333-8333-333333333333';
  const employeeInstanceId = '44444444-4444-4444-8444-444444444444';
  const threadId = '55555555-5555-4555-8555-555555555555';
  const operationId = '66666666-6666-4666-8666-666666666666';
  const vmId = '77777777-7777-4777-8777-777777777777';
  const instanceId = randomUUID();
  const employeeVersionId = randomUUID();
  const employeeSource = { kind: 'tenant_version', employeeVersionId };
  const employeeRevision = 1;
  const account = {
    username: 'qa-greenfield-fixture',
    password: 'synthetic-fixture-only',
  };
  const release = { sha: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const bootId = { web: randomUUID(), worker: randomUUID() };
  const scope = { organizationId, workspaceId, personId };
  let policy = {
    revision: 'synthetic-old-revision',
    defaultGeneration: '3.x',
    selections: [
      { organizationId, personId: '88888888-8888-4888-8888-888888888888' },
    ],
  };
  let registered = false;
  let employee = false;
  let authenticated = false;
  let vm;
  let polls = 0;
  let openedScope;
  const bindingRef = 'fixture-binding';
  const nativeDocument = (scopeId) =>
    `${entry}/document/${[
      scopeId,
      workspaceId,
      employeeInstanceId,
      threadId,
      bindingRef,
      'fixture-graph',
      'c'.repeat(64),
      'native/index.html',
    ].join('/')}`;

  return {
    account,
    organizationId,
    workspaceId,
    release,
    employeeName: '验收员工',
    timeout: 15_000,
    health(service) {
      return {
        status: 200,
        body: {
          status: 'ready',
          identity: {
            repository: repo,
            repositoryId: repoId,
            service,
            environment: 'dev',
            mode: 'production',
            sourceSha: release.sha,
            sourceTree: release.tree,
            bootId: bootId[service],
          },
        },
      };
    },
    // In-process ADMIN HTTP fixture. No cookie, API request, resolver or lock
    // from the live environment is used. Its state is private to this run.
    adminHttp(method, path, body) {
      if (
        path === peoplePath(organizationId) &&
        method === 'POST' &&
        !registered &&
        body?.people?.length === 1 &&
        body.people[0].username === account.username &&
        body.people[0].password === account.password
      ) {
        registered = true;
        return {
          status: 201,
          body: { created: [{ userId: personId, username: account.username }] },
        };
      }
      if (path === paths.policy && method === 'GET')
        return { status: 200, body: policy };
      if (path === paths.policy && method === 'PUT' && registered) {
        policy = { ...body, revision: 'synthetic-new-revision' };
        return { status: 200, body: policy };
      }
      return { status: 403 };
    },
    publicHttp({ url, method }, recordColdStart) {
      if (method === 'GET' && url.pathname === '/') return go('/chatflow');
      if (method === 'GET' && url.pathname === '/chatflow') {
        return go(authenticated ? entry : '/login');
      }
      if (method === 'GET' && url.pathname === '/login')
        return html(`<form>
        <label>账号<input name="username"></label><label>密码<input name="password" type="password"></label>
        <button>登录</button></form>${client(login, paths.login)}`);
      if (method === 'POST' && url.pathname === paths.login && registered) {
        authenticated = true;
        return json({ user: { id: personId }, homePath: '/chatflow' });
      }
      if (
        !authenticated ||
        !policy.selections.some((value) => value.personId === personId)
      )
        return json({}, 403);
      if (method === 'GET' && url.pathname === entry && !employee)
        return html(`<main>
        <h1>新建你的第一个员工</h1><button type="button">创建员工</button></main>
        <dialog aria-label="创建 AI 员工"><form><input data-employee-name required><button>确认创建</button></form></dialog>
        ${client(createEmployee, { endpoint: paths.employee, entry, organizationId, workspaceId })}`);
      if (method === 'POST' && url.pathname === paths.employee && !employee) {
        employee = true;
        const timestamp = new Date().toISOString();
        return json(
          {
            instance: {
              organizationId,
              workspaceId,
              ownerId: personId,
              id: employeeInstanceId,
              assignmentId: employeeInstanceId,
              kind: 'custom',
              revision: employeeRevision,
              profile: { name: '验收员工' },
              source: employeeSource,
              creationSource: employeeSource,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          },
          201,
        );
      }
      if (method === 'GET' && url.pathname === entry && employee) {
        return html(
          `<h1>正在启动工作台</h1>${client(openEmployee, { entry, paths, failWith })}`,
        );
      }
      if (method === 'POST' && url.pathname === paths.prewarm) {
        if (vm) return { status: 204 };
        if (
          failWith === 'startup-pending' ||
          failWith === 'startup-unallocated'
        ) {
          recordColdStart({
            state: failWith === 'startup-pending' ? 'pending' : 'unallocated',
          });
          return { status: 503 };
        }
        vm = {
          vmId,
          instanceId,
          personId,
          organizationId,
          leaseEpoch: 1,
          diskRetained: true,
        };
        if (failWith === 'startup-unknown') return { status: 503 };
        recordColdStart({ state: 'allocated', binding: vm });
        return json(
          {
            operationId,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            pollAfterMs: 1000,
          },
          202,
        );
      }
      if (method === 'GET' && url.pathname === paths.poll) {
        if (++polls === 1) return json({ state: 'starting' });
        return failWith === 'expired'
          ? json({ state: 'expired' }, 410)
          : json({ state: 'ready' });
      }
      if (method === 'POST' && url.pathname === paths.thread)
        return json({ workspaceId, employeeInstanceId, threadId });
      if (method === 'GET' && url.pathname === paths.identity) {
        return json({
          identity: {
            ...scope,
            employeeInstanceId,
            threadId,
            employeeRevision:
              failWith === 'missing-employee-revision'
                ? undefined
                : employeeRevision,
            employeeVersionId:
              failWith === 'wrong-employee-version'
                ? randomUUID()
                : employeeVersionId,
          },
        });
      }
      if (method === 'GET' && url.pathname === entry + '/document')
        return go(nativeDocument(openedScope));
      if (
        method === 'GET' &&
        openedScope &&
        url.pathname === nativeDocument(openedScope)
      ) {
        const replaced =
          failWith === 'replaced-document'
            ? nativeDocument(randomUUID())
            : undefined;
        return html(
          `<script>globalThis.__ALLRICE_EMPLOYEE_DOCUMENT__ = { scopeId: ${JSON.stringify(openedScope)} };
          ${replaced ? `window.history.replaceState(null, '', ${JSON.stringify(replaced)});` : ''}</script>
          <div role="textbox" aria-multiline="true" data-composer-input contenteditable="${failWith !== 'locked-editor'}" tabindex="0" style="min-height: 1rem"></div>`,
        );
      }
      return { status: 404 };
    },
    openCarrier({ streamId }) {
      openedScope = randomUUID();
      return {
        type: 'item',
        streamId,
        value: {
          type: 'opened',
          scopeReference: { scopeId: openedScope },
          bindingRef,
        },
      };
    },
    exactVm(scopeToStop) {
      if (!vm) return null;
      requireFact(
        scopeToStop.personId === vm.personId &&
          scopeToStop.organizationId === vm.organizationId,
        'cleanup-scope',
      );
      return { ...vm };
    },
    stopExact(binding) {
      requireFact(
        !failCleanup && sameVmBinding(binding, vm),
        'cleanup-unconfirmed',
      );
      const receipt = { ...vm, state: 'stopped', accountRetained: registered };
      vm = undefined;
      return receipt;
    },
  };
}
