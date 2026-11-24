import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import * as GatewayClient from '@deepseek-ai/dsh-api-gateway/client';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import { TYPERT_REMOTE as PRINCIPAL_REMOTE } from '@allrice/d-entry-principal/remote';
import { createDEntryPrincipalControl } from '../d-entry/principal-control.js';
import type { DEntryPrincipalIssue } from '@allrice/d-entry-principal/types';
import type { RequestContext } from '@allrice/contracts';
import {
  PersonVmError,
  sameVmBinding,
  type PersonVmBinding,
  type PersonVmBootstrapScope,
  type PersonVmPort,
} from '@allrice/person-vm';
import type { NativeWebLaunch } from './launch.js';
import { nativeWebTransport } from './transport.js';

/** Real public Node control owner for one already published native Web job.
 * This is not Runtime.ready, editor readiness, or a VM-wide activity producer. */
export async function openNativeWebOwner(input: {
  scope: PersonVmBootstrapScope;
  launch: NativeWebLaunch;
  context: RequestContext;
  vm: Pick<PersonVmPort, 'assertCurrentBinding'>;
  lifetime: AbortSignal;
  cleanupTimeoutMs: number;
}) {
  if (
    !input.scope.readNativeWebAuth ||
    !Number.isSafeInteger(input.cleanupTimeoutMs) ||
    input.cleanupTimeoutMs <= 0
  )
    throw new PersonVmError('PROVIDER_FAILED');
  const binding = Object.freeze({ ...input.scope.binding });
  if (!sameVmBinding(input.launch.binding, binding))
    throw new PersonVmError('LEASE_LOST');
  const stale = new AbortController(),
    carrier = new AbortController(),
    waitAbort = new AbortController();
  // Business cancellation fences calls; the separate carrier survives to carry
  // typed close/closed/end until normal cleanup, actual loss or exact stop.
  const signal = AbortSignal.any([input.lifetime, stale.signal]);
  let ready = false,
    closing: Promise<void> | undefined,
    hostClosing: Promise<void> | undefined;
  let job: Awaited<ReturnType<PersonVmBootstrapScope['launch']>> | undefined;
  let starting: Promise<NonNullable<typeof job>> | undefined;
  let nativeWait: Promise<unknown> | undefined;
  let nativeStopConfirmed = false;
  const root = new Context();
  const principals = createDEntryPrincipalControl(root, {
    carrier: carrier.signal,
    cleanupTimeoutMs: input.cleanupTimeoutMs,
  });
  const operations = new Set<Promise<unknown>>();
  function own<T>(operation: Promise<T>): Promise<T> {
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  }
  function setup<T>(work: () => PromiseLike<T>): Promise<T> {
    signal.throwIfAborted();
    return own(
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return work();
      }),
    );
  }
  async function joinOperations() {
    while (operations.size) await Promise.allSettled([...operations]);
  }
  let disconnected: Promise<void> | undefined;
  const lost = () => {
    if (disconnected) return;
    // Publish before abort callbacks can reenter. Local drain is not remote ACK.
    disconnected = Promise.resolve().then(async () => {
      await Promise.allSettled([starting, nativeWait]);
      const results = await Promise.allSettled([
        principals.drainLocal(),
        transport.close(),
      ]);
      await joinOperations();
      const [fiber] = await Promise.allSettled([root.fiber.dispose()]);
      if (
        fiber.status === 'rejected' ||
        results.some((r) => r.status === 'rejected')
      )
        throw new PersonVmError('CLEANUP_INCOMPLETE');
    });
    ready = false;
    principals.fence(new PersonVmError('PROVIDER_FAILED'));
    stale.abort(new PersonVmError('PROVIDER_FAILED'));
    carrier.abort(new PersonVmError('PROVIDER_FAILED'));
    waitAbort.abort();
    void disconnected.catch(() => {});
  };
  const transport = nativeWebTransport(
    input.launch.auth.origin,
    carrier.signal,
    lost,
  );
  function joinHost() {
    if (hostClosing) return hostClosing;
    ready = false;
    hostClosing = Promise.resolve().then(async () => {
      // This function proves LOCAL join only. Normal close separately requires
      // the scope stream ACK; exact-stop retirement must not ask a dead Host.
      stale.abort();
      carrier.abort();
      waitAbort.abort();
      await Promise.allSettled([starting, nativeWait, disconnected]);
      const results = await Promise.allSettled([
        principals.drainLocal(),
        transport.close(),
      ]);
      await joinOperations();
      const [fiber] = await Promise.allSettled([root.fiber.dispose()]);
      if (
        fiber.status === 'rejected' ||
        results.some((r) => r.status === 'rejected')
      )
        throw new PersonVmError('CLEANUP_INCOMPLETE');
    });
    const attempt = hostClosing;
    void attempt.catch(() => {
      if (hostClosing === attempt) hostClosing = undefined;
    });
    return attempt;
  }
  function close() {
    if (closing) return closing;
    // Publish before fence/abort: nested close must join this exact attempt.
    closing = Promise.resolve().then(async () => {
      const [scopes] = await Promise.allSettled([principals.close()]);
      // Even an unknown remote scope must get a real local drain. Only this
      // shared owner's close owns job cancellation; page scopes never do.
      const results = await Promise.allSettled([
        joinHost(),
        (async () => {
          await Promise.allSettled([starting]);
          // No await between this private stop-fact check and first dispatch.
          if (job && !nativeStopConfirmed)
            await job.cancelAndWait(
              AbortSignal.timeout(input.cleanupTimeoutMs),
            );
        })(),
      ]);
      const failures = [scopes, ...results].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length)
        throw new PersonVmError('CLEANUP_INCOMPLETE', {
          cause: new AggregateError(failures, 'Native owner cleanup failed'),
        });
    });
    ready = false;
    principals.fence(new PersonVmError('LEASE_LOST'));
    stale.abort(new PersonVmError('LEASE_LOST'));
    return closing;
  }
  const aborted = () => {
    void close().catch(() => {});
  };
  input.lifetime.addEventListener('abort', aborted, { once: true });
  input.scope.signal.addEventListener('abort', aborted, { once: true });
  if (input.lifetime.aborted || input.scope.signal.aborted) aborted();
  const startupTimer = setTimeout(lost, input.launch.auth.timeoutMs);
  function readCurrentSessions(
    requestSignal: AbortSignal,
    assertCurrent: (signal: AbortSignal) => Promise<void>,
  ) {
    const current = AbortSignal.any([signal, requestSignal]);
    if (current.aborted) return Promise.reject(current.reason);
    // Register before entering either asynchronous guard, including reentrant close.
    return own(
      Promise.resolve().then(async () => {
        current.throwIfAborted();
        await assertCurrent(current);
        current.throwIfAborted();
        const result = await root.remote.session.list({}, current);
        await assertCurrent(current);
        current.throwIfAborted();
        return result;
      }),
    );
  }
  try {
    signal.throwIfAborted();
    await setup(() => input.scope.assertCurrent());
    starting = setup(async () => {
      const opened = await input.scope.launch(input.launch.command);
      job = opened;
      return opened;
    });
    const started = await starting;
    if (!sameVmBinding(started.binding, binding))
      throw new PersonVmError('LEASE_LOST');
    signal.throwIfAborted();
    nativeWait = Promise.resolve().then(() => started.wait(waitAbort.signal));
    void nativeWait.then(
      () => {
        if (!waitAbort.signal.aborted) lost();
      },
      () => {
        if (!waitAbort.signal.aborted) lost();
      },
    );
    const auth = await setup(() =>
      input.scope.readNativeWebAuth!(input.launch.auth),
    );
    signal.throwIfAborted();
    await setup(() => input.scope.assertCurrent());
    await setup(() => transport.authenticate(auth.authenticatedUrl));
    await setup(() => root.plugin(TypertRegistry));
    signal.throwIfAborted();
    installConnection(root, {
      interactions: 'none',
      transport: {
        fetch: transport.fetch,
        createWebSocket: transport.createWebSocket,
        streamBaseUrl: input.launch.auth.origin,
      },
    });
    await setup(() => root.plugin(GatewayClient));
    await setup(() => root.remote.$mount(TYPERT_REMOTE));
    await setup(() => root.remote.$mount(PRINCIPAL_REMOTE));
    const list = await own(root.remote.session.list({}, signal));
    if (!list.ok) throw new PersonVmError('PROVIDER_FAILED');
    const stream = root.remote.session.control(signal);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await own(iterator.next());
    if (first.done || first.value.type !== 'baseline')
      throw new PersonVmError('PROVIDER_FAILED');
    await setup(() => input.scope.assertCurrent());
    signal.throwIfAborted();
    ready = true;
    own(
      (async () => {
        try {
          while (!(await iterator.next()).done) signal.throwIfAborted();
        } finally {
          // Expected business cancellation must leave cleanup carrier alive.
          if (!closing) lost();
          await iterator.return?.();
        }
      })(),
    ).catch(() => {});
    return Object.freeze({
      binding,
      revoked: signal,
      /** Connectivity only; never conveys current execution authorization. */
      controlReady: () => ready && !signal.aborted,
      acquirePrincipal(
        issue: DEntryPrincipalIssue,
        requestSignal: AbortSignal,
      ) {
        if (!ready || closing || signal.aborted)
          throw new PersonVmError('RUNTIME_NOT_READY');
        return principals.acquire(
          issue,
          AbortSignal.any([requestSignal, signal]),
        );
      },
      readSessions(requestSignal: AbortSignal) {
        async function assertCurrent(current: AbortSignal) {
          try {
            await input.vm.assertCurrentBinding(
              input.context,
              binding,
              current,
            );
          } catch (error) {
            // Normal closing/retirement owns this business abort; keep ACK carrier.
            if (!closing && !requestSignal.aborted) lost();
            throw error;
          }
        }
        return readCurrentSessions(requestSignal, assertCurrent);
      },
      /** Request denial does not certify loss of this shared native owner. */
      readSessionsFor(context: RequestContext, requestSignal: AbortSignal) {
        return readCurrentSessions(requestSignal, (current) =>
          input.vm.assertCurrentBinding(context, binding, current),
        );
      },
      /** The existing native index supplies the running Host's own graph.
       * The release publisher independently verifies its complete code graph and
       * new document bytes. The native index is never forwarded or executed. */
      readImmutableGraphFor(
        context: RequestContext,
        requestSignal: AbortSignal,
      ) {
        const current = AbortSignal.any([signal, requestSignal]);
        return own(
          Promise.resolve().then(async () => {
            current.throwIfAborted();
            if (!ready || closing) throw new PersonVmError('RUNTIME_NOT_READY');
            await input.vm.assertCurrentBinding(context, binding, current);
            const response = await transport.fetch(
              new URL('/', input.launch.auth.origin),
              { method: 'GET', redirect: 'error', signal: current },
            );
            if (
              !response.ok ||
              !response.headers.get('content-type')?.includes('text/html')
            )
              throw new PersonVmError('RUNTIME_NOT_READY');
            const html = await response.text();
            // renderIndexInjections uses exact global assignment with JSON; any
            // ambiguity, changed rendering contract or missing graph fails closed.
            const rows = [
              ...html.matchAll(
                /<script>globalThis\["__DSH_BOOT__"\] = ([^<]+)<\/script>/g,
              ),
            ];
            if (rows.length !== 1) throw new PersonVmError('RUNTIME_NOT_READY');
            const graph: unknown = JSON.parse(rows[0]![1]!);
            await input.vm.assertCurrentBinding(context, binding, current);
            current.throwIfAborted();
            return graph;
          }),
        );
      },
      /** Exact rc.2 static plugin combo roots. This never forwards a guest
       * URL, filesystem path, normal API request or browser authority. */
      readImmutableBundleFor(
        context: RequestContext,
        reference: string,
        expectedBytes: number,
        requestSignal: AbortSignal,
      ) {
        const current = AbortSignal.any([signal, requestSignal]);
        return own(
          Promise.resolve().then(async () => {
            current.throwIfAborted();
            if (
              !ready ||
              closing ||
              !/^plugins\/\?\?(?:[@a-z\d._/-]+(?:,[@a-z\d._/-]+)*)&rev=[a-f\d]+$/i.test(
                reference,
              )
            )
              throw new PersonVmError('RUNTIME_NOT_READY');
            const url = new URL(reference, input.launch.auth.origin);
            if (url.pathname !== '/plugins/' || url.hash)
              throw new PersonVmError('RUNTIME_NOT_READY');
            await input.vm.assertCurrentBinding(context, binding, current);
            const data = await transport.readExact(url, expectedBytes, current);
            await input.vm.assertCurrentBinding(context, binding, current);
            current.throwIfAborted();
            return data;
          }),
        );
      },
      /** Running Host catalog only; never startup readiness or a browser grant.
       * Native modelCatalog has zero arguments and no wire cancellation slot. */
      readModelCatalogFor(context: RequestContext, requestSignal: AbortSignal) {
        const current = AbortSignal.any([signal, requestSignal]);
        if (current.aborted) return Promise.reject(current.reason);
        if (!ready || closing)
          return Promise.reject(new PersonVmError('RUNTIME_NOT_READY'));
        // Register synchronously before either current guard or native dispatch.
        return own(
          Promise.resolve().then(async () => {
            current.throwIfAborted();
            if (!ready || closing) throw new PersonVmError('RUNTIME_NOT_READY');
            await input.vm.assertCurrentBinding(context, binding, current);
            current.throwIfAborted();
            const result = await root.remote.session.modelCatalog();
            // Join the actual zero-argument Promise before withholding cancelled output.
            current.throwIfAborted();
            await input.vm.assertCurrentBinding(context, binding, current);
            current.throwIfAborted();
            return result;
          }),
        );
      },
      /** Only the trusted runtime's confirmed-native-stop hook may use this.
       * This does not manufacture a job exit or replace normal exact close. */
      async retireAfterNativeStop(
        current: PersonVmBinding,
        cleanup: AbortSignal,
      ) {
        if (!sameVmBinding(binding, current))
          throw new PersonVmError('LEASE_LOST');
        cleanup.throwIfAborted();
        // Trusted exact-stop fact only; it does not certify any local I/O join.
        nativeStopConfirmed = true;
        const previous = closing;
        // Publish before abort/disposer reentry; no further job cancellation.
        closing = Promise.resolve().then(async () => {
          await Promise.allSettled([previous, hostClosing, disconnected]);
          hostClosing = undefined; // Fresh actual join; old rejection is no veto.
          await joinHost();
          await principals.retireAfterNativeStop(); // Local join + exact stop, no ACK.
          input.lifetime.removeEventListener('abort', aborted);
          cleanup.throwIfAborted();
        });
        ready = false;
        principals.fence(new PersonVmError('LEASE_LOST'));
        stale.abort();
        carrier.abort(); // Unblocks a pending normal ACK wait for this dead Host.
        waitAbort.abort();
        await closing;
      },
      async close() {
        try {
          await close();
        } finally {
          input.lifetime.removeEventListener('abort', aborted);
        }
      },
    });
  } catch {
    try {
      await close();
    } finally {
      input.lifetime.removeEventListener('abort', aborted);
    }
    throw new PersonVmError('PROVIDER_FAILED');
  } finally {
    clearTimeout(startupTimer);
    input.scope.signal.removeEventListener('abort', aborted);
  }
}

export type NativeWebOwner = Awaited<ReturnType<typeof openNativeWebOwner>>;
