import { randomUUID } from 'node:crypto';
import {
  sameDEntryIdentity,
  type DEntryIdentity,
  type DEntrySelectionInput,
  type RequestContext,
} from '@allrice/contracts';
import {
  DataAccessError,
  getDEntryHistoryRootPin,
  getDEntryPageNativeRoot,
  registerDEntryPageNativeRoot,
  resolveDEntryIdentity,
  runDEntryAdmittedActivity,
  watchDEntryNativeRosterAuthority,
  type DEntryHistoryRootPin,
  type DEntryPageForkSource,
} from '@allrice/database';
import { nativeSessionRoot } from '@allrice/d-entry-principal/policy';
import type {
  DEntryPageNativeCall,
  DEntryPrincipalActivity,
  DEntryPrincipalControlScope,
} from '@allrice/d-entry-principal/types';
import { currentDEntryRequest, type DEntryHttpDependencies } from './http.js';
import { ownDEntryCatalog } from './native-data.js';
import {
  currentDEntryNativeOwner,
  DEntryNativeUnavailable,
  resolveDEntryNativeResource,
  sameDEntryVmBinding,
  type ResolvedDEntryNativeOwner,
} from './native-owner.js';
import type { DEntryFixedProfileSource } from './released-profile.js';
import { dEntryStartupTiming } from './startup-timing.js';

type Selection = { organizationId: string; selection: DEntrySelectionInput };
export type DEntryPageDependencies = DEntryHttpDependencies & {
  historyIdentity: typeof resolveDEntryIdentity;
  historyRoot: typeof getDEntryHistoryRootPin;
  watchTerminal?(
    ...args: Parameters<typeof watchDEntryNativeRosterAuthority>
  ): ReturnType<DEntryHttpDependencies['watch']>;
} & Partial<typeof pageRootStore>;
const pageRootStore = {
  findRoot: getDEntryPageNativeRoot,
  registerRoot: registerDEntryPageNativeRoot,
};
export const dEntryPageHistory = {
  historyIdentity: resolveDEntryIdentity,
  historyRoot: getDEntryHistoryRootPin,
};

const denied = () => new DataAccessError('authorization_denied');
function sameRoot(a: DEntryHistoryRootPin, b: DEntryHistoryRootPin) {
  return (
    sameDEntryIdentity(a.identity, b.identity) &&
    a.rootNativeSessionId === b.rootNativeSessionId &&
    a.rootOriginDigest === b.rootOriginDigest &&
    a.rootBindingRef === b.rootBindingRef &&
    a.vmId === b.vmId
  );
}
function sameSelection(a: DEntrySelectionInput, b: DEntrySelectionInput) {
  return (
    a.workspaceId === b.workspaceId &&
    a.employeeInstanceId === b.employeeInstanceId &&
    a.threadId === b.threadId
  );
}
export type DEntryPageHandle = Readonly<{
  scope: DEntryPrincipalControlScope;
  bindingRef: string;
  fixedProfile?: DEntryFixedProfileSource;
  identity: DEntryIdentity;
  root: DEntryHistoryRootPin | null;
  signal: AbortSignal;
  assertCurrent(signal: AbortSignal): Promise<void>;
  canReuseNativeSession(
    nativeSessionId: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  authorizeForkSource(
    nativeSessionId: string,
    signal: AbortSignal,
  ): Promise<DEntryPageForkSource>;
  registerNativeSession(
    nativeSessionId: string,
    forkSource: DEntryPageForkSource | undefined,
    signal: AbortSignal,
  ): Promise<void>;
  invokeTerminal(
    call: DEntryPageNativeCall,
    signal: AbortSignal,
  ): ReturnType<DEntryPrincipalControlScope['invokePage']>;
  authorize(
    nativeSessionId: string,
    effect: 'read' | 'write',
    signal: AbortSignal,
  ): ReturnType<typeof resolveDEntryNativeResource>;
  invalidate(reason: unknown): void;
  use<T>(
    signal: AbortSignal,
    operation: (active: AbortSignal) => Promise<T>,
  ): Promise<T>;
}>;

export function createDEntryPageRequests(deps: DEntryPageDependencies) {
  const pages = new Map<
    string,
    {
      sessionId: RequestContext['sessionId'];
      selection: DEntrySelectionInput;
      page: DEntryPageHandle;
    }
  >();
  const terminalScopes = new Map<
    string,
    Promise<DEntryPrincipalControlScope>
  >();

  function terminalScope(
    context: RequestContext,
    pageIdentity: DEntryIdentity,
    pageOwner: ResolvedDEntryNativeOwner,
  ) {
    const identity = { ...pageIdentity, threadId: null };
    const key = JSON.stringify([
      context.sessionId,
      identity,
      pageOwner.bindingRef,
    ]);
    const existing = terminalScopes.get(key);
    if (existing) return existing;
    const opening = Promise.resolve().then(async () => {
      let authority: Awaited<ReturnType<typeof deps.watch>> | undefined;
      let activity: DEntryPrincipalActivity | undefined;
      let scope: DEntryPrincipalControlScope | undefined;
      let closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= Promise.resolve().then(async () => {
          authority?.revoked.removeEventListener('abort', lost);
          scope?.revoked.removeEventListener('abort', lost);
          const results = await Promise.allSettled([
            activity?.close(),
            authority?.close(),
          ]);
          if (results.some((result) => result.status === 'rejected'))
            throw Error('D_ENTRY_TERMINAL_JOIN_UNKNOWN');
          if (terminalScopes.get(key) === opening) terminalScopes.delete(key);
        }));
      function lost() {
        void close().catch(() => {
          // Keep this exact binding fenced when native cleanup cannot be confirmed.
          console.error('[d-entry-terminal] D_ENTRY_TERMINAL_JOIN_UNKNOWN');
        });
      }
      try {
        // Authorization belongs to the login and employee, independent of the
        // browser page and its selected thread. This scope owns native PTYs.
        const current = await currentDEntryNativeOwner(
          deps.owners,
          context,
          identity,
          pageOwner.revoked,
        );
        if (
          current.view.bindingRef !== pageOwner.bindingRef ||
          !sameDEntryVmBinding(
            current.view.receipt.binding,
            pageOwner.receipt.binding,
          )
        )
          throw denied();
        const verifyOwner = async (signal: AbortSignal) => {
          await current.owner.assertCurrent(context, signal);
          if (
            current.owner.bindingRef !== current.view.bindingRef ||
            !sameDEntryVmBinding(
              current.owner.receipt.binding,
              current.view.receipt.binding,
            ) ||
            current.owner.receipt.rosterDigest !==
              current.view.receipt.rosterDigest
          )
            throw denied();
        };
        authority = await (
          deps.watchTerminal ?? watchDEntryNativeRosterAuthority
        )(
          context,
          {
            workspaceId: identity.workspaceId,
            employeeInstanceId: identity.employeeInstanceId,
          },
          identity,
          current.signal,
          { verifyBinding: verifyOwner, verifyRoster: verifyOwner },
        );
        const active = authority.revoked;
        active.throwIfAborted();
        authority.revoked.addEventListener('abort', lost, { once: true });
        activity = current.owner.acquirePrincipal(
          context,
          { scopeId: randomUUID(), identity, access: 'page' },
          active,
        );
        scope = await activity.run(active);
        scope.revoked.addEventListener('abort', lost, { once: true });
        active.throwIfAborted();
        scope.revoked.throwIfAborted();
        return scope;
      } catch (error) {
        await close();
        throw error;
      }
    });
    terminalScopes.set(key, opening);
    return opening;
  }

  async function authenticate(
    token: string,
    input: Selection,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const context = await deps.authenticate(token, {
      organizationId: input.organizationId,
      workspaceId: input.selection.workspaceId,
    });
    signal.throwIfAborted();
    if (!context) throw new DataAccessError('authentication_required');
    return context;
  }

  async function currentHistory(
    context: RequestContext,
    input: Selection,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const identity = await deps.historyIdentity(
      context,
      input.selection,
      'history',
    );
    signal.throwIfAborted();
    return { context, identity };
  }

  async function history(token: string, input: Selection, signal: AbortSignal) {
    return currentHistory(
      await authenticate(token, input, signal),
      input,
      signal,
    );
  }

  async function own(
    token: string,
    input: Selection,
    signal: AbortSignal,
    stop: AbortSignal,
    opened: (page: DEntryPageHandle) => Promise<void>,
    revoked: (reason: unknown) => void,
  ) {
    // The explicit editor open may bind a new root on an existing Host.
    // This path never starts a VM to make a missing cold source exist.
    const timing = dEntryStartupTiming('page-open');
    const original = await timing.run('history-authority', () =>
      history(token, input, signal),
    );
    const existing = input.selection.threadId
      ? await timing.run('history-root', () =>
          deps.historyRoot(original.context, input.selection),
        )
      : null;
    signal.throwIfAborted();
    const data = deps.data();
    if (!data) throw new DEntryNativeUnavailable();
    if (existing && !sameDEntryIdentity(existing.identity, original.identity))
      throw denied();
    const auth = await timing.run('current-authority', () =>
      currentDEntryRequest(deps, token, input, signal),
    );
    if (
      auth.context.sessionId !== original.context.sessionId ||
      !sameDEntryIdentity(auth.identity, original.identity)
    )
      throw denied();
    const authority = await timing.run('watch-authority', () =>
      deps.watch(auth.context, input.selection, auth.identity, signal),
    );
    try {
      const active = AbortSignal.any([signal, authority.revoked]);
      const current = await timing.run('host-owner-and-roster', () =>
        currentDEntryNativeOwner(
          deps.owners,
          auth.context,
          auth.identity,
          active,
        ),
      );
      if (!current.owner.controlReady()) throw new DEntryNativeUnavailable();
      async function assertHost(caller: AbortSignal) {
        const next = await currentDEntryRequest(deps, token, input, caller);
        if (
          next.context.sessionId !== auth.context.sessionId ||
          !sameDEntryIdentity(auth.identity, next.identity)
        )
          throw denied();
        await current.owner.assertCurrent(next.context, caller);
        if (
          current.owner.bindingRef !== current.view.bindingRef ||
          !sameDEntryVmBinding(
            current.owner.receipt.binding,
            current.view.receipt.binding,
          )
        )
          throw denied();
        if (!current.owner.controlReady()) throw new DEntryNativeUnavailable();
        caller.throwIfAborted();
        return next.context;
      }
      let root = existing;
      const prepareEditorRoot = data.prepareEditorRoot;
      if (!root && input.selection.threadId && prepareEditorRoot) {
        root = await timing.run('native-root', () => {
          return prepareEditorRoot({
            ...auth,
            owner: current.owner,
            async assertCurrent(caller) {
              await assertHost(caller);
            },
            signal: current.signal,
          });
        });
      }
      const pin = root;
      if (
        pin &&
        (!sameDEntryIdentity(pin.identity, auth.identity) ||
          pin.vmId !== current.view.receipt.binding.vmId)
      )
        throw denied();
      async function assertCurrent(caller: AbortSignal) {
        const next = await assertHost(caller);
        if (pin && !sameRoot(await deps.root(next, input.selection), pin))
          throw denied();
        caller.throwIfAborted();
      }
      const operationId = randomUUID();
      const owner = await timing.run('admission-editor-proof', () =>
        data.resolveAdmissionOwner({
          ...auth,
          owner: current.owner,
          operationId,
          signal: current.signal,
          access: 'page',
        }),
      );
      if (
        owner.operationId !== operationId ||
        owner.context.sessionId !== auth.context.sessionId ||
        owner.context.workspaceId !== auth.context.workspaceId ||
        !sameDEntryVmBinding(owner.binding, current.view.receipt.binding)
      )
        throw denied();
      const finishAdmission = timing.begin('admission-activation');
      await runDEntryAdmittedActivity(
        {
          ports: data.admission,
          signal: current.signal,
          owner: {
            ...owner,
            async assertCurrent(caller) {
              await assertCurrent(caller);
              await owner.assertCurrent(caller);
            },
          },
        },
        (admitted) => {
          finishAdmission();
          const catalog = ownDEntryCatalog(current.owner, admitted);
          const ended = new AbortController();
          const lifetime = AbortSignal.any([admitted, ended.signal]);
          const scopeId = randomUUID();
          const children = new Set<Promise<unknown>>();
          let running: Promise<void> | undefined;
          let principal: DEntryPrincipalActivity | undefined;
          let scope: DEntryPrincipalControlScope | undefined;
          let closing: Promise<void> | undefined;
          const lost = () => invalidate(admitted.reason);
          const principalLost = () => invalidate(scope?.revoked.reason);
          function fence(reason?: unknown) {
            pages.delete(scopeId);
            ended.abort(reason);
          }
          function invalidate(reason: unknown) {
            if (ended.signal.aborted) return;
            fence(reason);
            revoked(reason);
          }
          function close() {
            if (closing) return closing;
            // Publish first so a stream/guard cancellation can reenter safely.
            closing = Promise.resolve().then(async () => {
              const results = await Promise.allSettled([
                principal?.close(),
                catalog.close(),
                running,
                ...children,
              ]);
              admitted.removeEventListener('abort', lost);
              scope?.revoked.removeEventListener('abort', principalLost);
              stop.removeEventListener('abort', stopPage);
              // The admitted callback preserves the business failure from run.
              const failures = results
                .slice(0, 2)
                .flatMap((result) =>
                  result.status === 'rejected' ? [result.reason] : [],
                );
              if (failures.length)
                throw new AggregateError(failures, 'PRINCIPAL_JOIN_UNKNOWN');
            });
            fence();
            return closing;
          }
          function stopPage() {
            fence();
          }
          admitted.addEventListener('abort', lost, { once: true });
          stop.addEventListener('abort', stopPage, { once: true });
          if (stop.aborted) stopPage();
          if (admitted.aborted) lost();
          return {
            run(caller) {
              const runningSignal = AbortSignal.any([caller, lifetime]);
              running = Promise.resolve().then(async () => {
                const authorize = async (
                  nativeSessionId: string,
                  effect: 'read' | 'write',
                  active: AbortSignal,
                ) => {
                  if (!pin) throw denied();
                  const resource = await resolveDEntryNativeResource({
                    ...auth,
                    owner: catalog.owner,
                    nativeSessionId,
                    signal: active,
                    root: deps.root,
                  });
                  if (
                    resource.rootNativeSessionId !== pin.rootNativeSessionId ||
                    (effect === 'write' &&
                      (resource.nativeSessionId !== pin.rootNativeSessionId ||
                        resource.parentNativeSessionId !== null))
                  )
                    throw denied();
                  return resource;
                };
                const authorizeForkSource = async (
                  nativeSessionId: string,
                  active: AbortSignal,
                ): Promise<DEntryPageForkSource> => {
                  await assertCurrent(active);
                  const sessions = await catalog.owner.readSessions(active);
                  if (!sessions.ok) throw denied();
                  const items = sessions.value.items;
                  const entries = new Map(
                    items.map((row) => [String(row.sessionId), row]),
                  );
                  const root = nativeSessionRoot(entries, nativeSessionId);
                  if (!root || entries.size !== items.length) throw denied();
                  const vmId = current.view.receipt.binding.vmId;
                  const registered = await (
                    deps.findRoot ?? pageRootStore.findRoot
                  )(auth.context, auth.identity, vmId, root.sessionId);
                  if (
                    !registered ||
                    registered.vmId !== vmId ||
                    registered.rootNativeSessionId !== root.sessionId ||
                    registered.forkedFromNativeSessionId !==
                      root.parentSessionId
                  )
                    throw denied();
                  active.throwIfAborted();
                  return { nativeSessionId, root: registered };
                };
                await timing.run('owned-vm-before-open', () =>
                  assertCurrent(runningSignal),
                );
                runningSignal.throwIfAborted();
                principal = catalog.owner.acquirePrincipal(
                  auth.context,
                  {
                    scopeId,
                    identity: auth.identity,
                    access: 'page',
                    ...(pin && {
                      root: {
                        nativeSessionId: pin.rootNativeSessionId,
                        rootOriginDigest: pin.rootOriginDigest,
                        rootBindingRef: pin.rootBindingRef,
                        ...(pin.forkedFromNativeSessionId && {
                          forkedFromNativeSessionId:
                            pin.forkedFromNativeSessionId,
                        }),
                      },
                    }),
                  },
                  runningSignal,
                );
                const startedPrincipal = principal;
                scope = await timing.run('guest-principal-open', () =>
                  startedPrincipal.run(runningSignal),
                );
                scope.revoked.addEventListener('abort', principalLost, {
                  once: true,
                });
                if (scope.revoked.aborted) principalLost();
                if (
                  scope.opened.scopeId !== scopeId ||
                  scope.opened.principal.scopeId !== scopeId ||
                  !sameDEntryIdentity(
                    scope.opened.principal.identity,
                    auth.identity,
                  ) ||
                  scope.opened.baseline.owner !== false
                )
                  throw denied();
                await timing.run('owned-vm-after-open', () =>
                  assertCurrent(runningSignal),
                );
                runningSignal.throwIfAborted();
                const page: DEntryPageHandle = {
                  scope,
                  bindingRef: current.view.bindingRef,
                  fixedProfile: current.owner.fixedProfile,
                  identity: auth.identity,
                  root: pin,
                  signal: lifetime,
                  async assertCurrent(caller) {
                    const active = AbortSignal.any([lifetime, caller]);
                    try {
                      await assertCurrent(active);
                    } catch (error) {
                      // A canceled finite request cannot revoke a live page.
                      if (!caller.aborted) invalidate(error);
                      throw error;
                    }
                    active.throwIfAborted();
                  },
                  async canReuseNativeSession(nativeSessionId, active) {
                    await assertCurrent(active);
                    const binding = current.view.receipt.binding;
                    const pin = await (deps.findRoot ?? pageRootStore.findRoot)(
                      auth.context,
                      auth.identity,
                      binding.vmId,
                      nativeSessionId,
                    );
                    if (
                      !pin ||
                      pin.rootNativeSessionId !== nativeSessionId ||
                      pin.vmId !== binding.vmId
                    )
                      return false;
                    const sessions = await catalog.owner.readSessions(active);
                    active.throwIfAborted();
                    return (
                      sessions.ok &&
                      sessions.value.items.some(
                        (row) =>
                          row.sessionId === nativeSessionId &&
                          row.origin !== 'subagent',
                      )
                    );
                  },
                  authorizeForkSource,
                  async registerNativeSession(
                    nativeSessionId,
                    forkSource,
                    active,
                  ) {
                    await assertCurrent(active);
                    if (forkSource) {
                      const confirmed = await authorizeForkSource(
                        forkSource.nativeSessionId,
                        active,
                      );
                      if (!sameRoot(forkSource.root, confirmed.root))
                        throw denied();
                    }
                    await (deps.registerRoot ?? pageRootStore.registerRoot)(
                      auth.context,
                      auth.identity,
                      {
                        nativeSessionId,
                        forkSource,
                        host: {
                          binding: current.view.receipt.binding,
                          bindingRef: current.view.bindingRef,
                          rosterDigest: current.view.receipt.rosterDigest,
                        },
                      },
                      active,
                    );
                    await assertCurrent(active);
                  },
                  async invokeTerminal(call, active) {
                    active.throwIfAborted();
                    const terminal = await terminalScope(
                      auth.context,
                      auth.identity,
                      current.owner,
                    );
                    await assertCurrent(active);
                    return terminal.invokePage(
                      { ...call, scopeId: terminal.opened.scopeId },
                      active,
                    );
                  },
                  authorize,
                  invalidate,
                  use(signal, operation) {
                    const active = AbortSignal.any([signal, lifetime]);
                    active.throwIfAborted();
                    const child = Promise.resolve().then(() =>
                      operation(active),
                    );
                    children.add(child);
                    void child.then(
                      () => children.delete(child),
                      () => children.delete(child),
                    );
                    return child;
                  },
                };
                if (pages.has(scopeId)) throw denied();
                pages.set(scopeId, {
                  sessionId: auth.context.sessionId,
                  selection: input.selection,
                  page,
                });
                // The send is part of run, even when the page closes mid-send.
                await timing.run('opened-reply', () => opened(page));
                timing.ready();
                if (!lifetime.aborted)
                  await new Promise<void>((resolve) =>
                    lifetime.addEventListener('abort', () => resolve(), {
                      once: true,
                    }),
                  );
              });
              return running;
            },
            close,
          };
        },
      );
    } finally {
      await authority.close();
    }
  }

  async function borrow<T>(
    token: string,
    input: Selection,
    scopeId: string,
    caller: AbortSignal,
    operation: (page: DEntryPageHandle, active: AbortSignal) => Promise<T>,
    failed?: (error: unknown, active: AbortSignal) => Promise<T>,
  ) {
    const context = await authenticate(token, input, caller);
    const record = pages.get(scopeId);
    if (
      !record ||
      record.sessionId !== context.sessionId ||
      record.page.identity.organizationId !== context.organizationId ||
      record.page.identity.organizationId !== input.organizationId ||
      !sameSelection(record.selection, input.selection)
    ) {
      await currentHistory(context, input, caller);
      throw denied();
    }
    return record.page.use(caller, async (active) => {
      try {
        const auth = await currentHistory(context, input, active);
        if (
          !sameDEntryIdentity(auth.identity, record.page.identity) ||
          pages.get(scopeId) !== record
        )
          throw denied();
        await record.page.assertCurrent(active);
        return await operation(record.page, active);
      } catch (error) {
        if (!failed) throw error;
        return failed(error, active);
      }
    });
  }

  return {
    async authorizeUpgrade(
      token: string,
      input: Selection,
      signal: AbortSignal,
    ) {
      const auth = await history(token, input, signal);
      const data = deps.data();
      if (!data) throw new DEntryNativeUnavailable();
      const root =
        input.selection.threadId &&
        (await deps.historyRoot(auth.context, input.selection));
      if (!root) {
        // Qualification only. Opening the socket alone never creates a root.
        await currentDEntryRequest(deps, token, input, signal);
      }
      signal.throwIfAborted();
    },
    own,
    borrow,
  };
}
