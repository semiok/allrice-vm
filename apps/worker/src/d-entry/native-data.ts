import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type {
  SessionCreateRequest,
  SessionCreateValue,
} from '@deepseek-ai/dsh-api-session-controller/types';
import type {
  DEntryAdmissionOwner,
  DEntryAdmissionPorts,
  DEntryHistoryRootPin,
  DEntryOwnedActivity,
} from '@allrice/database';
import type { PersonVmBinding } from '@allrice/person-vm';
import type { ResolvedDEntryNativeOwner } from './native-owner.js';
import {
  assertDEntryPrincipalIssueForOwner,
  createDEntryPrincipalChildren,
} from './principal-activity.js';
import type { parseDEntryNativeInvocation } from './native-invocation.js';

export type DEntryNativeInvocation = Awaited<
  ReturnType<typeof parseDEntryNativeInvocation>
>;
export type DEntryNativeMuxChannel = Readonly<{
  frames: AsyncIterable<string>;
  send(frame: string): Promise<void>;
}>;

/** The admitted page carrier owns its non-owner RPC and mux transports.
 * Older standalone carriers require their own explicit transport owners.
 * Acquire is inert; close cancels and joins the operation without closing
 * the shared native job. */
export interface DEntryNativeDataPort {
  admission: DEntryAdmissionPorts;
  assertEditorReady?(
    context: RequestContext,
    identity: DEntryIdentity,
    signal: AbortSignal,
  ): Promise<AbortSignal>;
  confirmVerifiedEditor?(
    context: RequestContext,
    identity: DEntryIdentity,
    signal: AbortSignal,
  ): Promise<{ binding: PersonVmBinding; proof: AbortSignal } | undefined>;
  /** Explicit editor open on a current running Host. The database owns the
   * durable claim and native root. Read-only discovery never calls this. */
  prepareEditorRoot?(input: {
    context: RequestContext;
    identity: DEntryIdentity;
    owner: ResolvedDEntryNativeOwner;
    assertCurrent(signal: AbortSignal): Promise<void>;
    signal: AbortSignal;
  }): Promise<DEntryHistoryRootPin>;
  resolveAdmissionOwner(input: {
    context: RequestContext;
    identity: DEntryIdentity;
    owner: ResolvedDEntryNativeOwner;
    operationId: string;
    signal: AbortSignal;
    access?: 'page';
  }): Promise<DEntryAdmissionOwner>;
  acquireRpc?(
    input: {
      owner: ResolvedDEntryNativeOwner;
      // Parsed generated input only. The adapter calls run ONLY after the
      // admitted catalog/root guard. Construction must not dispatch the RPC.
      invocation: DEntryNativeInvocation;
      consume(response: Response, signal: AbortSignal): Promise<void>;
    },
    signal: AbortSignal,
  ): DEntryOwnedActivity<void>;
  acquireMux?(
    input: {
      owner: ResolvedDEntryNativeOwner;
      serve(
        channel: DEntryNativeMuxChannel,
        signal: AbortSignal,
      ): Promise<void>;
    },
    signal: AbortSignal,
  ): DEntryOwnedActivity<void>;
  /** Host-only generated session/create, never a browser-provided native id,
   * path, preset or generic RPC. Actual profile authentication and partial-init
   * cancellation/join remain owned by this same real transport handle. Like
   * acquireRpc, constructing the handle must not start I/O; only run may. */
  acquireRoot(
    input: {
      owner: ResolvedDEntryNativeOwner;
      request: Readonly<SessionCreateRequest>;
    },
    signal: AbortSignal,
  ): DEntryOwnedActivity<RemoteResult<SessionCreateValue>>;
}

let installed: DEntryNativeDataPort | undefined;
export function installDEntryNativeDataPort(port: DEntryNativeDataPort) {
  if (installed) throw Error('D_ENTRY_DATA_PORT_ALREADY_INSTALLED');
  installed = port;
  return () => {
    if (installed === port) installed = undefined;
  };
}
export function currentDEntryNativeDataPort() {
  return installed;
}

/** Own the actual unary catalog children INSIDE one admitted request. A
 * fulfilled readSessions Promise is the owner's completed read operation;
 * raw rejection lacks a joined-close fact and remains unknown on close. */
export function ownDEntryCatalog(
  owner: ResolvedDEntryNativeOwner,
  signal: AbortSignal,
) {
  const abort = new AbortController();
  const lifetime = AbortSignal.any([signal, abort.signal, owner.revoked]);
  const principalChildren = createDEntryPrincipalChildren(lifetime);
  const reads = new Set<
    ReturnType<ResolvedDEntryNativeOwner['readSessions']>
  >();
  const failures: unknown[] = [];
  let closing: Promise<void> | undefined;
  const scoped: ResolvedDEntryNativeOwner = {
    receipt: owner.receipt,
    endpoint: owner.endpoint,
    bindingRef: owner.bindingRef,
    revoked: owner.revoked,
    controlReady: owner.controlReady.bind(owner),
    assertCurrent: owner.assertCurrent.bind(owner),
    acquirePrincipal(context, issue, caller) {
      assertDEntryPrincipalIssueForOwner(issue, owner);
      return principalChildren.acquire({
        signal: caller,
        assertCurrent: (active) => owner.assertCurrent(context, active),
        acquire: (active) => owner.acquirePrincipal(context, issue, active),
      });
    },
    readSessions(caller, notDispatched) {
      const current = AbortSignal.any([
        signal,
        caller,
        abort.signal,
        owner.revoked,
      ]);
      current.throwIfAborted();
      let read: ReturnType<ResolvedDEntryNativeOwner['readSessions']>;
      let joinedBeforeDispatch = false;
      try {
        read = Promise.resolve(
          owner.readSessions(current, () => {
            joinedBeforeDispatch = true;
            notDispatched?.();
          }),
        );
      } catch (error) {
        read = Promise.reject(error);
      }
      reads.add(read);
      void read.then(
        () => reads.delete(read),
        (error) => {
          reads.delete(read);
          if (!joinedBeforeDispatch) failures.push(error);
        },
      );
      return read;
    },
  };
  return {
    owner: scoped,
    close() {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        const [principals] = await Promise.allSettled([
          principalChildren.close(),
          ...reads,
        ]);
        if (principals.status === 'rejected') failures.push(principals.reason);
        if (failures.length)
          throw new AggregateError(failures, 'Catalog read join is unknown', {
            cause: failures[0],
          });
      });
      abort.abort();
      return closing;
    },
  };
}

/** Observe failed release ACKs without changing the real boundary semantics.
 * Business rejection after known join is separate from unknown cleanup. */
export function observeDEntryFinish(
  ports: DEntryAdmissionPorts,
  unknown: (error: unknown) => void,
): DEntryAdmissionPorts {
  const boundary = ports.boundary;
  return {
    ...ports,
    boundary: {
      admit: boundary.admit.bind(boundary),
      queued: boundary.queued.bind(boundary),
      activate: boundary.activate.bind(boundary),
      waitUntilReady: boundary.waitUntilReady.bind(boundary),
      async finish(permit) {
        try {
          await boundary.finish(permit);
        } catch (error) {
          unknown(error);
          throw error;
        }
      },
    },
  };
}
