import { stat } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname } from 'node:path';
import { PersonVmError } from '@allrice/person-vm';
import { expect, it, vi } from 'vitest';
import {
  deferred,
  modelBinding,
} from '../../../../packages/model-gateway/src/gateway.fixture.js';
import { openProductionRecoverySocket } from './production-recovery-socket.js';

it('keeps the exact maintenance owner reachable over a private Unix socket until authorized completion', async () => {
  let pending = true;
  const context = modelBinding().context;
  const authenticate = vi.fn(async (token: string) =>
    token === 'synthetic-admin' ? context : null,
  );
  const recover = vi.fn(async () => {
    pending = false;
    return 2;
  });
  const socket = await openProductionRecoverySocket({
    authenticate,
    recover,
    pending: () => pending,
  });
  function post(token: string, headers = {}) {
    return new Promise<{ status?: number; text: string }>((resolve, reject) => {
      const req = request(
        {
          socketPath: socket.path,
          path: '/recover',
          method: 'POST',
          headers: { authorization: 'Bearer ' + token, ...headers },
        },
        (response) => {
          response.setEncoding('utf8');
          let text = '';
          response.on('data', (chunk: string) => {
            text += chunk;
          });
          response.on('end', () =>
            resolve({ status: response.statusCode, text }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
  try {
    expect((await stat(dirname(socket.path))).mode & 0o777).toBe(0o700);
    expect(
      (await post('synthetic-admin', { origin: 'http://browser.invalid' }))
        .status,
    ).toBe(404);
    expect((await post('synthetic-anonymous')).status).toBe(401);
    expect(recover).not.toHaveBeenCalled();
    expect(await post('synthetic-admin')).toEqual({
      status: 200,
      text: '{"released":2}',
    });
    expect(recover).toHaveBeenCalledOnce();
    expect(recover.mock.calls).toHaveLength(1);
  } finally {
    await socket.close();
  }
  await expect(stat(dirname(socket.path))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('reports the current stop attempt only to an authorized local operator', async () => {
  const context = modelBinding().context;
  const recover = vi.fn(async () => 0);
  const authenticate = vi.fn(async () => context);
  const authenticateOperator = vi.fn(async (token: string) =>
    token === 'synthetic-platform-session' ? context : null,
  );
  const authorize = vi.fn(async () => undefined);
  const status = {
    bootId: 'worker-boot',
    pid: 123,
    attemptId: 'requested-stop',
    state: 'deferred',
    reason: 'VM_ACTIVE',
  } as const;
  const socket = await openProductionRecoverySocket({
    authenticate,
    recover,
    pending: () => true,
    shutdown: {
      authenticate: authenticateOperator,
      authorize,
      status: () => status,
    },
  });
  function read(token: string, origin?: string) {
    return new Promise<{ code?: number; body: string; cache?: string }>(
      (resolve, reject) => {
        const req = request(
          {
            socketPath: socket.path,
            path: '/shutdown-status',
            method: 'GET',
            headers: {
              authorization: 'Bearer ' + token,
              ...(origin && { origin }),
            },
          },
          (response) => {
            response.setEncoding('utf8');
            let body = '';
            response.on('data', (chunk: string) => {
              body += chunk;
            });
            response.on('end', () =>
              resolve({
                code: response.statusCode,
                cache: response.headers['cache-control'],
                body,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      },
    );
  }
  try {
    expect(
      (await read('synthetic-platform-session', 'https://browser.invalid'))
        .code,
    ).toBe(404);
    expect((await read('synthetic-employee')).code).toBe(401);
    authorize.mockRejectedValueOnce(Error('platform authority withdrawn'));
    expect((await read('synthetic-platform-session')).code).toBe(403);
    const result = await read('synthetic-platform-session');
    expect(result).toMatchObject({ code: 200, cache: 'no-store' });
    expect(JSON.parse(result.body)).toEqual(status);
    expect(authenticate).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledTimes(2);
  } finally {
    await socket.close();
  }
  await expect(stat(dirname(socket.path))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('joins authentication for a disconnected client before releasing the maintenance socket', async () => {
  const entered = deferred();
  const release = deferred();
  const recover = vi.fn(async () => 0);
  const socket = await openProductionRecoverySocket({
    async authenticate() {
      entered.resolve();
      await release.promise;
      return null;
    },
    recover,
    pending: () => true,
  });
  const client = request({
    socketPath: socket.path,
    path: '/recover',
    method: 'POST',
    headers: { authorization: 'Bearer synthetic-session' },
  });
  const disconnected = deferred();
  client.once('error', () => {});
  client.once('close', disconnected.resolve);
  client.end();
  let settled = false;
  try {
    await entered.promise;
    client.destroy();
    await disconnected.promise;
    const closing = socket.close().then(() => {
      settled = true;
    });
    // The kernel can close the client connection while its authority work
    // is behind the barrier. Verify the socket owner is still alive.
    await stat(dirname(socket.path));
    expect(settled).toBe(false);
    release.resolve();
    await closing;
    expect(recover).not.toHaveBeenCalled();
  } finally {
    client.destroy();
    release.resolve();
    await socket.close();
  }
});

it('only drains through the private socket for the authenticated and exact Worker boot', async () => {
  const context = modelBinding().context;
  const expiresAt = '2099-01-01T00:00:00.000Z';
  const drain = vi.fn(async () => ({ stopped: 2, expiresAt }));
  const afterClaim = deferred();
  let drained = false;
  drain.mockImplementation(async () => {
    drained = true;
    return { stopped: 2, expiresAt };
  });
  const claimShutdown = vi.fn(async (_context, expected: string) => {
    if (!drained || expected !== expiresAt)
      throw new PersonVmError('RUNTIME_NOT_READY');
    return afterClaim.resolve;
  });
  const socket = await openProductionRecoverySocket({
    authenticate: async () => null,
    recover: async () => 0,
    pending: () => true,
    upgrade: {
      bootId: 'worker-upgrade-boot',
      authenticate: async (token) =>
        token === 'operator-session' ? context : null,
      drain,
      claimShutdown,
    },
  });
  function post(token: string, boot: string, claim?: string) {
    return new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          socketPath: socket.path,
          path: claim ? '/shutdown-after-drain' : '/drain-for-upgrade',
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + token,
            'x-allrice-worker-boot': boot,
            ...(claim && { 'x-allrice-drain-expires': claim }),
          },
        },
        (res) => {
          res.setEncoding('utf8');
          let body = '';
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
  try {
    expect(
      (await post('operator-session', 'worker-upgrade-boot', expiresAt)).status,
    ).toBe(409);
    expect(
      (await post('operator-session', 'wrong-boot', expiresAt)).status,
    ).toBe(409);

    expect((await post('employee-session', 'worker-upgrade-boot')).status).toBe(
      401,
    );
    expect((await post('operator-session', 'previous-boot')).status).toBe(409);
    expect(drain).not.toHaveBeenCalled();
    expect(await post('operator-session', 'worker-upgrade-boot')).toEqual({
      status: 200,
      body: JSON.stringify({
        stopped: 2,
        expiresAt,
        bootId: 'worker-upgrade-boot',
      }),
    });
    expect(drain).toHaveBeenCalledExactlyOnceWith(
      context,
      expect.any(AbortSignal),
    );
    expect(
      (await post('operator-session', 'worker-upgrade-boot', 'invalid')).status,
    ).toBe(409);
    expect(
      (await post('operator-session', 'worker-upgrade-boot', expiresAt)).status,
    ).toBe(202);
    await afterClaim.promise;
  } finally {
    await socket.close();
  }
});

it('keeps the consumed release handoff when the private client disconnects', async () => {
  const context = modelBinding().context;
  const entered = deferred<AbortSignal>();
  const release = deferred();
  const completed = deferred();
  const retire = vi.fn(completed.resolve);
  const socket = await openProductionRecoverySocket({
    authenticate: async () => null,
    recover: async () => 0,
    pending: () => true,
    upgrade: {
      bootId: 'worker-boot',
      authenticate: async () => context,
      drain: async () => ({ stopped: 0, expiresAt: 'same-receipt' }),
      async claimShutdown(_context, _expiresAt, active) {
        entered.resolve(active);
        await release.promise;
        return retire;
      },
    },
  });
  const client = request({
    socketPath: socket.path,
    method: 'POST',
    path: '/shutdown-after-drain',
    headers: {
      authorization: 'Bearer synthetic',
      'x-allrice-worker-boot': 'worker-boot',
      'x-allrice-drain-expires': 'same-receipt',
    },
  });
  client.on('error', () => {});
  client.end();
  try {
    const active = await entered.promise;
    const disconnected = deferred();
    active.addEventListener('abort', () => disconnected.resolve(), {
      once: true,
    });
    client.destroy();
    await disconnected.promise;
    release.resolve();
    await completed.promise;
    expect(retire).toHaveBeenCalledTimes(1);
  } finally {
    client.destroy();
    release.resolve();
    await socket.close();
  }
});
