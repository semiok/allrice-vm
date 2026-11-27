#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { stagePersonVmConfiguration } from './stage-person-vm-config.mjs';
import { resolveServiceBuildSource } from './prepare-identity-root.mjs';
import { stageDshProfileAssets } from './stage-dsh-profile-assets.mjs';
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
const hostConfigurationPath = '.local/person-vm-host.json';
const hostConfiguration = await open(
  join(root, hostConfigurationPath),
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
).catch((error) => {
  if (error?.code !== 'ENOENT') throw error;
  return undefined;
});
let hostConfigurationChecksum;
if (hostConfiguration) {
  let config;
  try {
    const stat = await hostConfiguration.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 64 * 1024 ** 2
    )
      throw Error('Invalid private configuration');
    const bytes = await hostConfiguration.readFile();
    if (bytes.length !== stat.size)
      throw Error('Invalid private configuration');
    config = JSON.parse(bytes.toString('utf8'));
    hostConfigurationChecksum =
      'sha256:' + createHash('sha256').update(bytes).digest('hex');
  } catch {
    throw Error('DEV_BUILD_PRIVATE_CONFIG_INVALID');
  } finally {
    await hostConfiguration.close();
  }
  const { employeeProfileRuntime } =
    await import('../person-vm-image/verify.mjs');
  const configuredTerminal = config?.web?.terminalEnabled;
  if (
    configuredTerminal !== undefined &&
    typeof configuredTerminal !== 'boolean'
  )
    throw Error('DEV_BUILD_PRIVATE_CONFIG_INVALID');
  const terminalEnabled = configuredTerminal ?? true;
  const runtime = employeeProfileRuntime(config?.native);
  const { prepareEmployeeWebServiceArtifact } =
    await import('../../packages/dsh-web-composition/build-web-entry.mjs');
  const linuxCapture = runtime
    ? (
        await import('../person-vm-image/employee-profile.mjs')
      ).createEmployeeLinuxCapture(config.native, {
        ...runtime,
        terminalEnabled,
      })
    : undefined;
  await prepareEmployeeWebServiceArtifact(
    join(root, 'apps/worker/dist/d-entry-web'),
    sourceSha,
    linuxCapture,
    terminalEnabled,
  );
  await stageDshProfileAssets(root, sourceSha);
}
const manifest = await prepareServiceBuildManifest(source);
// The build inventory reopens the staged file. Its bytes must be the ones
// that selected and supplied the profile capture, including absence.
const sealedHostConfiguration = manifest.files.find(
  ({ path, scope }) => path === hostConfigurationPath && scope === 'worker',
);
if (sealedHostConfiguration?.checksum !== hostConfigurationChecksum)
  throw Error('DEV_BUILD_PRIVATE_CONFIG_CHANGED');
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
