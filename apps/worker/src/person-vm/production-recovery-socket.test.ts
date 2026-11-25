import { stat } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname } from 'node:path';
import { expect, it, vi } from 'vitest';
import { modelBinding } from '../../../../packages/model-gateway/src/gateway.fixture.js';
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
