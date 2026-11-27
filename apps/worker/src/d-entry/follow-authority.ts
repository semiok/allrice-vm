import type { DEntryAuthorityObservation } from '@allrice/database';

// Match the existing notification connection's query budget. Even if a
// writer's hint was missed, an established stream must renew its evidence.
const continuityIntervalMs = 5000;

export async function openFollowAuthority(
  observation: DEntryAuthorityObservation,
  caller: AbortSignal,
  verify: (signal: AbortSignal) => Promise<void>,
) {
  const stop = new AbortController();
  const signal = AbortSignal.any([caller, stop.signal]);
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;

  function scheduleCheck() {
    if (signal.aborted) return;
    dirty = true;
    if (pending) return;
    if (timer) clearTimeout(timer);
    pending = Promise.resolve()
      .then(async () => {
        do {
          dirty = false;
          signal.throwIfAborted();
          await verify(signal);
          await observation.observeThroughCommit(signal);
          signal.throwIfAborted();
        } while (dirty);
      })
      .catch((error: unknown) => stop.abort(error))
      .finally(() => {
        pending = undefined;
        if (signal.aborted) return;
        if (dirty) scheduleCheck();
        else {
          timer = setTimeout(scheduleCheck, continuityIntervalMs);
          timer.unref();
        }
      });
  }

  const unsubscribe = observation.subscribe(scheduleCheck);
  async function settle() {
    while (pending) await pending;
    signal.throwIfAborted();
  }
  function abort() {
    if (timer) clearTimeout(timer);
    unsubscribe();
  }
  async function close() {
    stop.abort();
    signal.removeEventListener('abort', abort);
    await pending;
  }
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    scheduleCheck();
    await settle();
    return {
      signal,
      /** Synchronous steady state. Join a check only when observation is dirty. */
      pending: () => (pending ? settle() : undefined),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
