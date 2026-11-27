import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots';
import {
  createEmployeePanelDataClient,
  unboundEmployeePanelDataClient,
  type EmployeePanelDataClient,
  type EmployeePanelDataHandlers,
  type EmployeePanelDataMethod,
} from '../../../apps/web/lib/chatflow/employee-panel-data';
import { employeePanelReferences } from './employee-panel-references';
import { EmployeePanelsUnavailableError } from './employee-panels-model';
import type {
  EmployeePanelsPort,
  EmployeePanelsSnapshot,
} from './employee-panels-port';

export type EmployeePanelsDataResolver = (
  sessionId: SessionIdOf,
  snapshot: EmployeePanelsSnapshot,
) => EmployeePanelDataClient | null;

/** The authenticated owner supplies both ports. This adapter owns only UI
 * lifetimes. It neither creates an identity nor falls back to legacy HTTP. */
export function createEmployeePanelsDataPort(
  source: EmployeePanelsPort,
  resolve: EmployeePanelsDataResolver,
  signal: AbortSignal,
): EmployeePanelsPort & {
  dataClient(sessionId: SessionIdOf): EmployeePanelDataClient;
} {
  const references = source.useReference
    ? undefined
    : employeePanelReferences();
  const snapshots = new Map<
    SessionIdOf,
    {
      original: EmployeePanelsSnapshot;
      referencing?: EmployeePanelsSnapshot;
      value: EmployeePanelsSnapshot;
      controller: AbortController;
      client: EmployeePanelDataClient;
      unsubscribe: () => void;
    }
  >();
  const clear = (id: SessionIdOf) => {
    const entry = snapshots.get(id);
    snapshots.delete(id);
    entry?.controller.abort();
    entry?.unsubscribe();
  };
  signal.addEventListener(
    'abort',
    () => {
      for (const id of snapshots.keys()) clear(id);
    },
    { once: true },
  );
  const read = (id: SessionIdOf) => {
    if (signal.aborted) return null;
    const original = source.getSnapshot(id);
    const prior = snapshots.get(id);
    if (prior?.original === original) return prior;
    clear(id);
    if (!original) return null;
    const controller = new AbortController();
    const resolved = resolve(id, original);
    const raw = resolved ?? unboundEmployeePanelDataClient;
    if (signal.aborted) return null;
    const current = () => {
      if (
        signal.aborted ||
        controller.signal.aborted ||
        source.getSnapshot(id) !== original
      )
        throw new EmployeePanelsUnavailableError();
    };
    const handlers = Object.fromEntries(
      Object.keys(raw).map((key) => {
        const name = key as EmployeePanelDataMethod;
        return [
          name,
          async (input: never, caller: AbortSignal) => {
            current();
            const combined = AbortSignal.any([
              signal,
              controller.signal,
              caller,
            ]);
            combined.throwIfAborted();
            const result = await raw[name](input, combined);
            current();
            combined.throwIfAborted();
            return result;
          },
        ];
      }),
    ) as EmployeePanelDataHandlers;
    const client = createEmployeePanelDataClient(handlers);
    const value = {
      ...original,
      materials: { ...original.materials, dataClient: client },
      files: { ...original.files, dataClient: client },
    };
    const entry = {
      original,
      value,
      referencing:
        resolved && references
          ? {
              ...value,
              materials: { ...value.materials, readOnly: false },
              files: { ...value.files, readOnly: false },
            }
          : undefined,
      controller,
      client,
      unsubscribe: () => {},
    };
    snapshots.set(id, entry);
    // Independent preview/dialog/upload consumers keep this subscription even
    // when no React panel is subscribed. Install the entry before subscribe:
    // owners may notify or revoke synchronously while registering a listener.
    let unsubscribe: () => void;
    try {
      unsubscribe = source.subscribe(id, () => {
        if (snapshots.get(id) === entry && source.getSnapshot(id) !== original)
          clear(id);
      });
    } catch (error) {
      if (snapshots.get(id) === entry) clear(id);
      throw error;
    }
    if (snapshots.get(id) !== entry) {
      unsubscribe();
      return null;
    }
    entry.unsubscribe = unsubscribe;
    if (source.getSnapshot(id) !== original) {
      clear(id);
      return null;
    }
    return entry;
  };
  return {
    getSnapshot(id) {
      const entry = read(id);
      if (!entry) return null;
      return entry.referencing &&
        references?.current?.matches(id, entry.original)
        ? entry.referencing
        : entry.value;
    },
    subscribe(id, listener) {
      const unsubscribe = source.subscribe(id, () => {
        if (snapshots.get(id)?.original !== source.getSnapshot(id)) clear(id);
        listener();
      });
      const unwatch = references?.subscribe(listener);
      return () => {
        unsubscribe();
        unwatch?.();
      };
    },
    useReference: source.useReference
      ? (request) => source.useReference!(request)
      : references &&
        ((request) => {
          const entry = read(request.sessionId);
          const bridge = references.current;
          return (
            !!entry?.referencing &&
            !!bridge?.matches(request.sessionId, entry.original) &&
            entry.value.scopeKey === request.scopeKey &&
            bridge.insert(request)
          );
        }),
    // Preview/dialog and the existing upload intake must receive this same
    // scoped client, rather than reconstructing an old route from an object ID.
    dataClient: (id) => read(id)?.client ?? unboundEmployeePanelDataClient,
  };
}
