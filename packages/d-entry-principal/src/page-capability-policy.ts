export type SensitivePageCapability =
  | 'native-identity'
  | 'plugin-management'
  | 'runtime-upgrade'
  | 'platform-settings'
  | 'provider-configuration';

type Method = Readonly<{
  namespace: string;
  method: string;
  service: string;
}>;

type Configuration = Readonly<{
  args: Readonly<Record<string, unknown>>;
  providerSettings: ReadonlySet<string> | undefined;
  pluginSettings?: ReadonlySet<string>;
}>;

type ProfileEntry = { entry: { options: { id: string; name: string } } };

export function pageSettingsNamespaces(
  entries: Iterable<ProfileEntry>,
  providers: readonly { settingsNs: string }[] | undefined,
) {
  const providerSettings =
    providers && new Set(providers.map(({ settingsNs }) => settingsNs));
  const pluginSettings = new Set<string>();
  for (const {
    entry: { options },
  } of entries) {
    if (options.name === '@deepseek-ai/dsh-agent-default-model')
      providerSettings?.add(options.id);
    if (
      options.name === '@deepseek-ai/dsh-plugin-market' ||
      options.name === '@deepseek-ai/dsh-plugin-manager' ||
      options.name === '@deepseek-ai/dsh-permission-presets'
    )
      pluginSettings.add(options.id);
  }
  return { providerSettings, pluginSettings };
}

const authentication = new Set([
  'account',
  'accountController',
  'auth',
  'authentication',
  'pairing',
  'remoteAccess',
  'tokenIssuer',
]);
const pluginManagement = new Set(['pluginManager']);
const pluginInventory = new Set([
  'listBundles',
  'listPlugins',
  'listVersionExemptions',
  'registries',
]);
const pluginMarket = new Set(['pluginMarket']);
const dynamicPlugins = new Set(['dynamicCordisRunner']);
const runtimeUpgrade = new Set(['runtimeUpgrade', 'updater', 'dshUpdater']);
const credentialManagement = new Set(['credentials', 'credentialsController']);
const filePreview = new Set(['workspaceFiles', 'officeToPdf']);

function inCategory(endpoint: Method, values: ReadonlySet<string>) {
  return values.has(endpoint.namespace) || values.has(endpoint.service);
}

/** The sealed file preview controllers remain unavailable on the page. */
export function isRetainedPageRestriction(endpoint: Method) {
  return inCategory(endpoint, filePreview);
}

/** A category rule for generated DSH methods. */
export function sensitivePageCapability(
  endpoint: Method,
  configuration?: Configuration,
): SensitivePageCapability | undefined {
  const { namespace, service, method } = endpoint;
  // The rc.2 gateway explicitly admits each non-owner peer's own access
  // snapshot. It neither pairs a client nor creates credentials.
  if (
    namespace === 'remoteAccess' &&
    service === 'remoteAccess' &&
    method === 'follow'
  ) {
    return;
  }
  if (inCategory(endpoint, authentication)) return 'native-identity';
  if (
    (inCategory(endpoint, pluginManagement) && !pluginInventory.has(method)) ||
    (inCategory(endpoint, pluginMarket) &&
      /^(?:set|update|replace|mutate)/u.test(method)) ||
    (inCategory(endpoint, dynamicPlugins) &&
      (method === 'stopFromPanel' ||
        method === 'undefineFromPanel' ||
        /^(?:activate|approve|runHost|resolveRequestRun|settleUserRun)/u.test(
          method,
        )))
  ) {
    return 'plugin-management';
  }
  if (inCategory(endpoint, runtimeUpgrade)) return 'runtime-upgrade';
  if (
    inCategory(endpoint, credentialManagement) ||
    (namespace === 'llm' &&
      /^(?:configure|discover|mutate|register|remove|replace|set|update)/u.test(
        method,
      ))
  ) {
    return 'provider-configuration';
  }

  if (namespace === 'settings' && method === 'openSettingsDocument') {
    return 'platform-settings';
  }

  // Native settings controllers multiplex several independent Config owners.
  // Provider settings are named by the DSH configurable-provider directory.
  if (namespace === 'settings' && /^(?:mutate|replace|update)/u.test(method)) {
    if (!configuration) return 'provider-configuration';
    const ns = configuration.args.ns;
    if (typeof ns === 'string' && configuration.pluginSettings?.has(ns)) {
      return 'platform-settings';
    }
    if (
      !configuration.providerSettings ||
      (typeof ns === 'string' && configuration.providerSettings.has(ns))
    ) {
      return 'provider-configuration';
    }
  }
}

export const sensitivePageUpgradeCapability = sensitivePageCapability;

/** Notifications may refresh authorized reads. Platform lifecycle requests,
 * installation output and credential notifications remain managed. */
export function isManagedPageEvent(event: string) {
  const [domain, action] = event.split('/');
  if (!domain || !action) return true;
  if (domain === 'plugin-manager' && action === 'changed') return false;
  if (domain === 'cordis' && /^request-run(?:-|$)/u.test(action)) return true;
  const camel = (value: string) =>
    value.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
  const namespace =
    domain === 'deepseek-account'
      ? 'account'
      : domain === 'cordis'
        ? 'dynamicCordisRunner'
        : camel(domain);
  const method = { namespace, service: namespace, method: camel(action) };
  return isRetainedPageRestriction(method) || !!sensitivePageCapability(method);
}
