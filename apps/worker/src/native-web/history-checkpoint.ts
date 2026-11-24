import { addAbortListener } from 'node:events';
import { z } from 'zod';
import {
  Session,
  SessionId,
  SessionLogOffset,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session';
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections';
import type { NativeHistoryCut } from '@allrice/dsh-native-history-source/types';
import type {
  PersonVmBinding,
  PersonVmWebEndpointReceipt,
} from '@allrice/person-vm';
import {
  HostHistoryBindingSchema,
  type HostHistoryBinding,
} from '@allrice/contracts';
import {
  hostHistoryDigest,
  HostHistoryIntegrityError,
  HostHistorySourceKeySchema,
  HostHistorySourceSchema,
  type HostHistorySource,
  type HostHistorySourceKey,
  type HostHistorySourceStore,
} from '@allrice/storage';
import { captureHostHistory } from '../harness/host-history.js';

type Capture = Parameters<typeof captureHostHistory>[0];
type Endpoint = PersonVmWebEndpointReceipt['endpoints'][number];

/** The authenticated reader owns these facts alongside its actual transport.
 * They are sampled from its verified launch and profile, independently of the
 * original history receipts. A caller must keep the port unbound without those
 * sources. The serialized native cut contains session data only. */
type NativeHistoryReader = Readonly<{
  binding: Readonly<PersonVmBinding>;
  endpoint: Readonly<Pick<Endpoint, 'workspaceId' | 'employeeInstanceId'>>;
  profile: Readonly<
    Pick<
      HostHistoryBinding,
      'nativeProfileRef' | 'configurationRef' | 'configurationDigest'
    >
  >;
  revoked: AbortSignal;
  assertCurrent(signal: AbortSignal): Promise<void>;
  readCut(
    request: { rootSessionId: string },
    signal: AbortSignal,
  ): Promise<string>;
}>;

/** Validate the transport envelope, then let native current-format restoration
 * validate its complete header/log. This detached value is never published to
 * a SessionStore, Agent or Host and cannot resume work. */
function decodeCut(text: string): NativeHistoryCut {
  const cut = z
    .object({
      rootSessionId: z.string().min(1),
      sessions: z.array(
        z
          .object({
            meta: HostHistorySourceSchema.shape.sessions.element.shape.header,
            inheritedEventCount: z.number().int().nonnegative().safe(),
            events: z.array(z.unknown()),
            catalog: z.array(
              z
                .object({
                  id: z.string().min(1),
                  createdAt: z.number().int().nonnegative().safe(),
                  mode: z.enum([
                    'one-shot',
                    'continuable',
                    'unknown',
                    'external',
                  ]),
                  label: z.string().optional(),
                })
                .strict(),
            ),
          })
          .strict(),
      ),
    })
    .strict()
    .parse(JSON.parse(text));
  return {
    rootSessionId: cut.rootSessionId,
    sessions: cut.sessions.map((row) => {
      // Native restoration may append an in-memory end-seed/resume marker to
      // its detached log. Use it ONLY for validation: never return that log or
      // a derived projection as the observed source prefix.
      Session.fromRestore(
        SessionId(row.meta.id),
        row.events as SessionEvent[],
        row.meta as unknown as SessionHeader,
        SessionLogOffset(row.inheritedEventCount),
        'detached',
        currentSessionMessageProjections,
      );
      if (
        row.catalog.some(
          (entry) => entry.mode === 'continuable' && entry.label === undefined,
        )
      )
        throw new HostHistoryIntegrityError();
      return {
        meta: row.meta as unknown as SessionHeader,
        inheritedEventCount: row.inheritedEventCount,
        events: row.events as SessionEvent[],
        catalog: row.catalog.map((entry) => ({
          ...entry,
          id: SessionId(entry.id),
        })) as NativeHistoryCut['sessions'][number]['catalog'],
      };
    }),
  };
}

/** Called only on an existing authenticated carrier BEFORE native stop. The
 * actual create/config owner must supply original bindings and the SQL root
 * receipt. Missing birth facts cannot be filled from today's employee config.
 * No final-cut claim is made without the caller's actual live producer barrier. */
export async function checkpointNativeHistory(input: {
  key: HostHistorySourceKey;
  originalBindings: readonly HostHistoryBinding[];
  native: NativeHistoryReader;
  authorize: Capture['authorize'];
  attachments: Capture['attachments'];
  snapshots: Capture['store'];
  sources: HostHistorySourceStore;
  signal: AbortSignal;
}) {
  const key = HostHistorySourceKeySchema.parse(input.key);
  const bindings = input.originalBindings.map((binding) =>
    HostHistoryBindingSchema.parse(binding),
  );
  const root = bindings.find(
    (binding) => binding.nativeSessionId === key.rootNativeSessionId,
  );
  const fail: () => never = () => {
    throw new HostHistoryIntegrityError();
  };
  const native = input.native;
  const actualBinding = (binding: HostHistoryBinding) => ({
    ...binding,
    organizationId: native.binding.organizationId,
    workspaceId: native.endpoint.workspaceId,
    personId: native.binding.personId,
    employeeInstanceId: native.endpoint.employeeInstanceId,
    nativeInstanceRef: native.binding.instanceId,
    nativeProfileRef: native.profile.nativeProfileRef,
    configurationRef: native.profile.configurationRef,
    configurationDigest: native.profile.configurationDigest,
  });
  const assertOrigin = () => {
    if (
      native.binding.vmId !== key.vmId ||
      bindings.some(
        (binding) =>
          hostHistoryDigest(actualBinding(binding)) !==
          hostHistoryDigest(binding),
      )
    )
      fail();
  };
  if (
    !root ||
    root.parentNativeSessionId !== null ||
    new Set(bindings.map((b) => b.nativeSessionId)).size !== bindings.length ||
    bindings.some(
      (binding) =>
        binding.rootNativeSessionId !== key.rootNativeSessionId ||
        (
          [
            'organizationId',
            'workspaceId',
            'personId',
            'employeeInstanceId',
            'threadId',
          ] as const
        ).some((field) => binding[field] !== key[field]),
    )
  )
    fail();
  assertOrigin();
  const grants = new AbortController();
  const signal = AbortSignal.any([input.signal, native.revoked, grants.signal]);
  const revocations = new Map<
    AbortSignal,
    ReturnType<typeof addAbortListener>
  >();
  const authorize = async (
    binding: HostHistoryBinding,
    active: AbortSignal,
  ) => {
    active.throwIfAborted();
    const grant = await input.authorize(binding, active);
    active.throwIfAborted();
    if (hostHistoryDigest(grant.binding) !== hostHistoryDigest(binding)) fail();
    grant.revoked.throwIfAborted();
    if (!revocations.has(grant.revoked))
      revocations.set(
        grant.revoked,
        addAbortListener(grant.revoked, () =>
          grants.abort(grant.revoked.reason),
        ),
      );
    return grant;
  };
  try {
    for (const binding of bindings) await authorize(binding, signal);
    await native.assertCurrent(signal);
    signal.throwIfAborted();
    assertOrigin();
    const serialized = await native.readCut(
      { rootSessionId: key.rootNativeSessionId },
      signal,
    );
    signal.throwIfAborted();
    await native.assertCurrent(signal);
    signal.throwIfAborted();
    assertOrigin();
    const cut = decodeCut(serialized);
    if (
      cut.rootSessionId !== key.rootNativeSessionId ||
      cut.sessions.length !== bindings.length ||
      new Set(cut.sessions.map((row) => row.meta.id)).size !==
        cut.sessions.length
    )
      fail();
    const sessions: HostHistorySource['sessions'] = [];
    const edges: HostHistorySource['edges'] = [];
    for (const row of cut.sessions) {
      const binding = bindings.find(
        (binding) => binding.nativeSessionId === row.meta.id,
      );
      if (!binding || row.meta.version !== 4) fail();
      const parentId = binding.parentNativeSessionId;
      if (parentId !== null) {
        const parent = cut.sessions.find((row) => row.meta.id === parentId);
        const catalog = parent?.catalog.filter(
          (entry) => entry.id === row.meta.id,
        );
        if (
          !parent ||
          catalog?.length !== 1 ||
          !['one-shot', 'continuable'].includes(catalog[0]!.mode) ||
          catalog[0]!.createdAt !== row.meta.createdAt
        )
          fail();
        const event = parent.events.find(
          (event) =>
            event.type === 'subagent/catalog' &&
            event.seq >= parent.inheritedEventCount &&
            event.data.childId === row.meta.id &&
            event.data.childCreatedAt === row.meta.createdAt &&
            event.data.mode === catalog[0]!.mode,
        );
        if (!event) fail();
        // The source schema validates/hash-binds the real complete catalog event.
        edges.push({
          parentNativeSessionId: parentId,
          childNativeSessionId: row.meta.id,
          parentEvent:
            HostHistorySourceSchema.shape.edges.element.shape.parentEvent.parse(
              event,
            ),
        });
      }
      const exported = await captureHostHistory({
        binding,
        native: {
          binding: actualBinding(binding),
          async inspect(id, active) {
            active?.throwIfAborted();
            if (id !== SessionId(row.meta.id)) fail();
            return {
              meta: row.meta,
              inheritedEventCount: SessionLogOffset(row.inheritedEventCount),
              events: row.events,
            };
          },
        },
        authorize,
        store: input.snapshots,
        attachments: input.attachments,
        signal,
      });
      signal.throwIfAborted();
      sessions.push({
        binding,
        snapshotDigest: exported.digest,
        header:
          HostHistorySourceSchema.shape.sessions.element.shape.header.parse(
            row.meta,
          ),
      });
    }
    for (const binding of bindings) await authorize(binding, signal);
    await native.assertCurrent(signal);
    signal.throwIfAborted();
    assertOrigin();
    // Unreferenced snapshots are deliberately not readable through the cold
    // adapter. Commit last, after the complete source/attachment/capture joins.
    const manifest: HostHistorySource = {
      schemaVersion: 1,
      key,
      sessions,
      edges,
    };
    const digest = await input.sources.publish(manifest, signal);
    signal.throwIfAborted();
    return { digest, manifest };
  } finally {
    for (const subscription of revocations.values())
      subscription[Symbol.dispose]();
  }
}
