import { renderMemoryIndexV2 } from '@allrice/contracts';

type MemoryIndexItems = Parameters<typeof renderMemoryIndexV2>[0];
const workspaceReadInstruction =
  'Confirmed memory summaries. Read marked details with workspace_memory_read(number)';

/** DSH names the model-facing tool using the managed `allrice` connection.
 * The shorter first sentence keeps the full V2 index within its byte limit. */
export function renderNativeMemoryIndexV2(items: MemoryIndexItems) {
  return renderMemoryIndexV2(items).replace(
    workspaceReadInstruction,
    'Confirmed summaries. Read marked details with mcp__allrice__memory_read(number)',
  );
}

/** Existing 4.0 contexts keep the exact initial text, hash and budget. */
export function matchesStoredNativeMemoryIndexV2(
  items: MemoryIndexItems,
  document: string,
) {
  return (
    document === renderNativeMemoryIndexV2(items) ||
    document ===
      renderMemoryIndexV2(items).replace(
        workspaceReadInstruction,
        'Confirmed memory summaries. Read marked details with memory_read(number)',
      )
  );
}
