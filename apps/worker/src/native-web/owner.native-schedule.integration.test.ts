import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { finished } from 'node:stream/promises';
import { SessionId } from '@deepseek-ai/dsh-session';
import { TYPERT_REMOTE as Native } from '@deepseek-ai/dsh-api-session-controller/remote';
import { TYPERT_REMOTE as Schedule } from '@deepseek-ai/dsh-schedule/remote';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  closeServer,
  listen,
} from '../../../../packages/model-gateway/src/gateway.fixture.js';
import { setupNativeWebFixture } from './owner.native.fixture.js';
import {
  deferredPromptFact,
  waitForPromptFact,
  type NativePromptObservation,
  type NativeToolObservation,
} from './prompt-observation.js';

const cli = process.env.ALLRICE_NATIVE_WEB_TEST_CLI;
const wireArguments = z.record(z.string(), z.json());
const roots: string[] = [];
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  if (failures.length)
    throw new AggregateError(failures, 'Fixture cleanup failed');
});

it.skipIf(!cli)(
  'shares one durable native reminder between the non-owner schedules page and the Host wake reader',
  { tags: ['manual:ALLRICE_NATIVE_WEB_TEST_CLI'], timeout: 30000 },
  async () => {
    const references = new Map<string, boolean>();
    const capability = 'a'.repeat(43);
    let assistantRequests = 0;
    const proofs = deferredPromptFact<NativeToolObservation>();
    const seen: NativeToolObservation[] = [];
    const opened = deferredPromptFact<NativePromptObservation>();
    const nativeCallId = randomUUID();
    const nativeRequestId = randomUUID();
    const humanText = 'Create a test reminder in ten minutes.';
    const selected = deferredPromptFact<{
      id: string;
      cursor: number;
      observation: NonNullable<NativeToolObservation['human']>;
    }>();
    const title = 'Synthetic reminder for the Host wake reader';
    const prompt = 'Acknowledge this synthetic reminder without using tools.';
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        await finished(request);
        if (request.headers.authorization !== 'Bearer ' + capability)
          throw Error('Wrong fixture capability');
        if (
          request.url === '/v1/reference' ||
          request.url === '/v1/reference/session-title'
        ) {
          if (request.url === '/v1/reference' && assistantRequests === 0) {
            const { sessionId } = JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            );
            try {
              await readAttempt(sessionId);
            } catch (error) {
              selected.reject(error);
              throw error;
            }
          }
          const reference = randomBytes(32).toString('base64url');
          references.set(reference, request.url.endsWith('/session-title'));
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ reference }));
          return;
        }
        const reference = String(
          request.headers['x-allrice-model-call-reference'],
        );
        const isTitle = references.get(reference);
        if (request.url !== '/v1/stream' || isTitle === undefined)
          throw Error('Missing managed model reference');
        const create = !isTitle && ++assistantRequests === 1;
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(
          [
            create
              ? {
                  type: 'tool-call-delta',
                  index: 0,
                  id: nativeCallId,
                  name: 'schedule_create',
                  argumentsDelta: JSON.stringify({
                    title,
                    prompt,
                    after_seconds: 600,
                  }),
                }
              : { type: 'text-delta', index: 0, text: 'Reminder scheduled.' },
            ...(create
              ? ['memory_read', 'memory_remember'].map((name, i) => ({
                  type: 'tool-call-delta',
                  index: i + 1,
                  id: randomUUID(),
                  name,
                  argumentsDelta: '{}',
                }))
              : []),
            {
              type: 'finish',
              reason: { kind: create ? 'tool-calls' : 'stop' },
            },
          ]
            .map((chunk) => JSON.stringify(chunk) + '\n')
            .join(''),
        );
      })().catch((error: unknown) =>
        response.destroy(Error('Fixture model failed', { cause: error })),
      );
    });
    const origin = await listen(server);
    cleanup.push(() => closeServer(server));
    const { owner, context, principalProfile } = await setupNativeWebFixture(
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
          inputModalities: ['text'],
        },
      },
      async (request) => {
        if (request.endpoint !== 'session/prompt')
          throw Error('Unexpected native prompt');
        const observation = request.observe(signal, (fact) => {
          seen.push(fact);
          if (fact.callId === nativeCallId) proofs.resolve(fact);
        });
        await observation.ready;
        opened.resolve(observation);
        return {
          undispatched: () => observation.close(),
          accepted() {},
          unknown() {},
        };
      },
    );
    const signal = AbortSignal.timeout(15000);
    async function readAttempt(sessionId: string) {
      const attempt = await owner.readNativeAttemptFor(
        context,
        {
          kind: 'session',
          sessionId: SessionId(sessionId),
        },
        signal,
      );
      if (!attempt?.observation?.human)
        throw Error(
          'No unique adopted input proof: ' +
            JSON.stringify({
              attempt: !!attempt,
              configuration: !!attempt?.observation?.request,
              status: attempt?.observation?.proofState ?? null,
              prompts: attempt?.prompts.length ?? 0,
            }),
        );
      expect(attempt.observation.request).toMatchObject({
        provider: 'openai-codex',
        model: 'fixture-codex',
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      selected.resolve({
        id: attempt.id,
        cursor: attempt.cursor,
        observation: attempt.observation.human,
      });
    }
    const created = await owner.createRootFor(context, {}, signal);
    if (!created.ok) throw Error('Native root unavailable');
    const { sessionId } = created.value;
    const identity = {
      ...principalProfile,
      organizationId: owner.binding.organizationId,
      personId: owner.binding.personId,
    };
    const pageId = randomUUID();
    const page = owner.acquirePrincipal(
      {
        scopeId: pageId,
        identity: { ...identity, threadId: null },
        access: 'page',
      },
      signal,
      context,
    );
    cleanup.push(() => page.close());
    const scope = await page.run(signal);
    expect(scope.opened.baseline.owner).toBe(false);
    async function invoke(
      endpoint: keyof typeof Schedule.methods,
      args: Record<string, unknown>,
    ) {
      const result = await scope.invokePage(
        {
          kind: 'page',
          endpoint,
          scopeId: pageId,
          args: wireArguments.parse(args),
        },
        signal,
      );
      expect(result.endpoint).toBe(endpoint);
      return result.value;
    }
    const catalog = () => invoke('schedule/catalog', {});
    const hostCatalog = () =>
      owner.readScheduleCatalog(async (active) => {
        active.throwIfAborted();
      }, signal);
    expect(await catalog()).toEqual([]);
    expect(await hostCatalog()).toEqual([]);
    const notifications = scope.stream(
      { kind: 'events', scopeId: pageId, payload: { args: {} } },
      signal,
    );
    cleanup.push(() => notifications.close());
    const events = notifications[Symbol.asyncIterator]();
    expect(await events.next()).toMatchObject({
      value: { value: { type: 'ready' } },
    });
    async function nextChange() {
      for (;;) {
        const frame = await events.next();
        if (frame.done) throw Error('Page notification stream closed');
        const value = frame.value.value;
        if (
          'type' in value &&
          value.type === 'emit' &&
          value.event === 'schedule/changed'
        ) {
          expect(value.args).toEqual([]);
          return;
        }
      }
    }

    const executionId = randomUUID();
    const execution = owner.acquirePrincipal(
      {
        scopeId: executionId,
        access: 'execute',
        identity: { ...identity, threadId: randomUUID() },
        root: {
          nativeSessionId: sessionId,
          rootOriginDigest: 'manual-test-native-create-only',
          rootBindingRef: 'manual-test-no-sql-permit',
        },
      },
      signal,
      context,
    );
    cleanup.push(() => execution.close());
    const promptScope = await execution.run(signal);
    expect(
      await promptScope.invoke(
        {
          endpoint: 'session/prompt',
          scopeId: executionId,
          args: Native.methods['session/prompt']
            .input({ strict: true })
            .create()
            .parse({
              request: {
                sessionId,
                requestId: nativeRequestId,
                content: [{ type: 'text', text: humanText }],
                mode: 'queue',
              },
            }),
        },
        signal,
      ),
    ).toMatchObject({ value: { accepted: true } });
    const [nativeAttempt, tool] = await Promise.all([
      waitForPromptFact(selected.promise, signal),
      waitForPromptFact(proofs.promise, signal),
    ]);
    const digest =
      'sha256:' +
      createHash('sha256')
        .update(JSON.stringify([humanText]))
        .digest('hex');
    expect(tool).toMatchObject({
      attemptId: nativeAttempt.id,
      callId: nativeCallId,
      name: 'schedule_create',
      human: {
        occurrence: {
          sessionId,
          scopeId: executionId,
          requestId: nativeRequestId,
          messageId: expect.any(String),
          turn: 1,
        },
        digest,
      },
    });
    expect(tool.human).toEqual(nativeAttempt.observation);
    expect(tool.assistantSequence).toBeGreaterThan(nativeAttempt.cursor);
    expect(tool.sequence).toBeGreaterThan(tool.assistantSequence);
    await nextChange();

    const observation = await waitForPromptFact(opened.promise, signal);
    expect(await waitForPromptFact(observation.settled, signal)).toBe('ended');
    expect(seen.map(({ name }) => name)).toEqual(['schedule_create']);
    await execution.close();

    const [task] = await hostCatalog();
    if (!task) throw Error('The native tool did not persist a reminder');
    expect(task).toMatchObject({ sessionId, title, prompt, status: 'active' });
    expect(await catalog()).toEqual([task]);
    const [expected] = Schedule.methods['schedule/list'].result
      .create()
      .parse(await invoke('schedule/list', { request: { sessionId } }));
    if (!expected)
      throw Error('The native Session list did not include the reminder');
    expect(expected).toMatchObject({ id: task.id, title, prompt });
    const selector = { sessionId, id: task.id };
    expect(
      await invoke('schedule/history', { request: { ...selector, limit: 10 } }),
    ).toMatchObject({ id: task.id, records: [] });
    const at = new Date(Date.now() + 1_200_000).toISOString();
    expect(
      await invoke('schedule/update', {
        request: {
          ...selector,
          expected,
          change: { kind: 'at', at },
        },
      }),
    ).toMatchObject({
      id: task.id,
      updated: true,
      record: { scheduledAt: at },
    });
    await nextChange();
    const updated = await hostCatalog();
    expect(updated).toMatchObject([{ ...selector, scheduledAt: at }]);
    expect(await catalog()).toEqual(updated);

    const other = await owner.createRootFor(context, {}, signal);
    if (!other.ok) throw Error('Second native root unavailable');
    expect(
      await invoke('schedule/delete', {
        request: { ...selector, sessionId: other.value.sessionId },
      }),
    ).toEqual({ id: task.id, deleted: false, code: 'schedule_not_found' });
    expect(await hostCatalog()).toEqual(updated);
    expect(await invoke('schedule/delete', { request: selector })).toEqual({
      id: task.id,
      deleted: true,
    });
    await nextChange();
    expect(await catalog()).toEqual([]);
    expect(await hostCatalog()).toEqual([]);
    await notifications.close();
    await events.return?.();
    await page.close();
    await expect(catalog()).rejects.toBeDefined();
  },
);
