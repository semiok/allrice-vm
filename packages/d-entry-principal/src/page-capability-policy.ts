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
  providerSettings: ReadonlySet<string>;
}>;

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
const pluginMarket = new Set(['pluginMarket']);
const dynamicPlugins = new Set(['dynamicCordisRunner']);
const runtimeUpgrade = new Set(['runtimeUpgrade', 'updater', 'dshUpdater']);
const credentialManagement = new Set(['credentials', 'credentialsController']);
const interactiveTerminal = new Set(['terminal', 'terminalController']);

function inCategory(endpoint: Method, values: ReadonlySet<string>) {
  return values.has(endpoint.namespace) || values.has(endpoint.service);
}

/** A category rule for generated DSH methods. Session ownership is decided by
 * the native resource policy before any descriptor can be dispatched. */
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
    inCategory(endpoint, pluginManagement) ||
    (inCategory(endpoint, pluginMarket) &&
      /^(?:set|update|replace|mutate)/u.test(method)) ||
    (inCategory(endpoint, dynamicPlugins) &&
      /^(?:activate|approve|runHost|resolveRequestRun|settleUserRun)/u.test(
        method,
      ))
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
    if (typeof ns === 'string' && configuration.providerSettings.has(ns)) {
      return 'provider-configuration';
    }
  }
}

/** The sealed employee profile does not register a terminal controller.
 * Report its capability on an upgrade even though the profile owns disablement. */
export function sensitivePageUpgradeCapability(endpoint: Method) {
  return (
    sensitivePageCapability(endpoint) ??
    (inCategory(endpoint, interactiveTerminal)
      ? 'interactive-shell'
      : undefined)
  );
}
