import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { EmployeeMemoryPort } from '@allrice/database';
import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { apply } from '@deepseek-ai/dsh-mcp-client';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import {
  createAllriceMcpServer,
  type AllriceMcpScope,
  type AllriceMcpServices,
} from './allrice-server.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderNativeMemoryIndexV2 } from '../../../../packages/database/src/memory-context-render.ts';

const fixtures = vi.hoisted(() => ({
  identity: vi.fn(),
  read: vi.fn(),
  remember: vi.fn(),
}));
// Explicit identity/business contract fakes. The production adapter still
// imports the actual 271 reader and the public memory port, never these fakes.
vi.mock('../business-runtime/d-entry-current.ts', () => ({
  readDEntryBusinessIdentity: fixtures.identity,
}));
import { bindEmployeeMemoryMcpServices } from './employee-memory-services.ts';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const memoryModule = {
  kind: 'builtin' as const,
  moduleId: 'employee-memory' as const,
};
const scope: AllriceMcpScope = {
  personId: id(1),
  organizationId: id(2),
  workspaceId: id(3),
  employeeInstanceId: id(4),
  allriceThreadRef: id(5),
  nativeSessionRef: {
    instanceId: 'transport-instance',
    profileId: 'transport-profile',
    sessionId: 'transport-child',
  },
  executionGeneration: '4.0',
  enabledModules: ['employee-memory'],
  moduleConfigRevisionRef: 'current-transport-config',
  nativeCallRef: 'opaque-observed-request',
  requestContext: {
    actor: { type: 'user', id: id(1) },
    organizationId: id(2),
    workspaceId: id(3),
    requestId: id(6),
    sessionId: id(7),
    memberships: [],
    authenticatedAt: '2026-11-22T00:00:00Z',
  },
};
const target = {
  workspaceId: id(3),
  employeeInstanceId: id(4),
  threadId: id(5),
  nativeRequestRef: 'actual-host-request',
  module: memoryModule,
};
const port: Pick<EmployeeMemoryPort, 'readOrdinal' | 'remember'> = {
  readOrdinal: fixtures.read,
  remember: fixtures.remember,
};
const live = () => new AbortController().signal;
const sdkConnections: (() => Promise<void>)[] = [];
function memoryServer(services: AllriceMcpServices) {
  return createAllriceMcpServer({
    host: {
      binding: {
        personId: scope.personId,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        employeeInstanceId: scope.employeeInstanceId,
        allriceThreadRef: scope.allriceThreadRef,
        nativeSessionRef: scope.nativeSessionRef,
        executionGeneration: scope.executionGeneration,
      },
      current: async () => scope,
    },
    services,
  });
}
async function connectMemoryServices(services: AllriceMcpServices) {
  const controller = memoryServer(services);
  const client = new Client({
    name: 'memory-adapter-contract-fixture',
    version: '1',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  sdkConnections.push(async () => {
    await controller.close();
    await client.close();
  });
  await controller.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
afterEach(async () => {
  for (const close of sdkConnections.splice(0).reverse()) await close();
});
beforeEach(() => {
  vi.resetAllMocks();
  fixtures.identity.mockResolvedValue({});
  fixtures.read.mockResolvedValue('complete already-metered detail');
  fixtures.remember.mockResolvedValue({
    id: id(8),
    revision: 1,
    pairDigest: 'sha256:internal',
    summary: '待确认候选',
    memoryClass: 'work_note',
    state: 'pending',
    requiresConfirmation: true,
    details: 'not disclosed',
  });
});
describe('formal MCP memory callbacks with explicit contracts', () => {
  it('composes the real SDK server and memory adapter before explicit identity/business contract fixtures', async () => {
    const actual = vi.fn().mockResolvedValue(target);
    const services = bindEmployeeMemoryMcpServices({
      port,
      targets: { actual },
    });
    const client = await connectMemoryServices(services);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'identity_read',
      'memory_read',
      'memory_remember',
    ]);
    expect(
      await client.callTool({ name: 'memory_read', arguments: { number: 1 } }),
    ).toMatchObject({
      content: [{ text: 'complete already-metered detail' }],
    });
    const result = await client.callTool({
      name: 'memory_remember',
      arguments: {
        summary: '  stable\npreference  ',
        details: 'complete condition',
      },
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          id: id(8),
          summary: '待确认候选',
          memoryClass: 'work_note',
          state: 'pending',
          requiresConfirmation: true,
        }),
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('not disclosed');
    expect(JSON.stringify(result)).not.toContain('pairDigest');
    expect(actual).toHaveBeenCalledTimes(2);
    expect(fixtures.identity).toHaveBeenCalledTimes(2);
    expect(fixtures.identity).toHaveBeenLastCalledWith(
      scope.requestContext,
      { workspaceId: id(3), employeeInstanceId: id(4), threadId: id(5) },
      'execute',
      expect.any(AbortSignal),
    );
    expect(fixtures.read).toHaveBeenCalledExactlyOnceWith(
      scope.requestContext,
      target,
      { number: 1 },
      expect.any(AbortSignal),
    );
    expect(fixtures.remember).toHaveBeenCalledExactlyOnceWith(
      scope.requestContext,
      target,
      {
        summary: 'stable preference',
        details: 'complete condition',
        memoryClass: 'work_note',
      },
      expect.any(AbortSignal),
    );
  });
  it('publishes the exact index tool name in the real DSH client and reads with it', async () => {
    const actual = vi.fn().mockResolvedValue(target);
    const controller = memoryServer(
      bindEmployeeMemoryMcpServices({ port, targets: { actual } }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
    });
    const http = createServer((request, response) => {
      void transport
        .handleRequest(request, response)
        .catch(() => response.destroy());
    });
    const ctx = new Context();
    try {
      await controller.server.connect(transport);
      await once(http.listen(0, '127.0.0.1'), 'listening');
      const address = http.address();
      if (!address || typeof address === 'string')
        throw Error('MCP fixture address unavailable');
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(ToolRuntime);
      await apply(ctx, {
        transport: 'streamable-http',
        serverName: 'allrice',
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: {},
        toolCallTimeoutMs: 10_000,
        failOnStartupError: true,
        reconnect: { enabled: false },
      });
      const name = ctx.tools
        .schemas()
        .find((tool) => tool.name.endsWith('__memory_read'))?.name;
      expect(name).toBe('mcp__allrice__memory_read');
      expect(
        renderNativeMemoryIndexV2([{ summary: '财务规则', hasDetails: true }]),
      ).toContain(`with ${name}(number) before`);
      const result = await ctx.tools.execute({
        name: name!,
        arguments: { number: 1 },
        signal: live(),
        callId: ToolCallId('memory-index-catalog-fixture'),
      });
      expect(result.content).toEqual([
        { type: 'text', text: 'complete already-metered detail' },
      ]);
      expect(actual).toHaveBeenCalledOnce();
      expect(fixtures.read).toHaveBeenCalledExactlyOnceWith(
        scope.requestContext,
        target,
        { number: 1 },
        expect.any(AbortSignal),
      );
    } finally {
      try {
        await ctx.fiber.dispose();
      } finally {
        await Promise.all([controller.close(), http[Symbol.asyncDispose]()]);
      }
    }
  });
  it('hides both memory tools without a target producer and returns the existing unbound-tool result', async () => {
    const services = bindEmployeeMemoryMcpServices({ port });
    const client = await connectMemoryServices(services);
    expect(services).toEqual({ executionGeneration: '4.0' });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'identity_read',
    ]);
    for (const call of [
      { name: 'memory_read', arguments: { number: 1 } },
      { name: 'memory_remember', arguments: { summary: 'fact' } },
    ]) {
      expect(await client.callTool(call)).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: {
                code: 'DEPENDENCY_UNAVAILABLE',
                message: 'This tool is currently unavailable.',
                requestId: scope.requestContext.requestId,
                retryable: false,
              },
            }),
          },
        ],
      });
    }
    expect(fixtures.identity).not.toHaveBeenCalled();
    expect(fixtures.read).not.toHaveBeenCalled();
    expect(fixtures.remember).not.toHaveBeenCalled();
  });
  it('uses original authenticated scope and the actual execute identity reader before the business port', async () => {
    const actual = vi.fn().mockResolvedValue(target),
      services = bindEmployeeMemoryMcpServices({ port, targets: { actual } });
    const signal = live();
    expect(await services.memoryRead!(scope, { number: 1 }, signal)).toEqual({
      content: [{ type: 'text', text: 'complete already-metered detail' }],
    });
    expect(actual).toHaveBeenCalledWith(scope, signal);
    expect(fixtures.identity).toHaveBeenCalledWith(
      scope.requestContext,
      { workspaceId: id(3), employeeInstanceId: id(4), threadId: id(5) },
      'execute',
      signal,
    );
    expect(fixtures.read).toHaveBeenCalledWith(
      scope.requestContext,
      target,
      { number: 1 },
      signal,
    );
    const result = await services.memoryRemember!(
      scope,
      { summary: '候选' },
      signal,
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id: id(8),
            summary: '待确认候选',
            memoryClass: 'work_note',
            state: 'pending',
            requiresConfirmation: true,
          }),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('details');
    expect(JSON.stringify(result)).not.toContain('pairDigest');
  });
  it.each([
    { workspaceId: id(9) },
    { employeeInstanceId: id(9) },
    { threadId: id(9) },
    { module: { ...memoryModule, moduleId: 'deliverables' } },
  ])(
    'rejects a host projection for a different memory target %j',
    async (changed) => {
      const services = bindEmployeeMemoryMcpServices({
        port,
        targets: {
          actual: vi.fn().mockResolvedValue({ ...target, ...changed }),
        },
      });
      await expect(
        services.memoryRead!(scope, { number: 1 }, live()),
      ).rejects.toMatchObject({
        code: 'business_runtime_authorization_denied',
      });
      expect(fixtures.identity).not.toHaveBeenCalled();
      expect(fixtures.read).not.toHaveBeenCalled();
    },
  );
  it('joins a signal-less identity promise before suppressing the late result', async () => {
    let done!: () => void;
    fixtures.identity.mockReturnValue(
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    const controller = new AbortController(),
      reason = Error('original native abort');
    const services = bindEmployeeMemoryMcpServices({
      port,
      targets: { actual: async () => target },
    });
    const operation = services.memoryRead!(
      scope,
      { number: 1 },
      controller.signal,
    );
    await vi.waitFor(() => expect(fixtures.identity).toHaveBeenCalledOnce());
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort(reason);
    await Promise.resolve();
    expect(settled).toBe(false);
    done();
    await expect(operation).rejects.toBe(reason);
    expect(fixtures.read).not.toHaveBeenCalled();
  });
});
