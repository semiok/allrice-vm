import { ChatSessionSchema } from '@allrice/contracts';
import type { PageNativeThreadRegistration } from '../../../apps/web/lib/d-entry/page-messages';
import type { readEmployeeDocument } from '../../../apps/web/lib/d-entry/profile-browser';

const conversationPrefix = 'dsh.conversation.';
const widthKey = conversationPrefix + 'contentWidth';
const managedPrefix = 'allrice:d-entry:conversation:v1:';
let installed = false;

const conversationKey = (key: string) =>
  key.startsWith(conversationPrefix) && key !== widthKey;

function volatileStorage(mapKey = (key: string) => key): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => Array.from(values.keys())[index] ?? null,
    getItem: (key) => values.get(mapKey(key)) ?? null,
    setItem: (key, value) => void values.set(mapKey(key), String(value)),
    removeItem: (key) => void values.delete(mapKey(key)),
    clear: () => values.clear(),
  };
}

function browserStorage(
  name: 'localStorage' | 'sessionStorage',
  probe: string,
  mapKey?: (key: string) => string,
) {
  try {
    const storage = window[name];
    // A browser may expose the object but deny reads within this document.
    storage.getItem(probe);
    return storage;
  } catch {
    Object.defineProperty(window, name, {
      configurable: true,
      value: volatileStorage(mapKey),
    });
  }
}

function guardStorageMethods(
  local: Storage | undefined,
  session: Storage | undefined,
  mapKey: (key: string) => string,
) {
  const prototype = window.Storage.prototype;
  const { getItem, setItem, removeItem, key, clear } = prototype;
  const length = Object.getOwnPropertyDescriptor(prototype, 'length')!.get!;
  type Changes = { changes: Map<string, string | null>; cleared: boolean };
  const active = new Map<Storage, Changes>();
  for (const area of [local, session])
    if (area) active.set(area, { changes: new Map(), cleared: false });
  function changesAfterWrite(
    area: Changes,
    target: string,
    value: string | null,
    write: () => void,
  ) {
    if (!area.cleared) {
      try {
        write();
        area.changes.delete(target);
        return;
      } catch {
        // A blocked write can coexist with readable persisted drafts.
      }
    }
    area.changes.set(target, value);
  }
  function nativeRead<T>(read: () => T, fallback: T): T {
    try {
      return read();
    } catch {
      return fallback;
    }
  }
  function keys(area: Storage, state: Changes) {
    const names = new Set<string>();
    if (!state.cleared) {
      const count: number = nativeRead(() => length.call(area), 0);
      for (let index = 0; index < count; index++) {
        const name = nativeRead(() => key.call(area, index), null);
        if (name !== null) names.add(name);
      }
    }
    for (const [name, value] of state.changes)
      if (value === null) names.delete(name);
      else names.add(name);
    return [...names];
  }
  function scopedGet(this: Storage, ...args: Parameters<Storage['getItem']>) {
    const [name] = args;
    const state = active.get(this);
    if (!state || typeof name !== 'string') return getItem.apply(this, args);
    const target = this === local ? mapKey(name) : name;
    if (state.changes.has(target) || state.cleared)
      return state.changes.get(target) ?? null;
    return nativeRead(() => getItem.call(this, target), null);
  }
  function scopedSet(this: Storage, ...args: Parameters<Storage['setItem']>) {
    const [name, value] = args;
    const state = active.get(this);
    if (!state || typeof name !== 'string' || args.length < 2)
      return setItem.apply(this, args);
    const target = this === local ? mapKey(name) : name;
    changesAfterWrite(state, target, String(value), () =>
      setItem.call(this, target, value),
    );
  }
  function scopedRemove(
    this: Storage,
    ...args: Parameters<Storage['removeItem']>
  ) {
    const [name] = args;
    const state = active.get(this);
    if (!state || typeof name !== 'string') return removeItem.apply(this, args);
    const target = this === local ? mapKey(name) : name;
    changesAfterWrite(state, target, null, () => removeItem.call(this, target));
  }
  Object.defineProperties(prototype, {
    getItem: { value: scopedGet },
    setItem: { value: scopedSet },
    removeItem: { value: scopedRemove },
    key: {
      value(this: Storage, index: number) {
        const state = active.get(this);
        if (!state) return key.call(this, index);
        if (!state.cleared && !state.changes.size)
          return nativeRead(() => key.call(this, index), null);
        return keys(this, state)[index] ?? null;
      },
    },
    clear: {
      value(this: Storage) {
        const state = active.get(this);
        if (!state) return clear.call(this);
        state.changes.clear();
        state.cleared = !nativeRead(() => {
          clear.call(this);
          return true;
        }, false);
      },
    },
    length: {
      get(this: Storage) {
        const state = active.get(this);
        if (!state) return length.call(this);
        if (!state.cleared && !state.changes.size)
          return nativeRead(() => length.call(this), 0);
        return keys(this, state).length;
      },
    },
  });
  if (
    local &&
    (local.getItem !== scopedGet ||
      local.setItem !== scopedSet ||
      local.removeItem !== scopedRemove)
  )
    throw Error('Employee draft storage is unavailable');
}

/** rc.2 accesses the native Storage methods directly for draft and view state.
 * Bind those keys in this document's realm before creating the native entry. */
export function installEmployeeDraftStorage({
  scopeId,
  organizationId,
  viewerId,
  selection,
  nativeSessionId,
}: ReturnType<typeof readEmployeeDocument>) {
  if (
    installed ||
    window === parent ||
    !selection.threadId ||
    !nativeSessionId ||
    conversationPrefix + nativeSessionId === widthKey
  )
    throw Error('Employee draft storage is unavailable');

  const namespaceFor = (threadId: string) =>
    managedPrefix +
    [
      organizationId,
      viewerId,
      selection.workspaceId,
      selection.employeeInstanceId,
      threadId,
    ]
      .map((id) => id.toLowerCase())
      .join('/') +
    '/';
  const initialNamespace = namespaceFor(selection.threadId);
  const namespaces = new Map([[nativeSessionId, initialNamespace]]);
  const allowedNamespaces = new Set([initialNamespace]);
  const scoped = (key: string) =>
    (namespaces.get(key.slice(conversationPrefix.length)) ?? initialNamespace) +
    key;
  function registerDraft(receipt: PageNativeThreadRegistration) {
    if (
      !receipt ||
      receipt.scopeId !== scopeId ||
      typeof receipt.nativeSessionId !== 'string' ||
      !receipt.nativeSessionId ||
      conversationPrefix + receipt.nativeSessionId === widthKey ||
      namespaces.has(receipt.nativeSessionId)
    )
      return;
    const parsed = ChatSessionSchema.safeParse(receipt.thread);
    if (!parsed.success) return;
    const thread = parsed.data;
    if (
      thread.organizationId !== organizationId ||
      thread.ownerId !== viewerId ||
      thread.workspaceId !== selection.workspaceId ||
      (thread.employeeInstanceId ?? thread.employeeAssignmentId) !==
        selection.employeeInstanceId ||
      thread.visibility !== 'private' ||
      thread.archivedAt !== null
    )
      return;
    const namespace = namespaceFor(thread.id);
    namespaces.set(receipt.nativeSessionId, namespace);
    allowedNamespaces.add(namespace);
  }
  const mapKey = (key: string) => (conversationKey(key) ? scoped(key) : key);
  const sample = scoped(conversationPrefix + nativeSessionId);
  const storage = browserStorage('localStorage', sample, mapKey);
  const session = browserStorage('sessionStorage', managedPrefix);
  if (storage || session) guardStorageMethods(storage, session, mapKey);

  window.addEventListener(
    'storage',
    (event) => {
      if (event.storageArea !== storage || !event.key) return;
      if (
        conversationKey(event.key) ||
        (event.key.startsWith(managedPrefix) &&
          !Array.from(allowedNamespaces).some((namespace) =>
            event.key!.startsWith(namespace),
          ))
      )
        event.stopImmediatePropagation();
    },
    { capture: true },
  );
  installed = true;
  return {
    registerDraft,
    registerScope(nativeId: string, threadId: string) {
      if (conversationPrefix + nativeId === widthKey)
        throw Error('Employee draft storage is unavailable');
      const next = namespaceFor(threadId);
      const registered = namespaces.get(nativeId);
      if (registered && registered !== next)
        throw Error('Employee draft session changed');
      namespaces.set(nativeId, next);
      allowedNamespaces.add(next);
    },
  };
}
