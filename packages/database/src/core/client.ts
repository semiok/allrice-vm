import postgres from 'postgres';
import { openPostgresNotifications } from './notification-client.ts';

let client: ReturnType<typeof postgres> | undefined;
let clientUrl: string | undefined;
let diagnostics: ReturnType<typeof postgres> | undefined;
const closeHooks = new Set<() => Promise<void>>();

export function registerDatabaseCloseHook(hook: () => Promise<void>) {
  closeHooks.add(hook);
  return () => closeHooks.delete(hook);
}

export function getDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  if (!client) {
    client = postgres(databaseUrl, {
      connect_timeout: 5,
      idle_timeout: 20,
      max: process.env.ALLRICE_SERVICE_ROLE === 'worker' ? 10 : 5,
      connection: {
        application_name: `allrice-${process.env.ALLRICE_SERVICE_ROLE === 'worker' ? 'worker' : 'app'}`,
      },
    });
    clientUrl = databaseUrl;
  }

  return client;
}

export function openDatabaseNotifications(
  database: ReturnType<typeof postgres>,
  channels: readonly string[],
  receive: (channel: string, payload: string) => void,
  options: { databaseUrl?: string; onListen?(): void } = {},
) {
  const url =
    options.databaseUrl ?? (database === client ? clientUrl : undefined);
  if (!url) throw Error('Dedicated notification connection URL required');
  return openPostgresNotifications(url, channels, receive, {
    applicationName: database.options.connection.application_name,
    onListen: options.onListen,
  });
}

/** A caller-owned client from the trusted client's entire public configuration.
 * No connection/pool handle is borrowed. The runtime accepts ParsedOptions'
 * host/port arrays; its constructor declaration narrows those input fields. */
export function createDedicatedDatabase(
  db: Pick<ReturnType<typeof postgres>, 'options'>,
) {
  const shared: unknown = Reflect.get(db.options, 'shared');
  if (
    !shared ||
    typeof shared !== 'object' ||
    !('typeArrayMap' in shared) ||
    !shared.typeArrayMap ||
    typeof shared.typeArrayMap !== 'object'
  )
    throw new Error('unsupported_postgres_options');
  return postgres({
    ...db.options,
    max: 1,
    // A caller-owned lease can span non-SQL work until its owner calls end().
    idle_timeout: 0,
    shared: { retries: 0, typeArrayMap: { ...shared.typeArrayMap } },
    parameters: {},
    parsers: { ...db.options.parsers },
    serializers: { ...db.options.serializers },
  } as unknown as NonNullable<Parameters<typeof postgres>[1]>);
}

export async function pingDatabase() {
  await getDatabase()`select 1 as ready`;
}

/** One bounded connection keeps lock diagnostics available when the business
 * pool is occupied. It never executes tenant queries or long transactions. */
export function getDiagnosticsDatabase() {
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is required');
  diagnostics ??= postgres(process.env.DATABASE_URL, {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 20,
    connection: {
      application_name: 'allrice-diagnostics',
      statement_timeout: 1500,
      lock_timeout: 500,
    },
  });
  return diagnostics;
}

export async function closeDatabase() {
  await diagnostics?.end({ timeout: 2 });
  diagnostics = undefined;
  if (!client) return;
  for (const hook of closeHooks) await hook();
  await client.end({ timeout: 5 });
  client = undefined;
  clientUrl = undefined;
}
