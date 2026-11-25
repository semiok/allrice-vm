#!/usr/bin/env node
import { lstat, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { stagePersonVmConfiguration } from './stage-person-vm-config.mjs';
import { resolveServiceBuildSource } from './prepare-identity-root.mjs';
import { prepareServiceBuildManifest } from '../../packages/database/dist/service-build-identity.js';
import {
  measureDshNativeArtifact,
  nativeArtifactPath,
} from '../../apps/worker/dist/harness/dsh-native-artifact.js';

const args = process.argv.slice(2);
const option = (key) => {
  const values = args.filter((s) => s.startsWith(key + '='));
  if (values.length !== 1) throw Error('DEV_BUILD_PREPARATION_ARGUMENT');
  return values[0].slice(key.length + 1);
};
const configArgs = args.filter((s) => s.startsWith('--person-vm-config='));
if (args.length !== 2 + configArgs.length || configArgs.length > 1)
  throw Error('DEV_BUILD_PREPARATION_ARGUMENT');
const source = await resolveServiceBuildSource(
  option('--root'),
  option('--release-sha'),
);
const { root, sourceSha } = source;
if (configArgs.length)
  await stagePersonVmConfiguration(
    root,
    configArgs[0].slice('--person-vm-config='.length),
  );
const hostConfiguration = await lstat(
  join(root, '.local/person-vm-host.json'),
).catch((error) => {
  if (error?.code !== 'ENOENT') throw error;
  return undefined;
});
if (hostConfiguration) {
  if (!hostConfiguration.isFile()) throw Error('DEV_BUILD_IDENTITY_INVALID');
  const { prepareEmployeeWebServiceArtifact } =
    await import('../../packages/dsh-web-composition/build-web-entry.mjs');
  await prepareEmployeeWebServiceArtifact(
    join(root, 'apps/worker/dist/d-entry-web'),
    sourceSha,
  );
}
const manifest = await prepareServiceBuildManifest(source);
const nativeArtifact = await measureDshNativeArtifact(root, undefined, {
  schemaVersion: 2,
});
nativeArtifact.source = { sha: sourceSha, tree: manifest.sourceTree };
await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
const target = join(root, '.local/dev-build-identity.json'),
  temp = target + '.tmp';
await writeFile(temp, JSON.stringify(manifest, null, 2) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
const nativeTarget = join(root, nativeArtifactPath),
  nativeTemp = nativeTarget + '.tmp';
await writeFile(nativeTemp, JSON.stringify(nativeArtifact, null, 2) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
await rename(temp, target);
await rename(nativeTemp, nativeTarget);
console.log(
  JSON.stringify({
    repository: manifest.repository,
    repositoryId: manifest.repositoryId,
    sourceSha,
    sourceTree: manifest.sourceTree,
    manifestDigest: manifest.manifestDigest,
    fileCount: manifest.files.length,
    webBuildId: manifest.webBuildId,
    releaseAdmission: 'disabled',
    nativeArtifactId: nativeArtifact.artifactId,
    nativeArtifactSchemaVersion: nativeArtifact.content.schemaVersion,
    nativePackageCount: nativeArtifact.content.packages.length,
    nativeArtifactApprovalGranted: false,
  }),
);
