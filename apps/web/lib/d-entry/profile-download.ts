export const profileDownloadLimits = {
  idleMs: 30_000,
  totalMs: 120_000,
};

export const sealedProfileBundleFetch = {
  cache: 'force-cache',
  credentials: 'omit',
  redirect: 'error',
} as const;

/** Also serialized into the inline document. Keep its dependencies explicit. */
export async function downloadProfileResource<T>(
  url: URL | string,
  parent: AbortSignal,
  options: Pick<RequestInit, 'credentials' | 'cache' | 'redirect' | 'priority'>,
  limits: { idleMs: number; totalMs: number },
  consume: (body: ReadableStream<Uint8Array>) => Promise<T>,
  timeoutReason: Error = new DOMException(
    'Employee profile download stalled',
    'TimeoutError',
  ),
): Promise<T> {
  parent.throwIfAborted();
  const timeout = new AbortController();
  const signal = AbortSignal.any([parent, timeout.signal]);
  const expire = () => timeout.abort(timeoutReason);
  let idle = setTimeout(expire, limits.idleMs);
  const total = setTimeout(expire, limits.totalMs);
  try {
    const response = await fetch(url, { ...options, signal });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw Error('Employee profile resource unavailable');
    }
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, output) {
          if (chunk.byteLength) {
            clearTimeout(idle);
            idle = setTimeout(expire, limits.idleMs);
          }
          output.enqueue(chunk);
        },
      }),
      { signal },
    );
    const result = await consume(body);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
}
