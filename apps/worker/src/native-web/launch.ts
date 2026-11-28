import { nativeScopedModelPatches } from './model-task-presets.js';
import type { ModelRouteKey, ScopedModelRule } from '@allrice/model-gateway';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import {
  DEntrySelectionInputSchema,
  type DEntryIdentity,
} from '@allrice/contracts';
import { readDEntryPrincipalHostArtifact } from '../d-entry/principal-artifact.js';
import type { readReleasedGuestProfile } from '../d-entry/released-profile.js';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import {
  isMicrosandboxGuestIpv4,
  nativeWebAuthArtifact,
  PersonVmError,
  type PersonVmBinding,
  type PersonVmGuestCommand,
  type PersonVmMemoryGuestPlan,
  type PersonVmNativeWebAuthRequest,
  type PersonVmNativeWebGuestAddress,
} from '@allrice/person-vm';
import type { createPersonVmDshCommandMemoryPatch } from '@allrice/vm-memory/guest-plan';
import { nativeSearchToolPatches } from './search-tools.js';

/** Trusted host configuration for an ALREADY published loopback endpoint. No
 * port allocation, guest-selected target, or running-VM restart is performed. */
export type NativeWebConfiguration = Readonly<{
  origin: string;
  publicUrl: string;
  guestPort: number;
  dshHome: string;
  agentsHome: string;
  workdir: string;
  cliPath: string;
  startupTimeoutMs: number;
  terminalEnabled?: boolean;
  principalProfile: Pick<
    DEntryIdentity,
    | 'workspaceId'
    | 'employeeInstanceId'
    | 'employeeRevision'
    | 'employeeVersionId'
  >;
}>;
export type NativeWebLaunch = Readonly<{
  binding: PersonVmBinding;
  auth: PersonVmNativeWebAuthRequest;
  files: PersonVmMemoryGuestPlan['files'];
  command: PersonVmGuestCommand;
}>;
export type NativeWebLaunchPlan = Omit<NativeWebLaunch, 'command'> &
  Readonly<{ commandWithoutHost: PersonVmGuestCommand }>;
export type NativeWebModelAdapter = Readonly<{
  origin: string;
  capability: string;
  provider: string;
  model: string;
  modelInfo: LlmResolvedModelInfo;
  scoped?: Readonly<{
    rules: readonly ScopedModelRule[];
    compaction?: ModelRouteKey;
    title?: ModelRouteKey;
    models: readonly {
      provider: string;
      model: string;
      modelInfo: LlmResolvedModelInfo;
    }[];
  }>;
  historicalModels?: readonly LlmResolvedModelInfo[];
  webSearchEnabled?: boolean;
}>;

async function managedModelFiles(directory: string, cliPath: string) {
  const resolve = createRequire(import.meta.url);
  const dist = dirname(resolve.resolve('@allrice/model-gateway'));
  const modules = await Promise.all(
    ['dsh-provider.js', 'contract.js', 'scoped-routes.js'].map(
      async (name) => ({
        path: posix.join(directory, name),
        contents: await readFile(join(dist, name), 'utf8'),
        mode: 0o600,
      }),
    ),
  );
  return [
    ...modules,
    {
      path: posix.join(directory, 'package.json'),
      contents: '{"type":"module"}',
      mode: 0o600,
    },
    {
      path: posix.join(directory, 'native-llm.js'),
      contents: `import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(${JSON.stringify(cliPath)});
export const { LlmAdapter, LlmError } = await import(
  pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href
);
`,
      mode: 0o600,
    },
  ];
}

export type NativeWebGuestProfile = Awaited<
  ReturnType<typeof readReleasedGuestProfile>
>;

/** Public Web entry with selectors only. Its normal login and current identity
 * checks still authorize the document and native operations. */
export function dEntryNativePublicUrl(
  origin: string,
  endpoint: Pick<DEntryIdentity, 'workspaceId' | 'employeeInstanceId'>,
) {
  const selection = DEntrySelectionInputSchema.parse({
    workspaceId: endpoint.workspaceId,
    employeeInstanceId: endpoint.employeeInstanceId,
  });
  return new URL(
    `/chatflow/4.0/${selection.workspaceId}/${selection.employeeInstanceId}/`,
    origin,
  ).href;
}

export async function prepareNativeWebLaunch(
  config: NativeWebConfiguration,
  binding: PersonVmBinding,
  profile: NativeWebGuestProfile,
  commandMemory?: ReturnType<typeof createPersonVmDshCommandMemoryPatch>,
  modelAdapter?: NativeWebModelAdapter,
): Promise<NativeWebLaunchPlan> {
  let origin: URL, publicUrl: URL;
  try {
    origin = new URL(config.origin);
    publicUrl = new URL(config.publicUrl);
  } catch {
    throw new PersonVmError('PROVIDER_FAILED');
  }
  const auth = Object.freeze({
    dshHome: config.dshHome,
    nonce: randomUUID(),
    ...(modelAdapter
      ? { modelAdapterId: randomBytes(32).toString('hex') }
      : {}),
    origin: origin.href,
    timeoutMs: config.startupTimeoutMs,
  });
  const artifact = nativeWebAuthArtifact(auth);
  if (
    !Number.isInteger(config.guestPort) ||
    config.guestPort < 1 ||
    config.guestPort > 65535 ||
    !['http:', 'https:'].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    config.publicUrl.includes('?') ||
    config.publicUrl.includes('#') ||
    [config.agentsHome, config.workdir, config.cliPath].some(
      (path) =>
        !posix.isAbsolute(path) ||
        posix.normalize(path) !== path ||
        path.includes('\0'),
    )
  )
    throw new PersonVmError('PROVIDER_FAILED');
  const directory = `${config.dshHome}/native-web`;
  const profileDirectory = `${config.dshHome}/profiles/allrice-web`;
  if (
    !profile.some(({ path }) => path === 'package.json') ||
    profile.some(
      ({ path }) =>
        posix.isAbsolute(path) ||
        posix.normalize(path) !== path ||
        /(?:^|\/)\.\.(?:\/|$)|\0/.test(path),
    )
  )
    throw new PersonVmError('PROVIDER_FAILED');
  const modelDirectory = posix.join(directory, 'model-gateway');
  const modelFiles = modelAdapter
    ? await managedModelFiles(modelDirectory, config.cliPath)
    : [];
  const principalPlugin = `${directory}/current-principal.mjs`;
  const principalSource = await readDEntryPrincipalHostArtifact();
  const plugin = `${directory}/owner.mjs`,
    patch = `${directory}/owner.patch.json`;
  const ownerSource = await readFile(
    new URL(
      modelAdapter
        ? '../../dist/guest-native-web-owner.mjs'
        : '../../dsh/allrice-native-web-owner.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  const journalSource = await readFile(
    new URL(
      modelAdapter
        ? '../../dist/allrice-native-run-journal.mjs'
        : '../../dsh/allrice-native-run-journal.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  const deliverySource = await readFile(
    new URL('../../dsh/allrice-native-delivery-capture.mjs', import.meta.url),
    'utf8',
  );
  const modelOwner = `${directory}/owner-with-model.mjs`;
  const searchPlugin = `${directory}/allrice-managed-web-search.mjs`;
  const searchSource = modelAdapter
    ? await readFile(
        new URL('../../dsh/allrice-managed-web-search.mjs', import.meta.url),
        'utf8',
      )
    : undefined;
  return Object.freeze({
    binding: Object.freeze({ ...binding }),
    auth,
    files: Object.freeze([
      { path: plugin, contents: ownerSource, mode: 0o600 },
      {
        path: `${directory}/allrice-native-delivery-capture.mjs`,
        contents: deliverySource,
        mode: 0o600,
      },
      {
        path: `${directory}/allrice-native-run-journal.mjs`,
        contents: journalSource,
        mode: 0o600,
      },
      ...(modelAdapter
        ? [
            {
              path: modelOwner,
              mode: 0o600,
              contents: `import { applyNativeWebOwner } from './owner.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { registerManagedGatewayAdapter } from './model-gateway/dsh-provider.js';
import { selectScopedModel } from './model-gateway/scoped-routes.js';
import { apply as applyManagedSearch, observeManagedSearchCalls } from './allrice-managed-web-search.mjs';
export { inject, name } from './owner.mjs';
export function apply(ctx, config) {
  return applyNativeWebOwner(ctx, config, registerManagedGatewayAdapter, {
    async applyManagedSearch(scope, settings) {
      const require = createRequire(settings.cliPath);
      const { WebError } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-web')).href);
      return applyManagedSearch(scope, settings, WebError);
    },
    observeManagedSearchCalls,
    selectScopedModel,
  });
}
`,
            },
          ]
        : []),
      ...(searchSource
        ? [{ path: searchPlugin, contents: searchSource, mode: 0o600 }]
        : []),
      ...modelFiles,
      { path: principalPlugin, contents: principalSource, mode: 0o600 },
      {
        path: patch,
        contents: JSON.stringify([
          {
            id: 'web-runtime',
            // rc.2 replaces config as a whole; CLI webStartup values are not merged.
            config: {
              openBrowser: false,
              publicUrl: publicUrl.href,
              surfaceContext: true,
              printUrl: false,
            },
          },
          {
            insert: [
              {
                id: 'allrice-current-principal',
                name: `file://${principalPlugin}`,
                config: {
                  profile: config.principalProfile,
                  binding,
                  moduleBase: config.cliPath,
                },
              },
              {
                id: 'allrice-native-web-owner',
                name: `file://${modelAdapter ? modelOwner : plugin}`,
                config: {
                  artifactPath: artifact.path,
                  nonce: auth.nonce,
                  baseUrl: auth.origin,
                  workdir: config.workdir,
                  ...(modelAdapter
                    ? {
                        modelAdapter: {
                          ...modelAdapter,
                          id: auth.modelAdapterId,
                          cliPath: config.cliPath,
                        },
                      }
                    : {}),
                  ...(commandMemory
                    ? { commandMemoryPlugin: commandMemory[2].insert[0].name }
                    : {}),
                },
              },
            ],
          },
          ...(config.terminalEnabled === false
            ? [
                { id: 'terminal-controller', disabled: true },
                { id: 'ui-sidebar-terminal', disabled: true },
              ]
            : []),
          ...(commandMemory ?? []),
          ...(modelAdapter
            ? [
                { id: 'llm-pi-ai', disabled: true },
                { id: 'web-search-deepseek', disabled: true },
                ...(modelAdapter.scoped
                  ? nativeScopedModelPatches(modelAdapter.scoped)
                  : nativeSearchToolPatches(
                      modelAdapter.webSearchEnabled === true,
                    )),
                {
                  id: 'agent-default-model',
                  config: {
                    provider: modelAdapter.provider,
                    model: modelAdapter.model,
                  },
                },
              ]
            : []),
        ]),
        mode: 0o600,
      },
      ...profile.map(({ path, contents }) => ({
        path: `${profileDirectory}/${path}`,
        contents,
        mode: 0o600,
      })),
    ]),
    commandWithoutHost: Object.freeze({
      executable: 'node',
      args: Object.freeze([
        config.cliPath,
        '--profile',
        'allrice-web',
        '--patch',
        patch,
        '--no-open',
        '--port',
        String(config.guestPort),
        '--public-url',
        publicUrl.href,
        '--trusted-host',
        new URL(auth.origin).host,
        '--trusted-host',
        publicUrl.host,
      ]),
      env: Object.freeze({
        DSH_HOME: config.dshHome,
        DSH_AGENTS_HOME: config.agentsHome,
      }),
      workdir: config.workdir,
    }),
  });
}

export function nativeWebLaunchOnGuest(
  { commandWithoutHost, ...launch }: NativeWebLaunchPlan,
  guestAddress: PersonVmNativeWebGuestAddress,
): NativeWebLaunch {
  if (!isMicrosandboxGuestIpv4(guestAddress))
    throw new PersonVmError('PROVIDER_FAILED');
  return Object.freeze({
    ...launch,
    command: Object.freeze({
      ...commandWithoutHost,
      args: Object.freeze([...commandWithoutHost.args, '--host', guestAddress]),
    }),
  });
}
