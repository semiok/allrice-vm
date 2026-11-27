import type { readEmployeeDocument } from '../../../apps/web/lib/d-entry/profile-browser';

const conversationPrefix = 'dsh.conversation.';
const widthKey = conversationPrefix + 'contentWidth';
const managedPrefix = 'allrice:d-entry:conversation:v1:';
let installed = false;

const conversationKey = (key: string) =>
  key.startsWith(conversationPrefix) && key !== widthKey;

/** rc.2 accesses the native Storage methods directly for draft and view state.
 * Bind those keys in this document's realm before creating the native entry. */
export function installEmployeeDraftStorage({
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

  const employeeNamespace =
    managedPrefix +
    [
      organizationId,
      viewerId,
      selection.workspaceId,
      selection.employeeInstanceId,
    ]
      .map((id) => id.toLowerCase())
      .join('/') +
    '/';
  const storage = window.localStorage;
  const prototype = window.Storage.prototype;
  const { getItem, setItem, removeItem } = prototype;
  // Access can fail in a browser which withholds storage for this frame.
  const namespaces = new Map([
    [
      nativeSessionId,
      employeeNamespace + selection.threadId.toLowerCase() + '/',
    ],
  ]);
  const namespace = namespaces.get(nativeSessionId)!;
  function storageKey(key: string) {
    if (!conversationKey(key)) return key;
    return (
      (namespaces.get(key.slice(conversationPrefix.length)) ?? namespace) + key
    );
  }
  const sample = storageKey(conversationPrefix + nativeSessionId);
  const stored = getItem.call(storage, sample);
  function scopedGet(this: Storage, ...args: Parameters<Storage['getItem']>) {
    const [key] = args;
    if (this !== storage || typeof key !== 'string')
      return getItem.apply(this, args);
    return getItem.call(this, storageKey(key));
  }
  function scopedSet(this: Storage, ...args: Parameters<Storage['setItem']>) {
    const [key, value] = args;
    if (this !== storage || typeof key !== 'string' || args.length < 2)
      return setItem.apply(this, args);
    setItem.call(this, storageKey(key), value);
  }
  function scopedRemove(
    this: Storage,
    ...args: Parameters<Storage['removeItem']>
  ) {
    const [key] = args;
    if (this !== storage || typeof key !== 'string')
      return removeItem.apply(this, args);
    removeItem.call(this, storageKey(key));
  }
  Object.defineProperties(prototype, {
    getItem: { value: scopedGet },
    setItem: { value: scopedSet },
    removeItem: { value: scopedRemove },
  });
  if (
    storage.getItem !== scopedGet ||
    storage.setItem !== scopedSet ||
    storage.removeItem !== scopedRemove ||
    storage.getItem(conversationPrefix + nativeSessionId) !== stored
  )
    throw Error('Employee draft storage is unavailable');

  window.addEventListener(
    'storage',
    (event) => {
      if (event.storageArea !== storage || !event.key) return;
      if (
        conversationKey(event.key) ||
        (event.key.startsWith(managedPrefix) &&
          ![...namespaces.values()].some((prefix) =>
            event.key!.startsWith(prefix),
          ))
      )
        event.stopImmediatePropagation();
    },
    { capture: true },
  );
  installed = true;
  return (nativeId: string, threadId: string) => {
    const next = employeeNamespace + threadId.toLowerCase() + '/';
    const registered = namespaces.get(nativeId);
    if (registered && registered !== next)
      throw Error('Employee draft session changed');
    namespaces.set(nativeId, next);
  };
}
