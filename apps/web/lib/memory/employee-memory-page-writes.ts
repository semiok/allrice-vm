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
  const stores = new Map<string, PageState>();
  return (host: Host, scopeId: string, employee: Employee) => {
    const actor = JSON.stringify([employee.organizationId, employee.personId]);
    if (principal !== actor) {
      for (const state of stores.values()) {
        state.writes.clear();
        state.notify = undefined;
      }
      stores.clear();
      principal = actor;
    }
    const key = employeeKey(employee);
    const state = stores.get(key) ?? { scopeId, writes: new Map() };
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
    const bridge: EmployeeMemoryPageWrites = {
      async mutate(intent, assertTab, source) {
        const client = employeeMemoryClient(target, state.writes, {
          assertCurrent() {
            if (host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__ !== read)
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
        if (host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__ === read)
          listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const read = (candidate: string, member: Employee) =>
      candidate === scopeId && employeeKey(member) === key ? bridge : undefined;
    host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__ = read;
    state.notify = notify;
    return () => {
      if (host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__ === read)
        delete host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__;
      if (state.notify === notify) state.notify = undefined;
      listeners.clear();
    };
  };
}

export function readEmployeeMemoryPageWrites(
  host: Host,
  scopeId: string,
  employee: Employee,
) {
  return host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__?.(scopeId, employee);
}
