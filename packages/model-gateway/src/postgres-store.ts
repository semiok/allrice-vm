import type postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { ModelGatewayError, MODEL_STREAMS_PER_PERSON } from './contract.ts';
import type {
  ModelCallBinding,
  ModelGatewayStore,
  ModelAttemptStart,
  ModelAttemptReceipt,
} from './contract.ts';
import { summarizeAttempts, unknownUsage } from './usage.ts';

const CHANNEL = 'allrice_model_gateway_capacity';
type CapacityHub = {
  subscribers: Map<string, Set<(error?: unknown) => void>>;
  ready: boolean;
};
type ListenCapacity = (
  notify: (person: string) => void,
  ready: () => void,
) => Promise<unknown>;
const capacityHubs = new WeakMap<postgres.Sql | ListenCapacity, CapacityHub>();

function capacityHub(
  db: postgres.Sql,
  listen: ListenCapacity | undefined,
): CapacityHub {
  const key = listen ?? db;
  const existing = capacityHubs.get(key);
  if (existing) return existing;
  const hub: CapacityHub = { subscribers: new Map(), ready: false };
  capacityHubs.set(key, hub);
  // Waiters own only local subscriptions. The injected listener or the
  // caller's pool owns the transport and reconnect.
  void Promise.resolve()
    .then(() => {
      const notify = (person: string) => {
        for (const pulse of hub.subscribers.get(person) ?? []) pulse();
      };
      const ready = () => {
        hub.ready = true;
        for (const subscribers of hub.subscribers.values())
          for (const pulse of subscribers) pulse();
      };
      return listen ? listen(notify, ready) : db.listen(CHANNEL, notify, ready);
    })
    .catch((error: unknown) => {
      if (hub.ready) return; // A newer onlisten already recovered this owner.
      // postgres retains this callback even when the first LISTEN rejects,
      // and re-registers it after reconnect. Keep the same pool owner; only
      // current waiters fail. Later waiters can await its onlisten recovery.
      for (const subscribers of hub.subscribers.values())
        for (const pulse of subscribers) pulse(error);
    });
  return hub;
}
type AttemptRow = {
  id: string;
  call_id: string;
  person_id: string;
  owner_id: string;
  kind: ModelAttemptStart['kind'];
  protocol: ModelAttemptStart['protocol'];
  receipt: ModelAttemptReceipt | null;
};
const fromRow = (r: AttemptRow): ModelAttemptReceipt =>
  r.receipt ?? {
    id: r.id,
    callId: r.call_id,
    personId: r.person_id,
    ownerId: r.owner_id,
    kind: r.kind,
    protocol: r.protocol,
    dispatchObserved: null,
    httpStatus: null,
    terminal: null,
    outcome: 'unknown',
    usage: unknownUsage(),
  };
export function nativeCallKey(binding: ModelCallBinding): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        binding.vm.vmId,
        binding.vm.instanceId,
        binding.vm.leaseEpoch,
        binding.native.instanceId,
        binding.native.sessionId,
        binding.native.attemptId
          ? [
              'native-attempt',
              binding.native.attemptKind,
              binding.native.attemptId,
              binding.native.attemptTurn,
              binding.native.attemptCursor,
            ]
          : binding.native.callId,
      ]),
    )
    .digest('hex');
}

/** Caller owns both clients and their lifecycles. All SQL touches only this owner's
 * three tables; no joins into identity, employee, Run or billing internals. */
export function createPostgresModelGatewayStore(
  db: postgres.Sql,
  listenCapacity?: ListenCapacity,
): ModelGatewayStore {
  const json = (value: unknown) =>
    db.json(JSON.parse(JSON.stringify(value)) as postgres.JSONValue);
  return {
    async reserveNativeCall(binding) {
      if (
        !binding.native.attemptId ||
        !binding.native.attemptKind ||
        (binding.native.attemptTurn !== null &&
          !Number.isSafeInteger(binding.native.attemptTurn)) ||
        !Number.isSafeInteger(binding.native.attemptCursor) ||
        binding.executionGeneration !== '4.0'
      )
        throw new ModelGatewayError('BINDING_INVALID');
      const key = nativeCallKey(binding) + ':authority';
      const identity = json(binding);
      const digest = createHash('sha256')
        .update(JSON.stringify(binding))
        .digest('hex');
      const rows = await db<{ id: string }[]>`
        insert into allrice_model_gateway_calls
          (id,native_key,person_id,organization_id,binding,request_digest)
        values(${randomUUID()},${key},${binding.vm.personId},${binding.vm.organizationId},
          ${identity},${digest}) on conflict(native_key) do nothing returning id
      `;
      if (!rows.length) throw new ModelGatewayError('DUPLICATE_CALL');
    },
    async claimCall(binding, requestDigest) {
      const id = randomUUID();
      const key = nativeCallKey(binding);
      const identity = json(binding);
      const rows = await db<{ id: string }[]>`
        insert into allrice_model_gateway_calls
          (id,native_key,person_id,organization_id,binding,request_digest)
        select ${id},${key},${binding.vm.personId},${binding.vm.organizationId},
          ${identity},${requestDigest}
        where ${!binding.native.attemptId} or exists (
          select 1 from allrice_model_gateway_calls
          where native_key=${key + ':authority'} and binding=${identity}
        )
        on conflict(native_key) do nothing returning id
      `;
      if (!rows.length) throw new ModelGatewayError('DUPLICATE_CALL');
      return id;
    },
    async watchCapacity(personId, signal) {
      signal.throwIfAborted();
      const hub = capacityHub(db, listenCapacity);
      let notified = false;
      let closed = false;
      let listenFailure: unknown;
      let wake: (() => void) | undefined;
      const pulse = (error?: unknown) => {
        listenFailure ??= error;
        notified = true;
        wake?.();
        wake = undefined;
      };
      const onAbort = () => pulse();
      const waitForPulse = async () => {
        if (!notified)
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (signal.aborted) pulse();
          });
        notified = false;
        signal.throwIfAborted();
        if (listenFailure) throw listenFailure;
      };
      const subscribers = hub.subscribers.get(personId) ?? new Set();
      hub.subscribers.set(personId, subscribers);
      subscribers.add(pulse);
      const detach = () => {
        subscribers.delete(pulse);
        if (!subscribers.size) hub.subscribers.delete(personId);
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort);
      try {
        while (!hub.ready) await waitForPulse();
        signal.throwIfAborted();
        // A hub may already be listening before this waiter subscribes.
        pulse();
      } catch (error) {
        detach();
        throw error;
      }
      // A disconnect/reconnect loses notifications; postgres' onlisten callback
      // must wake the waiter for an atomic recheck after every reconnect.
      return {
        async wait() {
          if (closed) throw new ModelGatewayError('ADMISSION_CLOSED');
          signal.throwIfAborted();
          await waitForPulse();
          if (closed) throw new ModelGatewayError('ADMISSION_CLOSED');
          signal.throwIfAborted();
        },
        async close() {
          if (closed) return;
          closed = true;
          detach();
          pulse();
        },
      };
    },
    async tryStartAttempt(attempt) {
      return db.begin(async (tx) => {
        const [call] = await tx<
          { person_id: string; provider: string }[]
        >`select person_id, binding->>'provider' as provider from allrice_model_gateway_calls where id=${attempt.callId}`;
        if (!call || call.person_id !== attempt.personId)
          throw new ModelGatewayError('BINDING_INVALID');
        // Shared with the admin selection transaction. An admitted intent
        // blocks a slot switch, including an independently joined refresh.
        if (call.provider === 'openai-codex')
          await tx`select pg_advisory_xact_lock_shared(8182)`;
        // Same global person key across gateways, tenants, Runs and native children.
        await tx`select pg_advisory_xact_lock(hashtextextended(${`model-gateway:${attempt.personId}`},0))`;
        let slot: number | null = null;
        if (attempt.kind === 'model') {
          const [free] = await tx<
            { slot: number }[]
          >`select n as slot from generate_series(1,${MODEL_STREAMS_PER_PERSON}) n
            where not exists(select 1 from allrice_model_gateway_slots s where s.person_id=${attempt.personId} and s.slot=n)
            order by n limit 1`;
          if (!free) return false;
          slot = free.slot;
        }
        await tx`insert into allrice_model_gateway_attempts(id,call_id,person_id,owner_id,kind,protocol)
          values(${attempt.id},${attempt.callId},${attempt.personId},${attempt.ownerId},${attempt.kind},${attempt.protocol})`;
        if (slot !== null)
          await tx`insert into allrice_model_gateway_slots(person_id,slot,attempt_id,owner_id)
          values(${attempt.personId},${slot},${attempt.id},${attempt.ownerId})`;
        return true;
      }) as Promise<boolean>;
    },
    async finishAttempt(receipt) {
      await db.begin(async (tx) => {
        const [row] = await tx<
          AttemptRow[]
        >`select * from allrice_model_gateway_attempts where id=${receipt.id} for update`;
        if (
          !row ||
          row.call_id !== receipt.callId ||
          row.person_id !== receipt.personId ||
          row.owner_id !== receipt.ownerId ||
          row.kind !== receipt.kind ||
          row.protocol !== receipt.protocol
        )
          throw new ModelGatewayError('BINDING_INVALID');
        if (row.receipt) {
          const [same] = await tx<
            { same: boolean }[]
          >`select receipt=${json(receipt)} as same from allrice_model_gateway_attempts where id=${receipt.id}`;
          if (!same?.same) throw new ModelGatewayError('LEDGER_UNAVAILABLE');
          return;
        }
        await tx`update allrice_model_gateway_attempts set receipt=${json(receipt)},closed_at=clock_timestamp() where id=${receipt.id}`;
        // Observed facts survive an unconfirmed close, but do not free capacity.
        if (receipt.outcome === 'unknown') return;
        await tx`delete from allrice_model_gateway_slots where attempt_id=${receipt.id} and owner_id=${receipt.ownerId}`;
        await tx`select pg_notify(${CHANNEL},${receipt.personId})`;
      });
    },
    async attempts(callId) {
      return (
        await db<
          AttemptRow[]
        >`select * from allrice_model_gateway_attempts where call_id=${callId} order by intent_at,id`
      ).map(fromRow);
    },
    async usage(personId, organizationId) {
      return summarizeAttempts(
        (
          await db<
            AttemptRow[]
          >`select a.* from allrice_model_gateway_attempts a
        join allrice_model_gateway_calls c on c.id=a.call_id
        where c.person_id=${personId} and c.organization_id=${organizationId}`
        ).map(fromRow),
      );
    },
    async reconcileOwner(ownerId, evidenceRef) {
      if (!evidenceRef.trim())
        throw new ModelGatewayError('AUTHORIZATION_DENIED');
      return db.begin(async (tx) => {
        const rows = await tx<
          AttemptRow[]
        >`select * from allrice_model_gateway_attempts
          where owner_id=${ownerId} and (closed_at is null or
            (receipt->>'outcome'='unknown' and recovery_evidence_ref is null))
          order by id for update`;
        for (const row of rows) {
          const receipt = fromRow(row);
          if (row.receipt)
            await tx`update allrice_model_gateway_attempts set recovery_evidence_ref=${evidenceRef} where id=${row.id}`;
          else
            await tx`update allrice_model_gateway_attempts set receipt=${json(receipt)},closed_at=clock_timestamp(),
              recovery_evidence_ref=${evidenceRef} where id=${row.id}`;
          await tx`delete from allrice_model_gateway_slots where attempt_id=${row.id} and owner_id=${ownerId}`;
          await tx`select pg_notify(${CHANNEL},${row.person_id})`;
        }
        return rows.length;
      }) as Promise<number>;
    },
  };
}
