import { renameSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export const name = 'allrice-native-web-owner';
export const inject = [
  'connection',
  'webServer',
  'typertGateway',
  'appReady',
  'loader',
  'clientModules',
  'allricePrincipal',
];
const activeOwners = new WeakMap();
const cordisOriginal = Symbol.for('cordis.original');
const original = (value) => value?.[cordisOriginal] ?? value;

async function waitWhileOwned(signal, subscribe) {
  let stop, unsubscribe;
  const release = () => {
    const cancel = unsubscribe;
    unsubscribe = undefined;
    cancel?.();
  };
  try {
    return await new Promise((resolve, reject) => {
      stop = () => {
        release();
        resolve(false);
      };
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
      unsubscribe = subscribe(() => resolve(true), reject);
    });
  } finally {
    release();
    signal.removeEventListener('abort', stop);
  }
}

/** One credential-free Upgrade on this sealed listener. rc.2 destroys the
 * socket for an absent route and emits this bounded reply from the real mux. */
async function confirmGatewayMux(origin, baseUrl, signal) {
  signal.throwIfAborted();
  const expected = Buffer.from('unauthorized');
  const bytes = Buffer.alloc(expected.length);
  let physicalClose, failure;
  let received = 0;
  let complete = false;
  const agent = new (class extends Agent {
    createConnection(...args) {
      const socket = super.createConnection(...args);
      physicalClose = new Promise((resolve) => socket.once('close', resolve));
      return socket;
    }
  })({ keepAlive: false });
  const invalid = () =>
    Error('Native gateway mux readiness response was invalid');
  try {
    await new Promise((resolve) => {
      const call = request(
        new URL('/api/remote.mux', origin),
        {
          agent,
          signal,
          headers: {
            Host: new URL(baseUrl).host,
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
            'Sec-WebSocket-Version': '13',
          },
        },
        (response) => {
          response.on('error', (error) => (failure ??= error));
          if (
            response.httpVersion !== '1.1' ||
            response.statusCode !== 401 ||
            response.statusMessage !== 'Unauthorized' ||
            response.headers.connection !== 'close' ||
            response.headers['content-type'] !== 'text/plain; charset=utf-8' ||
            response.headers['content-length'] !== String(expected.length)
          ) {
            failure = invalid();
            response.destroy();
            return;
          }
          response.on('data', (chunk) => {
            if (chunk.length > bytes.length - received) {
              failure = invalid();
              response.destroy();
              return;
            }
            chunk.copy(bytes, received);
            received += chunk.length;
          });
          response.once('end', () => {
            complete = received === bytes.length && bytes.equals(expected);
          });
        },
      );
      call.on('error', (error) => (failure ??= error));
      call.once('upgrade', (_response, socket) => {
        failure = invalid();
        socket.destroy();
      });
      call.once('close', resolve);
      call.end();
    });
  } finally {
    agent.destroy();
    await physicalClose;
  }
  if (failure) {
    if (
      signal.aborted &&
      failure.code === 'ABORT_ERR' &&
      failure.cause === signal.reason
    )
      throw signal.reason;
    throw failure;
  }
  signal.throwIfAborted();
  if (!complete) throw invalid();
}

/** An explicit local unloader also receives the actual profile retirement. */
export async function unloadNativeWebOwner(fiber) {
  const retire = activeOwners.get(fiber.dispose);
  if (!retire) throw Error('Native web owner retirement is unavailable');
  const results = await Promise.allSettled([retire(), fiber.dispose()]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, 'Native web owner retirement failed');
}

/** Native local login only. This file never establishes an AllRice principal. */
export function apply(ctx, config) {
  const { artifactPath, nonce, baseUrl } = config;
  const { fiber } = ctx;
  const providers = Object.entries(fiber.store ?? {}).map(
    ([name, provider]) => [name, provider.fiber, original(provider.value)],
  );
  const temporary = `${artifactPath}.${randomUUID()}.tmp`;
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const canceled = Error('Native auth publication canceled');
  let publishing;
  let publicationFailure;
  let published = false;
  let retiring = false;
  const stop = () => {
    retiring = true;
    lifetime.abort(canceled);
  };
  const sameConfig = (value) =>
    value?.artifactPath === artifactPath &&
    value?.nonce === nonce &&
    value?.baseUrl === baseUrl;
  const entry = fiber.entry;
  const current = () =>
    !retiring &&
    fiber.uid !== null &&
    (!entry || sameConfig(entry.options.config)) &&
    providers.every(([name, provider, value]) => {
      const live = ctx.get(name);
      return provider.uid !== null && live != null && original(live) === value;
    });
  const observed = ctx.allricePrincipal.observeProfileGraph(ctx.clientModules, {
    current,
    publish() {
      return (publishing = publish().catch((error) => {
        if (error === canceled) return;
        publicationFailure = { error };
        throw error;
      }));
    },
    async retire() {
      stop();
      await publishing?.catch(() => {});
      try {
        if (published) await rm(artifactPath, { force: true });
      } catch (error) {
        if (publicationFailure)
          throw new AggregateError(
            [publicationFailure.error, error],
            'Native auth cleanup failed',
          );
        throw error;
      }
      if (publicationFailure) throw publicationFailure.error;
    },
  });
  const retire = () => {
    stop();
    return observed.close();
  };
  // Cordis exposes an awaitable facade over the same actual disposer.
  activeOwners.set(fiber.dispose, retire);
  const retireMissingOwner = () => {
    if (!current()) void retire().catch(() => {});
  };
  // Cordis clears the actual uid or injection before its loading effect can
  // reach a disposer. That notification also fences existing scopes now.
  ctx.on('internal/plugin', retireMissingOwner);
  ctx.on('internal/service', retireMissingOwner);
  ctx.on('loader/partial-dispose', (changed) => {
    if (!entry || changed !== entry || sameConfig(entry.options.config)) return;
    void retire().catch(() => {});
  });
  ctx.effect(() => retire, 'allrice native profile and local auth lifetime');
  // Startup and this entry must settle before the launcher can call appReady.
  // The observer owns publication outside the Loader's apply task.
  void observed.ready.catch((error) => {
    if (!current()) return;
    publicationFailure ??= { error };
    void retire().catch(() => {});
  });

  async function publish() {
    if (!(await waitWhileOwned(signal, (ready) => ctx.appReady.onReady(ready))))
      return;
    if (!current()) return;
    // rc.2 dispatches ready listeners synchronously. This continuation runs
    // after dispatch and lets the shared Loader settle its actual entries.
    if (
      !(await waitWhileOwned(signal, (settled, reject) => {
        void ctx.loader.await().then(settled, reject);
      }))
    )
      return;
    if (!current()) return;
    await confirmGatewayMux(ctx.webServer.getOrigin(), baseUrl, signal);
    if (!current()) return;
    await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
    if (!current()) return;
    let primary;
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          v: 1,
          nonce,
          authenticatedUrl: ctx.connection.authenticatedUrl(baseUrl),
        }),
        { flag: 'wx', mode: 0o600 },
      );
      // The last generation check and same-directory publication have one
      // ordering with Cordis disposal, even if staging the nonce took time.
      if (current()) {
        renameSync(temporary, artifactPath);
        published = true;
      }
    } catch (error) {
      primary = { error };
    }
    try {
      await rm(temporary, { force: true });
    } catch (error) {
      if (primary)
        throw new AggregateError(
          [primary.error, error],
          'Native auth staging failed',
        );
      throw error;
    }
    if (primary) throw primary.error;
  }
}
