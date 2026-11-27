import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  closeServer,
  deferred,
  listen,
} from '../../../../packages/model-gateway/src/gateway.fixture.js';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { serverResponseSchema } from '@deepseek-ai/dsh-client-connection';
import { TYPERT_REMOTE as NATIVE_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types';
import type { DEntryPrincipalIssue } from '@allrice/d-entry-principal/types';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type WebSocket from 'ws';
import { hostFixture } from '../../../../packages/d-entry-principal/test/host-fixture.js';
import * as PrincipalControl from '../d-entry/principal-control.js';
import { holdReleasedProfile } from '../d-entry/released-profile.js';
import {
  PersonVmError,
  type PersonVmBootstrapScope,
  type PersonVmManagedJob,
} from '@allrice/person-vm';
import * as NativeTransport from './transport.js';
import { setupNativeWebFixture } from './owner.native.fixture.js';
import {
  waitForPromptFact,
  type NativePromptObservation,
} from './prompt-observation.js';

// Actual published rc.2 entry, not a fixture protocol server. Its complete
// compatible-OS package tree must be provisioned separately and recorded.
const cli = process.env.ALLRICE_NATIVE_WEB_TEST_CLI;
const tag = 'manual:ALLRICE_NATIVE_WEB_TEST_CLI';
const roots: string[] = [],
  cleanup: (() => Promise<void>)[] = [];
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  const joined = await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  const failure = joined.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
});
function setup(
  prepareScope?: (
    scope: PersonVmBootstrapScope,
    lifetime: AbortController,
  ) => void,
) {
  return setupNativeWebFixture(cli, roots, cleanup, prepareScope);
}

it.skipIf(!cli)(
  '真实rc.2产物交换API Cookie→认证list/control baseline；scope结束不杀长期job，close实际join',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    expect(f.owner.controlReady()).toBe(true);
    const signal = new AbortController().signal;
    await expect(
      f.owner.verifyStartingEditor({ ...f.scope }, signal, async () => {}),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await f.owner.verifyStartingEditor(
      f.scope,
      signal,
      async (source, readModels, active) => {
        const held = await holdReleasedProfile(
          f.seal.directory,
          source,
          active,
          f.seal.manifestSha256,
        );
        expect(held.graph.entries.length).toBeGreaterThan(0);
        expect((await readModels()).ok).toBe(true);
      },
    );
    expect(f.current).not.toHaveBeenCalled();
    f.startup.abort();
    await expect(
      f.owner.verifyStartingEditor(f.scope, signal, async () => {}),
    ).rejects.toBe(f.startup.signal.reason);
    const created = await f.owner.createRootFor(f.context, {}, signal);
    expect(created.ok).toBe(true);
    const sessions = await f.owner.readSessions(signal);
    expect(sessions.ok).toBe(true);
    expect(f.current).toHaveBeenCalledTimes(4);
    expect(f.child.exitCode).toBe(null);
    await Promise.all([f.owner.close(), f.owner.close()]);
    expect(f.owner.controlReady()).toBe(false);
    expect(f.kills()).toBe(1);
    expect(f.child.exitCode !== null || f.child.signalCode !== null).toBe(true);
  },
);

it.skipIf(!cli)(
  'observes the actual rc.2 scoped prompt, native idempotent receipt, and exact queued remove',
  { tags: [tag], timeout: 30000 },
  async () => {
    const firstModel = deferred(),
      releaseModel = deferred();
    const observing = new AbortController();
    const accepted = new Map<string, Promise<boolean>[]>();
    const observations = new Map<string, NativePromptObservation[]>();
    let promptLogin: string | undefined;
    let assistantReferences = 0;
    const server = createServer((request, response) => {
      void (async () => {
        const bytes: Buffer[] = [];
        for await (const chunk of request) bytes.push(Buffer.from(chunk));
        if (request.url?.startsWith('/v1/reference')) {
          if (request.url === '/v1/reference') assistantReferences++;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ reference: 'r'.repeat(43) }));
          return;
        }
        expect(request.url).toBe('/v1/stream');
        const payload = JSON.parse(Buffer.concat(bytes).toString('utf8'));
        if (payload.purpose !== 'session-title') {
          firstModel.resolve();
          await releaseModel.promise;
        }
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(
          JSON.stringify({ type: 'finish', reason: { kind: 'stop' } }) + '\n',
        );
      })().catch((error: unknown) => {
        firstModel.reject(error);
        response.destroy();
      });
    });
    const origin = await listen(server);
    cleanup.push(async () => {
      observing.abort();
      releaseModel.resolve();
      await closeServer(server);
    });
    const f = await setupNativeWebFixture(
      cli,
      roots,
      cleanup,
      undefined,
      undefined,
      {
        origin,
        capability: 'q'.repeat(43),
        provider: 'openai-codex',
        model: 'fixture-codex',
        modelInfo: {
          provider: 'openai-codex',
          id: 'fixture-codex',
          name: 'fixture-codex',
          inputModalities: ['text'],
        },
      },
      async (request) => {
        if (request.endpoint === 'session/updateQueue') {
          if (request.context.sessionId !== promptLogin)
            throw new PersonVmError('VM_ACTIVE');
          return;
        }
        promptLogin ??= request.context.sessionId;
        const { requestId, observe } = request;
        const observation = observe(observing.signal);
        const group = observations.get(requestId) ?? [];
        group.push(observation);
        observations.set(requestId, group);
        await observation.ready;
        return {
          undispatched: () => observation.close(),
          accepted() {
            const replies = accepted.get(requestId) ?? [];
            replies.push(observation.confirmedReplay());
            accepted.set(requestId, replies);
          },
          unknown() {},
        };
      },
    );
    const signal = AbortSignal.timeout(15000);
    const created = await f.owner.createRootFor(f.context, {}, signal);
    if (!created.ok) throw Error('Native root unavailable');
    const sessionId = created.value.sessionId;
    const issue: DEntryPrincipalIssue = {
      scopeId: randomUUID(),
      access: 'execute',
      identity: {
        ...f.principalProfile,
        organizationId: f.owner.binding.organizationId,
        personId: f.owner.binding.personId,
        threadId: randomUUID(),
      },
      root: {
        nativeSessionId: sessionId,
        rootOriginDigest: 'manual-test-native-create-only',
        rootBindingRef: 'manual-test-no-sql-permit',
      },
    };
    const activity = f.owner.acquirePrincipal(issue, signal, f.context);
    const scope = await activity.run(signal);
    const prompt = (requestId: string, text: string) =>
      scope.invoke(
        {
          endpoint: 'session/prompt',
          scopeId: issue.scopeId,
          args: NATIVE_REMOTE.methods['session/prompt']
            .input({ strict: true })
            .create()
            .parse({
              request: {
                sessionId,
                requestId,
                mode: 'queue',
                content: [{ type: 'text', text }],
              },
            }),
        },
        signal,
      );
    try {
      const firstId = randomUUID(),
        queuedId = randomUUID();
      const receipt = { endpoint: 'session/prompt', value: { accepted: true } };
      expect(await prompt(firstId, 'Native active turn')).toEqual(receipt);
      await waitForPromptFact(firstModel.promise, signal);
      await observations.get(firstId)![0]!.assertClaimed(signal);

      expect(await prompt(queuedId, 'Native pending occurrence')).toEqual(
        receipt,
      );
      expect(
        await prompt(queuedId, 'Native replay of that occurrence'),
      ).toEqual(receipt);
      expect(await Promise.all(accepted.get(queuedId)!)).toEqual([false, true]);
      await observations.get(queuedId)![1]!.close();
      const view = await scope.invoke(
        {
          endpoint: 'session/projections',
          scopeId: issue.scopeId,
          args: { request: { sessionId } },
        },
        signal,
      );
      if (view.endpoint !== 'session/projections' || !view.value)
        throw Error('Native inbox projection unavailable');
      const pending = view.value.values.inbox?.['next-turn'];
      expect(pending).toHaveLength(1);
      const item = pending?.[0];
      if (
        !item ||
        typeof item !== 'object' ||
        !('id' in item) ||
        typeof item.id !== 'string'
      )
        throw Error('Native inbox item ID unavailable');
      const updateQueue = (
        target: typeof scope,
        scopeId: string,
        action: unknown,
      ) =>
        target.invoke(
          {
            endpoint: 'session/updateQueue',
            scopeId,
            args: NATIVE_REMOTE.methods['session/updateQueue']
              .input({ strict: true })
              .create()
              .parse({
                request: {
                  sessionId,
                  itemId: item.id,
                  action,
                },
              }),
          },
          signal,
        );
      const otherIssue = { ...issue, scopeId: randomUUID() };
      const other = f.owner.acquirePrincipal(otherIssue, signal, {
        ...f.context,
        sessionId: randomUUID(),
      });
      try {
        const otherScope = await other.run(signal);
        for (const action of [
          {
            kind: 'edit',
            content: [{ type: 'text', text: 'Different login' }],
          },
          { kind: 'remove' },
          { kind: 'steer' },
        ]) {
          await expect(
            updateQueue(otherScope, otherIssue.scopeId, action),
          ).rejects.toHaveProperty('code', 'VM_ACTIVE');
        }
        const unchanged = await scope.invoke(
          {
            endpoint: 'session/projections',
            scopeId: issue.scopeId,
            args: { request: { sessionId } },
          },
          signal,
        );
        expect(unchanged).toMatchObject({
          value: { values: { inbox: { 'next-turn': [item] } } },
        });
      } finally {
        await other.close();
      }
      expect(
        await updateQueue(scope, issue.scopeId, { kind: 'remove' }),
      ).toEqual({ endpoint: 'session/updateQueue', value: { accepted: true } });
      await expect(
        waitForPromptFact(observations.get(queuedId)![0]!.settled, signal),
      ).resolves.toBe('discarded');
      await expect(prompt(randomUUID(), ' \n ')).rejects.toHaveProperty(
        'code',
        'gateway/bad-request',
      );
      releaseModel.resolve();
      await expect(
        waitForPromptFact(observations.get(firstId)![0]!.settled, signal),
      ).resolves.toBe('ended');
      expect(assistantReferences).toBe(1);
    } finally {
      observing.abort();
      releaseModel.resolve();
      await activity.close();
    }
  },
);

it.skipIf(!cli)(
  'proves a continuable child after the parent ends and both native wakeups on the idle parent',
  { tags: [tag], timeout: 30000 },
  async () => {
    const rootReady = deferred<{
      id: string;
      owner: Awaited<ReturnType<typeof setup>>['owner'];
      context: Awaited<ReturnType<typeof setup>>['context'];
    }>();
    const rootEnded = deferred();
    const relayEnded = deferred();
    const finished = deferred();
    for (const ready of [rootReady, rootEnded, relayEnded, finished])
      void ready.promise.catch(() => {});
    const signal = AbortSignal.timeout(25000);
    const capability = 'a'.repeat(43);
    const requestId = randomUUID();
    const attempts = new Map<string, number>();
    const refs = new Map<
      string,
      { session: string; ordinal: number; title: boolean }
    >();
    const turns: number[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const { id: root, owner, context } = await rootReady.promise;
        const bytes: Buffer[] = [];
        for await (const chunk of request) bytes.push(Buffer.from(chunk));
        expect(request.headers.authorization).toBe('Bearer ' + capability);
        const payload = JSON.parse(Buffer.concat(bytes).toString('utf8'));
        const title = request.url === '/v1/reference/session-title';
        if (request.url === '/v1/reference' || title) {
          const session = String(payload.sessionId);
          const isRoot = session === root;
          const address: SessionAddress = isRoot
            ? { kind: 'session', sessionId: SessionId(root) }
            : {
                kind: 'subagent',
                parentSessionId: SessionId(root),
                childSessionId: SessionId(session),
                mode: 'continuable',
              };
          const ordinal = title ? 0 : (attempts.get(session) ?? 0) + 1;
          if (!title) attempts.set(session, ordinal);
          if (!isRoot) await (ordinal === 1 ? rootEnded : relayEnded).promise;
          const proof = await owner.readNativeAttemptFor(
            context,
            address,
            signal,
            title ? 'session-title' : 'assistant',
          );
          expect(proof).toMatchObject({
            recipient: payload.recipient,
            rootSessionId: root,
            promptIds: [requestId],
            delegated: !isRoot || ordinal >= 3,
          });
          if (isRoot && !title) {
            expect(
              await owner.readNativeRootWakeFor(context, root, signal),
            ).toEqual(
              ordinal >= 3
                ? {
                    kind: 'delegated',
                    turn: proof!.turn!,
                    promptIds: [requestId],
                  }
                : { kind: 'clear' },
            );
            turns.push(proof!.turn!);
            if (ordinal >= 2) {
              expect(ordinal).toBeLessThanOrEqual(4);
              const joined =
                ordinal === 2
                  ? rootEnded
                  : ordinal === 3
                    ? relayEnded
                    : finished;
              void owner
                .waitNativeTurnEnd(context, address, proof!.turn!, signal)
                .then((end) => {
                  expect(end.reason).toBe('completed');
                  joined.resolve();
                })
                .catch(joined.reject);
            }
          }
          const reference = randomBytes(32).toString('base64url');
          refs.set(reference, { session, ordinal, title });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ reference }));
          return;
        }
        expect(request.url).toBe('/v1/stream');
        const entry = refs.get(
          String(request.headers['x-allrice-model-call-reference']),
        );
        if (!entry)
          throw Error('The native adapter did not redeem its reference');
        const { session, ordinal, title: isTitle } = entry;
        const tool = isTitle
          ? null
          : session === root && ordinal === 1
            ? {
                name: 'subagent',
                args: {
                  description: 'Read a small catalog',
                  prompt: 'Report when the catalog is ready.',
                },
              }
            : session !== root && ordinal === 1
              ? {
                  name: 'send_message',
                  args: { agent_id: root, message: 'The catalog is ready.' },
                }
              : null;
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(
          [
            tool
              ? {
                  type: 'tool-call-delta',
                  index: 0,
                  id: randomUUID(),
                  name: tool.name,
                  argumentsDelta: JSON.stringify(tool.args),
                }
              : { type: 'text-delta', index: 0, text: 'Catalog checked.' },
            { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } },
          ]
            .map((chunk) => JSON.stringify(chunk) + '\n')
            .join(''),
        );
      })().catch((error: unknown) => {
        response.destroy();
        rootEnded.reject(error);
        relayEnded.reject(error);
        finished.reject(error);
      });
    });
    const origin = await listen(server);
    cleanup.push(() => closeServer(server));
    const create = NativeTransport.nativeWebTransport;
    let transport: ReturnType<typeof create> | undefined;
    vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
      (...args) => (transport = create(...args)),
    );
    const { owner, context } = await setupNativeWebFixture(
      cli,
      roots,
      cleanup,
      undefined,
      undefined,
      {
        origin,
        capability,
        provider: 'openai-codex',
        model: 'fixture-codex',
        modelInfo: {
          provider: 'openai-codex',
          id: 'fixture-codex',
          name: 'fixture-codex',
        },
      },
    );
    const created = await owner.createRootFor(context, {}, signal);
    if (!created.ok || !transport)
      throw Error('Native owner fixture did not start');
    const sessionId = created.value.sessionId;
    rootReady.resolve({ id: sessionId, owner, context });
    const response = await transport.fetch('api/session/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: 'session/prompt',
        payload: {
          args: {
            request: {
              sessionId,
              requestId,
              content: [
                {
                  type: 'text',
                  text: 'Have a background agent check the catalog and tell me when it reports back.',
                },
              ],
              mode: 'queue',
            },
          },
        },
      }),
    });
    expect(
      serverResponseSchema.parse(await response.json()).result,
    ).toMatchObject({
      ok: true,
      value: { accepted: true },
    });
    await finished.promise;
    expect(
      await owner.readNativeRootWakeFor(context, sessionId, signal),
    ).toEqual({
      kind: 'clear',
    });
    expect(turns).toEqual([1, 1, 2, 3]);
    expect([...attempts.values()].sort()).toEqual([2, 4]);
  },
);

it.skipIf(!cli)(
  'registers the sealed Host model in the actual rc.2 profile and attests the same adapter in authenticated control',
  { tags: [tag], timeout: 30000 },
  async () => {
    const route = {
      origin: 'http://127.0.0.1:1',
      capability: 'a'.repeat(43),
      provider: 'openai-codex',
      model: 'gpt-6.2-sol',
      modelInfo: {
        provider: 'openai-codex',
        id: 'gpt-6.2-sol',
        name: 'GPT-6.2 Sol',
        reasoning: {
          efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
          defaultEffort: ReasoningEffortId('high'),
        },
      },
    };
    const f = await setupNativeWebFixture(
      cli,
      roots,
      cleanup,
      undefined,
      undefined,
      route,
    );
    expect(f.owner.modelAdapterId).toMatch(/^[a-f0-9]{64}$/);
    await f.owner.verifyStartingEditor(
      f.scope,
      new AbortController().signal,
      async (_profile, readModels, _active, installed) => {
        const catalog = await readModels();
        expect(installed).toBe(f.owner.modelAdapterId);
        expect(catalog.value.default).toMatchObject({
          provider: route.provider,
          model: route.model,
          reasoningEffort: 'high',
        });
        expect(catalog.value.routableProviders).toContain(route.provider);
        expect(catalog.value.failures).not.toContainEqual(
          expect.objectContaining({ id: route.provider }),
        );
      },
    );
  },
);

it.skipIf(!cli)(
  'reads live rc.2 attempt proofs and derives an admitted prompt image on the sealed native owner',
  { tags: [tag], timeout: 30000 },
  async () => {
    const primary = deferred(),
      title = deferred();
    void primary.promise.catch(() => {});
    void title.promise.catch(() => {});
    const facts = {
      assistant: { sessionId: '', attemptId: '', redeemed: false },
      'session-title': { sessionId: '', attemptId: '', redeemed: false },
    };
    const recipients = new Map<string, string>();
    const nativePrompt = randomUUID();
    let turnEnd: Promise<{ sequence: number; reason: string }> | undefined;
    const readAttempt =
      deferred<
        (session: string, kind: keyof typeof facts) => Promise<string>
      >();
    const readImage =
      deferred<(sessionId: string, ref: ImageAttachmentRef) => Promise<void>>();
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const capability = 'a'.repeat(43);
    const references = {
      assistant: 'b'.repeat(43),
      'session-title': 'c'.repeat(43),
    };
    const server = createServer((request, response) => {
      void (async () => {
        const bytes: Buffer[] = [];
        for await (const chunk of request) bytes.push(Buffer.from(chunk));
        if (request.headers.authorization !== 'Bearer ' + capability)
          throw Error('Wrong fixture capability');
        if (
          request.url === '/v1/reference' ||
          request.url === '/v1/reference/session-title'
        ) {
          const kind =
            request.url === '/v1/reference' ? 'assistant' : 'session-title';
          const selection = JSON.parse(Buffer.concat(bytes).toString('utf8'));
          if (
            selection.provider !== 'openai-codex' ||
            selection.model !== 'fixture-codex'
          )
            throw Error('Wrong native model selection');
          expect(selection.adapterId).toMatch(/^[a-f0-9]{64}$/);
          expect(selection.recipient).toMatch(/^[A-Za-z0-9_-]{43}$/);
          recipients.set(kind, selection.recipient);
          facts[kind].sessionId = selection.sessionId;
          facts[kind].attemptId = await (
            await readAttempt.promise
          )(selection.sessionId, kind);
          if (!facts[kind].attemptId) throw Error('No current attempt present');
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ reference: references[kind] }));
          return;
        }
        const payload = JSON.parse(Buffer.concat(bytes).toString('utf8'));
        const kind =
          payload.purpose === 'session-title' ? 'session-title' : 'assistant';
        if (
          request.url !== '/v1/stream' ||
          request.headers['x-allrice-model-call-reference'] !== references[kind]
        )
          throw Error('Native adapter did not redeem its reference');
        expect(request.headers['x-allrice-model-call-recipient']).toBe(
          recipients.get(kind),
        );
        if (kind === 'assistant') {
          const message = payload.messages.find(
            (entry: { role: string }) => entry.role === 'user',
          );
          const image = message.content.find(
            (part: { type: string }) => part.type === 'image',
          );
          if (!image?.attachment)
            throw Error('No durable image in native model input');
          await (
            await readImage.promise
          )(facts[kind].sessionId, image.attachment);
        }
        facts[kind].redeemed = true;
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(
          JSON.stringify({ type: 'finish', reason: { kind: 'stop' } }) + '\n',
        );
        (kind === 'assistant' ? primary : title).resolve();
      })().catch((error: unknown) => {
        response.destroy();
        primary.reject(error);
        title.reject(error);
      });
    });
    const browserlessOrigin = await listen(server);
    cleanup.push(() => closeServer(server));
    const create = NativeTransport.nativeWebTransport;
    let transport: ReturnType<typeof create> | undefined;
    vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
      (...args) => {
        transport = create(...args);
        return transport;
      },
    );
    const f = await setupNativeWebFixture(
      cli,
      roots,
      cleanup,
      undefined,
      undefined,
      {
        origin: browserlessOrigin,
        capability,
        provider: 'openai-codex',
        model: 'fixture-codex',
        modelInfo: {
          provider: 'openai-codex',
          id: 'fixture-codex',
          name: 'fixture-codex',
          inputModalities: ['text', 'image'],
        },
      },
    );
    const signal = new AbortController().signal;
    const created = await f.owner.createRootFor(f.context, {}, signal);
    if (!created.ok || !transport)
      throw Error('Native owner fixture did not start');
    const sessionId = created.value.sessionId;
    let journalRead:
      Parameters<typeof f.owner.readPersistedRunTerminalFor>[0] | undefined;
    const guard = async (active: AbortSignal) => active.throwIfAborted();
    readAttempt.resolve(async (requested, kind) => {
      const attempt = await f.owner.readNativeAttemptFor(
        f.context,
        { kind: 'session', sessionId: SessionId(requested) },
        signal,
        kind,
      );
      if (!attempt)
        throw Error(
          'DSH model attempt did not exist on the authenticated owner',
        );
      expect(attempt.recipient).toBe(recipients.get(kind));
      if (kind === 'assistant') {
        expect(attempt.promptIds).toContain(nativePrompt);
        expect(attempt.turn).toBeGreaterThan(0);
        journalRead = {
          sessionId: requested,
          nativeRequestId: nativePrompt,
          purpose: kind,
          cursor: attempt.cursor,
          turn: attempt.turn,
        };
        expect(
          await f.owner.readPersistedRunTerminalFor(journalRead, guard, signal),
        ).toBeNull();
        turnEnd = f.owner.waitNativeTurnEnd(
          f.context,
          { kind: 'session', sessionId: SessionId(requested) },
          attempt.turn!,
          signal,
        );
        void turnEnd.catch(() => {});
      }
      return attempt.id;
    });
    readImage.resolve(async (requested, ref) => {
      const read = (
        reference: ImageAttachmentRef,
        target: { width: number; height: number; maxBytes: number } | null,
      ) =>
        f.owner.readManagedModelImageFor(
          f.context,
          {
            sessionId: requested,
            kind: 'assistant',
            id: facts.assistant.attemptId,
          },
          reference,
          target,
          signal,
        );
      await expect(
        read({ ...ref, width: ref.width + 1 }, null),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      const original = await read(ref, null);
      expect(original.data.byteLength).toBe(ref.bytes);
      const variant = await read(ref, { width: 1, height: 1, maxBytes: 4096 });
      expect(variant).toMatchObject({
        attachment: ref,
        width: 1,
        height: 1,
        variantId: expect.any(String),
      });
      expect(variant.data.byteLength).toBeGreaterThan(0);
    });
    const method = NATIVE_REMOTE.methods['session/prompt'];
    const args = method
      .input({ strict: true })
      .create()
      .parse({
        request: {
          sessionId,
          requestId: nativePrompt,
          content: [
            { type: 'text', text: 'Synthetic lifecycle test' },
            { type: 'image', mediaType: 'image/png', data: png },
          ],
          mode: 'queue',
        },
      });
    const response = await transport.fetch('api/session/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: 'session/prompt',
        payload: { args },
      }),
    });
    const receipt = serverResponseSchema.parse(await response.json());
    expect(receipt.result).toMatchObject({
      ok: true,
      value: { accepted: true },
    });
    await Promise.all([primary.promise, title.promise]);
    expect(turnEnd).toBeDefined();
    const appended = await turnEnd;
    expect(appended).toMatchObject({
      sequence: expect.any(Number),
      reason: 'completed',
    });
    expect(journalRead).toBeDefined();
    await expect
      .poll(
        () => f.owner.readPersistedRunTerminalFor(journalRead!, guard, signal),
        { timeout: 5000 },
      )
      .toMatchObject({
        ...appended,
        sessionId,
        turn: journalRead!.turn,
        occurredAt: expect.any(String),
      });
    for (const fact of Object.values(facts))
      expect(fact).toEqual({
        redeemed: true,
        sessionId,
        attemptId: expect.any(String),
      });
    expect(facts.assistant.attemptId).not.toBe(
      facts['session-title'].attemptId,
    );
  },
);

it.skipIf(!cli)(
  '真实rc.2旧exact kill失败memo不能冒join；确认child停止后实际host退役可重新收束',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    const cancel = vi
      .spyOn(f.job, 'cancelAndWait')
      .mockRejectedValueOnce(new PersonVmError('PROVIDER_FAILED'));
    await expect(f.owner.close()).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    expect(f.child.exitCode).toBe(null);
    await expect(
      f.owner.retireAfterNativeStop(
        { ...f.owner.binding, instanceId: randomUUID() },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(f.child.exitCode).toBe(null);
    f.child.kill('SIGKILL');
    await f.exited; // This leaf's actual Host process, not a VM stop/status proof.
    await f.owner.retireAfterNativeStop(
      f.owner.binding,
      new AbortController().signal,
    );
    await f.owner.close();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.owner.controlReady()).toBe(false);
  },
);
it.skipIf(!cli)(
  '真实rc.2停止后退役仍join阻塞read与HTTP/WS；host join失败保留，显式重新核实才成功',
  { tags: [tag], timeout: 30000 },
  async () => {
    const io = latch(),
      entered = latch(),
      release = latch(),
      create = NativeTransport.nativeWebTransport;
    let unconfirmed = false;
    vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
      (...args) => {
        const transport = create(...args);
        return {
          ...transport,
          close: async () => {
            await transport.close();
            io.resolve();
            if (unconfirmed)
              throw Error('synthetic host join acknowledgement failure');
          },
        };
      },
    );
    const f = await setup();
    cleanup.push(async () => {
      release.resolve();
      unconfirmed = false;
    });
    f.current.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const reading = f.owner
      .readSessions(new AbortController().signal)
      .catch((error: unknown) => error);
    await entered.promise;
    unconfirmed = true;
    f.child.kill('SIGKILL');
    await f.exited;
    let settled = false;
    const retiring = f.owner
      .retireAfterNativeStop(f.owner.binding, new AbortController().signal)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await io.promise;
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    release.resolve();
    expect(await reading).toBeInstanceOf(Error);
    expect(await retiring).toMatchObject({ code: 'CLEANUP_INCOMPLETE' });
    await expect(
      f.owner.readSessions(new AbortController().signal),
    ).rejects.toBeDefined();
    unconfirmed = false;
    await f.owner.retireAfterNativeStop(
      f.owner.binding,
      new AbortController().signal,
    );
    await f.owner.close();
    expect(f.kills()).toBe(0); // Confirmed-stop path never queries an already-dead guest job.
  },
);

it.skipIf(!cli)(
  '真实retire先进入：wait abort重入lifetime/close不另发cancel，完整read与I/O实际join前不成功',
  { tags: [tag], timeout: 30000 },
  async () => {
    const entered = latch(),
      release = latch();
    const nativeExit = latch(),
      socketClose = latch(),
      deliverExit = latch();
    const transportClosing = latch(),
      actualTransportJoined = latch(),
      deliverTransportJoin = latch();
    let transportJoined = false;
    const queued: (() => void)[] = [];
    let holdingSocketEvents = true;
    const deliverSocketEvents = () => {
      holdingSocketEvents = false;
      for (const deliver of queued.splice(0)) deliver();
    };
    const makeTransport = NativeTransport.nativeWebTransport;
    vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
      (...args) => {
        const transport = makeTransport(...args);
        return {
          ...transport,
          close() {
            const joined = transport.close();
            transportClosing.resolve();
            return joined.then(async () => {
              transportJoined = true;
              actualTransportJoined.resolve();
              await deliverTransportJoin.promise;
            });
          },
          createWebSocket(url) {
            const wire = transport.createWebSocket(url);
            const socket = wire as unknown as WebSocket;
            const emit = socket.emit.bind(socket);
            vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
              if (
                !holdingSocketEvents ||
                (event !== 'close' && event !== 'error')
              )
                return emit(event, ...args);
              queued.push(() => emit(event, ...args));
              if (event === 'close') socketClose.resolve();
              return true;
            });
            return wire;
          },
        };
      },
    );
    cleanup.push(async () => {
      deliverExit.resolve();
      deliverSocketEvents();
      deliverTransportJoin.resolve();
      release.resolve();
    });
    const f = await setup((scope) => {
      const launch = scope.launch.bind(scope);
      scope.launch = async (command) => {
        const job = await launch(command);
        const wait = job.wait.bind(job);
        vi.spyOn(job, 'wait').mockImplementation(async (active) => {
          const exit = await wait(active);
          nativeExit.resolve();
          await deliverExit.promise;
          return exit;
        });
        return job;
      };
    });
    f.current.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const reading = f.owner
      .readSessions(new AbortController().signal)
      .catch((error: unknown) => error);
    await entered.promise;
    const cancel = vi.spyOn(f.job, 'cancelAndWait');
    let closed = false,
      retired = false,
      reentrant: Promise<unknown> | undefined;
    f.waitSignal().addEventListener(
      'abort',
      () => {
        f.lifetime.abort();
        reentrant = f.owner.close().finally(() => {
          closed = true;
        });
        void reentrant.catch(() => {});
      },
      { once: true },
    );
    f.child.kill('SIGKILL');
    // Hold only loss delivery. The PID, actual job wait and socket all ended
    // before invoking the trusted stop hook; neither notification has won.
    await Promise.all([f.exited, nativeExit.promise, socketClose.promise]);
    expect(f.waitSignal().aborted).toBe(false);
    const retiring = f.owner
      .retireAfterNativeStop(f.owner.binding, new AbortController().signal)
      .finally(() => {
        retired = true;
      });
    void retiring.catch(() => {});
    cleanup.push(async () => {
      await Promise.allSettled([reading, retiring, reentrant]);
    });
    expect(reentrant).toBeDefined(); // Synchronous reentry from the actual host join.
    expect(cancel).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    expect(retired).toBe(false);
    expect(f.owner.controlReady()).toBe(false);
    deliverExit.resolve();
    await transportClosing.promise;
    // The real close owns the I/O join before the queued terminal can notify
    // the transport. Let the read finish with the socket join still pending.
    release.resolve();
    expect(await reading).toBeInstanceOf(Error);
    await new Promise<void>((done) => setImmediate(done));
    expect(transportJoined).toBe(false);
    expect(closed).toBe(false);
    expect(retired).toBe(false);
    deliverSocketEvents();
    await actualTransportJoined.promise;
    // The real socket and independent read have joined. Only the result
    // returned from this transport close call is held for the owner.
    await new Promise<void>((done) => setImmediate(done));
    expect(retired, 'retire must await the transport close result').toBe(false);
    expect(
      closed,
      'reentrant close must await the transport close result',
    ).toBe(false);
    deliverTransportJoin.resolve();
    await Promise.all([retiring, reentrant]);
    expect(transportJoined).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(f.kills()).toBe(0);
  },
);
it.skipIf(!cli)(
  '真实close先进入：retire必须join旧cancel的实际host子进程，guest已停不能提前覆盖',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup(),
      entered = latch();
    // A bounded, secret-free host I/O fixture, not an msb/guest executor.
    const io = spawn(
      process.execPath,
      ['-e', "process.stdout.write('ready');process.stdin.resume()"],
      {
        env: { PATH: dirname(process.execPath) },
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    const ioClosed = once(io, 'close');
    void ioClosed.catch(() => {});
    cleanup.push(async () => {
      io.stdin.end();
      if (io.exitCode === null && io.signalCode === null) io.kill('SIGKILL');
      await ioClosed;
    });
    await Promise.race([
      once(io.stdout, 'data'),
      ioClosed.then(() => {
        throw Error('host I/O fixture exited before its handshake');
      }),
    ]);
    const cancel = f.job.cancelAndWait;
    vi.spyOn(f.job, 'cancelAndWait').mockImplementation(async (signal) => {
      const exit = await cancel(signal); // Actual rc.2 Host child close.
      entered.resolve();
      await ioClosed; // Actual host operation still owns a live child/stdio.
      return exit;
    });
    let closed = false,
      retired = false;
    const closing = f.owner.close().finally(() => {
      closed = true;
    });
    expect(f.owner.controlReady()).toBe(false);
    void closing.catch(() => {});
    await Promise.race([
      entered.promise,
      closing.then(() => {
        throw Error('close settled before the host cancellation I/O joined');
      }),
    ]);
    const retiring = f.owner
      .retireAfterNativeStop(f.owner.binding, new AbortController().signal)
      .finally(() => {
        retired = true;
      });
    void retiring.catch(() => {});
    f.lifetime.abort();
    const concurrent = f.owner.close();
    void concurrent.catch(() => {});
    cleanup.push(async () => {
      await Promise.allSettled([closing, retiring, concurrent]);
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(closed).toBe(false);
    expect(retired).toBe(false);
    expect(io.exitCode).toBe(null);
    expect(f.child.exitCode !== null || f.child.signalCode !== null).toBe(true);
    expect(f.kills()).toBe(1);
    io.stdin.end();
    expect(await ioClosed).toEqual([0, null]);
    await Promise.all([closing, retiring, concurrent]);
    expect(f.kills()).toBe(1);
    await f.owner.close();
    expect(f.kills()).toBe(1);
  },
);

for (const method of [
  'readSessions',
  'readSessionsFor',
  'readModelCatalogFor',
] as const)
  for (const check of [1, 2])
    it.skipIf(!cli)(
      `真实${method}第${check}次现权检查阻塞时close等待完整operation，禁止新读`,
      { tags: [tag], timeout: 30000 },
      async () => {
        const ioClosed = latch();
        const createTransport = NativeTransport.nativeWebTransport;
        let fetches = 0;
        // Observe real public transport.close completion; no fake protocol/readiness.
        vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
          (...args) => {
            const transport = createTransport(...args);
            return {
              ...transport,
              fetch: (...call) => {
                fetches++;
                return transport.fetch(...call);
              },
              close: async () => {
                await transport.close();
                ioClosed.resolve();
              },
            };
          },
        );
        const f = await setup(),
          entered = latch(),
          release = latch();
        const read = (signal: AbortSignal) =>
          method === 'readSessions'
            ? f.owner.readSessions(signal)
            : f.owner[method](f.context, signal);
        cleanup.push(async () => {
          release.resolve();
        });
        if (check === 2) f.current.mockResolvedValueOnce(undefined);
        f.current.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise; // Deliberately join even after its signal is aborted.
        });
        const reading = read(new AbortController().signal).then(
          () => {
            throw Error('closed reader must not return data');
          },
          (error: unknown) => error,
        );
        await entered.promise;
        const atGuard = fetches;
        let settled = false;
        const closed = f.owner.close().then(() => {
          settled = true;
        });
        await Promise.all([ioClosed.promise, f.exited]); // Real network and exact child join.
        await new Promise<void>((done) => setImmediate(done)); // Drain their settled continuations.
        expect(settled).toBe(false);
        await expect(read(new AbortController().signal)).rejects.toBeDefined();
        expect(f.current).toHaveBeenCalledTimes(check);
        expect(fetches).toBe(atGuard);
        release.resolve();
        expect(await reading).toBeDefined();
        await closed;
        expect(f.current).toHaveBeenCalledTimes(check);
        expect(fetches).toBe(atGuard);
        expect(f.kills()).toBe(1);
      },
    );
it.skipIf(!cli)(
  '真实native control失联只撤可达资格，不重放；lifetime取消仍精确结束job并join',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    const revoked = once(f.owner.revoked, 'abort');
    f.child.kill('SIGKILL');
    await revoked;
    expect(f.owner.controlReady()).toBe(false);
    await expect(
      f.owner.readSessions(new AbortController().signal),
    ).rejects.toBeDefined();
    await f.owner.close();
    expect(f.kills()).toBe(1);
  },
);

function observeFetches() {
  const create = NativeTransport.nativeWebTransport;
  let calls = 0;
  vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
    (...args) => {
      const transport = create(...args);
      return {
        ...transport,
        fetch: (...request) => {
          calls++;
          return transport.fetch(...request);
        },
      };
    },
  );
  return () => calls;
}
it.skipIf(!cli)(
  '新当前RC前置拒绝零native I/O且不撤共享owner；随后有效RC可用，方法可脱离接收者调用',
  { tags: [tag], timeout: 30000 },
  async () => {
    const fetches = observeFetches(),
      f = await setup();
    const expired = {
      ...f.context,
      requestId: randomUUID(),
      sessionId: randomUUID(),
    };
    const current = {
      ...f.context,
      requestId: randomUUID(),
      sessionId: randomUUID(),
    };
    const denied = new PersonVmError('AUTHORIZATION_DENIED');
    f.current.mockImplementation(async (context) => {
      if (context.sessionId === expired.sessionId) throw denied;
    });
    const before = fetches(),
      read = f.owner.readSessionsFor;
    await expect(read(expired, new AbortController().signal)).rejects.toBe(
      denied,
    );
    expect(fetches()).toBe(before);
    expect(f.owner.revoked.aborted).toBe(false);
    expect(f.owner.controlReady()).toBe(true);
    expect(f.kills()).toBe(0);
    f.current.mockClear();
    expect((await read(current, new AbortController().signal)).ok).toBe(true);
    expect(fetches()).toBe(before + 1);
    expect(f.current.mock.calls.map(([context]) => context)).toEqual([
      current,
      current,
    ]);
    expect(f.child.exitCode).toBeNull();
  },
);
it.skipIf(!cli)(
  '新当前RC读中撤权：实际list完成后复核拒绝丢结果并真实settle，不误撤共享owner',
  { tags: [tag], timeout: 30000 },
  async () => {
    const fetches = observeFetches(),
      f = await setup(),
      entered = latch(),
      joined = latch();
    const current = {
      ...f.context,
      requestId: randomUUID(),
      sessionId: randomUUID(),
    };
    const denied = new PersonVmError('AUTHORIZATION_DENIED');
    f.current
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        entered.resolve();
        await joined.promise;
        throw denied;
      });
    cleanup.push(async () => {
      joined.resolve();
    });
    const before = fetches();
    let ended = false;
    const reading = f.owner
      .readSessionsFor(current, new AbortController().signal)
      .catch((error: unknown) => error)
      .finally(() => {
        ended = true;
      });
    await entered.promise;
    expect(fetches()).toBe(before + 1); // Post-guard failure is not zero I/O.
    expect(ended).toBe(false);
    expect(f.owner.controlReady()).toBe(true);
    joined.resolve();
    expect(await reading).toBe(denied);
    expect(f.owner.revoked.aborted).toBe(false);
    expect(f.kills()).toBe(0);
    expect(
      (
        await f.owner.readSessionsFor(
          { ...current, sessionId: randomUUID() },
          new AbortController().signal,
        )
      ).ok,
    ).toBe(true);
  },
);
it.skipIf(!cli)(
  '新当前RC单次取消等待已发guard真实结束；不废共享owner，随后有效请求仍可读',
  { tags: [tag], timeout: 30000 },
  async () => {
    const fetches = observeFetches(),
      f = await setup(),
      entered = latch(),
      joined = latch(),
      caller = new AbortController();
    const cancelled = Error('only this request cancelled');
    cleanup.push(async () => {
      joined.resolve();
    });
    f.current.mockImplementationOnce(async (_context, _binding, signal) => {
      entered.resolve();
      await joined.promise;
      signal.throwIfAborted();
    });
    const before = fetches();
    let ended = false;
    const reading = f.owner
      .readSessionsFor(f.context, caller.signal)
      .catch((error: unknown) => error)
      .finally(() => {
        ended = true;
      });
    await entered.promise;
    caller.abort(cancelled);
    await new Promise<void>((done) => setImmediate(done));
    expect(ended).toBe(false);
    expect(f.owner.revoked.aborted).toBe(false);
    joined.resolve();
    expect(await reading).toBe(cancelled);
    expect(fetches()).toBe(before);
    expect(
      (await f.owner.readSessionsFor(f.context, new AbortController().signal))
        .ok,
    ).toBe(true);
    expect(f.kills()).toBe(0);
  },
);
it.skipIf(!cli)(
  '真实transport失联仍撤共享owner但不冒guest终止；新请求拒绝，显式close才join原job',
  { tags: [tag], timeout: 30000 },
  async () => {
    const create = NativeTransport.nativeWebTransport,
      disconnect: (() => void)[] = [];
    vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
      (...args) => {
        const transport = create(...args);
        return {
          ...transport,
          createWebSocket(input) {
            const socket = transport.createWebSocket(input);
            disconnect.push(() => socket.close());
            return socket;
          },
        };
      },
    );
    const f = await setup(),
      revoked = once(f.owner.revoked, 'abort');
    disconnect.forEach((close) => close());
    await revoked;
    expect(f.owner.controlReady()).toBe(false);
    expect(f.child.exitCode).toBeNull();
    expect(f.kills()).toBe(0);
    await expect(
      f.owner.readSessionsFor(f.context, new AbortController().signal),
    ).rejects.toBeDefined();
    await f.owner.close();
    expect(f.kills()).toBe(1);
  },
);
it.skipIf(!cli)(
  '真实lifetime取消仍撤共享owner并join job，新当前RC不能恢复已失效控制',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    f.lifetime.abort();
    expect(f.owner.revoked.aborted).toBe(true);
    await f.owner.close();
    await f.exited;
    expect(f.owner.controlReady()).toBe(false);
    expect(f.kills()).toBe(1);
    await expect(
      f.owner.readSessionsFor(f.context, new AbortController().signal),
    ).rejects.toBeDefined();
  },
);

it.skipIf(!cli)(
  '已join的单次取消不废owner；真实现权失效撤旧epoch，仍由显式close确认guest终止',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    await expect(
      f.owner.readSessions(AbortSignal.abort()),
    ).rejects.toBeDefined();
    expect(f.owner.controlReady()).toBe(true);
    f.current.mockRejectedValueOnce(new PersonVmError('LEASE_LOST'));
    await expect(
      f.owner.readSessions(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(f.owner.revoked.aborted).toBe(true);
    expect(f.kills()).toBe(0);
    await f.owner.close();
    expect(f.kills()).toBe(1);
  },
);

it.skipIf(!cli)(
  '真实running raw modelCatalog使用零业务参数和原生结果；不赋予startup/send就绪',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    const result = await f.owner.readModelCatalogFor(
      f.context,
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error('actual native model catalog was unavailable');
    expect(
      NATIVE_REMOTE.methods['session/modelCatalog'].result
        .create()
        .parse(result.value),
    ).toEqual(result.value);
    expect(f.owner).not.toHaveProperty('editorReady');
    expect(f.owner).not.toHaveProperty('canSend');
    await f.owner.close();
    await expect(
      f.owner.readModelCatalogFor(f.context, new AbortController().signal),
    ).rejects.toBeDefined();
  },
);

it.skipIf(!cli).each([1, 2])(
  '真实raw catalog第%s个current拒绝仅影响本请求，原错误保留且共享owner可继续',
  { tags: [tag], timeout: 30000 },
  async (check) => {
    const fetches = observeFetches(),
      f = await setup();
    const denied = new PersonVmError('AUTHORIZATION_DENIED');
    if (check === 2) f.current.mockResolvedValueOnce(undefined);
    f.current.mockRejectedValueOnce(denied);
    const before = fetches();
    await expect(
      f.owner.readModelCatalogFor(f.context, new AbortController().signal),
    ).rejects.toBe(denied);
    expect(fetches()).toBe(before + check - 1);
    expect(f.owner.revoked.aborted).toBe(false);
    expect(f.owner.controlReady()).toBe(true);
    expect(f.kills()).toBe(0);
    expect(
      (
        await f.owner.readModelCatalogFor(
          { ...f.context, sessionId: randomUUID() },
          new AbortController().signal,
        )
      ).ok,
    ).toBe(true);
  },
);

it.skipIf(!cli).each(['caller-cancel', 'owner-close'] as const)(
  '真实raw零参Promise尚未返回时%s不代替join；只在原reply真实结清后拒绝结果',
  { tags: [tag], timeout: 30000 },
  async (mode) => {
    const create = NativeTransport.nativeWebTransport,
      entered = latch(),
      release = latch();
    let first = true;
    let actual:
      { body: unknown; signal: AbortSignal | null | undefined } | undefined;
    vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
      (...args) => {
        const transport = create(...args);
        return {
          ...transport,
          async fetch(...request) {
            const response = await transport.fetch(...request);
            if (
              first &&
              new URL(request[0], args[0]).pathname ===
                '/api/session/modelCatalog'
            ) {
              first = false;
              if (typeof request[1].body !== 'string')
                throw Error('actual native JSON request missing');
              actual = {
                body: JSON.parse(request[1].body),
                signal: request[1].signal,
              };
              entered.resolve();
              await release.promise; // Hold the original public carrier Promise, never replace its response.
            }
            return response;
          },
        };
      },
    );
    const f = await setup(),
      caller = new AbortController();
    cleanup.push(async () => {
      release.resolve();
    });
    let settled = false;
    const reading = f.owner
      .readModelCatalogFor(f.context, caller.signal)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    if (!actual) throw Error('actual raw request was not observed');
    expect(actual.body).toEqual({
      type: 'client-request',
      rpcId: expect.any(String),
      method: 'session/modelCatalog',
      payload: { args: {} },
    });
    const cancelled = Error('fixture-only single raw read cancelled');
    const closing =
      mode === 'owner-close' ? f.owner.close() : Promise.resolve();
    void closing.catch(() => {});
    if (mode === 'caller-cancel') caller.abort(cancelled);
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    // The zero-argument native descriptor has only its mount lifetime, no caller cancellation slot.
    expect(actual.signal?.aborted).toBe(false);
    if (mode === 'caller-cancel') {
      expect(f.owner.revoked.aborted).toBe(false);
      expect(f.owner.controlReady()).toBe(true);
    } else expect(f.owner.revoked.aborted).toBe(true);
    release.resolve();
    const outcome = await reading;
    if (mode === 'caller-cancel') expect(outcome).toBe(cancelled);
    else expect(outcome).toBeInstanceOf(Error);
    await closing;
    if (mode === 'caller-cancel') {
      expect(
        (
          await f.owner.readModelCatalogFor(
            f.context,
            new AbortController().signal,
          )
        ).ok,
      ).toBe(true);
      expect(f.kills()).toBe(0);
    } else expect(f.kills()).toBe(1);
  },
);

it.skipIf(!cli).each(['normal', 'lost-then-exact-stop'] as const)(
  '真实guest封存principal安装、同API Peer两页及技术ready；%s按各自ACK/unknown/退役出口join',
  { tags: [tag], timeout: 30000 },
  async (mode) => {
    const create = NativeTransport.nativeWebTransport;
    let selected:
      ReturnType<typeof NativeTransport.nativeWebTransport> | undefined;
    vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
      (...args) => {
        selected = create(...args);
        return selected;
      },
    );
    const f = await setup(),
      transport = selected;
    if (!transport) throw Error('actual authenticated owner transport missing');
    // Only this manual test creates a native Session through the original owner Peer.
    // The pin strings below are explicitly test-owned provenance, not SQL or production authorization.
    const args = NATIVE_REMOTE.methods['session/create']
      .input({ strict: true })
      .create()
      .parse({ request: {} });
    const response = await transport.fetch('api/session/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: 'session/create',
        payload: { args },
      }),
    });
    const envelope = serverResponseSchema.parse(await response.json());
    if (!envelope.result.ok)
      throw Error('actual native session/create refused the manual fixture');
    const created = NATIVE_REMOTE.methods['session/create'].result
      .create()
      .parse(envelope.result.value);
    const issue: DEntryPrincipalIssue = {
      scopeId: randomUUID(),
      access: 'history',
      identity: {
        ...f.principalProfile,
        organizationId: f.owner.binding.organizationId,
        personId: f.owner.binding.personId,
        threadId: randomUUID(),
      },
      root: {
        nativeSessionId: created.sessionId,
        rootOriginDigest: 'manual-test-native-create-only',
        rootBindingRef: 'manual-test-no-sql-permit',
      },
    };
    const first = f.owner.acquirePrincipal(issue, new AbortController().signal);
    const secondIssue = { ...issue, scopeId: randomUUID() };
    const second = f.owner.acquirePrincipal(
      secondIssue,
      new AbortController().signal,
    );
    const firstScope = await first.run(new AbortController().signal);
    const secondScope = await second.run(new AbortController().signal);
    expect(firstScope.opened.baseline.owner).toBe(false);
    expect(firstScope.opened.principal.kind).toBe('allrice-d-entry');
    expect(secondScope.opened.baseline.owner).toBe(false);
    const eventsSource = firstScope.stream(
      { kind: 'events', scopeId: issue.scopeId, payload: { args: {} } },
      new AbortController().signal,
    );
    const events = eventsSource[Symbol.asyncIterator]();
    expect(await events.next()).toMatchObject({
      value: {
        type: 'item',
        value: { type: 'ready', clientId: expect.any(String) },
      },
    });
    await first.close(); // Real close/closed/end and local join; it never cancels the shared job.
    await events.return?.(); // Join this test's paused consumer too.
    expect(firstScope.revoked.aborted).toBe(true);
    expect(secondScope.revoked.aborted).toBe(false);
    expect(f.kills()).toBe(0);
    expect(
      await secondScope.invoke(
        {
          scopeId: secondIssue.scopeId,
          endpoint: 'session/page',
          args: {
            request: {
              address: { kind: 'session', sessionId: created.sessionId },
              throughSeq: 0,
            },
          },
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ endpoint: 'session/page' });
    if (mode === 'normal') {
      const entered = latch();
      f.current.mockImplementationOnce(async (_context, _binding, checking) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(checking.reason);
          checking.addEventListener('abort', abort, { once: true });
          if (checking.aborted) {
            checking.removeEventListener('abort', abort);
            abort();
          }
        });
      });
      const reading = f.owner.readSessions(new AbortController().signal);
      void reading.catch(() => {});
      await entered.promise;
      // Normal stale abort rejects a real in-flight binding guard. It must not
      // enter lost and kill the carrier before the other page's close ACK.
      const closing = f.owner.close();
      await expect(reading).rejects.toBeDefined();
      await closing;
    } else {
      f.child.kill('SIGKILL');
      await f.exited;
      await expect(f.owner.close()).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
      // Actual child exit is the fixture's trusted exact-stop fact; it is not an ACK.
      await f.owner.retireAfterNativeStop(
        f.owner.binding,
        new AbortController().signal,
      );
      await f.owner.close();
    }
    expect(secondScope.revoked.aborted).toBe(true);
    expect(f.kills()).toBe(1);
  },
);

it.skipIf(!cli)(
  'R3最后baseline后setup current实际悬挂时，normal close不能在真guard join前完成',
  { tags: [tag], timeout: 30000 },
  async () => {
    const entered = latch(),
      release = latch();
    let abort: (() => void) | undefined;
    let cancel: MockInstance<PersonVmManagedJob['cancelAndWait']> | undefined;
    let checks = 0,
      settled = false;
    const opening = setup((scope, lifetime) => {
      abort = () => lifetime.abort();
      const current = scope.assertCurrent.bind(scope),
        launch = scope.launch.bind(scope);
      vi.spyOn(scope, 'assertCurrent').mockImplementation(async () => {
        await current();
        if (++checks === 3) {
          entered.resolve();
          await release.promise;
        }
      });
      vi.spyOn(scope, 'launch').mockImplementation(async (...args) => {
        const job = await launch(...args);
        cancel = vi.spyOn(job, 'cancelAndWait');
        return job;
      });
    })
      .then(
        () => {
          throw Error('a late successful owner must never be published');
        },
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    cleanup.push(async () => {
      release.resolve();
      await opening;
    });
    await entered.promise;
    if (!abort || !cancel) throw Error('actual setup guard/job not reached');
    abort();
    await new Promise<void>((done) => setImmediate(done));
    expect(checks).toBe(3);
    expect(settled).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    const cancelled = cancel.mock.results[0];
    if (!cancelled || cancelled.type !== 'return')
      throw Error('actual native cancellation did not start');
    await cancelled.value; // Actual Host/job has joined, but its last guard is still pending.
    expect(settled).toBe(false);
    release.resolve();
    expect(await opening).toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);

it.skipIf(!cli)(
  'owner close保留真实control的native错误链及并存cleanup原因，等待实际job收尾并复用失败memo',
  { tags: [tag], timeout: 30000 },
  async () => {
    // This boundary test routes the real control to the public S1 fixture so its
    // native catalog can deterministically fail. Other manual cases cover the
    // actual same-Host/Peer installation; the owner job and its cleanup stay real.
    const native = await hostFixture(),
      create = PrincipalControl.createDEntryPrincipalControl,
      cancelEntered = latch(),
      cancelRelease = latch(),
      cleanupFailure = Error('actual joined job cleanup diagnostic');
    vi.spyOn(
      PrincipalControl,
      'createDEntryPrincipalControl',
    ).mockImplementation((_root, input) => create(native.node, input));
    let cancel: MockInstance<PersonVmManagedJob['cancelAndWait']> | undefined;
    const pendingCloses: Promise<unknown>[] = [];
    let nativeClosed = false,
      holdCancel = false;
    cleanup.push(async () => {
      cancelRelease.resolve();
      await Promise.allSettled(pendingCloses);
      if (!nativeClosed) await native.close();
    });
    const f = await setup((scope) => {
      const launch = scope.launch.bind(scope);
      vi.spyOn(scope, 'launch').mockImplementation(async (...args) => {
        const job = await launch(...args),
          actual = job.cancelAndWait.bind(job);
        cancel = vi
          .spyOn(job, 'cancelAndWait')
          .mockImplementation(async (...request) => {
            const result = await actual(...request);
            if (!holdCancel) return result;
            cancelEntered.resolve();
            await cancelRelease.promise;
            throw cleanupFailure;
          });
        return job;
      });
    });
    cleanup.push(async () => {
      cancelRelease.resolve();
      await Promise.allSettled(pendingCloses);
    });
    const activity = f.owner.acquirePrincipal(
      native.selected,
      new AbortController().signal,
    );
    const scope = await activity.run(new AbortController().signal);
    const failure = new RemoteError(
      'subagent/catalog-diagnostic',
      'owner boundary native setup failure',
      {
        parentSessionId: SessionId('root'),
        childSessionId: SessionId('child'),
        reason: 'unavailable',
      },
    );
    native.catalog.beforeFollow = async () => {
      throw failure;
    };
    const follow = scope.stream(
      {
        scopeId: native.selected.scopeId,
        endpoint: 'session/follow',
        args: {
          request: {
            address: { kind: 'session', sessionId: SessionId('root') },
          },
        },
      },
      new AbortController().signal,
    );
    const stream = follow[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toMatchObject({
      code: failure.code,
      message: failure.message,
      details: failure.details,
    });
    let settled = false;
    holdCancel = true;
    const closing = f.owner
      .close()
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    pendingCloses.push(closing);
    try {
      await cancelEntered.promise;
      await f.exited;
      await new Promise<void>((done) => setImmediate(done));
      expect(settled).toBe(false);
      expect(f.kills()).toBe(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      cancelRelease.resolve();
    }
    const outcome = await closing;
    f.expectCloseFailure(outcome);
    expect(outcome).toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
      cause: expect.any(AggregateError),
    });
    const reasons: unknown[] = [];
    function collect(error: unknown) {
      if (reasons.includes(error)) return;
      reasons.push(error);
      if (error instanceof AggregateError) error.errors.forEach(collect);
      if (error instanceof Error && error.cause) collect(error.cause);
    }
    collect(outcome);
    expect(reasons).toContainEqual(
      expect.objectContaining({
        code: failure.code,
        message: failure.message,
        details: failure.details,
      }),
    );
    expect(reasons).toContain(cleanupFailure);
    await expect(f.owner.close()).rejects.toBe(outcome);
    expect(cancel).toHaveBeenCalledTimes(1);
    await native.close();
    nativeClosed = true;
  },
);
