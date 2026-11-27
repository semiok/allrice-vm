import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as client from '../core/client.ts';
import { assertRuntimeFixtureDatabase } from '../runtime-fixture-database.ts';
import {
  createPostgresNativeScheduleObservationLedger,
  type NativeScheduleSnapshotReceiptInput,
} from './native-schedule-observation-ledger.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const lockObservation = { timeout: 5_000 };
suite(
  'actual observation receipt migration/SQL; no producer, native, model or VM authority',
  // Budget for PostgreSQL setup and assertions around the real five-second teardown.
  { timeout: 15_000 },
  () => {
    let admin: ReturnType<typeof postgres>, db: ReturnType<typeof postgres>;
    const schema = 'met285_ledger_' + randomUUID().replaceAll('-', '');
    const origin = {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      personId: randomUUID(),
      vmId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
      employeeInstanceId: randomUUID(),
      employeeRevision: 1,
      employeeVersionId: randomUUID(),
      bindingRef: 'isolated-provenance-not-authority',
    };
    const items = [
      {
        fingerprint: 'sha256:' + 'a'.repeat(64),
        id: 'native-task',
        scheduledAt: '2099-01-01T00:00:00.000Z',
        sessionId: 'native-session',
        status: 'active' as const,
      },
    ];
    const batch = {
      items,
      fingerprint:
        'sha256:' +
        createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    };
    const input = (
      extra: Partial<NativeScheduleSnapshotReceiptInput> = {},
    ): NativeScheduleSnapshotReceiptInput => ({
      kind: 'snapshot',
      receiptId: randomUUID(),
      origin,
      batch,
      invalidateReceiptIds: [],
      ...extra,
    });
    const ledger = () => createPostgresNativeScheduleObservationLedger(db);
    const blockedBy = (
      holder: number,
      statement: string,
      applicationName = schema,
    ) =>
      admin<{ pid: number }[]>`select pid from pg_stat_activity
        where datname=current_database() and application_name=${applicationName}
          and state='active' and wait_event_type='Lock'
          and query like ${statement + '%'}
          and ${holder}=any(pg_blocking_pids(pid))`;

    beforeAll(async () => {
      // Apply the allocated product migration, never replacement fixture DDL.
      const ddl = await readFile(
        new URL(
          '../../migrations/0257_native_schedule_observation_receipts.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const source = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!source) throw Error('Dedicated ALLRICE_TEST_DATABASE_URL required');
      assertRuntimeFixtureDatabase(new URL(source));
      admin = postgres(source, { max: 1 });
      await admin.unsafe(`create schema ${schema}`);
      db = postgres(source, {
        max: 4,
        connection: { search_path: schema, application_name: schema },
      });
      await db.unsafe(ddl);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      try {
        await db?.end({ timeout: 5 });
      } finally {
        try {
          if (admin)
            await admin.unsafe(`drop schema if exists ${schema} cascade`);
        } finally {
          await admin?.end({ timeout: 5 });
        }
      }
    });

    it('stores complete immutable facts and reconciles the exact original operation across a new reader', async () => {
      const request = input(),
        first = await ledger().commitBatch(request);
      expect(first.operation).toEqual(request);
      expect(await ledger().readExactReceipt(request)).toEqual(first);
      expect(await ledger().commitBatch(structuredClone(request))).toEqual(
        first,
      );
      expect(await ledger().readExactReceipt(input())).toBeNull();
      expect(first).not.toHaveProperty('current');
      expect(first).not.toHaveProperty('wakeEligible');
    });

    it('commits concurrent identical receipts once and rejects changed or cross-scope reuse', async () => {
      const request = input();
      const [a, b] = await Promise.all([
        ledger().commitBatch(request),
        ledger().commitBatch(request),
      ]);
      expect(a).toEqual(b);
      await expect(
        ledger().commitBatch({
          ...request,
          origin: { ...origin, employeeRevision: 2 },
        }),
      ).rejects.toMatchObject({ code: 'receipt_conflict' });
      const foreign = {
        ...request,
        origin: { ...origin, personId: randomUUID() },
      };
      expect(await ledger().readExactReceipt(foreign)).toBeNull();
      await expect(ledger().commitBatch(foreign)).rejects.toMatchObject({
        code: 'receipt_conflict',
      });
    });

    it('uses the real migration to forbid mutation or deletion of an existing receipt', async () => {
      const request = input();
      const stored = await ledger().commitBatch(request);
      await expect(
        db`update allrice_native_schedule_observation_receipts set received_at=now() where receipt_id=${request.receiptId}`,
      ).rejects.toBeDefined();
      await expect(
        db`delete from allrice_native_schedule_observation_receipts where receipt_id=${request.receiptId}`,
      ).rejects.toBeDefined();
      expect(await ledger().readExactReceipt(request)).toEqual(stored);
    });

    it('uses the real migration to bind payload scope and reject an incomplete snapshot shape', async () => {
      const request = input();
      for (const payload of [
        { ...request, origin: { ...origin, personId: randomUUID() } },
        { ...request, batch: { items: [] } },
      ]) {
        await expect(
          db`insert into allrice_native_schedule_observation_receipts
            (receipt_id,organization_id,workspace_id,person_id,vm_id,employee_instance_id,input_digest,input_payload)
            values(${request.receiptId},${origin.organizationId},${origin.workspaceId},${origin.personId},${origin.vmId},${origin.employeeInstanceId},
              ${'sha256:' + 'a'.repeat(64)},${db.json(JSON.parse(JSON.stringify(payload)))})`,
        ).rejects.toMatchObject({ code: '23514' });
      }
      expect(await ledger().readExactReceipt(request)).toBeNull();
    });

    it('atomically records a new snapshot and exact old invalidations, retaining the old evidence', async () => {
      const old = input();
      await ledger().commitBatch(old);
      const next = input({
        invalidateReceiptIds: [old.receiptId],
        origin: { ...origin, leaseEpoch: 2, instanceId: randomUUID() },
        batch: {
          items: [],
          fingerprint:
            'sha256:' + createHash('sha256').update('[]').digest('hex'),
        },
      });
      expect((await ledger().commitBatch(next)).operation).toEqual(next);
      expect((await ledger().readExactReceipt(old))!.operation).toEqual(old);
      const missing = input({ invalidateReceiptIds: [randomUUID()] });
      await expect(ledger().commitBatch(missing)).rejects.toMatchObject({
        code: 'invalid_receipt_reference',
      });
      expect(await ledger().readExactReceipt(missing)).toBeNull();
    });

    it('records explicit invalidation and refuses cross-scope or non-snapshot targets', async () => {
      const old = input();
      await ledger().commitBatch(old);
      const invalidation = {
        kind: 'invalidation' as const,
        receiptId: randomUUID(),
        origin,
        invalidateReceiptIds: [old.receiptId],
        reasonRef: 'owner-observed-source-loss',
      };
      expect(
        (await ledger().invalidateReceipts(invalidation)).operation,
      ).toEqual(invalidation);
      expect(await ledger().readExactReceipt(invalidation)).not.toBeNull();
      await expect(
        ledger().invalidateReceipts({
          ...invalidation,
          receiptId: randomUUID(),
          invalidateReceiptIds: [invalidation.receiptId],
        }),
      ).rejects.toMatchObject({ code: 'invalid_receipt_reference' });
      await expect(
        ledger().invalidateReceipts({
          ...invalidation,
          receiptId: randomUUID(),
          origin: { ...origin, employeeInstanceId: randomUUID() },
        }),
      ).rejects.toMatchObject({ code: 'invalid_receipt_reference' });
    });

    it('reads the original durable receipt after the real COMMIT succeeds but its reply is lost', async () => {
      const request = input(),
        error = Error('synthetic reply lost after actual commit');
      const create = client.createDedicatedDatabase;
      const dedicated = vi
        .spyOn(client, 'createDedicatedDatabase')
        .mockImplementationOnce((source) => {
          const owned = create(source);
          return new Proxy(owned, {
            get(target, key, receiver) {
              if (key !== 'reserve') return Reflect.get(target, key, receiver);
              return async () => {
                const session = await owned.reserve();
                return new Proxy(session, {
                  apply(target, receiver, args) {
                    const query: unknown = Reflect.apply(
                      target,
                      receiver,
                      args,
                    );
                    if (Array.isArray(args[0]) && args[0].join('') === 'commit')
                      return Promise.resolve(query).then(() => {
                        throw error;
                      });
                    return query;
                  },
                });
              };
            },
          });
        });
      await expect(ledger().commitBatch(request)).rejects.toBe(error);
      expect(dedicated).toHaveBeenCalledOnce();
      expect((await ledger().readExactReceipt(request))!.operation).toEqual(
        request,
      );
      const [row] = await db<
        { count: number }[]
      >`select count(*)::int count from allrice_native_schedule_observation_receipts where receipt_id=${request.receiptId}`;
      expect(row!.count).toBe(1);
    });

    it('joins dedicated client cleanup after an actual blocked write disconnects', async () => {
      const old = input(),
        original = await ledger().commitBatch(old);
      const blocker = await db.reserve();
      const request = input({ invalidateReceiptIds: [old.receiptId] });
      const create = client.createDedicatedDatabase;
      const inserts: PromiseLike<unknown>[] = [];
      let closed!: () => void, releaseEnd!: () => void;
      const clientClosed = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const finishEnd = new Promise<void>((resolve) => {
        releaseEnd = resolve;
      });
      vi.spyOn(client, 'createDedicatedDatabase').mockImplementationOnce(
        (source) => {
          const owned = create(source);
          const reserve = owned.reserve;
          vi.spyOn(owned, 'reserve').mockImplementationOnce(async () => {
            return new Proxy(await reserve(), {
              apply(sql, receiver, args) {
                const query: unknown = Reflect.apply(sql, receiver, args);
                const parts: unknown = args[0];
                // Capture the actual native query without changing execution.
                if (
                  Array.isArray(parts) &&
                  typeof parts[0] === 'string' &&
                  parts[0].startsWith(
                    'insert into allrice_native_schedule_observation_receipts',
                  )
                )
                  inserts.push(query as PromiseLike<unknown>);
                return query;
              },
            });
          });
          const end = owned.end;
          vi.spyOn(owned, 'end').mockImplementationOnce(async (options) => {
            await end(options);
            closed();
            await finishEnd;
          });
          return owned;
        },
      );
      const settled = vi.fn();
      let outcome: Promise<unknown> | undefined;
      try {
        await blocker`begin`;
        await blocker`lock table allrice_native_schedule_observation_receipts in share mode`;
        const [holder] = await blocker<
          { pid: number }[]
        >`select pg_backend_pid() pid`;
        outcome = ledger()
          .commitBatch(request)
          .finally(settled)
          .catch((error: unknown) => error);
        const blockedWrite = () =>
          blockedBy(
            holder!.pid,
            'insert into allrice_native_schedule_observation_receipts',
          );
        await expect.poll(blockedWrite, lockObservation).toHaveLength(1);
        const [victim] = await blockedWrite();
        expect(inserts).toHaveLength(1);
        const nativeFailure = Promise.resolve(inserts[0]!).catch(
          (error: unknown) => error,
        );
        const [terminated] = await admin<
          { stopped: boolean }[]
        >`select pg_terminate_backend(pid, 5000) stopped from pg_stat_activity
      where datname=current_database() and application_name=${schema}
      and pid=${victim!.pid} and ${holder!.pid}=any(pg_blocking_pids(pid))`;
        expect(terminated?.stopped).toBe(true);
        await Promise.race([
          clientClosed,
          outcome.then(() => {
            throw Error('Caller settled before the owned client closed');
          }),
        ]);
        expect(settled).not.toHaveBeenCalled();
        releaseEnd();
        const originalError = await nativeFailure;
        expect(originalError).toBeInstanceOf(Error);
        expect(await outcome).toBe(originalError);
        expect(inserts).toHaveLength(1);
        expect(
          await admin`select pid from pg_stat_activity where pid=${victim!.pid}`,
        ).toEqual([]);
      } finally {
        releaseEnd();
        try {
          await blocker`rollback`;
        } finally {
          blocker.release();
          await outcome;
        }
      }
      expect(await ledger().readExactReceipt(request)).toBeNull();
      expect(await ledger().readExactReceipt(old)).toEqual(original);
    });

    it('cancels real lock-wait SQL and joins rollback before returning both observed failures', async () => {
      const blocker = await db.reserve();
      const applicationName = schema + '_cancel';
      const request = input(),
        abort = new AbortController();
      let caught: Promise<unknown> | undefined;
      let writer: ReturnType<typeof client.createDedicatedDatabase> | undefined;
      try {
        await blocker`begin`;
        await blocker`lock table allrice_native_schedule_observation_receipts in access exclusive mode`;
        const [holder] = await blocker<
          { pid: number }[]
        >`select pg_backend_pid() pid`;
        // The caller clones this application name for its own connection.
        // An earlier receipt lookup can have the same SQL and blocker.
        writer = client.createDedicatedDatabase({
          options: {
            ...db.options,
            connection: {
              ...db.options.connection,
              application_name: applicationName,
            },
          },
        });
        caught = createPostgresNativeScheduleObservationLedger(writer)
          .commitBatch(request, abort.signal)
          .catch((error: unknown) => error);
        await expect
          .poll(
            () =>
              blockedBy(
                holder!.pid,
                'select receipt_id,input_digest,input_payload,received_at',
                applicationName,
              ),
            lockObservation,
          )
          .toHaveLength(1);
        abort.abort();
        const error = await caught;
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors.at(-1)).toBe(
          abort.signal.reason,
        );
        expect((error as Error).cause).toMatchObject({ code: '57014' });
      } finally {
        abort.abort();
        try {
          await blocker`rollback`;
        } finally {
          blocker.release();
          await Promise.all([caught, writer?.end({ timeout: 5 })]);
        }
      }
      expect(await ledger().readExactReceipt(request)).toBeNull();
    });
  },
);
