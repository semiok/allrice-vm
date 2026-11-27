import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { sandboxPublicAddress } from '@allrice/project-runtime';
import {
  EgressError,
  type EgressResponse,
  type EgressTransport,
} from './contract.js';

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
type PublicHttpsHop = EgressResponse | Readonly<{ location: string }>;

function assertPublicHttpsTarget(target: URL) {
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.hash ||
    (target.port && target.port !== '443') ||
    isIP(target.hostname.replace(/^\[|\]$/g, ''))
  )
    throw new EgressError('DENIED');
}

/** A late pre-connect fact is discarded after revocation. The system
 * resolver does not expose a cancellable getaddrinfo handle. */
function beforeAbort<T>(
  signal: AbortSignal,
  start: () => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const done = () => signal.removeEventListener('abort', abort);
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return start();
      })
      .then(
        (value) => {
          done();
          resolve(value);
        },
        (error: unknown) => {
          done();
          reject(error);
        },
      );
  });
}

/** Validate all DNS answers and pin each socket. No proxy or second lookup. */
function createPublicHttpsHopTransport(mode: 'registry' | 'web') {
  return {
    async read(
      url: URL,
      { maxBytes, signal }: { maxBytes: number; signal: AbortSignal },
    ): Promise<PublicHttpsHop> {
      signal.throwIfAborted();
      assertPublicHttpsTarget(url);
      const resolveHost = () =>
        lookup(url.hostname, { all: true, verbatim: true });
      const answers = await (mode === 'web'
        ? beforeAbort(signal, resolveHost)
        : resolveHost());
      signal.throwIfAborted();
      const own = new BlockList();
      for (const item of Object.values(networkInterfaces()).flat()) {
        if (!item) continue;
        const address = item.address.split('%', 1)[0]!;
        const family = isIP(address);
        if (family) own.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
      }
      if (
        !answers.length ||
        answers.some(
          ({ address, family }) =>
            !sandboxPublicAddress(address) ||
            own.check(address, family === 4 ? 'ipv4' : 'ipv6'),
        )
      )
        throw new EgressError('DENIED');
      const address = answers[0]!;
      return new Promise((resolve, reject) => {
        let failure: unknown;
        let result: PublicHttpsHop | undefined;
        let requestClosed = false,
          responseClosed = true;
        const settle = () => {
          if (!requestClosed || !responseClosed) return;
          if (failure) reject(failure);
          else if (result) resolve(result);
          else reject(new EgressError('UNAVAILABLE'));
        };
        const failed = (error: unknown) => {
          failure ??= error;
        };

        const req = request(
          {
            hostname: url.hostname,
            servername: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'GET',
            signal,
            agent: false,
            family: address.family,
            headers: {
              accept:
                mode === 'web'
                  ? 'text/html, text/plain, application/json'
                  : 'application/json, application/octet-stream',
              'accept-encoding': 'identity',
            },
            lookup: (_hostname, _options, callback) =>
              callback(null, address.address, address.family),
          },
          (response) => {
            responseClosed = false;
            response.once('close', () => {
              responseClosed = true;
              settle();
            });
            response.once('error', failed);
            const status = response.statusCode ?? 0;
            if (mode === 'web' && redirectStatuses.has(status)) {
              const location = response.headers.location;
              if (
                typeof location !== 'string' ||
                !location ||
                location.length > 4096
              )
                failed(new EgressError('INVALID_RESPONSE'));
              else result = { location };
              // A recognized redirect discards the body intentionally. Join
              // request and response close before considering the next hop.
              response.destroy();
              return;
            }
            response.once('aborted', () =>
              failed(new EgressError('UNAVAILABLE')),
            );
            if (
              status < 200 ||
              status >= 300 ||
              (response.headers['content-encoding'] &&
                response.headers['content-encoding'] !== 'identity')
            ) {
              failed(new EgressError('INVALID_RESPONSE'));
              response.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > maxBytes) {
                failed(new EgressError('LIMIT_EXCEEDED'));
                response.destroy();
                return;
              }
              chunks.push(chunk);
            });
            response.once('end', () => {
              result = {
                status,
                contentType:
                  response.headers['content-type'] ??
                  'application/octet-stream',
                body: Buffer.concat(chunks),
              };
            });
          },
        );
        req.once('error', failed);
        req.once('close', () => {
          requestClosed = true;
          settle();
        });
        req.end();
      });
    },
  };
}

export function createPublicHttpsTransport(): EgressTransport {
  const transport = createPublicHttpsHopTransport('registry');
  return {
    async read(url, options) {
      const result = await transport.read(url, options);
      if ('location' in result) throw new EgressError('INVALID_RESPONSE');
      return result;
    },
  };
}

/** A host-only transport. Callers supply authority and budgets for every hop. */
export async function fetchPublicHttps(
  input: string,
  options: {
    authorize(target: string, signal: AbortSignal): Promise<void>;
    maxBytes: number;
    maxRedirects: number;
    timeoutMs: number;
    signal: AbortSignal;
  },
): Promise<EgressResponse & Readonly<{ url: string }>> {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0 ||
    !Number.isSafeInteger(options.maxRedirects) ||
    options.maxRedirects < 0 ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 2_147_483_647
  )
    throw new EgressError('POLICY_INVALID');
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs),
  ]);
  function parse(value: string, base?: URL) {
    if (value.length > 4096) throw new EgressError('DENIED');
    const url = URL.parse(value, base);
    if (!url || url.href.length > 4096) throw new EgressError('DENIED');
    assertPublicHttpsTarget(url);
    return url;
  }
  const transport = createPublicHttpsHopTransport('web');
  let url = parse(input);
  for (let hop = 0; ; hop += 1) {
    signal.throwIfAborted();
    const target = url.href;
    await beforeAbort(signal, () => options.authorize(target, signal));
    signal.throwIfAborted();
    const result = await transport.read(url, {
      maxBytes: options.maxBytes,
      signal,
    });
    signal.throwIfAborted();
    if (!('location' in result)) return { ...result, url: url.href };
    if (hop >= options.maxRedirects) throw new EgressError('LIMIT_EXCEEDED');
    url = parse(result.location, url);
  }
}
