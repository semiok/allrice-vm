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
  const prototype = window.Storage.prototype;
  const { getItem, setItem, removeItem, key, clear } = prototype;
  const length = Object.getOwnPropertyDescriptor(prototype, 'length')!.get!;
  const volatile = new Map<Storage, Storage>();
  function access<T>(
    area: Storage,
    native: () => T,
    fallback: (memory: Storage) => T,
  ): T {
    if (area !== storage && area !== session) return native();
    let memory = volatile.get(area);
    if (!memory) {
      try {
        return native();
      } catch {
        // Keep one backing store after a denial, including when a write
        // first reveals it. Never fall back to the parent document's storage.
        memory = volatileStorage();
        volatile.set(area, memory);
      }
    }
    return fallback(memory);
  }
  function scopedGet(this: Storage, ...args: Parameters<Storage['getItem']>) {
    const [key] = args;
    if (typeof key !== 'string') return getItem.apply(this, args);
    const target = this === storage ? mapKey(key) : key;
    return access(
      this,
      () => getItem.call(this, target),
      (memory) => memory.getItem(target),
    );
  }
  function scopedSet(this: Storage, ...args: Parameters<Storage['setItem']>) {
    const [key, value] = args;
    if (typeof key !== 'string' || args.length < 2)
      return setItem.apply(this, args);
    const target = this === storage ? mapKey(key) : key;
    access(
      this,
      () => setItem.call(this, target, value),
      (memory) => memory.setItem(target, value),
    );
  }
  function scopedRemove(
    this: Storage,
    ...args: Parameters<Storage['removeItem']>
  ) {
    const [key] = args;
    if (typeof key !== 'string') return removeItem.apply(this, args);
    const target = this === storage ? mapKey(key) : key;
    access(
      this,
      () => removeItem.call(this, target),
      (memory) => memory.removeItem(target),
    );
  }
  if (storage || session) {
    Object.defineProperties(prototype, {
      getItem: { value: scopedGet },
      setItem: { value: scopedSet },
      removeItem: { value: scopedRemove },
      key: {
        value(this: Storage, index: number) {
          return access(
            this,
            () => key.call(this, index),
            (memory) => memory.key(index),
          );
        },
      },
      clear: {
        value(this: Storage) {
          access(
            this,
            () => clear.call(this),
            (memory) => memory.clear(),
          );
        },
      },
      length: {
        get(this: Storage) {
          return access(
            this,
            () => length.call(this),
            (memory) => memory.length,
          );
        },
      },
    });
    if (
      storage &&
      (storage.getItem !== scopedGet ||
        storage.setItem !== scopedSet ||
        storage.removeItem !== scopedRemove)
    )
      throw Error('Employee draft storage is unavailable');
  }

  window.addEventListener(
    'storage',
    (event) => {
      if (event.storageArea !== storage || !event.key || volatile.has(storage))
        return;
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
