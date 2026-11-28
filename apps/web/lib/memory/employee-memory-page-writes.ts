import type { DEntryIdentity } from '@allrice/contracts';
import {
  employeeMemoryClient,
  type MemoryPair,
  type MemoryRow,
  type MemoryWriteStore,
} from './employee-memory-client';

type Employee = Pick<
  DEntryIdentity,
  'organizationId' | 'workspaceId' | 'personId' | 'employeeInstanceId'
>;
type Intent =
  | { action: 'save'; pair: MemoryPair; row: MemoryRow | null }
  | { action: 'confirm' | 'remove'; row: MemoryRow };
type Listener = (source: object) => void;
export type EmployeeMemoryPageWrites = {
  mutate(
    intent: Intent,
    assertTab: () => void,
    source: object,
  ): Promise<unknown>;
  subscribe(listener: Listener): () => void;
};
type PageState = {
  scopeId: string;
  writes: MemoryWriteStore;
  notify?: Listener;
};
type Host = Window & {
  __ALLRICE_EMPLOYEE_MEMORY_WRITES__?: (
    scopeId: string,
    employee: Employee,
    caller?: Window,
  ) => EmployeeMemoryPageWrites | undefined;
};

const employeeKey = (employee: Employee) =>
  JSON.stringify([
    employee.organizationId,
    employee.workspaceId,
    employee.personId,
    employee.employeeInstanceId,
  ]);

/** The outer page survives chat navigation. It owns only technical write
 * identity and the joined HTTP receipt, even if the initiating iframe leaves. */
export function createEmployeeMemoryPageWrites() {
  let principal: string | undefined;
  let owner: Host | undefined;
  const stores = new Map<string, PageState>();
  const bindings = new Map<
    string,
    {
      employee: string;
      frame?: () => Window | null;
      bridge: EmployeeMemoryPageWrites;
    }
  >();
  const read = (scopeId: string, employee: Employee, caller?: Window) => {
    const binding = bindings.get(scopeId);
    if (binding?.employee !== employeeKey(employee)) return;
    if (binding.frame && binding.frame() !== caller) return;
    return binding.bridge;
  };
  return (
    host: Host,
    scopeId: string,
    employee: Employee,
    visible = () => true,
    frame?: () => Window | null,
  ) => {
    const actor = JSON.stringify([employee.organizationId, employee.personId]);
    if (principal !== actor || owner !== host) {
      if (owner?.__ALLRICE_EMPLOYEE_MEMORY_WRITES__ === read)
        delete owner.__ALLRICE_EMPLOYEE_MEMORY_WRITES__;
      bindings.clear();
      for (const state of stores.values()) {
        state.writes.clear();
        state.notify = undefined;
      }
      stores.clear();
      principal = actor;
      owner = host;
    }
    const key = employeeKey(employee);
    for (const [previousScope, binding] of bindings)
      if (binding.employee === key) bindings.delete(previousScope);
    const state: PageState = stores.get(key) ?? { scopeId, writes: new Map() };
    stores.set(key, state);
    const target = {
      scopeId: state.scopeId,
      workspaceId: employee.workspaceId,
      instanceId: employee.employeeInstanceId,
      headers: {
        'x-allrice-workspace-id': employee.workspaceId,
        'x-allrice-organization-id': employee.organizationId,
      },
    };
    const listeners = new Set<Listener>();
    const notify = (source: object) =>
      listeners.forEach((listener) => listener(source));
    const isCurrent = () =>
      host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__ === read &&
      bindings.get(scopeId) === binding;
    const bridge: EmployeeMemoryPageWrites = {
      async mutate(intent, assertTab, source) {
        const client = employeeMemoryClient(target, state.writes, {
          assertCurrent() {
            if (!isCurrent() || !visible())
              throw new DOMException('Employee page is closed', 'AbortError');
            assertTab();
          },
        });
        const result = await (intent.action === 'save'
          ? client.save(intent.pair, intent.row)
          : client[intent.action](intent.row));
        state.notify?.(source);
        return result;
      },
      subscribe(listener) {
        if (isCurrent()) listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const binding = { employee: key, bridge, frame };
    bindings.set(scopeId, binding);
    host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__ = read;
    state.notify = notify;
    return () => {
      if (isCurrent()) {
        bindings.delete(scopeId);
        if (!bindings.size) delete host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__;
      }
      if (state.notify === notify) state.notify = undefined;
      listeners.clear();
    };
  };
}

export function readEmployeeMemoryPageWrites(
  host: Host,
  scopeId: string,
  employee: Employee,
  caller?: Window,
) {
  return host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__?.(scopeId, employee, caller);
}
