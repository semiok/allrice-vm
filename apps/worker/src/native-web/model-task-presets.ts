import { composeEntries } from '@deepseek-ai/dsh-app-boot';
import type { ModelRouteKey } from '@allrice/model-gateway';
import { PersonVmError } from '@allrice/person-vm';
import {
  nativeSearchToolPatches,
  nativeWebBundlePatches,
} from './search-tools.js';

type Entry = {
  id?: string;
  name?: string;
  group?: boolean;
  config?: unknown;
};
type Options = Readonly<{ title?: ModelRouteKey; compaction?: ModelRouteKey }>;

function record(config: unknown): Record<string, unknown> {
  return config && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

export function nativeScopedModelPatches(options: Options) {
  const search = nativeSearchToolPatches(false);
  if (!options.compaction && !options.title) return search;

  const entries = composeEntries([...nativeWebBundlePatches(), search]);
  const patches: { id: string; config: Record<string, unknown> }[] = [];
  if (options.title) {
    const entry = entries.find(
      ({ id, name }) =>
        id === 'session-title-llm' &&
        name === '@deepseek-ai/dsh-session-title-first-prompt-llm',
    );
    if (!entry?.id) throw new PersonVmError('PROVIDER_FAILED');
    patches.push({
      id: entry.id,
      config: { ...record(entry.config), ...options.title },
    });
  }
  if (!options.compaction) return [...search, ...patches];

  const summarizer = {
    summarizationProvider: options.compaction.provider,
    summarizationModel: options.compaction.model,
  };
  // Native Web owns compaction inside its presets. Preserve the other
  // plugins and the search overlay when replacing the preset configuration.
  function patchCompaction(plugins: readonly Entry[]): {
    plugins: Entry[];
    changed: boolean;
  } {
    let changed = false;
    const updated = plugins.map((entry) => {
      if (entry.name === '@deepseek-ai/dsh-compaction-basic') {
        changed = true;
        return { ...entry, config: { ...record(entry.config), ...summarizer } };
      }
      if (!entry.group || !Array.isArray(entry.config)) return entry;
      const nested = patchCompaction(entry.config);
      changed ||= nested.changed;
      return { ...entry, config: nested.plugins };
    });
    return { plugins: updated, changed };
  }
  const changedPresets = new Set<string>();
  for (const entry of entries) {
    if (entry.name !== '@deepseek-ai/dsh-agent-preset' || !entry.id) continue;
    const config = record(entry.config);
    if (!Array.isArray(config.plugins)) continue;
    const result = patchCompaction(config.plugins);
    if (!result.changed) continue;
    changedPresets.add(entry.id);
    patches.push({
      id: entry.id,
      config: { ...config, plugins: result.plugins },
    });
  }
  if (!changedPresets.size) throw new PersonVmError('PROVIDER_FAILED');
  return [
    ...search.filter(({ id }) => !id || !changedPresets.has(id)),
    ...patches,
  ];
}
