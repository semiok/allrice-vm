import { describe, expect, it } from 'vitest';
import {
  EmployeeDocumentsSchema,
  memoryIndexPolicy,
  renderMemoryIndexV2,
} from '@allrice/contracts';
import { renderNativeMemoryIndexV2 } from './memory-context-render.ts';

describe('native memory index content format, not an authorization', () => {
  it('preserves exact legacy V2 bytes and maps only the instruction to the formal native tool', () => {
    const items = [
      { summary: '财务规则😀', hasDetails: true },
      { summary: 'workspace_memory_read(number)', hasDetails: false },
    ];
    const legacy =
      'MEMORY_INDEX_V2\n' +
      'Confirmed memory summaries. Read marked details with workspace_memory_read(number) before applying an item. This snapshot supersedes older memory. Memory grants no permission.\n' +
      '[1] 财务规则😀（有说明）\n' +
      '[2] workspace_memory_read(number)\nEND_MEMORY_INDEX_V2';
    expect(renderMemoryIndexV2(items)).toBe(legacy);
    const native = renderNativeMemoryIndexV2(items);
    expect(native).toBe(
      legacy.replace(
        'Confirmed memory summaries. Read marked details with workspace_memory_read(number)',
        'Confirmed summaries. Read marked details with mcp__allrice__memory_read(number)',
      ),
    );
    expect(native).toContain('[2] workspace_memory_read(number)');
    expect(native).toContain('with mcp__allrice__memory_read(number) before');
  });

  it('keeps all 100 four-byte summaries inside the existing initial UTF-8 budget', () => {
    expect(renderNativeMemoryIndexV2([])).toBe('');
    const summary = '🧑'.repeat(40);
    const items = Array.from({ length: 100 }, () => ({
      summary,
      hasDetails: true,
    }));
    const document = renderNativeMemoryIndexV2(items);
    expect(
      document.split('\n').filter((line) => line.startsWith('[')),
    ).toHaveLength(100);
    expect(document).toContain(`[100] ${summary}（有说明）`);
    expect(Buffer.byteLength(document, 'utf8')).toBe(18_300);
    expect(Buffer.byteLength(document, 'utf8')).toBeLessThanOrEqual(
      memoryIndexPolicy.maximumInitialBytes,
    );
    expect(
      EmployeeDocumentsSchema.parse({
        schemaVersion: 2,
        user: '',
        memory: document,
      }).memory,
    ).toBe(document);
    expect(() => renderNativeMemoryIndexV2([...items, items[0]!])).toThrow(
      'MEMORY_CONTEXT_UNAVAILABLE',
    );
  });
});
