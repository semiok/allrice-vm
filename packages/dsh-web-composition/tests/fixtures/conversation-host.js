import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const require = createRequire(process.argv[1]);
const { LlmAdapter } = await import(
  pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href
);

export const inject = ['llm'];

async function waitForBrowser(gate, signal) {
  const path = new URL(gate, import.meta.url);
  for (;;) {
    signal?.throwIfAborted();
    try {
      await access(path);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(20, undefined, { signal });
  }
}

class ConversationFixture extends LlmAdapter {
  listModels(provider) {
    return Promise.resolve([
      { provider, id: 'fixture-sol', name: 'Fixture Sol' },
      { provider, id: 'fixture-nova', name: 'Fixture Nova' },
    ]);
  }

  async *stream({ messages, signal, tools }) {
    const read = 'read';
    const hasRead = messages.some(
      (message) =>
        message.role === 'tool' && message.toolCallId === 'r2-fixture-read',
    );
    if (!hasRead) {
      if (!tools.some((tool) => tool.name === read))
        throw new Error('The native read tool is not installed');
      await waitForBrowser('issue-tool', signal);
      const call = {
        type: 'tool-call',
        id: 'r2-fixture-read',
        name: read,
        arguments: JSON.stringify({ file_path: 'visible-tool-witness.txt' }),
      };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: call.id,
        name: call.name,
        argumentsDelta: call.arguments,
      };
      yield { type: 'block-end', index: 0, block: call };
      yield {
        type: 'usage',
        usage: { inputTokens: 75, outputTokens: 5, cacheReadTokens: 25 },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    await waitForBrowser('finish-turn', signal);
    const text = 'R2 浏览器收到原生回合结果。';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    await delay(80, undefined, { signal });
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield {
      type: 'usage',
      usage: { inputTokens: 75, outputTokens: 16, cacheReadTokens: 25 },
    };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const registration = ctx.llm.registerAdapter(
      ['r2-browser-fixture'],
      new ConversationFixture(),
    );
    return registration;
  });
}
