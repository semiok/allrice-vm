import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  MAX_PERSON_VM_EMPLOYEE_PORT_SLOTS,
  readPlatformPersonVmConfiguration,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import {
  PersonVmError,
  type PersonVmBinding,
  type PersonVmEmployeeSelection,
} from './contract.ts';
import type { PersonVmGuestLaunchDispatch } from './guest-bootstrap.ts';

export type PersonVmWebRoster = Readonly<{
  personId: string;
  organizationId: string;
  entries: readonly Readonly<{
    workspaceId: string;
    employeeInstanceId: string;
    employeeRevision: number;
    employeeVersionId: string;
  }>[];
  digest: string;
}>;
/** Current authority for the full census and the active native work it covers. */
export type PersonVmWakeStartup = Readonly<{
  planId: string;
  roster: PersonVmWebRoster;
  employeeInstanceIds: readonly string[];
  digest: string;
}>;
export const PERSON_VM_WAKE_RESUME_AUDIT = 'scheduled-wake.resume';
type WebPort = Readonly<{ hostPort: number; guestPort: number }>;
type WebUpgrade = 'pending' | 'complete';

export type PersonVmWebEndpointReceipt = Readonly<{
  binding: PersonVmBinding;
  rosterDigest: string;
  endpoints: readonly (PersonVmWebRoster['entries'][number] & WebPort)[];
  /** Physical network publication, including slots without an employee. */
  slots?: readonly WebPort[];
  upgrade?: WebUpgrade;
}>;
export type NativeWebSetupFailure = Readonly<{
  step: string;
  errorType: string;
  errorCode?: string;
  httpStatus?: number;
  target?: string;
}>;
/** Host-owned startup metadata, from the authenticated caller or system wake. */
export type PersonVmWebStartup = Readonly<
  {
    receipt: PersonVmWebEndpointReceipt;
    dispatchScheduledLaunch?: PersonVmGuestLaunchDispatch;
    selectedEmployee?: PersonVmEmployeeSelection;
    editorThreadId?: string;
    /** Proven on this start lease before guest profile staging. */
    unusedEmployeeHomes?: true;
    recordNativeFailure?(
      failure: NativeWebSetupFailure,
      signal: AbortSignal,
    ): Promise<void>;
  } & (
    | {
        context: RequestContext;
        purpose?: never;
        scheduledEmployeeIds?: readonly string[];
      }
    | {
        context?: never;
        purpose: 'scheduled-wake';
        scheduledEmployeeIds: readonly string[];
      }
  )
>;
export interface PersonVmWebRosterPort {
  prepare(
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<PersonVmWebRoster>;
}
const filename = 'allrice-native-web-endpoints.json';
type ManifestBase = {
  vmId: string;
  personId: string;
  organizationId: string;
  digest: string;
  endpoints: PersonVmWebEndpointReceipt['endpoints'];
};
type SlotManifest = ManifestBase & {
  version: 2;
  slots: readonly WebPort[];
  upgrade?: WebUpgrade;
};
type Manifest = (ManifestBase & { version: 1 }) | SlotManifest;
function invalid(): never {
  throw new PersonVmError('PROVIDER_FAILED');
}
function port(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) invalid();
  return value;
}
function checkPorts(ports: readonly WebPort[]) {
  for (const key of ['hostPort', 'guestPort'] as const) {
    if (new Set(ports.map((slot) => port(slot[key]))).size !== ports.length)
      invalid();
  }
}
export function checkedWebRoster(roster: PersonVmWebRoster) {
  const entries = roster.entries
    .map((entry) => {
      if (
        !Number.isSafeInteger(entry.employeeRevision) ||
        entry.employeeRevision < 1
      )
        invalid();
      return Object.freeze({
        workspaceId: UuidSchema.parse(entry.workspaceId),
        employeeInstanceId: UuidSchema.parse(entry.employeeInstanceId),
        employeeRevision: entry.employeeRevision,
        employeeVersionId: UuidSchema.parse(entry.employeeVersionId),
      });
    })
    .sort((a, b) => a.employeeInstanceId.localeCompare(b.employeeInstanceId));
  if (
    new Set(entries.map((entry) => entry.employeeInstanceId)).size !==
    entries.length
  )
    invalid();
  const facts = {
    personId: UuidSchema.parse(roster.personId),
    organizationId: UuidSchema.parse(roster.organizationId),
    entries: Object.freeze(entries),
  };
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`;
  if (digest !== roster.digest) invalid();
  return Object.freeze({ ...facts, digest });
}
async function read(
  directory: string,
  binding: PersonVmBinding,
): Promise<Manifest | null> {
  let file;
  try {
    file = await open(
      join(directory, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid?.()
    )
      invalid();
    const value: Manifest = JSON.parse(await file.readFile('utf8'));
    if (
      (value.version !== 1 && value.version !== 2) ||
      value.vmId !== binding.vmId ||
      value.personId !== binding.personId ||
      value.organizationId !== binding.organizationId ||
      Object.keys(value).sort().join(',') !==
        (value.version === 1
          ? 'digest,endpoints,organizationId,personId,version,vmId'
          : value.upgrade === undefined
            ? 'digest,endpoints,organizationId,personId,slots,version,vmId'
            : 'digest,endpoints,organizationId,personId,slots,upgrade,version,vmId')
    )
      invalid();
    checkedWebRoster({ ...value, entries: value.endpoints });
    checkPorts(value.endpoints);
    for (const endpoint of value.endpoints) {
      if (
        Object.keys(endpoint).sort().join(',') !==
        'employeeInstanceId,employeeRevision,employeeVersionId,guestPort,hostPort,workspaceId'
      )
        invalid();
    }
    if (value.version === 2) {
      if (
        (value.upgrade !== undefined &&
          value.upgrade !== 'pending' &&
          value.upgrade !== 'complete') ||
        !Array.isArray(value.slots) ||
        !value.slots.length ||
        value.slots.some(
          (slot) => Object.keys(slot).sort().join(',') !== 'guestPort,hostPort',
        )
      )
        invalid();
      checkPorts(value.slots);
      for (const endpoint of value.endpoints)
        if (
          !value.slots.some(
            (slot) =>
              slot.hostPort === endpoint.hostPort &&
              slot.guestPort === endpoint.guestPort,
          )
        )
          invalid();
    }
    return value;
  } finally {
    await file.close();
  }
}
async function write(directory: string, value: Manifest) {
  const temporary = join(directory, `${filename}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, filename));
  } finally {
    await rm(temporary, { force: true });
  }
}
function receipt(
  binding: PersonVmBinding,
  manifest: Manifest,
): PersonVmWebEndpointReceipt {
  return Object.freeze({
    binding: Object.freeze({ ...binding }),
    rosterDigest: manifest.digest,
    endpoints: Object.freeze(
      manifest.endpoints.map((entry) => Object.freeze({ ...entry })),
    ),
    ...(manifest.version === 2 && {
      slots: Object.freeze(manifest.slots.map((slot) => Object.freeze(slot))),
      ...(manifest.upgrade !== undefined && { upgrade: manifest.upgrade }),
    }),
  });
}
export async function assertPreparedWebEndpoints(
  directory: string,
  binding: PersonVmBinding,
  expected: PersonVmWebEndpointReceipt,
) {
  if (
    !(
      [
        'vmId',
        'personId',
        'organizationId',
        'instanceId',
        'leaseEpoch',
      ] as const
    ).every((key) => expected.binding[key] === binding[key])
  )
    throw new PersonVmError('LEASE_LOST');
  const manifest = await read(directory, binding);
  if (
    !manifest ||
    expected.rosterDigest !== manifest.digest ||
    JSON.stringify(expected.endpoints) !== JSON.stringify(manifest.endpoints) ||
    JSON.stringify(expected.slots) !==
      JSON.stringify(manifest.version === 2 ? manifest.slots : undefined) ||
    expected.upgrade !== (manifest.version === 2 ? manifest.upgrade : undefined)
  )
    invalid();
}

export async function readWebUpgrade(
  directory: string,
  binding: PersonVmBinding,
  requireManifest = false,
) {
  const manifest = await read(directory, binding);
  if (requireManifest && !manifest) invalid();
  return manifest?.version === 2 ? manifest.upgrade : undefined;
}

export async function commitWebUpgrade(
  directory: string,
  expected: PersonVmWebEndpointReceipt,
) {
  const manifest = await read(directory, expected.binding);
  if (manifest?.version !== 2 || manifest.upgrade !== 'pending') invalid();
  await assertPreparedWebEndpoints(directory, expected.binding, expected);
  await write(directory, { ...manifest, upgrade: 'complete' });
}

/** This listener reserves an OS port only; it never serves an accepted peer. */
async function reserve(port: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const server = createServer(),
    sockets = new Map<Socket, Promise<void>>();
  const closed = new Promise<void>((done) => server.once('close', done));
  server.on('connection', (socket) => {
    sockets.set(
      socket,
      new Promise<void>((done) =>
        socket.once('close', () => {
          sockets.delete(socket);
          done();
        }),
      ),
    );
    socket.on('error', () => {}); // Always still await its actual close.
    socket.destroy();
  });
  let closing: Promise<void> | undefined;
  function close() {
    return (closing ??= (async () => {
      const listener = new Promise<void>((done, reject) =>
        server.close((error) =>
          error &&
          (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            ? reject(error)
            : done(),
        ),
      );
      for (const socket of sockets.keys()) socket.destroy();
      const [listenerResult] = await Promise.allSettled([listener, closed]); // Even a callback error must join real close.
      while (sockets.size) await Promise.all(sockets.values());
      if (listenerResult!.status === 'rejected') throw listenerResult!.reason;
    })());
  }
  let abort = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port, signal }, resolve);
      if (signal.aborted) abort();
    });
    const address = server.address();
    if (!address || typeof address === 'string') invalid();
    return { port: address.port, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new PersonVmError('CLEANUP_INCOMPLETE', {
        cause: new AggregateError([error, cleanup]),
      });
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Allocate the physical pool only for a new sandbox. A stopped pool can
 * reassign slots after the previous VM process and its owners have exited. */
export async function prepareWebEndpoints(input: {
  directory: string;
  binding: PersonVmBinding;
  roster: PersonVmWebRoster;
  state: 'absent' | 'stopped' | 'running' | 'unknown';
  employeePortSlots?: number;
  signal: AbortSignal;
}): Promise<PersonVmWebEndpointReceipt> {
  input.signal.throwIfAborted();
  const roster = checkedWebRoster(input.roster);
  if (
    roster.personId !== input.binding.personId ||
    roster.organizationId !== input.binding.organizationId
  )
    invalid();
  const prior = await read(input.directory, input.binding);
  if (input.state === 'unknown') invalid();
  // The converter's source is checked by the provider before using this
  // writer. A missing replacement must not erase its durable name pointer.
  if (input.state === 'absent' && prior?.version === 2 && prior.upgrade)
    invalid();
  const converting = input.state === 'stopped' && prior?.version === 1;
  if (input.state !== 'absent' && !converting) {
    if (!prior) throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
    if (prior.digest === roster.digest) return receipt(input.binding, prior);
    if (input.state !== 'stopped' || prior.version !== 2)
      throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
    const next = assignStoppedRoster(prior, roster);
    input.signal.throwIfAborted();
    await write(input.directory, next);
    return receipt(input.binding, next);
  }
  const reserved: Awaited<ReturnType<typeof reserve>>[] = [];
  let prepared: PersonVmWebEndpointReceipt | undefined;
  let failed = false,
    failure: unknown;
  try {
    const count =
      input.employeePortSlots ??
      readPlatformPersonVmConfiguration().employeePortSlots;
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_PERSON_VM_EMPLOYEE_PORT_SLOTS
    )
      invalid();
    if (roster.entries.length > count)
      throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
    const slots: WebPort[] = [];
    const previousSlots = prior?.version === 2 ? prior.slots : prior?.endpoints;
    for (let index = 0; index < count; index++) {
      input.signal.throwIfAborted();
      const previous = previousSlots?.[index];
      const handle = await reserve(previous?.hostPort ?? 0, input.signal);
      reserved.push(handle);
      slots.push({
        hostPort: port(handle.port),
        guestPort: previous?.guestPort ?? handle.port,
      });
    }
    input.signal.throwIfAborted();
    checkPorts(slots);
    const value = assignStoppedRoster(
      {
        version: 2,
        vmId: input.binding.vmId,
        personId: roster.personId,
        organizationId: roster.organizationId,
        digest: '',
        slots,
        ...(converting && { upgrade: 'pending' as const }),
        endpoints: prior?.endpoints ?? [],
      },
      roster,
    );
    await write(input.directory, value);
    input.signal.throwIfAborted();
    prepared = receipt(input.binding, value);
  } catch (error) {
    failed = true;
    failure = error;
  }
  const results = await Promise.allSettled(
    reserved.map((handle) => handle.close()),
  );
  const closeFailures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (closeFailures.length)
    throw new PersonVmError('CLEANUP_INCOMPLETE', {
      cause: new AggregateError([
        ...(failed ? [failure] : []),
        ...closeFailures,
      ]),
    });
  if (failed) throw failure;
  return prepared!;
}

function assignStoppedRoster(
  manifest: SlotManifest,
  roster: PersonVmWebRoster,
): SlotManifest {
  if (roster.entries.length > manifest.slots.length)
    throw new PersonVmError('WEB_ENDPOINTS_PREPARING');
  const kept = new Map<string, WebPort>();
  for (const entry of roster.entries) {
    const prior = manifest.endpoints.find(
      (endpoint) => endpoint.employeeInstanceId === entry.employeeInstanceId,
    );
    const slot =
      prior &&
      manifest.slots.find(
        (slot) =>
          slot.hostPort === prior.hostPort &&
          slot.guestPort === prior.guestPort,
      );
    if (slot) kept.set(entry.employeeInstanceId, slot);
  }
  const inUse = new Set(kept.values());
  const available = manifest.slots.filter((slot) => !inUse.has(slot));
  return {
    ...manifest,
    digest: roster.digest,
    endpoints: roster.entries.map((entry) => ({
      ...entry,
      ...(kept.get(entry.employeeInstanceId) ?? available.shift()!),
    })),
  };
}

/** Public v0.7.16 inspect flattens SandboxSpec; pending_changes does not cover
 * ports. Compare the actual desired AND running config explicitly. */
export function assertWebEndpointInspection(
  value: unknown,
  expectedName: string,
  expected: PersonVmWebEndpointReceipt,
  running: boolean,
) {
  const result = value as {
    name?: string;
    status?: string;
    config?: unknown;
    active_config?: unknown;
  };
  if (
    !result ||
    result.name !== expectedName ||
    (running && result.status !== 'Running')
  )
    invalid();
  const wanted = (expected.slots ?? expected.endpoints)
    .map((entry) => `127.0.0.1:${entry.hostPort}:${entry.guestPort}:tcp`)
    .sort();
  function compare(config: unknown) {
    const network = (
      config as {
        network?: {
          ports?: unknown;
          policy?: { default_ingress?: unknown; rules?: unknown };
        };
      } | null
    )?.network;
    const ports = network?.ports;
    if (!Array.isArray(ports)) invalid();
    const actual = ports
      .map(
        (entry: {
          host_bind: string;
          host_port: number;
          guest_port: number;
          protocol: string;
        }) =>
          `${entry.host_bind}:${port(entry.host_port)}:${port(entry.guest_port)}:${entry.protocol}`,
      )
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) invalid();
    if (expected.slots) {
      const policy = network?.policy;
      if (policy?.default_ingress !== 'deny' || !Array.isArray(policy.rules))
        invalid();
      const ingress = policy.rules
        .filter((rule) => rule?.direction !== 'egress')
        .map((rule) => {
          if (
            rule?.action !== 'allow' ||
            rule.direction !== 'ingress' ||
            rule.destination?.cidr !== '127.0.0.1/32' ||
            JSON.stringify(rule.protocols) !== '["tcp"]' ||
            !Array.isArray(rule.ports) ||
            rule.ports.length !== 1 ||
            rule.ports[0]?.start !== rule.ports[0]?.end
          )
            invalid();
          return port(rule.ports[0].start);
        })
        .sort((a, b) => a - b);
      const allowed = expected.slots
        .map((slot) => slot.guestPort)
        .sort((a, b) => a - b);
      if (JSON.stringify(ingress) !== JSON.stringify(allowed)) invalid();
    }
  }
  compare(result.config);
  if (running) compare(result.active_config);
}
