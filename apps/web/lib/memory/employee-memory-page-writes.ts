import type { DEntryIdentity } from '@allrice/contracts';
import type { MemoryWriteStore } from './employee-memory-client';

type Employee = Pick<
  DEntryIdentity,
  'organizationId' | 'workspaceId' | 'personId' | 'employeeInstanceId'
>;
type PageWrites = { operationScopeId: string; writes: MemoryWriteStore };
type Host = Window & {
  __ALLRICE_EMPLOYEE_MEMORY_WRITES__?: (
    scopeId: string,
    employee: Employee,
  ) => PageWrites | undefined;
};

const employeeKey = (employee: Employee) =>
  JSON.stringify([
    employee.organizationId,
    employee.workspaceId,
    employee.personId,
    employee.employeeInstanceId,
  ]);

/** The outer page survives chat navigation. Hold only idempotency and CAS
 * metadata here so an uncertain write keeps its identity in the next iframe. */
export function createEmployeeMemoryPageWrites() {
  let principal: string | undefined;
  const stores = new Map<string, PageWrites>();
  return (host: Host, scopeId: string, employee: Employee) => {
    const actor = JSON.stringify([employee.organizationId, employee.personId]);
    if (principal !== actor) {
      for (const state of stores.values()) state.writes.clear();
      stores.clear();
      principal = actor;
    }
    const key = employeeKey(employee);
    const state = stores.get(key) ?? {
      operationScopeId: scopeId,
      writes: new Map(),
    };
    stores.set(key, state);
    const read = (candidate: string, member: Employee) =>
      candidate === scopeId && employeeKey(member) === key ? state : undefined;
    host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__ = read;
    return () => {
      if (host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__ === read)
        delete host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__;
    };
  };
}

export function readEmployeeMemoryPageWrites(
  host: Host,
  scopeId: string,
  employee: Employee,
) {
  // Other hosts can supply a document-local store. Browser origin checks
  // disallow access to the bridge from a different origin.
  return host.__ALLRICE_EMPLOYEE_MEMORY_WRITES__?.(scopeId, employee);
}
