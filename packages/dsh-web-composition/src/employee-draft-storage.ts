import { ChatSessionSchema } from '@allrice/contracts';
import type { PageNativeThreadRegistration } from '../../../apps/web/lib/d-entry/page-messages';
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
  const storage = window.localStorage;
  const prototype = window.Storage.prototype;
  const { getItem, setItem, removeItem } = prototype;
  // Access can fail in a browser which withholds storage for this frame.
  const sample = scoped(conversationPrefix + nativeSessionId);
  const stored = getItem.call(storage, sample);
  function scopedGet(this: Storage, ...args: Parameters<Storage['getItem']>) {
    const [key] = args;
    if (this !== storage || typeof key !== 'string')
      return getItem.apply(this, args);
    return getItem.call(this, conversationKey(key) ? scoped(key) : key);
  }
  function scopedSet(this: Storage, ...args: Parameters<Storage['setItem']>) {
    const [key, value] = args;
    if (this !== storage || typeof key !== 'string' || args.length < 2)
      return setItem.apply(this, args);
    setItem.call(this, conversationKey(key) ? scoped(key) : key, value);
  }
  function scopedRemove(
    this: Storage,
    ...args: Parameters<Storage['removeItem']>
  ) {
    const [key] = args;
    if (this !== storage || typeof key !== 'string')
      return removeItem.apply(this, args);
    removeItem.call(this, conversationKey(key) ? scoped(key) : key);
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
