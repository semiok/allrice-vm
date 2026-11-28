/* global AbortController */
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { argv, cwd } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL, URL } from 'node:url';

const require = createRequire(argv[1]);
export const inject = ['sessions', 'sessionPersistence'];

async function waitForBrowser(name, signal) {
  const path = new URL(name, import.meta.url);
  for (;;) {
    signal.throwIfAborted();
    try {
      await access(path);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(20, undefined, { signal });
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const abort = new AbortController();
    const fixture = async () => {
      const { createMessage } = await import(
        pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href
      );
      abort.signal.throwIfAborted();
      const root = ctx.sessions.create(
        'session-00000000-0000-4000-8000-000000000086',
        { meta: { cwd: cwd(), agentPreset: 'standard' } },
      );
      function reply(session, turn, text) {
        session.append('turn/start', { turn });
        session.append(
          'user/message',
          createMessage({
            role: 'user',
            content: [{ type: 'text', text: '请核对隔离测试资料。' }],
            source: { kind: 'user', rpcId: randomUUID() },
          }),
          { surfaceOp: 'append' },
        );
        session.append('step/start', { turn, step: 1 });
        session.append(
          'assistant/message',
          {
            turn,
            step: 1,
            stream: [],
            message: createMessage({
              role: 'assistant',
              content: [{ type: 'text', text }],
              source: { kind: 'model', provider: 'fixture', model: 'fixture' },
            }),
          },
          { surfaceOp: 'append' },
        );
        session.append('step/end', { turn, step: 1 });
        session.append('turn/end', { turn, reason: { kind: 'completed' } });
      }
      root.append('session/title', {
        title: '子会话回归主对话',
        messageSeqs: [],
        source: { kind: 'user' },
      });
      reply(root, 1, '主对话历史仍在。');
      await writeFile(new URL('root-ready', import.meta.url), '');
      await waitForBrowser('add-children', abort.signal);
      const makeChild = (id, mode, label, text) => {
        const child = ctx.sessions.create(id, {
          meta: {
            cwd: cwd(),
            agentPreset: 'standard',
            parentSession: root.id,
            origin: 'subagent',
            delegationDepth: 1,
          },
        });
        child.append('subagent/descriptor', {
          version: 3,
          mode,
          provider: 'local',
          label,
        });
        reply(child, 1, text);
        root.append('subagent/catalog', {
          version: 0,
          childId: child.id,
          childCreatedAt: child.header.createdAt,
          mode,
          label,
        });
        return child;
      };
      makeChild(
        'session-00000000-0000-4000-8000-000000000087',
        'one-shot',
        '核对销售记录',
        '单次任务核对完成。',
      );
      const child = makeChild(
        'session-00000000-0000-4000-8000-000000000088',
        'continuable',
        '持续整理会议纪要和行动清单',
        '持续任务已记录结论。',
      );
      await waitForBrowser('child-live', abort.signal);
      reply(child, 2, '子任务实时补充已到达。');
      await waitForBrowser('child-reconnect', abort.signal);
      reply(child, 3, '子任务在重连后仍完整。');
      await writeFile(new URL('child-reconnect-ready', import.meta.url), '');
    };
    const task = fixture().catch(async (error) => {
      if (!abort.signal.aborted)
        await writeFile(
          new URL('fixture-error', import.meta.url),
          String(error),
        );
    });
    return async () => {
      abort.abort();
      await task;
    };
  });
}
