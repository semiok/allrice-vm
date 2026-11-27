import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Run only inside the isolated build child, using the released launcher's
 * real application-readiness lifecycle. Never a SaaS Host or identity source. */
export async function collectProfileArtifacts({
  outputDirectory,
  dshHome,
  packageRoot,
  installAnchor,
  resolutionAnchor = installAnchor,
  host,
  terminalEnabled = true,
}) {
  const require = createRequire(resolutionAnchor);
  const fromNative = (name) =>
    import(pathToFileURL(require.resolve(name)).href);
  const { loadProfileDirectory, loadLayeredEnv } = await fromNative(
    '@deepseek-ai/dsh-app-boot',
  );
  const { runProfile } = await fromNative('@deepseek-ai/dsh/profile-boot');
  const { bootInjections } = await fromNative(
    '@deepseek-ai/dsh-client-modules',
  );
  const profileDir = join(dshHome, 'profiles/allrice-web');
  await mkdir(join(profileDir, 'node_modules/@allrice'), { recursive: true });
  const contribution = join(
    profileDir,
    'node_modules/@allrice/dsh-web-composition',
  );
  if (contribution !== packageRoot)
    await symlink(packageRoot, contribution, 'dir');
  await writeFile(
    join(profileDir, 'package.json'),
    await readFile(join(packageRoot, 'profiles/allrice-web/package.json')),
  );
  const overlay = join(profileDir, 'build-only.patch.yml');
  await writeFile(
    overlay,
    JSON.stringify([
      {
        id: 'web-runtime',
        config: { openBrowser: false, printUrl: false, surfaceContext: true },
      },
      ...(terminalEnabled
        ? []
        : [
            { id: 'terminal-controller', disabled: true },
            { id: 'ui-sidebar-terminal', disabled: true },
          ]),
    ]),
  );
  const profile = loadProfileDirectory(
    'allrice-artifact',
    profileDir,
    installAnchor,
  );
  if (profile.skippedBundles.length)
    throw new Error('Profile bundle unavailable');
  // Installation-first may find an older workspace package's patch. Accept it
  // only when its complete patch bytes and dsh metadata equal this source.
  const ownMetadata = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  const allriceLayer = profile.layers.find(
    (layer) => layer.packageName === ownMetadata.name,
  );
  if (
    !allriceLayer ||
    allriceLayer.patchPaths.length !== 1 ||
    !Buffer.from(await readFile(allriceLayer.patchPaths[0])).equals(
      await readFile(join(packageRoot, 'cordis.patch.yml')),
    ) ||
    JSON.stringify(
      JSON.parse(
        await readFile(join(allriceLayer.packageDir, 'package.json'), 'utf8'),
      ).dsh,
    ) !== JSON.stringify(ownMetadata.dsh)
  )
    throw new Error('Profile bundle differs from the current AllRice source');
  let root;
  try {
    ({ ctx: root } = await runProfile({
      profile: 'allrice-web',
      resolvedProfile: { profile, installAnchor },
      environment: loadLayeredEnv('allrice-artifact'),
      patchFiles: [overlay],
      args: ['--host', host, '--port', '0', '--no-open'],
    }));
    const modules = root.get('clientModules');
    const web = root.get('webServer');
    if (!modules || !web)
      throw new Error('Public artifact services unavailable');
    if (
      (await realpath(modules.clientPath(ownMetadata.name))) !==
      (await realpath(join(packageRoot, 'dist/client.js')))
    )
      throw new Error('Profile did not select the source-built AllRice client');
    if (web.host !== host)
      throw new Error('Employee profile listener mismatch');
    const graph = modules.graph();
    const terminalUi = graph.entries.some(
      ({ id }) => id === '@deepseek-ai/dsh-client-ui-sidebar-terminal',
    );
    if (
      Boolean(root.get('terminalController')) !== terminalEnabled ||
      terminalUi !== terminalEnabled
    )
      throw new Error('Employee profile terminal configuration mismatch');
    const picker = graph.entries.filter(({ id }) =>
      id.startsWith('@deepseek-ai/dsh-client-ui-directory-picker-'),
    );
    if (
      picker.length !== 1 ||
      picker[0].id !== '@deepseek-ai/dsh-client-ui-directory-picker-browse'
    )
      throw new Error('Unexpected employee directory picker');
    const rows = web.collectIndexInjections();
    const moduleRows = new Set(
      bootInjections(graph).map((row) => JSON.stringify(row)),
    );
    const files = [];
    const chunks = [];
    const references = [
      ...new Set([...graph.entries, ...graph.batches].map((row) => row.url)),
    ];
    for (const { id, rev } of graph.entries) {
      const entry = modules.clientPath(id);
      if (!entry)
        throw new Error('Employee browser bundle has no client entry');
      const siblings = await readdir(dirname(entry), { withFileTypes: true });
      for (const file of siblings.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        // Match rc.2's package-local browser chunk convention.
        if (
          !file.isFile() ||
          !/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u.test(file.name) ||
          file.name === 'client.node.js' ||
          file.name.startsWith('client.node.')
        )
          continue;
        chunks.push({ module: id, file: file.name });
        references.push(`plugins/${id}/${file.name}?rev=${rev}`);
      }
    }
    for (const reference of references) {
      const url = new URL(reference, 'http://127.0.0.1/');
      const response = await modules.fetchBundle(new globalThis.Request(url));
      if (!response.ok)
        throw new Error('Advertised profile bundle unavailable');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const path = 'plugins/' + sha256(Buffer.from(reference)) + '.js';
      await writeFile(join(outputDirectory, path), bytes);
      files.push({
        reference,
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
      const mapReference = Buffer.from(bytes)
        .toString('utf8')
        .match(/\/\/# sourceMappingURL=([^\r\n]+)\s*$/)?.[1];
      if (mapReference) {
        const mapUrl = new URL(mapReference.trim(), url);
        if (
          mapUrl.origin !== url.origin ||
          !mapUrl.pathname.startsWith('/plugins/')
        )
          throw new Error('Profile advertised an external source-map resource');
        const map = await modules.fetchBundle(new globalThis.Request(mapUrl));
        if (!map.ok)
          throw new Error('Advertised profile source map unavailable');
        const mapBytes = new Uint8Array(await map.arrayBuffer());
        const mapName = mapUrl.pathname.slice(1) + mapUrl.search;
        const mapPath = 'plugins/' + sha256(Buffer.from(mapName)) + '.map';
        await writeFile(join(outputDirectory, mapPath), mapBytes);
        files.push({
          reference: mapName,
          path: mapPath,
          bytes: mapBytes.length,
          sha256: sha256(mapBytes),
        });
      }
    }
    const result = {
      graph,
      bootInjections: bootInjections(graph),
      files,
      chunks,
      // No collected values are emitted: owner:true and current configuration
      // must never become a release's replayable runtime identity/preferences.
      injectionInputs: rows.map((row) => ({
        kind: row.kind,
        name: row.kind === 'global' ? row.name : null,
        classification:
          row.kind === 'global' && row.name === '__DSH_REMOTE_ACCESS__'
            ? 'runtime-authority-unbound'
            : moduleRows.has(JSON.stringify(row))
              ? row.kind === 'script'
                ? 'release-code'
                : 'release-authority-unbound'
              : 'runtime-config-unbound',
        source: moduleRows.has(JSON.stringify(row))
          ? '@deepseek-ai/dsh-client-modules#bootInjections'
          : 'collectIndexInjections: current Host runtime input, not static release data',
      })),
      buildOwnerObserved: rows.some(
        (row) =>
          row.kind === 'global' &&
          row.name === '__DSH_REMOTE_ACCESS__' &&
          row.value?.owner === true,
      ),
      sourceBuiltClient: true,
    };
    await writeFile(
      join(outputDirectory, 'profile-code.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
  } finally {
    await root?.fiber.dispose();
  }
}
