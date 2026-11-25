import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatFlowPage from './page';

const entry = vi.hoisted(() => ({
  host: 'localhost',
  context: vi.fn(),
  find: vi.fn(),
}));
vi.mock('./chatflow-client', () => ({ ChatFlowClient: () => null }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: entry.host }),
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw Error(path);
  },
}));
vi.mock('../../lib/identity/session', () => ({
  getRequestContext: entry.context,
}));
vi.mock('../../lib/d-entry/entry-threads', () => ({
  findDEntryEmployee: entry.find,
}));

describe('ChatFlow server local command capability', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    entry.host = 'localhost';
  });

  it.each([
    ['0', '0', '0', false],
    ['1', '0', '1', false],
    ['1', '1', '0', false],
    ['0', '1', '1', true],
    ['1', '1', '1', true],
  ])(
    'keeps file confirmation available without the command runner (%s/%s/%s)',
    async (command, policy, ledger, enabled) => {
      vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', command);
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', policy);
      vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', ledger);
      const page = await ChatFlowPage({ searchParams: Promise.resolve({}) });
      expect(page.props.localCommandsEnabled).toBe(enabled);
      expect(entry.context).not.toHaveBeenCalled();
    },
  );
  it('opens 4.0 from the trial login destination only for the released employee', async () => {
    entry.host = 'allricevm.bplabs.xyz';
    entry.context.mockResolvedValue({ actor: { id: 'owner' } });
    entry.find
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ employeeInstanceId: 'enabled' });
    await expect(
      ChatFlowPage({ searchParams: Promise.resolve({}) }),
    ).resolves.toHaveProperty('props');
    await expect(
      ChatFlowPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('/chatflow/4.0');
    await expect(
      ChatFlowPage({
        searchParams: Promise.resolve({ session: 'legacy-bookmark' }),
      }),
    ).resolves.toHaveProperty('props');
    expect(entry.find).toHaveBeenCalledTimes(2);
  });
  it('shows the trial failure instead of defaulting to the legacy writer when policy is unavailable', async () => {
    entry.host = 'allricevm.bplabs.xyz';
    entry.context.mockResolvedValue({ actor: { id: 'owner' } });
    entry.find.mockRejectedValue(Error('policy unavailable'));
    await expect(
      ChatFlowPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('/chatflow/4.0');
  });
});
