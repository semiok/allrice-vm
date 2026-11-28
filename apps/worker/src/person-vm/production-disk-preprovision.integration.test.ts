import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import {
  createDEntryAuthorityFeed,
  createEmployeeInstance,
  ensureBootstrapPortalPrincipal,
  readPersonVmDiskPreparationForegroundBusy,
  readPersonVmDiskPreparationRoster,
  readPersonVmDiskPreparationTarget,
} from '@allrice/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { deferred } from '../../../../packages/d-entry-principal/test/host-fixture.ts';
import { startProductionDiskPreprovision } from './production-disk-preprovision.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const loopback = '127.0.0.1';
const firstListen = Buffer.from('LISTEN allrice_d_entry_authority\0');
const firstQualificationQuery = [
  Buffer.from('from pg_catalog.pg_type'),
  Buffer.from('begin isolation level repeatable read read only'),
];
const poll = { timeout: 5_000, interval: 25 };
type Hold = 'startup' | 'listen' | 'qualification' | null;
type ScannerInput = Parameters<typeof startProductionDiskPreprovision>[0];

// Both endpoints connect to real drivers. Observe only fixed query markers,
// including across TCP reads. The relay never logs packets or destroys the
// driver-facing socket to satisfy a test.
async function relay(dbUrl: URL, hold: Hold = null) {
  const sockets = new Set<Socket>();
  const peers: {
    upstream: Socket;
    port?: number;
    held: boolean;
    clientClosed: boolean;
    upstreamClosed: boolean;
  }[] = [];
  const server = createServer({ allowHalfOpen: true }, (clientSocket) => {
    let holding = peers.length === 0 && hold === 'startup';
    let markers =
      peers.length === 0 && hold === 'listen'
        ? [firstListen]
        : peers.length === 1 && hold === 'qualification'
          ? firstQualificationQuery
          : [];
    const tailSize = Math.max(...markers.map((marker) => marker.length), 1) - 1;
    let tail = Buffer.alloc(0);
    const upstream = createConnection({
      host: loopback,
      port: Number(dbUrl.port),
      allowHalfOpen: true,
    });
    const peer: (typeof peers)[number] = {
      upstream,
      held: false,
      clientClosed: false,
      upstreamClosed: false,
    };
    peers.push(peer);
    sockets.add(clientSocket);
    sockets.add(upstream);
    upstream.once('connect', () => {
      peer.port = upstream.localPort;
    });
    clientSocket.on('data', (chunk: Buffer) => {
      if (markers.length) {
        const frame = Buffer.concat([tail, chunk]);
        if (markers.some((marker) => frame.includes(marker))) {
          holding = true;
          markers = [];
          tail = Buffer.alloc(0);
        } else tail = frame.subarray(-tailSize);
      }
      if (!upstream.destroyed) upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      if (holding) peer.held = true;
      else if (!clientSocket.destroyed) clientSocket.write(chunk);
    });
    clientSocket.on('error', () => upstream.destroy());
    upstream.on('error', () => clientSocket.end());
    clientSocket.once('close', () => {
      peer.clientClosed = true;
      sockets.delete(clientSocket);
      upstream.end();
    });
    upstream.once('close', () => {
      peer.upstreamClosed = true;
      sockets.delete(upstream);
      clientSocket.end();
    });
    // TCP half-close is forwarded without destroying the opposite end.
    clientSocket.once('end', () => upstream.end());
    upstream.once('end', () => clientSocket.end());
  });
  server.listen(0, loopback);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('TCP relay not bound');
  const url = new URL(dbUrl);
  url.port = String(address.port);
  return {
    url,
    peers,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
type Relay = Awaited<ReturnType<typeof relay>>;
type Peer = Relay['peers'][number];

suite('disk-preprovision scanner with actual PostgreSQL sockets', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let databaseUrl: URL;
  let personId: string;
  let employeeId: string;

  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
    const { db } = fixture;
    const [schema] = await db<
      { name: string }[]
    >`select current_schema() as name`;
    expect(schema.name).toMatch(/^p25_[a-f0-9]{32}$/);
    databaseUrl = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
    databaseUrl.searchParams.set('sslmode', 'disable');
    databaseUrl.searchParams.set('options', '-csearch_path=' + schema.name);
    const owner = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug: 'preprovision-socket',
        organizationName: 'Synthetic disk-preprovision',
        workspaceSlug: 'test',
        workspaceName: 'Test',
        email: 'disk-preprovision@example.test',
        displayName: 'Synthetic member',
        role: 'member',
      },
      db,
    );
    personId = owner.user.id;
    await db`insert into allrice_settings(scope_type,key,value,updated_by)
      values('system','d_entry_rollout_policy',${db.json({
        revision: randomUUID(),
        defaultGeneration: '3.x',
        selections: [{ organizationId: owner.organizationId, personId }],
      })},${personId})`;
    const dbSetup = vi.spyOn(client, 'getDatabase').mockReturnValue(db);
    try {
      const employee = await createEmployeeInstance(
        {
          actor: { type: 'user', id: personId },
          organizationId: owner.organizationId,
          workspaceId: owner.workspaceId,
          requestId: randomUUID(),
        },
        {
          workspaceId: owner.workspaceId,
          expectedOwnerId: personId,
          requestId: randomUUID(),
          profile: { name: 'Synthetic employee' },
        },
      );
      employeeId = employee.id;
    } finally {
      dbSetup.mockRestore();
    }
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
  }, 30_000);

  async function backends(peer: Peer) {
    if (!peer.port) throw Error('Relay never connected to PostgreSQL');
    return fixture.db<
      {
        pid: number;
        state: string | null;
        query: string;
        wait_event_type: string | null;
      }[]
    >`select pid,state,query,wait_event_type from pg_stat_activity
      where datname=current_database() and usename=current_user
        and client_addr='127.0.0.1'::inet and client_port=${peer.port}`;
  }
  async function closed(peer: Peer) {
    await expect
      .poll(() => [peer.clientClosed, peer.upstreamClosed], poll)
      .toEqual([true, true]);
    await expect.poll(() => backends(peer), poll).toEqual([]);
  }

  async function withScanner(
    hold: Hold,
    run: (input: {
      feed: Relay;
      reads: Relay;
      owner: ReturnType<typeof startProductionDiskPreprovision>;
      openFeed: ReturnType<typeof vi.fn<ScannerInput['openFeed']>>;
      readRoster: ReturnType<typeof vi.fn<ScannerInput['readRoster']>>;
      prepared: ReturnType<typeof vi.fn<ScannerInput['port']['prepare']>>;
      outcomes: string[];
      previousFeedClosed: boolean[];
      settledReadsAtFeedOpen: number[];
    }) => Promise<void>,
    holdQualification = false,
  ) {
    const feed = await relay(databaseUrl, hold);
    const reads = await relay(
      databaseUrl,
      holdQualification ? 'qualification' : null,
    ).catch(async (error: unknown) => {
      await feed.close();
      throw error;
    });
    vi.stubEnv('DATABASE_URL', reads.url.toString());
    const outcomes: string[] = [];
    const previousFeedClosed: boolean[] = [];
    const settledReadsAtFeedOpen: number[] = [];
    const openFeed = vi.fn<ScannerInput['openFeed']>(() => {
      const prev = feed.peers.at(-1);
      if (prev)
        previousFeedClosed.push(prev.clientClosed && prev.upstreamClosed);
      settledReadsAtFeedOpen.push(outcomes.length);
      return createDEntryAuthorityFeed(feed.url.toString());
    });
    const readRoster = vi.fn(readPersonVmDiskPreparationRoster);
    const prepared = vi.fn<ScannerInput['port']['prepare']>(
      async (target, guard) => {
        expect(target).toMatchObject({
          personId,
          employeeInstanceId: employeeId,
        });
        await guard.assertCurrent();
        return 'prepared';
      },
    );
    const owner = startProductionDiskPreprovision({
      lifetime: new AbortController().signal,
      openFeed,
      readRoster,
      async readTarget(id, signal) {
        try {
          const target = await readPersonVmDiskPreparationTarget(id, signal);
          outcomes.push('fulfilled');
          return target;
        } catch (error) {
          outcomes.push('rejected');
          throw error;
        }
      },
      foregroundBusy: readPersonVmDiskPreparationForegroundBusy,
      availableBytes: async () => 100n,
      minimumFreeBytes: 70,
      reserveBytes: 20,
      port: { prepare: prepared },
      observe: () => {},
    });
    try {
      await run({
        feed,
        reads,
        owner,
        openFeed,
        readRoster,
        prepared,
        outcomes,
        previousFeedClosed,
        settledReadsAtFeedOpen,
      });
    } finally {
      try {
        const cleanup = await Promise.allSettled([
          owner.close(),
          feed.close(),
          reads.close(),
        ]);
        for (const result of cleanup)
          if (result.status === 'rejected') throw result.reason;
      } finally {
        await client.closeDatabase();
        vi.unstubAllEnvs();
      }
    }
  }

  it.each([
    ['startup', 'disconnect'],
    ['listen', 'disconnect'],
    ['idle', 'disconnect'],
    ['startup', 'close'],
    ['listen', 'close'],
  ] as const)(
    'joins the %s notification socket on %s',
    async (phase, action) => {
      await withScanner(phase === 'idle' ? null : phase, async (f) => {
        await expect.poll(() => f.feed.peers.length, poll).toBe(1);
        const first = f.feed.peers[0]!;
        if (phase === 'idle') {
          await expect
            .poll(() => f.outcomes.length, poll)
            .toBeGreaterThanOrEqual(3);
          await expect
            .poll(() => f.prepared.mock.results[0]?.value, poll)
            .toBe('prepared');
          await expect
            .poll(() => backends(first), poll)
            .toMatchObject([
              { state: 'idle', query: 'LISTEN allrice_d_entry_ticket_fence' },
            ]);
        } else {
          await expect.poll(() => first.held, poll).toBe(true);
          if (phase === 'listen') {
            await expect
              .poll(() => backends(first), poll)
              .toMatchObject([{ query: 'LISTEN allrice_d_entry_authority' }]);
          }
          expect(f.readRoster).not.toHaveBeenCalled();
          expect(f.prepared).not.toHaveBeenCalled();
        }
        if (action === 'close') {
          await f.owner.close();
          expect(f.openFeed).toHaveBeenCalledTimes(1);
        } else {
          first.upstream.destroy();
        }
        await closed(first);
        if (action === 'disconnect') {
          const expectedSweeps = phase === 'idle' ? 2 : 1;
          await expect
            .poll(
              () => f.readRoster.mock.results[expectedSweeps - 1]?.value,
              poll,
            )
            .toHaveProperty('page');
          if (phase !== 'idle')
            await expect
              .poll(() => f.prepared.mock.results[0]?.value, poll)
              .toBe('prepared');
          expect(f.previousFeedClosed).toEqual([true]);
          await f.owner.close();
          await closed(f.feed.peers[1]!);
        }
        expect(await fixture.db`select 1 as ok`).toEqual([{ ok: 1 }]);
      });
    },
    20_000,
  );

  it('closes a fresh qualification connection during its first SQL response', async () => {
    await withScanner(
      null,
      async (f) => {
        await expect.poll(() => f.reads.peers[1]?.held, poll).toBe(true);
        expect(f.outcomes).toEqual([]);
        expect(f.prepared).not.toHaveBeenCalled();
        await f.owner.close();
        expect(f.outcomes).toEqual(['rejected']);
        expect(f.openFeed).toHaveBeenCalledTimes(1);
        await Promise.all([...f.feed.peers, ...f.reads.peers].map(closed));
      },
      true,
    );
  }, 20_000);

  it.each(['disconnect', 'close'] as const)(
    'settles the blocked qualification transaction and sockets on %s',
    async (action) => {
      const locked = deferred<void>();
      const release = deferred<void>();
      const lock = fixture.db.begin(async (tx) => {
        await tx`lock table person_virtual_machines in access exclusive mode`;
        locked.resolve();
        await release.promise;
      });
      try {
        await Promise.race([locked.promise, lock]);
        await withScanner(null, async (f) => {
          await expect.poll(() => f.reads.peers.length, poll).toBe(2);
          const [roster, target] = f.reads.peers;
          await closed(roster!); // A successful dedicated read does not stay idle.
          const peer = target!;
          let heldPid: number | undefined;
          await expect
            .poll(async () => {
              const [backend] = await backends(peer);
              if (
                backend?.wait_event_type === 'Lock' &&
                backend.query.includes('from person_virtual_machines')
              )
                heldPid = backend.pid;
              return heldPid;
            }, poll)
            .toBeTypeOf('number');
          expect(f.outcomes).toEqual([]);
          expect(f.prepared).not.toHaveBeenCalled();
          if (action === 'disconnect') {
            expect(
              await fixture.db`select pg_terminate_backend(pid) as stopped
                from pg_stat_activity where pid=${heldPid!}
                  and datname=current_database() and usename=current_user
                  and client_addr='127.0.0.1'::inet and client_port=${peer.port!}`,
            ).toEqual([{ stopped: true }]);
          } else {
            await f.owner.close();
          }
          await closed(peer);
          await expect.poll(() => f.outcomes, poll).toEqual(['rejected']);
          expect(f.prepared).not.toHaveBeenCalled();
          if (action === 'disconnect') {
            release.resolve();
            await lock;
            await expect
              .poll(() => f.prepared.mock.results[0]?.value, poll)
              .toBe('prepared');
            expect(f.settledReadsAtFeedOpen).toEqual([0, 1]);
            expect(f.previousFeedClosed).toEqual([true]);
          } else {
            expect(f.openFeed).toHaveBeenCalledTimes(1);
          }
          await f.owner.close();
          await Promise.all([...f.feed.peers, ...f.reads.peers].map(closed));
        });
      } finally {
        release.resolve();
        await lock;
      }
    },
    20_000,
  );
});
