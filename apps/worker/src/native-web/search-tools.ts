import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import {
  bundlePatchPaths,
  composeEntries,
  loadOverlayPatches,
  readProfileManifest,
} from '@deepseek-ai/dsh-app-boot';
import { PersonVmError } from '@allrice/person-vm';

export function nativeWebBundlePatches() {
  const require = createRequire(import.meta.url);
  return ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].map((name) => {
    const directory = dirname(require.resolve(name + '/package.json'));
    const bundle = readProfileManifest('dsh', directory).dsh?.bundle;
    if (!bundle) throw new PersonVmError('PROVIDER_FAILED');
    return bundlePatchPaths(directory, bundle).flatMap((path) =>
      loadOverlayPatches('dsh', path),
    );
  });
}

export function nativeSearchToolPatches(webSearchEnabled: boolean) {
  if (webSearchEnabled) return [];

  // The Web bundle disables the root tool and mounts tools inside presets.
  // Cordis replaces preset config as a whole, so preserve the native config.
  const patches = composeEntries(nativeWebBundlePatches()).flatMap((entry) => {
    if (entry.name !== '@deepseek-ai/dsh-agent-preset') return [];
    const plugins = entry.config?.plugins as
      { name: string; config?: Record<string, unknown> }[] | undefined;
    if (!plugins?.some((plugin) => plugin.name === '@deepseek-ai/dsh-tool-web'))
      return [];
    return [
      {
        id: entry.id,
        config: {
          ...entry.config,
          plugins: plugins.map((plugin) =>
            plugin.name === '@deepseek-ai/dsh-tool-web'
              ? { ...plugin, config: { ...plugin.config, search: false } }
              : plugin,
          ),
        },
      },
    ];
  });
  if (!patches.length) throw new PersonVmError('PROVIDER_FAILED');
  return patches;
}
